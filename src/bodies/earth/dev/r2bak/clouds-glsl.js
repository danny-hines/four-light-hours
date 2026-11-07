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

// procedural sub-texel field for one phase. Returns vec4(n_resolved, d n / d p); varU = variance of the
// unresolved remainder (the total variance is cloudVarT()). gBump: gradient for the cloud-top relief.
// q: cloud-frame direction (unit), fp: pixel footprint (radians), cellW: stratocumulus-cell regime weight,
// cellSign: +1 closed / -1 open cells, streak: storm-track streak weight.
// Statistics measured on the CPU (dev/snstat): Ashima 3D simplex std 0.373; Worley F1 std 0.173 (mean 0.52);
// cell-wall term 0.7 (smoothstep(0, 0.4, F2 - F1) - 0.42) + 0.6 (0.52 - F1): std ~0.32.
// Octave amplitudes: a small first simplex octave, then a peak and gain 0.62 (H ~ 0.7, cloud-edge fractal
// dimension ~1.3; rougher spectra read as lace).
float octAmp(int i) { return i == 0 ? 0.09 : 0.17 * pow(0.62, float(i - 1)); }
const float AW = 0.42;                // Worley blob / cell octave amplitude
float cloudVarT() {
  float v = 0.0;
  for (int i = 0; i < 8; i++) { float a = octAmp(i); v += a * a * 0.139; }
  return v + AW * AW * 0.03;
}
vec4 cloudNoise(vec3 q, vec3 seed, vec3 w, float fp, int maxOct, float cellW, float cellSign, float streak, out float varU, out vec3 gBump) {
  vec4 s = vec4(0.0);
  gBump = vec3(0.0);
  varU = 0.0;
  // w: gentle domain warp (moves with the cloud, so features keep their shape as they drift)
  // ~21 km Worley octave: rounded cumulus-cluster blobs (F1 profile) or, over the subtropical oceans,
  // closed / open stratocumulus cells. Thresholding a positively skewed blob field gives separate clouds instead
  // of the worm-like mazes of a thresholded symmetric fbm.
  {
    const float fc = 300.0;
    float vb = mix(0.03, 0.10, cellW);              // variance of the blob vs the cell term
    float v2 = AW * AW * vb;
    float wt = clamp(1.0 / (fc * fp) * 0.3 - 0.45, 0.0, 1.0);
    varU += v2 * (1.0 - wt * wt);
    if (wt > 0.0) {
      vec2 F = worleyD(q * fc + w * 0.6 + seed * 0.37);
      float blob = 0.52 - F.x;
      float e = F.y - F.x;                           // 0 on the cell walls
      float cell = (0.7 * (smoothstep(0.0, 0.4, e) - 0.42) + 0.6 * blob) * cellSign;
      // clumpiness varies from place to place (a stationary single-scale texture reads as a pattern)
      float clump = mix(0.35 + 0.65 * smoothstep(-0.35, 0.45, w.x), 1.0, cellW);
      s.x += wt * AW * clump * mix(blob, cell, cellW);
    }
  }
  // storm tracks: raise the domain frequency along the pole axis, so features elongate east-west (along the wind)
  float sy = 1.0 + 1.6 * streak;
  float f = 420.0;                   // ~15 km simplex base (the map itself carries the >= 40 km structure)
  float gd = 1.0;
  for (int i = 0; i < uLoopMax; i++) {
    if (i >= 8) break;
    float a = octAmp(i);
    float v2 = a * a * 0.139;
    float qpx = 1.0 / (f * fp);               // pixels per noise unit
    float wt = i < maxOct ? clamp(qpx * 0.32 - 0.6, 0.0, 1.0) : 0.0;
    varU += v2 * (1.0 - wt * wt);
    if (wt > 0.0) {
      vec3 x = q * f + w * (0.55 + 0.1 * float(i)) + seed + float(i) * vec3(1.7, 9.2, 3.1);
      x.y *= sy;
      vec4 n = snoised(x);
      vec3 gq = n.yzw * f;
      gq.y *= sy;
      s += wt * a * vec4(n.x, gq);
      // bump gradient: dominated by the larger octaves (fine octaves as normals read as hammered metal)
      gBump += (wt * wt * a * gd) * gq;
    }
    gd *= 0.5;
    f *= 2.13;
  }
  return s;
}

// Cloud layer reflectance R (two-stream layer albedo, 0..1) at body-frame direction pb (cloud altitude).
// uv0: map UV of pb, g: its screen gradients; fp: pixel footprint (radians); maxOct: octave cap.
// Outputs grad (d n / d p in the body frame) for the cloud-top bump and R0 (the map's mean reflectance).
float cloudField(vec3 pb, vec2 uv0, vec4 g, float fp, int maxOct, float oceanW, out vec3 grad, out float R0mean) {
  float lat = asin(clamp(pb.y, -1.0, 1.0));
  float latD = abs(lat) * (180.0 / PI);
  float om = zonalRate(lat);
  float cl = sqrt(max(1.0 - pb.y * pb.y, 0.0));
  // sub-texel warp of the map lookup itself (the map's own shapes continue below its resolution)
  float warpW = smoothstep(CLOUD_TEXEL * 1.2, CLOUD_TEXEL * 0.3, fp) * uDetail;
  float w2 = smoothstep(CLOUD_TEXEL * 0.5, CLOUD_TEXEL * 0.15, fp);
  vec2 sc = warpW * vec2(1.0 / (2048.0 * max(cl, 0.08)), 1.0 / 1024.0);
  // pass 1: the map (two flow phases)
  float m = 0.0;
  vec3 q0 = pb, q1 = pb, w0 = vec3(0.0), w1 = vec3(0.0);
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 2) break;
    float dl = -om * (uFlow.x + (k == 0 ? uFlow.y : uFlow.z));
    vec3 seed = k == 0 ? uSeedA : uSeedB;
    vec3 q = rotLon(pb, dl);
    if (k == 0) q0 = q; else q1 = q;
    vec2 u = vec2(uv0.x + dl * (0.5 / PI), uv0.y);
    if (warpW > 0.0) {
      // two-octave (fractal) warp: the map's 20 km texel outlines never show as smooth bilinear blobs; the first
      // octave doubles as the procedural field's domain warp
      vec3 a1 = q * 95.0 + seed, a2 = q * 290.0 + seed.zxy;
      vec2 wv = vec2(snoise(a1), snoise(a1 + vec3(19.1, 7.3, 3.7)));
      u += (1.5 * wv + 0.7 * w2 * vec2(snoise(a2), snoise(a2 + vec3(5.3, 1.9, 8.1)))) * sc;
      vec3 wk = vec3(wv, wv.x * wv.y * 2.0);
      if (k == 0) w0 = wk; else w1 = wk;
    }
    m += textureGrad(uClouds, u, g.xy, g.zw).r * (k == 0 ? uFlow.w : 1.0 - uFlow.w);
  }
  vec2 AC = cloudAC(m);
  R0mean = AC.x * AC.y;
  float c = AC.y;
  grad = vec3(0.0);
  if (uDetail <= 0.0 || c <= 0.002) return R0mean;
  // regimes
  float subtrop = smoothstep(8.0, 16.0, latD) * smoothstep(42.0, 30.0, latD);
  float cellW = subtrop * oceanW * smoothstep(0.25, 0.55, c) * 0.75;
  float streak = smoothstep(28.0, 42.0, latD) * smoothstep(68.0, 55.0, latD) * 0.5;
  float cellSign = mix(-0.6, 1.0, smoothstep(0.3, 0.6, c));
  // pass 2: the procedural field, blended variance-preserving (Heitz-Neyret) so the crossfade never washes out
  float wA = uFlow.w, wB = 1.0 - uFlow.w;
  float nrm = inversesqrt(max(wA * wA + wB * wB, 1e-4));
  vec4 n = vec4(0.0);
  vec3 gb = vec3(0.0);
  float varU = 0.0;
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 2) break;
    float wk = (k == 0 ? wA : wB) * nrm;
    float vU; vec3 gbk;
    n += wk * cloudNoise(k == 0 ? q0 : q1, k == 0 ? uSeedA : uSeedB, k == 0 ? w0 : w1, fp, maxOct, cellW, cellSign, streak, vU, gbk);
    gb += wk * gbk;
    varU = vU;                            // both phases share the same spectrum
  }
  // total variance: the Worley term's variance depends on the regime
  float varT = cloudVarT() + AW * AW * (mix(0.03, 0.10, cellW) - 0.03);
  // logistic scales (s = sigma * sqrt(3) / pi)
  float sT = sqrt(varT) * 0.5513;
  // analytic AA: the resolved field must not change by more than ~ the transition width across one pixel
  float gpx = length(n.yzw - pb * dot(n.yzw, pb)) * fp;
  // edge softness floor: thin (stratiform / cirrus) cloud has soft edges, thick convective cloud crisp ones
  float soft = mix(0.004, 0.0003, smoothstep(0.45, 0.85, AC.x));
  float sU = sqrt(varU + soft) * 0.5513 + 0.55 * gpx;
  float cc = clamp(c, 0.002, 0.998);
  float t = sT * log((1.0 - cc) / cc);
  float cov = logistic((n.x - t) / max(sU, 1e-4));
  // interior texture where resolved: cores optically thicker (brighter) than the thin, eroded edges
  float res = clamp(1.0 - varU / max(varT, 1e-6), 0.0, 1.0);
  float core = smoothstep(0.0, 2.5 * sT, n.x - t);
  float R = AC.x * cov * mix(1.0, mix(0.78, 1.05, core), res);
  // cloud-top relief: only where there is cloud
  grad = gb * cov;
  return R;
}
`;
