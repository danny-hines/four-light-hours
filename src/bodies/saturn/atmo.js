// Saturn's stratospheric haze seen at and above the limb (the cloud deck + lower haze is the globe shader).
// Two exponential components (scale heights HA, HB) are integrated along each view ray near its closest approach,
// with analytic columns: for a straight line of tangent altitude h the slant optical depth is tau_t(h) and the
// column from the camera to a point at distance l past the tangent point is tau_t(h) * erfc(-l / sigma) / 2
// (sigma = sqrt(R H)); the column from a point toward the Sun uses the same form for the sun line through it.
// Every sample is tested against the planet's shadow, so when Saturn eclipses the Sun only haze that the
// sunlight can actually reach glows (one-sided from close range, a full ring from farther away).
// The result is averaged over the pixel's altitude footprint so the sub-pixel ring is antialiased.
import * as THREE from 'three';
import { RING_GLSL } from './rings-glsl.js';

const VERT = /* glsl */ `
uniform float uFlat;
uniform float uTop;
varying vec3 vP;
void main() {
  vP = position * uTop * vec3(1.0, uFlat, 1.0);
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
${RING_GLSL}
uniform vec3 uCamR;
uniform vec3 uSunR;
uniform vec3 uSunColor;
uniform float uFlat;
uniform float uHazeGain;
uniform float uGain;
uniform float uSigA, uSigB; // sqrt(R H) for the two components (uniforms: keeps the compiler from constant-folding)
varying vec3 vP;

// ln(erfc(x)) with the correct exp(-x^2) tail (Numerical Recipes erfcc, rel. error < 1.2e-7)
float lnErfc(float x) {
  float z = abs(x);
  float t = 1.0 / (1.0 + 0.5 * z);
  float p = -z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
            t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  float le = log(t) + p;
  return x >= 0.0 ? le : log(2.0 - exp(le));
}
const float RK = 60268.0;
// component A: main stratospheric haze; component B: extended upper haze (smaller, bluer particles)
const float HA = 45.0, HB = 180.0;
const vec3 HA1 = vec3(112.0, 121.0, 133.0); // altitude (km) where tau_t(A) = 1 (blue extinguished higher up)
const vec3 TB0 = vec3(0.24, 0.32, 0.46);    // tau_t(B) at HB1 (small grains: bluer)
const float HB1 = 200.0;
// latitude-dependent haze amounts (set per pixel from the tangent latitude): Saturn's stratospheric haze is thicker
// over the equatorial region and the polar caps than at mid-latitudes, so the eclipse limb ring varies in width
// and brightness around the disc instead of being a uniform outline
float gFA = 1.0, gFB = 1.0;
vec3 tauA(float h) { return gFA * exp(-(h - HA1) / HA); }
vec3 tauB(float h) { return gFB * TB0 * exp(-(h - HB1) / HB); }
// half-line columns: tau_t(h) * erfc(x) / 2, evaluated in log space (no overflow for h << 0)
vec3 colA(float h, float x) { return gFA * exp(-(h - HA1) / HA + lnErfc(x) - 0.6931472); }
vec3 colB(float h, float x) { return gFB * TB0 * exp(-(h - HB1) / HB + lnErfc(x) - 0.6931472); }
// thin detached haze layers (Cassini high-phase limb images show several), optically thin: emission only
float layers(float h, float lat) {
  float l1 = exp(-0.5 * pow((h - 330.0) / 14.0, 2.0)) * (0.6 + 0.4 * cos(lat * 3.0));
  float l2 = exp(-0.5 * pow((h - 445.0) / 18.0, 2.0)) * (0.5 + 0.5 * smoothstep(0.3, 1.1, abs(lat)));
  return 1.2e-5 * l1 + 0.7e-5 * l2; // extinction per km
}

// plane-parallel haze over the cloud deck: single scattering in the layer + transmission of the deck below
vec3 ppHaze(float mu, float mu0, vec3 tvA, vec3 tvB, float PA, float PB, vec3 wA, vec3 wB, out vec3 Tout) {
  vec3 L = vec3(0.0);
  if (mu0 > 0.0) {
    vec3 eA = 1.0 - exp(-tvA * (1.0 / mu + 1.0 / mu0));
    vec3 eB = 1.0 - exp(-tvB * (1.0 / mu + 1.0 / mu0));
    L = 0.25 * mu0 / (mu + mu0) * (wA * PA * eA + wB * PB * eB);
  }
  Tout = exp(-(tvA + tvB) / mu);
  return L;
}

void main() {
  vec3 o = vec3(uCamR.x, uCamR.y / uFlat, uCamR.z);
  vec3 rd = normalize(vP - uCamR);
  vec3 d = normalize(vec3(rd.x, rd.y / uFlat, rd.z));
  float tc = -dot(o, d);
  vec3 c = o + d * tc;
  float b = length(c);
  float dhKm = max(fwidth(b) * RK, 0.5);
  vec3 s = normalize(vec3(uSunR.x, uSunR.y / uFlat, uSunR.z));
  float cth = dot(rd, uSunR); // cos scattering angle (forward = 1)
  float PA = 0.75 * hgP(cth, 0.68) + 0.25 * hgP(cth, -0.15);
  float PB = 0.55 * hgP(cth, 0.80) + 0.2 * hgP(cth, 0.5) + 0.25 * 0.75 * (1.0 + cth * cth);
  vec3 wA = vec3(0.97, 0.95, 0.90), wB = vec3(0.98, 0.98, 0.97);
  vec3 cn = c / max(b, 1e-6);
  float latT = asin(clamp(cn.y, -1.0, 1.0));
  float aL = abs(latT);
  gFA = 0.75 + 0.45 * exp(-pow(latT / 0.42, 2.0)) + 0.3 * smoothstep(1.05, 1.35, aL);
  gFB = 0.3 + 1.4 * exp(-pow(latT / 0.45, 2.0)) + 0.7 * smoothstep(1.0, 1.35, aL);
  float kA = sqrt(6.2831853 * RK / HA), kB = sqrt(6.2831853 * RK / HB);

  vec3 L = vec3(0.0);
  vec3 T = vec3(1.0);
  vec3 tvA = tauA(0.0) / kA, tvB = tauB(0.0) / kB; // vertical optical depths above the cloud deck
  if (b < 0.95) {
    // over the disc: plane-parallel layer on top of the cloud deck
    float th = hitPlanet(o, d, 1.0);
    vec3 n = normalize(o + d * th);
    float mu = max(dot(n, -d), 0.01);
    float mu0 = dot(n, s);
    vec3 Tl; vec3 Ll = ppHaze(mu, mu0, tvA, tvB, PA, PB, wA, wB, Tl);
    L = Ll; T = Tl;
  } else {
    float sigA = uSigA, sigB = uSigB;
    float span = min(dhKm, 600.0);
    int nAlt = int(clamp(ceil(span / 35.0), 1.0, 6.0));
    float hc = (b - 1.0) * RK;
    vec3 Tacc = vec3(0.0);
    for (int a = 0; a < nAlt + uSatZero; a++) {
      float hs = hc + span * ((float(a) + 0.5) / float(nAlt) - 0.5);
      if (hs < 0.0) {
        // this part of the footprint hits the planet: plane-parallel at the hit point
        float rr = (RK + hs) / RK;
        float mu = sqrt(max(1.0 - rr * rr, 1e-4));
        vec3 xh = cn * rr - d * mu;               // near-side hit point on the unit sphere
        float mu0 = dot(xh, s);
        vec3 Tl; vec3 Ll = ppHaze(mu, mu0, tvA, tvB, PA, PB, wA, wB, Tl);
        L += Ll; Tacc += Tl;
        continue;
      }
      vec3 cs = cn * (RK + hs);
      vec3 La = vec3(0.0);
      const int NS = 24;
      float lMax = 3.6 * sigB;
      float dl = 2.0 * lMax / float(NS);
      for (int j = 0; j < NS + uSatZero; j++) {
        float l = -lMax + (float(j) + 0.5) * dl;
        vec3 x = cs + d * l;
        float rx = length(x);
        float hx = rx - RK;
        vec3 bA = tauA(hx) / sqrt(6.2831853 * rx * HA);
        vec3 bB = tauB(hx) / sqrt(6.2831853 * rx * HB);
        vec3 bT = bA + bB;
        // transmission from the camera to the start of this step; in-step extinction handled exactly
        vec3 Tv = exp(-(colA(hs, -(l - 0.5 * dl) / sigA) + colB(hs, -(l - 0.5 * dl) / sigB)));
        // sunlight along the sun line through x
        float l0 = dot(x, s);
        float bs = length(x - s * l0);
        float ht = bs - RK;
        vec3 tS;
        float lit = 1.0;
        if (ht >= 0.0) {
          tS = colA(ht, l0 / sigA) + colB(ht, l0 / sigB);
        } else {
          lit = l0 >= 0.0 ? 1.0 : smoothstep(-25.0, 25.0, ht);
          float mus = max(dot(x / rx, s), 0.03);
          tS = (tauA(hx) / kA + tauB(hx) / kB) / mus;
        }
        vec3 srcN = (bA * wA * PA + bB * wB * PB) / max(bT, vec3(1e-12)); // albedo-weighted phase
        La += srcN * Tv * (1.0 - exp(-bT * dl)) * exp(-tS) * lit;
        La += vec3(0.92, 0.97, 1.05) * PB * layers(hx, latT) * dl * Tv * exp(-tS) * lit;
      }
      L += La * 0.25;
      Tacc += exp(-(tauA(hs) + tauB(hs)));
    }
    L /= float(nAlt);
    T = Tacc / float(nAlt);
  }
  gl_FragColor = vec4(satDisplay(L * uHazeGain * uGain * uSunColor), clamp(dot(T, vec3(0.3333)), 0.0, 1.0));
}`;

export function createAtmosphere(ctx, shared) {
  const R = ctx.data.radius;
  const top = 1 + 1100 / 60268;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uCamR: shared.uCamR,
      uSunR: shared.uSunR,
      uSunColor: ctx.U.uSunColor,
      uFlat: shared.uFlat,
      uTop: { value: top },
      uSunAngR: shared.uSunAngR,
      uHazeGain: { value: 1 },
      uGain: shared.uGain,
      uSigA: { value: Math.sqrt(60268 * 45) },
      uSigB: { value: Math.sqrt(60268 * 180) },
      uExposure: ctx.U.uExposure,
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 192, 96), mat);
  mesh.scale.set(R * top, R * top * shared.uFlat.value, R * top);
  mesh.renderOrder = 11;
  mesh.name = 'saturn-haze';
  return mesh;
}
