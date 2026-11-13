# Jupiter piece: Jupiter, Io, Europa, Ganymede, Callisto

Owner files: `src/bodies/jupiter.js`, `src/bodies/jupiter/*`, `assets/jupiter/*`, `assets/{io,europa,ganymede,callisto}/*`.

Helper scripts (all in `assets-src/scripts/`):
- `jupiter_turbulence.py` (2-D Navier-Stokes tracer tile) and `jupiter_turb_post.py` (spectral tilt and encode).
- `jupiter_structure.py` (map-derived turbulence index).
- `jupiter_find.mjs` (GRS framing days and transits for a camera) and `jupiter_shadows.mjs` (every shadow-on-disc interval).
- `jupiter_gputime.mjs` (GPU timer) and `jupiter_moon_phases.mjs`.
- `process_jupiter_moons.py` and `process_europa_equalize.py`.

## Wave 3 (current): the film's disc and the low skim

Film beats in the current cut (re-locate from frames, the cut moves): 228-232 approach, 234-242 disc with Io's shadow
and the GRS, 243-249 low skim toward the terminator (6,800 km up at t = 246), 250-254 departure over the night side.
Before / after: `shots/jupiter/base_t*.png` vs `shots/jupiter/film_t*.png` (`film_sheet.png`).

1. **Limb darkening** (surface.js). The Minnaert k >= 1 fix was already in, but at the film's ~25 deg phase a k ~ 1 deck
   still leaves the sunward limb at ~65-90 % of the disc centre. Added a view-limb term `pow(mu, kV)`,
   kV = (0.40, 0.47, 0.58) RGB (absorbing gas/haze column, steeper in the blue), faded out toward the crescent
   (`smoothstep(-0.1, 0.75, cos phase)`) so the forward-scatter crescent is untouched. Measured on the EZ row at
   phase 25: r = 0.95 is now 37 % of the peak (was 65 %), r = 0.99 about 30 %. The haze shell's on-deck grazing
   in-scatter is capped at 0.62 (was 1.0): the wide blue-grey "frosted rim" is now a thin bluish line.
2. **GRS** (`grsColour`). No drawn ellipse: the outline is the streamline radius pushed in and out by the streamline
   tracer (ragged flakes), the tight log spiral (which read as onion rings) is a loose two-arm spiral broken by the
   tracer, the dark rim is a patchy brick annulus, and the Hollow is asymmetric (brown SEB "eyelid" wrapping the north,
   brightest collar south and east). Streamline-texture weight 0.55 -> 0.78, deeper red / paler cream end-members.
3. **Low skim** (surface.js + detail.js; the two programs share `closeGain` / `closeLam` and must agree).
   - Root cause of "marbled paper": the tanh tracer->colour curve posterised a magnified octave-A tile into two tones,
     and octaves B / C entered only through the curve's slope, i.e. only at blob edges. Now the gain is x0.6 below
     ~14 km/px (the tile's own continuous tones show), the end-member spread is x1.6, and the fine octaves have a slope
     floor (0.15) so swirl interiors carry filaments too.
   - Root cause of the "worms": octave C's very steep gradient fed the relief normal. Octave C now contributes value
     only; mesoscale (octave B) relief has its own amplitude (2.6 km per unit tracer) independent of the colour gain;
     the deck's octave-A relief is x2.2 up close with a soft slope limit (no black hairlines at sharp fronts).
   - Combed zonal streaks at close range: zonal-tile weight x0.3 below 15 km/px (was x0.65).
   - **Cast shadows of the cloud masses** (detail.js): the octave-A height field (soft 20 km footprint, x3.2
     exaggerated) probed at three distances toward the Sun, only when tan(sun elevation) < 1.1 and < 68 km/px,
     q=high only. 4 extra fetches in one non-constant loop.
   - **Skim exposure assist** (`uGain`, jupiter.js): up to x1.75 when the camera is within ~0.2 R of the cloud tops
     over a low sun (pure function of camera position; exactly 1 for every disc / crescent view). Without it the
     skim sits in the tone curve's toe. Set by `shared.uGain`; remove if the director takes over exposure there.
4. **Io's shadow**: checked against geometry, unchanged. At t = 240 the camera is only 194,000 km up, so the scale at
   the disc centre is 132 km/px: Io's 3,640 km umbra + penumbra is 26 px tall and 32 px wide (sun 35 deg off the
   local vertical), which is what is drawn; the penumbra is ~620 km (4-5 px).

Still open after wave 3: see Known gaps. `jdebug=20/21/22` (colour / relief / shadow layers of the detail shell) were
the useful switches for this pass.

## Fix round 2 (third pass): what changed and why (root causes)

1. **Close-range deck: one isotropic tracer everywhere (the structural gap).** Root cause: every belt and zone drew the
   same isotropic Navier-Stokes tile at the same scale. So 50-500 km structure was "paper marbling" everywhere, and the
   zones had no laminar character. Fixes:
   - **A second, physically different tile.** `assets-src/scripts/jupiter_turb_beta.py` solves forced 2-D turbulence on
     a **beta plane** (beta = 160, k_f = 28, 1024^2; spin-up at 256^2, then refined twice).
     - The beta effect makes the flow organise itself into alternating zonal jets. This is the Rhines mechanism, the
       reason Jupiter is banded.
     - Its tracer is long zonal streaks, meandering jets and chevron-like wave trains.
     - Encoded by `jupiter_turb_beta_post.py`: the pure k_x = 0 banding is cut to 12 % so no stripe repeats, k^-0.4
       tilt, 512x1024 at q74 = 50 KB.
   - **Regime from the data.** `chaos` (structure map + intermittency + GRS wake) picks the isotropic tile in the chaotic
     belts and the zonal tile everywhere else, in octaves A, B and C. `jdebug=11` shows r = chaos, g = zonal weight,
     b = GRS.
   - **Steady-state pre-shear** (`flow.js` row 2). Small-scale structure is drawn in a permanently sheared state.
     - Displacement D(y) = integral of age(y) du/dy, with age 3 d in zones and 0.7 d in chaotic belts, and strain capped
       at 4.5.
     - It depends on latitude only. An earlier 2-D mask around the GRS created a compression ripple.
     - Octave B gets half of it (younger eddies), and the relief gradients include the shear term.
   - **Band-limiting.** Octave A subtracts its own ~700 km low-pass everywhere (and the zonal tile's own banding), so the
     tracer never competes with the real map structure. This removed the smeared "pillars" in the GRS wake.
   - **Amplitude.**
     - At map scale the zones are calm (0.2), jet flanks keep their shear streaks, and every region gets texture below
       the map resolution.
     - At close range the local colour spread comes from cloud thickness (up to ~0.6 L), not from the low-passed map.
     - Gaps in the zones get a blue-grey "deeper layer" tint.
   - **Convective cloud tops** (`cumulus()` in surface.js).
     - A dense smooth-union field of bell-shaped domes in three octaves (~156, 52 and 17 km), in a cauliflower
       hierarchy: finer turrets sit on the coarser domes.
     - Irregular outlines, and a 10 h / 5 h / 2.4 h life cycle re-seeded every cycle (deterministic in `uDt`), riding
       the flow.
     - Soft analytic cast shadows from a proxy ellipsoid. Heights are 5-25 km.
     - Coverage = convection index x outbreak intermittency x thick cloud. Bright compact plumes in the map always
       become turret clusters.
   - **Storms.** The old small storm class is gone, because the cumulus field replaces it. The large storms have soft,
     spreading anvils instead of hard "pill" edges.
   - **Octave C** is domain-warped by octave B, so the 290 km tile never shows as a repeat.
2. **GRS as its own vortex model.** Root cause: the background tracer was twisted by a global rotation, so the GRS read
   as a twirl filter.
   - Closed elliptical streamlines. The zonal tile is sampled in (streamline angle, streamline radius), so differential
     rotation only slides each ring along itself: no grooves.
   - A weak 3-arm inward spiral, and a slowly rotating, mottled core.
   - Palette by streamline radius: deep red-orange core offset ESE, salmon body, paler outer annulus, a thin darker brick
     rim (darkest NE) and a bright cream collar. The streamline texture itself perturbs the colour boundaries.
   - Oval BA uses the same model. Fine octaves inside the vortices rotate with them and drop the pre-shear.
3. **Cross-fade grooves.** Root cause: winding grew linearly with the clock phase (up to +-3 d x omega).
   - The vortex clock is now `1.2 tanh(tau / 1.2)`: bounded and monotonic.
   - The GRS interior no longer carries a twisted background, and the circumpolar cyclones use the same bounded clock.
   - Checked at day 1.8715 (mid cross-fade): no rings, no hook.
4. **Crescent and limb haze.**
   - Two haze layers: upper-tropospheric (H = 32 km) and an extended stratospheric layer (H = 80 km, HG g = 0.76,
     omega 0.95/0.93/0.88). Optical depth is steeper toward the blue for small particles.
   - An albedo-independent forward lobe in the deck BRDF (g = 0.55).
   - Crescent peak at phase 150 rose from 131 to 182 (8-bit sRGB), and the lit arc is wider.
   - Polar haze optical depth is halved, so the polar caps and cyclones are not extinguished.
5. **Colour and contrast.** `mapCorrect` adds a 1.22x luminance S-curve around the mean and warms the zones (+4 % R,
   -3.5 % B). Measured on the full disc: luminance std 24.3 -> 30.4, mean saturation 0.166 -> 0.195 (reference 0.185).
6. **Moons.**
   - Europa:
     - `process_europa_v3.py` keeps only orientation-coherent high-pass detail (lineae, ridges) via a structure tensor,
       compresses (never boosts) the local amplitude, and damps the mid band.
     - The disc-scale mosaic seam and the stucco freckle field are gone.
     - Darker-than-average terrain maps to reddish-brown mottled material.
     - Equatorial great-circle arcs are excluded, and the crater density is 4x lower.
   - Io:
     - Paterae are much sparser and fade in only below the map resolution.
     - They have smooth, low-order lobed outlines, a radial floor gradient, diffuse dark-orange halos and occasional
       Pele-type red rings.
     - Sulfur-plains mottling (5-60 km, soft) breaks up the magnified base map, and the frost is softer.
   - Ganymede and Callisto:
     - Crater ages are skewed old (subdued), and relief is reduced at disc scale, where the map already shows the
       craters.
     - Grooves vanish before they drop below about 3 px per wavelength (no moire).

## Fix round 1: what changed and why (root causes)

1. **Close-range deck: the structural gap.**
   - Root cause: the old shader only *warped lookups into a soft map*. That can swirl the map's low frequencies, but it
     creates no new variance, so every close view was an upsampled watercolour.
   - Now: **mean-preserving variance injection**.
     - The full-resolution map sets each pixel's mean.
     - Low-passed map samples at latitude ±1.6° and ±3.2° (smooth soft-min/soft-max) give the local belt/zone hue
       end-members. They are re-centred on the mean, so a uniform belt still gets lighter and darker shades of itself.
     - A real turbulence tracer places the pixel between them through a tanh contrast curve. The curve's bias is solved
       analytically (probit/logistic approximation), so E[colour] = map colour: large scales are exactly the map, and
       chroma survives at every scale.
   - The tracer is a tileable **2-D Navier-Stokes passive-tracer field**, computed offline by a pseudo-spectral solver
     at 1024²: fronts, filaments and vortex roll-ups.
     - It is mapped on a seamless **stretched-Mercator** frame (37→24 tiles around the equator, integer, so no seam).
       The frame is compressed N-S by the local jet shear (1.5-3x), so the streakiness follows du/dy.
     - Over the caps it uses a **polar-stereographic** frame.
     - Octaves: A at 18,700 km, B at 2,340 km (churn clock), C at 290 km (low skim).
     - Evolution: each octave is advected by its own simulated velocity field through a short frozen-field backtrace
       (strain << 1, otherwise it over-filaments).
     - Spectral tilt k^-0.5: cloud albedo is steeper than a Batchelor tracer, so the large swirls dominate whatever
       scale is on screen.
   - **Where** the turbulence goes comes from the real data: `structure.webp` is the local non-zonal RMS of the Cassini
     map. The SEB wake, NEB plumes and chaotic belts get full amplitude; zones stay smooth. The Equatorial Zone is
     boosted.
   - Cloud-top **height**: soft from the tracer, plus cauliflower billows on thick cloud, plus pop-up storms. It drives
     normals, a horizon **self-shadow march** at a grazing sun, analytic **storm cast shadows**, and elevated tops that
     catch the Sun past the deck's terminator (horizon dip sqrt(2H/R) and a thinner gas column).
   - The map's colour is corrected toward the true-colour portrait. PIA07782's zones were blue, because its green
     channel is synthetic from 750/451 nm.
2. **Flow is real advection, not jitter.**
   - Long clock: 6.05 d cycle with a flat-topped partition of unity. Phases rest at days 0.25, 3.275, 6.30, **9.325**,
     ..., and each phase is shown **alone** for ±1.0 d around its rest. Belts stream monotonically with no cross-fade
     in the review window (days 0-1) or the film window (days 9.2-9.5).
   - Churn clock: 0.29 d, detuned from the 0.4135 d spin. Octave B is re-seeded on it.
   - The GRS and Oval BA are excluded from zonal shear. Coherent vortices don't shear, so the flow wraps around them.
     Before this fix the GRS was sheared into a parallelogram within a day.
3. **GRS.**
   - Differential rotation on the bounded clock: rigid core, collar falling off over r = 0.85-1.4. The winding stays
     ≲ 1 rad, so no record grooves.
   - The spiral tracer twist is 1.2 rad.
   - Present-day salmon-brick palette, with an offset deeper-red core and a lower-contrast interior.
4. **Poles.**
   - Zonal advection is faded above about 65°, and the polar tracer is in a stereographic frame, so there are no
     concentric grooves.
   - Blue-grey haze tint.
   - Juno's 8+1 north and 5+1 south cyclones are drawn as explicit logarithmic 2-3-arm spirals with cream cores, spin
     and twist.
5. **Crescent.** The haze shell dominated: at the tangent path it is optically thick and forward-scattering.
   - The haze is now absorbing and brownish (ω = 0.92/0.88/0.80 RGB, Zhang et al. 2013).
   - Low-latitude τ is 0.04.
   - On-deck rays get half the shell in-scatter and 0.6x the optical depth. Off-limb rays keep the full glow.
   - An albedo-proportional HG forward lobe (g = 0.62) in the cloud BRDF keeps band contrast.
   - Result: tan bands visible in the crescent, with a thin bright limb.
6. **Lightning.** 6 storm cells, each with a 16 % duty cycle, multi-stroke bursts, and a 300-900 km Gaussian glow.
   It is suppressed when the glow is under about 3 px.
7. **Moons** (`moon-detail.js` rewritten, all features footprint-filtered).
   - **Impact craters** (Ganymede, Callisto, and sparse ones on Europa):
     - power-law size-frequency distribution, one octave per halving of size;
     - per-crater age-driven depth and rim degradation, ellipticity and slight polygonal wobble;
     - flat floors plus central peaks or **central pits**;
     - young bright ejecta and rays.
   - **Ganymede** grooves: Voronoi swaths, each with its own orientation and spacing (6-13 km), with coarser lanes.
   - **Europa**:
     - 48 global great-circle and cycloid lineae with **double-ridge profiles** (two crests, a dark trough, reddish
       margins), across cross-cutting generations, plus three octaves of local ridge sets;
     - chaos plates in the mottled terrain;
     - almost no craters, and the map's blotches are softened up close.
   - **Io** (no impact craters):
     - sparse irregular **paterae** below the map's 5.6 km/px resolution, with black, greenish or grey floors and
       halos;
     - white SO2 frost (fwidth-anti-aliased) and a few massifs;
     - USGS hue shifted from green toward yellow-orange.
   - **Tiny discs** under about 3 px output the analytic disc-averaged brightness (Lambert phase law × mean albedo),
     so MSAA gives a soft, stable dot.
8. **GRS longitude** (cross-piece fix). `src/journey/film.js` searches the film clock assuming the GRS at body
   longitude -48.2°, but it was drawn at +103.1° E. `uLonOff` is now 0, so the GRS **is** at -48.2° E
   (exported as `GRS_BODY` from `src/bodies/jupiter.js`). The film's Io-shadow hold (t ≈ 243-252 s) now shows the GRS
   beside Io's shadow.

## Best shot commands
```bash
# full disc (round-3 reference set: shots/jupiter/final3/)
node tools/shot.mjs --q "view=body&body=jupiter&dist=3.5&phase=20&el=5&days=0.2175" --hud 0 --out shots/jupiter/final3/full.png
# GRS (centred for phase 25 / el -15 at days 0.2175, 0.631, ... every 0.4135); close: dist 1.2, el -18, fov 40
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.6&phase=25&el=-15&days=0.2175" --hud 0 --out shots/jupiter/final3/grs.png
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.2&phase=25&el=-18&days=0.2175&fov=40" --hud 0 --out shots/jupiter/final3/grs12.png
# low skims: required (EZ), over the NEB, and the horizon with the haze layers
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.08&phase=40&el=0&fov=60&look=0,-20" --hud 0 --out shots/jupiter/final3/skim.png
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.08&phase=55&el=10&fov=60&look=0,-10&days=0.1" --hud 0 --out shots/jupiter/final3/skim_neb.png
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.08&phase=70&el=5&fov=60&look=0,58" --hud 0 --out shots/jupiter/final3/horizon.png
# Io's shadow + GRS (the film's beat); Europa's shadow
node tools/shot.mjs --q "view=body&body=jupiter&dist=3.5&phase=20&el=5&days=2.25" --hud 0 --out shots/jupiter/final3/transit_io.png
node tools/shot.mjs --q "view=body&body=jupiter&dist=3.5&phase=20&el=5&days=0.252" --hud 0 --out shots/jupiter/final3/transit_europa.png
# mid cross-fade (robustness): no grooves
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.6&phase=25&el=-15&days=1.8715" --hud 0 --out shots/jupiter/final3/xfade.png
# the film's skim and departure
node tools/shot.mjs --t 243,256,262,267 --hud 0 --out shots/jupiter/final3/film_t{t}.png
# poles (dark at equinox: exposure 3 shows the cyclones on the lit side)
node tools/shot.mjs --q "view=body&body=jupiter&dist=1.6&phase=30&el=70&fov=45&exposure=3" --hud 0 --out shots/jupiter/final3/pole.png
```
Append `&only=jupiter` for fast isolated runs. Development switch, read only by this module:
- `jdebug=1` the tracer contrast T, `2` the mean position m, `3` the tracer, `4` amplitude/gain/sigma, `5` detail
  fades, `6` palette, `7` height, `10` the corrected map mean x Lambert, `11` regime (chaos / zonal tile / GRS);
- `jdebug=9` hides the haze shell.

Contact sheets: `shots/jupiter/final3/r3_05_flow_sheet.png` (flow, days 0-0.15) and `r3_06_moons_sheet.png`.

## Shadow transits (default epoch 2026-11-02T12:00:00Z; `days=` offsets)
These are the intervals with the shadow centre on the disc, from `node assets-src/scripts/jupiter_shadows.mjs 0 14`.
The phase 20 / el 5 camera sees them all.

| moon | windows | GRS at mid (phase 20 el 5, from the CM, + = east) |
| --- | --- | --- |
| Io | 0.429-0.525, **2.198-2.294**, 3.967-4.063, 5.736-5.832, 7.505-7.601, **9.274-9.370**, 11.044-11.140 | 0.481: -126; **2.250: -26 (on the disc)**; 4.019: +74 |
| Europa | **0.186-0.307**, 3.737-3.858, 7.288-7.409, 10.840-10.960 | **0.252: +34 (on the disc)** |
| Ganymede | 1.529-1.681, 8.684-8.836 | 1.611: +137 |
| Callisto | 5.232-5.433 (large soft penumbra) | 5.341: +145 |

The film's Jupiter hold currently runs at days 9.22-9.47, which covers Io's 9.274-9.370 transit. That lies inside the
long clock's rest window (phase B rests at 9.325), so there is no cross-fade during the hold.

## Performance (RTX 4090, 1600x900, only=jupiter, GPU timer p10, whole frame; round 3)
| view | GPU time |
| --- | --- |
| required skim at 1.08 R (EZ, cumulus field) | ~1.7 ms (median 2.6 with other agents on the GPU) |
| GRS close-up at 1.6 R | ~0.45 ms |
| GRS interior at 1.03 R | ~0.9 ms |
| skim horizon at 1.08 R | ~1.0 ms |
| full disc | ~0.74 ms |

Cost control:
- At most one long-clock phase is evaluated outside the cross-fade windows.
- Octave B and C fetches run only when resolvable. The zonal tile is fetched only where its weight is > 0.
- The cumulus field runs only below 40 km/px, and only where coverage is > 1 %.
- `q=med` drops octave C and the self-shadow. `q=low` also drops octave B, the cumulus and the storms.

Jupiter assets total 388 KB (budget 400 KB), of which turb_z.webp is 50 KB.

## Known gaps
- Wave 3: the skim's depth is still albedo + shading, not parallax; no volumetric towers. The film's skim never gets
  the Sun below ~20 deg while close, so cast shadows stay short (a few px): a lower pass along the terminator would
  show them. Close-up GRS (dist 1.6) is soft / wood-grained; only the disc-scale spot was reworked.
- The required skim (dist 1.08, el 0) looks into the bright EZ/NEZ at midday. It is now textured cloud (streaks, turrets,
  blue-grey gaps), but still a low-contrast cream field, as the real EZ is. The NEB and SEB skims are much stronger.
- Festoons and hot spots are still the map's own (sharpened by the tracer). There is no procedural system with
  SW-trailing plumes.
- No height-field parallax. At grazing angles the cloud tops are shaded (normals, cast shadows) but not displaced.
- The crescent is brighter and wider, but at phase 150 the haze ring off the limb is still thin (about 2 px).
- Polar cyclones are visible only near the lit side, at exposure 3 (near-equinox geometry).
- Europa at 1.15 R: the procedural lineae are straight great-circle sets, with no variety of triple-band or cycloid
  profiles yet. Io's sulfur mottling at 1.15 R still shows a little "camouflage" patchiness.
- No visible rings, and no Io plumes.

## Requests to integrator / director
- Wave 3: the skim (t = 243-249) would be far stronger if it ran closer to the terminator (sun 5-12 deg up at the
  look-at point) and/or with +0.5 EV; the body now applies its own x1.0-1.75 assist there (`uGain`), tell me to drop
  it if the director sets exposure for that beat.
- `src/journey/film.js` hard-codes the GRS at body longitude -48.2°. That is now correct. Prefer importing
  `GRS_BODY` from `src/bodies/jupiter.js` so the two can't drift apart again.
- If the Jupiter clock search moves the hold outside about days 8.3-10.3, check the long-clock rest table above. Rests
  are at 0.25 + k·3.025; ±1.0 d around a rest is free of cross-fades.
