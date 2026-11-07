// Earth cloud field: advection + structure. Included by earth-radiance.js (needs EARTH_COMMON, NOISE_GLSL, NOISE_D_GLSL).
//
// ADVECTION. A single cloud map cannot be advected for days: rigidly offsetting longitude per latitude shears every
// feature into comet tails (the strain grows linearly with time). Instead:
//   - a bounded long-term drift  D(d) = 0.5 tanh(d / 0.5) days of wind (strain <= ~0.2, so stills at days 0 / 0.25 /
//     0.5 show the systems really moving east / west), plus
//   - a two-phase flow map: phase k samples the field displaced by wind * (tau_k - 0.5) * P (P = 0.4 day), the two
//     phases are half a period apart and crossfaded with triangle weights, and each phase re-seeds its procedural
//     detail every cycle (weight 0 at the switch), so the motion is continuous and always with the local wind while
//     the total displacement - and therefore the shear - stays bounded forever. The map density is blended before the
//     coverage threshold (so a crossfade reads as clouds evolving, not as a double exposure) and the procedural
//     noise is blended variance-preserving (no contrast pulsing).
//
// STRUCTURE. The NASA map gives a mean reflectance per 20 km texel. Sub-texel structure is a coverage THRESHOLD of a
// procedural field n (Schneider-style), evaluated statistically: octaves below the pixel footprint are treated as
// unresolved logistic noise, so
//     R = A * CDF((n_resolved - t(c)) / s_unresolved),   t(c) = s_total * logit(1 - c)
// which equals the map's mean (A * c) when nothing is resolved and becomes crisp, solid-interior clouds with sharp
// eroded edges as the footprint shrinks (analytically anti-aliased by the resolved gradient). Clear sky stays clear,
// overcast decks stay solid. The field's spectrum is weighted below the map scale (no 40 km "leopard" blotches at
// mid range), with regimes: closed/open cellular stratocumulus over the subtropical oceans (Worley, ~28 km cells),
// billowy cumulus elsewhere, and wind-aligned streaky texture in the mid-latitude storm tracks.
export const CLOUDS_GLSL = /* glsl */ `
uniform vec4 uFlow;      // x: long-term drift (days), y: phase-A offset (days), z: phase-B offset (days), w: phase-A weight
uniform vec3 uSeedA;     // phase-A noise re-seed offset (changes only while its weight is 0)
uniform vec3 uSeedB;
#define CLOUD_TEXEL 0.00307    // 2 pi / 2048

// zonal wind (m/s, eastward +) for low/mid-level cloud: trade-wind easterlies, mid-latitude westerlies, polar
// easterlies. Smooth in latitude everywhere (no kink at the equator) so neighbouring rows never pull apart.
float zonalWind(float latDeg) {
  float a = abs(latDeg);
  return -6.5 * exp(-latDeg * latDeg / 420.0) + 11.0 * exp(-pow((a - 45.0) / 15.0, 2.0)) - 3.0 * exp(-pow((a - 76.0) / 10.0, 2.0));
}
// angular velocity about the pole (rad / day)
float zonalRate(float lat) {
  return zonalWind(lat * (180.0 / PI)) * 86400.0 / (6.371e6 * max(cos(lat), 0.15));
}
vec3 rotLon(vec3 p, float dl) {
  float c = cos(dl), s = sin(dl);
  return vec3(c * p.x + s * p.z, p.y, c * p.z - s * p.x);
}

// the two flow phases of a body-frame direction pb: sample directions (for noise) and longitude shifts (for the map)
struct CloudPhases { vec3 qA; vec3 qB; float dA; float dB; float wA; };
CloudPhases cloudPhases(vec3 pb) {
  CloudPhases P;
  float lat = asin(clamp(pb.y, -1.0, 1.0));
  float om = zonalRate(lat);
  P.dA = -om * (uFlow.x + uFlow.y);
  P.dB = -om * (uFlow.x + uFlow.z);
  P.qA = rotLon(pb, P.dA);
  P.qB = rotLon(pb, P.dB);
  P.wA = uFlow.w;
  return P;
}

// blended (two-phase) map value at a mip level, for cheap lookups (self-shadow march)
float cloudMapLod(vec3 pb, float lod) {
  CloudPhases P = cloudPhases(pb);
  vec2 uv0 = vec2(atan(-pb.z, pb.x) * (0.5 / PI) + 0.5, asin(clamp(pb.y, -1.0, 1.0)) / PI + 0.5);
  float mA = textureLod(uClouds, vec2(uv0.x + P.dA * (0.5 / PI), uv0.y), lod).r;
  float mB = textureLod(uClouds, vec2(uv0.x + P.dB * (0.5 / PI), uv0.y), lod).r;
  return mix(mB, mA, P.wA);
}

// logistic helpers (s = scale)
float logistic(float x) { return 1.0 / (1.0 + exp(-x)); }

// map value -> (in-cloud albedo A, coverage c) with A * c = the map's layer reflectance R0
vec2 cloudAC(float m) {
  float R0 = smoothstep(0.045, 0.9, m);
  R0 = R0 * R0 * (3.0 - 2.0 * R0) * 0.35 + R0 * 0.65;
  float A = mix(0.42, 0.93, smoothstep(0.25, 0.95, R0));
  float c = clamp(R0 / A, 0.0, 1.0);
  return vec2(A, c);
}

// procedural sub-texel field for one phase. Returns vec4(n_resolved, d n / d q); varU = variance of the
// unresolved remainder (the nominal total variance is cloudVarT()). gBump: gradient for the cloud-top shape, with the
// fine octaves de-emphasised (they read as hammered metal as normals).
// q: cloud-frame direction (unit), fp: pixel footprint (radians), cellW: stratocumulus-cell regime weight,
// cellSign: +1 closed / -1 open cells, streak: storm-track streak weight, skew: cumulus regime (positively skewed
// octaves => separate puffs on clear ground instead of perforated sheets), t / sT: the coverage threshold and the total
// logistic scale (for the edge-localised fine detail).
// Statistics measured on the CPU (dev/snstat): Ashima 3D simplex std 0.373; Worley F1 std 0.173 (mean 0.52).
// Octave amplitudes: the energy sits at 15-20 km (Worley + first simplex octave) so that cloud bodies, not km-sized
// holes, dominate from low orbit; the spectrum then falls ~0.6 per octave.
// Below ~3 km the spectrum steepens (gain 0.55): fine octaves only roughen the edges of the cloud bodies; with the
// self-similar gain all the way down a 50-70 % coverage texel became a perforated lace of km-sized holes.
float octAmp(int i) { return i == 0 ? 0.18 : (i == 1 ? 0.08 : 0.05 * pow(0.55, float(i - 2))); }
const float AW = 0.34;                // Worley blob / cell octave amplitude
// fine octaves (>= 2, < ~3 km) enter the coverage threshold at reduced weight LF and mostly modulate the optical
// thickness (brightness texture) instead: thresholding them at full weight punched a lace of pixel-sized holes into
// every 50-70 % coverage texel
#define LF 0.55
float cloudVarT() {
  float v = 0.0;
  for (int i = 0; i < 8; i++) { float a = octAmp(i) * (i >= 2 ? LF : 1.0); v += a * a * 0.139; }
  return v + AW * AW * 0.03;
}
vec4 cloudNoise(vec3 q, vec3 seed, vec3 w, float fp, int maxOct, float cellW, float cellSign, float streak,
                float skew, float t, float sT, out float varU, out vec3 gBump, out float fineV) {
  vec4 s = vec4(0.0);
  gBump = vec3(0.0);
  varU = 0.0;
  fineV = 0.0;
  // ~21 km cellular octave: rounded cumulus-cluster blobs (Gaussian blob field) or, over the subtropical oceans, closed /
  // open stratocumulus cells. The cell-wall term is soft and wide (real closed-cell walls are thinner cloud, not
  // cracks) and widened by the footprint so it can never alias into a crack network.
  {
    const float fc = 300.0;
    float v2 = AW * AW * 0.03;
    // resolved from ~3.5 px per cell, fully from ~10 px (the blobs are ~0.4 cell wide; thresholding them any earlier
    // turns near-pixel-size features into a net of 1-px lines)
    float wt = clamp(1.0 / (fc * fp) * 0.15 - 0.5, 0.0, 1.0);
    if (uDebug == 30) wt = 0.0;
    varU += v2 * (1.0 - wt * wt);
    if (wt > 0.0) {
      vec3 r1, r2; vec4 B;
      vec2 F = worleyD(q * fc + w * 0.35 + seed * 0.37, r1, r2, B);
      // Gaussian blob field normalised to the F1 statistics it replaces (mean 0.2872, std 0.3071 -> 0.173)
      float blob = (B.x - 0.2872) * 0.563;
      vec3 gblob = B.yzw * 0.563;
      float ww = 0.55 + 3.0 * fc * fp;
      float u = clamp((F.y - F.x) / ww, 0.0, 1.0);
      float se = u * u * (3.0 - 2.0 * u), dse = 6.0 * u * (1.0 - u) / ww;
      vec3 ge = r2 / max(F.y, 1e-3) - r1 / max(F.x, 1e-3);
      float cell = (0.22 * (se - 0.5) + 0.62 * blob) * cellSign;
      vec3 gcell = (0.22 * dse * ge + 0.62 * gblob) * cellSign;
      // clumpiness varies from place to place (a stationary single-scale texture reads as a pattern)
      float clump = mix(0.35 + 0.65 * smoothstep(-0.35, 0.45, w.x), 1.0, cellW);
      float a = wt * AW * clump;
      vec3 g3 = mix(gblob, gcell, cellW) * fc;
      s += a * vec4(mix(blob, cell, cellW), g3);
      gBump += a * g3;
    }
  }
  // storm tracks: raise the domain frequency along the pole axis, so features elongate east-west (along the wind)
  float sy = 1.0 + 1.6 * streak;
  float f = 420.0;                   // ~15 km simplex base (the map itself carries the >= 40 km structure)
  float gd = 1.0;
  float m = 1.0;
  for (int i = 0; i < uLoopMax; i++) {
    if (i >= 8) break;
    if (i == 2) {
      // edge-localised fine detail (Schneider-style erosion): deep inside a cloud mass or far out in clear air the
      // fine octaves cannot cross the threshold (solid decks, clean gaps, no perforation); near the coarse edge they
      // are amplified (fractal, eroded, cauliflower edges)
      float z = (s.x - t) / max(sT, 1e-4);
      m = mix(0.3, 1.0, exp(-0.5 * z * z));
    }
    float a = octAmp(i) * (i >= 2 ? m * LF : 1.0);
    float v2 = a * a * 0.139;
    float qpx = 1.0 / (f * fp);               // pixels per noise unit
    float wt = i < maxOct ? clamp(qpx * 0.15 - 0.5, 0.0, 1.0) : 0.0;    // 3.3 .. 10 px per noise unit
    if (uDebug == 31 && i >= 1) wt = 0.0;
    if (uDebug == 32 && i >= 2) wt = 0.0;
    varU += v2 * (1.0 - wt * wt);
    if (wt > 0.0) {
      // gentle domain warp (moves with the cloud): a fixed fraction of the noise unit, so it never swirls
      vec3 x = q * f + w * 0.3 + seed + float(i) * vec3(1.7, 9.2, 3.1);
      x.y *= sy;
      vec4 n = snoised(x);
      vec3 gq = n.yzw * f;
      gq.y *= sy;
      float nn = n.x, gk = 1.0;
      if (skew > 0.0 && i >= 1 && i <= 2) {
        float pz = max(nn, 0.0);
        nn += skew * (pz * pz - 0.07);
        gk = 1.0 + 2.0 * skew * pz;
      }
      s += wt * a * vec4(nn, gq * gk);
      if (i >= 2) fineV += wt * a * nn / LF;
      gBump += (wt * a * gd * gk) * gq;
    }
    gd *= 0.7;
    f *= 2.13;
  }
  return s;
}

// Cloud layer reflectance R (two-stream layer albedo, 0..1) at body-frame direction pb (cloud altitude).
// uv0: map UV of pb, g: its screen gradients; fp: pixel footprint (radians); maxOct: octave cap.
// Outputs grad = gradient of the local cloud-top height (scene units per radian, body frame) for the volume shading,
// R0mean (the map's mean reflectance) and hTop (local cloud-top relief, scene units).
float cloudField(vec3 pb, vec2 uv0, vec4 g, float fp, int maxOct, float oceanW, out vec3 grad, out float R0mean, out float hTop) {
  float lat = asin(clamp(pb.y, -1.0, 1.0));
  float latD = abs(lat) * (180.0 / PI);
  float om = zonalRate(lat);
  float cl = sqrt(max(1.0 - pb.y * pb.y, 0.0));
  // sub-texel warp of the map lookup itself (the map's own shapes continue below its resolution). Displacements are
  // kept under ~0.15 of each warp octave's wavelength: stronger warps of a smooth bilinear map turn it into marbled,
  // liquid swirls.
  float warpW = smoothstep(CLOUD_TEXEL * 1.2, CLOUD_TEXEL * 0.3, fp) * uDetail;
  float w2 = smoothstep(CLOUD_TEXEL * 0.5, CLOUD_TEXEL * 0.15, fp);
  vec2 sc = warpW * vec2(1.0 / (2048.0 * max(cl, 0.08)), 1.0 / 1024.0);
  // pass 1: the map (two flow phases)
  float m = 0.0;
  vec3 q0 = pb, q1 = pb, w0 = vec3(0.0), w1 = vec3(0.0);
  float dl0 = 0.0, dl1 = 0.0;
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 2) break;
    float dl = -om * (uFlow.x + (k == 0 ? uFlow.y : uFlow.z));
    vec3 seed = k == 0 ? uSeedA : uSeedB;
    vec3 q = rotLon(pb, dl);
    if (k == 0) { q0 = q; dl0 = dl; } else { q1 = q; dl1 = dl; }
    vec2 u = vec2(uv0.x + dl * (0.5 / PI), uv0.y);
    if (warpW > 0.0 && uDebug != 34) {
      vec3 a1 = q * 95.0 + seed, a2 = q * 290.0 + seed.zxy;
      vec2 wv = vec2(snoise(a1), snoise(a1 + vec3(19.1, 7.3, 3.7)));
      u += (0.55 * wv + 0.22 * w2 * vec2(snoise(a2), snoise(a2 + vec3(5.3, 1.9, 8.1)))) * sc;
      vec3 wk = vec3(wv, wv.x * wv.y * 2.0);
      if (k == 0) w0 = wk; else w1 = wk;
    }
    m += textureGrad(uClouds, u, g.xy, g.zw).r * (k == 0 ? uFlow.w : 1.0 - uFlow.w);
  }
  vec2 AC = cloudAC(m);
  R0mean = AC.x * AC.y;
  float c = AC.y;
  grad = vec3(0.0);
  hTop = 0.0;
  if (uDetail <= 0.0 || c <= 0.002 || uDebug == 33) return R0mean;
  // regimes
  float subtrop = smoothstep(8.0, 16.0, latD) * smoothstep(42.0, 30.0, latD);
  float cellW = subtrop * oceanW * smoothstep(0.25, 0.55, c) * 0.75;
  float streak = smoothstep(28.0, 42.0, latD) * smoothstep(68.0, 55.0, latD) * 0.5;
  float cellSign = mix(-0.6, 1.0, smoothstep(0.3, 0.6, c));
  // cumulus: thin, broken cloud outside the cell and storm-track regimes
  float skew = 0.0 * (1.0 - cellW) * max(1.0 - 1.6 * streak, 0.0) * smoothstep(0.62, 0.47, AC.x);
  // total variance and the threshold
  float varT = cloudVarT();
  float sT = sqrt(varT) * 0.5513;                 // logistic scale (s = sigma * sqrt(3) / pi)
  // dense decks: the gaps between cloud bodies are rarely clear, they hold thin cloud (a floor fraction fl of the
  // in-cloud reflectance); the threshold coverage c' is lowered so the mean still equals the map: c' + (1 - c') fl = c
  float fl = 0.4 * smoothstep(0.55, 0.92, c);
  float cc = clamp((c - fl) / (1.0 - fl), 0.002, 0.998);
  float t = sT * log((1.0 - cc) / cc);
  // pass 2: the procedural field, blended variance-preserving (Heitz-Neyret) so the crossfade never washes out
  float wA = uFlow.w, wB = 1.0 - uFlow.w;
  float nrm = inversesqrt(max(wA * wA + wB * wB, 1e-4));
  vec4 n = vec4(0.0);
  vec3 gb = vec3(0.0);
  float varU = 0.0, fine = 0.0;
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 2) break;
    float wk = (k == 0 ? wA : wB) * nrm;
    float vU, fk; vec3 gbk;
    vec4 nk = cloudNoise(k == 0 ? q0 : q1, k == 0 ? uSeedA : uSeedB, k == 0 ? w0 : w1, fp, maxOct, cellW, cellSign, streak, skew, t, sT, vU, gbk, fk);
    fine += wk * fk;
    // gradients back from the phase's advected frame to the body frame
    float dl = k == 0 ? dl0 : dl1;
    n += wk * vec4(nk.x, rotLon(nk.yzw, -dl));
    gb += wk * rotLon(gbk, -dl);
    varU = vU;                            // both phases share the same spectrum
  }
  // analytic AA: the resolved field must not change by more than ~ the transition width across one pixel
  float gpx = length(n.yzw - pb * dot(n.yzw, pb)) * fp;
  // edge softness floor: thin (stratiform / cirrus) cloud has soft edges, thick convective cloud crisp ones
  float soft = mix(0.004, 0.0003, smoothstep(0.45, 0.85, AC.x));
  float sU = sqrt(varU + soft) * 0.5513 + 0.55 * gpx;
  float cov = logistic((n.x - t) / max(sU, 1e-4));
  cov = cov + (1.0 - cov) * fl;
  // interior texture where resolved: cores optically thicker (brighter) than the thin, eroded edges
  float res = clamp(1.0 - varU / max(varT, 1e-6), 0.0, 1.0);
  float core = smoothstep(0.0, 2.5 * sT, n.x - t);
  float R = AC.x * cov * mix(1.0, mix(0.74, 1.05, core), res);
  // fine structure as optical-thickness texture (tufts, thin spots) inside the cloud bodies
  R *= clamp(1.0 + 3.0 * fine * core, 0.55, 1.3);
  R = min(R, 0.97);
  // cloud-top height field: a dome rising steeply from the (softened) edge and flattening inside the mass, so
  // cumulus have lit tops / shaded flanks and decks have gentle undulations. Amplitude by regime: stratocumulus tops
  // vary by a few hundred metres, cumulus ~1.5 km, deep convective masses several km.
  float Hc = KM * mix(mix(2.4, 7.0, smoothstep(0.78, 0.93, AC.x)), 0.5, cellW) * (1.0 - 0.5 * streak);
  float su = max(sU / sT, 0.05);
  float zz = (n.x - t) / sT;
  float x = zz / su;
  float zp = x > 15.0 ? zz : su * log(1.0 + exp(x));
  float dzp = logistic(x);
  float ex = exp(-1.3 * zp);
  // the dome shading only where the cloud bodies are well resolved (> ~6 px): barely resolved domes shade into a
  // pixel-scale light / dark rim net
  float domeW = smoothstep(0.00042, 0.00012, fp) * res;
  hTop = Hc * (1.0 - ex) * res;
  // + turreted tops: the interior keeps a gentle relief (~0.25 Hc per logistic unit) so cloud masses are not flat
  grad = (Hc * (1.3 * ex * dzp + 0.25 * dzp) / sT) * gb * domeW;
  return R;
}
`;
