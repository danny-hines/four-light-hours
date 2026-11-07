// FOUR LIGHT-HOURS — the shot list, executed for the real planet positions of the epoch.
//
// Every block is authored in its world's sun-relative frame (azimuth = phase-like angle from the Sun direction,
// elevation, distance in radii), so the lighting of each shot is the same for any epoch; arrival and departure
// directions come from the heliocentric route between worlds; moon shots (Earthrise, Phobos, Io's shadow,
// Titan, Triton) are solved from the body modules' own moon ephemerides at build time.
import * as THREE from 'three';
import { AU, DEG, KM_PER_UNIT, C_KM_S, LIGHT_SECONDS_PER_AU, bodyQuaternion, radecToThree, dateFromDays, daysSinceJ2000 } from '../core/astro.js';
import { BODIES } from '../core/bodies-data.js';
import { Track, clamp, smoothstep, slerpDir, unwrapDeg, lookQuat } from './math.js';
import { Rig, OrbitBlock, FlyBlock, WarpLeg, PullBack, routeGeom } from './rig.js';
import { makeClock } from './clock.js';

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const ECL = V3(0, 1, 0);
const GALACTIC_CENTRE = [266.405, -28.936]; // RA, Dec (deg)

// Exposure (EV = log2 exposure) per kind of shot. The Sun's disc is ~10^3 in linear HDR units.
// Sun: disc centre radiance 3000 (src/bodies/sun.js); exposures as tuned by the Sun builder for each view.
// (Sun exposures from notes/sun.md: full disc 0.0003, wide corona 0.002, skim 0.0002; post's hero composite gives the
// disc its own exposure, so these mainly set how the corona and prominences read)
const EV = { sunWide: -9.0, sun: -11.7, sunSkim: -12.3, planet: 0, venus: 0.1, venusCrescent: 1.3, night: 2.6, moon: 0.35, belt: 1.2, eclipse: 3.4, finale: 0.5 };

function fmtLightTime(sec) {
  if (sec < 90) return `${sec.toFixed(1)} s`;
  const m = sec / 60;
  if (m < 90) {
    const mm = Math.floor(m), ss = Math.round(sec - mm * 60);
    return `${mm} min ${String(ss).padStart(2, '0')} s`;
  }
  const h = Math.floor(m / 60), mm = Math.round(m - h * 60);
  return `${h} h ${String(mm).padStart(2, '0')} min`;
}
const fmtNum = (x) => Math.round(x).toLocaleString('en-US');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function fmtDate(d) {
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function buildFilm(ctx, W, opts = {}) {
  const { epochDays } = ctx;
  const TUNE = {};
  try {
    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('dtune') : null;
    if (q) for (const kv of q.split(',')) {
      const [k, v] = kv.split(':');
      TUNE[k] = Number(v);
    }
  } catch (e) {
    /* no location (node) */
  }
  const tune = (k, d) => (Number.isFinite(TUNE[k]) ? TUNE[k] : d);
  const clock = makeClock(epochDays);
  const rig = new Rig(W, clock);
  const plan = {
    aim: [],
    tr: { fov: [], yaw: [], pitch: [], roll: [], ev: [], sky: [], letterbox: [], fade: [], orbits: [], intensity: [], flare: [], glint: [], glintFloor: [], beltRing: [], pbdNorm: [] },
    captions: [],
    labels: [],
    chapters: [],
    cues: [],
    focus: [],
    holds: [],
    pans: [],
    cuts: [],
    freeFrame: [],
  };
  const key = (name, t, v, m) => plan.tr[name].push({ t, v, m });
  const aim = (t, target, blend = 2, up, ease) => plan.aim.push({ t, target, blend, up, ...(ease ? { ease } : {}) });
  const focus = (t, id) => plan.focus.push({ t, id });
  // a held beat keeps its authored camera rates (the director's turn-rate smoothing may not borrow time from it)
  const hold = (t0, t1) => plan.holds.push({ t0, t1 });
  // Departure: the world being left recedes in place (the block's last framing, radially: it shrinks at a constant
  // apparent rate with its lighting unchanged), then a deliberate cut under a 0.75 s dip to black: the view
  // changes to the destination's point of light at the frame centre and the leg resumes on the route, skipping the
  // slow bend onto it; the camera then accelerates to warp with the streaks radiating from the destination. No
  // departure pan: a turn of up to 180 degrees through an empty starfield was a quarter of the film.
  // o: { fov: [before, after], ev: [before, after], sky: [before, after], up }
  const cutT = (id) => S[id].t1 + S[id].cut;
  const legCut = (from, next, o = {}) => {
    const tc = cutT(from);
    plan.cuts.push(tc);
    // the look-back is a steady shot: the fluid head may not smear an earlier turn into it
    hold(o.steady ?? tc - 1.8, tc);
    key('fade', tc - 0.36, 0); key('fade', tc - 0.04, 1); key('fade', tc + 0.06, 1); key('fade', tc + 0.42, 0);
    aim(tc, next, 0, o.up || 'ecl');
    const nextId = typeof next === 'string' ? next : o.focus || 'asteroids';
    if (o.fov) { key('fov', tc - 0.07, o.fov[0]); key('fov', tc + 0.07, o.fov[1]); }
    if (o.ev) { key('ev', tc - 0.1, o.ev[0]); key('ev', tc + 0.1, o.ev[1]); }
    if (o.sky) { key('sky', tc - 0.1, o.sky[0]); key('sky', tc + 0.1, o.sky[1]); }
    if (o.flare !== undefined) { key('flare', tc - 0.1, 1); key('flare', tc + 0.1, o.flare); }
    focus(tc, nextId);
    if (typeof next === 'string') plan.labels.push({ t0: tc + 0.45, t1: S[from].t1 + S[from].leg + 2.5, ids: [next], kind: S[next] && ['titan', 'moon', 'triton'].includes(next) ? 'moon' : 'planet' });
    cue(tc, 'warp', 2);
    return tc;
  };
  const cue = (t, id, dur = 2) => plan.cues.push({ t, id, dur });
  const caption = (t0, t1, c) => {
    const o = { t0, t1, ...c };
    plan.captions.push(o);
    return o;
  };
  // leaving: the worlds of the previous chapter; when given, director.js moves the chapter start (and so its HUD
  // title card) to the moment the film has really left them (warp engaged and every one of them < 10 px)
  const chapter = (id, title, t0, body, leaving) => plan.chapters.push({ id, title, t0, body, ...(leaving ? { leaving, fromShot: true } : {}) });
  const labels = (t0, t1, ids, kind) => plan.labels.push({ t0, t1, ids, kind });

  // ------------------------------------------------------------------------------------------ helpers
  const apos = (id, t) => W.pos(id, clock(t), V3());
  const frameOf = (id, t, up = ECL) => W.frame(id, clock(t), up);
  const ae = (id, dir, t, up = ECL) => W.azElOf(frameOf(id, t, up), dir);
  const dirAE = (id, t, az, el, up = ECL) => W.dirFrom(frameOf(id, t, up), az, el, V3());
  const sunDirFrom = (id, t) => apos(id, t).negate().normalize();
  const lightTime = (id) => (W.positions[id] ? W.positions[id].length() * KM_PER_UNIT / C_KM_S : 0);
  const sunElevOverEquator = (id) => Math.asin(clamp(sunDirFrom(id, 0).dot(W.pole(id)), -1, 1)) / DEG;

  /** Tangents of the route between two points (matches WarpLeg._arc: the chord, bowed away from the Sun). */
  function arcTangents(A, B) {
    const g = routeGeom(A, B);
    return { dep: g.dep, arr: g.arr };
  }

  // ------------------------------------------------------------------------------------------ timeline
  // [id, block duration, leg duration after it, cut (s into the leg; null = a continuous leg), recession log-rate (/s)]
  // A cut leg: the camera keeps receding from the world it leaves (looking back at it) until the cut, made under a
  // dip to black; after it the camera is on the route, looking at the destination, and accelerates to warp (the
  // rest of the leg, ~3.5 s). The departing world is in frame until the dip; the destination swells from a point
  // at the frame centre right after it.
  let T = 0;
  const S = {};
  const seq = [
    ['sun', 41, 4.7, 1.5, 0.45],
    ['mercury', 21, 4.6, 1.4, 0.5],
    ['venus', 19, 4.7, 1.5, 0.45],
    ['earth', 30.8, 5.4, 0.9, 0.5],
    ['moon', 26, 4.7, 1.5, 0.45],
    ['mars', 26, 4.7, 1.5, 0.5],
    ['belt', 22, 4.2, 0.6, 0.4],
    ['jupiter', 37, 4.7, 1.5, 0.4],
    ['saturn', 41, 4.8, 1.6, 0.45],
    ['titan', 15, 4.7, 1.4, 0.5],
    ['uranus', 19, 4.7, 1.5, 0.4],
    ['neptune', 23, 5, null],
    ['triton', 52, 0, null],
  ];
  for (const [id, dur, leg, cut, dwellRate] of seq) {
    S[id] = { t0: T, t1: T + dur, leg, cut: cut ?? undefined, dwell: cut ?? 0, dwellRate };
    T += dur + leg;
  }
  // cut legs into a planet resume on the planet's own approach line, at most a quarter of its solar distance out (so
  // the distance from the Sun still only grows along the film)
  {
    const PLANET_IN = { sun: 'mercury', mercury: 'venus', venus: 'earth', moon: 'mars', belt: 'jupiter', jupiter: 'saturn', titan: 'uranus', uranus: 'neptune' };
    for (const from in PLANET_IN) S[from].cutOpts = { radialB: true, capB: 0.25 * W.positions[PLANET_IN[from]].length() };
  }
  // end of a leg's dwell (the cut, for a cut leg)
  const dwellEnd = (id) => S[id].t1 + S[id].dwell;
  const duration = S.triton.t1;
  const RATE = { sun: 0.3, mercury: 1, venus: 1, earth: 0.25, moon: 0.25, mars: 0.25, belt: 1, jupiter: 0.5, saturn: 0.5, titan: 0.5, uranus: 1, neptune: 1, triton: 0.5 };
  for (const [id] of seq) S[id].stop = clock.addStop(S[id].t0, S[id].t1, RATE[id]);

  // ------------------------------------------------------------------------------------------ searches
  // Earth: Africa on the sunlit face for the approach (like Apollo 17), which puts North America under the
  // pre-dawn night pass; and a Moon phase that shows a half-lit Earth from the lunar surface for Earthrise.
  const E_APP = { tau: 12.5, az: -22, el: 16 };
  const RISE = { tau0: 8.6, tau1: 18.2 }; // within the Moon block (the Earthrise hold, ~9.6 s)
  {
    const tApp = S.earth.t0 + E_APP.tau;
    const tRise = S.moon.t0 + (RISE.tau0 + RISE.tau1) / 2;
    const q = new THREE.Quaternion();
    let best = null;
    for (let x = 0; x <= 30; x += 0.004) {
      clock.setExtra(S.earth.stop, x);
      const d = clock(tApp);
      const dir = dirAE('earth', tApp, E_APP.az, E_APP.el);
      bodyQuaternion('earth', d, q).invert();
      const l = dir.applyQuaternion(q);
      const lon = Math.atan2(-l.z, l.x) / DEG;
      const lonErr = Math.abs(unwrapDeg(lon - 22, 0));
      if (lonErr > 3) continue;
      // Earth's phase angle seen from the Moon at Earthrise
      const dr = clock(tRise);
      const E = W.pos('earth', dr, V3()), M = W.pos('moon', dr, V3());
      const toSun = E.clone().negate().normalize(), toMoon = M.clone().sub(E).normalize();
      const alpha = Math.acos(clamp(toSun.dot(toMoon), -1, 1)) / DEG;
      const score = lonErr / 3 + Math.max(0, Math.abs(alpha - 80) - 35) / 4 + x * 0.05;
      if (!best || score < best.score) best = { x, score, alpha, lonErr };
      if (Math.abs(alpha - 80) < 35 && lonErr < 1.0) break;
    }
    clock.setExtra(S.earth.stop, best ? best.x : 0);
    S.earth.search = best;
  }

  // Mars: Valles Marineris on the approach face; Phobos coming round on the day side for the crossing.
  const M_APP = { tau: 9.5, az: 24 };
  const PHO = { tau0: 11.5, tau1: 17.5, az: 44 };
  {
    const tApp = S.mars.t0 + M_APP.tau;
    const tPh = S.mars.t0 + (PHO.tau0 + PHO.tau1) / 2;
    const q = new THREE.Quaternion();
    let best = null;
    for (let x = 0; x <= 14; x += 0.002) {
      clock.setExtra(S.mars.stop, x);
      const d = clock(tApp);
      const dir = dirAE('mars', tApp, M_APP.az, 0);
      bodyQuaternion('mars', d, q).invert();
      const l = dir.applyQuaternion(q);
      const lon = Math.atan2(-l.z, l.x) / DEG;
      const lonErr = Math.abs(unwrapDeg(lon - -66, 0));
      if (lonErr > 25) continue;
      const dp = clock(tPh);
      const ph = W.moonFns.phobos.fn(dp, V3()).normalize();
      const pae = W.azElOf(frameOf('mars', tPh), ph);
      const azErr = Math.max(0, Math.abs(unwrapDeg(pae.az - PHO.az, 0)) - 18);
      const score = lonErr / 12 + azErr / 30 + x * 0.04;
      if (!best || score < best.score) best = { x, score, lonErr, azErr, el: pae.el };
    }
    clock.setExtra(S.mars.stop, best ? best.x : 0);
    S.mars.search = best;
  }

  // Jupiter: Io's shadow on the visible disc during the close hold (camera at az/el below, Jupiter frame).
  const J_HOLD = { tau0: 14.5, tau1: 21, az: 26, el: 6, dist: 3.9 };
  {
    const tH = S.jupiter.t0 + (J_HOLD.tau0 + J_HOLD.tau1) / 2;
    const up = W.pole('jupiter');
    const RJ = W.radius('jupiter');
    let best = null;
    for (let x = 0; x <= 14; x += 0.0015) {
      clock.setExtra(S.jupiter.stop, x);
      const d = clock(tH);
      const camDir = dirAE('jupiter', tH, J_HOLD.az, J_HOLD.el, up);
      const J = W.positions.jupiter;
      const io = W.moonFns.io.fn(d, V3());
      const s = J.clone().add(io).negate().normalize(); // toward the Sun from Io
      // ray Io -> anti-sun, hit Jupiter sphere (centre at origin)
      const ro = io, rd = s.clone().negate();
      const b = ro.dot(rd), c = ro.lengthSq() - RJ * RJ;
      const h = b * b - c;
      if (h < 0 || -b < 0) continue;
      const hit = ro.clone().addScaledVector(rd, -b - Math.sqrt(h)).normalize();
      const ang = Math.acos(clamp(hit.dot(camDir), -1, 1)) / DEG;
      // Io itself should be visible (not behind the planet as seen from the camera)
      const camP = camDir.clone().multiplyScalar(J_HOLD.dist * RJ);
      const toIo = io.clone().sub(camP);
      const tCA = -camP.dot(toIo.clone().normalize());
      const hidden = tCA > 0 && tCA < toIo.length() && camP.clone().addScaledVector(toIo.clone().normalize(), tCA).length() < RJ;
      // Great Red Spot (body frame lon -48.2, lat -19.5; src/bodies/jupiter.js) on the visible disc too
      const gq = bodyQuaternion('jupiter', d, new THREE.Quaternion());
      const la = -19.5 * DEG, lo = -48.2 * DEG;
      const grs = V3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyQuaternion(gq);
      const angG = Math.acos(clamp(grs.dot(camDir), -1, 1)) / DEG;
      const score = Math.abs(ang - 22) / 10 + Math.max(0, angG - 32) / 8 + (hidden ? 3 : 0) + x * 0.02;
      if (!best || score < best.score) best = { x, score, ang, angG };
    }
    clock.setExtra(S.jupiter.stop, best ? best.x : 0);
    S.jupiter.search = best;
  }

  // Saturn: Titan a little beyond the anti-sun side, so the eclipse flows on to a backlit Titan.
  const TITAN_AZ = 204;
  {
    const up = W.pole('saturn');
    const tT = S.titan.t0 + 5;
    let best = null;
    for (let x = 0; x <= 17; x += 0.004) {
      clock.setExtra(S.saturn.stop, x);
      const d = clock(tT);
      const ti = W.moonFns.titan.fn(d, V3()).normalize();
      const a = W.azElOf(frameOf('saturn', tT, up), ti);
      const err = Math.abs(unwrapDeg(a.az - TITAN_AZ, 0));
      const score = Math.max(0, err - 22) / 6 + x * 0.06;
      if (!best || score < best.score) best = { x, score, err };
    }
    clock.setExtra(S.saturn.stop, best.x);
    S.saturn.search = best;
  }

  // Neptune: the Great Dark Spot near the centre of the approach view (lon -78 at 2026-11-02T12, drifting
  // -64 deg/day in the body frame; notes/neptune.md), and Triton on Neptune's night side for twin crescents.
  const N_APP = { tau: 9.5, az: 30, el: 9 };
  {
    const T0N = daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
    const tApp = S.neptune.t0 + N_APP.tau, tTr = S.triton.t0 + 6.5;
    const q = new THREE.Quaternion();
    let best = null;
    for (let x = 0; x <= 7; x += 0.002) {
      clock.setExtra(S.neptune.stop, x);
      const d = clock(tApp);
      const dir = dirAE('neptune', tApp, N_APP.az, N_APP.el);
      bodyQuaternion('neptune', d, q);
      const la = -17.5 * DEG, lo = (-78 - 64 * (d - T0N)) * DEG;
      const gds = V3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyQuaternion(q);
      const angG = Math.acos(clamp(gds.dot(dir), -1, 1)) / DEG;
      const dt = clock(tTr);
      const tr = W.moonFns.triton.fn(dt, V3()).normalize();
      const angT = Math.acos(clamp(tr.dot(sunDirFrom('neptune', tTr)), -1, 1)) / DEG;
      const score = Math.max(0, angG - 18) / 8 + Math.max(0, 140 - angT) / 10 + Math.max(0, angT - 168) / 2 + x * 0.05;
      if (!best || score < best.score) best = { x, score, angG, angT };
    }
    clock.setExtra(S.neptune.stop, best.x);
    S.neptune.search = best;
  }

  // ------------------------------------------------------------------------------------------ key points
  const belt = (() => {
    // the crossing: where the Mars -> Jupiter route (the bowed chord) passes 2.7 AU from the Sun, flown along it
    const M = W.positions.mars, J = W.positions.jupiter;
    const g = routeGeom(M, J);
    const at = (s) => M.clone().lerp(J, s).addScaledVector(g.n, g.h * 4 * s * (1 - s));
    let lo = 0, hi = 1;
    // |route(s)| rises from 1.5 to 5.2 AU along the route (bisect on the first crossing of 2.7 AU)
    for (let s = 0; s <= 1; s += 0.01)
      if (at(s).length() >= 2.7 * AU) {
        hi = s;
        lo = Math.max(0, s - 0.01);
        break;
      }
    for (let i = 0; i < 40; i++) {
      const m = (lo + hi) / 2;
      if (at(m).length() < 2.7 * AU) lo = m;
      else hi = m;
    }
    const s = (lo + hi) / 2;
    const C = at(s);
    const u = at(s + 1e-4).sub(at(s - 1e-4)).normalize();
    return { position: C, direction: u };
  })();

  const anchorPosAt = (id, t) => (id === 'belt' ? belt.position.clone() : apos(id, t));
  const order = seq.map((s) => s[0]);
  function natArr(id, t) {
    const i = order.indexOf(id);
    if (i <= 0) return null;
    return arcTangents(anchorPosAt(order[i - 1], t), anchorPosAt(id, t)).arr;
  }
  function natDep(id, t) {
    const i = order.indexOf(id);
    if (i < 0 || i >= order.length - 1) return null;
    return arcTangents(anchorPosAt(id, t), anchorPosAt(order[i + 1], t)).dep;
  }
  // exit direction: part-way from the last framing direction toward the route, so the block never has to swing
  // all the way round at low altitude (the leg finishes the turn once the world is a point of light)
  function exitDir(id, t, lastDir, w = 0.55) {
    return slerpDir(lastDir, natDep(id, t), w, V3(), ECL);
  }

  const blocks = {};
  const mk = (id, opts) => {
    const ks = opts.keys;
    if (opts.radialIn) {
      // arrival straight in along the first framing's own line (the cut leg before it resumes on that line): the world
      // swells from a point at the frame centre with no swing at all
      Object.assign(ks[0], { az: ks[1].az, el: ks[1].el });
      plan.holds.push({ t0: ks[0].t + 0.6, t1: ks[1].t - 1.2 });
      S[id].radialIn = true;
    } else if (ks.length > 1 && ks[0].dist >= 600 && ks[1].t - ks[0].t > 4) {
      // arrival from a warp leg: the world swells at a constant log rate along the route's own direction while the
      // warp dies down, and only then does the camera swing round to the block's first framing (an orbit at warp
      // would rotate the streaking frame); the destination is held exactly where the aim puts it (no smoothing
      // lag), so it swells from one spot in the frame
      // (the swing starts once the approach is below ~20 c: later for the giants, whose radii make 900 R far)
      const rKm = W.radius(id) * KM_PER_UNIT, inR = opts.inRate ?? 0.6;
      const dW = (6e6 / (rKm * inR)) ;
      const a = ks[0], b = ks[1], tau = clamp(Math.log(a.dist / dW) / inR, 1.2, Math.min(3.2, b.t - a.t - 2)), f = tau / (b.t - a.t);
      const daz = unwrapDeg(b.az, a.az) - a.az;
      ks.splice(1, 0, { t: a.t + tau, az: a.az + 0.06 * daz, el: a.el + 0.06 * (b.el - a.el), dist: Math.exp(Math.log(a.dist) * (1 - f) + Math.log(b.dist) * f) });
      plan.holds.push({ t0: a.t + 0.6, t1: a.t + tau - 0.4 });
    }
    return (blocks[id] = rig.add(new OrbitBlock(rig, { anchor: id, t0: S[id].t0, t1: S[id].t1, ...opts })));
  };
  const K = (t, az, el, dist, extra) => ({ t, az, el, dist, ...extra });
  const KD = (t, id, dir, dist, up = ECL, extra) => {
    const a = ae(id, dir, t, up);
    return { t, az: a.az, el: a.el, dist, ...extra };
  };

  const dateStr = fmtDate(dateFromDays(epochDays));

  // ============================================================================================ 0-1 COLD OPEN + SUN
  // The Sun module pins its rotation phase to the film start, with its hero hemisphere (sunspot groups,
  // limb prominences, streamers) facing az 30 / el 5 of this frame; the skim crosses active region A heading
  // south, with prominences standing beyond the horizon (see src/bodies/sun/features.js).
  {
    const id = 'sun', b = S.sun, t0 = b.t0, R = W.radius('sun');
    const HERO = { az: 30, el: 5 };
    const heroDir = dirAE('sun', t0, HERO.az, HERO.el);
    // cold open: from the corona-wide position, look at the Milky Way 70 deg from the Sun (near the galactic centre)
    const g = radecToThree(GALACTIC_CENTRE[0] * DEG, GALACTIC_CENTRE[1] * DEG, V3());
    const ngp = radecToThree(192.85948 * DEG, 27.12825 * DEG, V3());
    const gq = ngp.clone().cross(g).normalize();
    const toSun = heroDir.clone().negate();
    let openDir = g.clone(), best = 1e9;
    for (let l = -180; l < 180; l += 1) {
      const v = g.clone().multiplyScalar(Math.cos(l * DEG)).addScaledVector(gq, Math.sin(l * DEG));
      const ang = Math.acos(clamp(v.dot(toSun), -1, 1)) / DEG;
      const sc = Math.abs(ang - 72) / 8 + Math.abs(l) / 50 + Math.max(0, Math.abs(v.y) - 0.75) * 10;
      if (sc < best) {
        best = sc;
        openDir = v;
      }
    }
    const dDep = natDep('sun', b.t1);
    const keys = [
      K(t0 + 0, HERO.az - 4, HERO.el + 1, 16.5),
      K(t0 + 12.5, HERO.az - 1, HERO.el + 0.3, 14),
      K(t0 + 22, HERO.az, HERO.el, 4.2),
      K(t0 + 26.5, HERO.az + 2.5, HERO.el - 1.2, 3.75),
      K(t0 + 30.5, HERO.az + 0.5, 9, 1.16),
      K(t0 + 36, HERO.az, -1.5, 1.105),
      K(b.t1, 0, 0, 3.2),
    ];
    // pull straight up off the skim (radially): the Sun recedes below, the departure looks back at it
    const lastDir = dirAE('sun', t0 + 36, HERO.az, -1.5);
    const ex = exitDir('sun', b.t1, lastDir, 0.08);
    const exAE = ae('sun', ex, b.t1);
    Object.assign(keys[keys.length - 1], { az: exAE.az, el: exAE.el });
    mk(id, { keys, outRate: 0.55 });

    chapter('intro', 'Cold open', 0);
    chapter('sun', 'The Sun', t0 + 13, 'sun');
    key('fade', 0, 1); key('fade', 1.2, 1); key('fade', 7.5, 0);
    key('letterbox', 0, 1); key('letterbox', 13.5, 1); key('letterbox', 17.5, 0);
    key('sky', 0, 1.15); key('sky', 9, 1.15); key('sky', 14, 0.5); key('sky', t0 + 38.8, 0.4);
    key('ev', 0, 0.2); key('ev', 9.3, 0.2); key('ev', 14.2, EV.sunWide); key('ev', t0 + 15, EV.sunWide); key('ev', t0 + 22, EV.sun); key('ev', t0 + 28, EV.sun); key('ev', t0 + 31.5, EV.sunSkim); key('ev', t0 + 36.5, EV.sunSkim); key('ev', t0 + 39, EV.sun);
    key('fov', 0, 44); key('fov', 9, 40); key('fov', 14, 30); key('fov', t0 + 16, 31); key('fov', t0 + 22, 40); key('fov', t0 + 26.5, 38); key('fov', t0 + 31, 64); key('fov', t0 + 36, 66); key('fov', b.t1 + 0.5, 50);
    key('roll', 0, -3); key('roll', 12, 0); key('roll', t0 + 31, 0); key('roll', t0 + 34, -4); key('roll', t0 + 36.5, 2); key('roll', t0 + 39.5, 0);
    key('intensity', 0, 0.15); key('intensity', 12, 0.55); key('intensity', t0 + 30, 0.75); key('intensity', b.t1, 0.6);
    aim(0, { dir: openDir }, 0);
    aim(6.0, 'sun', 9, undefined, 'cruise');
    plan.freeFrame.push({ t0: 0, t1: 15.2 }); // the cold open looks at the Milky Way; the pan reveals the Sun
    const south = { rel: 'sun', v: dirAE('sun', t0 + 34, HERO.az, -55).multiplyScalar(R) };
    aim(t0 + 26.8, { horizon: 'sun', toward: south, below: 13 }, 5.2, { radial: 'sun' });
    // pull up and look back: as the camera climbs off the photosphere it tilts down over the limb it was skimming,
    // so the horizon curves into a limb with its prominences and the whole disc recedes below; only once the
    // disc is a small part of the frame does the view swing round to Mercury (the exposure follows: a held
    // Sun exposure never blacks out a frame without the Sun)
    aim(t0 + 34.8, { mix: [['sun', 0.42], [{ horizon: 'sun', toward: south, below: 4 }, 0.58]] }, 2.4, { radial: 'sun' });
    // looking back at the whole disc as it recedes, then the cut to Mercury's point of light
    // (up = the skim's heading, ecliptic south: the pull-up is then a pure pitch down onto the disc, no roll)
    aim(t0 + 37.2, 'sun', 3.6, { dir: V3(0, -1, 0) }, 'cruise');
    legCut('sun', 'mercury', { fov: [50, 46], ev: [EV.sun, EV.planet], sky: [0.4, 0.9] });
    focus(0, 'sun');
    cue(3, 'title', 6);
    cue(10.5, 'sun-reveal', 3);
    cue(t0 + 30, 'sun-skim', 8);
    caption(2.5, 10, { kind: 'title', title: 'FOUR LIGHT-HOURS', subtitle: 'A journey from the Sun past every planet, true to scale', lines: [`Planets placed where they are on ${dateStr}`] });
    const f = BODIES.sun.facts;
    caption(t0 + 15, t0 + 23, { kind: 'body', id: 'sun', title: 'The Sun', subtitle: `${f.diameter} across`, lines: [`Surface ${f.surface} · core ${f.core}`, `${f.mass}`] });
    caption(t0 + 31, t0 + 38, { kind: 'note', title: 'The photosphere', lines: ['Each granule is a column of rising gas the size of a country, lasting minutes'] });
    // keep the open direction for the validation harness
    S.sun.openDir = openDir;
  }

  // ============================================================================================ 2 MERCURY
  {
    const id = 'mercury', b = S.mercury, t0 = b.t0;
    const arr = ae(id, natArr(id, t0), t0);
    const keys = [
      K(t0, arr.az, arr.el, 650),
      K(t0 + 5.5, 80, -2, 13),
      K(t0 + 9.2, 98, -14, 1.95),
      K(t0 + 11.5, 89, -8, 1.17),
      K(t0 + 14.5, 87.5, 14, 1.085),
      K(t0 + 16.4, 89, 23, 1.55),
      K(b.t1, 0, 0, 19),
    ];
    // climb away radially: the half-lit globe recedes in place
    const ex = exitDir(id, b.t1, dirAE(id, t0 + 16.4, 89, 23), 0.08);
    const ea = ae(id, ex, b.t1);
    Object.assign(keys[keys.length - 1], { az: ea.az, el: ea.el });
    mk(id, { keys, radialIn: true, inRate: 0.62, outRate: 0.6 });
    chapter('mercury', 'Mercury', S.sun.t1, 'mercury', ['sun']);
    key('sky', t0 + 6, 0.6);
    key('fov', t0, 38); key('fov', t0 + 5.5, 36); key('fov', t0 + 9, 44); key('fov', t0 + 11.5, 56); key('fov', t0 + 14.5, 58); key('fov', t0 + 17, 50); key('fov', b.t1 + 0.6, 42);
    key('roll', t0 + 9, 0); key('roll', t0 + 12, 5); key('roll', t0 + 14.5, -3); key('roll', b.t1, 0);
    key('intensity', t0, 0.5); key('intensity', t0 + 11, 0.7); key('intensity', b.t1, 0.5);
    // half-lit, the view leaning toward the Sun (beyond the frame edge, inside post's edge-glare range, the flare
    // lifted for it): a composition, not a direction mix, so the disc sits at a fixed place in the frame at any
    // size and never slides off the edge
    aim(t0 + 4.2, { place: 'mercury', from: 'sun', off: 0.3 }, 4.0, undefined, 'cruise');
    aim(t0 + 8.2, { place: 'mercury', from: 'sun', off: 0.42 }, 2.3);
    key('flare', t0 + 4.5, 1); key('flare', t0 + 7.5, 1.5); key('flare', t0 + 10.5, 1.5); key('flare', t0 + 13, 1);
    const meAhead = { rel: id, v: dirAE(id, t0 + 13, 87, 62).multiplyScalar(W.radius(id)) };
    aim(t0 + 10.5, { horizon: 'mercury', toward: meAhead, below: 9 }, 2.5);
    aim(t0 + 14.6, 'mercury', 2.5);
    legCut('mercury', 'venus', { fov: [42, 46], sky: [0.6, 0.9] });
    cue(t0, 'arrive', 2);
    const f = BODIES.mercury.facts;
    caption(t0 + 2.5, t0 + 10.5, { kind: 'body', id, title: 'Mercury', subtitle: `${(W.positions.mercury.length() / AU).toFixed(2)} AU from the Sun · sunlight takes ${fmtLightTime(lightTime(id))}`, lines: [`A solar day lasts ${f.day.replace(' (solar day)', '')}`, `${f.temperature}`] });
  }

  // ============================================================================================ 3 VENUS
  {
    const id = 'venus', b = S.venus, t0 = b.t0;
    const arr = ae(id, natArr(id, t0), t0);
    const keys = [
      K(t0, arr.az, arr.el, 650),
      K(t0 + 5.5, 26, 12, 7),
      K(t0 + 8.5, 34, 7, 1.55),
      K(t0 + 11.8, 98, 9, 2.2),
      K(t0 + 15.0, 156, 6, 7.4),
      K(t0 + 17.0, 158, 6, 8.8),
      K(b.t1, 0, 0, 24),
    ];
    // the crescent recedes in place (radially), then the cut to Earth
    const ex = exitDir(id, b.t1, dirAE(id, t0 + 17.0, 158, 6), 0.06);
    const ea = ae(id, ex, b.t1);
    Object.assign(keys[keys.length - 1], { az: ea.az, el: ea.el });
    mk(id, { keys, radialIn: true, inRate: 0.6, outRate: 0.6 });
    chapter('venus', 'Venus', S.mercury.t1, 'venus', ['mercury']);
    // (the crescent beat a stop over the day deck: its forward-scattering limb is a thin bright line that blooms)
    key('ev', t0 + 2, EV.planet); key('ev', t0 + 6, EV.venus); key('ev', t0 + 11.5, EV.venus); key('ev', t0 + 14.2, EV.venusCrescent); key('ev', b.t1, EV.venusCrescent);
    key('sky', t0 + 2, 0.6); key('sky', t0 + 12, 0.45); key('sky', t0 + 15, 0.7);
    hold(t0 + 15.4, t0 + 18.4); // the crescent
    // (the Sun stands just beyond the frame edge in the crescent beat: a calmer lens system under the +1.3 EV)
    key('flare', t0 + 12, 1); key('flare', t0 + 15, 0.6);
    key('fov', t0, 38); key('fov', t0 + 5.5, 36); key('fov', t0 + 8.5, 48); key('fov', t0 + 11.8, 46); key('fov', t0 + 15.0, 24); key('fov', t0 + 15.6, 25); key('fov', b.t1, 22);
    key('roll', t0 + 8, 0); key('roll', t0 + 11.5, -6); key('roll', t0 + 14.5, 4); key('roll', b.t1, 0);
    key('intensity', t0, 0.45); key('intensity', t0 + 14, 0.6);
    aim(t0 + 7.5, { mix: [['venus', 0.7], [{ horizon: 'venus', toward: 'sun', below: 0 }, 0.3]] }, 2.5);
    aim(t0 + 11, 'venus', 3);
    legCut('venus', 'earth', { fov: [22, 46], ev: [EV.venusCrescent, EV.planet], sky: [0.7, 0.9], flare: 1 });
    cue(t0, 'arrive', 2);
    const f = BODIES.venus.facts;
    caption(t0 + 3, t0 + 11, { kind: 'body', id, title: 'Venus', subtitle: `Sunlight takes ${fmtLightTime(lightTime(id))}`, lines: [`${f.temperature} — hotter than Mercury`, `Surface pressure ${f.pressure}`, `${f.day}`] });
  }

  // ============================================================================================ 4 EARTH
  let tSunrise = 0;
  {
    const id = 'earth', b = S.earth, t0 = b.t0;
    const arr = ae(id, natArr(id, t0), t0);
    const keys = [
      K(t0, arr.az, arr.el, 700),
      K(t0 + 7, E_APP.az + 6, E_APP.el, 22),
      K(t0 + E_APP.tau, E_APP.az, E_APP.el, 4.3),
      K(t0 + 16.5, E_APP.az - 9, E_APP.el - 2, 3.5),
      K(t0 + 21, -92, 19, 1.6),
      K(t0 + 24, -136, 21, 1.16),
      K(t0 + 29.6, -114, 20, 1.063, { laRate: 0 }),
      K(b.t1, 0, 0, 1.078),
    ];
    // after the low point the orbit simply continues at the same angular pace, barely climbing (the cut to the Moon
    // comes ~1 s after the Sun's centre clears the limb, with the Sun still on the horizon; a faster exit swept the
    // camera across the terminator onto the day side within a second)
    const ea = { az: -114 + 5.5, el: 20 };
    Object.assign(keys[keys.length - 1], { az: ea.az, el: ea.el });
    // (a gentle exit rate: a steep one made the ln-altitude spline dip below the 400 km pass before climbing)
    const blk = mk(id, { keys, radialIn: true, inRate: 0.58, outRate: 0.08, azMode: 'pchip' });
    // sunrise: Sun centre crosses the limb as seen from the camera
    for (let t = t0 + 24; t < b.t1; t += 0.02) {
      const P = blk.position(t), E = apos(id, t);
      const n = P.clone().sub(E);
      const r = n.length();
      const toSun = P.clone().negate().normalize();
      const dip = Math.acos(1 / (r / W.radius(id)));
      const elevSun = Math.asin(clamp(toSun.dot(n.normalize()), -1, 1));
      if (elevSun > -dip) {
        tSunrise = t;
        break;
      }
    }
    if (!tSunrise) tSunrise = t0 + 29;
    // the cut to the Moon: the Sun just clear of the limb, the flare building, then the dip; after it the camera
    // comes straight in toward the Moon's far side (radialB), the Moon swelling from a point at the frame centre
    b.cut = b.dwell = clamp(tSunrise + 1.0 - b.t1, 0.3, b.leg - 3.6);
    b.cutOpts = { radialB: true };
    chapter('earth', 'Earth & Moon', S.venus.t1, 'earth', ['venus']);
    key('ev', t0 + 3, EV.planet); key('ev', t0 + 19, 0.15); key('ev', t0 + 23.5, EV.night); key('ev', tSunrise - 0.6, EV.night); key('ev', tSunrise + 1.3, 0.2);
    key('sky', t0, 0.7); key('sky', t0 + 10, 0.45); key('sky', t0 + 23, 0.25); key('sky', tSunrise + 1, 0.15);
    key('fov', t0, 38); key('fov', t0 + 7, 34); key('fov', t0 + E_APP.tau, 35); key('fov', t0 + 16.5, 36); key('fov', t0 + 21, 50); key('fov', t0 + 24, 60); key('fov', tSunrise, 58);
    key('roll', t0 + 16, 0); key('roll', t0 + 21, -10); key('roll', t0 + 25, 4); key('roll', tSunrise, 0);
    key('intensity', t0, 0.55); key('intensity', t0 + E_APP.tau, 0.75); key('intensity', t0 + 24, 0.45); key('intensity', tSunrise, 0.95); key('intensity', b.t1, 0.6);
    aim(t0 + 19, { mix: [['earth', 0.55], [{ horizon: 'earth', toward: 'sun', below: 0 }, 0.45]] }, 3);
    // the night pass looks along the horizon toward the coming dawn; the Sun rises over the limb in that view
    aim(t0 + 23.2, { horizon: 'earth', toward: 'sun', below: -5 }, 2.2, { radial: 'earth' });
    // from the sunrise on, the view holds the direction it had (the limb falls away as the camera climbs; no pitch)
    {
      const P = blk.position(tSunrise), E = apos(id, tSunrise);
      const n = P.clone().sub(E).normalize();
      const sr = P.clone().negate().normalize().addScaledVector(n, -0.09).normalize();
      aim(tSunrise - 0.2, { dir: sr }, 1.0, { dir: n });
    }
    cue(t0, 'arrive', 2); cue(tSunrise - 0.3, 'sunrise', 3);
    const f = BODIES.earth.facts;
    caption(t0 + 4, t0 + 13, { kind: 'body', id, title: 'Earth', subtitle: `${(W.positions.earth.length() / AU).toFixed(3)} AU · sunlight takes ${fmtLightTime(lightTime(id))}`, lines: [f.life] });
    caption(t0 + 24.5, tSunrise - 0.5, { kind: 'note', title: 'Night side', lines: ['400 km up — a low orbit sees a sunrise every 90 minutes'] });
    // the Moon from the Earth side: its point of light at the frame centre, swelling at a constant apparent rate
    // (up: toward the Earthward limb, so the descent that follows is a pure pitch up to the horizon ahead)
    const eM = apos('earth', S.moon.t0 + RISE.tau0).sub(apos('moon', S.moon.t0 + RISE.tau0)).normalize();
    legCut('earth', 'moon', { fov: [58, 40], ev: [0.2, EV.moon], sky: [0.15, 0.5], flare: 1, up: { dir: eM } });
  }

  // ============================================================================================ 4b THE MOON — EARTHRISE
  let tRise0 = 0, tRise1 = 0;
  {
    const id = 'moon', b = S.moon, t0 = b.t0, Rm = W.radius('moon');
    tRise0 = t0 + RISE.tau0;
    tRise1 = t0 + RISE.tau1;
    const tm = (tRise0 + tRise1) / 2;
    const Mo = apos('moon', tm), Ea = apos('earth', tm);
    const e = Ea.clone().sub(Mo).normalize();
    const s = Mo.clone().negate().normalize();
    const w1 = s.clone().addScaledVector(e, -s.dot(e));
    if (w1.lengthSq() < 1e-8) w1.set(0, 1, 0).addScaledVector(e, -e.y);
    w1.normalize();
    const w2 = e.clone().cross(w1).normalize();
    const alt = 12 / KM_PER_UNIT / Rm; // 12 km
    const dist = 1 + alt;
    const dip = Math.acos(1 / dist) / DEG;
    const gS = dip + 1.15, gE = dip - 3.1;
    // the Sun 10 deg up behind the camera's ground track: long shadows carve the lunar relief
    const sunElev = 10 * DEG;
    function cAt(gDeg) {
      const g = gDeg * DEG;
      let ct = (Math.sin(sunElev) + Math.sin(g) * s.dot(e)) / (Math.cos(g) * Math.max(1e-3, s.dot(w1)));
      ct = clamp(ct, -1, 1);
      const th = Math.acos(ct);
      return e.clone().multiplyScalar(-Math.sin(g)).addScaledVector(w1.clone().multiplyScalar(Math.cos(th)).addScaledVector(w2, Math.sin(th)), Math.cos(g)).normalize();
    }
    const cS = cAt(gS), cE = cAt(gE);
    // arrive over the far side and descend toward the Earth-facing limb, always moving toward it (Apollo 8 coming
    // round the Moon): the horizon ahead is the Earthward horizon, so the camera only ever looks ahead and down,
    // and Earth rises over the horizon it is flying toward (no 180-degree pan from "ahead" to "Earthward")
    // (the cut from Earth resumes on this line, straight in toward the far side: see the Earth -> Moon leg)
    const entry = cAt(gS + 52);
    // pull back to just off the Earth-Moon line, behind the Moon: Moon in front, Earth beyond, both gibbous
    const back = slerpDir(e.clone().negate(), cE, 0.2, V3(), ECL);
    const keys = [
      KD(t0, id, entry, 16),
      KD(t0 + 3.2, id, cAt(gS + 30), 2.3),
      KD(t0 + 5.8, id, cAt(gS + 9), 1.03),
      KD(tRise0, id, cS, dist),
      KD(tRise1, id, cE, dist),
      KD(t0 + 20.4, id, slerpDir(cE, back, 0.12, V3()), 1.08),
      KD(t0 + 23.6, id, slerpDir(cE, back, 0.8, V3()), 6.5),
      KD(b.t1, id, back, 10),
    ];
    const blkM = mk(id, { keys, inRate: 0.62, outRate: 0.55, azMode: 'pchip' });
    // field of view that holds the Moon and Earth together (85% of the frame) on the pull-back
    const pairFov = (t) => {
      const P = blkM.position(t), d = clock(t);
      const A = W.pos('moon', d, V3()).sub(P), B = W.pos('earth', d, V3()).sub(P);
      const rA = Math.asin(Math.min(1, Rm / A.length())), rB = Math.asin(Math.min(1, W.radius('earth') / B.length()));
      const th = A.angleTo(B);
      const ext = (th + rA + rB) / 2;
      // (radial up: the Moon sits below Earth, so the pair is fitted vertically, inside 82% of the frame height)
      return clamp((2 * Math.atan(Math.tan(ext) / 0.82)) / DEG, 24, 64);
    };
    key('ev', t0 + 4, EV.moon); key('ev', tRise1, EV.moon); key('ev', b.t1, 0.25);
    key('sky', t0 + 5, 0.55); key('sky', tRise1, 0.55);
    key('fov', t0, 40); key('fov', t0 + 3.2, 46); key('fov', t0 + 7.4, 30); key('fov', tRise0 + 0.6, 11); key('fov', tRise1, 9.5); key('fov', t0 + 20.4, 30); key('fov', t0 + 23.3, pairFov(t0 + 23.6)); key('fov', t0 + 24.3, pairFov(t0 + 24.3)); key('fov', b.t1 + 1, pairFov(t0 + 24.3) * 0.85);
    key('letterbox', t0 + 5, 0); key('letterbox', t0 + 7.5, 1); key('letterbox', tRise1 + 0.5, 1); key('letterbox', tRise1 + 3, 0);
    key('roll', tRise0 - 1.5, 0); key('roll', tRise0, -7); key('roll', tRise1, -5); key('roll', t0 + 20.4, 0);
    key('pitch', tRise0 - 1.5, 0); key('pitch', tRise0, -1.6); key('pitch', tRise1, -1.0); key('pitch', t0 + 20.4, 0);
    key('intensity', t0, 0.5); key('intensity', tRise0, 0.6); key('intensity', tRise1, 1.0); key('intensity', b.t1, 0.6);
    // descending over the far side: tilt from the Moon's disc to the horizon ahead (the Earthward horizon)
    // (looking down at the terrain ahead while high: Earth, still above the limb from up there, stays above the
    // frame; the view levels out only once the camera is low enough that Earth has sunk below the horizon)
    const towardE = { rel: 'moon', v: e.clone().multiplyScalar(3 * Rm) };
    aim(t0 + 1.5, { horizon: 'moon', toward: towardE, below: 25 }, 3.5, { radial: 'moon' });
    // (levelled only to 6 deg below the horizon: Earth must not peek over it before the authored rise)
    aim(t0 + 5.0, { horizon: 'moon', toward: towardE, below: 6 }, 2.2, { radial: 'moon' });
    aim(tRise0 - 0.6, 'earth', 1.2, { radial: 'moon' });
    // pull back with Earth hanging over the lunar limb: aim between Earth and the limb point beneath it, the local
    // vertical kept as up (no roll), the field opened to hold both (pairFov)
    aim(tRise1 + 0.5, { mix: [['earth', 0.5], [{ horizon: 'moon', toward: 'earth', below: 0 }, 0.5]] }, 3.6, { radial: 'moon' });
    // (up frozen at the lunar vertical of the Earthrise site: receding straight behind the Moon, its live radial
    // direction would turn into the view axis)
    aim(t0 + 22.4, { pair: ['moon', 'earth'] }, 2.4, { dir: cE.clone() });
    focus(tRise0 - 1, 'earth');
    // leaving: the pair recedes together (the Moon in front, Earth beyond), then the cut to Mars
    legCut('moon', 'mars', { fov: [pairFov(t0 + 24.3) * 0.85, 46], ev: [0.25, EV.planet], sky: [0.55, 0.85] });
    cue(tRise0 + 1.5, 'earthrise', 6);
    const f = BODIES.earth.moons.moon.facts;
    caption(t0 + 0.3, t0 + 8.3, { kind: 'body', id, title: 'The Moon', subtitle: `${f.distance} from Earth · ${f.lightTime} at the speed of light`, lines: [`${f.diameter} across`] });
    caption(tRise0 + 2, tRise1 + 1.5, { kind: 'note', title: 'Earthrise', lines: ['First seen by human eyes from Apollo 8, 24 December 1968'] });
  }

  // ============================================================================================ 5 MARS + PHOBOS
  {
    const id = 'mars', b = S.mars, t0 = b.t0, Rm = W.radius('mars');
    const arr = ae(id, natArr(id, t0), t0);
    // latitude: tilt the approach so the sub-camera point sits near Valles Marineris' latitude (-8)
    let elApp = 0;
    {
      const q = new THREE.Quaternion();
      const tApp = t0 + M_APP.tau;
      let bestE = 1e9;
      for (let el = -25; el <= 25; el += 0.5) {
        const dir = dirAE(id, tApp, M_APP.az, el);
        bodyQuaternion('mars', clock(tApp), q).invert();
        const l = dir.applyQuaternion(q);
        const lat = Math.asin(clamp(l.y, -1, 1)) / DEG;
        if (Math.abs(lat + 6) < bestE) {
          bestE = Math.abs(lat + 6);
          elApp = el;
        }
      }
    }
    // Phobos crossing: camera flies with Phobos (co-orbiting), a few hundred km above and behind it, and
    // drifts past so Phobos slides across the face of Mars.
    const phKeys = [];
    const t0p = t0 + PHO.tau0, t1p = t0 + PHO.tau1;
    for (let t = t0p; t <= t1p + 1e-6; t += 0.5) {
      const u = (t - t0p) / (t1p - t0p);
      const d = clock(t);
      const p = W.moonFns.phobos.fn(d, V3());
      const p2 = W.moonFns.phobos.fn(d + 1e-4, V3());
      const rh = p.clone().normalize();
      const th = p2.clone().sub(p);
      th.addScaledVector(rh, -th.dot(rh)).normalize();
      const nh = rh.clone().cross(th).normalize();
      const X = 0.075 - 0.15 * u, Y = 0.085 + 0.01 * Math.sin(Math.PI * u), Z = 0.012;
      const off = rh.clone().multiplyScalar(Y * Rm).addScaledVector(th, -X * Rm).addScaledVector(nh, Z * Rm);
      const P = p.add(off); // relative to Mars
      const dist = P.length() / Rm;
      const a = ae(id, P.normalize(), t);
      phKeys.push(K(t, a.az, a.el, dist));
    }
    const pFirst = phKeys[0], pSecond = phKeys[1];
    // the approach key sits on the far side of the co-orbit's motion (az / el keep turning the same way through the
    // junction), and the first co-orbit key carries the co-orbit's own rates: no stop-and-reverse at the hand-over
    const rAz = (pSecond.az - pFirst.az) / 0.5, rEl = (pSecond.el - pFirst.el) / 0.5;
    const dtJ = t0p - (t0 + M_APP.tau);
    const azApp = pFirst.az - rAz * dtJ * 0.8, elApp2 = Math.abs(rEl) > 1e-3 ? pFirst.el - rEl * dtJ * 0.8 : elApp;
    Object.assign(pFirst, { azRate: rAz, elRate: rEl });
    const keys = [
      K(t0, arr.az, arr.el, 700),
      K(t0 + 5.5, (M_APP.az - 6 + azApp) / 2, (elApp * 0.6 + elApp2) / 2, 16),
      K(t0 + M_APP.tau, azApp, elApp2, 3.6),
      ...phKeys,
    ];
    // after Phobos: up over the sunlit pole, then out to the limb for the dusty haze
    const sunPoleSign = sunElevOverEquator('mars') >= 0 ? 1 : -1;
    const pLast = phKeys[phKeys.length - 1];
    keys.push(K(t1p + 2.8, pLast.az + 14, sunPoleSign * 36, 3.0));
    keys.push(K(t1p + 5.6, pLast.az + 50, sunPoleSign * 18, 2.2));
    const lastDir = dirAE(id, t1p + 5.6, pLast.az + 50, sunPoleSign * 18);
    // leave radially from the limb framing: the globe recedes in place
    const ex = exitDir(id, b.t1, lastDir, 0.08);
    keys.push(KD(b.t1, id, ex, 16));
    mk(id, { keys, radialIn: true, inRate: 0.6, outRate: 0.6 });
    chapter('mars', 'Mars', S.moon.t1, 'mars', ['earth', 'moon']);
    key('ev', b.t1, EV.planet);
    key('sky', t0 + 5, 0.5);
    key('fov', t0, 38); key('fov', t0 + M_APP.tau, 35); key('fov', t0p, 48); key('fov', (t0p + t1p) / 2, 52); key('fov', t1p, 49); key('fov', t1p + 2.8, 50); key('fov', t1p + 5.6, 54); key('fov', b.t1 + 0.5, 44);
    key('roll', t0p - 1, 0); key('roll', t0p + 1, 6); key('roll', t1p, -4); key('roll', t1p + 2.8, 0);
    key('intensity', t0, 0.55); key('intensity', t0p, 0.7); key('intensity', t1p, 0.75); key('intensity', b.t1, 0.55);
    // during the crossing aim at a fixed point between Mars' centre and Phobos' mid-crossing position
    const tpm = (t0p + t1p) / 2;
    const phMid = apos('phobos', tpm);
    // during the crossing aim at a 70/30 mix of Mars' centre and Phobos itself (live: it co-orbits with the camera,
    // so its direction drifts slowly), never at a fixed point the camera flies close past
    void phMid;
    aim(t0p - 2.4, { mix: [['mars', 0.7], ['phobos', 0.3]] }, 3.0, undefined, 'cruise');
    aim(t1p - 0.6, 'mars', 3.6, undefined, 'cruise');
    // (Phobos is the HUD's target here, but the composition is Mars with Phobos sliding across it: no safe-frame pull)
    plan.freeFrame.push({ t0: t0p - 0.5, t1: t1p + 0.5 });
    // the limb: the disc slides down so its dusty edge stands against space
    aim(t1p + 3.6, { mix: [['mars', 0.6], [{ horizon: 'mars', toward: 'sun', below: 0 }, 0.4]] }, 2.4);
    aim(t1p + 6.3, 'mars', 2.6);
    focus(t0p - 0.5, 'phobos');
    focus(t1p + 0.5, 'mars');
    cue(t0, 'arrive', 2); cue(t0p + 1, 'phobos', 4);
    // (not a hold: the fluid head smooths this beat like any other, so the pass never lurches)
    const f = BODIES.mars.facts;
    caption(t0 + 2.5, t0 + 10.5, { kind: 'body', id, title: 'Mars', subtitle: `Sunlight takes ${fmtLightTime(lightTime(id))}`, lines: ['Valles Marineris: 4,000 km long, up to 7 km deep', `Highest peak: ${f.highest}`] });
    caption(t0p + 0.5, t1p + 0.5, { kind: 'note', title: 'Phobos', lines: ['22 km across, 6,000 km above Mars — it circles three times a day'] });
  }

  // ============================================================================================ 6 ASTEROID BELT
  // Fly down the axis of the asteroid builder's swarm (+-60 units long): arrive fast past the vanguard, brake to a
  // long glide through the set pieces near s = 0, the view swinging from the path to a side-lit direction (~95 deg
  // from the Sun: every rock shaded across its terminator), then to a backlit one (~38 deg from the Sun, the Sun
  // just above the frame: rims and forward-scattering dust). The glide ends inside the field; the cut to Jupiter
  // follows.
  {
    const b = S.belt, t0 = b.t0;
    const F = opts.beltField || { halfLength: 60, tail: 22, recommendedSpeed: 0.25 };
    const X = F.halfLength + F.tail - 2; // 80
    const vg = (F.recommendedSpeed ?? 0.25) * 1.3;
    const X1 = 8;
    const xKeys = [
      { t: t0, v: -X, m: 30 },
      { t: t0 + 2, v: -22, m: 12 },
      { t: t0 + 4, v: -6, m: 2.2 },
      { t: t0 + 6, v: -2.4, m: vg },
      { t: t0 + 16, v: 0.9, m: vg },
      { t: t0 + 19, v: 3.0, m: 1.2 },
      { t: b.t1, v: X1, m: 3.2 },
    ];
    const fly = new FlyBlock(rig, { anchorPos: belt.position, dir: belt.direction, t0, t1: b.t1, X, X1, vIn: 30, vOut: 3.2, xKeys, lateral: { side: 0.06, up: 0.03 } });
    blocks.belt = rig.add(fly);
    const u = belt.direction.clone(), sd = belt.position.clone().negate().normalize();
    const uSun = Math.acos(clamp(u.dot(sd), -1, 1)) / DEG; // the path's angle from the Sun (~150 deg: outward)
    const toward = (deg) => slerpDir(sd, u, clamp(deg / Math.max(1, uSun), 0, 1), V3());
    const sculpt = toward(Math.min(95, uSun)), sunward = toward(38);
    chapter('asteroids', 'The Asteroid Belt', S.mars.t1, undefined, ['mars']);
    key('ev', t0 + 1, EV.belt); key('ev', t0 + 12.5, EV.belt); key('ev', t0 + 18, 0.6); key('ev', b.t1 + 0.4, 0.6);
    key('sky', t0 + 2, 0.9); key('sky', b.t1, 0.9);
    key('fov', t0, 56); key('fov', t0 + 5, 58); key('fov', t0 + 13, 54); key('fov', t0 + 19, 54);
    key('roll', t0, 0); key('roll', t0 + 4, 5); key('roll', t0 + 9, -3); key('roll', t0 + 13, 0);
    key('intensity', t0, 0.8); key('intensity', t0 + 6, 0.55); key('intensity', t0 + 13, 0.6); key('intensity', b.t1, 0.75);
    legCut('mars', { dir: u.clone() }, { focus: 'asteroids', fov: [44, 54], sky: [0.5, 0.85] });
    aim(t0 + 2.5, { dir: sculpt }, 6.5, 'ecl', 'cruise');
    aim(t0 + 12.5, { dir: sunward }, 6.5, { dir: sd.clone() }, 'cruise');
    legCut('belt', 'jupiter', { up: { pole: 'jupiter' }, fov: [54, 44], ev: [0.6, EV.planet], sky: [0.9, 0.85] });
    cue(t0, 'belt', b.t1 - t0);
    caption(t0 + 1.5, t0 + 9.5, { kind: 'body', id: 'asteroids', title: 'The Asteroid Belt', subtitle: '2.7 AU from the Sun', lines: ['Millions of rocks — yet typically a million kilometres apart', 'Shown here far denser than it really is'] });
    caption(t0 + 18.6, b.t1 + 0.2, { kind: 'note', title: 'Looking sunward', lines: ['Rocks from 1 to 200 km across, lit from behind by a Sun seven times fainter than at Earth'] });
  }

  // ============================================================================================ 7 JUPITER
  {
    const id = 'jupiter', b = S.jupiter, t0 = b.t0, up = W.pole('jupiter');
    const arr = ae(id, natArr(id, t0), t0, up);
    // Galilean moons strung out: camera near the equatorial plane; pick the azimuth that spreads them best
    const tMoons = t0 + 7.5;
    let azM = 18, bestSep = -1;
    for (let az = 6; az <= 40; az += 1) {
      const P = apos(id, tMoons).add(dirAE(id, tMoons, az, 1.5, up).multiplyScalar(80 * W.radius(id)));
      const pts = ['jupiter', 'io', 'europa', 'ganymede', 'callisto'].map((m) => apos(m, tMoons).sub(P).normalize());
      let minSep = 1e9;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) minSep = Math.min(minSep, Math.acos(clamp(pts[i].dot(pts[j]), -1, 1)) / DEG);
      if (minSep > bestSep) {
        bestSep = minSep;
        azM = az;
      }
    }
    const keys = [
      K(t0, arr.az, arr.el, 900),
      K(t0 + 6.3, azM - 3, 2.5, 92),
      K(t0 + 9.5, azM, 1.5, 72),
      K(t0 + J_HOLD.tau0, J_HOLD.az - 3, J_HOLD.el - 1, J_HOLD.dist + 0.35),
      K(t0 + J_HOLD.tau1, J_HOLD.az + 4, J_HOLD.el + 1, J_HOLD.dist - 0.15),
      K(t0 + 24.5, 38, 11, 1.32),
      K(t0 + 28.5, 62, 9, 1.075),
      K(t0 + 31.8, 76, 8, 1.85), // climbing off the skim toward the terminator
      K(t0 + 35.0, 94, 7, 3.6), // the half-lit globe, the terminator down its middle, receding
      K(b.t1, 0, 0, 8.5),
    ];
    const ex = exitDir(id, b.t1, dirAE(id, t0 + 35.0, 94, 7, up), 0.06);
    const ea = ae(id, ex, b.t1, up);
    Object.assign(keys[keys.length - 1], { az: ea.az, el: ea.el });
    mk(id, { keys, radialIn: true, up, inRate: 0.6, outRate: 0.6 });
    chapter('jupiter', 'Jupiter', S.belt.t1, 'jupiter', []);
    key('ev', t0, EV.planet); key('ev', b.t1, EV.planet);
    key('sky', t0 + 4, 0.75); key('sky', t0 + 12, 0.45); key('sky', b.t1, 0.55);
    key('fov', t0, 36); key('fov', t0 + 5.5, 30); key('fov', t0 + 9.5, 32); key('fov', t0 + J_HOLD.tau0, 36); key('fov', t0 + J_HOLD.tau1, 34); key('fov', t0 + 24.5, 52); key('fov', t0 + 28.5, 60); key('fov', t0 + 31.6, 54); key('fov', t0 + 35, 42); key('fov', b.t1 + 1, 36);
    key('roll', t0 + 22, 0); key('roll', t0 + 26, -8); key('roll', t0 + 29, 6); key('roll', t0 + 32, 0);
    key('intensity', t0, 0.6); key('intensity', t0 + 10, 0.55); key('intensity', t0 + 28, 0.9); key('intensity', b.t1, 0.6);
    aim(t0 + 4, { mix: [['jupiter', 0.75], ['ganymede', 0.1], ['callisto', 0.15]] }, 3, { pole: 'jupiter' });
    aim(t0 + 10, 'jupiter', 3, { pole: 'jupiter' });
    const juAhead = { rel: id, v: dirAE(id, t0 + 28, 152, 7, up).multiplyScalar(W.radius(id)) };
    aim(t0 + 22.5, { horizon: 'jupiter', toward: juAhead, below: 10 }, 3, { radial: 'jupiter' });
    // climbing over the terminator into the night: keep the sunlit limb in view (a growing crescent), not the
    // black night side under the camera
    // climbing off the skim, the view pitches down from the horizon ahead onto the globe (one pitch: up = the
    // direction of travel) as the camera rises toward the terminator: the half-lit globe recedes below (crossing
    // onto the night side here filled the frame with black; turning round to the sunward limb is a whip)
    const ahead = dirAE(id, t0 + 30, 77, 8, up).sub(dirAE(id, t0 + 30, 76, 8, up)).normalize();
    // (the view leans toward the Sun, so the thin lit crescent sits inside the frame rather than on its bottom edge)
    aim(t0 + 29.8, { place: 'jupiter', from: 'sun', off: 0.2 }, 5.0, { dir: ahead }, 'cruise');
    labels(t0 + 5, t0 + 11.5, ['io', 'europa', 'ganymede', 'callisto'], 'moon');
    legCut('jupiter', 'saturn', { up: { pole: 'saturn' }, fov: [36, 44], sky: [0.55, 0.85] });
    cue(t0, 'arrive', 2); cue(t0 + J_HOLD.tau0, 'io-shadow', 5); cue(t0 + 26, 'jupiter-skim', 5);
    const f = BODIES.jupiter.facts;
    caption(t0 + 4, t0 + 12, { kind: 'body', id, title: 'Jupiter', subtitle: `Sunlight takes ${fmtLightTime(lightTime(id))}`, lines: ['Io, Europa, Ganymede and Callisto — found by Galileo in 1610', `${f.storm}`] });
    hold(t0 + J_HOLD.tau0 + 0.5, t0 + J_HOLD.tau1 - 1.5);
    caption(t0 + J_HOLD.tau0 + 0.5, t0 + J_HOLD.tau1, { kind: 'note', title: "Io's shadow", lines: ['A total solar eclipse 3,600 km wide, sliding across the cloud tops'] });
  }

  // ============================================================================================ 8 SATURN
  let tShadow = 0;
  {
    const id = 'saturn', b = S.saturn, t0 = b.t0, up = W.pole('saturn');
    const B = sunElevOverEquator('saturn');
    const sB = B >= 0 ? 1 : -1;
    const arr = ae(id, natArr(id, t0), t0, up);
    const eclEl = -B - sB * 5.5; // in the shadow, on the unlit side of the rings (close to the axis: a long stay)
    const keys = [
      K(t0, arr.az, arr.el, 900),
      K(t0 + 7, 42, sB * 22, 24),
      K(t0 + 10.5, 58, sB * 19, 6.4),
      K(t0 + 15, 76, sB * 4.6, 2.06),
      K(t0 + 20, 108, sB * 5.2, 1.95),
      K(t0 + 22.5, 126, sB * 6, 2.5),
      K(t0 + 25.5, 152, -sB * 0.5, 3.25),
      K(t0 + 29, 176, eclEl * 0.85, 4.1),
      K(t0 + 37, 181, eclEl, 4.9),
      K(b.t1, 0, 0, 6.6),
    ];
    // leave down the shadow, converging on its axis: the eclipse itself recedes and the camera stays in the umbra
    // (5 deg off the axis at 11 R would put it 1 R out, past the 0.9 R polar radius: the Sun would come back)
    const ex = slerpDir(dirAE(id, t0 + 37, 181, eclEl, up), dirAE(id, b.t1, 180, -B, up), 0.85, V3());
    const ea = ae(id, ex, b.t1, up);
    Object.assign(keys[keys.length - 1], { az: ea.az, el: ea.el });
    const blk = mk(id, { keys, radialIn: true, up, inRate: 0.6, outRate: 0.5, elMode: 'pchip' });
    // umbra entry (sun centre hidden)
    const Rs = W.radius(id);
    for (let t = t0 + 22; t < b.t1; t += 0.02) {
      const P = blk.position(t), C = apos(id, t);
      const toSun = P.clone().negate().normalize();
      const oc = C.clone().sub(P);
      const tca = oc.dot(toSun);
      if (tca > 0) {
        // oblate: scale the pole axis
        const cp = P.clone().addScaledVector(toSun, tca).sub(C);
        const hpol = cp.dot(up);
        const heq = cp.clone().addScaledVector(up, -hpol).length();
        const f = 1 - 0.098;
        if (Math.hypot(heq, hpol / f) < Rs) {
          tShadow = t;
          break;
        }
      }
    }
    if (!tShadow) tShadow = t0 + 28;

    chapter('saturn', 'Saturn', S.jupiter.t1, 'saturn', ['jupiter']);
    key('ev', t0, EV.planet); key('ev', t0 + 22, EV.planet); key('ev', tShadow - 0.4, 0.4); key('ev', tShadow + 1.6, EV.eclipse);
    key('sky', t0 + 6, 0.5); key('sky', tShadow, 0.45); key('sky', tShadow + 2, 0.12); key('sky', b.t1, 0.15);
    key('fov', t0, 36); key('fov', t0 + 6, 34); key('fov', t0 + 10.5, 38); key('fov', t0 + 15, 52); key('fov', t0 + 20, 54); key('fov', t0 + 25.5, 50); key('fov', t0 + 29, 44); key('fov', t0 + 33, 42); key('fov', b.t1 + 1, 38);
    key('roll', t0 + 13, 0); key('roll', t0 + 17, 7); key('roll', t0 + 21, -4); key('roll', t0 + 25, 0);
    key('letterbox', tShadow - 2, 0); key('letterbox', tShadow + 1, 1);
    key('intensity', t0, 0.6); key('intensity', t0 + 17, 0.85); key('intensity', tShadow, 0.7); key('intensity', tShadow + 3, 1.0); key('intensity', b.t1, 0.75);
    const saAhead = { rel: id, v: dirAE(id, t0 + 18, 205, 0, up).multiplyScalar(2.0 * W.radius(id)) };
    aim(t0 + 12.5, { mix: [['saturn', 0.62], [{ horizon: 'saturn', toward: saAhead, below: 0 }, 0.38]] }, 3, { pole: 'saturn' });
    aim(t0 + 22, 'saturn', 4, { pole: 'saturn' });
    hold(tShadow + 1.2, cutT('saturn') + 0.2); // the eclipse, then receding down the shadow
    const tc = legCut('saturn', 'titan', { fov: [38, 40], ev: [EV.eclipse, 0.4], sky: [0.15, 0.4], flare: 1 });
    key('letterbox', tc - 0.1, 1); key('letterbox', tc + 0.1, 0);
    cue(t0, 'arrive', 2); cue(t0 + 15, 'rings', 6); cue(tShadow, 'eclipse', 6);
    const f = BODIES.saturn.facts;
    caption(t0 + 3.5, t0 + 11.5, { kind: 'body', id, title: 'Saturn', subtitle: `Sunlight takes ${fmtLightTime(lightTime(id))}`, lines: [f.rings, f.density] });
    S.saturn.eclCaption = caption(tShadow + 1.5, tc - 0.7, { kind: 'note', title: "In Saturn's shadow", lines: ['The Sun hidden — sunlight scattering forward through the rings'] });
  }

  // ============================================================================================ 8b TITAN
  // A slow arc round Titan (~11 deg/s at 2.6-4 Titan radii, eased in log distance): its orange day side first, then
  // round to the far side, where Titan is a backlit crescent with its haze ring in front of Saturn; the view leans
  // toward Saturn (a composition: Titan kept at a fixed place in the frame) so both share it whenever they can.
  {
    const id = 'titan', b = S.titan, t0 = b.t0;
    const tm = (t0 + b.t1) / 2;
    const Ti = apos(id, tm), Sa = apos('saturn', tm);
    const eS = Sa.clone().sub(Ti).normalize(); // toward Saturn
    // the arc goes round Titan about the ecliptic normal (12 deg up): an arc over Titan's pole (the round-1 path)
    // put the camera's azimuth through a singularity, which is where Titan jumped across the frame
    const entry = natArr(id, t0);
    const arcDir = (ang, sg) => {
      const v = eS.clone().applyAxisAngle(ECL, sg * ang * DEG);
      const side = v.clone().cross(ECL).normalize();
      return v.applyAxisAngle(side, -12 * DEG).normalize();
    };
    // (the side of the arc nearer the arrival direction, so the approach does not swing across Titan)
    const sgn = entry.dot(arcDir(50, 1)) >= entry.dot(arcDir(50, -1)) ? 1 : -1;
    const rs = (ang) => arcDir(ang, sgn);
    const keys = [
      KD(t0, id, entry, 30),
      KD(t0 + 4.6, id, slerpDir(entry, rs(40), 0.75, V3()), 4.4),
      KD(t0 + 9, id, rs(88), 2.7),
      KD(t0 + 12.8, id, rs(132), 3.1),
      KD(b.t1, id, rs(134), 6.0),
    ];
    mk(id, { keys, inRate: 0.62, outRate: 0.5 });
    key('fov', t0, 40); key('fov', t0 + 4.6, 42); key('fov', t0 + 9, 48); key('fov', t0 + 12.8, 46); key('fov', b.t1 + 1, 40);
    key('ev', t0 + 1, 0.4); key('ev', t0 + 4, 0.2); key('ev', t0 + 10, 0.4); key('ev', t0 + 12.8, 1.2); key('ev', b.t1, 1.2);
    key('sky', t0 + 3, 0.5);
    aim(t0 + 4.0, { place: 'titan', from: 'saturn', off: 0.3 }, 4.5, 'ecl', 'cruise');
    // (on the far side the Sun comes out from behind Titan's hazy limb: a calmer lens system for it)
    key('flare', t0 + 9, 1); key('flare', t0 + 11.5, 0.45);
    legCut('titan', 'uranus', { fov: [40, 44], ev: [1.2, EV.planet], sky: [0.5, 0.85], flare: 1 });
    cue(t0, 'titan', 4);
    caption(t0 + 1.5, t0 + 9.5, { kind: 'body', id, title: 'Titan', subtitle: "Saturn's largest moon", lines: ['A nitrogen atmosphere 1.5 times denser at the surface than Earth’s'] });
  }

  // ============================================================================================ 9 URANUS
  {
    const id = 'uranus', b = S.uranus, t0 = b.t0;
    const sunD = sunDirFrom(id, t0);
    const pole = W.pole(id).clone();
    if (pole.dot(sunD) < 0) pole.negate(); // the sunlit pole
    const bull = slerpDir(sunD, pole, 0.82, V3());
    const ab = ae(id, bull, t0);
    const arr = ae(id, natArr(id, t0), t0);
    const keys = [
      K(t0, arr.az, arr.el, 900),
      K(t0 + 6, ab.az - 14, ab.el + 5, 62),
      K(t0 + 9.5, ab.az - 7, ab.el + 2.5, 32),
      K(t0 + 14, ab.az, ab.el, 7.6),
      K(t0 + 17, ab.az + 4, ab.el - 1.5, 7.2),
      K(b.t1, 0, 0, 10.5),
    ];
    // the bullseye recedes in place, then the cut to Neptune
    const ex = exitDir(id, b.t1, dirAE(id, t0 + 17, ab.az + 4, ab.el - 1.5), 0.05);
    const ea = ae(id, ex, b.t1);
    Object.assign(keys[keys.length - 1], { az: ea.az, el: ea.el });
    mk(id, { keys, radialIn: true, inRate: 0.6, outRate: 0.5 });
    chapter('uranus', 'Uranus', S.titan.t1, 'uranus', ['saturn', 'titan']);
    key('ev', b.t1, EV.planet);
    key('sky', t0 + 6, 0.6); key('sky', b.t1, 0.6);
    key('fov', t0, 38); key('fov', t0 + 6, 54); key('fov', t0 + 9.5, 46); key('fov', t0 + 14, 40); key('fov', b.t1 + 1, 34);
    key('roll', t0 + 6, 0); key('roll', t0 + 14, 0);
    key('intensity', t0, 0.5); key('intensity', t0 + 12, 0.6);
    labels(t0 + 5, t0 + 10.5, ['miranda', 'ariel', 'umbriel', 'titania', 'oberon'], 'moon');
    legCut('uranus', 'neptune', { fov: [34, 44], sky: [0.6, 0.85] });
    cue(t0, 'arrive', 2); cue(t0 + 12, 'bullseye', 5);
    hold(t0 + 12, b.t1 - 1.5);
    const f = BODIES.uranus.facts;
    const north = sunElevOverEquator(id) >= 0 ? 'north' : 'south';
    caption(t0 + 3, t0 + 11, { kind: 'body', id, title: 'Uranus', subtitle: `Sunlight takes ${fmtLightTime(lightTime(id))}`, lines: [`Tilted ${f.tilt.replace(' — it orbits on its side', '')}: it rolls around the Sun on its side`, `Right now its ${north} pole faces the Sun`, f.temperature] });
  }

  // ============================================================================================ 10 NEPTUNE
  {
    const id = 'neptune', b = S.neptune, t0 = b.t0;
    const arr = ae(id, natArr(id, t0), t0);
    const keys = [
      K(t0, arr.az, arr.el, 900),
      K(t0 + 6.8, 22, 8, 12),
      K(t0 + N_APP.tau, N_APP.az, N_APP.el, 3.7),
      K(t0 + 11.6, N_APP.az + 10, N_APP.el - 2, 4.2),
      K(b.t1, 0, 0, 5.0),
    ];
    // swing round to the night side, toward Triton (the hop to a moon leaves straight toward it)
    const toT = natDep(id, b.t1);
    const aT = ae(id, toT, b.t1);
    keys.splice(keys.length - 1, 0, K(t0 + 18.8, aT.az + (unwrapDeg(N_APP.az + 12 - aT.az, 0) > 0 ? 24 : -24), (aT.el + N_APP.el) / 2, 5.6));
    Object.assign(keys[keys.length - 1], { az: aT.az, el: aT.el });
    mk(id, { keys, radialIn: true, inRate: 0.6, outRate: 0.55 });
    chapter('neptune', 'Neptune', S.uranus.t1, 'neptune', ['uranus']);
    key('ev', t0 + 12, 0.15);
    key('sky', t0 + 6, 0.6);
    key('fov', t0, 38); key('fov', t0 + 5.5, 36); key('fov', t0 + 9.5, 38); key('fov', t0 + 12, 42); key('fov', t0 + 18, 52); key('fov', b.t1, 48);
    key('roll', t0 + 12, 0); key('roll', t0 + 16, -5); key('roll', t0 + 20, 0);
    // no turn to Triton: the camera backs away from Neptune's crescent down the line to Triton, and Triton slides
    // into the frame from behind it as the camera swings round to the twin-crescent view (see the Triton block)
    key('intensity', t0, 0.5); key('intensity', t0 + 10, 0.6);
    // (on the night side the Sun stands just beyond the crescent's limb: a calmer lens system)
    key('flare', t0 + 11, 1); key('flare', t0 + 15, 0.4);
    cue(t0, 'arrive', 2);
    const f = BODIES.neptune.facts;
    caption(t0 + 3, t0 + 11.5, { kind: 'body', id, title: 'Neptune', subtitle: `Sunlight takes ${fmtLightTime(lightTime(id))}`, lines: [`Winds ${f.winds.replace('Up to', 'up to')}`, `Sunlight here is ${Math.round((W.positions.neptune.length() / AU) ** 2)} times fainter than at Earth`] });
  }

  // ============================================================================================ 10b TRITON + 11 FINALE
  let tFin = 0, tPBD0 = 0, tPBD1 = 0;
  {
    const id = 'triton', b = S.triton, t0 = b.t0, RT = W.radius('triton');
    const tC = t0 + 6.5;
    const Tr = apos(id, tC), Ne = apos('neptune', tC);
    const out = Tr.clone().sub(Ne).normalize(); // from Neptune through Triton
    const side = ECL.clone().cross(out).normalize();
    // finale point: far beyond Neptune, high above the ecliptic, looking back at the Sun
    // Longitude: as close to Neptune's side as possible, but >= 100 deg from Earth's so that Earth is seen
    // near half phase rather than as an unlit crescent between us and the Sun (the pale-blue-dot beat).
    const lonOf = (v) => Math.atan2(-v.z, v.x) / DEG;
    const lamN = lonOf(W.positions.neptune), lamE = lonOf(W.positions.earth);
    let lamQ = lamN + 20, bestQ = 1e9;
    for (let l = lamN - 140; l <= lamN + 140; l += 1) {
      if (Math.abs(unwrapDeg(l - lamE, 0)) < 100) continue;
      const c = Math.abs(unwrapDeg(l - (lamN + 20), 0));
      if (c < bestQ) {
        bestQ = c;
        lamQ = l;
      }
    }
    const Q = W.dirFrom({ X: V3(1, 0, 0), Y: V3(0, 1, 0), Z: V3(0, 0, 1) }, lamQ, 33, V3()).multiplyScalar(46 * AU);
    // twin crescents: Neptune just clear of Triton's limb, seen from 24 deg above or below Triton's night side,
    // whichever is nearer the way out to Q (the retreat then barely has to swing round Triton)
    const qDir0 = Q.clone().sub(Tr).normalize();
    const camUp = out.clone().applyAxisAngle(side, -24 * DEG), camDn = out.clone().applyAxisAngle(side, 24 * DEG);
    const camDir = camUp.dot(qDir0) >= camDn.dot(qDir0) ? camUp : camDn;
    // the retreat from Triton (PullBack): 13.7 s from the end of the twin-crescent hold to Q, easing out over its
    // last 7 s, in which the Sun distance goes from ~30 to 46 AU and the solved frame settles
    const tPB = t0 + 9.5;
    tFin = tPB + 13.0;
    const qRel = Q.clone().sub(apos(id, tFin));
    const qDir = qRel.clone().normalize();
    const qd = qRel.length() / RT;
    const entry = natArr(id, t0);
    const keys = [
      KD(t0, id, slerpDir(entry, camDir, 0.35, V3()), 40),
      KD(t0 + 3.5, id, slerpDir(entry, camDir, 0.8, V3()), 8),
      KD(tC, id, camDir, 4.6),
      KD(tPB, id, camDir.clone().applyAxisAngle(side, 5 * DEG), 5.6),
    ];
    const blkT = mk(id, { keys, inRate: 0.62, t1: tPB });
    // ramp up from rest, a steady Powers-of-Ten rate while Triton and Neptune shrink, then a long ease-out
    rig.add(new PullBack(rig, { anchor: id, t0: tPB, t1: b.t1, tEnd: tFin, d0: 5.6 * RT, dir0: blkT.dirAt(tPB), Q, segs: [{ d: 1.8, a: 0, b: 2.0 }, { d: 2.0, a: 2.0, b: 2.0 }, { d: 2.4, a: 2.0, b: 0.7 }, { d: 6.8, a: 0.7, b: 0 }], swingU: 7.0 }));
    void qd;
    // the finale's beats: the labelled map (8.8 s), the zoom to Earth (6 s), the pale blue dot (8.4 s), credits (6.3 s)
    tPBD0 = tFin + 8.8;
    tPBD1 = tPBD0 + 6;
    const tCred = tPBD1 + 8.4;
    // ---- the finale frame, solved: from Q, the Sun and every planet that can be told apart inside 85% of the
    // frame, the lower-left card zone kept free, the ecliptic level; the smallest field that does it
    const QF = Q.clone().multiplyScalar(1.004);
    const dirTo = (pid) => (pid === 'sun' ? QF.clone().negate() : W.positions[pid].clone().sub(QF)).normalize();
    const finIds = ['sun', 'jupiter', 'saturn', 'uranus', 'neptune', 'mars', 'earth'];
    const finDirs = finIds.map(dirTo);
    const sunD = finDirs[0];
    let finBest = null;
    {
      const e1 = ECL.clone().cross(sunD).normalize(), e2 = sunD.clone().cross(e1).normalize();
      const qq = new THREE.Quaternion(), f = V3(), r = V3(), u = V3();
      // (the roll is solved too: the ecliptic may tilt up to 35 deg, so a Sun-Neptune diagonal can be turned away
      // from the corners the HUD occupies)
      const upR = V3();
      for (let a = -45; a <= 45; a += 1.5)
        for (let bb = -30; bb <= 30; bb += 1.5)
          for (let roll = -35; roll <= 35.01; roll += 5) {
          const aimD = sunD.clone().multiplyScalar(Math.cos(a * DEG) * Math.cos(bb * DEG)).addScaledVector(e1, Math.sin(a * DEG) * Math.cos(bb * DEG)).addScaledVector(e2, Math.sin(bb * DEG)).normalize();
          upR.copy(ECL).applyAxisAngle(aimD, roll * DEG);
          lookQuat(aimD, upR, qq);
          f.set(0, 0, -1).applyQuaternion(qq);
          r.set(1, 0, 0).applyQuaternion(qq);
          u.set(0, 1, 0).applyQuaternion(qq);
          let need = 0, okAll = true;
          const pts = finDirs.map((v) => {
            const z = v.dot(f);
            if (z <= 0.05) okAll = false;
            return [v.dot(r) / z, v.dot(u) / z];
          });
          if (!okAll) continue;
          // inside the 2.39:1 letterbox (visible height 0.744 of the frame) with a margin, and 88% of the width
          for (const [x, y] of pts) need = Math.max(need, Math.abs(y) / 0.62, Math.abs(x) / ((0.88 * 16) / 9));
          const tv = need;
          // card zone (lower left): no planet there
          let pen = 0;
          for (const [x, y] of pts) {
            const xn = x / ((tv * 16) / 9), yn = y / tv;
            if (xn < -0.22 && yn < -0.12) pen += 1; // title card (lower left)
            if (xn > 0.5 && yn > 0.3) pen += 1; // telemetry (upper right)
          }
          // the Sun on a third, not dead centre
          const sx = pts[0][0] / ((tv * 16) / 9), sy = pts[0][1] / tv;
          // the Sun and the inner orbits around it (Mars' orbit, ~1.6 AU) stay clear of the HUD's telemetry block
          // (top right, ~24% x 30% of the frame) and of the title card (lower left)
          {
            const rIn = Math.tan(Math.atan(1.7 / 46)) / tv;
            const rx = rIn / (16 / 9);
            if (sx + rx > 0.4 && sy + rIn > 0.3) pen += 3;
            if (sx - rx < -0.2 && sy - rIn < -0.1) pen += 2;
          }
          const score = (2 * Math.atan(tv)) / DEG + pen * 40 + Math.abs(Math.hypot(sx, sy) - 0.3) * 8 + Math.max(0, Math.abs(sy) - 0.22) * 14;
          const sc2 = score + Math.abs(roll) * 0.12;
          if (!finBest || sc2 < finBest.score) finBest = { score: sc2, aimD, up: upR.clone(), roll, fov: (2 * Math.atan(tv)) / DEG };
        }
    }
    const fovFin = clamp(finBest ? finBest.fov : 50, 30, 75);
    // ---- the pale blue dot: Earth on the right third, the Sun just beyond the left edge on Earth's horizontal,
    // so the Sun's scattered-light streak runs through Earth while the ghost axis (Sun -> frame centre) misses it
    const eD = dirTo('earth');
    const sep = Math.acos(clamp(eD.dot(sunD), -1, 1));
    const XE = 0.36, XS = -1.07, YP = 0.22;
    const tanHh = Math.tan(sep) / (XE - XS); // horizontal tan(half fov)
    const fovPBD = clamp(((2 * Math.atan((tanHh * 9) / 16)) / DEG) * tune('pbd', 1.0), 0.35, 3.2);
    const nPl = eD.clone().cross(sunD).normalize(); // normal of the Sun-Earth plane
    const upPBD = nPl.dot(ECL) >= 0 ? nPl.clone() : nPl.clone().negate();
    // aim: from Earth toward the Sun by XE * tanHh (Earth then sits right of centre), then lowered by YP
    const towardSun = sunD.clone().addScaledVector(eD, -sunD.dot(eD)).normalize();
    const tanV = (tanHh * 9) / 16;
    const aimPBD = eD.clone().addScaledVector(towardSun, XE * tanHh).addScaledVector(upPBD, -YP * tanV).normalize();
    const upP = upPBD.clone().addScaledVector(aimPBD, -upPBD.dot(aimPBD)).normalize();
    chapter('finale', 'Four light-hours', t0 + 11, undefined, ['neptune', 'triton']);
    key('ev', t0, 0.2); key('ev', t0 + 4, 0.6); key('ev', t0 + 12, 0.6); key('ev', t0 + 15, EV.finale); key('ev', tFin - 1, tune('finEV', EV.finale)); key('ev', tPBD0, tune('finEV', EV.finale)); key('ev', tPBD1, tune('pbdEV', 1.6)); key('ev', b.t1, tune('pbdEV', 1.6));
    key('sky', t0, 0.6); key('sky', t0 + 6, 0.7); key('sky', tFin - 2, 0.75); key('sky', tFin + 1.5, 0.5); key('sky', tPBD0, 0.5); key('sky', tPBD1, tune('pbdSky', 0.004));
    key('fov', t0, 42); key('fov', t0 + 3.5, 48); key('fov', tC, 52); key('fov', t0 + 9.5, 50); key('fov', t0 + 13.5, 50); key('fov', tFin - 1, fovFin); key('fov', tPBD0, fovFin * 0.97);
    // the zoom to Earth at a steady rate in log(field of view)
    for (let i = 1; i <= 8; i++) {
      const u = i / 8, w = u * u * (3 - 2 * u);
      key('fov', tPBD0 + 0.8 + u * (tPBD1 - tPBD0 - 0.8), fovFin * 0.97 * Math.pow(fovPBD / (fovFin * 0.97), w));
    }
    key('fov', b.t1, fovPBD * 0.97);
    // planets as labelled points: a longer exposure for the points, a floor so every labelled one reads, and a
    // calmer Sun so the inner orbits read around it
    key('glint', tFin - 3, 1); key('glint', tFin, 3.5); key('glintFloor', tFin - 3, 0); key('glintFloor', tFin, 0.32); key('glintFloor', tPBD0 + 1, 0.32); key('glintFloor', tPBD0 + 4, 0);
    key('roll', t0 + 3, 0); key('roll', tC, -6); key('roll', t0 + 11, 0);
    // (thin line art only once the retreat has come to rest: under warp the radial blur would hatch it; director.js
    // also gates shot.orbits by the warp)
    key('orbits', tFin - 0.8, 0); key('orbits', tFin + 1.8, 1); key('orbits', tPBD0, 1); key('orbits', tPBD0 + 3.5, 0);
    // the Sun's glare held right down in the map so the inner orbits (Mercury..Mars within ~40 px of it) read; the
    // Sun stays just outside the pale-blue-dot field: keep only a faint scattered-light beam from it
    key('flare', t0 + 9, 0.4); key('flare', tFin - 3, 0.35); key('flare', tFin + 0.5, 0.08); key('flare', tPBD0 + 1, 0.08); key('flare', tPBD1 - 1, tune('pbdFlare', 0.035)); key('flare', b.t1, tune('pbdFlare', 0.035));
    // a long exposure, like Voyager's: the sub-pixel Earth (0.05 px, ~0.1 of a pixel's light) is stretched up so
    // it reads as the single pale-blue point it was in the 1990 frame; the stars are left out of that exposure
    // ... and for the pale blue dot every point becomes what an unresolved world is: one compact faint point, the
    // brightness normalised so Earth's single pixel peaks at ~0.42 (below the bloom's reach, so it stays pale
    // blue), Venus and Jupiter keeping their true ratios to it (glints.js glintNorm)
    key('glint', tPBD0 + 1, 3.5); key('glint', tPBD0 + 4.5, 1);
    key('pbdNorm', tPBD0 + 1.5, 0); key('pbdNorm', tPBD0 + 4.5, 1); key('pbdNorm', b.t1, 1);
    key('letterbox', tFin - 4, 0); key('letterbox', tFin, 1); key('letterbox', b.t1, 1);
    // the credits card comes up over the pale blue dot, which fades out behind it; the card holds on black
    key('fade', tCred + 0.6, 0); key('fade', tCred + 3.4, 1); key('fade', b.t1, 1);
    key('intensity', t0, 0.55); key('intensity', tC, 0.7); key('intensity', t0 + 14, 0.9); key('intensity', tFin, 0.6); key('intensity', tPBD1, 0.95); key('intensity', b.t1, 0.2);
    // (the hand-over from Neptune to the Triton / Neptune pair is timed once the legs exist: see below)
    S.triton.pairAim = { target: { mix: [['triton', 0.55], ['neptune', 0.45]] } };
    // the retreat looks back down its own path: Triton and Neptune shrink together near the point the stars stream
    // from, while the view turns, in one slow constant-rate rotation over the whole retreat, onto the solved frame
    // of the whole system (the swing round to Q happens once they are points; PullBack)
    plan.aim.push({ t: tPB, target: { dir: finBest ? finBest.aimD : sunD }, blend: tFin + 1.4 - tPB, up: finBest ? { dir: finBest.up } : 'ecl', ease: 'cruise', qslerp: true });
    aim(tPBD0 - 0.5, { dir: aimPBD }, 4.2, { dir: upP }, 'cruise'); // re-centred ahead of the zoom, so Earth never leaves the field
    labels(tFin + 0.5, tPBD0 + 2, ['sun', 'jupiter', 'saturn', 'uranus', 'neptune', 'earth', 'mars', 'venus', 'mercury'], 'planet');
    labels(tPBD1 - 1.5, tCred + 1.2, ['earth'], 'pale-blue-dot');
    focus(tFin - 2, 'sun');
    focus(tPBD0 + 2, 'earth');
    hold(tC, tPB + 2.6); // twin crescents, and the start of the retreat's slow turn (already gentle: cruise easing)
    // (the retreat's one slow turn onto the solved frame is the composition: no safe-frame pull toward the Sun)
    plan.freeFrame.push({ t0: tPB, t1: tFin + 0.5 });
    cue(t0, 'triton', 4); cue(t0 + 11, 'pullback', 8); cue(tPBD0 + 2, 'pale-blue-dot', 8); cue(tCred, 'end', b.t1 - tCred);
    caption(t0 + 2.5, t0 + 10.5, { kind: 'body', id, title: 'Triton', subtitle: "Neptune's largest moon", lines: ['It orbits backwards — a captured world, slowly spiralling inward'] });
    const lt = Q.length() * KM_PER_UNIT / C_KM_S;
    caption(tFin + 0.5, tPBD0 + 0.6, { kind: 'body', id: 'finale', title: 'The Solar System', subtitle: `${(Q.length() / AU).toFixed(0)} AU from the Sun — this sunlight left it ${fmtLightTime(lt)} ago`, lines: ['Every planet where it really is today'] });
    const eDist = W.positions.earth.clone().sub(Q).length() * KM_PER_UNIT;
    caption(tPBD1 - 1.0, tCred, { kind: 'note', title: 'Earth', subtitle: `${(eDist / 1e9).toFixed(1)} billion km away · less than a pixel`, lines: ['Every ocean, every city, every person — one pale blue point of light'] });
    caption(tCred, b.t1, { kind: 'credits', title: 'FOUR LIGHT-HOURS', lines: ['Data: NASA / JPL / USGS · Yale Bright Star Catalogue · Natural Earth', `Planet positions computed for ${dateStr}`] });
  }

  // ------------------------------------------------------------------------------------------ warp legs
  const legOrder = order;
  for (let i = 0; i < legOrder.length - 1; i++) {
    const a = blocks[legOrder[i]], b = blocks[legOrder[i + 1]];
    if (!a || !b || b.t0 - a.t1 <= 0) continue;
    const sa = S[legOrder[i]];
    const leg = new WarpLeg(rig, a, b, { ua: 0.42, ub: 0.48, dwell: sa.dwell || 0, dwellRate: sa.dwellRate, ...(sa.cut !== undefined ? { cut: { at: sa.cut, ...(sa.cutOpts || {}) } } : {}) });
    b.prevLeg = leg;
    rig.add(leg);
  }
  rig.segments.sort((x, y) => x.t0 - y.t0);
  // Neptune -> Triton: the camera backs away from Neptune's crescent past Triton, still looking at Neptune; Triton
  // slides into the frame from behind the camera, and only once it is in front (within ~32 deg of Neptune) does the
  // view ease onto the pair (a turn toward a moon still behind the camera would be a whip pan)
  {
    let tIn = S.triton.t0 + 1.5;
    for (let t = S.neptune.t1; t < S.triton.t0 + 6; t += 0.05) {
      const P = rig.position(t), d = clock(t);
      const a = W.pos('triton', d, V3()).sub(P).normalize(), n = W.pos('neptune', d, V3()).sub(P).normalize();
      if (a.dot(n) > Math.cos(32 * DEG)) {
        tIn = t;
        break;
      }
    }
    aim(tIn - 0.3, S.triton.pairAim.target, Math.max(2.5, S.triton.t0 + 6.4 - tIn), undefined, 'cruise');
    focus(tIn + 0.5, 'triton');
    S.triton.tIn = tIn;
  }
  // generic leg cues: warp FOV breathing
  for (const s of rig.segments) {
    if (s.kind !== 'leg') continue;
    const m = (s.tDwell + s.t1) / 2;
    key('fov', m, 47);
  }

  // ------------------------------------------------------------------------------------------ wide-shot belt ring
  // (the belt chapter only, after the cut from Mars, and faintly in the finale map, where a bright ring would hide the
  // inner orbits round the Sun)
  key('beltRing', 0, 0); key('beltRing', cutT('mars') + 0.1, 0); key('beltRing', cutT('mars') + 1.5, 1); key('beltRing', S.belt.t1 - 1, 1); key('beltRing', cutT('belt') - 0.05, 0);
  key('beltRing', tFin - 3, 0); key('beltRing', tFin, tune('finRing', 0.1)); key('beltRing', tPBD0 + 1, tune('finRing', 0.1)); key('beltRing', tPBD0 + 3, 0);

  // ------------------------------------------------------------------------------------------ title-card composition
  // While a world's title card is up (HUD, lower-left), the world slides to the right of frame (a yaw that puts
  // the view centre left of it), so the card never prints over the disc; eased in and out over 1.6 s.
  {
    // (Mercury is composed by its own `place` aim, away from the Sun)
    const SHIFT = { sun: 0.3, venus: 0.3, earth: 0.32, mars: 0.34, saturn: 0.28, uranus: 0.3, neptune: 0.32, triton: 0.18, jupiter: 0.1 };
    for (const c of plan.captions) {
      if (c.kind !== 'body' || !(c.id in SHIFT)) continue;
      const fovAt = (t) => {
        const ks = plan.tr.fov.slice().sort((a, b) => a.t - b.t);
        let v = ks[0].v;
        for (const k of ks) if (k.t <= t) v = k.v;
        return v;
      };
      const yawFor = (t) => {
        const tv = Math.tan((fovAt(t) * DEG) / 2) * (16 / 9);
        return -Math.atan(SHIFT[c.id] * tv) / DEG;
      };
      // (after a warp leg the yaw waits until the warp has died down: no rotation in a streaking frame)
      // (eased over 2.8 s: a 10 deg re-composition is a slow drift, not a pan)
      const RY = 2.8;
      const a = Math.max(c.t0 + 0.6, S[c.id] && S[c.id].t0 > 0 ? S[c.id].t0 + 3.8 + RY : -1e9), b = c.t1 + 0.4;
      key('yaw', a - RY, 0);
      key('yaw', a, yawFor(a));
      key('yaw', (a + b) / 2, yawFor((a + b) / 2));
      key('yaw', b, yawFor(b));
      key('yaw', b + RY, 0);
      // a disc that fills much of the frame is also lowered a little, so its upper limb stays clear of the HUD's
      // telemetry block (top right)
      const DROP = { sun: 0.17, earth: 0.13 };
      if (DROP[c.id]) {
        const pitchFor = (t) => Math.atan(DROP[c.id] * Math.tan((fovAt(t) * DEG) / 2)) / DEG;
        key('pitch', a - RY, 0);
        key('pitch', a, pitchFor(a));
        key('pitch', b, pitchFor(b));
        key('pitch', b + RY, 0);
      }
    }
  }

  // ------------------------------------------------------------------------------------------ finalize
  plan.aim.sort((a, b) => a.t - b.t);
  let lastUp = 'ecl';
  for (const k of plan.aim) {
    if (k.up === undefined) k.up = lastUp;
    lastUp = k.up;
  }
  const tracks = {};
  for (const name in plan.tr) {
    const ks = plan.tr[name];
    if (!ks.length) continue;
    // de-duplicate equal times (last wins)
    ks.sort((a, b) => a.t - b.t);
    const out = [];
    for (const k of ks) {
      if (out.length && Math.abs(out[out.length - 1].t - k.t) < 1e-6) out[out.length - 1] = k;
      else out.push(k);
    }
    tracks[name] = new Track(out, { mode: 'pchip' });
  }
  plan.chapters.sort((a, b) => a.t0 - b.t0);
  for (let i = 0; i < plan.chapters.length; i++) plan.chapters[i].t1 = i + 1 < plan.chapters.length ? plan.chapters[i + 1].t0 : duration;
  plan.focus.sort((a, b) => a.t - b.t);
  plan.captions.sort((a, b) => a.t0 - b.t0);
  plan.cues.sort((a, b) => a.t - b.t);

  function focusAt(t) {
    let id = plan.focus[0]?.id || 'sun';
    for (const f of plan.focus) if (t >= f.t) id = f.id;
    return id;
  }
  function focusDistanceAt(t, camPos, d) {
    const id = focusAt(t);
    if (id === 'asteroids') return 50;
    try {
      return Math.max(1e-4, W.pos(id, d, V3()).distanceTo(camPos) - W.radius(id));
    } catch {
      return 1e3;
    }
  }

  return {
    rig,
    clock,
    duration,
    chapters: plan.chapters,
    captions: plan.captions,
    labelBeats: plan.labels,
    audioKeys: plan.cues,
    aimKeys: plan.aim,
    tracks,
    beltCrossing: belt,
    focusAt,
    focusDistanceAt,
    times: { S, tSunrise, tRise0, tRise1, tShadow, tFin, tPBD0, tPBD1, cuts: plan.cuts.slice() },
    holds: [{ t0: tRise0 - 1.0, t1: tRise1 + 0.5 }, ...plan.holds],
    pans: plan.pans,
    cuts: plan.cuts.slice().sort((a, b) => a - b),
    freeFrame: plan.freeFrame,
  };
}
