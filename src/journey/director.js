// FOUR LIGHT-HOURS — the director: camera choreography and timeline.
//
// create(ctx) builds the whole film once (deterministically, from the real planet positions for the epoch and
// the body modules' moon ephemerides), then evaluate(t) is a pure function of journey time t.
//
//   film.js   – the shot list: blocks around each world, warp legs, aim keys, exposure / FOV / sky tracks,
//               chapters, captions, labels, audio cues, the simulated clock and its searches (Io shadow, Moon
//               phase for Earthrise, Valles Marineris + Phobos, ...)
//   rig.js    – position paths (log-polar orbit blocks, logistic warp legs, fly-through)
//   world.js  – body / moon positions, shot frames, safety list
//   math.js   – Hermite tracks, easing, slerp
//   orbits.js – faint orbit ellipses for the finale (director.object)
import * as THREE from 'three';
import { DEG, KM_PER_UNIT, C_KM_S, radecToThree } from '../core/astro.js';
import { makeWorld } from './world.js';
import { buildFilm } from './film.js';
import { lookQuat, slerpDir, panSlerp, smootherstep, smoothstep, clamp, cruiseEase } from './math.js';
import { createOrbits } from './orbits.js';

export async function create(ctx) {
  const W = makeWorld(ctx);
  // the asteroid builder's field descriptor (pure constants); defaults if that module is unavailable
  let beltField = null;
  try {
    beltField = (await import('../bodies/asteroids/field.js')).FIELD || null;
  } catch (e) {
    beltField = null;
  }
  const film = buildFilm(ctx, W, { beltField });
  const { rig, clock, aimKeys, tracks, duration, chapters, captions, labelBeats, audioKeys } = film;
  // deliberate cuts (each under a dip to black): the camera's orientation (and, for a cut leg, its position) is
  // discontinuous there, so no smoothing, interpolation or finite difference may reach across one
  const cuts = (film.cuts || []).slice().sort((a, b) => a - b);
  const cutBetween = (a, b) => {
    for (const c of cuts) if (c > a && c <= b) return c;
    return null;
  };

  const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _vA = new THREE.Vector3();
  const ECL = new THREE.Vector3(0, 1, 0);

  // ------------------------------------------------------------------------------------------ clip guard
  // Every frame: keep the camera outside every body / moon (min altitude) and off every ring plane.
  // Smooth (softplus) so it never introduces a kink; it is a no-op on the designed paths.
  function guard(P, d, info) {
    let pushed = 0;
    for (const s of W.spheres) {
      W.pos(s.id, d, _c);
      _d.copy(P).sub(_c);
      const r = _d.length();
      const rmin = s.r * (1 + s.minAlt);
      if (r > rmin * 1.6) continue;
      const m = s.r * s.minAlt * 0.35;
      const x = (r - rmin) / m;
      const rNew = x > 9 ? r : rmin + m * Math.log1p(Math.exp(x)) - (x > 0 ? m * Math.log1p(Math.exp(-9)) * (x / 9) : 0);
      if (rNew - r > 1e-9) {
        P.copy(_c).addScaledVector(_d.divideScalar(Math.max(r, 1e-12)), rNew);
        pushed = Math.max(pushed, (rNew - r) / s.r);
        if (info) info.guard = s.id;
      }
    }
    for (const g of W.rings) {
      W.pos(g.id, d, _c);
      _d.copy(P).sub(_c);
      const h = _d.dot(g.n);
      _q.copy(_d).addScaledVector(g.n, -h);
      const rho = _q.length();
      const wIn = smoothstep(g.rIn * 0.97, g.rIn, rho) * (1 - smoothstep(g.rOut, g.rOut * 1.03, rho));
      if (wIn <= 0 || Math.abs(h) > g.h * 4) continue;
      const m = g.h * 0.4;
      const ah = Math.abs(h);
      const x = (ah - g.h) / m;
      const hNew = x > 20 ? ah : g.h + m * Math.log1p(Math.exp(x));
      const hh = ah + (hNew - ah) * wIn;
      if (hh - ah > 1e-9) {
        P.addScaledVector(g.n, (h >= 0 ? 1 : -1) * (hh - ah));
        pushed = Math.max(pushed, hh - ah);
        if (info) info.guard = g.id + '-rings';
      }
    }
    return pushed;
  }

  // ------------------------------------------------------------------------------------------ aim
  function resolveTarget(spec, t, P, d, out) {
    if (typeof spec === 'string') return W.pos(spec, d, out).sub(P).normalize();
    if (spec.mix) {
      const acc = new THREE.Vector3();
      for (const [s, w] of spec.mix) acc.addScaledVector(resolveTarget(s, t, P, d, new THREE.Vector3()), w);
      return out.copy(acc).normalize();
    }
    if (spec.pair) {
      // centre of the union of two discs (e.g. the Moon and Earth together): along their great circle, half way
      // between the far limb of one and the far limb of the other
      const [a, b] = spec.pair;
      const A = W.pos(a, d, new THREE.Vector3()).sub(P), B = W.pos(b, d, new THREE.Vector3()).sub(P);
      const rA = Math.asin(Math.min(1, W.radius(a) / A.length())), rB = Math.asin(Math.min(1, W.radius(b) / B.length()));
      A.normalize();
      B.normalize();
      const th = Math.acos(clamp(A.dot(B), -1, 1));
      if (th < 1e-6) return out.copy(A);
      const c = (th + rB - rA) / 2 + (spec.bias || 0) * th;
      const axis = new THREE.Vector3().crossVectors(A, B).normalize();
      return out.copy(A).applyAxisAngle(axis, Math.min(th, c));
    }
    if (spec.radec) return radecToThree(spec.radec[0] * DEG, spec.radec[1] * DEG, out);
    if (spec.dir) return out.copy(spec.dir).normalize();
    if (spec.pos) return out.copy(spec.pos).sub(P).normalize();
    if (spec.rel) return W.pos(spec.rel, d, out).add(spec.v).sub(P).normalize();
    if (spec.place) {
      // composition: the subject sits `off` of the way (NDC, along its own image direction) from the frame centre
      // on the side away from `from` (e.g. the Sun just beyond the opposite frame edge), at any distance: the aim
      // offset is an angle computed from the current field of view, so a small disc is never pulled off the frame
      // the way a fixed direction mix does
      const D = resolveTarget(spec.place, t, P, d, new THREE.Vector3());
      const S = resolveTarget(spec.from || 'sun', t, P, d, new THREE.Vector3());
      const e = S.clone().addScaledVector(D, -S.dot(D));
      if (e.lengthSq() < 1e-12) return out.copy(D);
      e.normalize();
      const fovT = tracks.fov ? tracks.fov.value(t) : 35;
      const tv = Math.tan((fovT * Math.PI) / 360), th = (tv * 16) / 9;
      const r = new THREE.Vector3().crossVectors(D, ECL);
      if (r.lengthSq() < 1e-10) r.set(1, 0, 0);
      r.normalize();
      const uu = new THREE.Vector3().crossVectors(r, D);
      const cx = Math.abs(e.dot(r)), cy = Math.abs(e.dot(uu));
      const tanT = (spec.off ?? 0.35) / Math.max(1e-6, Math.max(cx / th, cy / tv));
      // never past the `from` body itself (it would then sit on the other side of the centre)
      const th0 = Math.min(Math.atan(tanT), 0.92 * Math.acos(clamp(S.dot(D), -1, 1)));
      return out.copy(D).multiplyScalar(Math.cos(th0)).addScaledVector(e, Math.sin(th0)).normalize();
    }
    if (spec.vel) return velDir(t, out);
    if (spec.horizon) {
      const C = W.pos(spec.horizon, d, new THREE.Vector3());
      const n = P.clone().sub(C);
      const r = n.length();
      n.divideScalar(r);
      const f = resolveTarget(spec.toward, t, P, d, new THREE.Vector3());
      f.addScaledVector(n, -f.dot(n));
      // when `toward` points (nearly) straight up/down, hand over smoothly to the fallback heading
      const tau = f.length();
      if (spec.fallback) {
        const g = resolveTarget(spec.fallback, t, P, d, new THREE.Vector3());
        g.addScaledVector(n, -g.dot(n));
        if (g.lengthSq() > 1e-12) {
          g.normalize();
          const w = smoothstep(0.06, 0.35, tau);
          f.multiplyScalar(tau > 1e-12 ? w / tau : 0).addScaledVector(g, 1 - w);
        }
      }
      if (f.lengthSq() < 1e-10) f.set(1, 0, 0).addScaledVector(n, -n.x);
      f.normalize();
      const R = W.radius(spec.horizon);
      // soft-capped so a climbing camera never ends up looking straight down its own vertical
      let dip = Math.acos(clamp(R / r, -1, 1)) + (spec.below || 0) * DEG;
      const dc = 45 * DEG, dw = 17 * DEG;
      if (dip > dc) dip = dc + dw * Math.tanh((dip - dc) / dw);
      return out.copy(f).multiplyScalar(Math.cos(dip)).addScaledVector(n, -Math.sin(dip));
    }
    return out.set(0, 0, -1);
  }
  function resolveUp(spec, P, d, out) {
    if (!spec || spec === 'ecl') return out.copy(ECL);
    if (spec.pole) return out.copy(W.pole(spec.pole));
    if (spec.radial) return W.pos(spec.radial, d, out).negate().add(P).normalize();
    if (spec.dir) return out.copy(spec.dir).normalize();
    return out.copy(ECL);
  }
  const _D0 = new THREE.Vector3(), _D1 = new THREE.Vector3(), _U0 = new THREE.Vector3(), _U1 = new THREE.Vector3();
  // Orientation from the aim keys. Within a blend the two key orientations (each a well-conditioned
  // look-at with its own up reference) are slerped as quaternions, so changing the up reference (ecliptic ->
  // local vertical) never passes through a degenerate roll. Wide swings (> 110 deg) are pans about the
  // vertical in a fixed turning direction instead.
  const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion();
  // q = qa * r^w with r = qa^-1 qb lifted continuously: its sign is chosen to agree with the relative rotation
  // measured once at mid-blend (k.rref), so a relative rotation passing 180 deg never flips the path, and the
  // arbitrary sign of setFromRotationMatrix never matters.
  const _r = new THREE.Quaternion(), _ri = new THREE.Quaternion();
  function qInterp(a, b, w, rref, out) {
    _r.copy(a).invert().multiply(b);
    if (rref && _r.x * rref.x + _r.y * rref.y + _r.z * rref.z + _r.w * rref.w < 0) _r.set(-_r.x, -_r.y, -_r.z, -_r.w);
    const c = Math.max(-1, Math.min(1, _r.w));
    const half = Math.acos(c);
    const sh = Math.sqrt(Math.max(0, 1 - c * c));
    if (sh < 1e-9) _ri.identity();
    else {
      const k = Math.sin(w * half) / sh;
      _ri.set(_r.x * k, _r.y * k, _r.z * k, Math.cos(w * half));
    }
    return out.copy(a).multiply(_ri).normalize();
  }
  function aimAt(t, P, d, outQ) {
    let i = 0;
    while (i + 1 < aimKeys.length && aimKeys[i + 1].t <= t) i++;
    const k = aimKeys[i];
    resolveTarget(k.target, t, P, d, _D1);
    resolveUp(k.up, P, d, _U1);
    if (i > 0 && t < k.t + k.blend) {
      // 'cruise' blends (long turns) accelerate over the first and last quarter and turn at a constant rate in
      // between (peak rate 1.33x the mean instead of 1.875x for smootherstep)
      const w = k.ease === 'cruise' ? cruiseEase(clamp((t - k.t) / k.blend, 0, 1), 0, 0, 0.25, 0.25) : smootherstep(k.t, k.t + k.blend, t);
      const kp = aimKeys[i - 1];
      if (k.D0fixed) {
        _D0.copy(k.D0fixed);
        _U0.copy(k.U0fixed);
      } else {
        resolveTarget(kp.target, t, P, d, _D0);
        resolveUp(kp.up, P, d, _U0);
      }
      if (k.pan) {
        slerpDir(_U0, _U1, w, _up, _D1);
        panSlerp(_D0, _D1, w, _up, k.panLon, _dir);
        return lookQuat(_dir, _up, outQ);
      }
      lookQuat(_D0, _U0, _qa);
      lookQuat(_D1, _U1, _qb);
      qInterp(_qa, _qb, w, k.rref, outQ);
      if (k.push) {
        // a departure turn keeps the Sun out of the frame: the view is pushed away from it along the great circle
        // through the Sun by a precomputed, smooth amount (zero at both ends of the turn)
        const x = clamp(w, 0, 1) * (k.push.length - 1), i = Math.min(k.push.length - 2, Math.floor(x)), f = x - i;
        const p = k.push[i] * (1 - f) + k.push[i + 1] * f;
        if (p > 1e-5) outQ.premultiply(_qr.setFromAxisAngle(k.pushAxis, p)).normalize();
        return outQ;
      }
      if (k.bow) {
        // bow the turn away from the Sun: rotate the view by bow * sin(pi w) about the axis that tilts it away
        _dir.set(0, 0, -1).applyQuaternion(outQ);
        _up.crossVectors(_dir, k.bowN).normalize();
        if (_up.lengthSq() > 0.5) outQ.premultiply(_qr.setFromAxisAngle(_up, k.bow * Math.sin(Math.PI * w)));
      }
      return outQ;
    }
    return lookQuat(_D1, _U1, outQ);
  }

  // a blend must finish before the next key starts (otherwise the next key would start from a half-blended
  // state): shorten any overlapping blend and remember it for the validation report
  const clampedBlends = [];
  for (let i = 1; i + 1 < aimKeys.length; i++) {
    const k = aimKeys[i], kn = aimKeys[i + 1];
    if (k.t + k.blend > kn.t) {
      clampedBlends.push(`${k.t.toFixed(2)}: ${k.blend.toFixed(2)} -> ${(kn.t - k.t).toFixed(2)}`);
      k.blend = Math.max(0, kn.t - k.t);
    }
  }

  // wide aim swings become pans with a fixed turning direction (decided once, at mid-blend)
  for (let i = 1; i < aimKeys.length; i++) {
    const k = aimKeys[i], kp = aimKeys[i - 1];
    if (!(k.blend > 0)) continue;
    // during a warp leg the world being left is released as a fixed direction (seen at the key's start):
    // at warp speed its live direction would sweep across the sky faster than the camera should turn
    // a departure turn (k.qslerp) also starts from a fixed orientation: it is one constant-rate rotation (a
    // quaternion slerp under cruise easing) from the block's last framing to the destination, roll included
    if (k.qslerp || rig.segmentAt(k.t + 1e-3).kind === 'leg') {
      const P0 = rig.position(k.t, new THREE.Vector3()), d0 = clock(k.t);
      k.D0fixed = resolveTarget(kp.target, k.t, P0, d0, new THREE.Vector3());
      k.U0fixed = resolveUp(kp.up, P0, d0, new THREE.Vector3());
    }
    const tm = k.t + k.blend / 2;
    const d = clock(tm);
    const P = rig.position(tm, new THREE.Vector3());
    const a = k.D0fixed ? k.D0fixed.clone() : resolveTarget(kp.target, tm, P, d, new THREE.Vector3());
    const b = resolveTarget(k.target, tm, P, d, new THREE.Vector3());
    const u = resolveUp(k.up, P, d, new THREE.Vector3());
    // quaternion hemisphere for the blend, fixed once so a relative rotation passing 180 deg never flips
    {
      const ua = k.U0fixed ? k.U0fixed.clone() : resolveUp(kp.up, P, d, new THREE.Vector3());
      const qa = lookQuat(a, ua, new THREE.Quaternion()), qb = lookQuat(b, u, new THREE.Quaternion());
      k.rref = qa.clone().invert().multiply(qb);
      if (k.rref.w < 0) k.rref.set(-k.rref.x, -k.rref.y, -k.rref.z, -k.rref.w); // shortest way at mid-blend
    }
    if (k.avoidSun && k.qslerp) {
      // departure turn: how far the plain rotation would bring the view to the Sun, sampled along the turn; the
      // view is pushed away from it to SUN_CLEAR (just outside the frame), smoothly, vanishing at both ends
      const SUN_CLEAR = 56 * DEG, NP = 48;
      const ua = k.U0fixed ? k.U0fixed.clone() : resolveUp(kp.up, P, d, new THREE.Vector3());
      const qa = lookQuat(a, ua, new THREE.Quaternion());
      const raw = new Float64Array(NP + 1);
      const Ps = new THREE.Vector3(), bs = new THREE.Vector3(), us = new THREE.Vector3(), qb = new THREE.Quaternion(), qw = new THREE.Quaternion(), f = new THREE.Vector3();
      for (let i = 0; i <= NP; i++) {
        const wv = i / NP;
        const ts = k.t + wv * k.blend, dd = clock(ts);
        rig.position(ts, Ps);
        resolveTarget(k.target, ts, Ps, dd, bs);
        resolveUp(k.up, Ps, dd, us);
        lookQuat(bs, us, qb);
        qInterp(qa, qb, wv, k.rref, qw);
        f.set(0, 0, -1).applyQuaternion(qw);
        const sunS = Ps.clone().negate().normalize();
        const psi = f.angleTo(sunS);
        raw[i] = Math.max(0, SUN_CLEAR - psi);
        // one fixed push axis (where the turn passes closest to the Sun): a push about a moving axis would wobble
        if (raw[i] > (k._pmax || 0) && i > 0 && i < NP) {
          k._pmax = raw[i];
          const ax = sunS.clone().cross(f);
          if (ax.lengthSq() > 1e-10) k.pushAxis = ax.normalize();
        }
      }
      // (the push unwinds over the second half of the turn: a destination close to the Sun is then reached from
      // the side away from it, and the unwinding never adds a whip at the end)
      const env = (wv) => smoothstep(0, 0.22, wv) * (1 - smoothstep(0.45, 1, wv));
      const push = new Float64Array(NP + 1);
      let any = false;
      for (let i = 0; i <= NP; i++) {
        let s = 0, ww = 0;
        for (let j = Math.max(0, i - 8); j <= Math.min(NP, i + 8); j++) {
          const kk = Math.exp(-0.5 * ((j - i) / 3.5) ** 2);
          s += kk * raw[j];
          ww += kk;
        }
        push[i] = Math.min(42 * DEG, (1.15 * s) / ww) * env(i / NP);
        if (push[i] > 0.5 * DEG) any = true;
      }
      if (any && k.pushAxis) k.push = push;
    } else if (k.avoidSun && a.dot(b) >= Math.cos(110 * DEG)) {
      // a short turn whose great circle passes close to the Sun is bowed away from it (by up to 35 deg)
      // (sampled along the blend: at warp the Sun's direction itself swings as the camera covers AU per second)
      let m = Math.PI, side = 0;
      const Ps = new THREE.Vector3(), bs = new THREE.Vector3(), ds = new THREE.Vector3();
      // (a departure turn starts at the world it leaves, often a crescent next to the Sun: only its middle counts)
      for (let s = k.qslerp ? 0.35 : 0.15; s <= 0.851; s += 0.05) {
        const ts = k.t + s * k.blend, dd = clock(ts);
        rig.position(ts, Ps);
        resolveTarget(k.target, ts, Ps, dd, bs);
        slerpDir(a, bs, smootherstep(0, 1, s), ds);
        const sunS = Ps.clone().negate().normalize();
        const ang = ds.angleTo(sunS);
        if (ang < m) {
          m = ang;
          const n = a.clone().cross(bs).normalize();
          side = sunS.dot(n) > 0 ? -1 : 1;
          k.bowN = n.multiplyScalar(side); // tilt toward the side away from the Sun
        }
      }
      const want = k.qslerp ? 30 * DEG : 44 * DEG;
      if (m < want && side) k.bow = Math.min(k.qslerp ? 25 * DEG : 44 * DEG, want - m + 4 * DEG);
      else delete k.bowN;
    }
    if (!k.qslerp && a.dot(b) < Math.cos(110 * DEG)) {
      const e1 = a.clone().addScaledVector(u, -a.dot(u)).normalize();
      const e2 = u.clone().cross(e1);
      const lon = Math.atan2(b.dot(e2), b.dot(e1));
      k.pan = true;
      k.panLon = k.panSign ? (k.panSign > 0 ? (lon < 0 ? lon + 2 * Math.PI : lon) : lon > 0 ? lon - 2 * Math.PI : lon) : lon;
      if (k.avoidSun && !k.panSign) {
        // turn the way that keeps the Sun furthest from the view (a pan sweeping through the Sun at warp is a
        // white streak across the frame); the short way unless the long way is clearly better
        const sunD = P.clone().negate().normalize();
        // penalty = time the view spends within 45 deg of the Sun (both ways start next to it when leaving a
        // crescent, so the closest approach alone cannot tell them apart)
        const sunTime = (ref) => {
          let pen = 0;
          for (let s = 0; s <= 1.0001; s += 0.04) pen += Math.max(0, 45 * DEG - panSlerp(a, b, s, u, ref, new THREE.Vector3()).angleTo(sunD));
          return pen;
        };
        const alt = lon > 0 ? lon - 2 * Math.PI : lon + 2 * Math.PI;
        if (Math.abs(alt) < 1.3 * Math.PI && sunTime(alt) < 0.6 * sunTime(lon) - 0.05) k.panLon = alt;
      }
    }
  }

  // ------------------------------------------------------------------------------------------ evaluate helpers
  const val = (name, t, dflt) => (tracks[name] ? tracks[name].value(t) : dflt);
  const _dir = new THREE.Vector3(), _up = new THREE.Vector3(), _e = new THREE.Euler();
  const _qr = new THREE.Quaternion();

  function chapterIndexAt(t) {
    let ci = 0;
    for (let i = 0; i < chapters.length; i++) if (t >= chapters[i].t0) ci = i;
    return ci;
  }
  // camera position exactly as evaluate() places it (path + clip guard)
  function camAt(t, out = new THREE.Vector3()) {
    rig.position(t, out);
    guard(out, clock(t), null);
    return out;
  }
  // speed of the camera itself (central difference of the guarded path; pure, consistent with what is drawn);
  // one-sided next to a cut (a cut leg jumps forward along its route under the dip to black)
  const _sp = new THREE.Vector3(), _sq = new THREE.Vector3();
  function diffWindow(t, h) {
    let ta = Math.min(duration, t + h), tb = Math.max(0, t - h);
    const c = cutBetween(tb, ta);
    if (c !== null) {
      if (t < c) (ta = Math.min(t, c - 1e-6)), (tb = ta - 2 * h);
      else (tb = t), (ta = t + 2 * h);
    }
    return [tb, ta];
  }
  function speedAt(t) {
    const [tb, ta] = diffWindow(t, 1 / 240);
    camAt(ta, _sp);
    camAt(tb, _sq);
    return _sp.distanceTo(_sq) / (ta - tb);
  }
  function velDir(t, out) {
    const [tb, ta] = diffWindow(t, 0.05);
    rig.position(ta, _vA);
    rig.position(tb, out);
    out.subVectors(_vA, out);
    if (out.lengthSq() < 1e-20) return out.set(0, 0, -1);
    return out.normalize();
  }
  const warpOf = (speedC) => smoothstep(0.45, 2.6, Math.log10(Math.max(speedC, 1e-6))); // ~3 c -> 0, ~400 c -> 1
  // the authored orientation: aim keys + yaw / pitch / roll tracks
  function rawAim(t, P, d, out) {
    aimAt(t, P, d, out);
    const yaw = val('yaw', t, 0), pitch = val('pitch', t, 0), roll = val('roll', t, 0);
    if (yaw || pitch || roll) out.multiply(_qr.setFromEuler(_e.set(pitch * DEG, -yaw * DEG, roll * DEG, 'YXZ')));
    return out;
  }

  // ------------------------------------------------------------------------------------------ orientation track
  // The camera operator's fluid head: the authored orientation is sampled at build time and smoothed with a
  // zero-phase Gaussian whose width adapts locally until the angular velocity stays under an FOV-scaled cap
  // (CAP_K x FOV per second; a tighter field of view pans slower) and the roll rate under ROLL_CAP. A fast turn
  // therefore starts a little earlier and ends a little later instead of whipping; slow tracking is untouched.
  // At warp (streaking stars, radial blur) the camera must hold still: the cap tightens to CAP_WARP deg/s, so
  // the warp's streaks always radiate from the destination instead of smearing sideways. The departure pans
  // (film.js legAim: at low speed, the field opened up, before the warp) may run at CAP_PAN x FOV.
  // evaluate(t) interpolates the result, so it stays a pure function of t.
  const HZ = 30, CAP_K = 0.22, CAP_ABS = 12, CAP_PAN = 0.3, CAP_WARP = 6, ROLL_CAP = 8, ROLL_WARP = 4, SIG0 = 0.1, SIG_MAX = 4.0, SIG_SLOPE = 0.6;
  const NQ = Math.ceil(duration * HZ) + 1, hQ = duration / (NQ - 1);
  // cut segments: sample i belongs to [SLO[i], SHI[i]] (sample indices between two cuts)
  const SLO = new Int32Array(NQ), SHI = new Int32Array(NQ);
  // (the first sample index whose time i * hQ, in the same floating-point arithmetic rawAim sees, is >= the cut)
  const firstAfter = (c) => {
    let b = Math.max(0, Math.ceil(c / hQ - 1e-6));
    while (b * hQ < c) b++;
    while (b > 0 && (b - 1) * hQ >= c) b--;
    return b;
  };
  {
    const bounds = [0, ...cuts.map(firstAfter), NQ];
    for (let b = 0; b + 1 < bounds.length; b++)
      for (let i = bounds[b]; i < Math.min(NQ, bounds[b + 1]); i++) {
        SLO[i] = bounds[b];
        SHI[i] = Math.min(NQ, bounds[b + 1]) - 1;
      }
  }
  const QS = new Float64Array(NQ * 4); // smoothed orientation samples
  const AV = new Float32Array(NQ * 3); // angular velocity samples (deg/s total, about the view axis, cap)
  const buildStats = {};
  const DBG = {};
  {
    const tb = typeof performance !== 'undefined' ? performance.now() : 0;
    const raw = new Float64Array(NQ * 4), fovS = new Float64Array(NQ), cap = new Float64Array(NQ), rcap = new Float64Array(NQ);
    const P = new THREE.Vector3(), q = new THREE.Quaternion();
    let px = 0, py = 0, pz = 0, pw = 1;
    for (let i = 0; i < NQ; i++) {
      const t = i * hQ, d = clock(t);
      camAt(t, P);
      rawAim(t, P, d, q);
      if (i > 0 && q.x * px + q.y * py + q.z * pz + q.w * pw < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      raw[i * 4] = px = q.x;
      raw[i * 4 + 1] = py = q.y;
      raw[i * 4 + 2] = pz = q.z;
      raw[i * 4 + 3] = pw = q.w;
      const fv = val('fov', t, 35);
      fovS[i] = fv;
      const wf = smoothstep(0.25, 0.5, warpOf((speedAt(t) * KM_PER_UNIT) / C_KM_S));
      // (a field narrower than 12 deg is a zoom onto a subject that is already centred: its small re-centring
      // moves are not pans)
      const fc = Math.max(fv, 12);
      let kp = 0;
      for (const p of film.pans || []) kp = Math.max(kp, smoothstep(p.t0 - 0.6, p.t0, t) * (1 - smoothstep(p.t1, p.t1 + 0.6, t)));
      const kk = CAP_K + (CAP_PAN - CAP_K) * kp;
      cap[i] = Math.min(kk * fc, CAP_ABS) * (1 - wf) + Math.min(kk * fc, CAP_WARP) * wf;
      rcap[i] = ROLL_CAP * (1 - wf) + ROLL_WARP * wf;
    }
    const tRaw = tb ? performance.now() - tb : 0;
    const sig = new Float64Array(NQ).fill(SIG0);
    // holds: windows the film keeps at its authored rates (e.g. Earthrise: a zoom to 10 deg on a static horizon);
    // the smoothing width is capped there, ramping back over 1 s outside
    const sigCap = new Float64Array(NQ).fill(SIG_MAX);
    for (const hld of film.holds || [])
      for (let i = 0; i < NQ; i++) {
        const t = i * hQ;
        const dOut = Math.max(hld.t0 - t, t - hld.t1, 0);
        sigCap[i] = Math.min(sigCap[i], SIG0 + (SIG_MAX - SIG0) * smoothstep(0, 1.2, dOut));
      }
    const out = QS;
    const lastSig = new Float64Array(NQ).fill(-1);
    const GL = new Float64Array(2701); // exp(-u^2/2) for u in [0, 2.7] at 0.001
    for (let i = 0; i < GL.length; i++) GL[i] = Math.exp(-0.5 * (i / 1000) ** 2);
    const smoothQ = () => {
      for (let i = 0; i < NQ; i++) {
        // a sample is only re-smoothed when its width changed (the raw path never changes)
        if (Math.abs(sig[i] - lastSig[i]) < 1e-4) continue;
        lastSig[i] = sig[i];
        const s = sig[i] / hQ;
        const R = Math.min(NQ, Math.ceil(2.6 * s));
        // the raw samples are sign-aligned consecutively, so the path is continuous in 4D and its weighted sum is
        // well defined (re-aligning against the centre sample flipped signs half way through long turns)
        let x = 0, y = 0, z = 0, w = 0;
        const inv = 1000 / s;
        for (let j = Math.max(SLO[i], i - R); j <= Math.min(SHI[i], i + R); j++) {
          const k = GL[Math.min(2700, Math.round(Math.abs(j - i) * inv))];
          const bx = raw[j * 4], by = raw[j * 4 + 1], bz = raw[j * 4 + 2], bw = raw[j * 4 + 3];
          x += k * bx;
          y += k * by;
          z += k * bz;
          w += k * bw;
        }
        const n = Math.hypot(x, y, z, w) || 1;
        out[i * 4] = x / n;
        out[i * 4 + 1] = y / n;
        out[i * 4 + 2] = z / n;
        out[i * 4 + 3] = w / n;
      }
      for (let i = 1; i < NQ; i++)
        if (out[i * 4] * out[i * 4 - 4] + out[i * 4 + 1] * out[i * 4 - 3] + out[i * 4 + 2] * out[i * 4 - 2] + out[i * 4 + 3] * out[i * 4 - 1] < 0)
          for (let c = 0; c < 4; c++) out[i * 4 + c] = -out[i * 4 + c];
    };
    const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
    const rates = () => {
      let worst = 0;
      for (let i = 0; i < NQ; i++) {
        const a = Math.max(SLO[i], i - 1), b = Math.min(SHI[i], i + 1);
        qa.fromArray(out, a * 4);
        qb.fromArray(out, b * 4);
        _qr.copy(qa).invert().multiply(qb);
        if (_qr.w < 0) _qr.set(-_qr.x, -_qr.y, -_qr.z, -_qr.w);
        const ang = 2 * Math.acos(Math.min(1, _qr.w));
        const sh = Math.sqrt(Math.max(1e-30, 1 - _qr.w * _qr.w));
        const dtq = (b - a) * hQ;
        const wd = ((ang / dtq) * 180) / Math.PI;
        const rd = Math.abs((((ang * _qr.z) / sh / dtq) * 180) / Math.PI);
        AV[i * 3] = wd;
        AV[i * 3 + 1] = (((ang * _qr.z) / sh / dtq) * 180) / Math.PI;
        AV[i * 3 + 2] = cap[i];
        const r = Math.max(wd / cap[i], rd / rcap[i]);
        worst = Math.max(worst, r);
        need[i] = r;
      }
      return worst;
    };
    const need = new Float64Array(NQ), tmp = new Float64Array(NQ);
    let iter = 0, worst = 0;
    for (; iter < 26; iter++) {
      smoothQ();
      worst = rates();
      if (worst < 1.03) break;
      // widen the smoothing where the rate is over the cap, then spread the widening (running max over the
      // turn, then a blur) so the smoothing width itself varies smoothly in time
      for (let i = 0; i < NQ; i++) tmp[i] = need[i] > 1 ? Math.min(SIG_MAX, sig[i] * Math.pow(need[i], 1.3) + 0.05) : 0;
      for (let i = 0; i < NQ; i++) {
        if (!tmp[i]) continue;
        const R = Math.ceil((1.5 * tmp[i]) / hQ);
        for (let j = Math.max(0, i - R); j <= Math.min(NQ - 1, i + R); j++) sig[j] = Math.max(sig[j], tmp[i] * Math.sqrt(1 - Math.abs(j - i) / (R + 1)));
      }
      // light blur of sigma
      for (let i = 0; i < NQ; i++) {
        let s = 0, ww = 0;
        for (let j = Math.max(0, i - 6); j <= Math.min(NQ - 1, i + 6); j++) {
          const k = Math.exp(-0.5 * ((j - i) / 3) ** 2);
          s += k * sig[j];
          ww += k;
        }
        tmp[i] = s / ww;
      }
      for (let i = 0; i < NQ; i++) sig[i] = Math.max(SIG0, Math.min(sigCap[i], tmp[i]));
      // the smoothing width may only change slowly along the film (|d sigma / dt| <= SIG_SLOPE), so the output
      // never jumps where a wide smoothing meets a narrow one (e.g. at a hold)
      for (let i = 1; i < NQ; i++) sig[i] = Math.min(sig[i], sig[i - 1] + SIG_SLOPE * hQ);
      for (let i = NQ - 2; i >= 0; i--) sig[i] = Math.min(sig[i], sig[i + 1] + SIG_SLOPE * hQ);
    }
    // ---- safe frame: wherever the shot has a subject (shot.focus), its centre stays inside |NDC| < SAFE (a disc
    // large enough to fill much of the frame may sit further out, as long as a quarter of its radius reaches in).
    // Violations are measured on the smoothed track (offline: the whole film is known, so the correction looks
    // ahead like a feed-forward aim), turned into world-space rotation vectors, smoothed within their cut segment
    // (sigma 0.35 s) and applied; a few passes converge. Frames under a fade, and the film's free windows (the
    // cold open looks at the Milky Way before the Sun is revealed), are left alone.
    const SAFE = 0.6, SIGC = 0.35;
    let nCorr = 0, maxCorr = 0;
    {
      const P = new THREE.Vector3(), f = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3(), C = new THREE.Vector3(), ax = new THREE.Vector3();
      const raw3 = new Float64Array(NQ * 3), sm3 = new Float64Array(NQ * 3);
      const free = film.freeFrame || [];
      const RC = Math.ceil((2.6 * SIGC) / hQ);
      const KC = new Float64Array(RC + 1);
      for (let j = 0; j <= RC; j++) KC[j] = Math.exp(-0.5 * ((j * hQ) / SIGC) ** 2);
      const qc = new THREE.Quaternion();
      for (let pass = 0; pass < (globalThis.__DIR_NOSAFE ? 0 : 6); pass++) {
        raw3.fill(0);
        let any = false;
        for (let i = 0; i < NQ; i++) {
          const t = i * hQ;
          if (val('fade', t, 0) > 0.4) continue;
          if (free.some((w) => t >= w.t0 && t <= w.t1)) continue;
          const id = film.focusAt(t);
          if (!id || id === 'asteroids') continue;
          const d = clock(t);
          camAt(t, P);
          qa.fromArray(QS, i * 4);
          f.set(0, 0, -1).applyQuaternion(qa);
          r.set(1, 0, 0).applyQuaternion(qa);
          u.set(0, 1, 0).applyQuaternion(qa);
          W.pos(id, d, C).sub(P);
          const dist = C.length(), Rr = W.radius(id);
          if (dist <= Rr * 1.0001) continue;
          C.divideScalar(dist);
          const rho = Math.asin(Math.min(1, Rr / dist));
          const psi = Math.acos(clamp(C.dot(f), -1, 1));
          const ex = C.dot(r), ey = C.dot(u), en = Math.hypot(ex, ey);
          if (en < 1e-9) continue;
          const tv = Math.tan((val('fov', t, 35) * Math.PI) / 360), th = (tv * 16) / 9;
          const lbk = 1 - 0.256 * clamp(val('letterbox', t, 0), 0, 1);
          const smax = Math.min((SAFE * th) / Math.max(1e-9, Math.abs(ex / en)), (SAFE * tv * lbk) / Math.max(1e-9, Math.abs(ey / en)));
          // a small disc keeps its centre in the box; a large one (radius >~ 60% of the half field) only has to
          // reach into it (a low pass over a horizon has the planet's centre far below the frame)
          const kBig = smoothstep(0.05, 0.6, rho / Math.atan(tv));
          const excess = psi - (Math.atan(smax) + 0.97 * rho * kBig);
          // (a violation larger than ~25 deg is a framing the film intends, e.g. a moon about to slide into view from
          // behind its planet: the safe frame is a guard against drift, not a second aim)
          if (excess <= 2e-4 || excess > 25 * DEG) continue;
          ax.crossVectors(f, C);
          if (ax.lengthSq() < 1e-12) continue;
          ax.normalize().multiplyScalar(excess * 1.15);
          raw3[i * 3] = ax.x;
          raw3[i * 3 + 1] = ax.y;
          raw3[i * 3 + 2] = ax.z;
          any = true;
          if (pass === 0) nCorr++;
          maxCorr = Math.max(maxCorr, excess);
        }
        if (!any) break;
        for (let i = 0; i < NQ; i++) {
          let x = 0, y = 0, z = 0, w = 0;
          for (let j = Math.max(SLO[i], i - RC); j <= Math.min(SHI[i], i + RC); j++) {
            const k = KC[Math.abs(j - i)];
            x += k * raw3[j * 3];
            y += k * raw3[j * 3 + 1];
            z += k * raw3[j * 3 + 2];
            w += k;
          }
          // (normalised by the full kernel weight: a lone violating sample is not inflated)
          const wf = KC.reduce((a, b, j) => a + (j ? 2 * b : b), 0);
          sm3[i * 3] = x / wf;
          sm3[i * 3 + 1] = y / wf;
          sm3[i * 3 + 2] = z / wf;
          void w;
        }
        // a peak is diluted by the blur: scale each connected violation so its smoothed peak matches the raw peak
        for (let i = 0; i < NQ; i++) {
          const a = Math.hypot(sm3[i * 3], sm3[i * 3 + 1], sm3[i * 3 + 2]);
          if (a < 1e-7) continue;
          ax.set(sm3[i * 3], sm3[i * 3 + 1], sm3[i * 3 + 2]);
          const ang = ax.length();
          qc.setFromAxisAngle(ax.divideScalar(ang), Math.min(ang * 1.8, 60 * DEG));
          qa.fromArray(QS, i * 4).premultiply(qc).normalize();
          QS[i * 4] = qa.x;
          QS[i * 4 + 1] = qa.y;
          QS[i * 4 + 2] = qa.z;
          QS[i * 4 + 3] = qa.w;
        }
      }
      for (let i = 1; i < NQ; i++)
        if (QS[i * 4] * QS[i * 4 - 4] + QS[i * 4 + 1] * QS[i * 4 - 3] + QS[i * 4 + 2] * QS[i * 4 - 2] + QS[i * 4 + 3] * QS[i * 4 - 1] < 0)
          for (let c = 0; c < 4; c++) QS[i * 4 + c] = -QS[i * 4 + c];
      worst = rates();
    }
    DBG.sig = sig;
    DBG.sigCap = sigCap;
    buildStats.orientation = { iterations: iter + 1, worstOverCap: +worst.toFixed(2), maxSigma: +Math.max(...sig).toFixed(2), ms: tb ? +(performance.now() - tb).toFixed(0) : 0, rawMs: +tRaw.toFixed(0), safeFrameSamples: nCorr, safeFrameMaxDeg: +((maxCorr * 180) / Math.PI).toFixed(1) };
  }
  const _qA = new THREE.Quaternion(), _qB = new THREE.Quaternion();
  // Catmull-Rom on the (sign-aligned) quaternion components, renormalised: C1 between the 30 Hz samples
  // (within the cut segment that contains t: a cut is an instant change of view, never interpolated)
  function segOf(t) {
    let lo = 0, hi = NQ - 1;
    for (const c of cuts) {
      const b = firstAfter(c);
      if (t >= c) lo = b;
      else {
        hi = b - 1;
        break;
      }
    }
    return [lo, Math.max(lo, hi)];
  }
  function orientAt(t, out) {
    const [lo, hi] = segOf(t);
    if (hi <= lo) return out.fromArray(QS, lo * 4).normalize();
    const u = clamp(t / hQ, lo, hi);
    const i = Math.max(lo, Math.min(hi - 1, Math.floor(u))), f = clamp(u - i, 0, 1);
    const i0 = Math.max(lo, i - 1), i3 = Math.min(hi, i + 2);
    const f2 = f * f, f3 = f2 * f;
    const c0 = -0.5 * f3 + f2 - 0.5 * f, c1 = 1.5 * f3 - 2.5 * f2 + 1, c2 = -1.5 * f3 + 2 * f2 + 0.5 * f, c3 = 0.5 * f3 - 0.5 * f2;
    const o = [0, 0, 0, 0];
    for (let c = 0; c < 4; c++) o[c] = c0 * QS[i0 * 4 + c] + c1 * QS[i * 4 + c] + c2 * QS[(i + 1) * 4 + c] + c3 * QS[i3 * 4 + c];
    return out.set(o[0], o[1], o[2], o[3]).normalize();
  }
  const sampleAt = (arr, stride, k, t) => {
    const [lo, hi] = segOf(t);
    if (hi <= lo) return arr[lo * stride + k];
    const u = clamp(t / hQ, lo, hi);
    const i = Math.max(lo, Math.min(hi - 1, Math.floor(u))), f = clamp(u - i, 0, 1);
    return arr[i * stride + k] * (1 - f) + arr[(i + 1) * stride + k] * f;
  };

  // ------------------------------------------------------------------------------------------ exposure track
  // The authored EV track (per-beat intent, e.g. the Sun builder's exposures) is clamped by what is actually in
  // the frame: no darker than EV_FLOOR unless the Sun's disc covers part of the frame (a held Sun exposure can
  // never black out a frame that has turned away from the Sun), and no brighter than the large lit surfaces in
  // frame allow. Coverage comes from a 32x18 analytic ray cast against every body / moon sphere at 10 Hz; the
  // bounds are smoothed with a zero-phase Gaussian and joined with a soft max/min, so the exposure stays C1.
  const EV_FLOOR = -1.0, SUN_CEIL = -8.5;
  const HZE = 10, NE = Math.ceil(duration * HZE) + 1, hE = duration / (NE - 1);
  const EVS = new Float64Array(NE);
  const META = { sunCover: new Float32Array(NE) };
  {
    const lo = new Float64Array(NE), hi = new Float64Array(NE), auth = new Float64Array(NE);
    const P = new THREE.Vector3(), q = new THREE.Quaternion(), f = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3(), ray = new THREE.Vector3();
    const C = new THREE.Vector3(), sd = new THREE.Vector3();
    const all = [{ id: 'sun', r: W.radius('sun') }, ...W.spheres.filter((s) => s.id !== 'sun')];
    const ALB = { mercury: 0.14, venus: 0.75, earth: 0.35, moon: 0.12, mars: 0.25, jupiter: 0.5, saturn: 0.45, uranus: 0.5, neptune: 0.45, titan: 0.25, triton: 0.7 };
    const GX = 32, GY = 18;
    const cand = [];
    for (let k = 0; k < NE; k++) {
      const t = k * hE, d = clock(t);
      camAt(t, P);
      orientAt(t, q);
      const fov = val('fov', t, 35);
      f.set(0, 0, -1).applyQuaternion(q);
      r.set(1, 0, 0).applyQuaternion(q);
      u.set(0, 1, 0).applyQuaternion(q);
      const tv = Math.tan((fov * Math.PI) / 360), th = (tv * 16) / 9;
      const halfDiag = Math.atan(Math.hypot(tv, th));
      cand.length = 0;
      for (const s of all) {
        W.pos(s.id, d, C).sub(P);
        const dist = C.length();
        if (dist <= s.r) continue;
        const angR = Math.asin(Math.min(1, s.r / dist));
        const off = Math.acos(clamp(C.dot(f) / dist, -1, 1));
        if (off - angR < halfDiag) cand.push({ id: s.id, C: C.clone(), r: s.r, d2: dist * dist });
      }
      let nSun = 0, nLit = 0, Lmax = 0;
      const lits = [];
      for (let iy = 0; iy < GY; iy++)
        for (let ix = 0; ix < GX; ix++) {
          const x = ((ix + 0.5) / GX) * 2 - 1, y = ((iy + 0.5) / GY) * 2 - 1;
          ray.copy(f).addScaledVector(r, x * th).addScaledVector(u, y * tv).normalize();
          let best = Infinity, hit = null;
          for (const c of cand) {
            const b = ray.dot(c.C);
            if (b <= 0) continue;
            const h = b * b - (c.d2 - c.r * c.r);
            if (h <= 0) continue;
            const tt = b - Math.sqrt(h);
            if (tt < best) (best = tt), (hit = c);
          }
          if (!hit) continue;
          if (hit.id === 'sun') {
            nSun++;
            continue;
          }
          // Lambert radiance of the hit point under unit irradiance
          sd.copy(P).addScaledVector(ray, best).negate().normalize();
          const nx = ray.clone().multiplyScalar(best).sub(hit.C).normalize();
          const L = (ALB[hit.id] ?? 0.3) * 1.25 * Math.max(0, nx.dot(sd));
          if (L > 0.02) nLit++;
          lits.push(L);
        }
      const N = GX * GY;
      const sunCover = nSun / N;
      META.sunCover[k] = sunCover;
      // the floor: free while the Sun's disc fills >= ~3% of the frame, EV_FLOOR when it is gone
      lo[k] = EV_FLOOR - 14 * smoothstep(0.004, 0.03, sunCover);
      // the ceiling: the brightest lit surface that covers >= 2% of the frame stays below ~2.4 display-linear
      lits.sort((a, b) => b - a);
      const L2 = lits.length >= N * 0.02 ? lits[Math.floor(N * 0.02)] : 0;
      hi[k] = L2 > 1e-3 ? Math.log2(2.4 / L2) : 12;
      // the Sun's disc filling part of the frame (> 2 grid cells, a disc > ~100 px): never a blown-out white plate
      // (its centre is ~3000; post's bloom and flare take it from there). A small Sun (a sunrise over a planet's
      // limb, ~10 px) is left to blaze at the planet's exposure.
      if (sunCover > 0.003) hi[k] = Math.min(hi[k], SUN_CEIL);
      auth[k] = val('ev', t, 0);
    }
    const gblur = (a, sigS) => {
      const s = sigS / hE, R = Math.ceil(2.6 * s), o = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) {
        let acc = 0, ww = 0;
        for (let j = Math.max(0, i - R); j <= Math.min(a.length - 1, i + R); j++) {
          const kk = Math.exp(-0.5 * ((j - i) / s) ** 2);
          acc += kk * a[j];
          ww += kk;
        }
        o[i] = acc / ww;
      }
      return o;
    };
    // a running max before the blur so the floor rises only once the Sun has really left (no flicker)
    // (the ceiling looks ahead as a ramp of 4.5 EV/s: the exposure is already coming down, over ~2 s, when the
    // Sun's limb enters the frame; it lets go at 15 EV/s once it has left)
    const loM = new Float64Array(NE), hiM = new Float64Array(NE);
    for (let i = 0; i < NE; i++) {
      let m = -1e9, mh = 1e9;
      for (let j = Math.max(0, i - 2); j <= Math.min(NE - 1, i + 2); j++) m = Math.max(m, -lo[j]);
      for (let j = Math.max(0, i - 8); j <= Math.min(NE - 1, i + 30); j++) mh = Math.min(mh, hi[j] + (j > i ? 4.5 : 15) * Math.abs(j - i) * hE);
      loM[i] = -m;
      hiM[i] = mh;
    }
    const loS = gblur(loM, 0.3), hiS = gblur(hiM, 0.3);
    const k = 0.35;
    const smax = (a, b) => (a > b ? a + k * Math.log1p(Math.exp((b - a) / k)) : b + k * Math.log1p(Math.exp((a - b) / k)));
    const smin = (a, b) => -smax(-a, -b);
    const ev = new Float64Array(NE);
    let nFloor = 0, nCeil = 0;
    for (let i = 0; i < NE; i++) {
      let e = smax(auth[i], loS[i]);
      if (e > hiS[i] && auth[i] > hiS[i]) e = smin(e, hiS[i]);
      if (e - auth[i] > 0.3) nFloor++;
      if (auth[i] - e > 0.3) nCeil++;
      ev[i] = e;
    }
    EVS.set(gblur(ev, 0.12));
    buildStats.exposure = { floorEngagedS: +(nFloor * hE).toFixed(1), ceilingEngagedS: +(nCeil * hE).toFixed(1) };
  }
  function evAt(t) {
    const u = clamp(t / hE, 0, NE - 1);
    const i = Math.min(NE - 2, Math.floor(u)), f = u - i;
    const i0 = Math.max(0, i - 1), i3 = Math.min(NE - 1, i + 2);
    const f2 = f * f, f3 = f2 * f;
    return (-0.5 * f3 + f2 - 0.5 * f) * EVS[i0] + (1.5 * f3 - 2.5 * f2 + 1) * EVS[i] + (-1.5 * f3 + 2 * f2 + 0.5 * f) * EVS[i + 1] + (0.5 * f3 - 0.5 * f2) * EVS[i3];
  }

  // ------------------------------------------------------------------------------------------ chapters from the shots
  // A chapter (and its HUD title card) starts when the film has really left the previous world: the first time
  // after the block boundary that the warp has engaged (> 0.3) and every world of the previous chapter is
  // < 10 px or off screen. So URANUS is never printed beside Saturn's crescent.
  {
    const focalPx = (fov) => 450 / Math.tan((fov * Math.PI) / 360);
    const P = new THREE.Vector3(), q = new THREE.Quaternion(), f = new THREE.Vector3(), C = new THREE.Vector3();
    const ids = [...new Set(W.spheres.map((s) => s.id))];
    for (let i = 1; i < chapters.length; i++) {
      const ch = chapters[i];
      if (!ch.fromShot) continue;
      const prev = new Set(ch.leaving || []);
      let warped = false;
      let tNew = ch.t0;
      for (let t = ch.t0; t < ch.t0 + 14; t += 0.1) {
        const d = clock(t);
        camAt(t, P);
        orientAt(t, q);
        f.set(0, 0, -1).applyQuaternion(q);
        if (warpOf((speedAt(t) * KM_PER_UNIT) / C_KM_S) > 0.3) warped = true;
        let big = false;
        for (const id of ids) {
          if (!prev.has(id) && !prev.has(W.moonFns[id]?.parent)) continue;
          W.pos(id, d, C).sub(P);
          const dist = C.length();
          const z = C.dot(f);
          if (z <= 0) continue;
          const rpx = (W.radius(id) / dist) * focalPx(val('fov', t, 35));
          const off = Math.acos(clamp(z / dist, -1, 1));
          if (rpx > 10 && off < Math.atan(Math.tan((val('fov', t, 35) * Math.PI) / 360) * 1.9)) big = true;
        }
        if (warped && !big) {
          tNew = t;
          break;
        }
        tNew = t;
      }
      ch.t0 = Math.max(ch.t0, Math.min(tNew, chapters[i + 1] ? chapters[i + 1].t0 - 4 : duration));
    }
    for (let i = 0; i < chapters.length; i++) chapters[i].t1 = i + 1 < chapters.length ? chapters[i + 1].t0 : duration;
  }

  // ------------------------------------------------------------------------------------------ evaluate
  const _fw = new THREE.Vector3(), _rt = new THREE.Vector3(), _uw = new THREE.Vector3();
  function evaluate(tIn) {
    const t = clamp(tIn, 0, duration);
    const simDays = clock(t);
    const camPos = rig.position(t, new THREE.Vector3());
    const debug = {};
    const pushed = guard(camPos, simDays, debug);
    if (pushed > 0) debug.pushed = pushed;
    const seg = rig.segmentAt(t);

    const camQuat = orientAt(t, new THREE.Quaternion());

    const vUnits = speedAt(t);
    const speedKmS = vUnits * KM_PER_UNIT;
    const speedC = speedKmS / C_KM_S;
    const warp = warpOf(speedC);
    const ci = chapterIndexAt(t);
    const ch = chapters[ci];

    // captions active now (HUD fades them using t0/t1)
    const caps = [];
    for (const c of captions) if (t >= c.t0 - 0.5 && t <= c.t1 + 0.5) caps.push(c);
    // labels active now; a label whose point crowds a brighter / earlier one on screen fades out (no pile-ups)
    let labels = null;
    const fovNow = val('fov', t, 35);
    for (const b of labelBeats) {
      if (t < b.t0 || t > b.t1) continue;
      const a = Math.min(smoothstep(b.t0, b.t0 + 1.5, t), 1 - smoothstep(b.t1 - 1.5, b.t1, t));
      labels = labels || [];
      for (const id of b.ids) {
        const position = W.pos(id, simDays, new THREE.Vector3());
        const l = { id, name: W.name(id), position, alpha: a, kind: b.kind || 'body', ...(b.sub ? { sub: b.sub(id, t, position, camPos) } : {}), ...(b.priority ? { priority: b.priority } : {}) };
        // the pale blue dot's reticle is drawn as if around a ~9 px disc, so it rings the single pixel instead of
        // sitting on it (labels.js sizes the reticle from `radius`)
        if (l.kind === 'pale-blue-dot') l.radius = (position.distanceTo(camPos) * 9) / (450 / Math.tan((fovNow * Math.PI) / 360));
        labels.push(l);
      }
    }
    if (labels && labels.length > 1) {
      _fw.set(0, 0, -1).applyQuaternion(camQuat);
      _rt.set(1, 0, 0).applyQuaternion(camQuat);
      _uw.set(0, 1, 0).applyQuaternion(camQuat);
      const tv = Math.tan((fovNow * Math.PI) / 360), th = (tv * 16) / 9;
      const pts = labels.map((l) => {
        const v = l.position.clone().sub(camPos);
        const z = v.dot(_fw);
        return z > 0 ? { x: (v.dot(_rt) / z / th) * 800, y: (v.dot(_uw) / z / tv) * 450 } : null;
      });
      for (let i = 0; i < labels.length; i++) {
        if (!pts[i]) continue;
        let near = Infinity;
        for (let j = 0; j < i; j++) if (pts[j]) near = Math.min(near, Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y));
        const edge = Math.min(800 - Math.abs(pts[i].x), 450 - Math.abs(pts[i].y));
        labels[i].alpha *= smoothstep(30, 46, near) * smoothstep(20, 60, edge);
        // a moon's name must not print across its planet's disc: fade it near the parent's limb
        const par = W.moonFns[labels[i].id]?.parent;
        if (par) {
          const v = W.pos(par, simDays, new THREE.Vector3()).sub(camPos);
          const z = v.dot(_fw);
          if (z > 0) {
            const px = (v.dot(_rt) / z / th) * 800, py = (v.dot(_uw) / z / tv) * 450;
            const rpx = (W.radius(par) / v.length()) * (450 / tv);
            const gap = Math.hypot(pts[i].x - px, pts[i].y - py) - rpx;
            labels[i].alpha *= smoothstep(14, 44, gap);
          }
        }
      }
    }
    // audio cues
    let arrival = 0, departure = 0;
    if (seg.kind === 'leg') {
      const u = (t - seg.t0) / (seg.t1 - seg.t0);
      arrival = smoothstep(0.55, 1.0, u);
      departure = 1 - smoothstep(0.0, 0.45, u);
    } else if (seg.prevLeg) {
      arrival = 1 - smoothstep(0, 5, t - seg.t0);
    }
    const sunDist = camPos.length();
    const fov = fovNow;
    const evNow = evAt(t);
    const shot = {
      camPos,
      camQuat,
      fov,
      simDays,
      exposure: Math.pow(2, evNow),
      // camera angular velocity (deg/s) and its component about the view axis (roll), e.g. for motion blur
      angVel: sampleAt(AV, 3, 0, t),
      rollRate: sampleAt(AV, 3, 1, t),
      warp,
      speedC,
      speedKmS,
      skyGain: val('sky', t, 1),
      focus: film.focusAt(t),
      focusDistance: film.focusDistanceAt(t, camPos, simDays),
      chapter: ch.id,
      chapterIndex: ci,
      fade: clamp(val('fade', t, 0), 0, 1),
      letterbox: clamp(val('letterbox', t, 0), 0, 1),
      captions: caps,
      labels,
      lightTimeS: (sunDist * KM_PER_UNIT) / C_KM_S,
      sunDistanceKm: sunDist * KM_PER_UNIT,
      // (thin line art never under warp: post's radial blur would hatch it)
      orbits: clamp(val('orbits', t, 0), 0, 1) * (1 - smoothstep(0.03, 0.2, warp)),
      flare: Math.max(0, val('flare', t, 1)),
      glintGain: Math.max(0, val('glint', t, 1)),
      // display-space peak floor for planet glints (finale: planets as labelled points)
      glintFloor: clamp(val('glintFloor', t, 0), 0, 1),
      // the pale blue dot: every glint scaled so Earth's point peaks at `peak` after exposure (w blends it in)
      glintNorm: val('pbdNorm', t, 0) > 1e-3 ? { id: 'earth', peak: 0.42, w: clamp(val('pbdNorm', t, 0), 0, 1) } : null,
      // suggested gain for the wide-shot asteroid belt ring: the real belt is invisible to the eye, so it
      // fades out whenever the exposure is pushed for faint subjects (night side, eclipse, pale blue dot)
      // shot content: the ring belongs to the belt chapter and the finale's wide view only (the band it draws
      // along the ecliptic in the inner-planet shots is not something an eye or camera there would see)
      beltRing: clamp(val('beltRing', t, 0), 0, 1) * (1 - smoothstep(0.6, 1.6, evNow)),
      audio: {
        chapter: ch.id,
        chapterIndex: ci,
        warp,
        arrival,
        departure,
        intensity: clamp(val('intensity', t, 0.5), 0, 1),
        speedC,
        cue: audioKeys.find((a) => t >= a.t && t < a.t + (a.dur || 2))?.id || null,
      },
      debug,
    };
    return shot;
  }

  const orbits = createOrbits(ctx, W);

  return {
    duration,
    chapters,
    captions,
    audioCues: audioKeys,
    evaluate,
    beltCrossing: film.beltCrossing,
    object: orbits.object,
    update(frame) {
      orbits.update(frame);
    },
    // dev / validation helpers (not part of the contract)
    _film: film,
    _world: W,
    _clampedBlends: clampedBlends,
    _build: buildStats,
    _av: AV,
    _dbg: DBG,
    _hQ: hQ,
    _rawAim: (t) => {
      const P = camAt(t, new THREE.Vector3());
      return rawAim(t, P, clock(t), new THREE.Quaternion());
    },
  };
}
