# Mercury — notes

Owner files: `src/bodies/mercury.js`, `src/bodies/mercury/shaders.js`, `assets/mercury/*`,
asset script `assets-src/scripts/mercury_assets.py` (section "Mercury piece" in `assets-src/SOURCES.md`).

## What exists (round 3)

- **Data base layer** (USGS MESSENGER rasters, `mercury_assets.py`; 1.20 MB total, unchanged this round):
  `albedo.webp` 2048x1024 (MD3 mosaic de-stretched to relative normal albedo), `tint.webp` 512x256 lossless,
  `dem.webp` 1664x832 lossless (USGS DEM v2 as cubic B-spline coefficients, 8-bit, ~99 m steps),
  `density.webp`, `detail.webp` (512² tileable high-pass of the 665 m/px mosaic).
- **Exact DEM (new).** The 4-bilinear-tap B-spline trick ran through the texture unit's 8-bit sub-texel weights, so the
  DEM moved in 1/256-texel (~35 m) steps of a few metres; a grazing Sun turned those into the blocky stair-steps along
  shadow edges. `mercury.js` now builds, once at load on the GPU, a packed RGBA8 copy of the DEM (each texel = the 2x2
  block of coefficients), and `bsplineDem()` evaluates the B-spline from 4 `texelFetch` in full float precision
  (same fetch count as before). Used everywhere at LOD <= 0 (vertex displacement, march, normals, shadows).
- **Terrain shadows rewritten (`demShadow`).**
  - Penumbra = visible fraction of the true solar disc above the horizon (`discAbove`, alpha 0.6-0.9 deg from
    Mercury), not a 45 % contracted smoothstep. Shadow tips at a 2-5 deg Sun are therefore long and soft (physics:
    penumbra length / umbra length = 2 alpha / elevation), lateral edges stay crisp.
  - Near field (3 footprints .. 4 km, Sun < 11 deg): the exact DEM at each sample (DEM crater rims shadow the floors
    behind them), procedural craters as the receiver's tangent plane, and the regolith roughness band-limited to what
    the sample spacing resolves (coarser octaves enter through their gradient, finer ones as their expected maximum).
    Hummocks now cast real little shadows at a low Sun.
  - Far field (4-90 km, cut at the height Mercury's relief can reach for the current elevation): exact DEM at all 13
    samples (no mip blur), then the **crest roughness**: the visible micro-relief noise evaluated where the ray grazes
    the crest (parabolic refinement of the crest distance, continuous in the receiver position), so DEM shadows get
    lumpy/serrated outlines with fingers along the light instead of smooth ink-blot outlines.
  - Receiver and occluders always on the same exact DEM (a mip-blurred receiver shadowed its own peaks: this was the
    source of the black specks on the full-phase limb).
  - The old "bowl artefact" is gone (procedural crater floors compared against DEM-level occluders, which blackened
    every procedural crater near the terminator regardless of its depth).
- **Fill light (new).** Single-bounce light from lit surroundings: albedo x cosine of the sun-facing walls/slopes x view
  factor (1.5 % base, receiver tilt, enclosure by its crater's walls, DEM depressions), reduced inside terrain-scale
  shadows. Open-terrain shadows get ~1 % of the lit flats, crater floors beside a lit wall a few %: shadow floors read
  as terrain, not dead 0.
- **Per-crater shadows**: full-depth geometry faded in by the LOD weight (a crater too small to resolve still darkens its
  pixels); the receiver's roughness finer than the crater pokes out of / sinks into the shadow (ragged edges); while a
  crater spans < ~4 px its shadow becomes the pixel-averaged soft dark disc (no aliased ring outlines); exterior rim
  shadow reaches the edge of the crater's influence (1.75 r). Analytic profile derivative (was 3 evaluations).
- **Crater lattice fixes**: rim-radius limit 0.24 -> 0.218 cell (with the rim harmonics, influence <= 0.433 cell, the
  least tangential distance of a centre outside the 2x2x2 block): no more straight seams cutting craters. Cached block
  lists use the acceptance at the block centre (every ray gets the same list: no ray-dependent discontinuities in the
  march). Crater albedo pattern (walls, floors, crest) fades in only when the crater is several pixels wide; terraces
  fade in with the footprint. Degraded population joins ~1.5 octaves after the fresh one (perf). Small craters
  (octave >= 3) cluster: own per-octave clumping noise (secondary fields / gaps instead of an even sprinkle).
- **Roughness**: slope amplitude 0.034/0.026 -> 0.046/0.04 per octave (RMS slopes ~6-8 deg, MLA-like); the same noise
  drives normals, receiver height, near-field occluders and crest roughness.
- **Albedo**: shader unsharp mask of the mosaic near its own resolution (whole-disc views), detail-tile weight 1.4,
  mature-wall brightening 0.5 (crisper high-Sun views).
- **Grazing views**: shading footprint never below 0.55 x the long axis of the footprint ellipse (was 0.35: isotropic
  detail aliased along the stretched axis into horizontal streaks); march geometric footprint stretch cap 2 -> 4.5;
  skyline alpha is now analytic coverage blended over the sky (CustomBlending, opaque order, depth still written)
  instead of 4-level alpha-to-coverage; the closest-approach clearance is refined by a parabola (no pixel jitter of
  the skyline alpha); skyline pixels shade with a 3x footprint (no speckle band).

## Best shots

```bash
node tools/shot.mjs --q "view=body&body=mercury&dist=1.06&phase=88&el=2&fov=60&look=0,-18" --hud 0 --out shots/mercury/low.png
node tools/shot.mjs --q "view=body&body=mercury&dist=1.02&phase=85&el=0&fov=60&look=0,72" --hud 0 --out shots/mercury/horizon.png   # skyline relief
node tools/shot.mjs --q "view=body&body=mercury&dist=1.004&phase=84&el=0&fov=60&look=0,-30" --hud 0 --out shots/mercury/ultralow.png
node tools/shot.mjs --q "view=body&body=mercury&dist=3&phase=85&el=8" --hud 0 --out shots/mercury/half.png
node tools/shot.mjs --q "view=body&body=mercury&dist=1.1&phase=25&el=5&fov=40&look=0,-10" --hud 0 --out shots/mercury/highsun.png
node tools/shot.mjs --t 58,60,62 --hud 0 --out shots/mercury/film_{t}.png
```
Add `&only=mercury` for fast isolated runs. Debug: `&mdebug=1` sun visibility, `17` near-field terrain shadow only,
`18` far-field only, `19` crater shadows only, `15` march step bands, `2` normals, `3` albedo, `5` sun-elevation bands,
`6` unlit relief, `7` tint, `8` DEM-only normals; `&mskip=<bits>` timing switches (1 craters, 2 rayed craters,
4 micro-relief, 8 detail tile, 16 terrain shadow, 64 far roughness, 128 near field, 256 crater shadows,
512 young-crater albedo); `&mrelief=<R>`, `&moct=`, `&mstep=`, `&mfpg=` (march footprint cap), `&mfpl=` (footprint
long-axis fraction), `&mgain=`, `&mfp=`, `&mwall=`, `&mtile=`.

## Performance (RTX 4090 shared with many agents, 1600x900, whole frame with fallback post/sky, min of ~120 frames)

low pass 3.2 ms, very low 3.4 ms, horizon 3.2 ms, film t=62 3.0 ms (mercury + director), half disc 0.6 ms. Terrain
shadows ~0.3 ms, crater field ~1.4 ms, march pre-pass ~1.1 ms. Over the 3 ms target by ~0.1-0.4 ms in the extreme
close views (the round-2 figures were 2.5-2.9 on the same machine); `q=med` (render scale + detail LOD bias 1.6): low
pass 2.0 ms, very low 2.7 ms.
Timer: a scratch copy of `assets-src/scripts/jupiter_gputime.mjs` that interleaves queries, takes the min of ~120
frames, and seeks the journey for `T=<s>` (journey frames need `only=mercury,director`).

## Known gaps

- Far-field occluders carry no procedural craters (tried: 2 ms and aliased into ghost rims at the 13-sample spacing);
  their serration comes from the crest roughness only. A min-max DEM pyramid would allow denser crest sampling cheaply.
- Interior depth discontinuities at grazing angles (a near ridge in front of far terrain) are not anti-aliased (only the
  skyline is); the far terrain is smoother now but a horizon pan still shows some row structure.
- No lobate scarps / wrinkle ridges beyond what the DEM resolves; no secondary-crater chains radial to rayed craters
  (only clumping); no synthesized ray filaments around the known big rayed craters at close range.
- Photometry unchanged (Lunar-Lambert + surge fitted to Mallama 2002); no Hapke macroscopic-roughness term.
- Close high-Sun views still show the low-frequency mottling of the 7.5 km/px base map (now with crisper tile texture).

## Notes / requests to integrator

- Mercury's `update()` renders its own march pre-pass (private float target sized from `U.uResolution`, clear colour
  saved and restored). If post ever renders the scene at a different resolution than `U.uResolution`, the shading
  pass would read the wrong texel — please keep that invariant or tell me.
- At load, `create()` renders once into a private RGBA8 target (the packed DEM); render target restored afterwards.
- The relief shell now uses CustomBlending (SrcAlpha / OneMinusSrcAlpha) in the opaque pass for its skyline coverage;
  it assumes the sky is drawn before it (renderOrder -1000, as in the contract).
