// Simplex noise with analytic derivatives + footprint-filtered fbm. Requires NOISE_GLSL (mod289, permute,
// taylorInvSqrt) to be included first. Derivative form after Ian McEwan / Stefan Gustavson (MIT).
export const NOISE_D_GLSL = /* glsl */ `
#ifndef NOISE_D_GLSL
#define NOISE_D_GLSL
// loops are bounded by a uniform (= 64) so the D3D shader compiler cannot unroll them at every call site
// (constant-bound loops made the Earth shader take ~40 s to compile under ANGLE/D3D11)
#ifndef U_LOOPMAX
#define U_LOOPMAX
uniform int uLoopMax;
#endif
// returns vec4(value, d/dx, d/dy, d/dz); value in ~[-1, 1]
vec4 snoised(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 m2 = m * m;
  vec4 m4 = m2 * m2;
  vec4 pdotx = vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3));
  vec4 temp = m2 * m * pdotx;
  vec3 grad = -8.0 * (temp.x * x0 + temp.y * x1 + temp.z * x2 + temp.w * x3);
  grad += m4.x * p0 + m4.y * p1 + m4.z * p2 + m4.w * p3;
  return 42.0 * vec4(dot(m4, pdotx), grad);
}

// fbm with derivatives; gdecay additionally weights the gradient of octave i by gdecay^i (so bump maps can be
// dominated by the larger features while the value keeps its fine detail). fp = pixel footprint in the units of p. Octaves whose features are smaller than
// ~2.5 px fade out (to the noise mean, 0), so there is no shimmer at any distance.
// Returns vec4(value, gradient w.r.t. p).
vec4 fbmd2(vec3 p, float fp, int maxOct, float lac, float gain, float gdecay) {
  vec4 s = vec4(0.0);
  float a = 0.5, f = 1.0, gd = 1.0;
  for (int i = 0; i < uLoopMax; i++) {
    if (i >= maxOct) break;
    float q = 1.0 / (f * fp);
    float w = clamp(q * 0.4 - 0.6, 0.0, 1.0);
    if (w <= 0.0) break;
    vec4 n = snoised(p * f + float(i) * vec3(1.7, 9.2, 3.1));
    s += a * w * vec4(n.x, n.yzw * (f * gd));
    a *= gain;
    f *= lac;
    gd *= gdecay;
  }
  return s;
}
vec4 fbmd(vec3 p, float fp, int maxOct, float lac, float gain) {
  return fbmd2(p, fp, maxOct, lac, gain, 1.0);
}
#endif
`;
