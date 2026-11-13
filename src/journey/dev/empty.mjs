// Dead-air scan: for every half second, the largest on-screen disc (radius, px at 900 px frame height) of any
// body or moon. Prints the spans where nothing is larger than 3 px.   node src/journey/dev/empty.mjs [epochISO]
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const ctx = makeNodeCtx(process.argv[2] || '2026-11-02T12:00:00Z');
const dir = await create(ctx);
const W = dir._world;
const ids = W.spheres.map((s) => s.id);
const f = new THREE.Vector3(), r = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3();
const rows = [];
for (let t = 0; t <= dir.duration; t += 0.5) {
  const s = dir.evaluate(t);
  f.set(0, 0, -1).applyQuaternion(s.camQuat);
  r.set(1, 0, 0).applyQuaternion(s.camQuat);
  u.set(0, 1, 0).applyQuaternion(s.camQuat);
  const tv = Math.tan((s.fov * Math.PI) / 360), th = (tv * 16) / 9;
  let best = 0, bid = '';
  for (const id of ids) {
    W.pos(id, s.simDays, v).sub(s.camPos);
    const z = v.dot(f);
    if (z <= 0) continue;
    const d = v.length(), rpx = (Math.asin(Math.min(1, W.radius(id) / d)) / tv) * 450;
    const x = v.dot(r) / z / th, y = v.dot(u) / z / tv;
    const m = rpx / 450;
    if (Math.abs(x) > 1 + m * 0.5625 || Math.abs(y) > 1 + m) continue;
    if (rpx > best) (best = rpx), (bid = id);
  }
  rows.push({ t, best, bid, warp: s.warp, fade: s.fade });
}
let empty = 0, span = null;
const spans = [];
for (const q of rows) {
  const e = q.best < 3 && q.fade < 0.9;
  if (e) {
    empty += 0.5;
    if (!span) span = { t0: q.t, t1: q.t, warp: 0 };
    span.t1 = q.t;
    span.warp = Math.max(span.warp, q.warp);
  } else if (span) {
    spans.push(span);
    span = null;
  }
}
if (span) spans.push(span);
console.log(`duration ${dir.duration.toFixed(1)} s; nothing larger than 3 px for ${empty.toFixed(1)} s (${((100 * empty) / dir.duration).toFixed(0)}%)`);
for (const s of spans) if (s.t1 - s.t0 >= 1) console.log(`  ${s.t0.toFixed(1)}-${s.t1.toFixed(1)}  (${(s.t1 - s.t0 + 0.5).toFixed(1)} s, max warp ${s.warp.toFixed(2)})`);
