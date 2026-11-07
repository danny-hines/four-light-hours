// Per-leg motion table: node src/journey/dev/legs.mjs [epochISO] [legIndex|all] [--step 0.25]
// For each warp leg: warp, speedC, camera angular velocity, the angle between the view and the destination,
// between the velocity and the destination, the Sun's angle from the view, and the departing world's apparent size.
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const which = args.find((a) => /^\d+$/.test(a) || a === 'all') ?? 'all';
const si = args.indexOf('--step');
const step = si >= 0 ? Number(args[si + 1]) : 0.25;
const ctx = makeNodeCtx(epochISO);
const dir = await create(ctx);
const W = dir._world, rig = dir._film.rig;
const H = 1 / 60;
const angv = (t) => {
  const a = dir.evaluate(t - H / 2).camQuat, b = dir.evaluate(t + H / 2).camQuat;
  return (2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * 180) / Math.PI / H;
};
const legs = rig.segments.filter((s) => s.kind === 'leg');
const D = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI;
legs.forEach((L, i) => {
  if (which !== 'all' && Number(which) !== i) return;
  const A = L.from.anchor || 'belt', B = L.to.anchor || 'belt';
  console.log(`\n# leg ${i}: ${A} -> ${B}  ${L.t0.toFixed(1)}-${L.t1.toFixed(1)}`);
  console.log('   t     warp  speedC   angV  fov  view>dest vel>dest view>sun  depPx');
  for (let t = L.t0 - 5; t <= L.t1 + 3 + 1e-9; t += step) {
    const s = dir.evaluate(t);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camQuat);
    const Bp = B === 'belt' ? dir.beltCrossing.position.clone() : W.pos(B, s.simDays, new THREE.Vector3());
    const dB = Bp.clone().sub(s.camPos).normalize();
    const v = dir.evaluate(t + H).camPos.clone().sub(dir.evaluate(t - H).camPos).normalize();
    const sun = s.camPos.clone().negate().normalize();
    let px = 0;
    if (A !== 'belt') {
      const Ap = W.pos(A, s.simDays, new THREE.Vector3());
      px = (W.radius(A) / Ap.distanceTo(s.camPos)) * (450 / Math.tan((s.fov * Math.PI) / 360));
    }
    console.log(`${t.toFixed(2).padStart(7)} ${s.warp.toFixed(2)} ${s.speedC.toExponential(1).padStart(8)} ${angv(t).toFixed(1).padStart(5)} ${s.fov.toFixed(0).padStart(3)} ${D(f, dB).toFixed(1).padStart(8)} ${D(v, dB).toFixed(1).padStart(8)} ${D(f, sun).toFixed(1).padStart(8)} ${px.toFixed(1).padStart(7)}`);
  }
});
