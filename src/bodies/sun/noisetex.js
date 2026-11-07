// A tileable, band-limited 3D noise volume (64^3, RGBA8: four independent gradient-noise channels), generated
// deterministically at start-up and sampled with hardware trilinear filtering + mipmaps.
//
// Why: Chrome on Windows compiles shaders through ANGLE -> HLSL -> FXC, which inlines every snoise() call; a
// shader with dozens of simplex-noise call sites takes seconds to build. One textureLod() fetch returns four
// decorrelated noise values for a handful of instructions, and its mip chain gives the footprint average for free.
//
// GLSL side (see SUN_NOISE_GLSL): tn4(p) returns four signed noises (std ~0.37, like snoise) with one "unit" being
// the lattice spacing (features ~1-2 units across, as for snoise(p)); the volume repeats every PERIOD units, so
// callers rotate / scale their lookups to hide the tiling.
import * as THREE from 'three';

export const NOISE_N = 64; // texels per side
export const NOISE_PERIOD = 12; // lattice cells per tile (tile = 12 noise units; 5.33 texels per unit)

// improved-Perlin style gradient noise with a lattice period, evaluated for a whole volume
function makeVolume(seed) {
  const N = NOISE_N, P = NOISE_PERIOD;
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  // random unit gradients on the periodic lattice
  const G = new Float32Array(P * P * P * 3);
  for (let i = 0; i < P * P * P; i++) {
    let x, y, z, l;
    do {
      x = rnd() * 2 - 1; y = rnd() * 2 - 1; z = rnd() * 2 - 1;
      l = x * x + y * y + z * z;
    } while (l > 1 || l < 0.05);
    l = 1 / Math.sqrt(l);
    G[i * 3] = x * l; G[i * 3 + 1] = y * l; G[i * 3 + 2] = z * l;
  }
  // per-axis lattice index / fraction / fade for every texel (the volume is a tensor grid)
  const ci = new Int32Array(N), cf = new Float32Array(N), cu = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = (i * P) / N;
    const fl = Math.floor(x);
    ci[i] = fl % P;
    cf[i] = x - fl;
    const f = cf[i];
    cu[i] = f * f * f * (f * (f * 6 - 15) + 10);
  }
  const out = new Float32Array(N * N * N);
  const g = (ix, iy, iz) => ((iz % P) * P * P + (iy % P) * P + (ix % P)) * 3;
  let o = 0;
  for (let k = 0; k < N; k++) {
    const z0 = ci[k], fz = cf[k], wz = cu[k];
    for (let j = 0; j < N; j++) {
      const y0 = ci[j], fy = cf[j], wy = cu[j];
      for (let i = 0; i < N; i++) {
        const x0 = ci[i], fx = cf[i], wx = cu[i];
        let a, b, c, d;
        let q = g(x0, y0, z0); const n000 = G[q] * fx + G[q + 1] * fy + G[q + 2] * fz;
        q = g(x0 + 1, y0, z0); const n100 = G[q] * (fx - 1) + G[q + 1] * fy + G[q + 2] * fz;
        q = g(x0, y0 + 1, z0); const n010 = G[q] * fx + G[q + 1] * (fy - 1) + G[q + 2] * fz;
        q = g(x0 + 1, y0 + 1, z0); const n110 = G[q] * (fx - 1) + G[q + 1] * (fy - 1) + G[q + 2] * fz;
        q = g(x0, y0, z0 + 1); const n001 = G[q] * fx + G[q + 1] * fy + G[q + 2] * (fz - 1);
        q = g(x0 + 1, y0, z0 + 1); const n101 = G[q] * (fx - 1) + G[q + 1] * fy + G[q + 2] * (fz - 1);
        q = g(x0, y0 + 1, z0 + 1); const n011 = G[q] * fx + G[q + 1] * (fy - 1) + G[q + 2] * (fz - 1);
        q = g(x0 + 1, y0 + 1, z0 + 1); const n111 = G[q] * (fx - 1) + G[q + 1] * (fy - 1) + G[q + 2] * (fz - 1);
        a = n000 + (n100 - n000) * wx;
        b = n010 + (n110 - n010) * wx;
        c = n001 + (n101 - n001) * wx;
        d = n011 + (n111 - n011) * wx;
        a += (b - a) * wy;
        c += (d - c) * wy;
        out[o++] = a + (c - a) * wz;
      }
    }
  }
  // normalise to zero mean, std 0.37 (like snoise)
  let m = 0, v = 0;
  for (let i = 0; i < out.length; i++) m += out[i];
  m /= out.length;
  for (let i = 0; i < out.length; i++) v += (out[i] - m) ** 2;
  const sc = 0.37 / Math.sqrt(v / out.length);
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - m) * sc;
  return out;
}

let cached = null;
export function sunNoiseTexture() {
  if (cached) return cached;
  const N = NOISE_N;
  const data = new Uint8Array(N * N * N * 4);
  for (let c = 0; c < 4; c++) {
    const v = makeVolume(0x51ed + c * 7919);
    for (let i = 0; i < v.length; i++) data[i * 4 + c] = Math.max(0, Math.min(255, Math.round((v[i] * 0.5 + 0.5) * 255)));
  }
  const tex = new THREE.Data3DTexture(data, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  cached = tex;
  return tex;
}

// GLSL helpers. p in noise units; lod in mip levels (0 = full resolution; +1 per doubling of the footprint).
// Every lookup is an explicit-LOD fetch, so it is legal (and cheap to compile) inside dynamic loops.
export const SUN_NOISE_GLSL = /* glsl */ `
uniform highp sampler3D uNoise3;
const float NOISE_TS = ${(1 / NOISE_PERIOD).toFixed(8)};   // texture coordinate per noise unit
const float NOISE_TEX = ${(NOISE_N / NOISE_PERIOD).toFixed(6)}; // texels per noise unit
// four signed noises (std ~0.37) at p
vec4 tn4(vec3 p) { return textureLod(uNoise3, p * NOISE_TS, 0.0) * 2.0 - 1.0; }
// the same, prefiltered over a footprint fp (noise units): fades to the mean as features shrink below a pixel
vec4 tn4f(vec3 p, float fp) { return textureLod(uNoise3, p * NOISE_TS, log2(max(fp * NOISE_TEX, 1.0))) * 2.0 - 1.0; }
float tn(vec3 p) { return tn4(p).x; }
`;

// Hashes (Dave Hoskins, "hash without sine", MIT), the same as src/glsl/noise.js; skipped when that is included.
export const SUN_HASH_GLSL = /* glsl */ `
#ifndef NOISE_GLSL
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec2 hash23(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
#endif
`;
