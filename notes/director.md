# Director piece (camera choreography, timeline) + glints

Owner files: `src/journey/*` (director.js, film.js, rig.js, world.js, clock.js, math.js, orbits.js, dev/*) and
`src/render/glints.js` (unchanged this wave).

## The cut (wave 2) — table for HUD / audio retiming

Re-print at any time with `node src/journey/dev/table.mjs [epoch] --md`. Times are the same at every epoch to
~0.4 s (every shot is written in its world's sun-relative frame; only chapter starts that are found from the shots
move by a few tenths).

Duration **429.7 s** (7.16 min; wave 1: 441.5). Cuts (dip to black, ~0.75 s, centred on): 42.5, 68.1, 91.8, 126.3, 158.7, 189.4, 215.2, 257.3, 303.1, 322.7, 346.5.

| chapter | t0 | t1 | title card (body caption) | other captions | audio cues |
| --- | --- | --- | --- | --- | --- |
| intro | 0.0 | 13.0 |  | FOUR LIGHT-HOURS 2.5-10.0 | title 3.0, sun-reveal 10.5 |
| sun | 13.0 | 43.2 | sun 15.0-23.0 | The photosphere 31.0-38.0 | sun-skim 30.0, warp 42.5 |
| mercury | 43.2 | 68.5 | mercury 48.2-56.2 |  | arrive 45.7, warp 68.1 |
| venus | 68.5 | 92.4 | venus 74.3-82.3 |  | arrive 71.3, warp 91.8 |
| earth | 92.4 | 158.9 | earth 99.0-108.0, moon 131.5-139.5 | Night side 119.5-124.8, Earthrise 141.8-150.9 | arrive 95.0, sunrise 125.0, warp 126.3, earthrise 141.3, warp 158.7 |
| mars | 158.9 | 190.1 | mars 164.4-172.4 | Phobos 173.9-179.9 | arrive 161.9, phobos 174.4, warp 189.4 |
| asteroids | 190.1 | 215.3 | asteroids 194.1-202.1 | Looking sunward 211.2-214.8 | belt 192.6, warp 215.2 |
| jupiter | 215.3 | 257.3 | jupiter 222.8-230.8 | Io's shadow 233.8-239.8 | arrive 218.8, io-shadow 233.3, jupiter-skim 244.8, warp 257.3 |
| saturn | 257.3 | 322.7 | saturn 264.0-272.0, titan 307.8-315.8 | In Saturn's shadow 288.9-302.4 | warp 257.3, arrive 260.5, rings 275.5, eclipse 287.4, warp 303.1, titan 306.3, warp 322.7 |
| uranus | 322.7 | 346.5 | uranus 329.0-337.0 |  | warp 322.7, arrive 326.0, bullseye 338.0, warp 346.5 |
| neptune | 346.5 | 390.5 | neptune 352.7-361.2, triton 380.2-388.2 |  | warp 346.5, arrive 349.7, triton 377.7, pullback 388.7 |
| finale | 390.5 | 429.7 | finale 400.7-409.6 | Earth 414.0-423.4, FOUR LIGHT-HOURS 423.4-429.7 | pale-blue-dot 411.0, end 423.4 |

Cue names are unchanged (`title, sun-reveal, sun-skim, warp, arrive, sunrise, earthrise, phobos, belt, io-shadow,
jupiter-skim, rings, eclipse, titan, bullseye, triton, pullback, pale-blue-dot, end`). Every `warp` cue sits exactly
on a cut: the dip to black is the departure's punctuation, the warp itself fills the next ~3.2 s. Body cards are
8-9 s, finale map card 8.9 s, the pale-blue-dot caption 9.4 s, credits 6.3 s (picture fades out under them).

## What changed in wave 2 (root causes)

**1. Dead time and whip pans had one cause: the departure pan.** Each leg used to turn up to 180 deg from the world
it left to the destination, at low speed, through empty sky (4-6 s at 23-30 deg/s), then warp. Now every planet
departure is:
- **a look-back retreat**: the block's last framing recedes radially (`exitDir(..., ~0.06)`), so the world shrinks
  in place at a constant apparent rate with its lighting unchanged (Sun disc, Mercury half-lit, Venus crescent,
  Earth's sunrise, the Moon/Earth pair, Mars, the belt's sunward beat, Jupiter, the Saturn eclipse down the shadow,
  Titan's backlit haze ring, the Uranus bullseye). A `hold` keeps it a steady shot;
- **a deliberate cut under a 0.75 s dip to black** (`legCut` in film.js; `WarpLeg` `cut` option in rig.js): the edit
  changes the view to the destination's point of light at the frame centre and skips the slow bend onto the route;
- **a short warp** (~3.2 s): restarts slowly (`cut.rate` 0.06), accelerates to ~500 c, the streaks radiating from
  the destination (view vs travel 0.0 deg at every plateau), decelerates into the arrival.
- **radial arrivals** (`cut.radialB`): the camera resumes on the destination block's *own first-framing line*, at
  most a quarter of its solar distance out (so the distance from the Sun still only grows), and the world swells from
  a point at the frame centre straight into its first framing: the arrival swing (the second source of fast turns,
  and of Mercury sliding off-frame) is gone. The Earth -> Moon hop comes straight in toward the far side the same way.
- Moon hops that stay continuous: Neptune -> Triton (the camera backs past Triton looking at Neptune; the aim eases
  onto the pair only once Triton is in front, timed after the legs are built).

Infrastructure: cuts are first-class in director.js: the orientation track is smoothed and interpolated *per cut
segment* (no kernel, Catmull-Rom or finite difference crosses one; the sample-classification at the cut uses the
same floating-point times rawAim sees, which was a 27-degree kick bug), `speedAt` / `vel` aims are one-sided at
cuts, `film.cuts` is exported, validate/motion/metrics are cut-aware.

Fluid head: cap = min(0.22 x FOV, 12 deg/s) (was 0.38 x FOV, 0.5 x FOV for pans), 6 deg/s at warp, roll 8 deg/s,
sigma slope 0.6/s. Authored turns were slowed at the source (Sun pull-up as one pitch with a skim-heading up;
Venus swing; Mars/Phobos blends; Jupiter's climb as one pitch onto the half-lit globe; Neptune's night-side swing
8 s; title-card yaws eased over 2.8 s; cold-open pan with cruise easing; finale retreat turn 14.4 s).

**2. Subjects leaving the frame.**
- *Safe frame* (director.js, after the fluid head): wherever the shot has a focus, its centre is kept inside
  |NDC| < 0.6 (a disc larger than ~60% of the half field only has to reach into that box; letterbox-aware); violations
  become world-space rotation vectors, smoothed within their cut segment (sigma 0.35 s, i.e. look-ahead /
  feed-forward), applied over a few passes. Violations > 25 deg are left alone (a designed framing); declared
  `freeFrame` windows: cold open, Phobos crossing, the finale's retreat turn. On the current cut it corrects 306
  samples by at most 2.4 deg: the root causes were fixed in the paths, this is a guard.
- *Titan*: the round-1 arc went over Titan's pole (rotation about an axis in the ecliptic), so the azimuth spline hit
  its singularity: that was the jump to the top-right corner. Now a slow arc about the ecliptic normal, 12 deg up,
  2.7-4.4 Titan radii, ~11 deg/s, composed with a `place` aim (Titan held at a fixed place, leaning toward Saturn).
- *Mercury*: the `mix` with the Sun (direction average: at 140 deg separation it put Mercury 37 deg off-axis) is
  replaced by a **`place` composition target** (`{ place: id, from: 'sun', off }`: the subject at a fixed NDC offset
  away from the Sun at any distance); plus the radial arrival. Mercury holds x = 0.25-0.30 through its arrival.
- *Earth -> Moon*: no Sun-centred transfer: sunrise (the orbit keeps its pace past the low point, the Sun's reddened
  disc on the limb, cut 1.0 s after its centre clears it) -> dip ->
  the Moon's point at the frame centre swelling at a constant apparent rate (radial in toward the far side).
- Automated test: `node src/journey/dev/metrics.mjs <epoch>` — **0.0 s** of focus outside the safe box at all three
  epochs (was ~85 s by the same measure on the wave-1 cut).
- Kicks at 59.7 and 263.13: gone (worst one-frame angular-velocity change now 2.2 deg/s, no kicks > 2.5).

**3. The finale** (Triton block 52 s): twin crescents (hold), 13 s Powers-of-Ten retreat, **map 8.8 s** (flare 0.08,
belt ring 0.1 so the Mercury-Mars orbits read around the Sun; orbit lines fade in only after the retreat has come to
rest *and* `shot.orbits` is gated by the warp in director.js — no thin line art under the radial blur), the zoom to
Earth 6 s, **pale blue dot 8.4 s** (Earth a 2 px point, peak sRGB 113/135/159 at 1600x900, the Moon a fainter
point below it), **credits 6.3 s** over the fade to black.

Cross-piece requests absorbed: warp apex at frame centre on every plateau (0.0 deg); belt glide side-lit (view 95 deg
from the Sun) then a sunward beat (38 deg, Sun just above the frame, up = the Sun); Venus day deck EV +0.1, crescent
EV +1.3 (flare 0.6 there); Earthrise Sun elevation 10.0 deg (all epochs; Earth rises from -8 to -4 deg elevation,
dip 6.7 deg); body beats 8-9 s; Sun exposures from notes/sun.md (wide -9.0, disc -11.7, skim -12.3); calmer flare
where the Sun stands beside a crescent (Neptune night side, Titan's far side, the finale retreat).

## Measured (offline, 60 Hz / 10 Hz; `metrics.mjs`, `motion.mjs`, `validate.mjs`)

| | wave 1 (critic) | 2026-11-02 | 2027-06-15 | 2031-03-01 |
| --- | --- | --- | --- | --- |
| dead (no disc > 4 px), cold open -> finale retreat | ~98 s | 36.5 s | 37.2 s | 36.5 s |
| turn > 20 deg/s | 43.8 s | 0.5 s | 0.5 s | 0.5 s |
| turn > 12 deg/s | 141 s | 47.7 s | 43.3 s | 44.1 s |
| focus outside the safe box | 330-336, 57-58.6, 138-146 | 0 s | 0 s | 0 s |
| warp > 0.5 and turn > 12 deg/s | | 0.6 s (finale retreat) | 0 | 0 |
| NaN / kinks / purity | | 0 / none / pure | 0 / none / pure | 0 / none / pure |

Dead spans left are the ~4 s between each cut and the destination reaching 4 px (the warp itself: streaks radiating
from the labelled destination). Min altitudes: Moon 12 km, Mercury 207 km, Earth 366 km (the sunrise pass), Sun 0.105 R, Jupiter
5,372 km, Titan 4,377 km, 9,830 km over the A ring; no ring near-plane slicing. Director build ~0.9 s.

## How to see it

```bash
node tools/shot.mjs --t 0:429:10 --sheet shots/director/w2/sheet_final_2026.png --cols 6 --w 960 --h 540         # whole film, HUD
node tools/shot.mjs --t 295:331:1.5 --sheet shots/director/w2/strip_sat_titan.png --cols 5 --w 800 --h 450 --hud 0   # eclipse recedes down the shadow -> cut -> Titan swells, arcs to its backlit haze ring -> warp
node tools/shot.mjs --t 255.8:266.3:0.25 --sheet shots/director/w2/strip_jup_sat_dense.png --cols 7 --w 640 --h 360 --hud 0  # departure look-back -> dip -> warp from Saturn's point
node tools/shot.mjs --t 120:141:1 --sheet shots/director/w2/strip_earth_moon.png --cols 6 --w 800 --h 450 --hud 0   # night pass, sunrise, cut, the Moon swelling, descent
node tools/shot.mjs --t 44:72:1.5 --sheet shots/director/w2/strip_mercury.png --cols 5 --w 800 --h 450             # Mercury from a point, held off-centre, terminator pass, recedes
node tools/shot.mjs --t 137:152:0.5 --sheet shots/director/w2/strip_earthrise_dense.png --cols 8 --w 640 --h 360 --hud 0  # Earthrise (Sun 10 deg up behind the camera)
node tools/shot.mjs --t 405 --out shots/director/w2/map_405.png                                                   # the labelled map: inner orbits read round the Sun
node tools/shot.mjs --t 363:429:2.5 --sheet shots/director/w2/strip_finale.png --cols 6 --w 800 --h 450            # Neptune night side, twin crescents, retreat, map, pale blue dot, credits
node tools/shot.mjs --t 0:429:20 --q "epoch=2031-03-01T00:00:00Z" --sheet shots/director/w2/sheet_2031.png --cols 6 --w 800 --h 450
```
Offline (no browser, seconds):
```bash
node src/journey/dev/metrics.mjs [epoch] [--spans]   # dead time, turn-rate totals and spans, kicks, focus-in-frame test, card beats
node src/journey/dev/table.mjs [epoch] [--md]        # chapters / captions / cues / cuts (for HUD + audio)
node src/journey/dev/motion.mjs [epoch]              # turning at warp, kinks, ln-speed kicks, view vs travel at warp
node src/journey/dev/validate.mjs [epoch] [--report] # NaN, altitudes, ring planes, near-plane slicing, purity
node src/journey/dev/rates.mjs [epoch] a:b:step      # authored vs smoothed rate, cap, smoothing width, focus
node src/journey/dev/screenpos.mjs <epoch> a:b:step id,id   # bodies' place in the frame
node src/journey/dev/sunvis.mjs [epoch] a:b:step saturn     # is the Sun hidden (eclipse) through a window
node src/journey/dev/earthrise.mjs [epoch]           # Sun / Earth elevation over the lunar horizon during Earthrise
node src/journey/dev/legs.mjs [epoch] [leg#]         # per-leg table (warp, speedC, turn, view>dest, vel>dest)
```
`dtune=finEV:x,finRing:x,pbd:x,pbdEV:x,pbdSky:x,pbdFlare:x` (URL) tunes the finale without editing.

## Shot fields beyond the contract

`speedKmS`, `lightTimeS`, `sunDistanceKm`, `focusDistance`, `labels` (with `kind`, `radius` for `pale-blue-dot`),
`orbits` (now warp-gated), `flare`, `glintGain`, `glintFloor`, `glintNorm`, `beltRing`, `angVel`, `rollRate`,
`debug`, `audio`. `director._film.cuts` lists the cut times.

## Glints (`src/render/glints.js`, unchanged this wave)

One photometric system: total flux of glint + disc `T(r) = F_disc(R_H) (r/R_H)^(2 kappa)` below the hand-over radius
R_H = 3 px (kappa 0.13), the glint supplying `T - F_disc`, so the summed flux is continuous and monotone through the
hand-over; compact Gaussian core (sigma 0.55 px), depth-tested; moons beside a resolved planet near their true flux;
`shot.glintNorm` for the pale blue dot. With the radial arrivals every destination now swells from its glint at the
frame centre.

## Known gaps

- ~4 s per leg (36.5 s in all) still shows only the warp streaks and the labelled destination point before it
  reaches 4 px; shortening further would make the warp a flash.
- 11 dips to black: a consistent grammar, but a grammar; Neptune -> Triton and belt arrival are the only continuous
  hops (Earth -> Moon and Saturn -> Titan are cut legs).
- The Sun skim keeps ~0.5 s at 20 deg/s (29.2-29.7, the horizon aim over the photosphere); turn > 12 deg/s remains
  ~45 s, mostly orbits round a world that is kept centred (Mercury pass, Jupiter skim and climb, Titan arc, Mars
  after Phobos) - the background stars move at the orbit's angular rate.
- The finale retreat looks back down its own path at warp (streaks converge on Triton; view vs travel ~165 deg for
  ~3 s): deliberate (a Powers-of-Ten pull-back), but the only plateau whose apex is not at the frame centre.
- Jupiter's departure is now half-lit (no departure crescent): a crescent needs either the 150-degree turn back to
  the sunlit limb or a night-side climb that fills the frame with black (both tried).
- Earth's night pass shows city lights at 2026 and 2031; at 2027 (June) the pass is over dark ocean, the frame is
  the limb's airglow only.
- 2031: the Moon/Earth pull-back sees the Moon nearly unlit (phase of the epoch).
- The Titan far side and the Neptune night side bring the Sun into the frame beside a crescent (physically right;
  flare is calmed to 0.45/0.4 there).

## Requests to integrator / other pieces

- **HUD / audio**: retime against the table above (or `director.captions` / `audioCues` / `chapters`, which they
  already read). Chapters now start at the cuts (+0.3-0.7 s); `warp` cues are on the cuts.
- **post**: a cut is a hard change of view and (on cut legs) of position under `shot.fade` = 1; post's
  `evaluate(t +- 0.04)` travel direction spans it only inside the black. Orbit lines are never on screen under warp.
- **sky**: warp plateaus now have the apex exactly at the frame centre (the destination), except the finale retreat.
- **asteroids**: the glide is side-lit then sunward (Sun 38 deg off-axis above the frame, 3.5 s), the belt ring is
  0.1 in the finale map (it was the bright ellipse round the Sun); `belt.heroBeats` re-plans from the new path.
- **Integrator**: a transient `THREE.WebGLProgram: Shader Error ... VALIDATE_STATUS false` and `GL_INVALID_OPERATION:
  Two textures of different types use the same sampler location` appear in full-film runs but not with
  `only=director,glints,post,sky,asteroids` (another module).
- **Saturn critic's ring-skim note**: the film's Saturn block is already built in the ring frame (`up = pole`).
