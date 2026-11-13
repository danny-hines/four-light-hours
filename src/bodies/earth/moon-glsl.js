// Moon shaders.
//
// Geometry: a view-dependent polar grid centred on the sub-camera point (rings uniform in camera nadir angle, then
// uniform in central angle out past the horizon), displaced by LOLA heights in the vertex shader. This gives a true
// rugged horizon in the Earthrise shot from 15-50 km up, and a perfectly tessellated limb for the full disc.
// Shading: LRO WAC colour (contrast-corrected to true lunar albedo), C2 B-spline LOLA normals, a procedural crater
// population below the LOLA resolution (power-law sizes, morphology by diameter, per-crater degradation, shading from
// the height field + analytic rim shadows), LOLA horizon-march terrain shadows, lunar-Lambert / Hapke-lite photometry
// with opposition surge, earthshine and Earth's umbra.
// Compile budget (ANGLE -> HLSL -> FXC inlines every call): the crater code exists once (one flattened loop over
// level x cube face x cell), all fractal noise is the baked 3D texture (noise3d.js), loop bounds are uniforms.
import { NOISE_GLSL } from '../../glsl/noise.js';
import { NOISE3_GLSL } from './noise3d.js';

const MOON_RELIEF = /* glsl */ `
// Procedural relief below the LOLA resolution (~5 km): ridged multi-scale noise, ~160 m at 14 km down to ~10 m at
// 1 km, displacing the geometry too so the horizon silhouette is rugged rather than blob-like. Octaves fade by the
// local resolution (lmin = shortest wavelength resolved, km). Returns vec4(height km, dh/dp (km per radian)).
#define RELIEF_GAIN 2.3
vec4 moonRelief(vec3 p, float lmin) {
  vec4 s = vec4(0.0);
  float f = 1737.4 / 14.0, a = 0.16 * RELIEF_GAIN;
  for (int i = 0; i < uLoopMax; i++) {
    if (i >= 5) break;
    float w = smoothstep(lmin, 2.0 * lmin, 1737.4 / f);
    if (w <= 0.0) break;
    bool odd = (i & 1) == 1;
    vec3 x = p * f + float(i) * vec3(3.1, 7.7, 1.3);
    vec4 n = tn(odd ? NOISE3_ROT * x : x);
    vec3 g = (odd ? n.yzw * NOISE3_ROT : n.yzw) * f;
    // ridged, with a rounded crest (smooth |x|: a true crease flips the normal within a pixel at low sun); the rounding
    // grows as the octave approaches the resolution limit
    float k = mix(0.12, 0.5, 1.0 - w);
    float sa = sqrt(n.x * n.x + k * k);
    float r = 1.0 + k - sa;
    s += w * a * vec4(r * r - 0.45, 2.0 * r * (-n.x / sa) * g);
    f *= 2.2;
    a *= 0.34;                                           // regolith-mantled: smoother toward small scales
  }
  return s;
}
`;

// the 16 B-spline taps, written out (a loop nested inside the horizon-march loop compiled slower under FXC)
const BSPLINE_TAPS = (() => {
  const X = 'xyzw';
  let c = '  float h = 0.0, hu = 0.0, hv = 0.0;\n  int txb = int(i0.x) - 1;\n';
  for (let x = 0; x < 4; x++) c += `  int tx${x} = txb + ${x}; tx${x} -= sz.x * int(floor(float(tx${x}) / float(sz.x)));\n`;
  for (let y = 0; y < 4; y++) {
    c += `  { int ty = clamp(int(i0.y) - 1 + ${y}, 0, sz.y - 1); float r = 0.0, rd = 0.0;\n`;
    for (let x = 0; x < 4; x++) c += `    { float v = texelFetch(uHeight, ivec2(tx${x}, ty), 0).r; r += v * wx.${X[x]}; rd += v * dx.${X[x]}; }\n`;
    c += `    h += r * wy.${X[y]}; hu += rd * wy.${X[y]}; hv += r * dy.${X[y]}; }\n`;
  }
  return c;
})();

const MOON_COMMON = /* glsl */ `
#define PI 3.14159265359
#ifndef U_LOOPMAX
#define U_LOOPMAX
uniform int uLoopMax;          // = 64; uniform loop bounds keep FXC from unrolling
#endif
uniform sampler2D uHeight;     // LOLA, 0..1 -> H_MIN..H_MAX km
uniform float uR;              // mean radius (scene units)
#define H_MIN (-8.8134)
#define H_MAX (10.6398)
#define KM (1.0 / 6371.0)
vec2 dirToUV(vec3 d) {
  return vec2(atan(-d.z, d.x) * (0.5 / PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
}
float heightKm(float v) { return H_MIN + v * (H_MAX - H_MIN); }
// C2 cubic B-spline LOLA height + gradient: vec3(height km, dh/du, dh/dv) in km per uv unit; 16 texel fetches
vec3 lolaBspline(vec2 uv) {
  ivec2 sz = textureSize(uHeight, 0);
  vec2 st = uv * vec2(sz) - 0.5;
  vec2 i0 = floor(st);
  vec2 f = st - i0;
  vec2 f2 = f * f, f3 = f2 * f;
  vec4 wx = vec4((1.0 - 3.0 * f.x + 3.0 * f2.x - f3.x), (4.0 - 6.0 * f2.x + 3.0 * f3.x), (1.0 + 3.0 * f.x + 3.0 * f2.x - 3.0 * f3.x), f3.x) / 6.0;
  vec4 wy = vec4((1.0 - 3.0 * f.y + 3.0 * f2.y - f3.y), (4.0 - 6.0 * f2.y + 3.0 * f3.y), (1.0 + 3.0 * f.y + 3.0 * f2.y - 3.0 * f3.y), f3.y) / 6.0;
  vec4 dx = vec4(-1.0 + 2.0 * f.x - f2.x, -4.0 * f.x + 3.0 * f2.x, 1.0 + 2.0 * f.x - 3.0 * f2.x, f2.x) / 2.0;
  vec4 dy = vec4(-1.0 + 2.0 * f.y - f2.y, -4.0 * f.y + 3.0 * f2.y, 1.0 + 2.0 * f.y - 3.0 * f2.y, f2.y) / 2.0;
${BSPLINE_TAPS}
  float s = H_MAX - H_MIN;
  return vec3(H_MIN + h * s, hu * s * float(sz.x), hv * s * float(sz.y));
}
`;

export const MOON_VERT = /* glsl */ `
${MOON_COMMON}
${NOISE_GLSL}
${NOISE3_GLSL}
${MOON_RELIEF}
attribute vec2 grid;           // x = ring index, y = azimuth (radians)
uniform vec3 uCamB;            // camera position in the Moon's body frame
uniform mat3 uB2W;             // body frame -> world axes
uniform vec3 uCenterW;         // Moon centre (camera-relative world)
uniform float uNa;             // rings in the nadir-angle section
uniform float uNt;             // rings in the central-angle section
uniform float uAlphaA;         // nadir angle at the end of section A
uniform float uThetaS;         // central angle where section B starts
uniform float uThetaMax;       // outermost ring
varying vec3 vPosB;
varying vec3 vPosW;
varying float vPixAng;         // angular size of a pixel (radians)
uniform vec2 uResolution;
void main() {
  float D = length(uCamB);
  vec3 c = uCamB / D;
  vec3 e1 = normalize(cross(abs(c.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), c));
  vec3 e2 = cross(c, e1);
  float i = grid.x;
  // ring -> central angle; the ring spacing (dth) sets the shortest relief wavelength the mesh may carry
  float th, dth = (uThetaMax - uThetaS) / uNt;
  if (i <= uNa) {
    float a = uAlphaA * (i / uNa);
    th = asin(min(D * sin(a) / uR, 1.0)) - a;
    if (i < uNa) {
      float a1 = uAlphaA * ((i + 1.0) / uNa);
      dth = abs(asin(min(D * sin(a1) / uR, 1.0)) - a1 - th);
    }
  } else {
    th = uThetaS + dth * (i - uNa);
  }
  vec3 dir = c * cos(th) + (e1 * cos(grid.y) + e2 * sin(grid.y)) * sin(th);
  // C2 LOLA + sub-LOLA relief at wavelengths >= ~4x the local mesh spacing (no aliased silhouette facets)
  float h = (lolaBspline(dirToUV(dir)).x + moonRelief(dir, max(4.0 * dth * 1737.4, 0.6)).x) * KM;
  vPosB = dir * (uR + h);
  vPosW = uB2W * vPosB + uCenterW;
  vPixAng = 2.0 / (projectionMatrix[1][1] * uResolution.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vPosW, 1.0);
}
`;

export const MOON_FRAG = /* glsl */ `
${MOON_COMMON}
${NOISE_GLSL}
${NOISE3_GLSL}
${MOON_RELIEF}
uniform sampler2D uColor;
uniform vec3 uSunDirB;         // Moon -> Sun, body frame
uniform vec3 uEarthPosB;       // Earth centre relative to the Moon centre, body frame (scene units)
uniform float uEarthR;
uniform vec3 uEarthshine;      // earthshine irradiance (colour), already includes Earth's phase and the artistic gain
uniform float uSunAngR;        // Sun angular radius seen from the Moon
uniform mat3 uB2W;
uniform float uDetail;
uniform int uDebug;
varying vec3 vPosB;
varying vec3 vPosW;
varying float vPixAng;

// ---------------------------------------------------------------- crater population
// Crater population below the LOLA scale. Candidates live on a jittered 3D lattice per level (cells halve per level:
// 40 km .. 80 m); only lattice points within half a cell of the sphere count (a one-cell slab => one candidate per
// cell^2 of surface: uniform, seamless, no projection or pole artefacts), searched over the 3x3x3 cells around the
// pixel (exact: a candidate is within half a cell of the sphere and its influence within half a cell along it, so its
// cell is at most one cell away on every axis). The population:
//  - size-frequency N(>D) ~ D^-2 (one candidate per cell^2 per level, radii within a level p(r) ~ r^-3),
//  - regional density: maria (younger surfaces) ~0.4 of the saturated highlands, and clustering (secondary fields):
//    a level-scaled noise modulates the density 0.25 .. 1.75x, so the field has clumps and empty patches,
//  - morphology by diameter: simple bowls (d/D 0.2) below ~15 km; flat floors and central peaks above ~18 km
//    (Pike 1977: d = 1.044 D^0.301 km, rim height 0.236 D^0.399 km),
//  - a per-crater degradation state (most are old: shallow d/D ~0.04-0.08, rounded, rimless; a few percent fresh:
//    sharp rims, full depth, bright immature ejecta), smaller craters degrading faster,
//  - shading from the summed height-field gradient (the sun-facing inner wall is bright, the far wall in shade) and an
//    analytic rim shadow along the sun azimuth (anti-aliased by its own change across the pixel).
struct CraterAcc { vec3 grad; float shadow; float alb; float bounce; };
void craterField(vec3 p, float fpRad, float mare, vec3 Ls, inout CraterAcc acc) {
  float ns = dot(Ls, p);
  vec3 sT = Ls - p * ns;
  float ls = length(sT);
  sT /= max(ls, 1e-6);
  float tanS = ns / max(ls, 1e-6);
  const float C0 = 52.0 / 1737.4;                         // level-0 cell (radians)
  float cellRad = C0, fade = 1.0, amp = 1.0;
  vec3 X = p / C0, b0 = floor(X);
  for (int it = 0; it < uLoopMax * 8; it++) {
    if (it >= 270) break;
    int L = it / 27, k = it - L * 27;
    if (k == 0) {
      cellRad = C0 * exp2(-float(L));
      fade = smoothstep(1.0, 2.6, cellRad * 0.28 / fpRad);   // largest crater radius vs pixel footprint
      if (fade <= 0.0) break;                             // finer levels are unresolved too
      X = p / cellRad;
      b0 = floor(X);
      amp = fade * mix(1.0, 0.45, float(L) / 9.0);        // the smallest are mostly mantled by regolith
    }
    vec3 cell = b0 + vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec3 h = hash33(cell + float(L) * 17.13);
    vec3 cp = cell + h;
    float rl = length(cp);
    vec3 dv = p / cellRad - cp / rl * (1.0 / cellRad);   // to the centre projected onto the sphere, in cells
    float u1 = fract(h.z * 17.31 + h.x * 3.7);
    // radius in cells: p(r) ~ r^-3 on [0.14, 0.28]; the crater's influence (rim, ejecta blanket, halo, shadow) ends at
    // XO = 1.75 radii = 0.49 cell, with zero height AND slope there (a profile whose slope did not vanish at the cut-off
    // drew every crater's influence circle as a flat, hard-edged "pad")
    float r = 0.28 * inversesqrt(4.0 - 3.0 * u1);
    float x = length(dv) / r;
    if (abs(rl - 1.0 / cellRad) > 0.5 || x > 1.75) continue;
    // existence, decided at the crater's own centre (a per-pixel density would cut craters along its contours):
    // saturated highlands, clustered (density noise at ~6 cells: clumps and empty patches)
    if (fract(h.x * 5.31 + h.y * 2.77) > 0.92 * (0.25 + 1.5 * smoothstep(-0.45, 0.45, tn(cp * 0.16 + float(L) * 3.7).x))) continue;
    // maria (younger, flooded surfaces): ~60 % of the population is absent; across a mare boundary a crater is buried
    // gradually (shallower toward the mare) instead of being cut
    float buried = smoothstep(0.58 * mare - 0.12, 0.58 * mare + 0.12, fract(h.y * 3.17 + h.z * 8.39));
    // slightly irregular rims (a noise of the crater-relative position), rare oblique-impact ellipticity
    float u2 = fract(h.x * 41.7 + h.y * 9.3), u3 = fract(h.y * 23.1 + h.z * 7.7);
    vec3 dvn = dv / max(length(dv), 1e-9);
    vec3 hd = h - 0.5, hd2 = fract(h * 7.3) - 0.5;
    float dh = dot(dvn, hd), dh2 = dot(dvn, hd2);
    x *= 1.0 + 0.12 * (dh * dh2 - 0.04) + 0.06 * dh2 + 0.16 * u3 * u3 * u3 * u3 * dh + 0.02 * sin(13.0 * dh - 17.0 * dh2 + 30.0 * u3);
    // degradation: 1 = fresh .. 0 = old; small craters are erased faster. Most of the population is subdued: shallow
    // rimless dimples whose walls never exceed a low sun's elevation (soft shading, no shadow); a minority keep a bowl
    // deep enough to hold a shadow; a few per cent are crisp, with a raised sharp rim and bright immature ejecta.
    float fresh = pow(u2, mix(3.6, 6.5, float(L) / 9.0));
    float deep = pow(u2, mix(2.3, 3.8, float(L) / 9.0));          // depth retained (the bowl fills in more slowly than the rim wears)
    float rc = r * cellRad;                               // radius (radians)
    float Dkm = 2.0 * rc * 1737.4;
    // fresh depth / diameter and rim height / diameter (simple -> complex, Pike 1977), in units of the radius
    float dDf = Dkm < 15.0 ? 0.2 : clamp(1.044 * pow(Dkm, -0.699), 0.08, 0.2);
    float hRf = Dkm < 15.0 ? 0.04 : clamp(0.236 * pow(Dkm, -0.601), 0.02, 0.04);
    float Hr = 2.0 * mix(0.0015, hRf, fresh);                      // rim height / r
    float Dp = max(2.0 * mix(0.022, dDf, deep) - Hr, 0.0);          // floor depth below the old surface / r
    float xf = Dkm < 12.0 ? 0.35 * (1.0 - fresh) : mix(0.65, 0.5, fresh) * smoothstep(8.0, 20.0, Dkm);  // flat or infilled floor
    float Hp = Dp * 0.4 * smoothstep(16.0, 26.0, Dkm) * (0.4 + 0.6 * fresh);   // central peak
    // profile h(x) = Hr E(x) - Dp B(x) + peak:
    //   B = (1 - x^2)^pw inside the rim: a parabolic bowl with walls steep right up to the crest when fresh (pw 1),
    //       a rounded dish that meets the surface tangentially when old (pw 2); flat inside xf
    //   E = x^2 inside (the uplifted rim flank), ((XO - x) / (XO - 1))^2 outside (ejecta blanket): a crest at x = 1
    float pw = mix(2.0, 1.0, smoothstep(0.0, 0.55, fresh));
    //   (old rims are rounded on both flanks - smoothstep shapes with zero slope at the crest; a one-sided crest
    //   shaded an infilled crater as a raised puck)
    float xc = clamp(x, xf, 1.0), on = 1.0 / (1.0 - xf * xf), om = max((1.0 - xc * xc) * on, 1e-4);
    float Bz = pow(om, pw), dB = x > xf && x < 1.0 ? -2.0 * pw * xc * on * pow(om, pw - 1.0) : 0.0;
    float q = max(1.75 - x, 0.0) / 0.75, sharp = 2.0 - pw;
    float xi = min(x, 1.0), ss = x < 1.0 ? xi : q;
    float Ez = ss * ss * mix(3.0 - 2.0 * ss, 1.0, sharp);
    float dE = mix(6.0 * ss * (1.0 - ss), 2.0 * ss, sharp) * (x < 1.0 ? 1.0 : -1.0 / 0.75);
    // (the crest's slope reversal is filtered once the rim zone is narrower than the footprint)
    float crest = smoothstep(0.0, 1.0, abs(x - 1.0) * rc / (1.5 * fpRad));
    float pk = Hp * exp(-x * x / 0.03);
    float fz = Hr * Ez - Dp * Bz + pk;
    float fd = (Hr * dE - Dp * dB) * mix(0.35, 1.0, crest) - pk * x / 0.015;
    float ampC = amp * buried;
    acc.grad += dvn * fd * ampC;
    // brightness: immature (fresh) walls and ejecta are bright - a halo that fades over one radius beyond the rim,
    // broken into rays - old craters blend in
    float ray = 0.5 + 0.5 * sin(19.0 * dh + 27.0 * dh2 + 40.0 * u3);
    // (concentrated in the freshest few per cent: at a high sun those bright-haloed craters are what one sees)
    acc.alb += fresh * fresh * (3.0 - 2.0 * fresh) * fade * buried * (0.4 * (1.0 - smoothstep(0.9, 1.15, x)) + 0.55 * min(q * q, 1.0) * (0.3 + 0.7 * ray * ray));
    // rim shadow: the sun ray from this point toward the Sun's azimuth leaves the crater through the rim at distance t
    vec3 xv = dv * (x / max(length(dv), 1e-12));
    float bq = dot(xv, sT), cc = dot(xv, xv) - 1.0, disc = bq * bq - cc;
    float t = cc < 0.0 ? -bq + sqrt(max(disc, 0.0)) : (bq < 0.0 ? -bq - sqrt(max(disc, 0.0)) : -1.0);
    if (disc > 0.0 && t > 0.0 && tanS < 2.0) {
      // (a mantled crater is a shallower crater: its heights scale with the amplitude, so its shadow is SMALLER, not
      // fainter - a faded full-size shadow drew old craters as flat grey discs)
      float need = (Hr - fz) / t * ampC;
      float pen = 0.0046 + min(0.25 * fpRad / rc, 0.06) + 0.7 * (abs(fd) + abs(need)) * fpRad / (rc * max(t, 0.15));
      float sh = mix(smoothstep(-pen, pen, tanS - need), 1.0, smoothstep(1.4, 1.75, x));
      acc.shadow = min(acc.shadow, mix(1.0, sh, fade));
      acc.bounce = max(acc.bounce, (1.0 - sh) * fade * step(x, 1.0));
    }
  }
}

// ---------------------------------------------------------------- photometry
// lunar-Lambert (McEwen 1991) with a Hapke-style opposition surge; returns reflectance in contract units
// (a white Lambertian surface lit at normal incidence = 1)
float lunarPhotometry(float mu0, float mu, float alpha) {
  if (mu0 <= 0.0) return 0.0;
  float aD = alpha * (180.0 / PI);
  float Lp = clamp(1.0 - 0.019 * aD + 2.42e-4 * aD * aD - 1.46e-6 * aD * aD * aD, 0.0, 1.0);
  float ls = 2.0 * mu0 / (mu0 + max(mu, 0.0) + 1e-4);
  float ca = cos(alpha);
  float B = 1.0 / (1.0 + sqrt(max(1.0 - ca, 0.0) / max(1.0 + ca, 1e-3)) / 0.06);   // opposition surge (B0 = 1), tan(a/2)
  return (Lp * ls + (1.0 - Lp) * mu0) * (1.0 + B) * 0.5 * exp(-0.34 * alpha);
}

// fraction of the solar disc not blocked by the Earth (lunar eclipse) + umbra reddening by refraction
vec3 earthShadow(vec3 P, vec3 sunDir) {
  vec3 toE = uEarthPosB - P;
  float dE = length(toE);
  // (small angles: the Earth is ~1 deg across from the Moon, the Sun 0.5 deg; sin ~ angle to 0.01 %)
  float angE = uEarthR * 1.02 / dE;                               // ~2% for the atmosphere
  float sep = dot(toE, sunDir) > 0.0 ? length(cross(toE / dE, sunDir)) : 1.0;
  float rs = uSunAngR;
  if (sep >= rs + angE) return vec3(1.0);
  float vis = clamp((sep - (angE - rs)) / (2.0 * rs), 0.0, 1.0);
  return mix(vec3(0.012, 0.0035, 0.0012), vec3(1.0), vis * vis * (3.0 - 2.0 * vis));
}

void main() {
  vec3 P = vPosB;
  vec3 p = normalize(P);
  vec3 V = normalize(transpose(uB2W) * (-vPosW));
  vec2 uv = dirToUV(p);
  vec2 gdx = dFdx(uv), gdy = dFdy(uv);
  gdx.x -= floor(gdx.x + 0.5); gdy.x -= floor(gdy.x + 0.5);
  // pixel footprint: fwidth, clamped to the analytic range [d * pixel angle, d * pixel angle / mu] (at ridge
  // silhouettes a 2x2 quad spans near and far terrain and fwidth explodes)
  float muG = abs(dot(p, V));
  float fpA = length(vPosW) * vPixAng;
  float fwP = length(fwidth(P));
  vec3 Ls = uSunDirB;
  vec3 Le = normalize(uEarthPosB - P);

  // ---- albedo: LRO WAC colour, contrast reduced to the true maria / highland ratio (~2.2), lunar albedo, reddish grey
  vec3 col = textureGrad(uColor, uv, gdx, gdy).rgb;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  float mare = smoothstep(0.22, 0.12, lum);
  // (exponent 0.62: highlands ~0.23, maria ~0.09, ray systems ~0.3 - the 0.48 of earlier rounds flattened the rays
  // of Jackson, Tycho and Giordano Bruno into the highlands; a near-neutral grey with the soil's slight warmth)
  float aL = dot(pow(max(col, vec3(1e-4)), vec3(0.62)), vec3(0.2126, 0.7152, 0.0722)) * 0.4256;
  vec3 alb = aL * mix(vec3(1.065, 0.995, 0.895), vec3(1.05, 0.995, 0.91), mare);

  // ---- LOLA normal (C2 B-spline), sphere-aware; near the poles (the equirectangular u-derivative blows up) isotropic
  // differences of mip-filtered heights along a regular tangent frame
  // ---- LOLA (C2 B-spline, exact texelFetch weights: hardware bilinear weights are 8-bit and stair-step grazing
  // shadow edges) at the pixel, and the horizon march toward the key light, in one loop so the B-spline code is
  // compiled once: iteration 0 is the pixel itself, then distance-proportional steps (near samples B-spline, far ones
  // mip-filtered); penumbra = the sun's disc + the sample's own height uncertainty
  const float Rkm = 1737.4;
  float sunUp = dot(p, Ls);
  vec3 key = sunUp > -0.08 ? Ls : Le;
  float keyShadow = 1.0;
  vec3 hb = vec3(0.0);
  {
    vec3 kT = key - p * dot(key, p);
    float kl = length(kT);
    float tanK = dot(key, p) / max(kl, 1e-4);
    bool march = kl > 1e-4 && tanK < 0.6;
    kT /= max(kl, 1e-4);
    float fpK = clamp(fwP, fpA, fpA / max(muG, 0.02)) / KM;
    float s = max(1.6, fpK * 1.5);
    bool hiQ = uDetail > 0.5;
    for (int k = 0; k < uLoopMax; k++) {
      if (k >= 23 || s > 350.0 || (k == 1 && !march)) break;
      vec2 uq = k == 0 ? uv : dirToUV(normalize(p + kT * (s / Rkm)));
      vec3 hq = k == 0 || (hiQ && s < 40.0) ? lolaBspline(uq) : vec3(heightKm(textureLod(uHeight, uq, log2(max(s * 0.3 / 5.3, 1.0)) + 0.5).r));
      if (k == 0) { hb = hq; continue; }
      float pen = 0.0047 + 0.3 / s + 0.6 * fpK / s;
      keyShadow = min(keyShadow, smoothstep(-pen, pen, tanK - (hq.x - hb.x - s * s / (2.0 * Rkm)) / s));
      s *= 1.28;
    }
  }
  float cl = max(sqrt(1.0 - p.y * p.y), 1e-3);
  vec3 eastU = (abs(p.y) > 0.9995) ? vec3(0.0, 0.0, -1.0) : normalize(cross(vec3(0.0, 1.0, 0.0), p));
  vec3 northU = cross(p, eastU);
  vec3 grad = eastU * (hb.y / (2.0 * PI) / (Rkm * cl)) + northU * (hb.z / PI / Rkm);
  float polar = smoothstep(0.95, 0.985, abs(p.y));
  if (polar > 0.0) {
    vec3 Ta = normalize(cross(abs(p.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0), p)), Tb = cross(p, Ta);
    float e = 2.0 * PI / 1024.0;
    float rxz = max(p.x * p.x + p.z * p.z, 1e-6);
    vec2 duA = vec2((p.z * Ta.x - p.x * Ta.z) / rxz * (0.5 / PI), Ta.y * inversesqrt(rxz) / PI) * e;
    vec2 duB = vec2((p.z * Tb.x - p.x * Tb.z) / rxz * (0.5 / PI), Tb.y * inversesqrt(rxz) / PI) * e;
    float h0 = textureLod(uHeight, uv, 1.0).r;
    vec3 gp = (Ta * (textureLod(uHeight, uv + duA, 1.0).r - h0) + Tb * (textureLod(uHeight, uv + duB, 1.0).r - h0)) * ((H_MAX - H_MIN) / (e * Rkm));
    grad = mix(grad, gp, polar);
  }
  // footprint: the obliquity bound uses the LOLA-sloped surface (a ridge back facing away is seen far more obliquely
  // than the sphere normal says)
  float muL = abs(dot(normalize(p - (grad - p * dot(grad, p))), V));
  float fpW = clamp(fwP, fpA, fpA / max(min(muG, muL), 0.01));
  float fpRad = fpW / uR, fpKm = fpW / KM;

  // ---- procedural relief below the LOLA / LRO texel scale (~5 km): craters, ridged relief, gentle regolith texture
  CraterAcc acc;
  acc.grad = vec3(0.0); acc.shadow = 1.0; acc.alb = 0.0; acc.bounce = 0.0;
  float detail = uDetail;
  if (detail > 0.0) {
    craterField(p, fpRad, mare, Ls, acc);
    grad += acc.grad * detail;
    vec4 rl = moonRelief(p, max(fpKm * 2.5, 0.12));
    grad += (rl.yzw - p * dot(rl.yzw, p)) * (detail / Rkm) * mix(1.0, 0.45, mare);
    // regolith: soft albedo mottling (ray streaks, maturity) and very gentle undulation; no sub-100 m stipple
    // (soil maturity / composition patches at 2-12 km: the sub-km albedo octaves of earlier rounds read as stipple)
    vec4 a1 = tn(p * 310.0 + 3.7), a2 = tn(NOISE3_ROT * p * 1150.0);
    float w1 = clamp(0.4 / (310.0 * fpRad) - 0.6, 0.0, 1.0), w2 = clamp(0.4 / (1150.0 * fpRad) - 0.6, 0.0, 1.0);
    alb *= 1.0 + (a1.x * 0.09 * w1 + a2.x * 0.05 * w2 + acc.alb) * detail;
  }
  grad -= p * dot(grad, p);
  vec3 N = normalize(p - grad);

  float shS = (sunUp > -0.08 ? keyShadow : 1.0) * mix(1.0, acc.shadow, detail);
  float shE = sunUp > -0.08 ? 1.0 : keyShadow;

  // ---- lighting
  float mu = dot(N, V);
  float alphaS = acos(clamp(dot(Ls, V), -1.0, 1.0));
  float sunVis = smoothstep(-uSunAngR, uSunAngR, sunUp);
  // soft local terminator: sub-pixel relief and the sun's disc make the N.L = 0 crossing a ramp, not a step
  float ndlS = dot(N, Ls);
  float mu0S = 0.5 * (ndlS + sqrt(ndlS * ndlS + 0.0025));
  vec3 eSh = earthShadow(P, Ls);
  vec3 Lsun = alb * lunarPhotometry(mu0S, mu, alphaS) * shS * sunVis * eSh;
  // earthshine: its own light direction and shadows; Earth's disc is 2 deg wide and the light is already multiply
  // scattered at these low levels, so a softer phase law than the sun's
  float mu0E = max(dot(N, Le), 0.0);
  vec3 Learth = alb * (mu0E / (mu0E + max(mu, 0.0) + 1e-4) + 0.5 * mu0E) * (0.35 + 0.65 * pow(0.5 + 0.5 * dot(Le, V), 0.55)) * shE * uEarthshine;
  // light reflected into shadows by the surrounding sunlit terrain: under 1 % generally, ~3 % inside a shadowed crater
  // bowl (its own sunlit far wall faces it): lunar shadows are black in every orbital photograph, and at a grazing sun
  // seen at high phase the lit ground itself is only ~1 % - a brighter fill drew shadowed craters as grey pucks
  // (proportional to the irradiance on the surrounding ground: at a low sun the shadows are near black against it)
  vec3 Lbounce = alb * ((0.007 + 0.022 * acc.bounce * detail) * min(2.4 * clamp(sunUp, 0.0, 1.0), 1.0) * smoothstep(-0.01, 0.03, sunUp)) * eSh;
  vec3 L = Lsun + Learth + Lbounce;
  if (uDebug == 11) L = vec3(shS);
  if (uDebug == 12) L = N * 0.5 + 0.5;
  if (uDebug == 13) L = vec3(acc.shadow);
  gl_FragColor = vec4(L, 1.0);
}
`;
