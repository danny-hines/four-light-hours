// Procedural asteroid shapes, generated deterministically at load time.
//
// Every shape is a star-shaped radial function R(dir) = Rbase(dir) + Δ(dir): a smooth base solid (tri-axial
// ellipsoid, bent "Eros" banana, contact-binary lobes, Bennu-style spinning top, fractured shard, dog-bone...)
// plus multi-octave noise, power-law crater populations (bowl + sharp rim + ejecta falloff, fresh vs degraded),
// boulder fields, smooth regolith "ponds" and groove sets. It is sampled on a subdivided-icosphere hierarchy.
//
// Continuous LOD without popping: level k+1 of the hierarchy stores, for every vertex, its own position/normal
// AND the position/normal that the level-k surface has at that point ("coarse" attributes). The vertex shader
// morphs coarse -> fine with the rock's pixel size, so switching from level k (fully morphed) to level k+1
// (unmorphed) is geometrically exact. Detail in each level is band-limited to that level's vertex spacing.
//
// Per vertex we also bake: ambient occlusion (ray-marched against the shape's own radius map), a multi-scale
// cavity/convexity term, and a "pond" (smooth regolith) weight. Each shape also gets an octahedral radius map
// used by the fragment shader to ray-march true cast self-shadows (lobes shadowing lobes, crater rims...).
// The whole generator lives inside shapeLibrary() with no outside references, so it can be stringified into a
// Web Worker (see generateShapesParallel) as well as run on the main thread.
export function shapeLibrary() {
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const G3 = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];
  const F3 = 1 / 3, G = 1 / 6;

  function makeSimplex(seed) {
    const rng = mulberry32(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    const perm = new Uint8Array(512), pm12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      perm[i] = p[i & 255];
      pm12[i] = perm[i] % 12;
    }
    function noise(xin, yin, zin) {
      const s = (xin + yin + zin) * F3;
      const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
      const t = (i + j + k) * G;
      const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);
      let i1, j1, k1, i2, j2, k2;
      if (x0 >= y0) {
        if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
        else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
        else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
      } else {
        if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
        else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
        else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      }
      const x1 = x0 - i1 + G, y1 = y0 - j1 + G, z1 = z0 - k1 + G;
      const x2 = x0 - i2 + 2 * G, y2 = y0 - j2 + 2 * G, z2 = z0 - k2 + 2 * G;
      const x3 = x0 - 1 + 3 * G, y3 = y0 - 1 + 3 * G, z3 = z0 - 1 + 3 * G;
      const ii = i & 255, jj = j & 255, kk = k & 255;
      let n = 0, tt, gi;
      tt = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
      if (tt > 0) { gi = pm12[ii + perm[jj + perm[kk]]] * 3; tt *= tt; n += tt * tt * (G3[gi] * x0 + G3[gi + 1] * y0 + G3[gi + 2] * z0); }
      tt = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
      if (tt > 0) { gi = pm12[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3; tt *= tt; n += tt * tt * (G3[gi] * x1 + G3[gi + 1] * y1 + G3[gi + 2] * z1); }
      tt = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
      if (tt > 0) { gi = pm12[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3; tt *= tt; n += tt * tt * (G3[gi] * x2 + G3[gi + 1] * y2 + G3[gi + 2] * z2); }
      tt = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
      if (tt > 0) { gi = pm12[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3; tt *= tt; n += tt * tt * (G3[gi] * x3 + G3[gi + 1] * y3 + G3[gi + 2] * z3); }
      return 32 * n; // ~[-1, 1]
    }
    return noise;
  }


  // ------------------------------------------------------------------------------------------ icosphere hierarchy
  let HIER = null;
  function icoHierarchy(L) {
    if (HIER && HIER.L >= L) return HIER;
    const t = (1 + Math.sqrt(5)) / 2;
    const base = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
    const idx = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
    let Vmax = 12;
    for (let l = 1; l <= L; l++) Vmax = Vmax * 4 - 6;
    const dirs = new Float64Array(Vmax * 3);
    const parents = new Int32Array(Vmax * 2).fill(-1);
    for (let i = 0; i < 12; i++) {
      const x = base[i * 3], y = base[i * 3 + 1], z = base[i * 3 + 2];
      const n = Math.hypot(x, y, z);
      dirs[i * 3] = x / n;
      dirs[i * 3 + 1] = y / n;
      dirs[i * 3 + 2] = z / n;
    }
    let faces = new Uint32Array(idx);
    // make sure faces wind counter-clockwise seen from outside
    for (let f = 0; f < 20; f++) {
      const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
      const ax = dirs[a * 3], ay = dirs[a * 3 + 1], az = dirs[a * 3 + 2];
      const ux = dirs[b * 3] - ax, uy = dirs[b * 3 + 1] - ay, uz = dirs[b * 3 + 2] - az;
      const vx = dirs[c * 3] - ax, vy = dirs[c * 3 + 1] - ay, vz = dirs[c * 3 + 2] - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * ax + ny * ay + nz * az < 0) {
        faces[f * 3 + 1] = c;
        faces[f * 3 + 2] = b;
      }
    }
    const levels = [{ V: 12, faces }];
    let V = 12;
    for (let l = 1; l <= L; l++) {
      const prev = levels[l - 1].faces;
      const nf = new Uint32Array(prev.length * 4);
      const map = new Map();
      const mid = (a, b) => {
        const key = a < b ? a * 1048576 + b : b * 1048576 + a;
        let m = map.get(key);
        if (m !== undefined) return m;
        m = V++;
        const x = dirs[a * 3] + dirs[b * 3], y = dirs[a * 3 + 1] + dirs[b * 3 + 1], z = dirs[a * 3 + 2] + dirs[b * 3 + 2];
        const n = Math.hypot(x, y, z);
        dirs[m * 3] = x / n;
        dirs[m * 3 + 1] = y / n;
        dirs[m * 3 + 2] = z / n;
        parents[m * 2] = a;
        parents[m * 2 + 1] = b;
        map.set(key, m);
        return m;
      };
      for (let f = 0, o = 0; f < prev.length; f += 3) {
        const a = prev[f], b = prev[f + 1], c = prev[f + 2];
        const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
        // children of face f/3 are 4*(f/3) .. 4*(f/3)+3 (used by the radius-map descent)
        nf[o++] = a; nf[o++] = ab; nf[o++] = ca;
        nf[o++] = b; nf[o++] = bc; nf[o++] = ab;
        nf[o++] = c; nf[o++] = ca; nf[o++] = bc;
        nf[o++] = ab; nf[o++] = bc; nf[o++] = ca;
      }
      levels.push({ V, faces: nf });
    }
    HIER = { L, dirs, parents, levels };
    return HIER;
  }

  // ------------------------------------------------------------------------------------------ helpers
  const smin = (a, b, k) => {
    const h = Math.max(k - Math.abs(a - b), 0) / k;
    return Math.min(a, b) - h * h * k * 0.25;
  };
  const smax = (a, b, k) => -smin(-a, -b, k);
  const sstep = (e0, e1, x) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  function sdEllipsoid(x, y, z, a, b, c) {
    // Inigo Quilez's bound-ish ellipsoid distance; good enough for smooth unions
    const k0 = Math.hypot(x / a, y / b, z / c);
    const k1 = Math.hypot(x / (a * a), y / (b * b), z / (c * c));
    return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : -Math.min(a, b, c);
  }
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm3 = (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  function randDir(rng) {
    const u = rng() * 2 - 1, th = rng() * Math.PI * 2, r = Math.sqrt(1 - u * u);
    return [r * Math.cos(th), u, r * Math.sin(th)];
  }
  // power-law radius in [r0, r1] with cumulative slope q
  function powerLaw(rng, r0, r1, q) {
    const u = rng();
    const a = Math.pow(r0, -q), b = Math.pow(r1, -q);
    return Math.pow(a - u * (a - b), -1 / q);
  }

  // ------------------------------------------------------------------------------------------ shape kinds
  // Each kind returns { G(x,y,z) implicit (<0 inside) OR Rb(dx,dy,dz) closed form, params... }
  function baseFor(kind, rng, desc = {}) {
    const j = (a, b) => a + (b - a) * rng();
    switch (kind) {
      case 'potato': {
        const a = 1, b = j(0.62, 0.8), c = j(0.46, 0.62);
        return { Rb: (x, y, z) => 1 / Math.hypot(x / a, y / b, z / c), lowAmp: 0.17, lowFreq: 0.95, facet: 0.07 };
      }
      case 'elongated': {
        // Eros-like: 34 x 11 x 11 km banana with a saddle on the concave side
        const a = 1, b = j(0.38, 0.44), c = j(0.34, 0.4), bend = j(0.22, 0.32), twist = j(-0.25, 0.25);
        return {
          G: (x, y, z) => {
            const yy = y + bend * (x * x - 0.35);
            const ct = Math.cos(twist * x), st = Math.sin(twist * x);
            const y2 = ct * yy - st * z, z2 = st * yy + ct * z;
            return sdEllipsoid(x, y2, z2, a, b, c);
          },
          rMax: 1.15,
          lowAmp: 0.1,
          lowFreq: 1.3,
          facet: 0.04,
          saddle: [0, 1, 0],
        };
      }
      case 'contact': {
        // Itokawa / 67P-like bilobate rubble pile
        const r1 = [j(0.58, 0.66), j(0.48, 0.54), j(0.42, 0.48)], r2 = [j(0.42, 0.5), j(0.36, 0.42), j(0.33, 0.39)];
        const c1 = -j(0.32, 0.4), c2 = j(0.44, 0.52), off = j(-0.08, 0.08), k = j(0.26, 0.34);
        return {
          G: (x, y, z) => smin(sdEllipsoid(x - c1, y, z, r1[0], r1[1], r1[2]), sdEllipsoid(x - c2, y - off, z, r2[0], r2[1], r2[2]), k),
          rMax: 1.4,
          lowAmp: 0.15,
          lowFreq: 1.5,
          facet: 0.06,
          neckX: (c1 * r2[0] + c2 * r1[0]) / (r1[0] + r2[0]),
        };
      }
      case 'arrokoth': {
        // flattened contact binary ("snowman" of two pancake lobes)
        const r1 = [j(0.6, 0.66), j(0.5, 0.56), j(0.28, 0.34)], r2 = [j(0.44, 0.5), j(0.4, 0.45), j(0.26, 0.31)];
        const c1 = -j(0.36, 0.42), c2 = j(0.5, 0.56), k = j(0.1, 0.16);
        return {
          G: (x, y, z) => smin(sdEllipsoid(x - c1, y, z, r1[0], r1[1], r1[2]), sdEllipsoid(x - c2, y, z, r2[0], r2[1], r2[2]), k),
          rMax: 1.4,
          lowAmp: 0.1,
          lowFreq: 1.4,
          facet: 0.04,
          neckX: (c1 * r2[0] + c2 * r1[0]) / (r1[0] + r2[0]),
        };
      }
      case 'dogbone': {
        // Kleopatra-like: two bulbous ends joined by a thick neck
        const L = j(0.62, 0.7), rl = j(0.42, 0.48), rn = j(0.33, 0.37);
        return {
          G: (x, y, z) => {
            const cx = Math.max(-L, Math.min(L, x));
            const capsule = Math.hypot(x - cx, y, z * 1.12) - rn;
            const l1 = Math.hypot(x + L, y, z * 1.1) - rl, l2 = Math.hypot(x - L, y * 1.05, z) - rl * 0.94;
            return smin(capsule, Math.min(l1, l2), 0.22);
          },
          rMax: 1.4,
          lowAmp: 0.13,
          lowFreq: 1.3,
          facet: 0.05,
        };
      }
      case 'top': {
        // Bennu / Ryugu spinning top: superellipse profile with an equatorial ridge
        const h = j(0.84, 0.92), n = j(1.25, 1.45);
        return {
          Rb: (x, y, z) => {
            const cl = Math.hypot(x, z), sl = Math.abs(y);
            return Math.pow(Math.pow(cl, n) + Math.pow(sl / h, n), -1 / n);
          },
          lowAmp: 0.04,
          lowFreq: 1.4,
          facet: 0.02,
        };
      }
      case 'shard': {
        // young collisional fragment: convex polyhedron with softened edges
        const np = 10 + Math.floor(rng() * 6);
        const planes = [];
        for (let i = 0; i < np; i++) {
          const d = randDir(rng);
          planes.push([d[0], d[1] * 0.8, d[2] * 0.9, j(0.62, 0.9)]);
        }
        const kk = j(0.035, 0.06);
        return {
          G: (x, y, z) => {
            let m = -1e9;
            const vals = [];
            for (const p of planes) {
              const v = (p[0] * x + p[1] * y + p[2] * z) / Math.hypot(p[0], p[1], p[2]) - p[3];
              vals.push(v);
              if (v > m) m = v;
            }
            let s = 0;
            for (const v of vals) s += Math.exp((v - m) / kk);
            const poly = m + kk * Math.log(s);
            return Math.max(poly, sdEllipsoid(x, y, z, 1.25, 1.0, 0.85));
          },
          rMax: 1.6,
          lowAmp: 0.04,
          lowFreq: 1.6,
          facet: 0.015,
        };
      }
      case 'split': {
        // a fragment with one large flat fracture face
        const nrm = randDir(rng), d = j(0.25, 0.45), b = j(0.75, 0.9), c = j(0.62, 0.78);
        return {
          G: (x, y, z) => smax(sdEllipsoid(x, y, z, 1, b, c), x * nrm[0] + y * nrm[1] + z * nrm[2] - d, 0.08),
          rMax: 1.2,
          lowAmp: 0.11,
          lowFreq: 1.1,
          facet: 0.05,
        };
      }
      case 'facet': {
        // young collisional fragment: an elongated ellipsoid cut by 7..12 fracture planes with sharp edges
        const e = desc.elong || [1, j(0.45, 0.8), j(0.3, 0.6)];
        const np = 7 + Math.floor(rng() * 6);
        const planes = [];
        for (let i = 0; i < np; i++) {
          const d = randDir(rng);
          const hs = Math.hypot(e[0] * d[0], e[1] * d[1], e[2] * d[2]); // ellipsoid support distance
          planes.push([d[0], d[1], d[2], hs * j(0.6, 0.9)]);
        }
        const kk = j(0.008, 0.016);
        return {
          G: (x, y, z) => {
            let m = -1e9;
            const vals = [];
            for (const p of planes) {
              const v = p[0] * x + p[1] * y + p[2] * z - p[3];
              vals.push(v);
              if (v > m) m = v;
            }
            let s = 0;
            for (const v of vals) s += Math.exp((v - m) / kk);
            return Math.max(m + kk * Math.log(s), sdEllipsoid(x, y, z, e[0], e[1], e[2]));
          },
          rMax: 1.3,
          lowAmp: 0.05,
          lowFreq: 1.2,
          facet: 0.03,
        };
      }
      case 'mathilde': {
        const b = j(0.78, 0.86), c = j(0.66, 0.74);
        return { Rb: (x, y, z) => 1 / Math.hypot(x, y / b, z / c), lowAmp: 0.14, lowFreq: 1.0, facet: 0.06 };
      }
      case 'vesta': {
        return { Rb: (x, y, z) => 1 / Math.hypot(x / 1.0, y / 0.82, z / 0.96), lowAmp: 0.035, lowFreq: 1.0 };
      }
      default:
        throw new Error('unknown asteroid kind ' + kind);
    }
  }

  // Outermost root of G along the ray t*dir, refined from a guess.
  function rootRadius(G, dx, dy, dz, guess, rMax) {
    if (!(guess > 0)) {
      // full search from outside
      let t1 = rMax, g1 = G(dx * t1, dy * t1, dz * t1);
      let t0 = t1;
      for (let i = 0; i < 48 && g1 > 0; i++) {
        t0 = t1;
        t1 -= rMax / 48;
        g1 = G(dx * t1, dy * t1, dz * t1);
      }
      let lo = Math.max(t1, 1e-4), hi = t0;
      for (let i = 0; i < 26; i++) {
        const m = 0.5 * (lo + hi);
        if (G(dx * m, dy * m, dz * m) > 0) hi = m;
        else lo = m;
      }
      return 0.5 * (lo + hi);
    }
    // bracket around the guess, expanding outward first so we keep the outermost crossing
    let hi = guess * 1.04;
    let k = 0;
    while (G(dx * hi, dy * hi, dz * hi) <= 0 && k++ < 40) hi *= 1.05;
    let lo = guess * 0.96;
    k = 0;
    while (G(dx * lo, dy * lo, dz * lo) > 0 && k++ < 60) lo *= 0.95;
    for (let i = 0; i < 14; i++) {
      const m = 0.5 * (lo + hi);
      if (G(dx * m, dy * m, dz * m) > 0) hi = m;
      else lo = m;
    }
    return 0.5 * (lo + hi);
  }

  // ------------------------------------------------------------------------------------------ one shape
  /**
   * desc: { kind, seed, level, craters, boulders, ponds, grooves, hero }
   * returns { kind, level, levelsData: [{pos, nor, posC, norC, ao, aoC, index}], boundR, axes, radiusMap(Float32Array S*S), S }
   */
  function generateShape(desc) {
    const rng = mulberry32(desc.seed);
    const noise = makeSimplex(desc.seed ^ 0x5bd1e995);
    const noise2 = makeSimplex(desc.seed ^ 0x27d4eb2f);
    const B = baseFor(desc.kind, rng, desc);
    const L = desc.level;
    const H = icoHierarchy(L);
    const dirs = H.dirs, parents = H.parents;
    const Vmax = H.levels[L].V;

    // ---- base radius (smooth) for every vertex direction, refined level by level from the parents' average
    const Rb = new Float64Array(Vmax);
    const lowAmp = B.lowAmp * (desc.lowScale ?? 1), lowFreq = B.lowFreq;
    const lowNoise = (x, y, z) => {
      let s = 0, a = 1, f = lowFreq, n = 0;
      for (let o = 0; o < 3; o++) {
        s += a * noise(x * f + 11.3, y * f - 7.1, z * f + 3.7);
        n += a;
        a *= o === 0 ? 0.42 : 0.3; // the third octave made soft "dough" lumps: keep it weak
        f *= 2.1;
      }
      return s / n;
    };
    // low-frequency irregularity (multiplicative), part of the "base" surface on which features are placed
    // angular "facets": ridged noise at 2..4 cycles per radius gives the broken, faceted look of fragments
    const facetAmp = (B.facet ?? 0.03) * (desc.facetScale ?? 1);
    const facetNoise = (x, y, z) => {
      let s = 0, a = 1, f = 2.1, n = 0;
      for (let o = 0; o < 2; o++) {
        const v = 1 - Math.abs(noise2(x * f + 3.3, y * f - 1.7, z * f + 8.1));
        s += a * (v * v - 0.45);
        n += a;
        a *= 0.5;
        f *= 2.2;
      }
      return s / n;
    };
    for (let i = 0; i < Vmax; i++) {
      const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
      let r;
      if (B.Rb) r = B.Rb(dx, dy, dz);
      else {
        const pa = parents[i * 2];
        const guess = pa < 0 ? 0 : 0.5 * (Rb[pa] + Rb[parents[i * 2 + 1]]);
        r = rootRadius(B.G, dx, dy, dz, guess, B.rMax);
      }
      Rb[i] = r;
    }
    // Fracture planes ("cuts"): a collisional fragment keeps a few large, nearly flat break faces with sharp
    // (slightly bevelled) edges, like Gaspra or Steins. Applied to the noisy base radius, so the faces stay flat.
    const jr = (a, b) => a + (b - a) * rng();
    const rawSurf = (dx, dy, dz) => {
      const rb = B.Rb ? B.Rb(dx, dy, dz) : rootRadius(B.G, dx, dy, dz, 0, B.rMax);
      return rb * (1 + lowAmp * lowNoise(dx, dy, dz) + facetAmp * facetNoise(dx, dy, dz));
    };
    const cuts = [];
    for (let i = 0; i < (desc.cuts ?? 0); i++) {
      const n = randDir(rng);
      cuts.push({ n, D: rawSurf(n[0], n[1], n[2]) * jr(desc.cutMin ?? 0.7, desc.cutMax ?? 0.88), k: jr(0.012, 0.03) });
    }
    const cutR = (dx, dy, dz, r) => {
      for (const c of cuts) {
        const cc = dx * c.n[0] + dy * c.n[1] + dz * c.n[2];
        if (cc > 0.03) r = smin(r, c.D / cc, c.k);
      }
      return r;
    };
    const baseR = (i) => {
      const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
      return cutR(dx, dy, dz, Rb[i] * (1 + lowAmp * lowNoise(dx, dy, dz) + facetAmp * facetNoise(dx, dy, dz)));
    };
    const R0 = new Float64Array(Vmax);
    for (let i = 0; i < Vmax; i++) R0[i] = baseR(i);
    // Cosine between the radial direction and the base surface's normal, per vertex (finest level; coarser levels
    // are a prefix of the same vertices). All relief is displaced RADIALLY; where the surface is steep relative to
    // the radial direction (the flanks of elongated bodies, cut faces, lobes of contact binaries) a radial
    // displacement is mostly tangential and shears craters and noise into thin overlapping "paper flaps". The
    // detail displacement is attenuated there (it stays normal-sized where cos >= 0.65).
    const cosT = new Float32Array(Vmax);
    {
      const F = H.levels[L].faces;
      const N0 = new Float64Array(Vmax * 3);
      const P0 = (i, c) => dirs[i * 3 + c] * R0[i];
      for (let f = 0; f < F.length; f += 3) {
        const a = F[f], b = F[f + 1], c = F[f + 2];
        const ux = P0(b, 0) - P0(a, 0), uy = P0(b, 1) - P0(a, 1), uz = P0(b, 2) - P0(a, 2);
        const vx = P0(c, 0) - P0(a, 0), vy = P0(c, 1) - P0(a, 1), vz = P0(c, 2) - P0(a, 2);
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a, b, c]) {
          N0[v * 3] += nx;
          N0[v * 3 + 1] += ny;
          N0[v * 3 + 2] += nz;
        }
      }
      for (let i = 0; i < Vmax; i++) {
        const nl = Math.hypot(N0[i * 3], N0[i * 3 + 1], N0[i * 3 + 2]) || 1;
        cosT[i] = Math.max(0, (N0[i * 3] * dirs[i * 3] + N0[i * 3 + 1] * dirs[i * 3 + 1] + N0[i * 3 + 2] * dirs[i * 3 + 2]) / nl);
      }
    }

    // ---- features
    const craters = [];
    const addCrater = (dir, r, depth, rim, floorF, fresh) => {
      // centre on the base surface: approximate with the nearest base radius along dir (closed form or root)
      let rb;
      if (B.Rb) rb = B.Rb(dir[0], dir[1], dir[2]);
      else rb = rootRadius(B.G, dir[0], dir[1], dir[2], 0, B.rMax);
      rb *= 1 + lowAmp * lowNoise(dir[0], dir[1], dir[2]) + facetAmp * facetNoise(dir[0], dir[1], dir[2]);
      rb = cutR(dir[0], dir[1], dir[2], rb);
      // irregular rim: azimuthal modulation from two random directions (cheap, smooth)
      const v1 = randDir(rng), v2 = randDir(rng);
      craters.push({ x: dir[0] * rb, y: dir[1] * rb, z: dir[2] * rb, r, depth, rim, floorF, fresh, v1, v2, k1: 2 + Math.floor(rng() * 3), k2: 4 + Math.floor(rng() * 4), ph1: rng() * 6.28, ph2: rng() * 6.28, irr: 0.05 + 0.07 * rng() });
    };
    const nCr = desc.craters ?? 220;
    for (let i = 0; i < nCr; i++) {
      const r = powerLaw(rng, desc.craterMin ?? 0.035, desc.craterMax ?? 0.36, 2.0);
      const fresh = Math.pow(rng(), 1.6); // most craters are degraded; a few are fresh and crisp
      const depth = (0.15 + 0.28 * fresh) * (r > 0.25 ? 0.8 : 1); // depth / radius (d/D 0.075..0.21)
      const rim = (0.025 + 0.085 * fresh) * (0.7 + 0.6 * rng());
      const floorF = r > 0.18 ? 0.35 + 0.3 * rng() : rng() * 0.25;
      addCrater(randDir(rng), r, depth, rim, floorF, fresh);
    }
    // impact "bites": a few big, deep, sharp-rimmed concavities that notch the silhouette (Ida, Mathilde, Gaspra)
    for (let i = 0; i < (desc.bites ?? 0); i++) addCrater(randDir(rng), jr(0.28, 0.52), jr(0.32, 0.46), jr(0.015, 0.05), jr(0.15, 0.4), jr(0.35, 0.9));
    for (const gc of desc.giantCraters || []) addCrater(gc.dir || randDir(rng), gc.r, gc.depth, gc.rim ?? 0.05, gc.floor ?? 0.4, gc.fresh ?? 0.5);
    if (B.saddle && desc.saddle !== false) addCrater(B.saddle, 0.42, 0.22, 0.015, 0.5, 0.1); // Himeros-like saddle

    const boulders = [];
    const nB = desc.boulders ?? 0;
    for (let i = 0; i < nB; i++) {
      const d = randDir(rng);
      let rb;
      if (B.Rb) rb = B.Rb(d[0], d[1], d[2]);
      else rb = rootRadius(B.G, d[0], d[1], d[2], 0, B.rMax);
      rb *= 1 + lowAmp * lowNoise(d[0], d[1], d[2]) + facetAmp * facetNoise(d[0], d[1], d[2]);
      rb = cutR(d[0], d[1], d[2], rb);
      const r = powerLaw(rng, desc.boulderMin ?? 0.025, desc.boulderMax ?? 0.11, 2.6);
      // footprint: 7..9 irregular fracture planes roughly perpendicular to the surface; a tilted, broken roof;
      // rounded shoulders; partly buried (30-60%) with a regolith skirt, so blocks are not CG prisms
      const nx = d[0], ny = d[1], nz = d[2];
      const t1 = norm3(cross3([nx, ny, nz], [0.37, 0.82, 0.44])), t2 = cross3([nx, ny, nz], t1);
      const rot = rng() * 6.283;
      const np = 7 + Math.floor(rng() * 3);
      const planes = [];
      for (let k = 0; k < np; k++) {
        const th = rot + (k + (rng() - 0.5) * 0.7) * ((2 * Math.PI) / np);
        const c = Math.cos(th), sn = Math.sin(th), tilt = (rng() - 0.5) * 0.6;
        const m = norm3([t1[0] * c + t2[0] * sn + nx * tilt, t1[1] * c + t2[1] * sn + ny * tilt, t1[2] * c + t2[2] * sn + nz * tilt]);
        planes.push([m[0], m[1], m[2], r * (0.6 + 0.55 * rng())]);
      }
      const ra = rng() * 6.283, rf = 0.15 + 0.4 * rng();
      const roof = [t1[0] * Math.cos(ra) + t2[0] * Math.sin(ra), t1[1] * Math.cos(ra) + t2[1] * Math.sin(ra), t1[2] * Math.cos(ra) + t2[2] * Math.sin(ra)];
      boulders.push({ x: d[0] * rb, y: d[1] * rb, z: d[2] * rb, r, h: 0.35 + 0.5 * rng(), bu: 0.3 + 0.3 * rng(), ex: 0.45 + 0.35 * rng(), planes, roof, rf });
    }
    // broad positive bumps (e.g. the central peak of a giant impact basin)
    const bumps = [];
    if (desc.peak) {
      const d = desc.peak.dir;
      const n = Math.hypot(d[0], d[1], d[2]);
      const dd = [d[0] / n, d[1] / n, d[2] / n];
      let rb = B.Rb ? B.Rb(dd[0], dd[1], dd[2]) : rootRadius(B.G, dd[0], dd[1], dd[2], 0, B.rMax);
      bumps.push({ x: dd[0] * rb, y: dd[1] * rb, z: dd[2] * rb, r: desc.peak.r, h: desc.peak.h });
    }
    const grooves = [];
    for (let i = 0; i < (desc.grooves ?? 0); i++) {
      const n = randDir(rng);
      grooves.push({ n, d: (rng() - 0.5) * 0.5, w: 0.012 + 0.012 * rng(), depth: 0.006 + 0.008 * rng(), ph: rng() * 6.28, f: 30 + 30 * rng() });
    }
    if (desc.troughs) {
      // Vesta's Divalia Fossae: troughs concentric to the big basin's axis
      const ax = desc.troughs.axis;
      for (let i = 0; i < desc.troughs.n; i++)
        grooves.push({ n: ax, d: desc.troughs.d0 + i * desc.troughs.step, w: 0.02 + 0.01 * rng(), depth: 0.012 + 0.01 * rng(), ph: rng() * 6.28, f: 4 });
    }

    // spatial bins for small craters (big ones checked directly)
    const BIG = 0.16, CELL = 0.36;
    const bigC = craters.filter((c) => c.r > BIG);
    const bins = new Map();
    const binKey = (x, y, z) => ((x + 512) * 1024 + (y + 512)) * 1024 + (z + 512);
    for (const c of craters) {
      if (c.r > BIG) continue;
      const reach = c.r * 2.2;
      const x0 = Math.floor((c.x - reach) / CELL), x1 = Math.floor((c.x + reach) / CELL);
      const y0 = Math.floor((c.y - reach) / CELL), y1 = Math.floor((c.y + reach) / CELL);
      const z0 = Math.floor((c.z - reach) / CELL), z1 = Math.floor((c.z + reach) / CELL);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const k = binKey(x, y, z);
            let a = bins.get(k);
            if (!a) bins.set(k, (a = []));
            a.push(c);
          }
    }
    const bBins = new Map();
    for (const b of boulders) {
      const reach = b.r * 1.65;
      const x0 = Math.floor((b.x - reach) / CELL), x1 = Math.floor((b.x + reach) / CELL);
      const y0 = Math.floor((b.y - reach) / CELL), y1 = Math.floor((b.y + reach) / CELL);
      const z0 = Math.floor((b.z - reach) / CELL), z1 = Math.floor((b.z + reach) / CELL);
      for (let x = x0; x <= x1; x++)
        for (let y = y0; y <= y1; y++)
          for (let z = z0; z <= z1; z++) {
            const k = binKey(x, y, z);
            let a = bBins.get(k);
            if (!a) bBins.set(k, (a = []));
            a.push(b);
          }
    }

    // crater profile: bowl -depth*(1-x^2)^p (p from 1 = fresh/sharp to 2 = degraded/soft) + Gaussian rim ridge,
    // flat regolith-filled floors on big craters, and an irregular (non-circular) rim
    const craterH = (c, d, px, py, pz) => {
      let x = d / c.r;
      if (x >= 1.6) return 0;
      if (d > 1e-9) {
        const qx = (px - c.x) / d, qy = (py - c.y) / d, qz = (pz - c.z) / d;
        const a1 = qx * c.v1[0] + qy * c.v1[1] + qz * c.v1[2], a2 = qx * c.v2[0] + qy * c.v2[1] + qz * c.v2[2];
        // irregular rim only: modulating the radius inside the bowl would draw radial spokes
        x *= 1 + c.irr * sstep(0.55, 1.0, x) * (Math.sin(c.k1 * a1 * 3.14 + c.ph1) * 0.6 + Math.sin(c.k2 * a2 * 3.14 + c.ph2) * 0.4);
      }
      // simple-crater morphology (units of r): paraboloid bowl from -depth to the rim crest at x = 1, outer flank
      // (ejecta blanket) thinning as x^-3; the crest is knife-sharp when fresh and rounds off with age
      const age = 1 - c.fresh;
      const D0 = c.depth, R0 = c.rim;
      const hin = -D0 + (D0 + R0) * x * x;
      const xo = Math.max(x, 0.5);
      const hout = R0 / (xo * xo * xo);
      const k = (0.012 + 0.16 * age) * (D0 + R0);
      const hm = Math.min(1, Math.max(0, 0.5 + (0.5 * (hout - hin)) / k));
      let h = hout + (hin - hout) * hm - k * hm * (1 - hm);
      // regolith-filled flat floor on big craters
      const fl = -D0 + (D0 + R0) * c.floorF * c.floorF;
      if (h < fl) h = fl + (h - fl) * 0.08;
      return h * (1 - sstep(1.2, 1.6, x)) * c.r;
    };
    const pondAt = (px, py, pz) => {
      if (!desc.ponds) return 0;
      let w = 0;
      if (B.neckX !== undefined) w = Math.max(w, 1 - sstep(0.12, 0.3, Math.abs(px - B.neckX)));
      const n = noise2(px * 1.7 + 4.1, py * 1.7, pz * 1.7 - 2.3);
      w = Math.max(w, sstep(0.25, 0.55, n) * 0.9);
      return w * desc.ponds;
    };

    // band-limited displacement at base point P0 (dir * R0), for a level with vertex spacing sp
    const detailAmp = desc.detailAmp ?? 0.03;
    const disp = (px, py, pz, sp, out) => {
      const pond = pondAt(px, py, pz);
      let h = 0;
      // multi-octave ridged + fbm surface roughness
      let a = detailAmp, f = 2.2;
      for (let o = 0; o < 7; o++) {
        const lambda = 1 / f;
        const w = sstep(2.0 * sp, 4.0 * sp, lambda);
        if (w <= 0) break;
        const n = noise(px * f + o * 7.7, py * f - o * 3.1, pz * f + o * 5.3);
        const ridge = (1 - Math.abs(n)) * 2 - 1.0;
        // low octaves are muted (they made soft "dough" lumps); higher ones are ridged fracture texture
        const oa = o < 2 ? 0.45 : o < 4 ? 0.7 : 1.0;
        h += w * a * oa * (o < 2 ? n : 0.3 * n + 0.7 * ridge) * (1 - 0.8 * pond * sstep(0, 2, o));
        a *= 0.5;
        f *= 2.03;
      }
      // craters
      const cw = (r) => sstep(1.1 * sp, 2.4 * sp, r);
      let fresh = 0;
      for (const c of bigC) {
        const d = Math.hypot(px - c.x, py - c.y, pz - c.z);
        h += craterH(c, d, px, py, pz);
        if (d < 1.7 * c.r) fresh = Math.max(fresh, c.fresh * c.fresh * (1 - sstep(0.7, 1.7, d / c.r)));
      }
      const bk = binKey(Math.floor(px / CELL), Math.floor(py / CELL), Math.floor(pz / CELL));
      const list = bins.get(bk);
      if (list)
        for (const c of list) {
          const w = cw(c.r);
          if (w <= 0) continue;
          const d = Math.hypot(px - c.x, py - c.y, pz - c.z);
          h += w * craterH(c, d, px, py, pz) * (1 - 0.6 * pond);
          if (d < 1.7 * c.r) fresh = Math.max(fresh, w * c.fresh * c.fresh * (1 - sstep(0.6, 1.7, d / c.r)));
        }
      // boulders sit on top of the surface
      const bl = bBins.get(bk);
      if (bl) {
        let bh = 0;
        for (const b of bl) {
          const w = sstep(1.0 * sp, 2.2 * sp, b.r);
          if (w <= 0) continue;
          const qx = px - b.x, qy = py - b.y, qz = pz - b.z;
          if (qx * qx + qy * qy + qz * qz > b.r * b.r * 2.6) continue;
          let P = 0;
          for (const m of b.planes) P = Math.max(P, (qx * m[0] + qy * m[1] + qz * m[2]) / m[3]);
          if (P >= 1.6) continue;
          const rr = (qx * b.roof[0] + qy * b.roof[1] + qz * b.roof[2]) / b.r;
          // rounded, tilted dome over the polygonal footprint, buried to b.bu
          const dome = Math.pow(Math.max(0, 1 - P * P), b.ex) * (1 + (b.rf - 0.35) * rr);
          const H = b.r * b.h;
          const hv = (H * (dome - b.bu)) / (1 - b.bu);
          const Pb = Math.sqrt(Math.max(0, 1 - Math.pow(b.bu, 1 / b.ex)));
          const skirt = 0.14 * H * Math.exp(-(((P - Pb) / 0.32) ** 2));
          bh = Math.max(bh, w * Math.max(hv, skirt));
        }
        h += bh * (1 - pond);
      }
      for (const b of bumps) {
        const d2 = ((px - b.x) ** 2 + (py - b.y) ** 2 + (pz - b.z) ** 2) / (b.r * b.r);
        if (d2 < 9) h += b.h * Math.exp(-d2) * (0.85 + 0.15 * noise(px * 9, py * 9, pz * 9));
      }
      // grooves / troughs / pit chains
      for (const g of grooves) {
        const nn = Math.hypot(g.n[0], g.n[1], g.n[2]);
        const s = (px * g.n[0] + py * g.n[1] + pz * g.n[2]) / nn - g.d;
        const w = sstep(1.0 * sp, 2.0 * sp, g.w);
        if (w <= 0) continue;
        const x = s / g.w;
        if (Math.abs(x) > 3) continue;
        const along = 0.65 + 0.35 * Math.sin(g.ph + g.f * (px * 0.7 - py * 0.5 + pz * 0.3));
        h -= w * g.depth * Math.exp(-x * x) * along;
      }
      out.pond = pond;
      out.fresh = fresh;
      return h;
    };

    // ---- per-level band-limited radii
    const levelR = [];
    const tmp = { pond: 0, fresh: 0 };
    const pondArr = new Float32Array(Vmax);
    const freshArr = new Float32Array(Vmax);
    for (let l = 0; l <= L; l++) {
      const V = H.levels[l].V;
      const sp = (1.1 / Math.pow(2, l)) * 0.95; // vertex spacing (body radii)
      const R = new Float64Array(V);
      for (let i = 0; i < V; i++) {
        const dx = dirs[i * 3], dy = dirs[i * 3 + 1], dz = dirs[i * 3 + 2];
        const r0 = R0[i];
        const att = 0.25 + 0.75 * sstep(0.3, 0.65, cosT[i]);
        R[i] = Math.max(0.05, r0 + att * disp(dx * r0, dy * r0, dz * r0, sp, tmp));
        if (l === L) {
          pondArr[i] = tmp.pond;
          freshArr[i] = tmp.fresh;
        }
      }
      levelR.push(R);
    }

    // ---- normalise: mean radius over the finest level = 1
    const RL = levelR[L];
    let mean = 0;
    for (let i = 0; i < Vmax; i++) mean += RL[i];
    mean /= Vmax;
    for (const R of levelR) for (let i = 0; i < R.length; i++) R[i] /= mean;

    // ---- positions and normals per level
    const posL = [], norL = [];
    for (let l = 0; l <= L; l++) {
      const V = H.levels[l].V, R = levelR[l], F = H.levels[l].faces;
      const P = new Float32Array(V * 3), N = new Float32Array(V * 3);
      for (let i = 0; i < V; i++) {
        P[i * 3] = dirs[i * 3] * R[i];
        P[i * 3 + 1] = dirs[i * 3 + 1] * R[i];
        P[i * 3 + 2] = dirs[i * 3 + 2] * R[i];
      }
      for (let f = 0; f < F.length; f += 3) {
        const a = F[f] * 3, b = F[f + 1] * 3, c = F[f + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        N[a] += nx; N[a + 1] += ny; N[a + 2] += nz;
        N[b] += nx; N[b + 1] += ny; N[b + 2] += nz;
        N[c] += nx; N[c + 1] += ny; N[c + 2] += nz;
      }
      for (let i = 0; i < V; i++) {
        const n = Math.hypot(N[i * 3], N[i * 3 + 1], N[i * 3 + 2]) || 1;
        N[i * 3] /= n;
        N[i * 3 + 1] /= n;
        N[i * 3 + 2] /= n;
      }
      posL.push(P);
      norL.push(N);
    }

    // ---- radius map (octahedral) by exact ray/triangle descent through the finest mesh
    const S = desc.mapSize ?? 128;
    const SB = S;
    const radiusMapB = buildRadiusMap(H, L, posL[L], SB);
    const radiusMap = radiusMapB;

    // ---- ambient occlusion + cavity at an AO level (finest-1), propagated to the finest by parent averaging
    const aoLevel = Math.min(4, Math.max(0, L - 1));
    const Vao = H.levels[aoLevel].V;
    const AO = new Float32Array(Vmax), CAV = new Float32Array(Vmax);
    const RAYS = fibonacciSphere(28);
    {
      const P = posL[aoLevel], N = norL[aoLevel];
      for (let i = 0; i < Vao; i++) {
        const px = P[i * 3], py = P[i * 3 + 1], pz = P[i * 3 + 2];
        const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
        let occ = 0, wsum = 0;
        for (let r = 0; r < RAYS.length; r += 3) {
          const dx = RAYS[r], dy = RAYS[r + 1], dz = RAYS[r + 2];
          const c = dx * nx + dy * ny + dz * nz;
          if (c <= 0.05) continue;
          let t = 0.025, hit = 0;
          for (let s = 0; s < 11; s++) {
            const qx = px + dx * t, qy = py + dy * t, qz = pz + dz * t;
            const ql = Math.hypot(qx, qy, qz);
            const rr = sampleMap(radiusMapB, SB, qx / ql, qy / ql, qz / ql);
            if (ql < rr - 0.006 - 0.01 * t) {
              hit = 1;
              break;
            }
            t *= 1.55;
            if (t > 2.6) break;
          }
          occ += hit * c;
          wsum += c;
        }
        AO[i] = 1 - occ / Math.max(wsum, 1e-6);
      }
    }
    // cavity: signed height of the vertex relative to its neighbourhood (multi-scale), from the finest mesh
    {
      const P = posL[L], N = norL[L];
      // average of neighbours at the finest level (1-ring via faces)
      const F = H.levels[L].faces;
      const acc = new Float64Array(Vmax * 4);
      for (let f = 0; f < F.length; f += 3) {
        for (let e = 0; e < 3; e++) {
          const a = F[f + e], b = F[f + ((e + 1) % 3)];
          acc[a * 4] += P[b * 3]; acc[a * 4 + 1] += P[b * 3 + 1]; acc[a * 4 + 2] += P[b * 3 + 2]; acc[a * 4 + 3]++;
          acc[b * 4] += P[a * 3]; acc[b * 4 + 1] += P[a * 3 + 1]; acc[b * 4 + 2] += P[a * 3 + 2]; acc[b * 4 + 3]++;
        }
      }
      const sp = 1.1 / Math.pow(2, L);
      for (let i = 0; i < Vmax; i++) {
        const k = acc[i * 4 + 3] || 1;
        const mx = acc[i * 4] / k - P[i * 3], my = acc[i * 4 + 1] / k - P[i * 3 + 1], mz = acc[i * 4 + 2] / k - P[i * 3 + 2];
        // positive when neighbours lie above the tangent plane => concave
        CAV[i] = (mx * N[i * 3] + my * N[i * 3 + 1] + mz * N[i * 3 + 2]) / (sp * sp) * 0.02;
      }
    }
    for (let i = Vao; i < Vmax; i++) {
      const a = parents[i * 2], b = parents[i * 2 + 1];
      AO[i] = 0.5 * (AO[a] + AO[b]);
    }
    // fine-scale concavity darkens AO a little more (crevices narrower than the AO level resolves)
    for (let i = 0; i < Vmax; i++) AO[i] = Math.max(0, AO[i] * (1 - 0.35 * Math.max(0, Math.min(1, CAV[i] * 2.5 + 0.02))));
    // combine AO with a soft multi-scale cavity term (crevices between boulders, crater floors)
    for (let i = 0; i < Vmax; i++) {
      const cav = Math.max(-1, Math.min(1, CAV[i]));
      CAV[i] = cav;
    }

    // ---- assemble GPU attribute arrays per level
    const levelsData = [];
    for (let l = 0; l <= L; l++) {
      const V = H.levels[l].V;
      const P = posL[l], N = norL[l];
      const PC = new Float32Array(V * 3), NC = new Float32Array(V * 3);
      const A = new Float32Array(V * 4), AC = new Float32Array(V * 4);
      const Pp = l > 0 ? posL[l - 1] : P, Np = l > 0 ? norL[l - 1] : N, Vp = l > 0 ? H.levels[l - 1].V : V;
      for (let i = 0; i < V; i++) {
        A[i * 4] = AO[i];
        A[i * 4 + 1] = CAV[i];
        A[i * 4 + 2] = pondArr[i];
        A[i * 4 + 3] = freshArr[i];
        if (i < Vp) {
          PC[i * 3] = Pp[i * 3]; PC[i * 3 + 1] = Pp[i * 3 + 1]; PC[i * 3 + 2] = Pp[i * 3 + 2];
          NC[i * 3] = Np[i * 3]; NC[i * 3 + 1] = Np[i * 3 + 1]; NC[i * 3 + 2] = Np[i * 3 + 2];
          AC[i * 4] = AO[i]; AC[i * 4 + 1] = CAV[i]; AC[i * 4 + 2] = pondArr[i]; AC[i * 4 + 3] = freshArr[i];
        } else {
          const a = parents[i * 2], b = parents[i * 2 + 1];
          for (let c = 0; c < 3; c++) {
            PC[i * 3 + c] = 0.5 * (Pp[a * 3 + c] + Pp[b * 3 + c]);
            NC[i * 3 + c] = 0.5 * (Np[a * 3 + c] + Np[b * 3 + c]);
          }
          AC[i * 4] = 0.5 * (AO[a] + AO[b]);
          AC[i * 4 + 1] = 0.5 * (CAV[a] + CAV[b]);
          AC[i * 4 + 2] = 0.5 * (pondArr[a] + pondArr[b]);
          AC[i * 4 + 3] = 0.5 * (freshArr[a] + freshArr[b]);
        }
      }
      const F = H.levels[l].faces;
      const index = V > 65535 ? new Uint32Array(F) : new Uint16Array(F);
      levelsData.push({ pos: P, nor: N, posC: PC, norC: NC, ao: A, aoC: AC, index, V });
    }

    // ---- bounding radius and principal extents (for lightcurves of unresolved rocks)
    let boundR = 0, sx = 0, sy = 0, sz = 0;
    const PF = posL[L];
    for (let i = 0; i < Vmax; i++) {
      const x = PF[i * 3], y = PF[i * 3 + 1], z = PF[i * 3 + 2];
      boundR = Math.max(boundR, Math.hypot(x, y, z));
      sx += x * x;
      sy += y * y;
      sz += z * z;
    }
    const axes = [Math.sqrt((3 * sx) / Vmax), Math.sqrt((3 * sy) / Vmax), Math.sqrt((3 * sz) / Vmax)];
    return { kind: desc.kind, level: L, levelsData, boundR: boundR * 1.01, axes, radiusMap, S };
  }

  function fibonacciSphere(n) {
    const out = new Float64Array(n * 3);
    const ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(1 - y * y), th = ga * i;
      out[i * 3] = r * Math.cos(th);
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = r * Math.sin(th);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------ octahedral radius map
  function octDecode(u, v) {
    // u, v in [0,1] -> unit vector
    let x = u * 2 - 1, y = v * 2 - 1;
    const z = 1 - Math.abs(x) - Math.abs(y);
    if (z < 0) {
      const ox = x;
      x = (1 - Math.abs(y)) * Math.sign(ox || 1);
      y = (1 - Math.abs(ox)) * Math.sign(y || 1);
    }
    const n = Math.hypot(x, y, z);
    return [x / n, y / n, z / n];
  }
  function octEncode(x, y, z) {
    const s = Math.abs(x) + Math.abs(y) + Math.abs(z);
    let u = x / s, v = y / s;
    if (z < 0) {
      const ou = u;
      u = (1 - Math.abs(v)) * Math.sign(ou || 1);
      v = (1 - Math.abs(ou)) * Math.sign(v || 1);
    }
    return [u * 0.5 + 0.5, v * 0.5 + 0.5];
  }
  function sampleMap(map, S, x, y, z) {
    const [u, v] = octEncode(x, y, z);
    const fx = Math.min(S - 1.0001, Math.max(0, u * S - 0.5)), fy = Math.min(S - 1.0001, Math.max(0, v * S - 0.5));
    const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy;
    const a = map[iy * S + ix], b = map[iy * S + ix + 1], c = map[(iy + 1) * S + ix], d = map[(iy + 1) * S + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  function buildRadiusMap(H, L, P, S) {
    const map = new Float32Array(S * S);
    const dirs = H.dirs;
    const inTri = (a, b, c, x, y, z) => {
      // spherical triangle test on unit directions (edges are great circles)
      const e = (p, q) => {
        const px = dirs[p * 3], py = dirs[p * 3 + 1], pz = dirs[p * 3 + 2];
        const qx = dirs[q * 3], qy = dirs[q * 3 + 1], qz = dirs[q * 3 + 2];
        return (py * qz - pz * qy) * x + (pz * qx - px * qz) * y + (px * qy - py * qx) * z;
      };
      return e(a, b) >= -1e-12 && e(b, c) >= -1e-12 && e(c, a) >= -1e-12;
    };
    const FL = H.levels[L].faces;
    let last = -1;
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const [x, y, z] = octDecode((i + 0.5) / S, (j + 0.5) / S);
        let f = -1;
        if (last >= 0 && inTri(FL[last * 3], FL[last * 3 + 1], FL[last * 3 + 2], x, y, z)) f = last;
        else {
          const F0 = H.levels[0].faces;
          for (let k = 0; k < 20; k++)
            if (inTri(F0[k * 3], F0[k * 3 + 1], F0[k * 3 + 2], x, y, z)) {
              f = k;
              break;
            }
          if (f < 0) f = 0;
          for (let l = 1; l <= L; l++) {
            const F = H.levels[l].faces;
            let found = 4 * f + 3;
            for (let c = 0; c < 3; c++) {
              const g = 4 * f + c;
              if (inTri(F[g * 3], F[g * 3 + 1], F[g * 3 + 2], x, y, z)) {
                found = g;
                break;
              }
            }
            f = found; // the 4th (centre) child is the fallback
          }
        }
        last = f;
        const a = FL[f * 3] * 3, b = FL[f * 3 + 1] * 3, c = FL[f * 3 + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const den = nx * x + ny * y + nz * z;
        const t = Math.abs(den) > 1e-12 ? (nx * P[a] + ny * P[a + 1] + nz * P[a + 2]) / den : Math.hypot(P[a], P[a + 1], P[a + 2]);
        map[j * S + i] = t;
      }
    return map;
  }
  function downsampleMap(m, S2) {
    const S = S2 / 2, out = new Float32Array(S * S);
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        out[j * S + i] = 0.25 * (m[2 * j * S2 + 2 * i] + m[2 * j * S2 + 2 * i + 1] + m[(2 * j + 1) * S2 + 2 * i] + m[(2 * j + 1) * S2 + 2 * i + 1]);
      }
    return out;
  }

  return { generateShape, octEncode, octDecode };
}

const LIB = shapeLibrary();
export const generateShape = LIB.generateShape;
export const octEncode = LIB.octEncode;
export const octDecode = LIB.octDecode;

function transferables(r) {
  const t = [r.radiusMap.buffer];
  for (const L of r.levelsData) t.push(L.pos.buffer, L.nor.buffer, L.posC.buffer, L.norC.buffer, L.ao.buffer, L.aoC.buffer, L.index.buffer);
  return t;
}

/**
 * Generate many shapes on a small pool of Web Workers (results are identical to generateShape on the main
 * thread: pure, seeded functions). Falls back to the main thread if workers are unavailable.
 * descs: array of shape descriptors; returns Promise<array of shapes> in the same order.
 */
export async function generateShapesParallel(descs, onEach) {
  let url = null;
  try {
    const src = `const LIB = (${shapeLibrary.toString()})();
` +
      `onmessage = (e) => { const { id, desc } = e.data; const r = LIB.generateShape(desc);
` +
      `  const t = [r.radiusMap.buffer]; for (const L of r.levelsData) t.push(L.pos.buffer, L.nor.buffer, L.posC.buffer, L.norC.buffer, L.ao.buffer, L.aoC.buffer, L.index.buffer);
` +
      `  postMessage({ id, r }, t); };`;
    url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const n = Math.max(1, Math.min(6, (globalThis.navigator?.hardwareConcurrency || 4) - 1, descs.length));
    const workers = Array.from({ length: n }, () => new Worker(url));
    const out = new Array(descs.length);
    // longest jobs first (heroes at level 6)
    const order = descs.map((d, i) => i).sort((a, b) => (descs[b].level || 5) - (descs[a].level || 5));
    let next = 0;
    await new Promise((resolve, reject) => {
      let done = 0;
      const feed = (w) => {
        if (next >= order.length) return;
        const id = order[next++];
        w.postMessage({ id, desc: descs[id] });
      };
      for (const w of workers) {
        w.onmessage = (e) => {
          out[e.data.id] = e.data.r;
          onEach?.(e.data.id);
          if (++done === descs.length) resolve();
          else feed(w);
        };
        w.onerror = (e) => reject(e);
        feed(w);
      }
    });
    for (const w of workers) w.terminate();
    URL.revokeObjectURL(url);
    return out;
  } catch (e) {
    if (url) URL.revokeObjectURL(url);
    const out = [];
    for (const d of descs) {
      out.push(LIB.generateShape(d));
      onEach?.(out.length - 1);
      await new Promise((r) => setTimeout(r, 0));
    }
    return out;
  }
}
