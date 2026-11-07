# Handoff: where the build stands and how to resume

Written 2026-11-07, when the run was paused at about 93% of the usage budget.

## The method

The film is built as a "gauntlet loop". `CONTRACT.md` splits it into 15 pieces (sun, mercury, venus, earth, mars,
jupiter, saturn, uranus, neptune, asteroids, sky, post, director, hud, audio). Each piece has an owner, a set of
files, a floor and a target bar. For every piece, a builder agent works on it, then an independent critic who never
sees the builder's reasoning renders it with `tools/shot.mjs`, compares it with `bar/refs/` and scores it from 0 to
10. The next builder fixes the critic's biggest gaps. Between waves, a fresh triage agent decides where the next
round of effort goes, based on what a viewer of the film will actually notice.

## Done

**Wave 1** (90 agents): build, then critic, fix, critic, fix, final critic for all 15 pieces. Every piece met its
floor. The final board is in `notes/_board_wave1.md` (scores, critic summaries, top gaps with suggested fixes) and
`notes/_board_wave1.json`. `handoff/film_sheet_wave1.png` is the whole film at 8 s steps after wave 1.

| piece | stake | wave-1 final |
| --- | --- | --- |
| sun | critical | 6.5 |
| mercury | major | 6.5 |
| venus | major | 6.5 |
| earth | critical | 6.5 |
| mars | major | 6.2 |
| jupiter | critical | 5.5 |
| saturn | critical | 6.8 |
| uranus | major | 7.0 |
| neptune | major | 6.5 |
| asteroids | minor | 5.5 |
| sky | critical | 6.4 |
| post | critical | 7.5 |
| director | critical | 6.0 |
| hud | major | 8.0 |
| audio | major | 6.0 |

**Triage for wave 2**: `notes/_triage_wave2.json` holds each piece's decision, its ordered focus list, its film
windows, a judging note, the cross-piece routing of gaps, and the priorities for the integration pass.

**Lead fixes between the waves** (in `src/main.js`, `src/ui/hud.js` and `tools/`):

- **Shader hitches.** The first frame of a new world used to freeze playback for 3 to 23 s. Two things caused it:
  three.js had compiled the programs against the canvas instead of the HDR target, and ANGLE/FXC compile is slow.
  `main.js` now warms everything up behind the splash. Every program is compiled with the HDR target bound through
  `KHR_parallel_shader_compile` (`compileAsync`), then every object is drawn once, then one frame is rendered for
  every 4 s of the film. After the warm-up, no cold frame takes more than 75 ms. The splash shows "Preparing the
  GPU · N%" (`hud.setWarmup`). The warm-up runs in capture mode only with `warm=1`.
- **Shader compile budget.** Each piece's shaders must take no more than 800 ms in total, and no single object more
  than 350 ms, measured serially with `tools/checks/shader_cost.mjs --q "only=<id>,post"`. Every material must exist
  in the scene graph by the end of `create()`. Both rules are in `CONTRACT.md` 5b.
- **`tools/shot.mjs` profile pool.** Runs reuse Chrome profiles in `%TEMP%/fourlh-shot-profiles`, so the GPU shader
  cache persists between runs: about 5 s per run instead of about 40 s. `--fresh` uses a cold profile.
- **New checks**: `tools/checks/perf_probe.mjs`, `tools/checks/shader_cost.mjs`, `tools/checks/splash_check.mjs`
  and `tools/checks/file_url_check.mjs`.

## Paused: wave 2 (16 of 43 agents finished)

Completed results, including full critic verdicts, are in `notes/_board_wave2_partial.json`.

| piece | wave-2 progress | wave-2 critic | compile (serial) |
| --- | --- | --- | --- |
| sun | fix 1 + critic 1 done; **fix 2 stopped** | 7.0 | 753 ms (was 9.4 s) |
| saturn | fix 1 + critic 1 done; **fix 2 stopped** | 7.2 | 782 ms (was 5.9 s) |
| sky | fix 1 + critic 1 done; **fix 2 stopped** | 6.8 | n/a |
| venus | done (1 round) | 6.8 | 363 ms (was 2.2 s) |
| post | done (1 round) | 7.0 (was 7.5) | n/a |
| asteroids | done (1 round) | 6.0 | 826 ms (just over budget) |
| uranus | done (compile pass only) | banked at 7.0 | 453 ms (was 7.4 s) |
| director | fix 1 done (the re-cut); **critic 1 stopped** | not yet judged | n/a |
| mars | fix 1 done; **critic 1 stopped** | not yet judged | not yet measured |
| neptune | fix 1 done; **critic 1 stopped** | not yet judged | not yet measured |
| earth | **fix 1 stopped** | | |
| jupiter | **fix 1 stopped** | | |
| mercury | **fix 1 stopped** | | |
| audio | **fix 1 stopped** | | |
| hud | **fix 1 stopped** (it started after the director's re-cut) | | |

The stopped agents were killed mid-work, so files for earth, jupiter, mercury, audio and hud, and for sun, saturn
and sky (from their fix-2 builders), may contain half-finished edits. At the pause, the app still loaded with no
module failures, and `index.html` was rebuilt from that state. The resume builders read their files and notes
before they change anything.

## Resume on another PC

1. Clone the repo, then run `npm ci`. You need Node 24+ and Google Chrome at its default install path. Windows with
   a discrete GPU is ideal, because the compile-budget numbers are for Chrome's D3D11 path. `assets-src/raw/` is not
   needed to run or build.
2. Smoke test: `node tools/shot.mjs --t 20,120,300 --out shots/check_{t}.png`. The output should have no `module ...
   failed` lines. `node tools/checks/splash_check.mjs` tests the normal start (splash, warm-up, Begin, playback).
3. In Claude Code, opened at the repo root, with multi-agent workflows allowed (say "ultracode" or "run the
   workflow"), ask it to run the resumable workflow, passing the absolute path of your checkout:

   ```
   Workflow({ scriptPath: "handoff/wave2_resume.js", args: { root: "D:\\path\\to\\four-light-hours" } })
   ```

   The script is self-contained: it embeds the piece briefs, the wave-1 verdicts, the triage and the completed
   wave-2 steps. It skips the 16 finished agents and runs the remaining 27. That is: fix 1 for earth, jupiter,
   mercury, audio and hud; critic 1 for director, mars, neptune and the new fix-1 pieces; fix 2 and critic 2 for
   director, sun, earth, jupiter, saturn, sky and audio. The HUD waits for nothing, because the director's re-cut is
   already done. Audio's second round still waits for the director's round.

## After wave 2 (the rest of the plan)

1. **Triage again** with a fresh agent, given the wave-2 board (the gauntlet rule: whoever allocated the effort
   doesn't grade it).
2. **Integration pass**, whole-film critics routing fixes back to owners. The priorities are listed under
   `integration_priorities` in `notes/_triage_wave2.json`:
   - pacing and framing on the new cut (dead time, turn rates, subjects inside the frame under their title cards,
     finale holds), at the 2026, 2027 and 2031 epochs;
   - hero moments as a sequence at film exposure (Sun reveal, Blue Marble, Earthrise, Jupiter, Saturn eclipse,
     finale);
   - hygiene: zero module failures, no grey ecliptic band outside the belt, no NaN pixels, no warp-aliased lines;
   - warp legs, sound and picture together;
   - HUD legibility and accuracy, and full-film frame times (median and p95 at 1600×900).
3. **Performance**: `node tools/checks/shader_cost.mjs --parallel` measures the splash wait. The target is a few
   seconds, and wave 1 measured 61 s. `node tools/checks/perf_probe.mjs --q warm=1` must show no cold frame over
   about 80 ms.
4. **Build and verify**: `npm run build`, then `node tools/checks/file_url_check.mjs` (opens `index.html` from disk)
   and `node tools/checks/splash_check.mjs --page index.html`, with zero console errors.

## Known open items (lead's notes)

- In one splash capture, the splash's Begin button is barely visible when it becomes enabled. Check that its
  fade-in completes and that it has enough contrast.
- In the warm-up's film pass, Mercury still has one slow frame (about 0.9 s at t≈64). Some Mercury material is
  probably created lazily, after `create()`.
- In wave 2, post scored lower than in wave 1 (7.5 → 7.0) after its ghost and warp changes. The critic's gaps are in
  `notes/_board_wave2_partial.json`.
- Asteroids is 26 ms over its compile budget.
- Post's critic reported two green vertical lines in a view aimed at the Sun (phase 105.8). Nobody has been assigned
  to it yet; first identify which body module draws them.
- `node_modules/` is not committed. `shots/` (about 11 GB of builder and critic screenshots) is not committed either;
  regenerate screenshots with `tools/shot.mjs`.
