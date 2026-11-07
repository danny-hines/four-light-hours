// Corona + chromosphere shells. A BackSide sphere (radius uShellR solar radii) in the Sun's body frame whose
// fragment shader integrates along the camera ray, so it works with the camera far away or inside the corona.
// The same source compiled with CHROMO_PASS renders the chromosphere on a thin shell just above the
// photosphere, so only the limb ring pays for it.
//
// K-corona: Thomson-scattered photospheric light from a Baumbach-like electron density (steep inner term plus
// an r^-3.6 outer term, giving brightness ~ rho^-2.6 at large heights), polar coronal holes with plumes,
// helmet streamers built on a warped neutral sheet (bulb below the cusp, narrow stalk above), and fine radial
// rays (structure that depends on direction only projects to rays after line-of-sight integration).
// F-corona: dust-scattered light, slightly redder, flattened toward the ecliptic at larger elongations.
// Chromosphere: optically thick H-alpha layer (source function x (1 - e^-tau)) and an animated spicule forest.
// Integration uses the angle substitution s = p tan(a) on a fixed grid (no per-pixel jitter): for power-law
// densities this is exact up to a constant, so the radial gradient cannot band, and fine rays stay coherent.
import { NOISE_GLSL } from '../../glsl/noise.js';
import { SUN_COMMON } from './photosphere.glsl.js';
import { SUN_NOISE_GLSL, SUN_HASH_GLSL } from './noisetex.js';

export const CORONA_VERT = /* glsl */ `
varying vec3 vLocal;
void main() {
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

// Start-up bake of the corona's direction-only noise (rendered into a cubemap by a CubeCamera).
export const NOISE_BAKE_FRAG = /* glsl */ `
varying vec3 vLocal;
${NOISE_GLSL}
void main() {
  vec3 dir = normalize(vLocal);
  vec4 n = vec4(snoise(dir * 5.0 + 3.0), snoise(dir * 19.0 + 7.0), snoise(dir * 61.0), snoise(dir * 33.0 + 2.0));
  gl_FragColor = clamp(n * 0.5 + 0.5, 0.0, 1.0);
}`;

export const CORONA_FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uCamLocal;
uniform float uR;
uniform float uGain;
uniform vec3 uDiscColor;
uniform float uPixAngle;
uniform float uShellR;      // shell radius in solar radii
uniform float uCorona;      // corona gain
uniform float uChromo;      // chromosphere gain
uniform float uFade;        // 1 - point-sprite weight
uniform vec3 uEclN;         // ecliptic north in the body frame
uniform float uDebug;
uniform samplerCube uNoiseCube;
uniform int uSamples;        // K-corona samples per ray
uniform int uNAr;            // active regions (loop bound)
uniform int uNStrU;          // streamers (loop bound)
uniform int uSpicN;          // spicule sprites per pixel (rows x neighbours)
uniform vec3 uKCol;          // K-corona tint
uniform float uSkyLift;      // close hero views: brightness profile of the sky above the limb (0 = none)
uniform float uCubeLod0;     // log2(texels per radian) of the noise cubemap
#define NAR 10
uniform vec4 uAR[NAR];      // active regions: xyz direction, w strength
#define NSTR 10
uniform vec4 uStrA[NSTR];   // helmet streamers: xyz axis, w strength
uniform vec4 uStrB[NSTR];   // x bulb half-width (rad), y cusp height (radii), z stalk half-width, w cavity depth
varying vec3 vLocal;

${SUN_NOISE_GLSL}
${SUN_HASH_GLSL}
${SUN_COMMON}
const mat3 ROTA = mat3(0.34693, 0.29221, -0.89121, -0.32792, 0.92804, 0.17664, 0.87870, 0.23097, 0.41779);
const vec3 IRR = vec3(0.52573, 0.68819, 0.5); // an irrational direction through the noise volume (no repeats)

const float R_MM = 695.7;
const float RC = 1.0185;                     // chromosphere shell radius (radii; matches CHROMO_R in sun.js)
const vec3 HALPHA = vec3(1.0, 0.15, 0.19);   // H-alpha + H-beta blend of the flash spectrum (linear sRGB)

// Latitude of the neutral (current) sheet vs longitude. Declining phase: tilted ~25 deg plus a warp, so the
// main helmet streamers stand at mid position angles on opposite limbs.
// (written with multiple-angle identities on (cos lon, sin lon) to avoid trig per sample)
float sheetLat(vec2 eq) {
  float c = eq.x, s = eq.y;
  float s2 = 2.0 * s * c, c2 = c * c - s * s;
  float s3 = s * (3.0 - 4.0 * s * s), c3 = c * (4.0 * c * c - 3.0);
  return 0.42 * (s * 0.95233 + c * 0.30506) + 0.1 * (s2 * 0.36236 - c2 * 0.93204) + 0.05 * (s3 * -0.73739 + c3 * 0.67546);
}

// K-corona electron density (relative, per solar radius of path) at direction dir, radius r (radii)
// active streamer / AR index lists for the current ray (built once per pixel; dynamic loop counts so the
// compiler cannot flatten the per-sample work for inactive features)
int gStrIdx[NSTR];
int gNStr;
float gOuterSky = 0.0;
float gStreamer = 0.0;   // streamer + plume part of the last kDensity sample (they carry the fine rays)   // weight of the sky-plane striation texture (outer corona, camera outside): 3D blotches off
int gArIdx[NAR];
int gNAr;

// angular radius beyond which a streamer's Gaussian profile is negligible (bulb, or the widening stalk)
float streamerReach(vec4 B) { return max(B.x * 2.6, B.z * (1.0 + 0.25 * (uShellR - 1.0)) * 2.6) + 0.05; }

float kDensity(vec3 dir, float r, float fineFade, float midW, float lod) {
  float sl = dir.y;                                   // sin(latitude)
  float lat = asin(clamp(sl, -1.0, 1.0));
  vec2 eq = normalize(vec2(dir.x, -dir.z) + 1e-6);    // (cos lon, sin lon)
  float lr = log2(r);                                 // r^-k = exp2(-k lr)
  // background with polar coronal holes (|lat| > ~58 deg)
  float hole = smoothstep(0.8, 0.9, abs(sl));
  // fine structure is only sampled near the tangent point, where the samples are dense along the great circle
  // direction-only noise baked into a cubemap at start-up: (n5, n19, n61, n33) in [-1, 1]
  vec4 nz = textureLod(uNoiseCube, dir, lod) * 2.0 - 1.0;
  // the quiet background is smooth-ish; the fine radial structure lives in the streamer stalks and polar plumes
  float rays = 0.8 + 0.16 * nz.x + (0.1 * nz.y * midW + 0.05 * nz.z * fineFade);
  float bg = (0.07 * exp2(-8.0 * lr) + 0.024 * exp2(-3.8 * lr)) * mix(1.0, 0.06, hole) * rays;
  // inner-corona condensations over active regions
  float cond = 0.0;
  int nar = r < 1.8 ? gNAr : 0;
  nar = min(nar, uNAr);
  for (int j = 0; j < nar; j++) {
    vec4 A = uAR[gArIdx[j]];
    vec3 dd = dir - A.xyz;
    cond += A.w * exp(-dot(dd, dd) / 0.012);
  }
  bg += cond * 0.12 * exp2(-9.0 * lr) * (0.55 + 0.45 * rays);
  // plasma sheet: a faint, warped belt along the neutral line (the streamer belt between the big helmets)
  float dlat = lat - sheetLat(eq);
  float wsh = 0.07 + 0.2 * exp(-(r - 1.0) * 1.5);
  float bp = (eq.y * 0.76484 + eq.x * 0.64422) * 0.6 + (eq.y * (3.0 - 4.0 * eq.y * eq.y) * -0.50485 + eq.x * (4.0 * eq.x * eq.x - 3.0) * 0.86321) * 0.4;
  float belt = exp(-dlat * dlat / (wsh * wsh)) * (0.35 + 0.65 * smoothstep(-0.4, 0.6, bp));
  // (beyond ~2 R seen from outside, the fine variation comes from the sky-plane striations in main instead: 3D
  // direction noise seen from a finite distance projects to blotches there)
  float o3 = 1.0 - gOuterSky * smoothstep(1.5, 2.8, r);
  float str = max(0.6 + (0.5 * nz.w * fineFade + 0.3 * nz.x * midW + 0.25 * nz.y * midW) * o3, 0.08);
  float r6 = exp2(-6.0 * lr);
  float streamer = belt * (0.05 * r6 + 0.02 * exp2(-3.0 * lr)) * str;
  // helmet streamers: a bright bulb of nested loops below the cusp, then a narrow stalk (petal shape)
  for (int j = 0; j < uNStrU; j++) {
    if (j >= gNStr) break;
    int k = gStrIdx[j];
    vec4 A = uStrA[k], B = uStrB[k];          // A: axis, strength; B: bulb half-width, cusp height, stalk width, cavity
    vec3 dd = dir - A.xyz;
    float psi = length(dd);
    if (psi > streamerReach(B)) continue;
    float x = max((r - 1.0) / (B.y - 1.0), 0.0);
    float dome = pow(1.0 - smoothstep(0.0, 1.05, x), 0.75);   // helmet profile, zero slope at the cusp
    float bfade = smoothstep(1.25, 0.45, x);
    float wz = 0.65 * B.z;                                    // narrow stalk
    float w = wz * (1.0 + 0.25 * (r - 1.0)) + (B.x - wz) * pow(dome, 0.8) * (0.4 + 0.6 * bfade);
    float prof = exp(-psi * psi / (w * w));
    // nested loop arcades inside the bulb, and the dark cavity that often sits over a prominence
    float arch = sqrt(psi * psi / (B.x * B.x) + x * x);
    float loops = 0.9 + 0.1 * sin(arch * 30.0 + A.w * 7.0) * fineFade;
    float cav = 1.0 - 0.7 * B.w * exp(-pow((arch - 0.4) / 0.2, 2.0)) * smoothstep(0.95, 0.5, x);
    float bulb = 0.7 * r6 * bfade * loops * cav;
    float stalk = 0.55 * exp2(-2.7 * lr) * smoothstep(0.35, 1.0, x);
    streamer += A.w * prof * (bulb + stalk) * str;
  }
  // polar plumes: thin, slightly superradial rays rooted in the coronal holes
  float pl = nz.z * 0.7 * fineFade + nz.y * 0.4 * midW + 0.1;
  float plume = hole * max(pl, 0.0) * max(pl, 0.0) * 0.14 * exp2(-4.4 * lr) * (0.35 + 0.65 * fineFade);
  gStreamer = streamer + plume;
#ifdef SUN_DEBUG2
  return bg + plume;
#endif
#ifdef SUN_DEBUG3
  return streamer;
#endif
  return bg + streamer + plume;
}

uniform float uInside;
void main() {
#ifdef CHROMO_PASS
  if (gl_FrontFacing == (uInside > 0.5)) discard;
#endif
  vec3 ro = uCamLocal / uR;            // solar radii
  vec3 rd = normalize(vLocal - uCamLocal);
  float tc = -dot(ro, rd);
  vec3 pc = ro + tc * rd;
  float p = length(pc);
  float p0 = p;                        // unclamped tangent distance (< 1: the ray hits the photosphere)
  vec3 radial = pc / max(p, 1e-6);
  if (p < 1.0) { p = 1.0; pc = radial; } // corona: only reached by pixels in the sub-pixel gap at the mesh silhouette

  float S = uShellR;
  float hs = sqrt(max(S * S - p * p, 0.0));
  float s0 = max(-hs, -tc);            // path start relative to the closest-approach point (camera may be inside)
  float s1 = hs;
  vec3 col = vec3(0.0);
  float distC = length(ro);
  // angular size of a pixel seen from the Sun's centre at the tangent point -> fine-structure fade
  float pixR = uPixAngle * max(sqrt(max(distC * distC - p * p, 0.0)), 0.01);   // radii per pixel at the tangent
  float fineFade = 1.0 - smoothstep(0.004, 0.02, pixR);

#ifndef CHROMO_PASS
  if (s1 > s0 && uCorona > 0.0) {
    float a0 = atan(s0 / p), a1 = atan(s1 / p);
    // every sample of this ray lies on one great circle (the plane through the Sun's centre and the ray):
    // only streamers / active regions whose cones reach that plane can contribute
    vec3 pn = normalize(cross(pc, rd));
    gNStr = 0;
    for (int k = 0; k < uNStrU; k++) {
      if (uStrA[k].w > 0.0 && abs(dot(uStrA[k].xyz, pn)) < sin(min(streamerReach(uStrB[k]), 1.5))) { gStrIdx[gNStr] = k; gNStr++; }
    }
    gNAr = 0;
    for (int i = 0; i < uNAr; i++) if (uAR[i].w > 0.0 && abs(dot(uAR[i].xyz, pn)) < 0.35) { gArIdx[gNAr] = i; gNAr++; }
    // Outer corona seen from outside: fine radial rays as a texture in (position angle on the sky, log r), strongly
    // anisotropic (~30:1), so streamers stay as radial striations out to 10+ R (cf. eclipse photographs).
    vec3 wv = -ro / max(distC, 1e-6);
    vec3 ax = normalize(cross(wv, abs(wv.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 ay = cross(wv, ax);
    vec2 pa = normalize(vec2(dot(radial, ax), dot(radial, ay)) + 1e-6);
    float lp = log(p);
    gOuterSky = smoothstep(2.5, 5.0, distC);
    float fa1 = 1.0 - smoothstep(0.5, 1.5, 40.0 * pixR / p);      // angular features vs the pixel (fade to mean)
    float fa2 = 1.0 - smoothstep(0.5, 1.5, 130.0 * pixR / p);
    // (circles on an oblique plane through the noise volume, so the rays do not repeat around the Sun)
    float sky1 = tn4f(ROTA * vec3(pa * 64.0, 0.0) + vec3(0.0, 0.0, lp * 1.76 + 3.0), 64.0 * pixR / p).x;
    float sky2 = tn4f(ROTA * vec3(pa * 208.0, 0.0) + vec3(0.0, lp * 3.5 + 7.0, 0.0), 208.0 * pixR / p).y;
    float skyRays = (0.26 * sky1 * fa1 + 0.12 * sky2 * fa2) * gOuterSky * smoothstep(1.3, 2.6, p);
    int N = uSamples;
    float da = (a1 - a0) / float(N);
    vec2 acc = vec2(0.0);
    float accS = 0.0;
    for (int i = 0; i < N; i++) {
      float a = a0 + (float(i) + 0.5) * da;
      float ca = cos(a);
      float r = p / ca;
      vec3 xp = pc + (p * tan(a)) * rd;
      vec3 dir = xp / r;
      float ds = p / (ca * ca) * da;
      // Thomson scattering phase (1 + cos^2 chi), chi = angle between the radial direction and the view ray
      float cchi = dot(dir, rd);
      float ph = 0.75 * (1.0 + cchi * cchi);
      float k = kDensity(dir, r, fineFade * ca * ca * ca * ca * ca * ca, ca * ca, max(uCubeLod0 + log2(max(pixR / r, 1e-6)), 0.0));
      // F-corona: dust, ~r^-2.4, flattened toward the ecliptic beyond a few radii
      float z = dot(dir, uEclN);
      float flatn = mix(1.0, 0.25 + 0.75 * exp(-z * z / 0.09), smoothstep(2.0, 8.0, r));
      float f = 0.0011 * pow(r, -2.5) * flatn;
      acc += vec2(k * ph, f) * ds;
      accS += gStreamer * ph * ds;
    }
    // fade out at the shell boundary
    float edge = 1.0 - smoothstep(0.55 * S, 0.98 * S, p);
    // K-corona: Thomson scattering is grey (photospheric colour); rendered a touch cooler (pearl) than the disc.
    // the streamers and plumes carry the striations; the quiet background only a trace of them
    float kc = (acc.x - accS) * (1.0 + 0.25 * skyRays) + accS * max(1.0 + skyRays, 0.25);
#ifdef SUN_ARCADES
    // Loop arcades over active regions at the limb (cf. AIA 171; faint in white light): nested arcs rooted at
    // the region's limb footpoint, in the plane of the sky (an AR within ~15 deg of the limb).
    if (p < 1.45 && p0 >= 1.0) {
      float loopsAcc = 0.0;
      for (int i = 0; i < uNAr; i++) {
        vec4 A = uAR[i];
        if (A.w <= 0.0) continue;
        // distance from the camera's limb (cz = 0 there; the limb of a close camera lies at dot(A, wv) = -1/d)
        float cz = dot(A.xyz, wv) + 1.0 / max(distC, 1.0);   // > 0: behind the limb
        float wl = exp(-cz * cz / 0.08) * smoothstep(-0.5, -0.15, cz);
        if (wl < 0.02) continue;
        vec3 arS = normalize(A.xyz - dot(A.xyz, wv) * wv);
        // (both directions projected on the sky plane: a close camera's tangent points are not perpendicular to wv)
        vec3 radS = normalize(radial - dot(radial, wv) * wv);
        float cpa = clamp(dot(radS, arS), -1.0, 1.0);
        float x = acos(cpa) * sign(dot(cross(arS, radS), wv) + 1e-6);   // along the limb (radii)
        float y = p - 1.0;
        // an arcade: discrete loops (semicircles about the limb footpoint, a little wider than tall), each with its
        // own brightness, only some of them filled (they come and go along the arcade)
        float dl = length(vec2(x * 0.85, y));
        if (dl > 0.26) continue;
        float ang = atan(y, abs(x) + 1e-4);
        vec4 nl = tn4(vec3(ang * 2.4, float(i) * 3.7, 0.5));
        float lq = dl * 26.0 + 0.6 * nl.x;
        float li = floor(lq);
        float lf = fract(lq) - 0.5;
        vec2 lh = hash23(vec3(li, float(i) * 7.3, 2.1));
        float lw = 0.12 + 0.1 * lh.y;
        float lfw = max(lw, 2.0 * pixR * 26.0);
        float line = (lw / lfw) * exp(-lf * lf / (lfw * lfw));
        float on = smoothstep(0.45, 0.8, lh.x);
        float pch = 0.35 + 0.65 * smoothstep(-0.2, 0.5, tn4(vec3(ang * 4.0, li * 1.1, float(i) * 1.9)).y);
        float arcs = line * on * pch;
        loopsAcc += A.w * wl * arcs * exp(-dl / 0.08) * smoothstep(0.0, 0.01, y);
      }
      kc += 0.12 * loopsAcc;
    }
#endif
    // close hero views (the skim): the sky above the horizon is graded by height, bright pearl just above the limb
    // and falling off as ~h^-1.5, instead of a flat lift (h: tangent height of the ray, or the camera's own height
    // for rays heading away from the Sun)
    if (uSkyLift > 0.0) {
      float hp = (tc > 0.0 ? max(p0, 1.0) : distC) - 1.0;
      float prof = pow(0.045 / (hp + 0.012), 1.5);
      kc *= max(1.0 + uSkyLift * (min(prof, 7.0) - 0.9), 0.3);
    }
    col += (uKCol * kc + uDiscColor * vec3(1.04, 1.0, 0.92) * acc.y) * edge * uCorona;
  }

#endif
  // ---------------------------------------------------------------- chromosphere & spicules
  // Analytic line-of-sight columns (no ray march, so nothing can speckle): an exponential H-alpha layer seen along
  // a ray of tangent height h0 has the column tau0 exp(-h0/H) (Chapman, tangent geometry), pre-filtered over the
  // pixel footprint; the spicule forest is a curtain of inclined jets evaluated at the tangent point, several
  // overlapping layers deep, each jet rising and falling on its own clock. Rays that hit the photosphere just
  // inside the limb carry the rim emission a short projected distance onto the disc (this pass also draws front
  // faces when the camera is outside the shell), so there is no seam between the limb and the chromosphere.
#ifdef CHROMO_PASS
  if (uChromo > 0.0) {
    const float HB = 0.6;                    // base-layer scale height (Mm)
    float fpMm = max(pixR * R_MM, 1e-3);     // footprint (Mm) at the tangent point
    float spikeFade = 1.0 - smoothstep(0.5, 2.0, fpMm);
    float hitPhoto = (p0 < 1.0 && tc > 0.0) ? 1.0 : 0.0;
    float h0, colF, rimIn = 1.0;
    vec3 tdir;
    if (hitPhoto > 0.5) {
      // ray ends on the photosphere just inside the limb: continue the rim inward over ~1 Mm in projection
      h0 = 0.0;
      colF = 1.0;
      rimIn = 0.35 * exp(-(1.0 - p0) * R_MM / max(0.9, 0.6 * fpMm));
      tdir = radial;
    } else if (tc > 0.0 || distC > RC) {
      h0 = (p - 1.0) * R_MM;                 // tangent point ahead of the camera
      colF = 1.0;
      tdir = radial;
    } else {
      // camera inside the layer looking outward: half column above the camera height, slanted
      vec3 rc = ro / distC;
      h0 = (distC - 1.0) * R_MM;
      float muc = max(dot(rc, rd), 0.0);
      colF = 0.5 / (1.0 + muc / 0.024);
      tdir = rc;
    }
    if (rimIn > 1e-3 && h0 < 16.0) {
      // The H-alpha chromosphere: an optically thick band (tau0 e^(-h/HB): saturated up to ~3 Mm), averaged over the
      // footprint (exact for an exponential), with the spicule forest rising out of it.
      float xf = 0.5 * fpMm / HB;
      float tb = 25.0 * exp(-h0 / HB) * (sinh(min(xf, 20.0)) / max(xf, 1e-4)) * colF;
      // Spicules are indexed by position along the limb on the sky (the tangent direction projected perpendicular
      // to the line toward the Sun's centre), so each jet stays one coherent streak. Three rows of jets (different
      // depths along the line of sight), one jet per ~1.6 Mm cell: each with its own inclination (+-25 deg), width,
      // heavy-tailed height (mostly 3-5 Mm, a few to 10+), brightness and life cycle (rising and falling); jets are
      // clumped into bushes rooted in the supergranular network (~30 Mm apart along the limb).
      vec3 wv = -ro / max(distC, 1e-6);
      vec3 sky = tdir - dot(tdir, wv) * wv;
      sky *= inversesqrt(max(dot(sky, sky), 1e-12));
      if (hitPhoto < 0.5 && tc <= 0.0 && distC <= RC) sky = tdir;
      // position along the limb (Mm): angle of the sky direction about the line of sight
      vec3 ax = normalize(cross(wv, abs(wv.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      vec3 ay = cross(wv, ax);
      float pa = atan(dot(sky, ay), dot(sky, ax));
      float sMm = pa * R_MM;
      // (along an irrational direction through the noise volume: the bushes never repeat along the limb)
      float bush = tn4(IRR * (sMm / 16.0) + vec3(3.7, 1.1, 0.0)).x * 0.65 + tn4(IRR.yzx * (sMm / 5.6) + vec3(7.1, 2.3, 0.0)).y * 0.35;
      float bushD = smoothstep(-0.12, 0.42, bush);          // network bushes, with empty stretches between them
      float meanS = (0.3 + 1.3 * bushD) * exp(-h0 / 3.5) * smoothstep(0.0, 1.5, h0);
      float ts = meanS;
      if (spikeFade > 0.0) {
        float acc = 0.0;
        const float CELL = 1.25;
        for (int m = 0; m < uSpicN; m++) {
          int k = m / 5;
          float fk = float(k);
          float sk = sMm / CELL + fk * 0.37 + 13.0 * fk;
          float cid = floor(sk) + float(m - 5 * k - 2);
          vec3 hsh = hash33(vec3(cid, fk * 17.0 + 3.0, 5.3));
          vec2 hs2 = hash23(vec3(cid, fk * 17.0 + 9.0, 1.7));
          // clumping: ~70 % of the jets grow in the network bushes, a few stand alone between them
          float keep = step(hsh.x, 0.04 + 0.92 * bushD * sqrt(bushD));
          float incl = (hsh.y - 0.5) * 0.9 + 0.25 * bush;      // +-25 deg, leaning together within a bush
          float life = 0.5 + 0.5 * sin(uTime * (0.45 + 0.4 * hs2.x) + 6.2831853 * hs2.y);
          // heavy-tailed heights, ~2 to 15 Mm (median ~4)
          float hz = hsh.z;
          float H = (2.0 + 13.0 * hz * hz * hz) * (0.55 + 0.45 * life) * (0.75 + 0.45 * bushD);
          float base = cid + 0.5 + 0.8 * (hs2.x - 0.5);
          float d = (sk - base) * CELL - h0 * tan(incl);
          // a jet widens and fades into a diffuse glow toward its tip
          float hf = clamp(h0 / H, 0.0, 1.5);
          float wj = (0.3 + 0.45 * hs2.y) * (1.0 + 1.4 * hf * hf);
          float s2 = wj * wj + 0.3 * fpMm * fpMm;
          float prof = (wj * inversesqrt(s2)) * exp(-d * d * cos(incl) * cos(incl) / s2) / (1.0 + 1.4 * hf * hf);
          float along = exp(-h0 / (0.55 * H)) * (1.0 - smoothstep(0.55, 1.3, hf));
          // lognormal brightness per jet
          float br = exp(2.2 * (hs2.x - 0.5)) * (0.3 + 0.7 * hs2.y);
          acc += keep * prof * along * br;
        }
        ts = mix(meanS, 1.5 * acc * smoothstep(0.0, 1.2, h0) + 0.25 * meanS, spikeFade);
      }
      float L = 1.0 - exp(-(tb + ts * colF));
      // the dense bases glow pink-white (optically thin lines, cf. the prominences), the tips deep crimson
      vec3 hc = mix(vec3(1.0, 0.035, 0.065), vec3(1.0, 0.36, 0.45), 0.55 * exp(-h0 / 1.6));
      col += hc * L * 1.4 * uChromo * rimIn;
    }
  }

#endif
  gl_FragColor = vec4(col * uGain * uFade, 1.0);
}`;
