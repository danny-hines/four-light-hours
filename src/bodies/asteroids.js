// Asteroid belt: the dense local debris swarm the camera threads at the belt crossing, plus the faint belt as a
// whole for wide shots. See notes/asteroids.md for the director-facing field descriptor and shot commands.
//
//   object (universe origin, in main.js's `world` group)
//    |- local         re-centred on the camera each frame (modelMatrix ~ identity => precise floats)
//    |    |- rock meshes      one InstancedBufferGeometry per (shape, LOD); CPU picks LOD per rock
//    |    |- point rocks      one gl.POINTS lattice per size class, generated on the GPU (sub-pixel rocks)
//    |    '- dust             three lattice layers of motes / streaks / glints
//    '- ring          ~75k asteroids on Keplerian orbits (Kirkwood gaps, Hildas, Trojans)
import * as THREE from 'three';
import { generateShapesParallel } from './asteroids/shapes.js';
import { createField, FIELD, NCLASS, MESH_PX, rockQuaternion, PATH, PATH_N, PATH_S0, PATH_DS, slabDistance, newRock } from './asteroids/field.js';
import { rnd } from './asteroids/hash.js';
import { rockMaterial } from './asteroids/rockMaterial.js';
import { createPointClass } from './asteroids/points.js';
import { createDust } from './asteroids/dust.js';
import { createRing } from './asteroids/ring.js';
import { createGlow } from './asteroids/glow.js';
import { planBeats } from './asteroids/beats.js';
import { createGpuTimer } from './asteroids/gputimer.js';
import { AU } from '../core/astro.js';

export { FIELD };

// 20 regular shapes (max LOD 5) + 5 heroes (max LOD 6). Mid-size rocks are mostly angular collisional fragments:
// fracture-plane "cuts" (flat break faces with sharp edges) and impact "bites" (deep concavities that notch the
// silhouette) on top of tri-axial bases with axis ratios ~1 : 0.7 : 0.5 (lightcurve statistics of small asteroids).
const REGULAR = [
  { kind: 'potato', seed: 101, craters: 320, detailAmp: 0.03, bites: 2, cuts: 2 },
  { kind: 'potato', seed: 102, craters: 260, boulders: 60, detailAmp: 0.03, bites: 3, cuts: 3 },
  { kind: 'potato', seed: 103, craters: 360, detailAmp: 0.032, bites: 2, cuts: 4 },
  { kind: 'elongated', seed: 104, craters: 280, detailAmp: 0.026, bites: 1, cuts: 2 },
  { kind: 'contact', seed: 105, craters: 90, boulders: 260, ponds: 0.8, rubble: 1 },
  { kind: 'contact', seed: 106, craters: 200, boulders: 80, ponds: 0.4, rubble: 0.5, bites: 1 },
  { kind: 'arrokoth', seed: 107, craters: 160, detailAmp: 0.024, bites: 1 },
  { kind: 'dogbone', seed: 108, craters: 200, detailAmp: 0.024, bites: 1 },
  { kind: 'top', seed: 109, craters: 50, boulders: 360, rubble: 1 },
  { kind: 'shard', seed: 110, craters: 70, detailAmp: 0.018, bites: 1 },
  { kind: 'split', seed: 111, craters: 160, detailAmp: 0.026, bites: 1, cuts: 2 },
  { kind: 'mathilde', seed: 112, craters: 200, giantCraters: [{ r: 0.55, depth: 0.32 }, { r: 0.48, depth: 0.3 }, { r: 0.42, depth: 0.3 }, { r: 0.36, depth: 0.28 }] },
  // angular collisional fragments: fracture planes, sharp edges, up to 3:1, notched by a bite or two
  { kind: 'facet', seed: 113, craters: 110, detailAmp: 0.016, craterMin: 0.035, elong: [1, 0.6, 0.42], bites: 1 },
  { kind: 'facet', seed: 114, craters: 80, detailAmp: 0.016, craterMin: 0.035, elong: [1, 0.42, 0.33], bites: 1 },
  { kind: 'facet', seed: 115, craters: 90, detailAmp: 0.016, craterMin: 0.035, elong: [1, 0.78, 0.36], bites: 2 },
  { kind: 'facet', seed: 116, craters: 130, detailAmp: 0.018, craterMin: 0.035, elong: [1, 0.72, 0.55], bites: 2 },
  { kind: 'facet', seed: 117, craters: 120, detailAmp: 0.016, craterMin: 0.035, elong: [1, 0.55, 0.4], bites: 2 },
  { kind: 'facet', seed: 118, craters: 100, detailAmp: 0.018, craterMin: 0.035, elong: [1, 0.68, 0.47], bites: 1 },
  // Gaspra-like angular body (many flat faces) and an Ida-like curved, notched fragment
  { kind: 'potato', seed: 119, craters: 300, detailAmp: 0.028, bites: 2, cuts: 6, facetScale: 1.3 },
  { kind: 'elongated', seed: 120, craters: 340, detailAmp: 0.026, bites: 2, cuts: 3 },
];
const HEROES = [
  // H0 Eros-like (S-type, saddle, grooves)
  { kind: 'elongated', seed: 201, craters: 1800, grooves: 5, craterMin: 0.02, detailAmp: 0.008, lowScale: 0.55, boulders: 120, boulderMin: 0.02, boulderMax: 0.04, rubble: 0.35, bites: 2 },
  // H1 Itokawa-like rubble pile (angular boulders, smooth neck "seas")
  { kind: 'contact', seed: 202, craters: 60, boulders: 360, boulderMin: 0.035, boulderMax: 0.12, ponds: 1.0, rubble: 1, detailAmp: 0.01, lowScale: 0.7 },
  // H2 Bennu/Didymos-like spinning top (boulder-strewn)
  { kind: 'top', seed: 203, craters: 80, boulders: 320, boulderMin: 0.035, boulderMax: 0.11, rubble: 1, detailAmp: 0.01 },
  // H3 Ida-like, saturated with craters of every size
  { kind: 'potato', seed: 204, craters: 2600, craterMin: 0.017, grooves: 3, detailAmp: 0.008, lowScale: 0.6, rubble: 0.3, bites: 3, cuts: 2 },
  // H4 Vesta-like parent-body remnant: south-polar basin with a central peak, equatorial troughs
  { kind: 'vesta', seed: 205, level: 5, craters: 600, giantCraters: [{ dir: [0, -1, 0], r: 0.95, depth: 0.09, rim: 0.02, floor: 0.2, fresh: 0.9 }, { dir: [0.5, -0.75, 0.42], r: 0.6, depth: 0.08, rim: 0.015, floor: 0.3, fresh: 0.3 }], troughs: { axis: [0, 1, 0], n: 5, d0: -0.08, step: 0.045 }, peak: { dir: [0, -1, 0], r: 0.22, h: 0.06 } },
];

// heroes framed by the film camera during the slow glide (see beats.js): front-lit glide, then the sunward pan
const BEAT_SPECS = [
  { name: 'Eros-like', hero: 0, type: 1, albedo: 0.22, periodH: 5.27, seedQ: 301, phase: 60 },
  { name: 'Ida-like', hero: 3, type: 1, albedo: 0.2, periodH: 4.63, seedQ: 302, phase: 88 },
  // Itokawa is an S(IV)-type (geometric albedo ~0.29): its crescent reads against the sunward dust glow
  { name: 'Itokawa-like', hero: 1, type: 1, albedo: 0.24, periodH: 12.13, seedQ: 303, phase: 112 },
];

// URL debug switches (astdbg=noglow,nodust,nopoints,nomesh,noring and the shader ones in rockMaterial.js)
const DBG = (() => {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('astdbg') || '';
  } catch {
    return '';
  }
})();

// debug gallery (astdbg=gallery&galpx=60&galtype=1): every regular shape in a grid in front of the camera
const GAL = (() => {
  try {
    const p = new URLSearchParams(globalThis.location?.search || '');
    return { px: Number(p.get('galpx') || 60), type: Number(p.get('galtype') ?? 1), dist: Number(p.get('galdist') || 0.5) };
  } catch {
    return { px: 60, type: 1, dist: 0.5 };
  }
})();

// LOD 1 starts at a bounding radius of 2.5 px; each LOD doubles. Fine enough that a 30-80 px rock keeps its
// mesh-level relief (bites, cuts, the larger craters) in the silhouette: ~1.5-3 px between vertices.
const T1 = 2.5;

export async function create(ctx) {
  const { U } = ctx;
  const object = new THREE.Group();
  object.name = 'asteroids';
  const local = new THREE.Group();
  local.name = 'asteroids-local';
  object.add(local);
  const sharedK = { value: 865 };
  const pathUniforms = { uPathAB: { value: Array.from({ length: PATH_N }, () => new THREE.Vector2()) }, uPathOn: { value: 0 } };
  const actx = { ...ctx, sharedK, pathUniforms };

  // ---------------------------------------------------------------- shapes
  const shapes = [];
  const all = [...REGULAR.map((d) => ({ ...d, level: 5, mapSize: 128 })), ...HEROES.map((d) => ({ level: 6, mapSize: d.level === 5 ? 256 : 512, ...d, hero: true }))];
  const tGen0 = performance.now();
  const genTimes = [];
  const generated = await generateShapesParallel(all);
  for (let k = 0; k < all.length; k++) {
    const d = all[k], s = generated[k];
    s.rubble = d.rubble || 0;
    s.hero = !!d.hero;
    let mi = 0;
    for (let i = 1; i < 3; i++) if (s.axes[i] < s.axes[mi]) mi = i;
    s.spinAxis = mi;
    shapes.push(s);
  }
  const genMs = performance.now() - tGen0;
  const NSR = REGULAR.length;
  const shapeInfo = shapes.slice(0, NSR).map((s) => ({ boundR: s.boundR, axes: s.axes, spinAxis: s.spinAxis }));
  const heroInfo = shapes.slice(NSR).map((s) => ({ boundR: s.boundR, axes: s.axes, spinAxis: s.spinAxis }));

  // ---------------------------------------------------------------- meshes per (shape, LOD)
  const buckets = shapes.map((s, si) => {
    const tex = new THREE.DataTexture(THREE.DataUtils ? toHalf(s.radiusMap) : s.radiusMap, s.S, s.S, THREE.RedFormat, THREE.HalfFloatType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return s.levelsData.map((L, lod) => {
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(L.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(L.nor, 3));
      g.setAttribute('aPosC', new THREE.BufferAttribute(L.posC, 3));
      g.setAttribute('aNorC', new THREE.BufferAttribute(L.norC, 3));
      g.setAttribute('aAO', new THREE.BufferAttribute(L.ao, 4));
      g.setAttribute('aAOC', new THREE.BufferAttribute(L.aoC, 4));
      g.setIndex(new THREE.BufferAttribute(L.index, 1));
      g.instanceCount = 0;
      const mat = rockMaterial(actx, { shape: s, lod, radiusMap: tex, rubble: s.rubble, t1: T1 });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      mesh.name = `rock-${si}-L${lod}`;
      mesh.visible = false;
      local.add(mesh);
      const b = { mesh, geom: g, cap: 0, n: 0, arr: null, buf: null, minD: 0 };
      growBucket(b, lod <= 2 ? 256 : 32);
      return b;
    });
  });
  // the fine levels of L0 point their memory at the same arrays (no copies)
  function growBucket(b, cap) {
    const arr = new Float32Array(cap * 16);
    if (b.arr) arr.set(b.arr.subarray(0, b.n * 16));
    const buf = new THREE.InstancedInterleavedBuffer(arr, 16, 1);
    buf.setUsage(THREE.DynamicDrawUsage);
    b.geom.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 4, 0));
    b.geom.setAttribute('iQ', new THREE.InterleavedBufferAttribute(buf, 4, 4));
    b.geom.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 4, 8));
    b.geom.setAttribute('iC', new THREE.InterleavedBufferAttribute(buf, 4, 12));
    b.arr = arr;
    b.buf = buf;
    b.cap = cap;
  }

  // ---------------------------------------------------------------- point rocks, dust, ring
  // quality presets: q=low drops the two smallest point classes (sub-km rocks only ever seen as faint specks)
  const lowQ = ctx.quality === 'low';
  // radius maps of the regular shapes as one texture array (impostors sphere-trace them)
  {
    const S0 = shapes[0].S;
    const arr = new Uint16Array(S0 * S0 * NSR);
    for (let i = 0; i < NSR; i++) arr.set(toHalf(shapes[i].radiusMap), i * S0 * S0);
    const ta = new THREE.DataArrayTexture(arr, S0, S0, NSR);
    ta.format = THREE.RedFormat;
    ta.type = THREE.HalfFloatType;
    ta.minFilter = ta.magFilter = THREE.LinearFilter;
    ta.wrapS = ta.wrapT = THREE.ClampToEdgeWrapping;
    ta.generateMipmaps = false;
    ta.needsUpdate = true;
    actx.shapeMaps = ta;
  }
  const pointClasses = [];
  for (let c = lowQ ? 2 : 0; c < NCLASS; c++) {
    const pc = createPointClass(actx, c, shapeInfo);
    local.add(pc.points);
    pointClasses.push(pc);
  }
  const dust = createDust(actx);
  local.add(dust.object);
  const glow = createGlow(actx);
  local.add(glow.object);
  const ring = createRing(ctx);
  object.add(ring.object);

  // ---------------------------------------------------------------- field
  const field = createField(shapeInfo, heroInfo);
  const defaultCrossing = () => {
    const p = new THREE.Vector3(-1.438, 0.048, -2.285).multiplyScalar(AU);
    field.setCrossing(p, new THREE.Vector3(-0.829, 0.006, -0.56));
  };
  defaultCrossing();

  // ---------------------------------------------------------------- per-frame
  const camLocal = new THREE.Vector3();
  const qInv = new THREE.Quaternion();
  const tmp = new THREE.Vector3();
  const qq = new THREE.Quaternion();
  const heroSpheres = [];
  const galleryRocks = [];
  const newGalleryRock = (i) => {
    const r = newRock();
    const h = (0x9e3779b9 * (i + 7)) >>> 0;
    const u1 = rnd(h, 7), u2 = rnd(h, 8), u3 = rnd(h, 9);
    const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
    r.q0 = [s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2), s2 * Math.sin(2 * Math.PI * u3), s2 * Math.cos(2 * Math.PI * u3)];
    r.omega = 0.15;
    r.shape = i;
    r.spinAxis = shapeInfo[i].spinAxis;
    r.seed = rnd(h, 19);
    return r;
  };
  let firstFrame = true;
  const stats = { meshes: 0, points: 0, candidates: 0, cpuMs: 0, genMs, genTimes };
  // astdbg=gpu: per-pass GPU timings in window.__asteroids.stats.gpu / gpuMin (ms)
  const gpuT = DBG.includes('gpu') ? createGpuTimer(ctx.renderer, stats) : null;
  if (gpuT) {
    for (const B of buckets) for (const b of B) gpuT.wrap(b.mesh, 'meshes');
    for (const pc of pointClasses) gpuT.wrap(pc.points, 'points');
    for (const m of dust.object.children) gpuT.wrap(m, 'dust');
    gpuT.wrap(glow.object, 'glow');
    for (const m of ring.object.children) gpuT.wrap(m, 'ring');
  }
  const heroBeats = [];
  globalThis.__asteroids = { stats, field, heroBeats };

  function relOf(a, b, s, out) {
    // local (a,b,s) -> camera-relative world
    const x = a - camLocal.x, y = b - camLocal.y, z = s - camLocal.z;
    return out.set(0, 0, 0).addScaledVector(field.axA, x).addScaledVector(field.axB, y).addScaledVector(field.axD, z);
  }

  // Sample the director's actual camera path through the tube once, and clear a corridor around it so the
  // camera can never fly into a rock whatever its weave. Deterministic (the director is a pure function of t).
  let pathSampled = false;
  function samplePath(aspect) {
    pathSampled = true;
    const dir = ctx.director;
    globalThis.__asteroids.director = dir;
    if (!dir || typeof dir.evaluate !== 'function' || !(dir.duration > 0)) return;
    const pts = [];
    const L = new THREE.Vector3();
    const inside = (t) => {
      const sh = dir.evaluate(t);
      if (!sh || !sh.camPos) return null;
      field.toLocal(sh.camPos, L);
      return slabDistance(L.x, L.y, L.z) < 2 ? L.clone() : null;
    };
    const coarse = 0.25;
    let ta = Infinity, tb = -Infinity;
    for (let t = 0; t <= dir.duration; t += coarse)
      if (inside(t)) {
        ta = Math.min(ta, t);
        tb = Math.max(tb, t);
      }
    if (ta > tb) return;
    for (let u = Math.max(0, ta - coarse); u <= Math.min(dir.duration, tb + coarse); u += 0.01) {
      const p = inside(u);
      if (p) pts.push(p);
    }
    if (!pts.length) return;
    // bin lateral offsets by s station (linear interpolation between the nearest samples)
    pts.sort((p, q) => p.z - q.z);
    const ab = PATH.ab;
    let j = 0, any = false;
    for (let i = 0; i < PATH_N; i++) {
      const s = PATH_S0 + i * PATH_DS;
      while (j < pts.length - 1 && pts[j + 1].z < s) j++;
      const p = pts[j], q = pts[Math.min(pts.length - 1, j + 1)];
      let a, b;
      if (s <= pts[0].z) [a, b] = [pts[0].x, pts[0].y];
      else if (s >= pts[pts.length - 1].z) [a, b] = [pts[pts.length - 1].x, pts[pts.length - 1].y];
      else {
        const f = q.z > p.z ? (s - p.z) / (q.z - p.z) : 0;
        a = p.x + (q.x - p.x) * f;
        b = p.y + (q.y - p.y) * f;
      }
      ab[i * 2] = a;
      ab[i * 2 + 1] = b;
      any = true;
    }
    PATH.on = any;
    for (let i = 0; i < PATH_N; i++) pathUniforms.uPathAB.value[i].set(ab[i * 2], ab[i * 2 + 1]);
    pathUniforms.uPathOn.value = any ? 1 : 0;
    field.clearHeroesFromPath();
    try {
      heroBeats.push(...planBeats({ director: dir, field, heroInfo, aspect, specs: BEAT_SPECS }));
    } catch (e) {
      heroBeats.length = 0;
    }
    field.clearCache();
  }

  function update(frame) {
    const t0 = performance.now();
    if (!pathSampled && ctx.director) samplePath(frame.camera.aspect || 16 / 9);
    const t = frame.t;
    const cam = frame.camera;
    const camU = frame.camUniverse;
    local.position.copy(camU);
    field.toLocal(camU, camLocal);
    const rhoCam = Math.hypot(camLocal.x, camLocal.y);
    const slabD = slabDistance(camLocal.x, camLocal.y, camLocal.z);
    const near = slabD < 60;
    for (const B of buckets) for (const b of B) { b.n = 0; b.minD = 0; }
    stats.meshes = 0;
    stats.points = 0;
    if (near) {
      const K = (U.uResolution.value.y * 0.5 * cam.projectionMatrix.elements[5]);
      sharedK.value = K;
      qInv.copy(cam.quaternion).invert();
      const tanY = 1 / cam.projectionMatrix.elements[5], tanX = 1 / cam.projectionMatrix.elements[0];
      const cosX = 1 / Math.sqrt(1 + tanX * tanX), cosY = 1 / Math.sqrt(1 + tanY * tanY);
      const inFrustum = (rel, r) => {
        tmp.copy(rel).applyQuaternion(qInv);
        const z = -tmp.z;
        if (z < -r) return false;
        if (Math.abs(tmp.x) > z * tanX + r / cosX) return false;
        if (Math.abs(tmp.y) > z * tanY + r / cosY) return false;
        return true;
      };
      const rel = new THREE.Vector3();
      const pushRock = (r, shapeIdx, a, b, s, hero) => {
        relOf(a, b, s, rel);
        const d = rel.length();
        const pB = (r.bound * K) / Math.max(d, 1e-9);
        if (pB < (hero ? 0.8 : MESH_PX - 0.05)) return;
        if (!inFrustum(rel, r.bound)) return;
        const S = shapes[shapeIdx];
        const lod = pB < T1 ? 0 : Math.min(S.level, 1 + Math.floor(Math.log2(pB / T1)));
        const bk = buckets[shapeIdx][lod];
        if (bk.n >= bk.cap) growBucket(bk, bk.cap * 2);
        rockQuaternion(r, t, qq);
        const o = bk.n * 16, A = bk.arr;
        A[o] = rel.x; A[o + 1] = rel.y; A[o + 2] = rel.z; A[o + 3] = r.scale;
        A[o + 4] = qq.x; A[o + 5] = qq.y; A[o + 6] = qq.z; A[o + 7] = qq.w;
        A[o + 8] = r.stretch[0]; A[o + 9] = r.stretch[1]; A[o + 10] = r.stretch[2]; A[o + 11] = r.seed;
        A[o + 12] = r.color[0]; A[o + 13] = r.color[1]; A[o + 14] = r.color[2]; A[o + 15] = r.type + (hero ? 10 : 0);
        bk.n++;
        stats.meshes++;
      };
      // lattice rocks large enough to be meshes
      const maxBoundFactor = Math.max(...shapeInfo.map((x) => x.boundR)) * 1.18 * 2; // shape bound x stretch x top of the size octave
      // local -> camera-space matrix for the incremental cell frustum test
      const mLC = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(qInv)).multiply(field.basis);
      const cellCheck = { m: mLC.elements, boundFactor: maxBoundFactor, tanX, tanY, cosX, cosY };
      const bigEnough = (a, b, s, bound) => {
        const x = a - camLocal.x, y = b - camLocal.y, z = s - camLocal.z;
        return bound * K >= (MESH_PX - 0.05) * Math.sqrt(x * x + y * y + z * z);
      };
      const tE = performance.now();
      const galMode = DBG.includes('gallery');
      if (!galMode) field.forEachRockNear(camLocal, (C) => (C.r * maxBoundFactor * K) / (MESH_PX - 0.05), (r) => pushRock(r, r.shape, r.a, r.b, r.s, false), cellCheck, bigEnough, true);
      stats.enumMs = performance.now() - tE;
      // heroes (and their moons)
      heroSpheres.length = 0;
      for (const H of galMode ? [] : field.heroes) {
        const r = H.rock;
        if (H.cluster) {
          pushRock(r, r.shape, r.a, r.b, r.s, true);
          continue;
        }
        pushRock(r, NSR + H.hero, r.a, r.b, r.s, true);
        relOf(r.a, r.b, r.s, rel);
        heroSpheres.push({ v: new THREE.Vector4(rel.x, rel.y, rel.z, r.scale * 0.92), d: rel.length() });
        if (H.moonRock) {
          field.moonPos(H, t, tmp);
          const m = H.moonRock;
          pushRock(m, m.shape, tmp.x, tmp.y, tmp.z, true);
        }
      }
      if (galMode) {
        // shape gallery: all regular shapes on a grid at GAL.dist in front of the camera, GAL.px bounding radius
        const n = NSR, cols = Math.min(6, n), rows = Math.ceil(n / cols);
        const fw = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
        const rt = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        const upv = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
        const D = GAL.dist, hw = D * tanX * 0.92, hh = D * tanY * 0.9;
        const T = [0.05, 0.2, 0.15, 0.32, 0.05, 0.04];
        for (let i = 0; i < n; i++) {
          const cx = (i % cols + 0.5) / cols * 2 - 1, cy = 1 - (Math.floor(i / cols) + 0.5) / rows * 2;
          const w = fw.clone().multiplyScalar(D).addScaledVector(rt, cx * hw).addScaledVector(upv, cy * hh);
          const r = galleryRocks[i] || (galleryRocks[i] = newGalleryRock(i));
          r.scale = (GAL.px * D) / (K * shapeInfo[i].boundR);
          r.bound = shapeInfo[i].boundR * r.scale;
          r.type = GAL.type;
          const alb = T[GAL.type] ?? 0.15;
          r.color = [alb, alb, alb];
          const la = camLocal.x + w.dot(field.axA), lb = camLocal.y + w.dot(field.axB), ls = camLocal.z + w.dot(field.axD);
          pushRock(r, i, la, lb, ls, true);
        }
      }
      heroSpheres.sort((x, y) => x.d - y.d);
      // point lattices: clip each class's lattice box to the frustum (sampled directions out to unit range)
      const fb = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
      const bT = field.basis.clone().transpose();
      const qc = cam.quaternion;
      const grow = (x, y, z) => {
        const lx = bT.elements[0] * x + bT.elements[3] * y + bT.elements[6] * z;
        const ly = bT.elements[1] * x + bT.elements[4] * y + bT.elements[7] * z;
        const lz = bT.elements[2] * x + bT.elements[5] * y + bT.elements[8] * z;
        fb.min[0] = Math.min(fb.min[0], lx); fb.max[0] = Math.max(fb.max[0], lx);
        fb.min[1] = Math.min(fb.min[1], ly); fb.max[1] = Math.max(fb.max[1], ly);
        fb.min[2] = Math.min(fb.min[2], lz); fb.max[2] = Math.max(fb.max[2], lz);
      };
      grow(0, 0, 0);
      const vd = new THREE.Vector3();
      for (let i = 0; i <= 6; i++)
        for (let j = 0; j <= 6; j++) {
          vd.set((i / 3 - 1) * tanX * 1.06, (j / 3 - 1) * tanY * 1.06, -1).normalize().applyQuaternion(qc);
          grow(vd.x, vd.y, vd.z);
        }
      for (const pc of pointClasses) stats.points += pc.update(camLocal, field.basis, fb);
      dust.update(camLocal, field.basis, heroSpheres.slice(0, 4).map((h) => h.v), 1);
      glow.update(camLocal, field.basis, heroSpheres.slice(0, 4).map((h) => h.v));
    }
    for (const pc of pointClasses) if (!near) pc.points.visible = false;
    dust.object.visible = near;
    glow.object.visible = slabD < 600;
    if (glow.object.visible && !near) glow.update(camLocal, field.basis);
    // upload instance buffers (instances sorted near-to-far, buckets drawn nearest-first: less overdraw)
    for (const B of buckets)
      for (const b of B) {
        if (b.n > 1) sortBucket(b);
        b.mesh.renderOrder = b.n > 0 ? Math.min(1e6, Math.floor(b.minD * 1e5)) : 0;
        b.geom.instanceCount = b.n;
        b.mesh.visible = b.n > 0; // main.js warms every program behind the splash (all buckets exist from create())
        if (b.n > 0) {
          b.buf.clearUpdateRanges();
          b.buf.addUpdateRange(0, b.n * 16);
          b.buf.needsUpdate = true;
        }
      }
    ring.update(frame);
    if (DBG) {
      if (DBG.includes('noglow')) glow.object.visible = false;
      if (DBG.includes('nodust')) dust.object.visible = false;
      if (DBG.includes('nopoints')) for (const pc of pointClasses) pc.points.visible = false;
      if (DBG.includes('nomesh')) for (const B of buckets) for (const b of B) b.mesh.visible = false;
      if (DBG.includes('noring')) ring.object.visible = false;
    }
    firstFrame = false;
    stats.cpuMs = performance.now() - t0;
    gpuT?.poll();
  }

  return {
    id: 'asteroids',
    object,
    field: FIELD,
    stats,
    heroes: field.heroes,
    heroBeats, // [{ name, t, t0, t1, position (universe), radius }]: filled on the first frame from the director's camera
    setCrossing(position, direction) {
      field.setCrossing(position, direction);
    },
    nearestDistance(camUniverse) {
      return field.nearestDistance(camUniverse, U.uTime.value);
    },
    update,
  };
}

const _ord = [];
let _tmpArr = new Float32Array(0);
function sortBucket(b) {
  const A = b.arr, n = b.n;
  _ord.length = n;
  for (let i = 0; i < n; i++) _ord[i] = i;
  const d = (i) => A[i * 16] * A[i * 16] + A[i * 16 + 1] * A[i * 16 + 1] + A[i * 16 + 2] * A[i * 16 + 2];
  _ord.sort((x, y) => d(x) - d(y));
  if (_tmpArr.length < n * 16) _tmpArr = new Float32Array(n * 32);
  for (let i = 0; i < n; i++) _tmpArr.set(A.subarray(_ord[i] * 16, _ord[i] * 16 + 16), i * 16);
  A.set(_tmpArr.subarray(0, n * 16));
  b.minD = Math.sqrt(d(0));
}

function toHalf(f32) {
  const out = new Uint16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = THREE.DataUtils.toHalfFloat(f32[i]);
  return out;
}
