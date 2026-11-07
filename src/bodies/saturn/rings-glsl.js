// Shared GLSL for Saturn: ring-profile sampling (footprint-filtered), ring photometry, analytic shadows.
// All geometry is in Saturn-centred frames measured in equatorial radii (a = 1), +y = north pole.
// The body (spinning) frame and the ring (pole) frame differ only by a rotation about y, so ring-plane
// intersections and planet shadows are the same functions in either frame.
import { RING_R0, RING_R1, PROF_W, FINE_W, KM_PER_TEXEL } from './rings-data.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const RING_GLSL = /* glsl */ `
#ifndef SAT_RING_GLSL
#define SAT_RING_GLSL
#define SAT_RKM 60268.0
#define RING_R0 ${f(RING_R0)}
#define RING_R1 ${f(RING_R1)}
#define RING_W ${f(PROF_W)}
#define RING_KMPT ${KM_PER_TEXEL.toFixed(6)}
#define FINE_W ${FINE_W}
#ifndef PI
#define PI 3.14159265359
#endif

uniform sampler2D uRingProf;   // averages of exp(-tau*m), m = 1, m0, 4, 16
uniform sampler2D uRingAlb;    // rgb particle albedo, a dust fraction
uniform highp sampler2D uRingFine; // tau at 1 / 2 / 4 km (nearest)
uniform float uRingM0;         // 1/mu0
uniform float uRingFineN;      // number of 1 km samples
uniform float uSunAngR;        // solar angular radius (rad)
// Never set (WebGL initialises uniforms to 0). Loop bounds are written 'N + uSatZero' so FXC (ANGLE's D3D11
// back end) cannot see a constant trip count and keeps a real loop instead of unrolling and inlining the body N
// times -- that kept compile times of the big Saturn shaders at several seconds each.
uniform int uSatZero;

float ringU(float rkm) { return (rkm - RING_R0) / (RING_R1 - RING_R0); }
float ringLod(float fpKm) { return log2(max(fpKm, 1e-3) / RING_KMPT); }

// effective optical depths (at m = 1, 4, m0, 16) from the filtered transmission channels
vec4 ringTaus(vec4 E) {
  vec4 Em = max(E, vec4(1e-7));
  return min(vec4(-log(Em.x), -log(Em.z) * 0.25, -log(Em.y) / uRingM0, -log(Em.w) / 16.0), vec4(9.0));
}
// tau_eff(m): piecewise-linear in log2(m) through the knots (1, t1) (4, t4) (m0, tm0) (16, t16)
float tauAt(vec4 T, float m) {
  float l = log2(max(m, 1.0));
  float l0 = log2(uRingM0);
  if (l <= 2.0) return mix(T.x, T.y, l * 0.5);
  if (l <= l0) return mix(T.y, T.z, clamp((l - 2.0) / max(l0 - 2.0, 1e-3), 0.0, 1.0));
  if (l <= 4.0) return mix(T.z, T.w, clamp((l - l0) / max(4.0 - l0, 1e-3), 0.0, 1.0));
  return T.w;
}

// fine profile: tau at 1 km, ~2 km, ~4 km, linearly interpolated (two texelFetch)
vec3 ringFine(float rkm) {
  float x = clamp(rkm - RING_R0, 0.0, uRingFineN - 2.0);
  float k = floor(x);
  float fr = x - k;
  int i0 = int(k), i1 = i0 + 1;
  vec3 a = texelFetch(uRingFine, ivec2(i0 % FINE_W, i0 / FINE_W), 0).rgb;
  vec3 b = texelFetch(uRingFine, ivec2(i1 % FINE_W, i1 / FINE_W), 0).rgb;
  return mix(a, b, fr);
}

float satHash1(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
// 1D gradient noise in [-1, 1]
float gnoise1(float x) {
  float i = floor(x), fr = x - i;
  float g0 = satHash1(i) * 2.0 - 1.0, g1 = satHash1(i + 1.0) * 2.0 - 1.0;
  float u = fr * fr * (3.0 - 2.0 * fr);
  return 2.0 * mix(g0 * fr, g1 * (fr - 1.0), u);
}

// periodic 1D gradient noise (period K cells), for azimuth: x = phi / 2pi * K
float gnoise1p(float x, float K) {
  float i = floor(x), fr = x - i;
  float i0 = mod(i, K), i1 = mod(i + 1.0, K);
  float g0 = satHash1(i0 + 0.5) * 2.0 - 1.0, g1 = satHash1(i1 + 0.5) * 2.0 - 1.0;
  float u = fr * fr * (3.0 - 2.0 * fr);
  return 2.0 * mix(g0 * fr, g1 * (fr - 1.0), u);
}

// Optical-depth state of one ring pixel: effective taus at the four knots.
// fpKm = radial pixel footprint. Far: mip-filtered transmission averages. Near: the 1 km data plus
// procedural sub-km ringlets that fade in only when they are resolved.
vec4 ringTauState(float rkm, float fpKm, out float fineW) {
  // LOD biased -0.3 (~1.6 px per cycle at the finest resolved ringlets): sharp, still below the moire limit
  vec4 E = textureLod(uRingProf, vec2(ringU(rkm), 0.5), ringLod(fpKm) - 0.3);
  vec4 T = ringTaus(E);
  fineW = 1.0 - smoothstep(2.4, 4.8, fpKm);
  if (fineW > 0.0) {
    vec3 tf = ringFine(rkm);
    float t = mix(tf.y, tf.z, smoothstep(1.2, 4.0, fpKm));
    t = mix(tf.x, t, smoothstep(0.6, 1.4, fpKm));
    // sub-kilometre ringlets: multiplicative, footprint-filtered
    float sub = 0.0;
    float fq = 1.2;
    float amp = 0.22;
    float xr = rkm - RING_R0;
    for (int o = 0; o < 3 + uSatZero; o++) {
      float w = 1.0 - smoothstep(0.25, 0.6, fpKm * fq);
      sub += amp * w * gnoise1(xr * fq + float(o) * 17.13);
      fq *= 2.13;
      amp *= 0.75;
    }
    t *= max(0.0, 1.0 + sub);
    T = mix(T, vec4(t), fineW);
  }
  return T;
}

vec4 ringAlbedo(float rkm, float fpKm) {
  return textureLod(uRingAlb, vec2(ringU(rkm), 0.5), ringLod(fpKm) - 0.3);
}

// Sun transmission through the rings at fixed solar incidence (exact filtered average, channel y).
float ringSunT(float rkm, float lod) {
  return textureLod(uRingProf, vec2(ringU(rkm), 0.5), lod).y;
}

// HG normalised to mean 1 over the sphere; c = cos(scattering angle), 1 = forward.
float hgP(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-5), 1.5);
}
float particlePhase(float c) { return 0.86 * hgP(c, -0.42) + 0.14 * hgP(c, 0.45); }
float dustPhase(float c) { return 0.75 * hgP(c, 0.78) + 0.25 * hgP(c, 0.2); }

// Shadow of the oblate planet (b/a = flat) at point p for sun direction s: rgb transmission, 1 = lit.
// z = height of the sun ray's closest approach above the 1-bar limb (radii), t = distance behind the limb.
//  - grazing sunlight is extinguished by the stratospheric haze (scale height ~60 km = 0.001 R; slant optical depth
//    1 at ~300 km in the green, higher up in the blue, lower in the red: tau ~ lambda^-1.3), smeared by the solar
//    disc (half-width t * uSunAngR), so the edge is a ~300-600 km reddening ramp, not a cut;
//  - inside the geometric shadow, light refracted by the lower atmosphere (H2 at 10-100 mbar bends grazing rays by
//    1e-4 - 1e-3 rad) reaches a band whose depth grows with t; it crossed the deep haze: faint and deep red.
vec3 planetShadow(vec3 p, vec3 s, float fl) {
  vec3 q = vec3(p.x, p.y / fl, p.z);
  vec3 d = normalize(vec3(s.x, s.y / fl, s.z));
  float t = -dot(q, d);
  if (t <= 0.0) return vec3(1.0);
  float z = length(q + d * t) - 1.0;
  if (z > 0.03 + 2.0 * t * uSunAngR) return vec3(1.0);
  float pen = t * uSunAngR;
  float H = sqrt(1.6e-6 + 0.36 * pen * pen);
  vec3 T = exp(-min(vec3(0.62, 1.0, 1.75) * exp(-(z - 0.0055) / H), vec3(40.0)));
  float h = max(0.0, 0.0035 - z);
  vec3 refr = vec3(1.0, 0.40, 0.15) * 0.05 * exp(-h / (0.0045 * t + 2e-4));
  return T + refr * (1.0 - T.g);
}

// Display chroma pre-compensation for the post's AgX tone curve. AgX (with this project's punchy log window)
// desaturates bright colours hard and over-saturates dim ones: a material whose linear chroma matches a Cassini
// true-colour photograph displays as pale greige on the sunlit disc (B/R 0.80 instead of 0.63) and as copper in
// ringshine. Real spacecraft colour images are linear stretches, i.e. hue-preserving. Scaling the chroma around the
// Rec.709 luminance by s(Y * exposure) makes AgX's output keep the material's chroma at every brightness; s was
// fitted numerically through the post's exact AgX + look + grade (tools in notes/saturn.md, "Colour pipeline"):
// log2(Y exp) = -6: 0.5, -4: 0.73, -2: 1.09, -1: 1.34, 0: 1.63. Luminance is unchanged, so exposure, bloom and the
// tone curve still behave exactly as for every other body. Apply to a layer's final radiance.
uniform float uExposure;
vec3 satDisplay(vec3 L) {
  float Y = dot(L, vec3(0.2126, 0.7152, 0.0722));
  if (!(Y > 1e-10)) return L;
  float lg = log2(Y * max(uExposure, 1e-6));
  float s = clamp(1.085 * exp2(0.30 * (lg + 2.0)), 0.5, 1.85);
  return max(vec3(Y) + s * (L - vec3(Y)), vec3(0.0));
}

// Ray-ellipsoid (planet, a = 1, b = flat): returns t of entry or -1.
float hitPlanet(vec3 ro, vec3 rd, float fl) {
  vec3 o = vec3(ro.x, ro.y / fl, ro.z);
  vec3 d = vec3(rd.x, rd.y / fl, rd.z);
  float A = dot(d, d), B = dot(o, d), C = dot(o, o) - 1.0;
  float h = B * B - A * C;
  if (h < 0.0) return -1.0;
  float t = (-B - sqrt(h)) / A;
  return t;
}
#endif
`;
