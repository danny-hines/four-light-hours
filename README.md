# Four Light-Hours

A real-time WebGL film that travels from the Sun past every planet of the Solar System, true to scale, with each
planet placed where it really is on the day you watch. Sunlight takes about four hours to reach Neptune, hence the
title.

There are two builds. `npm run build:web` writes `dist/`, a static site (a 3 KB page that paints at once, the
bundle, and the textures as separate files) for hosting. `npm run build` writes one self-contained `index.html`
(about 12 MB, everything inlined) that works offline, straight from disk.

## Watch it

Open the site (or `index.html`) in a desktop Chrome, Edge, Firefox or Safari with a decent GPU. The start screen
compiles the shaders first, a few seconds on most machines. Press **Begin**, ideally with headphones.

- **The film**: Space play/pause, ←/→ previous/next chapter, M mute, F fullscreen, H hide the HUD; the timeline at
  the bottom scrubs.
- **Look around**: it is rendered live, so drag on the picture to turn the camera away from the director's framing.
  Let go and it eases back; while paused it stays where you left it.
- **Explore**: press E (or the Explore button, or "Explore the worlds" on the end card) to leave the timeline and
  orbit any planet or major moon: drag to orbit, scroll or pinch to zoom, ←/→ for the next world, Esc to return to
  the film where you left it.

The picture is rendered at a megapixel budget that adapts to the measured frame rate (`src/main.js`), so it holds
60 fps on a laptop in fullscreen instead of shading every Retina pixel. `?res=<megapixels>` pins it.

## Develop

Requirements: Node 24+ and Chrome (the tools drive the installed Chrome through puppeteer-core; macOS, Linux and
Windows paths are known, or set `CHROME_PATH`). The D3D11 shader-compile measurements need Windows.

```bash
npm ci
npm run serve        # http://localhost:5178/dev.html (live modules, no bundling)
npm run build        # writes index.html (single file)
npm run build:web    # writes dist/ (the static site; Vercel runs this itself, see vercel.json)
npm run deploy       # publishes the working tree to production (pushes to main deploy on their own)
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
| `src/ui/` | splash, title cards, telemetry, labels, timeline controls; `explore.js` is the live camera (look-around and Explore mode) |
| `src/audio/` | generative WebAudio score |
| `assets/` | processed public-domain maps and catalogues (WebP / binary) |
| `assets-src/` | `SOURCES.md` (provenance of every asset) and the scripts that produced `assets/` |
| `bar/refs/` | public-domain reference photos the critics compared against |
| `tools/` | dev server, the two builds, deterministic screenshot tool, perf / shader-cost / adaptive-resolution / interaction checks, social card |
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
