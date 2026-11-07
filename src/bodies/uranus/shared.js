// Uranus piece: per-frame uniforms shared by the globe, haze shell, rings and moons, plus common GLSL.
//
// Frames (see CONTRACT.md):
//   spin frame  = bodyQuaternion('uranus', d)  -> globe features (rotates, retrograde, period 17.24 h)
//   pole frame  = poleQuaternion('uranus')     -> rings and moon orbits (+y = IAU north pole, no spin)
// "Scaled planet space" (used by the haze and all shadow tests) = pole frame / R_eq with y divided by (1 - f),
// so the oblate cloud deck becomes the unit sphere.
import * as THREE from 'three';
import { KM_PER_UNIT } from '../../core/astro.js';

export const FLAT = 1 - 0.02293; // polar / equatorial radius
export const HAZE_N = 12; // haze samples per segment of a view ray

export function makeShared(ctx) {
  const R = ctx.data.radius;
  const S = {
    uPlanetW: { value: new THREE.Vector3() }, // planet centre, world (camera-relative)
    uSunDirW: { value: new THREE.Vector3(1, 0, 0) }, // unit vector planet -> Sun
    uPoleBasis: { value: new THREE.Matrix3() }, // pole frame -> world (columns = axes)
    uSpinBasis: { value: new THREE.Matrix3() }, // spin frame -> world
    uR: { value: R },
    uFlat: { value: FLAT },
    uKmPerUnit: { value: KM_PER_UNIT },
    uDays: { value: 0 }, // simulated days since the capture epoch (small number, for drift)
    uMoonPos: { value: Array.from({ length: 5 }, () => new THREE.Vector4(0, 0, 0, 0)) }, // xyz world, w radius
    // Upper haze / H2 Rayleigh shell above the cloud-deck reference surface (vertical optical depths).
    uHazeH: { value: 32 / 25559 }, // scale height / R  (H = RT/(mu g) ~ 30 km near 1 bar, 76 K)
    uHazeTop: { value: 560 / 25559 },
    // tenuous, extended stratospheric (hydrocarbon) haze: larger scale height, strongly forward scattering. Nearly
    // invisible at low phase, it gives the soft glowing annulus around the night side at high phase.
    uHaze2H: { value: 52 / 25559 },
    uTau2: { value: new THREE.Vector3(0.009, 0.0098, 0.0108) }, // cf. Pollack et al. 1987: tau ~ 0.01-0.03 at 0.5 um
    uTauR: { value: new THREE.Vector3(0.008, 0.017, 0.034) }, // H2 Rayleigh, ~lambda^-4 (red/green/blue)
    uTauM: { value: new THREE.Vector3(0.042, 0.042, 0.04) }, // upper-tropospheric / stratospheric aerosol haze
    uTauA: { value: new THREE.Vector3(0.04, 0.004, 0.0) }, // CH4 absorption above the deck (red)
    // effective aerosol single-scattering albedo: light scattered in the haze has mostly crossed CH4-bearing air, so
    // it is depleted in red like the deck below; this keeps the limb and the crescents cyan, as in Voyager images
    uHazeW: { value: new THREE.Vector3(0.6, 0.93, 0.98) },
    uHaze2W: { value: new THREE.Vector3(0.64, 0.94, 1.0) }, // the same for the tenuous stratospheric haze
    uHazeG: { value: 0.62 },
    // loop trip counts as uniforms: ANGLE -> HLSL -> FXC fully unrolls constant-bound loops (and inlines every call),
    // which made the first draw of each program cost seconds; with uniform bounds FXC emits one real loop
    uNHaze2: { value: 2 * HAZE_N }, // haze samples per view ray (two segments of HAZE_N)
    uN5: { value: 5 }, // moons casting shadows
  };
  return S;
}

// GLSL used by several Uranus shaders. Requires the uniforms above to be declared (UNIFORMS_GLSL).
export const UNIFORMS_GLSL = /* glsl */ `
uniform vec3 uPlanetW;
uniform vec3 uSunDirW;
uniform mat3 uPoleBasis;
uniform mat3 uSpinBasis;
uniform float uR;
uniform float uFlat;
uniform float uKmPerUnit;
uniform float uDays;
uniform vec4 uMoonPos[5];
uniform vec3 uSunColor;
uniform float uHazeH;
uniform float uHazeTop;
uniform vec3 uTauR;
uniform vec3 uTauM;
uniform vec3 uTauA;
uniform vec3 uHazeW;
uniform vec3 uHaze2W;
uniform float uHazeG;
uniform float uHaze2H;
uniform vec3 uTau2;
uniform int uNHaze2;
uniform int uN5;
`;


export const COMMON_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.14159265359
#endif

// world position -> scaled planet space (oblate deck = unit sphere)
vec3 toPlanetS(vec3 w) {
  vec3 l = transpose(uPoleBasis) * (w - uPlanetW) / uR;
  l.y /= uFlat;
  return l;
}
// world direction -> scaled planet space (normalised)
vec3 dirToPlanetS(vec3 d) {
  vec3 l = transpose(uPoleBasis) * d;
  l.y /= uFlat;
  return normalize(l);
}

// Ray / sphere about the origin, |d| = 1. Stable for large |o| (closest-approach form).
vec2 raySphereS(vec3 o, vec3 d, float r) {
  float b = dot(o, d);
  vec3 pc = o - b * d;
  float h = r * r - dot(pc, pc);
  if (h < 0.0) return vec2(1e20, -1e20);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// Chapman-function approximation for an exponential atmosphere: airmass for zenith cosine mu >= 0, x = r / H.
float chapF(float x, float mu) {
  float g2 = 1.0 / (1.5707963 * x);
  return 2.0 / (mu + sqrt(mu * mu + 4.0 * g2));
}
// Slant optical depth toward L, in units of the vertical optical depth at the deck (h = 0), scale height H.
// (branch-free: both cases share chapF(x, |mu|); FXC compiles branches inside loops very slowly)
float sunAirmassH(vec3 p, vec3 L, float H) {
  float r = max(length(p), 1e-6);
  float mu = dot(p, L) / r;
  float x = r / H;
  float h = r - 1.0;
  float am = exp(-h / H) * chapF(x, abs(mu));
  float rt = r * sqrt(max(1.0 - mu * mu, 0.0));
  float ht = max(rt - 1.0, -0.02);
  return mu >= 0.0 ? am : 2.0 * exp(-ht / H) * sqrt(1.5707963 * rt / H) - am;
}
float sunAirmass(vec3 p, vec3 L) { return sunAirmassH(p, L, uHazeH); }
// the same for two scale heights at once (the two haze layers inside the haze loop: one inlined copy)
vec2 sunAirmass2(vec3 p, vec3 L, vec2 H) {
  float r = max(length(p), 1e-6);
  float mu = dot(p, L) / r;
  vec2 x = r / H;
  float h = r - 1.0;
  float amu = abs(mu);
  vec2 g2 = 1.0 / (1.5707963 * x);
  vec2 am = exp(-h / H) * (2.0 / (amu + sqrt(amu * amu + 4.0 * g2)));
  float rt = r * sqrt(max(1.0 - mu * mu, 0.0));
  float ht = max(rt - 1.0, -0.02);
  return mu >= 0.0 ? am : 2.0 * exp(-ht / H) * sqrt(1.5707963 * rt / H) - am;
}
// Delta-scaled view transmittance for deck light (the haze is strongly forward scattering, so most of what it
// "removes" stays in the beam), without the CH4 absorption share: the fitted Minnaert law already contains the limb
// behaviour of the CH4 bands, and counting it again starved the outermost limb pixels of red.
vec3 deckT(vec3 T, float p) { vec3 f = uTauA / (uTauR + uTauM + uTauA); return pow(max(T, vec3(1e-8)), p * (1.0 - f)); }
// 1 = the Sun is not blocked by the deck sphere; soft edge half-width "soft" (units of R).
float deckOcclusion(vec3 p, vec3 L, float soft) {
  float b = dot(p, L);
  float d = sqrt(max(dot(p, p) - b * b, 0.0));
  return max(smoothstep(1.0 - soft, 1.0 + soft, d), float(b > 0.0));
}

// Single scattering in the upper haze along o + d*[t0, t1] (scaled planet space, |d| = 1).
// Returns in-scattered radiance for unit solar irradiance; T = view transmittance of the segment.
// The samples are packed quadratically toward the lowest point of the path (the tangent point, or the deck),
// where the density peaks, so grazing chords integrate the same optical depth whether they end on the deck or
// pass just above it (no seam at the limb). Both segments ([t0, tm] dense at tm, then [tm, t1] dense at tm) run in
// ONE real loop of uNHaze2 = 2 HAZE_N iterations (one inlined copy of the sample body instead of two unrolled ones).
vec3 hazeScatter(vec3 o, vec3 d, float t0, float t1, vec3 L, out vec3 T) {
  T = vec3(1.0);
  if (t1 <= t0) return vec3(0.0);
  vec3 tauExt = uTauR + uTauM + uTauA;
  vec3 acc = vec3(0.0), acc2 = vec3(0.0);
  vec3 tv = vec3(0.0);
  float tm = clamp(dot(-o, d), t0, t1);   // closest approach to the centre = lowest point
  const float NS = ${HAZE_N}.0;
  // empty segments are skipped through the loop bounds (no branch in the body): a ray that ends on the deck has no
  // second segment, one that starts at its lowest point no first
  int k0 = tm > t0 ? 0 : ${HAZE_N};
  int k1 = t1 > tm ? uNHaze2 : ${HAZE_N};
  for (int k = k0; k < k1; k++) {
    bool first = k < ${HAZE_N};
    // (branch-free body: an empty segment just gets dt = 0)
    float fs = float(first);
    float ta = mix(tm, t0, fs), tb = mix(t1, tm, fs);
    float len = max(tb - ta, 0.0);
    float sc = (float(k) - (1.0 - fs) * ${HAZE_N}.0 + 0.5) / NS;
    float wq = mix(sc, 1.0 - sc, fs);
    float t = mix(ta + len * wq * wq, tb - len * wq * wq, fs);
    float dt = 2.0 * len * wq / NS;
    vec3 p = o + d * t;
    float h = length(p) - 1.0;
    float hc = max(h, -0.004);
    float rho = exp(-hc / uHazeH) / uHazeH;
    float rho2 = exp(-hc / uHaze2H) / uHaze2H;
    vec3 e = tauExt * (rho * dt) + uTau2 * (rho2 * dt);
    vec2 am = sunAirmass2(p, L, vec2(uHazeH, uHaze2H));
    vec3 Ts = exp(-tauExt * am.x - uTau2 * am.y) * deckOcclusion(p, L, 0.0015);
    vec3 w = exp(-(tv + 0.5 * e)) * Ts * dt;
    acc += w * rho;
    acc2 += w * rho2;
    tv += e;
  }
  T = exp(-tv);
  float mu = dot(d, L);
  float pr = 0.1875 * (1.0 + mu * mu);
  // aerosol phase function: two-term Henyey-Greenstein (a strong, narrow forward lobe from the larger
  // stratospheric particles + a broad lobe), plus an isotropic term standing in for multiple scattering
  float g1 = 0.8, g2 = uHazeG;
  float p1 = 0.25 * (1.0 - g1 * g1) / pow(max(1.0 + g1 * g1 - 2.0 * g1 * mu, 1e-4), 1.5);
  float p2 = 0.25 * (1.0 - g2 * g2) / pow(max(1.0 + g2 * g2 - 2.0 * g2 * mu, 1e-4), 1.5);
  float pm = 0.32 * p1 + 0.6 * p2 + 0.08 * 0.25 + 0.035;
  // stratospheric haze: small particles of a few tenths of a micron, mostly forward (g ~ 0.85) + a broad lobe
  float g3 = 0.86;
  float p3 = 0.25 * (1.0 - g3 * g3) / pow(max(1.0 + g3 * g3 - 2.0 * g3 * mu, 1e-4), 1.5);
  float pm2 = 0.65 * p3 + 0.35 * p2;
  // H2 Rayleigh light from grazing paths has itself crossed the CH4-bearing atmosphere: its blue excess over green
  // stays small (the Voyager limb fades at nearly constant hue, R/G ~ 0.8, with no navy rim)
  vec3 ray = uTauR * pr * acc;
  ray.b = min(ray.b, ray.g * 1.1);
  return ray + uTauM * uHazeW * pm * acc + uTau2 * uHaze2W * (0.95 * pm2) * acc2;
}

// Soft shadow of a sphere (centre c, radius r) on point p for sunlight along L (all world space).
// Penumbra from the Sun's angular radius at Uranus (~2.4e-4 rad) plus a minimum softness.
float sphereShadow(vec3 p, vec3 L, vec3 c, float r, float minSoft) {
  vec3 oc = c - p;
  float t = dot(oc, L);
  float d = length(oc - t * L);
  float pen = max(t * 2.4e-4, minSoft);
  return max(smoothstep(r - pen, r + pen, d), float(t <= 0.0));
}
`;
