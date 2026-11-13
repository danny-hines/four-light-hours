# Venus — builder notes

Owner files: `src/bodies/venus.js`, `src/bodies/venus/{common,deck,haze,bake,noise-grad}.js`. No assets on disk
(fully procedural; the planetary fields are baked on the CPU at load, ~0.2 s). No external data downloaded.

## Wave 3 (film pass: day-disc structure, the crescent)
Before / after film frames: `shots/venus/before_after.png` (left HEAD, right now; t = 76, 80, 84, 88, 90), final frames
`shots/venus/final/film_t*.png`, baseline `shots/venus/base/`.
- **Day disc was a flat putty wall** (t 76-82). (a) `bake.js`: the coarse streak fields gained **spiral wave trains**
  `cos(m lon + s g(|lat|) + phase)` with integer zonal wavenumbers (3, 5, 8, 13; seamless), phases bent and amplitudes
  broken by low-frequency noise, blended in poleward of ~15 deg: streaks now trail poleward-westward at 15-30 deg to the
  latitude circles in both hemispheres (the Mariner 10 chevron). Noise stretched along latitude circles cannot tilt.
  (b) `deck.js`: domain warp of the fine octaves x0.3 (`uWarpK`, `vwarp=`): the marbled "fingerprint" swirls that
  appeared as soon as contrast was raised are gone; fine streaks fade toward the limb and the brightening of
  absorber-poor cloud saturates at +16 % (no white scratches at the limb). (c) `venus.js` defaults: `uContrast` 0.5 ->
  1.0, `uStreak` 2.6 -> 4.2, `uFine` 1.0 -> 0.8, `uAlbGain` 1.23 -> 1.3 (brighter cream; the Mallama calibration of
  wave 2 is knowingly exceeded by ~6 %).
- **Crescent was a thin grey outline** (t 84-90). `haze.js`: the forward lobe (direct beam, forward-diffused beam and
  twilight terms) gets a gain `1 + 5 fw` and a warm tint (1, 0.84, 0.58) with `fw = smoothstep(0.45, 0.97, cos
  scattering angle)` - back-lit views only, every day-side view is unchanged (`uFwd`, `vfwd=r,g,b,gain`). Twilight
  source 1.2 -> 2.5 with e-fold 0.2 -> 0.3 rad (the ring closes round the night limb), high haze tau 0.18 -> 0.24,
  H 13 -> 14 km. The crescent limb is now HDR (bloom spreads it into a glowing atmosphere) and warm cream-gold.
- Cost: unchanged within noise (same alternating measurement as Earth, ms per frame at 3200x1800: t=78 38.6 / 45.1 vs
  HEAD 42.0 / 33.5; t=88 25.7 / 24.8 vs 27.0 / 22.5). No new loops or noise call sites. **FXC compile time not
  re-measured** (macOS session): re-run `tools/checks/shader_cost.mjs --q "only=venus,post"` on Windows; the deck
  shader is known to be touchy there (see the `pow` note below).
- Requests (wave 3): **Post** - at the crescent beat the image-based lens ghost of the bright crescent lands inside
  the night disc as a faint inner arc (absent with `postDebug=raw`), and the glare veil still greys the night side.
  **Director** - the day beat at t~80 frames less than half the disc; the chevron reads best with the whole disc in
  frame (as at t=77-78).
- Remaining gaps: the Y is a tan belt with streaks rather than an unmistakable sideways Y; the forward-scatter gain
  makes far-field photometry at extreme phase even brighter than the phase curve (see wave-2 gap).

## What exists (after wave 2)

**Structure (true scale).** Solid radius 6051.8 km (reported `radius`). Visible cloud deck (opaque mesh, shaded on
the exact analytic sphere) at 68 km; haze shell to 200 km. Meshes ride in `bodyQuaternion('venus')` (IAU pole,
retrograde 243-day spin). Cloud super-rotation: westward, 4.0-day period at the equator, 1/cos(lat) angular velocity
to ~50 deg, ~1.5x solid-body polar region (VEx VMC profile). Measured drift at the disc centre (`dist=3&phase=30`,
days 0 -> 0.03): -34 px (cross-correlation), expected 33.6 px.

### Haze — `venus/haze.js` + `common.js` (rebuilt in wave 2: triage items 1 and 2)
Per-pixel integration (2 segments x 16 steps, 4 sub-rays across the limb footprint), analytic Chapman depths.
- **Phase function**: two-term HG, 0.88 HG(0.85) + 0.12 HG(-0.25) (`uPhA`, `vph=`), the strong forward lobe of the
  ~1 um H2SO4 droplets.
- **Vertical structure** (`HAZE` in common.js): cloud-top mode-2 aerosol tau 0.15 / H 4.2 km; upper haze tau 0.12 /
  H 6 km (x2.6 over the poles); tenuous high haze tau 0.18 / H 13 km (this is what is still sunlit far past the
  terminator and makes the ring at 4 R); detached layer at 94 km; CO2 Rayleigh tau 0.006 with H 4.5 km (below the
  haze's own, so Rayleigh never dominates the outer limb: no blue fringe from Venus itself).
- **Multiple-scattering terms** (new): (a) the forward-diffused part of the sunbeam that single-scattering extinction
  removes on the way in (`uMsF`, exp(-0.45 tau) - exp(-tau)), with a broadened forward lobe: it is what makes the
  optically thick limb glow in HDR; (b) twilight that diffuses past the shadow line, attenuated by the *vertical*
  optical depth above the point (`uTwK` = 20, so it lives in the thin high haze: bright along the limb, faint seen
  from above, so the night disc stays black), e-fold 0.2 rad of solar zenith angle (`uTwilight`).
- **Colour**: spectral haze single-scattering albedo (0.999, 0.996, 0.985); every multiply scattered source (deck
  light, forward-diffused beam, twilight) carries the deck's cream `uMsTint` (1, 0.982, 0.875), plus a tint
  uMsTint^(0.35 + 0.15 tau_view) on all in-scattered light (photons leaving the deep limb have scattered several
  times). Aerosol spectral factors are ~grey.
- Results (HDR, linear, `node hdrprobe.mjs` = float readback of the Venus object alone):

| view | before (wave 1) | after |
| --- | --- | --- |
| crescent `dist=3.5&phase=150` | peak 3.2, 1522 px > 2, glow falls 10x within 15 px | peak 4.2, 3417 px > 2, soft gradient over ~80 px |
| ring `dist=4&phase=172`, sun side (az 150) | peak 1.11, radial integral 3.9 | peak 2.24, integral 9.3 |
| ring, anti-sun side (az 330) | 0.022 (ring broken, 17 sRGB) | 0.077, complete 360 deg (~115 sRGB) |
| ring colour at peak (R/G, B/G) | 1.03 / 0.93 | 1.05 / 0.85 (cream; outer edge no longer blue) |
| film crescent t=88 | — | peak 3.2, 1293 px > 2 (warm, B/G 0.82-0.87) |

  Display: crescent edge 249/246/241 then 239/236/230, 221/217/210 ... (was 242/239/234 with a 188/195/206 blue
  fringe); ring top 219/213/203 (was 140/134/123).
- Half phase: terminator broad and smooth; night side black (twilight confined to the thin high haze).

### Deck — `venus/deck.js` + `venus/bake.js` (triage item 3 + compile diet)
- **Photometry** unchanged in form (Hapke radiance factor, similarity-scaled H functions + 0.94 HG(0.72) + 0.06
  HG(-0.4) single scattering, per-channel albedo, glory windowed by `uGloryFade`). `uAlbGain` 1.15 -> 1.23 to keep
  the calibration against the measured V phase curve (Mallama et al. 2006, p_V 0.69) after the absorber mean rose:
  disc-integrated flux from 40 R (G channel) at phase 0/20/90 = 0.673/0.597/0.175 vs measured 0.69/0.626/0.186.
  (Phase 150: 0.051 vs 0.037; phase 172: 0.10 vs 0.021 — the haze is deliberately brighter than the phase curve
  at extreme phase so the near-field crescent and ring glow; see gaps.)
- **Baked planetary fields** (`bake.js`, 512x256 RGBA half float with a CPU box-filtered mip chain, sampled with
  `textureLod` at the footprint's level: no seam, no aliasing):
  - R (wave frame, rigid 4-day rotation): zonal mean (absorber-rich equatorial belt, darker band at ~46 deg, **bright
    polar collar at ~58 deg**, bright polar hood) + the **sideways Y**: equatorial Kelvin-wave stem east of the
    vertex, mid-latitude Rossby arms diverging poleward to the west (amplitude `BAKE.yAmp` 1.7), streaky interior,
    bright region opposite. `WAVE_PH0` (85 deg) places the vertex so the stem and both arms face the film's day
    approach (t ~78-82) and the arms cross the disc in `phase=20` (the phase origin is unknown in reality).
  - G (arc frame, 2.8-day): bright spiral arcs into the collar.
  - B, A: coarse streak fields for the two flow-map layers: 3 octaves (~2500-500 km), meridional coordinate remapped
    by the integral of a latitude-dependent stretch (5x at low latitude -> 1.3x poleward of ~55 deg; spirals from
    the wind shear there), low-frequency domain warp (long curved strokes), intermittency envelope (calm sheets
    alternate with streaky regions), bright-skewed (thin white streaks on a tan background).
- **Colour**: absorption is now multiplicative `exp(-k a)` (strong markings no longer lose all blue); markings peach
  `uAbsCol` (0.34, 0.64, 0.95); absorber-poor cloud (collar, white streaks) brightens *neutrally* (no blue cast);
  streaks are 65 % neutral optical-thickness variation, 35 % absorber.
- Planetary-scale display contrast (luminance blurred 10 px / 2D cubic detrend, inside the bright disc):
  `phase=20` 2.25 % std, p2-p98 9.7 % (wave 1: 1.9 / 7.6 %; Mariner 10 ref: 2.3 / 8.8 %); film day disc t=80
  ~1.5 / 6 % (wave 1 t=88: 1.1 / 4.4 %).
- **Fine detail (GPU)**: octaves 3..10 (~280 km down to ~1 km) of analytic-gradient simplex with the per-octave
  footprint fade, anisotropic footprint, ridged 300-30 km share, multiplicative cascade, low-sun relief; domain-warped
  by the baked coarse fields (no marbled "eyes"). Per-octave tables are uniform arrays (`uOctS`, `uOctA`).
- **Cells** (critic gap 2): one Worley loop per pixel in the wave frame, 5 scales (~380/150 km subsolar convection
  masked in local solar time; ~60/22/8 km patches): soft domed bright cores, broad lanes, **no dark crack lines**,
  cheap analytic outline warp; fade in only when > ~20-50 px.
- Removed: per-pixel planetary noise, separate subsolar Worley loop, gravity-wave packets (they cost ~30 ms of FXC
  for a ~1 % relief detail visible only below 0.15 R), debug views except `vdbg=plan`.

### Shader compile cost (FXC, `node tools/checks/shader_cost.mjs --q "only=venus,post" --top 25`, two runs)
- **Now: deck 261 / 306 ms, haze 88 / 98 ms, total 349 / 404 ms** (wave 1: deck 3110, haze 117, total 3227).
- How: planetary scale -> CPU bake (removed ~10 inlined simplex copies, ~450 ms alone); exactly one `snoiseD` call
  site (octave loop) and one Worley call site; cells out of the per-layer function; Worley neighbour offsets with
  float math (int `%`/`/` cost ~55 ms); uniform per-octave tables; shared lon/lat for all texture lookups; uniform
  loop bounds everywhere (`uLoop`, `uSteps`, `uSegs`).
- Trap found: rewriting `pow(x, 6.0)` in `gloryRings` as `t2*t2*t2` made FXC take 3-5 s on the deck (comment left in
  the code). Measure after every shader edit: `scratchpad` probe = fresh nonce per compile.
- All materials exist at the end of `create()`; nothing is created lazily.

### Performance
GPU (postPerf=1, 1600x900, shared 4090): scene pass incl. MSAA resolve and sky 1.5 ms with Venus filling the
screen at 0.15 R, 1.7 ms full disc at 1.6 R.

## Shots that show it best
```bash
node tools/shot.mjs --q "view=body&body=venus&dist=3.5&phase=150&el=5&only=venus,sky,post" --hud 0 --out shots/venus/w2/crescent.png
node tools/shot.mjs --q "view=body&body=venus&dist=4&phase=172&el=2&only=venus,sky,post" --hud 0 --out shots/venus/w2/ring.png
node tools/shot.mjs --q "view=body&body=venus&dist=3&phase=20&el=-30&only=venus,sky,post" --hud 0 --out shots/venus/w2/south.png   # Mariner 10 look: streaks, tan belt, collar
node tools/shot.mjs --q "view=body&body=venus&dist=3&phase=20&el=5" --hud 0 --out shots/venus/w2/day.png    # Y arms + white streaks
node tools/shot.mjs --q "view=body&body=venus&dist=3&phase=90&el=5" --hud 0 --out shots/venus/w2/half.png
node tools/shot.mjs --t 80,84,88 --hud 0 --out "shots/venus/w2/film_t{t}.png"     # current cut: day 78-82, half 84, crescent 86-90
```
Motion: `--q "view=body&body=venus&dist=3&phase=30&days=D"` for D = 0, 0.03 (-34 px), 0.5, 1.
Before/after sheet: `shots/venus/w2/before_after.png` (`b_*` = wave-1 state, `f1_*`/`fin_*` = final).

Developer switches (my module only): `vdbg=nohaze|nodeck|flat|plan|wave` (`wave` logs the wave-frame longitude of
the sub-camera/sub-solar points), haze `vh=aerTau,aerH,upTau,upH,extTau,extH,rayTau,rayH`, `vph=0,g,wBack,gBack`,
`vhw=r,g,b`, `vtw=`, `vtwa=`, `vtwk=`, `vmsf=`; deck `vcon=` (0.5), `vstr=` (2.6), `vabs=r,g,b`, `valb=` (1.23),
`vani=` (2.0), `vyamp=`, `vcollar=`, `vstretch=`, `vcyc=`, `vrel=`, `vcr=`, `vcalb=`, `vfine=`, `vfb=`, `vridge=`,
`vsky=`, `vglory=`.

## Known gaps
- Far-field photometry at extreme phase: from 40 R the haze makes Venus ~1.4x (phase 150) and ~4.7x (phase 172) the
  Mallama phase curve. Chosen so the near-field crescent/ring glows; a separate, weaker forward lobe for the dense
  cloud-top layer would fix the far field without dimming the near ring (one extra HG per sample).
- At 4 R and phase 172 the anti-sun limb is 22 deg past the terminator (camera deep in the umbra), so that side of
  the ring is physically faint: complete but ~30x dimmer than the sun side.
- The Y and collar read in the disc views but are soft; the collar edge in the south view is a little crisp.
- Close range (0.15 R) is soft streaky taupe at SZA 75; cells are subtle (by design now; wave-1 gap 2 only partly
  addressed — film never goes there).
- Gravity-wave packets were removed for compile budget.
- Cloud-top altitude does not drop toward the poles; procedural (not Magellan) highlands for the invisible night glow.

## Requests to integrator
- Director: **+1 EV for the crescent beat** (currently t ~86-90; `EV` in film.js ramps to 0.6 at t0+14.5). The HDR is
  there now (peak 3-4, >1000 px above 2 at t=88) but bloom only reads with the extra stop. The day approach also
  reads best at EV 0 to +0.2 (now -0.3).
- Post: at the crescent beat the sun glare veil greys the night disc and the background (t=86-90); the lateral CA
  (`uCA` 0.0012) still puts a faint coloured fringe on the thin limb.
- The required "limb close-up" (`dist=1.15&phase=75&el=0&fov=50&look=0,-15`) contains no limb (Venus subtends 60 deg
  there). For the limb haze use `dist=1.05&phase=70&el=0&fov=40&look=0,60` and `dist=1.05&phase=105&el=0&fov=40&look=-62,0`.
