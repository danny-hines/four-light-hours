// Offline film analysis (no browser), with the live moon ephemerides (node-ctx.mjs):
//   node src/journey/dev/analyze.mjs [epochISO] [--table] [--report] [--from a --to b]
// Checks: NaN, clipping (altitude vs every body / moon / ring plane), camera angular velocity against an FOV-scaled
// cap (0.35 x FOV per second) and roll rate, path velocity reversals, shot.speedC vs actual motion, frame content
// from a 48x27 analytic ray-cast luminance proxy (dead / black windows), chapter title cards vs the world in frame,
// "Sun hidden" captions vs Sun visibility, finale label spacing.
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KM_PER_UNIT, C_KM_S, AU } from '../../core/astro.js';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const epochISO = args.find((a) => !a.startsWith('--') && /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const argv = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? Number(args[i + 1]) : d;
};
const ctx = makeNodeCtx(epochISO);
const tb = Date.now();
const dir = await create(ctx);
const buildMs = Date.now() - tb;
const W = dir._world, film = dir._film;
const out = [];
const log = (...a) => {
  const s = a.join(' ');
  out.push(s);
  console.log(s);
};
log(`# director analysis — epoch ${epochISO} (${ctx.live ? 'live moons' : 'FALLBACK moons'})`);
log(`build ${buildMs} ms, duration ${dir.duration.toFixed(1)} s`);
log('times:', JSON.stringify(Object.fromEntries(Object.entries(film.times).filter(([k]) => k !== 'S').map(([k, v]) => [k, +(+v).toFixed(2)]))));
log('chapters:', dir.chapters.map((c) => `${c.id}@${c.t0.toFixed(1)}`).join(' '));
if (dir._clampedBlends?.length) log('clamped aim blends:', dir._clampedBlends.join('; '));

const T0 = argv('--from', 0), T1 = argv('--to', dir.duration);
const dt = 1 / 30;
const S = [];
for (let t = T0; t <= T1 + 1e-9; t += dt) {
  const s = dir.evaluate(t);
  S.push({ t, s, P: s.camPos.clone(), Q: s.camQuat.clone() });
}

// ------------------------------------------------------------------ NaN + clipping
let nan = 0;
const altBy = {};
let worst = { alt: Infinity };
for (const { t, s, P, Q } of S) {
  if (![P.x, P.y, P.z, Q.x, Q.w, s.fov, s.exposure, s.simDays].every(Number.isFinite)) nan++;
  for (const sp of W.spheres) {
    const d = W.pos(sp.id, s.simDays, new THREE.Vector3()).distanceTo(P);
    const alt = (d - sp.r) / sp.r;
    if (!altBy[sp.id] || alt < altBy[sp.id].alt) altBy[sp.id] = { alt, t, km: (d - sp.r) * KM_PER_UNIT };
    if (alt < sp.minAlt * 0.999 && alt < worst.alt) worst = { alt, id: sp.id, t };
  }
}
log(`NaN frames: ${nan}`);
log(`below min altitude: ${worst.id ? `${worst.id} ${worst.alt.toFixed(4)}R at t=${worst.t.toFixed(2)}` : 'never'}`);
log('closest approach:', Object.entries(altBy).filter(([, v]) => v.alt < 4).map(([k, v]) => `${k}:${v.alt.toFixed(3)}R(${Math.round(v.km)}km)@${v.t.toFixed(1)}`).join('  '));

// ------------------------------------------------------------------ rotation: angular velocity vs FOV cap, roll rate
const peaks = [];
let maxW = { v: 0 }, maxRoll = { v: 0 }, maxRatio = { v: 0 };
const _r = new THREE.Quaternion();
for (let i = 1; i < S.length; i++) {
  const a = S[i - 1], b = S[i];
  _r.copy(a.Q).invert().multiply(b.Q); // rotation in the camera frame
  if (_r.w < 0) _r.set(-_r.x, -_r.y, -_r.z, -_r.w);
  const ang = 2 * Math.acos(Math.min(1, _r.w));
  const sh = Math.sqrt(Math.max(1e-30, 1 - _r.w * _r.w));
  const wDeg = (ang / dt) * 57.2958;
  const rollDeg = Math.abs(((ang * _r.z) / sh / dt) * 57.2958);
  const fov = b.s.fov;
  const cap = 0.35 * fov;
  const warpy = b.s.warp > 0.5;
  if (wDeg > maxW.v) maxW = { v: wDeg, t: b.t, fov };
  if (rollDeg > maxRoll.v) maxRoll = { v: rollDeg, t: b.t };
  const ratio = wDeg / cap;
  if (!warpy && ratio > maxRatio.v) maxRatio = { v: ratio, t: b.t, w: wDeg, fov };
  const bad = (!warpy && wDeg > cap * 1.0) || wDeg > 45 || rollDeg > 10;
  if (bad) {
    const last = peaks[peaks.length - 1];
    if (last && b.t - last.t1 < 0.4) {
      last.t1 = b.t;
      if (wDeg > last.w) Object.assign(last, { w: wDeg, tp: b.t, fov, roll: Math.max(last.roll, rollDeg) });
      last.roll = Math.max(last.roll, rollDeg);
    } else peaks.push({ t0: b.t, t1: b.t, w: wDeg, tp: b.t, fov, roll: rollDeg, warp: b.s.warp });
  }
  b.w = wDeg;
  b.roll = rollDeg;
}
log(`max angular velocity ${maxW.v.toFixed(1)} deg/s at t=${maxW.t?.toFixed(2)} (fov ${maxW.fov?.toFixed(0)}); max roll rate ${maxRoll.v.toFixed(1)} deg/s at t=${maxRoll.t?.toFixed(2)}; worst w/cap (non-warp) ${maxRatio.v.toFixed(2)} at t=${maxRatio.t?.toFixed(2)}`);
log(`rotation over cap (0.35*fov /s, or >45, or roll>10): ${peaks.length} segments`);
log('  ' + peaks.map((p) => `${p.tp.toFixed(1)}:${p.w.toFixed(0)}/${(0.35 * p.fov).toFixed(0)}${p.roll > 10 ? ` roll${p.roll.toFixed(0)}` : ''}(${p.t0.toFixed(1)}-${p.t1.toFixed(1)})`).join('  '));

// ------------------------------------------------------------------ path velocity reversals + speedC mismatch
const rev = [];
const speedErr = [];
for (let i = 2; i < S.length; i++) {
  const v0 = S[i - 1].P.clone().sub(S[i - 2].P), v1 = S[i].P.clone().sub(S[i - 1].P);
  const l0 = v0.length(), l1 = v1.length();
  // local mean speed over +-2 s
  let sum = 0, n = 0;
  for (let j = Math.max(1, i - 60); j < Math.min(S.length, i + 60); j++) {
    sum += S[j].P.distanceTo(S[j - 1].P);
    n++;
  }
  const mean = sum / n;
  if (l0 > 0.01 * mean && l1 > 0.01 * mean && v0.dot(v1) < 0) rev.push(`${S[i].t.toFixed(2)}(${((Math.acos(Math.max(-1, Math.min(1, v0.dot(v1) / (l0 * l1)))) * 180) / Math.PI).toFixed(0)}deg, ${((l1 / dt) * KM_PER_UNIT).toFixed(0)} km/s)`);
  const act = (S[i].P.distanceTo(S[i - 2].P) / (2 * dt)) * KM_PER_UNIT / C_KM_S;
  const rep = S[i - 1].s.speedC;
  if (act > 1e-3 && Math.abs(Math.log(Math.max(rep, 1e-9) / act)) > Math.log(1.25)) speedErr.push(`${S[i - 1].t.toFixed(2)}:${rep.toPrecision(3)}vs${act.toPrecision(3)}`);
}
log(`velocity reversals (>90 deg between frames at > 1% of local mean speed): ${rev.length ? rev.join('  ') : 'none'}`);
log(`speedC off by >25%: ${speedErr.length} frames ${speedErr.slice(0, 12).join(' ')}`);

// ------------------------------------------------------------------ frame content: analytic luminance proxy
const ALB = { sun: 0, mercury: 0.14, venus: 0.75, earth: 0.4, moon: 0.12, mars: 0.25, jupiter: 0.5, saturn: 0.47, uranus: 0.5, neptune: 0.45, titan: 0.22, triton: 0.7 };
const GX = 48, GY = 27;
const content = [];
const fwd = new THREE.Vector3(), right = new THREE.Vector3(), upv = new THREE.Vector3(), ray = new THREE.Vector3();
const Csph = [];
function frameStats(s) {
  const P = s.camPos, q = s.camQuat;
  fwd.set(0, 0, -1).applyQuaternion(q);
  right.set(1, 0, 0).applyQuaternion(q);
  upv.set(0, 1, 0).applyQuaternion(q);
  const tv = Math.tan((s.fov * Math.PI) / 360), th = tv * (16 / 9);
  const halfDiag = Math.atan(Math.hypot(tv, th));
  const focal = 450 / tv;
  // candidate spheres: sun + bodies + moons
  Csph.length = 0;
  const all = [{ id: 'sun', r: W.radius('sun') }, ...W.spheres.filter((x) => x.id !== 'sun')];
  const vis = {};
  for (const sp of all) {
    const C = W.pos(sp.id, s.simDays, new THREE.Vector3()).sub(P);
    const d = C.length();
    if (d <= sp.r) return { inside: sp.id };
    const angR = Math.asin(Math.min(1, sp.r / d));
    const off = Math.acos(Math.max(-1, Math.min(1, C.dot(fwd) / d)));
    const rpx = Math.tan(angR) * focal;
    if (off - angR < halfDiag) {
      Csph.push({ id: sp.id, C, r: sp.r, d });
      // centre on screen?
      const z = C.dot(fwd);
      if (z > 0) {
        const x = C.dot(right) / z / th, y = C.dot(upv) / z / tv;
        vis[sp.id] = { rpx, x, y, onScreen: Math.abs(x) < 1 + rpx / 800 && Math.abs(y) < 1 + rpx / 450 };
      }
    }
  }
  const sunDir = P.clone().negate().normalize();
  // sun visibility (ray to the Sun's centre blocked by any sphere?)
  let sunBlocked = false;
  for (const sp of all) {
    if (sp.id === 'sun') continue;
    const C = W.pos(sp.id, s.simDays, new THREE.Vector3()).sub(P);
    const b = C.dot(sunDir);
    if (b <= 0 || b > P.length()) continue;
    const c = C.lengthSq() - sp.r * sp.r;
    if (b * b - c > 0) sunBlocked = true;
  }
  const sunOff = Math.acos(Math.max(-1, Math.min(1, sunDir.dot(fwd)))) * 57.2958;
  // ray grid
  let lit = 0, sumL = 0, subj = {};
  const exposure = s.exposure;
  for (let iy = 0; iy < GY; iy++) {
    for (let ix = 0; ix < GX; ix++) {
      const x = ((ix + 0.5) / GX) * 2 - 1, y = ((iy + 0.5) / GY) * 2 - 1;
      ray.copy(fwd).addScaledVector(right, x * th).addScaledVector(upv, y * tv).normalize();
      let best = Infinity, hit = null;
      for (const c of Csph) {
        const b = ray.dot(c.C);
        if (b <= 0) continue;
        const h = b * b - (c.d * c.d - c.r * c.r);
        if (h <= 0) continue;
        const tt = b - Math.sqrt(h);
        if (tt < best) (best = tt), (hit = c);
      }
      let L = 0.0006 * s.skyGain; // stars / Milky Way average
      if (hit) {
        if (hit.id === 'sun') L = 2400;
        else {
          const n = ray.clone().multiplyScalar(best).sub(hit.C).normalize();
          const pW = P.clone().addScaledVector(ray, best);
          const sd = pW.negate().normalize();
          L = (ALB[hit.id] ?? 0.3) * 1.3 * Math.max(0, n.dot(sd));
          if (L === 0 && hit.id === 'earth') L = 0.004; // city lights / airglow on average
        }
        subj[hit.id] = (subj[hit.id] || 0) + 1;
      }
      const disp = L * exposure;
      if (disp > 0.012) lit++;
      sumL += Math.min(disp, 4);
    }
  }
  const N = GX * GY;
  let main = null, mainN = 0;
  for (const [id, n] of Object.entries(subj)) if (n > mainN) (main = id), (mainN = n);
  return { lit: lit / N, mean: sumL / N, main, cover: mainN / N, vis, sunBlocked, sunOff, sunInFrame: sunOff < halfDiag * 57.2958 };
}
const CS = [];
for (let i = 0; i < S.length; i += 3) {
  const st = frameStats(S[i].s);
  CS.push({ t: S[i].t, s: S[i].s, ...st });
}
// dead windows: < 0.5% of the frame above the star level for > 1.5 s, outside fades and hard warp
const dead = [];
let run = null;
for (const c of CS) {
  // content: >0.5% of the frame lit, or a world >= 3 px on screen, or the Sun in frame (not hidden), or the belt
  // field, or the cold open's Milky Way; otherwise (outside fades and hard warp) the frame is empty
  const bigVis = Object.entries(c.vis || {}).some(([id, v]) => v.onScreen && v.rpx >= 3 && id !== 'sun');
  const sunVis = c.sunInFrame && !c.sunBlocked;
  const belt = c.s.chapter === 'asteroids' && film.rig.segmentAt(c.t).kind === 'fly';
  const isDead = !c.inside && c.lit < 0.005 && !bigVis && !sunVis && !belt && c.t > 13 && c.s.fade < 0.5 && c.s.warp < 0.3;
  c.dead = isDead;
  if (isDead) {
    if (!run) run = { t0: c.t, t1: c.t };
    else run.t1 = c.t;
  } else if (run) {
    if (run.t1 - run.t0 >= 1.5) dead.push(run);
    run = null;
  }
}
if (run && run.t1 - run.t0 >= 1.5) dead.push(run);
const insides = CS.filter((c) => c.inside).map((c) => `${c.t.toFixed(1)}:${c.inside}`);
log(`camera inside a sphere: ${insides.length ? insides.join(' ') : 'never'}`);
log(`dead windows (>1.5 s, <0.5% lit, no fade, warp<0.3): ${dead.length ? dead.map((d) => `${d.t0.toFixed(1)}-${d.t1.toFixed(1)}`).join('  ') : 'none'}  total ${dead.reduce((a, d) => a + d.t1 - d.t0, 0).toFixed(1)} s`);
// overexposure: mean display > 1.3 (most of the frame blown)
const blown = CS.filter((c) => c.mean > 1.2 && c.s.fade < 0.5).map((c) => c.t.toFixed(1));
log(`frames with mean display > 1.2 (blown): ${blown.length ? blown.slice(0, 30).join(' ') : 'none'}`);
// sun in frame + visible during warp > 0.5
const sunWarp = CS.filter((c) => c.s.warp > 0.5 && c.sunOff < 40 && !c.sunBlocked).map((c) => `${c.t.toFixed(1)}(${c.sunOff.toFixed(0)})`);
log(`Sun within 40 deg of the view axis during warp>0.5: ${sunWarp.length ? sunWarp.join(' ') : 'none'}`);

// ------------------------------------------------------------------ chapters vs the world in frame
const prevWorld = { mercury: 'sun', venus: 'mercury', earth: 'venus', mars: 'moon', asteroids: 'mars', jupiter: 'mars', saturn: 'jupiter', uranus: 'titan', neptune: 'uranus', finale: 'triton' };
const chapIssues = [];
for (const ch of dir.chapters) {
  if (ch.id === 'intro' || ch.id === 'sun') continue;
  const t = ch.t0 + 0.8;
  const c = frameStats(dir.evaluate(t));
  const pw = prevWorld[ch.id];
  const v = pw && c.vis[pw];
  if (v && v.onScreen && v.rpx > 10) chapIssues.push(`${ch.id}@${t.toFixed(1)}: ${pw} still ${v.rpx.toFixed(0)} px in frame`);
  if (ch.id === 'finale' || ch.id === 'uranus' || ch.id === 'neptune') {
    // anything big from the previous chapter (parent planet of a moon too)
    for (const [id, vv] of Object.entries(c.vis)) if (vv.onScreen && vv.rpx > 10 && id !== ch.id && id !== 'sun' && !chapIssues.some((x) => x.includes(`: ${id} `))) chapIssues.push(`${ch.id}@${t.toFixed(1)}: ${id} ${vv.rpx.toFixed(0)} px in frame`);
  }
}
log(`chapter cards over the previous world: ${chapIssues.length ? chapIssues.join('; ') : 'none'}`);
// captions that say the Sun is hidden
const hid = [];
for (const cap of dir.captions) {
  if (!/hidden|shadow/i.test((cap.lines || []).join(' ') + cap.title)) continue;
  for (const c of CS) if (c.t >= cap.t0 && c.t <= cap.t1 && !c.sunBlocked && c.sunOff < 60) hid.push(`${cap.title}@${c.t.toFixed(1)}(sun ${c.sunOff.toFixed(0)} deg off-axis, visible)`);
}
log(`"shadow" captions with the Sun visible near the frame: ${hid.length ? hid.slice(0, 6).join('; ') : 'none'}`);
// labels: spacing and safe area
const lab = [];
for (const c of CS) {
  const L = c.s.labels;
  if (!L || !L.length) continue;
  const q = c.s.camQuat, P = c.s.camPos;
  fwd.set(0, 0, -1).applyQuaternion(q);
  right.set(1, 0, 0).applyQuaternion(q);
  upv.set(0, 1, 0).applyQuaternion(q);
  const tv = Math.tan((c.s.fov * Math.PI) / 360), th = tv * (16 / 9);
  const pts = [];
  for (const l of L) {
    if ((l.alpha ?? 1) < 0.5) continue;
    const v = l.position.clone().sub(P);
    const z = v.dot(fwd);
    if (z <= 0) continue;
    pts.push({ id: l.id, x: (v.dot(right) / z / th) * 800, y: (v.dot(upv) / z / tv) * 450 });
  }
  let minSep = Infinity, pair = '';
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
    if (d < minSep) (minSep = d), (pair = pts[i].id + '/' + pts[j].id);
  }
  const outSafe = pts.filter((p) => Math.abs(p.x) > 720 || Math.abs(p.y) > 405).map((p) => p.id);
  if (minSep < 40 || outSafe.length) lab.push(`${c.t.toFixed(1)}: min ${minSep.toFixed(0)}px ${pair}${outSafe.length ? ' outside safe: ' + outSafe.join(',') : ''}`);
}
log(`label problems: ${lab.length ? lab.length + ' frames, e.g. ' + lab.filter((_, i) => i % 6 === 0).slice(0, 8).join('; ') : 'none'}`);

// ------------------------------------------------------------------ table
const rows = [];
for (const c of CS) {
  if (Math.abs(c.t / 2 - Math.round(c.t / 2)) > 0.02) continue;
  const s = c.s;
  const wv = S.find((x) => Math.abs(x.t - c.t) < 1e-6)?.w ?? 0;
  rows.push(`${c.t.toFixed(0).padStart(4)} ${s.chapter.padEnd(9)} ${String(s.focus).padEnd(8)} v=${s.speedC.toExponential(1)}c warp=${s.warp.toFixed(2)} fov=${s.fov.toFixed(0).padStart(3)} ev=${Math.log2(s.exposure).toFixed(1).padStart(5)} w=${wv.toFixed(0).padStart(3)} lit=${(c.lit * 100).toFixed(1).padStart(5)}% mean=${(c.mean ?? 0).toFixed(2)} main=${c.main || '-'}(${((c.cover || 0) * 100).toFixed(0)}%) sun=${c.sunOff?.toFixed(0)}${c.sunBlocked ? 'X' : ''} ${s.captions.map((x) => x.title).join('|')}`);
}
if (args.includes('--table')) for (const r of rows) log(r);
if (args.includes('--report')) {
  const f = path.join(root, 'notes', `director-validate-${epochISO.slice(0, 10)}.md`);
  fs.writeFileSync(f, out.join('\n') + '\n\n```\n' + rows.join('\n') + '\n```\n');
  console.log('wrote', f);
}
