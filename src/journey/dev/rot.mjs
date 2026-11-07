// node src/journey/dev/rot.mjs <t0:t1:step> [epoch] — angular velocity breakdown (forward swing vs roll) per frame
import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { BODIES, JOURNEY_ORDER } from '../../core/bodies-data.js';
import { daysSinceJ2000, heliocentricPosition, KM_PER_UNIT } from '../../core/astro.js';
import { create } from '../director.js';
const [a, b, st] = (process.argv[2] || '60:70:0.25').split(':').map(Number);
const epochDays = daysSinceJ2000(new Date(process.argv[3] || '2026-11-02T12:00:00Z'));
const positions = { sun: new THREE.Vector3() };
for (const id of JOURNEY_ORDER) if (id !== 'sun') positions[id] = heliocentricPosition(id, epochDays);
const bodies = {};
for (const id of JOURNEY_ORDER) bodies[id] = { id, radius: BODIES[id].radius, object: new THREE.Group(), moons: [] };
const dir = await create({ THREE, U, BODIES, epochDays, positions, bodies });
const W = dir._world;
const h = 1 / 60;
for (let t = a; t <= b + 1e-9; t += st) {
  const s0 = dir.evaluate(t - h), s1 = dir.evaluate(t + h);
  const f0 = new THREE.Vector3(0, 0, -1).applyQuaternion(s0.camQuat), f1 = new THREE.Vector3(0, 0, -1).applyQuaternion(s1.camQuat);
  const u0 = new THREE.Vector3(0, 1, 0).applyQuaternion(s0.camQuat), u1 = new THREE.Vector3(0, 1, 0).applyQuaternion(s1.camQuat);
  const sw = (f0.angleTo(f1) / (2 * h)) * 57.3, tot = (s0.camQuat.angleTo(s1.camQuat) / (2 * h)) * 57.3;
  const s = dir.evaluate(t);
  const foc = s.focus;
  let alt = '';
  try { alt = ((W.pos(foc, s.simDays).distanceTo(s.camPos) / W.radius(foc))).toFixed(3) + 'R'; } catch {}
  const k = dir._film.aimKeys.filter((k) => k.t <= t).pop();
  console.log(t.toFixed(2), 'swing', sw.toFixed(1), 'total', tot.toFixed(1), 'fov', s.fov.toFixed(1), foc, alt, 'v', s.speedKmS.toFixed(0), 'aim@', k.t.toFixed(1), JSON.stringify(k.target).slice(0, 60));
}
