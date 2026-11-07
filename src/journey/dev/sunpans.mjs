// Seconds the Sun spends inside the frame (and within 8 deg outside its edge) during each departure pan window
// (film.pans), per epoch: node src/journey/dev/sunpans.mjs [epochISO]
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const epochISO = process.argv.slice(2).find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const dir = await create(makeNodeCtx(epochISO));
const out = [];
for (const p of dir._film.pans) {
  let inF = 0, near = 0, minA = 180;
  for (let t = p.t0; t <= p.t1 + 1.5; t += 0.05) {
    const s = dir.evaluate(t);
    const q = s.camQuat.clone().invert();
    const v = s.camPos.clone().negate().normalize().applyQuaternion(q);
    if (v.z >= 0) continue;
    const tv = Math.tan((s.fov * Math.PI) / 360), th = (tv * 16) / 9;
    const x = v.x / -v.z / th, y = v.y / -v.z / tv;
    const a = (Math.acos(-v.z) * 180) / Math.PI;
    minA = Math.min(minA, a);
    if (Math.abs(x) < 1 && Math.abs(y) < 1) inF += 0.05;
    else if (Math.abs(x) < 1.25 && Math.abs(y) < 1.4) near += 0.05;
  }
  out.push(`${p.t0.toFixed(1)}-${p.t1.toFixed(1)}: sun in frame ${inF.toFixed(1)} s, near edge ${near.toFixed(1)} s, min angle ${minA.toFixed(0)}`);
}
console.log(`# ${epochISO}\n` + out.join('\n'));
