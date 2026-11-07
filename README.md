# Four Light-Hours

A real-time WebGL film that travels from the Sun past every planet of the Solar System, true to scale, with each
planet placed where it really is on the day you watch. Sunlight takes about four hours to reach Neptune, hence the
title.

The deliverable is one self-contained file, `index.html` (about 12 MB, with every texture, the star catalogue,
the fonts and the code inlined). It works offline, straight from disk.

> **Status:** work in progress. Wave 1 of the build is done. Wave 2 (fix rounds) was paused partway through, so
> `index.html` is a mid-round snapshot. See [HANDOFF.md](HANDOFF.md) for where things stand and how to resume.

## Watch it

Open `index.html` in a desktop Chrome or Edge with a decent GPU. The start screen compiles the shaders first, which
takes roughly 10 to 30 seconds on a first visit (much less afterwards, thanks to the browser's shader cache). Press
**Begin**, ideally with headphones. Controls: Space play/pause, ←/→ previous/next chapter, M mute, F fullscreen,
H hide the HUD; the timeline at the bottom scrubs.

## Develop

Requirements: Node 24+, Chrome (the tools drive the installed Chrome through puppeteer-core), Windows for the
D3D11 shader-compile measurements.

```bash
npm ci
npm run serve        # http://localhost:5178/dev.html (live modules, no bundling)
npm run build        # writes index.html
node tools/shot.mjs --t 0:440:8 --sheet shots/sheet.png --cols 8   # contact sheet of the whole film
```

`dev.html` takes URL parameters for inspecting single bodies and shots (`view=body&body=saturn&dist=4&phase=40`,
`t=`, `epoch=`, `capture=1`, …). They are documented at the top of `src/main.js` and in `CONTRACT.md` section 7.

## API keys

None. The film makes no network calls at runtime, and no AI-generation services were used to make it. Every texture
and dataset comes from public-domain sources, and everything else is procedural.

## Layout

| Path | What |
| --- | --- |
| `src/main.js` | renderer, floating-origin world, module wiring, shader warm-up, capture API (`window.__app`) |
| `src/core/` | ephemerides (JPL Keplerian elements, IAU rotation models), body data, shared uniforms, asset loader |
| `src/bodies/` | one module per world (Sun, the eight planets with their major moons, the asteroid belt) |
| `src/sky/` | Yale Bright Star Catalogue stars, the Milky Way, relativistic aberration during warp |
| `src/render/` | HDR pipeline, bloom, lens system, warp effects, tonemapping; glints for sub-pixel worlds |
| `src/journey/` | the director: shot list, camera rig, timeline, chapters, captions, audio cues |
| `src/ui/` | splash, title cards, telemetry, labels, timeline controls |
| `src/audio/` | generative WebAudio score |
| `assets/` | processed public-domain maps and catalogues (WebP / binary) |
| `assets-src/` | `SOURCES.md` (provenance of every asset) and the scripts that produced `assets/` |
| `bar/refs/` | public-domain reference photos the critics compared against |
| `tools/` | dev server, single-file build, deterministic screenshot tool, perf and shader-cost probes |
| `CONTRACT.md` | the build contract every builder and critic worked to (conventions, interfaces, shot list, quality bar) |
| `notes/` | per-piece engineering notes and the review boards |
| `handoff/` | resumable workflow for the paused wave 2 |

## Credits

- Planet, moon and Earth imagery and elevation: NASA, JPL, USGS Astrogeology, NASA Earth Observatory, NASA SVS
  (Blue Marble, Black Marble, LRO, MESSENGER, Viking, MOLA, Galileo, Voyager, Cassini). Public domain; full list with
  URLs in `assets-src/SOURCES.md`. No NASA endorsement is implied.
- Coastlines and lakes: Natural Earth (public domain).
- Stars: Yale Bright Star Catalogue, 5th revised edition (public domain).
- Planet positions: E. M. Standish, JPL "Keplerian Elements for Approximate Positions of the Major Planets";
  orientations from the IAU WGCCRE reports.
- Code libraries: three.js (MIT, `licenses/three.js-LICENSE.txt`). Simplex noise by Ian McEwan / Ashima Arts (MIT),
  hash functions by Dave Hoskins (MIT).
- Fonts: Jost and Cormorant Garamond, SIL Open Font License 1.1 (`licenses/`).
