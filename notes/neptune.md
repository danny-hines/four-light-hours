# Neptune + Triton (piece: neptune)

Files: `src/bodies/neptune.js`, `src/bodies/neptune/{common,globe,cloudlist,haze,rings,triton,triton-surface}.js`,
`assets/triton/{color,mask}.webp` (160 KB total), `assets-src/scripts/process_triton.py`.

## Wave 2: what changed and why

Wave-1 verdict 6.5 (disc 7, framed spot 5.5, crescent 7.5, rings 7, Triton 6.5, Triton+Neptune 7.5). Triage items in order:

1. **Banding (board #3).** Band multipliers roughly doubled and the gas (Rayleigh) term now carries 85 % of the band
   pattern (was 60 %), plus a band-contrast exponent `uBandK = 1.2`. New profile: a broad dark southern belt with a
   sharp, meandering equatorward edge at ~-48.5 deg (just south of the bright Scooter line) and a softer poleward
   side; a bright collar at -71.5 (sharp poleward edge) around a darker polar cap; light zone at -30 (sharper
   poleward), a darker lane at -39.5, dark equatorial belt (0.52), +22 light, +50 dark. The profile is a 1024 x 2
   half-float LUT built in JS (`bandLut()` in globe.js). The GDS also darkens 40 % of the gas term (it is a hole in the
   haze). Measured on the central meridian of the required disc view (12-px strip median, limb darkening removed
   with a fit in mu): **p2p 64 DN, std 12.1** (wave 1: 53 / 8.9; Voyager frame by the same code: 87 / 14.4).
   Why p2p stays below 80: in the Voyager frame most of the p2p comes from the GDS (-31 DN) and its bright companion
   (+45 DN) lying on the central strip; in our required view the companions sit left of the strip. Pushing the bands
   to p2p 80 (`nepBandK=1.8`) made the disc look painted and Jupiter-like, so I stopped at std ~ reference. The
   southern belt + collar now read clearly from `el=-35` (`09_south`).
2. **Bright clouds and GDS (board #1).** Every filament now has a continuous opacity profile: a rounded core with
   a smooth shoulder at least ~2 px wide, an exponential skirt of thin cloud base (20 %), raggedness from ONE
   continuous warp of the across-track coordinate (two value-noise octaves, footprint-filtered), and fibres as a
   continuous density modulation (no thresholds, no ridged noise, so no stair-steps or striations). Cloud colour:
   core albedo capped at (0.74, 0.83, 0.94) and tinted by the gas column above it (`mix(1, deckTint, 0.22..0.42)`, more
   at thin edges), plus a soft halo: 12 % of a 3x-wide profile added as blue-tinted glow over the deck. GDS: the
   bright NE rim is gone (replaced by a faint broken cirrus arc on the N/NW edge), the S/E super-Gaussian softened
   (4.2 -> 2.8, 2.2 on N/W), the darker rims removed, the western third ~13 % darker, the main SW hook broader and
   brighter, and a broad bright streak under the western half (as in the Voyager frame). The deck inside the spot is
   carried by the vortex's own anticyclonic differential rotation (texture wraps around the rim), its fine texture
   is damped inside the spot, and the ridged term that drew hairline contours over the whole deck is gone
   (gain 0.68 per octave, then a k^-1 floor at 0.45 so close range keeps contrast; amplitude high in shear zones).
3. **Triton terminator (board #5).** The bump is now faded only toward the limb (not by mu0), the perturbed normal
   governs the terminator (`smoothstep(-0.03, 0.02, mu0)` on it, light at most ~4 deg past the geometric terminator),
   and **horizon taps**: 5 height-field taps toward the Sun at s = s0 * 2^k (s0 >= 2.4 km and >= 1.5 px, so the taps
   also see large-scale relief when Triton is small), curvature included; a tap shadows the point if its terrain rises
   above the sun ray. Taps run only where mu0 < 0.3 and fade out at the band edges. Pits fill with shadow and ridge
   tops catch light past the terminator (`23_triton_half`, `18_triton_north`).
4. **Cantaloupe (board #4, partly).** Cavi are now overlapping circular depressions (bowl kernels at jittered cell
   centres, radii +-40 %, raised rim ring, second generation of ~13 km pits), a large-scale density mask gives way to
   smooth plains with a few dark maculae and bright aureoles, mosaic hand-over feather narrowed from ~4 to ~1.5 deg.
   Plume streaks: 56 fans (40-150 km, heavy-tailed lengths / widths / darkness, dark head at the vent, NE-trending
   smooth wind field), ~3x sparser than before, rasterised once at create() into a mipmapped R8 cap map.

### Shader compile budget (hard requirement)

`node tools/checks/shader_cost.mjs --q "only=neptune,post" --top 25`, final two runs while other agents share the
CPU: **692 / 697 ms** total (wave 1: 15 424 ms in the same tool, 13.3 s for the globe alone). Per object (lower run):
globe deck 236, Triton 206, clouds 171, haze 67, Triton haze 12, rings ~0-40 ms; every object < 350 ms. Single runs
vary +-15 % with the machine's load.

How (root causes found with an offline FXC harness: ANGLE's translated HLSL via WEBGL_debug_shaders, compiled with
d3dcompiler_47 `D3DCompile` and timed in thread cycles; it reproduces the browser numbers):
- FXC cost is superlinear in inlined code: 10 inlined `snoise` = 200 ms, 20 = 560, 40 = 1780; one `snoise` inside a
  dynamic loop = ~20 ms. The globe had ~35 inlined simplex calls and two `ribbon` inlines.
- All minor noise is now one fetch of a shared 64^3 RGBA8 value-noise texture (`vn4`, `common.js`, generated in code;
  four independent channels per fetch). Simplex remains only inside loops (one call site per shader).
- The globe is two passes over the same geometry: the opaque deck (`neptune-globe`) and the bright clouds
  (`neptune-clouds`, a child mesh, renderOrder 0.5) blended `out = cloud + deck * (1 - opacity) * shadow`, so the
  cloud shadows still act on the deck. Two half-size shaders compile far faster than one.
- **All cloud bookkeeping moved to the CPU** (`cloudlist.js`): every frame JS builds the list of filaments that
  exist at simDays (band-cell lifetimes, drift of every feature, GDS companion arcs as rotated parabola segments with
  cos^2 windows that sum to one), a pure function of t, uploaded as 3 x vec4 per slot (max 80). The shader is one
  flat loop with one `ribbon()` call. (The previous per-pixel slot setup alone cost FXC ~0.4 s.)
- Deck: mottling and the fine cascade share one octave loop; band profile from a LUT. Triton: the relief octave
  loop serves three spectra; `relief()` has one call site that serves the shading point and the horizon taps; plumes
  are a texture; sulci poles from JS. Haze: flat sample loop, chapman() in a 3-species loop, branch-free.
- All textures are uploaded in create() with `renderer.initTexture`; the spheres carry positions only (normals and
  UVs dropped, globe 320x160), so the first draw uploads a third of the data. The warm-up pays almost only for programs.
- Every material exists in the scene graph after create(); no runtime define changes. The haze shells used to switch
  `material.side` when the camera entered them, which in three.js recompiles (FLIP_SIDED); they are now one
  double-sided single-pass program that discards the unwanted face (`uInside`).

Performance (RTX 4090, 1600x900): the 1.15 R full-screen close-up, the 1.8 R spot view and a 1.3 R Triton view all
hold the 240 Hz cap (4.17 ms/frame including post).

## What exists (cumulative)

**Globe** (`globe.js`, 320x160 oblate sphere, f = 0.0171, two passes)
- Reflectance per RGB channel: `I/F = A (1-g) mu0 exp(-ka Xe) deck + C_gas Rayleigh_LS(mu0, mu, Theta)`, excess
  airmass saturating (`Xe = X / (1 + X/3.2)`), calibrated against the Voyager radial profile.
- Deck: wind-advected two-phase flow map (2-day cycle), zonally stretched mottling, fine cascade, GDS-carried
  texture, polar mottling, band LUT with undulating edges.
- Discrete features at measured drift rates: GDS (-17.5 deg, 18.3 h, 8-day aspect/tilt oscillation) with hook,
  outer arc, west curl, N/NW cirrus arc and south-flank streaks; Scooter (-42, 16.8 h); DS2 with bright core (-54,
  16.05 h); South Polar Feature clouds (-70.4, 15.966 h). 18 hand-placed streaks + procedural band streaks.
- Cloud shadows (offset h tan z, h exaggerated to 240 km), analytic Triton shadow.
- Debug URL params: `nepDbg=1` graticule (yellow = equator, magenta = -60), `nepDbg=2` no clouds, `nepDbg=4`
  cloud opacity / halo; `nepBandK=<x>` band contrast; `nepHaze=<gain>`, `nepRingGain=<x>`, `nepArc=<deg>`.

**Haze shell** (`haze.js`, R x 1.05): two exponential hydrocarbon layers + Rayleigh gas, single scattering with
Chapman sun extinction and the planet's shadow cylinder, oblate-exact, footprint-floored scale heights, silhouette
coverage blending.

**Rings** (`rings.js`): Galle, Le Verrier, Lassell, Arago, Adams with clumpy arcs (Fraternite, Egalite 1/2, Liberte,
Courage; now a uniform list) co-rotating at 820.1185 deg/day; HG dust forward lobe, footprint-filtered, Neptune's
shadow.

**Triton** (`triton.js`, `triton-surface.js`): retrograde, inclined 156.885 deg, tidally locked, `positionAt(d)` is
exactly what is drawn; Voyager mosaic with feathered hand-over to procedural terrain, tile-gain equalisation,
cavi + sulci + plains/maculae, pink cap with plume map, relief cascade, horizon taps, Neptune-shine, thin N2 haze.

## Best shot commands

```bash
node tools/shot.mjs --q "view=body&body=neptune&dist=3.5&phase=20&el=5" --hud 0 --out shots/neptune/disc.png
node tools/shot.mjs --q "view=body&body=neptune&dist=1.8&phase=20&el=-5&days=-0.012" --hud 0 --out shots/neptune/spot.png   # GDS framed
node tools/shot.mjs --q "view=body&body=neptune&dist=3.5&phase=25&el=-35" --hud 0 --out shots/neptune/south.png       # belt, collar, SPF
node tools/shot.mjs --q "view=body&body=neptune&dist=4&phase=150&el=3" --hud 0 --out shots/neptune/crescent.png
node tools/shot.mjs --q "view=body&body=neptune&dist=5&phase=170&el=8" --hud 0 --out shots/neptune/rings.png
node tools/shot.mjs --q "view=body&body=neptune&target=triton&dist=3&phase=50" --hud 0 --out shots/neptune/triton.png
node tools/shot.mjs --q "view=body&body=neptune&target=triton&dist=3&phase=90" --hud 0 --out shots/neptune/triton_half.png   # terminator relief
node tools/shot.mjs --q "view=body&body=neptune&target=triton&dist=1.6&phase=75&el=30" --hud 0 --out shots/neptune/triton_north.png  # cavi at low sun
node tools/shot.mjs --q "view=body&body=neptune&target=triton&rel=neptune&phase=165&dist=8&aim=neptune&fov=45" --hud 0 --out shots/neptune/tritonnep.png
node tools/shot.mjs --t 360,372,386 --hud 0 --out shots/neptune/film.png    # current cut: hero disc, crescent, twin crescents
```
Add `&only=neptune,post,sky` for fast isolated runs. Wave-2 screenshots: `shots/neptune/w2/before/` (wave-1 state),
`shots/neptune/w2/final/` (this state), `shots/neptune/w2/film/sheet_b.png` (chapter sheet t=352..392).

## Facts for the director

- Current cut (re-locate by focus): approach 352-358, hero full disc ~358-364 (largest at 360), crescent with Sun and
  backlit rings 366-382, Triton twin crescents 384-390.
- GDS sub-camera alignment: at days=0 the GDS is at lon -78 deg, 6 deg east of the disc-view centre. It drifts
  -64 deg/day relative to the interior rotation (one turn per 16.11 h, which is 48 s of film).
- The Adams arcs orbit every 10.5 h (32 s of film). Triton moves 61 deg/day of orbit. Twin crescents at days=0.
- A camera ~30 deg below the equator (`el=-35`) shows the southern belt, collar and SPF clouds as Voyager did.

## Known gaps

- Central-meridian band p2p is 64 DN in the required disc view (std 12.1 matches the reference); see item 1 for why.
- Close range (1.15 R) is wispy and low-contrast rather than rich: no small convective tufts yet (the slot list has
  no room for hundreds of them; they would need their own cell field).
- Triton's cavi near the terminator read a little like a dense crater field; walled plains are not modelled.
- Twin-crescent scale: Triton's terminator relief is sub-pixel there, so it stays nearly smooth (physically right).
- Limb: the 1-3 px teal outline and the ~300 km close-range backlit haze glow from the wave-1 list are untouched.
- Shader budget margin is ~100 ms (692-697 ms in the final runs; earlier runs under heavier load reached ~810).

## Requests to integrator

- None blocking. Optional: the offline FXC harness (`dump.mjs`, `translate.mjs`, `fxc.py`, `fxcint.py`) is in
  `C:\Users\danny\AppData\Local\Temp\claude\C--Users-danny-fun\6f6a9dda-209e-410f-8186-f810075dd4ce\scratchpad\fxc\`
  and could become a `tools/checks/` script: it times FXC on ANGLE's HLSL in seconds and bisects shaders by text edits.
