# Uranus piece — notes

Owns `src/bodies/uranus.js`, `src/bodies/uranus/*`. No shipped assets: all procedural (0 bytes of the asset budget).
Data fetched: JPL Horizons state vectors for the five moons (`assets-src/raw/uranus_moons_horizons/`), and (fix round 2)
Voyager 2 moon images as visual references only (`assets-src/raw/uranus_moon_refs/`, see SOURCES.md).

## What exists

**Globe** (`uranus/globe.js`, haze in `uranus/shared.js`)
- Exact oblate deck (f = 0.0229), ray/ellipsoid intersection from the mesh point. Tilt and retrograde 17.24 h spin come
  from `bodyQuaternion('uranus')`.
- Tonality (fix round 2): Minnaert B0 = (0.37, 0.88, 0.97), k = (0.90, 1.08, 1.06), fitted through the post's AgX
  curve (`tools/agx.py`). Bullseye centre sRGB (194, 228, 229) vs Voyager PIA18182 (197, 235, 238); limb R/G at
  r = 0.98 is 0.75-0.82 (reference 0.75-0.77).
- **2026 north polar cap** (sub-solar latitude +73.6 deg), after HST 2022 / JWST 2023: +13 % R, +8.5 % G, +7.5 % B
  over the mid-latitudes, with a soft but definite ~3-deg edge at 59.5-62.5 N that meanders slightly with the 60 N
  jet, a darker collar lane (-3.5 to -4 %) at 56.5 N just outside it, and a gentle further rise toward the pole. In the
  pole-on views it reads as a brighter, slightly off-centre disc. Close up the edge is turbulent.
- Zonal bands, 2-3 % peak to peak: bright 45-50 N zone, dark ~33 N, faint bright ~21 N, darker equatorial belt
  (plus southern bands now in polar night), plus faint irregular band noise.
- **Close range**: zonal streaks (st = 1:9 stretched, flow-blended, sheared by the wind profile) whose contrast rises
  from ~1 % at disc scale to ~3-5 % once a pixel is under ~30 km; convective cells (300-800 km, ~6 %) inside the cap.
  Physically faint at disc scale, but a close pass now has structure.
- **Bright CH4 clouds** (rewritten): 10 clouds at 27-58 N (plus one in the dark south), a few big ones and more small
  ones. Each is a compact, irregular head (anisotropic noise in its own lat/lon frame, elongation 1.2-1.8) with a plume
  of per-cloud length that widens, fades and breaks up downstream. Peak 1.1-1.22x the deck in green (visible-light
  contrast). No long limb-parallel arcs or glints.
- **Limb (root-caused)**: the navy outline came from (1) the H2 Rayleigh in-scatter's blue excess dominating the dark
  limb, (2) red being removed twice, once by the sunward CH4 path and once by the view-path CH4 share of the deck
  transmittance, although the fitted Minnaert law already contains both. Fixes: the effective haze single-scattering
  albedo is cyan (uHazeW = 0.6, 0.93, 0.98, since haze light has crossed CH4-bearing air), the Rayleigh blue is
  limited to 1.1x green, the deck sun-path uses only 0.35 of the CH4 term, and `deckT()` excludes the CH4 share from
  the deck-light transmittance (globe and shell alike). The limb now fades at nearly constant hue.
  Pixel row y=420 of rings_close, last pixels: was (29,65,89) (6,33,60); now (37,65,64) (16,31,31).
- **Crescent**: stays cyan-teal at phase 140 (the forward-scattering haze is now CH4-tinted).
- Haze: H2 Rayleigh + aerosol (H = 32 km, two-term HG) + tenuous stratospheric haze (H = 52 km); cloud-top fuzz in the
  shell. Analytic ring and moon shadows on the deck.

**Rings** (`uranus/rings.js`)
- All 10 narrow rings with real a, e, apsidal precession, width–radius relation (epsilon 19.7-96.4 km), tau; analytic
  footprint coverage (no aliasing), lit/unlit face photometry, forward-scattering dust, exact oblate planet shadow.
- Fix round 2: particle tint neutral grey (1.0, 0.995, 0.985) instead of warm. The phase law of the dark particles
  e-folds at 55 deg (was 38, lunar-like) with up to 1.8x exposure compensation toward 90 deg. Both are deliberate
  long-exposure choices, so the hairlines stay readable in the inclined views. Thin-layer 1/mu brightening was already
  in the layer model (I = K tau / mu for thin rings).

**Moons** (`uranus/moons.js`, `uranus/orbits.js`): surface model rewritten in fix round 2 and compared against
Voyager PIA01490, PIA18185, PIA00140, PIA00141, PIA01534, PIA00041 and PIA00039.
- Orbits and photometry are unchanged (Horizons-phased, synchronous; Hapke IMSA with Karkoschka albedos, system gain 1.3).
- **Multi-scale relief**: a self-affine fractal (quintic gradient noise with analytic derivatives), up to 10 octaves
  from ~80 km down to the pixel, each faded in once its wavelength spans a few pixels. Plains are no longer plaster.
- **Craters**: one loop, one `crater()` call site. Named craters first, then hierarchical 3D-cell fields. Power-law
  radii inside each octave (dN/dR ~ R^-3, so N(>D) ~ D^-2 overall). Strong degradation variance (freshness
  ~ u^1.9): most craters are shallow, flat-floored and broad-rimmed, a few percent are crisp and bright. Polygonal
  outlines, analytic rim shadows.
- **Graben**: a Voronoi fault network (two-pass border distance in an anisotropic 3D domain, stretch axis in the
  equatorial plane so the lit north shows long sub-parallel rifts). Every border is a fault, but width and depth
  depend continuously on its orientation (wide along the trend, narrow cross-links). The two nearest borders are
  smoothly unioned, so Y-junctions have no creases or cut-off ends. Activity is a smooth province field, so rifts pinch
  out. Flat resurfaced floors, a medial groove (Ariel), uplifted shoulders, tilted blocks (the two walls differ in
  height), slope-limited walls, analytic wall shadows, bright fresh scarps. Ariel: a dense network of chasmata.
  Titania: a few long branching rifts. Oberon: sparse. Miranda: sparse grooves in the cratered terrain. The named
  southern chasmata remain great-circle troughs.
- **Miranda coronae**: signed distance to a lobate superellipse/trapezoid outline (two warp octaves). The band phase
  is the depth inside the outline, warped by ~0.8 of a band spacing, with spacing varying ±30 % along the outline, so
  bands wander, pinch, merge and fade. Relief uses an asymmetric ridge profile (sharp crest, broad trough, one steeper
  flank) plus fine parallel grooves. Albedo stripes come from the same field (period 1.45 ridges, ±24 %) and fade out
  along strike, with dark blotches in the dark bands. A raised outer edge truncates the cratered terrain. Knobby,
  mottled cores. The chevron is a ragged, feathered bright albedo patch of varying width with streaks parallel to its
  arms. Five coronae: Arden, Elsinore and Inverness (south, in polar night in 2026), plus two extrapolated northern
  ones. One is an Arden-like banded racetrack (34 N, 196 E: the hero view). The other is an Inverness-like polar
  trapezoid with its own chevron (76 N, 60 E). The extrapolated straight scarp of round 1 was removed (it read as a
  white tube at the terminator). Verona Rupes remains in the south.
- **Slope limit** ~35 deg on all relief, so sunlit walls at the terminator no longer blow out to white tubes.
- Debug: `udbg=2` Lambert-only shading, `udbg=3` 30-deg lat/lon grid on the moons (lon 0 / lat 0 tinted).

**Shader compile time**: see the wave-2 section below.

## Wave 2: shader compile budget and the black limb pixels (engineering only; the look is unchanged)

**Compile cost** (`node tools/checks/shader_cost.mjs --q "only=uranus,post"`, fresh Chrome profile, lower of 2 runs):

| object | before (wave 1) | after |
| --- | --- | --- |
| uranus-globe | 2166 ms | 269-285 ms |
| uranus-miranda (Miranda's own program) | 3139 ms | (one program for all moons) |
| uranus-ariel (the other four moons) | 1969 ms | |
| moons in the film (lean, see LOD) | | 130 ms |
| uranus-haze | 93 ms | 53-55 ms |
| uranus-rings | 0 ms | 0 ms |
| **piece total** | **7367 ms** (5888 ms lead's run) | **453 ms** (second run 472) |

The full-detail moon program, built only for moon close-up views (`target=<moon>`, or `umoons=full`), measures 1022 ms
(`--q "only=uranus,post&umoons=full"`).

What FXC actually spends its time on (measured offline with `d3dcompiler_47.dll` on ANGLE's own HLSL,
`src/bodies/uranus/tools/{hlsl.mjs,fxc.py,segs.py,stub.py}`; findings that apply to every piece):
- Time grows ~n^1.5 with the optimized instruction count (straight-line 794 instr 137 ms, 1582 instr 383 ms).
- Every inlined call site counts: the deck shader had ~35 inlined copies of `snoise()` (fbm, snoise3, a 10x
  unrolled cloud loop, 2x unrolled worley) = 3435 of its 4574 instructions.
- **Conditional regions inside loops are the big multiplier**: 16 samples behind 16 `continue`s in a loop compile in
  1520 ms; behind nested ifs 1127; behind one guard 585; the same code straight-line 383. ANGLE also rewrites every
  `?:` into if/else. So loop bodies were made branch-free (one-hot weights, `mix(a, b, float(cond))`, two-smallest
  bookkeeping with `min`/`max`) with one guard around the heavy call (`if (use) n = snoise(x);`).
- `discard` in a shader makes ANGLE emit `ANGLE_USES_DISCARD_REWRITING` (an old skip-optimization workaround), but on
  this Chrome's D3D11 path it does not change the compile time (measured; not used). FXC attributes/flags do not help.
- Register pressure and const arrays: a 30-float struct live through a long loop and `const vec4 X[10]` (which FXC
  turns into indexable temporaries) both cost; tables are uniforms, the corona noise is accumulated straight into the
  sums it feeds.

Changes (all arithmetic per sample kept; see the comments in each file):
- `globe.js`: every deck noise sample is an entry of a tap table (`TAPS`, 43 taps: input = base * scale + offset,
  weighted into one-hot accumulator slots), evaluated by one snoise() site in one real loop; the 10 clouds (2 samples
  each) in a second loop. Worley over 27 neighbours in one real loop with branch-free F1/F2. Per-cloud constants
  (drift rate, sin(1.7 i)) precomputed in JS. 4574 -> 1086 instructions.
- `shared.js`: the haze's two quadrature segments run in one loop with uniform bounds (empty segments skipped by the
  bounds, not a branch); `sunAirmass2()` does both scale heights at once; `sunAirmassH`, `deckOcclusion`,
  `sphereShadow` branch-free. Haze shell 586 -> 358 instructions.
- `rings.js`: ring loops have uniform trip counts; the globe's ring shadow uses a lean, branch-free `ringOpacity()`
  without `atan`. The rings shader itself is unchanged.
- `moons.js`: one program for the five moons; a simplex tap table (provinces, fault activity / width noise, 7
  mottling octaves, Miranda's corona detail, the 4 samples of each rayed crater); one gnoiseD() site for the corona's
  10 samples (tables in uniforms) and the relief octaves; corona in straight-line code before the crater loop; crater
  loop, crater(), canyons, scarp, Voronoi passes branch-free under one guard each; Hapke for both geometries in one
  call. 3836 (Miranda) + 2757 (others) -> 2336 instructions.
- **LOD by use**: `src/bodies/uranus/tools/moonsize.mjs` evaluates the director over the whole film: the largest any
  Uranian moon ever gets is 3.2 px in radius (Ariel, t = 344 s). So the film builds `MOON_LEAN` (571 instructions):
  the same photometry, provinces, mottling and relief, plus the unresolved-crater roughness term computed exactly as
  the full program does. At film scale it matches the full program to 0.6-0.8 % in disc flux (Ariel at 450 R, Miranda
  at 200 R). The full program is built for `view=body&body=uranus&target=<moon>` and `umoons=full`;
  `FULL_MOONS_IN_FILM` in moons.js switches the film to it (+~0.9 s of first-draw compile) if a moon close pass is added.
  The choice is fixed at create(); every material that a mode draws is in its scene graph after create().
- Debug variants are defines fixed at creation: `udbg=1` latitude stripes, `2` moon Lambert, `3` moon grid,
  `9` NaN/Inf finder (globe red, haze shell green, moons magenta).

**Black pixels on the lit limb, root cause**: in the haze shell, a ray exactly tangent to the deck gives
`length(pc) = 1.0` after rounding (`ht = 0`) while `raySphereS()` reports a miss (`1 - dot(pc, pc) < 0`). The old
`ht <= 0` branch then used the miss sentinel `tp.x = 1e20` as a hit distance: `normalize(o + d * 1e20)` overflowed to
the zero vector and `sunAirmass(0)` computed `mu = 0 / 0`. The resulting NaN sample poisoned the MSAA resolve, and the
post's sanitizer turned the pixel black, with a 2-3 px blot after its filters. It was view-locked: rings-close
(275-277, 786-788) and `dist=6&phase=10&el=60` (988-990, 594-596). Fix at the root: the deck branch requires a real
hit (`tp.x <= tp.y`), a tangent miss is a cloud-top graze at `ht = 0`, and `sunAirmassH()` guards `r >= 1e-6`. The
`udbg=9` finder shows no NaN/Inf in any of the 17 views. `src/bodies/uranus/tools/darkpix.py` reports 0 dark pixels
(was 4 and 7).

**Before / after** (`sh src/bodies/uranus/tools/w2views.sh <dir> "&only=uranus,post"`, 17 views; the before set
rendered with the wave-1 files; `python -I src/bodies/uranus/tools/imgdiff.py before after diff 16`; sRGB 0-255):
MAD <= 0.001 and 99th percentile 0 in 16 of 17 views (including the 5 required views, Miranda, Ariel, Titania,
Umbriel, the crescent, the limb and the rings). Only the 6-7 former NaN pixels differ, now matching their neighbours.
Exception: Oberon, MAD 0.045, 0.1 % of pixels > 8 (max 57), along its graben walls. Bisection: none of the rewritten
functions causes it (each swapped back in turn: identical). It is FXC's evaluation order inside the "hash without
sine" at Oberon's large fault seed (71 x 3.1 = 220), which moves Voronoi sites by ~1 px, so it comes from the compiler,
not from a logic change. Shots: `shots/uranus/w2_before_ns/`, `shots/uranus/w2_after_ns/`, diffs `shots/uranus/w2_diff_ns/`.
The with-sky sets `shots/uranus/w2_before/`, `w2_after/` differ only in the sky (another builder's work in between).

**Frame time**: at 1600x900 every view is still at the 240 Hz vsync cap (p95 4.3 ms). At 3840x2160, branch-free
loops do somewhat more work per pixel: globe close-up 5.6 -> 6.4 ms per frame (post included), Miranda close-up
(full program, inspection only) 6.4 -> 9.1 ms. The film's lean moons cost almost nothing.

## Best shot commands
```bash
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=5&phase=10&el=5" --out shots/uranus/fix2/final/v_bullseye.png       # cap + lane, bands, clouds, rings
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&target=miranda&dist=3&phase=50" --out shots/uranus/fix2/final/v_miranda.png  # coronae, chevron, craters
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&target=ariel&dist=3&phase=50" --out shots/uranus/fix2/m12_ariel.png        # chasmata network
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=4&phase=140&el=0" --out shots/uranus/fix2/final/v_crescent.png         # cyan crescent, dust
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=1.2&phase=40&el=0&fov=50" --out shots/uranus/fix2/final/v_limb.png     # close-range streaks
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=2.2&phase=110&el=54&look=17,-56&fov=12" --out shots/uranus/fix2/r1_ringzoom.png  # rings resolved
node tools/shot.mjs --t 330:354:4 --sheet shots/uranus/fix2/film_sheet.png --hud 0 --cols 4                                       # film chapter
```
Other moons: `target=titania|oberon|umbriel&dist=3&phase=50`; Miranda close `target=miranda&dist=1.3&phase=50`;
Miranda terminator `target=miranda&dist=1.6&phase=85`. All six required views: `sh src/bodies/uranus/tools/views.sh
<prefix> ""`; wave-2 set of 17 views: `sh src/bodies/uranus/tools/w2views.sh <dir> "&only=uranus,post"`.
Compile cost, fast (offline FXC on ANGLE's HLSL, ~10 s): `sh src/bodies/uranus/tools/cost.sh` (add `umoons=full` as
the 2nd argument of `hlsl.mjs` for the full moon program); per-loop instruction counts `python -I
src/bodies/uranus/tools/segs.py <file.hlsl>`; what-if `stub.py <file.hlsl> f_name`; in-browser
`node tools/shot.mjs --page src/bodies/uranus/tools/ctime2.html --out x.png`. Moon sizes in the film:
`node src/bodies/uranus/tools/moonsize.mjs`. NaN finder: add `&udbg=9`; `python -I src/bodies/uranus/tools/darkpix.py *.png`.
Dev tools: `tools/agx.py fwd|inv r g b`, `profile.py img.png [cx cy R]`, `crop.py in out x0 y0 x1 y1 [scale]`,
`imgdiff.py beforeDir afterDir outDir [gain]`.

## Performance
Full-screen Miranda and Ariel at 1600x900 run at p95 4.3 ms, the 240 Hz vsync cap (wave 2: unchanged; at 4K see the
wave-2 section). Fine detail is footprint-gated; `q=low` drops relief octaves, crater octaves and mesh density.

## Known gaps
- Miranda's coronae are much better but still read a little "designed": the banded racetrack follows its outline more
  faithfully than Arden does. Craters at 3-15 px can still read as bumps under the crater illusion.
- Ariel's network shows faint polygonal cross-links in places; the Voronoi approach can produce small closed loops.
- The close-range globe texture is marbled zonal flow (domain-warped); real small-scale Uranus structure is unknown.
- The limb's last pixel shows a ~10 % one-pixel dip between the deck edge and the haze fringe; its R/G is about 0.55
  (deck 0.7).
- **Required "rings close" view** (`dist=2.2&phase=20&el=30&fov=40`) has no rings in frame, and **"close limb"**
  (`dist=1.2&fov=50`) has no limb (geometry). Rings close-up: `dist=2.2&phase=110&el=54&look=17,-56&fov=12`.
- Rings seldom cross the lit disc in the film's framings; their absorption is physical (opacity by coverage).
- Compile: the globe (270-285 ms under the shared machine's load) is the largest object, ~20 % under the 350 ms cap; the
  full moon program (~1.0 s) is outside the budget by design: it is only built for moon close-up views. If the film
  ever needs it, set `FULL_MOONS_IN_FILM` (the piece would then be ~1.4 s).
- The lean film moons have no resolved craters / coronae / faults (invisible below ~5 px; they differ from the full
  program by < 1 % in disc flux at film scale). If a moon is framed larger than ~10 px, use the full program.

## Requests to integrator / director
- A rings close-up framing with rings in it (e.g. `dist=2.2&phase=110&el=54&look=17,-56&fov=12`), and a moon close
  pass: Miranda at `dist=1.6-3, phase 50-85` shows the extrapolated banded corona; Ariel at `dist=3` shows its chasmata.
- Ring brightness is set by `uGain` / `uDustGain` in `rings.js` if the post grade changes.
- Director: if a Uranian moon close pass is added, tell the uranus piece (or set `FULL_MOONS_IN_FILM = true` in
  `src/bodies/uranus/moons.js`); today no moon exceeds 3.2 px in radius anywhere in the film.
- Integrator: the warm-up compiles programs one at a time. With KHR_parallel_shader_compile, ANGLE compiles on
  worker threads, so `renderer.compileAsync(scene, camera)` for the whole scene (then the per-object draws) would
  overlap the pieces' FXC work across cores. Also worth passing on to every piece: FXC's time explodes with
  conditional regions (`continue`, `if`, ANGLE-rewritten `?:`) inside loops (numbers in the wave-2 section).
