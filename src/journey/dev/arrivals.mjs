// Where the destination sits in the frame during each arrival (normalised x, y; |x|,|y| < 1 in frame) and its
// disc radius in px at 1600x900: node src/journey/dev/arrivals.mjs [epochISO] [id] [--step 0.5]
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const only = args.find((a) => /^[a-z]+$/.test(a));
const si = args.indexOf('--step');
const step = si >= 0 ? Number(args[si + 1]) : 0.5;
const dir = await create(makeNodeCtx(epochISO));
const W = dir._world, rig = dir._film.rig;
for (const L of rig.segments.filter((s) => s.kind === 'leg')) {
  const B = L.to.anchor;
  if (!B || (only && B !== only)) continue;
  const rows = [];
  for (let t = L.t1 - 3; t <= L.t1 + 9 + 1e-9; t += step) {
    const s = dir.evaluate(t);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camQuat), r = new THREE.Vector3(1, 0, 0).applyQuaternion(s.camQuat), u = new THREE.Vector3(0, 1, 0).applyQuaternion(s.camQuat);
    const tv = Math.tan((s.fov * Math.PI) / 360), th = (tv * 16) / 9;
    const C = W.pos(B, s.simDays, new THREE.Vector3()).sub(s.camPos);
    const z = C.dot(f);
    const rpx = (W.radius(B) / C.length()) * (450 / tv);
    rows.push(`${t.toFixed(1)}: x${(C.dot(r) / z / th).toFixed(2)} y${(C.dot(u) / z / tv).toFixed(2)} r${rpx < 10 ? rpx.toFixed(1) : rpx.toFixed(0)} w${s.warp.toFixed(1)}`);
  }
  console.log(`# ${B} (block t0 ${L.t1.toFixed(1)})\n  ` + rows.join('  '));
}
