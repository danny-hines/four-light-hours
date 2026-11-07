// Uranus's five major moons: Miranda, Ariel, Umbriel, Titania, Oberon.
//
// Real sizes, orbits (JPL Horizons-phased, see orbits.js), synchronous rotation, Voyager 2 albedos and named
// features at their published planetocentric coordinates (IAU/USGS Gazetteer, east longitude). Voyager 2 imaged
// only the southern hemispheres (the north was in polar night in 1986); in 2026 the Sun stands ~74 deg north, so
// what is lit now is mostly terrain no spacecraft has seen. There the shader extrapolates each moon's known
// geology (marked "extrapolated" below) -- for Miranda two more coronae, one of them an Inverness-like polar
// trapezoid with its own chevron, mirroring the south.
//
// Surface model (fix round 2, compared against Voyager PIA01490 / PIA00140 / PIA00141 / PIA01534 / PIA00039):
//  * multi-scale relief: a self-affine fractal (simplex noise with analytic derivatives), footprint-gated per
//    octave, so the surface keeps its texture from a 10-px disc down to a few hundred metres per pixel;
//  * crater fields with a power-law size distribution (N(>D) ~ D^-2), strong degradation variance (most craters
//    soft and infilled, a few crisp and bright), polygonal outlines, analytic rim shadows;
//  * graben as a connected Voronoi fault network (Y-junctions, en-echelon tapering, varying width, flat
//    resurfaced floors with a medial groove, tilted blocks so the two walls differ in height), slope-limited walls
//    and analytic wall shadows; the named chasmata of the (now dark) south as great-circle troughs;
//  * Miranda's coronae from a signed distance to a lobate outline, domain-warped so ridge-and-groove bands wander,
//    pinch, merge and end; asymmetric ridge profile; albedo stripes from the same warped field; knobby cores;
//    the chevron as a ragged bright albedo patch with internal streaks;
//  * all relief is slope-limited (~35 deg) in the normal, so sunlit walls at the terminator stay in range.
// Photometry: Hapke IMSA with an opposition surge, per-channel w solved from the Voyager/HST albedos, a lunar-
// Lambert facet term, Uranus-shine on the night side and Uranus's shadow (eclipses).
//
// Shader compile budget (wave 2; Chrome / Windows compiles ANGLE -> HLSL -> FXC at the first draw, FXC inlines every
// call and its optimizer time grows ~n^1.5 with code size and much faster with conditional regions inside loops):
//  * ONE program for all five moons (Miranda's coronae / scarps are uniform-driven, uNCor = uNSc = 0 elsewhere);
//  * every simplex sample through one snoise() site (a tap table: provinces, fault activity, mottling, corona detail,
//    ray systems), the crater outlines through a second; every gradient-noise sample (corona warps, relief octaves)
//    through one gnoiseD() site; uniform loop trip counts; loop bodies branch-free except for one guard each;
//  * LOD by use (FULL_MOONS_IN_FILM, moonDetailFull): the film never shows these moons larger than ~3 px, so it
//    builds a lean variant (MOON_LEAN: same photometry, provinces, mottling and relief, unresolved-crater roughness);
//    moon close-up views build the full one.
// Measured (tools/checks/shader_cost.mjs): Miranda 3139 ms + generic moon 1969 ms before; lean 128 ms; full ~1.2 s.
import * as THREE from 'three';
import { NOISE_GLSL } from '../../glsl/noise.js';
import { UNIFORMS_GLSL, COMMON_GLSL } from './shared.js';
import { makeOrbit } from './orbits.js';

const D2R = Math.PI / 180;
function dirLL(latDeg, lonDeg) {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  return new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}
// local east / north unit vectors at a direction
function eastNorth(c) {
  const up = new THREE.Vector3(0, 1, 0);
  const e = new THREE.Vector3().crossVectors(up, c);
  if (e.lengthSq() < 1e-8) e.set(1, 0, 0);
  e.normalize().negate(); // east = direction of increasing lon (lon = atan(-z, x))
  const n = new THREE.Vector3().crossVectors(c, e).normalize();
  return [e, n];
}

// ---- per-moon parameters ----------------------------------------------------------------------------------------
// alb: normal reflectance (Karkoschka 2001 geometric albedos: Ariel 0.53, Titania 0.35, Oberon 0.31, Miranda 0.32,
// Umbriel 0.26); field: crater field [density, fresh simple depth/D, rim/D, min freshness];
// field2: [saturation, province contrast, albedo variegation, mantling];
// relief: fractal relief [slope of the first octave, slope growth per octave, base frequency (1/R), octaves];
// nets: Voronoi fault networks [stretch-axis lat, lon, cell scale (1/R), stretch, cover 0..1 (provinces), relative
//       size of the cross-links, floor width km, depth km, medial groove 0/1];
// craters: [lat, lonE, diameter km, depth km, kind, peak km]
// kind: 0 plain, 1 dark floor, 2 bright annulus (Wunda), 3 bright central peak, 4 bright rays, 5 dark halo
// canyons (named, great-circle troughs): [lat, lonE, azimuth deg (from north toward east), length km, width km, depth km]
const MOON_DEFS = {
  miranda: {
    alb: [0.32, 0.32, 0.315], field: [0.75, 0.19, 0.035, 0.05], field2: [0.7, 0.55, 0.3, 0.45], octaves: 8, seed: 11.0,
    relief: [0.085, 1.08, 3.0, 10],
    // graben in the old cratered terrain (Voyager saw several ~10-km-wide troughs), a sparse network
    nets: [[0, 150, 2.2, 2.6, 0.35, 0.2, 12, 1.0, 0]],
    craters: [
      [-21.0, 32.0, 30, 2.5, 0, 0], // Alonso (south, polar night now)
      [33.0, 120.0, 34, 3.0, 0, 0], // extrapolated
      [58.0, 250.0, 18, 2.0, 4, 0], // extrapolated: a young rayed crater on the northern cratered plains
      [12.0, 290.0, 22, 2.2, 0, 0], // extrapolated
    ],
    canyons: [
      [-43.2, 322.8, 40, 150, 6, 2.0], // Argier Rupes region (south)
    ],
    // coronae: [lat, lonE, orientation deg, half-size x, y (gnomonic tan units), superellipse m,
    //           belt width (tan), band spacing km, albedo contrast, kind]
    coronae: [
      [-29.1, 73.7, 20, 0.66, 0.46, 2.6, 0.3, 10, 0.55, 0], // Arden Corona (leading; strong bright/dark bands)
      [-24.8, 257.1, -10, 0.64, 0.58, 2.4, 0.26, 6, 0.3, 1], // Elsinore Corona (trailing; grooved belt)
      [-66.9, 325.7, 30, 0.5, 0.46, 4.0, 0.16, 7, 0.4, 2], // Inverness Corona (south pole; the bright chevron)
      // extrapolated: Voyager never saw the north. A banded, Arden-like racetrack on the sub-Uranian side and an
      // Inverness-like polar trapezoid with its own chevron, mirroring the southern set
      [34.0, 196.0, 35, 0.62, 0.4, 2.6, 0.19, 8, 0.6, 0],
      [76.0, 60.0, 15, 0.42, 0.38, 4.0, 0.15, 6, 0.4, 2],
    ],
    // scarps: [lat, lonE, azimuth, length km, height km (sign = which side is high)]
    scarps: [[-18.3, 347.8, 170, 116, 8]], // Verona Rupes (5-10 km; south, in polar night in 2026)
  },
  ariel: {
    alb: [0.53, 0.53, 0.54], field: [0.32, 0.2, 0.04, 0.12], field2: [0.6, 0.6, 0.22, 0.1], octaves: 7, seed: 23.0,
    relief: [0.06, 1.08, 3.0, 10],
    // the youngest surface of the five: an intersecting, connected network of fault-bounded graben (chasmata)
    // with smooth, resurfaced floors and medial grooves; a second, finer and sparser set crosses it
    nets: [[0, 120, 2.4, 3.0, 0.7, 0.25, 28, 3.4, 1]],
    craters: [
      [-21.3, 30.7, 30, 2.5, 4, 0], // Laica: bright rays
      [-68.7, 279.7, 78, 3.5, 0, 0], // Yangoor
      [-37.8, 33.7, 40, 2.5, 0, 0], // Huon
      [-15.5, 251.3, 20, 1.8, 4, 0], // Abans: bright
      [-71.5, 339.7, 71, 3.0, 0, 0], // Domovoy
      [30.0, 140.0, 46, 3.0, 0, 0], // extrapolated
      [52.0, 230.0, 24, 2.0, 4, 0], // extrapolated rayed
    ],
    canyons: [
      [-33.7, 246.0, 70, 620, 30, 4.0], // Kachina Chasmata
      [-28.0, 347.0, 80, 365, 25, 3.5], // Korrigan Chasmata
      [-14.8, 340.0, 60, 305, 18, 2.5], // Sprite Vallis
      [-20.0, 30.0, 95, 450, 22, 3.0], // Pixie / Kewpie Chasma (approx.)
      [-5.0, 300.0, 75, 500, 26, 3.5], // Brownie / Leprechaun Vallis (approx.)
    ],
  },
  umbriel: {
    alb: [0.26, 0.26, 0.255], field: [0.9, 0.18, 0.04, 0.1], field2: [0.85, 0.2, 0.06, 0.1], octaves: 7, seed: 37.0,
    relief: [0.07, 1.08, 3.0, 10],
    nets: [],
    craters: [
      [-7.9, 273.6, 131, 3.0, 2, 0], // Wunda (bright annulus on its floor)
      [-4.7, 311.6, 98, 4.0, 3, 3.0], // Vuver (bright central peak)
      [-1.8, 331.7, 72, 3.5, 3, 2.5], // Skynd (bright central peak)
      [-30.0, 1.8, 208, 4.0, 0, 0], // Wokolo
      [-33.6, 42.2, 52, 3.0, 0, 0], // Alberich
      [-21.4, 223.5, 69, 3.2, 0, 0], // Setibos
      [25.0, 200.0, 140, 4.5, 0, 0], // extrapolated
      [50.0, 330.0, 90, 4.0, 0, 0], // extrapolated
    ],
    canyons: [],
  },
  titania: {
    alb: [0.36, 0.35, 0.33], field: [0.8, 0.18, 0.04, 0.1], field2: [0.75, 0.5, 0.3, 0.1], octaves: 8, seed: 53.0,
    relief: [0.065, 1.08, 3.0, 10],
    // a few long, branching rift systems like Messina Chasmata (coarse cells, sparse cover)
    nets: [[0, 250, 1.8, 2.6, 0.4, 0.2, 32, 3.6, 0]],
    craters: [
      [-15.8, 287.1, 326, 3.0, 0, 0], // Gertrude
      [-12.4, 45.2, 135, 3.5, 0, 0], // Ursula
      [-42.4, 291.4, 100, 3.0, 0, 0], // Calphurnia
      [-11.4, 344.4, 75, 3.0, 4, 0], // Elinor (bright)
      [-34.4, 15.0, 30, 2.0, 4, 0], // Iago-like rayed (approx.)
      [40.0, 120.0, 150, 4.0, 0, 0], // extrapolated
      [60.0, 230.0, 60, 3.0, 4, 0], // extrapolated rayed
    ],
    canyons: [
      [-33.3, 335.0, 75, 1490, 45, 5.0], // Messina Chasmata
      [-8.5, 32.6, 60, 240, 25, 3.0], // Belmont Chasma
      [-14.7, 23.5, 40, 400, 6, 2.0], // Rousillon Rupes (fault scarp, approx. as narrow trough)
    ],
  },
  oberon: {
    alb: [0.32, 0.31, 0.29], field: [0.85, 0.18, 0.04, 0.1], field2: [0.85, 0.4, 0.22, 0.1], octaves: 8, seed: 71.0, darkFloors: 0.45,
    relief: [0.07, 1.08, 3.0, 10],
    nets: [[0, 30, 1.8, 2.2, 0.3, 0.2, 26, 3.0, 0]],
    craters: [
      [-46.1, 44.4, 206, 5.0, 1, 3.0], // Hamlet (dark floor, central peak)
      [-66.0, 42.9, 114, 4.0, 1, 0], // Othello (dark floor)
      [-58.4, 112.5, 203, 5.0, 1, 0], // Macbeth
      [-11.4, 345.2, 120, 4.0, 1, 0], // Coriolanus
      [-22.1, 19.0, 124, 4.0, 1, 2.0], // Falstaff
      [-5.4, 31.5, 126, 4.0, 5, 0], // Lear
      [-8.0, 323.0, 60, 3.0, 4, 0], // rayed crater near Mommur (approx.)
      [35.0, 160.0, 180, 5.0, 1, 3.5], // extrapolated
      [62.0, 20.0, 90, 4.0, 4, 0], // extrapolated rayed
      [15.0, 250.0, 140, 4.5, 1, 0], // extrapolated
    ],
    canyons: [
      [-16.3, 323.5, 80, 537, 30, 4.0], // Mommur Chasma
    ],
  },
};

const NCR = 10, NCA = 6, NNET = 2, NCOR = 5, NTAP = 24;

// ---- Hapke (1981 / 2002) photometry ------------------------------------------------------------------------------
// I/F = w/4 mu0/(mu0+mu) [ (1 + B(g)) P(g) + H(mu0) H(mu) - 1 ],  B(g) = B0 / (1 + tan(g/2)/h),
// P = one-term Henyey-Greenstein with b < 0 (backscattering icy regolith), H(x) ~ (1+2x)/(1+2x sqrt(1-w)).
// w per channel is solved so the normal reflectance (g = 0, i = e = 0) equals the moon's Voyager/HST albedo.
const HAPKE = { B0: 1.0, h: 0.045, b: -0.3 };
function hgP(b, g) { return (1 - b * b) / Math.pow(1 + 2 * b * Math.cos(g) + b * b, 1.5); }
function hFn(x, w) { return (1 + 2 * x) / (1 + 2 * x * Math.sqrt(1 - w)); }
function normalRefl(w) { return (w / 8) * ((1 + HAPKE.B0) * hgP(HAPKE.b, 0) + hFn(1, w) ** 2 - 1); }
function solveW(target) {
  let lo = 1e-3, hi = 0.999;
  for (let i = 0; i < 60; i++) {
    const m = 0.5 * (lo + hi);
    if (normalRefl(m) < target) lo = m;
    else hi = m;
  }
  return 0.5 * (lo + hi);
}
// Cinematic exposure of the whole Uranus system (the same "stretch" as the globe's fitted deck, see globe.js), so
// the moons keep their true brightness RELATIVE to Uranus.
const SYSTEM_GAIN = 1.3;

const VERT = /* glsl */ `
varying vec3 vPosW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = /* glsl */ `
${UNIFORMS_GLSL}
${NOISE_GLSL}
${COMMON_GLSL}
#define NCR ${NCR}
#define NCA ${NCA}
#define NNET ${NNET}
#define NCOR ${NCOR}
#define NTAP ${NTAP}
uniform vec3 uCenterW;
uniform float uRad;        // scene units
uniform float uRadKm;
uniform mat3 uBasis;       // body -> world
uniform vec3 uW;           // Hapke single-scattering albedo (r, g, b)
uniform vec3 uAlbN;        // normal reflectance (for Uranus-shine)
uniform vec4 uHapke;       // B0, h, HG b, cinematic gain
uniform vec3 uShineCol;
uniform vec4 uField;       // crater density, fresh simple-crater depth/D, rim height/D, minimum freshness
uniform vec4 uField2;      // saturation (erase), province contrast, albedo variegation, mantling (subdued relief)
uniform vec4 uRelief;      // fractal relief: first-octave slope, growth per octave, base frequency, octaves
uniform int uOctaves;
uniform int uNCr, uNCa, uNNet, uNRel, uNTap;   // loop counts as uniforms: real loops, not unrolled copies
uniform int uN8, uN27, uN10;                    // 8, 27 and 10 (crater cells, Voronoi neighbourhood, corona samples)
uniform float uSeed;
uniform float uDarkFloors;
uniform vec4 uCrA[NCR];    // centre dir, Rc (unit radius)
uniform vec4 uCrB[NCR];    // depth, rim, kind (rayed: 4 + 0.1 ray slot), peak
uniform vec4 uCaA[NCA];    // centre dir, half length (rad)
uniform vec4 uCaB[NCA];    // tangent dir, half width (rad)
uniform float uCaD[NCA];   // depth
uniform vec4 uNetA[NNET];  // fault network: stretch axis (xyz), cell scale (w; 0 = off)
uniform vec4 uNetB[NNET];  // stretch, cover, half floor width (unit R), depth (unit R)
uniform vec2 uNetG[NNET];  // medial groove, border activation probability
uniform vec4 uTapA[NTAP];  // simplex-noise tap: input scale (xyz), base id + 4 * destination (w)
uniform vec4 uTapB[NTAP];  // input offset (xyz), weight or (ray taps) named-crater index (w)
// Miranda only (uNCor = uNSc = 0 on the other moons: one program serves all five)
uniform vec4 uCoA[NCOR];   // corona centre dir, outline exponent
uniform vec4 uCoX[NCOR];   // axis x dir, belt width
uniform vec4 uCoY[NCOR];   // axis y dir, band spacing (unit radius)
uniform vec4 uCoP[NCOR];   // half size x, half size y, albedo contrast, kind (0 banded ovoid, 1 grooved ovoid, 2 trapezoid + chevron)
uniform vec4 uScA[2];      // scarp: centre dir, half length
uniform vec4 uScB[2];      // tangent, height (unit radius, signed: + = high side on the left)
uniform int uNCor, uNSc;
varying vec3 vPosW;

// h, g: height and its surface gradient (unit radius); alb: relative albedo offset; sh: direct-light visibility;
// young: fresh-ice fraction; sv: slope variance of relief too small to draw (it still roughens the photometry)
struct Terr { float h; vec3 g; float alb; float sh; float young; float sv; };

// Sun geometry in the local horizon frame (shared by all shadow tests)
vec3 gS; float gTanE; float gLt;

float sstepD(float e0, float e1, float x) { float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0); return 6.0 * t * (1.0 - t) / (e1 - e0); }
vec4 onehot4(float c) { return vec4(c < 0.5 ? 1.0 : 0.0, c > 0.5 && c < 1.5 ? 1.0 : 0.0, c > 1.5 && c < 2.5 ? 1.0 : 0.0, c > 2.5 ? 1.0 : 0.0); }

// 3D gradient noise (quintic) with its analytic gradient: (n, dn/dx, dn/dy, dn/dz), after Inigo Quilez.
// ONE call site in the whole shader (the corona samples and the relief octaves share one real loop).
vec4 gnoiseD(vec3 x) {
  vec3 i = floor(x);
  vec3 f = x - i;
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec3 ga = hash33(i) * 2.0 - 1.0;
  vec3 gb = hash33(i + vec3(1.0, 0.0, 0.0)) * 2.0 - 1.0;
  vec3 gc = hash33(i + vec3(0.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 gd = hash33(i + vec3(1.0, 1.0, 0.0)) * 2.0 - 1.0;
  vec3 ge = hash33(i + vec3(0.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 gf = hash33(i + vec3(1.0, 0.0, 1.0)) * 2.0 - 1.0;
  vec3 gg = hash33(i + vec3(0.0, 1.0, 1.0)) * 2.0 - 1.0;
  vec3 gh = hash33(i + vec3(1.0, 1.0, 1.0)) * 2.0 - 1.0;
  float va = dot(ga, f);
  float vb = dot(gb, f - vec3(1.0, 0.0, 0.0));
  float vc = dot(gc, f - vec3(0.0, 1.0, 0.0));
  float vd = dot(gd, f - vec3(1.0, 1.0, 0.0));
  float ve = dot(ge, f - vec3(0.0, 0.0, 1.0));
  float vf = dot(gf, f - vec3(1.0, 0.0, 1.0));
  float vg = dot(gg, f - vec3(0.0, 1.0, 1.0));
  float vh = dot(gh, f - vec3(1.0, 1.0, 1.0));
  float k1 = vb - va, k2 = vc - va, k3 = ve - va, k4 = va - vb - vc + vd, k5 = va - vc - ve + vg, k6 = va - vb - ve + vf;
  float k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  float n = va + u.x * k1 + u.y * k2 + u.z * k3 + u.x * u.y * k4 + u.y * u.z * k5 + u.z * u.x * k6 + u.x * u.y * u.z * k7;
  vec3 g = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga) + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg)
         + u.z * u.x * (ga - gb - ge + gf) + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh)
         + du * (vec3(k1, k2, k3) + u.yzx * vec3(k4, k5, k6) + u.zxy * vec3(k6, k4, k5) + u.yzx * u.zxy * k7);
  return 1.6 * vec4(n, g);
}

/// Analytic crater: a bowl (simple) or a flat floor with a concave wall and a central peak (complex), rising to a
// rounded rim crest (smooth minimum with the ejecta flank), the ejecta decaying ~ u^-3 out to uOut crater radii.
// The crest is never rounded over less than ~1.5 px, so a rim cannot alias into a dotted line or an "ink" circle.
// erase = how much of the older relief inside the new crater it obliterates (crater saturation).
// nIrr = the outline noise sample snoise(az * 3 + Cn * 37) (0 for craters under ~6 px), from the caller.
// Branch-free (FXC compiles every conditional region inside a loop very slowly): outside uOut, or with wgt = 0,
// every update below is the identity.
float crater(inout Terr T, vec3 p, vec3 Cn, float Rc, float D, float Hr, float uf, float pk, float rr, float wgt,
             float fp, float erase, float uOut, float irr, float nIrr) {
  vec3 dv = p - Cn;
  float dl = length(dv);
  float u0 = dl / Rc;
  float inO = float(u0 < uOut);
  wgt *= inO;
  // irregular, polygonal outlines (joints in the target, slumping): radius varies with azimuth
  float u = u0 * (1.0 + irr * nIrr * smoothstep(6.0, 14.0, Rc / fp));
  float iw = 1.0 / (1.0 - uf);
  float w = max(u - uf, 0.0) * iw;
  float a = -D + (D + Hr) * w * w;
  float da = 2.0 * (D + Hr) * w * iw;
  float ui = max(u, 0.5);
  float u3 = ui * ui * ui;
  float e0 = uOut * 0.72;
  float f = 1.0 - smoothstep(e0, uOut, u);
  float b = Hr / u3 * f;
  float db = -3.0 * Hr / (u3 * ui) * float(u > 0.5) * f - Hr / u3 * sstepD(e0, uOut, u);
  float k = max(rr, 1.5 * fp / Rc) * (2.0 * (D + Hr) * iw + 3.0 * Hr);
  float q = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  float h = mix(b, a, q) - k * q * (1.0 - q);
  float dh = mix(db, da, q);
  // central peak (pk = 0: none)
  float pw = max(0.16, 1.5 * fp / Rc);
  float e = exp(-u * u / (pw * pw));
  h += pk * e;
  dh -= pk * e * 2.0 * u / (pw * pw);
  vec3 gp = (dh / (max(dl, 1e-7) * Rc)) * dv;
  gp -= dot(gp, p) * p;
  float er = erase * (1.0 - smoothstep(0.8, 1.15, u)) * wgt;
  T.h = T.h * (1.0 - er) + h * wgt;
  T.g = T.g * (1.0 - er) + gp * wgt;
  T.sh = mix(T.sh, 1.0, er);
  T.alb *= 1.0 - 0.6 * er;
  // analytic rim shadow: does the sun ray from p clear the rim crest?
  vec3 ov = dv / Rc;
  ov -= dot(ov, p) * p;
  float aa = dot(ov, gS);
  float disc = aa * aa - dot(ov, ov) + 1.0;
  float sq = sqrt(max(disc, 0.0));
  float tr = -aa + sq * (2.0 * float(u < 1.0) - 1.0);
  // the (rounded) crest is k/4 below Hr; close to the crest the local slope decides (mu0 < 0), not this test
  float need = Hr - 0.25 * k - h;
  float have = tr * Rc * gTanE;
  float soft = 0.08 * (D + Hr) + fp * max(gTanE, 0.0) * 1.2;
  // only obstacles more than ~1-2 px away along the ray; marginal cases (need ~ have) stay lit
  float near = smoothstep(0.04, 0.2, tr) * smoothstep(1.0, 2.5, tr * Rc / fp);
  float on = float(gLt > 1e-4 && disc > 0.0 && tr > 0.0);
  T.sh = min(T.sh, mix(1.0, 1.0 - smoothstep(0.0, soft, need - have), wgt * near * on));
  return mix(u0, u, inO);
}

// Crater morphology by size and age: simple bowls below ~15 km; flat floors, central peaks and shallower relative
// depth above (the simple-complex transition on the Uranian satellites is ~15-25 km, Schenk 1989). Degradation
// (fr -> 0: old) makes craters shallow, flat-floored (infilled), with low, broadly rounded rims; mantled terrain
// (Miranda's regolith blanket) is softened further.
void craterShape(float Rc, float fr, float pkSeed, out float D, out float Hr, out float uf, out float pk, out float rr) {
  float Dkm = 2.0 * Rc * uRadKm;
  float cx = smoothstep(12.0, 32.0, Dkm);
  float old = 1.0 - fr;
  float mant = uField2.w * old;
  D = uField.y * mix(1.0, 0.42, cx) * mix(0.12, 1.0, fr) * (1.0 - 0.5 * mant) * 2.0 * Rc;
  Hr = uField.z * mix(1.0, 0.7, cx) * mix(0.04, 1.0, fr * fr) * (1.0 - 0.6 * mant) * 2.0 * Rc;
  uf = max(cx * mix(0.3, 0.5, fr), 0.45 * old * old);
  pk = cx * step(0.3, pkSeed) * D * 0.4 * fr;
  rr = mix(0.65, 0.06, fr * fr) + 0.3 * mant;
}

// Ray system of a rayed crater from its four noise samples (tapering streaks of different lengths: noise-modulated
// angular lobes that feather out, filtered by footprint: an unresolved streak contributes its mean brightness).
// nl: lobe length / curvature sample; n1, n2: primary rays and finer secondary streaks; np: patchiness.
float raySystem(float ur, float Rc, float fp, float nl, float n1r, float n2, float np) {
  float len = 2.2 + 6.0 * pow(0.5 + 0.5 * nl, 1.5);
  float taper = 1.0 - smoothstep(0.25 * len, len, ur);
  float arc = ur * Rc;
  float l1 = smoothstep(1.0, 3.0, arc / 12.0 / fp), l2 = smoothstep(1.0, 3.0, arc / 30.0 / fp);
  // a handful of broad primary rays, finer secondary streaks inside them, broken into patches of secondaries
  float n1 = smoothstep(0.35, 0.9, n1r);
  float r = mix(0.2, n1, l1) * (0.6 + 0.4 * mix(0.3, smoothstep(0.25, 0.85, n2), l2)) + 0.25 * mix(0.12, smoothstep(0.3, 0.85, n2), l2);
  float l7 = smoothstep(1.0, 3.0, arc / 7.0 / fp);
  float patchy = clamp(0.5 + 0.7 * np, 0.0, 1.0) * l7 + 0.45 * (1.0 - l7);
  r *= taper * smoothstep(0.85, 1.3, ur) * patchy;
  float halo = exp(-max(ur - 1.0, 0.0) * 1.4) * mix(0.6, 1.0, smoothstep(0.6, 1.0, ur));
  return 0.55 * r + 0.4 * halo;
}

// great-circle canyon / graben with flat floor, raised flanks and wall shadows (the named chasmata of the south)
void canyon(inout Terr T, vec3 p, vec4 A, vec4 B, float depth, float fp) {
  vec3 c = A.xyz; vec3 t = B.xyz;
  float cp = dot(p, c);
  vec3 nrm = cross(c, t);
  float s = dot(p, nrm);
  float hw = B.w;
  float along = atan(dot(p, t), cp);
  float env = 1.0 - smoothstep(A.w * 0.6, A.w, abs(along));
  float wob = 0.14 * sin(along * 9.0 + hw * 50.0) + 0.08 * sin(along * 23.0 + depth * 300.0) + 0.04 * sin(along * 61.0);
  float hwl = hw * (1.0 + wob) * mix(0.3, 1.0, env);
  float dEnv = depth * env;
  float wall = max(2.2 * dEnv, fp * 1.5);
  // one guard (FXC compiles every conditional region inside a loop very slowly); the shadow test is arithmetic
  if (cp >= 0.0 && env > 0.0 && abs(s) <= hwl + wall * 2.5) {
    float x = abs(s);
    float inside = 1.0 - smoothstep(hwl - wall * 0.5, hwl + wall * 0.5, x);
    float dinside = -sstepD(hwl - wall * 0.5, hwl + wall * 0.5, x);
    float flank = exp(-pow((x - hwl - wall) / wall, 2.0)) * 0.12;
    float dflank = flank * (-2.0 * (x - hwl - wall) / (wall * wall));
    float h = dEnv * (flank - inside);
    float dh = dEnv * (dflank - dinside) * sign(s);
    vec3 gn = nrm - dot(nrm, p) * p;
    float er = inside * env;
    T.h = T.h * (1.0 - er) + h;
    T.g = T.g * (1.0 - er) + dh * gn;
    T.sh = mix(T.sh, 1.0, er);
    T.alb += er * 0.04 + 0.1 * env * abs(dinside) * wall;   // smooth floor deposits, bright fresh walls
    // wall shadow: the Sun ray from p across the trough to the wall on the Sun side
    float sd = dot(gS, normalize(gn));
    float sgn = 2.0 * float(sd >= 0.0) - 1.0;
    float wallTop = sgn * (hwl + wall * 0.5);
    float dist = (wallTop - s) / (sgn * max(abs(sd), 1e-3));
    float have = dist * gTanE;
    float soft = depth * 0.08 + fp * 1.2;
    float on = float(gLt > 1e-4 && inside > 0.01 && abs(sd) > 1e-3 && dist > 0.0);
    T.sh = min(T.sh, mix(1.0, smoothstep(-soft, soft, have - dEnv * inside), env * smoothstep(0.0, wall, dist) * on));
  }
}

// ---- Voronoi fault networks --------------------------------------------------------------------------------------
// Distance to the nearest Voronoi border (iq's two-pass method) in an anisotropic 3D domain: cells flattened along
// the stretch axis make borders that preferentially run across it (one dominant trend with cross-links), and every
// border meets others at Y-junctions, so troughs form a connected network rather than isolated cuts.
// Every border is a fault, but its width and depth depend on its orientation (a continuous weight, the same seen
// from both sides): wide graben across the stretch axis (the dominant trend), narrow troughs on the cross-links.
// The two nearest borders are returned so the troughs merge smoothly at junctions (no creases, no cut-off ends).
struct Edge { float d; vec3 n; float h1; float h2; float d2; vec3 n2; float w1; float w2; };
Edge voroEdge(vec3 p, vec3 ax, float sc, float k, float seed, float prob) {
  vec3 q = sc * (p + (k - 1.0) * dot(p, ax) * ax);
  vec3 ip = floor(q), fq = q - ip;
  vec3 mg = vec3(0.0), mr = vec3(0.0);
  float md = 8.0;
  // (both passes branch-free: FXC compiles every conditional region inside a loop very slowly)
  for (int n = 0; n < uN27; n++) {
    vec3 g = vec3(float(n % 3 - 1), float((n / 3) % 3 - 1), float(n / 9 - 1));
    vec3 r = g + 0.1 + 0.8 * hash33(ip + g + seed) - fq;
    float d = dot(r, r);
    float b = float(d < md);
    md = mix(md, d, b); mr = mix(mr, r, b); mg = mix(mg, g, b);
  }
  float bd = 8.0, bd2 = 8.0;
  vec3 bn = vec3(0.0, 0.0, 1.0), bn2 = bn, bg = mg;
  for (int n = 0; n < uN27; n++) {
    vec3 g = mg + vec3(float(n % 3 - 1), float((n / 3) % 3 - 1), float(n / 9 - 1));
    vec3 r = g + 0.1 + 0.8 * hash33(ip + g + seed) - fq;
    vec3 dr = r - mr;
    float l2 = dot(dr, dr);
    vec3 nn = dr * inversesqrt(max(l2, 1e-12));
    float d = mix(8.0, dot(0.5 * (mr + r), nn), float(l2 > 1e-6));   // the own site never wins
    float b1 = float(d < bd), b2 = float(d >= bd && d < bd2);
    bd2 = mix(mix(bd2, d, b2), bd, b1); bn2 = mix(mix(bn2, nn, b2), bn, b1);
    bd = mix(bd, d, b1); bn = mix(bn, nn, b1); bg = mix(bg, g, b1);
  }
  Edge E;
  // gradients of the border distances with respect to p (chain rule through the linear anisotropic map)
  vec3 gp = -sc * (bn + (k - 1.0) * dot(bn, ax) * ax);
  gp -= dot(gp, p) * p;
  float gl = max(length(gp), 1e-6);
  E.d = bd / gl;
  E.n = gp / gl;   // points away from the border, into this pixel's own block
  vec3 gp2 = -sc * (bn2 + (k - 1.0) * dot(bn2, ax) * ax);
  gp2 -= dot(gp2, p) * p;
  float gl2 = max(length(gp2), 1e-6);
  E.d2 = bd2 / gl2;
  E.n2 = gp2 / gl2;
  E.h1 = hash13(ip + mg + seed * 1.7 + 0.31);
  E.h2 = hash13(ip + bg + seed * 1.7 + 0.31);
  float a1 = dot(bn, ax), a2 = dot(bn2, ax);
  E.w1 = mix(prob, 1.0, smoothstep(0.2, 0.8, a1 * a1));
  E.w2 = mix(prob, 1.0, smoothstep(0.2, 0.8, a2 * a2));
  return E;
}

// cross-section of one graben at distance x from its axis: flat floor (half width wf), smoothstep wall of height
// H1 and width ww1 (slope limited), uplifted footwall shoulder, optional medial groove. Returns (h, dh/dx).
vec2 grabenProf(float x, float wf, float dep0, float H1, float ww1, float gm, float fp) {
  float t = clamp((x - wf) / ww1, 0.0, 1.0);
  float h = -dep0 + H1 * t * t * (3.0 - 2.0 * t);
  float dh = H1 * 6.0 * t * (1.0 - t) / ww1;
  float sx = (x - wf - 1.3 * ww1) / (0.9 * ww1);
  float shd = 0.1 * H1 * exp(-sx * sx);
  h += shd;
  dh += shd * (-2.0 * sx) / (0.9 * ww1);
  float gw = max(0.16 * wf, 1.5 * fp);
  float gx = x / gw;
  float gg = 0.12 * dep0 * gm * exp(-gx * gx);
  return vec2(h - gg, dh + gg * 2.0 * gx / gw);
}

// Graben along the network: a flat, resurfaced floor (with an optional medial groove, as on Ariel), walls limited
// to ~32 deg, uplifted footwall shoulders, and tilted blocks so the two walls of a trough differ in height. Activity
// varies smoothly over the surface, so graben narrow, shallow and pinch out (en echelon) instead of ending abruptly.
// n0, nVar: the activity and width-variation noise samples (from the tap table). Network 0 only (every moon has <= 1).
void faultNet(inout Terr T, vec3 p, float fp, float excl, float n0, float nVar) {
  vec4 A = uNetA[0], B = uNetB[0];
  if (A.w <= 0.0) return;
  float sd = uSeed * 3.1;
  float th = 0.62 - 1.3 * B.y;
  float act = smoothstep(th - 0.2, th + 0.2, n0) * excl;
  if (act <= 0.01) return;
  Edge E = voroEdge(p, A.xyz, A.w, B.x, sd, uNetG[0].y);
  if (E.d > 1.0) return;
  float x = E.d;
  float var = 0.5 + 0.5 * nVar;
  float wf0 = B.z * (0.3 + 0.7 * act) * (0.55 + 0.9 * var);
  float dep00 = B.w * sqrt(act) * (0.7 + 0.5 * var);
  float wf = wf0 * E.w1;
  float dep0 = dep00 * sqrt(E.w1);
  float e1 = dep0 * 0.7 * (E.h1 - 0.5), e2 = dep0 * 0.7 * (E.h2 - 0.5);
  float H1 = dep0 + e1, H2 = dep0 + e2;
  float ww1 = max(2.4 * H1, 1.5 * fp), ww2 = max(2.4 * H2, 1.5 * fp);
  if (x > wf + 3.0 * ww1 + 2.0 * fp) return;
  float gm = uNetG[0].x * smoothstep(2.0, 5.0, wf / fp);
  vec2 P1 = grabenProf(x, wf, dep0, H1, ww1, gm, fp);
  float h = P1.x;
  vec3 gr = P1.y * E.n;
  if (E.d2 < wf + 3.0 * ww1) {
    // the second-nearest active border (a junction): smooth union of the two troughs
    float wfb = wf0 * E.w2, depb = dep00 * sqrt(E.w2);
    float Hb = depb + e1 * depb / max(dep0, 1e-6);
    vec2 P2 = grabenProf(E.d2, wfb, depb, Hb, max(2.4 * Hb, 1.5 * fp), gm, fp);
    float kk = 0.35 * max(dep0, depb);
    float q = clamp(0.5 + 0.5 * (P2.x - P1.x) / kk, 0.0, 1.0);
    h = mix(P2.x, P1.x, q) - kk * q * (1.0 - q);
    gr = mix(P2.y * E.n2, gr, q);
  }
  float t = clamp((x - wf) / ww1, 0.0, 1.0);
  float er = 1.0 - smoothstep(wf + 0.2 * ww1, wf + ww1, min(x, E.d2));
  T.h = T.h * (1.0 - er) + h;
  T.g = T.g * (1.0 - er) + gr;
  T.sh = mix(T.sh, 1.0, er);
  float wallM = 4.0 * t * (1.0 - t);
  T.alb += 0.12 * wallM * act + 0.04 * er * act;   // fresh scarps bright, smooth floor deposits
  T.young = max(T.young, 0.6 * wallM * act);
  if (gLt > 1e-4) {
    float sdn = dot(gS, E.n);
    float soft = 0.1 * dep0 + fp * 1.2;
    if (sdn > 1e-3 && x < wf + ww1) {
      // the Sun is beyond this block's own wall
      float dist = (wf + ww1 - x) / sdn;
      float need = e1 - h;
      T.sh = min(T.sh, mix(1.0, smoothstep(-soft, soft, dist * gTanE - need), smoothstep(1.0, 2.5, dist / fp)));
    } else if (sdn < -1e-3) {
      // the Sun is beyond the far wall (the neighbouring block)
      float dist = (x + wf + ww2) / (-sdn);
      float need = e2 - h;
      T.sh = min(T.sh, mix(1.0, smoothstep(-soft, soft, dist * gTanE - need), smoothstep(1.0, 2.5, dist / fp)));
    }
  }
}

// ---- Miranda's coronae (uNCor > 0 only) ---------------------------------------------------------------------------
// Lobate outline pseudo-distance: a superellipse (exponent m; m ~ 2.5 ovoid like Arden / Elsinore, m >~ 3 squarish
// with rounded corners like Inverness), tapered so one side is shorter (trapezoid). Scaled so |grad| ~ 1 near the edge.
float sdShape(vec2 q, vec2 b, float m, float taper) {
  float tw = 1.0 - taper * clamp(q.y / b.y, -1.0, 1.0);
  vec2 a = abs(vec2(q.x / tw, q.y)) / b;
  float r = pow(pow(a.x, m) + pow(a.y, m), 1.0 / m);
  return (r - 1.0) * min(b.x * tw, b.y);
}
float sdSeg(vec2 q, vec2 a, vec2 b) { vec2 pa = q - a, ba = b - a; float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }

// The corona's ten derivative-noise samples n_k(A_k uv + o_k), each (n, dn/du, dn/dv), accumulated straight into the
// combinations the corona uses (fewer live registers than ten separate samples): lx / ly = the two lobe-warp
// octaves (0.05 n0 + 0.018 n2, 0.05 n1 + 0.018 n3), wb = band warp (0.8 n4 + 0.3 n5), s1 = spacing variation (n6),
// ab = core knobs (n8 + n9); nA, nB, nR = values of n4, n5, n7.
struct CorN { vec3 lx; vec3 ly; vec3 wb; vec3 s1; vec3 ab; float nA; float nB; float nR; };
// sample tables (uniforms: const arrays become indexable temporaries in FXC): input matrix A_k (column-major, k >= 8
// divided by the band spacing), offset (ox, oy, z = a fi + b), weights in (lx, ly, wb, ab) and (s1, nA, nB, nR)
uniform vec4 uCorM[10], uCorO[10], uCorW1[10], uCorW2[10];   // (see COR_TABLES in moons.js)

// Outline distance and band phase at tangent-plane point uv, with analytic gradients (no finite differences of the
// noise, which tripled the shader). The outline is lobate (two warp octaves); the band coordinate is the depth inside
// the outline, warped by ~0.5 of a band spacing and divided by a spacing that varies along the outline, so bands
// wander, pinch, merge and terminate instead of running as parallel contour lines.
struct CorF { float sd; float ph; vec2 gsd; vec2 gph; float nA; float nB; float nC; };
CorF corField(vec2 uv, vec2 b, float m, float kind, float lam, CorN N) {
  vec2 lob = vec2(N.lx.x, N.ly.x);
  // Jacobian of the warped point w = uv + lob
  vec2 dlx = N.lx.yz;   // gradient of lob.x
  vec2 dly = N.ly.yz;   // gradient of lob.y
  vec2 w = uv + lob;
  float taper = kind > 1.5 ? 0.32 : 0.0;
  float sd = sdShape(w, b, m, taper);
  float e = 2e-3;
  vec2 gw = vec2(sdShape(w + vec2(e, 0.0), b, m, taper) - sd, sdShape(w + vec2(0.0, e), b, m, taper) - sd) / e;
  vec2 gsd = vec2(gw.x * (1.0 + dlx.x) + gw.y * dly.x, gw.x * dlx.y + gw.y * (1.0 + dly.y));
  float wb = lam * N.wb.x;
  vec2 gwb = lam * N.wb.yz;
  float sp = lam * (1.0 + 0.3 * N.s1.x);
  vec2 gsp = lam * 0.3 * N.s1.yz;
  CorF F;
  F.sd = sd;
  F.ph = (wb - sd) / sp;
  F.gsd = gsd;
  F.gph = (gwb - gsd) / sp - (wb - sd) / (sp * sp) * gsp;
  F.nA = N.nA; F.nB = N.nB; F.nC = N.s1.x;   // reused as modulation noise
  return F;
}

// asymmetric ridge: sharp crest (at integer phase), broad trough, one flank steeper. returns (h in 0..1, dh/dphase)
vec2 ridgeP(float ph, float k) {
  float a = 6.2831853 * ph;
  float ta = a + 0.55 * sin(a);
  float dta = 1.0 + 0.55 * cos(a);
  float e = exp(k * (cos(ta) - 1.0));
  return vec2(e, -k * sin(ta) * dta * 6.2831853 * e);
}

// Miranda corona: a belt of ridge-and-groove bands concentric with the lobate outline, alternating bright and dark
// albedo stripes (with dark blotches), fine grooves superposed (Elsinore's "fingerprint"), a raised outer edge
// that truncates the cratered terrain, a knobby, mottled core, and (Inverness type) the bright chevron.
// nG, nW, nR2: simplex samples of the tap table (uv 21, uv 5, uv 24).
float corona(inout Terr T, vec3 p, int i, float fp, vec2 uv, float cp, CorN N, float nG, float nW, float nR2) {
  vec3 c = uCoA[i].xyz;
  vec3 ax = uCoX[i].xyz, ay = uCoY[i].xyz;
  vec2 b = uCoP[i].xy;
  float kind = uCoP[i].w, m = uCoA[i].w, bw = uCoX[i].w, lam = uCoY[i].w, fi = float(i);
  CorF F = corField(uv, b, m, kind, lam, N);
  if (F.sd > 0.035) return 0.0;
  vec3 Jx = (ax - uv.x * c) / cp, Jy = (ay - uv.y * c) / cp;
  vec3 gP = F.gph.x * Jx + F.gph.y * Jy;    // surface gradient of the band phase
  vec3 gD = F.gsd.x * Jx + F.gsd.y * Jy;    // ... and of the outline distance
  float fpe = max(fp, 1e-5);
  float edgeW = max(0.004, 1.5 * fpe);
  float inside = 1.0 - smoothstep(-edgeW, 0.0, F.sd);
  float depth = -F.sd;
  float beltE = bw * (1.0 + 0.25 * F.nC);
  float belt = inside * (1.0 - smoothstep(beltE * 0.75, beltE * 1.1, depth));
  float core = inside - belt;
  float per = 1.0 / max(length(gP), 1e-3);  // local band period (unit radius)
  float nRx = N.nR;

  float h = 0.0;
  vec3 g = vec3(0.0);
  float albD = 0.0;
  // ridges and troughs: a few prominent ridges, many subdued ones (smoothly varying amplitude)
  float lodR = smoothstep(1.5, 4.0, per / fpe);
  float rv = 0.25 + 0.75 * smoothstep(-0.3, 0.7, nRx);
  float grooved = kind > 0.5 && kind < 1.5 ? 1.0 : 0.0;
  float amp = mix(0.06, 0.04, grooved) * lam * rv * belt;
  vec2 r1 = ridgeP(F.ph, 1.1);
  h += amp * lodR * (r1.x - 0.3);
  g += amp * lodR * r1.y * gP;
  // fine grooves parallel to the bands (the scratched, "fingerprint" texture of Elsinore and Arden's outer belt)
  float nf = mix(3.0, 4.0, grooved);
  float ph2 = F.ph * nf + 0.3 * nG;
  float lodF = smoothstep(2.0, 5.0, per / nf / fpe);
  vec2 r2 = ridgeP(ph2, 0.9);
  float amp2 = mix(0.01, 0.02, grooved) * lam * belt * (0.6 - 0.4 * nRx);
  h += amp2 * lodF * (r2.x - 0.35);
  g += amp2 * lodF * r2.y * nf * gP;
  T.sv += (1.0 - lodF) * belt * 0.01;
  // albedo stripes from the same warped field (period ~2.6 ridges), bright / dark, fading and pinching out;
  // different stripes have different strengths (some bright bands, some barely there)
  float lodB = smoothstep(1.0, 3.0, per * 1.45 / fpe);
  float bph = F.ph / 1.45 + 0.37 + 0.15 * F.nB;
  float band = tanh(2.0 * sin(6.2831853 * bph) + 0.6 * F.nA);
  float bmod = 0.12 + 0.88 * smoothstep(-0.5, 0.7, F.nC + 0.8 * sin(1.7 * F.ph + fi) + 0.5 * nRx);
  albD += belt * uCoP[i].z * 0.8 * band * bmod * lodB;
  // dark blotches strung along the dark bands (Arden, PIA01490)
  float blot = smoothstep(0.3, 0.8, nG * 0.6 + 0.4 * F.nB);
  albD -= belt * uCoP[i].z * 0.3 * blot * smoothstep(0.0, -0.6, band) * smoothstep(1.0, 3.0, 0.05 / fpe);
  // raised outer edge: the youngest, outermost ridge truncates the cratered terrain
  float ew = max(1.2 * lam, edgeW);
  float ex = depth / ew;
  float ee = exp(-pow(ex - 0.6, 2.0) * 2.0) * inside;
  h += 0.12 * lam * ee;
  g += 0.12 * lam * ee * (-4.0 * (ex - 0.6)) / ew * (-gD);
  // core: knobby, intersecting ridge sets and mottled albedo
  if (core > 0.0) {
    float lodC = smoothstep(1.5, 4.0, lam * 0.8 / fpe);
    float ac = 0.075 * lam * core * lodC;
    h += ac * N.ab.x;
    vec2 guv = N.ab.yz;
    g += ac * (guv.x * Jx + guv.y * Jy);
    albD += core * (0.16 * F.nA + 0.1 * F.nB + 0.08 * nG * smoothstep(1.0, 3.0, 0.03 / fpe) - 0.02);
  }
  if (kind > 1.5) {
    // the chevron: a bright, angular V-shaped albedo patch, apex toward the corona centre; its width varies along
    // the arms and its edge is ragged and feathered; streaks run parallel to the arms inside it
    vec2 s = b / vec2(0.5, 0.4);
    vec2 apex = vec2(0.02, -0.2) * s;
    vec2 a1 = vec2(-0.34, 0.2) * s, a2 = vec2(0.3, 0.26) * s;
    float d1 = sdSeg(uv, apex, a1), d2 = sdSeg(uv, apex, a2);
    float dv = min(d1, d2);
    vec2 dir = d1 < d2 ? normalize(a1 - apex) : normalize(a2 - apex);
    float across = dot(uv - apex, vec2(-dir.y, dir.x));
    float wch = 0.07 * min(s.x, s.y) * (0.6 + 0.45 * nW + 0.25 * F.nB);
    float rag = wch * (0.35 * nR2 + 0.25 * nG * smoothstep(1.0, 3.0, 0.02 / fpe));
    float fe = max(0.35 * wch, 1.5 * fpe);
    float chev = 1.0 - smoothstep(wch - fe, wch + fe, dv + rag);
    float streak = 0.72 + 0.28 * sin(across / (0.16 * wch) + 2.5 * nR2) * smoothstep(1.0, 3.0, 0.16 * wch / fpe);
    albD += 0.62 * chev * streak * (0.8 + 0.2 * nW) * inside;
    T.young = max(T.young, chev * inside);
  }
  float er = inside * 0.92;
  T.h = T.h * (1.0 - er) + h;
  T.g = T.g * (1.0 - er) + g;
  T.sh = mix(T.sh, 1.0, er);
  T.alb += albD;
  return inside;
}

/// fault scarp along a great-circle arc (Verona Rupes type): a cliff several km high (one guard, arithmetic shadow)
void scarp(inout Terr T, vec3 p, int i, float fp) {
  vec3 c = uScA[i].xyz, t = uScB[i].xyz;
  float cp = dot(p, c);
  vec3 nrm = cross(c, t);
  float s = dot(p, nrm);
  float along = atan(dot(p, t), cp);
  float env = 1.0 - smoothstep(uScA[i].w * 0.6, uScA[i].w, abs(along));
  if (cp >= 0.2 && env > 0.0 && abs(s) <= 0.08) {
    float H = uScB[i].w;
    float sw = s + 0.15 * abs(H) * (sin(along * 25.0 + float(i)) * 0.7 + sin(along * 61.0) * 0.3);
    float wdt = max(abs(H) * 0.7, fp * 1.5);
    float st = smoothstep(-wdt, wdt, sw);
    float h = H * env * (st - 0.5);
    vec3 gn = nrm - dot(nrm, p) * p;
    T.h += h;
    T.g += H * env * sstepD(-wdt, wdt, sw) * gn;
    T.alb += 0.08 * env * exp(-pow(sw / (wdt * 1.2), 2.0));
    T.young = max(T.young, 0.5 * env * exp(-pow(sw / (wdt * 1.2), 2.0)));
    float sd = dot(gS, normalize(gn)) * sign(H);
    float sl = sw * sign(H);
    float have = (-sl / max(sd, 1e-3)) * gTanE;
    float soft = abs(H) * 0.06 + fp * 1.2;
    float on = float(gLt > 1e-4 && sl < 0.0 && sd > 1e-3);
    T.sh = min(T.sh, mix(1.0, smoothstep(-soft, soft, have - abs(H) * env), env * on));
  }
}
// Hapke IMSA for two geometries at once: (mu0, mu) of the resolved facet and (mu0m, mum) of the mean surface
// (one inlined copy instead of two)
void hapke2(float mu0, float mu, float mu0m, float mum, float g, out vec3 r1, out vec3 r2) {
  vec3 gam = sqrt(1.0 - uW);
  float B = uHapke.x / (1.0 + tan(0.5 * min(g, 3.0)) / uHapke.y);
  float bb = uHapke.z;
  float P = (1.0 - bb * bb) / pow(1.0 + 2.0 * bb * cos(g) + bb * bb, 1.5);
  vec4 x = vec4(mu0, mu, mu0m, mum);
  vec4 Hr = (1.0 + 2.0 * x) / (1.0 + 2.0 * x * gam.r);
  vec4 Hg = (1.0 + 2.0 * x) / (1.0 + 2.0 * x * gam.g);
  vec4 Hb = (1.0 + 2.0 * x) / (1.0 + 2.0 * x * gam.b);
  float bp = (1.0 + B) * P - 1.0;
  r1 = uW * 0.25 * mu0 / (mu0 + mu) * (bp + vec3(Hr.x * Hr.y, Hg.x * Hg.y, Hb.x * Hb.y));
  r2 = uW * 0.25 * mu0m / (mu0m + mum) * (bp + vec3(Hr.z * Hr.w, Hg.z * Hg.w, Hb.z * Hb.w));
}

void main() {
  vec3 rd = normalize(vPosW);
  vec3 o = (vPosW - uCenterW) / uRad;
  vec2 tt = raySphereS(o, rd, 1.0);
  float th = tt.x < 1e19 ? tt.x : dot(-o, rd);
  vec3 pl = normalize(o + rd * th);
  vec3 pW = uCenterW + pl * uRad;
  mat3 Bi = transpose(uBasis);
  vec3 p = Bi * pl;
  vec3 L = normalize(Bi * uSunDirW);
  vec3 V = normalize(Bi * (-pW));
  float fp = max(length(fwidth(vPosW)) / uRad, 1e-5);

  float sinE = dot(L, p);
  vec3 Lt = L - sinE * p;
  gLt = length(Lt);
  gS = gLt > 1e-6 ? Lt / gLt : vec3(0.0);
  gTanE = sinE / max(gLt, 1e-4);

  Terr T;
  T.h = 0.0; T.g = vec3(0.0); T.alb = 0.0; T.sh = 1.0; T.young = 0.0; T.sv = 0.0;

  // Miranda: the coronae do not overlap: pick the one whose outline box contains p (cheap), evaluate only that one
  int ci = -1;
#ifndef MOON_LEAN
  float best = 0.12;
  for (int i = 0; i < uNCor; i++) {
    vec3 c = uCoA[i].xyz;
    float cp = dot(p, c);
    if (cp < 0.3) continue;
    vec3 q = p / cp;
    float bx = max(abs(dot(q, uCoX[i].xyz)) - uCoP[i].x, abs(dot(q, uCoY[i].xyz)) - uCoP[i].y);
    if (bx < best) { best = bx; ci = i; }
  }
#endif
  vec2 cuv = vec2(0.0);
  float ccp = 1.0, cfi = 0.0, clam = 1.0;
  if (ci >= 0) {
    vec3 c = uCoA[ci].xyz;
    ccp = dot(p, c);
    vec3 q = p / ccp;
    cuv = vec2(dot(q, uCoX[ci].xyz), dot(q, uCoY[ci].xyz));
    cfi = float(ci);
    clam = uCoY[ci].w;
  }

  // ---- every gradient-noise sample through ONE gnoiseD() site: the corona's 10 samples (if p is in a corona box),
  // then the octaves of the self-affine relief fractal (rolling plains down to regolith hummocks, one octave per
  // frequency doubling, each faded in only once its wavelength spans a few pixels; octaves too fine to draw go into
  // the slope-variance term instead: 0.004 per missing octave). Branch-free apart from the guard of gnoiseD().
  CorN N;
  N.lx = N.ly = N.wb = N.s1 = N.ab = vec3(0.0);
  N.nA = N.nB = N.nR = 0.0;
  vec3 gF = vec3(0.0);
  {
#ifdef MOON_LEAN
    const int nC = 0;   // (the corona samples fold away)
#else
    int nC = ci >= 0 ? uN10 : 0;
#endif
    float f = uRelief.z, sl = uRelief.x;
    for (int k = 0; k < nC + uNRel; k++) {
      float isC = float(k < nC);
      int kc = min(k, 9);
      int i = k - nC;
      vec4 M = uCorM[kc], O = uCorO[kc];
      mat2 A = mat2(M.x, M.y, M.z, M.w) * mix(1.0, 1.0 / clam, float(kc >= 8));
      float wr = smoothstep(2.0, 5.0, 1.0 / (f * fp)) * (1.0 - isC);
      T.sv += (1.0 - isC) * float(wr <= 0.0) * 0.004;
      vec3 xg = mix(p * f + vec3(float(i) * 17.3, uSeed, float(i) * 5.1), vec3(A * cuv + O.xy, cfi * O.z + O.w), isC);
      vec4 n = vec4(0.0);
      if (isC > 0.5 || wr > 0.0) n = gnoiseD(xg);
      vec3 r = vec3(n.x, transpose(A) * n.yz) * isC;
      vec4 W1 = uCorW1[kc], W2 = uCorW2[kc];
      N.lx += W1.x * r;
      N.ly += W1.y * r;
      N.wb += W1.z * r;
      N.ab += W1.w * r;
      N.s1 += W2.x * r;
      N.nA += W2.y * r.x;
      N.nB += W2.z * r.x;
      N.nR += W2.w * r.x;
      gF += (sl * 0.4) * wr * n.yzw;
      f *= mix(2.0, 1.0, isC);
      sl *= mix(uRelief.y, 1.0, isC);
    }
  }

  // ---- simplex-noise taps (provinces, fault activity, albedo mottling, Miranda's corona detail, the four samples of
  // each rayed crater's ray system) through one snoise() site in one real loop. Branch-free apart from the guard of
  // snoise() itself (FXC compiles every conditional region inside a loop very slowly): taps are accumulated into
  // one-hot slots P0 = (provinces, fault activity, fault width variation, mottling), P1 = (nG, nW, nR2, -)
  vec4 P0 = vec4(0.0), P1 = vec4(0.0);
  vec4 rayV = vec4(0.0);
  {
    const vec4 I4 = vec4(0.0, 1.0, 2.0, 3.0);
    float rNl = 0.0, rN1 = 0.0, rN2 = 0.0;
    for (int it = 0; it < uNTap; it++) {
      vec4 A = uTapA[it], B = uTapB[it];
      float dest = floor(A.w * 0.25);
      // albedo mottling octave (frequency A.x): band-limited by footprint
      // ray-system samples of named crater B.w in its tangent frame (cs = azimuth direction, ur = distance / Rc)
#ifdef MOON_LEAN
      const float isRay = 0.0;   // (the lean program has no ray / corona taps: their code folds away)
#else
      float isRay = float(dest > 6.5);
#endif
      float wt = mix(B.w * mix(1.0, smoothstep(2.5, 6.0, 1.0 / (A.x * fp)), float(dest > 2.5 && dest < 3.5)), 1.0, isRay);
      int j = int(clamp(B.w, 0.0, float(NCR - 1)) + 0.5);
      vec3 C = uCrA[j].xyz;
      float Rj = uCrA[j].w;
      float slot = floor((uCrB[j].z - 4.0) * 10.0 + 0.5);
      vec3 dv = p - C;
      float ur = length(dv) / max(Rj, 1e-6);
      vec3 e1 = normalize(cross(C, mix(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), float(abs(C.y) < 0.9))));
      vec3 e2 = cross(C, e1);
      vec2 cs = normalize(vec2(dot(dv, e1), dot(dv, e2)) + 1e-9);
      // rays curve and wander a little along their length (samples 2-4 use the first one)
      float wa = 0.06 * rNl * (ur - 1.0) / 4.0 * float(dest > 7.5);
      cs = vec2(cs.x * cos(wa) - cs.y * sin(wa), cs.x * sin(wa) + cs.y * cos(wa));
#ifdef MOON_LEAN
      const float isCor = 0.0;
#else
      float isCor = float(dest > 3.5 && dest < 6.5);
#endif
      vec3 bp = mix(mix(p, vec3(cuv, cfi), isCor), vec3(cs, ur), isRay);
      bool use = wt > 0.0 && (isCor == 0.0 || ci >= 0) && (isRay == 0.0 || ur <= 9.0);
      float n = 0.0;
      if (use) n = snoise(bp * A.xyz + B.xyz);
      P0 += n * wt * vec4(lessThan(abs(dest - I4), vec4(0.5)));
      P1 += n * vec4(lessThan(abs(dest - 4.0 - I4), vec4(0.5)));
      rNl = mix(rNl, n, float(abs(dest - 7.0) < 0.5));
      rN1 = mix(rN1, n, float(abs(dest - 8.0) < 0.5));
      rN2 = mix(rN2, n, float(abs(dest - 9.0) < 0.5));
      // fourth sample: the ray system of this crater is complete (zero beyond 9 crater radii)
      rayV += onehot4(slot) * (float(dest > 9.5 && use) * raySystem(ur, Rj, fp, rNl, rN1, rN2, n));
    }
  }
  float prov = P0.x, nAct = P0.y, nVar = P0.z, mott = P0.w, nG = P1.x, nW = P1.y, nR2 = P1.z;

  // terrain provinces: large regions that are more / less cratered and slightly darker / brighter
  float damp = clamp(1.0 + uField2.y * prov, 0.15, 1.6);
  // Miranda's corona goes in first (craters overprint it)
  float inC = 0.0;
#ifdef MOON_LEAN
  // Lean program (the film: no Uranian moon is ever larger than ~3 px in radius): the craters, coronae, faults and
  // canyons are all unresolved there, so only their photometric effect remains: the slope-variance (shadow-hiding)
  // term the full program accumulates for unresolved crater octaves, exactly as computed there.
  for (int oct = 0; oct < uOctaves; oct++) {
    float s = 0.5 * exp2(-float(oct));
    T.sv += (1.0 - smoothstep(1.0, 3.0, 0.3 * s / fp)) * uField.x * mix(1.0, 0.6, float(oct == 0)) * damp * 0.01;
  }
#else
  if (ci >= 0) inC = corona(T, p, ci, fp, cuv, ccp, N, nG, nW, nR2);
  damp *= 1.0 - 0.8 * inC;

  // ---- craters in ONE loop with a single crater() call site: the named craters first, then the hierarchical field,
  // octave by octave, oldest / largest first (smaller, younger craters overprint and erase older relief).
  // Field: one candidate per 3D cell of size s (exact on the sphere: no seams or pole pinching), kept only if it lies
  // in the shell |r - 1| < s/2 (uniform areal density). Radii follow a power law inside each octave (dN/dR ~ R^-3
  // between 0.15 s and 0.3 s), so with a constant density per octave N(>D) ~ D^-2 overall.
  // The candidate is selected arithmetically and everything else sits under ONE guard (see the taps loop).
  int nCrT = uNCr + uOctaves * uN8;
  for (int j = 0; j < nCrT; j++) {
    float fN = float(j < uNCr);
    int jn = min(j, NCR - 1);
    vec4 cA = uCrA[jn], cB = uCrB[jn];
    // field candidate: octave oct, corner k of the 2x2x2 cell neighbourhood
    int jj = max(j - uNCr, 0);
    int oct = jj / uN8;
    int k = jj - oct * uN8;
    float s = 0.5 * exp2(-float(oct));
    float seed = uSeed + float(oct) * 7.31;
    float dens = uField.x * mix(1.0, 0.6, float(oct == 0));
    float lodO = smoothstep(1.0, 3.0, 0.3 * s / fp);
    vec3 c = floor(p / s - 0.5) + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 hh = hash33(c + seed);
    vec3 C = (c + hash33(c * 1.37 + seed + 17.17)) * s;
    float lc = length(C);
    vec3 h2 = hash33(c * 2.71 + seed + 5.3);
    float RcF = 0.15 * s / sqrt(1.0 - 0.75 * hh.z);
    vec3 CnF = C / lc;
    float wgtF = lodO * smoothstep(1.5, 3.5, RcF / fp);
    bool candF = lodO > 0.0 && hh.x <= dens * damp && abs(1.0 - lc) <= 0.5 * s && length(p - CnF) <= 1.65 * RcF;
    // unresolved octaves and unresolved craters still roughen the photometry
    T.sv += (1.0 - fN) * (float(k == 0) * (1.0 - lodO) * dens * damp * 0.01 + float(candF && wgtF <= 0.0) * 0.02);
    vec3 Cn = mix(CnF, cA.xyz, fN);
    float Rc = mix(RcF, cA.w, fN);
    float kind = mix(-1.0, cB.z, fN);
    float wgt = mix(wgtF, smoothstep(1.5, 3.5, Rc / fp), fN);
    vec3 dv = p - Cn;
    bool valid = (fN > 0.5 && length(dv) <= 9.0 * Rc) || (fN < 0.5 && candF && wgtF > 0.0);
    if (valid) {
      // most field craters are degraded (soft, shallow, infilled); only a few percent are crisp
      float fr = mix(mix(uField.w, 1.0, pow(h2.x, 1.9)), mix(0.75, 1.0, float(kind > 3.5 && kind < 4.5)), fN);
      float er = mix(uField2.x * mix(0.4, 1.0, fr), 0.9, fN);
      float uOut = mix(1.65, 2.6, fN);
      float irr = mix(0.04 + 0.05 * h2.z, 0.06, fN);
      float D, Hr, uf, pk, rr;
      craterShape(Rc, fr, mix(h2.y, 1.0, fN), D, Hr, uf, pk, rr);
      // named craters: measured depth, rim and peak
      D = mix(D, cB.x, fN);
      Hr = mix(Hr, cB.y, fN);
      pk = mix(pk, cB.w, fN * float(cB.w > 0.0));
      // irregular, polygonal outline: the crater's outline-noise sample (only for craters drawn > ~6 px in radius)
      float nIrr = 0.0;
      if (wgt > 0.0 && Rc > 6.0 * fp) nIrr = snoise((dv / max(length(dv), 1e-7)) * 3.0 + Cn * 37.0);
      float u = crater(T, p, Cn, Rc, D, Hr, uf, pk, rr, wgt, fp, er, uOut, irr, nIrr);
      // field craters: only the freshest have bright walls / ejecta; nothing is painted on the rims
      float young = smoothstep(0.86, 1.0, fr) * clamp(0.25 + 3.0 * uField2.z, 0.0, 1.0) * (1.0 - fN);   // few on dark Umbriel
      T.alb += wgt * young * (0.3 * (1.0 - smoothstep(0.85, 1.7, u)) + 0.12 * (1.0 - smoothstep(0.4, 0.9, u)));
      T.young = max(T.young, young * (1.0 - smoothstep(1.0, 1.7, u)) * wgt);
      // dark-floored craters (Oberon): dark material ponded on the floors of the larger craters
      T.alb -= (1.0 - fN) * float(uDarkFloors > 0.0 && h2.y < uDarkFloors && Rc > 0.012) * wgt * 0.32 * (1.0 - smoothstep(0.3, 0.7, u));
      // named craters by kind: 1 dark floor, 2 bright annulus (Wunda), 3 bright central peak, 4 bright rays, 5 dark halo
      float wa = smoothstep(0.5, 1.5, Rc / fp) * fN;
      T.alb -= float(kind > 0.5 && kind < 1.5) * 0.4 * wa * (1.0 - smoothstep(0.45, 0.8, u));
      T.alb += float(kind > 1.5 && kind < 2.5) * 1.0 * wa * exp(-pow((u - 0.62) / 0.1, 2.0));
      T.alb += float(kind > 2.5 && kind < 3.5) * 0.8 * wa * exp(-u * u * 28.0);
      T.alb -= float(kind > 4.5) * 0.2 * (1.0 - smoothstep(0.8, 2.5, u));
      T.alb += float(kind > 3.5 && kind < 4.5) * dot(rayV, onehot4(floor((kind - 4.0) * 10.0 + 0.5)));
    }
  }

  // fault networks and the named chasmata cut the cratered plains
  if (uNNet > 0) faultNet(T, p, fp, 1.0 - inC, nAct, nVar);
  for (int i = 0; i < uNCa; i++) canyon(T, p, uCaA[i], uCaB[i], uCaD[i], fp);
  for (int i = 0; i < uNSc; i++) scarp(T, p, i, fp);
#endif

  // multi-scale fractal relief over everything (smoother on the young corona surfaces)
  gF *= 1.0 - 0.45 * inC;
  gF -= dot(gF, p) * p;

  // albedo variegation: broad provinces (10-15 %), mid-scale mottling and fine speckle standing in for unresolved
  // craters / ejecta / frost patches (each band-limited by footprint; the octaves are in the tap table)
  mott += 0.25 * uField2.z * prov;
  float alb = clamp(1.0 + mott + T.alb, 0.2, 2.6);
  vec3 Ac = vec3(alb) * mix(vec3(1.0), vec3(0.97, 1.0, 1.035), clamp(T.young, 0.0, 1.0));

  // slope limit (~35 deg): resolved walls stay plausible and do not blow out to white at the terminator
  vec3 gt = T.g + gF;
  float gl = length(gt);
  gt *= inversesqrt(sqrt(1.0 + pow(gl / 0.7, 4.0)));
  vec3 n = normalize(p - gt);
  float mu0 = dot(n, L), mu = max(dot(n, V), 1e-3);
  float mu0m = dot(p, L);
  float g = acos(clamp(dot(L, V), -1.0, 1.0));
  float mum = max(dot(p, V), 1e-3);
  vec3 rad, radM;
  hapke2(max(mu0, 0.0), mu, max(mu0m, 0.0), mum, g, rad, radM);
  if (mu0 <= 0.0) rad = vec3(0.0);
  if (mu0m <= 0.0) radM = vec3(0.0);
  // Hapke's macroscopic roughness makes resolved slopes shade more like Lambert as the phase grows (cf. the
  // lunar-Lambert fits to Voyager images of icy satellites, McEwen 1991): keep the disc-scale Hapke law but give
  // facets a Lambert-like dependence on their own tilt, weight rising with phase.
  float lw = clamp(g / 2.1, 0.0, 0.7);
  rad *= mix(1.0, (max(mu0, 0.0) + mu) / max(max(mu0m, 0.0) + mum, 1e-3), lw);
  // unresolved relief still casts tiny shadows: darkening that grows with phase
  rad *= 1.0 - clamp(T.sv, 0.0, 0.3) * (0.5 - 0.5 * cos(g)) * 1.1;
  float term = smoothstep(-0.03, 0.05, mu0m);
  // light scattered from sunlit surroundings into shadows (crater floors, canyon walls)
  vec3 direct = rad * T.sh * term + radM * 0.07 * (1.0 - T.sh) * term;

  // Uranus's shadow (eclipses) and Uranus-shine on the night side
  vec3 psU = toPlanetS(pW);
  vec3 LsU = dirToPlanetS(uSunDirW);
  float ecl = deckOcclusion(psU, LsU, 0.006);
  vec3 toU = uPlanetW - pW;
  float dU = length(toU) / uR;
  vec3 uDir = normalize(toU);
  float cb = clamp(dot(normalize(pW - uPlanetW), uSunDirW), -1.0, 1.0);
  float beta = acos(cb);
  float phiL = (sin(beta) + (PI - beta) * cb) / PI;
  vec3 shine = uShineCol * phiL / (dU * dU) * max(dot(uBasis * n, uDir), 0.0) * uAlbN;

  vec3 col = Ac * (direct * ecl * uSunColor + shine * 0.9) * uHapke.w;
#ifdef UDBG_LAMBERT
  col = vec3(max(dot(n, L), 0.0)) * 0.5;
#endif
#ifdef UDBG_GRID
  {
    // lat / lon grid every 30 deg (lon 0 red, lat 0 green)
    float la = asin(clamp(p.y, -1.0, 1.0)) * 57.29578, lo = atan(-p.z, p.x) * 57.29578;
    float gla = abs(fract(la / 30.0 + 0.5) - 0.5) * 30.0, glo = abs(fract(lo / 30.0 + 0.5) - 0.5) * 30.0 * cos(la / 57.29578);
    float wpx = fp * 57.29578 * 1.5;
    col = mix(col, vec3(abs(la) < 15.0 ? 0.2 : 1.0, 1.0, abs(lo) < 15.0 ? 0.2 : 1.0) * 0.6, (1.0 - smoothstep(0.0, wpx, min(gla, glo))) * 0.8);
  }
#endif
  gl_FragColor = vec4(col, 1.0);
#ifdef UDBG_NAN
  if (!all(lessThan(abs(col), vec3(65000.0)))) gl_FragColor = vec4(0.4, 0.0, 0.4, 1.0);
#endif
}
`;

// Miranda's corona noise samples (see CorN in FRAG): matrix (column-major), offset (ox, oy, a, b: z = a fi + b),
// weights into (lx, ly, wb, ab) and (s1, nA, nB, nR). Shared by all moon materials.
const COR_TABLES = (() => {
  const I = (f) => [f, 0, 0, f];
  const M = [I(2.3), I(2.3), I(6), I(6), I(4.5), I(11), I(2.4), I(6), [1, -0.6, 0.35, 0.3].map((v) => v / 1.3), [-0.45, 0.35, 1, 0.5].map((v) => v / 1.1)];
  const O = [[0, 0, 7, 0], [9, 9, 7, 3], [3, 3, 5, 0], [7, 7, 5, 1], [0, 0, 3.1, 1], [0, 0, 2.3, 5], [0, 0, 1, 11], [0, 0, 2.3, 0.7], [0, 0, 1, 0], [0, 0, 1, 5]];
  const W1 = [[0.05, 0, 0, 0], [0, 0.05, 0, 0], [0.018, 0, 0, 0], [0, 0.018, 0, 0], [0, 0, 0.8, 0], [0, 0, 0.3, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 1]];
  const W2 = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [1, 0, 0, 0], [0, 0, 0, 1], [0, 0, 0, 0], [0, 0, 0, 0]];
  const v = (a) => ({ value: a.map((x) => new THREE.Vector4(...x)) });
  return { uCorM: v(M), uCorO: v(O), uCorW1: v(W1), uCorW2: v(W2) };
})();

// Simplex-noise taps of one moon (see FRAG): snoise(base * scale + offset) * weight into a destination.
// base: 0 p, 1 corona tangent-plane point (uv, corona index), 2 ray frame of a named crater (azimuth dir, r / Rc)
// dest: 0 provinces, 1 fault activity, 2 fault width variation, 3 albedo mottling (weight x footprint LOD of
//       frequency scale.x), 4 / 5 / 6 corona detail nG / nW / nR2, 7..10 the four ray-system samples (weight = index
//       of the named crater)
function buildMoonTaps(def, rayed, lean) {
  const T = [];
  const add = (base, sc, off, w, dest) => T.push({ base, sc, off, w, dest });
  const v3 = (s) => [s, s, s];
  const sd = def.seed;
  add(0, v3(1.15), v3(sd * 0.71), 0.7, 0); // provinces: snoise(p 1.15 + seed 0.71) 0.7 + snoise(p 2.9 + seed 1.3) 0.3
  add(0, v3(2.9), v3(sd * 1.3), 0.3, 0);
  if (def.nets.length && !lean) {
    const s3 = sd * 3.1; // network 0
    add(0, v3(1.9), v3(s3), 0.7, 1);
    add(0, v3(5.3), v3(s3 * 1.7), 0.3, 1);
    add(0, v3(13), v3(s3 * 2.3), 1, 2);
  }
  const va = def.field2[2];
  for (let i = 0, f = 1.6; i < 7; i++, f *= 2) {
    const a = 0.3 * va * Math.pow(0.72, i) + (0.02 + 0.15 * va) * 0.5 * (i >= 3.5 ? 1 : 0);
    add(0, v3(f), [sd * 1.3 + i * 3.7, i * 1.9, sd], a, 3);
  }
  if (lean) return T; // (no faults, coronae or ray systems in the lean program)
  if (def.coronae) {
    add(1, [21, 21, 1], [0, 0, 3], 1, 4);
    add(1, [5, 5, 0], [0, 0, 5], 1, 5);
    add(1, [24, 24, 0], [0, 0, 2], 1, 6);
  }
  for (const j of rayed) {
    const seed = j * 3.7 + sd; // = float(it) * 3.7 + uSeed of the old crater loop
    add(2, [2.2, 2.2, 0], [0, 0, seed], j, 7);
    add(2, [4, 4, 0.12], [0, 0, seed], j, 8);
    add(2, [13, 13, 0.4], [0, 0, seed + 3], j, 9);
    add(2, [7, 7, 0.9], [0, 0, seed], j, 10);
  }
  if (T.length > NTAP) throw new Error('uranus moons: too many noise taps');
  return T;
}

// Level of detail of the moon program, fixed at creation (never switched at runtime). The film never shows a Uranian
// moon larger than ~3 px in radius (src/bodies/uranus/tools/moonsize.mjs: Ariel 3.2 px at t = 344 s of the current
// cut), so the film builds the LEAN program (~1/8 of the compile time); the FULL program (craters, coronae, faults,
// canyons, rays) is built for the moon close-up views view=body&body=uranus&target=<moon>, with umoons=full, or for
// the film if FULL_MOONS_IN_FILM is set (e.g. if the director adds a moon close pass; +~1 s of first-draw compile).
export const FULL_MOONS_IN_FILM = false;
const MOON_IDS = ['miranda', 'ariel', 'umbriel', 'titania', 'oberon'];
function moonDetailFull() {
  if (typeof location === 'undefined') return FULL_MOONS_IN_FILM;
  const q = new URLSearchParams(location.search);
  if (q.get('umoons') === 'full') return true;
  if (q.get('umoons') === 'lean') return false;
  return FULL_MOONS_IN_FILM || (q.get('view') === 'body' && q.get('body') === 'uranus' && MOON_IDS.includes(q.get('target')));
}

export function createMoons(ctx, S) {
  const { U, BODIES } = ctx;
  const data = BODIES.uranus.moons;
  const ids = MOON_IDS;
  const lean = !moonDetailFull();
  const seg = ctx.quality === 'low' ? 96 : 192;
  const geo = new THREE.SphereGeometry(1, seg, seg / 2);
  const dbg = typeof location !== 'undefined' ? Number(new URLSearchParams(location.search).get('udbg') || 0) : 0;
  // dev-only shader variants (set once at creation): udbg=2 Lambert only, 3 lat/lon grid, 9 NaN finder
  const defines = dbg === 2 ? { UDBG_LAMBERT: 1 } : dbg === 3 ? { UDBG_GRID: 1 } : dbg === 9 ? { UDBG_NAN: 1 } : {};
  if (lean) defines.MOON_LEAN = 1;
  const list = [];
  ids.forEach((id) => {
    const b = data[id];
    const def = MOON_DEFS[id];
    const orbit = makeOrbit(id, b.aKm, b.periodDays);
    const R = b.radius;
    const crA = [], crB = [];
    const rayed = [];
    for (let i = 0; i < NCR; i++) {
      const c = def.craters[i];
      if (!c) {
        crA.push(new THREE.Vector4(0, 1, 0, 0));
        crB.push(new THREE.Vector4());
        continue;
      }
      const [la, lo, dKm, depthKm, kind, peakKm] = c;
      const Rc = dKm / 2 / b.radiusKm;
      const d = dirLL(la, lo);
      // rayed craters carry their slot in the ray-value vector (at most 4 per moon): kind = 4 + 0.1 slot
      let k = kind;
      if (kind === 4) {
        k = 4 + 0.1 * rayed.length;
        rayed.push(i);
      }
      crA.push(new THREE.Vector4(d.x, d.y, d.z, Rc));
      crB.push(new THREE.Vector4(depthKm / b.radiusKm, ((0.04 * dKm) / b.radiusKm) * Math.min(1, 25 / dKm + 0.1), k, (peakKm || 0) / b.radiusKm));
    }
    if (rayed.length > 4) throw new Error('uranus moons: at most 4 rayed craters');
    const caA = [], caB = [], caD = [];
    for (let i = 0; i < NCA; i++) {
      const c = def.canyons[i];
      if (!c) {
        caA.push(new THREE.Vector4(0, 1, 0, 0));
        caB.push(new THREE.Vector4(1, 0, 0, 0));
        caD.push(0);
        continue;
      }
      const [la, lo, az, lenKm, wKm, dKm] = c;
      const cdir = dirLL(la, lo);
      const [e, n] = eastNorth(cdir);
      const t = n.clone().multiplyScalar(Math.cos(az * D2R)).addScaledVector(e, Math.sin(az * D2R)).normalize();
      caA.push(new THREE.Vector4(cdir.x, cdir.y, cdir.z, lenKm / 2 / b.radiusKm));
      caB.push(new THREE.Vector4(t.x, t.y, t.z, wKm / 2 / b.radiusKm));
      caD.push(dKm / b.radiusKm);
    }
    const netA = [], netB = [], netG = [];
    for (let j = 0; j < NNET; j++) {
      const nd = def.nets[j];
      if (!nd) {
        netA.push(new THREE.Vector4(0, 1, 0, 0));
        netB.push(new THREE.Vector4(1, 0, 0, 0));
        netG.push(new THREE.Vector2());
        continue;
      }
      const [la, lo, sc, k, cover, prob, wKm, dKm, groove] = nd;
      const a = dirLL(la, lo);
      netA.push(new THREE.Vector4(a.x, a.y, a.z, sc));
      netB.push(new THREE.Vector4(k, cover, wKm / 2 / b.radiusKm, dKm / b.radiusKm));
      netG.push(new THREE.Vector2(groove, prob));
    }
    if (def.nets.length > 1) throw new Error('uranus moons: the shader evaluates fault network 0 only');
    // Miranda's coronae and scarps (all moons carry the arrays: one program for the five moons)
    const coA = [], coX = [], coY = [], coP = [];
    for (const [la, lo, ang, hx, hy, m, bw, lamKm, ac, kind] of def.coronae || []) {
      const c = dirLL(la, lo);
      const [e, n] = eastNorth(c);
      const ca = Math.cos(ang * D2R), sa = Math.sin(ang * D2R);
      const ax = e.clone().multiplyScalar(ca).addScaledVector(n, sa);
      const ay = n.clone().multiplyScalar(ca).addScaledVector(e, -sa);
      coA.push(new THREE.Vector4(c.x, c.y, c.z, m));
      coX.push(new THREE.Vector4(ax.x, ax.y, ax.z, bw));
      coY.push(new THREE.Vector4(ay.x, ay.y, ay.z, lamKm / b.radiusKm));
      coP.push(new THREE.Vector4(hx, hy, ac, kind));
    }
    const nCor = coA.length;
    while (coA.length < NCOR) {
      coA.push(new THREE.Vector4(0, 1, 0, 2));
      coX.push(new THREE.Vector4(1, 0, 0, 0));
      coY.push(new THREE.Vector4(0, 0, 1, 1));
      coP.push(new THREE.Vector4(1, 1, 0, 0));
    }
    const scA = [], scB = [];
    for (const [la, lo, az, lenKm, hKm] of def.scarps || []) {
      const c = dirLL(la, lo);
      const [e, n] = eastNorth(c);
      const t = n.clone().multiplyScalar(Math.cos(az * D2R)).addScaledVector(e, Math.sin(az * D2R)).normalize();
      scA.push(new THREE.Vector4(c.x, c.y, c.z, lenKm / 2 / b.radiusKm));
      scB.push(new THREE.Vector4(t.x, t.y, t.z, hKm / b.radiusKm));
    }
    const nSc = scA.length;
    while (scA.length < 2) {
      scA.push(new THREE.Vector4(0, 1, 0, 0));
      scB.push(new THREE.Vector4(1, 0, 0, 0));
    }
    const taps = buildMoonTaps(def, rayed, lean);
    const nTap = taps.length;
    while (taps.length < NTAP) taps.push({ base: 0, sc: [0, 0, 0], off: [0, 0, 0], w: 0, dest: 0 });
    const uniforms = {
      ...S,
      ...COR_TABLES,
      uSunColor: U.uSunColor,
      uCenterW: { value: new THREE.Vector3() },
      uRad: { value: R },
      uRadKm: { value: b.radiusKm },
      uBasis: { value: new THREE.Matrix3() },
      uW: { value: new THREE.Vector3(...def.alb.map(solveW)) },
      uAlbN: { value: new THREE.Vector3(...def.alb) },
      uHapke: { value: new THREE.Vector4(HAPKE.B0, HAPKE.h, HAPKE.b, SYSTEM_GAIN) },
      uShineCol: { value: new THREE.Vector3(0.24, 0.45, 0.5) },
      uField: { value: new THREE.Vector4(...def.field) },
      uField2: { value: new THREE.Vector4(...def.field2) },
      uRelief: { value: new THREE.Vector4(def.relief[0], def.relief[1], def.relief[2], ctx.quality === 'low' ? Math.min(def.relief[3], 6) : def.relief[3]) },
      uOctaves: { value: ctx.quality === 'low' ? Math.min(def.octaves, 5) : def.octaves },
      uSeed: { value: def.seed },
      uDarkFloors: { value: def.darkFloors || 0 },
      uCrA: { value: crA },
      uCrB: { value: crB },
      uCaA: { value: caA },
      uCaB: { value: caB },
      uCaD: { value: caD },
      uNetA: { value: netA },
      uNetB: { value: netB },
      uNetG: { value: netG },
      uTapA: { value: taps.map((t) => new THREE.Vector4(t.sc[0], t.sc[1], t.sc[2], t.base + 4 * t.dest)) },
      uTapB: { value: taps.map((t) => new THREE.Vector4(t.off[0], t.off[1], t.off[2], t.w)) },
      uNTap: { value: nTap },
      uCoA: { value: coA },
      uCoX: { value: coX },
      uCoY: { value: coY },
      uCoP: { value: coP },
      uNCor: { value: nCor },
      uScA: { value: scA },
      uScB: { value: scB },
      uNSc: { value: nSc },
      uNCr: { value: def.craters.length },
      uNCa: { value: def.canyons.length },
      uNNet: { value: def.nets.length },
      uNRel: { value: ctx.quality === 'low' ? Math.min(def.relief[3], 6) : def.relief[3] },
      uN8: { value: 8 },
      uN27: { value: 27 },
      uN10: { value: 10 },
    };
    const mat = new THREE.ShaderMaterial({ uniforms, defines, vertexShader: VERT, fragmentShader: FRAG });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'uranus-' + id;
    mesh.scale.setScalar(R);
    list.push({ id, name: b.name, radius: R, orbit, mesh, mat });
  });
  return list;
}
