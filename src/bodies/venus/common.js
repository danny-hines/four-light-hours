// Venus — shared physical constants and GLSL used by the cloud-deck and haze shaders.
//
// Vertical structure (km above the 6051.8 km solid surface):
//   ~68 km   "deck": the visible-light cloud top (unit optical depth seen from above). Opaque mesh.
//   68-90    cloud-top aerosol (mode-2 H2SO4 droplets, r ~ 1 um), scale height ~4.2 km
//   70-110   upper haze (mode-1, r ~ 0.2-0.4 um), scale height ~6 km, thicker over the poles
//   90-200   tenuous extended haze (scale height ~11 km), tapered to zero below the shell top
//   ~92      a faint detached haze layer (Venus Express VMC/SPICAV)
//   CO2 Rayleigh above the cloud top: tau ~ 0.006 at 550 nm (2.4x air per molecule, ~40 mbar)
// The aerosol is nearly grey in the visible (H2SO4 droplets ~0.3-1 um): the limb glows cream-white, not blue.
// Everything is in scene units (1 = 6371 km) once multiplied by KM.
export const KM = 1 / 6371;
export const R_SURF_KM = 6051.8;
export const DECK_ALT_KM = 68;
export const TOP_ALT_KM = 200;

// Haze components: vertical optical depth above the deck at 550 nm, scale height, Angstrom-like spectral factors (R,G,B).
export const HAZE = {
  aer: { tau: 0.15, H: 4.2, spec: [1.0, 1.0, 1.0] }, // cloud-top mode-2 droplets (r ~ 1 um): grey in the visible
  up: { tau: 0.12, H: 6.0, spec: [0.98, 1.0, 1.02] }, // upper haze, mode-1 (r ~ 0.25 um), thicker over the poles
  ext: { tau: 0.18, H: 13.0, spec: [0.99, 1.0, 1.01] }, // tenuous high haze to ~150-200 km (lit far past the terminator)
  det: { tau: 0.006, h: 26, w: 3.0, spec: [1.0, 1.0, 1.0] }, // detached layer ~94 km (VEx SPICAV/SOIR, VMC limb)
  ray: { tau: 0.006, H: 4.5, spec: [0.47, 1.0, 2.35] }, // CO2 at ~200 K: H ~ 4.5 km, below the haze's own
};

export const VENUS_COMMON_GLSL = /* glsl */ `
#ifndef PI
#define PI 3.14159265359
#endif
uniform float uRd;            // deck radius
uniform float uRt;            // haze top radius
uniform vec3 uAerB;           // cloud-top aerosol scattering coefficient at the deck (per unit), RGB
uniform vec3 uUpB;            // upper-haze scattering coefficient at the deck
uniform vec3 uDetB;           // detached-layer peak scattering coefficient
uniform vec3 uRayB;           // CO2 Rayleigh scattering coefficient at the deck
uniform vec3 uExtB;           // extended high-haze scattering coefficient at the deck
uniform vec4 uHgt;            // H_aer, H_up, H_ray, H_ext   (scene units)
uniform vec2 uDet;            // detached layer height above deck, half width (scene units)
uniform vec3 uHazeOmega;      // single-scattering albedo of the aerosol (slightly absorbing in the blue)
uniform vec4 uPhA;            // aerosol phase function: forward-lobe weight, forward g, back-lobe weight, back g

vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }

// Thicker upper haze over the poles (Venus Express: tau of the upper haze rises poleward of ~55 deg).
float polarHaze(float y) { return 1.0 + 1.6 * smoothstep(0.78, 0.97, abs(y)); }
// Taper of the haze densities toward the shell top (no visible edge where the shell ends).
float hazeTaper(float h) { return 1.0 - smoothstep(0.55, 1.0, h / (uRt - uRd)); }

// Henyey-Greenstein, normalised to a sphere average of 1.
float hg(float g, float c) { float g2 = g * g; return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-5), 1.5); }
// H2SO4 haze droplet phase function: a two-term Henyey-Greenstein fit to the Mie phase function of the ~0.3-1 um
// droplets: a strong forward lobe (diffraction + refraction, g ~ 0.8) and a weak backscatter lobe.
float phaseAer(float c) { return (1.0 - uPhA.z) * hg(uPhA.y, c) + uPhA.z * hg(uPhA.w, c); }
float phaseRay(float c) { return 0.75 * (1.0 + c * c); }

// Schueler's approximation to the Chapman grazing-incidence function (GPU Pro 3), in units of the 50%-height.
// X: reference radius / H50, h: altitude above it / H50. Returns slant column / (beta0 * H).
float chapman50(float X, float h, float coschi) {
  float c = sqrt(X + h);
  if (coschi >= 0.0) return c / (c * coschi + 1.0) * exp2(-h);
  float x0 = sqrt(max(1.0 - coschi * coschi, 0.0)) * (X + h);
  float c0 = sqrt(x0);
  return 2.0 * c0 * exp2(min(X - x0, 0.0)) - c / (1.0 - c * coschi) * exp2(-h);
}
float chapmanTau(float r, float coschi, float H) {
  const float LN2 = 0.69314718;
  float H50 = H * LN2;
  return H * chapman50(uRd / H50, (r - uRd) / H50, coschi);
}

// Delta-scaling factor applied to aerosol extinction (the forward diffraction peak is treated as unscattered).
#define AER_EXT 0.6

// Optical depth (RGB) from a point at radius r toward the Sun with cos(zenith) = mu; ignores the planet shadow.
vec3 tauToSun(float r, float mu, float pol) {
  vec3 t = ((uAerB * chapmanTau(r, mu, uHgt.x) + uUpB * chapmanTau(r, mu, uHgt.y)) * pol
            + uExtB * chapmanTau(r, mu, uHgt.w)) * AER_EXT / uHazeOmega;
  t += uRayB * chapmanTau(r, mu, uHgt.z);
  return t;
}
// 1 where the Sun is above the deck horizon of a point at radius r with sun zenith cosine mu, else 0.
float sunVisible(float r, float mu) {
  return (mu < 0.0 && r * sqrt(max(1.0 - mu * mu, 0.0)) < uRd) ? 0.0 : 1.0;
}
// Sunlight transmittance at radius r, sun zenith cosine mu: zero where the Sun is below the deck.
vec3 sunTransmittance(float r, float mu, float pol) {
  return exp(-tauToSun(r, mu, pol)) * sunVisible(r, mu);
}
`;
