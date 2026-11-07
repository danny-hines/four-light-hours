# Sun — notes

Owner files: `src/bodies/sun.js`, `src/bodies/sun/*` (features.js, noisetex.js, photosphere.glsl.js,
corona.glsl.js, prominence.glsl.js, point.glsl.js). No assets: everything is procedural (the noise volume is
generated in code at start-up, ~75 ms). Screenshots: wave 2 in `shots/sun/w2/` (`base_*` = state at the start of
wave 2, `r10_*` / `r14_*` / `film_final_*` = current); older rounds in `shots/sun/r1/`, `shots/sun/r3/`.

## Wave 2 changes (triage board #1-#4 + shader compile budget)

1. **Prominences (board #1).** Same analytic Gaussian-tube integration (no ray march, no jitter), new look:
   - eclipse red: H-alpha (1, .045, .05) for the optically thick term; the thin lines (1, .3, .32) are soft-clipped
     (`em / (1 + em/k)`, capped at 0.28 x the thick level), so cores reach pale pink, never white;
   - display-graded like the corona: the saturated plasma lands on `PROM_DISP` (0.65 of linear display radiance at
     the shot exposure; up to x2.6 in wide views), far below the tone curve's shoulder (was ~3x brighter: the
     "neon" pink-white came from AgX's path to white);
   - Gaussian radial profile (was a flat-topped, hard-edged tube); rope radius pinched at the feet, fatter at the
     apex, lumpy; a diffuse Gaussian envelope 2.3x the rope radius at ~10-15 % brightness, patchy;
   - fragmentation: rope-level knots and gaps (filling ~30 %) in 2D (along x across), 14 threads per rope each
     broken into tapered segments (filling ~40 %) that drain along it, lognormal brightness per strand (sigma 0.8)
     and per thread; opacity lowered (kappa 0.35) so most of the plasma is in the linear regime and the structure
     shows instead of a saturated slab;
   - hedgerows: short, segmented, knotty vertical threads (3 octaves) of lognormal brightness over a diffuse fill;
   - one program for every box, `DoubleSide` + a uniform picks front/back faces (entering a box no longer switches
     to a new program variant mid-film).
2. **Sunspots (board #2).** features.js now *generates* the groups (10 regions, 95 spots): a big leader (1-3 umbral
   cores) at the given position, Joy's-law tilt (0.56 x |lat| + scatter), intermediate spots offset 20-40 % from
   the axis, a fragmented follower cluster with power-law sizes and rudimentary one-sided penumbrae, scattered
   pores, rejection-sampled spacing. Shader: umbra = sum of 1-3 domain-warped cores (boundary where the core field
   is 1/2), light bridges where two cores meet (the granulation itself, dimmed, variable width), lobed penumbra
   (+-25 %) that can be one-sided, filament tips at their own radius (granules between them), bright heads in the
   inner third, inner penumbra I ~0.86 -> outer ~0.68, coarse radial bundles that survive at mid range, twist
   per spot. CPU culls to the visible hemisphere (<= 72 spots in the arrays). Leader positions are unchanged, so
   the existing framings (skim, AR B spot view) still hold.
3. **Granulation (board #3).** The large-scale field (limb, faculae, spots) keeps the photographic chroma (1.6); the
   granulation-scale fluctuation is colorimetric (CHROMA 1). Measured: the display hue swing comes almost entirely
   from the hero tone curve (red channel in the shoulder, G carries the luminance: corr(Y, G/R) = 1.00), so the
   granulation-scale fluctuation also gets a gentler display contrast (`HERO_CONTRAST_SMALL` 1.15 vs 1.9 for the
   large scale). Skim crop: display luma RMS 24.8 % -> 15.5 %, G/R std 0.124 -> 0.078; limb darkening unchanged
   (full disc G: centre 179, r .9 97, r .97 58, identical to before). Added meso/supergranular brightness
   modulation (~2.5 % RMS: 6-14 Mm noise + per-supergranule), meso patches of stronger/weaker granulation, a wider
   granule size distribution (power weights; big granules brighter), bright-point chains in lanes, curved
   fragmentation lanes, faint rims close in.
4. **Skim sky / spicules (board #4).** The flat lift is replaced by a height profile of the sky above the limb
   (`uSkyLift`: bright pearl within ~0.05 R, falling ~h^-1.5, dimmer up high; warm pearl tint (1, .95, .88) in close
   views). Spicules: heights 2-15 Mm (heavy tail), ~70 % in network bushes with empty stretches, lognormal
   brightness, tips widen and fade into a glow.
5. **Shader compile budget.** New `noisetex.js`: a 64^3 RGBA8 tileable gradient-noise volume (4 channels, mipmapped)
   replaces every inlined `snoise()` (one explicit-LOD fetch per call site, mip = footprint average); all loops
   have uniform bounds; the two granulation passes are one loop; the Worley network loop became a ridged-noise
   fetch; prominence Newton/crossing has one strandP call site; runtime debug branches are compile-time defines.
   Texture noise has a ~1.6x longer correlation length than snoise, so converted call sites use `SN = 1.6`.

### Shader compile cost (`node tools/checks/shader_cost.mjs --q "only=sun,post&view=body&body=neptune&phase=0&dist=3"`)
(The tool's default journey view draws the Sun in the first frame, which compiles everything before the
measurement; the Neptune view keeps the Sun out of that frame.) Fresh profile, shared CPU, two runs:

| object | wave 1 | now (runs 1 / 2) |
| --- | --- | --- |
| sun-photosphere | 17812 ms | 285 / 280 |
| sun-prominence (one program for all 17) | 7871 ms | 285 / 313 |
| sun-corona | 471 ms | 90 / 87 |
| sun-chromosphere | 130 ms | 44 / 45 |
| sun-point | ~0 | ~0 |
| **total** | **26284 ms** | **704 / 725** |

Run-to-run noise is +-30 ms. Ablation (for the next diet): spots ~180 ms and granulation ~140 ms of the
photosphere; arches ~240 ms and hedgerows ~75 ms of the prominence program. Constant-vs-uniform small loops and
micro-trims made no measurable difference; removing a 27-iteration hash loop saved ~60 ms.

### GPU (only=sun,post, 1600x900, 4x MSAA, `postPerf=1`)
skim 1.21 ms, full disc 1.15 ms, limb 0.93 ms, prominence close-up 1.44 ms, grazing 1.14 ms (wave 1: 2.6-2.9 ms).

## What exists

True scale, R = 109.2 units. Everything lives in a `rotor` group that spins with
`bodyQuaternion('sun', REF_DAYS + (simDays - epochDays))`. REF_DAYS is 2026-11-02 12:00 UTC, so the Sun shows
the same face to the body-view camera on any viewing date, and it still rotates at the real IAU rate during the
film. Active regions drift slowly with Snodgrass differential rotation relative to that frame.
Note: `view=body&body=sun` without `phase` uses main.js's default phase = 30, so the default camera sits over
heliographic (lat ~+10, lon ~-144), which is what features.js is laid out around.

**Photosphere** (opaque sphere; the shading point comes from an exact per-pixel ray/sphere hit)
- Limb darkening: grey atmosphere, Eddington–Barbier with a Hopf-function fit, T(mu) = Teff·[3/4·(mu + q(mu))]^(1/4),
  Planck B_lambda(T) per channel (610/550/465 nm). Luminance exact; chroma of the large-scale field x1.6
  (photographic), granulation colorimetric.
- Disc-centre colour (1.0, 0.70, 0.36) at unit luminance; post's `HERO.discRGB` is derived from DISC_RADIANCE 3000 x
  this colour (keep in sync).
- Hero display contrast: luminance relative to disc centre raised to `HERO_CONTRAST` 1.9 (large scale) and
  `HERO_CONTRAST_SMALL` 1.15 (granulation scale), gated by the same exposure track as post's HERO.
- Granulation: animated power diagram (one loop, two passes), domain warped at three scales; Hinode/SST-like lane
  profile, DKIST-like close in; rounded corners, dark junction pockets, domes, rims, sub-granular structure, dark
  dots, exploding and fragmenting granules, grazing 3D relief, bright-point chains; footprint LOD to calibrated
  mottling (GRAN_MEAN 0.85, S_MEAN 0.48, `?sundebug=1/7`). Life cycle ~15 s of film time; skim frames 1 s apart
  correlate at 0.974-0.976 (no popping).
- Meso/supergranular brightness modulation and network (ridged noise at 31 Mm); faculae rising as (1-mu)^3 in
  worm-like plage networks around every group, polar faculae.
- Sunspots: see wave 2 item 2; Wilson depression (600 km), umbral dots close up.

**Corona** (`sun-corona`: BackSide shell of 22 R; works with the camera outside or inside)
- Line-of-sight integral on a fixed angle grid (24 samples), K-corona (Baumbach-like background, polar holes with
  plumes, AR condensations, warped streamer belt, 10 helmet streamers with bulb / cavity / cusp / stalk), F-corona;
  sky-plane striations seen from outside; eclipse-graded gain `min(1, (0.002/exposure)^1.15)`, eased to a faint halo
  at disc exposures; height-graded sky in close views (`uSkyLift`). Loop arcades are compiled out
  (`sundefs=SUN_ARCADES` brings them back) for the compile budget.

**Chromosphere** (`sun-chromosphere`, CHROMO_PASS on a 1.0185 R shell, DoubleSide + uniform face choice)
- Analytic H-alpha band (Chapman column, footprint pre-filtered) + spicule forest (wave 2 item 4).

**Prominences** (17 boxes: arches, hedgerows, one eruptive loop; see wave 2 item 1). Against the disc nothing is
drawn (filaments are invisible in white light); boxes entirely inside the disc are culled on the CPU.

**Far field** (`sun-point`): below ~2.6 px disc radius a screen-space Gaussian carries the disc flux (core <= 29000);
planets occlude it through the depth test.

## Radiance and exposures

Disc centre **3000** (DISC_RADIANCE). Prominences are display-graded (see above). Post's hero composite gives the disc
its own exposure, so the shot exposure mainly sets how strongly the corona, chromosphere and prominences read.

| shot | exposure | command |
| --- | --- | --- |
| full disc | 0.0003 | `node tools/shot.mjs --q "view=body&body=sun&dist=4&el=5&fov=40&exposure=0.0003" --hud 0 --out shots/sun/full.png` |
| wide corona | 0.002 | `node tools/shot.mjs --q "view=body&body=sun&dist=14&fov=30&exposure=0.002" --hud 0 --out shots/sun/wide.png` |
| limb + prominences | 0.0002 | `node tools/shot.mjs --q "view=body&body=sun&dist=1.9&fov=25&look=17,0&exposure=0.0002" --hud 0 --out shots/sun/limb.png` |
| prominence close-up | 0.0002 | `node tools/shot.mjs --q "view=body&body=sun&dist=1.9&fov=8&look=31.5,2&exposure=0.0002" --hud 0 --out shots/sun/promzoom.png` |
| close skim | 0.0002 | `node tools/shot.mjs --q "view=body&body=sun&dist=1.12&el=0&fov=70&look=0,-28&exposure=0.0002" --hud 0 --out shots/sun/skim.png` |
| skim motion | 0.0002 | the same query with `--t 0:4:1 --sheet shots/sun/skim_motion.png --cols 5` |
| sunspot (AR B leader, multi-core + bridges) | 0.0002 | `node tools/shot.mjs --q "view=body&body=sun&dist=1.12&el=14.3&phase=55&fov=30&exposure=0.0002" --hud 0 --out shots/sun/spot.png` |
| granulation close (DKIST-like) | 0.0002 | `node tools/shot.mjs --q "view=body&body=sun&dist=1.03&el=5&fov=20&exposure=0.0002" --hud 0 --out shots/sun/gran.png` |
| grazing horizon (spicule bushes, hedgerow) | 0.0002 | `node tools/shot.mjs --q "view=body&body=sun&dist=1.02&el=0&fov=50&look=0,-70&exposure=0.0002" --hud 0 --out shots/sun/graze.png` |
| far views | 1 | `view=body&body=jupiter&dist=40&phase=175&fov=20`, `view=body&body=neptune&dist=20&phase=165&el=3&fov=40` (in the required Neptune view, dist=2 and phase=170, the Sun is behind the planet) |
| film | — | `node tools/shot.mjs --t 12:44:4 --sheet shots/sun/film.png --cols 3 --hud 0` (sun chapter of the current cut: wide 12-16, full disc 20-24, photosphere 28-36, departure 40) |

Dev-only URL switches (ignored otherwise):
- `sundebug=1` raw granulation (x0.3; calibrates GRAN_MEAN), `sundebug=7` lane profile S (calibrates S_MEAN),
  `sundebug=2/3` corona without / with only streamers, `sundebug=10` prominence NaN check (magenta) — all become
  `#define SUN_DEBUGn`, so they cost nothing in normal runs; `sundebug=6` hides prominences;
- `sunprom=i,j` only those prominences; `sunmask=n` layer mask (1 photosphere, 2 shells, 4 prominences, 8 no corona,
  16 no chromosphere);
- `sunhk=x` / `sunhks=x` hero display contrast (large / granulation scale), `sunsky=x` skim sky profile strength,
  `sunpe=disp,thinSat,kappa,kappaHedge,thinHedge` prominence emission, `sunwb=r,g,b`, `sunchroma=x`,
  `sundefs=A,B` shader defines (e.g. `NO_SPOTS`, `NO_GRAN`, `NO_HEDGE`, `NO_ARCH` for compile ablations).

## Known gaps

- Prominences: much less neon, but at grazing angles (looking along an arch) the threads still line up into
  streaky ribbons, and at full-disc scale the hero arches read as loops/rings (shape variety is limited to
  arch / hedgerow / one eruptive loop). AgX renders the saturated H-alpha as salmon-crimson; a deeper eclipse red
  would need post.
- The granulation hue swing that remains comes from post's hero tone curve (red in the shoulder); see requests.
  Extreme close-ups (0.03 R) are smooth soft blobs with little interior structure.
- Penumbral filaments at mid range are faint coarse bundles; the outer penumbra edge can read as a thin dark
  contour; some multi-core umbrae look like ink blots near the limb.
- Skim spicule fringe is improved (bushes, varied heights) but can still read as a comb along a long, evenly lit
  limb at mid distance.
- Corona fine structure is still direction noise + sky-plane striations (no field-line tracing); the singular swirl
  inside the corona at a fixed world direction (wave-1 note, not in the cut) is not fixed.
- Compile: photosphere ~280-300 ms, prominence ~285-315 ms; the total (~700-725 ms) has ~80 ms margin.

## Requests to integrator / director / post

- Post: `HERO.discRGB` is derived from DISC_RADIANCE (3000) and DISC_CENTRE (1, 0.70, 0.36); keep in sync. Keep
  HERO.gamma at 1.4 (sun.js applies its own hero contrast).
- Post (granulation hue): in the hero disc composite the red channel sits in the tone curve's shoulder
  (HERO.target 2.4), so every granulation-scale luminance swing becomes a lemon/orange hue swing (corr(Y, G/R) = 1.0
  in the skim). A slightly lower HERO.target (~1.6-1.8) or a hue-preserving blend at high frequency would remove the
  rest of board #3 at no cost; the Sun side already renders that fluctuation colorimetrically.
- Shader-cost tool: with its default journey view the first frame draws the Sun and compiles all of its programs
  before the measurement starts, so the Sun reads ~0 ms; measure with a view that keeps the Sun out of frame
  (e.g. the Neptune query above).
- Optional shot fields read by the Sun: `shot.sunCorona` (corona gain multiplier), `shot.sunProminence` (0 hides
  the prominences).
- The point sprite is mine (glints skips the Sun). Post can rely on `sun.angularRadius`; the core stays <= 29000.
