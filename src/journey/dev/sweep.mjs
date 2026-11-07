// node src/journey/dev/sweep.mjs [startISO] [count] [stepDays] — robustness sweep over many epochs
import * as THREE from 'three';
import { U } from '../../core/uniforms.js';
import { BODIES, JOURNEY_ORDER } from '../../core/bodies-data.js';
import { daysSinceJ2000, heliocentricPosition, dateFromDays } from '../../core/astro.js';
import { create } from '../director.js';
const start = daysSinceJ2000(new Date(process.argv[2] || '2025-01-01T00:00:00Z'));
const n = Number(process.argv[3] || 30), step = Number(process.argv[4] || 41.3);
for (let i = 0; i < n; i++) {
  const epochDays = start + i * step;
  const positions = { sun: new THREE.Vector3() };
  for (const id of JOURNEY_ORDER) if (id !== 'sun') positions[id] = heliocentricPosition(id, epochDays);
  const bodies = {};
  for (const id of JOURNEY_ORDER) bodies[id] = { id, radius: BODIES[id].radius, object: new THREE.Group(), moons: [] };
  const warn = [];
  const ow = console.warn;
  console.warn = (...a) => warn.push(a.join(' '));
  const dir = await create({ THREE, U, BODIES, epochDays, positions, bodies });
  console.warn = ow;
  let prevQ = null, maxW = 0, tW = 0, nan = 0, pushed = 0, tP = 0, maxSpeedC = 0, minSun = 1e9;
  const dt = 1 / 20;
  for (let t = 0; t <= dir.duration; t += dt) {
    const s = dir.evaluate(t);
    if (!Number.isFinite(s.camPos.x) || !Number.isFinite(s.camQuat.w)) nan++;
    if (s.debug.pushed && s.debug.pushed > pushed) (pushed = s.debug.pushed), (tP = t);
    if (prevQ) {
      const w = (prevQ.angleTo(s.camQuat) / dt) * 57.3;
      if (w > maxW) (maxW = w), (tW = t);
    }
    prevQ = s.camQuat.clone();
    if (t > 46) minSun = Math.min(minSun, s.camPos.length() / 109.2);
    maxSpeedC = Math.max(maxSpeedC, s.speedC);
  }
  const ch = dir.chapters.find((c) => c.t0 <= tW && c.t1 > tW)?.id;
  console.log(dateFromDays(epochDays).toISOString().slice(0, 10), `maxRot ${maxW.toFixed(0)}deg/s@${tW.toFixed(1)}(${ch})`, `nan ${nan}`, `guard ${pushed.toFixed(3)}@${tP.toFixed(1)}`, `minSunDist ${minSun.toFixed(1)}Rs`, `vmax ${maxSpeedC.toFixed(0)}c`, `simSpan ${(dir._film.clock(dir.duration) - epochDays).toFixed(1)}d`, warn.length ? 'WARN ' + warn[0] : '');
}
