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
uniform float uSharp;     // log-tau unsharp mask
uniform float uFExt;      // fraction of the foreground screen in front of the nearest stars
uniform vec2 uEdge2;      // steepening of ln tau about the visual edge: strength, ln tau of the edge
uniform float uTauCap;    // saturation of the small-cloud optical depth above the ~2 deg column
uniform vec3 uPop;        // disk T, bulge T, DGL strength
uniform float uExpo;     // the shot's exposure (grain gating under the display toe)
uniform float uDetail;    // 0..1 master switch for procedural detail
uniform vec2 uGate;       // displayed brightness over which the procedural detail fades in
uniform float uShoulder;  // displayed radiance at which the diffuse light's shoulder sets in
uniform float uRedK;      // reddening strength of the dust (1 = the standard extinction curve)
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

// The dust column at full detail. Returns tau (V) for the background light.
//   1. the IRAS-resolution map, sampled at an explicit, footprint-matched LOD (seam-free, no aliasing), its lookup
//      warped by a tileable fBm so cloud outlines are ragged instead of bilinear-smooth
//   2. a log-space unsharp mask (restores the edge contrast the 4' beam took away)
//   3. filaments: two layers of ridged multifractal noise from a tile, laid out in Galactic coordinates and stretched
//      along the plane (the lanes of the Great Rift run along it), the second sheared across the first; they add to
//      ln tau where the data has dust at all, so the smooth far-IR column breaks up into dark streamers and the
//      star clouds between them stay clear. Mip-filtered by construction.
uniform sampler2D tNoise; // tileable: R, B fBm; G, A ridged filaments
uniform vec4 uFil;        // tile repeats around the plane (integer), latitude stretch, strength (e-folds), warp (texels)
uniform vec4 uFilM;       // means of the two ridged channels, tile size, second-layer strength
float dustTau(vec2 uv, float b, float lgal, float pixAng, float lsm, float wD, out float lnTauS) {
  float cb = max(cos(b), 1e-3);
  float yy = (uv.y - 0.5) * 2.0;
  float texU = 2.0 * PI * cb / uDustTex.x;
  float texV = (0.5 * PI) * uLatK * cosh(uLatK * yy) / uSinhK * (2.0 / uDustTex.y);
  float texel = max(texU, texV);
  float lod = max(0.0, log2(pixAng / texel));
  float fil = 0.0;
  if (wD > 0.0) {
    // (procedural structure only near the plane: Galactic longitude is a fair coordinate there)
    float wb = wD * (1.0 - smoothstep(0.5, 1.0, abs(b)));
    float kq = uFil.x / (2.0 * PI);
    vec2 q = vec2(lgal * kq, b * kq * uFil.y);
    float texN = 1.0 / (kq * uFilM.z);                       // tile texel along the plane (rad)
    float lodN = max(0.0, log2(pixAng * uFil.y / texN));
    vec4 n1 = textureLod(tNoise, q, lodN);
    // second layer: 3x finer, sheared (lanes that leave the plane at an angle), offset
    vec2 q2 = vec2(q.x * 3.0 + q.y * 1.1, q.y * 2.2) + vec2(0.31, 0.57);
    vec4 n2 = textureLod(tNoise, q2, max(0.0, lodN + 1.585));
    vec2 dw = (n1.rb - 0.5) * 2.0 + (n2.rb - 0.5);
    float ang = uFil.w * 0.00154 * wb;                       // warp, in IRAS texels (0.088 deg)
    uv += dw * ang * vec2(1.0 / (2.0 * PI * cb), 1.0 / (texV * uDustTex.y));
    fil = wb * ((n1.g - uFilM.x) + uFilM.w * (n2.a - uFilM.y));
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
  // filaments, where there is dust to form them (tau > ~0.1), strongest on the visible edges
  d += uFil.z * fil * smoothstep(-2.6, -0.4, lb2);
  float lt = lb2 + d;
  if (wD > 0.0) {
    // the visual edge of a dark cloud is where its optical depth crosses ~1: steepen ln tau about that level (not
    // about the local mean, which turned every fluctuation of the column into a sharp-edged cell), as far as the
    // footprint allows -- thick clouds get darker and crisper, thin screens clearer
    float tpx2 = texel / pixAng;
    float x = lt - uEdge2.y;
    // (local: the slope at the edge rises to 1 + strength, columns far from the edge level keep their value)
    lt += wD * uEdge2.x * clamp((tpx2 - 0.6) / 2.0, 0.0, 1.0) * x * exp(-x * x * (0.5 / (0.6 * 0.6)));
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
uniform float uBulgeLift;
uniform float uDiskVJ;    // V/J light ratio of the disk population relative to the bulge's K giants
vec3 popColour(vec3 g) {
  float bf = bulgeFrac(g);
  // the layer is near-IR (DIRBE 1.25 um) light: the young disk is bluer than the old bulge (V-J ~1.3 vs ~2.0),
  // so per unit J light it is brighter in the visible -- Cygnus, Carina and Crux against the Sagittarius clouds
  // (uBulgeLift: the photographic swell of the bulge -- its old giants are the brightest diffuse light in the sky)
  return bbColour(mix(uPop.x, uPop.y, bf)) * mix(uDiskVJ, 1.0 + uBulgeLift, bf);
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

// Resolved star clouds. The diffuse light of the Milky Way is the sum of stars: part of it is redistributed into
// points by a star-dust tile (a dense random field of point stars with a power-law flux distribution, mean 1 at
// every mip level), laid on the faces of an equal-angle cube in Galactic coordinates. Octaves of the tile, a factor 2
// apart in angular scale, are switched in by pixel footprint: the octave whose texel matches the pixel is a grain of
// individual faint stars, the coarser ones (seen through their mips) are the clumping of the star clouds, and a tile
// that is minified further is exactly the smooth light -- so the grain is filtered by construction (no aliasing, no
// twinkle), and zooming in resolves more and more stars, as a longer focal length does.
uniform sampler2D tStar;  // R, G: sqrt(flux / vmax) of two independent star fields
uniform vec4 uStarT;      // texel angle of octave 0 (rad), 1 / tile size, vmax, unused
uniform int uGrainN;      // number of octaves (quality)
uniform vec4 uGrain;      // share of the light in resolved points, clump (coarse-octave) gain, colour jitter, floor
vec2 starGrain(vec3 g, float pixAng) {
  vec3 a = abs(g);
  vec2 p;
  float m, face;
  if (a.x >= a.y && a.x >= a.z) { m = a.x; p = g.yz; face = g.x > 0.0 ? 0.0 : 1.0; }
  else if (a.y >= a.z) { m = a.y; p = g.zx; face = g.y > 0.0 ? 2.0 : 3.0; }
  else { m = a.z; p = g.xy; face = g.z > 0.0 ? 4.0 : 5.0; }
  vec2 cuv = atan(p / m);            // equal-angle face coordinates (rad), nearly uniform over the face
  float acc = 0.0, jit = 0.0, wsum = 0.0;
  for (int o = 0; o < uGrainN; o++) {
    float ao = uStarT.x * exp2(-float(o));
    float r = pixAng / ao;            // tile texels per pixel
    if (r > 3.6 || r < 0.3) continue;
    // a magnified tile would show its stars as blobs: it fades out and the next finer octave takes over; a
    // minified one keeps only its clumping
    float w = smoothstep(0.3, 0.62, r) * mix(1.0, uGrain.y, smoothstep(1.3, 2.6, r));
    vec2 uv = cuv * (uStarT.y / ao) + vec2(0.37, 0.61) * face + vec2(0.13, 0.29) * float(o);
    vec2 t = textureLod(tStar, uv, max(log2(r), 0.0)).rg;
    t *= t * uStarT.z;
    float v = mod(float(o), 2.0) < 0.5 ? t.r : t.g;
    acc += w * (v - 1.0);
    jit += w * (t.r - t.g);
    wsum += w;
  }
  // (between the stars every octave reads ~0: normalised, the smooth share of the light never drops below 1 - k)
  return vec2(acc, jit) / max(wsum, 1.0);
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
  const vec3 LW = vec3(0.2126, 0.7152, 0.0722);
  // the bulge: its K giants sit 8 kpc away, behind nearly all the dust at |b| > 3 deg, but the IRAS column
  // overestimates the extinction toward the bulge there (warm dust, SFD's known excess at low latitude: Baade's
  // window has A_V ~ 1.6, not ~2.7) -- a reduced screen, rising to more than the full column in the mid-plane
  float ld = lgal * (180.0 / PI), bd = bb * (180.0 / PI);
  float Sx = bulgeExcess(ld, bd, Sbg);
  // procedural detail (dust filaments, star grain) only where there is light for it to shape: most of the sky, and
  // every frame exposed for a sunlit body, takes the cheap path
  // diffuse objects (their dust also screens the Milky Way light behind them)
  float tauS = 0.0;
  vec3 co = vec3(0.0);
  if (uObjCount > 0) co = objects(dr, fp, tauS) * uObjToTex;
  float wD = uDetail * smoothstep(uGate.x, uGate.y, (Sbg + Sx + F + dot(co, LW)) * uMWK * uSkyGain * uExpo);
  float lnTauS;
  float tau = dustTau(uv, bb, lgal, pixAng, lsm, wD, lnTauS);
  // per-pixel extinction: background light dimmed and reddened, the nearest stars almost untouched
  vec3 bg = Sbg * exp(-tau - (KC - 1.0) * (rhoR * tau) * uRedK);
  float fr = F * exp(-uFExt * tau);
  // diffuse galactic light: dust scatters the ambient starlight (faint cirrus glow at high latitude)
  // (the ambient field a cloud scatters is the whole sky's starlight, brightest toward the plane; an opaque cloud
  // far from the plane is therefore only a few times darker than its faint background, never a black cut-out)
  float amb = 0.045 + 0.06 * exp(-abs(bb) * (180.0 / PI) / 10.0);
  float dgl = uPop.z * amb * (1.0 - exp(-tau));
  bg *= exp(-tauS * KC);
  vec3 pc = popColour(g);
  float kb = mix(uBulgeK.x, uBulgeK.y, exp(-bd * bd / (2.2 * 2.2)));
  vec3 pb = bbColour(uPop.y);
  // starlight (resolves into star clouds) and the smooth dust-scattered glow
  vec3 cs = pc * (bg + fr) + pb * (Sx * exp(-kb * tau * (1.0 + (KC - 1.0) * uRedK) - tauS * KC));
  vec3 c = cs + pc * dgl;
  // photographic response: compress the luminance range about the Sgr star cloud, keep chroma. It is taken from the
  // smooth light, so the star grain below keeps its full contrast
  float Lc = max(dot(c, LW), 1e-9);
  float kg = pow(Lc / 0.86, uMWGamma - 1.0);
  float G = 1.0;
  if (wD > 0.0 && uGrainN > 0) {
    vec2 gr = starGrain(g, pixAng);
    G = max(1.0 + uGrain.x * wD * gr.x, uGrain.w);
    float j = clamp(gr.y, -3.0, 3.0) * uGrain.z * wD;
    c = cs * G * vec3(1.0 + j, 1.0, 1.0 - 1.3 * j) + pc * dgl;
  }
  // shoulder: however the shot is exposed, the brightest star clouds stop short of clipping and keep their colour
  kg /= 1.0 + Lc * kg * uMWK * uSkyGain * uExpo / uShoulder;
  vec3 cg = c * kg;
  // diffuse objects share the same response (texture units = output / uMWK)
  if (co.r + co.g + co.b > 0.0) {
    vec3 ct = cs + pc * dgl + co;
    float Lt = max(dot(ct, LW), 1e-9);
    float ko = pow(Lt / 0.86, uMWGamma - 1.0);
    ko /= 1.0 + Lt * ko * uMWK * uSkyGain * uExpo / uShoulder;
    // (galaxies, clusters and the star fields the nebulae sit in resolve into the same grain)
    co = (ct * ko - (cs + pc * dgl) * kg) * mix(1.0, G, 0.7);
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
attribute vec3 aDir;       // unit direction (the deep field ships it as normalised int16)
attribute vec2 aMT;        // encoded magnitude and temperature (see uDec)
uniform vec4 uDec;         // V = uDec.x + uDec.y aMT.x;  T = exp(uDec.z + uDec.w aMT.y)
uniform float uCut;        // the quad ends where the image falls below this radiance
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
uniform vec3 uMagC;         // magnitude compression: pivot magnitude, slope below it, extra slope below V = 8
uniform float uWarpDim;    // extra magnitudes per magnitude below V = 6 while at warp
uniform float uHaloSat;    // chroma boost of the halo (the glow keeps the star's colour where the core clips)
varying vec3 vColH;
varying vec2 vP;
varying float vE;
varying float vL;
varying float vH;
varying float vS;
varying float vSx;
varying vec3 vCol;

vec2 toPx(vec4 clip) { return (clip.xy / clip.w * 0.5 + 0.5) * uRes; }

void main() {
  vec3 n0 = normalize(aDir);
  float aMag = uDec.x + uDec.y * aMT.x;
  float aTemp = exp(uDec.z + uDec.w * aMT.y);
  vec3 n = n0;
  float dop = 1.0;
  if (uBeta > 1e-4) n = aberrateFwd(n0, uVelDir, uBeta, dop);
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(n * 1.0e7, 1.0);
  // photographic response: below the pivot magnitude the flux is compressed (a deep exposure shows a V = 10 star
  // only a few times fainter than a V = 6 one; brightness differences turn into image size at the bright end)
  float mEff = aMag < uMagC.x ? aMag : uMagC.x + (aMag - uMagC.x) * uMagC.y;
  mEff += uMagC.z * max(aMag - 8.0, 0.0);
  // at warp the faint field thins out (aberration crowds 5x the stars into the forward sky and Doppler-brightens
  // them: the streaks must stay separate lines, not a blizzard)
  mEff += uWarpDim * max(aMag - 6.0, 0.0);
  float E = uK * uSkyGain * exp(-0.921034 * mEff);
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
  // (at warp a bright star's image grows less: it is drawn out into a line instead)
  float s = uSigma * pow(max(E / uGrowE, 1.0), uGrowP * (1.0 - 0.5 * min(1.0, uBeta * 1.6)));
  // the faintest field stars get a slightly softer image (energy conserved): they read as grain, not as dots
  s *= 1.0 + 0.25 * smoothstep(10.5, 12.3, aMag);
  // brightest pixel of the (possibly streaked) PSF, for culling
  float peak = E * 0.159 / (s * (s + 0.4 * L));
  // bright stars carry a larger share of their light in the halo (optics scatter, photographic bloom)
  float hf = uHaloF * (1.0 + 0.8 * smoothstep(3.0, 0.0, aMag));
  float hr = uHaloA * pow(max(E * hf * uHaloN / (0.5 * uCut), 1.0), 0.5 / uHaloB);
  // the quad covers the core out to where it falls below the cut (faint stars: a few pixels) and the halo likewise
  float hc = min(3.3 * s, s * sqrt(2.0 * log(max(peak / uCut, 1.0)))) + 1.0;
  float hv = E * hf * uHaloN > uCut ? 1.0 : 0.0;
  float h = clamp(max(hc, hr * hv), hc, uHaloMax);
  vec2 ndcPad = (vec2(h + L) * 2.0) / uRes;
  vec2 ndc = clip.xy / clip.w;
  if (clip.w <= 0.0 || peak < mix(uThresh, uCut, min(1.0, 4.0 * uBeta)) || abs(ndc.x) > 1.0 + ndcPad.x || abs(ndc.y) > 1.0 + ndcPad.y) {
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
  vH = hv * E * hf * (2.0 * uHaloA / (2.0 * uHaloA + L));
  vec3 col = bbColour(aTemp * pow(dop, dop < 1.0 ? min(1.0, uDopT * 1.7) : uDopT));
  float cl = dot(col, vec3(0.2126, 0.7152, 0.0722));
  // chroma fades for faint stars (their images are small, noisy and photographically near-neutral)
  float sat = uSat * pow(clamp(exp(-0.921034 * (aMag - uSatMag)), 0.0, 1.0), 0.2);
  sat = uBeta > 1e-4 ? max(sat, 0.8) : sat;
  vCol = max(mix(vec3(cl), col, sat), 0.0);
  vColH = max(mix(vec3(cl), col, sat * uHaloSat), 0.0);
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
varying vec3 vColH;
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
    // tapered tail: the light piles up toward the leading end (2.5 t^1.5 integrates to 1 along the streak)
    float tt = clamp(0.5 + a / vL, 0.0, 1.0);
    seg *= mix(1.0, 2.5 * tt * sqrt(tt), smoothstep(3.0, 10.0, vL));
    float hs = sx * 1.25;
    float ha = a - 0.5 * vL;
    float head = exp(-0.5 * ha * ha / (hs * hs)) * (0.39894228 / hs);
    float hf = 0.45 * smoothstep(2.0, 16.0, vL);
    along = mix(seg, head, hf);
  }
  float da = max(abs(a) - 0.5 * vL, 0.0);
  float r2 = da * da + c * c;
  vec3 L = vCol * (vE * along * across);
  if (vH > 0.0) L += vColH * (vH * uHaloN * pow(1.0 + r2 / (uHaloA * uHaloA), -uHaloB));
  gl_FragColor = vec4(L, 1.0);
}
`;
