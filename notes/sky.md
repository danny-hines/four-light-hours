# sky — notes

Owner of `src/sky/*` and `assets/sky/*` (+ the build scripts `assets-src/scripts/build_milkyway.py`,
`build_nebulae.py`, `nebula_shapes.py`). Assets (unchanged in wave 2): 338 KB total (stars.bin 146 KB, dust.webp 149 KB, milkyway.webp
17 KB, nebulae.webp 15 KB, json 12 KB), under the 0.4 MB cap.

## What exists

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
