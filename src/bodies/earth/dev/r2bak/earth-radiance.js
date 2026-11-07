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

// Worley F1/F2 over the 2x2x2 nearest cells (the cell holding p and its nearer neighbour on each axis), with a
// uniform loop bound so the compiled shader holds one copy
vec2 worleyD(vec3 p) {
  vec3 i = floor(p - 0.5), f = p - i;
  float d1 = 8.0, d2 = 8.0;
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 8) break;
    vec3 g = vec3(float(k & 1), float((k >> 1) & 1), float(k >> 2));
    vec3 r = g + hash33(i + g) - f;
    float d = dot(r, r);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
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
  vec2 tglow = raySphere(ro, rd, uRp + 115.0 * KM);
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
  float fpC = max(length(fwidth(Pc)), 1e-7) / uRp;

  float nu = dot(rd, sunDir);
  float pR = phaseRayleigh(nu), pM = phaseMie(nu);
  vec3 outL = vec3(0.0);
  float t0 = max(ta.x, 0.0);
  float detailFade = smoothstep(DAY_TEXEL * 2.5, DAY_TEXEL * 0.5, fpU) * uDetail;

  // ===================================================================== the solid-planet part of the pixel
  if (cov > 0.0) {
    vec3 Lup = vec3(0.0), Tup = vec3(1.0), Llo = vec3(0.0), Tlo = vec3(1.0);
    float tSplit = clamp(tCl, t0, tHit);
    marchSegment(ro, rd, t0, tSplit, true, 18, sunDir, pR, pM, Lup, Tup);
    marchSegment(ro, rd, tSplit, tHit, true, 6, sunDir, pR, pM, Llo, Tlo);

    float muS = dot(N, sunDir);
    vec3 Tsun = sunTrans(uRp + 2e-5, muS) * moonShadow(P, sunDir);
    vec3 V = -rd;
    float NdV = max(dot(N, V), 1e-3);

    // ---------------- textures
    vec3 day = textureGrad(uDay, uv, g.xy, g.zw).rgb;
    float wm = textureGrad(uWater, uv, g.xy, g.zw).r;
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
    const float RELIEF = 6.4 * KM * 5.0;     // 0..6.4 km, exaggerated x5 so relief reads at the terminator
    vec3 gradB = (Ta * (h1 - h0) + Tb * (h2 - h0)) * (RELIEF / (eps * uRp));
    // procedural micro-relief at close range: mountains rough, plains calm
    float rough = smoothstep(0.015, 0.2, hgt) * 0.85 + 0.15;
    if (detailFade > 0.0) {
      vec4 rn = fbmd(pb * 700.0, fpU * 700.0, 6, 2.1, 0.5);
      vec3 gr = rn.yzw * 700.0;
      gr -= pb * dot(gr, pb);
      gradB += gr * (detailFade * rough * 0.0009);
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
    float snowCover = smoothstep(snowN - 2.0, snowN + 3.0, latD + edgeNoise * 1.3 + hgt * 25.0) * (1.0 - water);
    float forest = smoothstep(0.02, 0.06, day.g - day.r) * smoothstep(0.12, 0.05, day.g);
    snowCover *= 1.0 - 0.65 * forest;          // boreal forest canopy hides snow; tundra and mountains go white

    // ---------------- albedo
    vec3 alb = day;
    if (detailFade > 0.0) {
      float dn = fbmd(pb * 1100.0 + vec3(3.1), fpU * 1100.0, 4, 2.2, 0.55).x;
      alb *= 1.0 + dn * 0.3 * detailFade * (1.0 - water);
    }
    alb = mix(alb, vec3(0.70, 0.78, 0.85) * (1.0 - 0.6 * floes), seaIce * 0.92);
    alb = mix(alb, vec3(0.78, 0.80, 0.83), snowCover * 0.85);
    float oceanW = water * (1.0 - seaIce);

    // ---------------- cloud layer
    int oct = int(mix(3.0, 8.0, uDetail));
    // the layer above this pixel (k = 0) and where the sun ray from the ground crosses it (k = 1, cloud shadow);
    // one loop so the (large) cloud code is compiled once
    vec3 cgrad = vec3(0.0);
    float R0cl = 0.0, Rcl = 0.0, dsh = 0.0;
    {
      vec2 ts = raySphere(P, sunDir, uRc);
      vec3 pbs = uW2B * normalize(P + sunDir * max(ts.y, 0.0));
      for (int k = 0; k < uLoopMax; k++) {
        if (k >= 2) break;
        vec3 pk = k == 0 ? pbc : pbs;
        vec3 gk; float r0k;
        // (the shadow uses a ~4 km footprint: two octaves, soft-edged like real cloud shadows lit by the whole sky)
        float rk = cloudField(pk, k == 0 ? uvc : dirToUV(pbs), gc, k == 0 ? fpC : max(fpC, 0.0006), k == 0 ? oct : 2, water, gk, r0k);
        if (k == 0) { Rcl = rk; cgrad = gk; R0cl = r0k; } else dsh = rk;
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
    float relief = smoothstep(-0.05, 0.1, muSl) * max(muSl, 0.0);
    vec3 Lland = alb * (direct * relief + Esky * (0.5 + 0.5 * shadow));

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
      vec3 ps = pb * vec3(260.0, 700.0, 260.0) + vec3(0.0, uDays * 0.2, 0.0);
      float slick = smoothstep(0.62, 0.8, fbmd(ps, fpU * 500.0, 4, 2.0, 0.5).x * 0.5 + 0.5);
      float alpha = mix(0.085, 0.22, clamp(wind, 0.0, 1.0)) * mix(1.0, 0.32, slick);
      // swell / wind waves resolved at close range; their unresolved slope variance goes into the lobe width
      vec3 Nw = N;
      float a2 = alpha * alpha;
      {
        vec4 sw = fbmd2(pb * 4200.0 + vec3(uDays * 400.0, 0.0, uDays * 150.0), fpU * 4200.0, 4, 2.3, 0.55, 1.0);
        float wRes = smoothstep(2.0, 0.6, fpU * 4200.0);            // fraction of the swell slope resolved
        vec3 gs = sw.yzw * 4200.0 * 0.000012;                         // ~0.05 rad rms slopes
        gs -= pb * dot(gs, pb);
        Nw = normalize(N - transpose(uW2B) * gs * wRes);
        a2 += 0.0025 * (1.0 - wRes * wRes);
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
      // bump from the procedural gradient (cloud-top relief ~1 km)
      vec3 gt = cgrad - pbc * dot(cgrad, pbc);
      vec3 nCb = normalize(pbc - gt * 0.00016 * uDetail);
      vec3 Ncl = transpose(uW2B) * nCb;
      // sunlight reaches each cloud top at its own height: low, thin stratocumulus / cumulus (~1.5 km) redden and
      // fall into shadow first at sunset, tall thick convective tops (~8 km) stay lit and whiter for longer
      float muSc = dot(Nc, sunDir);
      float rC = uRp + mix(1.5, 8.0, smoothstep(0.35, 0.85, R0cl)) * KM;
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
      float wrap = 0.3;
      float sunLit = smoothstep(-0.02, 0.05, muSc + 0.04) * (0.25 + 0.75 * selfSh);
      float lam = max((dot(Ncl, sunDir) + wrap * max(muSc, 0.0)) / (1.0 + wrap), 0.0);
      lam = pow(lam, 0.85) * sunLit;
      float mu0c = max(dot(Ncl, sunDir), 0.0), muVc2 = max(dot(Ncl, -rd), 0.03);
      const float g1 = 0.82, g2 = -0.25;
      float hg1 = (1.0 - g1 * g1) / pow(1.0 + g1 * g1 - 2.0 * g1 * nu, 1.5);
      float hg2 = (1.0 - g2 * g2) / pow(1.0 + g2 * g2 - 2.0 * g2 * nu, 1.5);
      float Pc = min(0.72 * hg1 + 0.28 * hg2, 9.0);
      float ss = Pc * mu0c / (4.0 * (mu0c + muVc2)) * sunLit * min(1.0, Rcl * 1.6);
      // forward-scattering silver lining through thin cloud when looking toward the sun
      float fwd = pow(max(nu, 0.0), 12.0) * (1.0 - Rcl) * 0.8;
      vec3 EskyC = skyIrradiance(muSc);
      Lcl = TsunC * ((lam * 0.92 + fwd) * Rcl + ss) / max(aCl, 1e-3) + EskyC * 0.85 * (Rcl / max(aCl, 1e-3));
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
      marchSegment(ro, rd, t0, tMid, true, 14, sunDir, pR, pM, Ls, Ts);
      marchSegment(ro, rd, tMid, ta.y, false, 14, sunDir, pR, pM, Ls, Ts);
    }
    vec3 Lsky = Ls * PI;
    // OI 557.7 nm airglow: a thin green emission layer at ~95 km (Gaussian, sigma 4.5 km), only noticeable edge-on
    // above the night limb. Integrated analytically (Abel transform of the Gaussian layer, fitted), so the line is
    // crisp at any distance; uAirglow = radiance of the line seen exactly edge-on.
    if (uAirglow > 0.0) {
      float r0g = uRp + 95.0 * KM, sg = 4.5 * KM;
      float x = (dq - r0g) / sg;
      float F = x <= 0.0 ? 2.5066 / sqrt(0.675 - x) : 3.05 * exp(-1.1 * x - 0.25 * x * x);
      // below its tangent height the line of sight only crosses the layer obliquely (twice): physically ~1/sqrt;
      // the eye / camera sees a thin bright line floating over a dark band down to the limb (ISS photographs)
      if (x < 0.0) F *= exp(0.3 * x);
      if (hit) F *= 0.5;                                  // the far leg is behind the planet
      vec3 pt = hit ? ro + rd * max(tglow.x, 0.0) : qv;     // where the line of sight meets the layer
      float dark = smoothstep(0.08, -0.15, dot(normalize(pt), sunDir));
      Lsky += vec3(0.25, 1.0, 0.42) * (F / 3.05) * dark * uAirglow;
    }
    outL += (1.0 - cov) * Lsky;
  }
  gl_FragColor = vec4(outL, 1.0);
}
`;
