// Shared constants and GLSL for the Neptune system (globe, haze, rings, Triton).
import { daysSinceJ2000 } from '../../core/astro.js';

// Time origin for every drifting feature (dark spots, streaks, ring arcs): 2026-11-02 12:00 UTC.
// Features are pure functions of (simDays - T0), so seek() is exact.
export const T0 = daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
export const KM_PER_UNIT = 6371;

export const COMMON_GLSL = /* glsl */ `
#ifndef NEP_COMMON
#define NEP_COMMON
#ifndef PI
#define PI 3.14159265359
#endif
#define TAU 6.28318530718

// Ray / sphere at the origin: (tNear, tFar); tNear > tFar on a miss. rd need not be normalised.
vec2 nepRaySphere(vec3 ro, vec3 rd, float r) {
  float a = dot(rd, rd);
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - a * c;
  if (h < 0.0) return vec2(1e20, -1e20);
  h = sqrt(h);
  return vec2((-b - h) / a, (-b + h) / a);
}

// Henyey-Greenstein phase function, normalised so that its mean over the sphere is 1.
float hg(float cosT, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * cosT, 1e-5), 1.5);
}

// Fraction of the solar disc visible from P past a sphere (centre C, radius Rs). L = unit dir to Sun.
float sphereShadow(vec3 P, vec3 L, float sunAng, vec3 C, float Rs) {
  vec3 oc = C - P;
  float tca = dot(oc, L);
  if (tca <= 0.0) return 1.0;
  float d = length(oc - L * tca);
  float pw = max(tca * sunAng, 1e-7);
  return smoothstep(Rs - pw, Rs + pw, d);
}
#endif
`;

// Value-noise lattice in a 64^3 RGBA8 3D texture (four independent channels), generated in code at create() time.
// One textureLod with a smoothstepped fractional coordinate is a C1 value noise: a single instruction for the
// shader compiler, where every inlined simplex call costs FXC (D3D) tens of milliseconds at the first draw.
export const VNOISE_GLSL = /* glsl */ `
#ifndef NEP_VNOISE
#define NEP_VNOISE
uniform highp sampler3D uNoiseTex;
// four independent C1 value noises in [-1, 1] (std ~0.37); lattice period 64
vec4 vn4(vec3 p) {
  vec3 i = floor(p);
  vec3 f = p - i;
  f = f * f * (3.0 - 2.0 * f);
  i = mod(i, 64.0);
  return textureLod(uNoiseTex, (i + f + 0.5) * 0.015625, 0.0) * 2.0 - 1.0;
}
#endif
`;
let _noiseTex = null;
export function noiseTexture(THREE) {
  if (_noiseTex) return _noiseTex;
  const N = 64;
  const data = new Uint8Array(N * N * N * 4);
  const r = rng(0x9e3779b1);
  for (let i = 0; i < data.length; i++) data[i] = Math.floor(r() * 256);
  const t = new THREE.Data3DTexture(data, N, N, N);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.unpackAlignment = 1;
  t.needsUpdate = true;
  _noiseTex = t;
  return t;
}

/** A sphere with positions only (the shaders derive everything from the position): normals and UVs dropped, so the
 * first draw uploads a third of the data. */
export function positionSphere(THREE, r, w, h) {
  const g = new THREE.SphereGeometry(r, w, h);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  return g;
}

/** Small seeded PRNG (mulberry32) for build-time feature layout (deterministic). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Neptune zonal wind (m/s), Sromovsky et al. (1993) polynomial fit, tapered to zero at the poles. */
export function windU(latDeg) {
  const p2 = latDeg * latDeg;
  const u = -398 + 0.188 * p2 - 1.2e-5 * p2 * p2;
  const x = Math.min(1, Math.max(0, (Math.abs(latDeg) - 72) / 18));
  return u * (1 - x * x * (3 - 2 * x));
}
/** Angular drift rate (rad/day) relative to the 16.11 h interior rotation at a latitude (deg). */
export function windOmega(latDeg, radiusKm = 24764) {
  // poleward of 76 deg the polar vortex turns as a near-solid body: hold the 76-deg angular rate (matches globe.js)
  const L = Math.max(-76, Math.min(76, latDeg));
  return (windU(L) * 86400) / (radiusKm * 1000 * Math.cos((L * Math.PI) / 180));
}
