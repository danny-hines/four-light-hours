// Prominence shader (wave 2): analytic line-of-sight integration, no ray march and no per-pixel jitter.
//
// Arches / eruptive prominences are bundles of flux-rope strands: each strand is a tube with a Gaussian
// cross-section around an irregular inverted-U curve whose two legs are anchored in the chromosphere. For every
// pixel the ray's closest approach to each strand is found (coarse search on the curve parameter + Newton), and the
// Gaussian tube is integrated exactly along the ray with erf() (limits: the camera and the photosphere).
// What a strand is made of (the H-alpha look of real limb prominences, not wires on black):
//   - a diffuse envelope ~2.6x the rope radius at ~13 % of its emissivity, patchy at low frequency, so an arch is a
//     cloud with threads inside;
//   - a rope radius that varies along the strand (pinched at the feet, fatter toward the apex, lumpy);
//   - rope-level fragmentation along the arc (knots and gaps, filling ~40 %);
//   - fine helical threads (Radon projection: a thread at radius r, angle psi projects to r cos(psi - psi_view)),
//     each broken into segments and knots (filling ~30 %) that drain along it, with a lognormal brightness;
//   - a lognormal brightness per strand (sigma ~0.8, set in sun.js).
// Hedgerows are thin meandering sheets of vertical threads: the ray's short path through the sheet is sampled at
// fixed (stratified, unjittered) points, and the curtain is band-limited to that spacing. Their threads are short,
// segmented, knotty and of varied brightness, over a faint diffuse fill.
//
// Emission: optically thick H-alpha (eclipse red, S (1 - e^-tau)) plus optically thin lines (H-beta, He D3) that
// grow with the emission measure but are soft-clipped (em / (1 + em / k)), so the dense cores reach pale pink and
// never white. Output (L, e^-tau), blending out = src + dst * srcAlpha.
//
// Compile budget (ANGLE -> HLSL -> FXC inlines every call and unrolls constant loops): every loop has a uniform
// bound, every noise is one explicit-LOD fetch from the shared noise volume (noisetex.js), and the rope crossing is
// evaluated from a single call site.
import { SUN_COMMON } from './photosphere.glsl.js';
import { SUN_NOISE_GLSL, SUN_HASH_GLSL } from './noisetex.js';

export const NSTRAND = 8;

export const PROM_VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Strand curve, shared with sun.js (which evaluates the same formula on the CPU for the bounding boxes).
// In the strand plane: X = Lk cos th + wobble, Y = -ce + (Hk + ce) sin th + wobble, leaning by `skew`; the plane
// is tilted about the channel axis and offset across it.
export const PROM_FRAG = /* glsl */ `
#define NSTRAND ${NSTRAND}
uniform float uTime;
uniform vec3 uCamLocal;
uniform float uR;
uniform float uGain;
uniform float uPixAngle;
uniform float uFade;
uniform mat3 uBasisT;      // body frame -> prominence frame
uniform vec3 uOrigin;      // anchor on the surface (body frame)
uniform vec3 uBoxMin;
uniform vec3 uBoxMax;
uniform float uSeed;
uniform vec3 uLHW;         // half length, height, half thickness
uniform vec4 uStrandA[NSTRAND]; // Lk (half span), Hk (height), ce (sink below the surface), plane tilt
uniform vec4 uStrandB[NSTRAND]; // width, density (lognormal), plane offset across the channel, phase
uniform vec4 uStrandC[NSTRAND]; // skew (lean), twist (rad of thread angle per rad of th), bound centre y, bound radius
uniform vec4 uStrandD[NSTRAND]; // foot splay along / across the channel (each leg), leg asymmetry (-1..1), apex dip (x Hk)
uniform vec4 uArch;        // thread contrast, inter-thread fill, envelope strength, thread twist scale
uniform vec4 uCurtain;     // the hedgerow sheet (or the rain curtain under an arch): half length, height, half thickness, gain
uniform vec4 uCurtainS;    // its shape: top exponent (0.35 flat mound .. 0.5 under an arch), base brightening, thread speed, -
uniform int uNStrand;
uniform int uNC;           // coarse search samples per strand
uniform int uNewton;       // Newton iterations
uniform int uThree;        // 3 (curve samples per Newton step; a uniform so the loop is not unrolled)
uniform int uNThread;      // threads per rope
uniform int uHedgeN;       // max samples through a hedgerow sheet
uniform float uEmit;       // H-alpha source function relative to the disc-centre radiance (display-graded, sun.js)
uniform float uThin;       // optically thin emissivity per unit emission measure (relative to the disc radiance)
uniform float uThinK;      // soft-clip knee of the thin emission
uniform float uKappa;      // opacity per unit column
uniform float uOffGain;    // extra gain of the off-disc emission (hero close-ups exposed for the disc)
uniform float uInside;     // 1: the camera is inside the box (draw back faces, no depth test)
uniform float uDebug;
varying vec3 vLocal;

${SUN_NOISE_GLSL}
${SUN_HASH_GLSL}
${SUN_COMMON}

const vec3 HA = vec3(1.0, 0.06, 0.075);   // H-alpha (656 nm) with a trace of H-beta: eclipse red (AgX desaturates it toward salmon)
const vec3 THIN = vec3(1.0, 0.27, 0.3);      // H-beta + He D3 blend of the dense cores: pale pink

vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv, t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  return vec2(max(max(tmin.x, tmin.y), tmin.z), min(min(tmax.x, tmax.y), tmax.z));
}
// erf(x) ~ tanh(1.128 x + 0.1009 x^3) (|error| < 5e-4), one exp
float erfa(float x) {
  x = clamp(x, -4.0, 4.0);
  return 1.0 - 2.0 / (exp(2.2567584 * x + 0.2018 * x * x * x) + 1.0);
}
// anti-aliased thin line where the noise n crosses zero: half-width lw (noise units), footprint fpn (noise units).
// Widening to the footprint keeps the line's integral, so the mean (~lw/2) does not depend on the distance.
float aaLine(float n, float lw, float fpn) {
  float w = clamp(max(lw, fpn), 1e-4, 1.0);
  float l = (lw / w) * (1.0 - smoothstep(0.0, w, abs(n)));
  return mix(l, 0.5 * lw, smoothstep(0.8, 1.6, fpn));
}

// ---------------------------------------------------------------- arches
vec4 gA, gB, gC, gD;
float gct, gst;
// plane coordinates (X, Y, across) of the loaded strand at curve parameter th
vec3 strandPlane(float th) {
  float c = cos(th), s = sin(th), ph = gB.w;
  float del = gB.x * 0.85 * sin(4.3 * th + ph) * sin(1.7 * th + 2.3 * ph) + gA.y * 0.06 * sin(2.2 * th + 1.3 * ph);
  // Kippenhahn-Schlueter dip: the field (and the plasma it holds) sags at the apex
  float dq = th - 1.5708;
  float Y = -gA.z + (gA.y + gA.z) * s + del * s - gD.w * gA.y * exp(-4.0 * dq * dq);
  // the legs splay apart toward their footpoints (each strand of the bundle lands on its own patch)
  float foot = 1.0 - smoothstep(-0.1 * gA.y, 0.55 * gA.y, Y);
  foot *= foot;
  float X = (gA.x + del) * c + gC.x * max(Y, 0.0) + gD.x * foot * sign(c);
  float za = gB.z + gB.x * 1.1 * sin(3.1 * th + 1.3 * ph) * sin(2.2 * th + 0.7 * ph) + uLHW.z * 0.3 * sin(1.4 * th + 2.0 * ph) + gD.y * foot * sign(c);
  return vec3(X, Y, za);
}
vec3 toBox(vec3 p) { return vec3(p.x, p.y * gct - p.z * gst, p.y * gst + p.z * gct); }
vec3 strandP(float th) { return toBox(strandPlane(th)); }
float rayDist2(vec3 P, vec3 ro, vec3 rd) {
  vec3 q = P - ro;
  float b = dot(q, rd);
  return dot(q, q) - b * b;
}

// accumulate one rope crossing (strand k loaded, curve parameter th): column (tau) and emission measure
// (C: the curve point at th, Tg: its tangent, both in box coordinates)
// The structure is field-aligned: every noise is stretched along the strand (a) and narrow across it (u), so
// threads stay continuous for most of the arch, their brightness drifting smoothly along them, with only rare
// gaps; the envelope is a continuous cloud around the bundle.
void ropeCrossing(int k, float th, vec3 C, vec3 Tg, vec3 ro, vec3 rd, float tA, float tB, float t, inout float col, inout float em) {
  vec3 pl = vec3(C.x, C.y * gct + C.z * gst, 0.0);
  Tg *= inversesqrt(max(dot(Tg, Tg), 1e-12));
  float sS = dot(C - ro, rd);
  vec3 off = ro + sS * rd - C;
  float d2 = dot(off, off);
  float hN = clamp(pl.y / max(gA.y, 1e-3), 0.0, 1.0);
  float span = 0.5 * (gA.x + gA.y);
  float a = th * span;                                   // along the strand (scene units)
  float fk = float(k);
  float cth = cos(th);
  float dq = th - 1.5708;
  float dipF = exp(-4.0 * dq * dq) * smoothstep(0.02, 0.12, gD.w);
  // low-frequency structure along the strand: x lumps, y envelope patchiness, z rope fragmentation, w fill
  vec4 nL = tn4(vec3(a * 0.11 - t * 0.02, fk * 3.1 + gB.w, uSeed * 2.7));
  // rope radius: pinched at the feet, fatter toward the apex, lumpy along its length; one leg fatter than the other
  float leg = max(0.2, 1.0 + gD.z * cth);
  float w = gB.x * (0.5 + 0.62 * smoothstep(0.0, 0.65, hN)) * (0.85 + 0.6 * max(nL.x, -0.35)) * (0.8 + 0.2 * leg);
  float wE = 3.0 * w;
  float eE = d2 / (wE * wE);
  if (eE > 5.0) return;
  vec3 cr = cross(rd, Tg);
  float sph = length(cr);
  float sp = max(sph, 0.14);
  float limE = erfa((tB - sS) * sp / wE) - erfa((tA - sS) * sp / wE);
  if (limE <= 1e-4) return;
  // density: lognormal per strand, the denser leg, and plasma collected in the apex dip
  float dens = gB.y * leg * (1.0 + 0.9 * dipF);
  // projected cross-rope offset (signed, rope radii) and the view angle around the rope
  vec3 nP = cr / max(sph, 1e-6);
  float u = dot(off, nP) / w;
  // field-aligned cloud structure on the sky (~12:1, long along the strand): x rope fragmentation, y/z patchiness
  vec4 nC = tn4(vec3(a * 0.16 + t * 0.03, u * 1.05 + fk * 1.7, uSeed + 5.0));
  // the diffuse envelope: a wide, faint Gaussian cloud around the rope, continuous along it
  float envM = uArch.z * (0.07 + 1.5 * smoothstep(-0.15, 0.5, nL.y + 0.6 * nC.y));
  float gE = exp(-eE);
  float colE = dens * envM * wE * 0.8862 / sp * gE * limE;
  col += colE;
  em += colE * dens * envM * gE;
  float e2 = d2 / (w * w);
  if (e2 > 9.0) return;
  float lim = erfa((tB - sS) * sp / w) - erfa((tA - sS) * sp / w);
  float g = exp(-e2);
  float colR = dens * w * 0.8862 / sp * g * lim;
  vec3 N0 = vec3(0.0, -gst, gct);
  N0 = normalize(N0 - dot(N0, Tg) * Tg + vec3(1e-5, 0.0, 0.0));
  // the view angle about the rope as a unit vector (cos, sin)
  vec2 pv = normalize(vec2(dot(nP, N0), dot(nP, cross(Tg, N0))) + vec2(1e-6, 0.0));
  float aa = abs(dq) * span;                             // distance from the apex: rain drains down both legs
  float fpu = uPixAngle * max(sS, 0.0) / w;              // pixel footprint in rope radii
  // rope-level fragmentation: a few long gaps along the rope, soft-edged
  float fragR = 0.06 + 0.94 * smoothstep(-0.12, 0.38, nL.z + 0.45 * nC.x);
  // condensations: lognormal clumps along each strand (~3-6 units), different in every strand, drifting with the
  // flows; and a fibrous fill between the threads (field-aligned ridges at two scales)
  vec4 nK = tn4(vec3(a * 0.4 - t * 0.06, u * 0.7 + fk * 2.3, uSeed * 3.1 + 2.0));
  float clumps = exp(2.0 * (nK.x + 0.7 * nL.x) - 0.3);
  float fib = 1.0 - abs(nK.y + 0.6 * nC.z);
  float M = uArch.y * (0.15 + smoothstep(-0.4, 0.5, nL.w + 0.5 * nC.z)) * (0.35 + 1.1 * fib * fib);
  float tw = gC.y * uArch.w;
  float thr = 0.0;
  for (int i = 0; i < uNThread; i++) {
    float fi = float(i);
    vec3 hs = hash33(vec3(fi * 1.37 + 0.5, fk * 7.1 + 1.3, uSeed));
    // threads fill the rope's cross-section uniformly (by area) and wind slowly about its axis
    float ri = 0.97 * sqrt(hs.x);
    float ang = 6.2831853 * hs.y + tw * (0.6 + 0.8 * hs.z) * th;
    float ui = ri * (cos(ang) * pv.x + sin(ang) * pv.y);   // r cos(psi - psi_view)
    float sg = 0.045 + 0.075 * hs.z;
    float s2 = sg * sg + 0.36 * fpu * fpu;
    float du = u - ui;
    float prof = (sg * inversesqrt(s2)) * exp(-du * du / s2);
    if (prof < 0.01) continue;
    // brightness drifts smoothly along each thread (correlation ~5 units, 30+ thread widths) and slides down the
    // legs (coronal rain); rare soft gaps
    vec2 ns = tn4(vec3(aa * (0.34 + 0.2 * hs.y) - t * (0.25 + 0.3 * hs.x), fi * 2.9 + fk * 1.3, uSeed * 1.9 + 11.0)).xy;
    float seg = exp(1.9 * ns.x) * smoothstep(-0.2, 0.12, ns.y);
    // lognormal brightness per thread (sigma ~0.6)
    float br = exp(2.1 * (fract(hs.x * 13.7 + hs.z * 5.3) - 0.5));
    thr += br * prof * seg;
  }
  // (unresolved threads blend into the fill)
  M += uArch.x * 1.25 * thr;
  M *= fragR * clumps;
  col += colR * M;
  em += colR * dens * g * M * M;
}

void arches(vec3 ro, vec3 rd, float tA, float tB, float t, out float col, out float em) {
  col = 0.0;
  em = 0.0;
  for (int k = 0; k < uNStrand; k++) {
    if (uKappa * col > 7.0) break;   // (optically thick: the strands behind are hidden)
    gA = uStrandA[k]; gB = uStrandB[k]; gC = uStrandC[k]; gD = uStrandD[k];
    gct = cos(gA.w); gst = sin(gA.w);
    // bounding sphere of the strand (centre on the channel axis, in the strand's plane)
    vec3 bc = vec3(0.0, gC.z * gct - gB.z * gst, gC.z * gst + gB.z * gct);
    if (rayDist2(bc, ro, rd) > gC.w * gC.w) continue;
    // coarse search for up to two local minima of the ray distance on the smooth (unwobbled) curve
    float lo = asin(clamp(gA.z / (gA.y + gA.z), 0.0, 0.99)) - 0.32;
    float hi = 3.14159265 - lo;
    float dth = (hi - lo) / float(uNC - 1);
    float gPrev2 = 1e20, gPrev = 1e20;
    float m1 = -1.0, m2 = -1.0, g1 = 1e20, g2 = 1e20;
    float cs = cos(lo), sn = sin(lo), cd = cos(dth), sd = sin(dth);
    float reach = 6.0 * gB.x * 1.6 + uLHW.z * 0.35 + 0.08 * gA.y + gD.w * gA.y;
    float reach2 = reach * reach;
    for (int j = 0; j <= uNC; j++) {
      float gj = 1e20;
      if (j < uNC) {
        float dq = lo + float(j) * dth - 1.5708;
        float Y = -gA.z + (gA.y + gA.z) * sn - gD.w * gA.y * exp(-4.0 * dq * dq);
        vec3 P = vec3(gA.x * cs + gC.x * max(Y, 0.0), Y * gct - gB.z * gst, Y * gst + gB.z * gct);
        gj = rayDist2(P, ro, rd);
        float c2 = cs * cd - sn * sd;
        sn = sn * cd + cs * sd;
        cs = c2;
      }
      // sample j-1 is a local minimum?
      if (j >= 1 && gPrev <= gPrev2 && gPrev < gj && gPrev < reach2) {
        float thm = lo + float(j - 1) * dth;
        // vertex of the parabola through the three samples (interior minima)
        if (gPrev2 < 1e19 && gj < 1e19) {
          float den = gPrev2 - 2.0 * gPrev + gj;
          if (den > 1e-6) thm += clamp(0.5 * (gPrev2 - gj) / den, -0.5, 0.5) * dth;
        }
        if (gPrev < g1) { m2 = m1; g2 = g1; m1 = thm; g1 = gPrev; }
        else if (gPrev < g2) { m2 = thm; g2 = gPrev; }
      }
      gPrev2 = gPrev;
      gPrev = gj;
    }
    if (m1 < -0.5) continue;
    // refine both minima (Newton on the squared ray distance, numeric derivatives), then integrate each crossing
    // from one call site
    float thPrev = -10.0;
    for (int c = 0; c < 2; c++) {
      float th = c == 0 ? m1 : m2;
      if (th < -0.5) break;
      // the last pass only samples the curve for the crossing (point and tangent): strandP has one call site
      vec3 Pc = vec3(0.0), Pp = vec3(0.0), Pm = vec3(0.0);
      for (int it = 0; it <= uNewton; it++) {
        float h = 0.012;
        float q0 = 0.0, qp = 0.0, qm = 0.0;
        for (int m = 0; m < uThree; m++) {
          float o = m == 0 ? 0.0 : (m == 1 ? h : -h);
          vec3 Pk = strandP(th + o);
          float qv = rayDist2(Pk, ro, rd);
          if (m == 0) { q0 = qv; Pc = Pk; } else if (m == 1) { qp = qv; Pp = Pk; } else { qm = qv; Pm = Pk; }
        }
        if (it == uNewton) break;
        float d1 = (qp - qm) / (2.0 * h), dd2 = (qp - 2.0 * q0 + qm) / (h * h);
        float st = dd2 > 1e-5 ? d1 / dd2 : sign(d1) * 0.08;
        th = clamp(th - clamp(st, -0.18, 0.18), lo, hi);
      }
      if (abs(th - thPrev) > 0.12) ropeCrossing(k, th, Pc, Pp - Pm, ro, rd, tA, tB, t, col, em);
      thPrev = th;
    }
  }
}

// ---------------------------------------------------------------- hedgerows
// density of the curtain at x (h = height above the photosphere); fpx / fph: band limits along x and height.
// A hedgerow is a sheet of fine vertical threads: brightest in its feet and lower body, its top a ragged edge of
// flame-like tufts of different heights (each thread octave has its own top); under an arch the same sheet is the
// rain curtain hanging from the dipped field (uCurtainS.x shapes its top).
float hedgeRho(vec3 x, float h, float fpx, float fph, float t, out float knot) {
  knot = 0.0;
  float L = uCurtain.x, H = uCurtain.y, W = uCurtain.z;
  float u = x.x / L;
  float env = pow(max(0.0, 1.0 - u * u), uCurtainS.x);
  if (env <= 0.0) return 0.0;
  // large-scale shape along the sheet: x top height, y meander, z feet, w clumps
  vec4 nS = tn4(vec3(x.x * 0.17, h * 0.05 + 0.3, uSeed * 1.7));
  float nT = tn4f(vec3(x.x * 0.8, 3.0, uSeed * 2.3), fpx * 0.8).x;
  float top = H * env * (0.72 + 0.9 * nS.x + 0.35 * nT);
  if (h > top * 1.45 + 0.5 || h < -0.05) return 0.0;
  // the sheet meanders a little and thickens downward
  float zc = 1.8 * W * nS.y;
  float zz = (x.z - zc) / (W * (0.75 + 0.45 * smoothstep(top, 0.0, h)));
  float sheet = exp(-zz * zz * 1.6);
  if (sheet < 0.01) return 0.0;
  // feet (barbs): between them the bottom of the sheet lifts into dark arches
  float fp1 = 0.5 + 0.5 * cos(x.x * 0.5 + uSeed * 2.0 + 1.7 * nS.z);
  float bottom = top * 0.5 * sqrt(fp1) * uCurtainS.w;
  float vert = smoothstep(bottom - 0.2, bottom + 1.1, h);
  if (vert <= 0.0) return 0.0;
  // threads: vertical segments (zero crossings of vertically stretched noise, ~5:1), three octaves from ~4 Mm
  // bundles to ~0.6 Mm threads, each with its own segment mask, lognormal brightness, knots sliding down
  // (downflows) and its own top (tufts); unresolved octaves fade to their mean
  float xs = x.x + 0.6 * nS.w + 0.05 * x.z;
  float hb = h - uCurtainS.z * t;
  float thr = 0.0;
  float f = 0.9;
  for (int o = 0; o < uThree; o++) {
    float fo = float(o);
    vec4 n = tn4f(vec3(xs * f, hb * f * 0.2, uSeed * 0.7 + fo * 4.1), fph * f * 0.2);
    float fpn = fpx * f * 1.7;
    float line = fpn < 1.6 ? aaLine(n.x, 0.1, fpn) : 0.05;
    float seg = mix(0.45, smoothstep(-0.12, 0.2, n.y), 1.0 - smoothstep(0.5, 1.2, fpn));
    float br = exp(2.0 * n.z);
    // the tuft top of this octave: finer octaves reach a little higher in thin wisps
    float tt = top * (0.78 + 0.18 * fo + 1.1 * n.w);
    float tf = smoothstep(tt * 1.05 + 0.3, tt * 0.45, h);
    thr += (1.6 - 0.25 * fo) * line * seg * br * tf;
    f *= 2.3;
  }
  float clump = 0.45 + 0.6 * smoothstep(-0.35, 0.4, nS.w + 0.5 * nT);
  // knots: bright condensations sliding down the threads
  float kd = tn4f(vec3(xs * 1.6, (h - 0.5 * t) * 0.45, uSeed + 3.3), fph * 0.45).x;
  knot = 0.35 + 1.4 * smoothstep(0.08, 0.45, kd) * (1.0 - smoothstep(0.4, 1.0, fpx * 1.6)) + 0.4 * clump;
  // a diffuse fill (the sheet is a cloud, not only threads), and the bright lower body
  float body = smoothstep(top * 1.1, top * 0.3, h);
  float fill = 0.12 * (0.5 + smoothstep(-0.4, 0.4, nS.w)) * body;
  float base = 1.0 + uCurtainS.y * exp(-max(h - bottom, 0.0) / max(0.3 * top, 0.5));
  return sheet * vert * (thr * clump + fill) * base;
}

void hedge(vec3 ro, vec3 rd, float tA, float tB, float t, out float col, out float em) {
  col = 0.0;
  em = 0.0;
  // the ray's interval through the slab holding the (meandering, thickening) sheet
  float W = uCurtain.z;
  float zs = 3.2 * W;
  float rz = abs(rd.z) > 1e-5 ? rd.z : 1e-5;
  float sa = (-zs - ro.z) / rz, sb = (zs - ro.z) / rz;
  float s0 = max(tA, min(sa, sb)), s1 = min(tB, max(sa, sb));
  if (s1 <= s0) return;
  // samples ~1.3 units apart (at least 5: grazing paths through the curtain get more; the curtain is band-limited to
  // their spacing)
  int K = int(clamp(ceil((s1 - s0) / 1.3), 5.0, float(uHedgeN)));
  float ds = (s1 - s0) / float(K);
  // band limit: the samples' spacing projected on the curtain (x along it, height up it)
  float fpS = uPixAngle * max(0.5 * (s0 + s1), 0.0);
  float fpx = max(fpS, 0.6 * ds * abs(rd.x));
  float fph = max(fpS, 0.6 * ds * abs(rd.y));
  for (int i = 0; i < uHedgeN; i++) {
    if (i >= K) break;
    float s = s0 + (float(i) + 0.5) * ds;
    vec3 x = ro + s * rd;
    float h = length(x + vec3(0.0, uR, 0.0)) - uR;
    float kn;
    float r = hedgeRho(x, h, fpx, fph, t, kn);
    col += r * ds;
    em += r * r * kn * ds;
  }
  col *= uCurtain.w;
  em *= uCurtain.w * uCurtain.w;
}

void main() {
  if (gl_FrontFacing == (uInside > 0.5)) discard;
  vec3 rdL = normalize(vLocal - uCamLocal);
  vec3 ro = uBasisT * (uCamLocal - uOrigin);
  vec3 rd = uBasisT * rdL;
  vec2 tb = boxHit(ro, rd, uBoxMin, uBoxMax);
  float tA = max(tb.x, 0.0), tB = tb.y;
  // the photosphere (sphere of radius R centred R below the anchor) stops the ray
  vec3 oc = ro + vec3(0.0, uR, 0.0);
  float b = dot(oc, rd);
  float c = dot(oc, oc) - uR * uR;
  float disc = b * b - c;
  bool onDisc = false;
  float tHit = 1e7;
  if (disc > 0.0) {
    float th = -b - sqrt(disc);
    if (th > 0.0) { tHit = th; onDisc = true; }
  }
  tB = min(tB, tHit);
  // Against the disc, in white light, a prominence (a filament) is invisible: nothing to do. (Its H-alpha
  // absorption would dim the photosphere by < 4 %, and its own glow is a percent of the disc's.)
  if (tB <= tA || onDisc) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float t = uTime;
  float col = 0.0, em = 0.0;
#ifndef NO_HEDGE
  // the hedgerow sheet (or the rain curtain under an arch)
  if (uCurtain.w > 0.0) hedge(ro, rd, tA, tB, t, col, em);
#endif
#ifndef NO_ARCH
  // tubes: integrated from the camera (or box entry when outside) to the photosphere
  if (uNStrand > 0) {
    float colA, emA;
    arches(ro, rd, 0.0, tHit, t, colA, emA);
    col += colA;
    em += emA;
  }
#endif
  float tau = uKappa * col;
  float T = exp(-tau);
  // the thin-line emission is soft-clipped: dense cores reach pale pink, never white
  float emS = em / (1.0 + em / uThinK);
  vec3 L = (HA * uEmit * (1.0 - T) + THIN * uThin * emS) * uGain;
#ifdef SUN_DEBUG10
  if (isnan(L.r + L.g + L.b + T) || isinf(L.r + L.g + L.b + T)) { gl_FragColor = vec4(1e4, 0.0, 1e4, 0.0); return; }
#endif
  gl_FragColor = vec4(L * uOffGain * uFade, mix(1.0, T, uFade));
}`;
