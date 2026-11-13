# Audio — generative score (`src/audio/*`)

A WebAudio score synthesised entirely in code: no samples, no services, no keys. It is composed at load from
the director's chapters plus a cue track sampled from `director.evaluate()`. The music is a pure function of
journey time, so live playback, seeking and the offline renderer all produce the same piece, and it re-fits
itself to whatever chapter times the director provides (it followed the finale's re-cut from 429.7 s to 434.7 s
during this round without a change) and to the fallback JOURNEY_ORDER timing.

API (`create(ctx)` returns): `start()`, `update(t, shot, playing)`, `seek(t)`, `setMuted(b)`, and
**`setExplore(worldId | null)`** (explore mode, below).

## How to see / hear it

The tools run on macOS, Linux and Windows (`src/audio/tools/chrome.mjs` finds Chrome and picks the ANGLE backend). The Python
plots need numpy, scipy and matplotlib.

```bash
node src/audio/tools/render.mjs                 # full film, offline, real app -> shots/audio/score.wav,
                                                #   shots/audio/spectrogram.png, notes/audio-report.md  (~1 min)
                                                #   exits 3 if a musical check fails, 2 on an audio error
                                                #   (--fast loads only the director; same score)
python src/audio/tools/loudcurve.py             # the loudness arc: shots/audio/loudness.png (anchors, legs by gesture)
python src/audio/tools/selfsim.py               # log-mel self-similarity, world x world: shots/audio/selfsim.png
node src/audio/tools/probe.mjs --quiet && node src/audio/tools/compose-check.mjs
                                                # the score in plain Node (~0.2 s): chords + voicings, legs with
                                                #   gestures and pivots, the melody plan, long lines, register per
                                                #   world, audits (exits 3 on a failure)
node src/audio/tools/live.mjs --wav shots/audio/score.wav
                                                # real page: setExplore before start(), start, seek, scrub, pause /
                                                #   suspend, resume, mute, a warp leg, EXPLORE MODE (enter, film paused,
                                                #   mute, world to world, unknown id, back to the film), audio-thread
                                                #   underruns at 6 dense moments, a 3 s stall, the film's end compared
                                                #   with the offline render -> notes/audio-live.md
node src/audio/tools/explore.mjs                # every explore bed offline, back to back through the live controller,
                                                #   and a long bed that rolls over twice -> notes/audio-explore.md,
                                                #   shots/audio/explore.wav
node src/audio/tools/explore.mjs --live 150     # explore soak in the real page (voices, generations, heap, underruns)
node src/audio/tools/underrun.mjs --t 292       # audio-thread underruns at one moment, A/B'd against a bare context
python src/audio/tools/zoom.py --t0 93 --t1 131 --out shots/audio/zoom_home_theme.png --fmin 60 --fmax 4000
                                                # zoomed spectrogram of any stretch, melody notes marked
node src/audio/tools/render.mjs --fast --seek-test   # 5 simulated seeks inside a render -> notes/audio-seek-report.md
node src/audio/tools/render.mjs --fallback --out shots/audio/fallback --report notes/audio-fallback-report.md
```

Best evidence: `notes/audio-report.md` (Score checks first), `shots/audio/loudness.png`, the zooms
`shots/audio/zoom_home_theme.png`, `zoom_eclipse_theme.png`, `zoom_finale_theme.png`, `notes/audio-live.md`,
`notes/audio-explore.md`.

## Latest full render (director 434.7 s, 2026-11-13)

`node src/audio/tools/render.mjs`: **all 21 checks pass, exit 0.** True peak -1.5 dBTP, integrated **-15.6 LUFS**,
LRA 12.9 LU, 0 NaN / 0 subnormal, longest silence 0.3 s (the fade from black), 139/139 melody notes >= +6 dB over
the local partials (worst +6.7), 0 melody/harmony rubs, 0 voicing rubs, 5/5 anchors prepared, peak 129 voices,
rendered at ~10x real time. The limiter is light: against a render 8 dB down it takes 0.1 LU off the integrated
loudness, at most 0.5 dB off a short-term peak and ~2.5 dB off the single highest sample peak.

Loudness arc (short-term LUFS, `loudcurve.py`):

| moment | ST max | before it |
| --- | --- | --- |
| pale blue dot (the theme whole, 411-434) | **-9.4** | -20 during the intimate pull-back |
| Earthrise (the theme developed, 141-157) | **-9.5** | -23 in the interlude |
| Saturn eclipse (the theme in E, soprano, 287-321) | **-9.8** | -23 as the rings dim |
| Earth arrival (the theme complete, 95-130) | **-10.7** at its resolution on the sunrise, -11.6 at its peak bars | -27 in the hush leg |
| Jupiter skim | -12.9 | |
| Sun (the horns' Light theme) | -12.9 | |
| legs: brass 41 / choir 67 / hush 90 / streak 157 / riser 188 / brass 215 / hush 256 / streak 321 / hush 345 | -18.9 / -23.5 / -21.4 / -12.3 / -20.5 / -20.6 / -17.6 / -19.4 / -19.0 | |

The eight loudest moments of the film all lie inside an anchor's theme. The loudest leg (Earth → Mars, -13.7 by the
report's measure) is the streak that carries Earthrise's last phrase out; every anchor is >= 3.9 dB above it.

`live.mjs` (full page, `q=low`): no audio-related errors and no module failure; 0% underruns at all six dense
moments (Sun, sunrise, Jupiter skim, eclipse, Uranus, finale; `underrun.mjs`: 0% with and without the hall);
`update()` averages 0.03-0.09 ms (max 9 ms, a seek's new generation); pause → context suspended after 10 s;
resume, mute, a 25-seek scrub (3 generations at most, 1 after 2 s), one resync after a 3 s main-thread stall, the
composed ending within ~1 dB of the offline render. Seek test: the largest sample step around each of 5 simulated
seeks is that of the music it lands in (0.09-0.17 vs 0.07-0.14 just before), no clicks.

## What changed this round (wave 3)

State found: the code was coherent (the page loaded, the offline render ran and passed its 21 checks on the 429.7 s
cut). Repairs: the audio tools hard-coded a Windows Chrome path and `--use-angle=d3d11` (now `src/audio/tools/chrome.mjs`);
a mangled regular expression in `composer.js edgeAt` (`d+` for `\d+`) meant cue-anchored layer edges such as
Saturn's descant `to: 'eclipse-1'` were silently ignored; `loudcurve.py` needs scipy.

1. **One theme, heard whole four times.** The four earlier tunes shared a 4-note head and then went their own ways;
   now there is one melody. The HOME theme is a sentence on the pale blue motif (a rising sixth that falls home by
   step) in a rising sequence, then the whole scale falling from the peak to the tonic:

   `(A4) F#5 E5 D5 · (B4) G5 F#5 E5 · (D5) B5 A5 G5 · (B5) A5 G5 F#5 E5 | D5` over `I  ii  IV  V9 | I`
   (Dadd9, Em11, G6/9, A9, Dadd9).

   - **Earth arrival** (95.7-129.6): complete. Felt piano with a rocking left hand; a cello in contrary motion from
     bar 2 (`E3 G3 B3 A3 | G3 B3 D4 | C#4 B3 A3 G3 | F#3`, parallel sixths under the cadence); the strings take the
     tune at its peak (bar 3); a desk of strings and warm pads under it; it resolves on the sunrise over the limb.
   - **Earthrise** (141.7-157.5), developed: head, straight to the peak, left open on D/E
     (`A4 F#5 E5 D5 · D5 B5 A5 G5 · B5 A5 F#5 E5`): piano + the solo voice + strings + cello.
   - **Saturn eclipse** (288.3-321.5), in E, solo soprano with glass an octave above:
     `B4 G#5 F#5 E5 · E5 C#6 B5 A5 · C#6 B5 A5 G#5 F#5 | E5 (over C#m11, deceptive) · G#5 F#5 E5 · C#5 B4`.
     C#6 is the highest note of the film's melody; it lands 7 s into the eclipse, at the director's intensity peak.
   - **Finale**: intimate first (392.5-406.5): the theme's first two steps alone on the piano over IV and ii, the
     tonic withheld (`A4 F#5 E5 D5 · B4 G5 F#5 E5`), then the dominant swelling under the map. On the **pale blue
     dot** the theme returns whole and transformed (410.2-433.4): its upbeat A4 on the dominant so the sixth lands
     exactly on the cue, piano + voice + strings + a horn an octave below + cello:
     `A4 | F#5 E5 D5 · D5 B5 A5 G5 · B5 A5 G5 F#5 E5 | D5` over Dadd9, G6/9, A9, then home on Dmaj9#11 (the Sun's
     raised fourth), closing bell and glass in the tail.
   - **Foreshadowing**, so the Earth statement lands as recognition: the seed A4 → F#5 on a bell under the title;
     on the Sun, after the Light theme on the horns (`A3 E4 F#4 G#4`), the theme's first three notes low on the
     horns, left hanging (`A3 F#4 E4`); Mercury, the sixth minor and bare on a dry piano (`E5 C6`); Venus, the motif
     buried in a dark horn (`F2 D3 C3 Bb2`) and the seed again on a bell riding into the hush before Earth.
   - **After Earth** the theme travels: **Mars**, its second step (`B G F# E`) spun into an 8-bar Dorian tune over
     the 84 BPM pulse (26 notes, 22 s, to the Dorian sixth C#6); **Jupiter**, the horn call assembling (`G4 Eb5`,
     the motif whole over bVII `F4 D5 C5 Bb4`, then augmented in C minor `G4 Eb5 D5 C5` at the skim); Uranus, the
     motif upside down on cold bells; **Neptune**, the theme alone and far from home on a high piano, in B minor,
     stopping on the raised fourth (`F#5 D6 C#6 B5 · G5 E6 D6 C#6`).
   Seven lines of 8+ notes lasting 12+ s (was 4; 0 two rounds ago); the fragments left are the foreshadowing and the
   connective tissue.
   Machinery: an upbeat before a tune's first bar (`@-1`), `elastic` bars (a final held note absorbs whatever a cut
   leaves over, so a tune's tempo never depends on it), free chords absorbing slack beside a tune (the dominant
   before the pale blue dot simply holds longer when the finale is lengthened; optional chords appear when there is
   room), tunes over a pulse get exactly their bars of the grid, doubling parts (`strings`, `horn`, `glass`, octave
   offsets) that the voicing treats as inner voices.
2. **The arc.** The Earth arrival is now an anchor (it was -17..-20 LUFS piano-and-cello; the old peak was Earthrise
   alone): the tune carries its own swell (`swell` on a tune: the level rises with it toward its peak bars), the
   strings enter under it, and it comes out of a real quiet: the Venus → Earth leg is now the **hush** (the music
   falls 11.5 dB under one high A, the theme's first note; the reveal blooms +17.5 dB). `quiet: { cue: [dB, s] }`
   draws the music back before an anchor: -6 dB over the 4.5 s before the eclipse, -4 dB before the pale blue dot
   (where strings and choir now enter only 5 s / 3 s before the cue: the pull-back is piano, pad and sub), -3.5 dB
   before Earthrise. The Sun is held under the anchors (-12.9).
3. **Legs.** Nine legs, five gestures, no two neighbours alike: brass (Sun → Mercury: the Sun's own brass once
   more through planing sus chords), choir (→ Venus), hush (→ Earth), streak on the Mars pluck (→ Mars), riser
   (→ belt), brass (→ Jupiter), hush (→ Saturn), streak on ice bells (→ Uranus), hush (→ Neptune). All riser levels
   still come from the music follower in the graph, i.e. from the live cue table; `approach.gain` is a gesture's own
   scale, not a calibration. Loudest leg 3.9 dB under the quietest anchor.
4. **World colour.** The **Sun** is now massive and low: low brass chords swelling with every change of harmony
   over a D pedal, more sub and p-modes, the Light theme on horns instead of the voice (the voice is saved for
   Earth), register centred on F3 (top voice C#4); spectral centroid 470 Hz (was 930), Sun → Mercury spectral
   correlation -0.21. Mercury's thin pads are written where they sound (no octave transposition); Venus sits low
   and close (D3-A3) under its high "u" haze; Mars is drier (hall 0.5). Top-voice medians: Sun C#4, Mercury F4,
   Venus A3, Earth E4, Mars G4, belt D5, Jupiter C4, Saturn G#4, Uranus E5, Neptune B3, finale E4 (every neighbour
   >= a minor third apart); seconds per chord 7.1 / 2.7 / 6.5 / 6.3 / 3.3 / 11.2 / 9.3 / 6.8 / 3.9 / 8.2 / 6.3.
5. **Loudness.** Integrated -15.6 LUFS (was -17.1; target -16..-14), true peak -1.5 dBTP, LRA 12.9 LU.
6. **Explore mode** (requested by the integrator mid-round), next section.

## Explore mode: `setExplore(worldId | null)`

While the film's clock is frozen and the viewer orbits a world, the score plays an endless, slowly evolving bed in
that world's own harmony, register and colour.

- `setExplore('saturn')`: crossfades (2 s, equal power) from whatever is playing to the bed; the film's generations
  are retired and the film is not "active" while exploring: `update(t, shot, playing)` only feeds the bed (no film
  cue can fire, whatever `t` and `playing` are), `seek(t)` is ignored. Another id crossfades bed to bed (1.5 s).
  The same id again is a no-op. `setExplore(null)` fades the bed out (2 s); the next `update()` starts the film's
  music at the current `t` if the film is playing (a `seek(t)` right after is fine), or leaves silence if paused.
- Before `start()` the request is remembered and applied as soon as the engine exists. Mute is the master mute,
  so it silences the bed too. The context is resumed if a film pause had suspended it, and it is not suspended
  while exploring.
- Ids: `sun mercury venus earth moon mars jupiter saturn titan uranus neptune triton` (also `asteroids`/`belt`;
  `io europa ganymede callisto` → Jupiter, `phobos deimos` → Mars); anything else gets a neutral deep-space bed
  (a held fifth on D with glass and the theme's seed on a far bell). Titan is Saturn's harmony under a warm,
  muffled haze; Triton is Neptune's, colder and thinner with far-off ice bells.
- How it works (`explore.js`, `composer.js composeExplore`): a bed is a plan composed like a chapter (the world's
  progression laid out twice over 72-132 s, its layers, lanes and register; no tunes, legs, risers or arrival hits;
  every 20-35 s one fragment of the themes drawn from that world's own lines) and played by an engine generation on
  its own clock, started 6 s into the plan so its sustained layers are already sounding. 8 s before a plan ends the
  next variation (cycle + 1 re-draws every seeded choice) is composed and the two are crossfaded over 7 s, so the
  bed never loops and never ends; the old generation, voices and plan are released by the engine's sweep. A stalled
  page (hidden tab) restarts the bed where it should be. Per-world trims put every bed at about -20 LUFS.
- Verified offline (`explore.mjs`, `notes/audio-explore.md`): 14 beds back to back + a 150 s Mars bed (two
  roll-overs): every bed -20.0..-22.0 LUFS (4.4-6.4 LU under the film's -15.6), true peak -3.2 dBTP, no NaN, no
  click at any crossfade (largest step 1.09x the beds' own), level within 1.7 LU across a roll-over, 0 generations
  and 0 voices left at the end. Live (`live.mjs`): applied before `start()`; entered at Saturn with the film then
  paused: output -22 dBFS RMS after 2.5 s and after 12.5 s, context running; same id again: nothing changes; mute:
  -120 dBFS; Titan, Mars, an unknown id; `playing` true while exploring: the film stays inactive; `setExplore(null)`
  + `seek(t)`: the film is back within 2.5 s, one generation alive. Soak (`explore.mjs --live 150`): heap flat at
  ~17 MB, 1 generation (2 during a roll-over), 70-107 voice sets, 0 ms of underruns.

## Harmonic plan

The tonal home is **D**. The Sun's light and Earth share it, and the finale returns to it. Each world ends on a
cadence chord that shares common tones with the arriving world's pivots; one voice-led line (3-5 voices) runs
through the whole film, moving register from world to world.

| world | key / harmony | character, register, instruments |
| --- | --- | --- |
| cold open | D open fifth | soft pad swells out of black; the seed of the theme (A4 → F#5) on a distant bell |
| Sun | D Lydian: Dmaj9#11 → E/D → Bm9 → Esus4 (7 s) | massive and low: brass swells, saw pad, sub, p-modes; L on the horns, then the theme's first three notes; bells and glass far above |
| Mercury | A5 → Bb5/A → A5 → G5/A → ... (side-slips every 2.7 s) | stark: a thin tremolo pad, glass fifths, ticks, a dry piano (L's skeleton, the minor sixth) |
| Venus | Bbmaj9 → Ebmaj9#11 → A7sus4 | thick and hazy: a low close pad, closed "u/o" choir, a high "u" haze, the motif buried in a dark horn |
| Earth & Moon | **HOME** over Dadd9-Em11-G6/9-A9 → Dadd9 (sunrise) → Gmaj9#11 → A13sus4 → **RISE** over Dadd9 → G6/9 → D/E | warm and consonant: felt piano, cello, strings, warm pads, sub; the voice from the interlude on |
| Mars | **MARS** over Em9 → A/E → Em9 → A/E → G6/9 → D/F# → Asus2 → Bm11 (one bar each at 84 BPM) | dry and open: FM-pluck 3+3+2 pulse with dotted echo, soft kick, dust wind; the tune on a dry piano |
| belt | Cmaj9#11 → Csus2 (11 s) | high open glitter, granular pebbles, rock whooshes |
| Jupiter | Cm(add9) → Bbsus2 → (skim) Cm(add9) → Ab(add9) (pedals) | vast, low power: low brass and pads (G2-C4), sub, the horn call; whistlers; Io's gong |
| Saturn | Emaj9 → C#m11 → Amaj9#11 → B11 → (eclipse) **ECLIPSE** over Eadd9 → A6/9 → B9 → C#m11 → F#9sus4 | glassy and awed: three-section choir with a high descant over the rings (until the eclipse), ring glitter, glass; the soprano at the eclipse |
| Uranus | quartal stacks F#m11 → Dmaj13#11 → Bm11 → C#m7sus4 → F#sus4 (4 s rotation) | cold: close and high (C#4-A5), no bass, FM bells in rotation |
| Neptune | Bm(add9) → Gmaj7#11 → Em9 → F#sus4(b9) → Asus4 | distant and sparse: deep and wide (G2-B3), sub, lonely wind; **NEPTUNE** alone on a high piano; a distant voice |
| finale | **FINALE_A** over Gmaj9 → Em11 → A9sus4 → (pale blue dot) **FINALE** over Dadd9 → G6/9 → A9 → Dmaj9#11 | intimate (piano, pad, sub), then everything: piano, voice, strings, horn, cello, choir |

## Sound engine

- **Master:** dry + [mono send → 30 ms pre-delay (±3 ms at 0.11 Hz) → 6.6 s convolution hall (generated IR, five
  bands with their own decay, two all-pass ears) → HP4 220 Hz → LP 9.5 kHz] → DC block → LR4 150 Hz mono-maker + M/S
  width 1.05 → glue compression (2:1) → makeup → true-peak limiter at -1.5 dBTP (4x-oversampled lookahead
  AudioWorklet) → mute.
- **Generations:** every start/seek/resume builds a fresh set of buses (tilt, level, warp duck, pad chain +
  symmetric chorus, three choir formant sections, lead voice, horn, piano, bow (cello/strings body), sub, pluck
  echo, noise beds, the music follower) with ~40 automation lanes in rolling 12 s chunks; sustained notes resume
  mid-envelope; generations crossfade equal-power. A generation plays the film's plan on the film's clock or an
  explore bed's plan on its own clock (`newGeneration(t, when, fade, { plan, gain })`).
- **Instruments:** pads, formant choir + solo voice (interval-aware scoop, breath onset), sub, FM bells, glass,
  felt piano (velocity brightness, round-robin, soundboard knock, damper), bowed string (solo cello; `ens` for a
  desk of strings, also on a tune), FM pluck, kick, brass (sustained low brass; horn lead), grains, pebbles, ticks,
  sparkle, chirps, p-modes, halo/hush tones, riser (follower-driven), suck, drop, whoosh.
- **Transport:** pause fades dry and sends while the hall rings out (suspend after 8 s); the film's end plays the
  composed tail; seek/resume start a new generation (scrubbing coalesced, queued voices of the old ones cancelled);
  mute is a ramp after the limiter; a hidden tab is a pause.
- **CPU:** per-category and global voice caps (150 sounding), k-rate automation on slowly moving params, 20 Hz
  scheduling with a 2.5 ms budget, 4 Hz sweeps that disconnect finished voices. Offline peak 129 voices; 0%
  underruns live; a seek costs 7-11 ms once.
- **Determinism:** every random choice is a mulberry32 seeded by world, section, line, cue or leg (explore beds:
  plus the variation number); noise loops, control noise, IR, piano strikes are fixed-seed.

## Files

| file | what |
| --- | --- |
| `score.js` | contract API (`start / update / seek / setMuted / setExplore`), throttled live scheduling, the end-of-film tail, `planFor`, `sampleCues`, `renderOffline`, `renderExploreOffline` |
| `explore.js` | `ExploreBed`: enter / swap / leave, roll-over to the next variation, stall restart; fades and per-world trims |
| `worlds.js` | per world: progressions, cadences, anchors, `tunes`, `lines`, `reg`, `approach` (pivots, gesture, gain), `swell`, `quiet`, layers (incl. `extra`), lanes, `centroid`, `impact`; Titan / Triton / deep-space beds; accents; chapter → world matching |
| `composer.js` | warp legs, sections, chord timelines + `fit()` (tune-aware: spans, elastic bars, grid), tunes (`realizeTunes`), fragments (`realizeLines`, explore fragments), the voice-led line, layer generators, `planLegs` + `GESTURES`, accents, lanes (hush duck, swells, quiets, tune swells), audits, `composeExplore` |
| `theory.js` | seeded RNG, pitch parsing, modes, `THEMES` + `realize`, `TUNES` (HOME, RISE, ECLIPSE, FINALE_A, FINALE, MARS, NEPTUNE) + `parseTune`, the voicing solvers |
| `instruments.js` | every voice; `kRate()` |
| `engine.js` | master chain, generations (per-plan), scheduler, voice limits, cancellation, cleanup, transport |
| `dsp.js` | noise loops, control noise, the hall IR, felt-piano synthesis, wavetables |
| `limiter.js` | true-peak lookahead limiter (AudioWorklet), with a fallback |
| `tools/*` | `chrome.mjs`, `render.mjs` (+ checks), `analyze.js` (BS.1770, true peak, STFT, salience, legs, stereo, character, self-similarity, ST peaks, spectrogram, WAV, `measure`), `compose-check.mjs`, `probe.mjs`, `live.mjs`, `explore.mjs`, `underrun.mjs`, `profile.mjs`, `zoom.py`, `loudcurve.py`, `selfsim.py` |

## Known gaps

- Judged by analysis, not by ear (headless): levels, spectra, leg shapes, melody salience, harmony, register and
  stereo are checked; nobody has listened to the theme, to the balance of strings / voice / horn in the finale's
  tutti, or to the soprano's top C#6. The theme was written on paper against its harmony; whether it is memorable
  is for a listener to say.
- The full theme on the pale blue dot needs about 16 s from the cue to its final chord. In this cut (cue 411.0,
  duration 434.7) the final chord arrives at 427.0, 7.7 s before the last frame, and rings through the 7 s tail. If
  the cue moved to within ~13 s of the end the tune would run faster (down to 0.6x of its written beat) and then
  give way to its fragments.
- The fallback timing (no director: 16 s per world) has no room for any tune: it plays the fragments (renders
  without errors; its musical checks are reported, not expected to pass).
- Plain log-mel cosine similarity between neighbours is still high where the palette is shared (Earth/Mars 0.98,
  Saturn/Uranus 0.98, Neptune/finale 0.98); the standardised measure is low everywhere except intro/Venus/Neptune
  (the three dark, low beds).
- Explore: a bed in a hidden tab plays out its 5 s of lookahead and thins until the tab returns (then restarts in
  0.5 s). The roll-over composes the next variation on the main thread (1-30 ms once per 65-125 s).
- Seeks: equal-power crossfade; a seek into a passage whose piano and bell notes started before the seek point can
  sound thin for ~0.5 s offline (live, prewarmed piano notes resume).
- The solo voice's formants follow the world's vowel lanes, not each note; the piano has no sympathetic resonance.
- Tested in Chrome only (macOS this round, Windows before); the webkitAudioContext and no-AudioWorklet fallback
  paths are untested. Not measured on a mid laptop.

## Requests to integrator / other pieces

- **main.js (Explore):** call `score.setExplore(id)` on entering / changing world and `score.setExplore(null)` on
  leaving, then `seek(t)`; keep calling `update()` every frame while exploring (the bed is scheduled from it).
- **main.js:** while audio is running, please drive `app.t` from the audio clock (or at least don't clamp `dt` to
  0.1 s while playing). Below ~10 fps the picture runs slow; the score tolerates up to 2.5 s of drift.
- **Director:** please keep `shot.audio.{intensity, arrival, departure, cue}` and `audioCues` stable. Cue names
  used: `title, sun-reveal, sunrise, earthrise, phobos, io-shadow, jupiter-skim, rings, eclipse, titan, bullseye,
  triton, pale-blue-dot`. The theme is timed by `sunrise`, `earthrise`, `eclipse` and `pale-blue-dot` (`end` is no
  longer an anchor). Please keep >= 16 s between `pale-blue-dot` and the film's end.
- HUD: keep calling `ctx.app.start()` directly in the click handler (the AudioContext is created inside it).
- `window.__score` is a small debug hook (`info()`, `_engine()`, `api`) used by the live tools; harmless, removable.
