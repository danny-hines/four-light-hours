// Shared tileable 3D gradient-noise texture for the Earth and Moon shaders.
//
// Why: ANGLE on Windows compiles GLSL through HLSL with FXC, which inlines every function call; each ALU simplex call
// site costs ~120 instructions of straight-line code and the compile time grows ~quadratically with the program size
// (20 call sites ~0.9 s, 40 ~2.9 s). A noise octave read from this texture is one textureLod: ~5 instructions.
//
// Content: periodic Perlin gradient noise with a quintic fade (C2), random unit lattice gradients, period 32 lattice
// cells across the texture (4 texels per cell, 128^3 RGBA16F = 16 MB), baked once on the GPU at startup (one tiny
// program, 128 layer draws, deterministic). rgba = (n, dn/dx, dn/dy, dn/dz) with x in lattice units; the value is
// scaled to std 0.373 (the std of the 3D simplex noise the octave amplitudes were tuned with), so it is a drop-in for
// snoise / snoised. Callers rotate every octave's domain (NOISE3_ROT) so the 32-cell period never lines up.
import * as THREE from 'three';

export const NOISE3_N = 128;
export const NOISE3_PERIOD = 32;
// std of raw periodic Perlin with unit gradients: 0.1915 (2^20 samples, dev/noise3stat.mjs) -> scaled to 0.373
const NORM = 0.373 / 0.1915;

const BAKE_VERT = /* glsl */ `
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const BAKE_FRAG = /* glsl */ `
precision highp float;
precision highp int;
uniform float uZ;
vec3 grad3(ivec3 c) {
  uvec3 u = uvec3(c & 31);
  uint h = u.x * 73856093u ^ u.y * 19349663u ^ u.z * 83492791u;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  uint h2 = h * 0x9e3779b9u; h2 ^= h2 >> 13; h2 *= 0x85ebca6bu; h2 ^= h2 >> 16;
  float z = 1.0 - 2.0 * float(h & 0xffffu) / 65535.0;
  float ph = 6.2831853 * float(h2 & 0xffffu) / 65536.0;
  float s = sqrt(max(0.0, 1.0 - z * z));
  return vec3(s * cos(ph), s * sin(ph), z);
}
void main() {
  vec3 x = vec3(gl_FragCoord.xy, uZ + 0.5) * (${NOISE3_PERIOD}.0 / ${NOISE3_N}.0);
  ivec3 i = ivec3(floor(x));
  vec3 f = x - vec3(i);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec3 ga = grad3(i), gb = grad3(i + ivec3(1, 0, 0)), gc = grad3(i + ivec3(0, 1, 0)), gd = grad3(i + ivec3(1, 1, 0));
  vec3 ge = grad3(i + ivec3(0, 0, 1)), gf = grad3(i + ivec3(1, 0, 1)), gg = grad3(i + ivec3(0, 1, 1)), gh = grad3(i + ivec3(1, 1, 1));
  float va = dot(ga, f), vb = dot(gb, f - vec3(1, 0, 0)), vc = dot(gc, f - vec3(0, 1, 0)), vd = dot(gd, f - vec3(1, 1, 0));
  float ve = dot(ge, f - vec3(0, 0, 1)), vf = dot(gf, f - vec3(1, 0, 1)), vg = dot(gg, f - vec3(0, 1, 1)), vh = dot(gh, f - vec3(1, 1, 1));
  float k1 = vb - va, k2 = vc - va, k3 = ve - va, k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf;
  float k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  float n = va + u.x * k1 + u.y * k2 + u.z * k3 + u.x * u.y * k4 + u.y * u.z * k5 + u.z * u.x * k6 + u.x * u.y * u.z * k7;
  vec3 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd)
         + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf) + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh);
  g += du * vec3(k1 + u.y * k4 + u.z * k6 + u.y * u.z * k7, k2 + u.z * k5 + u.x * k4 + u.z * u.x * k7, k3 + u.x * k6 + u.y * k5 + u.x * u.y * k7);
  gl_FragColor = vec4(n, g) * ${NORM.toFixed(6)};
}
`;

let cached = null;
/** Bake (once per renderer) and return the shared noise texture. */
export function getNoise3D(renderer) {
  if (cached && cached.renderer === renderer) return cached.texture;
  const N = NOISE3_N;
  const rt = new THREE.WebGL3DRenderTarget(N, N, N, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false });
  const tex = rt.texture;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const mat = new THREE.ShaderMaterial({ vertexShader: BAKE_VERT, fragmentShader: BAKE_FRAG, uniforms: { uZ: { value: 0 } }, depthTest: false, depthWrite: false });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const quad = new THREE.Mesh(g, mat);
  quad.frustumCulled = false;
  const scene = new THREE.Scene();
  scene.add(quad);
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const prev = renderer.getRenderTarget();
  const prevAuto = renderer.autoClear;
  renderer.autoClear = false;
  for (let z = 0; z < N; z++) {
    mat.uniforms.uZ.value = z;
    renderer.setRenderTarget(rt, z);
    renderer.render(scene, cam);
  }
  renderer.setRenderTarget(prev);
  renderer.autoClear = prevAuto;
  mat.dispose();
  g.dispose();
  cached = { renderer, texture: tex, rt };
  return tex;
}

// GLSL helpers (included by the Earth and Moon shaders). tn(x): noise value + gradient at x (lattice units).
// fbmT: footprint-filtered fbm with derivatives (the replacement for fbmd2): every octave's domain is rotated by
// NOISE3_ROT and offset, so neither the texture period nor the lattice axes line up between octaves.
export const NOISE3_GLSL = /* glsl */ `
#ifndef NOISE3_GLSL
#define NOISE3_GLSL
uniform highp sampler3D uNoise3;
#ifndef U_LOOPMAX
#define U_LOOPMAX
uniform int uLoopMax;
#endif
vec4 tn(vec3 x) { return textureLod(uNoise3, x * ${(1 / NOISE3_PERIOD).toFixed(6)}, 0.0); }
// rotation by 1.1 rad about the skew axis (1, 2, 0.5)
const mat3 NOISE3_ROT = mat3(0.557673, 0.402631, -0.725871, 0.013676, 0.869904, 0.493032, 0.829948, -0.284878, 0.479615);
// returns vec4(value, gradient w.r.t. p); octave i fades once its features are under ~2.5 px. Odd octaves are rotated
// (NOISE3_ROT) and the lacunarity should be non-integer, so octave periods and lattice axes never line up.
vec4 fbmT(vec3 p, float fp, int maxOct, float lac, float gain) {
  vec4 s = vec4(0.0);
  float a = 0.5, f = 1.0;
  for (int i = 0; i < uLoopMax; i++) {
    if (i >= maxOct) break;
    float w = clamp(0.4 / (f * fp) - 0.6, 0.0, 1.0);
    if (w <= 0.0) break;
    bool odd = (i & 1) == 1;
    vec3 x = p * f + float(i) * vec3(5.7, 9.2, 3.1);
    vec4 n = tn(odd ? NOISE3_ROT * x : x);
    s += a * w * vec4(n.x, (odd ? n.yzw * NOISE3_ROT : n.yzw) * f);
    a *= gain;
    f *= lac;
  }
  return s;
}
#endif
`;
