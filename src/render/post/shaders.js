// GLSL for the post pipeline (all passes are full-screen triangles, GLSL ES 3.00, RawShaderMaterial).
//
//   prefilter   HDR (full) -> bloom mip 1 (half): NaN/Inf guard, soft highlight clamp, 13-tap + Karis average
//   down        mip i -> mip i+1: 13-tap "dual box" filter (Jimenez 2014)
//   up          mip i+1 -> mip i: 3x3 tent + weighted add  (sum of levels = long-tailed lens PSF)
//   sunRef/probe  flux-calibrated sun visibility (see post.js)
//   warp        radial zoom blur toward the focus of expansion (16-tooth comb x ~1-px tent: exact, no jitter)
//   composite   lateral CA + barrel, energy-conserving bloom mix, analytic sun lens system, natural vignette,
//               exposure, AgX tonemap + look, grade, film grain, TPDF dither, letterbox, fade

export const VERT = /* glsl */ `
in vec3 position;
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const HEAD = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
const float PI = 3.14159265358979;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
// NaN / Inf / negative guard. Comparisons against NaN are false, so a bad pixel becomes black instead of
// spreading through the bloom pyramid as a huge square.
vec3 sane(vec3 c) {
  bool ok = all(lessThan(abs(c), vec3(65000.0)));
  return ok ? max(c, vec3(0.0)) : vec3(0.0);
}
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
`;

// ---------------------------------------------------------------- bloom
export const PREFILTER = HEAD + /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;     // source texel size
uniform float uClamp;    // highlight soft clamp (scene units)
uniform float uKaris;    // exposure used for the Karis weights
vec3 tap(vec2 uv) {
  vec3 c = sane(texture(tSrc, uv).rgb);
  float m = max(c.r, max(c.g, c.b));
  // soft knee: identity below uClamp/2, asymptotic to uClamp above (hue preserved)
  float k = 0.5 * uClamp;
  if (m > k) c *= (k + k * (1.0 - exp(-(m - k) / k))) / m;
  return c;
}
float kw(vec3 c) { return 1.0 / (1.0 + luma(c) * uKaris); }
void main() {
  vec2 t = uTexel;
  vec3 a = tap(vUv + t * vec2(-2.0, 2.0)), b = tap(vUv + t * vec2(0.0, 2.0)), c = tap(vUv + t * vec2(2.0, 2.0));
  vec3 d = tap(vUv + t * vec2(-2.0, 0.0)), e = tap(vUv), f = tap(vUv + t * vec2(2.0, 0.0));
  vec3 g = tap(vUv + t * vec2(-2.0, -2.0)), h = tap(vUv + t * vec2(0.0, -2.0)), i = tap(vUv + t * vec2(2.0, -2.0));
  vec3 j = tap(vUv + t * vec2(-1.0, 1.0)), k = tap(vUv + t * vec2(1.0, 1.0));
  vec3 l = tap(vUv + t * vec2(-1.0, -1.0)), m = tap(vUv + t * vec2(1.0, -1.0));
  // Karis average over the five 2x2 boxes: kills single-pixel fireflies (sub-pixel stars, glints) that would
  // otherwise make the bloom flicker as they cross pixel boundaries.
  vec3 b0 = (j + k + l + m) * 0.25;
  vec3 b1 = (a + b + d + e) * 0.25;
  vec3 b2 = (b + c + e + f) * 0.25;
  vec3 b3 = (d + e + g + h) * 0.25;
  vec3 b4 = (e + f + h + i) * 0.25;
  float w0 = 0.5 * kw(b0), w1 = 0.125 * kw(b1), w2 = 0.125 * kw(b2), w3 = 0.125 * kw(b3), w4 = 0.125 * kw(b4);
  vec3 o = (b0 * w0 + b1 * w1 + b2 * w2 + b3 * w3 + b4 * w4) / (w0 + w1 + w2 + w3 + w4);
  fragColor = vec4(o, 1.0);
}`;

export const DOWN = HEAD + /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
void main() {
  vec2 t = uTexel;
  vec3 a = texture(tSrc, vUv + t * vec2(-2.0, 2.0)).rgb, b = texture(tSrc, vUv + t * vec2(0.0, 2.0)).rgb, c = texture(tSrc, vUv + t * vec2(2.0, 2.0)).rgb;
  vec3 d = texture(tSrc, vUv + t * vec2(-2.0, 0.0)).rgb, e = texture(tSrc, vUv).rgb, f = texture(tSrc, vUv + t * vec2(2.0, 0.0)).rgb;
  vec3 g = texture(tSrc, vUv + t * vec2(-2.0, -2.0)).rgb, h = texture(tSrc, vUv + t * vec2(0.0, -2.0)).rgb, i = texture(tSrc, vUv + t * vec2(2.0, -2.0)).rgb;
  vec3 j = texture(tSrc, vUv + t * vec2(-1.0, 1.0)).rgb, k = texture(tSrc, vUv + t * vec2(1.0, 1.0)).rgb;
  vec3 l = texture(tSrc, vUv + t * vec2(-1.0, -1.0)).rgb, m = texture(tSrc, vUv + t * vec2(1.0, -1.0)).rgb;
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  fragColor = vec4(o, 1.0);
}`;

export const UP = HEAD + /* glsl */ `
uniform sampler2D tLow;   // coarser level (already accumulated)
uniform sampler2D tCur;   // this level's downsample
uniform vec2 uTexelLow;
uniform float uLowScale;
uniform float uCurWeight;
void main() {
  vec2 t = uTexelLow;
  vec3 s = texture(tLow, vUv + t * vec2(-1.0, -1.0)).rgb + texture(tLow, vUv + t * vec2(1.0, -1.0)).rgb
         + texture(tLow, vUv + t * vec2(-1.0, 1.0)).rgb + texture(tLow, vUv + t * vec2(1.0, 1.0)).rgb
         + 2.0 * (texture(tLow, vUv + t * vec2(0.0, -1.0)).rgb + texture(tLow, vUv + t * vec2(0.0, 1.0)).rgb
                + texture(tLow, vUv + t * vec2(-1.0, 0.0)).rgb + texture(tLow, vUv + t * vec2(1.0, 0.0)).rgb)
         + 4.0 * texture(tLow, vUv).rgb;
  vec3 o = s * (uLowScale / 16.0) + texture(tCur, vUv).rgb * uCurWeight;
  fragColor = vec4(o, 1.0);
}`;

// ---------------------------------------------------------------- sun probe
// The reference target holds ONLY the sun, rendered through the same projection as the scene (a view-offset
// window around the disc). Per pixel min(scene, ref) is the sunlight that actually reached the lens through
// whatever is in front (planet limbs, atmospheres, rings, asteroids). Off-screen window pixels fall back to
// the analytic sphere-occlusion value. The 32x32 result is mip-reduced on the GPU (no readback, no stall).
export const PROBE = HEAD + /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tRef;
uniform vec2 uOrigin;     // window bottom-left in scene pixels
uniform float uWin;       // window size in scene pixels
uniform vec2 uScreen;     // scene size in pixels
uniform float uAVis;      // analytic visibility
uniform int uMode;        // 0: ref (+u moment), 1: visible (+v moment)
void main() {
  vec2 f = gl_FragCoord.xy / 32.0;
  vec2 sp = uOrigin + f * uWin;
  vec3 ref = sane(texture(tRef, f).rgb);
  bool on = sp.x >= 0.0 && sp.y >= 0.0 && sp.x < uScreen.x && sp.y < uScreen.y;
  vec3 sc = on ? sane(texture(tScene, sp / uScreen).rgb) : ref * uAVis;
  vec3 m = min(sc, ref);
  float ml = luma(m);
  vec2 c = f - 0.5;
  fragColor = uMode == 0 ? vec4(ref, ml * c.x) : vec4(m, ml * c.y);
}`;

// ---------------------------------------------------------------- diffraction PSF: spectral sum (start-up)
// Sums the 550 nm Fraunhofer PSF (CPU FFT of the pupil, psf.js) over the spectrum: PSF_l(theta) =
// s^2 PSF_550(theta s), s = 550/l, weighted by the CIE->linear-sRGB matching functions. Runs once.
export const NL = 11;
export const SPECTRAL = HEAD + /* glsl */ `
#define NL ${NL}
uniform sampler2D tMono;   // N x N float32, centred (DC at N/2), nearest
uniform float uN;
uniform float uHalf;       // +- half-width of the output, 550 nm samples
uniform float uM;          // output size, texels
uniform float uS[NL];      // 550 / lambda
uniform vec3 uW[NL];       // channel weights per wavelength
uniform float uScale;      // keeps the half floats in their normal range
float P(vec2 s) {
  vec2 f = s + 0.5 * uN;
  vec2 i0 = floor(f);
  vec2 a = f - i0;
  ivec2 i = ivec2(i0);
  int n = int(uN);
  if (i.x < 0 || i.y < 0 || i.x >= n - 1 || i.y >= n - 1) return 0.0;
  float p00 = texelFetch(tMono, i, 0).r, p10 = texelFetch(tMono, i + ivec2(1, 0), 0).r;
  float p01 = texelFetch(tMono, i + ivec2(0, 1), 0).r, p11 = texelFetch(tMono, i + ivec2(1, 1), 0).r;
  return mix(mix(p00, p10, a.x), mix(p01, p11, a.x), a.y);
}
void main() {
  float tx = 2.0 * uHalf / uM;   // 550 nm samples per output texel (> 1: supersample 3x3 so thin spikes don't alias)
  vec3 acc = vec3(0.0);
  for (int sy = -1; sy <= 1; sy++)
    for (int sx = -1; sx <= 1; sx++) {
      vec2 o = (gl_FragCoord.xy - 0.5 * uM + vec2(float(sx), float(sy)) / 3.0) * tx;
      for (int k = 0; k < NL; k++) acc += P(o * uS[k]) * (uS[k] * uS[k]) * uW[k];
    }
  fragColor = vec4(acc * (uScale / 9.0), 1.0);
}`;

// ---------------------------------------------------------------- warp radial blur
export const WARP = HEAD + /* glsl */ `
// Radial speed streaks toward the focus of expansion, as an exact two-pass integral (wave 2).
// Coordinates along each ray from the focus are log-radius (a zoom blur is a translation in ln r), continued
// linearly beyond uR0 so a focus far outside the frame (sideways motion) gives parallel streaks of a capped length.
// Pass 1 gathers 16 taps outward (where the light now passing this pixel came from) at EVEN steps of uLen/16 in that
// coordinate, with a tapering weight, as an energy-conserving mean blended with a p=4 power mean wherever a sample
// is much brighter than the local mean (stars, city lights and limbs keep their peak along a tapered trail; diffuse
// sky smears without gaining energy). Pass 2 convolves the 16-tooth comb with a tent exactly two teeth wide
// (uN2 taps, ~1 px apart), which is linear interpolation between the teeth: one continuous, smoothly tapered trail.
// Because both passes step evenly in the same coordinate along the same ray, the composition is exact — no jitter,
// so no noise for thin line art to alias into hatching or moire (wave 1 jittered the taps and box-filtered one
// gap, and 1-px orbit lines broke into stripes once trails passed ~256 px).
// Dispersion (red reaches 2 % further than blue) is applied only to point-like samples: a tap whose neighbour 2 px
// across the trail is as bright (a line crossing the trail, diffuse light) keeps one position for all channels.
uniform sampler2D tSrc;   // pass 1: HDR; pass 2: pass-1 streaks
uniform sampler2D tOrig;  // the unstreaked HDR
uniform vec2 uRes;
uniform vec2 uFoe;        // focus of expansion, pixels
uniform float uLen;       // pass 1: trail length in the radial coordinate (ln(1 + L) near the focus)
uniform float uR0;        // radius (px) beyond which the radial coordinate is linear (capped trail length)
uniform int uN2;          // pass 2 tap count (~1 px apart)
uniform float uGain;      // trail brightness
uniform float uMix;       // 0 = pass-through, 1 = full streaks (final pass only)
uniform int uFinal;
uniform float uPowMix;    // how strongly bright samples follow the power mean (0 = pure speed blur)
uniform float uPMClamp;   // cap on the trail's excess luminance (scene units)
uniform vec2 uGlow;       // final pass: brightening toward the focus of expansion (amount, radius in pixels)
uniform vec3 uSunW;       // the solar disc (pixels: x, y, radius; radius 0 = none): it does not streak — its
                          // light reaches the frame through the analytic lens system instead
uniform float uInClamp;   // soft cap on a sample's luminance (scene units)
float sunCut(vec2 px) { return uSunW.z > 0.0 ? smoothstep(uSunW.z, uSunW.z + 4.0, length(px - uSunW.xy)) : 1.0; }
// Taps that leave the frame are mirrored back in. Dropping them starved the outermost columns; clamping smears the
// edge row into hatching. A mirrored tap continues the local content with the same statistics.
vec2 mirrorPx(vec2 px) { return uRes - abs(uRes - abs(px)); }
// per-channel soft knee: identity below k, asymptotic to 2k
vec3 softCap(vec3 c, float k) {
  vec3 o = k + k * (1.0 - exp(-(c - k) / k));
  return mix(c, o, step(vec3(k), c));
}
float rho(float r) { return r < uR0 ? log(max(r, 1e-4)) : log(uR0) + (r - uR0) / uR0; }
float rinv(float p) { float l0 = log(uR0); return p < l0 ? exp(p) : uR0 * (1.0 + p - l0); }
void main() {
  vec2 p = gl_FragCoord.xy;
  vec2 d = p - uFoe;
  float r = length(d);
  vec2 dir = r > 1e-4 ? d / r : vec2(1.0, 0.0);
  float r0 = rho(r);
  vec3 acc = vec3(0.0), acc4 = vec3(0.0), ws = vec3(0.0);
  if (uFinal == 0) {
    vec2 nrm = vec2(-dir.y, dir.x) * 2.0;
    for (int i = 0; i < 16; i++) {
      float s = float(i) / 16.0;
      float rr = rinv(r0 + uLen * s);
      vec2 pxG = mirrorPx(uFoe + dir * rr);
      // red reaches 2 % further along the trail than blue (in the trail's own coordinate)
      vec2 pxR = mirrorPx(uFoe + dir * rinv(r0 + uLen * s * 1.02));
      vec2 pxB = mirrorPx(uFoe + dir * rinv(r0 + uLen * s * 0.98));
      vec3 cg = texture(tSrc, pxG / uRes).rgb;
      vec3 cs = vec3(texture(tSrc, pxR / uRes).r, cg.g, texture(tSrc, pxB / uRes).b);
      float lp = luma(texture(tSrc, mirrorPx(pxG + nrm) / uRes).rgb);
      float pt = clamp(1.0 - lp / max(luma(cg), 1e-6), 0.0, 1.0);
      vec3 c = softCap(sane(mix(cg, cs, pt)), 0.5 * uInClamp);
      float cG = sunCut(pxG);
      vec3 w = (1.0 - s) * (1.0 - s) * vec3(mix(cG, sunCut(pxR), pt), cG, mix(cG, sunCut(pxB), pt));
      vec3 c2 = c * c;
      acc4 += c2 * c2 * w;
      acc += c * w;
      ws += w;
    }
    vec3 iw = 1.0 / max(ws, vec3(1e-6));
    vec3 mean = acc * iw;
    vec3 pm = sqrt(sqrt(acc4 * iw));
    // only where the trail carries a source much brighter than its surroundings
    float lm = luma(mean), lpm = luma(pm);
    float b = uPowMix * smoothstep(2.0, 6.0, lpm / max(lm, 1e-6));
    // the trail's excess over the mean is capped (in luminance, hue kept): a star or a city light keeps a bright
    // trail, but the Sun itself must not draw a white laser line across the frame. The brighter the excess, the
    // whiter it gets (a hot source's trail is white with faint coloured ends, never a saturated bar)
    vec3 ex = max(pm * 0.6 - mean, vec3(0.0));
    float le = luma(ex);
    ex *= min(1.0, uPMClamp / max(le, 1e-6));
    ex = mix(ex, vec3(luma(ex)), 0.75 * smoothstep(0.05 * uPMClamp, 0.6 * uPMClamp, le));
    fragColor = vec4(mean + b * ex, 1.0);
    return;
  }
  // pass 2: tent over +- one pass-1 tooth (uLen / 16) = linear interpolation between the teeth
  float g = uLen / 16.0;
  float wsum = 0.0;
  for (int k = 0; k < 64; k++) {
    if (k >= uN2) break;
    float tk = -1.0 + (2.0 * float(k) + 1.0) / float(uN2);
    float wk = 1.0 - abs(tk);
    vec2 px = mirrorPx(uFoe + dir * rinv(r0 + g * tk));
    acc += sane(texture(tSrc, px / uRes).rgb) * wk;
    wsum += wk;
  }
  vec3 streak = acc / wsum * uGain;
  vec3 orig = sane(texture(tOrig, p / uRes).rgb);
  // at the focus of expansion there is no motion blur: where the trail is shorter than ~1-2 px the unresampled
  // image is exact (the destination's point of light stays a crisp point instead of a twice-resampled blob)
  float tl = min(r, uR0) * (exp(uLen) - 1.0);
  float m = uMix * sunCut(p) * smoothstep(0.7, 2.2, tl);
  // a soft brightening toward the focus of expansion: the eye (and the lens) is drawn into the tunnel
  float rg = r / uGlow.y;
  fragColor = vec4(mix(orig, streak, m) * (1.0 + uMix * uGlow.x * exp(-rg * rg)), 1.0);
}`;

// ---------------------------------------------------------------- composite
export const NG = 5; // number of ghosts
export const COMPOSITE = HEAD + /* glsl */ `
#define NG ${NG}
#define NB 7.0
uniform sampler2D tHDR;
uniform sampler2D tBloom;
uniform sampler2D tProbeRef;
uniform sampler2D tProbeVis;
uniform vec2 uRes;
uniform vec2 uBloomTexel;
uniform float uBloomMix;
uniform float uBloomWarp;     // extra bloom mix during warp, confined to the periphery (the destination stays crisp)
uniform float uBloomNorm;
uniform sampler2D tOverlay;   // after-post overlay layer (scene-linear additive light), see OVERLAY_LAYER in post.js
uniform float uOverlayOn;
uniform float uExposure;
uniform float uFadeDisp;
uniform float uBarH;          // letterbox bar height (fraction of frame height, each side)
uniform float uFrame;
uniform float uGrain;
uniform float uVignette;
uniform float uTanHalf;
uniform float uCA;
uniform float uWarp;
uniform float uBarrel;
uniform float uCornerR2;
uniform int uDebug;
// sun lens system
uniform float uFlareOn;
uniform vec2 uSunPx;
uniform float uSunR;          // disc radius (frame-height units)
uniform vec3 uFlux;           // sun flux in frame units x colour
uniform float uAVis;
uniform float uProbeValid;
uniform float uProbeLod;
uniform float uProbeWin;      // window size, pixels
uniform float uKGlare;
uniform float uKStar;
uniform float uKGhost;
uniform float uKStreak;
uniform vec4 uBeam;           // scattered-light beam: amp, sigma, axis offset, fall-off length (frame heights)
uniform sampler2D tGhostSrc;  // 1/16-res bloom level (defocused source image for the image-based ghosts)
uniform vec4 uIG;             // image ghosts: energy fraction per ghost, threshold (scene units)
uniform vec3 uIGSun;          // the Sun's position and mask radius (frame-height coords), radius 0 = none
uniform float uStarRot;
uniform sampler2D tPSF;
uniform vec4 uPSF;            // texture half-size (frame heights), energy-density gain, mip level, core radius
uniform vec2 uPSFRot;         // cos, sin of the aperture rotation
uniform float uBladeRot;
uniform vec4 uGhostA[NG];     // k, radius, rim-peak intensity, edge softness
uniform vec4 uGhostB[NG];     // coating hue rgb (unit luminance), rim-caustic width
uniform vec4 uGhostC[NG];     // cat's-eye clip, dispersion, interior level (x rim), polygon (0 round, 1 stop)
uniform float uGhostRot[NG];  // per-ghost rotation of the stop image (pi for inverted images)
uniform vec4 uGlare;          // g1 amp, g1 radius, g2 amp, g2 radius
uniform vec4 uGlare2;         // g3 amp, g3 radius, barrel-flare amp, barrel-flare radius
uniform vec4 uStar2;          // starburst envelope radius, -, streak amp, streak length
uniform vec4 uGrade;          // saturation, shadow tint strength, highlight warmth, contrast
uniform vec4 uGrade2;         // hue preservation in the shoulder, punch (log-space saturation), -, -
uniform vec4 uHero;           // hero-Sun weight, ln(disc gain) (x weight), radial power n, solar-filter mix
uniform vec3 uHeroDir;        // unit vector to the Sun, camera space
uniform float uHeroSinR;      // sin of the Sun's angular radius
uniform float uHeroEdge;      // half a pixel, in solar radii (anti-aliased filter edge at the limb)
uniform vec3 uHeroFilter;     // solar-filter transmission (photosphere only)
uniform vec4 uHeroPivot;      // filtered disc-centre colour after exposure | log contrast of the photosphere

// ---------- AgX (Sobotka; Rec.2020 inset/outset, Filament/three.js constants) with a contrast look:
// the log2 window [-10.25, +2.25] (vs. the base [-12.47, +4.03]) is fitted so that a white Lambertian surface
// at unit irradiance lands at ~0.88 display and 18% grey at ~0.53 — a punchy, photographic response that
// still rolls every channel smoothly to white (the sun desaturates instead of clipping to yellow).
const mat3 SRGB_TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
const mat3 R2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
const mat3 AGX_IN = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
const mat3 AGX_OUT = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
const float AGX_MIN = -10.25;
const float AGX_MAX = 2.25;
vec3 agxCurve(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
const float AGX_PIVOT = 0.62203; // 18 % grey in the normalised log window
vec3 agx(vec3 c) {
  c = AGX_IN * (SRGB_TO_2020 * c);
  c = (log2(max(c, vec3(1e-10))) - AGX_MIN) / (AGX_MAX - AGX_MIN);
  // per-shot look in AgX log space, before the curve: "punch" (saturation around the log-luma, Blender's
  // punchy look) and contrast around 18 % grey
  float ll = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = ll + uGrade2.y * (c - ll);
  c = AGX_PIVOT + (c - AGX_PIVOT) * uGrade.w;
  c = clamp(c, 0.0, 1.0);
  c = agxCurve(c) * (1.0 / 0.9977);
  // look (ASC-CDL style, in AgX display space): saturation around luma
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = l + uGrade.x * (c - l);
  c = AGX_OUT * c;
  c = pow(max(c, vec3(0.0)), vec3(2.2));
  return clamp(R2020_TO_SRGB * c, 0.0, 1.0);
}
// Optional hue preservation in the shoulder (uGrade2.x): AgX's path to white turns a bright saturated emitter
// (the photosphere filling the frame) into beige. Tone-map the brightest channel and keep the scene's
// chromaticity instead, blended in only as the pixel reaches the shoulder, so the disc keeps a hot
// white-yellow core grading to orange at the limb while everything darker is untouched.
vec3 agxGraded(vec3 c) {
  vec3 a = agx(c);
  if (uGrade2.x <= 0.0) return a;
  float m = max(c.r, max(c.g, c.b));
  if (m <= 1e-8) return a;
  float g = agx(vec3(m)).g;
  vec3 h = clamp(c / m, 0.0, 1.0);
  h = mix(h, vec3(1.0), smoothstep(0.8, 1.0, g) * 0.3) * g;  // the very top still bleaches a little
  return mix(a, h, uGrade2.x * smoothstep(0.25, 0.8, g));
}
// Hero-Sun display: the same log-sigmoid as AgX, but per channel in sRGB primaries (no inset/outset). For greys it
// is identical to agx(); for the filtered photosphere the red channel shoulders first while green still carries
// the limb darkening, which is how a camera behind an orange solar filter renders the disc (golden centre, deep
// orange limb, near-black umbrae) instead of AgX's path to pale peach.
vec3 heroTone(vec3 c) {
  vec3 x = (log2(max(c, vec3(1e-10))) - AGX_MIN) / (AGX_MAX - AGX_MIN);
  x = clamp(x, 0.0, 1.0);
  return pow(max(agxCurve(x) * (1.0 / 0.9977), vec3(0.0)), vec3(2.2));
}
// Radially graded composite gain around the Sun (see HERO in post.js). Returns ln(gain); the filter mask is the
// photosphere's anti-aliased coverage.
float heroLnGain(vec2 q, out float disc) {
  vec3 v = normalize(vec3(q * (2.0 * uTanHalf), -1.0));
  float c = dot(v, uHeroDir);
  // impact parameter of the pixel's ray in solar radii (behind the camera: the camera's own distance)
  vec3 w = v - c * uHeroDir;
  float rho = (c > 0.0 ? length(w) : 1.0) / uHeroSinR;
  disc = 1.0 - smoothstep(1.0 - uHeroEdge, 1.0 + uHeroEdge, rho);
  // ln g = ln g_disc + n ln rho, eased back to 0 with a soft knee (no Mach band where the filter ends)
  // lifting a darker-exposed disc happens on the photosphere only (the corona keeps the shot's exposure)
  if (uHero.y > 0.0) return uHero.y * disc;
  float a = -uHero.y;
  float y = a - uHero.z * log(max(rho, 1.0));
  float k = 0.12 + 0.18 * min(a, 1.0);
  float sp = y > 8.0 * k ? y : k * log(1.0 + exp(y / k));
  // softplus overshoots by up to k ln2 at rho = 1: rescale so the disc gets exactly g_disc
  float sp1 = a > 8.0 * k ? a : k * log(1.0 + exp(a / k));
  return -sp * (a / max(sp1, 1e-6));
}
vec3 srgbEncode(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// ---------- scene sampling with lateral chromatic aberration
vec2 toUv(vec2 q) { return vec2(q.x * uRes.y / uRes.x, q.y) + 0.5; }
// Catmull-Rom resample (5 bilinear fetches, Jimenez 2016): the warp's barrel magnifies the centre ~10 %, and a
// bilinear resample of the already twice-resampled streak image turned the destination's point of light into a
// soft blob; the bicubic keeps it crisp. The CA's per-channel shifts ride on top as bilinear differences.
vec3 texCR(sampler2D t, vec2 uv) {
  vec2 res = uRes;
  vec2 sp = uv * res;
  vec2 tp = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 t0 = (tp - 1.0) / res, t3 = (tp + 2.0) / res, t12 = (tp + o12) / res;
  vec3 c = texture(t, vec2(t12.x, t0.y)).rgb * (w12.x * w0.y)
         + texture(t, vec2(t0.x, t12.y)).rgb * (w0.x * w12.y)
         + texture(t, vec2(t12.x, t12.y)).rgb * (w12.x * w12.y)
         + texture(t, vec2(t3.x, t12.y)).rgb * (w3.x * w12.y)
         + texture(t, vec2(t12.x, t3.y)).rgb * (w12.x * w3.y);
  float n = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
  return c / n;
}
vec3 sceneCA(vec2 qs, float r2) {
  float k = uCA;
  vec2 uvR = toUv(qs * (1.0 + k * r2));
  vec2 uvG = toUv(qs);
  vec2 uvB = toUv(qs * (1.0 - k * r2));
  vec3 c;
  c.r = texture(tHDR, uvR).r;
  c.g = texture(tHDR, uvG).g;
  c.b = texture(tHDR, uvB).b;
  if (uBarrel > 0.0) {
    vec3 g = texture(tHDR, uvG).rgb;
    c = texCR(tHDR, uvG) + (c - g);
  }
  return sane(c);
}
vec3 bloomTent(vec2 uv) {
  vec2 t = 0.5 * uBloomTexel;
  return 0.25 * (texture(tBloom, uv + vec2(-t.x, -t.y)).rgb + texture(tBloom, uv + vec2(t.x, -t.y)).rgb
               + texture(tBloom, uv + vec2(-t.x, t.y)).rgb + texture(tBloom, uv + vec2(t.x, t.y)).rgb);
}

// ---------- sun lens system (all in frame-height units, origin = frame centre)
// Aperture: 7 rounded blades. The same polygon shapes the ghosts and orients the 14-point starburst, as in a
// real lens (diffraction spikes are perpendicular to the blade edges).
float bladeK(float ang) {
  float seg = 2.0 * PI / NB;
  float a = mod(ang - uBladeRot + 0.5 * seg, seg) - 0.5 * seg;
  return mix(cos(a) / cos(PI / NB), 1.0, 0.28);
}
vec3 sq3(vec3 x) { return x * x; }
float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0)), f.x), f.y);
}
// Aperture ghosts (see GHOSTS in post.js). Each one is mostly rim: a defocused image of the stop or of an element
// edge piles its light into a thin caustic just inside the edge (an exponential ramp rising to the edge, then a
// crisp, anti-aliased cut), with the interior at ~10-20 % of the rim, faintly mottled by dust and polishing zones.
// Longer wavelengths image larger, so the rim fringes red outside / blue inside; each ghost carries its own coating
// hue; the barrel cuts the off-axis ones into cat's eyes.
float apertureK(float ang, float rot, float poly) {
  float seg = 2.0 * PI / NB;
  float a = mod(ang - rot + 0.5 * seg, seg) - 0.5 * seg;
  return mix(1.0, mix(cos(a) / cos(PI / NB), 1.0, 0.28), poly);
}
vec3 ghosts(vec2 q, vec2 s) {
  vec3 acc = vec3(0.0);
  float off = length(s);
  for (int i = 0; i < NG; i++) {
    vec4 A = uGhostA[i];
    if (A.z <= 0.0) continue;
    vec2 p = (q - s * A.x) / A.y;
    float rr = length(p);
    if (rr > 1.2) continue;
    vec4 B = uGhostB[i];
    vec4 C = uGhostC[i];
    float kp = apertureK(atan(p.y, p.x), uBladeRot + uGhostRot[i], C.w);
    vec3 sc = 1.0 + C.y * vec3(1.0, 0.0, -1.0);          // longer wavelengths image larger (dispersion)
    vec3 sd = rr * kp / sc - 1.0;                         // <0 inside the aperture image
    // edge: at least ~1 px wide (no aliasing on the small ones), wider for the strongly defocused ones
    float aa = max(A.w, 1.5 / (A.y * uRes.y));
    vec3 m = 1.0 - smoothstep(-aa, aa, sd);
    // the caustic: rises to the edge over B.w of the radius; lit unevenly around the circumference (element
    // decentring), never a uniform outline
    vec2 ca = p / max(rr, 1e-4);
    float rimVar = 0.55 + 0.9 * vnoise(ca * 1.7 + vec2(float(i) * 7.31, float(i) * 3.7));
    vec3 caus = exp(min(sd, vec3(0.0)) / B.w) * rimVar;
    vec2 no = p * 2.3 + float(i) * 3.17;
    float mott = 0.6 * vnoise(no) + 0.4 * vnoise(no * 2.2 + 5.3);
    float inner = C.z * (0.7 + 0.6 * mott);
    vec3 prof = inner + (1.0 - C.z) * caus;
    // cat's-eye vignetting by the lens barrel: the ghost is cut by a second circle that slides along the axis
    if (C.x > 0.0) {
      vec2 oc = (off > 1e-4 ? -s / off : vec2(0.0)) * min(off * C.x, 1.2);
      float dc = length(p - oc) - 1.08;
      m *= 1.0 - smoothstep(-0.05, 0.05, dc);
    }
    // the coating's reflectance hue drifts a little with the angle of incidence
    vec3 tint = B.rgb * (1.0 + 0.15 * off * (B.gbr - B.rgb));
    acc += m * prof * tint * A.z;
  }
  return acc;
}
vec3 sunGlare(vec2 d) {
  float r = length(d);
  float re = max(r - uSunR, 0.0);
  // aureole (glass + sensor scatter), glare skirt, veiling glare — the long tail of the lens PSF, convolved with
  // the solar disc: each term keeps its energy but spreads over (kernel radius^2 + disc radius^2), so a point-like
  // sun gets the kernel's sharp peak while a disc much wider than the kernel is veiled by only a small fraction of
  // its own radiance (the aureole no longer paints the point-source peak over a 5-degree disc)
  float R2 = uSunR * uSunR;
  float g1 = uGlare.x * (uGlare.y * uGlare.y / (uGlare.y * uGlare.y + R2)) * exp(-re / uGlare.y);
  float x2 = re / uGlare.w;
  float g2 = uGlare.z * (uGlare.w * uGlare.w / (uGlare.w * uGlare.w + R2)) * pow(1.0 + x2 * x2, -1.5);
  float x3 = re / uGlare2.y;
  float g3 = uGlare2.x * (uGlare2.y * uGlare2.y / (uGlare2.y * uGlare2.y + R2)) * pow(1.0 + x3 * x3, -1.5);
  // barrel / mount flare: light from a source just outside the field skims the lens barrel and the edges of
  // the elements and spreads as a broad haze on that side of the frame (amplitude set on the CPU, zero when
  // the sun is well inside the frame)
  float x4 = re / uGlare2.w;
  float g4 = uGlare2.z / (1.0 + x4 * x4);
  return vec3(g1 + g2 + g3) + g4 * vec3(1.0, 0.97, 0.92);
}
// Diffraction starburst: the lens's own Fraunhofer PSF (|FFT(pupil)|^2 summed over the spectrum, psf.js),
// rotated with the aperture. Sampling a mip level sized to the solar disc convolves the PSF with the disc, so a
// point-like sun at 30 AU gets crisp, finely fringed spikes and the 0.5 deg disc at 1 AU soft, wider ones. The
// core (the Airy disc and first rings) is the sharp image of the disc itself, already in the scene.
vec3 starburst(vec2 d) {
  float r = length(d);
  if (r >= uPSF.x) return vec3(0.0);
  vec2 rd = vec2(uPSFRot.x * d.x + uPSFRot.y * d.y, -uPSFRot.y * d.x + uPSFRot.x * d.y);
  vec2 u = rd / (2.0 * uPSF.x);
  // lateral colour of the lens on top of the diffraction's own lambda scaling: red images ~4 % larger and blue
  // smaller, so the spike tips fringe red and their roots blue
  vec3 p;
  p.r = textureLod(tPSF, u * (1.0 / 1.04) + 0.5, uPSF.z).r;
  p.g = textureLod(tPSF, u + 0.5, uPSF.z).g;
  p.b = textureLod(tPSF, u * (1.0 / 0.96) + 0.5, uPSF.z).b;
  float core = smoothstep(uPSF.w, 2.5 * uPSF.w, r);
  // envelope: beyond uStar2.x the spikes taper an extra r^-2 (coatings, the hood, a stopped-down but not
  // pinhole iris); uStar2.x grows with how hard the sun is over-exposed, so the visible length follows the
  // exposure instead of being one fixed star-filter size; plus a gradual window over the texture
  float e = r / uStar2.x;
  float x = r / uPSF.x;
  float edge = 1.0 - x * x;
  return p * (uPSF.y * core * edge * edge / (1.0 + e * e));
}
vec3 streak(vec2 d) {
  float ax = abs(d.x), ay = abs(d.y);
  // thickness grows with the distance from the source, so any residual stays a soft band, never a 1-px line
  float h = 0.0011 + 0.5 * uSunR * exp(-ax / 0.02) + ax * 0.0075;
  float v = exp(-ay / h) * (0.0011 / h);
  float u = pow(1.0 + ax / uStar2.w, -1.6);
  return uStar2.z * v * u * vec3(0.55, 0.78, 1.0);
}
// Scattered-light beams (sun just outside a narrow field): soft bands fanning out from the sun across the frame,
// each with its own tint, the way stray light off the sunshade crosses Voyager 1's Pale Blue Dot frame. The main
// band runs through the frame centre (the director puts Earth on that line); fainter companions diverge from it.
vec3 beamBand(vec2 rel, vec2 dir, float ang, float sig, vec3 tint) {
  float c = cos(ang), sn = sin(ang);
  vec2 d = vec2(dir.x * c - dir.y * sn, dir.x * sn + dir.y * c);
  float along = max(dot(rel, d), 0.0);
  float across = rel.x * d.y - rel.y * d.x;
  float w = sig * (1.0 + 0.9 * along);
  float a = across / w;
  return tint * exp(-0.5 * a * a) * (sig / w) / (1.0 + along / uBeam.w);
}
vec3 sunBeam(vec2 q, vec2 s) {
  float ls = length(s);
  vec2 dir = ls > 1e-5 ? -s / ls : vec2(0.0, 1.0);
  vec2 rel = q - s - vec2(-dir.y, dir.x) * uBeam.z;
  vec3 b = beamBand(rel, dir, 0.0, uBeam.y, vec3(1.0, 0.80, 0.58));
  b += beamBand(rel, dir, 0.105, uBeam.y * 1.5, vec3(0.42, 0.62, 1.0) * 0.5);
  b += beamBand(rel, dir, -0.150, uBeam.y * 2.1, vec3(0.62, 0.95, 0.66) * 0.3);
  b += beamBand(rel, dir, 0.235, uBeam.y * 2.6, vec3(1.0, 0.55, 0.42) * 0.22);
  return uBeam.x * b;
}
void flareTerms(vec2 fc, out vec3 lensLight, out vec3 vis) {
  vis = vec3(uAVis);
  vec2 cen = vec2(0.0);
  if (uProbeValid > 0.5) {
    vec4 a = textureLod(tProbeRef, vec2(0.5), uProbeLod);
    vec4 b = textureLod(tProbeVis, vec2(0.5), uProbeLod);
    vis = clamp(b.rgb / max(a.rgb, vec3(1e-7)), 0.0, 1.0);
    // a nearly unobstructed sun stays neutral: per-channel differences of a few per cent (sub-pixel MSAA
    // edges, shell dither) must not be amplified into a tint over the whole frame; deep occlusion through an
    // atmosphere keeps its true colour (the flare reddens and dims as the sun sets behind a limb)
    float lv = clamp(luma(b.rgb) / max(luma(a.rgb), 1e-7), 0.0, 1.0);
    vis = mix(vec3(lv), vis, smoothstep(0.985, 0.85, lv));
    float bl = luma(b.rgb);
    if (bl > 1e-7) cen = vec2(a.a, b.a) / bl * uProbeWin;   // centroid of the light that got through
  }
  vec2 sunPx = uSunPx + cen;
  vec2 q = (fc - 0.5 * uRes) / uRes.y;
  vec2 s = (sunPx - 0.5 * uRes) / uRes.y;
  vec2 d = q - s;
  vec3 L = vec3(0.0);
  if (uKGlare > 0.0) L += uKGlare * sunGlare(d);
  if (uKStreak > 0.0) L += uKStreak * streak(d);
  if (uKStar > 0.0) L += uKStar * starburst(d);
  if (uKGhost > 0.0) L += uKGhost * ghosts(q, s);
  if (uBeam.x > 0.0) L += sunBeam(q, s);
  lensLight = L * uFlux * vis;
}

// Image-based ghosts: every very bright source in the frame (a blazing crescent, a ring ansa, an atmosphere's
// limb at a pushed exposure) is reflected between lens surfaces into defocused, mirrored, rescaled copies of
// itself on the axis through the frame centre — what a real lens does with any bright source, not only the Sun.
// Three copies from the defocused bloom level, each with its coating tint; energy-conserving (1/k^2).
vec3 imageGhosts(vec2 q) {
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 3; i++) {
    float k = i == 0 ? -0.62 : (i == 1 ? -1.35 : 0.47);
    vec3 tint = i == 0 ? vec3(0.95, 1.0, 0.9) : (i == 1 ? vec3(1.0, 0.9, 0.96) : vec3(0.9, 0.95, 1.0));
    vec2 qs = q / k;
    vec2 uvs = toUv(qs);
    if (any(lessThan(uvs, vec2(0.0))) || any(greaterThan(uvs, vec2(1.0)))) continue;
    vec3 c = textureLod(tGhostSrc, uvs, 0.0).rgb;
    float l = luma(c);
    c *= max(l - uIG.y, 0.0) / max(l, 1e-6);
    // the edges of the source image fade out (no hard frame border in the ghost)
    vec2 e = min(uvs, 1.0 - uvs);
    c *= smoothstep(0.0, 0.08, min(e.x, e.y));
    if (uIGSun.z > 0.0) c *= smoothstep(uIGSun.z, uIGSun.z * 1.6, length(qs - uIGSun.xy));
    acc += c * tint / (k * k);
  }
  return acc * uIG.x;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = fc / uRes;
  // letterbox (2.39:1): bars are true black, with a one-pixel anti-aliased edge
  float dy = abs(fc.y - 0.5 * uRes.y);
  float edge = 0.5 * uRes.y - uBarH * uRes.y;
  float bar = clamp(dy - edge + 0.5, 0.0, 1.0);
  if (bar >= 1.0) { fragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec2 q = (fc - 0.5 * uRes) / uRes.y;
  float r2 = dot(q, q);
  // warp: slight barrel distortion (centre magnified, edges compressed, corners stay put)
  vec2 qs = q * (1.0 + uBarrel * r2) / (1.0 + uBarrel * uCornerR2);
  vec3 col = sceneCA(qs, r2);

  vec3 bloom = bloomTent(toUv(qs)) * uBloomNorm;
  col = mix(col, bloom, uBloomMix + uBloomWarp * smoothstep(0.08, 0.45, length(qs)));

  vec3 lens = vec3(0.0), vis = vec3(0.0);
  if (uFlareOn > 0.5) flareTerms(fc, lens, vis);
  float heroDisc = 0.0;
  if (uHero.x > 0.0) {
    // hero Sun: the disc behind its solar filter at its own exposure, graded back to the shot's exposure over a
    // few solar radii (scene, bloom and lens light alike, so the glow keeps its shape)
    float disc;
    float lg = heroLnGain(q, disc);
    heroDisc = disc;
    float gk = exp(lg);
    col *= gk * mix(vec3(1.0), uHeroFilter, uHero.w * disc);
    lens *= gk;
  }
  if (uIG.x > 0.0) col += imageGhosts(q);
  col += lens;

  if (uDebug == 1) col = bloom;
  else if (uDebug == 2) col = lens;
  else if (uDebug == 3) col = vec3(vis) + lens * 0.0;

  // natural vignetting (cos^4 law, mostly compensated, as in a modern cine lens)
  float t2 = r2 * 4.0 * uTanHalf * uTanHalf;
  float cos4 = 1.0 / ((1.0 + t2) * (1.0 + t2));
  col *= mix(1.0, cos4, uVignette);

  // after-post overlay (orbit lines, markers): composited over the finished optics — no warp streaks, bloom,
  // flare, CA or vignette — but registered with the warp's barrel and taken through the same exposure and tone
  // curve as the scene, so a line drawn into it looks exactly as it would in the scene, only clean
  if (uOverlayOn > 0.5) col += sane(texture(tOverlay, toUv(qs)).rgb);

  col *= uExposure;
  // the filtered photosphere: log contrast about its centre colour (only inside the limb)
  if (uHero.x > 0.0 && heroDisc > 0.0)
    col = mix(col, uHeroPivot.rgb * pow(max(col, vec3(1e-9)) / uHeroPivot.rgb, vec3(uHeroPivot.w)), heroDisc);
  vec3 dsp = agxGraded(col);
  if (uHero.x > 0.0) dsp = mix(dsp, heroTone(col), uHero.x);

  // gentle grade in display-linear: cool the deep shadows a touch, warm the highlights, keep black at black
  float l = luma(dsp);
  float sh = 1.0 - smoothstep(0.0, 0.25, l);
  float hi = smoothstep(0.35, 1.0, l);
  dsp *= mix(vec3(1.0), vec3(1.0 - 0.5 * uGrade.y, 1.0, 1.0 + uGrade.y), sh * smoothstep(0.0, 0.02, l));
  dsp *= mix(vec3(1.0), vec3(1.0 + uGrade.z, 1.0 + 0.3 * uGrade.z, 1.0 - uGrade.z), hi);

  vec3 s = srgbEncode(clamp(dsp, 0.0, 1.0));

  // film grain: deterministic (frame index from t), soft (two-pixel correlated), luminance-weighted so the
  // black of space stays clean and highlights stay clean; strongest in the mid-tones like real stock.
  vec2 gp = fc / 1.6;
  vec2 gi = floor(gp), gf = fract(gp);
  gf = gf * gf * (3.0 - 2.0 * gf);
  float fo = uFrame * 17.0;
  float g00 = hash12(gi + fo), g10 = hash12(gi + vec2(1.0, 0.0) + fo), g01 = hash12(gi + vec2(0.0, 1.0) + fo), g11 = hash12(gi + vec2(1.0) + fo);
  float g = mix(mix(g00, g10, gf.x), mix(g01, g11, gf.x), gf.y) - 0.5;
  float sl = dot(s, vec3(0.2126, 0.7152, 0.0722));
  float gw = smoothstep(0.0, 0.18, sl) * (1.0 - 0.7 * smoothstep(0.55, 1.0, sl));
  s += g * uGrain * gw;

  // triangular-PDF dither (+-1 LSB) from an R2 low-discrepancy sequence (blue-noise-like), animated per frame
  float n = fract(dot(fc, vec2(0.7548776662, 0.5698402910)) + uFrame * 0.6180339887);
  float tt = n * 2.0 - 1.0;
  float tri = sign(tt) * (1.0 - sqrt(1.0 - abs(tt)));
  s += tri / 255.0;

  s *= uFadeDisp;
  s *= 1.0 - bar;
  fragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;
