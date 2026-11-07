// Screen positions of bodies over a time range (offline): node src/journey/dev/screenpos.mjs <epochISO> <t0:t1:step> <id,id,...>
// Prints, per sample: fov, EV, the Sun's off-axis angle and for each id its normalised frame x/y (|x|,|y| < 1 is in
// frame), z sign (behind = -), disc radius in px at 1600x900, phase angle, and HIDDEN when another listed body occults it.
import * as THREE from 'three';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const ctx = makeNodeCtx(process.argv[2] || '2026-11-02T12:00:00Z');
const dir = await create(ctx);
const W = dir._world;
const [a,b,st] = process.argv[3].split(':').map(Number);
const ids = process.argv[4].split(',');
for (let t=a;t<=b+1e-9;t+=st){
  const s=dir.evaluate(t);
  const f=new THREE.Vector3(0,0,-1).applyQuaternion(s.camQuat), r=new THREE.Vector3(1,0,0).applyQuaternion(s.camQuat), u=new THREE.Vector3(0,1,0).applyQuaternion(s.camQuat);
  const tv=Math.tan(s.fov*Math.PI/360), th=tv*16/9;
  const out=[];
  for (const id of ids){
    const C=W.pos(id,s.simDays).sub(s.camPos); const d=C.length(); const z=C.dot(f);
    const rpx=W.radius(id)/d*450/tv;
    const sun=W.pos(id,s.simDays).negate().normalize(); const ph=Math.acos(Math.max(-1,Math.min(1,sun.dot(C.clone().negate().normalize()))))*57.3;
    let occ = false; for (const o of ids) { if (o === id) continue; const Co = W.pos(o, s.simDays).sub(s.camPos); const dn = C.clone().normalize(); const b = Co.dot(dn); if (b > 0 && b < d && Co.lengthSq() - b * b < W.radius(o) ** 2) occ = true; }
    out.push(`${occ ? "HIDDEN " : ""}${id}: x=${(C.dot(r)/z/th).toFixed(2)} y=${(C.dot(u)/z/tv).toFixed(2)} z${z>0?'+':'-'} r=${rpx.toFixed(1)}px ph=${ph.toFixed(0)}`);
  }
  const sunv=s.camPos.clone().negate().normalize(); const so=(Math.acos(sunv.dot(f))*57.3).toFixed(0);
  console.log(t.toFixed(1), 'fov', s.fov.toFixed(0), 'ev', Math.log2(s.exposure).toFixed(1), 'sunOff', so, out.join(' | '));
}
