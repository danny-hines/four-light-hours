// Motion checks at 60 Hz (offline): node src/journey/dev/motion.mjs [epochISO] [--from a --to b]
//  * turning at warp: windows where shot.warp > 0.5 while the camera turns faster than 12 deg/s (and 8 deg/s)
//  * path kinks / reversals: direction cosine between successive 1/60 s steps < 0.5
//  * acceleration kicks: frame-to-frame jumps in d(ln speed)/dt (a held shot that starts to move with a step)
//  * the destination's place in the frame at warp (angle between the view and the direction of travel)
import * as THREE from 'three';
import { KM_PER_UNIT } from '../../core/astro.js';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';

const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const argv = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const ctx = makeNodeCtx(epochISO);
const dir = await create(ctx);
const H = 1 / 60;
const T0 = argv('--from', 0), T1 = argv('--to', dir.duration);
const S = [];
// (deliberate cuts under a dip to black: samples within 2 frames after one are not motion)
const cuts = dir._film.cuts || [];
const nearCut = (t) => cuts.some((c) => t >= c - 1e-9 && t < c + 2.5 * H);
for (let t = T0; t <= T1 + 1e-9; t += H) {
  const s = dir.evaluate(t);
  if (nearCut(t)) continue;
  S.push({ t, P: s.camPos.clone(), Q: s.camQuat.clone(), warp: s.warp, fov: s.fov, seg: cuts.filter((c) => c <= t).length });
}
const ang = (a, b) => (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI;
const wins = (thr) => {
  const out = [];
  let w = null;
  for (let i = 1; i < S.length; i++) {
    if (S[i].seg !== S[i - 1].seg) continue;
    const av = ang(S[i - 1].Q, S[i].Q) / H;
    const bad = S[i].warp > 0.5 && av > thr;
    if (bad && !w) w = { t0: S[i].t, max: av };
    if (bad) w.max = Math.max(w.max, av);
    if (!bad && w) {
      w.t1 = S[i].t;
      out.push(w);
      w = null;
    }
  }
  if (w) (w.t1 = S[S.length - 1].t), out.push(w);
  return out;
};
const fmtW = (ws) => ws.map((w) => `${w.t0.toFixed(1)}-${w.t1.toFixed(1)}(${w.max.toFixed(0)})`).join(' ');
const sum = (ws) => ws.reduce((a, w) => a + w.t1 - w.t0, 0);
const w12 = wins(12), w8 = wins(8);
console.log(`# motion — ${epochISO}, duration ${dir.duration.toFixed(1)} s`);
console.log(`warp>0.5 & turn>12 deg/s: ${sum(w12).toFixed(1)} s in ${w12.length}: ${fmtW(w12)}`);
console.log(`warp>0.5 & turn>8 deg/s:  ${sum(w8).toFixed(1)} s in ${w8.length}: ${fmtW(w8)}`);
// kinks
const kinks = [];
for (let i = 2; i < S.length; i++) {
  if (S[i].seg !== S[i - 2].seg) continue;
  const v1 = S[i - 1].P.clone().sub(S[i - 2].P), v2 = S[i].P.clone().sub(S[i - 1].P);
  const l1 = v1.length(), l2 = v2.length();
  if (l1 > 1e-4 && l2 > 1e-4) { // (steps under ~600 m are floating-point noise at rest)
    const c = v1.dot(v2) / (l1 * l2);
    if (c < 0.5) kinks.push(`${S[i].t.toFixed(2)}(cos ${c.toFixed(2)}, ${((l2 / H) * KM_PER_UNIT).toFixed(0)} km/s)`);
  }
}
console.log(`path kinks (cos<0.5): ${kinks.length} ${kinks.slice(0, 12).join(' ')}`);
// acceleration kicks: d(ln v)/dt per frame, jumps between frames
const lv = S.map((s, i) => (i ? Math.log(Math.max(1e-30, s.P.distanceTo(S[i - 1].P) / H)) : 0));
const kicks = [];
for (let i = 3; i < S.length; i++) {
  if (S[i].seg !== S[i - 3].seg) continue;
  const r1 = (lv[i - 1] - lv[i - 2]) / H, r2 = (lv[i] - lv[i - 1]) / H;
  const j = Math.abs(r2 - r1);
  if (j > 2.5 && Math.abs(r2) > 1) kicks.push({ t: S[i].t, j, r1, r2 });
}
kicks.sort((a, b) => b.j - a.j);
console.log(`ln-speed rate jumps > 2.5/s per frame: ${kicks.length} ${kicks.slice(0, 10).map((k) => `${k.t.toFixed(2)}(${k.r1.toFixed(1)}->${k.r2.toFixed(1)})`).join(' ')}`);
// view vs travel at warp
let offMax = { v: 0 };
for (let i = 1; i < S.length; i++) {
  if (S[i].warp < 0.5 || S[i].seg !== S[i - 1].seg) continue;
  const v = S[i].P.clone().sub(S[i - 1].P).normalize();
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(S[i].Q);
  const a = (Math.acos(Math.max(-1, Math.min(1, v.dot(f)))) * 180) / Math.PI;
  if (a > offMax.v) offMax = { v: a, t: S[i].t };
}
console.log(`max angle between view and travel at warp>0.5: ${offMax.v.toFixed(1)} deg at ${offMax.t?.toFixed(2)}`);
// top rotation rates overall
const peaks = [];
for (let i = 1; i < S.length; i++) {
  const av = ang(S[i - 1].Q, S[i].Q) / H;
  if (av > 25) {
    const l = peaks[peaks.length - 1];
    if (l && S[i].t - l.t1 < 0.3) {
      l.t1 = S[i].t;
      if (av > l.v) (l.v = av), (l.fov = S[i].fov);
    } else peaks.push({ t0: S[i].t, t1: S[i].t, v: av, fov: S[i].fov });
  }
}
console.log(`turns > 25 deg/s: ${peaks.map((p) => `${p.t0.toFixed(1)}-${p.t1.toFixed(1)}(${p.v.toFixed(0)}@fov${p.fov.toFixed(0)})`).join(' ') || 'none'}`);
