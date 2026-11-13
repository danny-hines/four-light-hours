// Saturn's major moons. Real orbits (JPL SSD mean elements: mean longitude at J2000 measured from the ascending
// node of the Laplace plane on the ICRF equator = the +x axis of poleQuaternion('saturn'); BODIES periods), all
// synchronously rotating (sub-Saturn point at longitude 0, leading apex at 90 W).
// Icy moons: procedural craters + each moon's signature feature (Mimas: Herschel; Tethys: Odysseus and Ithaca
// Chasma; Dione and Rhea: dark trailing hemispheres with bright wisps, Rhea's rayed Inktomi; Enceladus: brilliant
// with the south-polar tiger stripes). Lit by the Sun (eclipsed analytically by Saturn) and by Saturnshine.
// Titan: an opaque core inside a raymarched shell of orange photochemical haze with the bluish detached layer.
import * as THREE from 'three';
import { NOISE_GLSL } from '../../glsl/noise.js';
import { RING_GLSL } from './rings-glsl.js';
import { DEG, circularOrbitOffset } from '../../core/astro.js';

// mean longitude at J2000 (deg) = node + peri + M  (JPL SSD sat_elem, epoch 2000-01-01.5)
export const MOON_L0 = { mimas: 141.9, enceladus: 176.5, tethys: 248.3, dione: 328.0, rhea: 209.5, titan: 168.6 };

// big: named basins [lat, lon E (deg), angular radius (rad), depth, central peak (moon radii)]
const ICY = {
  mimas: { id: 0, alb: [0.56, 0.555, 0.55], ls: 0.55, big: [[1.7, -111.8, 0.36, 0.05, 0.035]] }, // Herschel, 139 km
  enceladus: { id: 1, alb: [0.97, 0.975, 0.99], ls: 0.35, big: [] },
  tethys: { id: 2, alb: [0.74, 0.735, 0.73], ls: 0.45, big: [[32.8, -128.9, 0.42, 0.025, 0.012]] }, // Odysseus (relaxed)
  dione: { id: 3, alb: [0.60, 0.595, 0.59], ls: 0.55, big: [] },
  rhea: { id: 4, alb: [0.55, 0.535, 0.52], ls: 0.6, big: [[34.0, -151.0, 0.33, 0.02, 0.006], [-14.1, -112.1, 0.04, 0.012, 0.003]] }, // Tirawa, Inktomi
};
const dirLL = (lat, lon) => {
  const la = lat * DEG, lo = lon * DEG;
  return new THREE.Vector4(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo), 0);
};

const ICY_VERT = /* glsl */ `
varying vec3 vL;
void main() {
  vL = position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;

const ICY_FRAG = /* glsl */ `
${NOISE_GLSL}
${RING_GLSL}
uniform vec3 uSunL;     // sun direction, moon-local
uniform vec3 uCamL;     // camera, moon-local (moon radii)
uniform vec3 uSatL;     // Saturn centre, moon-local (moon radii)
uniform float uSatR;    // Saturn equatorial radius in moon radii
uniform float uFlat;
uniform vec3 uAlb;
uniform float uLS;      // Lommel-Seeliger fraction
uniform int uMoonId;
uniform vec3 uSunColor;
uniform vec3 uSatAlb;
uniform float uGain;
uniform vec4 uBig[2];   // named basins: centre direction (xyz), angular radius (rad, 0 = none)
uniform vec4 uBigP[2];  // depth, central peak height (moon radii)
varying vec3 vL;

// Compile-cost note: FXC (ANGLE's D3D11 back end) unrolls constant-bound loops and inlines every call. The height
// field is evaluated three times (finite-difference normal) inside ONE loop, the crater octaves x 27 cells are one
// nested real loop, and every simplex evaluation of the height field goes through one call site (loop bounds
// 'N + uSatZero', see rings-glsl.js), so the program compiles in a fraction of the time with the same image.

// Crater field (heights in moon radii). Saturated, power-law population: each octave halves the crater size and
// carries the same areal density, so small craters are far more numerous; every crater draws its own freshness:
// fresh ones are deep (d/D ~ 0.2) with sharp raised rims and a little ejecta, old ones shallow with soft rims;
// big ones get flat floors and central peaks. Newer (smaller) craters overwrite the terrain inside them, which is
// what saturated surfaces look like (no "bubble wrap" of summed dimples).
float craterField(vec3 p, float fp, float density, inout float albC) {
  float h = 0.0;
  float fq = 2.2;
  for (int o = 0; o < 6 + uSatZero; o++) {
    float w = 1.0 - smoothstep(0.08, 0.2, fp * fq);
    if (w <= 0.0) break;
    float seed = 1.0 + 7.0 * float(o);
    vec3 x = p * fq;
    vec3 ci = floor(x), f = fract(x);
    float hn = h;
    for (int c = 0; c < 27 + uSatZero; c++) {
      vec3 g = vec3(float(c - 3 * (c / 3)), float((c / 3) - 3 * (c / 9)), float(c / 9)) - 1.0;
      vec3 o1 = hash33(ci + g + seed);
      if (o1.x > 0.72 * density) continue;
      vec3 o2 = hash33(ci + g + seed + 17.31);
      float rc = 0.14 + 0.30 * o1.z * o1.z;             // cell units
      vec3 r = g + o2 * 0.8 + 0.1 - f;
      float lr = length(r);
      float d = lr / rc;
      if (d > 2.2) continue;
      // slightly irregular, polygonal outlines (real craters are rarely perfect circles): 2nd/3rd harmonics of the
      // azimuth, taken from two random in-cell directions (no atan)
      vec3 rn = r / max(lr, 1e-6);
      float c1 = dot(rn, normalize(o1 - 0.5)), c2 = dot(rn, normalize(o2.zxy - 0.5));
      d *= 1.0 + 0.05 * (4.0 * c1 * c1 * c1 - 3.0 * c1) + 0.04 * (2.0 * c2 * c2 - 1.0);
      float fr = o2.x * o2.x;                          // freshness (most craters are old)
      float R = rc / fq;                               // crater radius, moon radii
      float big = smoothstep(0.035, 0.08, R);
      // depth/diameter ~0.2 when fresh and simple, shallower when degraded or complex (flat floor, central peak)
      float depth = 2.0 * R * (0.04 + 0.11 * fr) * (1.0 - 0.5 * big);
      // bowl with zero slope at the rim and (complex craters) at the flat floor's edge: no zero-width outline
      float prof = d < 1.0 ? -depth * (1.0 - smoothstep(0.5 * big, 1.0, d)) : 0.0;
      float rw = 0.16 + 0.24 * (1.0 - fr);
      prof += depth * (0.16 + 0.2 * fr) * exp(-pow((d - 1.0) / rw, 2.0));
      // ejecta blanket: continuous at the rim and back to 0 before the cell cut-off
      prof += depth * 0.12 * fr * exp(-max(d - 1.0, 0.0) * 2.2) * smoothstep(0.9, 1.25, d) * (1.0 - smoothstep(1.5, 2.15, d));
      prof += big * depth * 0.4 * exp(-pow(d / 0.16, 2.0));
      float wIn = 1.0 - smoothstep(0.6, 1.35, d);
      hn = hn * (1.0 - wIn * (0.3 + 0.6 * fr)) + prof;
      albC += fr * 0.10 * exp(-pow(max(d - 0.9, 0.0) / 0.5, 2.0)) - 0.03 * wIn * (1.0 - fr);
    }
    h = mix(h, hn, w);
    fq *= 2.15;
  }
  return h;
}

// height field (moon radii) and albedo factor. Its noise inputs are evaluated beforehand in main()'s single simplex
// loop: rg = regolith fbm at this point, nz = Enceladus' plains / south-polar fields (at the pixel centre)
float heightField(vec3 p, out float albMod, float fp, float rg, vec4 nz) {
  albMod = 1.0;
  float density = 1.0;
  bool enc = uMoonId == 1;
  // Enceladus: young plains, crater-free south polar terrain
  if (enc) density = (0.25 + 0.75 * smoothstep(-0.2, 0.5, p.y) * (1.0 - 0.6 * smoothstep(0.25, 0.6, abs(p.z)))) * smoothstep(-0.86, -0.74, p.y);
  float albC = 0.0;
  float h = craterField(p, fp, density, albC);
  albMod *= 1.0 + albC;

  vec2 q = p.xz / max(1e-3, 1.0 + abs(p.y));     // south-polar stereographic coordinates (Enceladus)
  float nw = nz.x, ns1 = nz.y, nseg = nz.z, nsr = nz.w;
  // fine regolith roughness
  h += 0.0004 * rg * (1.0 - smoothstep(0.1, 0.3, fp * 90.0));

  // named basins (uBig): Mimas' Herschel, Tethys' Odysseus, Rhea's Tirawa and Inktomi
  for (int b = 0; b < 2 + uSatZero; b++) {
    vec4 B = uBig[b];
    if (B.w <= 0.0) continue;
    float a = acos(clamp(dot(p, B.xyz), -1.0, 1.0)) / B.w;
    float depth = uBigP[b].x;
    h += -depth * (1.0 - smoothstep(0.3, 1.0, a))                  // flat floor, smooth walls, zero slope at the rim
       + 0.45 * depth * exp(-pow((a - 1.0) / 0.12, 2.0)) + 0.15 * depth * exp(-max(a - 1.0, 0.0) * 3.0) * smoothstep(0.92, 1.2, a)
       + uBigP[b].y * exp(-pow(a / 0.13, 2.0));
  }
  if (enc) {
    // ridged plains (Samarkand, Harran... Sulci): belts of PARALLEL ridges and troughs a few km apart whose
    // orientation swings slowly from region to region; each ridge is made of segments of varying height
    float plains = smoothstep(0.2, 0.55, abs(p.z)) * smoothstep(-0.75, -0.55, p.y) * (1.0 - smoothstep(0.35, 0.7, p.y));
    // phase of a gently perturbed linear field: long, parallel, slowly curving ridges (not closed contours)
    vec3 ax = normalize(vec3(0.35, 1.0, 0.15));
    float s1 = dot(p, ax) * 95.0 + 9.0 * nw + 1.6 * ns1;
    float rg1 = 1.0 - abs(sin(s1)); rg1 = rg1 * rg1 * rg1;
    float seg = smoothstep(-0.4, 0.5, nseg);
    float wr1 = 1.0 - smoothstep(0.12, 0.3, fp * 95.0 / 6.283);
    float rid = rg1 * wr1 * seg;
    h += plains * 0.0022 * rid;
    albMod *= 1.0 + plains * 0.03 * rid;
    // tiger stripes: ~2 km troughs flanked by raised ridges (and the SPT's own ridged terrain)
    if (p.y < -0.78) {
      vec2 ax2 = normalize(vec2(0.8, 0.6)), pe = vec2(-0.6, 0.8);
      float along = dot(q, pe);
      float qq = dot(q, ax2) + 0.9 * along * along;
      float lenM = 1.0 - smoothstep(0.08, 0.16, abs(along));
      float spt = smoothstep(-0.78, -0.86, p.y);
      for (int k = 0; k < 4 + uSatZero; k++) {
        float x = qq - (-0.09 + 0.06 * float(k));
        h += spt * lenM * (-0.0022 * exp(-pow(x / 0.0045, 2.0)) + 0.0016 * exp(-pow((abs(x) - 0.009) / 0.0045, 2.0)));
      }
      float sr = 1.0 - abs(nsr);
      h += spt * 0.0012 * sr * sr * (1.0 - smoothstep(0.1, 0.3, fp * 40.0));
    }
  } else if (uMoonId == 2) { // Tethys: Ithaca Chasma follows the great circle 90 deg from Odysseus
    float gc = dot(p, uBig[0].xyz);
    float pol = 1.0 - smoothstep(0.7, 0.95, abs(p.y));
    h += (-0.015 * exp(-pow(gc / 0.06, 2.0)) + 0.006 * exp(-pow((abs(gc) - 0.09) / 0.02, 2.0))) * pol;
    albMod *= 1.0 - 0.06 * exp(-pow(gc / 0.08, 2.0));
  } else if (uMoonId == 4) { // Rhea: Inktomi (uBig[1]) bright rays
    vec3 ik = uBig[1].xyz;
    float a = acos(clamp(dot(p, ik), -1.0, 1.0));
    vec3 t1 = normalize(cross(ik, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(ik, t1);
    float ang = atan(dot(p, t2), dot(p, t1));
    float rays = pow(max(0.0, sin(ang * 9.0 + 1.3) * sin(ang * 5.0 + 0.4)), 2.0);
    albMod *= 1.0 + 0.9 * exp(-a / 0.05) + 0.45 * rays * exp(-a / 0.35) * smoothstep(0.03, 0.08, a);
  }
  return h;
}

void main() {
  vec3 n0 = normalize(vL);
  float fp = max(length(fwidth(vL)), 1e-5);
  // object-space finite-difference normal (no screen-space derivative artifacts at the limb): the height field at
  // the point and at two tangent offsets, in one loop (a single inlined copy of the whole field)
  vec3 t1 = normalize(cross(n0, abs(n0.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n0, t1);
  float eps = max(fp * 0.75, 2e-5);
  vec3 P1 = normalize(n0 + t1 * eps), P2 = normalize(n0 + t2 * eps);
  // ALL simplex noise of this shader, one call site: i 0-8 regolith octave (i % 3) at sample point i / 3 (centre and
  // the two finite-difference offsets), 9-12 Enceladus' fields, 13-16 albedo fbm, 17-20 Dione/Rhea wisps (ridged)
  bool enc = uMoonId == 1;
  bool wisps = uMoonId == 3 || uMoonId == 4;
  float wReg = 1.0 - smoothstep(0.1, 0.3, fp * 90.0);
  float wTex = 1.0 - smoothstep(0.1, 0.3, fp * 9.0);
  vec2 q0 = n0.xz / max(1e-3, 1.0 + abs(n0.y));
  vec3 rgv = vec3(0.0);
  vec4 nzE = vec4(0.0);
  float tex = 0.0, wisp = 0.0, ww = 1.0;
  for (int i = 0; i < 21 + uSatZero; i++) {
    bool need = i < 9 ? wReg > 0.0 : (i < 13 ? enc : (i < 17 ? wTex > 0.0 : wisps));
    if (!need) continue;
    vec3 x;
    float fi;
    if (i < 9) { int k = i / 3; fi = float(i - 3 * k); x = (k == 0 ? n0 : (k == 1 ? P1 : P2)) * (90.0 * pow(2.03, fi)) + vec3(1.7, 9.2, 3.1) * fi; }
    else if (i == 9) x = n0 * 1.3 + 4.0;
    else if (i == 10) x = n0 * 3.5;
    else if (i == 11) x = n0 * 7.0 + 3.0;
    else if (i == 12) x = vec3(q0 * 40.0, 1.0);
    else if (i < 17) { fi = float(i - 13); x = n0 * 9.0 * pow(2.03, fi) + vec3(1.7, 9.2, 3.1) * fi; }
    else { fi = float(i - 17); x = (n0 * vec3(2.5, 6.0, 2.5) + vec3(3.0, 0.0, 1.0)) * pow(2.07, fi) + vec3(5.1, 1.3, 7.7) * fi; }
    float n = snoise(x);
    if (i < 9) rgv += vec3(equal(ivec3(i / 3), ivec3(0, 1, 2))) * (pow(0.5, fi + 1.0) / 0.875) * n;
    else if (i < 13) nzE += vec4(equal(ivec4(i - 9), ivec4(0, 1, 2, 3))) * n;
    else if (i < 17) tex += pow(0.5, fi + 1.0) / 0.9375 * n;
    else { float r = 1.0 - abs(n); r *= r * ww; ww = clamp(r * 2.0, 0.0, 1.0); wisp += pow(0.5, fi + 1.0) / 0.9375 * r; }
  }
  float h = 0.0, h1 = 0.0, h2 = 0.0, albMod = 1.0;
  for (int k = 0; k < 3 + uSatZero; k++) {
    vec3 pk = k == 0 ? n0 : (k == 1 ? P1 : P2);
    float am;
    float hk = heightField(pk, am, fp, k == 0 ? rgv.x : (k == 1 ? rgv.y : rgv.z), nzE);
    if (k == 0) { h = hk; albMod = am; } else if (k == 1) h1 = hk; else h2 = hk;
  }
  vec3 grad = ((h1 - h) * t1 + (h2 - h) * t2) / eps;
  vec3 N = normalize(n0 - grad);

  vec3 alb = uAlb * albMod;
  float latD = degrees(asin(clamp(n0.y, -1.0, 1.0)));
  // leading (90W = +z) vs trailing hemisphere albedo contrast (E-ring coating vs plasma darkening)
  float lead = n0.z;
  if (wisps) {
    alb *= 1.0 + 0.12 * lead;
    // trailing-hemisphere wisps (bright fracture belts)
    float tr = smoothstep(0.1, 0.6, -lead);
    alb *= 1.0 + tr * (0.55 * smoothstep(0.55, 0.85, wisp) - 0.08);
  } else if (uMoonId == 2) {
    alb *= 1.0 + 0.05 * lead;
  } else if (uMoonId == 1 && latD < -55.0) {
    // tiger stripes: four parallel sulci across the south polar terrain, bluish
    vec2 q = n0.xz / max(1e-3, 1.0 + abs(n0.y));
    float along = dot(q, vec2(-0.6, 0.8));
    float qq = dot(q, normalize(vec2(0.8, 0.6))) + 0.9 * along * along;
    float stripes = 0.0;
    for (int k = 0; k < 4 + uSatZero; k++) {
      float c = -0.09 + 0.06 * float(k);
      stripes += exp(-pow((qq - c) / 0.007, 2.0)) * (1.0 - smoothstep(0.08, 0.16, abs(along)));
    }
    stripes *= smoothstep(-55.0, -62.0, latD);
    alb = mix(alb, vec3(0.55, 0.62, 0.72), clamp(stripes, 0.0, 1.0) * 0.8);
  }
  alb *= 1.0 + 0.08 * tex * wTex;

  vec3 V = normalize(uCamL - n0);
  float mu0 = dot(N, uSunL);
  float mu = max(dot(N, V), 1e-3);
  float m0 = max(mu0, 0.0);
  float ca = clamp(dot(uSunL, V), -1.0, 1.0);
  float alpha = acos(ca);
  float surge = 1.0 + 0.4 * exp(-alpha / 0.08);
  float phaseF = (1.0 - 0.35 * alpha / 3.14159) * surge;
  // Beyond the geometric terminator the Sun is below the mean horizon by delta; a point h above the mean sphere still
  // sees it while h > delta^2 / 2 (moon radii). So rims and peaks of big craters (Herschel!) keep catching light a
  // few degrees into the night while their floors stay dark -- at the terminator a big crater reads as a dark bowl
  // with a lit far rim and peak, not as a smooth bite out of the disc.
  float cz = dot(n0, uSunL);
  float dlt = max(-cz, 0.0);
  float term = max(smoothstep(-0.035, 0.05, cz), smoothstep(0.0005, 0.004, h - 0.5 * dlt * dlt) * (1.0 - smoothstep(0.25, 0.35, dlt)));
  float brdf = mix(m0, 2.0 * m0 / (m0 + mu), uLS) * phaseF * term;
  // eclipse by Saturn
  vec3 ps = (n0 - uSatL) / uSatR;
  vec3 sh = planetShadow(ps, uSunL, uFlat);
  // Saturnshine
  vec3 toS = uSatL - n0;
  float dS = length(toS);
  vec3 sd = toS / dS;
  float ap = acos(clamp(dot(-sd, uSunL), -1.0, 1.0));
  float Phi = (sin(ap) + (3.14159265 - ap) * cos(ap)) / 3.14159265;
  float rho2 = pow(uSatR / dS, 2.0);
  float wrap = clamp((dot(N, sd) + 0.25) / 1.25, 0.0, 1.0);
  vec3 sshine = uSatAlb * Phi * rho2 * wrap;
  vec3 L = alb * (brdf * sh + sshine) * uSunColor * uGain;
  gl_FragColor = vec4(L, 1.0);
}`;

// ------------------------------------------------------------------------------------------------- Titan
const TITAN_FRAG_CORE = /* glsl */ `
uniform vec3 uSunL;
uniform float uGain;
varying vec3 vL;
void main() {
  vec3 n = normalize(vL);
  float m0 = max(dot(n, uSunL), 0.0);
  gl_FragColor = vec4(vec3(0.03, 0.02, 0.01) * m0 * uGain, 1.0);
}`;

const TITAN_FRAG_SHELL = /* glsl */ `
uniform vec3 uSunL;
uniform vec3 uCamL;      // camera, Titan-local, km
uniform vec3 uSunColor;
uniform float uRt;       // solid radius km
uniform float uTop;      // shell radius km
uniform float uGain;
uniform int uSatZero;    // never set (0): keeps FXC from unrolling the march (see rings-glsl.js)
varying vec3 vL;         // shell point, km

vec2 rsph(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, h = b * b - c;
  if (h < 0.0) return vec2(1e20, -1e20);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
float erfcA(float x) {
  float ax = abs(x);
  float t = 1.0 + ax * (0.278393 + ax * (0.230389 + ax * (0.000972 + ax * 0.078108)));
  float r = 1.0 / (t * t * t * t);
  return x >= 0.0 ? r : 2.0 - r;
}
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-5), 1.5); }

// haze model (km): main haze exponential, detached layer near 480 km, N2 Rayleigh
const float HH = 62.0;
const vec3 B0 = vec3(0.74, 1.0, 1.43) * (5.0 / 62.0) ;  // per km at the surface: vertical tau ~ 5 (green)
const vec3 BD = vec3(0.50, 1.0, 2.0) * 1.05e-4;         // detached layer peak (small grains: blue-violet)
const float ZD = 500.0, SD = 10.0;                       // (wave 3: thinner and fainter -- a delicate separate thread)
const vec3 BR = vec3(0.25, 0.55, 1.25) * 2.0e-4;        // Rayleigh at surface (scale height 45 km)
const float HR = 45.0;

vec3 extinction(float z, out vec3 bh, out vec3 bd, out vec3 br) {
  // main haze: exponential, cut off above ~320 km, leaving the clear gap under the detached layer (Cassini UVIS/ISS:
  // extinction minimum near 420 km, detached layer at ~500 km)
  // (wave 3: the cut-off starts at 270 km and is steeper, so the backlit ring is a fine bright rim with a dark gap
  //  under the detached thread instead of one thick glowing tube out to 500 km)
  float zc = max(z - 270.0, 0.0);
  bh = B0 * exp(-max(z, 0.0) / HH - zc * zc / 2600.0);
  bd = BD * exp(-0.5 * pow((z - ZD) / SD, 2.0));
  br = BR * exp(-max(z, 0.0) / HR);
  return bh + bd + br;
}
// optical depth from p toward the sun (exponential haze, Gaussian Chapman form)
vec3 tauToSun(vec3 p, vec3 s) {
  float r = length(p);
  float l0 = dot(p, s);
  float bs = length(p - s * l0);
  float sig = sqrt(2.0 * bs * HH);
  float zt = bs - uRt;
  if (zt < 0.0 && l0 < 0.0) return vec3(80.0); // behind the solid body
  float zc = max(zt, 0.0);
  vec3 tt = B0 * exp(-zc / HH) * sqrt(6.2831853 * bs * HH) * 0.5 * erfcA(l0 / sig);
  if (zt < 0.0) { // sun line dips below the surface but p is sunward: vertical-ish path
    float mus = max(l0 / r, 0.03);
    tt = B0 * HH * exp(-(r - uRt) / HH) / mus;
  }
  // detached layer: crude slant column
  float mus2 = max(abs(l0) / r, 0.08);
  tt += BD * SD * 2.5 * smoothstep(ZD + 60.0, ZD - 20.0, r - uRt) / mus2;
  return tt;
}

void main() {
  vec3 ro = uCamL;
  vec3 rd = normalize(vL - uCamL);
  vec2 ts = rsph(ro, rd, uTop);
  vec2 tg = rsph(ro, rd, uRt);
  float t0 = max(ts.x, 0.0);
  bool hitCore = tg.x < tg.y && tg.x > 0.0;
  float t1 = hitCore ? tg.x : ts.y;
  if (t1 <= t0) discard;
#ifdef TITAN_DEBUG
  gl_FragColor = vec4(0.05, 0.0, 0.0, 0.0); return;
#endif
  vec3 s = uSunL;
  float cth = dot(rd, s);
  float Ph = 0.78 * hg(cth, 0.66) + 0.22 * hg(cth, -0.1);
  float Pd = 0.8 * hg(cth, 0.55) + 0.2;
  float Pr = 0.75 * (1.0 + cth * cth);
  vec3 wH = vec3(0.94, 0.815, 0.52);    // main haze single-scattering albedo (absorbs blue -> orange)
  vec3 wD = vec3(0.97, 0.96, 0.93);
  // non-uniform steps: denser near the closest approach to the surface
  const int NS = 44;
  // white (unstructured) per-pixel jitter: an interleaved-gradient pattern showed up as a fine hatch at the terminator
  vec2 jq = fract(gl_FragCoord.xy * vec2(0.1031, 0.1030));
  jq += dot(jq, jq.yx + 33.33);
  float jit = 0.2 + 0.6 * fract((jq.x + jq.y) * jq.x);
  float tcl = clamp(-dot(ro, rd), t0, t1);
  vec3 Tv = vec3(1.0), L = vec3(0.0);
  float prev = t0;
  for (int i = 0; i < NS + uSatZero; i++) {
    float u = (float(i) + 1.0) / float(NS);
    // piecewise warp: half the samples on each side of the closest approach, clustered toward it
    float t;
    if (u < 0.5) { float a = u / 0.5; t = mix(t0, tcl, 1.0 - (1.0 - a) * (1.0 - a)); }
    else { float a = (u - 0.5) / 0.5; t = mix(tcl, t1, a * a); }
    float dt = t - prev;
    float tm = prev + dt * jit;   // one stratified sample per segment (no step banding at the terminator)
    prev = t;
    if (dt <= 0.0) continue;
    vec3 p = ro + rd * tm;
    float r = length(p);
    float z = r - uRt;
    vec3 bh, bd, br;
    vec3 ext = extinction(z, bh, bd, br);
    vec3 Ts = exp(-tauToSun(p, s));
    float mus = dot(p / r, s);
    // seasonal structure (late 2026 = early northern autumn on Titan): the north polar hood building up over
    // the pole with a darker collar near 55-60 N, the hemispheric (north-south) asymmetry with the north a little
    // darker and redder, and faint latitudinal haze bands
    float lat = asin(clamp(p.y / r, -1.0, 1.0));
    float hood = smoothstep(radians(50.0), radians(64.0), lat);
    float collar = exp(-pow((lat - radians(57.0)) / radians(4.0), 2.0));
    float nsa = smoothstep(radians(-12.0), radians(12.0), lat);
    vec3 wHl = wH * mix(vec3(1.0), vec3(0.89, 0.80, 0.71), hood) * mix(vec3(1.0), vec3(0.88, 0.85, 0.81), collar);
    wHl *= mix(vec3(1.018, 1.024, 1.034), vec3(0.98, 0.966, 0.94), nsa) * (1.0 + 0.007 * sin(lat * 9.0 + 0.7));
    wHl = min(wHl, vec3(0.985));
    // multiple scattering: diffuse field sustained by high single-scattering albedo
    vec3 ms = wHl * wHl / (1.0 - wHl * 0.9) * 0.10 * smoothstep(-0.25, 0.6, mus) * exp(-0.25 * tauToSun(p, s)) ;
    vec3 src = bh * wHl * (Ph * 0.25 * Ts + ms) + bd * wD * Pd * 0.25 * Ts + br * Pr * 0.25 * Ts;
    vec3 dtau = ext * dt;
    vec3 Tstep = exp(-dtau);
    L += Tv * src * (1.0 - Tstep) / max(ext, vec3(1e-8));
    Tv *= Tstep;
    if (max(Tv.r, max(Tv.g, Tv.b)) < 1e-3) break;
  }
  gl_FragColor = vec4(L * uSunColor * uGain, dot(Tv, vec3(0.3333)));
}`;

const TITAN_VERT_KM = /* glsl */ `
uniform float uScaleKm;
varying vec3 vL;
void main() {
  vL = position * uScaleKm;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;

export function createMoons(ctx, shared, poleQ) {
  const { BODIES, U } = ctx;
  const sat = BODIES.saturn;
  const KM = 6371;
  const moons = [];
  const group = new THREE.Group();
  group.name = 'saturn-moons';

  const mk = (id) => {
    const m = sat.moons[id];
    const aU = m.aKm / KM;
    const L0 = MOON_L0[id];
    const P = m.periodDays;
    const tmp = new THREE.Vector3();
    const positionAt = (d) => circularOrbitOffset(aU, P, L0, d, poleQ, new THREE.Vector3());
    return { m, aU, L0, P, positionAt, tmp };
  };

  for (const id of ['mimas', 'enceladus', 'tethys', 'dione', 'rhea']) {
    const o = mk(id);
    const cfg = ICY[id];
    const uni = {
      uSunL: { value: new THREE.Vector3() },
      uCamL: { value: new THREE.Vector3() },
      uSatL: { value: new THREE.Vector3() },
      uSatR: { value: sat.radius / o.m.radius },
      uFlat: shared.uFlat,
      uAlb: { value: new THREE.Vector3(...cfg.alb) },
      uLS: { value: cfg.ls },
      uMoonId: { value: cfg.id },
      uSunColor: U.uSunColor,
      uSatAlb: { value: new THREE.Vector3(0.5, 0.44, 0.33) },
      uGain: shared.uGain,
      uSunAngR: shared.uSunAngR,
      uRingProf: { value: null },
      uRingAlb: { value: null },
      uRingFine: { value: null },
      uRingM0: { value: 7 },
      uRingFineN: { value: 1 },
      uBig: { value: [0, 1].map((k) => (cfg.big[k] ? dirLL(cfg.big[k][0], cfg.big[k][1]).setW(cfg.big[k][2]) : new THREE.Vector4(0, 1, 0, 0))) },
      uBigP: { value: [0, 1].map((k) => new THREE.Vector4(cfg.big[k]?.[3] ?? 0, cfg.big[k]?.[4] ?? 0, 0, 0)) },
    };
    const mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader: ICY_VERT, fragmentShader: ICY_FRAG });
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), mat);
    mesh.scale.setScalar(o.m.radius);
    mesh.name = id;
    group.add(mesh);
    moons.push({ id, name: o.m.name, radius: o.m.radius, positionAt: o.positionAt, mesh, uni, kind: 'icy', aU: o.aU });
  }

  // Titan
  {
    const o = mk('titan');
    const rt = o.m.radiusKm;
    const topKm = rt + 1050;
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(1, 96, 48),
      new THREE.ShaderMaterial({
        uniforms: { uSunL: { value: new THREE.Vector3() }, uScaleKm: { value: rt }, uGain: shared.uGain },
        vertexShader: TITAN_VERT_KM,
        fragmentShader: TITAN_FRAG_CORE,
      })
    );
    core.scale.setScalar(o.m.radius);
    const shellUni = {
      uSunL: core.material.uniforms.uSunL,
      uCamL: { value: new THREE.Vector3() },
      uSunColor: U.uSunColor,
      uRt: { value: rt },
      uTop: { value: topKm },
      uScaleKm: { value: topKm },
      uGain: shared.uGain,
    };
    const shell = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 64),
      new THREE.ShaderMaterial({
        uniforms: shellUni,
        vertexShader: TITAN_VERT_KM,
        fragmentShader: TITAN_FRAG_SHELL,
        transparent: true,
        depthWrite: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.SrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      })
    );
    shell.scale.setScalar((o.m.radius * topKm) / rt);
    const tg = new THREE.Group();
    tg.name = 'titan';
    tg.add(core, shell);
    group.add(tg);
    moons.push({ id: 'titan', name: o.m.name, radius: o.m.radius, positionAt: o.positionAt, mesh: tg, core, shell, shellUni, kind: 'titan', aU: o.aU });
  }

  const qInv = poleQ.clone().invert();
  const tmpV = new THREE.Vector3(), tmpS = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const basis = new THREE.Matrix4();
  const qLocal = new THREE.Quaternion();
  const ex = new THREE.Vector3(), ey = new THREE.Vector3(), ez = new THREE.Vector3();

  function update(frame, saturnWorldPos, sunWorld) {
    const d = frame.simDays;
    for (const mo of moons) {
      const off = mo.positionAt(d);
      mo.mesh.position.copy(off);
      // synchronous rotation: x toward Saturn, y = pole, z = direction of motion (leading)
      ex.copy(off).negate().normalize();
      ey.set(0, 1, 0).applyQuaternion(poleQ);
      ez.crossVectors(ex, ey).normalize();
      ex.crossVectors(ey, ez).normalize();
      basis.makeBasis(ex, ey, ez);
      qLocal.setFromRotationMatrix(basis);
      mo.mesh.quaternion.copy(qLocal);
      const qi = qLocal.clone().invert();
      const wp = tmpV.copy(saturnWorldPos).add(off); // moon centre, world (camera-relative)
      tmpS.copy(sunWorld).sub(wp).normalize().applyQuaternion(qi);
      tmpC.copy(wp).negate().applyQuaternion(qi); // camera (origin) in local axes, scene units
      if (mo.kind === 'icy') {
        mo.uni.uSunL.value.copy(tmpS);
        mo.uni.uCamL.value.copy(tmpC).divideScalar(mo.radius);
        mo.uni.uSatL.value.copy(off).negate().applyQuaternion(qi).divideScalar(mo.radius);
      } else {
        mo.core.material.uniforms.uSunL.value.copy(tmpS);
        mo.shellUni.uCamL.value.copy(tmpC).multiplyScalar(6371);
        // draw Titan's haze before or after Saturn's transparent layers depending on which is nearer
        const dT = wp.length(), dS = saturnWorldPos.length();
        mo.shell.renderOrder = dT < dS ? 20 : 2;
      }
    }
  }

  return { group, moons, update };
}
