// Shared GLSL for Mars, Phobos and Deimos: gradient noise with analytic derivatives, crater fields with
// analytic gradients and bowl shadows, Chapman grazing-incidence optical depth, small photometric helpers.
export const MARS_COMMON = /* glsl */ `
#ifndef MARS_COMMON
#define MARS_COMMON
#ifndef PI
#define PI 3.14159265359
#endif

// ---- hashes (Dave Hoskins, "hash without sine", MIT) ----
vec3 mh33(vec3 p3) { p3 = fract(p3 * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yxz + 33.33); return fract((p3.xxy + p3.yxx) * p3.zyx); }
vec4 mh43(vec3 p) { vec4 p4 = fract(vec4(p.xyzx) * vec4(.1031, .1030, .0973, .1099)); p4 += dot(p4, p4.wzxy + 33.33); return fract((p4.xxyz + p4.yzzw) * p4.zywx); }
float mh13(vec3 p3) { p3 = fract(p3 * .1031); p3 += dot(p3, p3.zyx + 31.32); return fract((p3.x + p3.y) * p3.z); }

// ---- 3D gradient noise with analytic derivatives: returns (value ~[-1,1], d/dx, d/dy, d/dz) ----
// Simplex lattice (4 corners, Gustavson-style falloff (0.6 - r^2)^4 with its exact gradient). It replaced an 8-corner
// quintic gradient noise: FXC (ANGLE/D3D) compiles it ~2.4x faster and it runs faster. Calibrated (Monte Carlo) to
// the old noise's statistics: value RMS 0.31 and gradient RMS 1.38 per unit input, so every amplitude and
// footprint fade written for the old noise still holds (input scaled by 0.64, output by 32.5).
vec4 gnoised(vec3 xin) {
  vec3 x = xin * 0.64;
  vec3 s = floor(x + dot(x, vec3(1.0 / 3.0)));
  vec3 x0 = x - s + dot(s, vec3(1.0 / 6.0));
  vec3 e = step(vec3(0.0), x0 - x0.yzx);
  vec3 i1 = e * (1.0 - e.zxy);
  vec3 i2 = 1.0 - e.zxy * (1.0 - e);
  vec3 x1 = x0 - i1 + 1.0 / 6.0;
  vec3 x2 = x0 - i2 + 1.0 / 3.0;
  vec3 x3 = x0 - 0.5;
  vec3 g0 = mh33(s) * 2.0 - 1.0, g1 = mh33(s + i1) * 2.0 - 1.0, g2 = mh33(s + i2) * 2.0 - 1.0, g3 = mh33(s + 1.0) * 2.0 - 1.0;
  vec4 w = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  vec4 d = vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3));
  vec4 w2 = w * w, w3 = w2 * w, w4 = w2 * w2;
  vec3 gr = -8.0 * (w3.x * d.x * x0 + w3.y * d.y * x1 + w3.z * d.z * x2 + w3.w * d.w * x3) + w4.x * g0 + w4.y * g1 + w4.z * g2 + w4.w * g3;
  return vec4(32.5 * dot(w4, d), 20.8 * gr);
}

// Chapman grazing-incidence function for an exponential atmosphere: optical depth from radius r toward
// zenith cosine mu, in units of (local density x scale height). X = r / H.
float chapman(float X, float mu) {
  float c = sqrt(1.5707963 * X);
  if (mu >= 0.0) return c / ((c - 1.0) * mu + 1.0);
  float sz = sqrt(max(1.0 - mu * mu, 0.0));
  float Xp = X * sz;
  float cp = sqrt(1.5707963 * Xp);
  return 2.0 * cp * exp(min(X - Xp, 60.0)) - c / ((c - 1.0) * (-mu) + 1.0);
}

// Fraction of the solar disc (angular radius as) hidden by a disc of angular radius ao at separation th.
float discOcclusion(float th, float as, float ao) {
  if (th >= as + ao) return 0.0;
  float full = min(1.0, (ao * ao) / (as * as));
  if (th <= abs(as - ao)) return full;
  float t = (as + ao - th) / (2.0 * min(as, ao));
  return full * smoothstep(0.0, 1.0, t);
}

float hgPhase(float mu, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}
vec3 hgPhase3(float mu, vec3 g) { return vec3(hgPhase(mu, g.r), hgPhase(mu, g.g), hgPhase(mu, g.b)); }

// ---- Martian dust optics at the sRGB primaries' effective wavelengths (~610 / 545 / 465 nm) ----
// r_eff ~1.5 um (size parameter x ~15-20). Three lobes, split by physics rather than by a single fit:
//   1. diffraction peak (non-absorbing, so neutral in colour; ~3-4 deg wide, narrower in the blue). It carries
//      half of the scattered light in the red but ~3/4 in the blue, because the dust absorbs strongly in the
//      blue and absorption removes only the refracted / internally reflected light;
//   2. the refracted forward-broad lobe (g ~0.45-0.5) -- this is the absorbing, COLOURED part that carries the
//      light at 20-150 deg: why the Martian sky and limb haze are butterscotch while the sunset aureole is blue;
//   3. a weak backscatter lobe (internal reflections, also absorbing).
// Red matches the Pathfinder-derived phase function (Tomasko et al. 1999: P(30) ~1.5, P(90) ~0.3, P(150) ~0.29);
// single-scattering albedo between the Pathfinder / Viking lander values (Tomasko 1999, Pollack 1995) and CRISM
// (Wolff et al. 2009).
const vec3 DUST_OMEGA = vec3(0.972, 0.85, 0.65);
const vec3 DUST_FD = vec3(0.514, 0.588, 0.769); // diffraction-peak fraction (= Q_diff / Q_sca = 0.5 / omega)
const vec3 DUST_GD = vec3(0.955, 0.962, 0.97);  // diffraction-peak asymmetry (narrower in the blue)
const vec3 DUST_FBK = vec3(0.08, 0.06, 0.045);  // backscatter lobe fraction (g = -0.3)
const vec3 DUST_GB = vec3(0.45, 0.47, 0.5);     // refracted forward-broad lobe asymmetry
// delta-Eddington extinction (the diffraction peak stays in the beam: tau' = tau (1 - omega f_D)): used for
// sunlight reaching the ground and for the ground seen through the haze. Nearly grey, very slightly bluer
// than red: the direct + aureole light at sunset is bluish, as the rovers see it.
const vec3 DUST_EXT = vec3(0.50, 0.50, 0.50);
vec3 dustPhase(float mu) {
  return DUST_FD * hgPhase3(mu, DUST_GD) + (vec3(1.0) - DUST_FBK - DUST_FD) * hgPhase3(mu, DUST_GB)
       + DUST_FBK * hgPhase(mu, -0.3);
}
// the broad (non-diffraction) part of the phase function only (sr^-1)
vec3 dustPhaseBroad(float mu) {
  return (vec3(1.0) - DUST_FBK - DUST_FD) * hgPhase3(mu, DUST_GB) + DUST_FBK * hgPhase(mu, -0.3);
}

// One octave of a crater field on a small body (Phobos, Deimos) of radius Rk (km). pk = point (km), n = unit
// normal. Adds height (km), 3D gradient (km/km), albedo modulation and bowl-shadow visibility.
// S = cell size (km); dens = presence probability; freshK skews toward degraded craters; w = LOD weight;
// Lt = unit sun direction in the tangent plane, tanE = tan(sun elevation); seed decorrelates octaves.
// Fresh craters: d/D ~0.2 paraboloid bowls with a SHARP crest (C1 break) and power-law ejecta thickness
// ~(r/R)^-3; degraded ones: shallow, infilled flat floors and rounded crests. Fresh material on Phobos is the
// brighter, bluer 'blue unit' regolith: fresh walls and ejecta are brighter, falling off as (r/R)^-2.5.
// (one cell k of the 2x2x2 neighbourhood per call: the caller runs octaves x cells as ONE loop, so FXC compiles
// a single copy of this body)
void craterCell(vec3 pk, vec3 n, vec3 e1, vec3 e2, float Rk, float S, float dens, float freshK, float w, float seed, int k,
                vec3 Lt, float tanE, float fp, inout float h, inout vec3 g, inout float alb, inout float vis, inout float rimMask) {
  vec3 i0 = floor(pk / S - 0.5);
  {
    vec3 cell = i0 + vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec4 r4 = mh43(cell + seed);
    if (r4.w > dens) return;
    vec3 c = (cell + 0.2 + 0.6 * mh33(cell + seed * 1.37 + 11.1)) * S;
    float rc = length(c);
    if (abs(rc - Rk) > 0.5 * S) return;
    vec3 dv = pk - c * (Rk / rc);
    dv -= n * dot(dv, n);
    float rr0 = S * (0.06 + 0.24 * r4.x * r4.x);
    float dist = length(dv);
    if (dist > 2.3 * 1.1 * rr0) return;
    vec4 q4 = mh43(cell + seed * 2.11 + 5.3);
    // slightly polygonal rim: 3- and 5-fold harmonics of the azimuth via Chebyshev polynomials (no atan / sin)
    float ca = dot(dv, e1) / max(dist, 1e-7), sa = dot(dv, e2) / max(dist, 1e-7);
    vec4 qa = q4 * 2.0 - 1.0;
    float rr = rr0 * (1.0 + 0.055 * (qa.x * ca * (4.0 * ca * ca - 3.0) + qa.y * sa * (3.0 - 4.0 * sa * sa))
                          + 0.035 * (qa.z * ca * (16.0 * ca * ca * ca * ca - 20.0 * ca * ca + 5.0) + qa.w * sa * (16.0 * sa * sa * sa * sa - 20.0 * sa * sa + 5.0)));
    float xr = dist / rr;
    if (xr > 2.3) return;
    float fresh = pow(r4.y, freshK);
    float D = 2.0 * rr0;
    float depth = D * mix(0.06, 0.2, fresh * fresh);
    float rim = D * mix(0.006, 0.04, fresh);
    float ff = 0.55 * (1.0 - fresh);
    float del = min(0.03 + 0.3 * (1.0 - fresh) + 1.2 * fp / rr, 0.6);
    float t = clamp((xr - ff) / (1.0 - ff), 0.0, 1.0);
    float hin = -depth + (depth + rim) * t * t;
    float din = (xr < 1.0 && xr > ff) ? 2.0 * (depth + rim) * t / (1.0 - ff) : 0.0;
    float pw = mix(1.6, 3.2, fresh);
    float xo = max(xr, 1.0);
    float win = 1.0 - smoothstep(1.7, 2.3, xr);
    float tw = clamp((xr - 1.7) / 0.6, 0.0, 1.0);
    float hraw = rim * pow(xo, -pw);
    float hout = hraw * win;
    float dout = (xr > 1.0 ? -pw * hraw / xo : 0.0) * win - hraw * 6.0 * tw * (1.0 - tw) / 0.6;
    float ts = clamp((xr - 1.0 + del) / (2.0 * del), 0.0, 1.0);
    float sb = ts * ts * (3.0 - 2.0 * ts);
    float hh = mix(hin, hout, sb);
    float dh = mix(din, dout, sb) + (hout - hin) * 6.0 * ts * (1.0 - ts) / (2.0 * del);
    h += w * hh;
    g += w * (dh / rr) * (dv / max(dist, 1e-7));
    // albedo: fresh walls and ejecta brighter (less space-weathered), old floors slightly darker (fines)
    float fr2 = fresh * fresh;
    float a = xr < 1.0 ? (0.45 * fr2 * smoothstep(0.3, 0.95, xr) - 0.1 * (1.0 - fresh) * (1.0 - xr * xr))
                       : 0.4 * fr2 * pow(xr, -2.5) * win;
    alb += w * a;
    rimMask = max(rimMask, w * fresh * exp(-abs(xr - 1.0) * 8.0));
    if (xr < 1.0 && tanE < 3.0) {
      float qu = dot(dv, Lt);
      float s = -qu + sqrt(max(rr * rr - dist * dist + qu * qu, 0.0));
      float clear = hh + s * tanE - rim;
      float soft = 0.004 * s + 0.02 * rr + 0.6 * fp * max(tanE, 0.05);
      vis = min(vis, mix(1.0, smoothstep(-soft, soft, clear), w));
    }
  }
}

#endif
`;
