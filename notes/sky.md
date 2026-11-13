# sky — notes

Owner of `src/sky/*` and `assets/sky/*` (+ the build scripts `assets-src/scripts/build_milkyway.py`,
`build_nebulae.py`, `nebula_shapes.py`). Assets (unchanged in waves 2-3): 348 KB total (stars.bin 146 KB, dust.webp 149 KB, milkyway.webp
17 KB, nebulae.webp 15 KB, json 12 KB), under the 0.4 MB cap.

## Wave 3 (current state) — what changed and why

Goal of the wave: the sky is the whole image in the cold open and in every transit; it was near-black with a thin
sprinkle of equal dots and a grey-brown, foggy Milky Way. Files: `sky.js`, `shaders.js`, `field.js`, new `tiles.js`.
No asset changed (348 KB).

- **Photographic star response** (`MAG_PIVOT 2.5`, `MAG_GAMMA 0.66`, `K 95 -> 300`): fluxes fainter than V 2.5 are
  compressed (flux^0.66), so the deep field shows while the bright stars do not burn out; brightness at the bright
  end turns into image size (`GROW_P 0.42`) and a larger, more saturated halo (`HALO_F 0.14`, `HALO_A 4.5`,
  `HALO_SAT 1.5`: the glow keeps the star's colour where the core clips). Chroma holds to fainter stars (exponent
  0.35 -> 0.2). Positions and magnitudes of the catalogue stars are untouched; only the tone curve changed.
- **Deep field: 1.3 M / 650 k / 300 k procedural stars to V 12.3 / 11.7 / 11.0** (was 400 k to 10.6), same
  statistics as before (N(<m) ~ 10^0.42m, placed by the unextincted starlight, dimmed/reddened by the dust), with the
  plane-to-pole density contrast flattened (`FIELD_DENS 0.55`: in the star clouds the Milky Way shader's grain
  carries the crowding). The field is sorted into 96 sky patches (equal-angle cube faces x 4 x 4), each its own
  instanced mesh sharing ONE material, switched on per frame only if it can touch the view (aberration-aware), so
  only ~8-15 % of the stars are submitted. Directions are normalised int16, magnitude/temperature bytes (8 bytes per
  star). Star quads now end where the image falls below `CUT` (faint stars: ~3 px quads; halo skipped) — fill cost
  per star is a fraction of what it was.
- **Milky Way grain = star-dust tile** (`tiles.js: makeStarTile`, 1024^2, generated at start-up in ~0.1 s, fixed
  seed): a dense random field of point stars with Pareto fluxes, mean 1 at every mip level, mapped on an equal-angle
  cube in Galactic coordinates in octaves a factor 2 apart. The octave whose texel matches the pixel is a grain of
  individual faint stars, coarser ones clump the star clouds, a minified tile is exactly the smooth light. Replaces
  the 7-level 3x3x3 hash lattice + simplex mottle + Poisson grain (27 hash cells x 7 levels per pixel): filtered by
  construction (no twinkle), and ~4x cheaper.
- **Dust filaments = noise tile** (`makeNoiseTile`, 512^2: fBm + ridged multifractal): two layers in (l, b),
  stretched along the plane, the second sheared, added to ln tau where the IRAS column has dust; the tile's fBm also
  warps the dust lookup (ragged outlines). Replaces the six-axis anisotropic simplex streak noise (up to 30 simplex
  evaluations per pixel) and the 4-tap gradient. The far-IR map still decides WHERE the dust is (real Great Rift,
  Pipe, Coalsack, Aquila rift); the tile only breaks its soft edges into streamers.
- **Colour and bulge**: `SAT_MW 0.6 -> 0.9`, `RED_K 1.3` (dust reddens the light behind it: brown/orange lane edges),
  `T_BULGE 4700`, `T_DISK 7600`, `BULGE_LIFT 1.5` (the bulge population outshines the disk: Sagittarius/Scutum are
  the brightest, warm-cream diffuse light; the outer plane is cooler and fainter). A shoulder (`SHOULDER 1.6`) keeps
  the brightest star clouds from clipping at any shot gain/exposure. Bright sprite nebulae x1.5 (`NEB`: Lagoon,
  Trifid, Carina, M42 read as small pink glints), galaxies x1.3 (`GAL`: LMC, SMC, M31), and they take the grain.
- **Detail gate** (`GATE`): filaments and grain are computed only where the displayed diffuse light exceeds ~0.001
  (most of the sky away from the plane, and all of it under a sunlit-planet exposure, takes the cheap path).
- **Adaptation to sunlit bodies** (`ADAPT 12`, `ADAPT_MIN 0.3`): sky gain x 1 / (1 + 12 x lit share of the frame),
  from the projected, phase-weighted discs of planets, moons and Saturn's rings (pure function of the frame). Empty
  transits keep the full dark-adapted sky; a planet filling the frame gets x0.3. This is on top of the director's
  `skyGain` track, which was authored for the old, 3x fainter star calibration.
- **Warp**: streaks have a tapered tail (2.5 t^1.5, energy conserved) and a tighter head; bright stars grow less
  and stretch instead; the faint field thins with warp (`WARP_DIM 0.5` mag per mag below V 6) so the forward sky is
  separate radiating lines, not a blizzard (aberration crowds ~5x the stars ahead and Doppler-brightens them).
  Aberration, Doppler colour (blue ahead / amber behind), patch culling under aberration all as before.

Measured (Apple M5 Pro, headless Chrome/Metal, `only=sky,post,director`, render + gl.finish, min of 20; the GPU was
shared with other builders, so +-30 %):

| frame | before 1600x900 | after 1600x900 | before 3200x1800 | after 3200x1800 |
| --- | --- | --- | --- | --- |
| t=8 cold open | 12.5 ms | 12.6 | 24.1 | 7.8 - 13.4 |
| t=96 transit | 14.5 | 10.1 | 28.7 | 9.9 - 13.3 |
| t=216 warp | 15.1 | 11.3 | (n/a) | 16.1 - 22.8 |
| t=330 | 12.7 | 9.3 | (n/a) | 11.7 - 17.9 |

(Ranges = two runs, the lower with a quieter GPU. At 1600x900 the fixed per-frame cost dominates; the 3200x1800
columns show the shader cost. Post alone: 2.5 / 6.6 / 8.2 ms at 3200x1800.) `perf_probe --t 8,96,216,330`: play avg 16.67 ms (vsync) at all four
after; before 32 / 18 / 18 / 17. Shader compile: sky 0 ms in `shader_cost.mjs --q "only=sky,post"` (two programs:
milkyway, stars; the 96 field patches share the star program). `perf_probe --q "warm=1&only=sky,post,director"`:
cold frames 7-15 ms. Start-up CPU: field 0.8 s (1.3 M stars), tiles 0.14 s. GPU memory: ~10 MB star buffers, 5.6 MB
star tile, 1.4 MB noise tile.
No-twinkle check: 6 frames panned 0.2 px apart at the galactic centre (fov 44): total light constant to 0.15 %, 7x7
box sums around 400 star peaks vary 0.8 % (median) / 2.9 % (p95).

Shots: before `shots/sky/base/` (film_t*.png, sheet.png, gc.png, orion.png, cyg.png, pole.png), after
`shots/sky/film_t*.png`, `film_sheet.png`, `gc.png`, `orion.png`, `planets_t*.png`; iterations `shots/sky/it/`.

### Known gaps after wave 3

- Transits that look away from the Galactic plane (t ~ 96, 162, 224-230) are a dense, coloured star field with no
  Milky Way in frame — rich, but the structure depends on where the director points the camera.
- The star-cloud grain at fov < ~15 is a uniform 'sand' (no cluster knots); filament tiles repeat 8x around the
  plane (not noticeable in film framings; a fov > 100 pan along the plane could show it).
- The filaments are statistical: stretched along the plane, not along each cloud's own contours (the old contour
  tracing was the single most expensive thing in the shader).
- Sirius/Canopus-class stars are soft white blobs (large Gaussian core + halo); no diffraction spikes (post's
  business, and arguably wrong for a 'naked camera').
- Warp frames: the bluish veil and the smear of the Milky Way come from post's radial blur + warp glow.
- No zodiacal light / gegenschein. Bulge still analytic (S_bg layer clipped at radMax; asset rebuild not possible
  here, the raw DIRBE/IRAS downloads are not in the repo).

### Requests (wave 3)

- **Director:** the `sky` track was tuned for the old calibration. With the adaptation in the sky module the film
  balances as is, but the transits would take more: `legCut(... sky: [x, 0.85-0.9])` -> 1.0-1.15 on the planet-less
  side of each leg, and hold the cold open's 1.15 a little longer (it starts fading at t=9 while the title is up).
  Transit framing: where the choice is free, keep some of the Galactic plane in frame (t=96 and t=162 look at the
  emptiest part of the sky). If you would rather own the planet/sky balance entirely, set `skyCal=ADAPT:0` (or ask
  for `CAL.ADAPT = 0`) and drop the track by ~x0.35 in planet close-ups.
- **Post:** during warp, less radial blur / warp glow on diffuse light (`WARP_GLOW`, `WARP_BLOOM`): the Milky Way
  turns into a blue-grey veil at warp 1 (t=258, 324, 348); scale lateral CA down with `shot.warp`.
- **Asteroids:** the grey belt ring still fogs `view=body` sky shots; judge with `only=sky,post`.

## Earlier waves (data model, still valid unless superseded above)

Superseded in wave 3: the lattice ladder ('Resolved star clouds'), the anisotropic streak noise ('Dust detail'),
the faint-field counts, the PSF numbers, the cost figures and the `skyCal` keys RES_*, REM_K, MOTTLE, DUST, WARP,
ANISO, RIDGE, LEVEL_K, EDGE_K (gone). New keys: see `CAL0` in `src/sky/sky.js`.

- **Stars (BSC5, 9096)** from `assets/sky/stars.bin`: true J2000 positions (`radecToThree`), flux = 10^(-0.4 V),
  colour = blackbody at T_eff(B-V) (Ballesteros 2012) through CIE 1931 CMFs -> linear sRGB, white-balanced to 6000 K
  (`src/sky/colour.js`). Close doubles (< 20") merged into one image.
- **PSF** (`src/sky/shaders.js`): instanced screen-space quads. Energy-conserving Gaussian core with a 0.8 CSS px
  sigma floor (faint stars dim, they never shrink or alias). Above saturation the core widens like a photographic
  star image (sigma ~ E^0.35, energy conserved) plus a Moffat halo (8 % of the light, 14 % for V < 0-3). Star chroma
  fades for stars fainter than V ~ 4.5. The faintest field stars (V > 9.4) get up to 30 % softer images (energy
  conserved) so they read as grain.
- **Faint field (400k / 200k / 100k by quality, to V 10.6 / 10.25 / 9.9)**, N(<m) ~ 10^(0.42 m), deterministic
  (`src/sky/field.js`): placed by the *unextincted* background starlight with log-normal clumping on 0.1-1 deg
  scales (stronger and finer toward the plane), then dimmed and reddened by the dust column in front of each star.
- **Milky Way: per-pixel extinction.** `build_milkyway.py` ships the physical layers and the shader composes
  `L_c = pop_c(l,b) * ( F + S_bg * exp(-tau) * exp(-(k_c-1) rho tau) + DGL )`:
  - `milkyway.webp` 1024x256: smooth ln tau_eff, background starlight S_bg (DIRBE J, stars masked), reddening rho;
  - `dust.webp` 4096x1024 (mipmapped): ln tau_eff residual at full IRAS resolution (0.088 deg/texel), companded.
  - **Round-3 data model (root cause of the 'cotton-ball' dust):** the old compact-source filter was a 9x9 (0.56 deg)
    *square* grey opening that also erased 70 % of every filament narrower than the square, leaving soft round
    plateaus. It is now an **oriented line opening** (12 orientations, 0.7 deg): compact warm peaks go, filaments of
    any width survive; applied only within |b| < 9 (away from the plane compact peaks are cold cores = real dark
    nebulae). Distant clump structure no longer leaks into the visible layers: the near zone takes the ~1 deg smoothed
    column near the plane (log-compressed structure, full structure only beyond |b| ~ 5), mid-distance stars see only
    the *smooth* part of the remaining column, and only ~4 % of the mid-plane small-scale excess is foreground outside
    the catalogued near-cloud complexes. LDN clouds are laid along the local filament direction (structure tensor of
    the IRAS column; elongation from its coherence) with streaked internal noise, instead of randomly oriented ellipses.
  - **HII regions are no longer black holes:** inside Lynds Bright Nebulae (red POSS class, brightness 1-4) and a hand
    list of southern HII regions (IC 2944, Carina, NGC 3603/3576, RCW 49/38/36/46, NGC 6188, NGC 6334/6357, G305, G333,
    M8, M20, M16, M17, M42, NGC 2024, Rosette, IC 1396, Heart/Soul, California, lambda Ori) the 100 um excess over a
    ~3 deg lower envelope (the nebula's own warm dust) is removed from the foreground screens and from the LDN stamps;
    the total column still dims the far background.
  - **Documented features the far-IR column cannot show:** star-cloud windows where the nearer dust thins (Large Sgr
    cloud, Baade's window, M24 + its surroundings, Scutum, Norma, Cygnus star cloud, Ara); explicit opaque screens for
    the Coalsack and the **Pipe Nebula** (B59 -> B65-67 stem -> B77/78 bowl) and the Snake (B72).
  - **Bulge (wave 2):** the S_bg layer is clipped at radMax over the whole inner Galaxy (|l| < 70, |b| < 7), which
    flattened the bulge into a straight 7-deg band. The shader now adds the missing light: an analytic boxy bulge
    (exponential in a superellipse radius, scales 3.6 x 3.0 deg, amplitude 13, +15 % toward the bar's near end at
    +l) plus the thin disk, minus what the layer holds, only where the layer is saturated. It sits behind a *reduced*
    screen (0.6 x the column at |b| > ~3, where the IRAS/SFD column overestimates A_V toward the bulge; 2 x in the
    mid-plane) at T_BULGE 4300 K. Result: the Large Sgr cloud swells to b ~ -12, Baade's window and the clouds south
    of the plane are the brightest diffuse light in the sky, and the mid-plane stays a dark rift. The disk light
    (DIRBE J) gets a V/J factor of 1.5 relative to the bulge (it is ~0.45 mag bluer in V-J), so Cygnus and Carina hold
    their own. Measured (fov 8 patches, sky only, no stars, sRGB median L / R:B): LSC 85 / 1.30, Carina 72 / 1.01,
    Cygnus cloud 60 / 1.03, Scutum 31 / 1.14.
  - **DGL** models the ambient sky the dust scatters (0.045 + 0.06 exp(-|b|/10 deg)): opaque clouds far from the
    plane (CrA, Taurus, Orion A) are a few times darker than their faint background, never black cut-outs; faint
    high-latitude cirrus glows slightly.
  - **Dust detail (wave 2, shader):** the isotropic 'cauliflower' perturbation is gone. Sub-texel detail is now
    *anisotropic streak noise along the iso-tau contours*: six fBm fields on icosahedron axes, each streaked ~3.5x
    along the circles about its axis (seamless on the sphere), blended per pixel by cos^8 of the angle between the
    field's streak direction and the local contour tangent (perpendicular to the analytic 4-tap gradient of the IRAS
    column; it falls back to the Galactic-plane direction where the column is flat), variance-preserving, 30 % sharp
    ridges, with a gentle meander warp. It acts mainly on cloud boundaries (edge weight), 12 % in interiors. Edges:
    EDGE_K 2.2 -> 1.2 and only on edges; a second steepening of ln tau *about the visual edge (tau ~2)*, local
    (x exp(-x^2/0.72)) and footprint-limited; DUST 0.8 -> 0.6; domain warp 1.4 -> 0.7 texels. Small dark clouds are
    no longer opaque cut-outs: their optical depth above the ~2 deg column saturates at ~3 (TAU_CAP).
- **Resolved star clouds (wave 2, the core of the 'grainy, not foggy' fix):** a 7-level geometric lattice ladder
  (spacing 0.0046 rad / 2^k; 3 / 5 / 7 levels at q low / med / high) replaces the 4 fixed lattices. A level turns
  into points once its spacing exceeds 1.6 px (full at 2.4 px), so at every fov the finest active level is a
  pixel-scale grain of faint stars and the coarser ones are rarer, brighter stars; zooming in resolves more. Each
  level keeps 3-4 % of the light as resolved stars (occupancy follows the smooth *visible* light, so lanes are nearly
  empty), and the two finest active levels also carry 45 % of the diffuse light as Poisson grain (every cell filled;
  the fine extinction modulates it). The grain fades out with pixel footprint between fov ~40 and ~70 (wide shots
  stay smooth, no coarse lattice) and in faint regions (smooth sky between resolved stars off the band). The
  near-star (foreground) light resolves too, so dark lanes keep a sparse scatter of stars (NEAR_K 1.5). Coarse levels
  use a 2x2x2 cell neighbourhood (cheap), fine ones 3x3x3.
- **Structure sprites** (`nebulae.webp` + `nebulae.json`, procedural from documented morphology): M42 (wider, flatter
  wings ~1.2 x 1.0 deg, a steep surface-brightness ladder so the core reads and the wings fade into the sky), M8, M20,
  Carina, North America/Pelican (continent now dominant, larger Gulf of Mexico), rho Oph, Rosette, LMC. Emission is a
  deep H-alpha red; bright high-excitation cores turn cream-teal; big sprites get their own milder stretch; nebula
  chroma eases off by 30 % at fov > 40. Sprite cell borders fade over 60 % of the radius (no cut-out edge).
- **Other objects** (`catalog.js`): Barnard's Loop, lambda Ori, Flame/IC 434, California, **Pleiades with striated
  reflection (streaks along PA -60, Merope and Maia knots)**, Heart & Soul, IC 1318/1396, Veil, M16/M17 (+ faint
  halos), NGC 6334/6357, Antares, Sh2-27, IC 2944, Gum, Vela, **NGC 6726/6727 + IC 4812 at the head of the CrA
  cloud**, SMC, M31, M33, 47 Tuc, omega Cen.
- **Warp (wave 2):** exact aberration for stars and the Milky Way, Doppler colour. Streak length is soft-capped at
  5 % of the frame height (STREAK_MAX; was a hard 360 px), with a bright head carrying up to 45 % of the light, so
  every star stays legible as a point radiating from the apex. Receding side: the Doppler brightness exponent went
  from 2.6 x 1.4 (= 3.6) to 1.4 for stars and 1.2 for the Milky Way, floored at 0.25 / 0.3, so the trailing sky is
  reddened and dimmer, never black. The sky never smears the Milky Way shell (it is only aberrated); the remaining
  smear is post's radial blur. Diffuse objects are culled where aberration puts them (the 32-slot list never
  overflows).
- Draw rules: Milky Way shell (r = 1e7, BackSide) renderOrder -1000, stars -999, `transparent:false,
  depthWrite:false, depthTest:true`. Bodies cover them (`shots/sky/r3/final/jupiter.png`).
- Cost (4090, sky+post): 4.17-4.22 ms average frame at 1600x900 and at 3200x1800 (vsync-limited, 240 fps; the
  GPU is not the limit). Shader compile: no sky program shows in `node tools/checks/shader_cost.mjs --q
  "only=sky,post"` (sky 0 ms, after forcing a rebuild of both programs). Cold frame after a seek (`node
  tools/checks/perf_probe.mjs --q warm=1 --t 6,220.5,260.5,272,326.5,395`): 7-35 ms everywhere (budget 80 ms). Both
  sky programs are created at create() and drawn every frame; no define changes, no lazily created passes (quality
  only changes uniforms).

## Shots that show it best

```bash
Q="view=body&body=earth&dist=60"
node tools/shot.mjs --hud 0 --q "$Q&aimRaDec=270,-27&fov=20&only=sky,post" --out shots/sky/sgr20.png   # grainy Sgr clouds, filamentary lanes, Pipe
node tools/shot.mjs --hud 0 --q "$Q&aimRaDec=266,-29&fov=60&only=sky,post" --out shots/sky/gc.png      # bulge swelling, Great Rift, rho Oph
node tools/shot.mjs --hud 0 --q "$Q&aimRaDec=190,-61&fov=20&only=sky,post" --out shots/sky/crux20.png  # Coalsack, Crux, ragged lanes
node tools/shot.mjs --hud 0 --q "$Q&aimRaDec=280,-10&fov=100&only=sky,post" --out shots/sky/wide.png   # Sgr-Scutum vs the band elsewhere
node tools/shot.mjs --hud 0 --q "$Q&aimRaDec=280,-10&fov=60&only=sky,post&skyWarp=0.8&skyVel=280,-10&postWarp=0.8" --out shots/sky/warp.png
node tools/shot.mjs --hud 0 --t 327 --q "only=sky,post,director" --out shots/sky/warp327.png          # an in-film warp plateau
```
Required views: orion 84,-2 fov 50; dipper 165,56 fov 50; crux 190,-60 fov 50; gc 266,-29 fov 60; cygnus 305,40
fov 60; wide 280,-10 fov 100; jupiter `view=body&body=jupiter&dist=2.5&phase=20`. Wave-2 renders: before
`shots/sky/w2/base/`, iterations `shots/sky/w2/it/` (suffix letters in order), final full-module set
`shots/sky/w2/final/` (orion, dipper, crux, gc, cygnus, wide_full, jupiter, sgr20, cyg25, warp_back, warp_fwd_post,
film_*), film frames `shots/sky/w2/film/` (warp_*.png = sky+post+director; full_sheet.png), patch measurements
`shots/sky/w2/meas/`. Before/after dust detail: `shots/sky/w2/final/crop_sgr20_dust_3x_before.png` vs
`crop_sgr20_dust_3x.png`.

Warp legs in the current cut (they move; re-locate with `--t 0:470:4` and the printed focus/warp): plateaus
~220-221 (Jupiter), ~260-261 (Saturn), ~327-328 (Uranus), ~350-351 (Neptune), ~391-399 (finale).

Test overrides (URL, sky only): `skyWarp=<0..1>`, `skyVel=<ra,dec>`, `skyStreak=<dbeta>`;
`skyDbg=nofield,nobsc,nores,nodetail,log`; `skyCal=KEY:value,...` (any CAL0 number; array entries as KEY.i:value,
e.g. `skyCal=BULGE.0:10,DOP_REC.1:0.4`).

Rebuild assets (unchanged in wave 2): `cd assets-src/scripts && RES_R=2.5 DUST_Q=74 python -I build_milkyway.py ../raw
../../assets/sky <cache> [preview]` and `python -I build_nebulae.py ../../assets/sky [preview]` (python:
C:\Python314; numpy/PIL/scipy live in the user site-packages, which dirbe_common.py adds under -I).

## Known gaps

- At fov 10-20 the star clouds are now a dense grain of stars, but the brightest Sgr fields read slightly 'sandy'
  (uniform grain amplitude); real clouds have more clumping at 1-5' (cluster knots, M24's sharp rim).
- The inner-plane dust (|b| < 3) is still model + LDN + hand screens; the far south (Norma-Carina) has no optical
  dark-cloud catalogue, so its lanes are softer than in a photograph. The Pipe stem is crisp but a little 'stamped'.
- The bulge is analytic in the shader (root cause: the S_bg layer is clipped at radMax over the inner Galaxy); the
  cleaner fix is to re-encode S_bg with a higher radMax in build_milkyway.py (asset rebuild, not done this wave).
- The Coalsack interior is very dark (A_V 1.6 screen + the column); the real Coalsack keeps a faint glow.
- Sprites remain procedural: Carina compact at fov 12, Lagoon/Trifid small at fov > 30.
- No zodiacal light / gegenschein.
- During warp, the Milky Way smear and colour fringes on streak heads come from post (radial blur, lateral CA).
- `uLevelK` / CAL.LEVEL_K is now unused (the old contour-offset noise was replaced); harmless.

## Requests to integrator

- **Director:** keep the apex within ~25 deg of frame centre during every warp plateau. In the current cut 220.5,
  260.5 and 327 look radial (good). t=326.5 is a pure-black frame (a fade or cut; it is black with the sky module
  disabled too, so it is not the sky).
- **Jupiter (seen in a full-module film run during this wave):** `module "jupiter" failed: SyntaxError: Identifier
  'lon' has already been declared`. Not sky-owned.
- **Asteroids:** a grey ecliptic belt band can still fog `view=body` sky shots; judge the sky with `only=sky,post`.
- **Post:** scale lateral CA down with `shot.warp` (streak heads fringe); consider less radial blur on the diffuse
  sky during warp so the Milky Way structure survives.
