// Is the Sun's centre hidden by a body (analytic, spheres; Saturn oblate) over a window?
// node src/journey/dev/sunvis.mjs [epoch] a:b:step [body]
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const [a, b, st] = (args.find((x) => x.includes(':') && !/\d{4}-/.test(x)) || '0:10:0.5').split(':').map(Number);
const body = args.find((x) => /^[a-z]+$/.test(x)) || 'saturn';
const dir = await create(makeNodeCtx(epochISO));
const W = dir._world;
const up = W.pole(body);
const rows = [];
for (let t = a; t <= b + 1e-9; t += st) {
  const s = dir.evaluate(t);
  const P = s.camPos, C = W.pos(body, s.simDays, new THREE.Vector3());
  const toSun = P.clone().negate().normalize();
  const tca = C.clone().sub(P).dot(toSun);
  const cp = P.clone().addScaledVector(toSun, Math.max(0, tca)).sub(C);
  const hp = cp.dot(up), he = cp.clone().addScaledVector(up, -hp).length();
  const m = tca > 0 ? Math.hypot(he, hp / (body === 'saturn' ? 0.902 : 1)) / W.radius(body) : 99;
  rows.push(`${t.toFixed(1)}:${m < 1 ? 'hid' : 'SUN'}(${m.toFixed(2)}R) ev${Math.log2(s.exposure).toFixed(1)} fade${s.fade.toFixed(2)}`);
}
console.log(rows.join('  '));
