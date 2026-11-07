// Mercury surface shaders.
//
// Everything is evaluated in the body-fixed frame with the planet radius = 1 ("R units"):
//   N      unit direction from the centre (lat = asin(N.y), lon = atan(-N.z, N.x))
//   uSunL  unit vector toward the Sun, uCamL camera position (both body-fixed, R units)
//
// Rendering: at every distance the planet is a bounding shell (radius 1 + uHG) whose view rays are marched against
// the true height field in a lean pre-pass (MARCH_PASS: hit distance, skyline coverage), then shaded by one shading
// program that reads that hit (ray differentials for the pixel footprint). Two programs in all, written for the
// D3D shader compiler that Chrome on Windows runs at first draw: every loop has a non-constant bound (FXC keeps it
// rolled instead of unrolling it) and every expensive function has a single call site.
//
// Layers, coarse to fine:
//   1. MESSENGER USGS DEM v2 (1664x832, B-spline coefficients, evaluated exactly): normals by finite differences on a
//      pole-safe tangent basis, the horizon march for cast shadows.
//   2. Procedural crater lattice, 12 octaves (r ~20 km down to ~10 m), 2x2x2 cells, three populations (craters of every
//      age, degraded ghosts, young rayed craters), blended in by pixel footprint. Each crater has an age (depth, rim
//      rounding, floor infill, albedo contrast), rim harmonics, simple bowl -> terraced complex crater with central
//      massifs, ejecta, and its own analytic rim / massif shadow.
//   3. Fractal micro-relief and the real 665 m/px MESSENGER texture tile at three scales.
// Photometry: Lunar-Lambert (Lommel-Seeliger/Lambert partition L(g)) times a phase function with a
// shadow-hiding opposition surge, fitted to Mercury's observed disc-integrated V-band phase curve (Mallama 2002).
// Albedo: MESSENGER MDIS MD3 mosaic, de-stretched to a relative normal albedo, mean 0.142 (geometric albedo),
// in natural colour (a faint spectral-slope tint on a warm grey base).

export const MERCURY_COMMON = /* glsl */ `
#define PI 3.14159265359
uniform int uZero;        // always 0: loop bounds "n + uZero" are not compile-time constants, so FXC (ANGLE/D3D) emits
                          // real loops instead of unrolling them (shader compile time)
uniform sampler2D uDem;
uniform sampler2D uDemP;
uniform sampler2D uAux;   // r: crater patchiness noise, g: crater-density map (baked once at load, see mercury.js)
uniform vec2 uDemSize;
uniform float uDemMin;    // R units
uniform float uDemScale;  // R units per (texel value 0..1)

vec2 dirToUV(vec3 d) {
  float lon = atan(-d.z, d.x + 1e-30); // (1e-30: defined at the poles)
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2(lon * (0.5 / PI) + 0.5, lat * (1.0 / PI) + 0.5);
}

// Cubic B-spline lookup of the DEM coefficients, evaluated exactly in float. uDemP holds, per texel (X, Y), the 2x2
// block of coefficients c(X-1..X, Y-2..Y-1) (longitude wrapped, rows clamped; built once at load in mercury.js),
// so the 16 coefficients come from 4 texelFetch. (The usual 4-bilinear-tap trick runs through the texture unit's
// 8-bit sub-texel weights: the DEM then moves in 1/256-texel steps of a few metres, which a grazing Sun turns into
// blocky ~35 m stair-steps along every shadow edge.)
float bsplineDem(vec2 uv) {
  vec2 st = uv * uDemSize - 0.5;
  vec2 i = floor(st);
  vec2 f = st - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) * (1.0 / 6.0);
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) * (1.0 / 6.0);
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) * (1.0 / 6.0);
  vec2 w3 = f3 * (1.0 / 6.0);
  int W = int(uDemSize.x);
  int ix = int(i.x), iy = int(i.y);
  int xa = ix + W * (int(ix < 0) - int(ix >= W));
  int xb = ix + 2 - W * int(ix + 2 >= W);
  vec4 A = texelFetch(uDemP, ivec2(xa, iy + 1), 0); // c(i-1, j-1) c(i, j-1) c(i-1, j) c(i, j)
  vec4 B = texelFetch(uDemP, ivec2(xb, iy + 1), 0); // columns i+1, i+2
  vec4 C = texelFetch(uDemP, ivec2(xa, iy + 3), 0); // rows j+1, j+2
  vec4 D = texelFetch(uDemP, ivec2(xb, iy + 3), 0);
  vec4 wx = vec4(w0.x, w1.x, w2.x, w3.x);
  return dot(vec4(w0.y, w1.y, w2.y, w3.y), vec4(dot(wx, vec4(A.xy, B.xy)), dot(wx, vec4(A.zw, B.zw)),
                                                 dot(wx, vec4(C.xy, D.xy)), dot(wx, vec4(C.zw, D.zw))));
}

// DEM height (R units) at uv, prefiltered to a mip level (<= 0: the exact B-spline on level 0)
float demHuv(vec2 uv, float lod) {
  float v = 0.0;
  if (lod < 1.0) v = bsplineDem(uv);
  if (lod > 0.0) v = mix(v, textureLod(uDem, uv, lod).r, min(lod, 1.0));
  return uDemMin + v * uDemScale;
}
`;

// Bounding shell: a sphere of radius 1 + uHG drawn with its back faces; every pixel's view ray is marched against the
// height field (see MERCURY_FRAG).
export const MERCURY_VERT_RELIEF = /* glsl */ `
uniform float uHG;
varying vec3 vLocal;
void main() {
  vLocal = normalize(position) * (1.0 + uHG);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(vLocal, 1.0);
}
`;

// One-off pass at load: crater patchiness noise (r) and the crater-density map (g) into one equirectangular texture.
export const MERCURY_AUX_FRAG = /* glsl */ `
#define PI 3.14159265359
uniform sampler2D uDensity;
uniform vec2 uSize;
float hash13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x), w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), f = hash13(i + vec3(1, 0, 1)), g = hash13(i + vec3(0, 1, 1)), h = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f, u.x), mix(g, h, u.x), u.y), u.z);
}
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float lon = (uv.x - 0.5) * 2.0 * PI, lat = (uv.y - 0.5) * PI;
  vec3 N = vec3(cos(lat) * cos(lon), sin(lat), -cos(lat) * sin(lon));
  // ~110 km patches plus a ~35 km modulation: heavily cratered terrain next to locally smoother plains
  float pat = smoothstep(0.25, 0.85, 0.7 * vnoise(N * 22.0 + 40.0) + 0.3 * vnoise(N * 70.0 + 13.0));
  gl_FragColor = vec4(pat, textureLod(uDensity, uv, 0.0).r, 0.0, 1.0);
}
`;

export const MERCURY_FRAG = /* glsl */ `
${MERCURY_COMMON}
uniform sampler2D uAlbedo;   // relative normal albedo, linear: rel = lo + v * (hi - lo)
uniform vec2 uAlbedoSize;
uniform vec2 uAlbedoRange;   // (lo, hi - lo)
uniform sampler2D uTint;     // rgb: natural-colour tint * 0.5 (sRGB-decoded)
uniform sampler2D uDetailTex; // tileable high-pass of the 665 m/px MESSENGER mosaic (log albedo ratio)
uniform float uDetailRange;
uniform float uTileR;        // tile size, R units
uniform vec3 uSunL;
uniform vec3 uCamL;
uniform vec3 uCamF;        // camera forward (body frame, unit)
uniform vec3 uPixX, uPixY; // change of the un-normalised view ray (forward component 1) per pixel along x / y
// Ray differentials of the unit view direction D, analytic (screen-space derivatives are undefined next to pixels of
// the quad that discarded or returned, which a compiler may move them past)
void rayDiff(vec3 D, out vec3 dDx, out vec3 dDy) {
  float k = dot(D, uCamF);
  dDx = (uPixX - D * dot(D, uPixX)) * k;
  dDy = (uPixY - D * dot(D, uPixY)) * k;
}
uniform vec3 uSunColor;
uniform float uSunAng;       // angular radius of the solar disc seen from Mercury (rad)
uniform float uMeanAlbedo;
uniform vec3 uBaseColor;     // luminance-normalised warm grey
uniform float uGain;
uniform float uDetail;       // 0..1 global detail switch (quality)
uniform float uCraterS0;     // cell size of the largest procedural crater octave (R units)
uniform float uDebug;
uniform float uFpScale;    // footprint multiplier (1; tests use 2 for an LOD-matched supersampled reference)
uniform float uDetailFp;   // procedural-detail LOD bias (quality: high 1, med 1.6)
uniform float uHG;         // relief shell: global upper bound of the surface height (R units)
uniform float uStepK;      // relief march: minimum step in pixel footprints
uniform float uFpGCap;     // relief march: cap of the grazing stretch of the geometric footprint
uniform float uFpLong;     // footprint: least fraction of the long (grazing) axis of the pixel footprint ellipse
uniform float uMarchOct;   // relief march: max crater octaves in the height field
uniform float uTileK;      // weight of the real-data detail tile
uniform int uSkip;         // debug/timing: bit0 craters, bit2 micro, bit3 tile, bit4 dem shadow, bit7 near field,
                           // bit8 crater shadows, bit9 young-crater albedo
uniform int uAniso;        // max anisotropic shading taps along the long axis of the pixel footprint
uniform int uTap;          // LIGHT: the tap this draw adds (one additive draw per tap)
uniform float uSinSun;     // sin(uSunAng)
uniform float uFillS;      // uMeanAlbedo x phaseS(1.2): the fill light's backscatter weight
uniform sampler2D uPre;    // march pre-pass: (t, coverage, skyline height, kind 0 miss/1 hit/2 skyline/3 night)
uniform mat4 projectionMatrix; // (three.js declares these for the vertex stage only)
uniform mat4 modelMatrix;
varying vec3 vLocal;

// ---------------------------------------------------------------- hashes / noise
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(.1031, .1030, .0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * .1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// value noise with analytic derivatives (Inigo Quilez): returns (value 0..1, d/dx, d/dy, d/dz)
vec4 noised(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * w * w * (w * (w - 2.0) + 1.0);
  float a = hash13(i + vec3(0, 0, 0));
  float b = hash13(i + vec3(1, 0, 0));
  float c = hash13(i + vec3(0, 1, 0));
  float d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1));
  float f = hash13(i + vec3(1, 0, 1));
  float g = hash13(i + vec3(0, 1, 1));
  float h = hash13(i + vec3(1, 1, 1));
  float k0 = a, k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d, k5 = a - c - e + g, k6 = a - b - e + f,
        k7 = -a + b + c - d + e - f - g + h;
  return vec4(k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z,
              du * vec3(k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
                        k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
                        k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y));
}
// trilinear value noise (value only; quintic fade)
float vnoise(vec3 x) {
  vec3 i = floor(x), w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  float a = hash13(i), b = hash13(i + vec3(1, 0, 0)), c = hash13(i + vec3(0, 1, 0)), d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1)), f = hash13(i + vec3(1, 0, 1)), g = hash13(i + vec3(0, 1, 1)), h = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f, u.x), mix(g, h, u.x), u.y), u.z);
}
// the same kind of noise (quintic value noise, lattice period 16) from a 64^3 texture built at load (mercury.js): one
// fetch instead of eight hashes, for the value-only uses (crater clumping, crest roughness)
uniform highp sampler3D uNoise3;
float tnoise(vec3 x) { return textureLod(uNoise3, x * (1.0 / 16.0), 0.0).r; }
// 2D value noise (4 hashes), for per-crater patterns
float vnoise2(vec2 x, float seed) {
  vec2 i = floor(x), w = fract(x);
  vec2 u = w * w * (3.0 - 2.0 * w);
  float a = hash13(vec3(i, seed)), b = hash13(vec3(i + vec2(1, 0), seed));
  float c = hash13(vec3(i + vec2(0, 1), seed)), d = hash13(vec3(i + vec2(1, 1), seed));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// ---------------------------------------------------------------- crater morphology
// Height in units of the crater radius r, x = distance / rim radius, and its derivative d/dx.
//   fresh simple (D < ~10 km): parabolic bowl, rim-to-floor 0.4 r (d/D 0.2), rim 0.08 r, ejecta ~ x^-3
//   fresh complex (D > ~14 km): flat floor out to ~0.42 r, terraced wall, d/D ~0.1 (central massifs: see massifs())
//   degradation (fresh -> 0): the caller scales the whole crater down to ~30 %; here the floor is infilled flat and
//   the rim crest rounded (k), so old craters read as shallow, flat-floored, soft-rimmed ghosts.
// Influence ends at x = 1.75 (the ejecta fade over 1.3..1.75). (Smooth-min blends differentiate to h a' + (1-h) b'.)
vec2 craterProfileD(float x, float cx, float fresh, float k) {
  float inS = -0.32 + 0.40 * x * x, dS = 0.8 * x;
  float tl = (x - 0.42) / 0.58;
  float t = clamp(tl, 0.0, 1.0);
  float W = pow(t, 1.7);
  float dW = 1.7 * pow(t, 0.7) / 0.58 * float(tl > 0.0) * float(tl < 1.0);
  float inside = mix(inS, -0.15 + 0.23 * W, cx), dIn = mix(dS, 0.23 * dW, cx);
  // infill: later ejecta and regolith creep raise and flatten the floors of old craters
  float old = 1.0 - fresh;
  float floorH = mix(-0.32, -0.15, cx) * (1.0 - 0.72 * old * old);
  dIn *= clamp(0.5 + 0.5 * (inside - floorH) / 0.04, 0.0, 1.0);
  inside = -smin(-inside, -floorH, 0.04);
  float hr = 0.08 - 0.03 * cx;
  float xo = max(x, 0.35);
  float u = clamp((x - 1.3) / 0.45, 0.0, 1.0);
  float fade = 1.0 - u * u * (3.0 - 2.0 * u);
  float io = hr / (xo * xo * xo);
  float outside = io * fade;
  float dOut = -3.0 * io / xo * float(x > 0.35) * fade - io * 6.0 * u * (1.0 - u) / 0.45;
  float hk = clamp(0.5 + 0.5 * (outside - inside) / k, 0.0, 1.0);
  return vec2(smin(inside, outside, k), mix(dOut, dIn, hk));
}

// craterProfileD(1).x and (0).x in closed form: rim crest and floor heights
vec2 crestFloor(float cx, float fresh, float k) {
  float old = 1.0 - fresh;
  float floorH = mix(-0.32, -0.15, cx) * (1.0 - 0.72 * old * old);
  return vec2(smin(0.08, 0.08 - 0.03 * cx, k), -smin(-mix(-0.32, -0.15, cx), -floorH, 0.04));
}

// periodic smooth value noise around a circle (m cells): ray / ejecta-lobe pattern
float rayLobes(float th, float m, float seed) {
  float u = th * (m / 6.2831853);
  float i = floor(u), f = fract(u);
  float a = hash13(vec3(mod(i, m), seed, 1.7)), b = hash13(vec3(mod(i + 1.0, m), seed, 1.7));
  return mix(a, b, f * f * (3.0 - 2.0 * f));
}

vec2 unit2(vec2 v) { return v * inversesqrt(dot(v, v) + 1e-6); }
vec2 rot120(vec2 v) { return vec2(-0.5 * v.x - 0.8660254 * v.y, 0.8660254 * v.x - 0.5 * v.y); }

// Central-peak complex: three elongated, overlapping massifs scattered around the centre (q in rim-radius units),
// each H exp(-rho^1.5) (pointed tops and ~25-35 deg flanks, not round Gaussian domes). Returns (height, d/dq) in
// rim-radius units. For the cast shadow toward ls (unit, q-plane) it also returns, per massif, the height of the
// massif on the Sun ray where it is most likely to be the occluder (A) and that distance along the ray (T): the
// ray's closest approach to the massif axis, pulled toward the receiver where the massif is wide (the maximum of
// H g(t) / t along the ray for a Gaussian, t* = (tc + sqrt(tc^2 - 2 s^2)) / 2). So peak shadows are elongated and
// taper to points along the light, instead of being stamped from a few march samples.
vec3 massifs(vec2 q, vec3 h, vec2 ls, out vec3 A, out vec3 T) {
  vec3 acc = vec3(0.0);
  A = vec3(0.0);
  T = vec3(1.0);
  vec2 dir = unit2(h.xy - 0.5);           // the three massifs sit ~120 deg apart around the centre (jittered)
  vec2 el = unit2(h.zx - 0.5);            // their elongation directions
  for (int i = 0; i < 3 + uZero; i++) {
    float fi = float(i);
    float j1 = fract(h.z * 7.13 + fi * 0.371), j2 = fract(h.y * 5.31 + fi * 0.613), j3 = fract(h.x * 3.17 + fi * 0.829);
    vec2 c = (0.03 + 0.11 * j1) * unit2(dir + 0.6 * vec2(j2 - 0.5, j3 - 0.5));
    float ht = 0.035 + 0.05 * j2;
    float wl = 0.08 + 0.07 * j3;
    vec2 e = unit2(el + vec2(j1 - 0.5, 0.0)), e2 = vec2(-e.y, e.x);
    vec2 sc = vec2(1.0 / wl, 1.0 / (0.62 * wl));
    vec2 p = vec2(dot(q - c, e), dot(q - c, e2)) * sc;
    float rho2 = dot(p, p);
    float rp = pow(rho2 + 1e-8, 0.75);
    float g = exp(-rp);
    acc.x += ht * g;
    vec2 dg = -1.5 * ht * g * pow(rho2 + 1e-8, -0.25) * p * sc; // d/dp of ht exp(-rho^1.5), back to q (e, e2)
    acc.yz += dg.x * e + dg.y * e2;
    // along the Sun ray q + t ls: p(t) = p + t l
    vec2 l = vec2(dot(ls, e), dot(ls, e2)) * sc;
    float a = dot(l, l);
    float tc = -dot(p, l) / a;
    float d2 = max(rho2 - a * tc * tc, 0.0);
    float ts = 0.5 * (tc + sqrt(max(tc * tc - 2.0 / a, 0.0)));
    float r2 = d2 + a * (ts - tc) * (ts - tc);
    float As = ht * exp(-pow(r2 + 1e-8, 0.75));
    vec3 sel = vec3(equal(ivec3(i), ivec3(0, 1, 2)));
    A += As * sel;
    T += (ts - 1.0) * sel;
    dir = rot120(dir);
    el = rot120(el);
  }
  return acc;
}

// Crater lattice. Octave o: 3D cells of size s = S0 / 2^o, three craters per cell (population 0: every age;
// population 1: old, degraded "ghost" craters that keep heavily cratered terrain hummocky; population 2: rare young
// rayed craters, octaves 0-4 only). A crater exists if its jittered centre lies within 0.25 s of the sphere
// (projected radially) and passes the local acceptance (crater density map x patchiness). Radii r <= 0.218 s with
// influence 1.75 r x 1.13 (rim harmonics) <= 0.433 s (rays 12 r <= 0.35 s), the least tangential distance of a centre
// in the shell outside the 2x2x2 cells around N, so every crater that can touch N belongs to those cells: seamless
// (no cube faces, no poles), and each octave's crater count per area ~ 1/s^2, i.e. a cumulative size-frequency
// N(>D) ~ D^-2 (equilibrium cratering).
// Local acceptance probability for an octave: smooth plains (low density) have fewer large craters, small ones
// saturate everywhere; patchy (0..1, one smooth noise per point shared by all octaves) makes the density vary over
// ~100 km (overlapping ejecta blankets, secondary fields, intercrater plains vs heavily cratered terrain).
float octaveAcc(float fo, float density, float patchy) {
  return mix(density, 1.0, clamp(fo / 7.0, 0.0, 1.0)) * mix(0.3, 1.6, patchy);
}

// Everything about one crater candidate that both the height and the shading evaluations need.
struct Crater {
  vec3 cu;      // unit centre
  vec3 e1, e2;  // tangent frame at the centre
  vec2 q;       // lookup point in rim-radius units, in (e1, e2)
  float r;      // mean rim radius (R units)
  float x;      // distance / local rim radius
  float rimS;   // local rim radius / mean (angular harmonics)
  float drim;   // d(rimS)/d(theta)
  float fresh;  // 0 old .. 1 pristine
  float amp;    // overall relief scale (degradation)
  float cx;     // simple -> complex
  float k;
  float wc;     // acceptance (x the population's own LOD weight)
  vec3 hs, hb, jit;
  float ea;     // rim harmonic amplitude
  int pop;
};

// cheap pre-test, no hashing: can cell (size s) hold a point of the band |r - 1| < 0.25 s near N? (the sphere is
// locally the plane through N normal to N; a cell's extent along N is 0.5 s (|Nx| + |Ny| + |Nz|) from its centre)
bool cellNearBand(vec3 cell, float s, vec3 N) {
  return abs(dot((cell + 0.5) * s - N, N)) < s * (0.5 * (abs(N.x) + abs(N.y) + abs(N.z)) + 0.25 + 1.2 * s); // (+ curvature)
}
float craterRadius(float hx, float s, int pop) {
  return s * mix(mix(0.06, 0.218, pow(hx, 1.25)), mix(0.0106, 0.029, hx), pop == 2);
}
float craterAcc(float hy, float pAcc, float density, int pop) {
  return mix(smoothstep(hy - 0.1, hy + 0.1, mix(pAcc, min(pAcc * 1.15, 1.0) * mix(0.4, 1.0, density), pop == 1)), step(hy, 0.08), pop == 2);
}
// local rim radius / mean at direction u1 (unit, crater plane): 2-, 3- and 5-fold harmonics, +-4..10 %, from angle sums
// of the unit vector (no trigonometry); and its derivative d/dtheta
vec2 rimAt(vec2 u1, vec2 f2, vec2 f3, vec2 f5, float ea) {
  vec2 u2 = vec2(u1.x * u1.x - u1.y * u1.y, 2.0 * u1.x * u1.y);
  vec2 u3 = vec2(u1.x * u2.x - u1.y * u2.y, u1.y * u2.x + u1.x * u2.y);
  vec2 u5 = vec2(u3.x * u2.x - u3.y * u2.y, u3.y * u2.x + u3.x * u2.y);
  // cos(n th + phi) = un.x f.x - un.y f.y;  d/dth = -n (un.y f.x + un.x f.y)
  return vec2(1.0 + ea * (0.6 * (u2.x * f2.x - u2.y * f2.y) + 0.45 * (u3.x * f3.x - u3.y * f3.y) + 0.25 * (u5.x * f5.x - u5.y * f5.y)),
              -ea * (1.2 * (u2.y * f2.x + u2.x * f2.y) + 1.35 * (u3.y * f3.x + u3.x * f3.y) + 1.25 * (u5.y * f5.x + u5.x * f5.y)));
}

// Candidate c (cell offset bits 0-2, population c >> 3) of this octave: false if it holds no crater within reach
// of N (cheap tests first: band, acceptance, reach), else everything the shading evaluations need.
bool craterGet(vec3 base, int c, float fo, float s, float pAcc, vec3 N, float fp, float density, float minFresh, out Crater cr) {
  vec3 cell = base + vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
  if (!cellNearBand(cell, s, N)) return false;
  int pop = c >> 3;
  float fpop = float(pop);
  vec3 jit = hash33(cell + fo * 19.19 + fpop * 41.37);
  vec3 cpos = (cell + jit) * s;
  float lc = length(cpos);
  vec3 hs = hash33(cell * 1.618 + fo * 7.31 + fpop * 13.7 + 3.7);
  float acc = craterAcc(hs.y, pAcc, density, pop);
  float r = craterRadius(hs.x, s, pop);
  vec3 cu = cpos / lc;
  vec3 dv = N - cu;
  dv -= N * dot(dv, N);
  // (1.75 x 1.13)^2: margin for the rim harmonics; rays 12 r
  if (any(bvec3(abs(lc - 1.0) > 0.25 * s, acc <= 0.0, dot(dv, dv) >= mix(3.95, 144.0, pop == 2) * r * r))) return false;
  vec3 hb = hash33(cell * 2.71 + fo * 3.3 + fpop * 29.1 + 11.0);
  // age: most craters are old and softened by later impacts, few are fresh; the younger smooth plains carry
  // fewer but on average fresher craters; population 1 is always degraded, population 2 pristine
  cr.fresh = mix(mix(pow(hb.x, mix(2.2, 3.2, density)), 1.0, pop == 2), 0.12 * hb.x, pop == 1);
  if (cr.fresh < minFresh) return false; // (callers that only need young craters)
  cr.pop = pop;
  cr.cu = cu;
  float ay = float(abs(cu.y) < 0.9);
  cr.e1 = normalize(cross(cu, vec3(1.0 - ay, ay, 0.0)));
  cr.e2 = cross(cu, cr.e1);
  cr.q = vec2(dot(dv, cr.e1), dot(dv, cr.e2)) / r;
  float qlen = length(cr.q);
  cr.ea = mix(0.04 + 0.06 * hb.z, 0.03, pop == 2);
  vec2 rs = rimAt(cr.q / max(qlen, 1e-6), unit2(hb.yz - 0.5), unit2(hs.zx - 0.5), unit2(jit.xy - 0.5), cr.ea);
  cr.rimS = rs.x;
  cr.drim = rs.y;
  cr.x = qlen / cr.rimS;
  cr.r = r;
  cr.amp = mix(0.24, 1.0, pow(cr.fresh, 0.7));
  cr.cx = smoothstep(0.0019, 0.0031, r);
  cr.k = mix(0.25, 0.02, cr.fresh) + 1.2 * fp / r;
  cr.wc = acc * float(cr.x < mix(1.75, 12.0, pop == 2));
  cr.hs = hs;
  cr.hb = hb;
  cr.jit = jit;
  return true;
}

// Octave weight by footprint (crater cell 0.2 s must span > ~1.8 px to appear); octave 0 is damped because the
// largest procedural craters overlap what the DEM already resolves.
float octaveWeight(int o, float s, float fp) {
  float w = smoothstep(1.8, 4.5, 0.2 * s / fp) * uDetail; // craters fade in from ~2 px across: no sub-pixel grain
  return w * mix(1.0, 0.75, o == 0);
}
// the degraded population (a third as deep) joins ~1.5 octaves after the fresh one
float pop1Weight(float s, float fp) { return smoothstep(5.0, 8.0, 0.2 * s / fp); }
// LOD weight of a crater's relief (x the octave weight for populations 0/1; rayed craters by their own size)
float craterLod(Crater cr, float w, float wPop1, float fp) {
  return mix(w * mix(1.0, wPop1, cr.pop == 1), smoothstep(1.0, 3.0, cr.r / fp) * uDetail, cr.pop == 2);
}


// ---------------------------------------------------------------- regolith roughness
// slope amplitude of roughness octave o (cell 11 km / 2^o): RMS slopes of ~6 deg at km baselines, rising toward
// ~8 deg at 100 m (MLA roughness of Mercury's cratered terrain, Kreslavsky et al. 2014; lunar highlands alike)
float roughAmp(int o) { return mix(0.04, 0.046, o < 4); }

// fraction of the solar disc above a horizon line x solar radii below the Sun's centre (x = (elev - horizon) / alpha)
float discAbove(float x) {
  // (the exact 0.5 + (x sqrt(1 - x^2) + asin x) / pi is within 0.04 of this cubic)
  return smoothstep(-1.0, 1.0, x);
}

// footprint of a pixel on the surface (R units) from its angular size times distance (pw) and the cosine of the
// view zenith angle: geometric mean of the two axes of the footprint ellipse, never below fl x its long axis
float footprint(float pw, float mu, float fl) {
  mu = max(mu, 1e-4);
  return pw * max(inversesqrt(mu), fl / mu);
}

#ifdef MARCH_PASS
// ================================================================ relief march (pre-pass)
// value-only twin of craterProfileD (identical formula)
float craterProfile(float x, float cx, float fresh, float k) {
  float W = pow(clamp((x - 0.42) / 0.58, 0.0, 1.0), 1.7);
  float inside = mix(-0.32 + 0.40 * x * x, -0.15 + 0.23 * W, cx);
  float old = 1.0 - fresh;
  inside = -smin(-inside, -mix(-0.32, -0.15, cx) * (1.0 - 0.72 * old * old), 0.04);
  float xo = max(x, 0.35);
  float u = clamp((x - 1.3) / 0.45, 0.0, 1.0);
  return smin(inside, (0.08 - 0.03 * cx) / (xo * xo * xo) * (1.0 - u * u * (3.0 - 2.0 * u)), k);
}
// Height (R units) of the crater field for the march: the same craters and profiles as the shading, octaves entering
// by the geometric footprint fpG and only while their depth spans >~1.5 px (pw = size of a pixel at that distance;
// 0.1 s is the depth of a large fresh crater of the octave), at most uMarchOct (<= 4) octaves, so the marched
// geometry never holds relief the shading lacks (beyond a pixel). The march evaluates the height many times along one
// ray: per octave the craters of the current 2x2x2 block are listed once (band + acceptance at the block centre, so
// every ray gets the same list) and reused until the ray's ground point leaves that block.
float craterMarchW(int o, float s, float fpG, float pw) {
  return octaveWeight(o, s, fpG) * smoothstep(1.0, 2.5, 0.1 * s / pw) * float(float(o) < uMarchOct);
}
// (height only: the same craters, centres, radii, ages and profiles as craterGet / craterProfileD, computed
// lean, and the candidates of each octave tested directly: the D3D compiler pays for every line and every loop level)
float craterHeight(vec3 N, float fpG, float pw) {
  float hsum = 0.0;
  vec4 aux = textureLod(uAux, dirToUV(N), 0.0);
  // octaves x candidates in one loop (a loop level less for the compiler); the octave setup runs at each octave start
  float s = uCraterS0, w = 0.0, fo = -1.0, pAcc = 0.0, wPop1 = 0.0;
  vec3 base = vec3(0.0);
  int nc = 0, ic = 0;
  for (int i = 0; i < 32 + uZero; i++) {
    if (ic >= nc) {
      fo += 1.0;
      s = uCraterS0 * exp2(-fo);
      w = craterMarchW(int(fo), s, fpG, pw);
      if (w <= 0.0 || fo > 1.5) break;
      pAcc = octaveAcc(fo, aux.g, aux.r);
      base = floor(N / s - 0.5);
      nc = 8; // (population 0; the degraded ghosts, a third as deep, are shading only)
      ic = 0;
    }
    int c = ic++;
    {
      vec3 cell = base + vec3(float(c & 1), float((c >> 1) & 1), float((c >> 2) & 1));
      if (!cellNearBand(cell, s, N)) continue;
      const float pop = 0.0;
      vec3 jit = hash33(cell + fo * 19.19 + pop * 41.37);
      vec3 cpos = (cell + jit) * s;
      float lc = length(cpos);
      vec3 hs = hash33(cell * 1.618 + fo * 7.31 + pop * 13.7 + 3.7);
      float acc = smoothstep(hs.y - 0.1, hs.y + 0.1, pAcc);
      float r = s * mix(0.06, 0.218, pow(hs.x, 1.25));
      vec3 cu = cpos / lc;
      vec3 dv = N - cu;
      dv -= N * dot(dv, N);
      if (any(bvec3(abs(lc - 1.0) > 0.25 * s, acc <= 0.0, dot(dv, dv) >= 3.95 * r * r))) continue;
      vec3 hb = hash33(cell * 2.71 + fo * 3.3 + pop * 29.1 + 11.0);
      float ay = float(abs(cu.y) < 0.9);
      vec3 e1 = normalize(cross(cu, vec3(1.0 - ay, ay, 0.0)));
      vec2 q = vec2(dot(dv, e1), dot(dv, cross(cu, e1))) / r;
      float qlen = length(q);
      float x = qlen; // (circular rims here: the shading's rim harmonics are a few % of r)
      if (x >= 1.75) continue;
      float fresh = pow(hb.x, mix(2.2, 3.2, aux.g));
      float cx = smoothstep(0.0019, 0.0031, r);
      float h = craterProfile(x, cx, fresh, mix(0.25, 0.02, fresh) + 1.2 * fpG / r);
      hsum += w * acc * mix(0.24, 1.0, pow(fresh, 0.7)) * r * h;
    }
  }
  return hsum;
}

// Full surface height (R units): DEM (B-spline, LOD by the geometric footprint) plus the procedural craters. The
// geometric footprint is the shading footprint with its grazing-angle stretch capped at uFpGCap, so silhouettes
// (horizon, far crater rims) keep their relief where the shading has averaged it out. coarse: an upper bound of the
// active octaves' crater relief instead of the craters (a fresh rim crest is 0.08 x 0.24 s high, x 0.75 for octave 0;
// overlapping rims of the other octaves add at most ~0.012 s each).
float gHCr; // the crater part of the last full height evaluation
float reliefH(vec3 n, float pw, float mu, float texR, bool coarse) {
  float fpG = pw * min(footprint(1.0, mu, uFpLong), uFpGCap);
  float h = demHuv(dirToUV(n), log2(fpG / texR));
  gHCr = 0.0;
  if (uDetail > 0.0) {
    if (coarse) {
      // (the marched octaves 0, 1 only; a finer octave is active only where the coarser one is)
      if (craterMarchW(0, uCraterS0, fpG * uDetailFp, pw * uDetailFp) > 0.0)
        h += uCraterS0 * (0.0145 + 0.006 * float(craterMarchW(1, 0.5 * uCraterS0, fpG * uDetailFp, pw * uDetailFp) > 0.0));
    } else {
      gHCr = craterHeight(n, fpG * uDetailFp, pw * uDetailFp);
      h += gHCr;
    }
  }
  return h;
}

void main() {
  float texR = 2.0 * PI / uDemSize.x;
  vec3 L = uSunL;
  // The view ray (body frame, R units) runs from the bounding sphere 1 + uHG to the first point below the terrain,
  // stepping by the vertical clearance over (descent rate + max slope) and never less than uStepK pixel footprints;
  // a secant refinement of the bracketed crossing; misses are discarded (real silhouette) unless they clear the
  // terrain by less than a pixel (analytic coverage of the skyline).
  vec3 O = uCamL;
  vec3 D = normalize(vLocal - O);
  vec3 dDx, dDy;
  rayDiff(D, dDx, dDy);
  float pixAng = max(sqrt(length(dDx) * length(dDy)), 1e-8) * uFpScale;
  float Rb = 1.0 + uHG;
  float bq = dot(O, D);
  float sq = sqrt(max(bq * bq - (dot(O, O) - Rb * Rb), 0.0));
  float tEnd = -bq + sq;
  float t = max(-bq - sq, 0.0);
  // every ray that reaches the sphere of the lowest terrain is below the surface there: the march never steps past it
  // (far views, where a few pixel footprints exceed the whole relief, then bracket the hit in one step)
  float sIn = bq * bq - (dot(O, O) - (1.0 + uDemMin) * (1.0 + uDemMin));
  float tIn = mix(1e9, -bq - sqrt(max(sIn, 0.0)), sIn > 0.0);
  // deep on the night side nothing can be lit: no march (the silhouette there is the unit sphere's)
  {
    float s1 = bq * bq - (dot(O, O) - 1.0);
    if (s1 > 0.0) {
      float t1 = -bq - sqrt(s1);
      if (all(bvec3(dot(O + t1 * D, L) < -0.12, uDebug < 5.5 || uDebug > 20.5, t1 > 0.0))) { gl_FragColor = vec4(t1, 1.0, 0.0, 3.0); return; }
    }
  }
  // Phases in one loop (one call site of the expensive height function):
  //   0: cheap march against DEM + an upper bound of the crater relief, down to that bound surface;
  //   1: march against the full height (DEM + craters);
  //   2: secant refinement of the bracketed crossing (2 steps).
  float tPrev = t, fPrev = 1.0, ta = t, tb = t, fa = 1.0, fb = -1.0;
  int phase = 0, nref = 0, steps = 0;
  bool hit = false;
  // closest approach of a missing ray (angular clearance above the terrain): silhouette anti-aliasing. The minimum
  // and its two neighbours (clearance and t) refine it by a parabola, so the skyline alpha and the skyline's shading
  // point move continuously from pixel to pixel instead of jumping between march samples.
  float margin = 1e9, tMin = t, hMin = 0.0;
  vec3 mB = vec3(1e9), mT = vec3(0.0), mH = vec3(0.0); // clearance, t, height before / at / after the minimum
  float mPrevV = 1e9, tPrevV = t, hPrevV = 0.0;
  bool justMin = false;
  for (int i = 0; i < 112 + uZero; i++) {
    vec3 p = O + t * D;
    float r = length(p);
    vec3 n = p / r;
    float mu = max(-dot(D, n), 0.0);
    float pw = t * pixAng;
    float h = reliefH(n, pw, mu, texR, phase == 0);
    float f = r - 1.0 - h;
    steps += int(any(bvec2(uDebug != 16.0, phase > 0)));
    if (phase == 2) {
      if (f > 0.0) { ta = t; fa = f; } else { tb = t; fb = f; }
      if (++nref >= 2) break;
      t = mix(ta, tb, clamp(fa / (fa - fb), 0.1, 0.9));
      continue;
    }
    // (phase 0 -> 1 also where the ray passes within ~2 px of the bound: skyline coverage needs the true heights)
    if (all(bvec2(phase == 0, f < 2.0 * pixAng * t))) { phase = 1; continue; } // same t, now against the full height
    if (f <= 0.0) {
      hit = true;
      ta = tPrev; fa = fPrev; tb = t; fb = f;
      if (tb <= ta) break;
      phase = 2;
      t = mix(ta, tb, clamp(fa / (fa - fb), 0.1, 0.9));
      continue;
    }
    float m = f / max(t, 1e-6);
    if (justMin) { mB.z = m; mT.z = t; mH.z = h; justMin = false; }
    if (m < margin) {
      margin = m; tMin = t; hMin = h; mB = vec3(mPrevV, m, 1e9); mT = vec3(tPrevV, t, 0.0); mH = vec3(hPrevV, h, h); justMin = true;
    }
    mPrevV = m; tPrevV = t; hPrevV = h;
    tPrev = t; fPrev = f;
    // slope allowance: conservative for grazing rays (no tunnelling through rims), small for steep ones (an
    // overshoot into the terrain is bracketed and refined)
    float tn = t + max(f / (mu + mix(0.6, 0.2, smoothstep(0.35, 0.85, mu))), uStepK * pw);
    if (all(bvec2(t < tIn, tn > tIn))) tn = max(tIn, t + 1e-7);
    t = tn;
    if (t > tEnd) break;
  }
  float dbg = float(steps) * float(any(bvec2(uDebug == 15.0, uDebug == 16.0)));
  if (!hit) {
#ifdef MDEBUG
    if (uDebug > 19.5 && margin > 1e8) { gl_FragColor = vec4(tEnd, 1.0, float(steps), 5.0); return; }
#endif
    if (margin > 1e8) discard;
    // parabola through the clearance minimum and its neighbours (non-uniform spacing): refined clearance and t
    if (all(bvec4(mB.x < 1e8, mB.z < 1e8, mT.x < mT.y, mT.z > mT.y))) {
      float t0 = mT.x - mT.y, t2 = mT.z - mT.y;
      float d0 = (mB.x - mB.y) / t0, d2 = (mB.z - mB.y) / t2;
      float c2 = (d2 - d0) / (t2 - t0); // curvature
      if (c2 > 1e-12) {
        float c1 = d0 - c2 * t0;         // slope at the minimum sample
        float u = clamp(-0.5 * c1 / c2, t0, t2);
        margin = max(mB.y + c1 * u + c2 * u * u, 0.0);
        tMin = mT.y + u;
        hMin = mix(mix(mH.y, mH.z, u / t2), mix(mH.y, mH.x, u / t0), u < 0.0);
      }
    }
    float cover = clamp(1.0 - margin / pixAng, 0.0, 1.0);
#ifdef MDEBUG
    if (uDebug > 20.5 && cover <= 0.0) { gl_FragColor = vec4(tMin, 1.0, margin / pixAng, 6.0); return; }
#endif
    if (cover <= 0.0) discard;
    gl_FragColor = vec4(tMin, cover, mix(hMin, dbg, dbg > 0.0), 2.0);
  } else {
    t = mix(ta, tb, fa / max(fa - fb, 1e-12));
    // (z: the procedural crater height at the hit, for the terrain shadow's receiver reference)
    gl_FragColor = vec4(t, 1.0, mix(gHCr, dbg, dbg > 0.0), 1.0);
  }
}
#else
// ================================================================ deferred shading passes
// TERRAIN (pre-pass): DEM normal + depression depth, DEM cast shadow           -> uTerr (visT, gT1, gT2, lapD)
// LIGHT   (pre-pass): roughness + crater relief and shadows + photometry, in    -> uLight (L, visC, nTap)
//                     anisotropic taps; L = irradiance factor for unit albedo
// FINAL   (visible):  albedo textures + crater albedo, composition, depth and skyline coverage
uniform sampler2D uTerr;
uniform sampler2D uLight;
uniform mat4 uLocalToClip;   // projection x view x model (set per draw)

// Everything about the pixel that every pass derives the same way from the march pre-pass.
struct Px {
  vec3 D, P, N, V, dNx, dNy, T1, T2, Lt, axL;
  float t, cover, hz, pw, muE, fpIso, fp, longAx, muS, lt, tanE, pixAng; // (sin / cos / tan of the Sun's elevation: muS, lt, tanE)
  int nTap, kind;
};
// false: the pixel is on the night side (black); misses are discarded
bool setupPx(out Px px) {
  vec3 O = uCamL;
  px.D = normalize(vLocal - O);
  vec3 dDx, dDy;
  rayDiff(px.D, dDx, dDy);
  px.pixAng = max(sqrt(length(dDx) * length(dDy)), 1e-8) * uFpScale;
  vec4 pre = texelFetch(uPre, ivec2(gl_FragCoord.xy), 0);
  if (pre.w < 0.5) discard;
  px.t = pre.x;
  px.cover = pre.y;
  px.hz = pre.z;
  px.kind = int(pre.w + 0.5);
  bool sky = px.kind == 2;
  px.P = mix(O + px.t * px.D, normalize(O + px.t * px.D) * (1.0 + pre.z), bvec3(sky));
  if (px.kind == 3) return false;
  px.N = normalize(px.P);
  px.V = -px.D;
  px.muS = dot(px.N, uSunL);
  // well past the terminator nothing (not even the highest peak, ~4 deg) can see the Sun: Mercury has no
  // atmosphere and no moon, so the night side is black
  if (all(bvec2(px.muS < -0.09, uDebug < 5.5 || uDebug > 20.5))) return false;
#ifdef PASS_FINAL
  // ray differentials: the pixel's footprint vectors on the tangent plane (texture gradients without the
  // discontinuities of screen-space derivatives across occlusion edges)
  float dn = min(dot(px.D, px.N), -1e-3);
  px.dNx = px.t * (dDx - px.D * (dot(dDx, px.N) / dn));
  px.dNy = px.t * (dDy - px.D * (dot(dDy, px.N) / dn));
#endif
  // footprint ellipse: the short axis is ~ a pixel at that distance, the long one stretched by 1 / mu along the view
  // direction projected on the ground. Procedural detail is filtered per tap: up to uAniso shading taps spread along
  // the long axis, each with the footprint of its own near-isotropic piece (anisotropic filtering of the procedural
  // relief and shadows: crater octaves survive far out without aliasing along the stretched axis)
  px.pw = px.t * px.pixAng;
  px.muE = max(dot(px.N, px.V), 1e-3);
  // (skyline pixels are shaded at the ray's closest approach: a wider footprint, smooth band instead of speckle)
  float skyK = mix(1.0, 3.0, sky);
#ifdef PASS_FINAL
  px.fpIso = footprint(px.pw, px.muE, uFpLong) * skyK;
#else
#ifdef PASS_LIGHT
  vec3 Vt = px.V - px.N * dot(px.V, px.N);
  px.axL = Vt / max(length(Vt), 1e-6);
  px.longAx = px.pw / px.muE;
#endif
  px.nTap = clamp(int(0.5 / px.muE + 0.5), 1, uAniso) * (1 - int(sky)) + int(sky);
  px.fp = max(footprint(px.pw, px.muE * float(px.nTap), uFpLong), 1e-7) * skyK;
  float ay = float(abs(px.N.y) < 0.99);
  px.T1 = normalize(cross(vec3(1.0 - ay, ay, 0.0), px.N));
  px.T2 = cross(px.N, px.T1);
  vec3 Lt = uSunL - px.N * px.muS;
  float lt = length(Lt);
  px.Lt = mix(px.T1, Lt / max(lt, 1e-6), bvec3(lt > 1e-6));
  px.lt = lt;
  px.tanE = px.muS / max(lt, 1e-6);
#endif
  return true;
}

// Prefix sums of the receiver's roughness octaves: gRoughP[j] = sum of octaves < j. Crater octave o (mean rim radius
// ~ the roughness cell of octave o) sees the receiver's roughness finer than its own scale, hR - gRoughP[o], poke out
// of (or sink into) its shadow; coarser octaves tilt crater and crest alike.
vec4 gRP0, gRP1, gRP2; // gRoughP[0..11] in three vec4 (one-hot writes / reads: no indexable array)
float gRo[10];  // the receiver's roughness octaves, unweighted (a x sc x (n - 0.5)); gNRo of them computed
vec3 gRoGP[11]; // prefix sums of their weighted gradients (d h / d N)
int gNRo;
// Regolith micro-relief: fractal value noise from ~11 km cells down to the footprint (slope amplitude ~constant
// per octave, height halving), with its albedo mottling. Returns (tangential gradient, height); nalb out.
vec4 roughness(vec3 N, float fpd, out float nalb) {
  float sc = 0.0045, hR = 0.0, aN = 0.12;
  vec3 ng = vec3(0.0);
  nalb = 0.0;
  gNRo = 0;
#ifdef PASS_TERRAIN
  gRoGP[0] = vec3(0.0);
#else
  gRP0 = gRP1 = gRP2 = vec4(0.0);
#endif
  for (int o = 0; o < 10 * int((uSkip & 4) == 0); o++) {
    float w = smoothstep(1.2, 3.5, sc / fpd) * uDetail;
    if (w <= 0.0) break;
    vec4 nz = noised(N / sc + float(o) * 13.7);
    float a = roughAmp(o);
    ng += w * a * nz.yzw;
    float ro = a * sc * (nz.x - 0.5);
    hR += w * ro;
#ifdef PASS_TERRAIN
    gRoGP[o + 1] = ng;
    gRo[o] = ro;
#else
    ivec4 j = ivec4(o + 1) - ivec4(0, 1, 2, 3);
    gRP0 += hR * vec4(equal(j, ivec4(0)));
    gRP1 += hR * vec4(equal(j, ivec4(4)));
    gRP2 += hR * vec4(equal(j, ivec4(8)));
    nalb += w * (nz.x - 0.5) * aN;
    aN *= 0.8;
#endif
    gNRo = o + 1;
    sc *= 0.5;
  }
  return vec4(ng - N * dot(ng, N), hR); // (gRoughP / gRoGP are valid up to index gNRo)
}

#ifdef PASS_TERRAIN
// ---------------------------------------------------------------- terrain: DEM normal and DEM cast shadow
void main() {
  Px px;
  if (!setupPx(px)) { gl_FragColor = vec4(0.0); return; }
  float texR = 2.0 * PI / uDemSize.x;
  vec3 N = px.N, Lt = px.Lt;
  float tE = px.tanE, alphaSun = uSunAng;
  float fpd = px.fp * uDetailFp;
  float lodD = log2(px.fp / texR);
  float eps = max(0.55 * texR, px.fp);
  // One loop, one DEM call site (the D3D compiler pays per copy). Iterations 0-4: the DEM normal taps (centre, +-T1,
  // +-T2: central differences on a pole-safe tangent basis, prefiltered to the footprint); 5: the exact DEM at the
  // centre (the horizon's receiver, the march's own surface); then the horizon toward the Sun along the great circle:
  //   far field (0.45 .. ~40 texels, x1.4, cut at the height Mercury's relief can reach): exact DEM;
  //   crest: the roughness where the ray grazes the far-field maximum (parabolic refinement of its distance,
  //     continuous in the receiver position), so DEM shadows get serrated outlines with fingers along the light.
  // The receiver height hr is the exact DEM plus the procedural relief above its local reference surface (craters'
  // rims and ejecta poke out of a DEM shadow, their bowls and floors stay in it: if the rim plane is in shadow, so is
  // the floor; the crater's own analytic shadow comes on top in LIGHT). Penumbra: the visible fraction of the true
  // solar disc (alpha ~0.6-0.9 deg from Mercury) above the horizon, widened to the pixel footprint seen from the crest.
  bool doSh = all(bvec2(px.muS < 0.3146, (uSkip & 16) == 0)); // (elevation < 0.32 rad)
  float h0 = 0.0, hr = 0.0;
  vec4 hx = vec4(0.0);
  float maxE = -1e4, tBest = texR;
  int mode = 3; // 3 DEM taps, 1 far field, 2 crest
  float t = 0.0;
  float ta = tan(alphaSun); // tan(elevation - alpha):
  float tFar = 0.0035 / max((tE - ta) / (1.0 + tE * ta), 1e-4); // (no relief on Mercury rises > ~8.5 km above its surroundings)
  float eA = -1e4, eB = -1e4, eC = -1e4, tC = texR, ePrev = -1e4, eBest = -1e4;
  int nFar = 0;
  // roughness octaves resolved at the receiver (cells 0.0045 / 2^o down to ~1.2 footprints)
  int nRo = clamp(int(floor(log2(0.0045 / (1.2 * fpd)))) + 1, 0, 10) * int((uSkip & 4) == 0);
  for (int k = 0; k < 28 + uZero; k++) {
    if (all(bvec2(mode == 1, any(bvec2(t > tFar, nFar >= 13))))) {
      if (any(bvec2(eBest < -1e3, uDetail <= 0.0))) break;
      float u = 0.0;
      if (all(bvec2(eA > -1e3, eC > -1e3))) {
        float den = eA - 2.0 * eB + eC; // samples at log-spacing: parabola in log t
        u = clamp(0.5 * (eA - eC) / min(den, -1e-9), -0.5, 0.5) * float(den < -1e-9);
      }
      t = tC * pow(1.4, u);
      mode = 2;
    }
    vec3 q = normalize(mix(N + Lt * t, N + eps * ((float(k == 1) - float(k == 2)) * px.T1 + (float(k == 3) - float(k == 4)) * px.T2), bvec3(mode == 3)));
    // crest: roughness of the occluder relative to the receiver, octave by octave, the band the crest sample resolves
    // (footprint ~0.06 t) as the height difference of the same noise at both ends (coarse octaves cancel to their
    // slope x distance), the finer ones as their expected maximum along the ray
    float dh = 0.0;
    if (mode == 2) {
      float fpo = max(fpd, 0.06 * t);
      float sc = 0.0045;
      for (int o = 0; o < nRo; o++) {
        float wr = smoothstep(1.2, 3.5, sc / fpd), wo = smoothstep(1.2, 3.5, sc / fpo);
        vec3 so = vec3(float(o) * 13.7);
        if (wo > 0.0) dh += wo * roughAmp(o) * sc * (tnoise(q / sc + so) - tnoise(N / sc + so));
        dh += (wr - wo) * roughAmp(o) * sc * 0.35;
        sc *= 0.5;
      }
      dh *= uDetail;
    }
    if (mode == 2) {
      float e = eBest + dh / t;
      if (e > maxE) { maxE = e; tBest = t; }
      eBest = -1e4; // (merged, with its crest roughness)
      break;
    }
    float hq = demHuv(dirToUV(q), mix(-1.0, lodD, all(bvec2(mode == 3, k < 5))));
    if (mode == 3) {
      h0 += hq * float(k == 0);
      hx += hq * vec4(equal(ivec4(k), ivec4(1, 2, 3, 4)));
      if (k == 5) {
        if (!doSh) break;
        // receiver: + the procedural crater relief above the local reference (the march's crater height at the hit)
        hr = hq + max(px.hz, 0.0) * float(px.kind == 1);
        mode = 1;
        t = 0.45 * texR;
        tC = t;
      }
      continue;
    }
    // elevation above the receiver's horizon (small angles: height difference over distance minus the curvature drop)
    float e = (hq - hr) / t - 0.5 * t;
    if (e > eBest) { eBest = e; tC = t; eA = ePrev; eB = e; eC = -1e4; }
    else if (all(bvec3(eC < -1e3, tC * 1.39 < t, tC * 1.41 > t))) eC = e;
    ePrev = e;
    nFar++;
    t *= 1.4;
  }
  if (eBest > maxE) { maxE = eBest; tBest = tC; }
  // (widened toward 2 alpha where the crest is only a few footprints away: no aliased sub-pixel penumbra)
  float aEff = alphaSun * (1.0 + min(fpd / tBest, 1.0));
  float visT = mix(1.0, discAbove((tE - maxE) / ((1.0 + tE * maxE) * aEff)), doSh);
  vec2 g = vec2(hx.x - hx.y, hx.z - hx.w) / (2.0 * eps);
  float lapD = (hx.x + hx.y + hx.z + hx.w - 4.0 * h0) / (4.0 * eps); // DEM depression depth over its radius (tan of the walls)
  gl_FragColor = vec4(visT, g, lapD);
}
#endif

#ifdef PASS_LIGHT
// Crater relief at N: tangential height gradient, sun visibility (each crater's own rim / massif shadow) and the
// enclosure by crater walls (fill light).
void craterRelief(vec3 N, float fp, vec3 Lt, float tanE, bool doShadow, float density, float pat, float alphaSun,
                  float hR, inout vec3 grad, inout float vis, inout float bowl) {
  // octaves x candidates in one loop (a loop level less for the compiler); the octave setup runs at each octave start.
  // Candidates: population 0 (c 0..7), population 1 (8..15) while it is resolved, population 2 (rayed) in octaves
  // <= 4, each tested directly (a real branch in a dynamic loop; neighbouring pixels share their candidates)
  float s = 2.0 * uCraterS0, w = 0.0, fo = -1.0, pAcc = 0.0, wPop1 = 0.0;
  vec3 base = vec3(0.0);
  int o = -1, nc = 0, ic = 0, has1 = 0;
  for (int it = 0; it < 288 + uZero; it++) {
    if (ic >= nc) {
      o++;
      fo = float(o);
      s *= 0.5;
      w = octaveWeight(o, s, fp);
      if (any(bvec2(w <= 0.0, o >= 12))) break;
      pAcc = octaveAcc(fo, density, pat);
      // small craters cluster (secondary fields, overlapping ejecta): an own ~8-cell noise per octave, so each size
      // class is clumpy with gaps instead of an even sprinkle (mean density unchanged)
      if (o >= 3) pAcc *= mix(0.25, 1.85, smoothstep(0.25, 0.8, tnoise(N / (8.0 * s) + fo * 7.31)));
      base = floor(N / s - 0.5);
      wPop1 = pop1Weight(s, fp);
      has1 = int(wPop1 > 0.0);
      nc = 8 + 8 * has1; // (populations 0, 1: the rayed population's bowls are a pixel or two, its rays are albedo)
      ic = 0;
    }
    int c = ic++;
    {
      Crater cr;
      if (!craterGet(base, c, fo, s, pAcc, N, fp, density, 0.0, cr)) continue;
      float wc = craterLod(cr, w, wPop1, fp) * cr.wc;
      float x = cr.x;
      if (any(bvec2(x >= 1.75, wc <= 0.0))) continue;
      // Sun direction in the crater plane
      vec2 ls = vec2(dot(Lt, cr.e1), dot(Lt, cr.e2));
      float lsl = length(ls);
      ls /= max(lsl, 1e-4);
      // ---- height and its gradient (radial profile derivative incl. the rim harmonics, plus the massifs)
      vec2 pd = craterProfileD(x, cr.cx, cr.fresh, cr.k);
      float h0 = pd.x;
      float rho = length(cr.q);
      vec2 qr = cr.q / max(rho, 1e-6);
      vec2 gq = pd.y * (qr - vec2(-qr.y, qr.x) * (cr.drim / cr.rimS)) / cr.rimS;
      vec3 Am = vec3(0.0), Tm = vec3(1.0);
      float fm = 0.0;
      if (all(bvec2(cr.cx > 0.0, x < 0.55))) {
        // (massifs fade out once ~2 px wide: sub-pixel peaks and their shadows would only sparkle)
        fm = cr.cx * smoothstep(0.55, 0.3, x) * smoothstep(1.5, 3.5, 0.1 * cr.r / fp);
        vec3 m = massifs(cr.q, cr.hb, ls, Am, Tm);
        h0 += fm * m.x;
        gq += fm * m.yz;
        Am *= fm;
      }
      grad += wc * cr.amp * (gq.x * cr.e1 + gq.y * cr.e2);
      // enclosure by this crater's walls (tan of the wall elevation seen from inside), for the fill light
      bowl = max(bowl, wc * cr.amp * (0.4 - 0.17 * cr.cx) * smoothstep(1.05, 0.6, x));

      // ---- cast shadow from this crater's rim / central massifs (analytic secant test toward the Sun)
      if (all(bvec3(doShadow, (uSkip & 256) == 0, lsl > 1e-4))) {
        float A = cr.amp * mix(1.0, 0.75, o == 0);
        // receiver height for the test: + its roughness finer than this crater (pokes out of / sinks into the shadow)
        // (in profile units; it decorrelates from the crest's own roughness over ~r, hence the min(t, 1))
        ivec4 jo = ivec4(min(o, gNRo)) - ivec4(0, 1, 2, 3);
        float hpr = (hR - dot(gRP0, vec4(equal(jo, ivec4(0)))) - dot(gRP1, vec4(equal(jo, ivec4(4)))) - dot(gRP2, vec4(equal(jo, ivec4(8))))) / (A * cr.r);
        vec2 cf = crestFloor(cr.cx, cr.fresh, cr.k);
        float crest = cf.x, fl0 = cf.y;
        float maxS = -1e4;
        // rim crossing toward the Sun: the near rim for a receiver outside, the far one from inside (the receiver's
        // roughness finer than the crater makes the shadow edges ragged)
        float b = dot(cr.q, ls), qq = dot(cr.q, cr.q);
        float disc = b * b - qq + cr.rimS * cr.rimS;
        if (disc > 0.0) {
          float sq = sqrt(disc);
          float tcr = -b + sq * (1.0 - 2.0 * float(-b - sq > 1e-3));
          if (tcr > 1e-3) maxS = (crest - h0 - hpr * min(tcr, 1.0)) / tcr;
        }
        // central massifs (analytic: their along-ray maximum, see massifs())
        if (fm > 0.0) {
          vec3 sl = (Am + fl0 - h0 - hpr * min(Tm, 1.0)) / max(Tm, 0.02);
          sl = mix(vec3(-1e4), sl, step(0.02, Tm));
          maxS = max(maxS, max(sl.x, max(sl.y, sl.z)));
        }
        // (the exterior rim shadow fades out toward the edge of the crater's reach)
        float mA = maxS * A; // (penumbra: the angle between Sun and rim from the slope difference)
        float sh = discAbove((tanE - mA) / ((1.0 + max(tanE * mA, -0.9)) * (alphaSun + 0.15 * fp / cr.r)));
        // LOD: while the crater spans only a few pixels its rim-scale shadow structure (thin crescents, exterior
        // slivers) would alias into ring outlines; it becomes the pixel average instead: a soft dark disc
        // covering the shadowed fraction of the bowl (shadow length = rim-to-floor depth / tan(elevation))
        float sd = smoothstep(1.5, 4.0, cr.r / fp);
        float frac = pow(clamp(0.5 * (crest - fl0) * A / max(tanE, 1e-3), 0.0, 1.0), 0.8);
        sh = mix(1.0 - frac * smoothstep(1.05, 0.45, x), sh, sd);
        vis = min(vis, mix(1.0, sh, smoothstep(1.75, 1.45, x) * wc / mix(1.0, 0.75, o == 0)));
      }
    }
  }
}

// ---------------------------------------------------------------- photometry
// I/F per unit normal albedo. Lunar-Lambert with L(g) = 1 - g/135deg (pure Lommel-Seeliger at opposition:
// a flat, limb-darkening-free full disc), times S(g): shadow-hiding opposition surge B0 = 1.95, h = 0.12 and a
// smooth decline; fitted to the V-band phase curve of Mercury (Mallama et al. 2002), rms error 2% for g < 140.
float phaseS(float g) {
  float gd = g * (180.0 / PI);
  float surge = (1.0 + 1.95 / (1.0 + tan(0.5 * g) / 0.12)) / 2.95;
  return surge * exp(-0.008 * gd + 4.0e-5 * gd * gd);
}

void main() {
  Px px;
  if (!setupPx(px)) { gl_FragColor = vec4(0.0); return; }
  vec4 terr = texelFetch(uTerr, ivec2(gl_FragCoord.xy), 0);
  float visT = terr.x;
  vec3 gradDem = terr.y * px.T1 + terr.z * px.T2;
  vec4 aux = textureLod(uAux, dirToUV(px.N), 0.0); // exactly what the relief march used
  vec3 L = uSunL, V = px.V;
  float cg = clamp(dot(L, V), -1.0, 1.0), ac = abs(cg);
  float g0 = sqrt(1.0 - ac) * (1.5707288 + ac * (-0.2121144 + ac * (0.0742610 - 0.0187293 * ac)));
  float g = mix(g0, PI - g0, cg < 0.0); // acos
  float Lg = clamp(1.0 - g / (135.0 * PI / 180.0), 0.0, 1.0);
  float S = phaseS(g);
  float softA = uSinSun;
  // Fill light: sunlight scattered once by nearby lit terrain (no sky on Mercury). Irradiance ~ albedo of the
  // surroundings x their cosine (sun-facing walls and slopes, which near the terminator are far brighter than the
  // flats) x the view factor of that terrain: the planet and gentle relief (~1.5 %) and the receiver's tilt toward
  // the ground (their lit fraction falls inside a terrain shadow), plus the walls of the crater it sits in and
  // DEM-scale depressions: those walls are lit only where the crater's rim plane is (a crater inside a terrain
  // shadow gets no fill from its own walls). Lambertian, with a mid-phase backscatter weight.
  float muWall = clamp(px.muS * 0.92106 + px.lt * 0.38942, 0.0, 1.0) * smoothstep(-0.04, 0.04, px.muS) * uFillS; // sin(elev + 0.4)
  float fpd = px.fp * uDetailFp;
  // one tap per draw (additive): this tap's point along the long axis of the footprint
  int tap = uTap;
  if (tap >= px.nTap) discard;
  vec3 Nk = px.N;
  if (px.nTap > 1) Nk = normalize(px.N + px.axL * (px.longAx * ((float(tap) + 0.5) / float(px.nTap) - 0.5)));
  float vis = 1.0, bowl = 0.0, nalb = 0.0;
  vec3 grad = gradDem;
  vec4 rg = vec4(0.0);
  if (uDetail > 0.0) {
    rg = roughness(Nk, fpd, nalb);
    if ((uSkip & 1) == 0) craterRelief(Nk, fpd, px.Lt, px.tanE, px.muS < 0.6816, aux.g, aux.r, uSunAng, rg.w, grad, vis, bowl);
  }
  float visC = vis;
  vis = min(vis, visT);
  vec3 n = normalize(Nk - grad - rg.xyz);
  // ---- photometry
  float mu0 = dot(n, L);
  float ms = clamp(mu0 + softA, 0.0, 2.0 * softA);
  mu0 = mix(ms * ms / (4.0 * softA), mu0, mu0 >= softA); // (extended Sun)
  float mu = max(dot(n, V), 0.0);
  float ioF = S * (2.0 * Lg * mu0 / max(mu0 + mu, 1e-4) + (1.0 - Lg) * mu0);
  float encl = max(bowl, clamp(terr.w, 0.0, 0.5));
  float Fv = (0.015 + 0.5 * (1.0 - dot(n, Nk))) * mix(0.12, 1.0, visT) + 0.45 * encl * encl * visT;
  float Lk = (1.0 + nalb) * (ioF * vis + muWall * Fv);
  gl_FragColor = vec4(Lk / float(px.nTap), vec2(visC, float(px.nTap)) * float(tap == 0), 0.0);
}
#endif

#ifdef PASS_FINAL
// Crater albedo at N. Immature (young) material is bright and bluish: walls, rim and ejecta of young craters,
// continuous near the rim and breaking into lobes outward; old craters have lost their contrast. A few excavate dark
// low-reflectance material (dark halos); the rayed population has bright filamentary rays to ~12 r (Kuiperian
// craters below the mosaic's resolution). Mature craters: steep walls still shed regolith (slightly brighter at high
// Sun), floors a touch darker, rim crests stay immature longest (MDIS high-Sun images: crater walls and rim crests are
// the brightest lines in the scene); hollows: bright, bluish etched patches on some complex-crater floors.
void craterAlbedo(vec3 N, float fp, float density, float pat, inout float albMod, inout float blue) {
  // octaves x candidates in one loop (a loop level less for the compiler); the octave setup runs at each octave start.
  // Candidates: population 0 (c 0..7), population 1 (8..15) while it is resolved, population 2 (rayed) in octaves
  // <= 4, each tested directly (a real branch in a dynamic loop; neighbouring pixels share their candidates)
  float s = 2.0 * uCraterS0, w = 0.0, fo = -1.0, pAcc = 0.0, wPop1 = 0.0;
  vec3 base = vec3(0.0);
  int o = -1, nc = 0, ic = 0, has1 = 0;
  for (int it = 0; it < 288 + uZero; it++) {
    if (ic >= nc) {
      o++;
      fo = float(o);
      s *= 0.5;
      w = octaveWeight(o, s, fp);
      if (any(bvec2(w <= 0.0, o >= 12))) break;
      pAcc = octaveAcc(fo, density, pat);
      // small craters cluster (secondary fields, overlapping ejecta): an own ~8-cell noise per octave, so each size
      // class is clumpy with gaps instead of an even sprinkle (mean density unchanged)
      if (o >= 3) pAcc *= mix(0.25, 1.85, smoothstep(0.25, 0.8, tnoise(N / (8.0 * s) + fo * 7.31)));
      base = floor(N / s - 0.5);
      wPop1 = pop1Weight(s, fp);
      has1 = int(wPop1 > 0.0);
      nc = 8 + 8 * int(o <= 4); // (populations 0 and 2: the degraded ghosts carry no albedo pattern)
      ic = 0;
    }
    int i = ic++;
    {
      int c = i + 8 * int(i >= 8);
      Crater cr;
      if (!craterGet(base, c, fo, s, pAcc, N, fp, density, 0.3, cr)) continue; // (young craters only)
      int pp = cr.pop;
      float wc = craterLod(cr, w, wPop1, fp) * cr.wc;
      float x = cr.x;
      if (cr.wc <= 0.0) continue;
      float young = smoothstep(0.3, 0.92, cr.fresh);
      float res = smoothstep(2.0, 6.0, cr.r / fp);
      float rf = cr.r / fp;
      if (all(bvec2(young > 0.0, (uSkip & 512) == 0))) {
        // continuous bright blanket near the rim breaking into lobes / rays outward, fading over ~0.85 r (young craters)
        // or ~3 r out to 12 r (the rayed population: sharper, thinner filaments that break up along their length;
        // lobes narrower than ~1.5 px average out to their mean)
        bool ray = pp == 2;
        float th = atan(cr.q.y, cr.q.x) + 3.14159265;
        float m = floor(mix(mix(7.0, 16.0, cr.hs.x), mix(9.0, 22.0, cr.hs.z), ray));
        float lob = rayLobes(th, m, cr.hs.z * 77.0 + fo);
        float lobS = mix(lob * lob, lob * lob * lob * sqrt(lob), ray) * 1.6;
        float xa = max(x - 0.9, 0.0);
        float cont = exp(-xa * xa * mix(6.0, 1.2, ray));
        float rays = mix(0.35, lobS, mix(res, smoothstep(0.7, 2.5, x * rf * 6.2831853 / (m * 3.0)), ray));
        float fall = exp(-xa * mix(2.4, 1.0 / 3.2, ray)) * smoothstep(mix(1.75, 12.0, ray), mix(1.35, 7.0, ray), x);
        float inner = mix(mix(0.6 + 0.4 * x * x, 0.25 + 0.75 * smoothstep(0.38, 0.62, x), cr.cx), 1.0, smoothstep(0.65, 0.9, x));
        float ej = mix(cont + (1.0 - cont) * rays, inner, x < 0.9) * fall;
        float bright = ej * mix(wc * 0.95 * young * young, 1.5 * smoothstep(0.4, 1.5, rf), ray);
        albMod *= 1.0 + bright;
        blue += bright * mix(1.05, 0.9, ray);
      }
    }
  }
}

void main() {
  Px px;
  bool lit = setupPx(px);
  vec4 clip = uLocalToClip * vec4(px.P, 1.0);
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_FragDepth = clip.z / clip.w;
#else
  gl_FragDepth = 0.5 * clip.z / clip.w + 0.5;
#endif
#ifdef MDEBUG
  if (uDebug > 19.5 && px.kind > 3) { gl_FragColor = vec4(1.0, 0.0, 1.0, 1.0); return; }
  if (uDebug > 19.5 && px.kind == 3) { gl_FragColor = vec4(0.0, 0.0, 0.3, 1.0); return; }
  if (uDebug > 19.5 && !lit) { gl_FragColor = vec4(0.0, 0.3, 0.0, 1.0); return; }
  if (uDebug > 19.5 && px.kind == 2) { gl_FragColor = vec4(0.3, 0.3, 0.0, 1.0); return; }
#endif
  if (!lit) { gl_FragColor = vec4(0.0, 0.0, 0.0, mix(px.cover, 1.0, px.kind == 3)); return; }
#ifdef MDEBUG
  if (uDebug == 15.0 || uDebug == 16.0) {
    // march step-count bands: <=4 blue, <=8 cyan, <=16 green, <=32 yellow, <=64 red, more magenta
    int steps = int(px.hz + 0.5);
    vec3 c = steps <= 4 ? vec3(0, 0, 1) : steps <= 8 ? vec3(0, 1, 1) : steps <= 16 ? vec3(0, 1, 0) : steps <= 32 ? vec3(1, 1, 0) : steps <= 64 ? vec3(1, 0, 0) : vec3(1, 0, 1);
    gl_FragColor = vec4(c * (px.kind == 1 ? 1.0 : 0.4), 1.0); return;
  }
#endif
  vec3 N = px.N;
  // ---- albedo + colour
  vec2 uv = dirToUV(N);
  // texture gradients: the footprint vectors through the Jacobian of the lon/lat mapping (pole-safe: the longitude
  // derivative grows as 1 / cos(lat), so the poles take the coarse mips they should)
  float rxz = max(N.x * N.x + N.z * N.z, 1e-8);
  vec2 jx = vec2((N.z * px.dNx.x - N.x * px.dNx.z) / rxz * (0.5 / PI), px.dNx.y * inversesqrt(rxz) * (1.0 / PI));
  vec2 jy = vec2((N.z * px.dNy.x - N.x * px.dNy.z) / rxz * (0.5 / PI), px.dNy.y * inversesqrt(rxz) * (1.0 / PI));
  float texA = 2.0 * PI / uAlbedoSize.x;
  float lodA = log2(px.fpIso / texA);
  float aLin = textureGrad(uAlbedo, uv, jx, jy).r;
  // local-contrast restoration while the mosaic is shown near its own resolution (whole-disc views): the 7.5 km/px
  // resample of the 665 m mosaic loses the crispness of crater rims and ray filaments; an unsharp mask against a
  // ~3-texel blur brings it back (faded out where the real detail tile takes over, and when minified)
  float usm = 0.8 * smoothstep(-1.6, -0.6, lodA) * smoothstep(2.5, 1.0, lodA);
  if (usm > 0.0) aLin += usm * (aLin - textureGrad(uAlbedo, uv, jx * 3.0, jy * 3.0).r);
  float rel = uAlbedoRange.x + max(aLin, 0.0) * uAlbedoRange.y;
  // mild gamma above the median: immature (bright) material stands out as in MDIS photometric mosaics
  rel = mix(rel, pow(rel, 1.15), rel > 1.0);
  // where the 7.5 km/px map is magnified, real 1.3-8 km MESSENGER texture takes over from its blur (the tile carries
  // a little baked shading, so it backs off toward the terminator where the computed relief dominates); the same real
  // texture again at 1/4 and 1/16 of the scale (Mercury's surface is self-similar): crisp 80 m - 1.3 km albedo
  // structure in low passes, each faded in once its texels are about a pixel. Triplanar (sharp blend), each
  // projection rotated/offset differently so the 681 km period does not line up.
  float wTile = smoothstep(-0.3, -1.8, lodA) * uDetail * mix(0.45, 1.0, smoothstep(0.08, 0.4, px.muS));
  if (all(bvec2(wTile > 0.0, (uSkip & 8) == 0))) {
    vec3 bw = pow(abs(N), vec3(8.0));
    bw /= (bw.x + bw.y + bw.z);
    const mat2 RB = mat2(0.8, -0.6, 0.6, 0.8);
    const mat2 RC = mat2(0.28, 0.96, -0.96, 0.28);
    float dt = 0.0, tR = uTileR, wt = 1.0;
    vec2 off = vec2(0.0);
    for (int j = 0; j < 3 + uZero; j++) {
      if (wt > 0.0) {
        vec3 Pt = N / tR, dPx = px.dNx / tR, dPy = px.dNy / tR;
        float d = 0.0;
        if (bw.x > 0.004) d += bw.x * textureGrad(uDetailTex, Pt.yz + off, dPx.yz, dPy.yz).r;
        if (bw.y > 0.004) d += bw.y * textureGrad(uDetailTex, RB * Pt.zx + 0.37 + off, RB * dPx.zx, RB * dPy.zx).r;
        if (bw.z > 0.004) d += bw.z * textureGrad(uDetailTex, RC * Pt.xy + 0.71 + off.yx, RC * dPx.xy, RC * dPy.xy).r;
        dt += wt * (d - 0.5) * 2.0 * uDetailRange;
      }
      tR *= 0.25;
      off = mix(vec2(0.11, 0.67), vec2(0.43, 0.19), bvec2(j == 0));
      wt = mix(0.65, 0.8, j == 0) * smoothstep(0.6, 1.5, (tR / 512.0) / px.fpIso);
    }
    rel *= exp(uTileK * wTile * dt);
  }
  vec3 tint = textureGrad(uTint, uv, jx * 0.5, jy * 0.5).rgb * 2.0;
  vec4 aux = textureLod(uAux, uv, 0.0);
  float albMod = 1.0, blue = 0.0;
  if (all(bvec2(uDetail > 0.0, (uSkip & 1) == 0))) craterAlbedo(N, px.fpIso * uDetailFp, aux.g, aux.r, albMod, blue);
  vec4 light = texelFetch(uLight, ivec2(gl_FragCoord.xy), 0);
  vec3 albedo = uMeanAlbedo * rel * albMod * uBaseColor * tint * (1.0 + clamp(blue, 0.0, 2.0) * vec3(-0.035, 0.0, 0.05));
  vec3 col = uSunColor * albedo * light.x * uGain;
#ifdef MDEBUG
  vec4 terr = texelFetch(uTerr, ivec2(gl_FragCoord.xy), 0);
  if (uDebug == 1.0 || uDebug == 17.0) col = vec3(min(light.y, terr.x));
  else if (uDebug == 18.0) col = vec3(terr.x);
  else if (uDebug == 19.0) col = vec3(light.y);
  else if (uDebug == 3.0) col = vec3(rel * albMod * 0.4);
  else if (uDebug == 4.0) col = vec3(aux.g);
  else if (uDebug == 5.0) col = vec3(step(0.0998, px.muS), step(0.1494, px.muS), step(0.1987, px.muS));
  else if (uDebug == 6.0) col = vec3(light.x * 0.5);
  else if (uDebug == 7.0) col = (tint - 0.9) * 4.0;
  else if (uDebug == 9.0) col = vec3(light.z / 4.0);
#endif
  gl_FragColor = vec4(col, px.cover);
}
#endif
#endif
`;
