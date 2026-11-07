// Film-level metrics (offline, no browser): node src/journey/dev/metrics.mjs [epochISO] [--spans] [--json out.json]
//  * dead time: frames (10 Hz) in which no world (body, moon or the Sun) shows a disc larger than 4 px radius in
//    the 1600x900 frame (the belt chapter's rock field counts as content), excluding frames faded to black
//  * turn rate (60 Hz): seconds above 20 / 12 / 10 / 8 deg/s; spans above 20; one-frame rotation kicks
//  * focus in frame: the shot's focus target centre outside |NDC| < 0.65 (or behind) while not faded out (the film's
//    declared free-frame windows are skipped: the cold open, the Phobos crossing, the finale's retreat turn)
//  * subject beats: for every title card, the seconds its subject is in the safe frame with radius >= 6 px
import * as THREE from 'three';
import fs from 'node:fs';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';

const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const showSpans = args.includes('--spans');
const ji = args.indexOf('--json');
const dir = await create(makeNodeCtx(epochISO));
const W = dir._world;
const ids = [...new Set(W.spheres.map((s) => s.id))];
const V = () => new THREE.Vector3();
const f = V(), r = V(), u = V(), C = V();
function frameInfo(s) {
  f.set(0, 0, -1).applyQuaternion(s.camQuat);
  r.set(1, 0, 0).applyQuaternion(s.camQuat);
  u.set(0, 1, 0).applyQuaternion(s.camQuat);
  const tv = Math.tan((s.fov * Math.PI) / 360), th = (tv * 16) / 9;
  return { tv, th, focal: 450 / tv };
}
function project(id, s, fi) {
  W.pos(id, s.simDays, C).sub(s.camPos);
  const d = C.length(), z = C.dot(f);
  const rpx = (Math.asin(Math.min(1, W.radius(id) / d)) / Math.atan(fi.tv)) * 450; // (angular, valid at any size)
  if (z <= 0) return { behind: true, rpx, x: 9, y: 9 };
  return { behind: false, rpx, x: C.dot(r) / z / fi.th, y: C.dot(u) / z / fi.tv };
}
const lb = (s) => 1 - 0.256 * (s.letterbox || 0); // visible half-height fraction under the 2.39:1 matte

// ---------------------------------------------------------------- 10 Hz scan: dead time, focus in frame
const H10 = 0.1;
const dead = [], focusOff = [];
let deadT = 0, focT = 0;
const beats = dir.captions.filter((c) => c.kind === 'body');
const beatIn = beats.map(() => 0);
let cur = null, curF = null;
for (let t = 0; t <= dir.duration + 1e-9; t += H10) {
  const s = dir.evaluate(t);
  const fi = frameInfo(s);
  const faded = s.fade > 0.5;
  let best = 0, bestId = null;
  for (const id of ids) {
    const p = project(id, s, fi);
    if (p.behind) continue;
    const rx = p.rpx / 800, ry = p.rpx / 450;
    if (Math.abs(p.x) - rx > 1 || Math.abs(p.y) - ry > lb(s)) continue;
    if (p.rpx > best) (best = p.rpx), (bestId = id);
  }
  const inBelt = s.camPos.distanceTo(dir.beltCrossing.position) < 90;
  const isDead = !faded && best < 4 && !inBelt;
  if (isDead) {
    deadT += H10;
    if (!cur) cur = { t0: t, t1: t, maxPx: best };
    cur.t1 = t;
    cur.maxPx = Math.max(cur.maxPx, best);
  } else if (cur) {
    if (cur.t1 - cur.t0 >= 0.45) dead.push(cur);
    cur = null;
  }
  // focus
  const fid = s.focus;
  let off = false, px = 0, fx = 0, fy = 0;
  const free = (dir._film.freeFrame || []).some((w) => t >= w.t0 && t <= w.t1);
  if (fid && fid !== 'asteroids' && !faded && t > 12 && !free) {
    const p = project(fid, s, fi);
    px = p.rpx;
    fx = p.x;
    fy = p.y;
    // angles: a small disc must have its centre in the safe box (|NDC| < 0.65); a large one (radius >~ 60% of the
    // half field) only has to reach into it, so a low pass over a horizon counts as framed
    W.pos(fid, s.simDays, C).sub(s.camPos);
    const dist = C.length();
    C.divideScalar(dist);
    const rho = Math.asin(Math.min(1, W.radius(fid) / dist));
    const psi = Math.acos(Math.max(-1, Math.min(1, C.dot(f))));
    const ex = C.dot(r), ey = C.dot(u), en = Math.hypot(ex, ey) || 1e-9;
    const smax = Math.min((0.65 * fi.th) / Math.max(1e-9, Math.abs(ex / en)), (0.65 * fi.tv * lb(s)) / Math.max(1e-9, Math.abs(ey / en)));
    const k = Math.min(1, Math.max(0, (rho / Math.atan(fi.tv) - 0.05) / 0.55));
    const kBig = k * k * (3 - 2 * k);
    off = psi > Math.atan(smax) + rho * kBig + 0.002;
  }
  if (off) {
    focT += H10;
    if (!curF) curF = { t0: t, t1: t, id: fid, maxX: 0, px };
    curF.t1 = t;
    curF.maxX = Math.max(curF.maxX, Math.max(Math.abs(fx), Math.abs(fy)));
  } else if (curF) {
    focusOff.push(curF);
    curF = null;
  }
  // subject beats
  beats.forEach((b, i) => {
    if (t < b.t0 || t > b.t1 || b.id === 'asteroids' || b.id === 'finale') return;
    const p = project(b.id, s, fi);
    if (!p.behind && Math.abs(p.x) < 0.65 + p.rpx / 800 && Math.abs(p.y) < 0.65 + p.rpx / 450 && p.rpx >= 6) beatIn[i] += H10;
  });
}
if (cur && cur.t1 - cur.t0 >= 0.45) dead.push(cur);
if (curF) focusOff.push(curF);

// ---------------------------------------------------------------- 60 Hz scan: turn rates and kicks
const H = 1 / 60;
let prevQ = null, prevW = null;
const thr = [20, 12, 10, 8];
const over = thr.map(() => 0);
const fast = [];
let curW = null;
const kicks = [];
const qd = new THREE.Quaternion(), w = V();
for (let t = 0; t <= dir.duration + 1e-9; t += H) {
  const s = dir.evaluate(t);
  if (prevQ) {
    qd.copy(prevQ).invert().multiply(s.camQuat);
    if (qd.w < 0) qd.set(-qd.x, -qd.y, -qd.z, -qd.w);
    const ang = 2 * Math.acos(Math.min(1, qd.w));
    const sh = Math.sqrt(Math.max(1e-30, 1 - qd.w * qd.w));
    w.set(qd.x / sh, qd.y / sh, qd.z / sh).multiplyScalar((ang / H) * (180 / Math.PI)); // deg/s, camera axes
    const wm = w.length();
    const faded = s.fade > 0.5;
    if (!faded) thr.forEach((x, i) => wm > x && (over[i] += H));
    if (wm > 20 && !faded) {
      if (!curW) curW = { t0: t, t1: t, max: wm };
      curW.t1 = t;
      curW.max = Math.max(curW.max, wm);
    } else if (curW) {
      fast.push(curW);
      curW = null;
    }
    if (prevW && !faded) {
      const j = w.clone().sub(prevW).length(); // deg/s change in one frame
      if (j > 1.2) kicks.push({ t, j, wm });
    }
    prevW = w.clone();
  }
  prevQ = s.camQuat.clone();
}
if (curW) fast.push(curW);
kicks.sort((a, b) => b.j - a.j);

const res = {
  epoch: epochISO,
  duration: +dir.duration.toFixed(1),
  deadS: +deadT.toFixed(1),
  deadSpans: dead.map((d) => [+d.t0.toFixed(1), +d.t1.toFixed(1)]),
  turnOver: Object.fromEntries(thr.map((x, i) => [x, +over[i].toFixed(1)])),
  fastSpans: fast.map((x) => [+x.t0.toFixed(2), +x.t1.toFixed(2), +x.max.toFixed(0)]),
  kicks: kicks.slice(0, 8).map((k) => [+k.t.toFixed(2), +k.j.toFixed(1), +k.wm.toFixed(1)]),
  focusOffS: +focT.toFixed(1),
  focusOff: focusOff.map((x) => [+x.t0.toFixed(1), +x.t1.toFixed(1), x.id, +x.maxX.toFixed(2)]),
  beats: beats.map((b, i) => [b.id, +b.t0.toFixed(1), +(b.t1 - b.t0).toFixed(1), +beatIn[i].toFixed(1)]),
  chapters: dir.chapters.map((c) => [c.id, +c.t0.toFixed(1)]),
};
console.log(`# metrics — ${epochISO}, duration ${res.duration} s`);
// (the cold open looks at the Milky Way by design and the finale's map and pale blue dot are labelled points)
const tFinRetreat = dir._film.times.tFin - 13;
const legDead = dead.filter((d) => d.t0 > 12 && d.t1 < tFinRetreat).reduce((a, d) => a + d.t1 - d.t0, 0);
res.deadLegsS = +legDead.toFixed(1);
console.log(`dead (no disc > 4 px): ${res.deadS} s in ${dead.length} spans; between the cold open and the finale retreat: ${res.deadLegsS} s${showSpans ? ': ' + res.deadSpans.map((x) => x.join('-')).join(' ') : ''}`);
console.log(`turn > 20/12/10/8 deg/s: ${thr.map((x) => res.turnOver[x]).join(' / ')} s; spans > 20: ${res.fastSpans.map((x) => `${x[0]}-${x[1]}(${x[2]})`).join(' ')}`);
console.log(`rotation kicks (|dw| > 1.2 deg/s in one frame): ${kicks.length}; worst ${res.kicks.map((k) => `${k[0]}(${k[1]})`).join(' ')}`);
console.log(`focus outside |NDC|<0.65: ${res.focusOffS} s: ${res.focusOff.map((x) => `${x[0]}-${x[1]} ${x[2]} (${x[3]})`).join('; ')}`);
console.log(`title-card beats [id, t0, card s, subject-in-safe-frame s]: ${res.beats.map((b) => `${b[0]} ${b[1]} ${b[2]}/${b[3]}`).join('; ')}`);
console.log(`chapters: ${res.chapters.map((c) => `${c[0]}@${c[1]}`).join(' ')}`);
if (ji >= 0) fs.writeFileSync(args[ji + 1], JSON.stringify(res, null, 1));
