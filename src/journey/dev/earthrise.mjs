// Earthrise geometry at each epoch: Sun and Earth elevation over the local lunar horizon, the angle between the
// Sun and the view (node src/journey/dev/earthrise.mjs [epoch])
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const epochISO = process.argv.slice(2).find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const dir = await create(makeNodeCtx(epochISO));
const W = dir._world, T = dir._film.times;
const D = 180 / Math.PI;
const rows = [];
for (let t = T.tRise0 - 1; t <= T.tRise1 + 0.01; t += 1) {
  const s = dir.evaluate(t);
  const M = W.pos('moon', s.simDays, new THREE.Vector3()), E = W.pos('earth', s.simDays, new THREE.Vector3());
  const n = s.camPos.clone().sub(M).normalize();
  const sun = s.camPos.clone().negate().normalize();
  const e = E.clone().sub(s.camPos).normalize();
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camQuat);
  const alt = (s.camPos.distanceTo(M) - W.radius('moon')) * 6371;
  rows.push(`${t.toFixed(1)}: alt ${alt.toFixed(0)} km, sun el ${(Math.asin(sun.dot(n)) * D).toFixed(1)}, earth el ${(Math.asin(e.dot(n)) * D).toFixed(1)}, sun-view ${(Math.acos(sun.dot(f)) * D).toFixed(0)}, earth phase ${(Math.acos(E.clone().negate().normalize().dot(e.clone().negate())) * D).toFixed(0)}`);
}
console.log(epochISO + '\n' + rows.join('\n'));
