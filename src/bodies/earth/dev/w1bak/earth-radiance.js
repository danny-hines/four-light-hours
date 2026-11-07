// Earth "radiance" pass (additive): surface + clouds + city lights + aerial perspective + limb scattering + airglow.
import { NOISE_GLSL } from '../../glsl/noise.js';
import { NOISE_D_GLSL } from './noise-d.js';
import { EARTH_COMMON } from './earth-glsl.js';
import { CLOUDS_GLSL } from './clouds-glsl.js';
import { CITYLIGHTS_GLSL } from './citylights-glsl.js';

export const EARTH_RADIANCE_FRAG = /* glsl */ `
${EARTH_COMMON}
${NOISE_GLSL}
${NOISE_D_GLSL}
uniform vec3 uCenterW;
uniform vec3 uSunDir;          // planet centre -> Sun (world axes, unit)
uniform mat3 uW2B;             // world axes -> body-fixed (rotating) frame
uniform vec3 uMoonRel;         // Moon centre relative to Earth centre (world)
uniform float uMoonR;
uniform float uSunAngR;        // angular radius of the Sun seen from Earth
uniform float uDays;           // simulated days since the film epoch (cloud advection)
uniform float uSeason;         // day of year (0..365) for sea-ice / snow extent
uniform float uRc;             // cloud layer radius
uniform float uAirglow;        // airglow emission scale
uniform float uDetail;         // quality: 0 = low .. 1 = high
uniform int uDebug;
uniform sampler2D uDay;
uniform sampler2D uNight;
uniform sampler2D uClouds;
uniform sampler2D uHeight;
uniform sampler2D uWater;
uniform sampler2D uShelf;          // continental-shelf depth: 1 at the shore .. 0 below 200 m
varying vec3 vPosW;

#define DAY_TEXEL 0.00153      // 2 pi / 4096

vec2 dirToUV(vec3 d) {
  float lon = atan(-d.z, d.x);
  float lat = asin(clamp(d.y, -1.0, 1.0));
  return vec2(lon * (0.5 / PI) + 0.5, lat / PI + 0.5);
}
vec4 wrapGrad(vec2 dx, vec2 dy) {
  dx.x -= floor(dx.x + 0.5);
  dy.x -= floor(dy.x + 0.5);
  return vec4(dx, dy);
}
vec3 tangentA(vec3 n) { return normalize(cross(abs(n.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), n)); }

// Worley F1 / F2 with the vectors from the two nearest feature points (for analytic gradients), plus a smooth
// Gaussian blob field B = sum exp(-d^2 / 2 sigma^2), sigma 0.3 cell, over the same points (returned with its gradient
// in blob). Exact: full 3x3x3 neighbourhood (a 2x2x2 search misses nearer points in outer cells and cuts straight
// seams through the field). The blob field has no creases (1 - F1 has a V-shaped valley along every cell border,
// which thresholds into a crack network) and is positively skewed (1.08): separate rounded clusters.
// Uniform loop bound so the compiled shader holds one copy.
vec2 worleyD(vec3 p, out vec3 r1, out vec3 r2, out vec4 blob) {
  vec3 i = floor(p), f = p - i;
  float d1 = 8.0, d2 = 8.0;
  r1 = vec3(1.0); r2 = vec3(1.0);
  blob = vec4(0.0);
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 27) break;
    vec3 g = vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec3 h = hash33(i + g);
    vec3 r = f - g - h;                          // feature point -> p
    float d = dot(r, r);
    // irregular clusters: 30 % of the cells empty, random size and strength (a jittered lattice of equal blobs
    // thresholds into a regular net); stats measured in dev/blobstat2.mjs: mean 0.2872, std 0.3071, skew 1.8
    float v = fract(h.x * 7.13 + h.y * 3.71 + h.z * 1.93), u = fract(h.x * 2.31 + h.z * 5.17);
    float amp = v < 0.3 ? 0.0 : 0.35 + 1.3 * u * u;
    float sg = 0.2 + 0.18 * u;
    float ik = 0.5 / (sg * sg);
    float wb = amp * exp(-ik * d);
    blob += wb * vec4(1.0, -2.0 * ik * r);
    if (d < d1) { d2 = d1; r2 = r1; d1 = d; r1 = r; } else if (d < d2) { d2 = d; r2 = r; }
  }
  return sqrt(vec2(d1, d2));
}
${CLOUDS_GLSL}
${CITYLIGHTS_GLSL}

// fraction of the solar disc visible past the Moon (solar-eclipse shadow) from point p (planet-centred)
float moonShadow(vec3 p, vec3 sunDir) {
  vec3 toM = uMoonRel - p;
  float dM = length(toM);
  float angM = asin(clamp(uMoonR / dM, 0.0, 1.0));
  vec3 c = cross(toM / dM, sunDir);
  float sep = atan(length(c), dot(toM / dM, sunDir));
  float rs = uSunAngR;
  if (sep >= rs + angM) return 1.0;
  float ov = clamp((rs + angM - sep) / (2.0 * min(rs, angM)), 0.0, 1.0);
  float frac = min(1.0, (angM * angM) / (rs * rs));
  return 1.0 - smoothstep(0.0, 1.0, ov) * frac;
}

// GGX / Smith
float D_GGX(float NdH, float a) { float a2 = a * a; float d = NdH * NdH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float G1(float NdX, float a) { float a2 = a * a; return 2.0 * NdX / (NdX + sqrt(a2 + (1.0 - a2) * NdX * NdX)); }

void main() {
  vec3 rd = normalize(vPosW);
  vec3 ro = -uCenterW;
  vec3 sunDir = uSunDir;
  vec2 ta = raySphere(ro, rd, uRt);
  vec2 tglow = raySphere(ro, rd, uRp + 290.0 * KM);
  if (tglow.x > tglow.y || tglow.y <= 0.0) discard;

  float b = dot(ro, rd);
  vec3 qv = ro - b * rd;
  float dq = length(qv);
  float cov = (b < 0.0) ? clamp((uRp - dq) / max(fwidth(dq), 1e-9) + 0.5, 0.0, 1.0) : 0.0;
  vec2 tg = raySphere(ro, rd, uRp);
  bool hit = tg.x <= tg.y && tg.y > 0.0;
  float tHit = hit ? tg.x : max(-b, 0.0);
  // ground point (for edge pixels that just miss: the tangent point projected onto the sphere)
  vec3 P = hit ? ro + rd * tHit : normalize(qv) * uRp;
  vec3 N = normalize(P);
  vec3 pb = uW2B * N;
  vec2 uv = dirToUV(pb);
  vec4 g = wrapGrad(dFdx(uv), dFdy(uv));
  // pixel footprint covariance in the tangent plane (city lights): box pixel variance 1/12 per axis, x ~4 so a
  // point is never narrower than ~1 px
  Footprint fpc;
  {
    fpc.e1 = tangentA(pb);
    fpc.e2 = cross(pb, fpc.e1);
    vec3 dx = dFdx(pb), dy = dFdy(pb);
    vec2 ax = vec2(dot(dx, fpc.e1), dot(dx, fpc.e2)), ay = vec2(dot(dy, fpc.e1), dot(dy, fpc.e2));
    fpc.C = 0.33 * vec3(ax.x * ax.x + ay.x * ay.x, ax.x * ax.y + ay.x * ay.y, ax.y * ax.y + ay.y * ay.y);
  }
  // cloud layer: first intersection from outside, else straight above the ground point
  vec2 tcS = raySphere(ro, rd, uRc);
  bool cloudFront = tcS.x > 0.0 && tcS.x < tHit;
  float tCl = cloudFront ? tcS.x : tHit;
  vec3 Pc = cloudFront ? ro + rd * tCl : N * uRc;
  vec3 Nc = normalize(Pc);
  vec3 pbc = uW2B * Nc;
  vec2 uvc = dirToUV(pbc);
  vec4 gc = wrapGrad(dFdx(uvc), dFdy(uvc));
  float fpU = max(length(fwidth(P)), 1e-7) / uRp;            // pixel footprint on the unit sphere
  // cloud footprint: oblique views have a long, thin pixel footprint; the max axis blurred the whole layer into streaks
  // near the horizon, the min axis would alias along the long one - use the geometric mean, bounded below by 0.4 x max
  float fpC;
  {
    float ax = length(dFdx(Pc)), ay = length(dFdy(Pc));
    fpC = max(max(1.25 * sqrt(ax * ay), 0.4 * max(ax, ay)), 1e-7) / uRp;
  }

  float nu = dot(rd, sunDir);
  float pR = phaseRayleigh(nu), pM = phaseMie(nu), pJ = phaseStrat(nu);
  vec3 outL = vec3(0.0);
  float t0 = max(ta.x, 0.0);
  float detailFade = smoothstep(DAY_TEXEL * 2.5, DAY_TEXEL * 0.5, fpU) * uDetail;

  // ===================================================================== the solid-planet part of the pixel
  if (cov > 0.0) {
    vec3 Lup = vec3(0.0), Tup = vec3(1.0), Llo = vec3(0.0), Tlo = vec3(1.0);
    float tSplit = clamp(tCl, t0, tHit);
    marchSegment(ro, rd, t0, tSplit, true, 18, sunDir, pR, pM, pJ, Lup, Tup);
    marchSegment(ro, rd, tSplit, tHit, true, 6, sunDir, pR, pM, pJ, Llo, Tlo);

    float muS = dot(N, sunDir);
    vec3 Tsun = sunTrans(uRp + 2e-5, muS) * moonShadow(P, sunDir);
    vec3 V = -rd;
    float NdV = max(dot(N, V), 1e-3);

    // ---------------- textures
    // sub-texel detail: once a Blue Marble texel (~10 km) spans several pixels, the lookup is displaced by a fractal
    // field of up to ~0.6 texel, so the map's own edges (coasts, field boundaries, river valleys, dune seas) continue
    // as crisp fractal shapes below its resolution instead of bilinear blur
    vec2 uvD = uv;
    {
      float jw = smoothstep(DAY_TEXEL * 0.8, DAY_TEXEL * 0.25, fpU) * uDetail;
      if (jw > 0.0) {
        // (displacement <= ~0.1 of each octave's wavelength: more reads as a wobbly shower-glass refraction)
        vec3 a1 = pb * 2600.0, a2 = pb * 7800.0;
        vec2 j = 0.35 * vec2(snoise(a1), snoise(a1 + vec3(17.3, 5.1, 9.7))) + 0.17 * vec2(snoise(a2), snoise(a2 + vec3(3.3, 8.8, 1.2)));
        float clat = max(sqrt(1.0 - pb.y * pb.y), 0.05);
        uvD += j * jw * vec2(1.0 / (4096.0 * clat), 1.0 / 2048.0);
      }
    }
    vec3 day = textureGrad(uDay, uvD, g.xy, g.zw).rgb;
    float wm = textureGrad(uWater, uvD, g.xy, g.zw).r;
    float hgt = textureGrad(uHeight, uv, g.xy, g.zw).r;
    float nightTex = textureGrad(uNight, uv, g.xy, g.zw).r;
    float latD = asin(clamp(pb.y, -1.0, 1.0)) * (180.0 / PI);

    // water: Natural Earth mask, sharpened by the colour of the Blue Marble pixel (open water is blue-dominant)
    float blueness = day.b - max(day.r, day.g);
    float water = smoothstep(0.3, 0.7, wm) * smoothstep(-0.004, 0.012, blueness + 0.01 * smoothstep(0.6, 1.0, wm));

    // ---------------- relief from the height map (3 taps along tangent axes; well defined at the poles)
    vec3 Ta = tangentA(pb);
    vec3 Tb = cross(pb, Ta);
    float eps = max(0.0032, fpU * 1.5);
    float lodH = log2(max(eps / 0.0031, 1.0));
    float h0 = textureLod(uHeight, uv, lodH).r;
    vec2 uv1 = dirToUV(normalize(pb + Ta * eps)), uv2 = dirToUV(normalize(pb + Tb * eps));
    float h1 = textureLod(uHeight, uv1, lodH).r;
    float h2 = textureLod(uHeight, uv2, lodH).r;
    // the height map is 0 on all water (lakes included): a tap that lands in water would make the shore a cliff
    // (a dark/bright outline around every coast and lake), so water taps take the centre height
    h1 = mix(h1, h0, smoothstep(0.3, 0.7, textureLod(uWater, uv1, lodH).r));
    h2 = mix(h2, h0, smoothstep(0.3, 0.7, textureLod(uWater, uv2, lodH).r));
    // resolved map relief: exaggerated x5 when the map texel is near the pixel scale (so relief reads at the
    // terminator from afar), true scale (x1.3) once the footprint is below ~2 km - where the procedural terrain below
    // takes over and the exaggeration would turn every hill into a cliff
    float exag = mix(1.3, 5.0, smoothstep(0.00025, 0.0012, fpU));
    float RELIEF = 6.4 * KM * exag;
    vec3 gradMap = (Ta * (h1 - h0) + Tb * (h2 - h0)) * (6.4 * KM / (eps * uRp));   // true-scale map slope
    vec3 gradB = gradMap * exag;
    // procedural terrain below the map scale, by terrain class (true slopes: plains ~0.01, hills ~0.05, mountains
    // ~0.15-0.25 rms; spectrum with slope amplitude falling ~10% per octave). Classes from the map itself: local
    // relief (map slope) -> mountains; bright, red, low sandy ground -> ergs with wind-aligned dune ridges.
    float mapSlope = length(gradMap);
    float mtn = smoothstep(0.004, 0.03, mapSlope + 0.25 * smoothstep(0.15, 0.5, hgt));
    float sand = smoothstep(0.32, 0.5, day.r) * smoothstep(0.08, 0.2, day.r - day.b) * (1.0 - mtn) * smoothstep(0.25, 0.08, hgt);
    float lift = 0.0;              // albedo modulation from the terrain (ridges catch light-coloured debris)
    if (detailFade > 0.0) {
      // mountains: ridged erosion-like relief, 9 km .. 150 m
      vec4 rn = fbmd2(pb * 700.0, fpU * 700.0, 6, 2.0, 0.46, 1.0);
      float rr = 1.0 - abs(rn.x);
      vec3 gr = rn.yzw * 700.0 * (-sign(rn.x)) * 2.0 * rr;            // gradient of rr^2
      vec3 grLow = rn.yzw * 700.0;
      gr -= pb * dot(gr, pb);
      grLow -= pb * dot(grLow, pb);
      // slope scale: |grad fbm| ~ 700 * 0.5 * 1.9 * 1.9 per unit amplitude; target rms slopes per class
      float kM = 0.20 / 1260.0, kH = 0.035 / 1260.0;
      vec3 gTerr = gr * (kM * mtn * 0.5) + grLow * (kH * (1.0 - mtn) * (1.0 - sand));
      // dunes: linear ridges across the (north-easterly) trade wind, ~2-4 km draa, faint slopes
      if (sand > 0.0) {
        vec3 east = normalize(vec3(-pb.z, 0.0, pb.x) + vec3(1e-5));
        vec3 north = cross(pb, east);
        vec3 wdir = normalize(east * 0.6 + north * 0.8);                 // ridge-normal direction
        vec3 pd = pb * 1800.0 + wdir * dot(pb, wdir) * 3.0 * 1800.0;      // compress along the wind => ridges across it
        vec4 dn = fbmd2(pd, fpU * 1800.0 * 4.0, 3, 2.0, 0.5, 1.0);
        vec3 gd = 1800.0 * (dn.yzw + 3.0 * wdir * dot(wdir, dn.yzw));    // chain rule through the stretch
        gd -= pb * dot(gd, pb);
        gTerr += gd * (0.05 / (1800.0 * 0.5 * 1.9 * 4.0 * 1.4)) * sand;
        lift += dn.x * 0.06 * sand;
      }
      gradB += gTerr * detailFade;
      lift += rr * 0.08 * mtn - 0.04 * mtn;
    }
    vec3 nB = normalize(pb - gradB * (1.0 - water));
    vec3 Nl = transpose(uW2B) * nB;          // land normal, world axes

    // ---------------- seasonal sea ice and snow (the Blue Marble is a July map; the film is set on its own date)
    float seasonA = cos(2.0 * PI * (uSeason - 255.0) / 365.25);
    float seasonS = cos(2.0 * PI * (uSeason - 263.0) / 365.25);
    float iceN = 72.5 + 5.5 * seasonA;                 // Arctic ice edge latitude (78N Sept .. 67N Mar)
    float iceS = -66.0 + 5.0 * seasonS;                // Antarctic ice edge (61S Sept .. 71S Feb)
    float edgeNoise = snoise(pb * 9.0) * 2.2 + snoise(pb * 31.0) * 0.8;
    float seaIce = max(smoothstep(iceN - 1.2, iceN + 1.2, latD + edgeNoise), smoothstep(-iceS - 1.2, -iceS + 1.2, -latD + edgeNoise));
    seaIce *= water;
    float floes = 0.0;
    if (detailFade > 0.0 && seaIce > 0.0) floes = smoothstep(0.62, 0.8, abs(snoise(pb * 900.0) + 0.5 * snoise(pb * 2100.0))) * detailFade;
    float snowN = 58.0 - 17.0 * cos(2.0 * PI * (uSeason - 20.0) / 365.25); // NH snow edge (41N Jan .. 75N Jul)
    // snow line feathered by a large-scale "climatology" field (continental interiors and uplands colder, coasts warmer)
    float clim = snoise(pb * 3.3 + vec3(2.0, 5.0, 1.0)) * 4.0 + snoise(pb * 11.0) * 1.6;
    float snowCover = smoothstep(snowN - 3.0, snowN + 3.0, latD + edgeNoise * 0.8 + clim + hgt * 25.0) * (1.0 - water);
    // canopy: snow under boreal forest is hidden by the trees (albedo ~0.25-0.35 instead of ~0.85). The Blue Marble's
    // dark green (forest) vs light brown / grey-green (tundra, bog, open ground) carries the dendritic river / lake /
    // forest pattern straight into the winter landscape
    float lumD = dot(day, vec3(0.3, 0.59, 0.11));
    float forest = smoothstep(0.012, 0.045, day.g - day.r) * smoothstep(0.16, 0.06, lumD);
    float canopy = mix(1.0, 0.22, forest);

    // ---------------- albedo
    vec3 alb = day;
    if (detailFade > 0.0) {
      float dn = fbmd(pb * 1100.0 + vec3(3.1), fpU * 1100.0, 4, 2.2, 0.55).x;
      alb *= 1.0 + (dn * 0.22 + lift) * detailFade * (1.0 - water);
    }
    alb = mix(alb, vec3(0.70, 0.78, 0.85) * (1.0 - 0.6 * floes), seaIce * 0.92);
    // fresh snow on open ground ~0.85 (sub-texel albedo noise: drifts, wind-scoured patches), sunlit relief brighter
    vec3 snowAlb = vec3(0.80, 0.83, 0.87) * (0.92 + 0.08 * snoise(pb * 520.0) * detailFade);
    alb = mix(alb, snowAlb, snowCover * canopy);
    float oceanW = water * (1.0 - seaIce);

    // ---------------- cloud layer
    int oct = int(mix(3.0, 8.0, uDetail));
    // the layer above this pixel (k = 0) and where the sun ray from the ground crosses it (k = 1, cloud shadow);
    // one loop so the (large) cloud code is compiled once
    vec3 cgrad = vec3(0.0);
    float R0cl = 0.0, Rcl = 0.0, dsh = 0.0, hTopC = 0.0;
    {
      vec2 ts = raySphere(P, sunDir, uRc);
      vec3 pbs = uW2B * normalize(P + sunDir * max(ts.y, 0.0));
      for (int k = 0; k < uLoopMax; k++) {
        if (k >= 2) break;
        vec3 pk = k == 0 ? pbc : pbs;
        vec3 gk; float r0k, hk;
        // the shadow is the same field (same threshold statistics) at a wider footprint: soft-edged like real cloud
        // shadows lit by the whole sky, and never darker than the layer it comes from
        float rk = cloudField(pk, k == 0 ? uvc : dirToUV(pbs), gc, k == 0 ? fpC : max(fpC * 2.0, 0.00025), oct, water, gk, r0k, hk);
        // (the shadow never exceeds ~1.6 x the mean layer reflectance there: no orphan shadows on clear water)
        if (k == 0) { Rcl = rk; cgrad = gk; R0cl = r0k; hTopC = hk; } else dsh = min(rk, 1.6 * r0k);
      }
    }
    // the source map's polar areas are thermal IR: the ice sheets show up as "cloud"; damp them
    float iceSheet = smoothstep(-62.0, -70.0, latD) * (1.0 - water) + smoothstep(0.55, 0.75, dot(day, vec3(0.333))) * (1.0 - water) * smoothstep(55.0, 65.0, abs(latD));
    float iceDamp = 1.0 - 0.6 * clamp(iceSheet, 0.0, 1.0);
    Rcl *= iceDamp;
    float muVc = max(dot(Nc, -rd), 0.0);
    float aCl = 1.0 - pow(1.0 - Rcl, 1.0 / max(muVc, 0.25));   // oblique views see more of the layer

    // cloud shadow on the ground: sample the layer where the sun ray from P crosses it
    // diffuse transmission of a conservative-scattering layer ~ 1 - R (the direct beam is mostly blocked)
    float shadow = 1.0 - dsh * iceDamp * 0.9;

    // ---------------- surface radiance (units: white Lambertian under the Sun = 1)
    float muSl = dot(Nl, sunDir);
    // the LUT holds sky IRRADIANCE per unit sun irradiance; a Lambert surface's radiance in contract units is then
    // albedo * E (the factor PI applies to radiances only - multiplying here made skylight 3.14x too strong and
    // washed the terminator and every shadow blue-grey)
    vec3 Esky = skyIrradiance(muS);
    vec3 direct = Tsun * shadow;
    // the geometric (sphere) terminator gates the direct light; the relief normal shades it with a little wrap
    // (unresolved sub-pixel slopes and multiple scattering soften the facets), no hard self-shadow
    float wrapL = 0.12;
    float relief = max((muSl + wrapL) / (1.0 + wrapL), 0.0) * smoothstep(-0.02, 0.06, muS);
    relief = mix(relief, max(muSl, 0.0), smoothstep(0.1, 0.4, muS));   // high sun: plain Lambert
    // skylight on a tilted facet: the sky dome visible to it ~ (1 + n.up) / 2
    float skyView = 0.5 + 0.5 * dot(Nl, N);
    vec3 Lland = alb * (direct * relief + Esky * skyView * (0.5 + 0.5 * shadow));

    // ocean: computed water-leaving reflectance (the Blue Marble's bathymetry-shaded ocean shows ridges as light
    // lines and is far too light) + GGX sun glint with wind roughness, calm slicks and footprint-filtered swell
    // (LEAN-style: unresolved wave slopes widen the lobe) + Fresnel sky reflection
    vec3 Lsea = vec3(0.0);
    if (oceanW > 0.0) {
      float shelf = textureGrad(uShelf, uv, g.xy, g.zw).r;            // 1 at the shore .. 0 deeper than 200 m
      float coastal = textureLod(uShelf, uv, 4.5).r;
      // deep water: oligotrophic gyres navy, productive high-latitude / coastal water greener and darker in blue
      float prod = clamp(smoothstep(38.0, 62.0, abs(latD)) * 0.75 + coastal * 0.8 + 0.3 * snoise(pb * 6.0) - 0.1, 0.0, 1.0);
      vec3 rhoW = mix(vec3(0.0030, 0.0105, 0.0330), vec3(0.0042, 0.0140, 0.0210), prod);
      // shelves: the sea floor shows through (sand turquoise in the shallowest water, from the Blue Marble colour)
      float bottom = smoothstep(0.6, 0.97, shelf) * (1.0 - seaIce);
      vec3 rhoShallow = mix(vec3(0.006, 0.021, 0.032), day * 0.42, smoothstep(0.9, 1.0, shelf));
      rhoW = mix(rhoW, rhoShallow, bottom);
      // wind roughness (Cox-Munk: alpha ~ 0.1 at 2 m/s .. 0.22 at 12 m/s) and wind-aligned calm slicks
      float wind = fbmd(pb * 30.0 + vec3(uDays * 0.05), fpU * 30.0, 4, 2.0, 0.5).x * 0.6 + 0.5;
      // calm slicks: long filaments (tens of km, along the wind), only the two largest octaves - finer octaves broke
      // them into a sprinkling of bright / dark dashes all over the glint
      vec3 ps = pb * vec3(130.0, 420.0, 130.0) + vec3(0.0, uDays * 0.2, 0.0);
      float slick = smoothstep(0.66, 0.82, fbmd(ps, fpU * 420.0, 2, 2.0, 0.5).x * 0.5 + 0.5);
      float alpha = mix(0.085, 0.22, clamp(wind, 0.0, 1.0)) * mix(1.0, 0.32, slick);
      // wind waves: real wave slopes live at wavelengths of ~300 m and below (swell is long but gentle); they are only
      // resolved from a few tens of km up, and otherwise enter the GGX lobe as slope variance (Cox-Munk / LEAN).
      // Resolving km-scale "waves" from orbit made a hammered-metal pattern around the glint.
      vec3 Nw = N;
      float a2 = alpha * alpha;
      {
        const float FW = 24000.0;                                      // ~270 m lattice
        float wRes = smoothstep(1.6, 0.5, fpU * FW);                  // fraction of the wave slope resolved
        if (wRes > 0.0) {
          vec4 sw = fbmd2(pb * FW + vec3(uDays * 2400.0, 0.0, uDays * 900.0), fpU * FW, 4, 2.3, 0.55, 1.0);
          vec3 gs = sw.yzw * FW * (0.06 / (FW * 0.5 * 1.9 * 1.6));    // ~0.06 rms slope
          gs -= pb * dot(gs, pb);
          Nw = normalize(N - transpose(uW2B) * gs * wRes);
        }
        a2 += 0.0036 * (1.0 - wRes * wRes);
      }
      float al = sqrt(a2);
      vec3 H = normalize(sunDir + V);
      float NdL = max(dot(Nw, sunDir), 0.0);
      float NdH = max(dot(Nw, H), 0.0);
      float VdH = max(dot(V, H), 0.0);
      float NdVw = max(dot(Nw, V), 1e-3);
      float F = 0.02 + 0.98 * pow(1.0 - VdH, 5.0);
      float spec = D_GGX(NdH, al) * G1(NdL, al) * G1(NdVw, al) * F / (4.0 * NdVw + 1e-4);
      float Fv = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
      float Fs = 0.02 + 0.98 * pow(1.0 - max(muS, 0.0), 5.0);
      vec3 skyRad = Esky * (0.25 + 0.9 * (1.0 - NdV));                // reflected sky: the horizon sky is brighter
      if (uDebug == 5) { gl_FragColor = vec4(vec3(spec * PI), 1.0); return; }
      if (uDebug == 6) { gl_FragColor = vec4(rhoW * 20.0, 1.0); return; }
      Lsea = rhoW * (1.0 - Fv) * (1.0 - Fs) * (direct * max(muS, 0.0) + Esky * (0.5 + 0.5 * shadow))
           + spec * PI * direct
           + Fv * skyRad;
    }
    vec3 Lg = mix(Lland, Lsea, oceanW);
    if (uDebug == 7) { gl_FragColor = vec4(vec3(oceanW), 1.0); return; }
    if (uDebug == 8) { gl_FragColor = vec4(seaIce, snowCover, water, 1.0); return; }

    // ---------------- city lights (night side only, off by civil twilight; diffused and dimmed by clouds)
    float nightF = smoothstep(-0.015, -0.11, muS);
    vec3 cityDiff = vec3(0.0);
    if (nightF > 0.0) {
      float nlt = nightTex * sqrt(nightTex);           // Black Marble is stretched; ~1.5 restores the dynamic range
      // urban cores are 5-10x brighter than their suburbs (the 8-bit stretched map compresses that range)
      float coreK = smoothstep(0.5, 1.0, nightTex);
      nlt *= 0.6 + 2.6 * coreK * coreK;
      float nltBlur = textureLod(uNight, uv, 4.5).r;
      nltBlur *= nltBlur;
      // point-light field below the texel scale (see citylights-glsl.js); the mean is the Black Marble radiance
      Lg += cityLights(pb, nlt * 0.28, nightTex, fpc) * nightF * (1.0 - water * 0.9);
      vec3 lc = vec3(1.0, 0.6, 0.3);
      cityDiff = lc * nltBlur * 0.06 * nightF;
    }

    // ---------------- cloud radiance
    vec3 Lcl = vec3(0.0);
    if (aCl > 0.002) {
      // volume: normal of the cloud-top height field (domes rising from the edges; see cloudField), slope soft-clamped
      vec3 gt = cgrad - pbc * dot(cgrad, pbc);
      vec3 sl = gt / uRp;
      sl /= 1.0 + length(sl) / 2.2;
      vec3 nCb = normalize(pbc - sl * uDetail);
      vec3 Ncl = transpose(uW2B) * nCb;
      if (uDebug == 9) { gl_FragColor = vec4((nCb - pbc) * 2.0 + 0.5, 1.0); return; }
      // sunlight reaches each cloud top at its own height: low, thin stratocumulus / cumulus (~1.5 km) redden and
      // fall into shadow first at sunset, tall thick convective tops (~8 km) stay lit and whiter for longer
      float muSc = dot(Nc, sunDir);
      float hC = mix(1.5, 7.0, smoothstep(0.35, 0.85, R0cl)) * KM + hTopC;
      float rC = uRp + hC * ATMO_S;
      vec3 TsunC = sunTrans(rC, muSc) * moonShadow(Pc, sunDir);
      // low sun: thick, tall clouds shadow their neighbours (march the cloud-top height field toward the sun)
      float selfSh = 1.0;
      if (muSc < 0.35 && muSc > -0.06) {
        vec3 sB = uW2B * sunDir;
        vec3 tS = sB - pbc * dot(sB, pbc);
        float lt = length(tS);
        if (lt > 1e-4) {
          tS /= lt;
          float tanE = dot(sB, pbc) / lt;
          const float HTOP = 9.0 * KM;                 // tallest tops ~9 km above the layer base
          float h0 = Rcl * Rcl * HTOP;
          float st = 0.0016;
          for (int k = 0; k < 5; k++) {
            float lodq = log2(max(st / CLOUD_TEXEL, 1.0));
            float mq = smoothstep(0.045, 0.9, cloudMapLod(normalize(pbc + tS * st), lodq)) * iceDamp;
            float hq = mq * mq * HTOP;
            float hray = h0 + st * tanE * uRp + 0.5 * st * st * uRp;
            selfSh = min(selfSh, smoothstep(-0.25, 0.6, (hray - hq) / (1.2 * KM)));
            st *= 2.0;
          }
          selfSh = mix(1.0, selfSh, smoothstep(0.35, 0.15, muSc));
        }
      }
      // Cloud BRDF = multiple scattering (wrapped Lambert on the bumpy tops) + single scattering with a two-lobe
      // Henyey-Greenstein water-cloud phase function in Lommel-Seeliger form, P(T) mu0 / (4 (mu0 + mu)). The
      // single-scatter lobe is what makes clouds bright at high phase angles (the crescent Earth, a low pass toward
      // the sun) and gives the glory side a slight backscatter lift; at nadir it adds only ~7%.
      // directional part on the dome normal (sun-facing flanks catch the low sun, the far flanks fall into shade), plus
      // a diffusion part: light that entered elsewhere and leaks out of the shaded flank (thick cloud is never black)
      float sunLit = smoothstep(-0.02, 0.05, muSc + 0.06) * (0.25 + 0.75 * selfSh);
      // unresolved cloud-top relief: at grazing sun the sun-facing sides of sub-pixel turrets are still lit (the
      // "soft" cosine of a rough surface, rms slope ~0.2), which is what keeps cloud tops glowing orange along the
      // terminator after the flat ground has gone dark
      float ndl = dot(Ncl, sunDir);
      float softMu = 0.5 * (ndl + sqrt(ndl * ndl + 0.035));
      float lam = mix(0.5 * (muSc + sqrt(muSc * muSc + 0.035)), softMu, 0.72) * sunLit;
      // + flanks facing the sun past the base terminator (the tops are already in TsunC's lit air)
      lam += max(ndl - max(muSc, 0.0), 0.0) * 0.15 * sunLit;
      float mu0c = softMu, muVc2 = max(dot(Ncl, -rd), 0.03);
      const float g1 = 0.82, g2 = -0.25;
      float hg1 = (1.0 - g1 * g1) / pow(1.0 + g1 * g1 - 2.0 * g1 * nu, 1.5);
      float hg2 = (1.0 - g2 * g2) / pow(1.0 + g2 * g2 - 2.0 * g2 * nu, 1.5);
      float Pc = min(0.72 * hg1 + 0.28 * hg2, 9.0);
      float ss = Pc * mu0c / (4.0 * (mu0c + muVc2)) * sunLit * min(1.0, Rcl * 1.6);
      // forward-scattering silver lining through thin cloud when looking toward the sun
      float fwd = pow(max(nu, 0.0), 12.0) * (1.0 - Rcl) * 0.8;
      // skylight on a cloud top: only the sky ABOVE it (the LUT is for the ground) and only the part its tilted top sees
      vec3 EskyC = skyIrradiance(muSc) * exp(-hC / (HR)) * (0.6 + 0.4 * dot(Ncl, Nc));
      Lcl = TsunC * ((lam * 0.92 + fwd) * Rcl + ss) / max(aCl, 1e-3) + EskyC * (Rcl / max(aCl, 1e-3));
    }

    // ---------------- composite: above-cloud air, cloud, below-cloud air, ground
    vec3 Lsurf = Lup * PI + Tup * ((Lcl + cityDiff) * aCl + (1.0 - aCl) * (Llo * PI + Tlo * Lg));
    if (uDebug == 1) Lsurf = Lup * PI + Tup * Llo * PI;
    if (uDebug == 2) Lsurf = Lg;
    if (uDebug == 3) Lsurf = Lcl * aCl;
    if (uDebug == 4) Lsurf = Tup * Tlo;
    outL += cov * Lsurf;
  }

  // ===================================================================== the sky (limb) part of the pixel
  if (cov < 1.0) {
    vec3 Ls = vec3(0.0), Ts = vec3(1.0);
    if (ta.x <= ta.y && ta.y > 0.0) {
      float tMid = clamp(-b, t0, ta.y);
      marchSegment(ro, rd, t0, tMid, true, 14, sunDir, pR, pM, pJ, Ls, Ts);
      marchSegment(ro, rd, tMid, ta.y, false, 14, sunDir, pR, pM, pJ, Ls, Ts);
    }
    vec3 Lsky = Ls * PI;
    // OI 557.7 nm airglow: a thin green emission layer at ~95 km (Gaussian, sigma 4.5 km), only noticeable edge-on
    // above the night limb. Integrated analytically (Abel transform of the Gaussian layer, fitted), so the line is
    // crisp at any distance; uAirglow = radiance of the line seen exactly edge-on.
    if (uAirglow > 0.0) {
      // three emission layers, each integrated analytically along the line of sight (Abel transform of a Gaussian
      // shell, fitted): OI 557.7 nm green at ~97 km (sigma 6 km, modestly widened), Na 589 nm orange just below it
      // (~90 km), and the broad, faint OI 630 nm red layer at ~210 km
      vec3 pt = hit ? ro + rd * max(tglow.x, 0.0) : qv;     // where the line of sight meets the layers
      float dark = smoothstep(0.08, -0.15, dot(normalize(pt), sunDir));
      if (dark > 0.0) {
        // gravity-wave banding along the limb: low-frequency brightness structure fixed to the planet
        vec3 pg = uW2B * normalize(pt);
        float band = 1.0 + 0.45 * snoise(pg * vec3(14.0, 40.0, 14.0)) + 0.2 * snoise(pg * 55.0 + 3.1);
        vec3 E = vec3(0.0);
        for (int k = 0; k < uLoopMax; k++) {
          if (k >= 3) break;
          float hk = k == 0 ? 97.0 : (k == 1 ? 89.0 : 210.0);
          float sk = k == 0 ? 6.0 : (k == 1 ? 3.5 : 40.0);
          vec3 ck = k == 0 ? vec3(0.25, 1.0, 0.40) : (k == 1 ? vec3(1.0, 0.55, 0.12) * 0.28 : vec3(1.0, 0.12, 0.08) * 0.035);
          float x = (dq - (uRp + hk * KM)) / (sk * KM);
          float F = x <= 0.0 ? 2.5066 / sqrt(0.675 - x) : 3.05 * exp(-1.1 * x - 0.25 * x * x);
          // below its tangent height the line of sight crosses the layer obliquely (twice): the camera sees a bright
          // line floating over a darker band down to the limb (ISS photographs)
          if (x < 0.0) F *= exp(0.3 * x);
          if (hit) F *= 0.5;                                  // the far leg is behind the planet
          E += ck * (F / 3.05) * (k == 2 ? sqrt(40.0 / 6.0) : 1.0);
        }
        Lsky += E * band * dark * uAirglow;
      }
    }
    outL += (1.0 - cov) * Lsky;
  }
  gl_FragColor = vec4(outL, 1.0);
}
`;
