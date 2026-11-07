// The local asteroid field around the camera's belt crossing.
//
// The field is a tube along the flight path (field-local coords: a, b lateral, s along the path; origin at the
// crossing point). Rocks are NOT stored: every rock is a pure function of an integer lattice cell. Each size
// class k (radius r_k = R_MIN * 2^k) has its own lattice whose cell size scales with r_k, and each cell holds M
// candidate slots; a slot becomes a rock with a probability set by the density envelope (tube profile,
// entry/exit ramps, clumpy collisional-family structure, a clear corridor along the path). Therefore:
//   - density near the camera is the same everywhere along the 120-unit tube at constant cost;
//   - the CPU (meshes, nearestDistance) and the GPU (sub-pixel "point" rocks) generate identical rocks from the
//     same PCG hashes (hash.js), so rocks hand over from point to mesh without popping;
//   - everything is deterministic and independent of frame history.
// Hero rocks are explicit, placed by setCrossing() for the film's set pieces.
import * as THREE from 'three';
import { hashCell, rnd, vnoiseH, HASH_GLSL, mulberry32 } from './hash.js';
import { TIME_SCALE } from '../../core/astro.js';

export const SEED = 0x5eed1e57 >>> 0;
export const R_MIN = 0.00006; // smallest class radius: 0.38 km
export const NCLASS = 9; // up to ~0.031 units (196 km radius)
export const Q_SLOPE = 2.0; // cumulative size-frequency slope within the swarm
export const N0 = 491000; // class-0 rocks per unit^3 on the axis at peak clump density (class 7: 30 per unit^3)
export const RANGE_K = 2000; // point-rock range = RANGE_K * r_k (beyond it a rock is < ~0.6 px: the glow pass takes over)
export const LAMBDA = 2.8; // expected rocks per lattice cell at peak density
export const SLOTS = 4; // candidate slots per cell
export const MESH_PX = 8; // lattice rocks become meshes at a bounding radius of 8 px (cross-fade 8..12)

// The swarm is a flattened cloud (like the belt itself): wide in the ecliptic across the path (A), thin out of it
// (B), long along the path (s). Density = a power-law core around the axis, (1 + (a/cw)^2 + (b/ch)^2)^-0.75, times a
// Gaussian taper over a noise-WARPED, slightly SHEARED ellipsoid (semi-axes taperWidth x taperHeight; the swarm's
// ends are warped fronts), times clumps at three scales. The taper reaches ~0.5% of the axis density well before
// the bounding box (halfWidth/halfHeight), so no straight edge or corner is ever visible from outside; the same
// function drives the meshes, the GPU points, the integrated glow and the dust (one density everywhere).
export const FIELD = {
  halfLength: 60, // units (Earth radii) along the path either side of the crossing point
  halfWidth: 26, // bounding half-extent in the ecliptic (A axis); the density is ~0 long before it
  halfHeight: 7, // bounding half-thickness out of the ecliptic (B axis)
  coreWidth: 4.0, // power-law core scale in A
  coreHeight: 1.4, // power-law core scale in B
  taperWidth: 9.5, // Gaussian taper semi-axis in A (warped +-28%, sheared 0.04 a per unit s, displaced +-2.5)
  taperHeight: 2.5, // Gaussian taper semi-axis in B (warped +-22%, displaced +-0.7)
  radius: 26, // bounding radius of the slab cross-section (kept for older readers of FIELD)
  coreRadius: 1.4,
  corridor: 0.012, // no rock surface within this distance of the path axis (~76 km)
  recommendedSpeed: 0.25, // units per second for a beautiful pass (0.08..0.12 for a slow hero close-up)
  rampLength: 6,
  tail: 22, // sparse "vanguard" rocks extend this far beyond either end
};
/** Distance from field-local point (a, b, s) to the slab's bounding box (0 inside). */
export function slabDistance(a, b, s, pad = 0) {
  const F = FIELD;
  const da = Math.max(0, Math.abs(a) - F.halfWidth - pad), db = Math.max(0, Math.abs(b) - F.halfHeight - pad);
  const ds = Math.max(0, Math.abs(s) - F.halfLength - F.tail - pad);
  return Math.hypot(da, db, ds);
}

// Camera-path corridor: lateral offset (a, b) of the director's actual path, sampled at PATH_N stations along s.
export const PATH_N = 64;
export const PATH_S0 = -(FIELD.halfLength + FIELD.tail);
export const PATH_DS = (2 * (FIELD.halfLength + FIELD.tail)) / (PATH_N - 1);
export const PATH_R = 0.02; // corridor radius around the sampled path
export const PATH = { on: false, ab: new Float32Array(PATH_N * 2) };
export function pathBlocked(a, b, s, bound) {
  if (!PATH.on) return false;
  const x = (s - PATH_S0) / PATH_DS;
  if (x < 0 || x > PATH_N - 1) return false;
  const i = Math.min(PATH_N - 2, Math.floor(x)), f = x - i;
  const pa = PATH.ab[i * 2] + (PATH.ab[i * 2 + 2] - PATH.ab[i * 2]) * f;
  const pb = PATH.ab[i * 2 + 1] + (PATH.ab[i * 2 + 3] - PATH.ab[i * 2 + 1]) * f;
  return Math.hypot(a - pa, b - pb) < PATH_R + bound;
}

// Shape frequencies: 32-entry lookup table into the 20 regular shapes. Angular collisional fragments (faceted
// 12-17, Gaspra-like 18, shard 9, split 10) are the majority (~56%); bilobed bodies (contact binaries, dog-bones;
// shapes 4-7) ~12% (radar/lightcurve statistics give ~15% of small asteroids); notched potatoes and bananas ~16%.
export const SHAPE_TABLE = [12, 12, 13, 13, 13, 14, 14, 15, 15, 16, 16, 16, 17, 17, 18, 18, 18, 9, 10, 10, 0, 1, 2, 3, 19, 4, 5, 6, 7, 8, 11, 11];

export const CLASSES = [];
for (let k = 0; k < NCLASS; k++) {
  const r = R_MIN * Math.pow(2, k);
  const n = N0 * Math.pow(2, -Q_SLOPE * k);
  const cell = Math.cbrt(LAMBDA / n);
  CLASSES.push({ k, r, cell, range: RANGE_K * r, n, lambda: LAMBDA, M: SLOTS, pAcc: LAMBDA / SLOTS });
}

// composition classes: [weight, albedo min, albedo max, tint r, g, b]
export const TYPES = [
  // outer-middle main belt by number at 2.7 AU: ~60% dark C/B/D, ~30% S, a few bright V and metallic M
  // tints are the visible-range spectral slopes, kept subtle (true colour of asteroids is near neutral grey)
  { id: 'C', w: 0.42, a0: 0.035, a1: 0.075, tint: [1.0, 0.995, 0.985] },
  // S-types: the red visible slope of olivine/pyroxene + space weathering reads as a tan/butterscotch grey in
  // true colour (Eros, Itokawa); C/B near neutral (B slightly blue); D redder still; M faintly warm
  { id: 'S', w: 0.22, a0: 0.15, a1: 0.25, tint: [1.09, 1.0, 0.86] },
  { id: 'M', w: 0.05, a0: 0.12, a1: 0.18, tint: [1.03, 1.0, 0.96] },
  { id: 'V', w: 0.04, a0: 0.28, a1: 0.38, tint: [1.05, 1.0, 0.92] },
  { id: 'B', w: 0.06, a0: 0.04, a1: 0.07, tint: [0.98, 0.997, 1.02] },
  { id: 'D', w: 0.07, a0: 0.03, a1: 0.06, tint: [1.1, 1.0, 0.88] },
];
const TYPE_CDF = (() => {
  let s = 0;
  const tot = TYPES.reduce((a, t) => a + t.w, 0);
  return TYPES.map((t) => (s += t.w / tot));
})();

const sstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

// Large-scale structure (shared by envelope() and the GLSL fieldShape()): two low-frequency value-noise fields.
// nF: filaments and sheets, 3.6 x 1.25 units across but ~50 units long along the path (a young collisional family
// shears into streams along its orbit), so even an end-on view integrating the whole swarm shows streaks and voids;
// nW: a broad warp (12 x 4 x 11 units) that bends the outer boundary and the ends.
function largeNoise(a, b, s) {
  const nF = vnoiseH(a * 0.28 + 3.1, b * 0.8 - 7.7, s * 0.02 + 1.3, (SEED ^ 0x5a5a) >>> 0);
  const nW = vnoiseH(a * 0.08 - 4.2, b * 0.25 + 2.9, s * 0.09 - 6.6, (SEED ^ 0x6b6b) >>> 0);
  return [nF, nW];
}
/**
 * The swarm's smooth shape at (a, b, s) given the large-scale noises: power-law core x warped Gaussian taper x
 * warped axial fronts x a large-scale density modulation (voids and filaments away from the axis). `coreW/coreH`
 * select the core (rocks 4 x 1.4; the fine dust uses a broader 11 x 2.8 core inside the same outer shape).
 */
export function swarmShape(a, b, s, nF, nW, coreW = FIELD.coreWidth, coreH = FIELD.coreHeight) {
  const F = FIELD;
  const aa = Math.abs(a), ab = Math.abs(b);
  if (aa >= F.halfWidth || ab >= F.halfHeight) return 0;
  const ea = a / coreW, eb = b / coreH;
  const core = Math.pow(1 + ea * ea + eb * eb, -0.75);
  // warped, sheared ellipsoidal taper (no box edges): Gaussian near the axis, exponential tails outside (the
  // filaments reach further out than the voids, so the outline is ragged)
  const at = a + 0.04 * s + 2.5 * nW, bt = b + 0.6 * nW;
  const W = F.taperWidth * (1 + 0.3 * nF), H = F.taperHeight * (1 + 0.25 * nF);
  const q2 = (at / W) * (at / W) + (bt / H) * (bt / H);
  const taper = Math.exp(-q2 / (1 + 0.5 * Math.sqrt(q2)));
  const guard = (1 - sstep(F.halfWidth - 4, F.halfWidth, aa)) * (1 - sstep(F.halfHeight - 1.5, F.halfHeight, ab));
  // warped fronts at both ends (+-8 units across the cross-section) and a sparse vanguard beyond them
  const sw = s + 8 * nW;
  const as = Math.abs(sw);
  const main = sstep(-F.halfLength - 2, -F.halfLength + F.rampLength + 4, sw) * (1 - sstep(F.halfLength - F.rampLength - 4, F.halfLength + 2, sw));
  const tail = 0.11 * Math.exp(-Math.max(0, as - F.halfLength + 6) / 7) * (1 - sstep(F.halfLength + F.tail - 10, F.halfLength + F.tail, Math.abs(s)));
  // large-scale voids and filaments, faded in away from the axis (the camera's own neighbourhood keeps the
  // clump statistics the film was composed with); mean ~1
  const rho = Math.sqrt((a / 3) * (a / 3) + (b / 1.2) * (b / 1.2));
  const large = 1 + sstep(0.8, 3.5, rho) * (0.25 + 1.7 * sstep(-0.35, 0.45, nF) - 1.0);
  return core * taper * guard * Math.max(main, tail) * large;
}
/** Small-scale clumps (two octaves, 1.8 and 0.6 units): collisional families with real voids between them. */
function clumpNoise(a, b, s) {
  const n = 0.62 * vnoiseH(a * 0.55 + 17.0, b * 0.55 - 9.0, s * 0.55, SEED ^ 0x1234) + 0.38 * vnoiseH(a * 1.6, b * 1.6 + 5.0, s * 1.6 - 3.0, SEED ^ 0x4321);
  const cs = sstep(-0.2, 0.42, n);
  return 0.08 + 1.3 * cs * Math.sqrt(cs); // mean 0.49, peak 1.38 (pAcc x env stays < 1)
}
/** Density envelope in [0, ~1.4] at field-local (a, b, s). Mirrored in GLSL (fieldEnvelope). */
export function envelope(a, b, s) {
  const F = FIELD;
  if (Math.abs(a) >= F.halfWidth || Math.abs(b) >= F.halfHeight || Math.abs(s) >= F.halfLength + F.tail) return 0;
  const [nF, nW] = largeNoise(a, b, s);
  const shape = swarmShape(a, b, s, nF, nW);
  if (shape <= 0) return 0;
  return shape * clumpNoise(a, b, s);
}

/**
 * Generate the rock in slot j of cell (ix,iy,iz) of class cls, or null. shapeInfo: [{boundR, axes, spinAxis}] for
 * the regular shapes. Must match GLSL genRock() bit-for-bit in its decisions.
 */
export function genRock(cls, ix, iy, iz, j, shapeInfo, out, filter) {
  const C = CLASSES[cls];
  const h = hashCell(ix, iy, iz, (SEED + cls * 64 + j) >>> 0);
  const ua = rnd(h, 3);
  if (!(ua < C.pAcc)) return null; // cheap pre-test (envelope <= 1); same decision as the full test
  const a = (ix + rnd(h, 0)) * C.cell, b = (iy + rnd(h, 1)) * C.cell, s = (iz + rnd(h, 2)) * C.cell;
  // size: power law within the octave [r, 2r)
  const u = rnd(h, 4);
  const q = Q_SLOPE;
  const scale = C.r * Math.pow(1 - u * (1 - Math.pow(2, -q)), -1 / q);
  const nS = shapeInfo.length;
  const shape = Math.min(nS - 1, SHAPE_TABLE[Math.min(31, Math.floor(rnd(h, 5) * 32))]);
  const sx = 0.82 + 0.36 * rnd(h, 14), sy = 0.82 + 0.36 * rnd(h, 15), sz = 0.82 + 0.36 * rnd(h, 16);
  const smax = Math.max(sx, sy, sz);
  const bound = shapeInfo[shape].boundR * smax * scale;
  // caller's cheap geometric filter (e.g. "too small on screen") before the expensive envelope
  if (filter && !filter(a, b, s, bound)) return null;
  const env = envelope(a, b, s);
  if (!(ua < C.pAcc * env)) return null;
  const rho = Math.hypot(a, b);
  if (rho < FIELD.corridor + bound && Math.abs(s) < FIELD.halfLength + FIELD.tail) return null;
  if (pathBlocked(a, b, s, bound)) return null;
  out.cls = cls;
  out.h = h;
  out.a = a;
  out.b = b;
  out.s = s;
  out.scale = scale;
  out.bound = bound;
  out.shape = shape;
  out.stretch[0] = sx;
  out.stretch[1] = sy;
  out.stretch[2] = sz;
  rockMaterialProps(h, out);
  // orientation (uniform random quaternion, Shoemake)
  const u1 = rnd(h, 7), u2 = rnd(h, 8), u3 = rnd(h, 9);
  const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
  out.q0[0] = s1 * Math.sin(2 * Math.PI * u2);
  out.q0[1] = s1 * Math.cos(2 * Math.PI * u2);
  out.q0[2] = s2 * Math.sin(2 * Math.PI * u3);
  out.q0[3] = s2 * Math.cos(2 * Math.PI * u3);
  // spin: principal-axis rotation about the shortest axis, period 2.2 .. 33 h (spin barrier for rubble piles)
  const Ph = 2.2 * Math.pow(15, Math.pow(rnd(h, 10), 1.4));
  out.omega = ((2 * Math.PI) / (Ph * 3600)) * TIME_SCALE * (rnd(h, 11) < 0.5 ? 1 : -1); // rad per film second
  out.phase0 = rnd(h, 12) * 2 * Math.PI;
  out.tumble = rnd(h, 13) < 0.12 ? 0.35 + 0.6 * rnd(h, 18) : 0; // non-principal-axis tumblers (Toutatis-like)
  out.spinAxis = shapeInfo[shape].spinAxis;
  out.seed = rnd(h, 19);
  out.hero = -1;
  return out;
}

export function rockMaterialProps(h, out) {
  const ut = rnd(h, 6);
  let t = 0;
  while (t < TYPE_CDF.length - 1 && ut > TYPE_CDF[t]) t++;
  const T = TYPES[t];
  const alb = T.a0 + (T.a1 - T.a0) * rnd(h, 17);
  const jit = (rnd(h, 20) - 0.5) * 0.06;
  out.type = t;
  out.albedo = alb;
  out.color[0] = alb * T.tint[0] * (1 + jit);
  out.color[1] = alb * T.tint[1];
  out.color[2] = alb * T.tint[2] * (1 - jit);
}

export function newRock() {
  return { cls: 0, h: 0, a: 0, b: 0, s: 0, scale: 0, bound: 0, shape: 0, stretch: [1, 1, 1], q0: [0, 0, 0, 1], omega: 0, phase0: 0, tumble: 0, spinAxis: 2, seed: 0, type: 0, albedo: 0.1, color: [0.1, 0.1, 0.1], hero: -1 };
}

// rotation of a rock at film time t: q0 * [precession] * spin(about the body's short axis)
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _ax = new THREE.Vector3();
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
export function rockQuaternion(r, t, out) {
  out.set(r.q0[0], r.q0[1], r.q0[2], r.q0[3]);
  const ang = r.phase0 + r.omega * t;
  if (r.tumble > 0) {
    // free precession of the spin axis around the angular momentum vector (body x-ish), tilt = r.tumble rad
    _qa.setFromAxisAngle(AXES[(r.spinAxis + 1) % 3], ang * 0.37 + r.phase0 * 1.7);
    out.multiply(_qa);
    _qa.setFromAxisAngle(AXES[(r.spinAxis + 2) % 3], r.tumble);
    out.multiply(_qa);
  }
  _qb.setFromAxisAngle(AXES[r.spinAxis], ang);
  return out.multiply(_qb);
}

// ------------------------------------------------------------------------------------------ GLSL mirror
export function fieldGLSL() {
  const F = FIELD;
  const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));
  const tdefs = TYPES.map((T, i) => `  if (t == ${i}) { a0 = ${f(T.a0)}; a1 = ${f(T.a1)}; tint = vec3(${T.tint.map(f).join(', ')}); }`).join('\n');
  const cdf = TYPE_CDF.map((c, i) => `  if (ut > ${f(c)}) t = ${i + 1};`).slice(0, TYPE_CDF.length - 1).join('\n');
  return /* glsl */ `
${HASH_GLSL}
#define FIELD_SEED ${SEED}u
#define Q_SLOPE ${f(Q_SLOPE)}
#define TIME_SCALE ${f(TIME_SCALE)}
float sstep(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
// The field's four value noises from ONE vnoiseH call site (ANGLE/FXC inlines every call site): n < 4 skips the
// finer ones. x = nF (filaments), y = nW (warp): mirror of field.js largeNoise(); z, w = the clump octaves
// (1.8 and 0.6 units): mirror of clumpNoise(). The loop bound comes from the uVN uniform (uVN / 2 = 4).
vec4 fieldNoises(vec3 p, int n) {
  vec4 r = vec4(0.0);
  // one flat loop over (noise, corner): the value noise is inlined here instead of nesting vnoiseH's corner loop
  int nK = n * uVN;
  ivec3 ci = ivec3(0);
  vec3 u = vec3(0.0);
  uint sd = 0u;
  float acc = 0.0;
  int i = 0, kk = 0; // (noise, corner) counters instead of an integer division per iteration
  for (int k = 0; k < nK; k++) {
    if (kk == 0) {
      vec3 q;
      if (i == 0) { q = vec3(p.x * 0.28 + 3.1, p.y * 0.8 - 7.7, p.z * 0.02 + 1.3); sd = FIELD_SEED ^ 0x5a5au; }
      else if (i == 1) { q = vec3(p.x * 0.08 - 4.2, p.y * 0.25 + 2.9, p.z * 0.09 - 6.6); sd = FIELD_SEED ^ 0x6b6bu; }
      else if (i == 2) { q = vec3(p.x * 0.55 + 17.0, p.y * 0.55 - 9.0, p.z * 0.55); sd = FIELD_SEED ^ 0x1234u; }
      else { q = vec3(p.x * 1.6, p.y * 1.6 + 5.0, p.z * 1.6 - 3.0); sd = FIELD_SEED ^ 0x4321u; }
      vec3 fl = floor(q);
      ci = ivec3(fl);
      vec3 f = q - fl;
      u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
      acc = 0.0;
    }
    ivec3 o = ivec3(kk & 1, (kk >> 1) & 1, (kk >> 2) & 1);
    vec3 w3 = mix(1.0 - u, u, vec3(o));
    acc += w3.x * w3.y * w3.z * u01(hashCell(ci + o, sd));
    if (kk == uVN - 1) {
      float v = acc * 2.0 - 1.0;
      if (i == 0) r.x = v; else if (i == 1) r.y = v; else if (i == 2) r.z = v; else r.w = v;
      kk = 0;
      i++;
    } else kk++;
  }
  return r;
}
// mirror of field.js swarmShape(): power-law core x warped, sheared taper x warped fronts x large-scale voids.
// Returns the shape for two cores at once: x = rocks (coreWidth x coreHeight), y = fine dust (11 x 2.8).
vec2 fieldShape(vec3 p, vec2 nn) {
  vec2 aab = abs(p.xy);
  if (aab.x >= ${f(F.halfWidth)} || aab.y >= ${f(F.halfHeight)} || abs(p.z) >= ${f(F.halfLength + F.tail)}) return vec2(0.0);
  vec2 e = p.xy / vec2(${f(F.coreWidth)}, ${f(F.coreHeight)});
  vec2 ed = p.xy / vec2(11.0, 2.8);
  vec2 core = pow(vec2(1.0 + dot(e, e), 1.0 + dot(ed, ed)), vec2(-0.75));
  float nF = nn.x, nW = nn.y;
  float at = p.x + 0.04 * p.z + 2.5 * nW, bt = p.y + 0.6 * nW;
  float W = ${f(F.taperWidth)} * (1.0 + 0.3 * nF), H = ${f(F.taperHeight)} * (1.0 + 0.25 * nF);
  float q2 = (at / W) * (at / W) + (bt / H) * (bt / H);
  float taper = exp(-q2 / (1.0 + 0.5 * sqrt(q2)));
  float guard = (1.0 - sstep(${f(F.halfWidth - 4)}, ${f(F.halfWidth)}, aab.x)) * (1.0 - sstep(${f(F.halfHeight - 1.5)}, ${f(F.halfHeight)}, aab.y));
  float sw = p.z + 8.0 * nW;
  float as = abs(sw);
  float mainA = sstep(${f(-F.halfLength - 2)}, ${f(-F.halfLength + F.rampLength + 4)}, sw) * (1.0 - sstep(${f(F.halfLength - F.rampLength - 4)}, ${f(F.halfLength + 2)}, sw));
  float tailA = 0.11 * exp(-max(0.0, as - ${f(F.halfLength - 6)}) / 7.0) * (1.0 - sstep(${f(F.halfLength + F.tail - 10)}, ${f(F.halfLength + F.tail)}, abs(p.z)));
  float rho = sqrt((p.x / 3.0) * (p.x / 3.0) + (p.y / 1.2) * (p.y / 1.2));
  float large = 1.0 + sstep(0.8, 3.5, rho) * (0.25 + 1.7 * sstep(-0.35, 0.45, nF) - 1.0);
  return core * (taper * guard * max(mainA, tailA) * large);
}
// clumpy collisional-family structure from the clump octaves (nn.zw); lod = 0 full, 1 = large octave only,
// 2 = the mean (for long integration steps)
float fieldClumpN(vec2 c, float lod) {
  if (lod >= 1.99) return 0.49; // the mean over the noise (long integration steps)
  float n = 0.62 * c.x + (lod < 0.99 ? 0.38 * c.y : 0.0);
  float cs = sstep(-0.2, 0.42, n);
  return 0.08 + 1.3 * cs * sqrt(cs);
}
float fieldEnvelope(vec3 p) {
  if (abs(p.x) >= ${f(F.halfWidth)} || abs(p.y) >= ${f(F.halfHeight)} || abs(p.z) >= ${f(F.halfLength + F.tail)}) return 0.0;
  vec4 nn = fieldNoises(p, uVN / 2);
  float base = fieldShape(p, nn.xy).x;
  if (base <= 0.0) return 0.0;
  return base * fieldClumpN(nn.zw, 0.0);
}
void rockMaterial(uint h, out int t, out vec3 color, out float albedo) {
  float ut = rnd(h, 6u);
  t = 0;
${cdf}
  float a0 = 0.1, a1 = 0.1; vec3 tint = vec3(1.0);
${tdefs}
  albedo = a0 + (a1 - a0) * rnd(h, 17u);
  float jit = (rnd(h, 20u) - 0.5) * 0.06;
  color = albedo * tint * vec3(1.0 + jit, 1.0, 1.0 - jit);
}
uniform vec2 uPathAB[${PATH_N}];
uniform float uPathOn;
bool pathBlocked(vec3 p, float bound) {
  if (uPathOn < 0.5) return false;
  float x = (p.z - (${f(PATH_S0)})) / ${f(PATH_DS)};
  if (x < 0.0 || x > ${f(PATH_N - 1)}) return false;
  int i = min(${PATH_N - 2}, int(floor(x)));
  float fr = x - float(i);
  vec2 ab = mix(uPathAB[i], uPathAB[i + 1], fr);
  return length(p.xy - ab) < ${f(PATH_R)} + bound;
}
// SHAPE_TABLE packed 5 bits x 6 per uint (no dynamically indexed local array: FXC turns those into slow indexable temps)
${(() => {
  const W = [];
  for (let w = 0; w < 6; w++) {
    let v = 0;
    for (let k = 0; k < 6; k++) v += (SHAPE_TABLE[w * 6 + k] ?? 0) * 2 ** (5 * k);
    W.push(v >>> 0);
  }
  return `int shapeTable(int i) {
  int wi = i / 6;
  uint w = wi == 0 ? ${W[0]}u : (wi == 1 ? ${W[1]}u : (wi == 2 ? ${W[2]}u : (wi == 3 ? ${W[3]}u : (wi == 4 ? ${W[4]}u : ${W[5]}u))));
  return int((w >> uint(5 * (i - wi * 6))) & 31u);
}`;
})()}
vec4 qmul(vec4 a, vec4 b) {
  return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
vec4 qaxis(int i, float ang) {
  float s = sin(0.5 * ang), c = cos(0.5 * ang);
  return i == 0 ? vec4(s, 0.0, 0.0, c) : (i == 1 ? vec4(0.0, s, 0.0, c) : vec4(0.0, 0.0, s, c));
}
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
`;
}

// ------------------------------------------------------------------------------------------ field object
export function createField(shapeInfo, heroShapeInfo) {
  const basis = new THREE.Matrix3(); // columns: A (lateral), B (lateral), D (path)
  const basisT = new THREE.Matrix3();
  const origin = new THREE.Vector3(2.7 * 23481.07, 0, 0);
  const axA = new THREE.Vector3(), axB = new THREE.Vector3(), axD = new THREE.Vector3(0, 0, -1);
  const heroes = [];
  const camLocal = new THREE.Vector3();
  const tmpV = new THREE.Vector3();

  function toLocal(u, out) {
    tmpV.copy(u).sub(origin);
    return out.set(tmpV.dot(axA), tmpV.dot(axB), tmpV.dot(axD));
  }
  function localToWorldDir(a, b, s, out) {
    return out.set(0, 0, 0).addScaledVector(axA, a).addScaledVector(axB, b).addScaledVector(axD, s);
  }

  function setCrossing(position, direction) {
    origin.copy(position);
    axD.copy(direction).normalize();
    // right-handed local basis (A x B = D): B = ecliptic north made perpendicular to the path, A = B x D
    axB.set(0, 1, 0).addScaledVector(axD, -axD.y);
    if (axB.lengthSq() < 1e-8) axB.set(1, 0, 0).addScaledVector(axD, -axD.x);
    axB.normalize();
    axA.crossVectors(axB, axD).normalize();
    basis.set(axA.x, axB.x, axD.x, axA.y, axB.y, axD.y, axA.z, axB.z, axD.z);
    basisT.copy(basis).transpose();
    buildHeroes();
  }

  // ---- hero set pieces, composed for the inspection views and the director's pass
  function buildHeroes() {
    heroes.length = 0;
    const sunDirAt = (s) => {
      // direction from a field point toward the Sun, in local coords
      const p = tmpV.copy(origin).addScaledVector(axD, s).negate().normalize();
      return new THREE.Vector3(p.dot(axA), p.dot(axB), p.dot(axD));
    };
    // view direction used by main.js body view (yaw about world up, then pitch) -> local
    const viewDirLocal = (yawDeg, elDeg) => {
      const up = new THREE.Vector3(0, 1, 0);
      const d = axD.clone().applyAxisAngle(up, (yawDeg * Math.PI) / 180);
      d.applyAxisAngle(new THREE.Vector3().crossVectors(d, up).normalize(), (elDeg * Math.PI) / 180);
      return new THREE.Vector3(d.dot(axA), d.dot(axB), d.dot(axD));
    };
    const camS = (dist) => -dist * 50;
    // place a hero so that, seen from camera point s0 along view v, it sits at screen offset (sx, sy) (in view
    // fractions of the tangent) at distance dist, and is lit at a pleasing phase angle if we have a choice
    const place = (s0, v, dist, sx, sy) => {
      const fwd = v.clone().normalize();
      const right = new THREE.Vector3(0, 1, 0).cross(fwd); // local "B" is roughly up; build screen axes
      const upL = new THREE.Vector3(0, 1, 0);
      right.crossVectors(fwd, upL).normalize();
      const up2 = new THREE.Vector3().crossVectors(right, fwd).normalize();
      const p = fwd.clone().addScaledVector(right, sx).addScaledVector(up2, sy).normalize().multiplyScalar(dist);
      p.z += s0;
      return p;
    };
    const add = (o) => heroes.push(o);
    // choose among framing candidates the one whose phase angle (Sun-rock-camera) is closest to `target`, so
    // the hero shows a sculpted terminator whatever direction the director's crossing has
    const placeLit = (s0, v, dist, target, cands) => {
      const L = sunDirAt(s0);
      let best = null;
      for (const [sx, sy, pen = 0] of cands) {
        const p = place(s0, v, dist, sx, sy);
        const u = p.clone().setZ(p.z - s0).normalize();
        const alpha = (Math.acos(Math.max(-1, Math.min(1, -L.dot(u)))) * 180) / Math.PI;
        const score = Math.abs(alpha - target) + pen;
        if (!best || score < best.score) best = { p, score, alpha };
      }
      return best.p;
    };
    const grid = (xs, ys) => xs.flatMap((x) => ys.map((y) => [x, y, Math.abs(y) * 12 + Math.abs(Math.abs(x) - 0.38) * 10]));
    // H0: Eros-like hero, foreground of the in-field view (dist=0.6 -> s=-30)
    {
      const v = viewDirLocal(0, 0);
      const p = placeLit(camS(0.6), v, 0.105, 72, grid([-0.52, -0.4, -0.3, 0.3, 0.4, 0.52], [-0.2, -0.08, 0.1]));
      add({ hero: 0, a: p.x, b: p.y, s: p.z, scale: 0.0118, periodH: 5.27, tilt: 0.5, type: 1, albedo: 0.25, seedQ: 11 });
    }
    // H1: Itokawa-like rubble pile met just after entering (camera at s=-65 looks at it)
    {
      const v = viewDirLocal(0, 0);
      const p = placeLit(camS(1.3), v, 0.33, 65, grid([-0.42, -0.3, -0.2, 0.2, 0.3, 0.42], [-0.12, 0.0, 0.1]));
      add({ hero: 1, a: p.x, b: p.y, s: p.z, scale: 0.0185, periodH: 12.13, tilt: 0.3, type: 1, albedo: 0.27, seedQ: 23 });
    }
    // H2: spinning-top binary for the 90-degree side view
    {
      const v = viewDirLocal(90, 0);
      const p = placeLit(camS(0.6), v, 0.16, 72, grid([-0.5, -0.36, -0.2, 0.2, 0.36, 0.5], [-0.14, 0.0, 0.12]));
      // Didymos-like: an S-type spinning top (2.26 h) with its moonlet (Dimorphos-like, 11.9 h orbit)
      add({ hero: 2, a: p.x, b: p.y, s: p.z, scale: 0.016, periodH: 2.26, tilt: 0.2, type: 1, albedo: 0.17, seedQ: 37, moon: { scale: 0.0034, aMul: 3.1, periodH: 11.9 } });
    }
    // H3: Ida-like potato with a small moon (Dactyl), for the 40-degree view
    {
      const v = viewDirLocal(40, 0);
      const p = placeLit(camS(0.6), v, 0.24, 72, grid([-0.45, -0.3, -0.16, 0.16, 0.3, 0.45], [-0.1, 0.04, 0.14]));
      add({ hero: 3, a: p.x, b: p.y, s: p.z, scale: 0.0145, periodH: 4.63, tilt: 0.7, type: 1, albedo: 0.22, seedQ: 41, moon: { scale: 0.0012, aMul: 4.2, periodH: 20 } });
    }
    // a large, rounder remnant of the parent body far ahead in the entering view (Vesta-like basin and troughs)
    {
      const v = viewDirLocal(0, 0);
      const p = placeLit(camS(1.3), v, 2.3, 60, grid([-0.34, -0.22, 0.22, 0.34], [0.08, 0.17]));
      add({ hero: 4, a: p.x, b: p.y, s: p.z, scale: 0.05, periodH: 5.34, tilt: 0.5, type: 3, albedo: 0.36, seedQ: 53 });
    }
    // set pieces at the crossing itself, where the director's pass is slowest, plus a few along the tube
    // [s, a, b, scale, hero shape, albedo, rotation period (h)]
    const extra = [
      [-1.6, 0.075, -0.03, 0.018, 0, 0.24, 5.27],
      [-0.5, -0.05, 0.035, 0.0085, 3, 0.2, 4.63],
      [0.7, -0.035, -0.05, 0.012, 2, 0.05, 4.3],
      [2.3, 0.06, 0.07, 0.016, 1, 0.26, 12.13],
      [4.5, -0.1, 0.02, 0.022, 3, 0.07, 8.4],
      [-6, -0.09, 0.04, 0.02, 1, 0.08, 9.1],
      [-18, 0.07, -0.05, 0.016, 0, 0.06, 6.1],
      [15, -0.06, -0.08, 0.019, 2, 0.06, 7.7],
      [27, 0.1, 0.02, 0.026, 0, 0.24, 10.2],
      [40, -0.04, 0.11, 0.015, 3, 0.15, 5.5],
    ];
    for (const [s, a, b, scale, hero, albedo, P] of extra) add({ hero, a, b, s, scale, periodH: P, tilt: 0.4, type: albedo < 0.1 ? (hero === 2 ? 4 : 0) : 1, albedo, seedQ: Math.floor(s * 7 + 100) });
    // local clusters of medium fragments around the set pieces, so every view direction has mid-ground rocks
    const clusters = [
      { s0: camS(0.6), n: 34, d0: 0.07, d1: 0.75, r0: 0.0017, r1: 0.0075, seed: 9101 },
      { s0: 0.4, n: 26, d0: 0.08, d1: 0.9, r0: 0.0017, r1: 0.008, seed: 9202 },
      { s0: camS(1.3) + 3.5, n: 26, d0: 0.7, d1: 6.0, r0: 0.006, r1: 0.032, seed: 9303, forward: true },
    ];
    const statics = [];
    for (const K of clusters) {
      const rr = mulberry32(K.seed);
      let placed = 0;
      for (let tries = 0; placed < K.n && tries < K.n * 40; tries++) {
        let dx = rr() * 2 - 1, dy = rr() * 2 - 1, dz = rr() * 2 - 1;
        const l = Math.hypot(dx, dy, dz);
        if (l > 1 || l < 0.05) continue;
        dx /= l; dy /= l; dz /= l;
        if (K.forward) dz = Math.abs(dz) * 0.6 + 0.4 * Math.sign(dz || 1);
        const dist = K.d0 * Math.pow(K.d1 / K.d0, rr());
        const a = dx * dist, b = dy * dist, sz = K.s0 + dz * dist;
        const u = rr();
        const scale = Math.pow(Math.pow(K.r0, -2) - u * (Math.pow(K.r0, -2) - Math.pow(K.r1, -2)), -0.5);
        const shape = Math.floor(rr() * shapeInfo.length);
        const bound = shapeInfo[shape].boundR * 1.1 * scale;
        if (Math.hypot(a, b) < FIELD.corridor + bound + 0.012) continue;
        let ok = true;
        for (const o of [...heroes.map((H) => ({ a: H.a, b: H.b, s: H.s, bound: heroShapeInfo[H.hero].boundR * H.scale * (H.moon ? 1 + H.moon.aMul : 1) })), ...statics])
          if (Math.hypot(a - o.a, b - o.b, sz - o.s) < (bound + o.bound) * 1.15) ok = false;
        if (!ok) continue;
        statics.push({ a, b, s: sz, bound, scale, shape, h: (K.seed * 7919 + placed * 104729) >>> 0 });
        placed++;
      }
    }
    for (const st of statics) add({ cluster: true, ...st });
    for (const H of heroes) finalizeHero(H);
  }

  // build the rock record of a hero (or cluster fragment) descriptor
  function finalizeHero(H) {
    if (H.cluster) {
      const r = newRock();
      const h = H.h;
      r.h = h;
      r.a = H.a;
      r.b = H.b;
      r.s = H.s;
      r.scale = H.scale;
      r.shape = H.shape;
      r.stretch = [0.85 + 0.3 * rnd(h, 14), 0.85 + 0.3 * rnd(h, 15), 0.85 + 0.3 * rnd(h, 16)];
      r.bound = shapeInfo[H.shape].boundR * Math.max(...r.stretch) * H.scale;
      rockMaterialProps(h, r);
      const u1 = rnd(h, 7), u2 = rnd(h, 8), u3 = rnd(h, 9);
      const s1 = Math.sqrt(1 - u1), s2 = Math.sqrt(u1);
      r.q0 = [s1 * Math.sin(2 * Math.PI * u2), s1 * Math.cos(2 * Math.PI * u2), s2 * Math.sin(2 * Math.PI * u3), s2 * Math.cos(2 * Math.PI * u3)];
      const Ph = 2.6 * Math.pow(9, rnd(h, 10));
      r.omega = ((2 * Math.PI) / (Ph * 3600)) * TIME_SCALE * (rnd(h, 11) < 0.5 ? 1 : -1);
      r.phase0 = rnd(h, 12) * 6.28;
      r.tumble = rnd(h, 13) < 0.15 ? 0.4 : 0;
      r.spinAxis = shapeInfo[H.shape].spinAxis;
      r.seed = rnd(h, 19);
      r.hero = -3;
      H.rock = r;
      return H;
    }
    const info = heroShapeInfo[H.hero];
    const h = (H.seedQ * 2654435761) >>> 0;
    const r = newRock();
    r.h = h;
    r.a = H.a;
    r.b = H.b;
    r.s = H.s;
    r.scale = H.scale;
    r.shape = H.hero;
    r.hero = H.hero;
    r.stretch = [1, 1, 1];
    r.bound = info.boundR * H.scale;
    const T = TYPES[H.type];
    r.type = H.type;
    r.albedo = H.albedo;
    r.color = T.tint.map((c) => c * H.albedo);
    const qq = new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd(h, 1) * 6.28, rnd(h, 2) * 6.28, rnd(h, 3) * 6.28));
    r.q0 = [qq.x, qq.y, qq.z, qq.w];
    r.omega = ((2 * Math.PI) / (H.periodH * 3600)) * TIME_SCALE * (rnd(h, 4) < 0.5 ? 1 : -1);
    r.phase0 = rnd(h, 5) * 6.28;
    r.tumble = 0;
    r.spinAxis = info.spinAxis;
    r.seed = rnd(h, 6);
    H.rock = r;
    if (H.moon) {
      const m = newRock();
      m.h = (h ^ 0xabcdef) >>> 0;
      m.scale = H.moon.scale;
      m.shape = 0;
      m.stretch = [1.1, 0.9, 0.85];
      m.bound = shapeInfo[0].boundR * 1.1 * m.scale;
      m.type = H.type;
      m.albedo = H.albedo * 0.9;
      m.color = r.color.map((c) => c * 0.9);
      m.q0 = [0, 0, 0, 1];
      m.omega = ((2 * Math.PI) / (H.moon.periodH * 3600)) * TIME_SCALE; // synchronous rotation
      m.phase0 = 0;
      m.spinAxis = 2;
      m.seed = 0.77;
      m.hero = -2;
      H.moonRock = m;
      H.moonA = H.moon.aMul * H.scale;
    }
    return H;
  }

  /** Add a hero after setCrossing (e.g. the director-framed beats); returns it. */
  function addHero(H) {
    heroes.push(H);
    return finalizeHero(H);
  }

  // keep every hero clear of the director's sampled path (deterministic nudge, applied once)
  function clearHeroesFromPath() {
    for (const H of heroes) {
      const r = H.rock;
      const x = (r.s - PATH_S0) / PATH_DS;
      if (!PATH.on || x < 0 || x > PATH_N - 1) continue;
      const i = Math.min(PATH_N - 2, Math.floor(x)), f = x - i;
      const pa = PATH.ab[i * 2] + (PATH.ab[i * 2 + 2] - PATH.ab[i * 2]) * f;
      const pb = PATH.ab[i * 2 + 1] + (PATH.ab[i * 2 + 3] - PATH.ab[i * 2 + 1]) * f;
      const need = r.bound + (H.moonA ? H.moonA + H.moonRock.bound : 0) + 0.016;
      let da = r.a - pa, db = r.b - pb;
      const d = Math.hypot(da, db);
      if (d >= need) continue;
      if (d < 1e-6) { da = 1; db = 0; } else { da /= d; db /= d; }
      r.a = pa + da * need;
      r.b = pb + db * need;
      H.a = r.a;
      H.b = r.b;
    }
  }

  // moonlet position (local) at time t: circular orbit, inclined 9 degrees
  function moonPos(H, t, out) {
    const m = H.moonRock;
    const ang = m.omega * t + 1.3;
    const R = H.moonA;
    const ci = Math.cos(0.16), si = Math.sin(0.16);
    const x = R * Math.cos(ang), y = R * Math.sin(ang);
    return out.set(H.a + x, H.b + y * ci, H.s + y * si);
  }

  // ---- iterate rocks (all classes) within radius `range(cls)` of local point p
  // Accepted rocks per lattice cell are cached (they are a pure function of the cell), so a slowly moving
  // camera only pays for cells that newly enter its range. Least-recently-used cells are evicted.
  const caches = CLASSES.map(() => new Map());
  let stamp = 0;
  const R = newRock();
  function cellRocks(c, ix, iy, iz) {
    // 30-bit small-integer key (fast Map path); the entry stores its true cell, so wrap-around aliases of
    // cells 1024 apart are detected and regenerated
    const key = (ix & 1023) | ((iy & 1023) << 10) | ((iz & 1023) << 20);
    const cache = caches[c];
    let e = cache.get(key);
    if (e && e.ix === ix && e.iy === iy && e.iz === iz) {
      e.stamp = stamp;
      return e.rocks;
    }
    const rocks = [];
    for (let j = 0; j < CLASSES[c].M; j++) {
      const r = genRock(c, ix, iy, iz, j, shapeInfo, newRock());
      if (r) rocks.push(r);
    }
    cache.set(key, { ix, iy, iz, stamp, rocks });
    return rocks;
  }
  function trimCache(max = 20000) {
    for (const cache of caches) {
      if (cache.size <= max) continue;
      for (const [k, e] of cache) if (stamp - e.stamp > 4) cache.delete(k);
    }
  }
  function clearCache() {
    for (const cache of caches) cache.clear();
  }
  function forEachRockNear(p, rangeFn, cb, cellFilter, rockFilter, useCache = false) {
    stamp++;
    for (let c = 0; c < NCLASS; c++) {
      const C = CLASSES[c];
      const range = rangeFn(C);
      if (range <= 0) continue;
      // slab bounding box test
      if (slabDistance(p.x, p.y, p.z) > range) continue;
      const x0 = Math.floor((Math.max(p.x - range, -FIELD.halfWidth)) / C.cell), x1 = Math.floor((Math.min(p.x + range, FIELD.halfWidth)) / C.cell);
      const y0 = Math.floor((Math.max(p.y - range, -FIELD.halfHeight)) / C.cell), y1 = Math.floor((Math.min(p.y + range, FIELD.halfHeight)) / C.cell);
      const z0 = Math.floor((Math.max(p.z - range, -FIELD.halfLength - FIELD.tail)) / C.cell), z1 = Math.floor((Math.min(p.z + range, FIELD.halfLength + FIELD.tail)) / C.cell);
      const r2 = range * range, cs = C.cell;
      // incremental camera-space cell centres for the frustum test (cellFilter = {m: local->camera 3x3, ...})
      const F = cellFilter && cellFilter.m ? cellFilter : null;
      let m, w0x, w0y, w0z, cr, tX, tY, cX, cY;
      if (F) {
        m = F.m;
        w0x = -(m[0] * p.x + m[3] * p.y + m[6] * p.z);
        w0y = -(m[1] * p.x + m[4] * p.y + m[7] * p.z);
        w0z = -(m[2] * p.x + m[5] * p.y + m[8] * p.z);
        cr = cs * 0.87 + C.r * F.boundFactor;
        tX = F.tanX; tY = F.tanY; cX = cr / F.cosX; cY = cr / F.cosY;
      }
      for (let ix = x0; ix <= x1; ix++) {
        const dx = Math.max(0, Math.max(ix * cs - p.x, p.x - (ix + 1) * cs));
        for (let iy = y0; iy <= y1; iy++) {
          const dy = Math.max(0, Math.max(iy * cs - p.y, p.y - (iy + 1) * cs));
          const rem = r2 - dx * dx - dy * dy;
          if (rem < 0) continue;
          // z extent of this column inside the range sphere
          const hz = Math.sqrt(rem);
          let za = Math.max(z0, Math.floor((p.z - hz) / cs)), zb = Math.min(z1, Math.floor((p.z + hz) / cs));
          let vx = 0, vy = 0, vz = 0;
          if (F) {
            // camera-space centre is linear in iz: v(iz) = v0 + (iz - za) * m2*cs. Clip [za, zb] against the
            // five frustum planes analytically, so only visible cells are visited.
            const cx = (ix + 0.5) * cs, cy = (iy + 0.5) * cs, cz = (za + 0.5) * cs;
            vx = w0x + m[0] * cx + m[3] * cy + m[6] * cz;
            vy = w0y + m[1] * cx + m[4] * cy + m[7] * cz;
            vz = w0z + m[2] * cx + m[5] * cy + m[8] * cz;
            const sx = m[6] * cs, sy = m[7] * cs, sz = m[8] * cs;
            let tlo = 0, thi = zb - za;
            // five planes a . (v0 + t s) <= b: in front, right, left, top, bottom
            for (let pl = 0; pl < 5; pl++) {
              let k, c0;
              if (pl === 0) { k = sz; c0 = cr - vz; }
              else if (pl === 1) { k = sx + sz * tX; c0 = cX - (vx + vz * tX); }
              else if (pl === 2) { k = -sx + sz * tX; c0 = cX - (-vx + vz * tX); }
              else if (pl === 3) { k = sy + sz * tY; c0 = cY - (vy + vz * tY); }
              else { k = -sy + sz * tY; c0 = cY - (-vy + vz * tY); }
              if (k > 1e-12) thi = Math.min(thi, Math.floor(c0 / k));
              else if (k < -1e-12) tlo = Math.max(tlo, Math.ceil(c0 / k));
              else if (c0 < 0) thi = -1;
            }
            if (thi < tlo) continue;
            vx += sx * tlo; vy += sy * tlo; vz += sz * tlo;
            za += tlo;
            zb = za + (thi - tlo);
          }
          for (let iz = za; iz <= zb; iz++) {
            if (F && iz > za) { vx += m[6] * cs; vy += m[7] * cs; vz += m[8] * cs; }
            const dz = Math.max(0, Math.max(iz * cs - p.z, p.z - (iz + 1) * cs));
            if (dx * dx + dy * dy + dz * dz > r2) continue;
            if (cellFilter && !F && !cellFilter(C, ix, iy, iz)) continue;
            if (useCache) {
              const rocks = cellRocks(c, ix, iy, iz);
              for (let k = 0; k < rocks.length; k++) {
                const r = rocks[k];
                if (!rockFilter || rockFilter(r.a, r.b, r.s, r.bound)) cb(r);
              }
            } else
              for (let j = 0; j < C.M; j++) {
                const r = genRock(c, ix, iy, iz, j, shapeInfo, R, rockFilter);
                if (r) cb(r);
              }
          }
        }
      }
    }
    if (useCache) trimCache();
  }

  const tmpL = new THREE.Vector3();
  // Conservative distance from the camera to the nearest rock surface (never larger than the truth, so the
  // near plane can't clip a rock): heroes exactly, lattice rocks within one cell, a lower bound beyond.
  function nearestDistance(camU, t = 0) {
    toLocal(camU, tmpL);
    let best = Infinity;
    for (const H of heroes) {
      const r = H.rock;
      best = Math.min(best, Math.hypot(tmpL.x - r.a, tmpL.y - r.b, tmpL.z - r.s) - r.bound);
      if (H.moonRock) {
        // time-independent lower bound: distance to the moonlet's orbital sphere shell
        const dc = Math.hypot(tmpL.x - r.a, tmpL.y - r.b, tmpL.z - r.s);
        best = Math.min(best, Math.abs(dc - H.moonA) - H.moonRock.bound);
      }
    }
    // distance to the slab (lattice rocks only exist inside it)
    const tube = slabDistance(tmpL.x, tmpL.y, tmpL.z, 1) - 0.1;
    if (tube > 0.5) return Math.max(1e-6, Math.min(best, tube));
    let bound = Infinity;
    for (const C of CLASSES) bound = Math.min(bound, C.cell - C.r * 6);
    forEachRockNear(tmpL, (C) => C.cell, (r) => {
      const d = Math.hypot(tmpL.x - r.a, tmpL.y - r.b, tmpL.z - r.s) - r.bound;
      if (d < best) best = d;
    }, null, null, true);
    return Math.max(1e-6, Math.min(best, bound));
  }

  return {
    origin,
    axA,
    axB,
    axD,
    basis,
    heroes,
    camLocal,
    setCrossing,
    toLocal,
    localToWorldDir,
    forEachRockNear,
    clearCache,
    nearestDistance,
    moonPos,
    clearHeroesFromPath,
    addHero,
  };
}
