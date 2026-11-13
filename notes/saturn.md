# Saturn (rings and moons) — builder notes

Owns `src/bodies/saturn.js`, `src/bodies/saturn/*`, `assets/saturn/*` (+ `assets-src/scripts/process_saturn_rings.py`,
`assets-src/raw/saturn_rings_pps/`, Saturn section of `assets-src/SOURCES.md`).

## Wave 3 (current) - what changed

Before / after: `shots/saturn/base_t*.png` vs `shots/saturn/film_t*.png` (`film_sheet.png`). Film beats (current cut):
268-274 approach from below the lit face, 275-283 under the lit face beside the globe, 284-287 crescent, 288-302
eclipse, 306-320 Titan.

1. **Globe** (globe.js). Minnaert k was 0.9: with `pow(mu, k - 1)` that brightens the sunward limb (flat disc). Now
   k = 1.03 plus a view-limb falloff `pow(mu, (0.24, 0.30, 0.42))` (deeper tan at the limb), faded out toward the
   crescent. Fine striations x1.9 and their hue swing x1.7 (pale gold / butterscotch / faintly pink tan): the bands
   are no longer flat fills between soft edges.
2. **Ring structure** (rings-data.js `brightnessStructure`). The B2-B4 stand-in for the saturated PPS data is now a
   ~1/f hierarchy of abrupt bands from 900 km down to 4 km at about twice the contrast (albedo factor exp(0.48 x) vs
   exp(0.32 x)), and the real structure elsewhere is enhanced x1.3. The film's ring views have radial footprints of
   30-300 km, so this (not the 1-12 km straw) is what makes the lit face read as thousands of ringlets.
3. **C ring** (particleProps): effective albedo x1.35 and warmer (0.80, 0.70, 0.585 + plateaus), chroma factor 1.45.
   Note the rings as a whole are physically dim in 2026 (Sun 8 deg above the plane: lit-face B ring I/F ~0.1, a fifth
   of the globe); C / B is ~0.5-0.6 on the lit face at this geometry.
4. **Planet shadow on the rings** (rings-glsl.js `planetShadow`): softening scale 76 -> 200 km (refraction), so the
   shadow edge is a few px of warm falloff instead of a razor line.
5. **Eclipse**: limb-haze gain 1 -> 1.6 with eclipse depth (`uHazeGain`, saturn.js): brighter refracted arc; ring
   dynamic range comes from item 2. Otherwise untouched.
6. **Titan** (moons.js): main-haze cut-off now starts at 270 km and is steeper, detached layer thinner (sigma 10 km)
   and x0.4: the backlit ring is a fine orange-cream rim, a dark gap and a faint blue-violet thread, not one thick
   tube out to 500 km; the half-phase disc keeps its soft terminator.

Not a bug (checked): at t ~ 280 the "translucent disc" over the rings is the globe's northern hemisphere carrying the
rings' own shadow bands; the straight edge at lower right is the A ring's outer edge seen from inside.

## Wave 2 - what changed

Film window in the current cut (re-locate by chapter `saturn`): 268-271 small disc, 273-277 approach above the
lit face, 277-286 skim ~0.16 R under the lit face + close globe, 286-291 crescent / sun at the limb, 292-306
eclipse, 308-325 Titan.

1. **Globe banding (board #1) - root cause fixed.** The band-albedo LUT is now indexed by a nearly straight latitude
   (`latB` = lat + 0.06 deg x meander). The vortex domain rotation, the meanders/eddies and the wave trains no longer
   deflect the LUT (they dragged its sharp edges into hooks / 'paint drips'); they only move the cloud texture
   (`sp`) and a second, flow-following latitude `latW` that drives the fine striations and filaments (those really
   are deflected around eddies). Every LUT edge has a minimum width (profile convolved with a 0.17 deg Gaussian
   before the thin dark lines go on: ~0.45 deg 10-90 % ramps). Band-to-band contrast around the envelope x0.8 for
   the equatorial belts, x0.4 poleward of ~27 deg (was 1.0 / 0.6). New latitude-only striation layer (periods
   0.04-1.5 deg, +-2-3 % each) baked in a 16384-texel mip-mapped strip (`buildStriationTexture`), sampled at `latW`
   with LOD from the footprint, so it is exactly box-filtered. Wave trains <= 0.08 deg (were 0.26-0.48, cusped) --
   then removed from the shader entirely (invisible at that amplitude). Vortex rotation/albedo now fall off
   C1-continuously ((1 - r^2/9)^3); popcorn relief -65 %, convective relief -33 %. Hexagon: smooth rounded outline,
   no noise threshold on its edges, laminar streaks, four log-spiral arms (it is still in polar night in 2026).
2. **Ring skim (board #2).** *Saturnshine*: `computeSaturnshine` (rings-data.js) integrates, at load (~20 ms), the
   irradiance of the visible lit globe on BOTH faces of every ring point (40 radii x 32 azimuths from the sub-solar
   meridian), including the rings' own shadow on the globe (the B ring shadows the northern tropics in 2026, so the
   north face gets less), plus the mean elevation of the planet light. The ring shader reflects the camera-face share
   and diffusely transmits the far-face share with the same slab photometry and particle/dust phase functions as the
   sunlight (planet light travels outward: backlit when you look toward the planet). Values: 2-9 % of sunlight at
   the inner B ring on the sub-solar side, ~1 % at the outer B ring. Planet light uses a Lambert albedo matched to
   Saturn's full-phase brightness (0.77, 0.70, 0.60; chroma halved like the globe's ringshine). Where planet light is
   the ONLY light (unlit face, planet shadow) it gets a display lift `uSSLift` = 1.5 x nightLift (4.5; fades to 1 where
   sunlight is >15 % of it, and to 1 during an eclipse) -- same reasoning as the globe's ringshine lift: 1 % of
   daylight is black after the AgX toe. The unlit-face skim is now a dim brown, textured floor instead of a void, and
   the unlit-face reversal (black B ring vs glowing C / CD / A) still reads. *Near field*: three octaves of 'straw'
   (canted ~21 deg trailing, 1:15-1:23 elongated clumps with gaps, radial size 12 / 4 / 1.3 km) on a lattice that
   wraps seamlessly around the ring (integer cells per revolution, integer hash), modulating tau / particle brightness;
   all near-field octaves now fade at ~1.5 px per feature (were ~3 px); radial footprint = max of the two screen axes
   (was their length) and ring-profile LOD bias -0.3 -> crisper nearest ring, no moire (checked at telephoto
   dist=12/25). The density waves are the real ones in the PPS data (Janus 6:5, Mimas 5:3...) and show wherever the
   footprint resolves them.
3. **Lit-face C ring (board #4).** C ring / Cassini Division effective particle albedo raised (C 0.30 -> 0.58,
   CD 0.36 -> 0.66 in r at tau ~ 0.1 plateau-dependent). Classic view: C ring display 21 -> 44 /255 against the B
   ring's 91 (linear ~0.2 of B, Cassini lit-side ratio), Cassini Division 12 -> 28. It now reads as a translucent grey
   band with stars through it. Brighter on the unlit face too (the reversal is stronger).
4. **Shader compile budget.** FXC (ANGLE D3D11) inlines every call and unrolls constant-bound loops. All Saturn loops
   now run to `N + uSatZero` (an int uniform that is never set, so always 0: rings-glsl.js) and every big noise stack
   goes through ONE `snoise` call site: the globe's 16 turbulence octaves + 10 polar/convective/popcorn fields + 12
   filament fields are one table-driven loop (`NZ` in globe.js, results scattered branchlessly into vec4 slots -- an
   if-chain there alone cost FXC ~200 ms); zonal wind, belt weight, vortex density and striations come from latitude
   strips; the icy-moon height field is evaluated 3x (finite-difference normal) inside one loop and all of its noise
   (regolith at the 3 sample points, Enceladus fields, albedo fbm, Dione/Rhea wisps) is one 21-entry loop; named
   basins (Herschel, Odysseus, Tirawa, Inktomi) are one loop over `uBig` uniforms; the rings' three phase-function
   evaluations (sun, planet light on each face) are one loop. Measured with `tools/checks/shader_cost.mjs --q
   "only=saturn,post"` (fresh profile, two runs, other agents loading the CPU): **702 / 704 ms** total (globe 325-330,
   icy moons 223-238, limb haze 76, Titan 59-78) vs 9194 ms measured the same way at the start of this wave (wave-1
   lead figure 5868). That tool does not see the ring programs (they compile in the first frame: the ring meshes are
   not frustum-culled); a cache-busted per-program measurement (`scratchpad` tool, same conditions) gives main rings
   218 ms, E ring 50, G ring 16, i.e. ~1.0 s for the whole piece including rings (was ~10.9 s). Same images, runtime
   still at the 240 Hz vsync cap (full-screen globe and the unlit skim, `--perf 4`). All materials exist after
   create() (no lazy creation, no runtime define changes).

Before/after shots: `shots/saturn/w2/base/` (start of wave 2) vs `shots/saturn/w2/final/` (full modules: required
views + `sheet_required.png`, film strip `film_sheet.png` 268-325 s, `before_after.png` = classic / mid / unlit skim /
film skim frame, left wave-1 right wave-2); iterations in `shots/saturn/w2/g*/ r*/ v*/`.

## Wave 1 (still valid, condensed)

- **Colour pipeline**: `satDisplay()` (rings-glsl.js) scales each layer's chroma around its Rec.709 luminance by
  `s(Y exposure) = clamp(1.085 * 2^(0.30 (log2(Y exp) + 2)), 0.5, 1.85)`, fitted through an exact JS replica of the
  post's AgX + look + grade, so the displayed hue equals the material's linear chroma (Cassini colour images are
  hue-preserving stretches). Luminance untouched. Applied to globe, rings, limb haze, E/G rings (not Titan/icy moons).
  Re-fit if the post's AgX changes.
- **Near plane**: ring meshes clip only at `uNear2` (a quarter of the distance to the drawn annuli) and write their
  true depth (`gl_FragDepth`, reversed-Z aware), so skims at 0.02 R are never clipped by main.js's sphere-based near.
- **Edge-on AA**: below a 0.9 px projected A-ring minor axis the sheet is tilted open in the vertex shader (`uTilt`)
  and the output scaled by true/drawn area (`uCover`): a continuous line at dist 25-150 instead of dashes.
- **E ring** is a 16-sample line-of-sight volume (Gaussian vertical profile widening outward, peak at Enceladus,
  per-sample planet shadow); the G ring a thin sheet; both exaggerated ~40-50x for the PIA08329 backlit look.
- **Lit-face photometry**: dense-layer correction (Salo & Karjalainen 2003: mu -> mix(mu, sqrt(mu mu0), 0.6 D)) and
  inter-particle multiple scattering growing with the slab's slant optical depth; mirrored in the CPU ringshine.
- **Ringshine on the globe** is physical (0.5-1 % of daylight) and lifted x3 (`nightLift`, x4.2 in eclipse) for display.
- **Eclipse assist** = 7 / max(1, shot.exposure): the film's +3.4 EV eclipse gets no extra gain.
- **Seasonal tint** follows the sub-solar latitude (B = -8 deg in 2026: blue-grey winter north, golden south).
- **Titan**: main haze cut off above ~320 km, detached blue layer at 500 km, north polar hood + 57 N collar.
- **Icy moons**: saturated power-law craters with per-crater freshness, zero-slope rims, terminator rim-lighting
  (h > delta^2/2); Herschel, Odysseus + Ithaca, Tirawa + rayed Inktomi, Dione/Rhea wisps, Enceladus tiger stripes.
  Wave 2: Enceladus' ridged plains are now long, parallel, slowly curving ridges (phase of a perturbed linear field)
  instead of the closed 'fingerprint' contours.

## What exists

**Rings — real data.** `assets/saturn/rings_tau.bin` (152 KB) is the Voyager 2 PPS δ Sco occultation profile
(PDS VG_2801, 1 km sampling, 66,000–142,000 km), so every ringlet, plateau, gap edge and density wave is where it
really is (C-ring plateaus, Maxwell/Colombo gaps, B-ring irregular structure, Huygens ringlet, Encke and Keeler gaps,
the Janus/Mimas waves in the A ring). Where the PPS saturates (B ring, τ ≳ 3) smooth Cassini-occultation floors are
applied (B2 1.9, B3 core 4.2, B4 2.2) modulated by the PPS fine structure, so the B ring is properly opaque to the
star field while the A ring, C ring and Cassini Division let stars through. At runtime (`saturn/rings-data.js`) it becomes:
- a 16384-texel hand-mipped HalfFloat texture of **averages of exp(−τ·m)** for m = 1, m0 (=1/μ0, the fixed solar
  incidence), 4 and 16 — so distant pixels get the true mean transmission of unresolved ringlets, and the planet's
  ring-shadow uses the exact filtered solar transmission. No moiré at any distance (footprint-driven LOD).
- a 1/2/4 km "fine" texture (texelFetch) for close range, plus sub-km procedural ringlets, periodic-in-azimuth
  streaks and canted 'straw' clumps (seamless integer lattice) that fade in only when resolved (~1.5 px/feature).
- particle albedo/colour/dust fraction by region (C ring and Cassini Division darker and greyer, B ring salmon and
  τ-correlated brightness, dusty Encke ringlets, D ring all dust).

**Ring photometry** (`saturn/rings.js`): classical many-particle-thick layer on both faces —
lit `ϖP/4·μ0/(μ+μ0)·(1−e^{−τ(1/μ+1/μ0)})`, unlit (diffuse transmission) `ϖP/4·μ0/(μ−μ0)·(e^{−τ/μ}−e^{−τ/μ0})`;
backscattering particle phase function + opposition surge, forward-scattering dust population (HG g≈0.78).
Gives the lit-face B ring bright, the unlit-face B ring black while C ring / Cassini Division / A ring glow
(the reversal), and dusty rings blazing when backlit. Also: analytic planet shadow with solar penumbra + atmospheric
softening/reddening, Saturnshine on both faces (load-time table over the visible lit globe, incl. the rings' own
shadow on it), A-ring self-gravity-wake azimuthal asymmetry, **B-ring spokes** (born radial at the
field's rotation, sheared by Keplerian motion; dark in backscatter, bright forward — appropriate right after the
2025 equinox), **eccentric F ring** (core + strands + envelope, precessing periapse, clumps), faint **G and E rings**
(E ring peaks at Enceladus' orbit; optical depths exaggerated ~50× so the backlit rings read like PIA08329).
Far and near halves of the ring are drawn in two passes around the limb-haze shell so the haze glow sits correctly in
front of / behind the rings.

**Globe** (`saturn/globe.js`): oblate (f = 0.098) spheroid, ray-intersected per pixel; planetographic band albedo
profile (cream EZ, golden-brown belts at +-18 deg, storm alley 35 S, GWS-remnant band 38 N, the 47 N ribbon wave) as a
hand-mipped strip with minimum-width edges, indexed by a nearly straight latitude; many fine zonal striations (second
strip) at the flow-following latitude; zonally stretched turbulence + eddies + filaments down to the pixel footprint
through one noise loop; sparse vortices that swirl the texture (not the bands); zonal-wind advection (Cassini wind
profile) driven by simDays; north-polar **hexagon** (smooth rounded jet band, laminar streaks, cap, eyed polar vortex
with four spiral arms) and the south polar vortex; seasonal tint (north = winter -> bluer/greyer, south more golden);
Minnaert limb darkening, reddened grazing light and twilight beyond the terminator; **ring shadows** (sun ray -> ring
plane -> exact filtered transmission, blurred by the solar disc), **moon shadows**, **ringshine** from a table
integrated at load over the real ring profile (lit and unlit face radiance, ring self-shadow by the planet, horizon).

**Limb haze** (`saturn/atmo.js`): two-component stratospheric haze integrated along each view ray near its tangent
point with analytic (log-space erfc/Chapman) view and sun columns and a per-sample planet-shadow test; footprint-
averaged so the sub-pixel ring is antialiased. Gives the thin bright ring around the night side when Saturn eclipses
the Sun, and a soft haze edge on the day-side limb.

**Eclipse exposure assist**: when Saturn hides the Sun (from the camera), all Saturn-system materials ramp up to 7×
(`body.eclipseExposureAssist`, smooth in how deep the Sun is behind the disc). Real backlit rings are ~1/10 the
brightness of the sunlit globe, so at exposure 1 the eclipse frame would be nearly black; this is what an
auto-exposing camera does. Set `bodies.saturn.eclipseExposureAssist = 1` if the director drives exposure itself.

**Moons** (`saturn/moons.js`): Mimas, Enceladus, Tethys, Dione, Rhea, Titan at real periods (BODIES) with J2000 mean
longitudes from JPL SSD Laplace-plane mean elements; synchronous rotation (sub-Saturn point lon 0, leading 90°W).
Icy moons: procedural crater fields with finite-difference normals, Lommel-Seeliger/Lambert mix + opposition surge,
eclipses by Saturn, Saturnshine; signature features — Mimas' Herschel (1.7°N 111.8°W, 139 km), Tethys' Odysseus and
Ithaca Chasma, Rhea's Tirawa and rayed Inktomi, Dione/Rhea dark trailing hemispheres with bright wisps, Enceladus
brilliant with smooth south and four tiger stripes. **Titan**: opaque core inside a 1050 km raymarched shell — main
photochemical haze (H = 62 km, blue-absorbing → orange), bluish detached layer at 480 km, N2 Rayleigh, approximate
multiple scattering, north polar hood; full forward-scattering ring when backlit.

## Best shot commands

```bash
node tools/shot.mjs --q "view=body&body=saturn&dist=5&phase=30&el=-20" --hud 0 --out shots/saturn/classic.png        # soft striated bands, translucent C ring
node tools/shot.mjs --q "view=body&body=saturn&dist=1.8&phase=25&el=-5&fov=40" --hud 0 --out shots/saturn/mid.png     # band edges soft + straight, eddies swirl only the texture
node tools/shot.mjs --q "view=body&body=saturn&dist=1.9&phase=50&el=26&fov=60&look=0,-8" --hud 0 --out shots/saturn/skim_unlit.png  # 0.05 R over the UNLIT face: Saturnshine floor
node tools/shot.mjs --q "view=body&body=saturn&dist=1.9&phase=50&el=23&fov=60&look=0,25" --hud 0 --out shots/saturn/skim_lit.png    # 0.05 R under the lit face, looking up: straw clumps at the top
node tools/shot.mjs --q "view=body&body=saturn&dist=7&phase=179&el=-3&fov=40" --hud 0 --out shots/saturn/eclipse.png
node tools/shot.mjs --q "view=body&body=saturn&dist=5&phase=30&el=42" --hud 0 --out shots/saturn/unlitface.png        # true unlit face: the reversal
node tools/shot.mjs --t 268:326:3 --hud 0 --sheet shots/saturn/film_sheet.png --cols 5                                 # the film's Saturn chapter (current cut)
```
Also: `dist=4&phase=120&el=-25` (planet shadow across the rings, Saturnshine near the planet on the far side),
`dist=2.2&phase=50&el=23.973&fov=60&look=0,12&roll=180` (0.02 R over the lit A ring), `dist=2.2&phase=50&el=25.026&fov=60&look=0,-12`
(0.02 R over the unlit face), `dist=12&phase=40&el=-10&fov=12&look=6,0` (telephoto: moire check),
`dist=3&phase=10&el=70&epoch=2017-05-24T12:00:00Z` (hexagon lit), `target=titan&dist=3&phase=160`,
`target=rhea&dist=1.6&phase=70&el=10&fov=45`, `target=enceladus&dist=2.5&phase=30&el=-60`, film `--t 280` (skim frame),
`--t 298` (eclipse). Add `only=saturn,post,sky` for fast isolated runs (also removes other pieces' belt dust).
The required 'ring skim' query `dist=1.9&phase=50&el=-1.2` is 0.82 R below the ring plane (el is ecliptic); use the
`el=23` / `el=26` versions above for real skims. Dev switches:
`satdbg=norings,nohaze,noglobe,nomoons,notitancore,headlight,norelief,ringdbg1,ringdbg2`.

## Geometry facts worth knowing (epoch 2026-11-02)

- Sub-solar latitude -8.16 deg (Sun 8.2 deg below the ring plane, south side). `el` in view=body is ecliptic; Saturn's
  pole is 28 deg from ecliptic north: `el=-20,phase=30` -> 38 deg below the ring plane (lit face); `el=20,phase=30` ->
  0.45 deg below (edge-on, lit face); `phase=179,el=-3` -> 9.4 deg above (unlit face, in Saturn's shadow);
  `phase=50`: `el=23` -> 0.05 R below, `el=26` -> 0.05 R above the plane at dist 1.9.
- The north polar hexagon (78 N) has the Sun at most ~4 deg up at local noon in Nov 2026; north of 81.8 N is polar
  night. The required hexagon view shows the twilit noon-side edge only; `epoch=2017-...` shows it fully.
- Planet shadow on the rings is ~7 R long (low Sun). The B ring shadows the globe's northern tropics (~2-12 N).
- The film's skim camera is ~0.16 R under the lit face over the B/A rings: radial footprint >= 10 km, so the straw
  octaves (<= 12 km) only show in the 0.02-0.05 R views; at the film's height the near field is the real 1 km radial
  structure (sharper now), the Saturnshine and the A-ring wake asymmetry.

## Performance

Runtime: all checked views at the 240 Hz vsync cap (4.17 ms whole frame, RTX 4090, 1600x900, shared GPU), including
the full-screen unlit skim (Saturnshine + straw) and the full-screen cloud deck at 0.25 R (`--perf 4`). The real
loops (uSatZero) did not cost runtime. CPU at load: ring textures + ringshine ~160 ms, Saturnshine table ~20 ms,
band + striation strips ~30 ms. Asset: 152 KB (unchanged).
Compile (first draw, D3D11/FXC, fresh profile, other agents loading the CPU): `tools/checks/shader_cost.mjs --q
"only=saturn,post"` = 702 / 704 ms (globe 325-330, icy moons 223-238 -- one program for all five, haze 76,
Titan shell 59-78); ring programs (not seen by that tool, compiled in the first frame) main 218, E ring 50, G 16.
Start of wave 2 the same tool gave 9194 ms (globe 3534, icy moons 5441).

## Known gaps

- Wave 3: no near-field sparkle / density-wave work (the film never gets within 5 km/px of the rings); the ring
  particle phase function is steeper than a Callisto-like power law at phase 60 (about -25 %), left alone because
  the classic low-phase view was tuned with it.

- The hexagon in its required 2026 view is still only a twilit edge (physics; see geometry). No forward-scattered
  twilight haze glow was added to make it visible.
- Close range (0.25 R): the relief bump is still screen-derivative based (2x2 quad faceting possible at grazing
  light); popcorn/convective relief was cut 65 % / 33 % but not replaced by central differences (compile budget).
- Straw/clumps only show below ~0.05 R altitude (they are 1-12 km structures); the film's 0.16 R skim sees radial
  structure only. No procedural density waves beyond those in the PPS data.
- Saturnshine where it is the only light is lifted x4.5 (display latitude, like the globe's ringshine x3); the far
  rings beside the planet are visibly brightened by (physical) Saturnshine at high phase.
- C ring / Cassini Division particle albedo is an *effective* albedo (0.58 / 0.66 in r), higher than the measured
  single-scattering albedo, to reach the lit-face I/F ratio C/B ~0.2 that the classical slab underestimates.
- Eclipse limb ring nearly uniform in the required view (geometry nearly symmetric); E ring seen from inside is a soft
  band (physical). Icy moons procedural (no mosaics), Enceladus' ridges subtle; Rhea crater density unchanged.
- E/G ring optical depths exaggerated ~50x for the backlit look (PIA08329).
- Other pieces: speckled dust 'lens' in eclipse frames = asteroid belt sparse ring; lens-flare ghosts on Titan = post.

## Requests to integrator

- **shader_cost.mjs does not count the Saturn ring programs** (~280 ms): the ring meshes have `frustumCulled = false`
  and compile in the boot frame, before the measured warm-up. Count them by cache-busting (unique define) or by
  measuring before the first render.
- **Critic / lead shot queries**: build skim cameras in the ring frame (poleQuaternion('saturn')); for body views use
  `phase=50&el=23` (lit face) / `el=26` (unlit face) at dist 1.9 for 0.05 R skims.
- **Director**: the unlit-face skim now has a real floor (Saturnshine); a skim over the UNLIT face at ~0.05 R looking
  toward the lit planet (rings dark brown and textured, the planet's ring-shadow bands above) is a strong new beat.
  `bodies.saturn.nightLift` (3) scales both the globe's night side and (x1.5) the rings' Saturnshine floor.
- **Post**: `satDisplay` (rings-glsl.js) is fitted to the current AgX; re-fit if the post's tone curve changes.
- Titan's haze renderOrder is 20 (nearer than Saturn) / 2; other transparent objects near Saturn should avoid 9-13, 2, 20.
- (Optional) main.js near plane: include `b.nearestDistance?.(camU)` (no longer blocking; the rings clip themselves).
