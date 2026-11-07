// Hero beats: big rocks placed where the film's own camera will actually hold them.
//
// The director is a pure function of t, so on the first frame we sample its camera through the belt chapter
// (position, orientation, field of view) and search for hero placements that stay inside the frame for the
// longest time at a good size, lit at a phase angle that sculpts the terminator (Sun-rock-camera 60..110 deg),
// never crossing the camera path and never eclipsing the Sun (the lens-flare occlusion only knows the planets).
// Deterministic: same director -> same placements. The result is exposed as belt.heroBeats so the director can
// aim or rack focus on them.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * director: { evaluate(t), chapters, duration }; field: createField() object; heroInfo: [{boundR}] per hero shape.
 * specs: [{ hero, type, albedo, periodH, seedQ, phase, name }] one per beat (in film order).
 * Returns [{ t, t0, t1, position (universe), local, radius, name }].
 */
export function planBeats({ director, field, heroInfo, aspect = 16 / 9, specs }) {
  const ch = (director.chapters || []).find((c) => c.id === 'asteroids');
  const T0 = ch ? ch.t0 - 2 : 0, T1 = ch ? ch.t1 + 2 : director.duration;
  const toL = (v) => new THREE.Vector3(v.dot(field.axA), v.dot(field.axB), v.dot(field.axD));
  const cams = [];
  const L = new THREE.Vector3();
  for (let t = T0; t <= T1 + 1e-6; t += 0.1) {
    const sh = director.evaluate(t);
    if (!sh || !sh.camPos || !sh.camQuat) continue;
    field.toLocal(sh.camPos, L);
    const q = sh.camQuat;
    const f = toL(new THREE.Vector3(0, 0, -1).applyQuaternion(q));
    const r = toL(new THREE.Vector3(1, 0, 0).applyQuaternion(q));
    const u = toL(new THREE.Vector3(0, 1, 0).applyQuaternion(q));
    const tanY = Math.tan(((sh.fov || 50) * DEG) / 2);
    cams.push({ t, p: L.clone(), f, r, u, tanY, tanX: tanY * aspect });
  }
  if (cams.length < 3) return [];
  // the slow glide through the dense core: where the camera is near the crossing and slower than 1.2 u/s
  const slow = [];
  for (let i = 1; i < cams.length; i++) {
    const v = cams[i].p.distanceTo(cams[i - 1].p) / 0.1;
    if (v < 1.2 && Math.abs(cams[i].p.z) < 20) slow.push(cams[i].t);
  }
  if (!slow.length) return [];
  const ts0 = slow[0], ts1 = slow[slow.length - 1];
  const sunL = toL(field.origin.clone().negate().normalize());
  const n = specs.length;
  const beats = [];
  for (let b = 0; b < n; b++) {
    const spec = specs[b];
    const w0 = ts0 + ((ts1 - ts0) * b) / n, w1 = ts0 + ((ts1 - ts0) * (b + 1)) / n;
    const info = heroInfo[spec.hero];
    const phase0 = spec.phase ?? 85;
    const samples = cams.filter((c) => c.t >= w0 - 0.8 && c.t <= w1 + 0.8);
    let best = null;
    for (const fa of [0.2, 0.4, 0.6, 0.8]) {
      const tc = w0 + (w1 - w0) * fa;
      const C = cams.reduce((a, c) => (Math.abs(c.t - tc) < Math.abs(a.t - tc) ? c : a));
      for (let sx = -0.65; sx <= 0.651; sx += 0.1625)
        for (let sy = -0.45; sy <= 0.451; sy += 0.15)
          for (const d of [0.35, 0.5, 0.7, 1.0, 1.4, 2.0, 2.8]) {
            const dir = C.f.clone().addScaledVector(C.r, sx * C.tanX).addScaledVector(C.u, sy * C.tanY).normalize();
            const P = C.p.clone().addScaledVector(dir, d);
            // hero mean radius: a quarter of the frame's half-height at the anchor, within real big-asteroid sizes
            const scale = Math.min((spec.maxBound ?? 0.12) / info.boundR, Math.max(0.012, (0.3 * d * C.tanY) / 1.3));
            const bound = info.boundR * scale;
            // never near the camera path (whole chapter) nor another hero
            let ok = true;
            for (const c of cams) if (c.p.distanceTo(P) < bound + 0.05) { ok = false; break; }
            if (!ok) continue;
            for (const H of field.heroes) {
              const r = H.rock;
              const hb = r.bound + (H.moonA ? H.moonA + H.moonRock.bound : 0);
              if (Math.hypot(P.x - r.a, P.y - r.b, P.z - r.s) < (bound + hb) * 1.25 + 0.01) { ok = false; break; }
            }
            if (!ok) continue;
            let score = 0;
            for (const c of samples) {
              const rel = P.clone().sub(c.p);
              const dist = rel.length();
              // must not eclipse the Sun (the flare's occlusion test does not know about asteroids)
              const sunSep = Math.acos(Math.max(-1, Math.min(1, rel.dot(sunL) / dist)));
              if (sunSep < Math.asin(Math.min(1, bound / dist)) + 4 * DEG) { score = -1; break; }
              const z = rel.dot(c.f);
              if (z <= 0) continue;
              const x = rel.dot(c.r) / (z * c.tanX), y = rel.dot(c.u) / (z * c.tanY);
              const ar = (scale * 1.3) / (dist * c.tanY);
              const arx = ar * (c.tanY / c.tanX);
              const inF = (1 - sstep(0.8 - arx, 0.95 - arx, Math.abs(x))) * (1 - sstep(0.75 - ar, 0.92 - ar, Math.abs(y)));
              if (inF <= 0) continue;
              const sizeW = sstep(0.08, 0.22, ar) * (1 - sstep(0.6, 0.9, ar));
              const phase = Math.acos(Math.max(-1, Math.min(1, -rel.dot(sunL) / dist))) / DEG;
              const phaseW = Math.exp(-(((phase - phase0) / 32) ** 2));
              const centerW = 1 - 0.25 * (x * x + y * y);
              const inWin = c.t >= w0 && c.t <= w1 ? 1 : 0.5;
              score += 0.1 * inF * sizeW * phaseW * centerW * inWin;
            }
            if (score > 0 && (!best || score > best.score)) best = { score, P, scale, bound };
          }
    }
    if (!best) continue;
    const H = field.addHero({ hero: spec.hero, a: best.P.x, b: best.P.y, s: best.P.z, scale: best.scale, periodH: spec.periodH, tilt: 0.4, type: spec.type, albedo: spec.albedo, seedQ: spec.seedQ, beat: true });
    // when (and for how long) it is in frame at a readable size (radius >= ~3% of the frame height), and the
    // moment it is biggest near the centre
    let tIn = Infinity, tOut = -Infinity, tPeak = w0, pk = -1;
    for (const c of cams) {
      const rel = best.P.clone().sub(c.p);
      const z = rel.dot(c.f);
      if (z <= 0) continue;
      const x = rel.dot(c.r) / (z * c.tanX), y = rel.dot(c.u) / (z * c.tanY);
      const ar = H.rock.bound / (rel.length() * c.tanY);
      if (Math.abs(x) < 1 && Math.abs(y) < 1 && ar > 0.03) {
        tIn = Math.min(tIn, c.t);
        tOut = Math.max(tOut, c.t);
        const w = Math.min(ar, 0.5) * (1 - 0.5 * (x * x + y * y));
        if (w > pk) { pk = w; tPeak = c.t; }
      }
    }
    const pos = field.origin.clone().addScaledVector(field.axA, best.P.x).addScaledVector(field.axB, best.P.y).addScaledVector(field.axD, best.P.z);
    beats.push({ name: spec.name, t: +tPeak.toFixed(2), t0: +tIn.toFixed(2), t1: +tOut.toFixed(2), position: pos, local: best.P.clone(), radius: H.rock.bound, score: +best.score.toFixed(3) });
  }
  return beats;
}
