# post — HDR target, bloom, sun lens system, tonemap, warp, letterbox/fade

Files: `src/render/post.js` (entry, pipeline, CPU-side sun/warp/grade logic), `src/render/post/shaders.js` (all
GLSL), `src/render/post/psf.js` (pupil + FFT for the diffraction starburst).

## Wave 2 (this round)

Shots in `shots/post/w2/` (`final/` holds the before/after pairs named below). The director re-cut the film several
times during the round (441.5 -> 434 s); film times below are from the cut at the end of the round. Find beats by
chapter/focus with a coarse sweep (`--t 0:434:2 --w 320 --h 180`), not by these numbers alone.

1. **The ghost chain no longer reads as a plugin** (board #2). Root cause: nine copies of one grey heptagon, all
   with filled interiors, all visible all the time. Now (`GHOSTS` in post.js, `ghosts()` in shaders.js):
   - **Five ghosts**, one per reflecting pair: a small, crisp green near-focus reflection point-mirrored through
     the centre (k -0.93), a violet-magenta stop polygon (k -0.4), a round cyan-green element-edge ghost (k 0.47),
     a large amber annulus (k -1.3), and a huge, faint blue-violet lune near the centre (k 0.08).
   - **Rim-dominant profile**: an exponential caustic rises to a crisp edge, anti-aliased over about 1.5 px. The
     interior sits at 4-8 % of the rim in linear light, about 15 % in display (measured at t=88: 14/255 inside,
     92/255 on the rim). The interior is faintly mottled, and rim brightness varies around the circumference.
   - **A coating hue per ghost** (saturation about 0.3-0.45, unit luminance), drifting a little with the angle
     of incidence. Dispersion is cut to 0.6-2 % (red outside, blue inside), so there is no 1-px rainbow outline.
   - **Shape**: stop images (poly 1) differ from element-edge ghosts (round). Inverted images (k < 0) are the
     stop's point reflection, so they are rotated by pi (for 7 blades, a visibly different orientation), plus a
     small per-ghost jitter.
   - **Field windows**: each ghost path is vignetted over part of the field, so ghosts fade in and out as the sun
     moves. For example, the cyan round ghost appears only within 0.85 fh of the centre, and the amber annulus
     only beyond 0.35 fh. A shot shows 2-4 ghosts, and a different set in each shot.
   - Intensity stays linear in sun flux x probe visibility x exposure. Pushed night-side exposures ghost more,
     and the hero Sun does not ghost at all. Overall gain is 0.85 (was 1.3 on a much fuller profile).
   Before/after: `final/before_glare150.png` vs `final/glare150.png`. In the film: `final/venus_crescent_t88.png`
   (Venus's night disc stays clean, with no ghost on it) and `final/triton_t388.png`.
2. **The warp radial blur is now an exact integral** (board #1). Root cause: pass 1 jittered its 16 taps per pixel
   (interleaved-gradient noise), and pass 2 box-filtered one tap gap. With per-pixel jitter, the box no longer swept
   each tap across thin line art exactly once, so 1-px orbit lines and ring edges broke into hatching and moire,
   and the per-channel R/B split taps added rainbow fringes. Now (WARP in shaders.js):
   - Both passes step **evenly in one radial coordinate** along each ray from the focus. That coordinate is ln r,
     continued linearly beyond `WARP_R0` = 1.2 frame heights, so a focus far outside the frame gives parallel
     streaks of capped length. Pass 1 is a 16-tooth tapered comb. Pass 2 is a tent exactly two teeth wide (`uN2`
     taps about 0.8 px apart, scaled with resolution), which is linear interpolation between the teeth. The
     result is one smooth trail, with **no jitter at all**.
   - The R/B dispersion applies only to **point-like** taps, meaning a neighbour 2 px across the trail is darker
     than the tap. A line crossing the trail, or diffuse light, keeps one position for all channels.
   - The destination's point of light keeps its no-warp profile. Three changes do this: at the focus of expansion
     (trail under about 1-2 px) the unresampled image is used; the barrel resample is **Catmull-Rom** (5 fetches,
     with the CA shifts applied as bilinear differences); and the +70 % warp bloom is confined to the periphery.
     At t=220 the point measures 10 px FWHM, the same as with postWarp=0 and postDebug=raw, i.e. the glint's own
     size.
   Before/after on the finale orbit lines: `final/before_warp_orbit_x2.png` vs `final/after_warp_orbit_x2.png`.
3. **After-post overlay layer** (cross-piece). `OVERLAY_LAYER = 31` is exported from post.js and also available as
   `post.overlayLayer`. Any Mesh, Line, Points or Sprite whose only layer is 31 (`line.layers.set(31)`) is skipped
   by the scene render. It is drawn with the same camera into a 4x MSAA HDR target, which the composite **adds**
   after the optics: no warp streaks, bloom, flare, ghosts, CA or vignette. It stays registered with the warp
   barrel, and it goes through the same exposure, tone curve, fade and letterbox, so line art looks as it does in
   the scene, only clean. It is additive only (no occlusion). Objects are found by a scene scan at start-up (and
   every 256 frames), and each is drawn once at create() so its program is compiled. Test hook: `postOv=orbits`
   puts the director's `director-orbits` lines on the layer. Compare `final/overlay_forcedwarp.png` (t=404,
   postWarp=1: crisp ellipses, streaking stars) with `final/no_overlay_forcedwarp.png` (smooth ribbons, no moire).
   It is a drop-in: at t=404 without warp, the overlay lines differ from the in-scene lines by a mean of 0.09/255
   (only CA and vignette at the line pixels).
4. **Hero-Sun reveal** (board #4). In the current cut, the director's exposure look-ahead brings the exposure down
   before the limb enters. The hero weight ramps from 0 to 1 over t=10.0-10.75 while the Sun is still 5 -> 2.4 deg
   outside the frame. The disc enters at t=11.2 already filtered, and the corona fades up with the exposure. The
   disc centre (sRGB) from t=11.75 on is (243-245, 168-174, 15-18), stable through the skim. See
   `final/hero_reveal_strip.png` (t=9.5-13 every 0.25 s). No post change was needed; the weight still follows the
   exposure track (see Known gaps).
5. **Compile cost**: the sun probe (both modes), both warp passes and every overlay object are drawn once at
   create() into 1x1 targets. Bloom and the composite run on frame 1 and switch terms by uniforms only (no define
   changes). With `node tools/checks/perf_probe.mjs --q warm=1 --t 12,48,78,105,136,177,210,234,282,345,372,395,401`,
   the cold frame after a seek is 8-53 ms everywhere (budget 80); see `shots/post/w2/perf_probe.txt`.

## History (wave 1, critique rounds 1-3, condensed)

Round 1: the probe reference got a 32F depth texture (z-fighting sun shells had tinted every low-orbit flare
teal); the starburst became the lens's real Fraunhofer PSF (psf.js); grade hooks (`shot.grade`). Round 2: the hero
Sun became a radially graded, solar-filtered composite keyed to the disc's over-exposure (not its size); glare was
convolved with the disc; an irregular iris; the warp edge fringe and the purple bar beside the Sun were fixed; a
Voyager-style beam for the pale blue dot; image-based ghosts (dormant, see gaps).

## What exists

Pipeline per frame (all full-screen triangles, RawShaderMaterial / GLSL ES 3.00):

1. **Scene → HDR**: RGBA16F, 4× MSAA, 32F depth texture, reversed depth (renderer flag from main.js; the target is
   cleared to depth 0 by three). `post.target` / `post.depthTexture` are exposed for anyone who needs them.
2. **Flux-calibrated sun probe** (the key trick). A 32×32 MSAA *reference* render of only `bodies.sun.object`
   through the same projection (a `setViewOffset` window around the disc, 1:1 with scene pixels for discs up to
   ~10 px radius). Per pixel `min(scene, ref)` is the sunlight that actually reached the lens through whatever is
   in front: planet limbs, **atmospheres (the flare reddens and dims as the sun sets behind Earth's limb)**,
   rings, asteroids. Off-screen window pixels fall back to the analytic `sun.visible`. Both 32×32 results are
   mip-reduced on the GPU (no readback, no stall); the composite reads the 1×1 mip → visible fraction per RGB
   channel and the **centroid** of the light that got through (the starburst moves to the visible sliver of a
   partly occluded sun). During the reference render `U.uResolution` is set to the window size so the sun's
   screen-space far-field point sprite renders at the same pixel size.
3. **Bloom**: 7-level pyramid from half res. Prefilter = NaN/Inf guard + hue-preserving soft clamp at
   `40/exposure` + 13-tap filter with **Karis average** (no firefly flicker from sub-pixel stars). 13-tap
   downsample, 3×3 tent upsample with per-octave weights forming a long-tailed lens PSF. Energy-conserving mix
   `mix(hdr, bloom, 0.035)`. The sun's own wide glare is analytic (below), so it continues smoothly off-frame.
4. **Sun lens system** (analytic, frame-height units, intensity = sun flux × probe visibility, exposure applies):
   - aureole + glare skirt + veiling glare: the PSF tail `exp` + two `(1+(r/r0)²)^-1.5` terms (energy fractions
     0.55 %, 1.3 %, 0.5 %), measured from the disc edge so an extended disc stays right;
   - **diffraction starburst** = the Fraunhofer PSF of the 7-blade pupil (psf.js + SPECTRAL pass, see above):
     14 spikes, spectral smear (red tips), dust/scratch structure, disc-convolved by mip level; orientation fixed
     to the camera with a subtle drift with camera roll;
   - **5 aperture ghosts** along the axis through the frame centre (wave 2, above): rim-dominant caustics, a
     coating hue each, stop polygons (inverted ones rotated by pi) and round element-edge ghosts, per-ghost field
     windows, slight dispersion, and **cat's-eye vignetting** (cut by a second circle sliding along the axis as
     the sun goes off-axis);
   - faint blue anamorphic streak (own fade: 0-3 deg outside the frame);
   - **off-frame behaviour**: everything is driven by the angle by which the sun is outside the frame — starburst
     fades over 0–14°, ghosts 3–30°, glare 5–45°, plus a broad "barrel flare" haze on that side for a sun just
     outside the frame (0.5–40°), streak 0–3°. No flare when occluded (visibility 0), behind the camera, or for
     a disc > ~2.6° (then the bloom alone is right).
5. **Warp** (`shot.warp`): radial speed blur toward the focus of expansion (travel direction from
   `director.evaluate(t±0.04)`, pure, so stills match playback): 16-tooth comb x tent, evenly stepped in
   log-radius (exact, no jitter; mean + capped power mean for bright sources, R/B split on point-like taps only,
   sun masked, mirrored taps at the frame edge), sharp original at the focus, FOE glow, slight barrel distortion
   (corners fixed, centre magnified, Catmull-Rom resample), CA x2.5, exposure +12 %, bloom +70 % in the periphery
   only, vignette +0.2.
6. **Overlay** (`OVERLAY_LAYER` objects, only while any is visible): see wave 2 item 3.
7. **Composite**: lateral CA (R/B radial scale ±0.0012·r²), natural cos⁴ vignetting (32 % strength), overlay,
   exposure (`shot.exposure`), **AgX** (Rec.2020 inset/outset, Filament/three constants) with a fitted contrast
   look (log2 window [-10.25, +2.25]: white Lambertian at unit irradiance → 0.88 display, 18 % grey → 0.53,
   smooth path to white), saturation 1.04, optional punch/contrast/hue-preservation/EV (grade hooks), the
   **hero-Sun composite** (radially graded disc exposure + solar filter + per-channel tone, round 3), gentle grade (cooler deep shadows, warmer highlights, black stays
   black), film grain (deterministic from `t`, two-pixel correlated, mid-tone weighted so space stays clean),
   **TPDF ±1 LSB dither** from an R2 low-discrepancy sequence (no banding in dark gradients), fade, 2.39:1
   letterbox with an anti-aliased 1-px edge, true-black bars.

Fade: `exposure × (1-fade)^0.6` (highlights linger like an optical fade) and display × `(1-fade)^0.8` (reaches 0 at
fade = 1. Letterbox: bar height eased with smoothstep(letterbox).

## Cost

GPU timer queries (`postPerf=1`, RTX 4090, 1600x900, shared with other agents):
- Sun on screen with probe, full lens system and PSF starburst: **post = 0.08-0.09 ms**.
- Warp and letterbox forced on: **0.37 ms** (budget 1.5 ms).

The overlay costs one extra MSAA draw of its own objects, and only while they are visible. Its 46 MB target is
allocated only when the scene holds overlay objects.

Start-up: pupil + FFT (1024^2) takes about 80-130 ms on the CPU, once. The spectral pass, mips and the program
warm-up draws take under 1 ms on the GPU.

The required perf run (`--q "view=body&body=earth&dist=3&phase=150" --perf 4`) gives 4.27 ms/frame avg (234 fps),
p95 4.3 ms. Cold-frame hitches of 1-14 s show up when seeking a cold profile straight to t=400 without `warm=1`.
They are scene shaders compiling in a pooled profile whose cache misses them: they do not depend on any post
override, and they disappear with `warm=1`.

## Best shots

```bash
node tools/shot.mjs --q "view=body&body=earth&dist=3&phase=150&el=4&fov=45" --hud 0 --out shots/post/w2/final/glare150.png   # 1 AU starburst, rim-dominant coloured ghosts (cyan arc on the limb, violet polygon, green dot)
node tools/shot.mjs --t 88,126,370,388 --hud 0 --out "shots/post/w2/film/c_{t}.png"           # Venus crescent (clean night disc), sunrise over Earth's limb, Neptune / Triton twin crescents with the Sun in frame
node tools/shot.mjs --t 220,162 --hud 0 --out "shots/post/w2/warp/e_{t}.png"                  # warp legs: smooth tapered streaks, destination crisp at the focus
node tools/shot.mjs --t 404 --hud 0 --q "postOv=orbits&postWarp=1" --out shots/post/w2/warp/govw_404.png   # overlay: orbit lines stay clean under a forced warp (drop the postOv to see the smooth, moire-free ribbons)
node tools/shot.mjs --t 9.5:13:0.25 --w 800 --h 450 --hud 0 --q "postLog=1" --sheet shots/post/w2/hero/strip.png --cols 5   # hero-Sun reveal: enters filtered, corona fades up
node tools/shot.mjs --q "view=body&body=earth&dist=3&phase=150&postPerf=1&postWarp=1&postLetterbox=1" --perf 12  # prints "[app] post gpu ms"
```

Other required views:
- Limb occlusion: `view=body&body=earth&dist=1.04&phase=105.8&el=0&fov=50&aim=sun` (a red, dimmed starburst as
  the sun sets through the limb). The required `phase=176` view (no aim) is a correct black frame, with the sun
  deep behind the planet.
- Sun in a corner: `view=body&body=mercury&dist=3&phase=120&el=6&fov=50&look=-12,4` (the sun is about 8 deg
  outside the frame: glare from the left and one faint polygon rim).
- Banding: `view=body&body=neptune&dist=3&phase=60&exposure=1`. It is smooth at 8x gain
  (`final/neptune_band_x8.png`).
- Letterbox/fade: `view=body&body=earth&dist=2.2&phase=40&el=8&fov=40&postFade=0.5&postLetterbox=1` gives 230 black
  rows, 1600x670 = 2.388:1.

Test overrides (URL): `postWarp=<0..1>`, `postFade=<0..1>`, `postLetterbox=<0..1>`, `postFlare=<gain>`,
`postDebug=bloom|flare|vis|raw` (raw also hides the overlay), `postLog=1`, `postPerf=1`, `postProbe=1`,
`postPick=x,y;...` (linear HDR at screen pixels, y down), `postIG=0`, `postOv=orbits`.

Optional shot fields:
- `shot.flare`: multiplier on the whole sun lens system (default 1); it also shortens the starburst envelope.
- `shot.grade` = `{ saturation, shadowTint, warmth, contrast, hue, punch, filter, ev, hero }`, any subset. `hero`
  (0..1) overrides the automatic hero-Sun weight, and `filter` the solar-filter mix.

## Known gaps

- **The hero weight still follows the exposure track.** It fades in over a 4-stop window of the disc's
  over-exposure (ev 7.5 -> 3.5), which is about 1 s at the director's 4.5 EV/s ramp. Today it happens off-frame.
  If a re-cut lets the disc enter while the exposure is still falling, the white-to-orange change would show
  again. `shot.grade.hero` can author it directly.
- **Veiling-glare consistency** (wave-1 board #3, routed to the integration VFX pass): a sun just outside the frame
  still lifts the near edge through the barrel-flare haze (`BARREL_A`), e.g. the Triton frames t=380-386.
- The image-based ghosts are dormant: no non-solar source in the film exceeds 2x white after exposure.
- A 1-degree disc near Mercury gets only faint, wide spikes (the PSF is convolved with the disc).
- MSAA is resolved before tonemapping (WebGL2 cannot sample multisample textures), so very bright edges resolve
  slightly fat.
- The PSF spans about 145 Airy radii (1024^2 FFT). Probe windows larger than 32 px are sampled at reduced
  resolution.
- The overlay is additive light only (no occlusion and no depth test against the scene). That suits orbit lines
  and markers, not labels with backgrounds (the HUD owns those).

## Requests to integrator / other pieces

- **director**: to keep orbit lines (or any line art or marker, e.g. the destination glint) clean through warp,
  bloom and flare, call `line.layers.set(31)` (or import `OVERLAY_LAYER` from `src/render/post.js`) on each
  `director-orbits` line and keep them under `world`. No tuning change is needed, because the overlay goes through
  the same exposure and tone curve. Verify with `postOv=orbits` today. The current cut fades the orbits in only
  after the finale warp, which also avoids the problem.
- **asteroids**: the bright elliptical dust ring around the finale Sun (visible with `postDebug=raw` at t=404)
  leaves two dark lobes beside the Sun inside the glare. It is scene content.
- **sun**: please expose `discRadiance: [r, g, b]`. Post uses the constants (4059, 2841, 1461).
- **uranus / venus** (cross-piece report): with the ghost rework there are no large hexagons in the Uranus crescent
  (`dist=4&phase=140&el=0`: one faint polygon rim) or on Venus's night disc (t=88). With the Sun hidden
  (`dist=3&phase=170&el=4&fov=40`), post draws no streak (visibility 0, flare off). A streak seen there would be
  scene content.
- Seen during this round, not post (other pieces were mid-edit at times): `mercury/shaders.js` missing
  `MERCURY_VERT`; `neptune/globe.js` missing `makeGlobeMaterial`; a `worleyD` overload error in a ShaderMaterial;
  director `legAim is not defined`. All were transient.
