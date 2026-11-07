// Earth cloud field: advection + structure. Included by earth-radiance.js (pass C; needs EARTH_COMMON, NOISE_GLSL and
// NOISE3_GLSL).
//
// ADVECTION. A single cloud map cannot be advected for days: rigidly offsetting longitude per latitude shears every
// feature into comet tails. Instead a bounded long-term drift D(d) = 0.5 tanh(d / 0.5) days of wind, plus a two-phase
// flow map (P = 0.4 day): phase k samples the field displaced by wind * (tau_k - 0.5) * P, the phases are half a period
// apart, crossfaded with triangle weights, and each re-seeds its procedural detail while its weight is 0. The map is
// blended before the coverage threshold (clouds evolve, no double exposure); the noise variance-preserving.
//
// STRUCTURE. The NASA map gives a mean reflectance per 20 km texel. Sub-texel structure is a coverage THRESHOLD of a
// procedural field n, evaluated statistically: octaves below the pixel footprint are unresolved logistic noise, so
//     R = A * CDF((n_resolved - t(c)) / s),   t(c) = s_total * logit(1 - c)
// equals the map mean (A * c) when nothing is resolved and becomes crisp clouds with eroded edges as the footprint
// shrinks. s = unresolved spread + the field's change across the pixel measured along BOTH screen axes (an oblique,
// foreshortened footprint is long in one direction: an isotropic width aliased the field into rows of dashes there).
// Regimes (all from the map's own coverage and latitude, faded by a low-frequency regime field):
//   - closed-cell stratocumulus (subtropical oceans, high coverage): bright cells, each with its own optical
//     thickness, separated by narrow lanes of thinner, darker cloud (Worley F2 - F1),
//   - open cells (lower coverage): cloud rings around clear centres,
//   - cumulus clusters elsewhere (Gaussian blob field, irregular strength and size),
//   - storm tracks: features elongated along the zonal wind (<= 1.8 : 1).
export const CLOUDS_GLSL = /* glsl */ `
uniform vec4 uFlow;      // x: long-term drift (days), y: phase-A offset (days), z: phase-B offset (days), w: phase-A weight
uniform vec3 uSeedA;     // phase-A noise re-seed offset (changes only while its weight is 0)
uniform vec3 uSeedB;
#define CLOUD_TEXEL 0.00307    // 2 pi / 2048

// zonal wind (m/s, eastward +) for low/mid-level cloud: trade-wind easterlies, mid-latitude westerlies, polar
// easterlies; smooth in latitude (no kink at the equator)
float zonalRate(float lat) {
  float ld = lat * (180.0 / PI), a = abs(ld);
  float u = -6.5 * exp(-ld * ld / 420.0) + 11.0 * exp(-(a - 45.0) * (a - 45.0) / 225.0) - 3.0 * exp(-(a - 76.0) * (a - 76.0) / 100.0);
  return u * 86400.0 / (6.371e6 * max(cos(lat), 0.15));      // rad / day about the pole
}
float logistic(float x) { return 1.0 / (1.0 + exp(-x)); }

// map value -> (in-cloud albedo A, coverage c), A * c = the map's layer reflectance R0. Thick decks reach A 0.95
// (two-stream albedo of tau ~60 water cloud); thin / broken cloud is greyer per unit area.
vec2 cloudAC(float m) {
  float R0 = smoothstep(0.045, 0.9, m);
  R0 = R0 * R0 * (3.0 - 2.0 * R0) * 0.35 + R0 * 0.65;
  float A = mix(0.42, 0.95, smoothstep(0.25, 0.9, R0));
  return vec2(A, clamp(R0 / A, 0.0, 1.0));
}

// octave amplitudes: the energy sits at 15-20 km (cellular octave + first simplex octave) so cloud bodies, not km-size
// holes, dominate from low orbit; below ~3 km the spectrum steepens (fine octaves only roughen edges)
float octAmp(int i) { return i == 0 ? 0.18 : (i == 1 ? 0.08 : 0.05 * pow(0.55, float(i - 2))); }
const float AW = 0.34;
#define LF 0.55
// total nominal variance (constant-folded): sum over 8 octaves of (amp * LF?)^2 * 0.139 + AW^2 * 0.03
#define CLOUD_VART 0.009012

// procedural sub-texel field for one flow phase: vec4(n, dn/dq); varU = unresolved variance, gBump = gradient for the
// cloud-top shape (fine octaves de-emphasised), fineV = fine-octave texture, cellK = per-cell optical thickness.
// q: advected direction, seed: the phase's re-seed offset, w: warp vector, fp: pixel footprint (radians).
vec4 cloudNoise(vec3 q, vec3 seed, vec3 w, float fp, int maxOct, float cellW, float open, float dense, float streak,
                float t, float sT, out float varU, out vec3 gBump, out float fineV, out float cellK) {
  vec4 s = vec4(0.0);
  gBump = vec3(0.0);
  varU = 0.0;
  fineV = 0.0;
  cellK = 1.0;
  {
    const float fc = 300.0;                    // ~21 km cells
    float wt = clamp(0.25 / (fc * fp) - 0.5, 0.0, 1.0);          // resolved from 2 px per cell, fully from 6 px
    varU += AW * AW * 0.03 * (1.0 - wt * wt);
    if (wt > 0.0) {
      // Worley F1 / F2 (exact 3x3x3 search), nearest-cell hash and a Gaussian blob field over the same points (30 % of
      // the cells empty, sizes and strengths vary; stats in dev/blobstat2.mjs: mean 0.2872, std 0.3071)
      vec3 p = q * fc + w * 0.35 + seed * 0.37;
      vec3 ip = floor(p), fp3 = p - ip;
      float d1 = 8.0, d2 = 8.0, h1 = 0.0;
      vec4 B = vec4(0.0);
      for (int k = 0; k < uLoopMax; k++) {
        if (k >= 27) break;
        vec3 g = vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
        vec3 h = hash33(ip + g);
        vec3 r = fp3 - g - h;
        float d = dot(r, r);
        float v = fract(h.x * 7.13 + h.y * 3.71 + h.z * 1.93), u = fract(h.x * 2.31 + h.z * 5.17);
        float ik = 0.5 / ((0.2 + 0.18 * u) * (0.2 + 0.18 * u));
        B += (v < 0.3 ? 0.0 : 0.35 + 1.3 * u * u) * exp(-ik * d) * vec4(1.0, -2.0 * ik * r);
        if (d < d1) { d2 = d1; d1 = d; h1 = v; } else d2 = min(d2, d);
      }
      // cell interior: 0 on a wall (F2 = F1) .. 1 inside. Open cells: cloud rings around clear centres. Closed cells:
      // the coverage field carries each cell's own strength and a shallow dip at the walls - the lanes between closed
      // cells are thinner, darker cloud (cellK), not cracks of open ocean
      float se = smoothstep(0.0, mix(0.18, 0.34, open) + 2.5 * fc * fp, sqrt(d2) - sqrt(d1));
      float cell = mix(0.14 * (h1 - 0.5) + 0.07 * (se - 0.55), 0.34 * (0.55 - se), open);
      // cumulus clusters: the blob field (normalised to std 0.173), clumpiness varying from place to place; dense decks
      // are not perforated by the gaps between clusters (their minima read as round punched holes)
      float a = wt * AW * mix((0.35 + 0.65 * smoothstep(-0.35, 0.45, w.x)) * (1.0 - 0.75 * dense), 1.0, cellW);
      vec3 g3 = B.yzw * (0.563 * fc * (1.0 - cellW));
      s += a * vec4(mix((B.x - 0.2872) * 0.563, cell, cellW), g3);
      gBump += a * g3;
      cellK = mix(1.0, mix(0.6 + 0.4 * se, 1.0, open) * (0.84 + 0.32 * h1), cellW * wt);
    }
  }
  // octaves of baked gradient noise, ~15 km base
  float sy = 1.0 + 1.6 * streak;              // storm tracks: shorter along the pole axis => elongated east-west
  float f = 420.0, gd = 1.0, m = 1.0;
  for (int i = 0; i < uLoopMax; i++) {
    if (i >= 8) break;
    if (i == 2) {
      // edge-localised fine detail (Schneider erosion): no perforation deep inside a mass, no specks in clear air
      float z = (s.x - t) / max(sT, 1e-4);
      m = mix(0.3, 1.0, exp(-0.5 * z * z));
    }
    float a = octAmp(i) * (i >= 2 ? m * LF : 1.0);
    float wo = i < maxOct ? clamp(0.25 / (f * fp) - 0.5, 0.0, 1.0) : 0.0;
    varU += a * a * 0.139 * (1.0 - wo * wo);
    if (wo > 0.0) {
      vec3 x = q * f + w * 0.3 + seed + float(i) * vec3(1.7, 9.2, 3.1);
      x.y *= sy;
      // odd octaves rotated: the 32-cell texture period and the lattice axes never line up between octaves
      bool odd = (i & 1) == 1;
      vec4 n = tn(odd ? NOISE3_ROT * x : x);
      vec3 gq = (odd ? n.yzw * NOISE3_ROT : n.yzw) * f;
      gq.y *= sy;
      s += wo * a * vec4(n.x, gq);
      if (i >= 2) fineV += wo * a * n.x / LF;
      gBump += (wo * a * gd) * gq;
    }
    gd *= 0.7;
    f *= 2.13;
  }
  return s;
}

// Cloud layer reflectance R (0..1) at body-frame direction pb. uv0 / g: map UV and its screen gradients; fp: pixel
// footprint for octave fading (radians); dPx / dPy: screen derivatives of pb (exact anti-aliasing of the threshold).
// Outputs grad (cloud-top height gradient, for the volume shading), R0mean (map mean) and hTop (top relief).
float cloudField(vec3 pb, vec2 uv0, vec4 g, float fp, vec3 dPx, vec3 dPy, int maxOct, float oceanW,
                 out vec3 grad, out float R0mean, out float hTop) {
  float lat = asin(clamp(pb.y, -1.0, 1.0));
  float latD = abs(lat) * (180.0 / PI);
  float om = zonalRate(lat);
  float cl = sqrt(max(1.0 - pb.y * pb.y, 0.0));
  // sub-texel warp of the map lookup (the map's own shapes continue below its resolution); displacement <= ~0.15 of
  // each warp wavelength (stronger warps of a smooth bilinear map marble it into liquid swirls)
  float warpW = smoothstep(CLOUD_TEXEL * 1.2, CLOUD_TEXEL * 0.3, fp) * uDetail;
  float w2 = smoothstep(CLOUD_TEXEL * 0.5, CLOUD_TEXEL * 0.15, fp);
  vec2 sc = warpW * vec2(1.0 / (2048.0 * max(cl, 0.08)), 1.0 / 1024.0);
  float m = 0.0;
  vec3 q0 = pb, q1 = pb, w0 = vec3(0.0), w1 = vec3(0.0);
  vec2 r0 = vec2(1.0, 0.0), r1 = vec2(1.0, 0.0);
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 2) break;
    float dl = -om * (uFlow.x + (k == 0 ? uFlow.y : uFlow.z));
    vec3 seed = k == 0 ? uSeedA : uSeedB;
    vec2 cs = vec2(cos(dl), sin(dl));
    vec3 q = vec3(cs.x * pb.x + cs.y * pb.z, pb.y, cs.x * pb.z - cs.y * pb.x);     // longitude-rotated by dl
    vec2 u = vec2(uv0.x + dl * (0.5 / PI), uv0.y);
    vec3 wk = vec3(0.0);
    if (warpW > 0.0) {
      // warp vector from the gradients of two baked octaves (~65 and ~22 km)
      vec4 a1 = tn(q * 95.0 + seed), a2 = tn(q * 290.0 + seed.zxy);
      vec2 wv = a1.yz * 0.3;
      u += (0.55 * wv + 0.22 * w2 * a2.yz * 0.3) * sc;
      wk = vec3(wv, a1.x);
    }
    if (k == 0) { q0 = q; r0 = cs; w0 = wk; } else { q1 = q; r1 = cs; w1 = wk; }
    m += textureGrad(uClouds, u, g.xy, g.zw).r * (k == 0 ? uFlow.w : 1.0 - uFlow.w);
  }
  vec2 AC = cloudAC(m);
  R0mean = AC.x * AC.y;
  float c = AC.y;
  grad = vec3(0.0);
  hTop = 0.0;
  if (uDetail <= 0.0 || c <= 0.002 || uDebug == 33) return R0mean;
  // regimes; a low-frequency regime field breaks the subtropical cell decks into neighbourhoods (cells, open
  // patches, plain cumulus), so the same texture never covers an ocean
  float reg = tn(pb * 7.0 + vec3(3.0, 1.0, 7.0)).x * 2.2;
  float subtrop = smoothstep(8.0, 16.0, latD) * smoothstep(42.0, 30.0, latD);
  float cellW = subtrop * oceanW * smoothstep(0.25, 0.55, c) * clamp(0.75 + 0.6 * reg, 0.0, 1.0);
  float streak = smoothstep(28.0, 42.0, latD) * smoothstep(68.0, 55.0, latD) * 0.5;
  float open = smoothstep(0.52, 0.32, c + 0.12 * reg);     // open cells at lower coverage, closed above
  float dense = smoothstep(0.5, 0.85, c);
  float sT = sqrt(CLOUD_VART) * 0.5513;           // logistic scale of the total field
  float cc = clamp(c, 0.002, 0.998);
  float t = sT * log((1.0 - cc) / cc);
  // the procedural field, both phases blended variance-preserving (Heitz-Neyret)
  float wA = uFlow.w, wB = 1.0 - uFlow.w;
  float nrm = inversesqrt(max(wA * wA + wB * wB, 1e-4));
  vec4 n = vec4(0.0);
  vec3 gb = vec3(0.0);
  float varU = 0.0, fine = 0.0, ck = 0.0;
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 2) break;
    float wk = (k == 0 ? wA : wB) * nrm;
    float vU, fk, ckk; vec3 gbk;
    vec4 nk = cloudNoise(k == 0 ? q0 : q1, k == 0 ? uSeedA : uSeedB, k == 0 ? w0 : w1, fp, maxOct, cellW, open, dense, streak, t, sT, vU, gbk, fk, ckk);
    vec2 r = k == 0 ? r0 : r1;
    // back to the body frame (the phase sampled a longitude-rotated direction)
    n += wk * vec4(nk.x, r.x * nk.y - r.y * nk.w, nk.z, r.x * nk.w + r.y * nk.y);
    gb += wk * vec3(r.x * gbk.x - r.y * gbk.z, gbk.y, r.x * gbk.z + r.y * gbk.x);
    fine += wk * fk;
    ck += (k == 0 ? wA : wB) * ckk;
    varU += (k == 0 ? wA : wB) * vU;
  }
  // exact anti-aliasing: the field's change across the pixel along both screen axes
  vec3 gt = n.yzw - pb * dot(n.yzw, pb);
  float gpx = length(vec2(dot(gt, dPx), dot(gt, dPy)));
  // edge softness: thin stratiform / cirrus edges are soft, cumulus and cell edges crisp
  // (by regime, not by in-cloud albedo: broken trade cumulus has a low mean albedo but the crispest edges of all)
  float strat = max(streak * 1.6, smoothstep(55.0, 70.0, latD)) * (1.0 - subtrop);
  float soft = 0.0008 * strat * (1.0 - smoothstep(0.8, 0.93, AC.x));
  float sU = sqrt(varU + soft) * 0.5513 + 0.6 * gpx;
  float cov = logistic((n.x - t) / max(sU, 1e-4));
  float res = clamp(1.0 - varU / CLOUD_VART, 0.0, 1.0);
  // optical depth builds up within a short distance of the edge (a cumulus is bright almost to its rim)
  float core = smoothstep(0.0, 0.6 * sT, n.x - t);
  float R = AC.x * cov * mix(1.0, mix(0.85, 1.03, core) * ck, res);
  R *= clamp(1.0 + 2.2 * fine * core, 0.7, 1.22);
  R = min(R, 0.97);
  // cloud-top height field: a dome rising steeply from the edge and flattening inside the mass (lit tops / shaded
  // flanks on cumulus, gentle undulation on decks): stratocumulus a few hundred metres, cumulus ~2 km, convection 7 km
  float Hc = KM * mix(mix(2.4, 7.0, smoothstep(0.78, 0.93, AC.x)), 0.5, cellW) * (1.0 - 0.5 * streak);
  float su = max(sU / sT, 0.05);
  float zz = (n.x - t) / sT;
  float x = zz / su;
  float zp = x > 15.0 ? zz : su * log(1.0 + exp(x));
  float dzp = logistic(x);
  float ex = exp(-1.3 * zp);
  float domeW = smoothstep(0.00042, 0.00012, fp) * res;
  hTop = Hc * (1.0 - ex) * res;
  grad = (Hc * (1.3 * ex * dzp + 0.5 * dzp) / sT) * gb * domeW;
  return R;
}
`;
