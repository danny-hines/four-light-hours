// Earth shaders. The planet is ray-traced analytically inside a proxy sphere that encloses the atmosphere
// (so the limb is exact and anti-aliased at any distance, with no tessellation facets at the horizon):
//
//   pass 1 "transmit" (multiply blending):  dst *= T(view ray through the atmosphere)  — chromatic, so the Sun
//                                             setting behind the limb reddens; 0 where the solid planet is.
//   pass 2 "radiance" (additive blending):   dst += surface * T + in-scattering + airglow
//
// Everything is evaluated per pixel: Blue Marble surface with relief, GGX ocean glint with wind-roughness
// variation, seasonal sea ice / snow, an elevated cloud layer (NASA map + domain-warped procedural detail,
// advected by latitude-dependent winds), cloud shadows, city lights, eclipse shadow of the Moon, and physically
// based Rayleigh / Mie / ozone single scattering + Hillaire multiple scattering via LUTs (atmo-lut.js).


import { ATMO } from './atmo-lut.js';
const f = (v) => Number(v).toFixed(6);
const SA = ATMO.S;
const v3 = (a, k) => `vec3(${f(a[0] * k)}, ${f(a[1] * k)}, ${f(a[2] * k)})`;

export const EARTH_COMMON = /* glsl */ `
#define PI 3.14159265359
uniform float uRp;       // planet radius (scene units)
uniform float uRt;       // top of the scattering atmosphere
uniform sampler2D uTransLUT;
uniform sampler2D uMsLUT;
uniform sampler2D uIrrLUT;
#ifndef U_LOOPMAX
#define U_LOOPMAX
uniform int uLoopMax;      // = 64; a uniform loop bound keeps the D3D compiler from unrolling every call site
#endif

#define T_W 256.0
#define T_H 64.0
#define MS_N 32.0
#define IRR_N 64.0
#define KM (1.0 / 6371.0)
// atmosphere constants: generated from ATMO in atmo-lut.js (heights x S, coefficients / S; see there)
#define ATMO_S ${f(SA)}
#define HR (${f(ATMO.HRkm * SA)} * KM)
#define HM (${f(ATMO.HMkm * SA)} * KM)
const vec3 BETA_R = ${v3(ATMO.betaR, 6.371 / SA)};
const float BETA_MS = ${f((ATMO.betaMs * 6.371) / SA)};
const float BETA_ME = ${f((ATMO.betaMe * 6.371) / SA)};
const vec3 BETA_O = ${v3(ATMO.betaO, 6.371 / SA)};       // sRGB-channel-integrated ozone (see atmo-lut.js)
#define H_O (${f(ATMO.hOkm * SA)} * KM)
#define W_O (${f(ATMO.wOkm * SA)} * KM)
#define H_J (${f(ATMO.hJkm * SA)} * KM)
#define W_J (${f(ATMO.wJkm * SA)} * KM)
#define K_J ${f(ATMO.kJ)}
#define MIE_G ${f(ATMO.g)}

// numerically stable ray / sphere (works for far cameras)
vec2 raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd);
  vec3 q = ro - b * rd;
  float h = R * R - dot(q, q);
  if (h < 0.0) return vec2(1e20, -1e20);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float distToTop(float r, float mu) {
  float disc = r * r * (mu * mu - 1.0) + uRt * uRt;
  return max(0.0, -r * mu + sqrt(max(disc, 0.0)));
}

vec3 transLUT(float r, float mu) {
  r = clamp(r, uRp, uRt);
  float H = sqrt(uRt * uRt - uRp * uRp);
  float rho = sqrt(max(r * r - uRp * uRp, 0.0));
  float d = distToTop(r, mu);
  float dMin = uRt - r, dMax = rho + H;
  float xmu = (d - dMin) / max(dMax - dMin, 1e-9);
  float xr = rho / H;
  vec2 uv = vec2(0.5 / T_W + xmu * (1.0 - 1.0 / T_W), 0.5 / T_H + xr * (1.0 - 1.0 / T_H));
  return textureLod(uTransLUT, uv, 0.0).rgb;
}

// transmittance of sunlight to a point at radius r with sun zenith cosine mu, including the planet's shadow
vec3 sunTrans(float r, float mu) {
  float ratio = uRp / max(r, uRp);
  float muH = -sqrt(max(0.0, 1.0 - ratio * ratio));
  float vis = clamp((mu - muH) / 0.0093 + 0.5, 0.0, 1.0);
  return transLUT(r, max(mu, muH + 2e-4)) * vis;
}

vec3 msLUT(float r, float muS) {
  vec2 uv = vec2((muS * 0.5 + 0.5) * (1.0 - 1.0 / MS_N) + 0.5 / MS_N,
                 clamp((r - uRp) / (uRt - uRp), 0.0, 1.0) * (1.0 - 1.0 / MS_N) + 0.5 / MS_N);
  return textureLod(uMsLUT, uv, 0.0).rgb;
}

// irradiance from the sky dome on a horizontal surface, per unit sun irradiance (physical)
vec3 skyIrradiance(float muS) {
  float x = clamp((muS + 0.35) / 1.35, 0.0, 1.0);
  return textureLod(uIrrLUT, vec2(x * (1.0 - 1.0 / IRR_N) + 0.5 / IRR_N, 0.5), 0.0).rgb;
}

float phaseRayleigh(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
// stratospheric (sulphate) aerosol: small, strongly forward-scattering lobe (g 0.92) - the bright golden aureole
// that spreads along the limb around an orbital sunrise
float phaseStrat(float mu) {
  const float g = 0.92, g2 = 0.92 * 0.92;
  return 0.25 / PI * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5);
}
float phaseMie(float mu) {
  const float g = MIE_G, g2 = MIE_G * MIE_G;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

`;

export const EARTH_VERT = /* glsl */ `
varying vec3 vPosW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

// ------------------------------------------------------------------------------------------------ pass 1
export const EARTH_TRANSMIT_FRAG = /* glsl */ `
${EARTH_COMMON}
uniform vec3 uCenterW;
varying vec3 vPosW;
void main() {
  vec3 rd = normalize(vPosW);
  vec3 ro = -uCenterW;
  vec2 ta = raySphere(ro, rd, uRt);
  if (ta.x > ta.y || ta.y <= 0.0) discard;
  float b = dot(ro, rd);
  float dq = length(ro - b * rd);
  float cov = (b < 0.0) ? clamp((uRp - dq) / max(fwidth(dq), 1e-9) + 0.5, 0.0, 1.0) : 0.0;
  // transmittance of the whole chord (or from the camera, if it is inside the atmosphere)
  float t0 = max(ta.x, 0.0);
  vec3 p0 = ro + rd * t0;
  float r0 = length(p0);
  float mu0 = dot(p0, rd) / r0;
  // if the chord passes below the ground, use the grazing ray (only matters inside the AA edge)
  float ratio = uRp / r0;
  float muH = -sqrt(max(0.0, 1.0 - ratio * ratio));
  vec3 T = transLUT(r0, max(mu0, muH + 1e-4));
  gl_FragColor = vec4(mix(T, vec3(0.0), cov), 1.0);
}
`;

