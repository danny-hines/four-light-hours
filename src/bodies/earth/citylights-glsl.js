// City lights below the Black Marble's ~10 km texels: a hashed point-light field (included by earth-radiance.js).
//
// Lights live on a 3D jittered lattice; only lattice points within half a cell of the sphere count (a one-cell-thick
// slab => one candidate per cell^2 of surface, seamless everywhere, no projection seams or pole pinching). Each
// candidate is switched on with a probability set by the local Black Marble radiance (sparse bright villages in the
// countryside, a continuous carpet downtown, more lights along a ridged "road" network), gets a lognormal
// brightness and a lamp type (high-pressure sodium vs white LED), and is drawn as a normalised Gaussian whose width
// is never less than the pixel footprint - so the field is analytically anti-aliased (no moire, no shimmer) and
// its mean is exactly the texture radiance at every distance (levels fade to their mean of 1 once a cell is
// smaller than ~3 px). Multiplicative cascade of three levels: towns (10 km cells, ~2 km glow), districts / road
// junctions (2 km cells), individual lamps (0.5 km). One flattened loop (level x 27 lattice cells): the compiled
// program holds a single copy of the lamp code.
export const CITYLIGHTS_GLSL = /* glsl */ `
// Pixel footprint as a covariance in the tangent plane (radians^2, basis e1 / e2): from the screen derivatives of
// the surface direction, so grazing views get thin, correctly projected points instead of smeared ellipses.
struct Footprint { vec3 e1; vec3 e2; vec3 C; };   // C = (cxx, cxy, cyy)

// City-light radiance (contract units) at body-frame direction pb. M = Black Marble radiance at the pixel (already
// restored to linear), Mt = raw texture value, fpc = pixel footprint covariance.
vec3 cityLights(vec3 pb, float M, float Mt, Footprint fpc) {
  // lamp mix: ~35 % white LED on average, varying regionally (national retrofit programmes), a little whiter in the
  // brightest cores (mixed commercial lighting)
  float pLED = clamp(0.33 + 0.24 * tn(pb * 2.6 + vec3(7.0, 1.0, 3.0)).x + 0.12 * smoothstep(0.55, 0.95, Mt), 0.06, 0.8);
  const vec3 SODIUM = vec3(1.0, 0.43, 0.12), LED = vec3(1.0, 0.86, 0.68);
  vec3 col = mix(SODIUM, LED, pLED);
  float w = 1.0;
  if (uDetail > 0.0 && M > 0.0) {
    float carpet = smoothstep(0.45, 0.95, Mt) * 0.55;
    float road = pow(1.0 - abs(tn(pb * 640.0).x), 5.0);         // ridged network of arterial roads
    vec4 acc = vec4(0.0);
    float F = 640.0, sigL = 0.2, fade = 0.0, pOn = 1.0, pBase = 1.0, nrm = 1.0, seed = 3.7;
    vec3 X = vec3(0.0), c0 = vec3(0.0), Ci = vec3(1.0);
    for (int i = 0; i < uLoopMax; i++) {
      if (i >= 81) break;
      int lvl = i / 27, k = i - lvl * 27;
      if (k == 0) {
        // level setup: cell size, lamp size, footprint fade (the 3x3x3 search is exact while the total footprint
        // stays below ~0.36 cell), probability of a lamp being on
        F = lvl == 0 ? 640.0 : (lvl == 1 ? 3200.0 : 13000.0);
        sigL = lvl == 0 ? 0.2 : 0.07;
        vec3 C = fpc.C * (F * F);
        float lmax = 0.5 * (C.x + C.z) + sqrt(0.25 * (C.x - C.z) * (C.x - C.z) + C.y * C.y);
        fade = smoothstep(0.36, 0.24, sqrt(sigL * sigL + lmax)) * uDetail;
        if (fade <= 0.0) break;                                    // finer levels are unresolved too
        pBase = lvl == 0 ? clamp(0.15 + 1.5 * Mt, 0.15, 1.0) : (lvl == 1 ? clamp(0.3 + 1.2 * Mt, 0.3, 1.0) : clamp(0.45 + Mt, 0.45, 1.0));
        pOn = clamp(pBase * (lvl == 1 ? 0.5 + 2.6 * road : 1.0), 0.02, 1.0);
        seed = 3.7 + 7.6 * float(lvl);
        X = pb * F;
        c0 = floor(X);
        C += vec3(sigL * sigL, 0.0, sigL * sigL);
        float det = C.x * C.z - C.y * C.y;
        Ci = vec3(C.z, -C.y, C.x) / det;
        nrm = 1.0 / (6.2832 * sqrt(det));
        acc = vec4(0.0);
      }
      vec3 cell = c0 + vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
      vec3 h = hash33(cell + seed);
      vec3 xp = cell + h;
      float rr = length(xp);
      vec3 d3 = xp * (F / rr) - X;
      vec2 d = vec2(dot(d3, fpc.e1), dot(d3, fpc.e2));
      float q = Ci.x * d.x * d.x + 2.0 * Ci.y * d.x * d.y + Ci.z * d.y * d.y;
      vec3 h2 = hash33(cell * 1.618 + seed + 17.0);
      if (abs(rr - F) <= 0.5 && q <= 12.0 && h2.x <= pOn) {
        // lognormal brightness (sigma_ln ~1.2), lamp type
        float gw = exp(2.4 * (h2.y + h2.z + h.x - 1.5) - 0.5 * q) * nrm;
        acc += gw * vec4(mix(SODIUM, LED, step(h2.y * 0.37 + h2.z * 0.63, pLED)), 1.0);
      }
      if (k == 26) {
        // E[lum] = exp(0.5 * 2.4^2 * 0.25) = 2.05; mean candidate density 1 per cell^2; road-modulated level E = 0.9
        acc /= 2.05 * max(pOn, 1e-3);
        float lw = mix(acc.w * (pOn / pBase) / (lvl == 1 ? 0.9 : 1.0), 1.0, carpet);
        w *= mix(1.0, lw, fade);
        col = mix(col, acc.w > 1e-3 ? acc.rgb / acc.w : col, fade * smoothstep(0.0, 0.05, acc.w));
      }
    }
  }
  vec3 L = col * (w * M);
  // brightest cores: overexposed sodium + mixed light reads yellow-white (as in every ISS night photograph); soft clamp
  float pk = max(max(L.r, L.g), L.b);
  L = mix(L, vec3(pk) * vec3(1.0, 0.86, 0.62), smoothstep(0.15, 1.2, pk) * 0.45);
  return L / (1.0 + max(max(L.r, L.g), L.b) / 12.0);
}
`;
