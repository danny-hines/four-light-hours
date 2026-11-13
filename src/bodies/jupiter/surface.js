// Jupiter cloud deck.
//   large scale : the Cassini PIA07782 map (Dec 2000), colour-corrected toward the true-colour portrait (its zones are
//                 too blue), GRS remapped to its present size, advected by the real zonal jets on a long bounded clock
//   close range : MEAN-PRESERVING VARIANCE INJECTION. A tileable tracer from a real 2-D Navier-Stokes run
//                 (assets-src/scripts/jupiter_turbulence.py) is laid on the sphere in a seamless stretched-Mercator frame
//                 (polar-stereographic over the caps), advected by the jets, wound into spirals by the GRS / Oval BA /
//                 circumpolar cyclones and evolved by its own velocity field. The map's full-resolution colour sets each
//                 pixel's mean; local belt/zone end-members come from the low-passed map at lat +-1.6/3.2 deg; the tracer,
//                 through a contrast curve whose bias is solved analytically, places the pixel between them, so the
//                 large-scale look is exactly the map while every finer scale gets crisp filaments with full chroma.
//   relief      : cloud-top height from the tracer (bright ammonia tops high, dark gaps deep) + convective pop-up storms;
//                 normals, horizon self-shadowing and analytic storm cast shadows at a grazing sun
// Every layer is footprint-filtered (mip-mapped tile + analytic AA of the contrast curve) so nothing aliases.
// Outputs linear HDR radiance; haze.js adds the gas/haze scattering, extinction and limb glow on top.
import * as THREE from 'three';
import { JUP_COMMON } from './glsl.js';
import { HAZE_PARAMS } from './haze.js';
import { TILE_N, LAT_N } from './flow.js';

export const JUP_CLOUDS = /* glsl */ `
uniform sampler2D uMap;
uniform sampler2D uLatF;
uniform sampler2D uT1;     // isotropic Navier-Stokes tracer tile: r = tracer, gb = its gradient (bake.js), a = 2nd tracer
uniform sampler2D uTz;     // zonal beta-plane turbulence tracer tile (jupiter_turb_beta.py): r = tracer, gb = gradient
uniform sampler2D uTuv;    // the isotropic tile's velocity field (rg)
uniform sampler2D uHi;     // baked local light end-member (rgb), a = the map's structure index (jupiter_structure.py)
uniform sampler2D uLo;     // baked local dark end-member (rgb), a = outbreak intermittency field
uniform float uT1G;        // gradient scales of the packed tiles
uniform float uTzG;
uniform float uUVS;      // tile velocity scale (sim units)
uniform float uFlat;
uniform vec4 uClkL;      // long clock (jupiter.js): x = tau (days) of the dominant phase, y = GRS clock 1.2 tanh(tau/1.2), z = BA clock tanh(tau)
uniform vec4 uVcs;       // cos, sin of the vortex cores' rigid turn: GRS (xy), Oval BA (zw)
uniform vec4 uClkS;      // churn clock: tau0, tau1 (days), w0, w1
uniform vec4 uSeedS;     // churn seeds: phase 0 (xy), phase 1 (zw), tile units
uniform float uDt;
uniform float uLonOff;
uniform float uQual;
uniform float uDebug;    // jdebug=<n> URL switch (development views of internal fields)
// Always 0. Loop bounds are written "n + uI0" so they are NOT compile-time constants: ANGLE/FXC then emits real loops
// instead of fully unrolling (and inlining) every iteration, which is what made this program take seconds to compile.
uniform int uI0;
uniform vec4 uGrs;       // lon, latc, semi-axis lon, semi-axis lat (rad): the GRS as drawn (present-day size)
uniform vec4 uGrsMap;    // the same for the GRS as it appears in the Cassini map
uniform vec4 uBa;        // Oval BA
uniform sampler2D uPolT; // the polar caps' baked tracer with the circumpolar cyclones (bake.js polarTracer)
uniform float uPolG;     // its gradient scale (per km)
const float POLAR_EXT = 2.9;

const float R_KM = 71492.0;
const float TEXEL = 0.003068;   // map texel in radii (2 pi / 2048)
const float NA = ${TILE_N.toFixed(1)};
const float NLAT = ${LAT_N.toFixed(1)};
// tile sim-time units per day. A forcing-scale eddy of the tile turns over in ~0.5 sim units; the backtrace runs
// through a FROZEN velocity field, so it must stay well under one turnover (strain << 1) or it over-filaments the
// tracer: ~10% of a turnover per half-day for octave A, a little more for the short-lived octave B
const float KA = 0.12;
const float KB = 0.35;
const vec3 LUMW = vec3(0.2126, 0.7152, 0.0722);
const float ZY = 0.6;     // N-S scale of the zonal tile relative to the stretched-Mercator frame (it is already streaky)
const float ZAMP = 1.15;  // zonal tile amplitude relative to the isotropic tile (matched variance)
// Close range (the low skim): the tracer -> colour curve is softened so the tile's own continuous tones and filaments
// show (a hard curve posterises a magnified tile into two-tone "marbled paper"), and the combed zonal streaks give way
// to convective eddies. Shared by the deck (surface.js) and the detail shell (detail.js): they must agree.
float closeGain(float fpk) { return mix(1.0, 0.6, smoothstep(60.0, 14.0, fpk)); }
float closeLam(float fpk) { return 1.0 - 0.7 * smoothstep(60.0, 15.0, fpk); }

float wrapPi(float a) { return a - TAU * floor((a + PI) / TAU); }
vec3 sphOf(vec2 ll) { float c = cos(ll.y); return vec3(c * cos(ll.x), sin(ll.y), -c * sin(ll.x)); }
vec2 llOf(vec3 p) { return vec2(atan(-p.z, p.x), asin(clamp(p.y / length(p), -1.0, 1.0))); }

// the three latitude-table rows at one latitude (one index computation, manual lerp of the float table)
void latRows(float latc, out vec4 p0, out vec4 p1, out vec4 p2) {
  float x = clamp((latc / PI + 0.5) * NLAT - 0.5, 0.0, NLAT - 1.001);
  float i = floor(x), f = x - i;
  ivec2 c = ivec2(int(i), 0);
  p0 = mix(texelFetch(uLatF, c, 0), texelFetch(uLatF, c + ivec2(1, 0), 0), f);
  p1 = mix(texelFetch(uLatF, c + ivec2(0, 1), 0), texelFetch(uLatF, c + ivec2(1, 1), 0), f);
  p2 = mix(texelFetch(uLatF, c + ivec2(0, 2), 0), texelFetch(uLatF, c + ivec2(1, 2), 0), f);
}

vec2 advectZonal(vec2 ll, float tau, float u) {
  // distance from the spin axis of the oblate surface (reduced latitude), without an atan
  float ck = cos(ll.y) * (1.0 - uFlat);
  float rAxis = max(ck * inversesqrt(sin(ll.y) * sin(ll.y) + ck * ck), 0.03) * R_KM;
  float pf = 1.0 - smoothstep(1.13, 1.25, abs(ll.y));     // no zonal shear over the caps (no record grooves)
  return vec2(ll.x - u * 86.4 / rAxis * tau * pf, ll.y);
}

vec2 grsRemap(vec2 ll) {
  vec2 q = vec2(wrapPi(ll.x - uGrs.x), ll.y - uGrs.y) / uGrs.zw;
  float t = smoothstep(1.05, 2.3, length(q));
  return mix(uGrsMap.xy, uGrs.xy, t) + q * mix(uGrsMap.zw, uGrs.zw, t);
}

// differential rotation about an elliptical vortex: returns the rotated lon/lat for an angle field ang(r)
vec2 vortexRot(vec2 ll, vec4 V, float ang) {
  vec2 q = vec2(wrapPi(ll.x - V.x), ll.y - V.y) / V.zw;
  float ca = cos(ang), sa = sin(ang);
  q = vec2(ca * q.x - sa * q.y, sa * q.x + ca * q.y);
  return V.xy + q * V.zw;
}
float vortexR(vec2 ll, vec4 V) { return length(vec2(wrapPi(ll.x - V.x), ll.y - V.y) / V.zw); }


vec2 mapUV(vec2 ll) { return vec2(ll.x / TAU + 0.5, 0.5 + ll.y / PI); }
vec3 sampleMap(vec2 ll, vec2 dx, vec2 dy, float mag) {
  vec2 uv = mapUV(ll);
  vec3 c = textureGrad(uMap, uv, dx, dy).rgb;
  vec3 coarse = textureGrad(uMap, uv, dx * 3.0 + 0.0012, dy * 3.0 + 0.0012).rgb;
  return max(c + (c - coarse) * (0.3 + 0.4 * mag), 0.0);
}

// ---- turbulence tile
vec2 tileVel(vec2 uv) {
  vec2 w = textureLod(uTuv, uv, 0.0).rg;
  // image rows run down (+y_sim), the texture's t runs up
  return vec2(w.x * 2.0 - 1.0, 1.0 - w.y * 2.0) * (uUVS / TAU);
}
vec2 backtrace(vec2 uv, float t, int n) {
  float h = t / float(n);
  for (int i = 0; i < n + uI0; i++) uv -= tileVel(uv) * h;
  return uv;
}
// value + gradient (per tile unit) of a packed tracer tile at the footprint gx, gy: ONE fetch (bake.js)
vec3 tileVG(sampler2D T, float gs, vec2 uv, vec2 gx, vec2 gy) {
  vec3 t = textureGrad(T, uv, gx, gy).rgb;
  return vec3(t.r * 2.0 - 1.0, (t.gb - 0.5) * (2.0 * gs));
}
float tileV(sampler2D T, vec2 uv, vec2 gx, vec2 gy) { return textureGrad(T, uv, gx, gy).r * 2.0 - 1.0; }

// polar-stereographic tile coordinates (octave A units). Scale matched to the Mercator tile at ~62 deg.
const float POLAR_K = 0.8;
vec2 polarUV(vec2 ll) {
  float co = PI * 0.5 - abs(ll.y);
  float rho = 2.0 * tan(0.5 * co);
  float sg = ll.y >= 0.0 ? 1.0 : -1.0;
  return vec2(cos(ll.x), sg * sin(ll.x)) * rho * (NA / TAU) / POLAR_K + vec2(sg * 17.31, 5.77);
}

struct Deck {
  vec3 cFull;   // map colour (mean)
  vec3 cDk;     // local dark end-member
  vec3 cLt;     // local light end-member
  vec3 tA;      // octave A tracer (value, d/dx_km, d/dy_km)
  float tA2;    // octave A second tracer
  vec2 uvA;     // Mercator tile coordinates actually sampled
  float kx;     // Mercator tile units per km (east)
  float ky;     // Mercator tile units per km (north)
  float grsIn;
  float grsR;
  float baIn;
  float cycIn;
  float cycArm; // spiral-arm tracer of the circumpolar cyclones (signed)
  float polar;
  float wake;
  float inter;  // intermittency (outbreaks vs calm), carried by the flow
  float sIdx;   // structure index from the real map (0 smooth .. 1 chaotic)
  vec2 llAdv;   // zonally advected map-frame lon/lat (billows ride the flow)
  float chaos;  // flow regime: 0 laminar (zones, jet flanks) .. 1 chaotic (turbulent belts, outbreaks, the GRS wake)
  float lam;    // weight of the zonal beta-plane tile (laminar streaks, meandering jets) vs the isotropic tile
  float grsW;   // weight of the GRS's own streamline model
  vec2 vq;      // offset / semi-axes from the nearer vortex (GRS or Oval BA)
  float vTau;   // its bounded vortex clock
  float vBA;    // 1 = the nearer vortex is Oval BA
  float vW;     // weight of its streamline model
  vec2 vf;      // its streamline frame (turned angle, lobed radius) and d(frame)/dq (vortexFrame)
  mat2 vM;
};

// ---- coherent vortices: the Great Red Spot and Oval BA ----------------------------------------------------------
// Closed elliptical streamlines (q = offset / semi-axes, r = |q| labels the streamline). The cloud tracer is (nearly)
// constant along a steady streamline, so the interior is drawn in the STREAMLINE FRAME: x = streamline angle (turned
// by the differential rotation), y = streamline radius + one tile period per turn, so the lanes are not rings but a
// slow inward spiral (pitch ~4-8 deg, seamless because the shift per turn is an integer number of periods). The
// differential rotation only slides each lane along itself, so there are no winding grooves at any clock phase. The
// edge is lobed (+-8 %, 2/3/5 lobes riding the collar flow). Octaves B and C are drawn in the same frame (main), so the
// fine structure is filaments that wrap the vortex instead of the isotropic background "sponge".
// Angular velocity (rad/day, CCW = anticyclonic in the south): slow centre, ~150 m/s collar jet at r ~ 0.85-0.9
// (rotation period ~4.5 d there), falling to the quiescent exterior by r ~ 1.3.
float grsOmega(float r) { return (0.55 + 0.85 * smoothstep(0.2, 0.85, r)) * (1.0 - smoothstep(0.92, 1.3, r)); }
// (omega, d omega / dr), analytic
vec2 grsOmegaD(float r) {
  float a = clamp((r - 0.2) / 0.65, 0.0, 1.0), b = clamp((r - 0.92) / 0.38, 0.0, 1.0);
  float A = 0.55 + 0.85 * a * a * (3.0 - 2.0 * a), B = 1.0 - b * b * (3.0 - 2.0 * b);
  return vec2(A * B, 0.85 * 6.0 * a * (1.0 - a) / 0.65 * B - A * 6.0 * b * (1.0 - b) / 0.38);
}
const float GRS_NRING = 5.0;     // zonal-tile periods around a streamline (octave A of the vortex)
const float GRS_KRAD = 2.2;      // zonal-tile periods across r = 0..1
const float GRS_SPIRAL = 2.0;    // radial tile periods gained per turn (integer: seamless) -> inward spiral lanes
float vortexLobes(float thr, float sd) {
  return 0.05 * sin(2.0 * thr + 0.7 + sd) + 0.035 * sin(3.0 * thr + 2.1 + 1.7 * sd);
}
// returns (thr, rP): turned streamline angle and lobed streamline radius; M = d(thr, rP)/dq
vec2 vortexFrame(vec2 q, float tauV, float sd, out mat2 M) {
  float r = max(length(q), 1e-4);
  float th = atan(q.y, q.x);
  vec2 om = grsOmegaD(r);
  float thr = th - om.x * tauV;
  float lob = vortexLobes(thr, sd);
  vec2 er = q / r, et = vec2(-er.y, er.x);
  vec2 dthr = et / max(r, 0.05) - om.y * tauV * er;
  vec2 drP = er / (1.0 + lob);
  M = mat2(dthr.x, drP.x, dthr.y, drP.y);
  return vec2(thr, r / (1.0 + lob));
}
// tile coordinates per unit (thr, rP) of the vortex octave-A tile (octave B / C: x8 / x64)
mat2 vortexK(float s) { return mat2(s * GRS_NRING / TAU, s * GRS_SPIRAL / TAU, 0.0, s * GRS_KRAD); }
vec2 minLen(vec2 g, float m) { return g * max(1.0, m / max(length(g), 1e-7)); }
// value + d/dq of the vortex's octave-A tracer; dqx, dqy = screen derivatives of q
vec3 grsTexture(vec2 q, vec2 f, mat2 M, vec2 dqx, vec2 dqy, vec2 cs, float sd) {
  float r = length(q);
  mat2 J = vortexK(1.0) * M;
  vec2 uv = vortexK(1.0) * f + vec2(0.37, 0.61) + sd * vec2(0.29, 0.43);
  // octave A of the vortex never draws finer than ~1/80 of the semi-axis (octave B adds the rest)
  vec3 z = tileVG(uTz, uTzG, uv, J * dqx, J * dqy);
  vec2 gq = transpose(J) * z.yz;
  return vec3(z.x, gq);
}
// GRS colour: the Cassini map's OWN GRS patch (grsRemap to today's size, turning with the vortex) graded toward the
// present-day spot (2015-2025 Juno / Hubble OPAL: smaller, deeper orange-red, darker core offset ESE, two inward spiral
// arms of deeper red), a faint, patchy rim lane broken by the tracer, and a faintly darker Red Spot Hollow outside the
// bright collar. No drawn outlines: every boundary is the map's own or is perturbed by the lobes and the tracer.
vec3 grsColour(vec3 cm, vec2 q, vec2 f, float tr, out float wIn) {
  float thr = f.x, rP = f.y;
  float r = length(q);
  // soft, irregular outline: the streamline tracer pushes the edge in and out (ragged flakes peeling into the collar),
  // never a drawn ellipse
  float rE = rP * (1.0 + 0.085 * tr) + 0.03 * sin(3.0 * thr + 1.3);
  wIn = 1.0 - smoothstep(0.58, 1.06, rE);
  // loose two-arm inward spiral (a tight log spiral reads as onion rings at disc scale), broken by the tracer
  float arm = 0.5 + 0.5 * cos(2.0 * thr + 2.6 * log(r + 0.12) + 1.6 * tr);
  arm *= smoothstep(0.12, 0.45, r);
  float core = 1.0 - smoothstep(0.05, 0.62, length((q - vec2(0.13, -0.07)) * vec2(1.0, 1.25)));
  vec3 tint = mix(vec3(1.0), vec3(1.25, 0.87, 0.66), wIn * (0.86 + 0.14 * tr));
  tint *= mix(vec3(1.0), vec3(1.08, 0.88, 0.76), wIn * clamp(0.4 * arm + 0.7 * core, 0.0, 1.0));
  float L = dot(cm, LUMW);
  float Lt = L * mix(1.0, 0.9 - 0.06 * arm - 0.10 * core, wIn);
  // outer annulus: a faintly darker brick lane, patchy (present only where the tracer says so)
  float ann = smoothstep(0.55, 0.85, rE) * (1.0 - smoothstep(0.9, 1.08, rE));
  Lt *= 1.0 - 0.08 * ann * smoothstep(-0.5, 0.7, tr);
  // the Red Spot Hollow: the pale collar is not a uniform white ring. Brown SEB material wraps the north side (the
  // "eyelid"), wisps of it are dragged around the spot, and the collar is brightest to the south and east
  float col1 = smoothstep(0.98, 1.12, rE) * (1.0 - smoothstep(1.3, 1.75, rP));
  float north = smoothstep(-0.25, 0.75, q.y / max(r, 1e-3));
  Lt *= 1.0 - col1 * (0.07 + 0.12 * north) * smoothstep(-0.2, 0.9, tr + 0.5 * sin(2.0 * thr + 0.4));
  vec3 c = cm * tint;
  c = mix(c, c * vec3(1.06, 0.97, 0.88), col1 * north * 0.6);
  return c * (Lt / max(dot(c, LUMW), 1e-4));
}
// Oval BA today: a pale cream-tan oval with a faint orange-tan inner ring (faded since its 2006 reddening), no dark
// outline: anything darker than the surroundings inside r < 1.3 is lifted toward them.
vec3 baColour(vec3 cm, float Lsur, vec2 f, out float wIn) {
  float rP = f.y;
  wIn = 1.0 - smoothstep(0.72, 1.05, rP);
  float L = dot(cm, LUMW);
  float Lt = mix(L, max(L, Lsur * 1.0), 1.0 - smoothstep(1.0, 1.35, rP));
  float ring = smoothstep(0.3, 0.55, rP) * (1.0 - smoothstep(0.6, 0.85, rP));
  vec3 cb = mix(vec3(1.0, 0.96, 0.88), vec3(1.0, 0.86, 0.71), 0.55 * ring);
  Lt = mix(Lt, max(Lt, Lsur * 1.1), wIn);
  vec3 c = mix(cm, cb * Lt, 0.8 * wIn);
  return c * (Lt / max(dot(c, LUMW), 1e-4));
}

// ---------------------------------------------------------------------------------------------------------------
// one phase of the long clock: map colour, palette, octave-A tracer
//   preLon : steady-state pre-shear of the tracer (lon offset, rad), see flow.js shearAge
//   shK    : the pre-shear strain d(x_east_km)/d(north_km) (for the tracer gradient -> relief normals)
//   dllx/y : screen derivatives of the (unwarped) lon/lat, for the vortex streamline-frame footprints
Deck deckPhase(vec2 ll0, float tau, vec4 p0, vec4 p1, float fp, vec2 dx, vec2 dy, float mag, float D, vec2 gA0x, vec2 gA0y,
               float preLon, float shK, vec2 dllx, vec2 dlly) {
  Deck S;
  // coherent vortices are not sheared by the jets that flank them (they drift as a whole, ~0 in System III):
  // suppress zonal advection around the GRS and Oval BA so the flow wraps around them instead
  float rg = vortexR(ll0, uGrs), rb = vortexR(ll0, uBa);
  float vm = max(1.0 - smoothstep(1.05, 2.1, rg), 1.0 - smoothstep(1.05, 1.9, rb));
  float u = p0.r * (1.0 - vm);
  vec2 ll = advectZonal(ll0, tau, u);
  S.polar = smoothstep(1.03, 1.13, abs(ll0.y));

  // ---- vortices: differential rotation on a BOUNDED clock (winding <= ~2 rad in every clock phase)
  float tauG = uClkL.y;   // 1.2 tanh(tau / 1.2) (jupiter.js)
  S.grsR = rg;
  float mg = 1.0 - smoothstep(1.3, 1.75, rg);
  float angM = grsOmega(rg) * tauG * mg;
  vec2 llMap = vortexRot(ll, uGrs, -angM);
  vec2 llTr = llMap;
  S.grsIn = 1.0 - smoothstep(0.8, 1.08, rg);
  float mb = 1.0 - smoothstep(1.2, 1.7, rb);
  float tauB = uClkL.z;   // tanh(tau)
  float angB = 2.0 * tauB * mb * (1.0 - smoothstep(0.9, 1.4, rb));
  float twB = 2.2 * smoothstep(0.15, 0.7, rb) * (1.0 - smoothstep(0.9, 1.45, rb)) * mb;
  llMap = vortexRot(llMap, uBa, -angB);
  llTr = vortexRot(llTr, uBa, -(angB + twB));
  S.baIn = 1.0 - smoothstep(0.75, 1.05, rb);
  // steady-state shear of the small-scale structure (texture coordinates only; the map is not displaced)
  llTr.x += preLon;

  // intermittency field, advected with the zonal flow (two simplex octaves, one call site)
  S.llAdv = ll;
  S.inter = textureLod(uLo, mapUV(ll), 0.0).a;
  // turbulent wake of the GRS (SEB, west of the spot)
  float dw = wrapPi(ll0.x - uGrs.x);
  S.wake = smoothstep(-0.42, -0.31, ll0.y) * (1.0 - smoothstep(-0.27, -0.2, ll0.y)) * smoothstep(-0.07, -0.17, dw) * (1.0 - smoothstep(-0.6, -1.2, dw));

  // ---- colour field
  vec2 llR = grsRemap(llMap);
  S.cFull = sampleMap(llR, dx, dy, mag);
  vec4 hT = textureLod(uHi, mapUV(llR), 0.0), lT = textureLod(uLo, mapUV(llR), 0.0);
  S.sIdx = hT.a;
  // end-members: the soft max / min of the ~1,750 km low-passed map over +-1.15 and +-2.3 deg of latitude, widened by
  // 15 % (bake.js: position-only, so baked once instead of 5 map lookups per pixel)
  vec3 hi = hT.rgb, lo = lT.rgb;
  // the low-passed extremes underestimate the true local extremes: widen, and keep a minimum local contrast
  float Lm = dot(S.cFull, LUMW);
  float ezM0 = 1.0 - smoothstep(0.07, 0.13, abs(ll0.y));
  float minC = (0.12 + 0.22 * p0.g * (1.0 - 0.5 * p0.b) + 0.3 * ezM0) * Lm;
  float cc = dot(hi - lo, LUMW);
  if (cc < minC) { float e = 0.5 * (minC - cc) / max(Lm, 1e-3); hi *= 1.0 + e; lo *= 1.0 - e; }

  // ---- flow regime. Chaotic where the real map is turbulent (structure map), in the GRS wake and in outbreaks;
  //      laminar in the zones and on the jet flanks. Laminar regions draw the zonal beta-plane tile.
  S.grsW = 1.0 - smoothstep(1.04, 1.3, rg);
  S.chaos = max(smoothstep(0.1, 0.6, S.sIdx) * mix(0.75, 1.0, smoothstep(-0.3, 0.6, S.inter)), S.wake) * (1.0 - S.grsW);
  S.lam = (1.0 - smoothstep(0.2, 0.7, S.chaos)) * (1.0 - S.polar);

  // ---- the vortices (the GRS and Oval BA never overlap): ONE streamline-model evaluation, for the nearer one
  bool inBA = rb < rg;
  vec4 VV = inBA ? uBa : uGrs;
  float rv = inBA ? rb : rg;
  float tauV = inBA ? 1.4 * tauB : tauG;
  float sdV = inBA ? 1.0 : 0.0;
  vec2 qv = vec2(wrapPi(ll.x - VV.x), ll.y - VV.y) / VV.zw;
  float wV = 1.0 - smoothstep(inBA ? 1.0 : 1.04, 1.3, rv);
  S.vq = qv;
  S.vTau = tauV;
  S.vBA = inBA ? 1.0 : 0.0;
  S.vW = wV;
  S.vf = vec2(0.0);
  S.vM = mat2(1.0);
  vec3 gT = vec3(0.0);
  if (rv < 2.0) {
    vec2 dqx = dllx / VV.zw, dqy = dlly / VV.zw;
    mat2 M;
    vec2 f = vortexFrame(qv, tauV, sdV, M);
    S.vf = f;
    S.vM = M;
    if (wV > 0.0) gT = grsTexture(qv, f, M, dqx, dqy, inBA ? uVcs.zw : uVcs.xy, sdV);
    float trn = clamp(gT.x / 0.385, -2.0, 2.0);
    float wIn;
    if (inBA) {
      vec3 cb = baColour(S.cFull, 0.5 * (dot(hi, LUMW) + dot(lo, LUMW)), f, wIn);
      S.cFull = cb;
      lo = mix(lo, cb * 0.88, wIn);
      hi = mix(hi, cb * 1.1, wIn);
    } else {
      vec3 cg = grsColour(S.cFull, qv, f, trn, wIn);
      S.cFull = cg;
      // inside: deeper red-brown filaments and paler salmon-cream cloud (Juno PJ7)
      vec3 gLo = cg * vec3(0.70, 0.54, 0.46), gHi = mix(cg * 1.28, vec3(dot(cg, LUMW) * 1.4), 0.35);
      lo = mix(lo, gLo, wIn);
      hi = mix(hi, gHi, wIn);
    }
  }
  // polar caps: soft blue-grey haze (reference), darker, low saturation
  if (S.polar > 0.0) {
    float Lp = dot(S.cFull, LUMW);
    vec3 bg = vec3(0.90, 0.98, 1.12) * Lp * 1.12;
    S.cFull = mix(S.cFull, bg, 0.8 * S.polar);
    lo = mix(lo, vec3(0.78, 0.82, 0.90) * Lp * 0.6, S.polar);
    hi = mix(hi, vec3(1.04, 1.03, 1.02) * Lp * 1.5, S.polar);
  }
  S.cDk = lo;
  S.cLt = hi;

  // ---- octave A tracer: stretched-Mercator (seamless: x period NA), polar-stereographic over the caps
  S.tA = vec3(0.0);
  S.tA2 = 0.0;
  S.cycIn = 0.0;
  S.cycArm = 0.0;
  // Mercator tile units per km: x = lon N / 2pi (true cos), y = Y(lat) whose slope is capped at cos(1.45) (flow.js)
  float cphi = max(cos(ll0.y), 1e-3);
  S.kx = NA / (TAU * R_KM * cphi);
  S.ky = NA * p1.g / (TAU * R_KM * max(cos(ll0.y), 0.1205));
  S.uvA = vec2(0.0);
  if (D > 0.0) {
    // Y(lat) linearised about the pixel's latitude (llTr.y differs from it only inside the vortices' rotation)
    vec2 uvM = vec2(llTr.x * (NA / TAU), p1.r + (llTr.y - ll0.y) * (NA / TAU) * p1.g / max(cos(ll0.y), 0.1205));
    // fine-scale contrast: calm regions keep the large swirls but soften the finest filaments (cloud albedo has a
    // steeper spectrum than a pure Batchelor tracer); outbreaks and the GRS wake keep full small-scale contrast
    float kap = mix(0.6, 1.0, S.chaos);
    float hpB = (0.5 + 0.2 * (1.0 - S.chaos)) * (1.0 - S.polar);
    vec2 gLx = normalize(gA0x + vec2(1e-9)) * max(length(gA0x), 0.037), gLy = normalize(gA0y + vec2(1e-9)) * max(length(gA0y), 0.037);
    vec2 uvb = backtrace(uvM, tau * KA, 3);
    vec4 t4 = textureGrad(uT1, uvb, gA0x, gA0y);
    vec3 v = vec3(t4.r * 2.0 - 1.0, (t4.gb - 0.5) * (2.0 * uT1G));
    v.x = mix(tileV(uT1, uvb, gA0x * 4.0, gA0y * 4.0), v.x, kap);
    v.x -= hpB * tileV(uT1, uvb, gLx, gLy);
    v.yz *= kap;
    // laminar regime: the zonal beta-plane tile (long streaks, meandering jets, chevron-like wave trains); at close range
    // the streaks give way to more of the isotropic eddies (the 100-km structure of the zones is convective, not combed)
    S.lam *= closeLam(fp * R_KM);
    if (S.lam > 0.0) {
      vec2 uz = vec2(uvM.x, uvM.y * ZY) + vec2(0.31, 0.17);
      vec3 z = tileVG(uTz, uTzG, uz, vec2(gA0x.x, gA0x.y * ZY), vec2(gA0y.x, gA0y.y * ZY));
      // octave A only adds what the map cannot resolve: remove the zonal tile's own banding (~700 km low-pass)
      z.x -= 0.75 * tileV(uTz, uz, vec2(gLx.x, gLx.y * ZY), vec2(gLy.x, gLy.y * ZY));
      z.z *= ZY;
      v = v * cos(S.lam * 1.5708) + z * (sin(S.lam * 1.5708) * ZAMP);
    }
    S.uvA = uvb;
    // per km (east, north); the pre-shear adds d(x_tile)/d(north km) = -strain * kx
    S.tA = vec3(v.x, v.y * S.kx, v.z * S.ky - v.y * S.kx * shK);
    S.tA2 = t4.a * 2.0 - 1.0;
    // the vortex interior: its streamline texture replaces the generic tracer
    if (wV > 0.0) {
      vec2 gk = gT.yz / vec2(VV.z * R_KM * cphi, VV.w * R_KM);     // d/dq -> per km
      // (70 %: the rest is the generic tracer turned with the vortex, so the lanes are broken by mottled eddies)
      S.tA = mix(S.tA, vec3(gT.x, gk) * (inBA ? 0.385 : 0.385 * 1.3), 0.78 * wV * (1.0 - 0.4 * smoothstep(0.9, 1.2, length(qv))));
    }
  }
  return S;
}
// ---- convective cloud tops at close range ----------------------------------------------------------------------
// A dense field of overlapping cumuliform domes (smooth bell caps on a jittered grid, merged with a smooth union so
// clusters read as lumpy cauliflower masses rather than separate beads), three octaves (~160, 52 and 17 km cells):
// finer turrets bulge out of the coarser masses. Every cell boils through a life cycle of a few hours (fast growth,
// slower spreading decay) and is re-seeded each cycle, while the grid rides the flow. Domes have irregular outlines
// (per-cell ellipticity and lobes). Neighbouring domes cast analytic soft shadows at a low sun. Everything fades in by
// footprint, so a dome appears only once it spans several pixels. 3 octaves x 9 cells run as ONE real loop.
//   q   : octave-0 cell coordinates (x periodic with period px0 cells); kc : cell units per km (east, north)
//   cover : dome probability (0..1); sdir : unit sun direction in the tangent plane (east, north); tanE : sun elevation
// returns x = height (km), yz = gradient (km/km, east/north), w = crest mask (0 deck/gaps .. 1 crest)
const float CU_NC0 = 120.0;   // octave-0 cells per octave-A tile unit (18,716 km / 120 = 156 km at the equator)
const float CU_CY = 0.55;     // N-S compression of the stretched-Mercator frame (cells ~round in km)
vec4 cumulus(vec2 q, float px0, vec2 kc, float fpk, float cover, float occS, float tday, vec2 sdir, float tanE, inout float shad) {
  float H = 0.0, topM = 0.0;
  vec2 G = vec2(0.0);
  float px = px0, host = 1.0, ampO = 1.0;
  float shK = 0.45 * smoothstep(1.0, 0.3, tanE);
  for (int o = 0; o < 4 + uI0; o++) {
    float cellKm = 1.0 / kc.x;
    float vis = smoothstep(3.0, 8.0, 0.35 * cellKm / fpk) * (o == 0 ? smoothstep(26.0, 12.0, fpk) : 1.0);
    if (vis <= 0.0 && o > 0) break;
    float fo = float(o);
    float life = 0.8 * exp2(-fo);                            // days: storms 19 h; cumulus 10 h, 5 h, 2.4 h
    float pc = o == 0 ? occS : cover * mix(0.3, 1.0, host);
    vec2 ip = floor(q);
    // smooth union: H = log(1 + sum exp(k h_i)) / k  (the deck itself is the "1")
    float kU = 3.5 / (0.08 * cellKm);
    float sumE = 1.0, crest = 0.0;
    vec2 sumG = vec2(0.0);
    for (int j = 0; j < 9 + uI0; j++) {
      vec2 c = ip + vec2(float(j - 3 * (j / 3)) - 1.0, float(j / 3) - 1.0);
      vec2 cw = vec2(c.x - px * floor(c.x / px), c.y);
      vec3 h0 = hash33(vec3(cw, 11.0 + fo * 7.0));
      float tl = tday / life + h0.z;
      float cyc = floor(tl), ph = tl - cyc;
      vec3 h = fract(h0.zxy * vec3(17.31, 5.13, 11.7) + cyc * vec3(0.6180, 0.7549, 0.5698) + fo * 0.31);
      float ex = smoothstep(h.x - 0.15, h.x + 0.15, pc) * step(0.005, pc);
      if (ex <= 0.0) continue;
      vec2 cen = c + 0.15 + 0.7 * fract(h.yz * 7.31 + h0.xy);
      float env = sqrt(max(sin(3.14159 * ph), 0.0));          // life cycle: fast growth, spreading decay
      float rk = (0.38 + 0.36 * h.y) * (0.55 + 0.45 * env) * cellKm;
      vec2 d = (q - cen) / kc;                                // km (east, north) from the cell centre
      // irregular outline: random ellipticity + 3/5-lobed wobble (trig-free: Chebyshev polynomials of the direction)
      vec2 ea = normalize(fract(h0.yx * 13.7 + h.xz) - 0.5 + 1e-4);
      vec2 de = vec2(dot(d, ea) * (1.0 + 0.35 * h0.x), dot(d, vec2(-ea.y, ea.x)));
      vec2 u = de * inversesqrt(max(dot(de, de), 1e-12));
      float wob = 1.0 + 0.18 * (u.x * (4.0 * u.x * u.x - 3.0) * (h0.y - 0.5) + u.y * (3.0 - 4.0 * u.y * u.y) * (h0.z - 0.5))
                + 0.14 * (h.z - 0.5) * u.x * (16.0 * u.x * u.x * u.x * u.x - 20.0 * u.x * u.x + 5.0);
      float rw2 = rk * rk * wob * wob;
      float x2 = dot(de, de) / rw2;
      float hk = min((0.1 + 0.1 * h.z) * rk, 25.0) * env * ex;      // dome height (km): pop-up tops ~5-25 km
      if (x2 < 1.0) {
        float b = 1.0 - x2, sb = sqrt(b);
        float e = exp(min(kU * hk * b * sb, 30.0));            // bell cap (1 - x^2)^1.5, smooth union
        sumE += e;
        sumG -= e * 3.0 * hk * sb / rw2 * d;                   // (radial, ellipticity ignored in the slope)
        crest = max(crest, b * env);
      }
      // soft cast shadow: step toward the Sun by ~0.6 of the shadow length (height / tan(elevation), capped) and test
      // the dome's upper core there, so the shadow starts where the dome is actually tall
      float rs = 0.62 * rk;
      vec2 so = d + sdir * min(0.85 * hk / max(tanE, 1e-3), 5.0 * rs) * 0.6;
      shad = min(shad, 1.0 - shK * vis * step(0.3, x2) * smoothstep(1.0, 0.35, dot(so, so) / (rs * rs)));
    }
    float a = vis * ampO * (o <= 1 ? 1.0 : mix(0.5, 1.0, host));
    H += log(sumE) / kU * a;
    G += sumG / sumE * a;
    topM = max(topM, crest * vis * (o == 0 ? 0.45 : 0.3));
    if (o > 0) { host = smoothstep(0.05, 0.6, crest); ampO *= 0.7; }
    // next octave: 3x finer
    q *= 3.0;
    kc *= 3.0;
    px *= 3.0;
  }
  return vec4(H, G, topM);
}
`;

export function makeSurfaceMaterial({ uniforms }) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: /* glsl */ `
      uniform float uRadius;
      varying vec3 vObj;
      varying vec3 vPosJ;
      varying vec3 vPosW;
      void main() {
        vObj = position / uRadius;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosW = wp.xyz;
        vPosJ = mat3(modelMatrix) * position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${JUP_COMMON}
      ${HAZE_PARAMS}
      ${JUP_CLOUDS}
      uniform mat3 uRot;
      uniform vec3 uSunJ;
      uniform float uSunR;
      uniform vec3 uSunColor;
      uniform float uRadius;
      uniform float uTime;
      uniform float uGain;
      varying vec3 vObj;
      varying vec3 vPosJ;
      varying vec3 vPosW;

      void main() {
        vec3 uS = normalize(vObj);
        vec2 ll0 = llOf(uS);
        vec3 nLoc = normalize(vec3(uS.x, uS.y / (1.0 - uFlat), uS.z));
        ll0.y = atan((1.0 - uFlat) * uS.y, length(uS.xz));   // planetocentric latitude
        ll0.x = wrapPi(ll0.x + uLonOff);                        // into the map's longitude frame

        // every screen derivative is taken here, outside the loops (FXC cannot keep a gradient op in a real loop)
        vec2 uv0 = mapUV(ll0);
        vec2 dx = dFdx(uv0), dy = dFdy(uv0);
        dx.x -= floor(dx.x + 0.5); dy.x -= floor(dy.x + 0.5);
        vec2 dllx = vec2(dx.x * TAU, dx.y * PI), dlly = vec2(dy.x * TAU, dy.y * PI);
        float fp = max(length(dFdx(vPosJ)), length(dFdy(vPosJ))) / uRadius;
        fp = max(fp, 1e-7);
        float fpk = fp * R_KM;
        float mag = smoothstep(0.9, 1.8, TEXEL / fp);

        vec4 p0, p1, p2;
        latRows(ll0.y, p0, p1, p2);
        // steady-state pre-shear of the small-scale structure (flow.js shearAge): a function of latitude only. It is NOT
        // masked around the vortices: D changes by ~27,000 km across the GRS's latitude range, so any 2-D mask compresses
        // the tracer in longitude into streaks; the GRS and Oval BA draw their own streamline textures instead.
        float ckA = cos(ll0.y) * (1.0 - uFlat);
        float rAx = max(ckA * inversesqrt(sin(ll0.y) * sin(ll0.y) + ckA * ckA), 0.03) * R_KM;
        float preLon = -p2.r / rAx;
        float shK = p2.g;
        vec2 dPre = vec2(dFdx(preLon), dFdy(preLon)) * (NA / TAU);
        // octave-A tile footprint from the unwarped (but pre-sheared) mapping (periodic x correction)
        vec2 uvA0 = vec2((ll0.x + preLon) * (NA / TAU), p1.r);
        vec2 gA0x = dFdx(uvA0), gA0y = dFdy(uvA0);
        gA0x.x -= NA * floor(gA0x.x / NA + 0.5); gA0y.x -= NA * floor(gA0y.x / NA + 0.5);
        // detail fades in as the map's own resolution runs out (km per pixel)
        float D = smoothstep(190.0, 70.0, fpk);   // (the polar caps' baked tracer is drawn at every range)
        float DB = smoothstep(26.0, 9.0, fpk) * step(0.5, uQual);
        float DC = smoothstep(4.0, 1.6, fpk) * step(1.5, uQual);

        // ---- the long clock: ONE phase is evaluated (the dominant one; jupiter.js). Its hand-over happens only mid-way
        //      between the rests (days 1.76 + k 3.025), never inside the review (0-1.2) or film windows. A blended second
        //      phase would put this whole function inside a loop, which FXC compiles several times slower.
        // polar caps: the baked polar-stereographic tracer (screen derivatives here, at top level)
        float sgP = ll0.y >= 0.0 ? 1.0 : -1.0;
        vec2 pcP = vec2(cos(ll0.x), sgP * sin(ll0.x)) * (2.0 * tan(0.5 * (PI * 0.5 - abs(ll0.y))) * (NA / TAU) / POLAR_K);
        vec2 uvPol = vec2((clamp(pcP.x / POLAR_EXT, -0.995, 0.995) * 0.5 + 0.5) * 0.5 + 0.25 - 0.25 * sgP, pcP.y / POLAR_EXT * 0.5 + 0.5);
        vec2 gPx = dFdx(uvPol), gPy = dFdy(uvPol);

        Deck S = deckPhase(ll0, uClkL.x, p0, p1, fp, dx, dy, mag, D, gA0x, gA0y, preLon, shK, dllx, dlly);
        if (S.polar > 0.0) {
          vec4 pt = textureGrad(uPolT, uvPol, gPx, gPy);
          vec3 vP = vec3(pt.r * 2.0 - 1.0, (pt.gb - 0.5) * (2.0 * uPolG * 0.6));
          float wp = S.polar;
          S.tA = (S.tA * (1.0 - wp) + vP * wp) / sqrt(wp * wp + (1.0 - wp) * (1.0 - wp));
          S.tA2 *= 1.0 - wp;
          // cyclone interiors: lighter cream-grey cloud with dark lanes (JunoCam)
          S.cycIn = pt.a * wp;
          float Lc = dot(S.cFull, LUMW);
          S.cFull = mix(S.cFull, vec3(1.02, 1.0, 0.96) * Lc * 1.2, 0.6 * S.cycIn);
          S.cLt = mix(S.cLt, vec3(1.05, 1.02, 0.95) * Lc * 1.9, S.cycIn);
          S.cDk = mix(S.cDk, vec3(0.72, 0.74, 0.8) * Lc * 0.45, S.cycIn);
        }

        // (octaves B and C, the convective towers and their relief: detail.js, a second program on the same geometry)
        // ---- tracer -> colour (mean-preserving)
        float turbv = p0.g * (1.0 + 0.8 * S.wake);
        float zone = p0.b;
        // normalised tracer (unit variance where fully resolved)
        float t = S.tA.x * D / 0.385 * (1.0 - 0.45 * S.cycIn);
        float sig = D + 1e-3;
        // contrast gain: belts and the wake churn harder; analytic AA: never sharper than ~1 px
        // intermittency: turbulence comes in outbreaks and calm, streaky stretches (large-scale, slowly varying)
        // tracer amplitude follows where the real planet is turbulent (structure map), with a little intermittency
        // zones are smooth at the scale of the map (Cassini), belts and outbreaks are not; jet flanks carry streaks
        float amp = mix(0.2, 1.3, smoothstep(0.06, 0.6, S.sIdx)) * mix(0.8, 1.15, smoothstep(-0.45, 0.55, S.inter));
        amp = max(amp, 0.34 * smoothstep(0.15, 0.6, p1.a));    // shear-drawn streaks on the jet flanks
        amp = max(amp, 0.5 * smoothstep(30.0, 6.0, fpk));      // below the map's resolution every region has texture
        amp = mix(amp, 0.6, S.polar);                           // the polar turbulence (structure map is blind there)
        amp = max(amp, 0.95 * S.wake);
        // the Equatorial Zone carries plumes, festoon roots and wave trains (Juno), a little more than its smooth map
        float ezM = 1.0 - smoothstep(0.07, 0.13, abs(ll0.y));
        amp = max(amp, 0.42 * ezM);
        amp = mix(amp, 1.0, S.grsW);
        amp = mix(amp, 1.0, S.cycIn);
        t *= amp;
        sig *= amp;
        float g = (0.75 + 0.35 * turbv) * p0.a * mix(1.0, 0.7, zone * (1.0 - S.polar) * (1.0 - 0.6 * ezM)) * mix(1.0, 0.95, S.grsIn) * mix(1.0, 0.7, S.polar) * mix(1.0, 1.6, S.cycIn);
        g *= closeGain(fpk);
        float fw = fwidth(t);
        g = min(g, 0.9 / max(fw, 1e-4));
        // re-centre the end-members on the local mean: hue/chroma from the neighbourhood, luminance spread split
        // two-sided (m compressed into [0.25, 0.75]) so a uniform belt interior gets lighter AND darker shades of itself
        float Lf = dot(S.cFull, LUMW);
        float Ld0 = dot(S.cDk, LUMW), Lt0 = dot(S.cLt, LUMW);
        float mRaw = clamp((Lf - Ld0) / max(Lt0 - Ld0, 1e-4), 0.0, 1.0);
        float m = 0.5 + (mRaw - 0.5) * 0.5;
        float closeK = smoothstep(70.0, 12.0, fpk) * (1.0 - 0.25 * S.grsW) * (1.0 - S.polar);
        float Sp = max(Lt0 - Ld0, (0.05 + 0.38 * closeK + 0.17 * closeK * closeK) * Lf) * (1.0 + 0.6 * closeK);
        float Ld = max(Lf - m * Sp, 0.2 * Lf), Lt = Lf + (1.0 - m) * Sp;
        m = (Lf - Ld) / max(Lt - Ld, 1e-4);
        S.cDk = S.cDk * (Ld / max(Ld0, 1e-4));
        S.cLt = S.cLt * (Lt / max(Lt0, 1e-4));
        // the gaps show the deeper layers: blue-grey under the zones and the EZ, browner under the belts
        // the gaps show the deeper layers: in the zones and the EZ either blue-grey (thin cloud over the deep, clear gas)
        // or tan-ochre (chromophore-stained lower cloud), picked by the second tracer; browner under the belts
        vec3 gapC = mix(vec3(0.80, 0.86, 0.98), vec3(1.12, 0.94, 0.72), smoothstep(-0.3, 0.3, S.tA2));
        vec3 deep = mix(S.cDk, gapC * Ld, 0.6 * zone * closeK * (1.0 - S.grsW));
        S.cDk = deep * (Ld / max(dot(deep, LUMW), 1e-4));
        float kap = sqrt(1.0 + 1.571 * g * g * sig * sig);
        float b = kap * atanh(2.0 * m - 1.0) / g;
        float T = 0.5 + 0.5 * tanh(g * (t + b));
        vec3 col = S.cFull + (S.cLt - S.cDk) * (T - m);
        // a second, independent tracer shifts the hue a little (chromophore-rich vs fresher cloud)
        float t2 = S.tA2 * D;
        col *= 1.0 + 0.07 * t2 * vec3(0.8, 0.1, -0.9) * (1.0 - 0.6 * zone) * (1.0 - S.polar);
        col = clamp(col, S.cDk * 0.85, S.cLt * 1.12 + 0.02);

        // ---- cloud-top height (km) and its gradient (per km)
        // cloud-top relief of the tracer: thick bright cloud stands ~5 km proud of the thin; at close range the deck's
        // streets and billows show their full ~10-15 km of relief
        float closeH = smoothstep(40.0, 8.0, fpk);
        float Hamp = mix(5.0, 13.0, closeH) * mix(1.0, 0.6, zone) * (1.0 + 0.4 * S.wake);
        float gh = 0.45 * g / closeGain(fpk) * mix(1.0, 2.2, closeH);          // softer than the colour curve; bolder up close
        float Th = 0.5 + 0.5 * tanh(gh * (t + b));
        float dT = 0.5 * gh * (1.0 - (2.0 * Th - 1.0) * (2.0 * Th - 1.0));  // dTh/dt
        float H = Hamp * Th;
        vec2 Hg = Hamp * dT * amp * S.tA.yz * D / 0.385;
        Hg *= inversesqrt(1.0 + dot(Hg, Hg) / 0.09);   // soft slope limit (a razor-sharp tracer front would shade as a black hairline)

        // ---- lighting frame
        // east in the body frame: d/dlon of (cos lon, -, -sin lon) -> (-sin lon, 0, -cos lon)
        vec3 east = vec3(uS.z, 0.0, -uS.x) * inversesqrt(max(dot(uS.xz, uS.xz), 1e-12));
        vec3 north = normalize(cross(nLoc, east));
        vec3 posJ = vPosJ;
        vec3 L = normalize(uSunJ - posJ);
        vec3 Lb = transpose(uRot) * L;           // sun direction in the body frame
        float mu0g = dot(nLoc, Lb);
        vec2 sunT = vec2(dot(Lb, east), dot(Lb, north));
        float sunTl = max(length(sunT), 1e-4);
        float tanE = mu0g / sunTl;

        float shad = 1.0;
        // ---- albedo: map ~ eye's view; scale to Jupiter's I/F (zones ~0.55-0.6, belts ~0.3)
        // the Cassini map already contains the gas column seen near nadir: remove it so the haze shell can add the full,
        // geometry-dependent extinction and scattering without double counting
        vec3 alb = col * 0.72 * exp(TAU_R * 1.6);

        // ---- relief normal (tangential gradient of the cloud-top height)
        float rel = 1.0 - smoothstep(0.8, 1.0, S.polar) * 0.5;
        vec3 nB = normalize(nLoc - (east * Hg.x + north * Hg.y) * rel);
        vec3 N = normalize(uRot * nB);
        vec3 N0 = normalize(uRot * nLoc);

        vec3 V = normalize(-vPosW);
        float mu0 = dot(N, L);
        float mu = max(dot(N0, V), 0.0);
        // twilight toe: haze carries light a little past the geometric terminator; elevated cloud tops (H km above the
        // deck) see the Sun past the deck's terminator by the dip of the horizon, sqrt(2 H / R)
        float dip = sqrt(2.0 * max(H, 0.0) / R_KM);
        float mu0e = mu0 + dip;
        float m0 = mu0e > 0.03 ? mu0e : (mu0e > -0.03 ? (mu0e + 0.03) * (mu0e + 0.03) / 0.12 : 0.0);
        m0 *= smoothstep(-0.035, 0.0, mu0g + dip);
        // Minnaert limb darkening, k >= 1 (Jupiter's continuum k ~ 1.0-1.1, larger in the blue and over the deeper belts,
        // which sit under more gas). With k < 1 the mu^(k-1) factor BRIGHTENED the sun-side limb.
        float latAbs = abs(ll0.y);
        vec3 kM = vec3(1.0, 1.05, 1.12) + 0.07 * (1.0 - zone) * (1.0 - S.polar);
        // + a view-limb term. At the film's phase (~25 deg) a pure Lambert/Minnaert k ~ 1 deck leaves the sunward limb at
        //   ~90 % of the disc centre (a flat decal); the real disc falls away to the limb through the absorbing gas +
        //   haze column (methane, chromophore haze), steeper in the blue. Fades out toward the crescent, whose brightness
        //   is the forward-scattering lobes below.
        float cosA = dot(L, V);
        vec3 kV = vec3(0.40, 0.47, 0.58) * smoothstep(-0.1, 0.75, cosA);
        vec3 I = alb * pow(vec3(m0), kM) * pow(vec3(max(mu, 0.02)), kM - 1.0 + kV);
        // absorbing chromophore haze above the deck (tau_abs ~0.17 vertical in the blue, thicker over the poles): the map
        // already holds the nadir column, so only the EXCESS slant airmass darkens (view path in full, sun path half,
        // the rest of the sun path is in sunTransmit). This is what gives the disc its strong, blue-grey limb falloff.
        vec3 tauA = vec3(0.085, 0.095, 0.115) * (1.0 + 1.2 * smoothstep(0.85, 1.35, latAbs));
        float amV = inversesqrt(mu * mu + 0.002), amS = inversesqrt(max(mu0g, 0.0) * max(mu0g, 0.0) + 0.002);
        vec3 absT = exp(-tauA * (max(amV - 1.0, 0.0) + 0.5 * max(amS - 1.0, 0.0)));
        I *= absT;
        // single scattering by the cloud particles (forward lobe): keeps albedo contrast in the crescent
        float g1 = 0.62;
        float dH1 = max(1.0 + g1 * g1 + 2.0 * g1 * cosA, 1e-3);
        float pHG = (1.0 - g1 * g1) / (dH1 * sqrt(dH1));
        I += alb * absT * (0.2 * pHG) * max(mu0, 0.0) / (max(mu0, 0.0) + max(mu, 0.05)) * smoothstep(-0.2, 0.6, -cosA);
        // + a forward lobe that does not scale with the cloud albedo (haze and small ice grains in the upper deck): it
        //   keeps the crescent bright, ~2-3x a Lambert sphere at phase 140-150 (Cassini phase curve, Mayorga et al. 2016)
        float g2 = 0.55;
        float dH2 = max(1.0 + g2 * g2 + 2.0 * g2 * cosA, 1e-3);
        float pHG2 = (1.0 - g2 * g2) / (dH2 * sqrt(dH2));
        I += vec3(0.95, 0.9, 0.82) * (0.075 * pHG2) * max(mu0, 0.0) / (max(mu0, 0.0) + max(mu, 0.05)) * smoothstep(-0.3, 0.5, -cosA);
        I *= shad;

        {
          // sunlight reaching the cloud tops through the gas + haze column (cos(zenith) >= 0 here: upper branch only)
          float hS = max(H, 0.0), cz = max(mu0g + dip, 0.0);
          float rr = 1.0 + hS / R_KM;
          vec3 tau = TAU_R * exp(-hS / H_R) * chapmanUpper(rr * JR_KM / H_R, cz)
                   + HAZE_SPEC * (hazeTau(latAbs) * exp(-hS / H_M) * chapmanUpper(rr * JR_KM / H_M, cz)
                                  + hazeTauS(latAbs) * exp(-hS / H_S) * chapmanUpper(rr * JR_KM / H_S, cz));
          I *= exp(-tau);
        }

        vec3 rad = I * uSunColor * uGain;   // (moon shadows and lightning: haze.js)
        // jdebug=1: tracer contrast T, 3: tracer, 7: cloud-top height
        if (abs(uDebug - 1.0) < 0.5) rad = vec3(T);
        if (abs(uDebug - 3.0) < 0.5) rad = vec3(0.5 + 0.25 * t);
        if (abs(uDebug - 7.0) < 0.5) rad = vec3(H / 20.0);
        // jdebug=10: the (warped, colour-corrected) map mean alone; 11: regime (r = chaos, g = zonal-tile weight, b = GRS)
        if (abs(uDebug - 10.0) < 0.5) rad = S.cFull * max(mu0g, 0.0);
        if (abs(uDebug - 11.0) < 0.5) rad = vec3(S.chaos, S.lam, S.grsW) * 0.6;
        gl_FragColor = vec4(rad, 1.0);
      }`,
  });
}
