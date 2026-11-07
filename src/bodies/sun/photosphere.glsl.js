// Photosphere shader: analytic ray/sphere surface point, Eddington-Barbier limb darkening on a grey
// atmosphere (Hopf function), Planck colour per channel, animated power-diagram granulation (domed, rounded,
// warped granules of varied size with sub-granular structure, bright rims, dark dots, fragmenting lanes, lane bright
// points and the corrugated 3D relief seen at grazing incidence) with anisotropic footprint-filtered LOD, meso- and
// supergranular brightness modulation, supergranular network, faculae (contrast rising toward the limb), and sunspots
// (irregular multi-core umbrae, lobed and often one-sided filamentary penumbrae, light bridges made of granulation,
// umbral dots, the Wilson depression).
//
// Colour: the large-scale temperature field (limb darkening, faculae, spots) is rendered with a photographic chroma
// (uChroma); the granulation-scale fluctuations keep their colorimetric Planck chroma (CHROMA 1), so granules change
// brightness, not hue (+-150 K barely shifts the colour).
//
// Compile budget (ANGLE -> HLSL -> FXC inlines every call and unrolls constant loops): all loops have uniform bounds,
// noise is a 3D texture fetch (noisetex.js) instead of inlined simplex noise, and the two granulation passes recompute
// their seeds instead of indexing a local array.
import { SUN_NOISE_GLSL, SUN_HASH_GLSL } from './noisetex.js';
import { NOISE_GLSL } from '../../glsl/noise.js';

export const NSPOT = 72;
export const NPLAGE = 16;

export const PHOTO_VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

export const SUN_COMMON = /* glsl */ `
#define PI 3.14159265359
const vec3 LAMBDA = vec3(0.610, 0.550, 0.465);   // effective wavelengths of the linear sRGB channels (um)
const float C2 = 14388.0;                         // second radiation constant (um K)
const float TEFF = 5772.0;
const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
vec3 planck(float T) { return 1.0 / (exp(C2 / (LAMBDA * T)) - 1.0); }
// grey-atmosphere temperature seen at disc position mu (Eddington-Barbier: tau = mu), Hopf q(tau) fit
float hopfT(float mu) {
  float q = 0.7104 - 0.1331 * exp(-3.4488 * mu);
  return TEFF * pow(0.75 * (mu + q), 0.25);
}
// interleaved gradient noise (static per-pixel dither)
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
`;

export const PHOTO_FRAG = /* glsl */ `
#define NSPOT ${NSPOT}
#define NPLAGE ${NPLAGE}
uniform float uTime;
uniform vec3 uCamLocal;     // camera position in the Sun's body frame (scene units)
uniform float uR;           // solar radius (scene units)
uniform float uGain;        // radiance at disc centre
uniform vec3 uDiscColor;    // colour at disc centre (linear, unit luminance)
uniform float uChroma;      // photographic chroma of the large-scale temperature contrasts (1 = colorimetric)
uniform float uPixAngle;    // radians per pixel
uniform float uDiscFade;    // 1 - point-sprite weight
uniform int uNSpot;         // spots in the arrays this frame (the CPU keeps those on the visible hemisphere)
uniform vec4 uSpotA[NSPOT]; // xyz centre (unit vector), w penumbra radius (rad, 0 = pore)
uniform vec4 uSpotB[NSPOT]; // x umbra radius (rad), y umbral cores + fract seed, z Wilson depth (radii), w one-sidedness
uniform int uNPlage;
uniform vec4 uPlage[NPLAGE];// xyz centre, w radius (rad)
uniform float uPlageS[NPLAGE];
uniform int uCellN;         // 27: neighbour cells of the granulation power diagram
uniform int uFilN;          // 6: penumbral filament sprites per pixel (2 rows x 3 neighbours)
uniform int uCores;         // 3: max umbral cores per spot
uniform float uDebug;
uniform float uHeroK;       // display contrast exponent of the large-scale luminance (1 outside hero shots)
uniform float uHeroKs;      // ... and of the granulation-scale fluctuations on top of it
varying vec3 vLocal;

${SUN_NOISE_GLSL}
#ifdef SN_WARP
${NOISE_GLSL}
#endif
${SUN_HASH_GLSL}
${SUN_COMMON}

const float R_MM = 695.7;            // solar radius in Mm (noise works in Mm)
const float GRAN_MM = 1.32;          // granulation cell scale (Mm)
const float SUPER_MM = 31.0;         // supergranulation cell scale (Mm)
const float GRAN_MEAN = 0.85;        // area mean of granuleI at fpc ~0.1-0.3 (calibrated with ?sundebug=1)
const float GRAN_GAIN = 0.85;        // -> RMS intensity contrast ~20% at disc centre, 550 nm
const float S_MEAN = 0.48;           // area mean of the granule profile S (calibrated with ?sundebug=7)
const float LIFE_RATE = 1.0 / 15.0;  // granule life cycle per film second (~40x time-lapse of the real ~10 min)
const float SN = 1.6;                // texture-noise frequency that matches snoise() features (correlation length)
// fixed rotations that decorrelate noise octaves (and hide the noise volume's period)
const mat3 ROT1 = mat3(0.34693, 0.29221, -0.89121, -0.32792, 0.92804, 0.17664, 0.87870, 0.23097, 0.41779);
const mat3 ROT2 = mat3(-0.44304, 0.75754, -0.47943, -0.12880, 0.47544, 0.87027, 0.88720, 0.44732, -0.11307);

// Power-diagram (weighted Voronoi) cells whose seeds wander and whose weights follow each cell's life cycle times a
// per-cell size (a broad, lognormal-like size distribution), so granules of varied size are born small, swell, and
// shrink away continuously (no popping). q in cell units.
// Returns (distance to the cell boundary, life 0..1, life phase, distance to the seed).
float gJunction;  // distance to the second-nearest cell boundary (small near lane junctions)
float gCellRand;  // per-cell random number of the nearest cell
float gCellSize;  // per-cell size factor (power weight) of the nearest cell, 0..1
vec3 gNb;         // unit normal of the nearest boundary, pointing into the cell (the gradient of the distance)
vec3 gR1;         // vector from the shading point to the nearest cell's seed
vec4 cellSeed(vec3 cid, float t, out float life, out float ph) {
  vec3 h = hash33(cid);
  ph = fract(t * LIFE_RATE * (0.75 + 0.5 * h.y) + h.z * 7.31);
  life = sin(PI * ph);
  vec3 o = 0.16 + 0.68 * h + 0.06 * sin(t * LIFE_RATE * 2.3 + h.yzx * 6.2831853);
  float sz = hash13(cid + 5.17);
  return vec4(o, -(0.13 + 0.15 * sz * sz) * life);
}
vec4 cells(vec3 q, float t) {
  vec3 iq = floor(q), fq = fract(q);
  float P1 = 1e9;
  vec3 r1 = vec3(0.0), c1 = vec3(0.0);
  float life1 = 0.0, ph1 = 0.0, life, ph;
  float e = 8.0, e2 = 8.0;
  vec3 nb = vec3(0.0, 1.0, 0.0);
  // one loop, two passes (so the seed code is compiled once): pass 1 finds the nearest power cell; pass 2 the exact
  // distance to the nearest power bisector (and the next one, for lane junctions), recomputing the seeds
  for (int m = 0; m < 2 * uCellN; m++) {
    int k = m < uCellN ? m : m - uCellN;
    vec3 g = vec3(float(k % 3 - 1), float((k / 3) % 3 - 1), float(k / 9 - 1));
    vec4 s = cellSeed(iq + g, t, life, ph);
    vec3 r = g + s.xyz - fq;
    float P = dot(r, r) + s.w;
    if (m < uCellN) {
      if (P < P1) { P1 = P; r1 = r; life1 = life; ph1 = ph; c1 = iq + g; }
    } else {
      vec3 dr = r - r1;
      float l2 = dot(dr, dr);
      if (l2 > 1e-8) {
        float il = inversesqrt(l2);
        float eb = (P - P1) * il * 0.5;
        if (eb < e) { e2 = e; e = eb; nb = -dr * il; }
        else e2 = min(e2, eb);
      }
    }
  }
  gCellRand = hash13(c1 + 17.13);
  gCellSize = hash13(c1 + 5.17);
  gJunction = e2;
  gNb = nb;
  gR1 = r1;
  return vec4(e, life1, ph1, length(r1));
}

// Granule intensity (relative). fpc = pixel footprint in cell units (major axis).
// graze: 0 near disc centre .. 1 at grazing incidence; facing: cosine between the outward normal of the nearest
// granule boundary and the direction toward the observer along the surface; net: magnetic network strength;
// nA, nB: noise at 2.7 and 7 per cell (sub-granular structure, dark dots, bright points).
float granuleI(vec4 G, float fpc, float laneVar, float graze, float facing, float net, vec4 nA, vec4 nB, out float lane) {
  float e = G.x, life = G.y, ph = G.z, d1 = G.w;
  float res = 1.0 - smoothstep(0.22, 0.7, fpc);       // interior structure resolved
  float closeF = 1.0 - smoothstep(0.015, 0.05, fpc);  // very close: sharper edges, finer structure
  // rounded corners: polynomial smooth-min of the two nearest boundary distances
  float KR = mix(0.26, 0.17, closeF);
  float hh = max(KR - abs(e - gJunction), 0.0) / KR;
  float er = e - 0.25 * KR * hh * hh;
  // normalised cell coordinate: 0 on the (rounded) boundary, 1 at the seed
  float erp = max(er, 0.0);
  float c = clamp(erp / (erp + 0.75 * d1 + 1e-4), 0.0, 1.0);
  // 3D relief at grazing incidence: the wall of a granule facing the observer is seen face-on (bright, and the
  // lane in front of it is hidden behind the granule before it); the lane on the far side widens into a dark band
  float near = smoothstep(0.0, 0.75, facing), far = smoothstep(0.0, 0.75, -facing);
  c = clamp(c + graze * res * (0.14 * near - 0.07 * far) * (1.0 - c), 0.0, 1.0);
  // lane: the intergranular downflow lanes have a roughly constant physical width (~0.15 Mm), seen through a
  // ~0.1 Mm point-spread (Hinode / SST-like resolution; sharper close in, DKIST-like) or the pixel footprint
  float sig = mix(0.085, 0.022, closeF);
  sig = sqrt(sig * sig + 0.25 * fpc * fpc);
  float w0 = mix(0.1, 0.04, closeF);
  float S = smoothstep(w0 - 1.5 * sig, w0 + 1.5 * sig, er);
  // footprint: the transition widens toward the mean as cells shrink to a few pixels
  S = mix(S, S_MEAN + 0.5 * (S - S_MEAN), smoothstep(0.25, 0.7, fpc));
  lane = 1.0 - S;
  float Ig = 1.2 + 0.22 * life + 0.16 * (gCellRand - 0.5) + 0.14 * (gCellSize * gCellSize - 0.33);   // big granules are brighter
  float IL = 0.62 + 0.13 * laneVar;
  // sub-granular structure: brighter and darker patches inside each granule
  float sub = res * (0.075 * nA.x + 0.05 * nB.x * (1.0 - smoothstep(0.07, 0.22, fpc)));
  float dome = mix(0.9, 0.74 + 0.26 * smoothstep(0.1, 0.85, c), res);
  float I = IL + (Ig * dome * (1.0 + sub) - IL) * S;
  // bright rims where the upflow turns over at the granule edge (resolved at mid range and close in)
  float cr = (c - 0.28) / 0.11;
  I += (0.015 * res + 0.06 * closeF) * exp(-cr * cr) * S;
  // the junctions of three or more granules are the darkest parts of the lanes (pockets)
  float jw = 0.12 + 0.7 * fpc;
  I -= 0.07 * exp(-max(gJunction, 0.0) / jw) * (0.12 / jw) * lane;
  // exploding granules: a dark core opens late in a big granule's life
  float ex = smoothstep(0.6, 0.92, ph) * smoothstep(0.3, 0.55, e + 0.25 * life);
  float s2 = 0.03 + fpc * fpc * 0.25;
  I -= 0.3 * ex * exp(-d1 * d1 / s2) * (0.03 / s2);
  // occasional small dark dots inside granules (resolved)
#ifndef NO_DOTS
  I -= 0.12 * res * smoothstep(0.42, 0.64, nA.w) * smoothstep(0.25, 0.5, c) * S;
#endif
  // fragmenting granules: in many big granules a dark lane grows across the middle late in life, splitting them
  float hs = fract(gCellRand * 13.7);
#ifdef NO_FRAG
  hs = 0.0;
#endif
  if (hs > 0.5 && res > 0.0) {
    float ang = gCellRand * 31.4;
    vec3 dir = normalize(vec3(cos(ang), sin(ang * 1.3), sin(ang)));
    vec3 dir2 = normalize(cross(dir, gR1 + vec3(1e-3, 0.0, 0.0)));
    // (a curved lane: an arc across the granule, not a straight cut)
    float dl = dot(gR1, dir) + 0.08 * (hs - 0.75) + (fract(hs * 7.1) - 0.5) * 1.4 * pow(dot(gR1, cross(dir, dir2)), 2.0) + 0.06 * nA.z;
    float spl = exp(-dl * dl / (0.0025 + 0.5 * sig * sig)) * smoothstep(0.45, 0.85, ph) * smoothstep(0.08, 0.3, c);
    I -= 0.32 * spl * res * (0.6 + 0.4 * life);
  }
  // grazing incidence: walls facing the observer are seen nearly face-on, deeper and hotter
  I += graze * res * 0.1 * near * smoothstep(0.05, 0.25, c) * (1.0 - smoothstep(0.3, 0.6, c));
  // bright points strung along the lanes (chains), strongest where the network field is strong
  float bpF = 1.0 - smoothstep(0.06, 0.2, fpc);
  if (bpF > 0.0) I += (0.08 + 0.45 * net) * smoothstep(0.25, 0.5, nA.y) * smoothstep(0.5, 0.9, lane) * bpF;
  return I;
}

float fadeBy(float fp, float size) { return 1.0 - smoothstep(0.25 * size, 0.7 * size, fp); }

// Sunspots: returns a temperature factor (1 = quiet photosphere); gPen = coverage that suppresses granulation.
float gBridge;  // light-bridge coverage (granulation shows through there)
float gPen;
float sunspots(vec3 n, vec3 V, float mu, float fpU, float t) {
  gBridge = 0.0;
  gPen = 0.0;
  float f = 1.0;
  float aa = fpU / uR;  // footprint in radians
  for (int i = 0; i < uNSpot; i++) {
    vec4 A = uSpotA[i];
    vec4 B = uSpotB[i];
    float rp = A.w, ru = B.x;
    float reach = max(rp * 1.55 + ru * 0.5, ru * 2.6);
    vec3 d = n - A.xyz;
    if (dot(d, d) > reach * reach) continue;
    vec3 c = A.xyz;
    vec3 e1 = normalize(cross(vec3(0.0, 1.0, 0.0), c));
    vec3 e2 = cross(c, e1);
    vec2 xy = vec2(dot(d, e1), dot(d, e2));
    float nc = floor(B.y);
    float sd = fract(B.y) * 89.0;
    vec3 hS = hash33(vec3(sd, 1.7, 3.1));
    // Wilson depression: the umbral floor sits B.z radii below the surface, so the line of sight meets it
    // displaced away from the observer; the umbra appears shifted toward disc centre near the limb.
    float r0 = length(xy);
    float depth = B.z * (1.0 - smoothstep(ru * 0.7, max(rp, ru) * 0.95, r0));
    vec2 vt = vec2(dot(V, e1), dot(V, e2));
    xy -= depth * vt / max(mu, 0.06);
    float r = length(xy);
    vec2 cs = xy / max(r, 1e-9);
    // angular structure around the spot (a circle of radius 1.25 in the noise volume): x penumbral lobes (3-8
    // around), y/z umbral boundary warp, w filament twist
    vec4 nA = tn4(vec3(cs * 1.25 + hS.xy * 7.0, sd));
    // umbra: 1-3 domain-warped cores; each core's field is 2^-(d/r)^2, the umbral boundary is where the sum is 1/2
    vec2 xw = xy / ru;
    vec4 nU = tn4f(vec3(xw * 1.1 + hS.yz * 5.0, sd + 7.0), aa / ru * 1.1);
    xw += (0.28 * nA.yz) * smoothstep(0.1, 0.8, r / ru) + 0.16 * nU.xy;   // (the angular warp is undefined at the centre)
    float U = 0.0, U1 = 0.0, U2 = 0.0;
#ifdef CORE_CONST
    for (int k = 0; k < 3; k++) {
#else
    for (int k = 0; k < uCores; k++) {
#endif
      if (float(k) >= nc) break;
      vec3 hk = hash33(vec3(sd, float(k) * 3.3 + 1.0, 9.1));
      float ak = 6.2831853 * hk.x;
      vec2 ok = k == 0 ? (hk.yz - 0.5) * 0.25 : vec2(cos(ak), sin(ak)) * (0.55 + 0.3 * hk.y);
      float rk = k == 0 ? (nc > 1.5 ? 0.74 : 0.9) : 0.42 + 0.2 * hk.z;
      vec2 dk = xw - ok;
      float uk = exp2(-dot(dk, dk) / (rk * rk));
      U += uk;
      if (uk > U1) { U2 = U1; U1 = uk; } else U2 = max(U2, uk);
    }
    // distance-like coordinate from the core field: 1 on the umbral boundary (r / ru for a single core)
    float sU = sqrt(max(-log2(max(2.0 * U, 1e-9)) + 1.0, 0.0));
    float edgeU = max(1.2 * aa / ru, 0.035);
    float um = 1.0 - smoothstep(1.0 - edgeU, 1.0 + edgeU, sU);
    if (rp <= 0.0) {
      // pore: a small, ragged dark knot without penumbra
      float pm = 1.0 - smoothstep(1.0 - 2.0 * edgeU, 1.0 + 2.5 * edgeU, sU);
      f = min(f, mix(1.0, 0.83, pm));
      gPen = max(gPen, pm * 0.75);
      continue;
    }
    // penumbral width around the spot: lobed (+-~25 %), and one-sided for rudimentary penumbrae (B.w)
    float aDir = 6.2831853 * hS.x;
    float side = dot(cs, vec2(cos(aDir), sin(aDir)));
    float pw = max(1.0 + 0.6 * nA.x, 0.35) * mix(1.0, smoothstep(-0.45, 0.65, side), B.w);
    float sOut = 1.0 + (rp / ru - 1.0) * pw;
    float u = (sU - 1.0) / max(sOut - 1.0, 1e-3);           // 0 at the umbra .. 1 at the mean outer edge
    if (u > 1.3 && um <= 0.0) continue;
    // penumbral filaments: sprites in (azimuth, radius) cells (~0.42 Mm wide), two staggered rows; each filament
    // has its own start, length (its tip ends at u = 0.85..1.2, so granules intrude between the tips), width,
    // brightness and a rounded bright head (penumbral grain, inner third); they twist with a per-spot sense and
    // curvature, and are bundled into clusters with gaps
    float tw = (hS.y - 0.5) * 0.7 * u * u + 0.5 * nA.w;
    vec2 ct = vec2(cs.x * cos(tw) - cs.y * sin(tw), cs.x * sin(tw) + cs.y * cos(tw));
    float rmidMm = 0.5 * (ru + rp) * R_MM;
    float Nf = max(24.0, floor(6.2831853 * rmidMm / 0.42));
    float fpcF = aa * R_MM / 0.42 * (rmidMm / max(r * R_MM, 1e-3));   // footprint in filament cells
    float fineF = 1.0 - smoothstep(0.45, 1.1, fpcF);
    float x = atan(ct.y, ct.x) * (Nf / 6.2831853);
    // coarse structure that survives when the filaments are unresolved: bundles ~4-5 filaments wide, brighter and
    // darker radial streaks of varied length (so a mid-range penumbra is not a flat disc)
    float xb = x / 4.6, ib = floor(xb), fb = xb - ib;
    float Nb = floor(Nf / 4.6);
    float hb0 = hash11(mod(ib, Nb) + sd * 3.1), hb1 = hash11(mod(ib + 1.0, Nb) + sd * 3.1);
    float fs3 = fb * fb * (3.0 - 2.0 * fb);
    float bnd = mix(hb0, hb1, fs3);
    float bLen = mix(fract(hb0 * 7.7), fract(hb1 * 7.7), fs3);
    float coarseF = 1.0 - smoothstep(0.9, 2.6, fpcF / 4.6);   // (the footprint is the major axis: generous)
    float sf = 0.55 * (1.0 + coarseF * (0.9 * (bnd - 0.5) - 0.45 * smoothstep(0.3 + 0.6 * bLen, 0.55 + 0.6 * bLen, u)));
    float head = 0.0, tip = 1.0;
    if (fineF > 0.0) {
      float acc = 0.0, cov = 0.0;
      for (int m = 0; m < uFilN; m++) {
        int k = m / 3;
        float xk = x + 0.5 * float(k);
        float cid = floor(xk) + float(m - 3 * k - 1);
        float cm = mod(cid, Nf);
        vec3 h1 = hash33(vec3(cm, float(k) * 7.0 + 1.0, sd));
        vec3 h2 = fract(h1.yzx * 7.31 + h1.zxy * 3.17 + 0.13);
        float dx = xk - (cid + 0.2 + 0.6 * h1.x);
        float wf = 0.22 + 0.18 * h1.y;
        float s2 = wf * wf + 0.45 * fpcF * fpcF;
        float prof = (wf * inversesqrt(s2)) * exp(-dx * dx / s2);
        float st0 = -0.08 + 0.75 * h1.z * h1.z;                    // start (many start near the umbra)
        float uEnd = min(st0 + 0.3 + 0.6 * h2.x, 0.85 + 0.35 * fract(h2.x * 7.3));   // tip (granules between)
        float along = smoothstep(st0 - 0.07, st0, u) * (1.0 - smoothstep(uEnd - 0.12, uEnd, u));
        // clusters: brightness follows a slow variation along the azimuth (bundles and gaps)
        float bund = 0.35 + 0.9 * smoothstep(-0.2, 0.25, hash11(floor(cm / 5.0) + sd) - 0.5 + 0.4 * (h2.z - 0.5));
        float b = (0.6 + 0.5 * h2.y) * bund;
        float uh = (u - st0) / 0.07;
        float hb = exp(-uh * uh) * (1.0 - smoothstep(0.25, 0.45, st0));   // inner heads
        float v = b * prof * along * (1.0 + 0.7 * hb);
        acc = max(acc, v);
        cov = max(cov, prof * along);
        head = max(head, v * hb * (1.0 - smoothstep(-0.12, 0.05, u)));
      }
      sf = mix(sf, acc, fineF);
      tip = mix(1.0, clamp(1.6 * cov, 0.0, 1.0), fineF);
    }
    // outer boundary: the lobed mean edge, then (resolved) the filament tips
    float edgeP = max(1.5 * aa / ru / max(sOut - 1.0, 0.1), 0.025);
    float pm = 1.0 - smoothstep(1.2 - edgeP, 1.2 + edgeP, u);
    pm *= mix(1.0, tip, smoothstep(0.75, 0.95, u));
    pm = max(pm, um);
    if (pm <= 0.0) continue;
    // penumbral intensity: bright inner penumbra (~0.86 of the quiet Sun) darkening outward (~0.68), filaments +-
    float Ip = mix(0.86, 0.68, smoothstep(0.0, 1.0, u)) * (0.79 + 0.33 * clamp(sf, 0.0, 1.2));
    float fp = pow(max(Ip, 0.05), 0.23);
    // the grains' heads poke into the umbra
    um *= 1.0 - 0.9 * clamp(head * fineF, 0.0, 1.0);
    // umbra: dark (T ~ 0.70, I ~ 0.1 at 550 nm), coolest in the cores, with umbral dots close up
    float fu = 0.695 + 0.04 * smoothstep(0.2, 1.0, sU);
    fu += 0.05 * smoothstep(0.4, 0.65, nU.w) * smoothstep(0.3, 0.85, sU) * (1.0 - smoothstep(0.012, 0.035, fpU));
    // light bridges (multi-core spots): the granulation itself (dimmer) where two cores meet, with a varying width
    if (nc > 1.5 && hS.z < 0.75) {
      float rho = U2 / max(U1, 1e-6);
      float bvis = smoothstep(1.0, 2.5, 0.15 * ru / max(aa, 1e-9));
      float bridge = smoothstep(0.8, 0.94, rho + 0.3 * nU.z) * um * bvis;
      fu = mix(fu, 0.9, bridge);
      gBridge = max(gBridge, bridge);
    }
    float fs = mix(1.0, mix(fp, fu, um), pm);
    f = min(f, fs);
    gPen = max(gPen, pm);
  }
  return f;
}

void main() {
  // exact surface point from the camera ray (robust closest-approach form, precise at any distance)
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocal - uCamLocal);
  float tc = -dot(ro, rd);
  vec3 pc = ro + tc * rd;
  float h2 = max(uR * uR - dot(pc, pc), 0.0);
  float th = tc - sqrt(h2);
  vec3 P = pc - sqrt(h2) * rd;
  vec3 n = normalize(P);
  vec3 V = -rd;
  float mu = clamp(dot(n, V), 0.0, 1.0);
  float muS = max(mu, 0.02);

  // pixel footprint on the surface (scene units): the major axis of the footprint ellipse (screen derivatives,
  // bounded by the analytic minor axis and the analytic major axis), so foreshortened detail cannot alias
  float fpMin = uPixAngle * max(th, 1e-3);
  float fpD = max(length(dFdx(P)), length(dFdy(P)));
  float fpU = clamp(fpD, fpMin, fpMin / muS);
  float fpMm = fpU * 6.371;
  vec3 pMm = n * R_MM;
  float t = uTime;

  // ---------------------------------------------------------------- supergranular network & plage
  float plage = 0.0;
  for (int i = 0; i < uNPlage; i++) {
    vec4 Pl = uPlage[i];
    float a = length(n - Pl.xyz);
    plage += uPlageS[i] * (1.0 - smoothstep(0.25 * Pl.w, Pl.w, a));
  }
  // large-scale patchiness (plage fragments), meso- and supergranular brightness: one fetch per scale
  vec4 nP1 = tn4f(ROT1 * pMm * (SN / 11.0) + 7.7, fpMm * SN / 11.0);
  vec4 nP2 = tn4f(ROT2 * pMm * (SN / 4.6) + 1.3, fpMm * SN / 4.6);
  float patchy = 0.6 * nP1.x + 0.4 * nP2.x;
  float plageEnv = clamp(plage, 0.0, 1.3);
  plage = clamp(plage * smoothstep(-0.35, 0.45, patchy), 0.0, 1.3);

  float fpS = fpMm / SUPER_MM;
  // supergranular network: the ridges (zero crossings) of a noise field at the supergranule scale, a cell-like web of
  // lanes ~30 Mm apart (|n| / |grad n| ~ distance to the ridge), footprint-filtered with the mean kept
  vec4 nS = tn4f(ROT2 * pMm * (SN / SUPER_MM) + vec3(3.1, 7.4, 1.9), fpS * SN);
  float ks = sqrt(0.09 * 0.09 + 0.5 * fpS * fpS);
  float network = exp(-abs(nS.x) / 0.37 * 0.5 / ks) * (0.07 / ks);
  network *= 0.55 + 0.45 * nP1.y;
  float net = clamp(0.6 * network + 0.8 * plage, 0.0, 1.0);

  // ---------------------------------------------------------------- granulation
  float fpc = fpMm / GRAN_MM;
  float fadeG = 1.0 - smoothstep(0.32, 0.85, fpc);
  float dGran = 0.0;
  float laneBP = 0.3;  // bright-point potential in lanes (mean when unresolved)
#ifndef NO_GRAN
  if (fadeG > 0.0) {
    vec3 q = pMm / GRAN_MM;
    // domain warp: curved, irregular lane network (large scale) and wavy granule edges (~0.5 per cell)
    vec4 w1 = tn4(ROT1 * q * (0.21 * SN) + 1.7);
    vec4 w2 = tn4(ROT2 * q * (0.52 * SN) + 3.7);
    vec4 w3 = tn4(q * (1.15 * SN) * ROT1 + 6.2);
#ifdef SN_WARP
    w1.xyz = vec3(snoise(q * 0.21 + 1.7), snoise(q * 0.21 + 9.1), snoise(q * 0.21 + 4.3));
    w2.xyz = vec3(snoise(q * 0.52 + 3.7), snoise(q * 0.52 + 5.1), snoise(q * 0.52 + 8.3));
    w3.xyz = vec3(snoise(q * 1.15 + 6.2), snoise(q * 1.15 + 2.4), snoise(q * 1.15 + 9.7));
#endif
    q += 0.35 * w1.xyz + 0.24 * w2.xyz + 0.13 * w3.xyz;
    vec4 G = cells(q, t);
    // sub-granular structure (one fetch per scale, footprint-filtered)
    vec4 nA = tn4f(q * (2.7 * SN) + vec3(0.0, 0.07 * t, 7.0), fpc * 2.7 * SN);
    vec4 nB = tn4f(ROT1 * q * (6.3 * SN) + vec3(0.11 * t, 3.0, 0.0), fpc * 6.3 * SN);
    // grazing relief: direction toward the observer along the surface
    vec3 vt = V - n * mu;
    vec3 vth = vt * inversesqrt(max(dot(vt, vt), 1e-12));
    float graze = smoothstep(0.62, 0.12, mu);
    float facing = -dot(gNb, vth);
    float lane;
    float I = granuleI(G, fpc, w2.w, graze, facing, net, nA, nB, lane);
#ifdef SUN_DEBUG1
    gl_FragColor = vec4(vec3(I * 0.3), 1.0); return;
#endif
#ifdef SUN_DEBUG7
    gl_FragColor = vec4(vec3((1.0 - lane) * 0.3), 1.0); return;
#endif
    // close in (DKIST-like resolution) the contrast rises toward the unsmeared ~25%; mesogranular patches of
    // slightly stronger / weaker granulation; abnormal granulation in plage: smaller contrast
    float gg = GRAN_GAIN * (1.0 + 0.35 * (1.0 - smoothstep(0.015, 0.06, fpc))) * (1.0 + 0.5 * nP2.z);
    dGran = gg * (I - GRAN_MEAN) * fadeG * (1.0 - 0.35 * clamp(plage, 0.0, 1.0));
    laneBP = mix(0.3, lane, fadeG);
  }
#endif
  // footprint-filtered mottling: octaves standing in for the unresolved granulation (the residual contrast of a
  // footprint-sized average of granules); the volume's mip chain does the footprint average
  float m1 = 1.0 - fadeG * 0.85;
  float mott = 0.042 * tn4f(ROT2 * pMm * (SN / 2.7) + 11.0, fpMm * SN / 2.7).x * m1;
  vec4 nM = tn4f(pMm * (SN / 5.6) + 23.0, fpMm * SN / 5.6);
  mott += 0.026 * nM.x;
  // meso- (~6-14 Mm) and supergranular (~30 Mm) brightness modulation, ~2.5 % RMS (40 % of it when the
  // granulation is unresolved), and a per-supergranule brightness
  float meso = (0.06 * nM.y + 0.05 * nP1.z + 0.05 * nS.y) * (0.4 + 0.6 * fadeG);
  mott += 0.015 * nP1.w;

  // ---------------------------------------------------------------- faculae
  // facular contrast is ~0 at disc centre and rises toward the limb (hot-wall effect), dropping at the very edge
  float cMu = 0.002 + 1.25 * pow(1.0 - mu, 3.0) * smoothstep(0.0, 0.12, mu);
  // faculae: a worm-like bright network around the active regions (ridged noise; the fine worms resolve close up,
  // the coarser ~8 Mm network carries the pattern at full-disc scale, footprint-faded to its mean)
  float wf = fadeBy(fpMm, 2.2);
  float worm = 1.0 - abs(tn4(ROT1 * pMm * (SN / 3.2) + vec3(5.0, 1.0, 9.0)).x);
  worm = mix(0.42, worm * worm * worm * 1.2, wf);
  float wf2 = fadeBy(fpMm, 6.0);
  float worm2 = 1.0 - abs(nM.z);
  worm2 = mix(0.4, 1.3 * worm2 * worm2 * worm2, wf2);
  float facNet = plageEnv * smoothstep(-0.25, 0.55, patchy) * (0.3 + 1.6 * mix(worm2, worm * (0.4 + 0.9 * worm2), wf)) * (0.55 + 0.45 * network);
  float brightPts = laneBP * (0.45 + 0.55 * network);
  float fac = cMu * (facNet * (0.75 + 0.6 * brightPts) + 0.22 * network * (0.3 + 0.7 * brightPts));
  // polar faculae (declining phase): faint network brightenings at high latitude, seen near the limb
  fac += cMu * 0.18 * smoothstep(0.75, 0.95, abs(n.y)) * network;

  // granulation contrast decreases toward the limb (we see higher, more uniform layers)
  float gMu = 0.3 + 0.7 * smoothstep(0.0, 0.7, mu);
  float dSmall = dGran * gMu + mott + meso;   // granulation-scale: luminance only (colorimetric chroma)

  // ---------------------------------------------------------------- sunspots
#ifdef NO_SPOTS
  float fSpot = 1.0; gPen = 0.0; gBridge = 0.0;
#else
  float fSpot = sunspots(n, V, muS, fpU, t);
#endif
  // granulation is suppressed in the spots (magnetic field), except in light bridges (smaller, dimmer granules)
  float keep = 1.0 - gPen * (1.0 - 0.5 * gBridge);
  dSmall *= keep;
  fac *= keep;

  float T0 = hopfT(1.0);
  float TL = hopfT(mu) * (1.0 + 0.231 * fac) * fSpot;          // large scale: limb, faculae, spots
  float T = TL * (1.0 + 0.231 * dSmall);
  vec3 bL = planck(TL) / planck(T0);
  vec3 bt = planck(T) / planck(T0);
  float YL = dot(bL, LUMW);
  float Y = dot(bt, LUMW);
  // chromaticity: photographic chroma for the large-scale field, colorimetric for the granulation on top of it
  vec3 ch = pow(bL / max(YL, 1e-12), vec3(uChroma)) * (bt * (YL / max(Y, 1e-12)) / max(bL, vec3(1e-12)));
  ch /= dot(ch, LUMW);
  // hero shots: contrasty white-light rendering of the large-scale luminance (limb darkening, faculae, spots; see
  // HERO_CONTRAST in sun.js); the granulation keeps a gentler display contrast (the hero tone curve already turns
  // its luminance swing into a hue swing, the red channel sitting in the shoulder)
  YL = max(YL, 1e-12);
  vec3 col = uDiscColor * (uGain * pow(YL, uHeroK) * pow(max(Y, 1e-12) / YL, uHeroKs)) * ch;
  gl_FragColor = vec4(col * uDiscFade, 1.0);
}`;
