// Print an orbit block's keys and the rate of change of its camera direction: node src/journey/dev/blockkeys.mjs <anchor> [epoch]
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const id = process.argv[2] || 'saturn';
const epochISO = process.argv.slice(3).find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const dir = await create(makeNodeCtx(epochISO));
const blk = dir._film.rig.segments.find((s) => s.kind === 'orbit' && s.anchor === id);
console.log(`${id} block ${blk.t0.toFixed(1)}-${blk.t1.toFixed(1)}`);
for (const k of blk.keys) console.log(`  key t=${k.t.toFixed(2)} az=${k.az.toFixed(1)} el=${k.el.toFixed(1)} dist=${k.dist.toFixed(3)}`);
const yaw = dir._film.tracks.yaw;
for (let t = blk.t0; t <= Math.min(blk.t1, blk.t0 + 12); t += 0.5) {
  const a = blk.dirAt(t - 0.05), b = blk.dirAt(t + 0.05);
  const w = (a.angleTo(b) / 0.1) * 57.3;
  console.log(`  t=${t.toFixed(1)} dirRate=${w.toFixed(1)} deg/s az=${blk.az.value(t).toFixed(1)} el=${blk.el.value(t).toFixed(1)} dist=${(blk.distAt(t) / blk.R).toFixed(1)} yaw=${yaw ? yaw.value(t).toFixed(2) : 0}`);
}
