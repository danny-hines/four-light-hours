// City lights below the Black Marble's ~10 km texels: a hashed point-light field (included by earth-radiance.js).
//
// Lights live on a 3D jittered lattice; only lattice points within half a cell of the sphere count (a one-cell-thick
// slab => one candidate per cell^2 of surface, seamless everywhere, no projection seams or pole pinching). Each
// candidate is switched on with a probability set by the local Black Marble radiance (sparse bright villages in the
// countryside, a continuous carpet downtown, more lights along a ridged "road" network), gets a lognormal
// brightness and a lamp type (high-pressure sodium vs white LED), and is drawn as a normalised Gaussian whose width
// is never less than the pixel footprint - so the field is analytically anti-aliased (no moire, no shimmer) and
// its mean is exactly the texture radiance at every distance (levels fade to their mean of 1 once a cell is
// smaller than ~3 px). Two levels: settlements (~5 km) x individual lights (~0.9 km).
export const CITYLIGHTS_GLSL = /* glsl */ `
// Pixel footprint as a covariance in the tangent plane (radians^2, basis e1 / e2): from the screen derivatives of
// the surface direction, so grazing views get thin, correctly projected points instead of smeared ellipses.
struct Footprint { vec3 e1; vec3 e2; vec3 C; };   // C = (cxx, cxy, cyy)

// one level: returns vec4(colour-weighted sum, sum) with mean (meanCol, 1), given p(on)
vec4 cityLevel(vec3 pb, float F, Footprint fpc, float pOn, float pLED, float sigL, float seed) {
  vec3 X = pb * F;
  vec3 c0 = floor(X);
  // total covariance in cells^2: lamp size + pixel footprint (0.36 px^2 ~ a box pixel's variance x 4)
  vec3 C = fpc.C * (F * F) + vec3(sigL * sigL, 0.0, sigL * sigL);
  float det = C.x * C.z - C.y * C.y;
  vec3 Ci = vec3(C.z, -C.y, C.x) / det;
  float nrm = 1.0 / (6.2832 * sqrt(det));
  vec4 acc = vec4(0.0);
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 27) break;
    vec3 cell = c0 + vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec3 h = hash33(cell + seed);
    vec3 xp = cell + h;
    float rr = length(xp);
    if (abs(rr - F) > 0.5) continue;               // only the one-cell slab around the surface
    vec3 d3 = xp * (F / rr) - X;
    vec2 d = vec2(dot(d3, fpc.e1), dot(d3, fpc.e2));
    float q = Ci.x * d.x * d.x + 2.0 * Ci.y * d.x * d.y + Ci.z * d.y * d.y;
    if (q > 12.0) continue;
    vec3 h2 = hash33(cell * 1.618 + seed + 17.0);
    if (h2.x > pOn) continue;
    // lognormal brightness (sigma_ln ~1.2; mean normalised below)
    float lum = exp(2.4 * (h2.y + h2.z + h.x - 1.5));
    float led = step(h2.y * 0.37 + h2.z * 0.63, pLED);
    float gw = lum * exp(-0.5 * q) * nrm;
    acc += gw * vec4(mix(vec3(1.0, 0.43, 0.12), vec3(1.0, 0.86, 0.68), led), 1.0);
  }
  // E[lum] = exp(0.5 * 2.4^2 * 0.25) = 2.05;  mean candidate density = 1 per cell^2
  return acc / (2.05 * max(pOn, 1e-3));
}

// City-light radiance (contract units) at body-frame direction pb. M = Black Marble radiance at the pixel
// (already restored to linear), Mt = raw texture value, fpc = pixel footprint covariance.
// Multiplicative cascade of three levels (each of mean 1): towns (10 km cells, ~2 km glow), districts / road
// junctions (2 km cells), individual lamps (0.5 km). A level is drawn while its Gaussians stay narrower than ~0.35
// cell (pixel footprint included) and fades to its mean of 1 beyond, so the field is exact on average and never
// aliases. Dense cores keep part of a continuous carpet.
vec3 cityLights(vec3 pb, float M, float Mt, Footprint fpc) {
  // lamp mix: dense cores mostly sodium (older), suburbs more white LED
  float pLED = mix(0.55, 0.22, smoothstep(0.35, 0.85, Mt));
  vec3 meanCol = mix(vec3(1.0, 0.43, 0.12), vec3(1.0, 0.86, 0.68), pLED);
  if (uDetail <= 0.0 || M <= 0.0) return meanCol * M;
  float carpet = smoothstep(0.45, 0.95, Mt) * 0.55;
  float road = pow(1.0 - abs(snoise(pb * 640.0)), 5.0);         // ridged network of arterial roads
  float w = 1.0;
  vec3 col = meanCol;
  for (int k = 0; k < uLoopMax; k++) {
    if (k >= 3) break;
    float F = k == 0 ? 640.0 : (k == 1 ? 3200.0 : 13000.0);
    float sigL = k == 0 ? 0.2 : 0.07;                          // town glow; then point-like lamps / junctions
    // largest axis of the total footprint (cells): the 3x3x3 neighbourhood is exact while it stays below ~0.36
    vec3 Cc = fpc.C * (F * F);
    float lmax = 0.5 * (Cc.x + Cc.z) + sqrt(0.25 * (Cc.x - Cc.z) * (Cc.x - Cc.z) + Cc.y * Cc.y);
    float fade = smoothstep(0.36, 0.24, sqrt(sigL * sigL + lmax)) * uDetail;
    if (fade <= 0.0) break;                                      // finer levels are unresolved too
    float pBase = k == 0 ? clamp(0.15 + 1.5 * Mt, 0.15, 1.0) : (k == 1 ? clamp(0.3 + 1.2 * Mt, 0.3, 1.0) : clamp(0.45 + Mt, 0.45, 1.0));
    float rm = k == 1 ? (0.5 + 2.6 * road) : 1.0;               // E[rm] ~ 0.9 for k == 1
    float pOn = clamp(pBase * rm, 0.02, 1.0);
    vec4 c = cityLevel(pb, F, fpc, pOn, pLED, sigL, 3.7 + 7.6 * float(k));
    float lw = c.w * (pOn / pBase) / (k == 1 ? 0.9 : 1.0);
    lw = mix(lw, 1.0, carpet);
    w *= mix(1.0, lw, fade);
    col = mix(col, c.w > 1e-3 ? c.rgb / c.w : col, fade * smoothstep(0.0, 0.05, c.w));
  }
  // soft clamp of the brightest point cores (bloom does the rest)
  vec3 L = col * (w * M);
  return L / (1.0 + max(max(L.r, L.g), L.b) / 12.0);
}
`;
