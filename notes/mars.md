# Mars, Phobos, Deimos — notes

Owner files: `src/bodies/mars.js`, `src/bodies/mars/{glsl,relief,bake,noise3d,surface,atmosphere,moons}.js`,
`assets/mars/*` (`color.webp` 4096x2048 Viking colour mosaic + `height.webp` 2048x1024 MOLA, 1.02 MB; no new
assets, everything else is procedural or baked on the GPU / CPU at load).

## Wave 2 — what changed

### 1. Shader compile budget (hard requirement) — met
`node tools/checks/shader_cost.mjs --q "only=mars,post" --top 25` (fresh profile; lowest of several runs, the CPU
is shared and numbers swing +-25%):

| program | wave 1 | now |
| --- | --- | --- |
| mars-surface-lod0 | 7325 ms | **256-268 ms** |
| phobos-lod0 (Deimos shares it) | 4101 ms | **236-242 ms** |
| mars-atmosphere | 336 ms | **95-100 ms** |
| **piece total** | 11 763 ms | **588-611 ms** (budget 800, each <= 350) |

GPU frame time unchanged (~4.2 ms whole frame at dist 1.25-1.6, 1600x900, RTX 4090).

How (root causes, measured with an isolated compile harness on the dumped GLSL; FXC cost grows ~n^1.4 with code
size, one inlined analytic noise ~25 ms alone and ~100 ms inside a big shader):
- every loop bound is an int uniform (FXC no longer unrolls); octave x cell loops collapsed into one loop
  (`marsCraterCell` / `craterCell` evaluate one cell per iteration);
- analytic noise call sites 22 -> 0 (surface), 12 -> 0 (moons), 5 -> 1 (haze): `gnoised` is now a 4-corner simplex
  noise calibrated to the old noise's value / gradient RMS (glsl.js), and the surface detail layers and the moons'
  albedo noise read a **baked periodic 3D noise texture** (`noise3d.js`: 64^3 half-float, value + analytic
  gradient, 2 MB, built once on the CPU), with a per-band rotated lattice so octaves never line up;
- **load-time GPU bakes** (`bake.js`): the geologic-age map (equirect 1024x512) and two **polar-stereographic frost
  maps** (1024^2 half-float, lat 44-90) replace ~30 per-pixel noise / cap evaluations;
- all close-range terrain layers (undulation, highland ridges, roughness, sub-texel albedo, LIC spurs/gullies, LIC
  lava flows) are rows of one table-driven loop with a branch-free profile;
- cut for the budget (all close-range only, none visible in the film): analytic caldera high-pass (MOLA still holds
  the calderas, softened), wrinkle ridges, dunes, giant polygons, Olympus aureole ridges (they were the moire source
  in gap 4), crater rays / rampart aprons / wind streaks; Phobos' 3D pit-grid search replaced by a 2-pit bead chain
  along each groove; Stickney streak noise -> azimuthal sines;
- the haze shell used to flip `material.side` when the camera entered it, which compiles a second program mid-film:
  now one DoubleSide + `forceSinglePass` program choosing faces in the shader (`uInside`).
- Every material exists by the end of `create()`; no defines change at runtime.

### 2. Albedo grade — dark markings slate grey-brown, Valles Marineris floor dark (triage 1)
`trueColour()` in surface.js: contrast pivot about the median red albedo (0.26), gamma 2.4 below / 1.35 above
(`uGrade`), dark-region hue 1 : 0.84 : 0.80 (`uBasalt`) over a wide albedo ramp (no hard dust/basalt switch),
cleaner butterscotch dust 1 : 0.345 : 0.066; dust tau 0.15 -> 0.12 (clear northern spring) so the orange veil does
not lift the dark regions. Valles Marineris floors: MOLA-depth mask (floor > ~1.5 km below the 160-km-smoothed
surroundings, Noctis to Eos) darkened and greyed.
Histogram check (inner 75% of the disc, frost excluded; `view=body&body=mars&dist=4&phase=15&el=12&days=0.36` is
the reference's geometry, sub-camera 22.6 N 58 W):

| | mean RGB | darkest 12% | brightest 30% | luminance p5/p25/p50/p75/p95 |
| --- | --- | --- | --- | --- |
| Viking reference | 150 / 96 / 53 | 79 / 59 / 47 | 197 / 121 / 56 | 63 / 86 / 108 / 125 / 138 |
| wave 1 | 154 / 95 / 47 | 102 / 57 / 24 | 183 / 119 / 65 | 65 / 86 / 109 / 123 / 135 |
| now | 149 / 94 / 49 | 74 / 53 / 39 | 190 / 120 / 57 | 58 / 84 / 107 / 123 / 137 |

(The post grade warms and saturates dark tones; the albedo hue compensates for it.)

### 3. Polar cap (triage 2)
- Frost albedo 0.68 with a warm dust-pink tint (1 : 0.92 : 0.89) and a gentler photometric law for ice (Lunar-Lambert
  weighted to Lommel-Seeliger 0.64 + opposition surge + mild forward lobe): the cap stays bright at 60-80 deg
  incidence and reads pinkish-white, not grey plaster (HDR on the cap ~0.24 / 0.21 / 0.18 at the film's half phase).
- Edge = baked margin (deg) from the season's edge latitude + pole-facing MOLA slopes + topographic hollows + only
  large-scale (>500 km) wander, mip-filtered, feathered over ~1.5 px (`rw`): crisp, topography-controlled, no
  thresholded-noise stipple; thin-frost veil narrowed to ~2 deg.
- Frost blankets the relief: disc-scale exaggeration x0.55 and procedural slopes x0.7 under thick frost, bowl shadows
  shortened, procedural crater albedo applied after the frost and mostly hidden.
- Near-pole dark dashes / star spot: root cause = the MOLA terrain-shadow march on the degenerate equirect rows;
  cast shadows now fade out at 81-85 deg (normals still shade the troughs). Polar albedo comes from the
  polar-stereographic bake (mosaic luminance filtered in 3D), so no radial streaks.

### 4. Phobos / Deimos in the film (triage 3)
- Low-phase albedo structure: 100-km mottling +-20% (Deimos +-9%), the brighter bluer "blue unit" around Stickney
  and the redder "red unit" on the trailing side, brighter fresh crater walls / rims; groove troughs keep a faint
  footprint-averaged lineation at a few hundred m/px (visible at film size).
- 15% Lambert share (stand-in for Hapke macroscopic roughness) -> slight limb darkening, reads as a lump, not an egg.
- Mars-shine now physical: Mars' disc-averaged I/F (0.25, 0.11, 0.05) x sin^2(21 deg) x lit fraction, same regolith
  law (night side visible at exposure ~4).
- Crescent tick aliasing: root cause = per-cell hashed start jitter in the self-shadow march; now a smooth
  deterministic march (64 steps, footprint-widened penumbra) + bump normals partly blended to the mesh normal at
  grazing sun.
- Silhouettes: Deimos' spall facets softened (cutSoft 0.55 -> 1.1, depth 0.17 -> 0.13); mesh LOD switches pushed
  3x further out (>= 2 px per silhouette edge at every switch).

### 5. Twilight (wave-1 gap 5)
Surface twilight is now exponential in the solar depression (e-fold 4.5 deg, to ~20 deg, scaled by tau). It is in
the HDR (0.026 at the terminator edge -> 0.0025 ten degrees past it) but sits in the post tonemapper's toe at the
film's daylight exposure, so the required `dist=1.12&phase=95` view (which does not contain the limb) still looks
nearly black. Judge the limb at `22_limb95` below.

## Shots (wave 2: `shots/mars/w2/`)
`fin/*.png` = final, all modules; `base/*.png` = start of wave 2; `before_after.png`; `film/*.png` = film frames.
```
node tools/shot.mjs --q "view=body&body=mars&dist=3.2&phase=30&el=10" --hud 0 --out shots/mars/w2/fin/01_disc.png
node tools/shot.mjs --q "view=body&body=mars&dist=1.6&phase=85&el=15" --hud 0 --out shots/mars/w2/fin/02_term.png
node tools/shot.mjs --q "view=body&body=mars&dist=1.12&phase=95&el=0&fov=50" --hud 0 --out shots/mars/w2/fin/03_limb.png
node tools/shot.mjs --q "view=body&body=mars&target=phobos&dist=3&phase=50" --hud 0 --out shots/mars/w2/fin/04_phobos.png
node tools/shot.mjs --q "view=body&body=mars&target=phobos&rel=mars&phase=172&dist=6&aim=mars&fov=50" --hud 0 --out shots/mars/w2/fin/05_phfront.png
node tools/shot.mjs --q "view=body&body=mars&target=deimos&dist=3&phase=40" --hud 0 --out shots/mars/w2/fin/06_deimos.png
```
Best showcase:
```
# the Viking reference geometry (histogram check): dark markings, butterscotch dust, cap
node tools/shot.mjs --q "view=body&body=mars&dist=4.0&phase=15&el=12&days=0.36" --hud 0 --out shots/mars/w2/fin/11_vmref.png
# Valles Marineris disc
node tools/shot.mjs --q "view=body&body=mars&dist=3.2&phase=30&el=10&days=0.44" --hud 0 --out shots/mars/w2/fin/10_vmdisc.png
# the film's half-phase cap view; and the cap edge close
node tools/shot.mjs --q "view=body&body=mars&dist=2.6&phase=85&el=40" --hud 0 --out shots/mars/w2/fin/17_capfilm.png
node tools/shot.mjs --q "view=body&body=mars&dist=1.8&phase=20&el=62" --hud 0 --out shots/mars/w2/fin/16_npole.png
# limb haze layers + Tharsis Montes shadows at the evening terminator
node tools/shot.mjs --q "view=body&body=mars&dist=1.25&phase=95&el=0&fov=50&look=0,22" --hud 0 --out shots/mars/w2/fin/22_limb95.png
# Phobos crescent with Mars-shine (exposure 4) / Phobos at ~200 px, low phase
node tools/shot.mjs --q "view=body&body=mars&target=phobos&dist=2.2&phase=140&el=10&exposure=4" --hud 0 --out shots/mars/w2/fin/30_phcres.png
node tools/shot.mjs --q "view=body&body=mars&target=phobos&dist=14&phase=20" --hud 0 --out shots/mars/w2/fin/31_phmid.png
# the film (current cut: Mars chapter ~162-190 s; disc 168-180, Phobos crossing 174-178, cap 182-186)
node tools/shot.mjs --t 160:194:2 --hud 0 --sheet shots/mars/w2/film/sheet.png --cols 6 --w 800 --h 450
node tools/shot.mjs --t 172,176,178,182,184 --hud 0 --out "shots/mars/w2/film/j_{t}.png"
```
Dev-only URL overrides: `mars_grade=lo,hi`, `mars_basalt=r,g,b`, `mars_tau`, `mars_exag`, `mars_frost` (cap edge
lat), `mars_haze` (haze gain, 0 = off), `mars_atm=0` (no shell), `mars_ms`, `mars_detail=0`, `mars_dbg=1` (albedo) /
`2` (lighting), `mars_timing=1`, `mars_probe=1` (sub-camera / sub-solar / view-centre lat-lon), `mars_mdbg` (moon
detail bits: 1 no grooves, 2 no boulders, 4 no per-pixel craters).

## What exists (summary)
**Surface** (`surface.js`): Viking colour -> graded true colour (two-band luminance unsharp, VM floor mask), MOLA
relief de-terraced on the GPU (`relief.js`) -> displacement, normals (x2.2, x3.4 at disc scale), unsharp-masked
slopes, terrain cast shadows; baked geologic-age map drives a 10-octave D^-2 crater field (fresh / degraded,
central peaks / pits, ejecta albedo, dark floor dunes); table-driven close-range layers (see above); seasonal caps
from the real Ls via the polar bakes, frost photometry; Lunar-Lambert; delta-scaled dust extinction; aureole +
broad-lobe sky + exponential twilight; antumbral shadows of Phobos and Deimos.

**Atmosphere** (`atmosphere.js`): dust (H 9.5 km, tau 0.12, stops at the terrain, thinner at high latitude) with the
physically split 3-lobe optics, energy-consistent single scattering + capped higher orders + ground-lit term;
detached dust layer ~24 km, ice lines ~46 / 61 km, north polar hood, trace CO2 Rayleigh; shell to 95 km.

**Moons** (`moons.js`): IAU orbits via circularOrbitOffset in Mars' equatorial plane; positionAt(d) is exactly what
update() draws; tidally locked. Baked shape (icosphere + triaxial + soft facets + named craters + power-law
population), self-shadow march on a baked radius map, per-pixel craters, bead-chain grooves, boulders, Stickney wall
streaks, Mars' shadow, Mars-shine; Lommel-Seeliger (+15% Lambert) x Hapke-style phase function.

## Facts for the director / HUD
- Epoch geometry (2026-11-02T12:00Z): subsolar point 5.6 N 59 E; Ls ~13 (early northern spring), north seasonal cap
  to ~59 N.
- Phobos orbits in 7 h 39 min (laps Mars every ~23 s of film); Deimos 30.3 h. Both are very dark: I/F ~0.024 (V) at
  55 deg phase vs ~0.12 for Mars.

## Known gaps
- Close range (0.04-0.6 R altitude) is still the weakest regime (wave-1 gap 1, deferred): the budget cut the
  calderas, wrinkle ridges, dunes and polygons; craters are one morphology family with variants; the base maps are
  5-10x magnified at 1-2 km/px.
- Twilight / the required `dist=1.12, phase=95` view: physically faint at the film's exposure (see 5).
- The darkest markings are still a little lighter and warmer than in the (contrast-stretched) Viking mosaic
  (Acidalia ~90/65/51 vs 66/54/51).
- Phobos at the film's transit (60-90 px, low phase) is a dark grey lump with faint grooves and craters: correct
  physics (3-5x darker than Mars), so its detail depends on exposure (see requests).

## Requests to integrator
- Director: Phobos (geometric albedo 0.07) sits ~2-3 stops under Mars; +0.5 to +0.7 stop during the transit
  (currently ~174-178 s) would let its grooves and craters read.
- Post: soften the toe below ~0.02 linear (dark-but-lit bodies, Martian twilight, lunar maria keep their texture);
  the current look also warms / saturates dark tones (dark Martian basalt needed a bluer albedo to read slate).
- Consider replacing the required limb view with `dist=1.25&phase=95&el=0&fov=50&look=0,22` (contains the limb).
