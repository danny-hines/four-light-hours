# Earth & Moon — piece notes

Owner files: `src/bodies/earth.js`, `src/bodies/earth/*`, `assets/earth/*`, `assets/moon/*` (Earth 2.18 MB incl. the new
`shelf.webp`, Moon 1.15 MB). Dev-only scripts live in `src/bodies/earth/dev/` (not bundled): `batch.mjs` (many views in
one browser), `gputime.mjs` (GPU timer query), `atmo-probe.mjs` (CPU port of the atmosphere march for colour tests),
`compile-time.mjs` (shader compile time), `simdays.mjs` (director's simDays over t). Round-1 originals: `dev/*.r1.bak`.

## Round 4 (film pass: "photographic" look, Earthrise)
Judged on the film's own frames (current cut: approach t~100-114, terminator 114-118, night 118-125, sunrise ~125.6,
Moon approach 130-138, Earthrise 138-152, pull-back 152-158). Before / after: `shots/earth/before_after_a.png`,
`before_after_b.png`; all final frames `shots/earth/final/film_t*.png`, contact sheet `shots/earth/film_sheet.png`;
baseline (HEAD) frames `shots/earth/base/`.
- **Photographic look (`uLook`, radiance pass composite; `earth.js`)**. The physically exact composite read steel-blue
  and milky after post's AgX: the Rayleigh path radiance over a black ocean is ~3x the water's own radiance
  (`earthDebug=1` vs `2`). On the sunlit disc only (weight `dayW` from the sun elevation at the ground point): 62 % of the
  path radiance is kept for near-vertical views (100 % at grazing views, so the limb rim, low-orbit horizons, twilight arc,
  night side and sunrise are untouched), a print-contrast curve about mid-grey (exponent 1.25: HDR cloud tops reach
  ~1.2-1.4 and bloom), saturation x1.25. Dev overrides `eclr= econ= esat=`. Disc stats at t=108 (sRGB, half-res):
  ocean p10 (29,75,125) -> (2,37,84) (Apollo 17: 6,32,70); luminance p5 68 -> 34 (ref 28); p99 221 -> 233 (ref 241).
- **Clouds at disc scale**: (a) the two-phase flow map crossfaded copies of the map up to ~170 km apart (a double
  exposure that melted the map's cyclone arms and cell fields into blobs twice per cycle): displacement x0.3
  (`FLOW_GAIN`, `eflow=`); (b) map -> reflectance is now `1 - exp(-3.6 m^1.8)` (the smoothstep threshold dropped the
  thin and mid-level cloud: half the planet's cover); (c) unsharp mask of the map (radius ~6 px / 6 texels, +55 %) so
  bands and cells stay distinct. Bright-cloud pixel fraction on the disc 0.12 -> 0.18 (Apollo frame incl. Antarctica 0.33).
- **Clouds at 1.5-3 R (t 114-118)**: self-shadow march pre-filtered and softened (bilinear 8-bit map texels cast hard
  dark specks into the decks at low sun); the octave-fade footprint counts the long axis of an oblique footprint more
  (0.4 -> 0.72 of it): the rows of dashes near the limb are gone.
- **Ocean**: clear-water reflectance bluer (0.0012, 0.0055, 0.036): royal-blue gyres instead of grey-navy.
- **City lights**: downtown "carpet" share 0.55 -> 0.3 and core gain 2.6 -> 2.0 (big conurbations were flat white
  patches; now point structure inside them), overall x1.2, plus a sodium-orange haze halo from two blurred mips of the
  Black Marble.
- **Moon, crater field (`moon-glsl.js`, rewritten profile)**:
  - the "pads" (flat discs with a hard outline, lighter or darker than their surroundings) were every crater's influence
    circle: the old smooth-min profile had non-zero height and slope at the cut-off, the fresh-albedo term was a uniform
    disc, and the rim shadow was clipped at the same circle. New profile `h = Hr E(x) - Dp B(x) + peak` is C1 at the
    cut-off (1.75 radii; radii 0.14-0.28 cell, level-0 cell 52 km): bowl `(1-x^2)^pw` (pw 1 fresh: walls steep to a
    sharp crest; pw 2 old: rounded dish), flat floors normalised to full depth, rim/ejecta flanks `x^2 | q^2` when fresh
    and smoothstep-shaped (rounded on both sides) when old, central peaks above ~16 km;
  - depth and rim sharpness now degrade separately (`deep`, `fresh`): most craters are shallow rimless dimples that
    only shade, a minority hold a shadow, a few per cent are crisp with a bright wall + ray-broken ejecta halo;
  - a mantled crater's shadow is smaller, not fainter (heights scale with the amplitude in the shadow test; the faded
    full-size shadow drew old craters as grey pucks);
  - shadow fill light 3.5 % + 6 % -> 0.7 % + 2.2 % and proportional to the sun elevation: shadows are black, as in every
    orbital photograph (at a grazing sun and high phase the lit ground itself is only ~1 %);
  - sub-LOLA ridged relief x2.3 (shading and geometry: hummocky highlands, attached shadows at a 10 deg sun, a more
    rugged horizon); sub-km albedo stipple replaced by 2-12 km maturity mottling.
- **Moon, disc**: albedo exponent 0.48 -> 0.62 (highlands ~0.23, maria ~0.09, rays ~0.3: the ray systems survive),
  near-neutral grey (r/g 1.07, b/g 0.90), phase decay exp(-0.34 a) (was 0.42: the approach crescent was charcoal).
- **Cost**: unchanged within noise. `node src/bodies/earth/dev/abperf.mjs 78,88,112,116,126,140,150 16` (new dev
  script: median frame ms at 3200x1800 so the GPU sets the frame time; shared GPU, run alternately on HEAD and on this
  code, two rounds each): t=112 52.4 / 51.2 vs HEAD 52.4 / 48.2; t=116 77.6 / 80.3 vs 85.1 / 71.8; t=126 37.3 / 55.1
  vs 56.2 / 49.1; t=140 71.1 / 100.6 vs 102.4 / 98.4; t=150 35.1 / 58.2 vs 59.9 / 59.5. No new loops, noise call sites
  or materials (two explicit-LOD texture taps in the cloud pass, one in the city pass, a few ALU ops elsewhere).
  **Not measured: FXC compile time** (this round was done on macOS / Metal; re-run `tools/checks/shader_cost.mjs
  --q "only=earth,post"` on Windows - the Moon's crater body gained two `pow` and two `sin`).

## Round 3 (critic round 2 fixes)
- **Clouds, close range (structural)**: Worley search is exact (full 3x3x3; the 2x2x2 search cut straight seams); the
  cellular octave is now a smooth Gaussian blob field over the same jittered points (random size/strength, 30 % empty
  cells; stats measured in `dev/blobstat2.mjs`) - 1-F1 had a crease on every cell border that thresholded into the
  "dried-mud" crack net. Closed-cell walls soft, wide and widened by the footprint. Map-lookup domain warp cut ~3x
  (<= 0.15 of each warp wavelength: no marbled swirls). Fine octaves (< 3 km) enter the coverage threshold at reduced
  weight, are edge-localised (Schneider erosion: amplified near the coarse edge, damped deep inside / far outside) and
  otherwise modulate optical thickness, so 50-70 % texels are cloud bodies with tufted edges instead of lace. Octaves
  resolve from 3.3 px (were 1.9 px: a 1-px net). Dense decks keep a thin-cloud floor in their gaps (mean-preserving).
  Cloud footprint uses the geometric mean of the pixel axes (oblique views were blurred into streaks).
- **Cloud volume**: cloud-top height field (dome rising from the soft edge, 2.4-7 km by regime, gentle interior
  turrets) -> normals (faded in only where cloud bodies are > ~6 px), soft cosine for unresolved relief (tops stay lit
  past the flat terminator), sun transmittance at each top's own height (+ dome height), skylight only from the sky
  above the top. Shadows on the ground use the same field/threshold (wider footprint) and are clamped to 1.6x the local
  mean layer reflectance (no orphan shadows).
- **Land relief (root cause of "crumpled foil")**: x5 map exaggeration fades to x1.3 below a ~2 km footprint;
  procedural terrain now has true slopes by class (mountains ridged ~0.2 rms, hills 0.035, ergs wind-aligned dune ridges
  0.05, chain rule through the stretch); the hard `smoothstep(muSl)` self-shadow is replaced by wrapped lighting gated by
  the sphere terminator; skylight on tilted facets ~ (1 + n.up)/2. Sub-texel UV jitter (<= 0.35 texel) continues coasts
  and field edges below the Blue Marble resolution.
- **Aerial perspective / limb**: the boundary-layer aerosol was laboratory-clean (AOD 0.005) -> AOD ~0.05 (beta_s
  36e-6/m, SSA 0.9), so LEO horizons get a white-blue haze band and a washed-out surface toward the horizon. The whole
  atmosphere is vertically exaggerated x1.35 (heights x S, coefficients / S: every vertical column unchanged, limb 1.35x
  thicker). All constants come from one place (`ATMO` in `atmo-lut.js`; the GLSL `#define`s are generated from it).
- **Sunrise**: stratospheric aerosol scatters with its own g = 0.92 lobe (`phaseStrat`) -> a bright golden aureole that
  narrows along the limb around the rising Sun. Best at `el=74.5` (Sun 0.5 deg above the limb, flattened, orange).
- **Airglow**: three Abel-integrated layers - OI 557.7 green 97 km (sigma 6 km), Na orange 89 km, faint broad OI 630
  red 210 km (proxy sphere raised to Rp + 290 km) - with low-frequency gravity-wave banding; 2.2x brighter.
- **Ocean**: resolved wave normals only at ~270 m wavelengths below ~50 km altitude (the 9.5 km "swell" gave hammered
  metal); everything else is Cox-Munk slope variance in the GGX lobe; calm slicks are 2-octave filaments (the 4-octave
  version sprinkled dashes over the glint).
- **City lights**: per-texel core contrast (cores ~5x suburbs), ~35 % white LED varying regionally, the brightest cores
  roll to yellow-white.
- **Snow**: canopy-dependent albedo (0.85 open ground, ~0.2 under boreal forest, from Blue Marble greenness) and a
  climatology-feathered snow line.
- **Moon**: albedo x1.4 (highlands ~0.22) and the real reddish-grey soil colour (render: full-Moon highlands sRGB r/g
  1.07, b/g 0.88; ref 1.06 / 0.90); terrain shadows march the C2 B-spline height within 40 km (bilinear 8-bit texels
  made stair-stepped, streaky shadow edges) with a soft penumbra widened by the footprint; soft local terminator on the
  summed normal (no black/lit speckle at low sun); regolith bumps weaker and 4x weaker at low sun; crater relief
  amplitude -15..-30 %; fresh bright craters ~3x rarer; 3.5 % terrain bounce light in shadows; earthshine gain
  2500 -> 150 (it lifted the sunlit ground's shadows; lunar night is now honestly dark). exposureEV hint 1.3 -> 0.8.
- Cost: low-orbit full screen 5.4 ms vs 4.8 ms for the round-2 code measured back to back (GPU shared with other
  agents; round 2's 1.2 ms was on an idle GPU) - about +12 %.

## Round 2 (critic round 1 fixes)
- **Cloud advection (structural)**: replaced the per-latitude longitude offset (which sheared the map into comet tails)
  with a bounded long-term drift `0.5 tanh(d/0.5)` days of wind + a **two-phase flow map** (P = 0.4 day, triangle
  crossfade, each phase re-seeds its procedural detail at weight 0; map blended before the coverage threshold, noise
  blended variance-preserving). Smooth wind profile (no equatorial kink). Days 0..3 and film t=112-156 show no streaks.
  `earth/clouds-glsl.js`, uniforms `uFlow/uSeedA/uSeedB` set in `earth.js:cloudFlow()`.
- **Cloud structure**: Schneider-style coverage threshold evaluated statistically: R = A * logistic((n_res - t(c)) /
  s_unres), t from the map coverage, unresolved-octave variance as the edge width (analytic AA) => equals the map mean
  when unresolved, crisp solid decks with eroded edges when resolved (no leopard perforation, no blur at low orbit).
  Regimes: Worley cumulus clusters, closed/open stratocumulus cells over subtropical oceans, wind-stretched storm tracks.
  Cloud tops lit at their own height (1.5 km low cloud .. 8 km convective) => reddening/fade order at sunset; two-lobe
  HG single-scatter term (g 0.82 / -0.25) for bright high-phase clouds.
- **Mauve atmosphere (root cause)**: the ozone coefficients were monochromatic at 680/550/440 nm, which put the whole
  Chappuis band (peak 602 nm) into green; long grazing paths depleted G vs R and B => lilac haze. Now sRGB-channel-
  integrated (2.4, 1.70, 0.17)e-6/m. Verified with `dev/atmo-probe.mjs`: zenith (sun 30) B>G>R, grazing toward-sun haze
  R/G 0.96 B/G 1.19, horizon twilight warm. Also: **sky irradiance was multiplied by PI** (it is an irradiance, not a
  radiance) => skylight 3.14x too strong, grey/blue terminators and washed shadows. Fixed.
- **Ocean**: computed water-leaving reflectance (navy gyres, greener productive/high-latitude water, turquoise only on
  shelves < ~50 m from `shelf.webp`), no Blue Marble bathymetry ridges; diffuse terms x (1-F) at low sun; GGX glint
  with Cox-Munk roughness, calm slicks, resolved swell normals + LEAN-style variance for the unresolved part.
- **Coast / lake halos**: relief taps that land on water (height 0) now take the centre height (no cliffs at shores).
- **City lights**: `earth/citylights-glsl.js` — hashed 3-level point-light cascade (towns / districts+roads / lamps),
  lognormal brightness, sodium vs LED per lamp, Gaussians widened by the pixel-footprint covariance in the tangent
  plane (anisotropic, analytically AA, no moire), mean = Black Marble radiance at every distance.
- **Moon**: albedo remapped to true normal albedo (maria ~0.07-0.09, highlands ~0.16; ratio ~2.2 instead of ~5);
  craters full-jittered, elliptical, mostly degraded; ridged sub-LOLA relief (14 km .. 1 km) in shading AND geometry
  (mesh-spacing faded, rounded crests) so the horizon silhouette is rugged; footprint clamped against fwidth spikes at
  ridge silhouettes. Earthshine gain 2500 with its own softer phase law (never the sun's masks). `exposureEV: 1.3` hint
  on the moon def for the director.
- **Airglow**: thin green line floating over a dark band (steeper falloff below its tangent height), brighter.
- **Performance**: all heavy loops use a uniform bound (`uLoopMax` = 64) — constant-bound loops were unrolled per call
  site by the D3D compiler (radiance shader compile 8 s -> 37 s; now 7 s). Worley over 2x2x2 cells. GPU time (timer
  query, 1600x900, body only): low-orbit glint 1.2 ms, dist 1.8 disc 1.2 ms (round 1: 3.5 / 3.3 ms).

## What exists

### Earth (`earth.js`, `earth/earth-glsl.js`, `earth/earth-radiance.js`, `earth/atmo-lut.js`, `earth/noise-d.js`)
- **Analytic, ray-traced globe** inside an atmosphere proxy sphere (Rp + 115 km). Exact, analytically anti-aliased
  limb at any distance (coverage from the ray's closest approach), no tessellation facets at the horizon.
- **Two passes** on the same proxy: `transmit` (multiply blend: `dst *= T`, chromatic) then `radiance` (additive).
  So the Sun / Moon / stars behind the limb are reddened and dimmed by the real chromatic transmittance — the Sun
  rising through the limb turns orange-red and flattens into the dense layers.
- **Atmosphere**: Rayleigh + Mie (g 0.8) + ozone (Chappuis band → blue twilight zenith) + a thin stratospheric
  (Junge, ~20 km, τ≈0.005) aerosol layer that gives the orange band hugging the limb at an orbital sunrise;
  Bruneton/Hillaire coefficients, true 60 km top, true scale heights, MS ground albedo 0.07 (ocean-dominated). LUTs built on the CPU at startup (~0.2 s, deterministic):
  transmittance (Bruneton horizon-preserving parametrisation), Hillaire multiple-scattering Ψms, sky irradiance.
  Per-pixel 24–28-step march with sample spacing concentrated toward the densest air; split at the cloud layer so
  aerial perspective above and below the clouds is correct. Contract units (radiance × π).
- **Surface**: Blue Marble NG (July) albedo; relief normals from the height map (×5, three tangent taps, valid at the
  poles); close-range procedural micro-relief (roughness from elevation) and albedo detail, footprint-faded.
  Water = Natural Earth mask sharpened by the Blue Marble pixel colour.
- **Ocean**: Fresnel water body + GGX/Smith sun glint (F0 0.02) with wind-roughness field (α 0.025–0.21, Cox–Munk
  range) and slick patches, reflected sky with brighter horizon, cloud shadows in the glint.
- **Seasonal truth**: the Blue Marble is a July map; sea-ice edges (Arctic 67–78°N, Antarctic 61–71°S) and the
  Northern-Hemisphere snow line (41–75°N, forest canopy masking) follow the film's actual date.
- **Clouds**: elevated layer at 6.5 km with parallax; NASA cloud map + statistical coverage-threshold sub-texel
  structure, two-phase flow-map advection (see Round 2); thermal-IR "cloud" over the ice sheets damped; soft cloud
  shadows on the ground (sampled where the sun ray crosses the layer); low-sun self-shadow march; tops lit at their own
  height (redden / fade in order at sunset); HG forward-scatter lobe; silver lining.
- **City lights**: Black Marble, night side only (fade between sun elevation -1 and -6 deg), point-light cascade below
  the texel scale (see Round 2), sodium / LED per lamp, dimmed + diffused under clouds.
- **Airglow**: OI 557.7 nm green layer at 95 km (σ 4.5 km), integrated analytically (Abel transform of a Gaussian
  shell) so the line is crisp at any distance; night limb only.
- **Eclipses**: the Moon's penumbral/umbral shadow on the ground and clouds (disc-overlap).
- Rotation from `bodyQuaternion('earth', d)` (real sunlit hemisphere for the date).

### Moon (`earth/moon.js`, `earth/moon-glsl.js`)
- `positionAt(d)` = `moonGeocentric(d)`; orientation `bodyQuaternion('moon', d)`; `moons[0].id === 'moon'`.
- **Geometry**: view-dependent polar grid centred on the sub-camera point (rings uniform in nadir angle, then in
  central angle out to 6.7° past the horizon), displaced by **C2 B-spline LOLA heights** in the vertex shader → a
  real rugged horizon from 10–50 km up and a perfectly tessellated limb for the disc; low-res grid when < 90 px.
- **Shading**: LRO WAC colour contrast-corrected to the true maria/highland ratio (~2.5), lunar albedo; LOLA
  normals from a 16-tap B-spline (smooth, no 8-bit terraces); analytic multi-scale **crater field** (8 levels, 18 km
  → 140 m cells, equal-angle cube faces, seam-exact neighbour-face evaluation, fewer craters on maria, degradation
  states, irregular rims, smooth-min rim profile, bright fresh craters) with **analytic crater shadows** (sunward
  rim inside the bowl, near rim outside) — analytic AA on shadow edges; **LOLA horizon-march terrain shadows**;
  regolith micro-relief; all footprint-faded (no shimmer).
- **Photometry**: lunar-Lambert (McEwen) with a Hapke-style shadow-hiding opposition surge — flat full Moon, no limb
  darkening at full phase, steep phase decay.
- **Earthshine** (Earth phase from the date, Lambert-sphere phase law, blue tint) with an artistic gain of 150
  (physically ~1e-4 of sunlight) so the night side shows a faint ashen glow; Earth's umbra/penumbra with a
  copper-red refracted umbra (lunar eclipse).

## How to see it (best shots)

```bash
node tools/shot.mjs --hud 0 --t 102,108,112,114,116,118,120,124,126,130,134,136,138,142,146,150,156 --out shots/earth/final/film.png   # the film's Earth + Moon beats
node tools/shot.mjs --hud 0 --q "view=body&body=earth&dist=3.2&phase=25&el=10&only=earth,sky,post" --out shots/earth/disc.png
node src/bodies/earth/dev/batch.mjs shots/earth/r3/final.txt     # all critic views + extras + film frames (one browser)
node tools/shot.mjs --hud 0 --q "view=body&body=earth&dist=4&phase=25&el=15" --out shots/earth/approach.png
node tools/shot.mjs --hud 0 --q "view=body&body=earth&dist=1.04&phase=180&el=74.5&fov=50&aim=sun" --out shots/earth/sunrise.png
node tools/shot.mjs --hud 0 --q "view=body&body=earth&dist=1.06&phase=60&el=5&fov=60&look=0,62" --out shots/earth/leo_horizon.png
node tools/shot.mjs --hud 0 --q "view=body&body=earth&dist=1.06&phase=40&el=-30&fov=60&look=-38,0" --out shots/earth/glint.png
node tools/shot.mjs --hud 0 --q "view=body&body=earth&dist=1.06&phase=165&el=5&fov=60&look=0,62&exposure=6" --out shots/earth/airglow.png
node tools/shot.mjs --hud 0 --t 128,132,152 --out shots/earth/film.png          # night pass, terminator sunrise, Earthrise
node tools/shot.mjs --hud 0 --q "view=body&body=earth&target=moon&dist=3&phase=4&el=3" --out shots/earth/moon_full.png
```
Reference renders of round 3: `shots/earth/r3/f_*.png`, contact sheet `shots/earth/r3/full_sheet.png`.
Isolated (only=earth) close-ups: `shots/earth/r3/c_leo.png`, `c_mid.png`, `p_lowsun.png`, `h_leo.png`, `w_sr745.png`
(only=earth,sun,post), `mf_low.png`, `m_t152.png`.
The required glint view `dist=1.06&phase=40&el=0&look=0,-20` does not contain the specular point (it lies ~40 deg
left/below); `el=-30&look=-38,0` puts it in frame.

### Notes on three of the critic's views (geometry, not shading)
- `dist=1.04&phase=176&el=0&fov=50` looks straight down at the night side (the limb is 74 deg off-axis, outside a 50 deg
  frame). The sunrise over the limb is `dist=1.04&phase=180&el=74.5&fov=50&aim=sun` (el 73.8 = pre-dawn glow).
- `target=moon&rel=earth&phase=88&dist=1.012&el=0&aim=earth&fov=40` is at **lunar midnight** with Earth ~11 deg up:
  earthshine at grazing incidence is tiny on the ground (gain now 150) — black after the tonemapper, as in reality. The
  film's Earthrise (t=152) is sunlit. Use the film shot or `earthrise_lit` for judging.
- Crescent at `dist=3&phase=150`: from 3 radii only 70.5 deg of central angle is visible and the terminator is 60 deg
  from the sub-camera point, so the lit crescent is genuinely ~10-15 px wide (the "67 px" estimate is orthographic).
  Use `dist=10&phase=150&fov=15` for a fuller crescent.

## Performance / budget
- Full-screen Earth (dist 1.8, low-orbit glint) and the 12 km Earthrise: p95 4.3 ms per whole frame at 1600×900
  (the shot tool's rAF cap) on the RTX 4090. `q=low` drops procedural detail and uses a 160×512 Moon grid.
- LUT build ~0.2 s at startup (main thread, during loading). Assets unchanged (Earth 2.0 MB, Moon 1.15 MB).
- Reference renders: `shots/earth/r3/f_*.png` (all real modules), `shots/earth/r3/full_sheet.png`.
- Round 3 GPU (timer query, 1600x900, body only, shared GPU): low-orbit full screen 5.4 ms (round-2 code at the same
  time 4.8 ms), dist 1.8 disc 1.8 ms.

## Known gaps
- The photographic look is a look: the sunlit disc is no longer radiometrically exact (path radiance x0.62 at nadir,
  contrast 1.25). Set `eclr=1&econ=1&esat=1` for the physical composite.
- No ocean glint on the hero disc: with the film's approach direction the specular point falls on East Africa (see
  requests). The glint is in frame only at t~115-118.
- Clouds at 1.5-3 R are believable but soft (one 20 km map + two resolved procedural octaves at 3 km / px); faint
  ripples remain in cloud-top shading near the terminator at oblique views (the 4-texel-per-cell baked noise is only
  C0 in its gradient); no true volumetric towers; cirrus is not separate.
- Moon at a HIGH sun from 400-1000 km (not in the film; `shots/earth/moon_mid.png`): the crater field still reads as
  scattered round bowls - craters have no overlap ordering (a young crater does not erase the old rim under it) and
  no wall terraces / slumps; at a low sun (every film frame) it reads as orbital photography.
- Crater shadows are analytic per crater; the x2.3 ridged relief has attached shadows only (no cast shadows).
- The far side (all the film shows of the disc) has few maria: the pull-back disc at t=156 is truthfully bland.
- At 1-2 km per pixel over land the Blue Marble (~10 km texels) is still soft inside large uniform regions.
- No highway filaments between cities.

## Requests to integrator / director
- **Director, Earth approach (round 4)**: rotate the approach azimuth (`E_APP.az`) ~25-35 deg toward the Sun side or
  pick the Atlantic / Indian-Ocean face so the specular point lies on open ocean: the hero disc then gets its sun-glint
  (the BRDF is there: `earthDebug=5`).
- **Director, Earthrise (round 4)**: the star field is far too bright for a frame exposed for sunlit regolith and a
  sunlit Earth (`sky` 0.55 at t0+5..tRise1): Apollo frames show a black sky. Suggest sky <= 0.12 from the descent to the
  end of the hold. The surface now has black shadows, so +0.2..0.3 EV on the hold (EV.moon 0.35) would also sit well.
- **Director, sunrise**: still as below - the Sun clears the limb in ~0.5 s (t 125.3 -> 125.8) and is white by 126;
  a slower crossing with the Sun 0-1 deg up would show the reddened, flattened disc the transmittance pass produces.
- **Post**: lunar and Earth highlights now exceed 1 (cloud tops ~1.3); nothing needed, but a slightly lower bloom
  threshold on the Earth disc would give the clouds a photographic halation.
- **Sky (zodiacal light)**: the zodiacal band is far too bright - a grey fog in every Earth/Moon frame, and a huge white
  glare band above the limb in the sunrise view with aim=sun (`shots/earth/r3/f_sunrise.png`, all modules, vs
  `w_sr745.png`, only=earth,sun,post). Real zodiacal light is fainter than the airglow and invisible next to a sunlit limb.
- **main.js view=body**: (a) honour `moons[].exposureEV` (Moon 0.8 EV) for target=moon views; (b) add `up=radial` (the
  target's local vertical as the lookAt up vector for rel/aim views) so Earthrise horizons are level - with
  ecliptic-north up, the required Earthrise views (phase 85-92, el -2..2) put the horizon vertical at the frame edge.
  Those geometries are also lunar night (Earth ~11 deg up, Sun below the horizon): judge Earthrise from the film's t=152.
- **Required sunrise view** `dist=1.04&phase=176&el=0&fov=50` looks straight down at the night side (the limb is 74 deg
  off-axis). The sunrise over the limb is `dist=1.04&phase=180&el=74.5&fov=50&aim=sun` (el 73.8 = pre-dawn glow).
- **Director**: time the orbital-sunrise beat with the Sun 0-1 deg above the limb (at t=124 it is white and high).
- **Post**: the hexagonal arc near the crescent Earth in the critic's `c09_arc.png` is a lens-flare aperture ghost, not
  the Moon (a 24 px Moon renders round: `shots/earth/r3/ms_cmp.png`).
- Moon close-ups: keep `mesh.frustumCulled = false` behaviour in mind - three's frustum test with the reversed-depth
  projection culled the camera-centred Moon grid when the camera was inside its bounding sphere (worked around here).
