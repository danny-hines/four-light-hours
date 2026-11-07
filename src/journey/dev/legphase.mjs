// Per leg: phase of the departing world seen looking back along the route, phase of the destination on arrival,
// and the angle between the look-back and the destination (node src/journey/dev/legphase.mjs [epoch])
import * as THREE from 'three';
import { routeGeom } from '../rig.js';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const epochISO = process.argv.slice(2).find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const dir = await create(makeNodeCtx(epochISO));
const W = dir._world, rig = dir._film.rig, clock = dir._film.clock;
const D = (v) => (v * 180) / Math.PI;
for (const L of rig.segments.filter((s) => s.kind === 'leg')) {
  const tm = L.tm, d = clock(tm);
  const A = L._anchorPos(L.ex, tm, new THREE.Vector3()), B = L._anchorPos(L.en, tm, new THREE.Vector3());
  const g = routeGeom(A, B);
  const sA = A.lengthSq() > 0 ? A.clone().negate().normalize() : new THREE.Vector3(1, 0, 0);
  const sB = B.clone().negate().normalize();
  const phDep = D(Math.acos(g.dep.dot(sA)));
  const phArr = D(Math.acos(g.arr.dot(sB)));
  const eDir = L.ex.dir;
  console.log(`${(L.from.anchor || 'belt').padEnd(8)} -> ${(L.to.anchor || 'belt').padEnd(8)} t ${L.t0.toFixed(1)}-${L.t1.toFixed(1)} L ${(L.L / 23481).toFixed(3)} AU  look-back phase ${phDep.toFixed(0)}  arrival phase ${phArr.toFixed(0)}  block exit vs route ${D(Math.acos(Math.max(-1, Math.min(1, eDir.dot(g.dep))))).toFixed(0)}  sun-dest sep from A ${D(Math.acos(Math.max(-1,Math.min(1,-sA.dot(g.dep)*-1)))).toFixed(0)}`);
}
