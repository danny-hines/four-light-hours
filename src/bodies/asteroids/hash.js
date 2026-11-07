// Integer hashing shared bit-for-bit between JavaScript (CPU field enumeration, nearestDistance) and GLSL
// (GPU point-rock and dust lattices). Both sides must agree exactly on which rocks exist and where, so every
// random quantity of a rock is derived from 32-bit PCG hashes of its cell coordinates.

/** PCG-RXS-M-XS 32-bit hash (Jarzynski & Olano 2020). Input/output: uint32 as a JS number. */
export function pcg(v) {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Hash of an integer cell (ix, iy, iz) plus a salt (class, slot, seed...). */
export function hashCell(ix, iy, iz, salt) {
  return pcg(((ix >>> 0) + pcg(((iy >>> 0) + pcg(((iz >>> 0) + pcg(salt >>> 0)) >>> 0)) >>> 0)) >>> 0);
}

/** 24-bit uniform float in [0, 1) from a hash. */
export function u01(h) {
  return (h >>> 8) / 16777216;
}

/** The i-th derived uniform of a base hash. */
export function rnd(h, i) {
  return u01(pcg((h + Math.imul(i, 0x9e3779b9)) >>> 0));
}

/** Deterministic PRNG (mulberry32) for load-time generation. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Quintic-smoothed value noise in [-1, 1] on the integer lattice, hashed with pcg (matches GLSL vnoiseH). */
export function vnoiseH(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const h = (a, b, c) => u01(hashCell(ix + a, iy + b, iz + c, seed));
  const x00 = h(0, 0, 0) + (h(1, 0, 0) - h(0, 0, 0)) * ux;
  const x10 = h(0, 1, 0) + (h(1, 1, 0) - h(0, 1, 0)) * ux;
  const x01 = h(0, 0, 1) + (h(1, 0, 1) - h(0, 0, 1)) * ux;
  const x11 = h(0, 1, 1) + (h(1, 1, 1) - h(0, 1, 1)) * ux;
  const y0 = x00 + (x10 - x00) * uy;
  const y1 = x01 + (x11 - x01) * uy;
  return (y0 + (y1 - y0) * uz) * 2 - 1;
}

export const HASH_GLSL = /* glsl */ `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
uint hashCell(ivec3 c, uint salt) {
  return pcg(uint(c.x) + pcg(uint(c.y) + pcg(uint(c.z) + pcg(salt))));
}
float u01(uint h) { return float(h >> 8u) / 16777216.0; }
float rnd(uint h, uint i) { return u01(pcg(h + i * 0x9e3779b9u)); }
// Trilinear value noise over the 8 lattice corners as a LOOP with a uniform bound (uVN = 8): ANGLE/FXC inlines every
// call site and unrolls constant loops, so the old form put 8 hash chains (32 PCG rounds) at every call site and
// cost hundreds of ms of shader compile; this keeps one hash chain per call site. Same value as the nested lerps.
uniform int uVN;
float vnoiseH(vec3 p, uint seed) {
  vec3 fl = floor(p);
  ivec3 i = ivec3(fl);
  vec3 f = p - fl;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float acc = 0.0;
  for (int k = 0; k < uVN; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    vec3 w3 = mix(1.0 - u, u, vec3(o));
    acc += w3.x * w3.y * w3.z * u01(hashCell(i + o, seed));
  }
  return acc * 2.0 - 1.0;
}
`;
