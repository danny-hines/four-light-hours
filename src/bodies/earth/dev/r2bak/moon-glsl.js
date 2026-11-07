// Moon shaders.
//
// Geometry: a view-dependent polar grid centred on the sub-camera point (rings uniform in camera nadir angle, then
// uniform in central angle out past the horizon), displaced by LOLA heights in the vertex shader. This gives a true
// rugged horizon in the Earthrise shot from 15-50 km up, and a perfectly tessellated limb for the full disc, at a
// fixed cost.
// Shading: LRO WAC colour (contrast-corrected to true lunar albedo), C2 B-spline LOLA normals, an analytic multi-
// scale crater field (cube-face cells, equal-angle, seam-exact) with analytic crater shadows, LOLA horizon-march
// terrain shadows, lunar-Lambert/Hapke-lite photometry with opposition surge, earthshine and Earth's umbra.
import { NOISE_GLSL } from '../../glsl/noise.js';
import { NOISE_D_GLSL } from './noise-d.js';

const MOON_RELIEF = /* glsl */ `
// Procedural relief below the LOLA resolution (~5 km): ridged multi-scale noise, ~160 m at 14 km down to ~10 m at
// 1 km, displacing the geometry too so the horizon silhouette is rugged rather than blob-like. Octaves fade by the
// local mesh resolution (lmin = shortest wavelength resolved, km). Returns vec4(height km, d h / d p (km per radian)).
vec4 moonRelief(vec3 p, float lmin) {
  vec4 s = vec4(0.0);
  float f = 1737.4 / 14.0, a = 0.16;
  for (int i = 0; i < uLoopMax; i++) {
    if (i >= 5) break;
    float lam = 1737.4 / f;                              // wavelength km
    float w = smoothstep(lmin, 2.0 * lmin, lam);
    if (w <= 0.0) break;
    vec4 n = snoised(p * f + float(i) * vec3(3.1, 7.7, 1.3));
    // ridged, with a rounded crest (smooth |x|): a true crease flips the normal within one pixel and aliases
    // into jagged lit / unlit edges at low sun; the rounding fades in as the octave approaches the resolution limit
    float k = mix(0.12, 0.5, 1.0 - w);
    float sa = sqrt(n.x * n.x + k * k);
    float r = 1.0 + k - sa;
    s += w * a * vec4(r * r - 0.45, 2.0 * r * (-n.x / sa) * n.yzw * f);
    f *= 2.2;
    a *= 0.34;                                           // regolith-mantled: smoother toward small scales
  }
  return s;
}
`;

const MOON_COMMON = /* glsl */ `
#define PI 3.14159265359
uniform sampler2D uHeight;     // LOLA, 0..1 -> H_MIN..H_MAX km
uniform float uR;              // mean radius (scene units)
#define H_MIN (-8.8134)
#define H_MAX (10.6398)
#define KM (1.0 / 6371.0)
vec2 dirToUV(vec3 d) {
  float lon = atan(-d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2(lon * (0.5 / PI) + 0.5, lat / PI + 0.5);
}
float heightKm(float v) { return H_MIN + v * (H_MAX - H_MIN); }
// ---------------------------------------------------------------- C2 cubic B-spline LOLA height + gradient
// returns vec3(height km, dh/du, dh/dv) in km per texture-uv unit; 16 texel fetches, smooth everywhere
vec3 lolaBspline(vec2 uv) {
  ivec2 sz = textureSize(uHeight, 0);
  vec2 st = uv * vec2(sz) - 0.5;
  vec2 i0 = floor(st);
  vec2 f = st - i0;
  vec4 wx, wy, dx, dy;
  {
    vec2 f2 = f * f, f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;
    vec2 d0 = (-1.0 + 2.0 * f - f2) / 2.0;
    vec2 d1 = (-4.0 * f + 3.0 * f2) / 2.0;
    vec2 d2 = (1.0 + 2.0 * f - 3.0 * f2) / 2.0;
    vec2 d3 = f2 / 2.0;
    wx = vec4(w0.x, w1.x, w2.x, w3.x); wy = vec4(w0.y, w1.y, w2.y, w3.y);
    dx = vec4(d0.x, d1.x, d2.x, d3.x); dy = vec4(d0.y, d1.y, d2.y, d3.y);
  }
  float h = 0.0, hu = 0.0, hv = 0.0;
  for (int y = 0; y < 4; y++) {
    int ty = clamp(int(i0.y) - 1 + y, 0, sz.y - 1);
    float row = 0.0, rowd = 0.0;
    for (int x = 0; x < 4; x++) {
      int tx = int(i0.x) - 1 + x;
      tx = tx - sz.x * int(floor(float(tx) / float(sz.x)));
      float v = texelFetch(uHeight, ivec2(tx, ty), 0).r;
      row += v * wx[x];
      rowd += v * dx[x];
    }
    h += row * wy[y];
    hu += rowd * wy[y];
    hv += row * dy[y];
  }
  float s = H_MAX - H_MIN;
  return vec3(H_MIN + h * s, hu * s * float(sz.x), hv * s * float(sz.y));
}

`;

export const MOON_VERT = /* glsl */ `
${MOON_COMMON}
${NOISE_GLSL}
${NOISE_D_GLSL}
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
uniform int uDebugV;
void main() {
  float D = length(uCamB);
  vec3 c = uCamB / D;
  vec3 e1 = normalize(cross(abs(c.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), c));
  vec3 e2 = cross(c, e1);
  float i = grid.x;
  float th;
  if (i <= uNa) {
    float a = uAlphaA * (i / uNa);
    th = asin(min(D * sin(a) / uR, 1.0)) - a;
  } else {
    th = uThetaS + (uThetaMax - uThetaS) * ((i - uNa) / uNt);
  }
  vec3 dir = c * cos(th) + (e1 * cos(grid.y) + e2 * sin(grid.y)) * sin(th);
  float h = lolaBspline(dirToUV(dir)).x * KM;   // C2-smooth heights: no 8-bit terraces on ridgelines
  // + sub-LOLA relief, only at wavelengths >= ~4x the local mesh spacing (ring spacing; the azimuthal spacing is
  // finer), so the displaced silhouette never aliases into jagged facets
  float dth;
  if (i < uNa) {
    float a1 = uAlphaA * ((i + 1.0) / uNa);
    dth = abs(asin(min(D * sin(a1) / uR, 1.0)) - a1 - th);
  } else {
    dth = (uThetaMax - uThetaS) / uNt;
  }
  float spacingKm = dth * 1737.4;
  h += uDebugV == 19 ? 0.0 : moonRelief(dir, max(4.0 * spacingKm, 0.6)).x * KM;
  vPosB = dir * (uR + h);
  vPosW = uB2W * vPosB + uCenterW;
  vPixAng = 2.0 / (projectionMatrix[1][1] * uResolution.y);
  gl_Position = projectionMatrix * viewMatrix * vec4(vPosW, 1.0);
}
`;

export const MOON_FRAG = /* glsl */ `
${MOON_COMMON}
${NOISE_GLSL}
${NOISE_D_GLSL}
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

// ---------------------------------------------------------------- analytic crater field
vec3 hash3(vec3 p) { return hash33(p); }
// equal-angle cube face coordinates
void faceCoords(vec3 p, out int face, out vec2 uv) {
  vec3 a = abs(p);
  vec2 q;
  if (a.x >= a.y && a.x >= a.z) { face = p.x > 0.0 ? 0 : 1; q = vec2(p.y, p.z) / a.x; }
  else if (a.y >= a.z) { face = p.y > 0.0 ? 2 : 3; q = vec2(p.z, p.x) / a.y; }
  else { face = p.z > 0.0 ? 4 : 5; q = vec2(p.x, p.y) / a.z; }
  uv = atan(q) * (4.0 / PI);
}
vec2 projectToFace(vec3 p, int face) {
  vec2 q;
  if (face < 2) q = vec2(p.y, p.z) / abs(p.x);
  else if (face < 4) q = vec2(p.z, p.x) / abs(p.y);
  else q = vec2(p.x, p.y) / abs(p.z);
  return atan(q) * (4.0 / PI);
}
vec3 faceDir(int face, vec2 uv) {
  vec2 q = tan(uv * (PI / 4.0));
  float s = (face == 0 || face == 2 || face == 4) ? 1.0 : -1.0;
  vec3 d;
  if (face < 2) d = vec3(s, q.x, q.y);
  else if (face < 4) d = vec3(q.y, s, q.x);
  else d = vec3(q.x, q.y, s);
  return normalize(d);
}

struct CraterAcc { vec3 grad; float shadowS; float shadowE; float albedo; float h; vec3 dbg; };

// one face, one level: 2x2 cells around p (exact because a crater's influence <= 0.5 cell)
void cratersOnFace(vec3 p, int face, vec2 uv, float cellUV, float cellRad, float lvl, float density, float fade,
                   vec3 sT, float tanS, vec3 eT, float tanE, float penS, float fpR, inout CraterAcc acc) {
  vec2 g = uv / cellUV - 0.5;
  vec2 base = floor(g);
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    vec2 cell = base + vec2(float(i), float(j));
    vec3 h = hash3(vec3(cell, float(face) * 7.13 + lvl * 13.71));
    if (h.z > density) continue;
    vec2 cuv = (cell + h.xy) * cellUV;                     // full-cell jitter: no polka-dot regularity
    if (abs(cuv.x) > 1.0 || abs(cuv.y) > 1.0) continue;    // owned by another face
    vec3 c3 = faceDir(face, cuv);
    // size within the level: bias toward small (steep size-frequency distribution)
    float sz = fract(h.z * 17.31 + h.x * 3.7);
    float r = cellRad * mix(0.12, 0.32, sz * sz);
    vec3 dv = p - c3;
    if (dot(dv, dv) > 3.7 * r * r) continue;
    // irregular, slightly polygonal, sometimes elliptical (oblique impacts) rims
    vec3 e1 = normalize(cross(abs(c3.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), c3));
    vec3 e2 = cross(c3, e1);
    float ea = fract(h.y * 23.1 + h.z * 7.7) * 3.1416;
    vec3 ax = e1 * cos(ea) + e2 * sin(ea);
    float ell = 1.0 + 0.28 * pow(fract(h.x * 13.3 + h.z * 5.1), 3.0);   // most round, a few up to 1.28:1
    float along = dot(dv, ax);
    vec3 dvE = dv + ax * along * (1.0 / ell - 1.0);
    float x = length(dvE) / r;
    if (x > 1.5) continue;
    dv = dvE;
    // age: the large majority are degraded (shallow, softened, rimless), a few percent fresh (deep, sharp, bright)
    float age = fract(h.x * 41.7 + h.y * 9.3);
    float deg = pow(age, 3.2);
    float fresh = smoothstep(0.82, 0.96, deg);
    float ph = atan(dot(dv, e2), dot(dv, e1));
    float wob = 0.5 * sin(3.0 * ph + h.x * 6.28) + 0.3 * sin(5.0 * ph + h.y * 6.28) + 0.2 * sin(9.0 * ph + h.z * 40.0);
    x *= 1.0 + 0.055 * wob * (0.6 + 0.4 * deg);
    float Dp = 0.40 * mix(0.07, 1.0, deg);          // rim-to-floor depth / radius (d/D = 0.2 when fresh)
    float Hr = 0.07 * mix(0.08, 1.0, deg * deg);    // rim height / radius: degraded rims are almost gone
    float k = mix(0.30, 0.035, deg) + min(0.6 * fpR / r, 0.05);   // rim rounding (+ a little footprint filtering)
    // profile: smooth-min of a parabolic bowl and an x^-3 ejecta blanket (rounded crest, no seams)
    float bowl = Hr + Dp * (x * x - 1.0), dbowl = 2.0 * Dp * x;
    float ix = 1.0 / max(x, 0.3);
    float win = smoothstep(1.5, 1.1, x);
    float ej = Hr * ix * ix * ix * win, dej = -3.0 * Hr * ix * ix * ix * ix * win;
    float hh = clamp(0.5 + 0.5 * (ej - bowl) / k, 0.0, 1.0);
    float f = mix(ej, bowl, hh) - k * hh * (1.0 - hh);
    float fd = mix(dej, dbowl, hh);
    float rimH = Hr - 0.25 * k;
    float amp = fade * mix(1.0, 0.4, lvl / 7.0);   // the smallest craters are mostly buried in regolith
    vec3 ur = dv / max(length(dv), 1e-9);
    acc.grad += ur * fd * amp;
    acc.h += f * r * amp;
    // brightness: fresh craters and their ejecta are bright, old ones blend in
    acc.albedo += fresh * fade * (x < 1.0 ? 0.18 : 0.26 * smoothstep(1.5, 1.0, x));
    // analytic shadow cast by the sunward rim (inside the bowl) or the near rim (just outside, downsun)
    vec3 xv = dv * (x / max(length(dv), 1e-12));    // wobbled radius, so shadows follow the irregular rim
    float b = dot(xv, sT), cc = dot(xv, xv) - 1.0;
    float disc = b * b - cc;
    if (disc > 0.0 && tanS < 2.0) {
      float t = cc < 0.0 ? -b + sqrt(disc) : (b < 0.0 ? -b - sqrt(disc) : -1.0);
      if (t > 0.0) {
        float need = (rimH - f) / t;
        // analytic anti-aliasing: how much 'need' changes across one pixel
        float pen = penS + 0.7 * (abs(fd) + abs(need)) * fpR / (r * max(t, 0.15));
        float sh = smoothstep(-pen, pen, tanS - need);
        sh = mix(sh, 1.0, smoothstep(1.3, 1.5, x));       // no hard cut where the crater's influence ends
        acc.shadowS = min(acc.shadowS, mix(1.0, sh, amp));
      }
    }
    b = dot(xv, eT);
    disc = b * b - cc;
    if (disc > 0.0 && tanE < 2.0) {
      float t = cc < 0.0 ? -b + sqrt(disc) : (b < 0.0 ? -b - sqrt(disc) : -1.0);
      if (t > 0.0) {
        float need = (rimH - f) / t;
        float sh = mix(smoothstep(-0.03, 0.03, tanE - need), 1.0, smoothstep(1.3, 1.5, x));
        acc.shadowE = min(acc.shadowE, mix(1.0, sh, amp));
      }
    }
  }
}

void craterField(vec3 p, float fpRad, float mare, vec3 Ls, vec3 Le, inout CraterAcc acc) {
  int face; vec2 uv;
  faceCoords(p, face, uv);
  // light directions in the local tangent plane, and their elevations
  float ns = dot(Ls, p), ne = dot(Le, p);
  vec3 sT = Ls - p * ns; float ls = length(sT); sT /= max(ls, 1e-6); float tanS = ns / max(ls, 1e-6);
  vec3 eT = Le - p * ne; float le = length(eT); eT /= max(le, 1e-6); float tanE = ne / max(le, 1e-6);
  float cellRad = 18.0 / 1737.4;                     // level 0 cells: 18 km
  for (int L = 0; L < 8; L++) {
    float rMax = cellRad * 0.32;
    float fade = smoothstep(1.2, 3.0, rMax / fpRad);   // crater radius vs pixel footprint
    if (fade <= 0.0) break;
    float cellUV = cellRad / (PI / 4.0);
    // maria are younger: fewer craters at every size
    float density = mix(0.95, 0.42, mare);
    float penS = 0.0045 + min(0.25 * fpRad / rMax, 0.06);   // sun's disc + pixel footprint
    cratersOnFace(p, face, uv, cellUV, cellRad, float(L), density, fade, sT, tanS, eT, tanE, penS, fpRad, acc);
    // seams: also evaluate neighbouring faces' craters that reach across the edge
    float band = 0.5 * cellUV + 0.002;
    if (abs(uv.x) > 1.0 - band) {
      int nf = (face < 2) ? (uv.x > 0.0 ? 2 : 3) : (face < 4) ? (uv.x > 0.0 ? 4 : 5) : (uv.x > 0.0 ? 0 : 1);
      cratersOnFace(p, nf, projectToFace(p, nf), cellUV, cellRad, float(L), density, fade, sT, tanS, eT, tanE, penS, fpRad, acc);
    }
    if (abs(uv.y) > 1.0 - band) {
      int nf = (face < 2) ? (uv.y > 0.0 ? 4 : 5) : (face < 4) ? (uv.y > 0.0 ? 0 : 1) : (uv.y > 0.0 ? 2 : 3);
      cratersOnFace(p, nf, projectToFace(p, nf), cellUV, cellRad, float(L), density, fade, sT, tanS, eT, tanE, penS, fpRad, acc);
    }
    cellRad *= 0.5;
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
  float B = 1.0 / (1.0 + tan(min(alpha, 3.0) * 0.5) / 0.06);       // shadow-hiding opposition surge (B0 = 1)
  float f = (1.0 + B) * 0.5 * exp(-0.42 * alpha);
  return (Lp * ls + (1.0 - Lp) * mu0) * f;
}

// fraction of the solar disc not blocked by the Earth (lunar eclipse) + umbra reddening by refraction
vec3 earthShadow(vec3 P, vec3 sunDir) {
  vec3 toE = uEarthPosB - P;
  float dE = length(toE);
  float angE = asin(clamp(uEarthR * 1.02 / dE, 0.0, 1.0));     // ~2% for the atmosphere
  float sep = atan(length(cross(toE / dE, sunDir)), dot(toE / dE, sunDir));
  float rs = uSunAngR;
  if (sep >= rs + angE) return vec3(1.0);
  float vis = clamp((sep - (angE - rs)) / (2.0 * rs), 0.0, 1.0);
  vis = vis * vis * (3.0 - 2.0 * vis);
  // light refracted through Earth's atmosphere tints the umbra copper-red
  vec3 umbra = vec3(0.012, 0.0035, 0.0012);
  return mix(umbra, vec3(1.0), vis);
}

void main() {
  vec3 P = vPosB;
  vec3 p = normalize(P);
  vec3 V = normalize(transpose(uB2W) * (-vPosW));
  vec2 uv = dirToUV(p);
  vec2 gdx = dFdx(uv), gdy = dFdy(uv);
  gdx.x -= floor(gdx.x + 0.5); gdy.x -= floor(gdy.x + 0.5);
  // pixel footprint: fwidth, clamped to the analytic range [d * pixel angle, d * pixel angle / mu]. At the
  // silhouettes of ridges a 2x2 pixel quad spans near and far terrain and fwidth explodes, which switched the
  // detail off in 2x2 blocks (jagged dashes along every ridge line at low sun).
  float muG = abs(dot(p, normalize(transpose(uB2W) * (-vPosW))));
  float fpA = length(vPosW) * vPixAng;
  float fwP = length(fwidth(P));
  float fpW = clamp(fwP, fpA, fpA / max(muG, 0.02));
  float fpRad = fpW / uR;
  float fpKm = fpW / KM;

  vec3 Ls = uSunDirB;
  vec3 toE = uEarthPosB - P;
  vec3 Le = normalize(toE);

  // ---- albedo: LRO WAC colour, contrast reduced to the true maria / highland ratio (~2.5), scaled to lunar albedo
  vec3 col = textureGrad(uColor, uv, gdx, gdy).rgb;
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // LRO WAC mosaic (linear): maria 0.055-0.11, highlands 0.31-0.36 -> true normal albedo (maria ~0.065-0.09,
  // highlands ~0.16, a ratio of ~2-2.5 as measured, not the mosaic's stretched ~5)
  vec3 alb = pow(max(col, vec3(1e-4)), vec3(0.48)) * 0.264;
  float mare = smoothstep(0.22, 0.12, lum);
  // a touch of the real hue: maria slightly blue-grey (titanium), highlands warm grey
  alb *= mix(vec3(1.02, 1.0, 0.96), vec3(0.96, 0.99, 1.04), mare);

  // ---- LOLA normal (C2 B-spline), sphere-aware
  vec3 hb = lolaBspline(uv);
  float cl = max(sqrt(1.0 - p.y * p.y), 1e-3);
  // texture u grows with east longitude (lon = atan(-z, x)): east = up x p, north = p x east
  vec3 eastU = (abs(p.y) > 0.9995) ? vec3(0.0, 0.0, -1.0) : normalize(cross(vec3(0.0, 1.0, 0.0), p));
  vec3 northU = cross(p, eastU);
  // dh/dlon = hu / (2 pi), dh/dlat = hv / pi (km per radian) -> slope = dh / (R_km * dangle)
  float Rkm = 1737.4;
  float sE = hb.y / (2.0 * PI) / (Rkm * cl);
  float sN = hb.z / PI / Rkm;
  vec3 grad = eastU * sE + northU * sN;
  // near the poles the equirectangular u-derivative blows up (1/cos lat): switch to isotropic 3-tap differences
  // along a well-defined tangent frame, using the same smooth B-spline
  float polar = smoothstep(0.95, 0.985, abs(p.y));
  if (polar > 0.0) {
    vec3 Ta = normalize(cross(abs(p.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0), p));
    vec3 Tb = cross(p, Ta);
    float e = max(2.0 * PI / 2048.0, fpRad * 1.5);
    float hA = lolaBspline(dirToUV(normalize(p + Ta * e))).x;
    float hB = lolaBspline(dirToUV(normalize(p + Tb * e))).x;
    vec3 gp = (Ta * (hA - hb.x) + Tb * (hB - hb.x)) / (e * Rkm);
    grad = mix(grad, gp, polar);
  }

  // final footprint: the obliquity bound uses the LOLA-sloped surface (a ridge back facing away from the camera is
  // seen far more obliquely than the sphere normal says; bounding by the sphere left unresolved detail switched on
  // there, which aliased into horizontal dashes)
  {
    vec3 nL = normalize(p - (grad - p * dot(grad, p)));
    float muL = abs(dot(nL, normalize(transpose(uB2W) * (-vPosW))));
    fpW = clamp(fwP, fpA, fpA / max(min(muG, muL), 0.01));
    fpRad = fpW / uR;
    fpKm = fpW / KM;
  }

  // ---- procedural craters + regolith micro relief at close range
  CraterAcc acc;
  acc.dbg = vec3(0.0); acc.grad = vec3(0.0); acc.shadowS = 1.0; acc.shadowE = 1.0; acc.albedo = 0.0; acc.h = 0.0;
  float detail = uDetail * smoothstep(1.2, 0.4, fpKm);   // only below the LOLA / LRO texel scale (~5 km)
  if (detail > 0.0) {
    craterField(p, fpRad, mare, Ls, Le, acc);
    grad += acc.grad * detail;
    vec4 rg = fbmd2(p * 9000.0, fpRad * 9000.0, 4, 2.1, 0.5, 0.8);
    vec3 rgt = rg.yzw * 9000.0; rgt -= p * dot(rgt, p);
    grad += rgt * 0.000025 * detail;
    float an = fbmd(p * 2600.0 + 3.7, fpRad * 2600.0, 4, 2.2, 0.55).x;
    // ridged sub-LOLA relief (the same field displaces the mesh; here down to the pixel footprint)
    vec4 rl = moonRelief(p, max(fpKm * 2.5, 0.12));
    vec3 rlg = rl.yzw - p * dot(rl.yzw, p);
    if (uDebug != 18) grad += rlg * (detail / Rkm) * mix(1.0, 0.45, mare);
    alb *= 1.0 + (an * 0.18 + acc.albedo) * detail;
  }
  grad -= p * dot(grad, p);
  vec3 N = normalize(p - grad);

  // ---- large-scale terrain shadow: horizon march over LOLA toward the key light
  float sunUp = dot(p, Ls);
  vec3 key = sunUp > -0.08 ? Ls : Le;
  float keyShadow = 1.0;
  {
    vec3 kT = key - p * dot(key, p);
    float kl = length(kT);
    if (kl > 1e-4) {
      kT /= kl;
      float tanK = dot(key, p) / kl;
      if (tanK < 0.6) {
        // march with the same (mip-filtered bilinear) height on both ends, so 8-bit steps never self-shadow
        float s = max(2.5, fpKm * 2.0);
        float lod0 = log2(max(s * 0.35 / 5.3, 1.0)) + 0.5;
        float h0 = heightKm(textureLod(uHeight, uv, lod0).r);
        float occ = 1.0;
        for (int k = 0; k < 22; k++) {
          float ang = s / Rkm;
          vec3 q = normalize(p + kT * ang);
          float lod = log2(max(s * 0.35 / 5.3, 1.0)) + 0.5;
          float hq = heightKm(textureLod(uHeight, dirToUV(q), lod).r);
          float drop = s * s / (2.0 * Rkm);
          float rise = (hq - h0 - drop) / s;
          // penumbra widens with distance to the occluder (sun's disc) and with the sample spacing
          float pen = 0.0047 + 0.6 / s;
          occ = min(occ, smoothstep(-pen, pen, tanK - rise));
          s *= 1.3;
          if (s > 350.0) break;
        }
        keyShadow = occ;
      }
    }
  }
  float shS = sunUp > -0.08 ? keyShadow : 1.0;
  float shE = sunUp > -0.08 ? 1.0 : keyShadow;
  shS *= acc.shadowS > 0.0 ? mix(1.0, acc.shadowS, detail) : 1.0;
  shE *= mix(1.0, acc.shadowE, detail);

  // ---- lighting
  float mu = dot(N, V);
  float alphaS = acos(clamp(dot(Ls, V), -1.0, 1.0));
  float alphaE = acos(clamp(dot(Le, V), -1.0, 1.0));
  // geometric terminator: the sun's disc sets gradually over the local horizon
  float sunVis = smoothstep(-uSunAngR, uSunAngR, sunUp + 0.0);
  vec3 Lsun = alb * lunarPhotometry(max(dot(N, Ls), 0.0), mu, alphaS) * shS * sunVis * earthShadow(P, Ls);
  // earthshine: its own light direction and shadows (never the sun's masks). Earth's disc is 2 deg wide and the
  // light is already multiply scattered in the regolith at these low levels, so a softer phase law than the sun's
  // (the full McEwen law makes everything seen toward a low Earth pitch black)
  float mu0E = max(dot(N, Le), 0.0);
  float phE = 0.35 + 0.65 * exp(-0.6 * alphaE);
  vec3 Learth = alb * (2.0 * mu0E / (mu0E + max(mu, 0.0) + 1e-4) * 0.5 + 0.5 * mu0E) * phE * shE * uEarthshine;
  vec3 L = Lsun + Learth;
  if (uDebug == 20) L = Learth * 100.0;
  if (uDebug == 21) L = vec3(mu0E, phE, shE);
  if (uDebug == 22) L = uEarthshine * 10.0;
  if (uDebug == 11) L = vec3(shS);
  if (uDebug == 13) L = vec3(acc.shadowS);
  if (uDebug == 17) L = vec3(polar);
  if (uDebug == 16) L = acc.dbg;
  if (uDebug == 14) L = vec3(keyShadow);
  if (uDebug == 15) { float ns = dot(Ls, p); L = vec3(ns, dot(Ls, N), 0.0); }
  if (uDebug == 12) L = N * 0.5 + 0.5;
  gl_FragColor = vec4(L, 1.0);
}
`;
