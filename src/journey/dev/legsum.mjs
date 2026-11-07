// One line per warp leg: when the warp passes 0.3, how much of the turn to the destination is left then, the
// fastest turn while warp > 0.3, the view-vs-travel angle at peak warp, peak speed, and the arrival framing.
// node src/journey/dev/legsum.mjs [epochISO]
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const epochISO = process.argv.slice(2).find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const dir = await create(makeNodeCtx(epochISO));
const W = dir._world, rig = dir._film.rig;
const H = 1 / 60;
const D = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a.dot(b)))) * 180) / Math.PI;
const angv = (t) => (2 * Math.acos(Math.min(1, Math.abs(dir.evaluate(t - H / 2).camQuat.dot(dir.evaluate(t + H / 2).camQuat)))) * 180) / Math.PI / H;
console.log(`# legs — ${epochISO}`);
for (const L of rig.segments.filter((s) => s.kind === 'leg')) {
  const A = L.from.anchor || 'belt', B = L.to.anchor || 'belt';
  const destDir = (s) => (B === 'belt' ? dir.beltCrossing.position.clone() : W.pos(B, s.simDays, new THREE.Vector3())).sub(s.camPos).normalize();
  let t3 = null, left = 0, maxW = 0, vmax = 0, offPk = 0, tStartTurn = null, ang0 = 0;
  const s0 = dir.evaluate(L.t0 - 3);
  ang0 = D(new THREE.Vector3(0, 0, -1).applyQuaternion(s0.camQuat), destDir(s0));
  for (let t = L.t0 - 4; t <= L.t1 + 4; t += 0.05) {
    const s = dir.evaluate(t);
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(s.camQuat);
    if (s.warp > 0.3 && t3 === null) {
      t3 = t;
      left = D(f, destDir(s));
    }
    if (s.warp > 0.3) maxW = Math.max(maxW, angv(t));
    if (s.speedC > vmax) {
      vmax = s.speedC;
      const v = dir.evaluate(t + H).camPos.clone().sub(dir.evaluate(t - H).camPos).normalize();
      offPk = D(f, v);
    }
  }
  console.log(`${(A + '>' + B).padEnd(16)} ${L.t0.toFixed(1)}-${L.t1.toFixed(1)} dwell ${L.dwell.toFixed(1)}  view>dest@t0-3 ${ang0.toFixed(0).padStart(3)}  warp0.3@${t3 === null ? '-' : t3.toFixed(1)} left ${left.toFixed(1)}  maxTurn@warp>0.3 ${maxW.toFixed(1)}  peak ${vmax.toFixed(0)}c view>travel ${offPk.toFixed(1)}`);
}
