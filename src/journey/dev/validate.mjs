// Offline validation of the director (no browser): node src/journey/dev/validate.mjs [epochISO] [--report]
// Samples evaluate(t) densely and checks: NaNs, min altitude vs every body / moon / ring plane, near-plane
// slicing (main.js near rule vs ring planes), orientation angular velocity / acceleration, speed, purity
// (evaluate twice = same), chapter / caption timing. Prints a summary; --report writes notes/director-validate.md.
import * as THREE from 'three';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { U } from '../../core/uniforms.js';
import { BODIES, JOURNEY_ORDER } from '../../core/bodies-data.js';
import { AU, daysSinceJ2000, heliocentricPosition, KM_PER_UNIT } from '../../core/astro.js';
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const epochISO = args.find((a) => !a.startsWith('--')) || '2026-11-02T12:00:00Z';
const writeReport = args.includes('--report');
// live moon ephemerides when src/journey/dev/.ephem.json exists (node src/journey/dev/ephem-dump.mjs)
const ctx = makeNodeCtx(epochISO);
const epochDays = ctx.epochDays;

const t0 = Date.now();
const dir = await create(ctx);
const buildMs = Date.now() - t0;
const W = dir._world, film = dir._film;
const out = [];
const log = (...a) => {
  const s = a.join(' ');
  out.push(s);
  console.log(s);
};
log(`# director validation — epoch ${epochISO}`);
log(`build ${buildMs} ms, duration ${dir.duration.toFixed(1)} s (${(dir.duration / 60).toFixed(2)} min)`);
log('searches:', JSON.stringify({ earth: film.times.S.earth.search, mars: film.times.S.mars.search, jupiter: film.times.S.jupiter.search, saturn: film.times.S.saturn.search }));
log('times:', JSON.stringify(Object.fromEntries(Object.entries(film.times).filter(([k, v]) => k !== 'S' && typeof v === 'number').map(([k, v]) => [k, +v.toFixed(2)]))));
log('clamped aim blends:', dir._clampedBlends.join('; ') || 'none');
log('cuts (dip to black):', (film.cuts || []).map((c) => c.toFixed(2)).join(' '));
log('chapters:', dir.chapters.map((c) => `${c.id}@${c.t0.toFixed(1)}`).join(' '));
const stops = film.clock.stops.map((s) => `${s.t0.toFixed(0)}:+${s.extra.toFixed(2)}d`).join(' ');
log('clock extras:', stops, ` total sim span ${(film.clock(dir.duration) - epochDays).toFixed(2)} d`);

const dt = 1 / 30;
// deliberate cuts (under a dip to black): differences that span one are not motion
const cuts = film.cuts || [];
const spansCut = (t) => cuts.some((c) => c > t - dt - 1e-9 && c <= t + 1e-9);
let prevQ = null, prevW = null, prevPos = null, prevStep = null;
const kinks = [];
let worst = { alt: Infinity }, maxW = { v: 0 }, maxAcc = { v: 0 }, maxRing = { v: Infinity }, nan = 0, slice = { v: 0 };
const altBy = {};
const peaks = [];
const pure = [];
const fwd = new THREE.Vector3();
for (let t = 0; t <= dir.duration + 1e-9; t += dt) {
  const s = dir.evaluate(t);
  const p = s.camPos;
  if (![p.x, p.y, p.z, s.camQuat.x, s.camQuat.w, s.fov, s.exposure, s.simDays].every(Number.isFinite)) nan++;
  // altitude vs every sphere
  let nearest = Infinity;
  for (const sp of W.spheres) {
    const c = W.pos(sp.id, s.simDays, new THREE.Vector3());
    const d = c.distanceTo(p);
    const alt = (d - sp.r) / sp.r;
    nearest = Math.min(nearest, d - sp.r * 1.2);
    if (!altBy[sp.id] || alt < altBy[sp.id].alt) altBy[sp.id] = { alt, t: +t.toFixed(2), km: (d - sp.r) * KM_PER_UNIT };
    if (alt < worst.alt && sp.minAlt) worst = { alt, id: sp.id, t };
  }
  const near = Math.min(10, Math.max(1e-5, nearest * 0.25));
  // ring planes: height above plane within the annulus, and near-plane slicing of the ring disc
  fwd.set(0, 0, -1).applyQuaternion(s.camQuat);
  for (const g of W.rings) {
    const c = W.pos(g.id, s.simDays, new THREE.Vector3());
    const v = p.clone().sub(c);
    const h = v.dot(g.n);
    const rho = v.clone().addScaledVector(g.n, -h).length();
    if (rho > g.rIn && rho < g.rOut && Math.abs(h) < maxRing.v) maxRing = { v: Math.abs(h), id: g.id, t, km: Math.abs(h) * KM_PER_UNIT };
    // near-plane slicing: cast rays through a grid of the frustum; any ring-plane hit inside the annulus with
    // axial depth < near (main.js rule: 0.25 * (nearest sphere distance - 1.2 R)) is sliced away
    if (rho < g.rOut * 1.3) {
      const vf = Math.tan((s.fov * Math.PI) / 360), hf = vf * 16 / 9;
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(s.camQuat), upv = new THREE.Vector3(0, 1, 0).applyQuaternion(s.camQuat);
      for (let iy = -1; iy <= 1; iy += 0.25) for (let ix = -1; ix <= 1; ix += 0.25) {
        const r = fwd.clone().addScaledVector(right, ix * hf).addScaledVector(upv, iy * vf).normalize();
        const den = r.dot(g.n);
        if (Math.abs(den) < 1e-9) continue;
        const tt = -h / den;
        if (tt <= 0) continue;
        const hit = v.clone().addScaledVector(r, tt);
        const rr = hit.length();
        if (rr < g.rIn || rr > g.rOut) continue;
        const depth = tt * r.dot(fwd);
        if (depth < near && near / depth > slice.v) slice = { v: near / depth, id: g.id, t: +t.toFixed(2) };
      }
    }
  }
  if (prevQ && spansCut(t)) {
    prevQ = null;
    prevW = null;
    prevPos = null;
    prevStep = null;
  }
  if (prevQ) {
    const ang = prevQ.angleTo(s.camQuat) / dt; // rad/s
    const deg = (ang * 180) / Math.PI;
    if (deg > maxW.v) maxW = { v: deg, t };
    if (deg > 45) {
      const last = peaks[peaks.length - 1];
      if (last && t - last.t1 < 0.5) {
        last.t1 = t;
        if (deg > last.v) last.v = deg, last.tp = t;
      } else peaks.push({ t0: t, t1: t, v: deg, tp: t });
    }
    if (prevW !== null) {
      const acc = Math.abs(deg - prevW) / dt;
      if (acc > maxAcc.v && t > 0.2) maxAcc = { v: acc, t };
    }
    prevW = deg;
  }
  prevQ = s.camQuat.clone();
  // direction-cosine scan: the path never reverses or kinks (steps under ~600 m are floating-point noise at rest)
  if (prevPos && prevStep) {
    const st = p.clone().sub(prevPos);
    if (st.length() > 1e-4 && prevStep.length() > 1e-4) {
      const c = st.dot(prevStep) / (st.length() * prevStep.length());
      if (c < 0.5) kinks.push(`${t.toFixed(2)}(cos ${c.toFixed(2)})`);
    }
  }
  if (prevPos) prevStep = p.clone().sub(prevPos);
  prevPos = p.clone();
  if (Math.abs(t - Math.round(t / 37) * 37) < dt / 2) {
    const s2 = dir.evaluate(t);
    pure.push(s2.camPos.distanceTo(p) === 0 && s2.camQuat.equals(s.camQuat));
  }
}
log(`NaN frames: ${nan}`);
log(`min altitude (any body, as fraction of radius): ${worst.alt.toFixed(4)} at ${worst.id} t=${(worst.t ?? 0).toFixed(2)}`);
log('closest approach per body:', Object.entries(altBy).filter(([, v]) => v.alt < 5).map(([k, v]) => `${k}:${v.alt.toFixed(3)}R(${Math.round(v.km)}km)@${v.t}`).join('  '));
log(`closest to a ring plane inside the rings: ${maxRing.v === Infinity ? 'never inside' : `${Math.round(maxRing.km)} km (${maxRing.id}) at t=${maxRing.t.toFixed(2)}`}`);
log(`ring near-plane slicing risk (near/depth > 1 means sliced): ${slice.v ? `${slice.v.toFixed(2)} at ${slice.id} t=${slice.t}` : 'none'}`);
log(`max camera angular velocity: ${maxW.v.toFixed(1)} deg/s at t=${maxW.t.toFixed(2)}`);
log('rotation peaks > 45 deg/s:', peaks.map((p) => `${p.tp.toFixed(1)}s:${p.v.toFixed(0)}(${p.t0.toFixed(1)}-${p.t1.toFixed(1)})`).join('  ') || 'none');
log(`max angular acceleration: ${maxAcc.v.toFixed(0)} deg/s^2 at t=${maxAcc.t.toFixed(2)}`);
log(`purity (repeat evaluate identical): ${pure.every(Boolean)}`);
log(`path reversals / kinks (direction cosine < 0.5 between 1/30 s steps): ${kinks.length ? kinks.join(' ') : 'none'}`);
// per-second table: chapter, speedC, warp, fov, ev
const rows = [];
for (let t = 0; t <= dir.duration; t += 2) {
  const s = dir.evaluate(t);
  const foc = s.focus;
  const fd = s.focusDistance;
  rows.push(`${t.toFixed(0).padStart(4)} ${s.chapter.padEnd(9)} ${foc.padEnd(9)} v=${s.speedC.toExponential(2)}c warp=${s.warp.toFixed(2)} fov=${s.fov.toFixed(1)} ev=${Math.log2(s.exposure).toFixed(2)} sky=${s.skyGain.toFixed(2)} alt=${(fd * KM_PER_UNIT).toExponential(2)}km ${s.captions.map((c) => c.title).join('|')}`);
}
if (args.includes('--table')) for (const r of rows) log(r);
if (writeReport) {
  const f = path.join(root, 'notes', `director-validate-${epochISO.slice(0, 10)}.md`);
  fs.writeFileSync(f, out.join('\n') + '\n\n```\n' + rows.join('\n') + '\n```\n');
  console.log('wrote', f);
}
