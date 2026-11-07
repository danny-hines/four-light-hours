// Camera rig: position paths for the film.
//
// * OrbitBlock   – motion around one anchor (body or moon) in log-polar coordinates: azimuth/elevation in a
//                  sun-relative shot frame and ln(altitude/R). Hermite splines (PCHIP / Catmull-Rom) through
//                  keys. Interpolating ln(altitude) means the camera can never pass through the body, and a world
//                  swells or recedes at a constant apparent rate while the log-altitude changes linearly.
// * FlyBlock     – straight-ish fly-through of a point (the asteroid-belt crossing).
// * WarpLeg      – travel between two blocks. Progress is a logistic in log-distance space:
//                  F = ln(dA/dB) follows a rate profile (dwell, ramp, cruise, ramp), so the distance from the
//                  departure world grows exponentially, then the distance to the destination shrinks exponentially,
//                  with the peak speed at mid-leg. The route is the chord between the worlds, bowed gently away
//                  from the Sun (more where the chord would pass near it), so at warp the destination's line of
//                  sight hardly moves; near each end it blends (on the sphere around the end body, so it never cuts
//                  through it) into the blocks' radial entry/exit directions, while the speed is still low.
//                  Position, velocity and acceleration are continuous with the blocks (C2).
import * as THREE from 'three';
import { Track, cruiseEase, sigmoid, smootherstep, slerpDir, unwrapDeg, clamp } from './math.js';
import { DEG } from '../core/astro.js';

const logit = (p) => Math.log(p / (1 - p));
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _x = new THREE.Vector3(), _y = new THREE.Vector3();
const ECL_UP = new THREE.Vector3(0, 1, 0);

/**
 * The route between two worlds: the straight chord A -> B, bowed away from the Sun by h * 4 s (1 - s) along n.
 * A straight route keeps the destination's line of sight still while the camera is at warp (the streaks radiate
 * from its point of light at the frame centre); the bow is small (1.5% of the chord) unless the chord passes near
 * the Sun, where it grows until the route clears half the inner world's solar distance.
 * Returns { n, h, L, dep, arr } (dep = departure tangent, arr = direction from B back along the incoming route).
 */
export function routeGeom(A, B, bowFrac = 0.015) {
  const D = B.clone().sub(A);
  const L = D.length();
  const u = L > 1e-12 ? D.clone().divideScalar(L) : new THREE.Vector3(1, 0, 0);
  let n = new THREE.Vector3(), h = 0;
  const rA = A.length(), rB = B.length();
  if (L > 1e-12 && rA > 1e-6 && rB > 1e-6 && A.clone().normalize().dot(B.clone().normalize()) < 0.9999999) {
    const s0 = clamp(-A.dot(D) / (L * L), 0, 1);
    const C = A.clone().addScaledVector(D, s0);
    n.copy(C).addScaledVector(u, -C.dot(u));
    if (n.lengthSq() < 1e-12 * L * L) n.copy(ECL_UP).addScaledVector(u, -ECL_UP.dot(u));
    n.normalize();
    const dMin = C.length();
    const want = 0.5 * Math.min(rA, rB);
    h = bowFrac * L;
    if (dMin < want) h = Math.max(h, Math.min(0.35 * L, (want - dMin) / Math.max(0.25, 4 * s0 * (1 - s0))));
  }
  const dep = D.clone().addScaledVector(n, 4 * h).normalize();
  const arr = D.clone().addScaledVector(n, -4 * h).normalize().negate();
  return { n, h, L, u, dep, arr };
}

/**
 * A rate profile made of constant levels joined by smoothstep ramps (so the rate is C1 and its integral C2).
 * segs: [{ d (seconds), a (start level), b (end level) }] where a level may be the string 'c' (the unknown cruise
 * level, solved so that the integral over all segments equals `total`).
 */
export class RateProfile {
  constructor(segs, total) {
    let kc = 0, k0 = 0;
    for (const s of segs) {
      const wa = s.d / 2, wb = s.d / 2;
      if (s.a === 'c') kc += wa;
      else k0 += wa * s.a;
      if (s.b === 'c') kc += wb;
      else k0 += wb * s.b;
    }
    this.c = kc > 0 ? (total - k0) / kc : 0;
    this.segs = segs.map((s) => ({ d: s.d, a: s.a === 'c' ? this.c : s.a, b: s.b === 'c' ? this.c : s.b }));
    this.T = this.segs.reduce((x, s) => x + s.d, 0);
  }
  // integral of the rate from 0 to x
  integral(x) {
    const I = (y) => y * y * y - (y * y * y * y) / 2; // integral of smoothstep on [0, y]
    let acc = 0, t = 0;
    for (const s of this.segs) {
      if (x <= t) break;
      const dx = Math.min(x - t, s.d);
      if (s.d > 0) acc += s.a * dx + (s.b - s.a) * s.d * I(dx / s.d);
      t += s.d;
    }
    if (x > t) acc += (this.segs.length ? this.segs[this.segs.length - 1].b : 0) * (x - t);
    return acc;
  }
  rate(x) {
    let t = 0;
    for (const s of this.segs) {
      if (x <= t + s.d) {
        const y = s.d > 0 ? clamp((x - t) / s.d, 0, 1) : 1;
        return s.a + (s.b - s.a) * y * y * (3 - 2 * y);
      }
      t += s.d;
    }
    return this.segs.length ? this.segs[this.segs.length - 1].b : 0;
  }
}

export class OrbitBlock {
  /**
   * keys: [{ t, az, el, dist }]   (t absolute seconds; az/el degrees in the anchor's shot frame; dist in anchor radii)
   * opts: { anchor, up (Vector3 frame pole, default ecliptic north), azMode ('cardinal'|'pchip'), tension,
   *         inRate (ln-distance per second, inward, at the first key), outRate (outward at the last key) }
   */
  constructor(rig, opts) {
    this.rig = rig;
    this.kind = 'orbit';
    this.anchor = opts.anchor;
    this.up = opts.up || null;
    this.keys = opts.keys;
    this.t0 = opts.t0 ?? opts.keys[0].t;
    this.t1 = opts.t1 ?? opts.keys[opts.keys.length - 1].t;
    this.R = rig.W.radius(this.anchor);
    const ks = this.keys;
    // unwrap azimuths so the spline takes the short way between consecutive keys
    for (let i = 1; i < ks.length; i++) ks[i].az = unwrapDeg(ks[i].az, ks[i - 1].az);
    const la = (k) => Math.log(Math.max(1e-7, k.dist - 1));
    const first = ks[0], last = ks[ks.length - 1];
    const inRate = opts.inRate ?? 0, outRate = opts.outRate ?? 0;
    this.inRate = inRate;
    this.outRate = outRate;
    const laKeys = ks.map((k, i) => {
      const o = { t: k.t, v: la(k) };
      if (i === 0) o.m = -inRate * (k.dist / (k.dist - 1));
      if (i === ks.length - 1) o.m = outRate * (k.dist / (k.dist - 1));
      if (k.laRate !== undefined) o.m = k.laRate;
      return o;
    });
    const azMode = opts.azMode || 'pchip';
    // C2 (quintic Hermite) tracks: a held shot starts to move with the acceleration ramping up, not stepping
    this.az = new Track(ks.map((k) => ({ t: k.t, v: k.az, m: k.azRate })), { mode: azMode, tension: opts.tension ?? 0, c2: true });
    this.el = new Track(ks.map((k) => ({ t: k.t, v: k.el, m: k.elRate })), { mode: opts.elMode || 'pchip', tension: opts.tension ?? 0, c2: true });
    this.la = new Track(laKeys, { mode: 'pchip', extrapolate: true, c2: true });
    this._F = { X: new THREE.Vector3(), Y: new THREE.Vector3(), Z: new THREE.Vector3() };
  }
  frameAt(t) {
    const d = this.rig.clock(t);
    return this.rig.W.frame(this.anchor, d, this.up || this.rig.W.ECL_N, this._F);
  }
  dirAt(t, out = new THREE.Vector3()) {
    const F = this.frameAt(t);
    return this.rig.W.dirFrom(F, this.az.value(t), this.el.value(t), out);
  }
  distAt(t) {
    return this.R * (1 + Math.exp(this.la.value(t)));
  }
  position(t, out = new THREE.Vector3()) {
    const d = this.rig.clock(t);
    this.rig.W.pos(this.anchor, d, out);
    const dir = this.dirAt(t, _v);
    return out.addScaledVector(dir, this.distAt(t));
  }
  // radial entry / exit used by warp legs: direction from the anchor, distance, and ln-distance rate
  entry() {
    return { anchor: this.anchor, dir: this.dirAt(this.t0, new THREE.Vector3()), dist: this.distAt(this.t0), rate: this.inRate, t: this.t0 };
  }
  exit() {
    return { anchor: this.anchor, dir: this.dirAt(this.t1, new THREE.Vector3()), dist: this.distAt(this.t1), rate: this.outRate, t: this.t1 };
  }
}

/** Fly-through of a fixed point C along unit direction u: x(t) from -X to +X with matched end speeds. */
export class FlyBlock {
  constructor(rig, { anchorPos, dir, t0, t1, X, X1, vIn, vOut, vMid, tMid, lateral, xKeys }) {
    this.rig = rig;
    this.kind = 'fly';
    this.anchor = null;
    this.C = anchorPos.clone();
    this.u = dir.clone().normalize();
    this.t0 = t0;
    this.t1 = t1;
    this.X = X;
    this.X1 = X1 ?? X; // (the exit may be nearer the anchor than the entry: a glide that ends inside the field)
    this.R = 0;
    this.vIn = vIn;
    this.vOut = vOut;
    const tm = tMid ?? (t0 + t1) / 2;
    // xKeys: [{t, v, m}] along-path position / speed (must run from -X at t0 to +X at t1)
    this.x = new Track(
      xKeys || [
        { t: t0, v: -X, m: vIn },
        { t: tm, v: 0, m: vMid },
        { t: t1, v: X, m: vOut },
      ],
      { mode: 'pchip', extrapolate: true }
    );
    // gentle lateral weave (world-space offsets), zero with zero slope at both ends
    this.lat = lateral || null;
    const s = new THREE.Vector3(0, 1, 0).cross(this.u);
    if (s.lengthSq() < 1e-6) s.set(1, 0, 0);
    this.side = s.normalize();
    this.vert = new THREE.Vector3().crossVectors(this.u, this.side).normalize();
  }
  position(t, out = new THREE.Vector3()) {
    out.copy(this.C).addScaledVector(this.u, this.x.value(t));
    if (this.lat) {
      const w = Math.sin(Math.PI * clamp((t - this.t0) / (this.t1 - this.t0), 0, 1)) ** 2;
      out.addScaledVector(this.side, this.lat.side * w).addScaledVector(this.vert, this.lat.up * w);
    }
    return out;
  }
  entry() {
    return { anchorPos: this.C, dir: this.u.clone().negate(), dist: this.X, rate: this.vIn / this.X, t: this.t0 };
  }
  exit() {
    return { anchorPos: this.C, dir: this.u.clone(), dist: this.X1, rate: this.vOut / this.X1, t: this.t1 };
  }
}

export class WarpLeg {
  /**
   * from/to: blocks (their exit()/entry() define the end states).
   * opts: { ua, ub (fraction of the warp phase spent accelerating / decelerating), lift (extra ecliptic-normal
   *         bow, as a fraction of the leg length), bow (bow away from the Sun, fraction of the chord),
   *         dwell (seconds at the start spent receding gently while the camera turns to the destination),
   *         dwellRate (ln-distance per second during the dwell; default the block's exit rate) }
   *
   * Turn first, then accelerate: the leg opens with a dwell in which the camera keeps receding from the world it
   * is leaving at a gentle, constant log-rate (it shrinks at a steady apparent rate, the speed stays far below
   * the warp threshold) while the path swerves from the block's exit direction onto the route and the view turns
   * to the destination. Only then does the log-distance rate ramp up to the cruise; it ramps down again into the
   * arrival block's own approach rate. The rate profile is smoothstep-joined levels, so position, velocity and
   * acceleration are continuous with the blocks (which are C2 themselves).
   */
  constructor(rig, from, to, opts = {}) {
    this.rig = rig;
    this.kind = 'leg';
    this.from = from;
    this.to = to;
    this.t0 = from.t1;
    this.t1 = to.t0;
    this.T = this.t1 - this.t0;
    this.ua = opts.ua ?? 0.4;
    this.ub = opts.ub ?? 0.45;
    this.lift = opts.lift ?? 0;
    this.dwell = Math.max(0, Math.min(opts.dwell ?? 0, this.T * 0.75));
    this.ex = from.exit();
    this.en = to.entry();
    const tm = (this.t0 + this.t1) / 2;
    this.tm = tm;
    this.geom = routeGeom(this._anchorPos(this.ex, tm, new THREE.Vector3()), this._anchorPos(this.en, tm, new THREE.Vector3()), opts.bow ?? 0.015);
    // leg length = arc length of the route between the two anchors at mid-leg
    let L = 0;
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    const NS = 96;
    const cum = [0];
    this._arc(0, tm, p);
    for (let i = 1; i <= NS; i++) {
      this._arc(i / NS, tm, q);
      L += q.distanceTo(p);
      cum.push(L);
      p.copy(q);
    }
    this.L = L;
    // arc-length reparameterisation: fraction of route length -> arc parameter (monotone, C1)
    const sk = cum.map((c, i) => ({ t: c / L, v: i / NS }));
    sk[0].m = (sk[1].v - sk[0].v) / (sk[1].t - sk[0].t);
    sk[NS].m = (sk[NS].v - sk[NS - 1].v) / (sk[NS].t - sk[NS - 1].t);
    this.sOf = new Track(sk, { mode: 'pchip' });
    const rOut = Math.min(this.ex.dist, 0.38 * L), rIn = Math.min(this.en.dist, 0.38 * L);
    if (rOut < this.ex.dist || rIn < this.en.dist) console.warn('[director] leg end too far for its length', from.anchor, to.anchor);
    this.rOut = rOut;
    this.rIn = rIn;
    // how far the block's exit / entry direction is from the route (0..1 of a half turn)
    const swerve = (st, s) => {
      const A = this._anchorPos(st, tm, new THREE.Vector3());
      const H = this._arc(s, tm, new THREE.Vector3()).sub(A);
      if (H.lengthSq() < 1e-12) return 0;
      return Math.acos(clamp(H.normalize().dot(st.dir), -1, 1)) / Math.PI;
    };
    this.swA = swerve(this.ex, this.sOf.value(0.12));
    this.swB = swerve(this.en, this.sOf.value(0.88));
    // ln-distance windows in which the radial exit / entry hands over to the route: close to the world (within
    // ~5-25x the block's exit distance), i.e. during the dwell, at low speed; the warp itself runs on the route
    // (the window always starts above the end distance, so the leg leaves the block exactly on its radial exit,
    // and ends by mid-route, where the other end's branch takes over: short planet -> moon hops get a short window)
    const win = (r0, sw) => {
      const base = Math.log(r0);
      const hi = Math.min(base + 1.75 + 1.6 * sw, Math.log(0.5 * L));
      const lo = Math.min(base + 0.15, base + 0.4 * (hi - base));
      return [lo, hi];
    };
    this.winA = win(rOut, this.swA);
    this.winB = win(rIn, this.swB);
    this.F0 = logit(rOut / L);
    this.F1 = -logit(rIn / L);
    // rate profile in F = ln(rhoA / rhoB) per second
    const r0 = this.ex.rate / (1 - rOut / L), r1 = this.en.rate / (1 - rIn / L);
    const rD = (opts.dwellRate ?? this.ex.rate) / (1 - rOut / L);
    if (opts.cut) {
      // A cut leg: the camera keeps receding radially from the world it leaves (the block's own last framing, so
      // the world shrinks in place at a constant apparent rate, its lighting unchanged) until the cut at
      // t0 + cut.at, made under a dip to black; the edit skips the slow bend onto the route, and the camera
      // resumes on the route, already pointed at the destination, from where it accelerates to warp.
      const dPre = clamp(opts.cut.at, 0.2, this.T - 1.5);
      const ra = Math.min(1.0, 0.6 * dPre);
      this.prof = new RateProfile([{ d: ra, a: r0, b: rD }, { d: dPre - ra, a: rD, b: rD }], 0);
      this.prof.c = 0;
      this.tCut = this.t0 + dPre;
      const Fc = this.F0 + this.prof.integral(dPre);
      const lnCut = Math.log(L * sigmoid(Fc));
      // the hand-over to the route starts just after the cut (radial until then) and is skipped by the edit
      const hi = Math.min(lnCut + 1.4, Math.log(0.5 * L));
      this.winA = [Math.min(lnCut + 0.02, hi - 0.05), hi];
      // resume on the route beyond the hand-over (never past mid-route, never before the cut point)
      this.Fafter = Math.max(Fc + 0.05, Math.min(0, logit(Math.min(0.5, Math.exp(hi + (opts.cut.skip ?? 0.15)) / L))));
      // radialB: resume on the destination block's own entry line, at most capB from it (the edit then removes the
      // whole swing from the route's arrival direction onto the block's first framing)
      if (opts.cut.radialB && opts.cut.capB) this.Fafter = Math.max(this.Fafter, logit(1 - Math.min(0.9 * L, opts.cut.capB) / L));
      const T2 = this.T - dPre;
      // (the camera resumes slowly after the cut and accelerates into the warp over ~1 s: no jump into full warp)
      const rPost = opts.cut.rate ?? 0.06;
      const Ua2 = (opts.cut.ua ?? 0.32) * T2, Ub2 = (opts.cut.ub ?? 0.42) * T2;
      this.prof2 = new RateProfile([{ d: Ua2, a: rPost, b: 'c' }, { d: Math.max(0, T2 - Ua2 - Ub2), a: 'c', b: 'c' }, { d: Ub2, a: 'c', b: r1 }], this.F1 - this.Fafter);
      if (!(this.prof2.c > 0)) console.warn('[director] cut leg cruise rate not positive', from.anchor, to.anchor, this.prof2.c);
      this.dwell = dPre;
      this.tDwell = this.tCut;
      // radialB: after the cut the camera comes straight in along the destination block's entry direction (a hop to
      // a moon whose first framing lies round its far side: no swing across the moon at close range)
      this.radialB = !!opts.cut.radialB;
      return;
    }
    const Tw = this.T - this.dwell, Ua = this.ua * Tw, Ub = this.ub * Tw;
    const segs = [];
    let rStart = r0;
    if (this.dwell > 0) {
      const ra = Math.min(1.2, 0.45 * this.dwell);
      segs.push({ d: ra, a: r0, b: rD }, { d: this.dwell - ra, a: rD, b: rD });
      rStart = rD;
    }
    segs.push({ d: Ua, a: rStart, b: 'c' }, { d: Math.max(0, Tw - Ua - Ub), a: 'c', b: 'c' }, { d: Ub, a: 'c', b: r1 });
    this.prof = new RateProfile(segs, this.F1 - this.F0);
    // (short planet -> moon hops may cruise slower than their ends; only a non-positive cruise is an error)
    if (!(this.prof.c > 0)) console.warn('[director] leg cruise rate not positive', from.anchor, to.anchor, this.prof.c);
    // time at which the dwell ends (the turn to the destination must be done by then)
    this.tDwell = this.t0 + this.dwell;
  }
  _anchorPos(endState, t, out) {
    if (endState.anchorPos) return out.copy(endState.anchorPos);
    return this.rig.W.pos(endState.anchor, this.rig.clock(t), out);
  }
  // the route between the two anchor centres (bowed chord); s in [0,1]
  _arc(s, t, out) {
    const A = this._anchorPos(this.ex, t, _x);
    const B = this._anchorPos(this.en, t, _y);
    out.copy(A).lerp(B, s);
    if (this.geom && this.geom.h > 0) out.addScaledVector(this.geom.n, this.geom.h * 4 * s * (1 - s));
    if (this.lift) out.addScaledVector(this.rig.W.ECL_N, this.lift * 4 * s * (1 - s) * (this.L || A.distanceTo(B)));
    return out;
  }
  progress(t) {
    if (this.tCut !== undefined) {
      if (t < this.tCut) return this.F0 + this.prof.integral(clamp(t - this.t0, 0, this.tCut - this.t0));
      return this.Fafter + this.prof2.integral(clamp(t - this.tCut, 0, this.t1 - this.tCut));
    }
    const x = clamp(t - this.t0, 0, this.T);
    return this.F0 + this.prof.integral(x);
  }
  position(t, out = new THREE.Vector3()) {
    const F = this.progress(t);
    const sF = sigmoid(F);
    if (this.tCut !== undefined) {
      // a cut leg recedes radially from the world it leaves until the cut (even past mid-route, on a short hop)
      if (t < this.tCut) return this._anchorPos(this.ex, t, out).addScaledVector(this.ex.dir, this.L * sF);
      if (this.radialB) return this._anchorPos(this.en, t, out).addScaledVector(this.en.dir, this.L * (1 - sF));
    }
    // route parameter at the same fraction of the route length as the camera's distance from A (rhoA = L sF), so
    // the route point H stays level with the radial exit / entry and the blend between them is monotone
    const s = this.sOf.value(clamp(sF, 0, 1));
    const rhoA = this.L * sF, rhoB = this.L * (1 - sF);
    const H = this._arc(s, t, new THREE.Vector3());
    const wA = 1 - smootherstep(this.winA[0], this.winA[1], Math.log(rhoA));
    const wB = 1 - smootherstep(this.winB[0], this.winB[1], Math.log(rhoB));
    if (wA > 0 && rhoA <= rhoB) {
      const A = this._anchorPos(this.ex, t, new THREE.Vector3());
      const hd = H.clone().sub(A);
      const hl = hd.length();
      const dir = hl > 1e-9 && wA < 1 ? slerpDir(this.ex.dir, hd.divideScalar(hl), 1 - wA, new THREE.Vector3(), this.rig.W.ECL_N) : this.ex.dir.clone();
      const dist = rhoA * wA + hl * (1 - wA);
      return out.copy(A).addScaledVector(dir, dist);
    }
    if (wB > 0 && rhoB < rhoA) {
      const B = this._anchorPos(this.en, t, new THREE.Vector3());
      const hd = H.clone().sub(B);
      const hl = hd.length();
      const dir = hl > 1e-9 && wB < 1 ? slerpDir(this.en.dir, hd.divideScalar(hl), 1 - wB, new THREE.Vector3(), this.rig.W.ECL_N) : this.en.dir.clone();
      const dist = rhoB * wB + hl * (1 - wB);
      return out.copy(B).addScaledVector(dir, dist);
    }
    return out.copy(H);
  }
}

/**
 * The finale's retreat: from just off a (moving) world out to a fixed far point Q, in log distance from the world.
 * ln D follows a rate profile (RateProfile: ramp up from rest, a steady Powers-of-Ten rate while the world and its
 * planet shrink, then a long ease-out), scaled so D reaches |Q - world| exactly at tEnd, after which the camera
 * rests at Q. The direction from the world swings from the block's last direction to Q's (smootherstep in the
 * first part of the climb, while the world still dominates), so the path is C1 with the block before it and
 * comes to rest without a jolt.
 */
export class PullBack {
  constructor(rig, { anchor, t0, t1, tEnd, d0, dir0, Q, segs, swingU }) {
    this.rig = rig;
    this.kind = 'pull';
    this.anchor = anchor;
    this.t0 = t0;
    this.t1 = t1;
    this.tEnd = tEnd;
    this.d0 = d0;
    this.dir0 = dir0.clone().normalize();
    this.Q = Q.clone();
    const T = rig.W.pos(anchor, rig.clock(t0 + 3 * (1 - Math.exp(-(tEnd - t0) / 3))), new THREE.Vector3());
    this.uEnd = Math.log(this.Q.distanceTo(T) / d0);
    // the swing from dir0 toward Q happens in this ln-distance window (late: the world and its planet are points
    // of light by then, so the camera never has to orbit them at close range)
    this.swing = [Math.min(swingU ?? 0, this.uEnd - 1), this.uEnd - 0.2];
    // segs are relative rates; scale them so the integral is exactly uEnd
    const prof = new RateProfile(segs, 1);
    const k = this.uEnd / prof.integral(tEnd - t0);
    this.prof = new RateProfile(segs.map((s) => ({ d: s.d, a: s.a === 'c' ? 'c' : s.a * k, b: s.b === 'c' ? 'c' : s.b * k })), this.uEnd);
    this._T = new THREE.Vector3();
    this._q = new THREE.Vector3();
  }
  u(t) {
    return this.prof.integral(clamp(t, this.t0, this.tEnd) - this.t0);
  }
  position(t, out = new THREE.Vector3()) {
    if (t >= this.tEnd) return out.copy(this.Q);
    // the world's own motion is followed at first (C1 with the block), then smoothly frozen once the camera is
    // far from it (its orbit no longer matters), so the camera comes to rest at Q without a residual drift
    const tau = this.t0 + 3 * (1 - Math.exp(-(t - this.t0) / 3));
    const T = this.rig.W.pos(this.anchor, this.rig.clock(tau), this._T);
    const u = this.u(t);
    const toQ = this._q.copy(this.Q).sub(T);
    const dQ = toQ.length();
    toQ.divideScalar(dQ);
    const w = smootherstep(this.swing[0], this.swing[1], u);
    const dir = slerpDir(this.dir0, toQ, w, new THREE.Vector3());
    // (distance as a fraction of the live distance to Q: it reaches Q exactly at tEnd, never overshoots)
    return out.copy(T).addScaledVector(dir, dQ * Math.exp(u - this.uEnd));
  }
}

/** Holds the clock and the time-ordered list of position segments. */
export class Rig {
  constructor(W, clock) {
    this.W = W;
    this.clock = clock;
    this.segments = [];
  }
  add(seg) {
    this.segments.push(seg);
    return seg;
  }
  segmentAt(t) {
    const s = this.segments;
    if (t <= s[0].t0) return s[0];
    for (let i = 0; i < s.length; i++) if (t < s[i].t1) return s[i];
    return s[s.length - 1];
  }
  position(t, out = new THREE.Vector3()) {
    return this.segmentAt(t).position(t, out);
  }
}
