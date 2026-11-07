# Asteroids piece: notes

Owner files: `src/bodies/asteroids.js`, `src/bodies/asteroids/*`:

| file | what |
| --- | --- |
| `asteroids.js` | module entry: shapes (Web Workers), per-(shape, LOD) instanced meshes, CPU mesh selection, wiring, director-path corridor, hero beats, debug shape gallery |
| `asteroids/shapes.js` | procedural shape library (self-contained so it can be stringified into a Worker), morph-LOD icosphere hierarchy, fracture-plane cuts, impact bites, crater and boulder populations, baked AO / cavity / pond / fresh-crater channels, octahedral radius maps |
| `asteroids/field.js` | the swarm: ONE noise-warped ellipsoidal density for meshes, points, glow and dust (JS and GLSL mirrors), size classes, PCG lattice, composition classes, shape-frequency table, hero set pieces and clusters, per-cell cache, `nearestDistance` |
| `asteroids/beats.js` | hero beats: heroes placed where the film camera (director, a pure function of t) holds them, at a sculpting phase angle |
| `asteroids/rockMaterial.js` | rock shader (ONE program for all 155 shape/LOD materials): Hapke-roughened lunar-Lambert photometry, saturated crater octaves (degradation states, rims, analytic bowl shadows, bounce, cavity sky-view) with boulders in the same loop, macro self-shadows through the radius map (0.1-degree Sun), macro-concavity bounce, topography-driven albedo, silhouette-band backlit limb, M-type GGX lobe |
| `asteroids/points.js` | GPU lattice per size class: PSF points (fixed sigma, lightcurves) and impostors sphere-traced against each shape's own radius map |
| `asteroids/dust.js` | dust motes: motion streaks, forward-scattering phase function with diffraction peak, flake glints, clumps and voids, hero shadows |
| `asteroids/glow.js` | integrated light of the unresolved swarm plus the forward-scattering dust haze (same outer shape, broader core; lanes), extinction, dust shadow cylinders behind heroes |
| `asteroids/ring.js` | the belt for wide shots: ~75k Keplerian points (Kirkwood gaps, Hungarias, Cybeles, Hildas, Trojans) plus a volumetric band with the Kirkwood lanes, exposure floor and glare lift; geometric gate (below) |
| `asteroids/gputimer.js` | `astdbg=gpu`: GPU timer queries per pass into `window.__asteroids.stats.gpu` / `gpuMin` |
| `asteroids/hash.js`, `asteroids/simplex.js` | PCG hash and value noise (shared JS/GLSL), seeded simplex |

No external data and no assets: everything is generated at load (about 1 s of Worker time, off the main thread).

## Wave 2 changes (2026-11-03)

1. **Belt ring gated (cross-piece fix, landed first).** `ring.js update()` multiplies the director's
   `shot.beltRing` (1 when absent, i.e. every `view=body`) by a geometric gate: on within ~0.25-0.45 AU of the belt
   annulus (2.06-3.3 AU, |z| < 0.3 AU) or from well out of the ecliptic (latitude seen from the Sun > 10-16 deg:
   the finale), otherwise 0 (band and Kepler points both off). From Mercury, Venus, Earth, Mars (1.6 AU) and Saturn
   the grey 15-degree ecliptic band / speckled dust lens is gone; the finale ring (camera 46 AU at 33 deg latitude)
   is unchanged. Before/after: `shots/asteroids/w2/band/` (venus, saturn eclipse, film 200/206, finale 426).
2. **Swarm envelope rebuilt.** Root cause of the "soft-edged glowing rectangle": a slow power-law core truncated
   by box smoothsteps at |a| = 20-26, |b| = 3-5 and a planar front in s. Now: power-law core x a Gaussian-to-
   exponential taper over a noise-warped, slightly sheared ellipsoid (semi-axes 9.5 x 2.5, scaled +-30% / +-25%
   by a filament noise, displaced +-2.5 / +-0.6 by a broad warp, shear 0.04 a per unit s), warped fronts (+-8
   units across the cross-section), large-scale voids and filaments away from the axis (filament noise
   3.6 x 1.25 x 50 units, so even an end-on view integrating the whole swarm shows streaks), plus the old clump
   octaves near the path. ONE function (`swarmShape` in JS / `fieldShape` in GLSL) drives meshes, GPU points, the
   integrated glow and the dust haze (11 x 2.8 core inside the same outer shape). The bounding box (26 x 7 x 82) is
   never visible: the density there is ~0.5% of the axis value.
3. **Points read as distant rock, not snow.** Unresolved rocks use the camera PSF (fixed sigma 0.6 px), so peak
   brightness follows flux (albedo x phase x area x lightcurve): a few bright S-types, many faint C-types instead
   of equal 2-4 px blobs. Impostors (real outlines) take over from ~2 px (was ~3). The impostor -> mesh hand-over
   (8-12 px) no longer ghosts: the impostor stays opaque but sits at the back of the rock (depth + bounding
   radius), so the mesh's alpha-to-coverage samples hide it (complementary coverage, no half-grey background seen
   through the rock).
4. **Rock surfaces (plaster/soap -> rock).**
   - Crater field at saturation: 4 candidates per cell (one cell hash + one PCG round per candidate), radii
     0.13-0.32 cell, 7 octaves (cells 0.2 x 2^-i): ~15% area per octave, craters on craters. Wave 1 covered ~5%
     per octave, which is why the pocks looked sparse and stamped. Degradation per crater (fresh: d/D 0.21, crest
     ~0.045 D, bright walls and ejecta; mature: d/D 0.05, soft); finer octaves are older (gardening).
   - Boulders are candidates of the same loop on rubble piles and heroes (dome, 30-60% buried, hard cast shadow).
   - Albedo from topography, not blobs: maturity patches +-10% (was +-20% camouflage), fresh crater walls/ejecta
     and steep slopes bright (bluer on S-types), old floors and concavities darker (fines), regolith grain +-6%.
     S-types tan (tint 1.09 : 1 : 0.86), D redder, B slightly blue.
   - A Sun-independent cavity sky-view (crater bowls, vertex AO) keeps front-lit rocks legible; macro shadows in
     concavities get bounce from their sunlit walls (day side only); convex shadowed sides stay black.
   - Mesh: radial detail displacement is attenuated where the base surface is steep relative to the radial
     direction (cos < 0.65), where a radial displacement is mostly tangential and sheared relief into flaps.
   - Backlit limb only on the real silhouette ((1 - mu)^2 of the mesh normal) inside the smoothed body's limb
     zone (radius-map normal sampled 0.12 rad apart, ~15 px wide): interior ridges and crater rims no longer
     light up as contour lines on crescents.
5. **Shader compile diet (ANGLE -> HLSL -> FXC).** All loop bounds are uniforms; nested loops flattened (crater
   cells x candidates, field noises x corners) with counters instead of integer division; the GLSL value noise is
   a uniform-bounded corner loop (`uVN`); the four field noises come from one call site (`fieldNoises`); the rock
   shader uses no simplex (value-noise albedo loop, one call site); the separate boulder layer is merged into the
   crater loop; `textureLod` for radius-map reads inside loops; the 32-entry const shape table is packed into six
   uints; the dust takes the swarm density at the camera from the CPU; all 155 rock materials share one program
   (alphaToCoverage on everywhere, the fade is a uniform); rock buckets are no longer force-drawn on the first
   frame (that hid their compile cost from the tool; main.js warms every program behind the splash). Every
   material exists from `create()`.

## Shader compile cost

`node tools/checks/shader_cost.mjs --q "only=asteroids,post" --top 25` (fresh Chrome profile; CPU shared with other
builders, so two runs, lower taken):

| program | wave 1 | wave 2 |
| --- | --- | --- |
| rock (all 155 materials) | 2 programs x ~505 ms (hidden from the tool by the first-frame draw) | 281 / 322 ms |
| points (9 classes, one program) | 262-435 ms | 201 / 222 ms |
| glow | 639 ms | 107 / 112 ms |
| dust (3 layers, one program) | 161-327 ms | 70 / 73 ms |
| belt band + belt points | ~50 ms | ~50 ms |
| **piece total** | ~2160 ms (931 ms reported) | **743 ms** / 818 ms |

## Field descriptor (for the director)

`import { FIELD } from '../bodies/asteroids.js'` (pure constants, safe to import). The module object also carries
it as `belt.field`.

| key | value | meaning |
| --- | --- | --- |
| `halfLength` | 60 | the dense swarm spans s = -60 .. +60 units along `beltCrossing.direction` from `beltCrossing.position` (density ramps over s = -62..-50 and 50..62, fronts shifted +-8 units across the cross-section) |
| `tail` | 22 | sparse "vanguard" rocks continue to abs(s) = 82 |
| `halfWidth`, `halfHeight` | 26, 7 | bounding box across the path (A in the ecliptic, B out of it); the density is ~0 well inside it |
| `coreWidth`, `coreHeight` | 4.0, 1.4 | power-law core (1 + (a/4)^2 + (b/1.4)^2)^-0.75 around the axis |
| `taperWidth`, `taperHeight` | 9.5, 2.5 | warped ellipsoidal taper (Gaussian near the axis, exponential tails) |
| `radius` | 26 | bounding radius of the cross-section (kept for older readers) |
| `corridor` | 0.012 | no lattice rock comes within 0.012 units (76 km) of the axis |
| `recommendedSpeed` | 0.25 | units/s for the beautiful part of the pass (0.08 to 0.12 for a slow hero close-up) |

Units are Earth radii (1 unit = 6371 km). Rocks are true-size: 0.4 to 200 km radius in the lattice; the inspection
heroes are 54 to 320 km, the film's beat heroes up to ~0.12 units bounding radius. The density is the artistic
licence: a young collisional-family swarm, far denser than the real belt (the HUD caption says so).

### `belt.heroBeats`

Filled on the first frame: `[{ name, t, t0, t1, position /* universe Vector3 */, radius, score }]`, re-planned from
whatever the director currently does (beats.js: a search over hero positions in front of the camera, scored by
time in frame x on-screen size x a phase-angle preference x centring; nothing within reach of the camera path or
another hero, nothing that would eclipse the Sun). With the latest cut (belt chapter t = 192.3..218.9: arrival
~195, glide ~196-208, side-lit ~208-212, sunward beat ~212-217 with the Sun ~38 deg off axis): Eros-like 205.2
(198.6..205.9), Ida-like 209.1 (198.9..211.2), Itokawa-like 211.4 (199.1..212.4).

### How the field adapts to the director

- On the first frame the module samples `ctx.director.evaluate(t)` over the whole film, finds where the camera is
  inside the swarm box, and clears a 0.02-unit corridor around that actual path for every lattice rock (CPU and GPU
  agree). Any hero within reach of the path is nudged sideways. `nearestDistance()` is conservative.
- Inspection-view heroes look at the Sun direction at the crossing and are framed at a phase near 70 degrees.

### Set pieces (field-local: s along the path; A = B x D; B = ecliptic north made perpendicular to D)

- The three film beats (above).
- s = -1.6 .. +4.5: Eros-, Ida-, Didymos-, Itokawa-like and a dark C-type 0.06 to 0.1 units off the axis (close
  whips), plus a cluster of 26 medium fragments within 0.08 to 0.9 units.
- s = -30 (inspection camera at dist = 0.6): Eros-like hero in the forward view; Ida-like hero with its moonlet
  (Dactyl-like) for phase = 40; Didymos-like top with a Dimorphos-like moonlet for phase = 90; 34 fragments.
- s = -65 (dist = 1.3, entering): Itokawa-like contact binary at 0.33 units, a Vesta-like remnant 2.3 units ahead,
  and 26 vanguard rocks.

Real rotation periods for the analogues (Eros 5.27 h, Itokawa 12.13 h, Ida 4.63 h, Didymos 2.26 h, Vesta 5.34 h);
on the film clock (TIME_SCALE 1200) Eros turns once every 15.8 s.

## How to see it (best shots)

```bash
# required views
node tools/shot.mjs --q "view=body&body=asteroids&dist=1.3&fov=55" --hud 0 --out shots/asteroids/enter.png
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6&fov=55" --hud 0 --out shots/asteroids/in.png
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6&fov=55&phase=40" --hud 0 --out shots/asteroids/in40.png
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6&fov=55&phase=90" --hud 0 --out shots/asteroids/in90.png
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6&fov=55" --t 0:3:0.5 --sheet shots/asteroids/tumble.png --hud 0
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6" --perf 4
# the film's belt chapter (if the director re-cuts, a coarse sweep --t 150:260:4 prints the chapter per frame)
node tools/shot.mjs --t 192:218:2 --sheet shots/asteroids/film.png --cols 4 --hud 0
node tools/shot.mjs --t 195,205.2,209.1,214 --out shots/asteroids/film_{t}.png --hud 0   # outside, Eros beat, Ida, sunward
# hero surfaces (saturated craters, boulders, tan S-type albedo)
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6&phase=27.5&el=-4&fov=16" --hud 0 --out shots/asteroids/eros16.png
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6&phase=27.5&el=-4&fov=7" --hud 0 --out shots/asteroids/eros7.png
# the swarm from outside (no box edges), 200 units before the crossing
node tools/shot.mjs --q "view=body&body=asteroids&dist=4&fov=55" --hud 0 --out shots/asteroids/outside.png
# shape gallery (galpx = bounding radius in px, galtype 0 = C, 1 = S)
node tools/shot.mjs --q "view=body&body=asteroids&dist=0.6&fov=55&phase=-90&only=asteroids,sky,post,director&astdbg=gallery,nopoints,nodust,noglow&galpx=60&galdist=0.4" --hud 0 --out shots/asteroids/gallery.png
# belt ring: finale (gated on) and a planet view (gated off)
node tools/shot.mjs --t 426 --hud 0 --out shots/asteroids/finale.png
node tools/shot.mjs --q "view=body&body=venus&dist=3&phase=120" --hud 0 --out shots/asteroids/venus_noband.png
# compile cost
node tools/checks/shader_cost.mjs --q "only=asteroids,post" --top 25
```

Fast isolated runs: add `&only=asteroids,sky,post,director` (keep `director`: without it the fallback director
uses a different crossing and Sun direction; add `sun` for wide shots so post's real glare is present).
Debug switches (URL `astdbg=`): `nocs,nomacro,noboulder,nocrater,rim` (shader; `rim` shows the limb weights),
`noglow,nodust,nopoints,nomesh,noring` (passes), `gallery` (with `galpx`, `galtype`, `galdist`), `gpu` (timer
queries). `window.__asteroids` exposes `stats` (meshes, points, cpuMs, enumMs, gpu, gpuMin), `field`, `heroBeats`,
`director`. Wave-2 validation shots: `shots/asteroids/w2/` (`band/` before/after, `final/` required views and
tumble, `v2/` and `v3/` film frames of the new cut, `surf/` hero close-ups before/after, `env/` arrival frames).

## Technique summary

- **Shapes.** 20 regular (LOD 0..5) + 5 hero shapes (LOD 0..6). Mid-size rocks are mostly angular collisional
  fragments (~56% by the frequency table): ellipsoids up to 3:1 cut by sharp fracture planes, a Gaspra-like body
  with 6 flat break faces, shards and split fragments; notched potatoes and bananas; contact binaries / dog-bones
  (~12%); a Bennu-like top and Mathilde-like giant craters. Star-shaped radial functions: base solid -> muted
  low-frequency lumps + ridged fracture texture -> fracture-plane cuts -> impact bites -> power-law craters
  N(>D) ~ D^-2 -> boulders -> grooves / troughs -> ponds in the necks; detail attenuated on steep flanks.
- **LOD.** LOD k starts at a bounding radius of 2.5 x 2^(k-1) px; continuous morph, no popping.
- **Per-pixel detail** (footprint-filtered): wave 2 item 4.
- **Shadows.** Macro self-shadowing ray-marched (40 steps) through the shape's radius map with the penumbra of the
  0.1-degree Sun at 2.7 AU; exact paraboloid bowl and boulder cast shadows; bounce inside craters and macro
  concavities; fill light 0.25%.
- **Photometry.** Lunar-Lambert on Hapke (1984) macroscopic-roughness cosines with the shadowing function (mean
  slope 30 deg), exponential phase darkening (steeper for C/B/D) with an opposition surge, a weak forward lobe,
  the silhouette-band backlit limb, an M-type GGX lobe on scattered bare facets. Composition by number at 2.7 AU:
  ~55% C/B/D (p_v 0.03-0.08), ~22% S (0.15-0.25), ~5% M, ~4% V.
- **Points and impostors.** < 2 px: PSF points with the real lightcurve; 2-12 px impostors sphere-traced against
  each shape's radius map (lunar-Lambert); meshes from 8 px.
- **Glow and dust.** The glow integrates the unresolved cross-section exactly complementary to the point fade-out
  (same density function), plus fine dust with a forward-peaked phase function (0.85 HG(0.8) + 0.1 HG(0.97) +
  0.05 HG(-0.3)), lanes, and shadow cylinders behind the nearest heroes.
- **Belt ring.** Points on gap-carved Keplerian orbits (4:1, 3:1, 5:2, 7:3, 9:4, 2:1; Hungarias, Cybeles, Hildas,
  Trojans) + a volumetric band with mip-mapped Kirkwood lanes; exposure floor and glare lift for the finale;
  geometric gate (item 1); off inside the annulus, where the local swarm carries the light.

## Performance (RTX 4090, 1600x900, GPU shared with other builders)

- GPU timer queries (`astdbg=gpu`, min of 90 frames) at `view=body&body=asteroids&dist=0.6&fov=55`, isolated:
  piece ~1.8 ms = meshes 0.95 + points 0.35 + glow 0.46 + dust/ring ~0.01 (wave 1: 1.65 ms; the glow's 40-step
  loop now evaluates the shared shape noises). CPU ~1.4 ms per frame (1.2 ms lattice enumeration).
- `--perf 4` at the required view with every module: 218 fps (4.6 ms avg, 8.3 ms p95).
- `q=low` drops the two smallest point classes.

## Known gaps

- Steep "ledges" on the elongated heroes (where the radial parametrisation is nearly tangent to the surface, e.g.
  the Eros-like saddle wall) still show stretched-triangle striations at fov <= 16; a real fix needs displacement
  along the surface normal or a non-radial hero mesh.
- From outside the swarm (film ~195, a ~1 s glimpse) the cloud is integrated glow only: the largest rocks are
  physically < 0.5 px there and the point lattice does not reach that far (cost).
- Backlit rims in the sunward beat (~212-217) are soft against the bright forward-scatter haze; tiny backlit rocks
  are dark specks only through the glow's extinction (points are additive).
- Dust glints are rare and faint; no motion blur on fast near whips.
- Per-pixel craters and boulders are normal/shadow detail only: the limb silhouette shows mesh-level relief.
- Rocks do not exclude each other: small lattice rocks can intersect the big beat heroes.
- The ring band's glare lift is calibrated on post's current glare (one constant in ring.js).

## Requests to the integrator / director

- The latest cut's side-lit glide and sunward beat (Sun ~38 deg off axis, ~212-217) are what this piece wanted;
  keep the Sun just outside the frame there. The Eros-like beat (~205) reads best at phase 60-100 deg.
- For the belt ring to read in a wide shot, frame at least one beat with the Sun off-frame or small (glare off
  the annulus), e.g. the finale before the pale-blue-dot zoom.
