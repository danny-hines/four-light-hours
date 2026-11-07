// GLSL for the sky: Milky Way + diffuse objects (sphere shell) and stars (screen-space instanced quads).
import { NOISE_GLSL } from '../glsl/noise.js';

// Relativistic aberration helpers (shared). v = unit velocity, b = beta.
const ABERRATION = /* glsl */ `
// rest-frame direction n (toward the source) -> observed direction; also returns the Doppler factor
vec3 aberrateFwd(vec3 n, vec3 v, float b, out float dop) {
  float cr = dot(n, v);
  float cp = (cr + b) / (1.0 + b * cr);
  vec3 p = n - v * cr;
  float pl = length(p);
  p = pl > 1e-7 ? p / pl : vec3(0.0);
  float sp = sqrt(max(0.0, 1.0 - cp * cp));
  float g = inversesqrt(max(1e-6, 1.0 - b * b));
  dop = g * (1.0 + b * cr);
  return normalize(v * cp + p * sp);
}
// observed direction -> rest-frame direction (inverse), Doppler factor of light arriving from there
vec3 aberrateInv(vec3 d, vec3 v, float b, out float dop) {
  float cp = dot(d, v);
  float cr = (cp - b) / (1.0 - b * cp);
  vec3 p = d - v * cp;
  float pl = length(p);
  p = pl > 1e-7 ? p / pl : vec3(0.0);
  float sr = sqrt(max(0.0, 1.0 - cr * cr));
  float g = inversesqrt(max(1e-6, 1.0 - b * b));
  dop = 1.0 / (g * (1.0 - b * cp));
  return normalize(v * cr + p * sr);
}
`;

const LUT_FN = /* glsl */ `
uniform sampler2D uLUT;
uniform vec2 uLUTRange; // ln(Tmin), 1/ln(Tmax/Tmin)
uniform float uDopT;     // colour-temperature Doppler exponent
vec3 bbColour(float T) {
  float u = clamp((log(T) - uLUTRange.x) * uLUTRange.y, 0.0, 1.0);
  return texture2D(uLUT, vec2(u * (255.0 / 256.0) + 0.5 / 256.0, 0.5)).rgb;
}
`;

export const MW_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const MW_FRAG = /* glsl */ `
precision highp float;
${NOISE_GLSL}
${ABERRATION}
${LUT_FN}
uniform sampler2D tMW;    // 1024x256: R = smooth ln tau_eff, G = log S_bg (background light), B = rho (reddening fraction)
uniform sampler2D tDust;  // 4096x1024 (mipmapped): ln tau_eff residual about R (IRAS resolution), +-uResR e-folds
uniform float uResR;
uniform vec4 uNear;       // F = min(uNear.x S_bg, uNear.y (uNear.z exp(-|b|/uNear.w) (1 + uNear2.x cos l))^uNear2.y)
uniform vec2 uNear2;
uniform vec2 uDustTex;    // dust texture size
uniform sampler2D tObj;   // NOBJ x 6 RGBA32F texels per object
uniform sampler2D tNeb;   // nebula structure atlas: R = emission^(1/3), G = dust tau / 3, B = reflection^(1/3)
uniform vec2 uNebSize;    // atlas size (texels)
uniform int uObjCount;   // number of entries in uObjIdx (objects that can touch the view, culled on the CPU)
uniform int uObjIdx[32];
uniform mat3 uW2G;
uniform vec2 uRadLn;      // ln radMin, ln radMax
uniform vec2 uTauLn;      // ln tauMin, ln tauMax
uniform float uLatK, uSinhK;
uniform float uMWK;       // texture radiance -> output radiance
uniform float uObjToTex;  // 1 / uMWK
uniform float uMWGamma;   // photographic compression of the Milky Way's own dynamic range (about the Sgr cloud)
uniform float uObjGamma;  // ... and the extra stretch of the nebulae / galaxies
uniform float uSkyGain;
uniform float uSat;
uniform float uSatObj;
uniform float uDust;      // log-normal sigma of the sub-texel dust column detail
uniform float uWarpAmp;   // domain-warp amplitude of the dust map (texels)
uniform float uSharp;     // log-tau unsharp mask
uniform float uLevelK;    // contour-following noise: noise units per e-fold of tau
uniform float uFExt;      // fraction of the foreground screen in front of the nearest stars
uniform float uEdgeK;     // cloud-edge steepening
uniform vec2 uEdge2;      // steepening of ln tau about the visual edge: strength, ln tau of the edge
uniform float uTauCap;    // saturation of the small-cloud optical depth above the ~2 deg column
uniform vec3 uPop;        // disk T, bulge T, DGL strength
uniform float uExpo;     // the shot's exposure (grain gating under the display toe)
uniform float uDetail;    // 0..1 master switch for procedural detail
uniform float uBeta;
uniform vec3 uVelDir;
uniform float uDopP;
uniform vec2 uDopRec;    // receding-side Doppler exponent and brightness floor
varying vec3 vDir;

const float PI = 3.14159265358979;
const vec3 KC = vec3(0.84, 1.0, 1.24); // A_c / A_V for the R, G, B channels

float fade(float f, float fp) { return clamp(1.6 - f * fp * 2.2, 0.0, 1.0); }
// stricter octave filter for structure that gets steepened: an octave is gone before its wavelength (~1.5/f) falls
// below ~5 px, so cloud edges never break up into pixel-scale stipple
float fadeEdge(float f, float fp) { return clamp((0.3 - f * fp) / 0.18, 0.0, 1.0); }

vec2 galUV(vec3 g, out float b) {
  float l = atan(g.y, g.x);
  b = asin(clamp(g.z, -1.0, 1.0));
  float y = asinh((b * (2.0 / PI)) * uSinhK) / uLatK;
  return vec2(0.5 - l / (2.0 * PI), 0.5 + 0.5 * y);
}

// filamentary structure in [-1, 1] (used by the analytic nebulae)
float wisps(vec3 p, float fp, float f0) {
  vec3 q = p * f0;
  q += 0.28 * snoise3(q * 0.37 + 4.1);
  float s = 0.0, a = 0.55, f = f0;
  for (int i = 0; i < 5; i++) {
    float w = fade(f, fp);
    if (w <= 0.0) break;
    float n = snoise(q);
    n = mix(n, 1.0 - 2.0 * abs(n), 0.15);
    s += a * w * n;
    q = q * 2.07 + vec3(1.3, 7.1, 3.7);
    f *= 2.07;
    a *= 0.56;
  }
  return s;
}

// cubic B-spline sample of the dust map's base level (4 bilinear taps): C2-smooth, so the edge steepening below
// never brings out the kinks of bilinear interpolation along texel rows
float dustBicubic(vec2 uv) {
  vec2 st = uv * uDustTex - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (w1 / g0) - 0.5 + i, h1 = (w3 / g1) + 1.5 + i;
  vec2 inv = 1.0 / uDustTex;
  float a = textureLod(tDust, (vec2(h0.x, h0.y) + 0.5) * inv, 0.0).r;
  float b = textureLod(tDust, (vec2(h1.x, h0.y) + 0.5) * inv, 0.0).r;
  float c = textureLod(tDust, (vec2(h0.x, h1.y) + 0.5) * inv, 0.0).r;
  float d = textureLod(tDust, (vec2(h1.x, h1.y) + 0.5) * inv, 0.0).r;
  return g0.y * (g0.x * a + g1.x * b) + g1.y * (g0.x * c + g1.x * d);
}

// Anisotropic (filamentary) fBm on the sphere. A noise field whose coordinates are (colatitude about a fixed axis a)
// x f and (the position perpendicular to a) x f / s varies s times more slowly along the circles around a than across
// them: streaks along those circles, globally seamless (no orientation-field warping, no tiles). Six such fields
// (axes on an icosahedron, so at every point at least a few distinct streak directions exist) are blended per pixel
// by how well their streak direction matches the local contour tangent t of the dust column, with a
// variance-preserving weight, so dust lanes break up into streamers and filaments that run along the clouds' own
// iso-tau contours. Ridged, footprint-filtered.
const vec3 AXK[6] = vec3[6](vec3(0.0, 0.0, 1.0), vec3(0.894427, 0.0, 0.447214), vec3(0.276393, 0.850651, 0.447214),
  vec3(-0.723607, 0.525731, 0.447214), vec3(-0.723607, -0.525731, 0.447214), vec3(0.276393, -0.850651, 0.447214));
uniform float uAniso;     // streak elongation along the contours
uniform float uRidge;     // ridged share of the filament noise (thin dark filaments)
float streaks(vec3 g, vec3 t, float pixAng, float f0, out float wOct) {
  float w[6];
  float wmax = 0.0;
  for (int k = 0; k < 6; k++) {
    vec3 dk = cross(AXK[k], g);
    float s2 = dot(dk, dk);
    float c = dot(dk, t);
    float al = c * c / max(s2, 1e-6);
    al *= al;
    al *= al;              // cos^8 of the angle between the field's streaks and the contour
    w[k] = s2 * s2 * al;    // (fields whose axis is near g are degenerate: suppressed)
    wmax = max(wmax, w[k]);
  }
  float acc = 0.0, w2 = 0.0;
  wOct = 0.0;
  for (int k = 0; k < 6; k++) {
    if (w[k] < 0.12 * wmax) continue;
    vec3 a = AXK[k];
    float ca = dot(g, a);
    float th = acos(clamp(ca, -1.0, 1.0));
    vec3 pp = g - a * ca;
    float sum = 0.0, amp = 1.0, f = f0, wo = 0.0;
    for (int i = 0; i < 5; i++) {
      float fw = fadeEdge(f, pixAng);
      if (fw <= 0.0) break;
      vec3 q = a * (th * f) + pp * (f / uAniso) + vec3(float(i) * 7.31 + float(k) * 3.7, float(i) * 3.17 - float(k) * 1.3, 1.9);
      float n = snoise(q);
      float r = 1.0 - abs(n);
      r = r * r * r;          // sparse, sharp ridges: occasional thin filaments, not a dense hatching
      sum += amp * fw * mix(n, 2.4 * (r - 0.27), uRidge);
      wo += amp * fw;
      f *= 2.13;
      amp *= 0.58;
    }
    acc += w[k] * sum;
    w2 += w[k] * w[k];
    wOct = max(wOct, wo);
  }
  return acc / max(sqrt(w2), 1e-9);
}

// The dust column at full detail. Returns tau (V) for the background light.
//   1. the IRAS-resolution map, sampled at an explicit, footprint-matched LOD (seam-free, no aliasing)
//   2. a small domain warp (cloud edges not bilinear-smooth)
//   3. a log-space unsharp mask (restores the edge contrast the 4' beam took away)
//   4. sub-texel column structure as anisotropic streaks along the local contour direction of the column
//      (filaments and streamers, not round cells), strongest on cloud boundaries, footprint-filtered
float dustTau(vec3 g, float pixAng, float lsm, out float lnTauS) {
  float b;
  vec2 uv = galUV(g, b);
  float cb = max(cos(b), 1e-3);
  float yy = (uv.y - 0.5) * 2.0;
  float texU = 2.0 * PI * cb / uDustTex.x;
  float texV = (0.5 * PI) * uLatK * cosh(uLatK * yy) / uSinhK * (2.0 / uDustTex.y);
  float texel = max(texU, texV);
  float lod = max(0.0, log2(pixAng / texel));
  float ww = fade(110.0, pixAng);
  if (uDetail > 0.0 && ww > 0.0) {
    vec3 q = g * 110.0;
    vec2 dw = vec2(snoise(q + vec3(3.1, 7.7, 1.3)), snoise(q + vec3(-5.2, 2.9, 8.4)));
    float w2 = fade(250.0, pixAng);
    q = g * 250.0;
    dw += 0.5 * w2 * vec2(snoise(q + vec3(1.7, -3.3, 4.1)), snoise(q + vec3(6.6, 5.5, -2.2)));
    float w3 = fade(560.0, pixAng);
    q = g * 560.0;
    dw += 0.25 * w3 * vec2(snoise(q + vec3(9.1, 1.4, -6.3)), snoise(q + vec3(-7.4, 3.8, 2.6)));
    uv += dw * (uWarpAmp * ww) * vec2(texV / texU, 1.0) / uDustTex;
  }
  float e0 = lod < 1.0 ? mix(dustBicubic(uv), textureLod(tDust, uv, 1.0).r, lod) : textureLod(tDust, uv, lod).r;
  float e1 = textureLod(tDust, uv, lod + 2.5).r;
  float e2 = textureLod(tDust, uv, lod + 4.5).r;
  float rk = uResR * (255.0 / 127.0);
  float r0 = 128.0 / 255.0;
  float lt0 = lsm + (e0 - r0) * rk;
  float lb1 = lsm + (e1 - r0) * rk;
  float lb2 = lsm + (e2 - r0) * rk;
  lnTauS = lb1;
  // multi-scale local contrast in log tau: clouds stand out from their surroundings at 0.3-2 deg scales, and the
  // data's own fine structure (IRAS beam scale) rides on top with a mild boost
  float d = (1.0 + 0.5 * uSharp) * (lb1 - lb2) + (1.0 + uSharp) * (lt0 - lb1);
  if (uDetail > 0.0) {
    // gradient of the column at ~3 texels from four explicit taps (smooth from pixel to pixel: per-quad fwidth()
    // made the edge weights step in 2x2 blocks, which the steepening below turned into a stippled spray)
    float Lg = lod + 1.5;
    float sg = exp2(Lg);
    vec2 duv = sg / uDustTex;
    float gx = textureLod(tDust, uv + vec2(duv.x, 0.0), Lg).r - textureLod(tDust, uv - vec2(duv.x, 0.0), Lg).r;
    float gy = textureLod(tDust, uv + vec2(0.0, duv.y), Lg).r - textureLod(tDust, uv - vec2(0.0, duv.y), Lg).r;
    float G = length(vec2(gx / texU, gy / texV)) * (0.5 * rk / sg);  // e-folds of tau per radian
    // edge-ness: how fast the column changes per dust texel -- the noise lives mainly on cloud boundaries
    float edge = smoothstep(0.05, 0.35, G * texel);
    // contour tangent of the column (perpendicular to its gradient); where the column is flat it is undefined, and
    // the streaks fall back to running along the Galactic plane (as the field-aligned dust near the plane does)
    vec3 el = normalize(vec3(-g.y, g.x, 0.0) + vec3(1e-6, 0.0, 0.0));
    vec3 eb = cross(g, el);
    vec3 gr = eb * (gy / texV) - el * (gx / texU);
    vec3 tc = cross(g, gr);
    float tl = length(tc);
    tc = tl > 1e-9 ? tc / tl : el;
    if (dot(tc, el) < 0.0) tc = -tc;
    float coh = smoothstep(0.06, 0.4, G * texel);
    vec3 tdir = normalize(tc * coh + el * (1.0 - coh) * 0.8 + 1e-6);
    // the streak coordinates meander (an isotropic warp at twice the base wavelength): smoke, not hatching
    float fs0 = 1.0 / (2.2 * 0.00154);
    vec3 qw = g * (0.45 * fs0);
    vec3 gw = g + vec3(snoise(qw + vec3(2.3, -1.1, 4.7)), snoise(qw + vec3(-6.1, 3.3, 0.4)), snoise(qw + vec3(1.7, 5.9, -3.2))) * (0.55 / fs0) * fade(0.45 * fs0, pixAng);
    float wOct;
    float s = streaks(gw, tdir, pixAng, fs0, wOct);
    // boundaries: filamentary displacement of the iso-level; the interiors carry a fainter continuation of the
    // column's power spectrum below the data resolution (also streaky)
    d += uDust * (edge + 0.12) * s;
    // steepen the cloud boundaries -- only as far as the footprint allows: the edge never gets narrower than
    // ~1.5 px (at wide fields, where a dust texel is about a pixel, the data is left as it is)
    float tpx = texel / pixAng;
    d += uEdgeK * clamp((tpx - 1.2) / 3.0, 0.0, 1.0) * edge * 0.35 * tanh(d / 0.35);
  }
  float lt = lb2 + d;
  if (uDetail > 0.0) {
    // the visual edge of a dark cloud is where its optical depth crosses ~1: steepen ln tau about that level (not
    // about the local mean, which turned every fluctuation of the column into a sharp-edged cell), as far as the
    // footprint allows -- thick clouds get darker and crisper, thin screens clearer
    float tpx2 = texel / pixAng;
    float x = lt - uEdge2.y;
    // (local: the slope at the edge rises to 1 + strength, columns far from the edge level keep their value)
    lt += uEdge2.x * clamp((tpx2 - 1.0) / 3.0, 0.0, 1.0) * x * exp(-x * x * (0.5 / (0.6 * 0.6)));
  }
  // small dark clouds are never opaque cut-outs: the excess over the ~2 deg column saturates at a few optical
  // depths (scattered light, the clumpy cloud's holes and its few foreground stars keep a trace of light)
  float t2 = exp(lb2);
  float tx = max(exp(lt) - t2, 0.0);
  return min(exp(lt), t2 + uTauCap * tanh(tx / uTauCap));
}

// stellar-population colour of the diffuse light: old bulge K giants vs the bluer disk (white point 6000 K). The
// bulge's share of the light follows a boxy (COBE/DIRBE-like) profile, ~14 deg in l by ~11 deg in b, so the whole
// visible bulge -- the Sagittarius star clouds well south of the plane included -- carries the warm population
float bulgeFrac(vec3 g) {
  float l = atan(g.y, g.x) * (180.0 / PI);
  float b = asin(clamp(g.z, -1.0, 1.0)) * (180.0 / PI);
  float r = pow(pow(abs(l) / 14.0, 3.0) + pow(abs(b + 0.5) / 11.0, 3.0), 1.0 / 3.0);
  return 1.0 / (1.0 + r * r * r);
}
uniform float uDiskVJ;    // V/J light ratio of the disk population relative to the bulge's K giants
vec3 popColour(vec3 g) {
  float bf = bulgeFrac(g);
  // the layer is near-IR (DIRBE 1.25 um) light: the young disk is bluer than the old bulge (V-J ~1.3 vs ~2.0),
  // so per unit J light it is brighter in the visible -- Cygnus, Carina and Crux against the Sagittarius clouds
  return bbColour(mix(uPop.x, uPop.y, bf)) * mix(uDiskVJ, 1.0, bf);
}

vec3 objects(vec3 d, float fp, out float tauS) {
  vec3 sum = vec3(0.0);
  tauS = 0.0;
  for (int k = 0; k < 32; k++) {
    if (k >= uObjCount) break;
    int i = uObjIdx[k];
    vec4 e = texelFetch(tObj, ivec2(3, i), 0); // kind, ring, noise, cosLimit
    vec4 a = texelFetch(tObj, ivec2(0, i), 0); // dir, scale radius (rad)
    float cd = dot(d, a.xyz);
    if (cd < e.w) continue;
    vec4 c = texelFetch(tObj, ivec2(1, i), 0); // colour * peak radiance, seed
    vec4 m = texelFetch(tObj, ivec2(2, i), 0); // major axis, q   (sprite: east axis, half-height)
    vec4 s = texelFetch(tObj, ivec2(4, i), 0); // side.xy, side strength, ring width / lane   (sprite: atlas cell)
    vec3 tp = d / cd - a.xyz;
    if (e.x > 3.5) {
      // structure sprite in sky orientation (+x east, +y north), sampled at a footprint-matched LOD
      vec3 north = cross(a.xyz, m.xyz);
      vec2 q = vec2(dot(tp, m.xyz) / a.w, dot(tp, north) / m.w);
      if (abs(q.x) >= 1.0 || abs(q.y) >= 1.0) continue;
      vec2 uv = s.xy + (q * 0.5 + 0.5) * s.zw;
      float tpp = fp / (2.0 * a.w) * s.z * uNebSize.x;   // atlas texels per pixel
      vec3 t = textureLod(tNeb, uv, clamp(log2(max(tpp, 1e-6)), 0.0, 3.0)).rgb;
      vec4 r = texelFetch(tObj, ivec2(5, i), 0);         // reflection colour * peak, dust scale
      // bright, high-excitation cores ([O III] + H-beta, and photographic saturation) turn cream-teal; the outer
      // nebula keeps its H-alpha red
      float em3 = t.r * t.r * t.r;
      vec3 cem = mix(c.rgb, vec3(0.86, 1.04, 1.0) * dot(c.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.75 * smoothstep(0.62, 0.97, t.r));
      vec3 col = cem * em3 + r.rgb * (t.b * t.b * t.b);
      // nebulae get a stronger photographic stretch of their own (faint outer structure lifted, cores held)
      col *= pow(max(dot(col, vec3(0.2126, 0.7152, 0.0722)) * uObjToTex, 1e-12) / 0.86, e.y - 1.0);
      // fine filamentary texture inside the sprite, below its texel scale (footprint-filtered)
      if (e.z > 0.0) col *= mix(1.0, clamp(0.7 + 0.6 * wisps(d * 1.0 + c.w, fp, 0.8 / (a.w / (s.z * uNebSize.x))), 0.2, 2.0), e.z);
      sum += col;
      tauS += 3.0 * t.g * r.w;
      continue;
    }
    vec2 xy = vec2(dot(tp, m.xyz), dot(tp, cross(a.xyz, m.xyz)));
    vec2 pq = vec2(xy.x, xy.y / m.w) / a.w;
    float rho = length(pq);
    int kind = int(e.x + 0.5);
    float prof;
    vec3 np = d + vec3(c.w * 0.37, c.w * 0.11, -c.w * 0.23);
    float f0 = 2.6 / a.w;
    if (kind == 0) {
      if (e.y > 0.0) { float t = (rho - e.y) / s.w; prof = exp(-t * t); }
      else prof = exp(-0.693 * rho * rho);
      if (s.z > 0.0) { float sd = max(0.0, 0.5 + 0.5 * dot(normalize(pq + 1e-6), s.xy)); prof *= mix(1.0, sd * sd, s.z); }
      if (e.z > 0.0 && prof > 1e-3) {
        float w = wisps(np, fp, f0);
        prof *= mix(1.0, pow(clamp(0.62 + 0.9 * w, 0.0, 2.0), 1.7), e.z);
      }
    } else if (kind == 1) {
      prof = exp(-1.25 * pow(rho, 1.15));
      vec4 st = texelFetch(tObj, ivec2(5, i), 0);
      if (st.x > 0.0 && prof > 1e-3) {
        // striated reflection nebula (Pleiades): noise stretched st.x times along the major axis, in the object's
        // own flat tangent frame (it is small), footprint-filtered
        vec2 sp = xy / a.w;
        float sum = 0.0, amp = 0.5, fq = 7.0;
        for (int o = 0; o < 4; o++) {
          float w = fade(fq / a.w, fp);
          if (w <= 0.0) break;
          float n = snoise(vec3(sp.x * fq / st.x, sp.y * fq, c.w + float(o) * 3.7));
          sum += amp * w * (0.6 - abs(n)) * 2.0;
          fq *= 2.2;
          amp *= 0.6;
        }
        prof *= mix(1.0, clamp(0.55 + 1.1 * sum, 0.05, 2.6), e.z);
      } else if (e.z > 0.0 && prof > 1e-3) prof *= mix(1.0, clamp(0.75 + 0.6 * wisps(np, fp, f0 * 0.8), 0.0, 2.0), e.z);
    } else if (kind == 2) {
      prof = exp(-rho);
      if (s.w > 0.5) { // dust lanes of an inclined spiral (M31): arcs on the near (NW) side
        float r1 = length(vec2(pq.x, pq.y * 1.0));
        float lane = exp(-pow((r1 - 1.25) / 0.16, 2.0)) + 0.7 * exp(-pow((r1 - 2.3) / 0.2, 2.0));
        prof *= 1.0 - 0.45 * lane * smoothstep(-0.2, 0.6, pq.y);
      }
      if (e.z > 0.0 && prof > 1e-4) prof *= mix(1.0, clamp(0.7 + 0.75 * wisps(np, fp, f0 * 1.4), 0.15, 2.2), e.z);
    } else {
      prof = pow(1.0 + rho * rho, -1.5);
      float fq = 60.0 / a.w;
      float w = fade(fq, fp);
      if (w > 0.0) prof *= mix(1.0, clamp(0.45 + 1.6 * max(snoise(d * fq), 0.0), 0.2, 3.0), e.z * w);
    }
    sum += c.rgb * prof;
  }
  return sum;
}

// Resolved star clouds: part of the diffuse light is redistributed into point stars on fixed sky lattices
// (3D voxel shells, seamless, deterministic). The lattice levels form a geometric ladder of star spacings
// (uResH0 / 2^k); a level turns into points once its spacing exceeds ~2.4 px and fades in by 4.8 px, so at every
// field of view the finest active level is a dense pixel-scale grain of faint stars and the coarser ones are the
// rarer, brighter stars: zooming in resolves more and more of the star clouds, as a longer focal length does.
// Cells hold a star with a probability that follows the smooth VISIBLE light (and a clumpy log-normal field): star
// clouds are crowded, dust lanes nearly empty, and the fine extinction dims the stars that remain. Each star carries
// the light of the cells it stands for, so the mean is conserved.
uniform float uResH0;    // star spacing (rad) of level 0
uniform int uResN;       // number of levels (quality)
uniform float uResSig;   // PSF sigma (px)
uniform vec2 uResWin;    // star spacing (px) over which a level fades in
uniform vec4 uLF;        // luminosity function: beta = 0.4/alpha; m_b-star fluxes per arcsec^2 per texture unit (true
                         // light); count scale (photographic: < 1 = fewer, brighter stars); rendered share of the boost
uniform vec2 uRemK;      // gain of the unresolved remainder's pixel-scale grain; of the cluster mottle
// Light fraction of the unresolved population carried by stars FAINTER than the lam-th brightest per cell, for a
// power-law luminosity function N(<m) ~ 10^(alpha m) truncated at m_b (the faint field's limit), whose cell light is
// lam0 / (beta - 1) m_b-stars:  T(lam) = (1 + lam / lam0)^(1 - beta).  The lam-th star's flux / the cell's mean light
// is -dT/dlam.
float lfTail(float lam, float lam0) { return pow(1.0 + lam / lam0, 1.0 - uLF.x); }
float lfFlux(float lam, float lam0) { return (uLF.x - 1.0) / lam0 * pow(1.0 + lam / lam0, -uLF.x); }
// Resolved star clouds from the real luminosity function. Lattice level k (cell spacing uResH0 / 2^k) holds the
// stars whose expected count per cell lies in [nu, 4 nu) (one star per cell on average): the levels tile the
// luminosity function, coarse cells holding the rare bright stars and fine cells the many faint ones, so the k-th
// brightest point in a cell matches N(<m) there. Fluxes come from order statistics of a Poisson process (the
// cumulative count of the n-th brightest star is a sum of n unit exponentials), so a cell's points are never brighter
// than an m_b star (V ~ 10.6, boosted like the rest of the diffuse light): far fainter than any catalogued star.
// Everything a level cannot render (finer than ~2 px, or faded) stays smooth; a level that fades out hands its band
// down to the next finer one, so light is conserved at every field of view. Returns (smooth + points) / mean and the
// relative std of the unresolved remainder at the finest active cell scale.
vec3 resolvedFactor(vec3 g, float pixAng, float Lvis, out float remStd, out float hRem, out float remW) {
  float smooth_ = 1.0;
  vec3 pts = vec3(0.0);
  float s2 = uResSig * uResSig;
  float rmax = 3.0 * uResSig;
  const float NU = 1.0 / 3.0;
  float lamA = (uLF.x - 1.0) * max(Lvis, 1e-7) * uLF.y * uLF.z;   // lam0 per arcsec^2 of cell
  float rf = uLF.w;
  float wPrev = 0.0;
  remStd = 0.0;
  hRem = uResH0;
  remW = 0.0;
  for (int k = 0; k < 7; k++) {
    if (k >= uResN) break;
    float h = uResH0 * exp2(-float(k));
    float cpx = h / pixAng;
    if (cpx < uResWin.x) break;
    float win = smoothstep(uResWin.x, uResWin.y, cpx);
    float w = win * (1.0 - smoothstep(48.0, 96.0, cpx));
    float hA = h * 206264.8;
    float lam0 = max(lamA * hA * hA, 1e-6);
    // the unresolved remainder below this level (stars with more than ~1.3 per cell): its Poisson fluctuation per
    // cell, relative to the mean light, is (beta - 1) / sqrt((2 beta - 1) lam0) (1 + 4 nu / lam0)^(1/2 - beta)
    remStd = (uLF.x - 1.0) * inversesqrt((2.0 * uLF.x - 1.0) * lam0) * pow(1.0 + 4.0 * NU / lam0, 0.5 - uLF.x);
    hRem = h;
    remW = win;
    if (w <= 0.0) { wPrev = 0.0; continue; }
    // band light: [0, nu) handed down from the coarser level to the extent it is faded, [nu, 4 nu) this level's own
    float tNu = lfTail(NU, lam0), t4 = lfTail(4.0 * NU, lam0);
    smooth_ -= w * rf * ((1.0 - wPrev) * (1.0 - tNu) + (tNu - t4));
    vec3 q0 = g / h;
    vec3 c0 = floor(q0);
    // a star can only reach this pixel from the nearest 2x2x2 cells once its PSF radius is under half a cell
    int n = cpx < 2.0 * rmax ? 3 : 2;
    vec3 base = n == 3 ? c0 - 1.0 : c0 + step(0.5, q0 - c0) - 1.0;
    vec3 acc = vec3(0.0);
    for (int z = 0; z < 3; z++) {
      if (z >= n) break;
      for (int y = 0; y < 3; y++) {
        if (y >= n) break;
        for (int x = 0; x < 3; x++) {
          if (x >= n) break;
          vec3 cc = base + vec3(float(x), float(y), float(z));
          vec3 rnd = hash33(cc + float(k) * 17.31);
          vec3 q = (cc + rnd) * h;
          float rq = length(q);
          if (abs(rq - 1.0) > 0.5 * h) continue;
          float dpx = length(q / rq - g) / pixAng;
          if (dpx > rmax) continue;
          vec3 hr = hash33(cc * 1.37 + float(k) * 5.1);
          // the cell's stars in this level's band, brightest first (cumulative counts = sums of unit exponentials)
          float l1 = -log(max(hr.x, 1e-7));
          if (l1 >= 4.0 * NU) continue;
          float l2 = l1 - log(max(hr.z, 1e-7));
          float l3 = l2 - log(max(fract(hr.x * 17.13 + hr.z * 3.7), 1e-7));
          float fl = lfFlux(l1, lam0) * (l1 < NU ? 1.0 - wPrev : 1.0);
          if (l2 < 4.0 * NU) fl += lfFlux(l2, lam0) * (l2 < NU ? 1.0 - wPrev : 1.0);
          if (l3 < 4.0 * NU) fl += lfFlux(l3, lam0) * (l3 < NU ? 1.0 - wPrev : 1.0);
          float t = hr.y * 2.0 - 1.0;                                // colour spread of the population
          vec3 tint = vec3(1.0 + 0.14 * t, 1.0 + 0.01 * t, 1.0 - 0.18 * t);
          acc += tint * (fl * exp(-0.5 * dpx * dpx / s2));
        }
      }
    }
    pts += acc * (w * rf * cpx * cpx / (6.2831853 * s2));
    wPrev = w;
  }
  return vec3(max(smooth_, 0.0)) + pts;
}
// Poisson clustering of the stars that make up the star clouds (associations, open clusters, the clumpy disk):
// a log-normal field at 2-20 arcmin, footprint-filtered and seeded on the sphere, plus sparse compact cluster knots.
float cloudMottle(vec3 g, float fp) {
  float m = 0.0, v = 0.0;
  float a;
  a = 0.10 * fade(180.0, fp); m += a * snoise(g * 180.0 + vec3(1.3, -2.1, 0.7)); v += a * a;
  a = 0.11 * fade(380.0, fp); m += a * snoise(g * 380.0 + vec3(-4.2, 3.3, 1.9)); v += a * a;
  a = 0.10 * fade(850.0, fp); m += a * snoise(g * 850.0 + vec3(7.7, 0.4, -3.1)); v += a * a;
  a = fade(1500.0, fp);
  if (a > 0.0) { float kn = max(snoise(g * 1500.0 + vec3(2.2, 9.1, -5.5)) - 0.5, 0.0) * 2.0; m += a * 0.55 * kn * kn - a * 0.03; }
  m *= uRemK.y;
  return exp(m - 0.5 * v * uRemK.y * uRemK.y);
}

// The boxy bulge (COBE/DIRBE-like: exponential in a superellipse radius, ~3.6 x 2.7 deg scale lengths, the bar's
// near end at positive l slightly brighter). The background-light layer saturates (radMax) over the whole inner
// Galaxy at |b| < ~7 deg, which flattened the bulge into a straight band; this term restores the light the layer
// cannot hold -- the model minus what the layer already carries, only where it is saturated.
uniform vec4 uBulge;     // amplitude, scale length in l (deg), in b (deg), bar asymmetry
uniform vec2 uBulgeK;    // screen factor of the bulge: far from the mid-plane, in the mid-plane
float bulgeExcess(float ld, float bd, float Sbg) {
  float r = pow(pow(abs(ld) / uBulge.y, 3.0) + pow(abs(bd) / uBulge.z, 3.0), 1.0 / 3.0);
  float Sb = uBulge.x * exp(-r) * (1.0 + uBulge.w * clamp(ld / 8.0, -1.0, 1.0));
  float Sd = 1.5 * exp(-abs(bd) / 5.5);
  return max(0.0, Sd + Sb - Sbg) * smoothstep(0.55, 0.95, Sbg * exp(-uRadLn.y));   // (only where the encoding saturates)
}

void main() {
  vec3 d = normalize(vDir);
  float dop = 1.0;
  vec3 dr = d;
  if (uBeta > 1e-4) dr = aberrateInv(d, uVelDir, uBeta, dop);
  vec3 g = uW2G * dr;
  // footprint in the rest frame (aberration magnifies / shrinks the sky)
  float fp = max(length(fwidth(g)), 1e-7);
  float pixAng = max(max(length(dFdx(g)), length(dFdy(g))), 1e-7);
  float bb;
  vec2 uv = galUV(g, bb);
  vec3 lo = texture2D(tMW, uv).rgb;
  float Sbg = max(exp(mix(uRadLn.x, uRadLn.y, lo.g)) - exp(uRadLn.x), 0.0);
  float rhoR = lo.b;
  float lsm = mix(uTauLn.x, uTauLn.y, lo.r);
  float lgal = atan(g.y, g.x);
  float F = min(uNear.x * Sbg, uNear.y * pow(uNear.z * exp(-abs(bb) * (180.0 / PI) / uNear.w) * (1.0 + uNear2.x * cos(lgal)), uNear2.y));
  float lnTauS;
  float tau = dustTau(g, pixAng, lsm, lnTauS);
  // per-pixel extinction: background light dimmed and reddened, the nearest stars almost untouched
  vec3 bg = Sbg * exp(-tau - (KC - 1.0) * (rhoR * tau));
  float fr = F * exp(-uFExt * tau);
  // diffuse galactic light: dust scatters the ambient starlight (faint cirrus glow at high latitude)
  // (the ambient field a cloud scatters is the whole sky's starlight, brightest toward the plane; an opaque cloud
  // far from the plane is therefore only a few times darker than its faint background, never a black cut-out)
  float amb = 0.045 + 0.06 * exp(-abs(bb) * (180.0 / PI) / 10.0);
  float dgl = uPop.z * amb * (1.0 - exp(-tau));
  // diffuse objects (their dust also screens the Milky Way light behind them)
  float tauS;
  vec3 co = objects(dr, fp, tauS) * uObjToTex;
  bg *= exp(-tauS * KC);
  vec3 pc = popColour(g);
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  // the bulge: its K giants sit 8 kpc away, behind nearly all the dust at |b| > 3 deg, but the IRAS column
  // overestimates the extinction toward the bulge there (warm dust, SFD's known excess at low latitude: Baade's
  // window has A_V ~ 1.6, not ~2.7) -- a reduced screen, rising to more than the full column in the mid-plane
  float ld = lgal * (180.0 / PI), bd = bb * (180.0 / PI);
  float Sx = bulgeExcess(ld, bd, Sbg);
  float kb = mix(uBulgeK.x, uBulgeK.y, exp(-bd * bd / (2.2 * 2.2)));
  vec3 pb = bbColour(uPop.y);
  vec3 cb = pc * bg + pb * (Sx * exp(-kb * tau * KC - tauS * KC));  // background light: this resolves into star clouds
  // star-count clustering of the star clouds (and of the near stars in front of the lanes)
  float mot = uDetail > 0.0 ? cloudMottle(g, fp) : 1.0;
  cb *= mot;
  vec3 c = cb + pc * (fr * mot + dgl);
  // photographic response: compress the luminance range about the Sgr star cloud, keep chroma
  float Lc = max(dot(c, LW), 1e-9);
  float kg = pow(Lc / 0.86, uMWGamma - 1.0);
  vec3 cg = c * kg;
  // diffuse objects share the same response (texture units = output / uMWK)
  if (co.r + co.g + co.b > 0.0) {
    vec3 ct = c + co;
    float Lt = max(dot(ct, LW), 1e-9);
    co = ct * pow(Lt / 0.86, uMWGamma - 1.0) - cg;
  }
  if (uDetail > 0.0 && uResN > 0) {
    // star occupancy from the smooth (texture-scale) VISIBLE light, so it is constant across each star's few-pixel
    // PSF: the large-scale extinction thins the star clouds out (fewer stars rise above the threshold behind a
    // lane), the fine extinction in cb dims the stars that remain
    float tsm = exp(lnTauS);
    // (the nearest stars, in front of the dust, resolve too: dark lanes keep a sparse scatter of foreground stars)
    float Lv = (dot(pc, LW) * (Sbg * exp(-tsm) + fr) + dot(pb, LW) * Sx * exp(-kb * tsm)) * mot;
    float remStd, hRem, remW;
    vec3 rfac = resolvedFactor(g, pixAng, Lv, remStd, hRem, remW) - 1.0;
    // the unresolved remainder is not smooth either: the Poisson fluctuation of its many faint stars, a grain at the
    // finest active cell scale (two octaves, handed over with the lattice), footprint-filtered
    float rn = 0.0;
    float fr1 = 0.9 / hRem;
    rn += remW * fade(fr1, fp) * (snoise(g * fr1 + 3.7) + snoise(g * fr1 * 1.41 - 8.1)) * remStd;
    rn += (1.0 - remW) * fade(0.5 * fr1, fp) * (snoise(g * 0.5 * fr1 - 1.9) + snoise(g * 0.71 * fr1 + 5.3)) * remStd * 1.41;
    rfac += uRemK.x * rn;
    // (never let the grain outlive its own glow: below the display toe the diffuse light is crushed to black, and
    // isolated grain points would read as glitter)
    float vis = dot(cb + pc * fr, LW) * kg * uMWK * uSkyGain * uExpo;
    cg += (cb + pc * fr) * kg * rfac * smoothstep(0.0006, 0.004, vis);
  }
  float Lm = dot(cg, LW);
  float Lo = dot(co, LW);
  c = (max(vec3(0.0), mix(vec3(Lm), cg, uSat)) + max(vec3(0.0), mix(vec3(Lo), co, uSatObj))) * uMWK;
  if (uBeta > 1e-4) {
    vec3 tint = bbColour(5600.0 * pow(dop, dop < 1.0 ? min(1.0, uDopT * 1.7) : uDopT)) / bbColour(5600.0);
    tint = mix(vec3(dot(tint, LW)), tint, dop < 1.0 ? 0.55 : 1.0);
    // tempered Doppler beaming: brighter ahead; the trailing sky reddens and dims but never goes black
    c *= tint * (dop < 1.0 ? max(pow(dop, uDopRec.x), uDopRec.y) : min(pow(dop, uDopP), 12.0));
  }
  gl_FragColor = vec4(c * uSkyGain, 1.0);
}
`;

export const STAR_VERT = /* glsl */ `
${ABERRATION}
${LUT_FN}
attribute vec2 corner;
attribute vec3 aDir;
attribute float aMag;
attribute float aTemp;
uniform vec2 uRes;
uniform float uK;          // pixel-sum energy of a mag-0 star
uniform float uSkyGain;
uniform float uSigma;      // PSF core sigma (device px)
uniform float uHaloF, uHaloA, uHaloB, uHaloN, uHaloMax;
uniform float uThresh;
uniform float uBeta;
uniform float uStreakDB;
uniform float uStreakMax;  // streak length cap, fraction of the frame height
uniform vec2 uDopRec;      // receding side: Doppler exponent, brightness floor
uniform vec3 uVelDir;
uniform float uDopP;
uniform float uSat;
uniform float uSatMag;     // stars fainter than this lose chroma (photographic: faint images are near neutral)
uniform float uGrowE, uGrowP; // photographic growth: sigma *= (E / uGrowE)^uGrowP above saturation
varying vec2 vP;
varying float vE;
varying float vL;
varying float vH;
varying float vS;
varying float vSx;
varying vec3 vCol;

vec2 toPx(vec4 clip) { return (clip.xy / clip.w * 0.5 + 0.5) * uRes; }

void main() {
  vec3 n0 = aDir;
  vec3 n = n0;
  float dop = 1.0;
  if (uBeta > 1e-4) n = aberrateFwd(n0, uVelDir, uBeta, dop);
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(n * 1.0e7, 1.0);
  float E = uK * uSkyGain * exp(-0.921034 * aMag);
  // Doppler brightening ahead, tempered dimming behind (the trailing sky reddens and thins, it never goes black)
  if (uBeta > 1e-4) E *= dop < 1.0 ? max(pow(dop, uDopRec.x), uDopRec.y) : min(pow(dop, uDopP), 25.0);
  vec2 px = toPx(clip);
  vec2 sv = vec2(0.0);
  if (uStreakDB > 0.0) {
    float d2;
    vec3 nb = aberrateFwd(n0, uVelDir, max(uBeta - uStreakDB, 0.0), d2);
    vec4 c2 = projectionMatrix * modelViewMatrix * vec4(nb * 1.0e7, 1.0);
    if (c2.w > 0.0) sv = px - toPx(c2);
    // soft cap at a few percent of the frame height: short, legible dashes radiating from the apex, never
    // frame-crossing parallel lines (which read as camera shake)
    float sl = length(sv);
    float lmax = uStreakMax * uRes.y;
    if (sl > 1e-3) sv *= lmax * (1.0 - exp(-sl / lmax)) / sl;
  }
  float L = length(sv);
  float s = uSigma * pow(max(E / uGrowE, 1.0), uGrowP);
  // the faintest field stars get a slightly softer image (energy conserved): they read as grain, not as dots
  s *= 1.0 + 0.3 * smoothstep(9.4, 10.6, aMag);
  // brightest pixel of the (possibly streaked) PSF, for culling
  float peak = E * 0.159 / (s * (s + 0.4 * L));
  // bright stars carry a larger share of their light in the halo (optics scatter, photographic bloom)
  float hf = uHaloF * (1.0 + 0.8 * smoothstep(3.0, 0.0, aMag));
  float hr = uHaloA * pow(max(E * hf * uHaloN / uThresh, 1.0), 0.5 / uHaloB);
  float h = clamp(max(3.3 * s + 1.0, hr), 3.3 * s + 1.0, uHaloMax);
  vec2 ndcPad = (vec2(h + L) * 2.0) / uRes;
  vec2 ndc = clip.xy / clip.w;
  if (clip.w <= 0.0 || peak < uThresh || abs(ndc.x) > 1.0 + ndcPad.x || abs(ndc.y) > 1.0 + ndcPad.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vE = 0.0;
    return;
  }
  vec2 ax = L > 1e-3 ? sv / L : vec2(1.0, 0.0);
  vec2 local = corner * vec2(h + 0.5 * L, h);
  vec2 off = ax * local.x + vec2(-ax.y, ax.x) * local.y;
  vec2 mid = px - 0.5 * sv;
  gl_Position = vec4(((mid + off) / uRes * 2.0 - 1.0) * clip.w, clip.z, clip.w);
  vP = local;
  vS = s;
  // a streak keeps the thin, unsaturated core width across its length (the photographic growth of a bright star's
  // image would turn it into a fat lozenge); the extra light goes into its length and a brighter head
  vSx = mix(s, min(s, uSigma * 1.2), clamp(L / (3.0 * s), 0.0, 1.0));
  vE = E * (1.0 - hf);
  vL = L;
  vH = E * hf * (2.0 * uHaloA / (2.0 * uHaloA + L));
  vec3 col = bbColour(aTemp * pow(dop, dop < 1.0 ? min(1.0, uDopT * 1.7) : uDopT));
  float cl = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // chroma fades for faint stars (their images are small, noisy and photographically near-neutral)
  float sat = uSat * pow(clamp(exp(-0.921034 * (aMag - uSatMag)), 0.0, 1.0), 0.35);
  vCol = mix(vec3(cl), col, uBeta > 1e-4 ? max(sat, 0.8) : sat);
}
`;

export const STAR_FRAG = /* glsl */ `
precision highp float;
uniform float uSigma;
uniform float uHaloF, uHaloA, uHaloB, uHaloN;
varying vec2 vP;
varying float vE;
varying float vL;
varying float vH;
varying float vS;
varying float vSx;
varying vec3 vCol;
float erfA(float x) { // Abramowitz & Stegun 7.1.26
  float s = sign(x);
  x = abs(x);
  float t = 1.0 / (1.0 + 0.3275911 * x);
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return s * y;
}
void main() {
  if (vE <= 0.0) discard;
  float s = vS;
  float a = vP.x, c = vP.y;
  float sx = vSx;
  float across = exp(-0.5 * c * c / (sx * sx)) * (0.39894228 / sx);
  float along;
  if (vL < 0.05) along = exp(-0.5 * a * a / (s * s)) * (0.39894228 / s);
  else {
    // uniform segment (the motion over the exposure) plus a bright head at the leading end carrying up to 45 % of
    // the light, so every star stays legible as a point; both normalised, so the star's energy is conserved
    float seg = 0.5 * (erfA((a + 0.5 * vL) * (0.70710678 / sx)) - erfA((a - 0.5 * vL) * (0.70710678 / sx))) / vL;
    float hs = sx * 1.5;
    float ha = a - 0.5 * vL;
    float head = exp(-0.5 * ha * ha / (hs * hs)) * (0.39894228 / hs);
    float hf = 0.45 * smoothstep(2.0, 16.0, vL);
    along = mix(seg, head, hf);
  }
  float da = max(abs(a) - 0.5 * vL, 0.0);
  float r2 = da * da + c * c;
  float halo = uHaloN * pow(1.0 + r2 / (uHaloA * uHaloA), -uHaloB);
  vec3 L = vCol * (vE * along * across + vH * halo);
  gl_FragColor = vec4(L, 1.0);
}
`;
