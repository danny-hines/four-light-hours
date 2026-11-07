// Phobos and Deimos: procedural irregular bodies (triaxial shape + lumps + real named craters + a
// deterministic power-law crater population baked into an indexed icosphere), shaded with dark-regolith
// photometry (Lommel-Seeliger x Hapke-style opposition surge and phase function), per-pixel craters, Phobos' grooves and Stickney's
// bright landslide streaks, Mars' shadow (eclipses happen almost every orbit near equinox) and Mars-shine.
import { MARS_COMMON } from './glsl.js';
import { noiseTexture3D } from './noise3d.js';

const DEG = Math.PI / 180;

// ------------------------------------------------------------------ deterministic CPU noise
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash3(ix, iy, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(iz, 2147483647) ^ Math.imul(seed, 144665);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const h = (a, b, c) => hash3(ix + a, iy + b, iz + c, seed) * 2 - 1;
  const l = (a, b, t) => a + (b - a) * t;
  return l(
    l(l(h(0, 0, 0), h(1, 0, 0), sx), l(h(0, 1, 0), h(1, 1, 0), sx), sy),
    l(l(h(0, 0, 1), h(1, 0, 1), sx), l(h(0, 1, 1), h(1, 1, 1), sx), sy),
    sz
  );
}
function fbm3(x, y, z, oct, seed) {
  let s = 0, a = 1, n = 0, f = 1;
  for (let i = 0; i < oct; i++) {
    s += a * vnoise3(x * f, y * f, z * f, seed + i * 31);
    n += a;
    a *= 0.5;
    f *= 2.07;
  }
  return s / n;
}

// ------------------------------------------------------------------ indexed icosphere
function icosphere(level) {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [];
  const add = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    v.push(x / l, y / l, z / l);
    return v.length / 3 - 1;
  };
  [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].forEach((p) => add(...p));
  let f = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  for (let l = 0; l < level; l++) {
    const cache = new Map();
    const mid = (a, b) => {
      const key = a < b ? a * 1e7 + b : b * 1e7 + a;
      let m = cache.get(key);
      if (m === undefined) {
        m = add(v[3 * a] + v[3 * b], v[3 * a + 1] + v[3 * b + 1], v[3 * a + 2] + v[3 * b + 2]);
        cache.set(key, m);
      }
      return m;
    };
    const nf = new Array(f.length * 4);
    let k = 0;
    for (let i = 0; i < f.length; i += 3) {
      const a = f[i], b = f[i + 1], c = f[i + 2];
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      nf[k++] = a; nf[k++] = ab; nf[k++] = ca;
      nf[k++] = b; nf[k++] = bc; nf[k++] = ab;
      nf[k++] = c; nf[k++] = ca; nf[k++] = bc;
      nf[k++] = ab; nf[k++] = bc; nf[k++] = ca;
    }
    f = nf;
  }
  return { positions: new Float32Array(v), index: f.length > 65535 * 3 ? new Uint32Array(f) : new Uint32Array(f) };
}

// body-local direction from planetographic lat / east longitude (deg): +x lon 0 (sub-Mars), +y north, -z 90 E
function dirLatLon(lat, lonE) {
  const la = lat * DEG, lo = lonE * DEG;
  return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)];
}

function craterProfile(x, depth, rim, fresh, soft) {
  if (soft) {
    // large, old impact basin on a small body (Stickney): a smooth bowl with a rounded, low rim crest that
    // blends into the curved surface (no lip standing out of the silhouette)
    // (HiRISE: a well-defined crest, steep upper walls; the low rim still never stands out of the silhouette)
    if (x < 1) return -depth + (depth + rim) * x * x * (1.25 - 0.25 * x * x);
    return rim * Math.pow(x, -6) * (1 - smooth(1.5, 2.0, x));
  }
  if (x < 1) {
    const fl = 0.55 * (1 - fresh);
    const xx = Math.max(x - fl, 0) / (1 - fl);
    return -depth + (depth + rim) * xx * xx;
  }
  const w = 1 - smooth(1.85, 2.4, x);
  return rim * Math.exp(-(x - 1) * 3.0) * w;
}
function smooth(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// spec: { axes:[ax, ay, az] semi-axes km along x (to Mars), y (pole), z (leading), lump, named:[{lat, lon, r, d, rim, fresh}], nRandom, seed, level }
function buildShape(THREE, spec) {
  const { positions, index } = icosphere(spec.level);
  const n = positions.length / 3;
  const [ax, ay, az] = spec.axes;
  const rnd = mulberry32(spec.seed);
  const craters = spec.named.map((c) => ({ dir: dirLatLon(c.lat, c.lon), ...c }));
  const rMean = Math.cbrt(ax * ay * az);
  for (let i = 0; i < spec.nRandom; i++) {
    const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, s = Math.sqrt(1 - z * z);
    const u = rnd();
    const r = spec.rMin * Math.pow(spec.rMax / spec.rMin, Math.pow(u, 1.8)); // power-law-ish: many small
    const fresh = Math.pow(rnd(), spec.freshPow);
    const ds = spec.dScale || 1;
    craters.push({ dir: [s * Math.cos(ph), z, s * Math.sin(ph)], r, d: 2 * r * (0.07 + 0.13 * fresh) * ds, rim: 2 * r * (0.01 + 0.03 * fresh) * ds, fresh });
  }
  // crater angular radii from the true (km) radius on the local surface: r_local = triaxial radius toward the
  // crater (Stickney: 4.5 km on a ~12 km local radius -> 9 km rim to rim)
  for (const c of craters) {
    const l = Math.hypot(...c.dir);
    c.dir = c.dir.map((x) => x / l);
    const rLoc = 1 / Math.sqrt((c.dir[0] / ax) ** 2 + (c.dir[1] / ay) ** 2 + (c.dir[2] / az) ** 2);
    c.ang = Math.min(1.3, c.r / rLoc);
    c.rLoc = rLoc;
    const a = Math.abs(c.dir[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const e1 = [a[1] * c.dir[2] - a[2] * c.dir[1], a[2] * c.dir[0] - a[0] * c.dir[2], a[0] * c.dir[1] - a[1] * c.dir[0]];
    const l1 = Math.hypot(...e1);
    c.e1 = e1.map((v) => v / l1);
    c.e2 = [c.dir[1] * c.e1[2] - c.dir[2] * c.e1[1], c.dir[2] * c.e1[0] - c.dir[0] * c.e1[2], c.dir[0] * c.e1[1] - c.dir[1] * c.e1[0]];
    c.ph = [rnd() * 6.283, rnd() * 6.283, rnd() * 6.283];
    c.cos = Math.cos(Math.min(Math.PI, c.ang * (c.smooth ? 2.2 : c.soft ? 2.05 : 2.4)));
  }
  // planar cuts (spall facets): the ellipsoid intersected with a few half-spaces, edges rounded by a soft-min
  const cuts = [];
  for (let i = 0; i < (spec.cuts || 0); i++) {
    const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, s = Math.sqrt(1 - z * z);
    const nrm = [s * Math.cos(ph), z, s * Math.sin(ph)];
    const re = 1 / Math.sqrt((nrm[0] / ax) ** 2 + (nrm[1] / ay) ** 2 + (nrm[2] / az) ** 2);
    cuts.push({ n: nrm, d: re * (1 - spec.cutDepth * (0.4 + 0.6 * rnd())) });
  }
  const kSoft = spec.cutSoft || 0.6;
  // radial shape function r(unit direction), km: shared by the mesh and the self-shadow texture
  const radiusAt = (x, y, z) => {
    let r = 1 / Math.sqrt((x / ax) ** 2 + (y / ay) ** 2 + (z / az) ** 2);
    for (const c of cuts) {
      const cd = x * c.n[0] + y * c.n[1] + z * c.n[2];
      if (cd <= 0.05) continue;
      const rc = c.d / cd;
      // polynomial smooth-min
      const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (rc - r)) / kSoft));
      r = rc + (r - rc) * h - kSoft * h * (1 - h);
    }
    r *= 1 + spec.lump * fbm3(x * 1.3 + 3.1, y * 1.3 - 1.7, z * 1.3 + 0.4, 3, spec.seed) + spec.lump * 0.35 * fbm3(x * 3.7, y * 3.7, z * 3.7, 3, spec.seed + 7);
    for (const c of craters) {
      const cd = x * c.dir[0] + y * c.dir[1] + z * c.dir[2];
      if (cd < c.cos) continue;
      const ang = Math.acos(Math.min(1, cd));
      // irregular, slightly polygonal rims (azimuth around the crater axis)
      const px = x - c.dir[0] * cd, py = y - c.dir[1] * cd, pz = z - c.dir[2] * cd;
      const th = Math.atan2(px * c.e2[0] + py * c.e2[1] + pz * c.e2[2], px * c.e1[0] + py * c.e1[1] + pz * c.e1[2]);
      const wob = 1 + 0.06 * Math.sin(3 * th + c.ph[0]) + 0.04 * Math.sin(5 * th + c.ph[1]) + 0.025 * Math.sin(9 * th + c.ph[2]);
      const xr = ang / (c.ang * (c.smooth ? 1 : c.soft ? 1 + 0.5 * (wob - 1) : wob));
      r += c.smooth ? -c.d * Math.exp(-xr * xr * 1.6) : craterProfile(xr, c.d, c.rim, c.fresh, c.soft);
    }
    return r;
  };
  // displaced icosphere at a given subdivision level (mesh LODs share the shape function)
  let rMax = 0;
  const meshAt = (lvl) => {
    const ico = lvl === spec.level ? { positions, index } : icosphere(lvl);
    const nv = ico.positions.length / 3;
    const out = new Float32Array(nv * 3);
    for (let i = 0; i < nv; i++) {
      const x = ico.positions[3 * i], y = ico.positions[3 * i + 1], z = ico.positions[3 * i + 2];
      const r = radiusAt(x, y, z);
      rMax = Math.max(rMax, r);
      out[3 * i] = x * r;
      out[3 * i + 1] = y * r;
      out[3 * i + 2] = z * r;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    g.setIndex(new THREE.BufferAttribute(ico.index, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  const geometries = [meshAt(spec.level), meshAt(Math.max(spec.level - 2, 2)), meshAt(Math.max(spec.level - 4, 1))];
  // equirectangular radius map for ray-marched self-shadowing (u = lon/2pi + 0.5, v = lat/pi + 0.5, row 0 south)
  const TW = spec.shadowRes || 256, TH = TW / 2;
  const half = new Uint16Array(TW * TH);
  for (let j = 0; j < TH; j++) {
    const lat = ((j + 0.5) / TH - 0.5) * Math.PI;
    for (let i = 0; i < TW; i++) {
      const lon = ((i + 0.5) / TW - 0.5) * 2 * Math.PI;
      const x = Math.cos(lat) * Math.cos(lon), y = Math.sin(lat), z = -Math.cos(lat) * Math.sin(lon);
      half[j * TW + i] = THREE.DataUtils.toHalfFloat(radiusAt(x, y, z));
    }
  }
  const radiusTex = new THREE.DataTexture(half, TW, TH, THREE.RedFormat, THREE.HalfFloatType);
  radiusTex.wrapS = THREE.RepeatWrapping;
  radiusTex.wrapT = THREE.ClampToEdgeWrapping;
  radiusTex.magFilter = THREE.LinearFilter;
  radiusTex.minFilter = THREE.LinearFilter;
  radiusTex.generateMipmaps = false;
  radiusTex.needsUpdate = true;
  return { geometries, craters, rMean, rMax, radiusTex };
}

export function createMoon(ctx, kind, { quality }) {
  const { THREE, U } = ctx;
  const phobos = kind === 'phobos';
  const level = phobos ? (quality === 'high' ? 7 : 6) : quality === 'high' ? 6 : 5;
  const spec = phobos
    ? {
        axes: [13.0, 9.1, 11.4],
        lump: 0.09,
        shadowRes: quality === 'high' ? 512 : 256,
        cuts: 9,
        cutDepth: 0.09,
        cutSoft: 0.9,
        seed: 1877,
        level,
        nRandom: 150,
        rMin: 0.18,
        rMax: 1.9,
        freshPow: 1.8,
        named: [
          { name: 'Stickney', lat: -1, lon: -49, r: 4.5, d: 1.55, rim: 0.12, fresh: 0.75, soft: true },
          { name: 'Limtoc', lat: -11, lon: -54, r: 0.98, d: 0.3, rim: 0.04, fresh: 0.9 },
          { name: 'Hall', lat: -80, lon: 150, r: 2.7, d: 0.65, rim: 0.12, fresh: 0.5 },
          { name: 'Roche', lat: 52, lon: 177, r: 2.6, d: 0.55, rim: 0.1, fresh: 0.45 },
          { name: 'Grildrig', lat: 81, lon: -165, r: 1.3, d: 0.3, rim: 0.05, fresh: 0.5 },
          { name: 'Drunlo', lat: 12, lon: -92, r: 2.1, d: 0.5, rim: 0.08, fresh: 0.55 },
          { name: 'Clustril', lat: 60, lon: -91, r: 1.7, d: 0.4, rim: 0.06, fresh: 0.55 },
          { name: 'Shklovsky', lat: 24, lon: -112, r: 1.0, d: 0.26, rim: 0.05, fresh: 0.7 },
          { name: "D'Arrest", lat: -39, lon: -179, r: 1.05, d: 0.25, rim: 0.04, fresh: 0.6 },
          { name: 'Reldresal', lat: 41, lon: -39, r: 1.45, d: 0.33, rim: 0.05, fresh: 0.6 },
          { name: 'Todd', lat: -9, lon: -153, r: 1.3, d: 0.3, rim: 0.05, fresh: 0.6 },
          // ancient, shallow, degraded basins that give Phobos its faceted outline
          { smooth: true, name: 'facet1', lat: 35, lon: 120, r: 5.5, d: 0.55, rim: 0.05, fresh: 0.05 },
          { smooth: true, name: 'facet2', lat: -45, lon: 60, r: 5.0, d: 0.5, rim: 0.05, fresh: 0.05 },
          { smooth: true, name: 'facet3', lat: 10, lon: -150, r: 4.5, d: 0.45, rim: 0.04, fresh: 0.05 },
          { smooth: true, name: 'facet4', lat: -20, lon: 170, r: 4.0, d: 0.4, rim: 0.04, fresh: 0.08 },
        ],
      }
    : {
        // 15.0 x 12.2 x 11.0 km (Thomas 1996): long axis to Mars, intermediate along the orbit, short polar
        axes: [7.5, 5.5, 6.1],
        lump: 0.07,
        cuts: 14,
        cutDepth: 0.13,
        cutSoft: 1.1, // a regolith blanket rounds the facets (HiRISE 2009): an irregular but smooth outline
        seed: 4421,
        level,
        nRandom: 18,
        rMin: 0.18,
        rMax: 0.8,
        freshPow: 5.0, // regolith-blanketed: nearly every crater is shallow and infilled
        dScale: 0.45,
        named: [
          // the ~11 km saddle-shaped concavity near the south pole, and broad facets that make the outline angular
          { smooth: true, name: 'south concavity', lat: -68, lon: 10, r: 5.6, d: 1.15, rim: 0.12, fresh: 0.05 },
          { smooth: true, name: 'trailing facet', lat: 12, lon: 100, r: 3.6, d: 0.45, rim: 0.05, fresh: 0.04 },
          { smooth: true, name: 'north facet', lat: 58, lon: -120, r: 3.4, d: 0.4, rim: 0.04, fresh: 0.04 },
          { smooth: true, name: 'leading facet', lat: -15, lon: -95, r: 3.2, d: 0.35, rim: 0.04, fresh: 0.04 },
          { name: 'Voltaire', lat: 22, lon: -3.5, r: 0.95, d: 0.12, rim: 0.02, fresh: 0.2 },
          { name: 'Swift', lat: 12.5, lon: 1.8, r: 0.5, d: 0.07, rim: 0.015, fresh: 0.3 },
        ],
      };
  const t0 = performance.now();
  const shape = buildShape(THREE, spec);
  if (globalThis.location && /mars_timing/.test(globalThis.location.search)) console.warn('[mars] ' + kind + ' shape ms', (performance.now() - t0).toFixed(0));

  // the biggest craters go to the shader for analytic bowl shadows and albedo
  const big = shape.craters.filter((c) => !c.smooth && c.r > (phobos ? 0.95 : 0.6)).sort((a, b) => b.r - a.r).slice(0, 8);
  while (big.length < 8) big.push({ dir: [0, 1, 0], r: 0, d: 0, rim: 0, fresh: 0 });
  // (A: crater axis + angular radius; B: depth, rim height, freshness, rim radius km)
  const uBigA = big.map((c) => new THREE.Vector4(c.dir[0], c.dir[1], c.dir[2], c.ang || 0));
  const uBigB = big.map((c) => new THREE.Vector4(c.d, c.rim, c.fresh, c.r));

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uCamKm: { value: new THREE.Vector3(50, 0, 0) },
    uMarsKm: { value: new THREE.Vector3(-9376, 0, 0) },
    uMarsRkm: { value: 3396.2 },
    uMarsTau: { value: 0.35 },
    uMarsH: { value: 11.0 },
    uSunColor: U.uSunColor,
    uSunAng: { value: 0.003 },
    uRmean: { value: shape.rMean },
    uPixAngle: { value: 0.001 },
    // radiance factor I/F at opposition, disc centre (p_V ~0.071 / 0.068, red-sloped spectra)
    uAlbedo: { value: phobos ? new THREE.Vector3(0.086, 0.073, 0.063) : new THREE.Vector3(0.083, 0.071, 0.062) },
    uPhobos: { value: phobos ? 1 : 0 },
    uBigA: { value: uBigA },
    uBigB: { value: uBigB },
    uMarsShine: { value: new THREE.Vector3(0.25, 0.11, 0.05) }, // Mars' disc-averaged I/F (red-sloped)
    tRadius: { value: shape.radiusTex },
    uRmax: { value: shape.rMax },
    // dev: mars_mdbg bitmask (1 no grooves, 2 no boulders, 4 no per-pixel craters)
    uDbg: { value: Number(new URLSearchParams(globalThis.location ? globalThis.location.search : '').get('mars_mdbg') || 0) },
    // loop bounds as uniforms (FXC fully unrolls constant-bound loops: this program took ~4 s to compile)
    uCrIters: { value: 56 }, // 7 octaves x 8 cells
    uStreakN: { value: 9 },
    tNoise3: { value: noiseTexture3D(THREE) },
    uBoulderN: { value: 16 }, // 2 scales x 8 cells
    uBigN: { value: 8 },
    uGrooveN: { value: 4 },
    uPitN: { value: 2 },
    uShadowN: { value: 64 },
  };

  const vertexShader = /* glsl */ `
    varying vec3 vPk;
    varying vec3 vNk;
    void main() {
      vPk = position;
      vNk = normal;
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`;
  const fragmentShader = /* glsl */ `
    ${MARS_COMMON}
    uniform vec3 uSunDir, uCamKm, uMarsKm, uSunColor, uAlbedo, uMarsShine;
    uniform float uMarsRkm, uMarsTau, uMarsH, uSunAng, uRmean, uPixAngle, uRmax;
    uniform sampler2D tRadius;
    uniform int uPhobos;
    uniform float uDbg;
    uniform int uCrIters, uStreakN, uBoulderN, uBigN, uGrooveN, uPitN, uShadowN;
    uniform highp sampler3D tNoise3;
    uniform vec4 uBigA[8];
    uniform vec4 uBigB[8];
    varying vec3 vPk;
    varying vec3 vNk;

    // Phobos' grooves: families of parallel troughs (traces of parallel planes whose poles cluster near the
    // leading apex, +z), absent around the trailing apex, irregularly spaced and segmented. Resolved, each groove
    // is a CHAIN OF OVERLAPPING SHALLOW PITS (regolith draining into fractures; HRSC / HiRISE); below ~2 px per
    // pit the chain is replaced by its footprint-averaged trough.
    void grooves(vec3 p, vec3 d, vec3 Nm, float fp, float mask, inout vec3 g, inout float alb) {
      for (int k = 0; k < uGrooveN; k++) {
        float fk = float(k);
        vec3 nk = normalize(vec3(0.62 * sin(fk * 2.3 + 0.4), 0.5 * cos(fk * 1.9 + 0.8), 1.0));
        float sp = 0.6 + 0.4 * fract(fk * 0.618 + 0.2);                // mean spacing (km)
        float t = dot(p, nk) / sp + fk * 0.37;
        float gi = floor(t + 0.5);
        vec4 rg = mh43(vec3(gi, fk, 7.0));
        if (rg.x > 0.72) continue;                                      // some grooves are missing
        float ac0 = (t - gi - (rg.y - 0.5) * 0.45) * sp;                // across-groove distance (km)
        float rp = 0.05 + 0.065 * rg.z;                                 // pit radius 50-115 m
        if (abs(ac0) > 2.2 * rp + 2.0 * fp) continue;
        float cover = mask * smoothstep(-0.45, 0.1, d.z) * (1.0 - smoothstep(0.82, 0.97, dot(d, nk)));
        // segmented: each groove breaks into segments a few km long (two incommensurate sines along the trace,
        // phases from the groove's hash; no noise lookup)
        vec3 tg = normalize(cross(nk, d));
        float sa = dot(p, tg);
        float seg = smoothstep(-0.15, 0.3, 0.55 * sin(sa * 1.3 + 6.28 * rg.w) + 0.35 * sin(sa * 0.47 + 6.28 * rg.y + gi) + 0.25 * rg.w);
        float cs = cover * seg;
        if (cs <= 0.0) continue;
        // footprint-averaged trough
        float we = sqrt(0.6 * rp * 0.6 * rp + fp * fp);
        float At = 0.32 * rp * 0.75 * (0.6 * rp / we);
        float pr = exp(-ac0 * ac0 / (2.0 * we * we));
        vec3 gT = -At * pr * (-ac0 / (we * we)) * nk;
        // (the averaged trough stays visible as a faint lineation at a few hundred m/px, as in the Viking frames)
        float aT = -0.17 * pr * sqrt(0.6 * rp / we);
        // resolved pit chain: a chain of overlapping shallow pits along the trace, ~1.65 pit radii apart, jittered in
        // position and size, some missing; the nearest two pits are evaluated, the deeper one wins
        float wP = smoothstep(1.2, 2.5, rp / fp);
        vec3 gP = vec3(0.0);
        float aP = 0.0;
        if (wP > 0.0) {
          vec3 ac = normalize(nk - Nm * dot(nk, Nm));                    // across the trace, in the surface
          vec3 tk = cross(Nm, ac);                                         // along the trace
          float spP = 1.65 * rp;
          float al = dot(p, tk) / spP + rg.w * 17.0;
          float bi = floor(al);
          float best = 0.0;
          for (int j = 0; j < uPitN; j++) {
            float bj = bi + (j == 0 ? 0.0 : (al - bi > 0.5 ? 1.0 : -1.0));
            vec4 hj = mh43(vec3(bj, gi, fk + 41.0));
            if (hj.w < 0.28) continue;
            float rj = rp * (0.65 + 0.7 * fract(hj.w * 7.7));
            vec2 q2 = vec2((al - bj - 0.5 - 0.6 * (hj.x - 0.5)) * spP, ac0 - (hj.y - 0.5) * 0.3 * rp);
            float r2 = dot(q2, q2) / (rj * rj);
            if (r2 >= 1.0) continue;
            float H = -0.22 * rj * (1.0 - r2) * (1.0 - r2);             // rounded bowl, d/D ~0.11
            if (H < best) {
              best = H;
              gP = 0.88 * (1.0 - r2) * (q2.x * tk + q2.y * ac) / rj;
              aP = -0.12 * (1.0 - r2);
            }
          }
        }
        g += cs * mix(gT, gP, wP);
        alb += cs * mix(aT, aP, wP);
      }
    }

    float shapeR(vec3 q) {
      vec3 d = q / length(q);
      return textureLod(tRadius, vec2(atan(-d.z, d.x) * 0.15915494 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.31830989 + 0.5), 0.0).r;
    }
    // ray-marched self-shadowing against the baked radial shape: Stickney's rim, lumps and ridges cast real
    // shadows across the body near the terminator. Soft by the Sun's angular size (plus a little extra).
    float selfShadow(vec3 P, vec3 L, float fp) {
      float vis = 1.0;
      // smooth, deterministic march (no per-cell start jitter: hashed on body-space cells it projected into
      // tick-shaped blocks across the lit crescent); fine steps near the start, the penumbra widened to the pixel
      // footprint so thin ridges cannot alias
      float t = 0.06 + 2.0 * fp;
      for (int i = 0; i < uShadowN; i++) {
        vec3 q = P + L * t;
        float rq = length(q);
        if (rq > uRmax + 0.05) break;
        float h = rq - shapeR(q) + 0.04;
        vis = min(vis, clamp(0.5 + h / (t * 0.016 + 0.05 + 2.0 * fp), 0.0, 1.0));
        if (vis <= 0.0) break;
        t = t * 1.09 + 0.03;
      }
      return vis;
    }

    // Large craters (analytic, per pixel): returns a mask of Stickney's interior + near rim (the grooves stop
    // there) and the albedo of the landslide streaks on the walls: sparse, irregular bright deposits that run
    // from the rim down the walls (fresh material exposed by downslope regolith movement), not a sunburst.
    float bigCraters(vec3 pk, out float alb) {
      float inside = 0.0;
      alb = 0.0;
      vec3 d = normalize(pk);
      for (int i = 0; i < uBigN; i++) {
        vec4 A = uBigA[i];
        if (A.w <= 0.0) continue;
        vec3 cdir = A.xyz;
        float x = acos(clamp(dot(d, cdir), -1.0, 1.0)) / A.w;
        if (x > 1.6) continue;
        vec4 B = uBigB[i];
        if (B.w > 3.0) inside = max(inside, 1.0 - smoothstep(1.05, 1.35, x));
        if (x > 1.0) continue;
        vec3 e1 = normalize(cross(cdir, abs(cdir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
        vec3 e2 = cross(cdir, e1);
        float az = atan(dot(d, e2), dot(d, e1));
        float fi = float(i) * 2.39;
        // broad bands (tens of degrees of azimuth near the rim), not thin rays: a few incommensurate azimuthal
        // harmonics with per-crater phases (seamless around the rim, no noise lookups)
        float s3 = sin(3.0 * az + fi), s5 = sin(5.0 * az + 2.1 * fi + 1.0), s11 = sin(11.0 * az + 2.7 * fi);
        float sN = 0.5 * s3 + 0.35 * s5 + 0.2 * s11;
        float st = smoothstep(0.1, 0.6, sN);
        // each streak reaches a different distance down the wall; narrower toward its foot
        float reach = 0.3 + 0.4 * (0.5 + 0.5 * s5 * s3);
        float wall = smoothstep(reach - 0.08, reach + 0.18, x) * (1.0 - smoothstep(0.88, 0.99, x));
        float dark = smoothstep(0.45, 0.8, 0.45 * s11 * s5 + 0.5) * 0.35; // boulder tracks
        alb += B.z * wall * (0.85 * st - 0.25 * dark * (1.0 - st));
      }
      return inside;
    }

    void main() {
      vec3 pk = vPk;
      vec3 Nm = normalize(vNk);
      vec3 V = uCamKm - pk;
      float dist = length(V);
      V /= dist;
      vec3 L = uSunDir;
      vec3 d = normalize(pk);
      float fp = dist * uPixAngle;
      float fpMaj = fp / max(dot(Nm, V), 0.15);

      // ---- per-pixel detail in direction space (no popping, no seams) ----
      vec3 ps = d * uRmean;
      float sinE = dot(Nm, L);
      vec3 Lt = L - Nm * sinE;
      float ll = length(Lt);
      Lt = ll > 1e-5 ? Lt / ll : vec3(0.0, 1.0, 0.0);
      float tanE = sinE / max(ll, 1e-3);
      float h = 0.0, cAlb = 0.0, cVis = 1.0, rimM = 0.0;
      vec3 g = vec3(0.0);
      float S = uPhobos == 1 ? 1.6 : 0.7;
      // Deimos: regolith blanket -> few, infilled craters
      float dens = uPhobos == 1 ? 0.62 : 0.035;
      float freshK = uPhobos == 1 ? 2.2 : 7.0;
      vec3 ce1 = normalize(cross(abs(d.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), d));
      vec3 ce2 = cross(d, ce1);
      for (int it = 0; it < uCrIters; it++) {
        int o = it >> 3;
        float So = S * pow(0.45, float(o));
        if (So < 0.012) break;
        float w = smoothstep(1.5, 4.0, 0.25 * So / fpMaj);
        if (w > 0.0 && uDbg < 3.5) craterCell(ps, d, ce1, ce2, uRmean, So, dens, freshK, w, float(o) * 5.17 + float(uPhobos) * 31.0, it & 7, Lt, tanE, fpMaj, h, g, cAlb, cVis, rimM);
      }
      // albedo mottling and Deimos' downslope streak taps: value noise from the baked periodic 3D texture (16 lattice
      // cells per repeat), mip-filtered by the true footprint (explicit gradients, so it may run inside the loop)
      vec3 dpx = dFdx(pk), dpy = dFdy(pk);
      vec3 down = -(d - Nm * dot(d, Nm));
      float slD = length(down);
      down = slD > 1e-4 ? down / slD : vec3(0.0);
      float nA = textureGrad(tNoise3, (d * 3.0 + 1.3) / 16.0, dFdx(d) * (3.0 / 16.0), dFdy(d) * (3.0 / 16.0)).r;
      float nB = textureGrad(tNoise3, (d * 17.0 + 5.1) / 16.0, dFdx(d) * (17.0 / 16.0), dFdy(d) * (17.0 / 16.0)).r;
      float nC = textureGrad(tNoise3, pk * (3.3 / 16.0) + 0.37, dpx * (3.3 / 16.0), dpy * (3.3 / 16.0)).r;
      float nD = textureGrad(tNoise3, pk * (11.0 / 16.0) + 0.61, dpx * (11.0 / 16.0), dpy * (11.0 / 16.0)).r;
      float sN = 0.0;
      if (uPhobos == 0) {
        for (int k = 0; k < uStreakN; k++)
          sN += textureGrad(tNoise3, (pk + down * (float(k - 4) * 0.42)) * (2.6 / 16.0) + 0.44, dpx * (2.6 / 16.0), dpy * (2.6 / 16.0)).r;
      }
      // ejecta blocks / boulders: domes in a jittered grid at two scales (power-law sizes, up to ~60 m; denser on
      // fresh crater rims), shading and casting their own tiny shadows by slope; faded below ~1.5 px
      float bAlb = 0.0;
      for (int it = 0; it < uBoulderN; it++) {
        int o = it >> 3, k = it & 7;
        float cs = o == 0 ? 0.16 : 0.06;
        float wsc = smoothstep(1.2, 3.0, 0.2 * cs / fpMaj);
        if (wsc <= 0.0 || mod(floor(uDbg / 2.0), 2.0) > 0.5) break;
        vec3 cb = floor(pk / cs - 0.5);
        {
          vec3 cell = cb + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
          vec4 hb = mh43(cell + 17.0 * float(o) + 0.5);
          if (hb.w > 0.16 + 0.4 * rimM) continue;
          float rb = cs * (0.07 + 0.2 * hb.x * hb.x * hb.x);
          vec3 cc = (cell + 0.5 + 0.6 * (hb.xyz - 0.5)) * cs;
          vec3 dv = pk - cc;
          dv -= Nm * dot(dv, Nm);
          float r2 = dot(dv, dv) / (rb * rb);
          if (r2 >= 1.0) continue;
          float wb = wsc * smoothstep(1.0, 2.5, rb / fpMaj);
          float q = 1.0 - r2;
          // dome of height 0.6 rb: h = 0.6 rb q^1.5 -> grad = -1.8 q^0.5 dv / rb
          g += wb * (-1.8 * sqrt(q) / rb) * dv * 0.6;
          bAlb += wb * 0.18 * q;
        }
      }
      float sAlb;
      float inSt = bigCraters(pk, sAlb);
      float gAlb = 0.0;
      if (uPhobos == 1 && mod(uDbg, 2.0) < 0.5) grooves(pk, d, Nm, fp, 1.0 - inSt, g, gAlb);

      g -= Nm * dot(g, Nm);
      // near grazing sunlight, sub-pixel bump detail only sparkles: blend it partly toward the mesh normal there
      vec3 N = normalize(Nm - g * mix(0.4, 1.0, smoothstep(0.0, 0.18, dot(Nm, L))));

      // ---- albedo: dark, slightly red regolith; Phobos' bluer unit around Stickney ----
      vec3 alb = uAlbedo;
      // albedo structure that survives at low phase (where relief shading vanishes): 100-km-scale mottling of the
      // regolith (+-20%); on Phobos the brighter, bluer 'blue unit' around Stickney and on the leading hemisphere
      // and the darker 'red unit' on the trailing side (Mars Express HRSC / MRO CRISM colour maps)
      alb *= 1.0 + (uPhobos == 1 ? 0.2 : 0.09) * nA + (uPhobos == 1 ? 0.1 : 0.05) * nB;   // (Deimos: a smooth blanket)
      if (uPhobos == 1) {
        float nearSt = smoothstep(0.15, 0.95, dot(d, normalize(vec3(0.656, -0.02, 0.755))));
        alb *= mix(vec3(1.0), vec3(1.07, 1.12, 1.22), nearSt);
        alb *= mix(vec3(1.0), vec3(0.95, 0.91, 0.87), smoothstep(0.1, -0.75, d.z));
      } else {
        // Deimos: smooth regolith blanket; bright streaks run downslope from ridge crests and crater rims
        // (fresher, finer material moving down the slopes, Thomas et al. 1996). Downslope ~ toward the centre
        // projected into the local surface; the streak noise is stretched along it and only appears on slopes.
        // line-integral-convolved noise along the downslope direction (taps in the loop above): coherent streaks
        // ~3-4 km long, ~0.4 km wide
        sN *= 0.24;
        float slopeW = smoothstep(0.12, 0.4, slD);
        float streak = smoothstep(0.1, 0.45, sN) * slopeW;
        // and a faint brightening of the crests themselves (convex, thin regolith)
        float crest = smoothstep(0.02, 0.2, dot(Nm, d) - 0.86);
        alb *= 1.0 + 0.28 * streak + 0.06 * crest;
      }
      alb *= 1.0 + cAlb + gAlb + sAlb + rimM * 0.08;
      // the bright wall streaks and fresh crater material are the bluer, less space-weathered regolith
      alb *= mix(vec3(1.0), vec3(0.93, 1.0, 1.1), clamp(max(sAlb, cAlb) * 1.6, 0.0, 1.0));
      // regolith mottling at 0.3-3 km (space-weathering maturity), faded below the pixel scale; boulders brighter
      alb *= 1.0 + bAlb + 0.08 * smoothstep(1.0, 3.0, 0.3 / fpMaj) * nC
                 + 0.05 * smoothstep(1.0, 3.0, 0.1 / fpMaj) * nD;

      // ---- illumination ----
      float mu0 = dot(N, L);
      float mu = max(dot(N, V), 0.0);
      float gph = acos(clamp(dot(L, V), -1.0, 1.0));
      // Lommel-Seeliger (dark regolith: single scattering dominates, almost no limb darkening)
      // (a 15% Lambert share stands in for Hapke macroscopic roughness: a little limb darkening, so the body reads
      // as a solid lump at low phase rather than a flat disc)
      float ls = max(mu0, 0.0) * (0.15 + 1.7 / max(max(mu0, 0.0) + mu, 1e-3));
      // Hapke-style phase behaviour, normalised so uAlbedo is the disc-centre I/F at opposition:
      // shadow-hiding opposition surge B0 = 1.5, h = 0.06 (Simonelli et al. 1998 for Phobos) and a backscattering
      // single-particle phase function (one-term HG, xi = -0.2): [(1 + B(g)) P(g)] / [(1 + B0) P(0)].
      // Normalised at g = 0, so I/F(disc centre) at 55 deg phase ~0.024 (V) / 0.028 (red), ~2.9x below opposition
      // (a phase coefficient ~0.025 mag/deg, between the Moon's and the steepest Phobos estimates).
      float Bg = 1.5 / (1.0 + tan(min(gph, 3.0) * 0.5) / 0.06);
      float Pg = 0.96 / pow(1.04 - 0.4 * cos(gph), 1.5);
      float phase = (1.0 + Bg) * Pg / (2.5 * 1.875);
      // macroscopic roughness softens the terminator
      float rough = smoothstep(-0.02, 0.18, mu0);

      // Mars' shadow (umbra/penumbra) with dust extinction just outside it
      vec3 toM = uMarsKm - pk;
      float dM = length(toM);
      vec3 mDir = toM / dM;
      float aM = asin(min(1.0, uMarsRkm / dM));
      float thM = acos(clamp(dot(mDir, L), -1.0, 1.0));
      float sunVis = 1.0 - discOcclusion(thM, uSunAng, aM);
      float bTan = dM * sin(thM) - uMarsRkm;                    // tangent altitude of the sun ray
      if (dot(mDir, L) > 0.0) sunVis *= exp(-uMarsTau * 2.0 * sqrt(1.5707963 * uMarsRkm / uMarsH) * exp(-max(bTan, 0.0) / uMarsH));

      float self = mu0 > -0.05 ? selfShadow(pk + Nm * 0.01, L, fp) : 0.0;
      vec3 sun = uSunColor * sunVis * cVis * self * ls * phase * rough;
      // Mars-shine: Mars subtends ~42 deg from Phobos; lit fraction from the Sun-Mars-moon phase
      float lit = 0.5 + 0.5 * dot(L, -mDir);
      float mus = max(dot(N, mDir), 0.0);
      // irradiance from Mars' lit disc: (mean I/F of the disc) x sin^2(angular radius) x lit fraction, then the same
      // dark-regolith law (a ~0.7 mean phase factor for the broad range of Mars-light directions)
      vec3 ms = uSunColor * uMarsShine * sin(aM) * sin(aM) * lit * mus * (0.15 + 1.7 / max(mus + mu, 0.05)) * 0.7;
      vec3 col = alb * (sun + ms);
      gl_FragColor = vec4(col, 1.0);
    }`;

  const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader });
  // distance LODs (scene units; 1 unit = 6371 km): full detail within ~40 radii, coarser beyond
  const mesh = new THREE.LOD();
  mesh.name = kind;
  mesh.scale.setScalar(1 / 6371); // geometry in km
  const rU = shape.rMean / 6371;
  // (switching late keeps the silhouette smooth: >= 2 px per edge at each switch)
  [0, 120 * rU, 1200 * rU].forEach((dist, i) => {
    const m = new THREE.Mesh(shape.geometries[i], material);
    m.name = kind + '-lod' + i;
    mesh.addLevel(m, dist);
  });
  return { mesh, uniforms, rMean: shape.rMean, rMax: shape.rMax };
}
