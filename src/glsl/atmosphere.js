// Physically based single-scattering atmosphere (Rayleigh + Mie + optional absorption layer).
// Work in planet-local, camera-relative space: planet centre at the origin, distances in scene units.
//
// Typical shell usage (render a BackSide sphere of radius Ra AFTER the opaque planet, with
// CustomBlending: blendSrc = OneFactor, blendDst = SrcAlphaFactor, so out = scatter + dst * transmittance):
//   vec3 ro = cameraPosLocal;  vec3 rd = normalize(fragPosLocal - ro);
//   vec2 ta = raySphere(ro, rd, P.Ra);            // atmosphere entry/exit
//   vec2 tp = raySphere(ro, rd, P.Rp);            // planet hit
//   float t0 = max(ta.x, 0.0), t1 = (tp.x > 0.0) ? min(ta.y, tp.x) : ta.y;
//   vec3 T; vec3 L = atmosphereScatter(ro, rd, t0, t1, sunDirLocal, P, T);
//   gl_FragColor = vec4(L * sunIntensity, dot(T, vec3(1.0/3.0)));
//
// Earth in scene units (1 unit = 6371 km): Rp = 1.0, Ra = 1.0 + 60/6371, HR = 8/6371, HM = 1.2/6371,
//   betaR = vec3(5.802, 13.558, 33.1) * 1e-6 * 6.371e6, betaM = vec3(3.996e-6) * 6.371e6, g = 0.8,
//   ozone absorption betaA = vec3(0.650, 1.881, 0.085) * 1e-6 * 6.371e6 centred at 25 km, half-width 15 km.
export const ATMOSPHERE_GLSL = /* glsl */ `
#ifndef ATMOSPHERE_GLSL
#define ATMOSPHERE_GLSL
#ifndef PI
#define PI 3.14159265359
#endif
#ifndef ATMO_STEPS
#define ATMO_STEPS 16
#endif
#ifndef ATMO_LIGHT_STEPS
#define ATMO_LIGHT_STEPS 6
#endif

struct AtmoParams {
  float Rp;      // planet radius
  float Ra;      // top of atmosphere radius
  vec3 betaR;    // Rayleigh scattering coefficient (per scene unit)
  float HR;      // Rayleigh scale height
  vec3 betaM;    // Mie scattering coefficient
  float HM;      // Mie scale height
  float g;       // Mie anisotropy (0.76 .. 0.9)
  vec3 betaA;    // absorption coefficient of a tent-shaped layer (e.g. ozone); vec3(0) to disable
  float hA;      // absorption layer centre altitude
  float wA;      // absorption layer half width
};

// Ray / sphere (centred at origin). Returns (tNear, tFar); tNear > tFar means no hit.
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(1e20, -1e20);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

float phaseRayleigh(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseMie(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5));
}

vec3 atmoExtinction(float h, AtmoParams P, out float dR, out float dM) {
  dR = exp(-max(h, 0.0) / P.HR);
  dM = exp(-max(h, 0.0) / P.HM);
  float dA = max(0.0, 1.0 - abs(h - P.hA) / max(P.wA, 1e-6));
  return P.betaR * dR + P.betaM * 1.11 * dM + P.betaA * dA;
}

// Optical depth (extinction integral) from p toward the sun, to the top of the atmosphere.
vec3 atmoOpticalDepthToSun(vec3 p, vec3 sunDir, AtmoParams P) {
  vec2 ts = raySphere(p, sunDir, P.Ra);
  float len = max(ts.y, 0.0);
  float ds = len / float(ATMO_LIGHT_STEPS);
  vec3 od = vec3(0.0);
  for (int j = 0; j < ATMO_LIGHT_STEPS; j++) {
    vec3 q = p + sunDir * (ds * (float(j) + 0.5));
    float dR, dM;
    od += atmoExtinction(length(q) - P.Rp, P, dR, dM) * ds;
  }
  return od;
}

// Soft planet-shadow factor for sunlight reaching point p (0 = fully shadowed by the planet).
float atmoPlanetShadow(vec3 p, vec3 sunDir, float Rp) {
  float b = dot(p, sunDir);
  float d2 = dot(p, p) - b * b;           // squared distance from planet centre to the sun ray
  if (b > 0.0) return 1.0;                 // point is on the day side of the terminator plane
  float d = sqrt(max(d2, 0.0));
  return smoothstep(Rp * 0.995, Rp * 1.004, d);
}

// Single scattering along ro + rd * [t0, t1]. Returns in-scattered radiance per unit sun intensity.
// transmittance receives the extinction along the segment (apply it to whatever lies behind).
vec3 atmosphereScatter(vec3 ro, vec3 rd, float t0, float t1, vec3 sunDir, AtmoParams P, out vec3 transmittance) {
  transmittance = vec3(1.0);
  if (t1 <= t0) return vec3(0.0);
  float ds = (t1 - t0) / float(ATMO_STEPS);
  vec3 sumR = vec3(0.0), sumM = vec3(0.0), odView = vec3(0.0);
  float mu = dot(rd, sunDir);
  for (int i = 0; i < ATMO_STEPS; i++) {
    vec3 p = ro + rd * (t0 + ds * (float(i) + 0.5));
    float h = length(p) - P.Rp;
    float dR, dM;
    vec3 ext = atmoExtinction(h, P, dR, dM) * ds;
    odView += ext;
    float sh = atmoPlanetShadow(p, sunDir, P.Rp);
    if (sh > 0.0) {
      vec3 att = exp(-(odView - ext * 0.5 + atmoOpticalDepthToSun(p, sunDir, P))) * sh;
      sumR += att * dR * ds;
      sumM += att * dM * ds;
    }
  }
  transmittance = exp(-odView);
  return sumR * P.betaR * phaseRayleigh(mu) + sumM * P.betaM * phaseMie(mu, P.g);
}

// Sunlight transmittance at a surface point (for reddening the terminator on the ground).
vec3 atmoSunTransmittance(vec3 p, vec3 sunDir, AtmoParams P) {
  return exp(-atmoOpticalDepthToSun(p, sunDir, P)) * atmoPlanetShadow(p, sunDir, P.Rp * 0.999);
}
#endif
`;
