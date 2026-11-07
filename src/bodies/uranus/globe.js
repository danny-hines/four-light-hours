// Uranus globe and its upper-haze shell.
//
// Appearance model (visible light, 2026 season: sub-solar latitude ~ +74 deg, northern spring):
//  * Cloud-deck reflectance follows a Minnaert law I/F = B0 mu0^k mu^(k-1) with per-channel B0 and k fitted to the
//    Voyager 2 true-colour disc (strong limb darkening, k ~ 0.9-1.0) and to Karkoschka's full-disc albedo spectrum
//    (methane absorbs red: B0 ~ 0.36 / 0.60 / 0.64).
//  * Seasonal north polar cap (HST/Keck/JWST 2014-2024): brighter and whiter north of ~60 N with a faint bright
//    collar at the edge and a darker lane near 50 N; tiny convective "popcorn" cells inside the cap.
//  * Very low-contrast zonal banding, sheared zonal streaks and a handful of small bright CH4-ice clouds at
//    mid-latitudes, all advected by the measured zonal wind profile (retrograde ~ -80 m/s at the equator, prograde
//    ~ +250 m/s jets near +-60 deg; Sromovsky et al. 2015) on top of the 17.24 h retrograde rotation.
//  * A thin single-scattering H2 Rayleigh + aerosol shell (scale height 32 km) gives the soft limb, the faint blue
//    rim and forward-scattering brightening of the crescent; it also slightly reddens/dims light at the terminator.
//  * Analytic shadows: rings (narrow dark lines when the Sun is low on the ring plane) and the five major moons.
//
// Shader compile budget (wave 2): Chrome/Windows compiles through ANGLE -> HLSL -> FXC, which inlines every function
// call and unrolls constant-bound loops. The deck shader used ~45 simplex-noise samples written as ~60 inlined copies
// (fbm, snoise3, a 10x unrolled cloud loop, 2x unrolled worley...): 4574 DXBC instructions, ~2.2 s to compile. Now
// every noise sample is one entry of a tap table (TAPS below) evaluated by one snoise() call site in one real loop,
// the clouds' two samples each by a second; Worley, the haze, ring and moon-shadow loops have uniform trip counts, and
// the loop bodies are branch-free apart from one guard (FXC's time explodes with conditional regions inside loops).
// 1086 instructions, ~0.3 s. The arithmetic per sample is unchanged, so the image is the same.
import * as THREE from 'three';
import { NOISE_GLSL } from '../../glsl/noise.js';
import { UNIFORMS_GLSL, COMMON_GLSL, FLAT } from './shared.js';
import { RING_GLSL } from './rings.js';

// Wind-driven drift: angular velocity relative to the interior, f(x) = u / cos(lat) in m/s with x = sin(lat).
// u(lat) = cos(lat) * (-80 + 667.2 x^2 + 141.6 x^4): -80 m/s at the equator, 0 at +-20 deg, ~250 m/s at +-60 deg.
const WIND_GLSL = /* glsl */ `
float windOmega(float x) {            // rad / day, positive = prograde
  float x2 = x * x;
  return (-80.0 + 667.2 * x2 + 141.6 * x2 * x2) * 86400.0 / 25559.0e3;
}
`;

// Small bright CH4-ice clouds: lat (deg), lon at epoch (deg), head half-size (deg), zonal elongation of the head,
// peak brightening (fraction of the deck reflectance in green: 1.1-1.25x, as in visible-light HST/Keck images, much
// less than in the near-IR), plume e-folding length (head sizes). A few big ones, more small ones, spread over
// 27-58 N (the higher ones sit well inside the disc in the pole-on view).
const CLOUDS = [
  [45.5, 20, 1.9, 1.5, 0.21, 6.0], // the brightest storm of the season (cf. Keck/HST, 30-50 N)
  [40.5, 150, 1.4, 1.4, 0.17, 3.5],
  [51.5, -95, 1.2, 1.3, 0.16, 2.5],
  [55.0, 75, 0.85, 1.2, 0.14, 2.0],
  [48.5, -150, 1.0, 1.6, 0.15, 4.5],
  [33.0, -40, 1.25, 1.7, 0.13, 3.0],
  [57.5, -70, 0.65, 1.2, 0.12, 1.5],
  [58.0, 110, 0.55, 1.3, 0.11, 1.8],
  [27.5, 200, 1.0, 1.8, 0.12, 2.5],
  [-28.0, 200, 1.4, 1.6, 0.15, 4.0], // south (in polar night in 2026)
];

// Noise taps of the deck: snoise(base * scale + offset) * weight, accumulated into a destination.
//   base:  0 q1, 1 q2 (the two flow-blend phases of the spin-frame point), 2 w1 = q1 + 0.03 warp1, 3 w2 = q2 + 0.03
//          warp2, 4 (cos lonW, sin lonW, 0) (cap-edge wave), 5 (latitude deg, 0, 0) (band noise)
//   dest:  0 cap-edge wave, 1 turbulent cap edge, 2 band noise, 3 cap low-frequency structure, 4 / 5 streak warps of
//          q1 / q2 (vector, component comp), 6 / 7 cell warps, 8 / 9 cell cluster strength, 10 zonal streaks
//   group: per-pixel LOD amplitude: 0 one, 1 cap-edge turbulence, 2 / 3 3rd / 4th band octave, 4 streaks on,
//          5 / 6 / 7 streak scale A / B / C amplitude, 8 cells on
//   phase: flow blend 0 none, 1 (1 - wb) (phase q1), 2 wb (phase q2)
// Exactly the samples of the original expressions (fbm(), snoise3(), mix(.., .., wb)); fbm octave i of
// fbm(P0, n) is snoise(P0 * 2.03^i + c_i) with c_i = c_{i-1} * 2.03 + (1.7, 9.2, 3.1), weight 0.5^(i+1) / sum.
function buildTaps() {
  const T = [];
  const add = (base, sc, off, w, dest, group, phase, comp = 0) => T.push({ base, sc, off, w, dest, group, phase, comp });
  const S3 = [[0, 0, 0], [31.416, -47.853, 12.793], [-233.145, -113.408, -185.31]]; // snoise3() offsets
  const v3 = (s) => [s, s, s];
  add(4, [3.5, 3.5, 0], [0, 0, 4], 0.4, 0, 0, 0); // cap-edge wave
  for (const [b, ph] of [[0, 1], [1, 2]]) {
    add(b, v3(26), v3(3), 0.9, 1, 1, ph); // turbulent cap edge: 0.9 (n(q 26 + 3) + 0.5 n(q 61))
    add(b, v3(61), v3(0), 0.45, 1, 1, ph);
  }
  add(5, [0.19, 0, 0], [0, 3.7, 1.3], 0.6, 2, 0, 0); // band noise in latitude
  add(5, [0.47, 0, 0], [0, 7.1, 9.2], 0.4, 2, 0, 0);
  add(5, [1.4, 0, 0], [0, 2.2, 5.5], 0.35, 2, 2, 0);
  add(5, [4.3, 0, 0], [0, 6.6, 0.5], 0.25, 2, 3, 0);
  for (const [b, ph] of [[0, 1], [1, 2]]) {
    add(b, v3(4), v3(2), 0.6, 3, 0, ph); // cap low-frequency structure
    add(b, v3(9), v3(7), 0.4, 3, 0, ph);
  }
  for (const [b, dest] of [[0, 4], [1, 5]]) S3.forEach((o, c) => add(b, v3(8), o, 1, dest, 4, 0, c)); // snoise3(q 8)
  for (const [b, dest] of [[0, 6], [1, 7]]) S3.forEach((o, c) => add(b, v3(30), o, 1, dest, 8, 0, c)); // snoise3(q 30)
  add(0, v3(9), v3(3), 1, 8, 8, 0); // cell cluster strength
  add(1, v3(9), v3(3), 1, 9, 8, 0);
  const fbm = (b, ph, sc0, off0, oct, group) => {
    let n = 0;
    for (let i = 0, a = 0.5; i < oct; i++, a *= 0.5) n += a;
    let sc = sc0.slice(), off = off0.slice();
    for (let i = 0, a = 0.5; i < oct; i++, a *= 0.5) {
      add(b, sc, off, a / n, 10, group, ph);
      sc = sc.map((v) => v * 2.03);
      off = off.map((v, j) => v * 2.03 + [1.7, 9.2, 3.1][j]);
    }
  };
  // zonal streaks on the warped points (st = (1, 9, 1) zonal stretch): fbm(w st 5 + (0, 11, 0), 4),
  // fbm(w st 22 + 5, 3), snoise(w (1, 3.5, 1) 70 + 9)
  for (const [b, ph] of [[2, 1], [3, 2]]) fbm(b, ph, [5, 45, 5], [0, 11, 0], 4, 5);
  for (const [b, ph] of [[2, 1], [3, 2]]) fbm(b, ph, [22, 198, 22], v3(5), 3, 6);
  for (const [b, ph] of [[2, 1], [3, 2]]) add(b, [70, 245, 70], v3(9), 1, 10, 7, ph);
  return T;
}
const TAPS = buildTaps();
// accumulator slot of a tap in the shader (S0..S4, see GLOBE_FRAG): scalars 0-3, warp vectors 4-15, clus / streak 16-18
function tapSlot(t) {
  return t.dest < 4 ? t.dest : t.dest < 8 ? 4 + 3 * (t.dest - 4) + t.comp : 16 + (t.dest - 8);
}

const GLOBE_VERT = /* glsl */ `
uniform float uFlat;
varying vec3 vPosW;
void main() {
  vec3 p = vec3(position.x, position.y * uFlat, position.z);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const GLOBE_FRAG = /* glsl */ `
${UNIFORMS_GLSL}
${NOISE_GLSL}
${COMMON_GLSL}
${RING_GLSL}
${WIND_GLSL}
#define NCLOUD ${CLOUDS.length}
#define NTAP ${TAPS.length}
uniform vec4 uCloudA[NCLOUD];   // lat rad, lon rad, half-size rad, elongation
uniform vec4 uCloudB[NCLOUD];   // brightness, plume length, drift rate (rad/day, signed), sin(1.7 index)
uniform vec4 uTapA[NTAP];       // noise tap: input scale (xyz), input base id (w)
uniform vec4 uTapB[NTAP];       // input offset (xyz), weight (w)
uniform vec4 uTapC[NTAP];       // accumulator slot, LOD group, flow phase, -
uniform int uNTap, uNCloud, uN2, uN27;
uniform vec3 uB0;               // Minnaert normal albedo
uniform vec3 uK;                // Minnaert exponent
uniform float uRotSign;         // sign of the spin rate (Uranus: -1, retrograde)
uniform float uDetail;
varying vec3 vPosW;

// rotate p about +y by angle a (same sense as the IAU W angle)
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }

// Worley F1/F2 (= worley() of glsl/noise.js, same visiting order) over the 27 neighbours in ONE real loop
vec2 worleyL(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  float d1 = 8.0, d2 = 8.0;
  for (int n = 0; n < uN27; n++) {
    vec3 g = vec3(float(n % 3 - 1), float((n / 3) % 3 - 1), float(n / 9 - 1));
    vec3 r = g + hash33(i + g) - f;
    float d = dot(r, r);
    d2 = min(d2, max(d1, d));   // (= the two smallest so far, branch-free)
    d1 = min(d1, d);
  }
  return sqrt(vec2(d1, d2));
}

void main() {
  // --- exact ray / oblate-deck intersection (scaled planet space), started from the mesh point
  vec3 rdW = normalize(vPosW);
  vec3 o = toPlanetS(vPosW);
  vec3 d = dirToPlanetS(rdW);
  vec2 th = raySphereS(o, d, 1.0);
  float tHit = th.x < 1e19 ? th.x : dot(-o, d);
  vec3 ps = o + d * tHit;                      // point on the unit deck sphere (scaled pole frame)
  ps = normalize(ps);
  vec3 L = dirToPlanetS(uSunDirW);
  // true (unscaled) local normal of the ellipsoid, then to world
  vec3 nP = normalize(vec3(ps.x, ps.y / uFlat, ps.z));            // pole frame (gradient of the ellipsoid)
  vec3 nW = uPoleBasis * nP;
  vec3 pW = uPlanetW + uPoleBasis * (vec3(ps.x, ps.y * uFlat, ps.z) * uR);
  vec3 V = normalize(-pW);
  vec3 Lw = uSunDirW;
  float mu0 = dot(nW, Lw);
  float mu = max(dot(nW, V), 0.0);

  // spin frame coordinates of the surface point (features rotate with the planet)
  vec3 sp = transpose(uSpinBasis) * (pW - uPlanetW) / uR;
  sp.y /= uFlat;
  sp = normalize(sp);
  float x = nP.y;                               // sin(planetographic latitude)
  float lat = asin(clamp(x, -1.0, 1.0));
  float latd = lat * 57.29578;
  float lon = atan(-sp.z, sp.x);

  // pixel footprint (units of R) for LOD
  float fp = length(fwidth(vPosW)) / uR;

  // --- zonal drift (flow-blended so sheared noise never over-stretches)
  float om = windOmega(x) * uRotSign;
  const float PER = 1.2;
  float ph1 = fract(uDays / PER), ph2 = fract(uDays / PER + 0.5);
  float wb = abs(ph1 * 2.0 - 1.0);
  vec3 q1 = rotY(sp, -om * ph1 * PER), q2 = rotY(sp, -om * ph2 * PER);
  // the cap boundary meanders slightly (low-wavenumber wave advected with the 60 N jet)
  float lonW = lon - windOmega(sin(61.0 / 57.29578)) * uRotSign * uDays;

  // footprint LOD of each group of noise taps (see TAPS in globe.js)
  float lCap = smoothstep(0.006, 0.0015, fp) * uDetail;       // turbulent cap edge (close range)
  float lB3 = smoothstep(0.01, 0.002, fp), lB4 = smoothstep(0.003, 0.0006, fp);
  float l1 = smoothstep(0.02, 0.004, fp);
  float l2 = smoothstep(0.004, 0.0009, fp) * uDetail;
  float l3 = smoothstep(0.0012, 0.0003, fp) * uDetail;
  float zoomC = smoothstep(0.004, 0.0012, fp);
  float lodC = smoothstep(0.004, 0.001, fp) * uDetail;
  float sOn = l1 > 0.0 ? 1.0 : 0.0;
  float cOn = lodC > 0.0 && latd > 55.0 ? 1.0 : 0.0;   // cells exist only in / near the cap (its edge is >= 57 N)

  // --- the simplex-noise samples of the deck: a table of taps in one real loop, then two samples per discrete cloud
  // in a second one (one snoise() call site each). The loop bodies are branch-free except for the guard of snoise():
  // FXC's compile time explodes with every conditional region inside a loop (measured: 16 guarded blocks in a loop
  // compile 2-3x slower than the same code under one guard), so selections are arithmetic (one-hot weights) and
  // ANGLE's ternaries (which it rewrites into if / else) are avoided.
  // accumulator slots (TAPS[].slot): S0 = (cap-edge wave, turbulent cap edge, band noise, cap LF structure),
  // S1..S3 = streak warps wv1.xyz, wv2.xyz and cell warps cw1.xyz, cw2.xyz in order, S4 = (clus1, clus2, streaks, -)
  vec4 S0 = vec4(0.0), S1 = vec4(0.0), S2 = vec4(0.0), S3 = vec4(0.0), S4 = vec4(0.0);
  vec4 G0 = vec4(1.0, lCap, lB3, lB4);
  vec4 G1 = sOn * vec4(1.0, mix(0.018, 0.055, zoomC), 0.06 * l2, 0.012 * l3);
  vec3 circ = vec3(cos(lonW), sin(lonW), 0.0), latv = vec3(latd, 0.0, 0.0);
  const vec4 I4 = vec4(0.0, 1.0, 2.0, 3.0);
  for (int k = 0; k < uNTap; k++) {
    vec4 A = uTapA[k], B = uTapB[k], C = uTapC[k];
    // per-pixel LOD amplitude of the tap's group, flow-blend phase weight, input point
    vec4 og0 = vec4(lessThan(abs(C.y - I4), vec4(0.5))), og1 = vec4(lessThan(abs(C.y - 4.0 - I4), vec4(0.5)));
    float amp = dot(og0, G0) + dot(og1, G1) + float(C.y > 7.5) * cOn;
    amp *= 1.0 - float(C.z > 0.5) + float(C.z > 0.5) * mix(1.0 - wb, wb, float(C.z > 1.5));
    vec4 ob0 = vec4(lessThan(abs(A.w - I4), vec4(0.5)));
    vec3 base = ob0.x * q1 + ob0.y * q2 + ob0.z * (q1 + 0.03 * S1.xyz) + ob0.w * (q2 + 0.03 * vec3(S1.w, S2.xy))
              + float(A.w > 3.5 && A.w < 4.5) * circ + float(A.w > 4.5) * latv;
    float n = 0.0;
    if (amp != 0.0) n = snoise(base * A.xyz + B.xyz);
    // weighted sample into its accumulator slot
    float v = n * amp * B.w;
    S0 += v * vec4(lessThan(abs(C.x - I4), vec4(0.5)));
    S1 += v * vec4(lessThan(abs(C.x - 4.0 - I4), vec4(0.5)));
    S2 += v * vec4(lessThan(abs(C.x - 8.0 - I4), vec4(0.5)));
    S3 += v * vec4(lessThan(abs(C.x - 12.0 - I4), vec4(0.5)));
    S4 += v * vec4(lessThan(abs(C.x - 16.0 - I4), vec4(0.5)));
  }
  float nWave = S0.x, nCapE = S0.y, nBand = S0.z, nCapLF = S0.w;
  vec3 cw1 = vec3(S2.zw, S3.x), cw2 = S3.yzw;
  float nClus1 = S4.x, nClus2 = S4.y, nStreak = S4.z;

  // discrete bright methane-ice clouds, advected individually by the wind at their latitude: compact bright cores
  // with a ragged edge and a long, fading plume sheared out along the zonal flow behind them (two samples each)
  float cl = 0.0, cn1 = 0.0;
  for (int kc = 0; kc < 2 * uNCloud; kc++) {
    int ci = kc / 2;
    float sub = float(kc - 2 * ci);
    vec4 cA = uCloudA[ci];
    vec4 cB = uCloudB[ci];
    float omc = cB.z;                          // = windOmega(sin(lat)) * uRotSign (precomputed)
    float lonc = cA.y + omc * uDays;
    float dlon = mod(lon - lonc + PI, 2.0 * PI) - PI;
    float dl = (lat - cA.x) / cA.z;
    float dz = dlon * cos(cA.x) / cA.z;
    float along = -dz * sign(omc + 1e-30);    // > 0 downstream: the plume trails behind the head
    bool cUse = dl * dl + dz * dz <= 9.0 || (along >= 0.0 && along <= 4.0 * cB.y + 3.0 && abs(dl) <= 3.5);
    // a compact, irregular head: anisotropic noise in the cloud frame (lat / lon), not a smooth ellipse
    float n = 0.0;
    if (cUse) n = snoise(mix(vec3(dz * 1.1, dl * 1.5, float(ci) * 3.1), vec3(dz * 2.9, dl * 3.6, float(ci) * 5.7 + 1.0), sub));
    // the first sample is kept, the second completes the cloud
    cn1 = mix(n, cn1, sub);
    float n1 = cn1, n2 = n;
    float nn = 0.65 * n1 + 0.35 * n2;
    float ez = dz / cA.w;
    float r2 = dl * dl * (1.0 + 0.3 * n1) + ez * ez;
    float head = 0.7 * exp(-r2 * 2.2 * (1.0 + 0.55 * nn)) + 0.3 * exp(-r2 * 6.0 * (1.0 + 0.4 * nn));
    // the plume: its length varies per cloud; it widens, fades, drifts a little in latitude and breaks up
    float aa = max(along, 0.0);
    float pw = 1.0 + 0.22 * aa;
    float pl = (dl - 0.08 * aa * cB.w) / pw;
    float tail = exp(-pl * pl * 1.8) * exp(-aa / cB.y) * smoothstep(-0.3, 1.2, along) * clamp(0.55 + 0.6 * nn, 0.0, 1.0) * 0.5;
    cl += float(cUse) * sub * cB.x * max(head, tail);
  }

  // --- latitude structure (very low contrast). All terms multiply the reflectance (never added in display space).
  vec3 alb = uB0;
  float wave = 0.35 * sin(lonW * 4.0 + 1.3) + 0.3 * sin(lonW * 11.0 - 0.4) + 0.25 * sin(lonW * 17.0 + 2.2) + nWave;
  float latc = latd + 0.8 * wave * smoothstep(45.0, 55.0, latd) * (1.0 - smoothstep(66.0, 75.0, latd));
  // up close the cap boundary is turbulent (eddies shed along the jet), not a smooth line
  latc += nCapE;
  // 2026 north polar cap (HST 2022 / JWST 2023): ~8 % brighter in green / blue and ~13 % in red than the
  // mid-latitudes, with a soft but definite edge (~3 deg wide) near 61 N, a darker collar lane (-3.5 %) at 55-58 N
  // just outside it, and a gentle further rise toward the pole.
  float cap = smoothstep(59.5, 62.5, latc);
  float poleG = smoothstep(65.0, 90.0, latd);
  float lane = exp(-pow((latc - 56.5) / 1.9, 2.0));
  float eq = exp(-pow(latd / 9.0, 2.0));
  float sCollar = exp(-pow((latd + 47.0) / 4.0, 2.0));  // Voyager-era southern collar (now in polar night)
  float sCap = smoothstep(-55.0, -75.0, latd);
  // many faint bands: deterministic band noise in latitude (nBand)
  float bandAmp = 0.009 * (1.0 - 0.6 * cap);
  vec3 m = vec3(1.0);
  // the cap is whiter (less CH4 absorption above its haze): red gains most
  m *= 1.0 + cap * vec3(0.13, 0.085, 0.075) + poleG * vec3(0.035, 0.025, 0.02);
  // low-frequency 1-2 % structure inside the cap (flow-blended so it drifts with the polar winds)
  m *= 1.0 + 0.016 * nCapLF * cap;
  m *= 1.0 - lane * vec3(0.04, 0.035, 0.03);
  // zonal bands, 2-3 % peak to peak (cf. the stretched Voyager disc and HST): the bright 45-50 N zone where the
  // CH4 storms form, a darker belt near 33 N, a faint bright zone near 21 N and a darker equatorial belt
  float zb = 0.012 * exp(-pow((latd - 47.0) / 4.0, 2.0)) - 0.01 * exp(-pow((latd - 33.0) / 4.5, 2.0))
           + 0.007 * exp(-pow((latd - 21.0) / 4.0, 2.0)) - 0.006 * exp(-pow((latd - 8.0) / 3.5, 2.0))
           + 0.006 * exp(-pow((latd + 22.0) / 5.0, 2.0)) - 0.008 * exp(-pow((latd + 35.0) / 4.0, 2.0));
  m *= 1.0 + zb * vec3(1.25, 1.0, 0.8);
  m *= 1.0 - eq * vec3(0.022, 0.012, 0.004);
  m *= 1.0 + sCollar * vec3(0.06, 0.045, 0.03) + sCap * vec3(0.12, 0.06, 0.03);
  m *= 1.0 + bandAmp * nBand * vec3(1.2, 1.0, 0.8);

  // --- domain-warped, zonally stretched turbulence at three scales (LOD-faded by pixel footprint; nStreak). The
  // finest octave is kept below ~1 % and only broad (it must never read as parallel scratches).
  float mid = smoothstep(6.0, 22.0, abs(latd)) * (1.0 - 0.45 * cap);
  float streak = nStreak * (0.45 + 0.55 * mid) * l1;
  m *= 1.0 + streak * vec3(1.25, 1.0, 0.8);

  // --- convective cells inside the polar hood (Keck H-band "popcorn"): coherent soft cells 300-800 km across
  // (Worley F2-F1: bright cell interiors, faint darker lanes), 1-3 % contrast, slightly whiter; flow-blended.
  if (lodC > 0.0 && cap + poleG > 0.0) {
    float cells = 0.0;
    for (int j = 0; j < uN2; j++) {
      float fj = float(j);
      vec3 wq = mix(q1, q2, fj) * 48.0 + 0.45 * mix(cw1, cw2, fj);
      vec2 f12 = worleyL(wq);
      float e = f12.y - f12.x;                          // 0 on cell walls
      float cell = smoothstep(0.0, 0.45, e) - 0.55;     // soft interiors, lanes
      float clus = 0.6 + 0.4 * mix(nClus1, nClus2, fj); // clustered strength
      cells += mix(1.0 - wb, wb, fj) * cell * clus;
    }
    m *= 1.0 + cells * 0.06 * smoothstep(0.3, 1.0, cap + 0.3 * poleG) * lodC * vec3(1.2, 1.0, 0.85);
  }

  // --- the discrete bright clouds (cl, from the noise loop)
  m *= 1.0 + cl * vec3(1.25, 1.0, 0.85);
  alb *= m;

  // --- Minnaert reflectance of the deck
  float mu0c = max(mu0, 0.0);
  vec3 kk = uK;
  float muc = max(mu, 0.035);
  vec3 refl = alb * pow(vec3(mu0c + 1e-6), kk) * pow(vec3(muc), kk - 1.0);
  // soften the terminator slightly (deep, scattering atmosphere): light leaks a little past mu0 = 0
  refl += alb * 0.012 * smoothstep(-0.06, 0.03, mu0) * (1.0 - smoothstep(0.0, 0.1, mu0));

  // --- shadows on the deck: rings, moons
  float shade = 1.0;
  shade *= ringShadow(pW, Lw, fp * uR * uKmPerUnit * 0.6);
  for (int i = 0; i < uN5; i++) {
    vec4 mp = uMoonPos[i];
    shade *= sphereShadow(pW, Lw, mp.xyz, mp.w, fp * uR * 0.6);
  }

  // --- upper haze along the view ray (camera -> deck) and sunlight transmittance at the deck
  vec2 ta = raySphereS(o, d, 1.0 + uHazeTop);
  float tCam = dot(toPlanetS(vec3(0.0)) - o, d);  // camera position along the ray (o-relative)
  float t0 = max(ta.x, tCam);
  vec3 T;
  vec3 ins = hazeScatter(o, d, t0, tHit, L, T);
  // (Rayleigh extinction of the incoming light is already inside the fitted Minnaert law)
  vec3 Tsun = exp(-(uTauM + 0.35 * uTauA) * sunAirmass(ps * 1.0002, L));
  // delta-scaled view transmittance for the deck light: the haze is strongly forward scattering (and multiply
  // scattering at grazing paths), so most of the light it "removes" from the beam stays in it. Without this the
  // deck goes dark at the limb before the haze fringe takes over, which reads as a hard navy outline.
  vec3 Tdk = deckT(T, 0.3);
  vec3 col = (refl * Tsun * shade) * Tdk + ins * shade;
#ifdef UDBG_LAT
  col = mix(col, vec3(fract(latd / 10.0) < 0.5 ? 1.0 : 0.0, latd > 0.0 ? 0.5 : 0.0, abs(latd - 61.0) < 0.5 ? 1.0 : 0.0), 0.5);
#endif
  gl_FragColor = vec4(col * uSunColor, 1.0);
#ifdef UDBG_NAN
  if (!all(lessThan(abs(gl_FragColor.rgb), vec3(65000.0)))) gl_FragColor = vec4(0.4, 0.0, 0.0, 1.0);
#endif
}
`;

const SHELL_VERT = /* glsl */ `
varying vec3 vPosW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHELL_FRAG = /* glsl */ `
${UNIFORMS_GLSL}
${COMMON_GLSL}
uniform vec3 uB0;
uniform vec3 uK;
uniform float uFuzzH;    // cloud-top thinning scale height / R
uniform float uFuzzTau;  // its vertical optical depth at the nominal deck level
varying vec3 vPosW;
// deck radiance seen at grazing incidence at unit normal n (scaled space): the globe's Minnaert law with the
// hood brightening and the mu clamp, times the sunlight transmittance through the haze
vec3 deckGrazing(vec3 n, vec3 L) {
  float mu0 = dot(n, L);
  float latd = asin(clamp(n.y, -1.0, 1.0)) * 57.29578;
  vec3 hood = (1.0 + smoothstep(59.5, 62.5, latd) * vec3(0.13, 0.085, 0.075) + smoothstep(65.0, 90.0, latd) * vec3(0.035, 0.025, 0.02))
            * (1.0 - exp(-pow((latd - 56.5) / 1.9, 2.0)) * vec3(0.04, 0.035, 0.03));
  vec3 refl = uB0 * hood * pow(vec3(max(mu0, 0.0) + 1e-6), uK) * pow(vec3(0.035), uK - 1.0);
  refl += uB0 * 0.012 * smoothstep(-0.06, 0.03, mu0) * (1.0 - smoothstep(0.0, 0.1, mu0));
  return refl * exp(-(uTauM + 0.35 * uTauA) * sunAirmass(n * 1.0002, L));
}
void main() {
  vec3 rdW = normalize(vPosW);
  vec3 o = toPlanetS(vPosW);
  vec3 d = dirToPlanetS(rdW);
  vec2 ta = raySphereS(o, d, 1.0 + uHazeTop);
  if (ta.x > ta.y) discard;
  float tCam = dot(toPlanetS(vec3(0.0)) - o, d);
  float t0 = max(ta.x, tCam);
  float t1 = ta.y;
  vec2 tp = raySphereS(o, d, 1.0);
  bool hit = tp.x <= tp.y;                     // (a miss is returned as (1e20, -1e20))
  if (hit && tp.x > t0) t1 = tp.x;   // (deck pixels are drawn by the globe; this only clips slivers)
  vec3 L = dirToPlanetS(uSunDirW);
  vec3 T;
  vec3 ins = hazeScatter(o, d, t0, t1, L, T);
  // Soft cloud-top edge: the deck is not a hard surface but a cloud whose top thins out over a few tens of km.
  // A ray passing at tangent height ht above the nominal deck crosses a slant optical depth tauC(ht); that much
  // of the deck-like grazing radiance is added (and the background occluded), so the limb fades smoothly from the
  // deck into the blue haze fringe instead of ending in a hard dark outline.
  float bq = dot(-o, d);
  vec3 pc = o + d * bq;
  float rt = length(pc);
  float ht = rt - 1.0;
  float tr = dot(T, vec3(0.3333));
  // One deckGrazing() call for both cases. Root cause of the black limb pixels (wave 2): at an exactly tangent ray
  // length(pc) rounds to 1.0 (ht = 0) while raySphereS() reports a miss; the old "ht <= 0" branch then used the miss
  // sentinel tp.x = 1e20 as a hit distance, normalize() of the overflowing point returned 0 and sunAirmass(0) was
  // 0/0 = NaN, which the post turns into a black blot. Now the deck branch requires a real hit; a tangent miss is
  // treated as a cloud-top graze at ht = 0.
  float aC = 0.0, wI = 1.0, pT = 0.15;
  vec3 nD = vec3(0.0, 1.0, 0.0);
  if (hit && tp.x > t0) {
    // the ray reaches the deck in a sub-pixel sliver the polygonal globe mesh does not cover
    nD = normalize(o + d * tp.x);
    aC = 1.0;
    pT = 0.3;
    tr = 0.0;
  } else if ((ht > 0.0 || !hit) && bq > tCam) {
    float htc = max(ht, 0.0);
    float tauC = uFuzzTau * exp(-htc / uFuzzH) * sqrt(6.2831853 * rt / uFuzzH);
    aC = 1.0 - exp(-tauC);
    wI = 0.5 + 0.5 * (1.0 - aC);   // half chord
    nD = pc / max(rt, 1e-6);
    tr *= 1.0 - aC;
  }
  vec3 col = ins * wI;
  if (aC > 0.0) col += aC * deckT(T, pT) * deckGrazing(nD, L);   // delta-scaled
  gl_FragColor = vec4(col * uSunColor, tr);
#ifdef UDBG_NAN
  if (!all(lessThan(abs(gl_FragColor), vec4(65000.0)))) gl_FragColor = vec4(0.0, 0.4, 0.0, 0.0);
#endif
}
`;

// dev-only shader variants from the URL (set once at creation, never changed at runtime):
//   udbg=1 latitude stripes on the deck, udbg=9 NaN / Inf finder (red: globe, green: haze shell)
function debugDefines() {
  const v = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('udbg') : null;
  return v === '1' ? { UDBG_LAT: 1 } : v === '9' ? { UDBG_NAN: 1 } : {};
}

export function createGlobe(ctx, S) {
  const { U } = ctx;
  const R = ctx.data.radius;
  const DEG = Math.PI / 180;
  const uCloudA = { value: CLOUDS.map(([la, lo, sz, el]) => new THREE.Vector4(la * DEG, lo * DEG, sz * DEG, el)) };
  // per-cloud constants of the shader: drift rate = windOmega(sin(lat)) * rotation sign (see WIND_GLSL), sin(1.7 i)
  const windOmega = (x) => ((-80 + 667.2 * x * x + 141.6 * x ** 4) * 86400) / 25559e3;
  const uCloudB = { value: CLOUDS.map((c, i) => new THREE.Vector4(c[4], c[5], -windOmega(Math.sin(c[0] * DEG)), Math.sin(i * 1.7))) };
  // Minnaert normal albedo and exponent of the deck. Fitted THROUGH the post's AgX tone curve so that the displayed
  // disc reproduces the hue and limb-darkening profile of Voyager 2's true-colour PIA18182 (pale cyan that keeps its
  // hue almost to the limb). Green/blue are ~1.35x the physical I/F (Karkoschka: ~0.55-0.6 at disc centre) -- the
  // same "stretch" as the reference photograph; red is low because CH4 absorbs it. Red limb-darkens LESS than green
  // (k < 1): much of broadband red falls in CH4 bands where the overlying haze limb-brightens.
  const uB0 = { value: new THREE.Vector3(0.37, 0.88, 0.97) };
  const uK = { value: new THREE.Vector3(0.9, 1.08, 1.06) };
  const segW = ctx.quality === 'low' ? 192 : 320;
  const geo = new THREE.SphereGeometry(R, segW, segW / 2);
  const dbg = debugDefines();
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...S,
      uSunColor: U.uSunColor,
      uCloudA,
      uCloudB,
      uTapA: { value: TAPS.map((t) => new THREE.Vector4(t.sc[0], t.sc[1], t.sc[2], t.base)) },
      uTapB: { value: TAPS.map((t) => new THREE.Vector4(t.off[0], t.off[1], t.off[2], t.w)) },
      uTapC: { value: TAPS.map((t) => new THREE.Vector4(tapSlot(t), t.group, t.phase, 0)) },
      uNTap: { value: TAPS.length },
      uNCloud: { value: CLOUDS.length },
      uN2: { value: 2 },
      uN27: { value: 27 },
      uB0,
      uK,
      uRotSign: { value: -1 },
      uDetail: { value: ctx.quality === 'low' ? 0.0 : 1.0 },
    },
    defines: dbg,
    vertexShader: GLOBE_VERT,
    fragmentShader: GLOBE_FRAG,
  });
  mat.extensions = { derivatives: true };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'uranus-globe';

  const shellR = R * (1 + S.uHazeTop.value) * 1.004;
  const shellGeo = new THREE.SphereGeometry(shellR, 256, 128);
  const shellMat = new THREE.ShaderMaterial({
    uniforms: { ...S, uSunColor: U.uSunColor, uB0, uK, uFuzzH: { value: 18 / 25559 }, uFuzzTau: { value: 0.05 } },
    defines: dbg.UDBG_NAN ? dbg : {},
    vertexShader: SHELL_VERT,
    fragmentShader: SHELL_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const shell = new THREE.Mesh(shellGeo, shellMat);
  shell.name = 'uranus-haze';
  return { mesh, shell, material: mat, shellMaterial: shellMat, FLAT };
}
