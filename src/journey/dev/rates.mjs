// Authored vs smoothed camera rotation rate (deg/s) and the fluid-head cap: node src/journey/dev/rates.mjs [epoch] a:b:step
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const [a, b, st] = (args.find((x) => x.includes(':') && !/\d{4}-/.test(x)) || '0:10:0.5').split(':').map(Number);
const dir = await create(makeNodeCtx(epochISO));
console.log('build', JSON.stringify(dir._build));
const H = 1 / 30;
const ang = (p, q) => (2 * Math.acos(Math.min(1, Math.abs(p.dot(q)))) * 180) / Math.PI;
for (let t = a; t <= b + 1e-9; t += st) {
  const r = ang(dir._rawAim(t - H / 2), dir._rawAim(t + H / 2)) / H;
  const s = ang(dir.evaluate(t - H / 2).camQuat, dir.evaluate(t + H / 2).camQuat) / H;
  const i = Math.round(t / dir._hQ);
  const cap = dir._av[i * 3 + 2];
  const e = dir.evaluate(t);
  const sg = dir._dbg.sig ? dir._dbg.sig[i] : 0, sc = dir._dbg.sigCap ? dir._dbg.sigCap[i] : 0;
  console.log(t.toFixed(2).padStart(7), 'raw', r.toFixed(1).padStart(6), 'out', s.toFixed(1).padStart(6), 'cap', cap.toFixed(1).padStart(5), 'sig', sg.toFixed(2), 'sigCap', sc.toFixed(2), 'warp', e.warp.toFixed(2), 'fov', e.fov.toFixed(0), 'focus', e.focus);
}
