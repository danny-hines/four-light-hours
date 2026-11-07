# FOUR LIGHT-HOURS — build contract

A single-page, real-time WebGL film: a journey from the Sun past every planet to Neptune — the distance sunlight
covers in about four hours — at **true scale** (true sizes, true distances, planets placed where they really are
on the viewer's date, the real night sky behind them). It must look like a high-end planetarium / NASA
visualization studio production running live in a browser. The final deliverable is one self-contained
`index.html` built by `node tools/build.mjs`.

Every builder works on ONE piece, in the files listed for that piece only. Read this whole file first.

---------------------------------------------------------------------------------------------------------------

## 1. Ground rules

1. **File ownership.** Edit only the files your piece owns (section 6). You may add new files inside your piece's
   folder (e.g. `src/bodies/jupiter/*.js`, `assets/jupiter/*`). Do **not** edit `src/main.js`, `src/core/*`,
   `src/glsl/*`, `src/fallback/*`, `tools/*`, `dev.html`, or another piece's files. If you need a contract change,
   write it under "Requests to integrator" in `notes/<piece>.md`; work around it meanwhile.
   You may *copy* code from `src/glsl/*` into your own files and modify the copy.
2. **No keys, no AI services.** Nothing from any `.env` file. All content is code, procedural shaders, or
   public-domain NASA / JPL / USGS / NOAA / Natural Earth / Yale BSC5 data. Record every external data source you
   add in `assets-src/SOURCES.md` (append a section for your piece). Downloads go in their own new folder under
   `assets-src/raw/<item>/`; processing scripts live in `assets-src/scripts/` and run as `python -I script.py`.
3. **Deterministic.** All animation must be a pure function of the frame inputs (`frame.t`, `frame.simDays`,
   `U.uTime`, `U.uSimDays`). No `Math.random()` at runtime without a fixed seed, no `Date.now()`, no accumulation
   across frames that would make `seek(t)` render differently from playing up to `t`.
4. **Performance budget** (measured later on an RTX 4090 at 1600×900; aim to also run at 30+ fps on a mid laptop at
   `q=med`): a whole frame ≤ 8 ms GPU. Any single body filling the screen ≤ 3 ms. Use pixel-footprint LOD: fade
   octaves / detail out with distance (`fwidth`, or screen-space radius), skip work for back-facing or tiny bodies,
   cap raymarch steps. Note: while many agents share the GPU, measured fps is noisy — design for the budget.
5. **Asset budget** for the whole project ≈ 9 MB of files under `assets/` (base64 inflates ×1.33 in the final file).
   Per body: rocky worlds ≤ 1.2 MB (Earth ≤ 2.5 MB), gas giants ≤ 0.4 MB (they should be procedural), sky ≤ 0.4 MB.
   Prefer WebP. Textures are a base layer only: procedural detail must take over at close range (no visible
   texels or blur when a body fills the frame).
5b. **Shader compile budget** (added in wave 2). Chrome on Windows compiles every program through ANGLE → HLSL →
   FXC, and FXC unrolls constant-bound loops and inlines every call, so big raymarch/fbm shaders take seconds. The
   film compiles everything in parallel behind the splash (`main.js` warm-up, `KHR_parallel_shader_compile`), so the
   wait is set by the slowest single program. Budget per piece, measured serially with
   `node tools/checks/shader_cost.mjs --q "only=<id>,post"`: total ≤ 800 ms, no one object > 350 ms. Use
   non-constant loop bounds (`for (int i = 0; i < uSteps; i++)`), one call site per large noise function, no
   implicit-derivative texture reads inside non-uniform loops. **Every material a piece will ever draw must exist in
   the scene graph by the end of `create()`** (toggle `.visible`, never create materials or change defines
   mid-film), or the warm-up misses it and the film hitches. `node tools/checks/perf_probe.mjs --q warm=1` verifies
   that cold frames after a seek stay under ~80 ms.
6. **Never break the app.** The page must load with zero console errors from your module. `main.js` falls back to a
   placeholder if your module throws, which hides your work — check the shot tool output for
   `module "<x>" failed` lines.

## 2. Coordinates, units, time

- `src/core/astro.js` has everything: read it. **1 scene unit = 1 Earth radius = 6371 km.** `AU` = 23,481 units.
  Neptune is ~706,000 units from the Sun. Sizes and distances are real.
- World axes: ecliptic J2000 mapped to three.js as x = X, y = Z (ecliptic north is **+y**), z = −Y.
- **Floating origin.** The camera is always at the world origin. `main.js` puts all universe content in the `world`
  group and sets `world.position = −cameraUniverse` every frame. So in shaders, **world-space positions are
  camera-relative** (small, precise numbers) and `cameraPosition` is (0,0,0). Use `modelMatrix` for world positions.
  The Sun's world position is `U.uSunPosW`.
- Planets are fixed at their heliocentric positions for the epoch (`ctx.positions[id]`, universe coords). Your
  body's `object` is placed there by `main.js`; put your meshes inside it with local offsets.
- **Body-local frame:** use `bodyQuaternion(id, simDays)` (includes spin) for the planet mesh and
  `poleQuaternion(id)` (no spin) for rings and moon orbit planes. In that local frame +y is the north pole,
  +x is longitude 0, −z is 90° E. `lat = asin(p.y)`, `lon = atan(-p.z, p.x)`. three.js `SphereGeometry` UVs
  already match an equirectangular map with longitude 0 at the horizontal centre, east to the right.
- **Time.** `frame.simDays` = days since J2000 on the accelerated simulation clock (`TIME_SCALE` = 1200: one real
  second = 20 simulated minutes; Earth turns once per 72 s, Jupiter once per 30 s). Use it for rotation, moon
  orbits, and anything physical (cloud drift, band flow). `frame.t` / `U.uTime` is journey time in seconds — use
  it only for purely visual animation (solar plasma boil, sparkle). Planet positions do not change during the film.
- Real rotation sense and pole orientation (Venus and Uranus are retrograde; Uranus is tipped 98°) come for free
  from `bodyQuaternion`. `moonGeocentric(d)` gives a phase-accurate Moon. `circularOrbitOffset()` helps for other moons.

## 3. Rendering conventions

- `main.js` → `post.render()` draws the whole `scene` into a linear **HDR** half-float target (4× MSAA, reversed
  32-bit float depth, so precision is fine from 1 m to 1e9 units; `camera.near` is set per frame from the closest
  surface) and then post-processes to the screen. **Materials output linear HDR radiance.** Do not tone-map or
  sRGB-encode in materials. Use `ShaderMaterial` / `RawShaderMaterial` (no three.js lights exist in the scene).
- **Exposure model:** sunlight has **unit irradiance at every planet** (colour `U.uSunColor`) — i.e. a perfect
  auto-exposure. A white Lambertian surface facing the Sun shades to ≈ 1.0. Do not add 1/r² falloff for planets.
  Emissive things pick plausible relative values: the Sun's disc ≈ 50–4000 (cap < 30000; post adds bloom/flare),
  city lights ≈ 0.02–0.2, Io's volcanoes small. Stars/Milky Way are scaled by `U.uSkyGain`.
- **Draw order:** opaque bodies first (default), then transparent shells (atmospheres, rings, haze) — three.js
  sorts transparent objects back to front. Sky content uses `transparent: false`, `depthWrite: false`,
  `depthTest: true`, `renderOrder: -1000` (so it draws first and everything covers it), geometry radius ≤ 1e8.
- Atmospheres: `src/glsl/atmosphere.js` has a single-scattering Rayleigh/Mie(+ozone) integrator and the blending
  recipe (`CustomBlending`, `OneFactor` / `SrcAlphaFactor` ⇒ `out = scatter + dst × transmittance`).
  `src/glsl/noise.js` has simplex, fbm, ridged, worley, hashes. Copy and modify freely.
- No three.js shadow maps. Shadows between bodies (ring shadows, moon shadows on a planet, planet shadow on rings
  and moons, eclipses) are analytic in your shaders (ray–sphere / ray–plane tests toward `U.uSunPosW`).
- Bodies must look right from any distance: a full disc filling ~70% of the frame, a crescent, a close pass at
  0.05–0.3 radii altitude, and a tiny disc a few pixels wide (glints take over below ~2 px). No seams, no pole
  pinching, no texture-pixel blur, no shimmering/aliasing (filter procedural detail by footprint), no banding.
- Physically plausible appearance first, matched to the reference photographs in `bar/refs/` (see `INDEX.md`
  there) — then cinematic. Correct terminator softness, limb darkening/brightening, phase behaviour, colours.

## 4. Modules (all are `export async function create(ctx)`)

`ctx` = `{ THREE, renderer, scene, world, camera, U, BODIES, assets, quality, capture, epochDays, positions,
data /* BODIES[id] for bodies */ }`. Later modules also get `bodies` and `director`. `assets` =
`src/core/assets.js`: `loadTexture(path, {srgb})`, `loadTextureOptional`, `loadBinary`, `loadJSON`, all relative
to `assets/` (the build inlines them — never hard-code URLs).

`frame` (passed to every `update`) = `{ t, dt, simDays, camera, camUniverse /* Vector3 */, shot, positions, bodies }`.

### Body modules (`src/bodies/<id>.js`)
```js
return {
  id, radius,                 // equatorial radius, scene units (ctx.data.radius)
  object,                     // THREE.Object3D; main.js sets object.position = ctx.positions[id]
  update(frame),              // orient/spin meshes, advance moons, update your uniforms
  moons: [ { id, name, radius, positionAt(simDays) -> Vector3 /* offset from parent centre, world axes */ } ],
};
```
The director, lens-flare occlusion and near-plane logic read `moons[].positionAt`, so it must be a pure function and
must match where you draw the moon. Moons with a shot in the film (section 5) need real visual quality; other moons
may be simple but must not look bad when they cross the frame.

### Asteroid belt (`src/bodies/asteroids.js`)
`{ object /* added to world at universe origin */, update(frame), setCrossing(position, direction), nearestDistance(camUniverse) }`.
`setCrossing` gives the point (universe coords, ~2.7 AU from the Sun) and direction where the camera flies
through the belt; build a dense, beautiful local field there (artistic licence: the real belt is nearly empty —
use thousands of instanced rocks within a few thousand units of the path, near ones big and detailed, plus dust)
and a faint sparse belt ring for wide shots. `nearestDistance` returns the distance to the closest rock surface.

### Sky (`src/sky/sky.js`)
`{ object /* added to scene root, follows camera (camera is at origin) */, update(frame) }`.

### Post (`src/render/post.js`)
`{ setSize(w, h), render({ scene, camera, shot, sun, dt, t }) }` — owns the HDR target and everything after it.
`sun` = `{ ndc: Vector3, onScreen, visible /* 0..1 analytic occlusion */, angularRadius, distance }`.
`shot` carries `exposure`, `warp` (0..1), `fade` (0..1 to black), `letterbox` (0..1), `focus`.

### Glints (`src/render/glints.js`) — owned by the director piece
Star-like points for planets/moons whose discs are under ~2 px, so you can always see where you are going.

### Director (`src/journey/director.js`, plus `src/journey/*`)
```js
return {
  duration, chapters: [ { id, title, body?, t0, t1 } ],
  evaluate(t) -> shot,        // PURE function of t (seekable)
  beltCrossing: { position, direction },
  object?,                    // optional: added to world (e.g. orbit lines for the finale)
  update?(frame),
};
shot = { camPos /* universe Vector3 */, camQuat, fov, simDays, exposure, warp, speedC, skyGain, focus,
         chapter, chapterIndex, fade, letterbox, captions? /* data for the HUD */, audio? /* cues */ }
```

### HUD (`src/ui/hud.js`, plus `src/ui/*`)
`{ setLoading(p01), attach({ director, bodies }), update(t, shot, { playing, muted, duration }) }`.
Owns all DOM: splash/loading screen with the start button (calls `ctx.app.start()` — required for audio),
title cards, captions, telemetry, timeline, controls, keyboard. Injects its own CSS. `ctx.app` has
`seek(t), play(), pause(), togglePlay(), setMuted(b), t, playing, muted`. Must be hidden when `ctx.visible === false`.

### Audio (`src/audio/score.js`, plus `src/audio/*`)
`{ start() /* on the user gesture */, update(t, shot, playing), seek(t), setMuted(b) }`. WebAudio only, generated
in code (no samples, no services).

## 5. The film (shot list — the director executes it; body builders make these shots stunning)

Working runtime ≈ 6–7 minutes. Real-scale travel is compressed by "warp" legs: the camera accelerates with
log-distance easing so the next world swells from a point of light; stars streak; the HUD reads speed in
multiples of c and light-time from the Sun.

0. **Cold open.** Black. Stars fade up — the real sky, the Milky Way. Title: FOUR LIGHT-HOURS.
1. **The Sun.** Wide: whole disc, limb darkening, granulation, sunspot groups, prominences on the limb, corona.
   Then a skim over the photosphere a few tenths of a radius up: granules, faculae, a prominence arching overhead.
2. **Mercury.** Half-lit with the Sun huge and blinding just off-frame; low pass along the terminator — long
   crater shadows, bright ray craters.
3. **Venus.** A thick-atmosphered crescent with a glowing limb; the featureless-yet-subtle cloud deck in daylight.
4. **Earth & Moon.** Blue Marble approach; terminator pass — city lights on the night side, a sunrise over the
   limb through the blue atmosphere; then the Moon: **Earthrise** over the grey lunar horizon.
5. **Mars.** Rust disc with Valles Marineris, a polar cap, thin dusty limb haze; Phobos crosses close in front.
6. **Asteroid belt.** Threading a field of tumbling rocks; the Sun small and distant.
7. **Jupiter.** Galilean moons strung out; the banded disc and Great Red Spot; Io's shadow on the clouds; a low
   skim over turbulent cloud tops; departure crescent.
8. **Saturn.** Approach above the rings (low sun angle → long planet shadow across the rings, ring shadow bands on
   the globe); skim just over the rings; then the **eclipse shot** — Saturn backlit, Sun hidden, rings glowing in
   forward scattering; Titan's hazy orange disc.
9. **Uranus.** Nearly pole-on to the Sun right now: a pale cyan globe with a bright polar haze and its thin rings
   as a bullseye; moons.
10. **Neptune.** Deep blue, a dark spot with bright companion clouds; crescent with Triton; departure.
11. **Finale.** Pull far back: the Sun a bright star; planets as labelled points; a look back to find Earth — a
    single pale blue pixel; closing card and credits (data: NASA/JPL/USGS, Yale BSC5, Natural Earth).

## 6. Pieces, owned files, and the bar

Each piece is judged by an independent critic who renders it with `tools/shot.mjs` and compares it to `bar/refs/`
and to this bar. **Floor** = minimum to be judged at all. **Target** = the real bar.

| piece | owns | floor | target |
| --- | --- | --- | --- |
| sun | `src/bodies/sun.js`, `src/bodies/sun/*` | animated photosphere, limb darkening, corona, HDR disc | an SDO-grade Sun: granulation, sunspots w/ penumbra, faculae, limb prominences, layered corona/streamers; convincing in the close skim |
| mercury | `src/bodies/mercury.js`, `src/bodies/mercury/*`, `assets/mercury/*` | cratered lit sphere, correct terminator | MESSENGER look: crisp craters with relief at the terminator, bright rays, no blur at 0.1 R altitude |
| venus | `src/bodies/venus.js`, `src/bodies/venus/*` | cloud-covered sphere + atmosphere | creamy cloud deck with subtle banded/Y-shaped structure, thick limb glow, beautiful crescent with forward-scatter ring |
| earth | `src/bodies/earth.js`, `src/bodies/earth/*`, `assets/earth/*`, `assets/moon/*` | real continents, oceans, clouds, atmosphere, Moon | Blue-Marble quality: ocean sun-glint, animated clouds with shadows, city lights only on the night side, Rayleigh limb + sunset-red terminator, photoreal Moon (real maria) for Earthrise |
| mars | `src/bodies/mars.js`, `src/bodies/mars/*`, `assets/mars/*` | real Mars map, lit sphere | Valles Marineris & volcanoes in relief at the terminator, polar cap, dusty limb haze, Phobos/Deimos lumpy and believable |
| jupiter | `src/bodies/jupiter.js`, `src/bodies/jupiter/*`, `assets/jupiter/*`, `assets/{io,europa,ganymede,callisto}/*` | banded, animated globe, GRS, 4 moons | Juno/Cassini look: turbulent flowing belts & zones, festoons, white ovals, GRS vortex, moon shadow transits, detail holds in the low skim |
| saturn | `src/bodies/saturn.js`, `src/bodies/saturn/*`, `assets/saturn/*` | banded globe + ring system | Cassini look: real ring structure (C/B/Cassini div./A/Encke/F), planet shadow on rings, ring shadows on globe, backlit forward-scatter, north hexagon, Titan haze |
| uranus | `src/bodies/uranus.js`, `src/bodies/uranus/*` | pale cyan globe, rings, correct tilt | Voyager/JWST look: subtle limb-darkened haze, polar cap brightening, thin dark rings (ε brightest), 5 major moons |
| neptune | `src/bodies/neptune.js`, `src/bodies/neptune/*`, `assets/triton/*` | deep-blue globe, Triton | Voyager look: dark spot + bright companion clouds, streaky cirrus, faint rings w/ Adams arcs, Triton's pinkish cantaloupe terrain |
| asteroids | `src/bodies/asteroids.js`, `src/bodies/asteroids/*` | instanced rocks along the crossing | varied irregular rocks with craters/regolith, correct lighting and self-shadowing look, depth & parallax, dust glints, no popping |
| sky | `src/sky/*`, `assets/sky/*` | real star catalog + Milky Way band | the real sky: BSC5 stars with true colours/brightness and recognizable constellations, a photographic Milky Way along the true galactic plane with dust lanes & bulge, faint star field; streaks during warp; no aliasing |
| post | `src/render/*` (not glints) | HDR + bloom + filmic tonemap | physically based bloom, sun glare/lens flare with analytic occlusion, filmic grade, subtle grain/vignette/CA, warp effects, fades & letterbox, temporal stability |
| director | `src/journey/*`, `src/render/glints.js` | complete tour with smooth camera | a cinematographer's tour: motivated, smooth, varied shots per section 5; no clipping into bodies, no jarring cuts, timed beats for HUD/audio |
| hud | `src/ui/*` | splash, title cards, controls | elegant cinematic typography & telemetry, accurate facts (use `BODIES[id].facts`), timeline with chapter scrubbing, keyboard + touch, hides cleanly |
| audio | `src/audio/*` | generative ambient score + warp SFX | an evolving, emotional score scored to chapters, spatial reverb, no clipping, tasteful SFX, mute |

## 7. Testing — `tools/shot.mjs`

The dev server (`node tools/serve.mjs`, port 5178) starts automatically. Examples:
```bash
node tools/shot.mjs --q "view=body&body=saturn&dist=4&phase=40&el=12&only=saturn" --out shots/saturn/a.png
node tools/shot.mjs --q "view=body&body=earth&target=moon&dist=1.08&phase=95&el=2&fov=50" --out shots/earth/moon.png
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.15&phase=30&el=5&days=0.2" --hud 0 --out shots/jupiter/skim.png
node tools/shot.mjs --t 0:300:25 --sheet shots/journey/sheet.png --cols 4         # journey contact sheet
node tools/shot.mjs --q "view=body&body=mars&dist=3" --perf 4                      # fps while rendering
```
`view=body` params (see `src/main.js` header): `body`, `target` (moon id), `dist` (target radii from centre),
`phase` (Sun–target–camera angle; 0 = full, 90 = half, 160 = crescent), `el`, `roll`, `fov`, `look=yaw,pitch`,
`days` (simulated days after the epoch), `exposure`, `sky`, `only=<ids>` (load only these modules for real),
`epoch=<ISO date>`. Write screenshots to `shots/<piece>/`. Look at them (Read the PNG) — they are the truth.

`shot.mjs` reuses pooled Chrome profiles (`%TEMP%/fourlh-shot-profiles`), so the GPU shader cache survives between
runs (a warm run starts in ~5 s instead of ~40 s); `--fresh` uses a throwaway profile. Other checks:
`tools/checks/shader_cost.mjs` (compile cost per object; `--parallel` for the real splash wait),
`tools/checks/perf_probe.mjs` (cold/warm frame cost after seeks, real-time playback timings; `--sequential` steps
the whole film), `tools/checks/file_url_check.mjs` (the built `index.html` opened from disk).

Pieces that are not visual in stills (audio, motion) must provide another observable: e.g. a filmstrip with
`--t a:b:step --sheet`, or an offline render/analysis script under your folder that writes a report to `notes/`.

## 8. Notes

Keep `notes/<piece>.md` current: what exists, how to see it (exact shot commands, which shots best show the
piece), known gaps, requests to the integrator.
