// Shared GLSL for the Jupiter system: simplex noise with analytic gradient, eclipse (disc-overlap) shadows,
// Chapman grazing-incidence function and small helpers.
export const JUP_COMMON = /* glsl */ `
#ifndef JUP_COMMON
#define JUP_COMMON
#define PI 3.14159265359
#define TAU 6.28318530718

float hash13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }
vec3 hash33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

// 3D simplex noise (Ashima/McEwan, MIT) with analytic gradient: returns (n, dn/dx, dn/dy, dn/dz), n in [-1,1].
vec4 snoiseD(vec3 v) {
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

float snoise(vec3 v) { return snoiseD(v).x; }

// Fraction of the solar disc (angular radius a) hidden by a disc of angular radius b at centre separation c.
float discOverlap(float a, float b, float c) {
  if (c >= a + b) return 0.0;
  if (c <= abs(a - b)) return min(1.0, (b * b) / (a * a));
  float a2 = a * a, b2 = b * b, c2 = c * c;
  float k1 = a2 * acos(clamp((c2 + a2 - b2) / (2.0 * c * a), -1.0, 1.0));
  float k2 = b2 * acos(clamp((c2 + b2 - a2) / (2.0 * c * b), -1.0, 1.0));
  float k3 = 0.5 * sqrt(max(0.0, (-c + a + b) * (c + a - b) * (c - a + b) * (c + a + b)));
  return clamp((k1 + k2 - k3) / (PI * a2), 0.0, 1.0);
}

// Sunlight fraction at point p (any frame) from a spherical occluder at o with radius r; sun centre s, radius rs.
float sphereEclipse(vec3 p, vec3 s, float rs, vec3 o, float r) {
  vec3 ds = s - p;
  vec3 dm = o - p;
  float ls = length(ds), lm = length(dm);
  if (dot(ds, dm) <= 0.0 || lm < r) return 1.0;
  vec3 us = ds / ls, um = dm / lm;
  float c = atan(length(cross(us, um)), dot(us, um));
  float a = asin(clamp(rs / ls, 0.0, 1.0));
  float b = asin(clamp(r / lm, 0.0, 1.0));
  // solar limb darkening: the overlap of the bright centre matters more than the dim limb (u ~ 0.6)
  float f = discOverlap(a, b, c);
  float fc = discOverlap(a * 0.62, b, c);
  return 1.0 - clamp(mix(f, fc, 0.35), 0.0, 1.0);
}

// Cheap sunlight fraction behind a spherical occluder (~15 instructions instead of ~150 for the exact disc overlap):
// the covered fraction of the solar disc is a smoothstep of the normalised overlap depth, times the area ratio. The
// separation uses |cross| (exact at the tiny angles involved; 1 - cos would lose everything in float32).
float sphereShadow(vec3 p, vec3 s, float rs, vec3 o, float r) {
  vec3 ds = s - p, dm = o - p;
  float ls = length(ds), lm = length(dm);
  if (dot(ds, dm) <= 0.0 || lm < r) return 1.0;
  float c = length(cross(ds, dm)) / (ls * lm);
  float a = rs / ls, b = r / lm;
  float x = clamp((a + b - c) / (2.0 * min(a, b)), 0.0, 1.0);
  return 1.0 - x * x * (3.0 - 2.0 * x) * min(1.0, (b * b) / (a * a));
}

// Chapman grazing-incidence function (Schuler 2012 style). X = r / H, cosChi = cos(solar zenith at r).
// Returns the column relative to the vertical column at the same point (for cosChi >= 0).
float chapmanUpper(float X, float cosChi) {
  float c = sqrt(1.5707963 * X);
  return c / ((c - 1.0) * max(cosChi, 0.0) + 1.0);
}
#endif
`;
