// Earth radiance: five programs on the same proxy sphere (+ the transmittance pass in earth-glsl.js).
//
// Compile budget. ANGLE (Chrome on Windows) compiles GLSL -> HLSL -> FXC at a program's first draw; FXC inlines every
// call and its time grows ~n^2.7 with the program's instruction count and steeply with loop nesting (measured offline
// with dev/fxc.py on ANGLE's own HLSL: 1400 slots ~0.45 s, 2600 slots ~2.4 s; the wave-1 single program was 20 s). So
// the work is split into programs of ~300-900 slots, each holding every heavy block once (one atmosphere march, one
// cloud-field site, one fbm site, one lamp loop), with uniform loop bounds and all fractal noise read from the baked
// 3D texture (noise3d.js). Prepasses are drawn by earth.js in update(), in this order, with the frame's camera at the
// drawing-buffer size (= post's HDR target), and read back with texelFetch at the same pixel:
//
//   C  "clouds"     -> rtC (RGBA32F, packed half pairs): cloud field above the pixel - reflectance, map mean, top relief,
//                      top slope, ice damping
//   C' (uShadowPass) -> rtS: the same program at the point where the sun ray from the ground crosses the layer
//                      (cloud-shadow strength)
//   G  "ground"     -> rtG (RGBA16F): land + ocean radiance at the ground point (reads rtC, rtS), water mask
//   L  "cloudlight" -> rtS: cloud radiance x coverage, coverage (reads rtC)
//   Q  "city"       -> rtC: city lights on the ground, their glow under the clouds (reads rtG)
//   A  "radiance"   (in the scene, additive; reads rtS, rtG, rtC): atmosphere march (ground path split at the cloud
//                      layer + limb chord), composite, limb sky, airglow
import { NOISE_GLSL } from '../../glsl/noise.js';
import { NOISE3_GLSL } from './noise3d.js';
import { EARTH_COMMON } from './earth-glsl.js';
import { CLOUDS_GLSL } from './clouds-glsl.js';
import { CITYLIGHTS_GLSL } from './citylights-glsl.js';

const HEAD = /* glsl */ `
${EARTH_COMMON}
${NOISE_GLSL}
${NOISE3_GLSL}
uniform vec3 uCenterW;
uniform vec3 uSunDir;          // planet centre -> Sun (world axes, unit)
uniform mat3 uW2B;             // world axes -> body-fixed (rotating) frame
uniform vec3 uMoonRel;         // Moon centre relative to Earth centre (world)
uniform float uMoonR;
uniform float uSunAngR;        // angular radius of the Sun seen from Earth
uniform float uDays;           // simulated days since the film epoch
uniform vec3 uSeasonEdge;      // Arctic / Antarctic sea-ice edge latitude, NH snow-line latitude (deg) for the date
uniform float uRc;             // cloud layer radius
uniform float uAirglow;        // airglow emission scale
uniform float uDetail;         // quality: 0 = low .. 1 = high
uniform int uDebug;
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform sampler2D uHeight;
uniform sampler2D uWater;
uniform sampler2D uShelf;      // continental-shelf depth: 1 at the shore .. 0 below 200 m
uniform highp sampler2D uPreC; // pass C output (packed)
uniform highp sampler2D uPreG; // pass G output
uniform highp sampler2D uPreS; // pass C (shadow draw) output
uniform int uShadowPass;
varying vec3 vPosW;
#define DAY_TEXEL 0.00153      // 2 pi / 4096

vec2 dirToUV(vec3 d) {
  return vec2(atan(-d.z, d.x) * (0.5 / PI) + 0.5, asin(clamp(d.y, -1.0, 1.0)) / PI + 0.5);
}
vec3 tangentA(vec3 n) { return normalize(cross(abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n)); }

// fraction of the solar disc visible past the Moon (solar-eclipse shadow) from point p (planet-centred)
float moonShadow(vec3 p, vec3 sunDir) {
  vec3 toM = uMoonRel - p;
  float dM = length(toM);
  float angM = asin(clamp(uMoonR / dM, 0.0, 1.0));
  float sep = atan(length(cross(toM / dM, sunDir)), dot(toM / dM, sunDir));
  float rs = uSunAngR;
  if (sep >= rs + angM) return 1.0;
  float ov = clamp((rs + angM - sep) / (2.0 * min(rs, angM)), 0.0, 1.0);
  return 1.0 - smoothstep(0.0, 1.0, ov) * min(1.0, (angM * angM) / (rs * rs));
}

// per-pixel geometry shared by the three passes: the view ray, the analytic limb coverage (from the ray's closest
// approach, anti-aliased), the ground point (edge pixels that just miss: the tangent point projected onto the sphere)
struct Px { vec3 rd; vec3 ro; vec2 ta; float b; vec3 qv; float dq; float cov; bool hit; float tHit; vec3 P; vec3 N; vec3 pb; };
Px pixel() {
  Px x;
  x.rd = normalize(vPosW);
  x.ro = -uCenterW;
  x.ta = raySphere(x.ro, x.rd, uRt);
  x.b = dot(x.ro, x.rd);
  x.qv = x.ro - x.b * x.rd;
  x.dq = length(x.qv);
  x.cov = (x.b < 0.0) ? clamp((uRp - x.dq) / max(fwidth(x.dq), 1e-9) + 0.5, 0.0, 1.0) : 0.0;
  vec2 tg = raySphere(x.ro, x.rd, uRp);
  x.hit = tg.x <= tg.y && tg.y > 0.0;
  x.tHit = x.hit ? tg.x : max(-x.b, 0.0);
  x.P = x.hit ? x.ro + x.rd * x.tHit : normalize(x.qv) * uRp;
  x.N = normalize(x.P);
  x.pb = uW2B * x.N;
  return x;
}
// the cloud layer: first intersection from outside, else straight above the ground point
vec3 cloudPoint(Px x, out bool front, out float tCl) {
  vec2 tcS = raySphere(x.ro, x.rd, uRc);
  front = tcS.x > 0.0 && tcS.x < x.tHit;
  tCl = front ? tcS.x : x.tHit;
  return front ? x.ro + x.rd * tCl : x.N * uRc;
}
// half pairs in a float32 channel: non-negative values in the high half (+1, so the float32 is never denormal or NaN)
float pk2(float lo, float hi) { return uintBitsToFloat(packHalf2x16(vec2(lo, hi + 1.0))); }
vec2 up2(float v) { return unpackHalf2x16(floatBitsToUint(v)) - vec2(0.0, 1.0); }
`;

// ------------------------------------------------------------------------------------------------ pass C: clouds
export const EARTH_CLOUDS_FRAG = /* glsl */ `
${HEAD}
${CLOUDS_GLSL}
void main() {
  Px x = pixel();
  bool front; float tCl;
  vec3 Pc = cloudPoint(x, front, tCl);
  vec3 pbc = uW2B * normalize(Pc);
  vec2 uvc = dirToUV(pbc), uv = dirToUV(x.pb);
  vec2 cgx = dFdx(uvc), cgy = dFdy(uvc);
  cgx.x -= floor(cgx.x + 0.5); cgy.x -= floor(cgy.x + 0.5);
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
  vec3 dPcx = dFdx(pbc), dPcy = dFdy(pbc), dPbx = dFdx(x.pb), dPby = dFdy(x.pb);
  // octave-fade footprint: the geometric mean of an oblique footprint's axes (the max axis blurs grazing views); the
  // octaves this keeps that are under a pixel along the foreshortened axis are anti-aliased by the threshold's exact
  // screen-space width in cloudField (with an isotropic width they aliased into rows of horizontal dashes)
  float lx = length(dPcx), ly = length(dPcy);
  float fpC = max(max(1.25 * sqrt(lx * ly), 0.4 * max(lx, ly)), 1e-7);
  if (x.cov <= 0.0) { gl_FragColor = uShadowPass == 1 ? vec4(0.0) : vec4(pk2(0.0, 0.0)); return; }
  vec3 day = textureGrad(uDay, uv, gx, gy).rgb;
  float wm = textureGrad(uWater, uv, gx, gy).r;
  float water = smoothstep(0.3, 0.7, wm) * smoothstep(-0.004, 0.012, day.b - max(day.r, day.g) + 0.01 * smoothstep(0.6, 1.0, wm));
  float latD = asin(clamp(x.pb.y, -1.0, 1.0)) * (180.0 / PI);
  // draw 0: the layer above this pixel; draw 1 (uShadowPass): where the sun ray from the ground crosses the layer - the
  // cloud shadow, the same field at a wider footprint (soft-edged like real cloud shadows lit by the sky). Two draws of
  // one program instead of a loop: FXC's compile time grows steeply with loop nesting.
  int oct = int(mix(3.0, 8.0, uDetail));
  bool sh = uShadowPass == 1;
  vec2 ts = raySphere(x.P, uSunDir, uRc);
  vec3 pbs = uW2B * normalize(x.P + uSunDir * max(ts.y, 0.0));
  vec3 cgrad;
  float R0cl, hTopC;
  float Rcl = cloudField(sh ? pbs : pbc, sh ? dirToUV(pbs) : uvc, vec4(cgx, cgy), sh ? max(fpC * 2.0, 0.00025) : fpC,
                         sh ? dPbx * 2.0 : dPcx, sh ? dPby * 2.0 : dPcy, oct, water, cgrad, R0cl, hTopC);
  // the source map's polar areas are thermal IR: the ice sheets show up as "cloud"; damp them
  float iceSheet = smoothstep(-62.0, -70.0, latD) * (1.0 - water) + smoothstep(0.55, 0.75, dot(day, vec3(0.333))) * (1.0 - water) * smoothstep(55.0, 65.0, abs(latD));
  float iceDamp = 1.0 - 0.6 * clamp(iceSheet, 0.0, 1.0);
  // cloud-top slope (soft-clamped) in the tangent basis of pbc
  vec3 sl = (cgrad - pbc * dot(cgrad, pbc)) / uRp;
  sl /= 1.0 + length(sl) / 2.2;
  vec3 e1 = tangentA(pbc), e2 = cross(pbc, e1);
  if (sh) gl_FragColor = vec4(min(Rcl, 1.6 * R0cl) * iceDamp * 0.9);      // shadow strength (never darker than the layer allows)
  else gl_FragColor = vec4(pk2(dot(sl, e1), Rcl * iceDamp), pk2(dot(sl, e2), R0cl), pk2(hTopC / KM, 0.0), pk2(0.0, iceDamp));
}
`;

// ------------------------------------------------------------------------------------------------ pass G: ground
export const EARTH_GROUND_FRAG = /* glsl */ `
${HEAD}
float G1(float NdX, float a2) { return 2.0 * NdX / (NdX + sqrt(a2 + (1.0 - a2) * NdX * NdX)); }
void main() {
  Px x = pixel();
  vec3 pb = x.pb, N = x.N;
  vec2 uv = dirToUV(pb);
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
  float fpU = max(length(fwidth(x.P)), 1e-7) / uRp;
  if (x.cov <= 0.0) { gl_FragColor = vec4(0.0); return; }
  ivec2 ip = ivec2(gl_FragCoord.xy);
  float R0cl = up2(texelFetch(uPreC, ip, 0).y).y, shadow = 1.0 - texelFetch(uPreS, ip, 0).r;
  vec3 sunDir = uSunDir;
  float muS = dot(N, sunDir);
  vec3 Tsun = sunTrans(uRp + 2e-5, muS) * moonShadow(x.P, sunDir);
  vec3 V = -x.rd;
  float NdV = max(dot(N, V), 1e-3);
  float detailFade = smoothstep(DAY_TEXEL * 2.5, DAY_TEXEL * 0.5, fpU) * uDetail;
  bool det = detailFade > 0.0;

  // ---------------- textures. Sub-texel detail: once a Blue Marble texel (~10 km) spans several pixels the lookup is
  // displaced by up to ~0.4 texel along a fractal field, so the map's own edges (coasts, field boundaries, river
  // valleys, dune seas) continue as crisp fractal shapes below its resolution instead of bilinear blur
  vec2 uvD = uv;
  float jw = smoothstep(DAY_TEXEL * 0.8, DAY_TEXEL * 0.25, fpU) * uDetail;
  if (jw > 0.0) {
    vec2 j = 0.16 * tn(pb * 2600.0).yz + 0.08 * tn(pb * 7800.0 + vec3(3.3, 8.8, 1.2)).yz;
    uvD += j * jw * vec2(1.0 / (4096.0 * max(sqrt(1.0 - pb.y * pb.y), 0.05)), 1.0 / 2048.0);
  }
  vec3 day = textureGrad(uDay, uvD, gx, gy).rgb;
  float wm = textureGrad(uWater, uvD, gx, gy).r;
  float hgt = textureGrad(uHeight, uv, gx, gy).r;
  float latD = asin(clamp(pb.y, -1.0, 1.0)) * (180.0 / PI);
  // water: Natural Earth mask, sharpened by the colour of the Blue Marble pixel (open water is blue-dominant)
  float water = smoothstep(0.3, 0.7, wm) * smoothstep(-0.004, 0.012, day.b - max(day.r, day.g) + 0.01 * smoothstep(0.6, 1.0, wm));

  // ---------------- relief from the height map (3 taps along tangent axes; well defined at the poles)
  vec3 Ta3 = tangentA(pb), Tb3 = cross(pb, Ta3);
  float eps = max(0.0032, fpU * 1.5);
  float lodH = log2(max(eps / 0.0031, 1.0));
  float h0 = textureLod(uHeight, uv, lodH).r;
  // tap UVs from the analytic Jacobian of the equirectangular map (no extra atan / asin)
  float rxz = max(pb.x * pb.x + pb.z * pb.z, 1e-6);
  vec2 uv1 = uv + vec2((pb.z * Ta3.x - pb.x * Ta3.z) / rxz * (0.5 / PI), Ta3.y * inversesqrt(rxz) / PI) * eps;
  vec2 uv2 = uv + vec2((pb.z * Tb3.x - pb.x * Tb3.z) / rxz * (0.5 / PI), Tb3.y * inversesqrt(rxz) / PI) * eps;
  // the height map is 0 on all water: a tap in water would make every shore a cliff, so water taps take h0
  float h1 = mix(textureLod(uHeight, uv1, lodH).r, h0, smoothstep(0.3, 0.7, textureLod(uWater, uv1, lodH).r));
  float h2 = mix(textureLod(uHeight, uv2, lodH).r, h0, smoothstep(0.3, 0.7, textureLod(uWater, uv2, lodH).r));
  // map relief exaggerated x5 near the map's own scale (relief reads at the terminator from afar), true scale (x1.3)
  // below ~2 km footprints where the procedural terrain takes over
  vec3 gradMap = (Ta3 * (h1 - h0) + Tb3 * (h2 - h0)) * (6.4 * KM / (eps * uRp));
  vec3 gradB = gradMap * mix(1.3, 5.0, smoothstep(0.00025, 0.0012, fpU));
  // terrain classes from the map: local relief -> mountains; bright, red, low ground -> ergs (dune seas)
  float mtn = smoothstep(0.004, 0.03, length(gradMap) + 0.25 * smoothstep(0.15, 0.5, hgt));
  float sand = smoothstep(0.32, 0.5, day.r) * smoothstep(0.08, 0.2, day.r - day.b) * (1.0 - mtn) * smoothstep(0.25, 0.08, hgt);

  // ---------------- procedural detail: one fbm site (ridged mountains / hills, 9 km .. 150 m); the rest are one or two
  // baked octaves each (FXC inlines every fbm call site)
  vec3 east = normalize(vec3(-pb.z, 0.0, pb.x) + vec3(1e-5));
  vec3 wdir = normalize(east * 0.6 + cross(pb, east) * 0.8);       // dune-ridge normal (north-easterly trades)
  vec4 rn = fbmT(pb * 700.0, fpU * 700.0, det ? 6 : 0, 2.03, 0.46);
  // octave weights by footprint (features under ~2.5 px fade to the mean)
  #define OW(f) clamp(0.4 / ((f) * fpU) - 0.6, 0.0, 1.0)
  // dunes: ridges across the wind (domain compressed along the ridge normal), ~2-4 km draa
  vec3 pd = pb * 1800.0 + wdir * dot(pb, wdir) * 5400.0;
  vec4 d2 = tn(NOISE3_ROT * pd * 2.0 + 5.7);
  vec4 dn = (0.5 * OW(7200.0)) * tn(pd) + (0.25 * OW(14400.0)) * vec4(d2.x, 2.0 * (d2.yzw * NOISE3_ROT));
  // albedo texture (fields, rock / soil patches), wind roughness, calm slicks
  float anx = 0.5 * OW(1100.0) * tn(pb * 1100.0 + 3.1).x + 0.28 * OW(2420.0) * tn(NOISE3_ROT * pb * 2420.0).x;
  float wnx = 0.5 * OW(30.0) * tn(pb * 30.0 + vec3(uDays * 0.05)).x + 0.25 * OW(61.0) * tn(NOISE3_ROT * pb * 61.0 + 2.2).x;
  vec3 ps = pb * vec3(130.0, 420.0, 130.0) + vec3(0.0, uDays * 0.2, 0.0);
  float snx = 0.5 * OW(420.0) * tn(ps).x + 0.25 * OW(850.0) * tn(ps * 2.03 + 9.1).x;
  float lift = 0.0;
  if (det) {
    // ridged erosion-like relief, true slopes (mountains ~0.2 rms, hills ~0.035); dunes: ridges across the trades
    float rr = 1.0 - abs(rn.x);
    vec3 gTerr = rn.yzw * 700.0 * ((-sign(rn.x)) * 2.0 * rr * (0.20 / 1260.0 * mtn * 0.5) + 0.035 / 1260.0 * (1.0 - mtn) * (1.0 - sand));
    gTerr += 1800.0 * (dn.yzw + 3.0 * wdir * dot(wdir, dn.yzw)) * (0.05 / 19152.0) * sand;
    gradB += (gTerr - pb * dot(gTerr, pb)) * detailFade;
    lift = dn.x * 0.06 * sand + rr * 0.08 * mtn - 0.04 * mtn;
  }
  vec3 Nl = transpose(uW2B) * normalize(pb - gradB * (1.0 - water));   // land normal, world axes

  // ---------------- seasonal sea ice and snow (the Blue Marble is a July map; the film is set on its own date)
  vec4 nLo = tn(pb * 9.0), nMid = tn(pb * 31.0 + vec3(5.0, 2.0, 7.0));
  float edgeNoise = nLo.x * 2.2 + nMid.x * 0.8;
  float seaIce = max(smoothstep(uSeasonEdge.x - 1.2, uSeasonEdge.x + 1.2, latD + edgeNoise), smoothstep(-uSeasonEdge.y - 1.2, -uSeasonEdge.y + 1.2, -latD + edgeNoise)) * water;
  float floes = det && seaIce > 0.0 ? smoothstep(0.62, 0.8, abs(tn(pb * 900.0).x + 0.5 * tn(pb * 2100.0 + 4.1).x)) * detailFade : 0.0;
  float clim = tn(pb * 3.3 + vec3(2.0, 5.0, 1.0)).x * 4.0 + nMid.w * 0.9;      // colder interiors / uplands
  float snowCover = smoothstep(uSeasonEdge.z - 3.0, uSeasonEdge.z + 3.0, latD + edgeNoise * 0.8 + clim + hgt * 25.0) * (1.0 - water);
  // canopy: snow under boreal forest is hidden by the trees (albedo ~0.25 instead of ~0.85)
  float canopy = mix(1.0, 0.22, smoothstep(0.012, 0.045, day.g - day.r) * smoothstep(0.16, 0.06, dot(day, vec3(0.3, 0.59, 0.11))));

  // ---------------- albedo
  vec3 alb = day * (1.0 + (anx * 0.22 + lift) * detailFade * (1.0 - water));
  alb = mix(alb, vec3(0.70, 0.78, 0.85) * (1.0 - 0.6 * floes), seaIce * 0.92);
  alb = mix(alb, vec3(0.80, 0.83, 0.87) * (0.92 + 0.08 * tn(pb * 520.0).x * detailFade), snowCover * canopy);
  float oceanW = water * (1.0 - seaIce);

  // ---------------- surface radiance (units: white Lambertian under the Sun = 1). Esky is the sky IRRADIANCE per unit
  // sun irradiance (a Lambert surface's radiance is then albedo * E; no factor PI)
  vec3 Esky = skyIrradiance(muS);
  vec3 direct = Tsun * shadow;
  float muSl = dot(Nl, sunDir);
  // sphere terminator gates the direct light; the relief normal shades it with a little wrap (sub-pixel slopes)
  float relief = mix(max((muSl + 0.12) / 1.12, 0.0) * smoothstep(-0.02, 0.06, muS), max(muSl, 0.0), smoothstep(0.1, 0.4, muS));
  // cloud shadows dim the skylight too (half the dome is the cloud) - except at very low sun, when the ground is lit
  // mostly by the sky and shadows go blue-grey, not black
  float skySh = mix(0.5 + 0.5 * shadow, 1.0, smoothstep(0.08, 0.0, muS));
  vec3 Lg = alb * (direct * relief + Esky * (0.5 + 0.5 * dot(Nl, N)) * skySh);

  // ocean: computed water-leaving reflectance + GGX sun glint with wind roughness, calm slicks and footprint-filtered
  // wave slopes (Cox-Munk / LEAN: unresolved slopes widen the lobe) + Fresnel sky reflection
  if (oceanW > 0.0) {
    float shelf = textureGrad(uShelf, uv, gx, gy).r;
    float coastal = textureLod(uShelf, uv, 4.5).r;
    // water-leaving reflectance just above the surface (pi Rrs): clear oligotrophic gyres navy (Rrs(443) ~0.008, sRGB
    // channels ~0.0015 / 0.005 / 0.022), productive high-latitude / coastal water greener and dimmer in blue
    float prod = clamp(smoothstep(38.0, 62.0, abs(latD)) * 0.75 + coastal * 0.8 + 0.3 * tn(pb * 6.0).x - 0.1, 0.0, 1.0);
    vec3 rhoW = mix(vec3(0.0015, 0.0050, 0.0220), vec3(0.0025, 0.0085, 0.0130), prod);
    // shelves: the sea floor shows through (sand turquoise in the shallowest water)
    rhoW = mix(rhoW, mix(vec3(0.004, 0.016, 0.026), day * 0.42, smoothstep(0.9, 1.0, shelf)), smoothstep(0.6, 0.97, shelf) * (1.0 - seaIce));
    // wind roughness (Cox-Munk slope variance -> GGX alpha): calm water under the subtropical highs (low cloud cover,
    // 1-3 m/s, alpha ~0.035) gives a near-mirror core inside the broad glint; trade winds / storm tracks ~0.15-0.24.
    // Calm slicks: long wind-aligned filaments (tens of km).
    float calm = smoothstep(0.35, 0.05, R0cl) * smoothstep(8.0, 22.0, abs(latD)) * smoothstep(40.0, 28.0, abs(latD));
    float wind = clamp(wnx * 1.3 + 0.5 - 0.55 * calm, 0.0, 1.0);
    float alpha = mix(0.035, 0.24, wind * wind) * mix(1.0, 0.45, smoothstep(0.66, 0.82, snx * 0.5 + 0.5));
    // wind waves (~300 m and below) are unresolved from orbit: their slopes are the GGX lobe width (+ swell variance)
    vec3 Nw = N;
    float a2 = alpha * alpha + 0.0036;
    vec3 Hh = normalize(sunDir + V);
    float NdL = max(dot(Nw, sunDir), 0.0), NdH = max(dot(Nw, Hh), 0.0), NdVw = max(dot(Nw, V), 1e-3);
    float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, Hh), 0.0), 5.0);
    float dd = NdH * NdH * (a2 - 1.0) + 1.0;
    float spec = a2 / (PI * dd * dd) * G1(NdL, a2) * G1(NdVw, a2) * F / (4.0 * NdVw + 1e-4);
    float Fv = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
    float Fs = 0.02 + 0.98 * pow(1.0 - max(muS, 0.0), 5.0);
    // reflected sky: the sky radiance is ~ E / pi near the zenith, brighter toward the horizon
    vec3 Lsea = rhoW * (1.0 - Fv) * (1.0 - Fs) * (direct * max(muS, 0.0) + Esky * (0.5 + 0.5 * shadow))
              + spec * PI * direct + Fv * Esky * (0.32 + 0.7 * (1.0 - NdV));
    if (uDebug == 5) Lsea = vec3(spec * PI);
    Lg = mix(Lg, Lsea, oceanW);
  }
  gl_FragColor = vec4(Lg, water);
}
`;

// ------------------------------------------------------------------------------------------------ pass L: cloud light
// cloud radiance at the layer above the pixel, premultiplied by its coverage (reads pass C) -> rgb, coverage -> a
export const EARTH_CLOUDLIGHT_FRAG = /* glsl */ `
${HEAD}
#define CLOUD_TEXEL 0.00307
uniform vec4 uFlow;
float zonalRate(float lat) {
  float ld = lat * (180.0 / PI), a = abs(ld);
  float u = -6.5 * exp(-ld * ld / 420.0) + 11.0 * exp(-(a - 45.0) * (a - 45.0) / 225.0) - 3.0 * exp(-(a - 76.0) * (a - 76.0) / 100.0);
  return u * 86400.0 / (6.371e6 * max(cos(lat), 0.15));
}
void main() {
  Px x = pixel();
  if (x.cov <= 0.0) { gl_FragColor = vec4(0.0); return; }
  bool front; float tCl;
  vec3 Pc = cloudPoint(x, front, tCl);
  vec3 Nc = normalize(Pc), pbc = uW2B * Nc;
  vec3 rd = x.rd, sunDir = uSunDir, V = -rd;
  float nu = dot(rd, sunDir);
  vec4 pc = texelFetch(uPreC, ivec2(gl_FragCoord.xy), 0);
  vec2 c0 = up2(pc.x), c1 = up2(pc.y), c2 = up2(pc.z);
  float Rcl = c0.y, R0cl = c1.y, hTopC = c2.x * KM, iceDamp = up2(pc.w).y;
  float aCl = 1.0 - pow(1.0 - Rcl, 1.0 / max(max(dot(Nc, V), 0.0), 0.25));   // oblique views see more of the layer
  float mShadow = moonShadow(x.P, sunDir);
    // ---------------- cloud radiance
    vec3 Lcl = vec3(0.0);
    if (aCl > 0.002) {
      // volume: normal of the cloud-top height field (domes rising from the edges; slope from pass C)
      vec3 e1 = tangentA(pbc), e2 = cross(pbc, e1);
      vec3 Ncl = transpose(uW2B) * normalize(pbc - (e1 * c0.x + e2 * c1.x) * uDetail);
      // sunlight reaches each top at its own height: low cumulus (~1.5 km) redden and fall into shadow first at
      // sunset, tall convective tops (~8 km) stay lit and whiter for longer
      float muSc = dot(Nc, sunDir);
      float hC = mix(1.5, 7.0, smoothstep(0.35, 0.85, R0cl)) * KM + hTopC;
      vec3 TsunC = sunTrans(uRp + hC * ATMO_S, muSc) * mShadow;
      // low sun: thick, tall clouds shadow their neighbours (march the map's top-height field toward the sun)
      float selfSh = 1.0;
      vec3 sB = uW2B * sunDir;
      vec3 tS = sB - pbc * dot(sB, pbc);
      float lt = length(tS);
      if (muSc < 0.35 && muSc > -0.06 && lt > 1e-4) {
        tS /= lt;
        float tanE = dot(sB, pbc) / lt;
        const float HTOP = 9.0 * KM;
        float hh0 = Rcl * Rcl * HTOP;
        float st = 0.0016;
        float om = zonalRate(asin(clamp(pbc.y, -1.0, 1.0)));
        float dlA = -om * (uFlow.x + uFlow.y) * (0.5 / PI), dlB = -om * (uFlow.x + uFlow.z) * (0.5 / PI);
        for (int k = 0; k < uLoopMax; k++) {
          if (k >= 5) break;
          float lodq = log2(max(st / CLOUD_TEXEL, 1.0));
          vec2 uq = dirToUV(normalize(pbc + tS * st));
          float mq = mix(textureLod(uClouds, uq + vec2(dlB, 0.0), lodq).r, textureLod(uClouds, uq + vec2(dlA, 0.0), lodq).r, uFlow.w);
          mq = smoothstep(0.045, 0.9, mq) * iceDamp;
          float hray = hh0 + st * tanE * uRp + 0.5 * st * st * uRp;
          selfSh = min(selfSh, smoothstep(-0.25, 0.6, (hray - mq * mq * HTOP) / (1.2 * KM)));
          st *= 2.0;
        }
        selfSh = mix(1.0, selfSh, smoothstep(0.35, 0.15, muSc));
      }
      // Cloud BRDF = multiple scattering (soft-cosine Lambert on the bumpy tops, with the thick-cloud backscatter
      // anisotropy: reflectance factor ~1.15 toward the antisolar point, MODIS/CERES angular models) + single
      // scattering with a two-lobe HG water-cloud phase function in Lommel-Seeliger form (bright high-phase clouds)
      float sunLit = smoothstep(-0.02, 0.05, muSc + 0.06) * (0.25 + 0.75 * selfSh);
      float ndl = dot(Ncl, sunDir);
      // (unresolved turrets and anvil edges, rms slope ~0.3, intercept the grazing sun broadside: tops along the
      // terminator glow orange-pink well after the flat layer would have gone dark, as in every ISS terminator photograph)
      float softMu = 0.5 * (ndl + sqrt(ndl * ndl + 0.08));
      float lam = (mix(0.5 * (muSc + sqrt(muSc * muSc + 0.08)), softMu, 0.72) + max(ndl - max(muSc, 0.0), 0.0) * 0.3) * sunLit;
      float back = 1.0 + 0.3 * pow(max(-nu, 0.0), 4.0) * smoothstep(0.5, 0.9, Rcl);
      float muVc2 = max(dot(Ncl, V), 0.03);
      float hgP = 0.72 * 0.0904 / pow(1.6724 - 1.64 * nu, 1.5) + 0.28 * 0.9375 / pow(1.0625 + 0.5 * nu, 1.5);   // g 0.82 / -0.25
      float ss = min(hgP, 9.0) * softMu / (4.0 * (softMu + muVc2)) * sunLit * min(1.0, Rcl * 1.6);
      float fwd = pow(max(nu, 0.0), 12.0) * (1.0 - Rcl) * 0.8;     // silver lining through thin cloud toward the sun
      // skylight on a top: only the sky ABOVE it, and only the part its tilted top sees
      vec3 EskyC = skyIrradiance(muSc) * exp(-hC / HR) * (0.6 + 0.4 * dot(Ncl, Nc));
      Lcl = (TsunC * ((lam * back + fwd) * Rcl + ss) + EskyC * Rcl) / max(aCl, 1e-3);
    }

  gl_FragColor = vec4(Lcl * aCl, aCl);
}
`;

// ------------------------------------------------------------------------------------------------ pass Q: city lights
// city lights on the ground (rgb, dimmed over water) and their diffuse glow on the cloud undersides (a); night side
// only, off by civil twilight. Reads G (water); written into C's target once G and L have consumed it.
export const EARTH_CITY_FRAG = /* glsl */ `
${HEAD}
${CITYLIGHTS_GLSL}
void main() {
  Px x = pixel();
  vec2 uv = dirToUV(x.pb);
  vec2 gx = dFdx(uv), gy = dFdy(uv);
  gx.x -= floor(gx.x + 0.5); gy.x -= floor(gy.x + 0.5);
  // pixel footprint covariance in the tangent plane
  Footprint fpc;
  fpc.e1 = tangentA(x.pb);
  fpc.e2 = cross(x.pb, fpc.e1);
  vec3 dx = dFdx(x.pb), dy = dFdy(x.pb);
  vec2 ax = vec2(dot(dx, fpc.e1), dot(dx, fpc.e2)), ay = vec2(dot(dy, fpc.e1), dot(dy, fpc.e2));
  fpc.C = 0.33 * vec3(ax.x * ax.x + ay.x * ay.x, ax.x * ax.y + ay.x * ay.y, ax.y * ax.y + ay.y * ay.y);
  float nightF = smoothstep(-0.015, -0.11, dot(x.N, uSunDir));
  if (x.cov <= 0.0 || nightF <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float water = texelFetch(uPreG, ivec2(gl_FragCoord.xy), 0).a;
  float nightTex = textureGrad(uNight, uv, gx, gy).r;
  float nlt = nightTex * sqrt(nightTex);            // the Black Marble is stretched: ~1.5 restores the range
  float coreK = smoothstep(0.5, 1.0, nightTex);
  nlt *= 0.6 + 2.6 * coreK * coreK;                 // urban cores 5-10x their suburbs
  float nltBlur = textureLod(uNight, uv, 4.5).r;
  gl_FragColor = vec4(cityLights(x.pb, nlt * 0.28, nightTex, fpc) * nightF * (1.0 - water * 0.9), nltBlur * nltBlur * 0.06 * nightF);
}
`;

// ------------------------------------------------------------------------------------------------ pass A: radiance
export const EARTH_RADIANCE_FRAG = /* glsl */ `
${HEAD}
void main() {
  vec2 tglow = raySphere(-uCenterW, normalize(vPosW), uRp + 290.0 * KM);
  if (tglow.x > tglow.y || tglow.y <= 0.0) discard;
  Px x = pixel();
  vec3 rd = x.rd, ro = x.ro, sunDir = uSunDir;
  float cov = x.cov, b = x.b;
  bool front; float tCl;
  vec3 Pc = cloudPoint(x, front, tCl);
  vec3 Nc = normalize(Pc), pbc = uW2B * Nc;
  float nu = dot(rd, sunDir);
  float pR = phaseRayleigh(nu), pM = phaseMie(nu), pJ = phaseStrat(nu);
  float t0 = max(x.ta.x, 0.0);

  // ===================================================================== atmosphere: one march, three segments
  // A [t0, tSplit] camera -> cloud layer, B [tSplit, tG] cloud layer -> ground (or the tangent point of a miss),
  // C [tC, tEnd] tangent point -> far side of the limb chord (pixels with sky in them only). Sample spacing is
  // quadratic toward the densest air (the ground / the tangent point).
  float tG = x.hit ? x.tHit : max(-b, t0);
  float tSplit = clamp(tCl, t0, tG);
  float tC = max(tG, -b);
  float tEnd = max(x.ta.y, tC);
  vec3 La = vec3(0.0), Ta = vec3(1.0), Lb = vec3(0.0), Tb = vec3(1.0), Lc = vec3(0.0), Tc = vec3(1.0);
  {
    const int NA = 18, NB = 6;
    int NC = cov < 1.0 ? 14 : 0;
    for (int i = 0; i < uLoopMax; i++) {
      if (i >= NA + NB + NC) break;
      int sg = i < NA ? 0 : (i < NA + NB ? 1 : 2);
      float sa = sg == 0 ? t0 : (sg == 1 ? tSplit : tC);
      float len = max((sg == 0 ? tSplit : (sg == 1 ? tG : tEnd)) - sa, 0.0);
      float fn = float(sg == 0 ? NA : (sg == 1 ? NB : NC));
      float j = float(i - (sg == 0 ? 0 : (sg == 1 ? NA : NA + NB)));
      vec2 s = vec2(j, j + 1.0) / fn;
      vec2 xs = sg < 2 ? 1.0 - (1.0 - s) * (1.0 - s) : s * s;
      float dt = (xs.y - xs.x) * len;
      vec3 p = ro + rd * (sa + 0.5 * (xs.x + xs.y) * len);
      float r = length(p);
      float h = max(r - uRp, 0.0);
      float dR = exp(-h / HR);
      float hj = (h - H_J) / W_J;
      float dMb = exp(-h / HM), dMj = K_J * exp(-hj * hj);
      vec3 sR = BETA_R * dR;
      vec3 ext = sR + BETA_ME * (dMb + dMj) + BETA_O * max(0.0, 1.0 - abs(h - H_O) / W_O);
      float muS = dot(p, sunDir) / r;
      vec3 S = (sR * pR + BETA_MS * (dMb * pM + dMj * pJ)) * sunTrans(r, muS) + (sR + BETA_MS * (dMb + dMj)) * msLUT(r, muS);
      vec3 e = exp(-ext * dt);
      vec3 dL = S * (1.0 - e) / max(ext, vec3(1e-7));
      if (sg == 0) { La += Ta * dL; Ta *= e; }
      else if (sg == 1) { Lb += Tb * dL; Tb *= e; }
      else { Lc += Tc * dL; Tc *= e; }
    }
  }
  vec3 outL = vec3(0.0);

  // ===================================================================== the solid-planet part of the pixel
  if (cov > 0.0) {
    ivec2 ip = ivec2(gl_FragCoord.xy);
    vec4 Lp = texelFetch(uPreS, ip, 0);           // pass L: cloud radiance x coverage, coverage
    vec4 Gp = texelFetch(uPreG, ip, 0);
    float aCl = Lp.a;
    vec4 Qp = texelFetch(uPreC, ip, 0);           // pass Q: city lights on the ground (rgb), glow under the clouds (a)
    vec3 Lg = Gp.rgb + Qp.rgb;
    vec3 cityDiff = vec3(1.0, 0.6, 0.3) * Qp.a;

    // ---------------- composite: above-cloud air, cloud, below-cloud air, ground
    vec3 Lsurf = La * PI + Ta * (Lp.rgb + cityDiff * aCl + (1.0 - aCl) * (Lb * PI + Tb * Lg));
    if (uDebug == 1) Lsurf = La * PI + Ta * Lb * PI;
    if (uDebug == 2) Lsurf = Lg;
    if (uDebug == 3) Lsurf = Lp.rgb;
    outL += cov * Lsurf;
  }

  // ===================================================================== the sky (limb) part of the pixel
  if (cov < 1.0) {
    vec3 Lsky = (La + Ta * (Lb + Tb * Lc)) * PI;
    // airglow: OI 557.7 nm green ~97 km, Na 589 nm orange ~89 km, faint broad OI 630 nm red ~210 km, each integrated
    // analytically along the line of sight (Abel transform of a Gaussian shell, fitted): crisp at any distance
    vec3 pt = x.hit ? ro + rd * max(tglow.x, 0.0) : x.qv;
    float dark = smoothstep(0.08, -0.15, dot(normalize(pt), sunDir)) * uAirglow;
    if (dark > 0.0) {
      // gravity-wave banding along the limb, fixed to the planet
      vec3 pg = uW2B * normalize(pt);
      float band = 1.0 + 0.45 * tn(pg * vec3(14.0, 40.0, 14.0)).x + 0.2 * tn(pg * 55.0 + 3.1).x;
      vec3 E = vec3(0.0);
      for (int k = 0; k < uLoopMax; k++) {
        if (k >= 3) break;
        float hk = k == 0 ? 97.0 : (k == 1 ? 89.0 : 210.0);
        float sk = k == 0 ? 6.0 : (k == 1 ? 3.5 : 40.0);
        vec3 ck = k == 0 ? vec3(0.25, 1.0, 0.40) : (k == 1 ? vec3(0.28, 0.154, 0.0336) : vec3(0.0875, 0.0105, 0.007));
        float xx = (x.dq - (uRp + hk * KM)) / (sk * KM);
        float F = xx <= 0.0 ? 2.5066 / sqrt(0.675 - xx) * exp(0.3 * xx) : 3.05 * exp(-1.1 * xx - 0.25 * xx * xx);
        E += ck * (F / 3.05) * (x.hit ? 0.5 : 1.0);
      }
      Lsky += E * band * dark;
    }
    outL += (1.0 - cov) * Lsky;
  }
  gl_FragColor = vec4(outL, 1.0);
}
`;
