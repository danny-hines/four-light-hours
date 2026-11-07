// The finale retreat: Sun distance (AU), its log rate, speed (c), and turn rate: node src/journey/dev/finale.mjs [epoch] [a:b:step]
import { AU, KM_PER_UNIT, C_KM_S } from '../../core/astro.js';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const dir = await create(makeNodeCtx(epochISO));
const ft = dir._film.times;
const [a, b, st] = (args.find((x) => x.includes(':') && !/\d{4}-/.test(x)) || `${(ft.tFin - 15).toFixed(1)}:${(ft.tFin + 2).toFixed(1)}:0.5`).split(':').map(Number);
const H = 1 / 60;
console.log('tFin', ft.tFin.toFixed(2), 'tPBD0', ft.tPBD0.toFixed(2), 'tPBD1', ft.tPBD1.toFixed(2), 'duration', dir.duration.toFixed(1));
for (let t = a; t <= b + 1e-9; t += st) {
  const p = dir.evaluate(t - H / 2).camPos, q = dir.evaluate(t + H / 2).camPos, s = dir.evaluate(t);
  const lr = (Math.log(q.length()) - Math.log(p.length())) / H;
  const v = (q.distanceTo(p) / H) * KM_PER_UNIT / C_KM_S;
  const av = (2 * Math.acos(Math.min(1, Math.abs(dir.evaluate(t - H / 2).camQuat.dot(dir.evaluate(t + H / 2).camQuat)))) * 180) / Math.PI / H;
  console.log(t.toFixed(2).padStart(7), `S=${(s.camPos.length() / AU).toFixed(2)}AU dlnS/dt=${lr.toFixed(3)} v=${v.toExponential(2)}c warp=${s.warp.toFixed(2)} turn=${av.toFixed(1)} fov=${s.fov.toFixed(1)} orbits=${s.orbits.toFixed(2)}`);
}
