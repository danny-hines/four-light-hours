// Uranus's rings: nine narrow dark main rings + the dusty lambda / eta-plateau / zeta material.
//
// Data: orbital elements and widths from French et al. (1991, "Dynamics and structure of the Uranian rings",
// Uranus, U. Arizona Press) and Voyager 2 radio / stellar occultations; optical depths from Esposito & Colwell.
//   a (km), e, periapse longitude at epoch (deg), apsidal precession (deg/day), width at periapse / apoapse (km),
//   normal optical depth (or, for epsilon, a constant equivalent depth EW so tau = EW / width).
// Each ring is a box in radius whose centre follows its Keplerian ellipse r(f) = a(1-e^2)/(1+e cos f) and whose
// width varies linearly with radius (epsilon: 19.7 km at periapse to 96.4 km at apoapse). Coverage of each
// pixel's radial footprint is computed analytically, so km-wide rings never alias at any distance.
// The ring material is very dark (particle normal reflectance ~0.03-0.05, neutral grey) with a strong
// opposition surge; the dust is forward-scattering. Rings orbit retrograde about the IAU north pole (+y).
import * as THREE from 'three';
import { UNIFORMS_GLSL, COMMON_GLSL } from './shared.js';

const J1977 = -8331.333; // 1977 Mar 10 20:00 UTC (occultation epoch of French et al.) in days since J2000

//            name     a_km       e        varpi0  dvarpi   w_peri  w_apo  tau    EW
export const RINGS = [
  ['6', 41837.15, 0.001013, 242.8, 2.7616, 1.6, 2.2, 0.3, 0],
  ['5', 42234.82, 0.001899, 170.3, 2.7059, 1.9, 4.9, 0.5, 0],
  ['4', 42570.91, 0.001059, 127.3, 2.6588, 2.4, 4.4, 0.32, 0],
  ['alpha', 44718.45, 0.000761, 333.2, 2.1857, 4.8, 10.0, 0.4, 0],
  ['beta', 45661.03, 0.000442, 224.9, 2.0569, 6.1, 11.4, 0.25, 0],
  ['eta', 47175.91, 0.000004, 0.0, 0.0, 1.9, 2.7, 0.35, 0],
  ['gamma', 47626.87, 0.000109, 132.1, 1.75, 3.6, 4.7, 1.6, 0],
  ['delta', 48300.12, 0.000004, 0.0, 0.0, 4.1, 6.1, 0.5, 0],
  ['lambda', 50023.94, 0.0, 0.0, 0.0, 1.5, 2.5, 0.12, 0],
  ['epsilon', 51149.32, 0.007936, 215.0, 1.3626, 19.7, 96.4, 0, 40.0],
];
const NRING = RINGS.length;

// Faint dust (forward scattering only): [centre km, sigma km, normal optical depth]
// zeta ring (1986U2R) inside ring 6, the broad eta plateau, the delta inner shoulder and inter-ring dust lanes
// as seen in Voyager's 172-degree phase image (PIA00142).
const DUST = [
  [39600, 1100, 1.5e-4], [41150, 260, 1.0e-4], [42900, 420, 2.2e-4], [43850, 220, 1.6e-4], [44300, 120, 1.1e-4],
  [45150, 160, 2.6e-4], [46100, 260, 1.8e-4], [46600, 120, 1.2e-4], [47205, 22, 2.0e-3], [47900, 160, 2.4e-4],
  [48275, 9, 1.5e-3], [48800, 240, 1.4e-4], [49350, 300, 2.5e-4], [50024, 12, 1.2e-3], [50550, 260, 1.6e-4],
];
const NDUST = DUST.length;

export const RING_GLSL = /* glsl */ `
#define NRING ${NRING}
#define NDUST ${NDUST}
uniform vec4 uRingGeo[NRING];   // a_km, e, varpi (rad, in psi = direction of motion), unused
uniform vec4 uRingPhys[NRING];  // w_peri, w_apo, tau, EW (if > 0, tau = EW / w)
uniform vec3 uDust[NDUST];      // centre km, sigma km, tau
uniform int uNRing, uNDust;     // = NRING, NDUST as uniforms: real loops for FXC instead of unrolled copies

// Main-ring coverage and optical depth for a radial footprint [r - hw, r + hw] (km) at ring longitude psi.
// Returns per-ring results through callbacks-by-accumulation: blocking opacity (for slant mu) and I/F.
// K = particle phase term (w0 P(alpha) / 4); sameSide = Sun and observer on the same face.
void ringMain(float r, float psi, float hw, float mu, float mu0, bool sameSide, float K, float fine,
              out float opac, out float refl) {
  opac = 0.0;
  refl = 0.0;
  for (int i = 0; i < uNRing; i++) {
    vec4 g = uRingGeo[i];
    vec4 ph = uRingPhys[i];
    float cf = cos(psi - g.z);
    float rc = g.x * (1.0 - g.y * g.y) / (1.0 + g.y * cf);
    float w = mix(ph.x, ph.y, 0.5 - 0.5 * cf);
    float lo = rc - 0.5 * w;
    if (r + hw < lo || r - hw > lo + w) continue;
    float cov = (clamp(r + hw - lo, 0.0, w) - clamp(r - hw - lo, 0.0, w)) / (2.0 * hw);
    float tau = ph.w > 0.0 ? min(ph.w / w, 2.6) : ph.z;
    // resolved internal structure (sharp edges, a few internal maxima), faded out when unresolved
    float res = fine * smoothstep(6.0, 2.0, hw * 12.0 / w);
    if (res > 0.0) {
      float u = clamp((r - lo) / w, 0.0, 1.0);
      float s = 1.0 + 0.28 * cos(6.2831853 * (u * 3.0 + 0.15)) * (ph.w > 0.0 ? 1.0 : 0.6) + 0.35 * smoothstep(0.12, 0.0, min(u, 1.0 - u));
      tau *= mix(1.0, s, res);
    }
    float a = 1.0 - exp(-tau / mu);
    opac += cov * a;
    float I;
    if (sameSide) {
      I = K * mu0 / (mu0 + mu) * (1.0 - exp(-tau * (1.0 / mu0 + 1.0 / mu)));
    } else {
      float dm = mu - mu0;
      I = abs(dm) < 1e-3 ? K * (tau / mu) * exp(-tau / mu) : K * mu0 / dm * (exp(-tau / mu) - exp(-tau / mu0));
    }
    // reflected light uses a perceptually compressed coverage (cov^0.5): sub-pixel rings read as faint
    // continuous lines (as in a stretched long exposure); resolved rings (cov = 1) are photometrically exact.
    refl += (fine > 0.0 ? sqrt(cov) : cov) * I;
  }
}

// Optically thin dust: returns normal optical depth averaged over the footprint (Gaussian bands).
float ringDust(float r, float hw) {
  float t = 0.0;
  for (int i = 0; i < uNDust; i++) {
    vec3 d = uDust[i];
    float s2 = d.y * d.y + hw * hw * 0.33;
    float x = r - d.x;
    t += d.z * (d.y * inversesqrt(s2)) * exp(-0.5 * x * x / s2);
  }
  return t;
}

// Fraction of sunlight passing the ring plane along L (world) for a point pW (world) — used for ring
// shadows on the globe and the moons. hwShadow = footprint half-width in km at the shadow.
// Branch-free main-ring opacity for the shadow test (the same coverage and tau as ringMain; FXC compiles loops with
// branches very slowly): a ring outside the footprint has cov = 0 anyway.
// cpsi = (cos psi, sin psi) of the ring-plane longitude (no atan needed)
float ringOpacity(float r, vec2 cpsi, float hw, float mu) {
  float opac = 0.0;
  for (int i = 0; i < uNRing; i++) {
    vec4 g = uRingGeo[i];
    vec4 ph = uRingPhys[i];
    float cf = dot(cpsi, vec2(cos(g.z), sin(g.z)));   // = cos(psi - varpi)
    float rc = g.x * (1.0 - g.y * g.y) / (1.0 + g.y * cf);
    float w = mix(ph.x, ph.y, 0.5 - 0.5 * cf);
    float lo = rc - 0.5 * w;
    float cov = (clamp(r + hw - lo, 0.0, w) - clamp(r - hw - lo, 0.0, w)) / (2.0 * hw);
    float tau = mix(ph.z, min(ph.w / w, 2.6), float(ph.w > 0.0));
    opac += cov * (1.0 - exp(-tau / mu));
  }
  return opac;
}

float ringShadow(vec3 pW, vec3 L, float hwShadow) {
  vec3 n = uPoleBasis[1];
  vec3 rel = pW - uPlanetW;
  float dn = dot(L, n);
  if (abs(dn) < 1e-4) return 1.0;
  float t = -dot(rel, n) / dn;
  if (t <= 0.0) return 1.0;
  vec3 hit = transpose(uPoleBasis) * (rel + t * L);
  float r = length(hit.xz) * uKmPerUnit;
  if (r < 41000.0 || r > 52200.0) return 1.0;
  return 1.0 - ringOpacity(r, hit.xz / max(length(hit.xz), 1e-9), max(hwShadow, 0.5), abs(dn));
}
`;

const VERT = /* glsl */ `
varying vec3 vRing;
varying vec3 vPosW;
void main() {
  vRing = position;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${UNIFORMS_GLSL}
${COMMON_GLSL}
${RING_GLSL}
uniform float uGain;
uniform float uDustGain;
varying vec3 vRing;
varying vec3 vPosW;

void main() {
  float r = length(vRing.xz) * uKmPerUnit;
  // radial footprint of this pixel (km): analytic box filter half-width, slightly widened for stability
  float dr = length(vec2(dFdx(r), dFdy(r)));
  float hw = max(0.65 * dr, 0.02);
  if (r + hw < 37000.0 || r - hw > 52200.0) discard;
  float psi = atan(vRing.z, vRing.x);

  vec3 V = normalize(-vPosW);                       // toward the camera
  vec3 Vp = transpose(uPoleBasis) * V;
  vec3 Lp = transpose(uPoleBasis) * uSunDirW;
  float mu = max(abs(Vp.y), 1e-3);
  float mu0 = max(abs(Lp.y), 1e-3);
  bool sameSide = (Vp.y * Lp.y) > 0.0;
  float cosA = clamp(dot(V, uSunDirW), -1.0, 1.0);
  float alpha = acos(cosA);                          // phase angle
  float aDeg = alpha * 57.29578;
  // dark, rough macroscopic particles: backscattering phase law + narrow opposition surge (Voyager/HST). The decline
  // with phase is gentler than lunar (e-folding 55 deg instead of ~38): a deliberate long-exposure choice so the
  // hairlines stay readable in the moderately inclined views of the film.
  float K = 0.036 * exp(-aDeg / 55.0) * (1.0 + 0.55 * exp(-aDeg / 1.8) + 0.25 * exp(-aDeg / 9.0))
          * (1.0 + 0.8 * smoothstep(15.0, 90.0, aDeg));   // exposure compensation of the long-exposure look

  float opac, refl;
  ringMain(r, psi, hw, mu, mu0, sameSide, K, 1.0, opac, refl);

  // forward-scattering dust (w0 ~ 0.5), optically thin: a broad HG lobe (g = 0.7) plus the narrow diffraction
  // peak of micron-sized grains (g = 0.95) that makes the dust sheet blaze within ~15 deg of the Sun (PIA00142)
  float td = ringDust(r, hw);
  float g = 0.7, gd = 0.95;
  float pHG = 0.7 * (1.0 - g * g) / pow(1.0 + g * g + 2.0 * g * cosA, 1.5)    // scattering angle = pi - alpha
            + 0.3 * (1.0 - gd * gd) / pow(max(1.0 + gd * gd + 2.0 * gd * cosA, 1e-4), 1.5);
  float dust = 0.5 * td * pHG / (4.0 * mu) * uDustGain;

  // planet shadow (oblate, exact ray test in scaled space; edge softened over the pixel footprint)
  vec3 ps = toPlanetS(vPosW);
  vec3 Ls = dirToPlanetS(uSunDirW);
  float sh = deckOcclusion(ps, Ls, max(hw / 25559.0 * 2.0, 3e-4));

  vec3 tint = vec3(1.0, 0.995, 0.985);   // the ring particles are dark and nearly neutral grey
  vec3 col = uSunColor * sh * (refl * uGain * tint + dust * vec3(0.95, 0.98, 1.0));
  gl_FragColor = vec4(col, clamp(opac, 0.0, 1.0));
}
`;

// Ring uniforms live in the shared set (the globe and moons need them for ring shadows).
export function addRingUniforms(S) {
  S.uRingGeo = { value: RINGS.map(() => new THREE.Vector4()) };
  S.uRingPhys = { value: RINGS.map(([, , , , , wp, wa, tau, ew]) => new THREE.Vector4(wp, wa, tau, ew)) };
  S.uDust = { value: DUST.map(([c, s, t]) => new THREE.Vector3(c, s, t)) };
  S.uNRing = { value: NRING };
  S.uNDust = { value: NDUST };
}

export function updateRingUniforms(S, simDays) {
  for (let i = 0; i < NRING; i++) {
    const [, a, e, w0, wd] = RINGS[i];
    const varpi = ((w0 + wd * (simDays - J1977)) % 360) * (Math.PI / 180);
    S.uRingGeo.value[i].set(a, e, varpi, 0);
  }
}

export function createRings(ctx, S) {
  const { U } = ctx;
  const R = ctx.data.radius;
  const kmU = S.uKmPerUnit.value;
  const inner = 37000 / kmU, outer = 52600 / kmU;
  const seg = 1024;
  const geo = new THREE.RingGeometry(inner, outer / Math.cos(Math.PI / seg), seg, 1);
  geo.rotateX(-Math.PI / 2); // into the xz plane (pole frame: +y = north)

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...S,
      uSunColor: U.uSunColor,
      uGain: { value: 6.5 },
      uDustGain: { value: 40.0 }, // artistic: the dust sheet is ~1e-4 I/F, shown as in a long exposure
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'uranus-rings';
  mesh.frustumCulled = false;

  return { mesh, material: mat, R };
}
