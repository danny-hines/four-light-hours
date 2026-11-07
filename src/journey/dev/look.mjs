import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { BODIES, JOURNEY_ORDER } from '../../core/bodies-data.js';
import { daysSinceJ2000, heliocentricPosition } from '../../core/astro.js';
import { create } from '../director.js';
const [a, b, st] = process.argv[2].split(':').map(Number);
const body = process.argv[3] || 'jupiter';
const epochDays = daysSinceJ2000(new Date(process.argv[4] || '2026-11-02T12:00:00Z'));
const positions = { sun: new THREE.Vector3() };
for (const id of JOURNEY_ORDER) if (id !== 'sun') positions[id] = heliocentricPosition(id, epochDays);
const bodies = {};
for (const id of JOURNEY_ORDER) bodies[id] = { id, radius: BODIES[id].radius, object: new THREE.Group(), moons: [] };
const dir = await create({ THREE, U, BODIES, epochDays, positions, bodies });
const W = dir._world;
for (let t = a; t <= b + 1e-9; t += st) {
  const s = dir.evaluate(t);
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camQuat);
  const C = W.pos(body, s.simDays);
  const n = s.camPos.clone().sub(C).normalize();
  const sun = s.camPos.clone().negate().normalize();
  const F = W.frame(body, s.simDays, W.pole(body));
  const ae = W.azElOf(F, n);
  console.log(t.toFixed(2), 'fwd·down', (-f.dot(n)).toFixed(3), 'fwd·sun', f.dot(sun).toFixed(3), 'cam az', ae.az.toFixed(1), 'el', ae.el.toFixed(1), 'r', (s.camPos.distanceTo(C) / W.radius(body)).toFixed(3), 'sunElevAtNadir', (Math.asin(n.dot(C.clone().negate().normalize())) * 57.3).toFixed(1));
}
