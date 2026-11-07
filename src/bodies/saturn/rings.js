// Saturn's rings: main system (D, C, B, Cassini Division, A with Encke/Keeler gaps, eccentric F ring) and the faint
// dusty G and E rings. Photometry of a classical many-particle-thick layer on BOTH faces:
//   lit face   I/F = w P(a)/4 * mu0/(mu+mu0) * (1 - exp(-tau (1/mu + 1/mu0)))
//   unlit face I/F = w P(a)/4 * mu0/(mu-mu0) * (exp(-tau/mu) - exp(-tau/mu0))     (diffuse transmission)
// with a backscattering particle phase function plus a forward-scattering dust population, so the B ring is
// bright on the lit face and nearly black on the unlit face while the C ring / Cassini Division are translucent,
// and dusty rings glow when backlit. Analytic planet shadow, Saturnshine, A-ring wake asymmetry, B-ring spokes.
import * as THREE from 'three';
import { RING_GLSL } from './rings-glsl.js';
import { SS_R0, SS_R1 } from './rings-data.js';

// The ring sheet is a plane, not a sphere: main.js's near plane (from bounding spheres) would clip it under the
// camera in a low ring skim. So the ring geometry is clipped only at uNear2 (a quarter of the camera's distance to
// the ring sheet) and every fragment writes its true depth for the real camera projection (gl_FragDepth). Ring
// fragments closer than the global near plane get depth 1 (reversed Z: nearest), i.e. in front of everything,
// which is exactly what they are.
// Nearly edge-on rings far away project to a sub-pixel ellipse and would rasterize as a dotted line that crawls in
// motion. Below a minimum projected opening (minor semi-axis of the A ring ~0.9 px) the drawn sheet is tilted open
// a little more about the axis across the line of sight (uTilt, set in saturn.js), and the fragment output is scaled
// by uCover = true / drawn projected area, so the total flux and the mean transmission are conserved. Shading still
// uses the true plane position (vRing) and the true viewing geometry.
const VERT = /* glsl */ `
uniform float uNear2;
uniform vec4 uTilt;   // xy: unit horizontal direction to the camera (ring frame), z: tan(extra tilt) signed
varying vec3 vRing;
varying float vViewZ;
void main() {
  vRing = position;
  vec3 pd = position;
  pd.y -= uTilt.z * dot(position.xz, uTilt.xy);
  vec4 mv = viewMatrix * modelMatrix * vec4(pd, 1.0);
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position.z = gl_Position.w - uNear2;        // ZERO_TO_ONE clip volume: 0 <= z <= w  <=>  w >= uNear2
#else
  gl_Position.z = gl_Position.w - 2.0 * uNear2;  // -w <= z <= w  <=>  w >= uNear2
#endif
}`;

// true depth of this fragment for the real camera projection
const DEPTH_GLSL = /* glsl */ `
uniform mat4 projectionMatrix;
varying float vViewZ;
void satWriteDepth() {
  float Z = max(vViewZ, 1e-12);
  float ndc = (projectionMatrix[3][2] - projectionMatrix[2][2] * Z) / Z;
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_FragDepth = clamp(ndc, 0.0, 1.0);
#else
  gl_FragDepth = clamp(0.5 * ndc + 0.5, 0.0, 1.0);
#endif
}`;

// Saturnshine table size (rings-data.js computeSaturnshine defaults)
const SS_NR = 40, SS_NA = 32;
// near-field 'straw' octaves: radial size hr (km), Ku (cant: integer cells per revolution in the across coordinate,
// tan 21 deg at 110,000 km), Nv (integer cells per revolution along the orbit: length 15-23 hr), amplitude
const STRAW_GLSL = [[12, 15, 0.16], [4, 20, 0.14], [1.3, 23, 0.11]]
  .map(([hr, asp, amp]) => {
    const r = 110000, Ku = Math.round((2 * Math.PI * r * Math.tan((21 * Math.PI) / 180)) / hr), Nv = Math.round((2 * Math.PI * r) / (hr * asp));
    return `vec4(${hr.toFixed(2)}, ${Ku.toFixed(1)}, ${Nv.toFixed(1)}, ${amp.toFixed(3)})`;
  })
  .join(', ');

const FRAG = /* glsl */ `
${RING_GLSL}
${DEPTH_GLSL}
uniform vec3 uCamR;      // camera, ring frame (Saturn radii)
uniform vec3 uSunR;      // sun direction, ring frame
uniform vec3 uSunColor;
uniform float uFlat;
uniform float uHalf;     // +1: far half (behind the planet's centre plane), -1: near half
uniform float uHours;    // simulated hours (wrapped) for spokes
uniform float uFApse;    // F-ring longitude of periapsis (rad)
uniform vec3 uPlanetAlb; // mean planet albedo colour (Saturnshine)
uniform float uGain;     // eclipse exposure assist (see saturn.js)
uniform float uCover;    // edge-on coverage factor (see VERT)
uniform int uDebug;
uniform sampler2D uSShine; // Saturnshine on both faces vs (radius, |azimuth from the sub-solar meridian|), rings-data.js
uniform float uSSLift;     // display lift of planet light where it is the only light (saturn.js; 1 in eclipse)
varying vec3 vRing;
#define SS_R0 ${SS_R0.toFixed(4)}
#define SS_R1 ${SS_R1.toFixed(4)}
#define SS_NR ${SS_NR.toFixed(1)}
#define SS_NA ${SS_NA.toFixed(1)}

// integer hash -> [-1, 1] (exact for the large cell indices of the near-field lattice)
float strawHash(int i, int j, int s) {
  uint h = uint(i) * 1597334677u ^ uint(j) * 3812015801u ^ uint(s) * 2654435761u;
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return float(h) * (2.0 / 4294967295.0) - 1.0;
}
// Value noise on a canted, azimuthally elongated lattice that wraps seamlessly around the ring: across-coordinate
// u = r / hr + Ku * phi/2pi (constant-u lines trail inward at ~21 deg to the orbit, like the self-gravity wakes and
// the A-ring 'straw'), along-coordinate v = Nv * phi/2pi. Ku and Nv are integers, so u and v shift by whole periods
// at phi = +-pi. xa = phi / 2pi + 1 (positive).
float strawNoise(float xr, float xa, vec4 P, int seed) {
  float u = xr / P.x + P.y * xa, v = P.z * xa;
  float iu = floor(u), iv = floor(v);
  vec2 f = vec2(u - iu, v - iv);
  f = f * f * (3.0 - 2.0 * f);
  int K = int(P.y), M = int(P.z);
  int i0 = int(iu) % K, i1 = (int(iu) + 1) % K, j0 = int(iv) % M, j1 = (int(iv) + 1) % M;
  return mix(mix(strawHash(i0, j0, seed), strawHash(i1, j0, seed), f.x), mix(strawHash(i0, j1, seed), strawHash(i1, j1, seed), f.x), f.y);
}

// --- F ring: eccentric core + strands + dusty envelope; returns tau (footprint-filtered), dust fraction in dust
float gaussF(float x, float s, float fp) {
  float se = sqrt(s * s + 0.09 * fp * fp);
  return (s / se) * exp(-0.5 * x * x / (se * se));
}
float fRingTau(float rkm, float phi, float fp, out float dustOut) {
  float a = 140221.0, e = 0.00235;
  float rc = a * (1.0 - e * cos(phi - uFApse));
  float x = rkm - rc;
  if (abs(x) > 1500.0) { dustOut = 1.0; return 0.0; }
  // clumpy core (azimuthal brightness variations), strands drift with a kinked spiral
  float xa = phi / 6.2831853;
  float clump = 0.55 + 0.45 * gnoise1p(xa * 1131.0, 1131.0) * gnoise1p(xa * 233.0 + 0.5, 233.0) + 0.35 * gnoise1p(xa * 384.0 + 0.2, 384.0);
  float core = 0.65 * max(clump, 0.15) * gaussF(x - 1.5 * sin(phi * 23.0), 1.6, fp);
  float strands = 0.0;
  for (int i = 0; i < 4 + uSatZero; i++) {
    float fi = float(i);
    float off = (fi - 1.5) * 38.0 + 22.0 * sin(phi * (3.0 + fi) + fi * 2.1) + 30.0 * (fi - 1.5) * sin(phi + fi);
    strands += (0.028 - 0.005 * fi) * gaussF(x - off, 5.0 + 2.0 * fi, fp);
  }
  // (core: cm-to-m particles that also reflect at low phase, so the F ring stays a distinct thread on the lit face)
  float env = 0.005 * gaussF(x, 260.0, fp) + 0.002 * gaussF(x - 300.0, 500.0, fp);
  float t = core * 1.3 + strands + env;
  dustOut = (core * 1.3 * 0.2 + strands * 0.8 + env) / max(t, 1e-6);
  return t;
}

// --- B-ring spokes (Cassini, Mitchell et al. 2013): diffuse, wedge-shaped clouds of sub-micron dust lifted above
// the B ring. Each forms within minutes along a radial line that co-rotates with the magnetic field, then every
// radius drifts at its own Keplerian rate (the spoke shears) while it fades over a couple of hours.
float spokes(float rkm, float phi) {
  float s = 0.0;
  const float GM = 3.7931e7; // km^3/s^2
  float omK = sqrt(GM / (rkm * rkm * rkm)) * 3600.0;     // rad/hour at this radius
  float omM = 6.2831853 / 10.656;                         // magnetic field rotation, rad/hour
  float radial = smoothstep(96000.0, 102000.0, rkm) * (1.0 - smoothstep(114000.0, 118000.0, rkm));
  if (radial <= 0.0) return 0.0;
  for (int k = 0; k < 12 + uSatZero; k++) {
    float fk = float(k);
    float life = 4.0 + 3.0 * satHash1(fk * 7.1);
    float tt = uHours + fk * 1.37 * life;
    float cyc = floor(tt / life);
    float age = tt - cyc * life;                           // hours since birth
    float seed = satHash1(cyc * 13.7 + fk * 3.3);
    float phiB = seed * 6.2831853 + omM * (uHours - age);  // birth longitude (rotates with the field)
    float phiC = phiB + omK * age;                         // Keplerian drift of this radius since birth
    float d = mod(phi - phiC + 3.14159265, 6.2831853) - 3.14159265;
    float rc = 101000.0 + 8000.0 * satHash1(seed * 5.0);
    float hw = 3500.0 + 4000.0 * satHash1(seed * 9.0);
    float x = (rkm - rc) / hw;
    // wedge: wider toward its ends, Gaussian edges in azimuth, soft flat-topped radial extent
    float wid = (0.006 + 0.010 * satHash1(seed * 91.0)) * (0.7 + 0.6 * abs(x)) * (1.0 + 0.25 * age);
    float prof = exp(-0.5 * d * d / (wid * wid));
    float rad = exp(-0.5 * x * x * x * x);
    float fade = smoothstep(0.0, 0.25, age) * exp(-age / 1.6);
    s += fade * rad * prof * (0.6 + 0.4 * satHash1(seed * 3.7));
  }
  return s * radial;
}

void main() {
  satWriteDepth();
  vec3 p = vec3(vRing.x, 0.0, vRing.z);
  float rr = length(p.xz);
  float rkm = rr * SAT_RKM;
  vec2 er = p.xz / max(rr, 1e-6);
  vec2 eo = vec2(er.y, -er.x); // prograde orbital direction
  // footprints (computed before any discard)
  vec3 dpx = dFdx(p), dpy = dFdy(p);
  float fpR = max(max(abs(dot(dpx.xz, er)), abs(dot(dpy.xz, er))) * SAT_RKM, 1e-3);   // radial footprint (km)
  float fpT = max(length(vec2(dot(dpx.xz, eo), dot(dpy.xz, eo))) * SAT_RKM, 1e-3);
  float fineW;
  vec4 T = ringTauState(rkm, fpR, fineW);
  vec4 al = ringAlbedo(rkm, fpR);

  vec3 toC = uCamR - p;
  float dist = length(toC);
  vec3 v = toC / dist;
  float side = dot(p, -normalize(uCamR));
  if (side * uHalf < 0.0) discard;
  if (rkm < 66600.0 || rkm > 141700.0) discard;

  float phi = atan(-p.z, p.x);
  float mu = max(abs(v.y), 1e-3);
  float mu0 = max(abs(uSunR.y), 1e-3);
  bool lit = v.y * uSunR.y > 0.0;
  float cosT = -dot(v, uSunR); // cos scattering angle (1 = forward)
  float m = 1.0 / mu, m0 = uRingM0;

  // add the F ring (separate population) and spokes (thin dust over the B ring)
  float dustF;
  float tauF = fRingTau(rkm, phi, fpR, dustF);
  float tauS = 0.0045 * spokes(rkm, phi) * (1.0 - smoothstep(400.0, 2500.0, fpT));

  // A-ring self-gravity wakes: azimuthal brightness/transmission asymmetry
  float aMask = smoothstep(122500.0, 124500.0, rkm) * (1.0 - smoothstep(134000.0, 136700.0, rkm));
  vec2 wdir = normalize(eo * 0.934 - er * 0.358); // canted ~21 deg, trailing
  vec2 vp = v.xz;
  float vpl = length(vp);
  float c2 = vpl > 1e-4 ? 2.0 * pow(dot(vp / vpl, wdir), 2.0) - 1.0 : 0.0;
  float wakeA = aMask * 0.16 * (1.0 - mu) * c2;

  // near-field particle texture. Cassini's closest ring images (Grand Finale, ~0.5-1 km/px) show the dense rings
  // broken into streaky and clumpy textures that run along the orbit: fine radial ringlets that wander slowly in
  // azimuth, and 'straw' -- elongated clumps (aspect 1:10-1:30) canted ~20 deg to the orbit by the Keplerian shear,
  // with gaps between them. Every octave is drawn only where it is resolved (full strength to ~1.5 px per feature,
  // gone by ~1.3 px), radially AND azimuthally, so nothing moires or shimmers. Azimuth uses periodic noise (no seam
  // at phi = +-pi). It modulates tau (translucent rings) and, in the opaque rings where tau no longer changes the
  // reflectivity, the particle brightness.
  float streak = 0.0;
  {
    float xa = phi / 6.2831853;
    float xr = rkm - RING_R0;
    float c0 = 6.2831853 * rkm / 2048.0, c1 = 6.2831853 * rkm / 8192.0;
    float w0 = (1.0 - smoothstep(0.45, 0.75, fpR / 9.0)) * (1.0 - smoothstep(0.45, 0.75, fpT / c0));
    float w1 = (1.0 - smoothstep(0.45, 0.75, fpR / 2.5)) * (1.0 - smoothstep(0.45, 0.75, fpT / c1));
    if (w0 > 0.0) {
      float sh = xa * 2048.0 + xr * 0.004;                           // slight cant: shear
      float n0 = gnoise1(xr / 9.0 + 3.0 * gnoise1p(sh, 2048.0) + 6.0 * gnoise1p(xa * 256.0 + 0.7, 256.0));
      streak += 0.10 * w0 * n0;
      if (w1 > 0.0) streak += 0.08 * w1 * gnoise1(xr / 2.5 + 4.0 * gnoise1p(xa * 8192.0, 8192.0) + 9.0 * gnoise1p(xa * 1024.0 + 0.3, 1024.0));
    }
    // straw: three octaves of clumps (radial size hr = 12, 4, 1.3 km), contrast-shaped into clumps and gaps
    const vec4 STRAW[3] = vec4[3](${STRAW_GLSL});
    for (int k = 0; k < 3 + uSatZero; k++) {
      vec4 P = STRAW[k];
      float la = 6.2831853 * rkm / P.z;
      float wk = (1.0 - smoothstep(0.45, 0.75, fpR / P.x)) * (1.0 - smoothstep(0.45, 0.75, fpT / la));
      if (wk <= 0.0) break;
      float n = strawNoise(xr, xa + 1.0, P, 17 + k);
      streak += P.w * wk * (smoothstep(-0.45, 0.55, n) - 0.5);
    }
  }
  float streakT = streak * smoothstep(0.15, 0.6, T.x);
  float streakB = streak * smoothstep(0.5, 1.5, T.x) * 0.9;

  // optical depths for the three slab terms
  float tauV = tauAt(T, m) * (1.0 + streakT) + tauF;
  float tauL = tauAt(T, m + m0) * (1.0 + streakT) + tauF;
  float tauU = tauAt(T, 0.5 * (m + m0)) * (1.0 + streakT) + tauF;

  float S;
  float tauMain = max(T.x, 1e-6);
  if (lit) {
    // dense-layer correction (Salo & Karjalainen 2003): in a close-packed ring the sunlit and the visible particles
    // are the same top layer, so the reflectivity depends much less on the viewing elevation than the classical
    // many-particle-thick result mu0/(mu+mu0) — the opaque B ring at low solar elevation stays bright
    float Dn = smoothstep(0.2, 1.2, tauMain);
    float muE = mix(mu, sqrt(mu * mu0), 0.6 * Dn);
    S = mu0 / (muE + mu0) * (1.0 - exp(-tauL * (m + m0)));
  } else {
    if (abs(mu - mu0) < 2e-3) S = tauU * m0 * exp(-tauU * m0);
    else S = mu0 / (mu - mu0) * (exp(-tauU * m) - exp(-tauU * m0));
    // dense rings: light that is scattered many times (and leaks through the gaps between self-gravity wakes)
    // diffuses through the slab far better than the single-scattering term allows, so the opaque B ring on the
    // unlit face is dark brown with its structure showing (B1 lighter, the B3 core nearly black), not a void
    S = max(S, 0.0) + 0.25 * exp(-1.25 * tauMain) * smoothstep(0.4, 1.4, tauMain) * 2.0 * mu0 / (mu + mu0);
  }
  float Tview = exp(-tauV * m);

  // particle population mix
  float dust = clamp((tauMain * al.a + tauF * dustF) / (tauMain + tauF), 0.0, 1.0);
  vec3 alb = mix(al.rgb * (1.0 + streakB), vec3(0.62, 0.58, 0.54), tauF / (tauMain + tauF));
  // Saturnshine geometry (table from the real visible lit-and-unshadowed globe seen from each ring point, see
  // computeSaturnshine): planet light travels outward from the planet, down onto the camera-side face and up
  // through the far face
  float dphS = abs(mod(phi - atan(-uSunR.z, uSunR.x) + 3.14159265, 6.2831853) - 3.14159265) / 3.14159265;
  vec2 uvS = vec2((clamp((rr - SS_R0) / (SS_R1 - SS_R0), 0.0, 1.0) * (SS_NR - 1.0) + 0.5) / SS_NR, (dphS * (SS_NA - 1.0) + 0.5) / SS_NA);
  vec4 ss = textureLod(uSShine, uvS, 0.0);
  bool camN = v.y > 0.0;
  float sg = camN ? 1.0 : -1.0;
  float Ec = camN ? ss.r : ss.g, Eo = camN ? ss.g : ss.r;
  float mc = clamp(camN ? ss.b : ss.a, 0.05, 1.0), mo = clamp(camN ? ss.a : ss.b, 0.05, 1.0);
  vec3 dC = vec3(er.x * sqrt(1.0 - mc * mc), -sg * mc, er.y * sqrt(1.0 - mc * mc));
  vec3 dO = vec3(er.x * sqrt(1.0 - mo * mo), sg * mo, er.y * sqrt(1.0 - mo * mo));
  // particle and dust phase functions of the three light paths (sun, planet light on the camera face, planet light
  // through the far face) in one loop: a single inlined copy of each
  vec3 cosv = vec3(cosT, dot(dC, v), dot(dO, v));
  vec3 PPv = vec3(0.0), PDv = vec3(0.0);
  for (int j = 0; j < 3 + uSatZero; j++) {
    vec3 oh = vec3(equal(ivec3(j), ivec3(0, 1, 2)));
    float c = dot(cosv, oh);
    PPv += oh * particlePhase(c);
    PDv += oh * dustPhase(c);
  }
  float alpha = acos(clamp(-cosT, -1.0, 1.0));
  float surge = 1.0 + 0.55 * exp(-alpha / 0.035);
  float pp = PPv.x * surge;
  float pd = PDv.x;
  // dust colour in forward scattering: the main rings' and the F ring's dust spans ~1-100 um, and grains larger than
  // ~3 um are seen outside their diffraction lobe at these angles, where the intensity grows with wavelength (red:
  // the backlit rings glow warm cream-tan, Cassini PIA08329); the D ring's finer dust is grey-blue
  vec3 dustAlb = mix(mix(vec3(0.50, 0.53, 0.60), vec3(0.66, 0.54, 0.41), smoothstep(73500.0, 75500.0, rkm)),
                     vec3(0.62, 0.55, 0.47), smoothstep(137500.0, 139500.0, rkm));
  // diffuse transmission through the slab is a multiple-scattering process: each extra bounce multiplies by the
  // (reddish) particle albedo, so the unlit face and the backlit rings are warmer than single scattering gives
  // The diffuse-transmission term already carries the particle albedo once; the extra bounces inside the slab
  // redden it only mildly (Cassini unlit-face images are grey-brown, B/R ~ 0.6-0.7, not copper), so the colour is
  // applied once and its chroma halved toward the luminance on the unlit face.
  vec3 albU = lit ? alb : mix(alb, vec3(dot(alb, vec3(0.2126, 0.7152, 0.0722))), 0.45);
  vec3 phaseCol = albU * pp * (1.0 - dust) + dustAlb * pd * dust;
  // inter-particle multiple scattering grows with the slab's slant optical thickness (not its normal tau)
  float ms = lit ? 1.0 + 0.85 * smoothstep(0.4, 3.0, tauMain * 0.5 * (m + m0)) : 1.15;
  float wake = lit ? (1.0 - wakeA) : (1.0 + 0.6 * wakeA);

  // spokes: dust layer on top (dims the lit face at low phase, glows forward)
  float spokeCover = exp(-tauS * (m + m0));
  vec3 spokeL = dustAlb * pd * 0.25 * (1.0 - spokeCover) * mu0 / (mu + mu0);

  vec3 sh = planetShadow(p, uSunR, uFlat);
  vec3 Lsun = (phaseCol * 0.25 * S * ms * wake * spokeCover + spokeL) * sh;

  // Saturnshine on both faces: the face toward the camera reflects the planet light that falls on it, and the light
  // falling on the far face reaches the camera by diffuse transmission, with the same slab photometry as the
  // sunlight. In 2026 the north (unlit) face sees the winter hemisphere, partly in the rings' own shadow.
  vec3 Lss;
  {
    vec3 pC = alb * PPv.y * (1.0 - dust) + dustAlb * PDv.y * dust;
    vec3 pO = albU * PPv.z * (1.0 - dust) + dustAlb * PDv.z * dust;
    float mcI = 1.0 / mc, moI = 1.0 / mo;
    float tauR = tauAt(T, m + mcI) * (1.0 + streakT) + tauF;
    float Dn = smoothstep(0.2, 1.2, tauMain);
    float muE = mix(mu, sqrt(mu * mc), 0.6 * Dn);
    float Sr = Ec / (muE + mc) * (1.0 - exp(-tauR * (m + mcI))) * (1.0 + 0.85 * smoothstep(0.4, 3.0, tauMain * 0.5 * (m + mcI)));
    float tauT = tauAt(T, 0.5 * (m + moI)) * (1.0 + streakT) + tauF;
    float St = abs(mu - mo) < 2e-3 ? Eo * tauT * moI * moI * exp(-tauT * moI) : Eo / (mu - mo) * (exp(-tauT * m) - exp(-tauT * moI));
    Lss = 0.25 * (pC * Sr + pO * max(St, 0.0) * 1.15) * uPlanetAlb;
  }
  // display lift of planet light where it is the main source (unlit face, the planet's shadow): ~1-3 % of daylight,
  // which the AgX toe would crush to black; where sunlight dominates the lift fades to 1 (lit face unchanged)
  {
    float ySun = dot(Lsun, vec3(0.2126, 0.7152, 0.0722)), ySs = dot(Lss, vec3(0.2126, 0.7152, 0.0722));
    Lss *= mix(1.0, uSSLift, exp(-ySun / max(0.15 * ySs, 1e-9)));
  }

  vec3 L = (Lsun + Lss) * uSunColor * uGain;
  float Tout = clamp(Tview * (lit ? (1.0 + 0.5 * wakeA) : (1.0 + 0.3 * wakeA)), 0.0, 1.0);
  // soft inner/outer limits of the drawn annulus
  gl_FragColor = vec4(satDisplay(L * uCover), 1.0 - uCover * (1.0 - Tout));
  if (uDebug == 1) gl_FragColor = vec4(S, pp * 0.25, alb.r * ms * 0.5, 0.0);
  if (uDebug == 2) gl_FragColor = vec4(mu, mu0 * 4.0, sh.r * 0.5, 0.0);
}`;

const OUTER_FRAG = /* glsl */ `
${RING_GLSL}
${DEPTH_GLSL}
uniform vec3 uCamR;
uniform vec3 uSunR;
uniform vec3 uSunColor;
uniform float uFlat;
uniform float uHalf;
uniform float uGain;
uniform float uCover;
varying vec3 vRing;
// G ring (dust; vertically thin, so a sheet). Optical depth exaggerated ~50x over the measured ~1e-6..1e-5 so the
// backlit ring reads on screen as in Cassini's long exposures (PIA08329); at low phase it stays invisible.
// The E ring is a separate volume (E_FRAG).
void main() {
  satWriteDepth();
  vec3 p = vec3(vRing.x, 0.0, vRing.z);
  float rr = length(p.xz);
  float rkm = rr * SAT_RKM;
  vec3 v = normalize(uCamR - p);
  float side = dot(p, -normalize(uCamR));
  if (side * uHalf < 0.0) discard;
  float tau = 2.2e-4 * exp(-0.5 * pow((rkm - 167500.0) / 1800.0, 2.0)) * smoothstep(165000.0, 166500.0, rkm)
            + 0.8e-4 * exp(-0.5 * pow((rkm - 168500.0) / 4500.0, 2.0));
  if (tau < 1e-7) discard;
  float mu = max(abs(v.y), 0.06);
  float cosT = -dot(v, uSunR);
  float pd = dustPhase(cosT);
  // G-ring dust is larger than the E ring's (power law to ~10 um): neutral to slightly red in forward scattering
  vec3 col = vec3(0.58, 0.53, 0.50);
  vec3 sh = planetShadow(p, uSunR, uFlat);
  vec3 L = col * pd * 0.25 * tau / mu * sh * uSunColor * uGain;
  gl_FragColor = vec4(satDisplay(L * uCover), 1.0 - uCover * min(tau / mu, 1.0));
}`;

// E ring: a real volume. Normal optical depth peaks at Enceladus' orbit (3.95 Rs; steep inner edge, ~r^-2.8 outside,
// fading out by ~15 Rs), exaggerated ~40x like the G ring; Gaussian vertical profile whose width grows outward
// (FWHM ~6,000 km at Enceladus to ~30,000 km at 8 Rs: sigma = 0.042 (r/3.95)^2.3 Rs). Each pixel integrates the
// line of sight through the slab with 16 samples -- half importance-sampled from the vertical Gaussian at the
// plane crossing (steep rays), half uniform along the path (grazing rays), combined with the balance heuristic --
// and every sample is tested against the planet's shadow, so the umbra is a soft-edged cylinder through the
// layer (at an 8 deg sun the edge smears over ~1.5 Rs) instead of a hard strip, and the grazing view from inside
// the ring is a soft glowing band, not an edge. Stops at the globe and at the moons (depth test off).
const E_VERT = /* glsl */ `
varying vec3 vP;
void main() {
  vP = position;
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}`;
const E_FRAG = /* glsl */ `
${RING_GLSL}
uniform vec3 uCamR;
uniform vec3 uSunR;
uniform vec3 uSunColor;
uniform float uFlat;
uniform float uGain;
uniform vec4 uMoonsR[6];
varying vec3 vP;
const float EYM = 2.4, ERM = 15.0;
float erfA(float x) {
  float t = 1.0 / (1.0 + 0.3275911 * abs(x));
  float y = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-x * x);
  return x < 0.0 ? -y : y;
}
float erfinvA(float x) { // Giles (2010), single precision
  float w = -log(max((1.0 - x) * (1.0 + x), 1e-30));
  float p;
  if (w < 5.0) {
    w -= 2.5;
    p = 2.81022636e-08; p = 3.43273939e-07 + p * w; p = -3.5233877e-06 + p * w; p = -4.39150654e-06 + p * w;
    p = 0.00021858087 + p * w; p = -0.00125372503 + p * w; p = -0.00417768164 + p * w; p = 0.246640727 + p * w;
    p = 1.50140941 + p * w;
  } else {
    w = sqrt(w) - 3.0;
    p = -0.000200214257; p = 0.000100950558 + p * w; p = 0.00134934322 + p * w; p = -0.00367342844 + p * w;
    p = 0.00573950773 + p * w; p = -0.0076224613 + p * w; p = 0.00943887047 + p * w; p = 1.00167406 + p * w;
    p = 2.83297682 + p * w;
  }
  return p * x;
}
float eTau(float r) {
  float rE = r / 3.949;
  float shape = rE < 1.0 ? pow(smoothstep(0.74, 1.0, rE), 2.0) : pow(rE, -2.8);
  return 6.0e-4 * shape * exp(-pow(r / 13.0, 4.0));
}
float eSig(float r) { return min(0.042 * pow(max(r, 2.6) / 3.949, 2.3), 0.5); }
float eDens(vec3 p) {
  float r = length(p.xz);
  float sg = eSig(r);
  return eTau(r) / (2.5066283 * sg) * exp(-0.5 * p.y * p.y / (sg * sg));
}
void main() {
  vec3 ro = uCamR;
  vec3 rd = normalize(vP - uCamR);
  // slab |y| < EYM, cylinder r < ERM
  float t0 = 0.0, t1 = 1e9;
  if (abs(rd.y) > 1e-7) {
    float ta = (-EYM - ro.y) / rd.y, tb = (EYM - ro.y) / rd.y;
    t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
  } else if (abs(ro.y) > EYM) discard;
  vec2 o2 = ro.xz, d2 = rd.xz;
  float A = dot(d2, d2), B = dot(o2, d2), C = dot(o2, o2) - ERM * ERM;
  float h = B * B - A * C;
  if (h <= 0.0 || A < 1e-12) discard;
  h = sqrt(h);
  t0 = max(t0, (-B - h) / A); t1 = min(t1, (-B + h) / A);
  float tp = hitPlanet(ro, rd, uFlat);
  if (tp > 0.0) t1 = min(t1, tp);
  for (int j = 0; j < 6 + uSatZero; j++) {
    vec3 oc = ro - uMoonsR[j].xyz;
    float b = dot(oc, rd), c = dot(oc, oc) - uMoonsR[j].w * uMoonsR[j].w;
    float hh = b * b - c;
    if (hh > 0.0) { float tm = -b - sqrt(hh); if (tm > 0.0) t1 = min(t1, tm); }
  }
  if (t1 <= t0) discard;

  // Gaussian proposal around the plane crossing
  float tc = abs(rd.y) > 1e-7 ? -ro.y / rd.y : 0.5 * (t0 + t1);
  vec3 pc = ro + rd * clamp(tc, t0, t1);
  float sc = eSig(length(pc.xz));
  float k = 0.70710678 / sc;
  float y0 = ro.y + rd.y * t0, y1 = ro.y + rd.y * t1;
  float F0 = erfA(y0 * k), F1 = erfA(y1 * k);
  float G = abs(rd.y) > 1e-7 ? 0.88622693 / (k * abs(rd.y)) * abs(F1 - F0) : 0.0;  // integral of exp(-(y k)^2) dt
  float L0 = t1 - t0;
  bool useG = G > 1e-6 * L0;
  // stable interleaved-gradient noise (no temporal change: deterministic, no crawl when static)
  float jit = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  const int NH = 8;
  float colA = 0.0;
  vec3 colS = vec3(0.0);
  for (int i = 0; i < 2 * NH + uSatZero; i++) {
    bool gs = i < NH;
    float u = (float(gs ? i : i - NH) + fract(jit + (gs ? 0.0 : 0.5))) / float(NH);
    float t;
    if (gs) {
      if (!useG) continue;
      float y = erfinvA(clamp(mix(F0, F1, u), -0.9999995, 0.9999995)) / k;
      t = clamp((y - ro.y) / rd.y, t0, t1);
    } else t = mix(t0, t1, u);
    vec3 p = ro + rd * t;
    float g = exp(-pow(p.y * k, 2.0));
    float pG = useG ? g / G : 0.0;
    float pU = 1.0 / L0;
    float wgt = 1.0 / (float(NH) * (pG + pU));
    float n = eDens(p) * wgt;
    colA += n;
    colS += n * planetShadow(p, uSunR, uFlat);
  }
  if (colA < 1e-12) discard;
  float cosT = dot(rd, uSunR);
  // ~1 micron ice grains with a narrow size distribution: strongly forward scattering and, inside their diffraction
  // lobe, brighter in the blue (I ~ lambda^-1.5 .. -2): the E ring's blue-violet halo in PIA08329
  vec3 col = vec3(0.42, 0.50, 0.70);
  vec3 L = col * dustPhase(cosT) * 0.25 * colS * uSunColor * uGain;
  gl_FragColor = vec4(satDisplay(L), 1.0);
}`;

function annulus(r0, r1, segs) {
  // flat annulus in the xz plane (ring frame), radius in Saturn radii
  const pos = [];
  const idx = [];
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    pos.push(r0 * c, 0, -r0 * s, r1 * c, 0, -r1 * s);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), r1);
  return g;
}

/** Build ring meshes. Returns { group, meshes: [farMain, nearMain, farOuter, nearOuter], uniforms }. */
export function createRings(ctx, data, shared) {
  const { U } = ctx;
  const uni = {
    uRingProf: { value: data.prof },
    uRingAlb: { value: data.alb },
    uRingFine: { value: data.fine },
    uRingM0: { value: data.m0 },
    uRingFineN: { value: data.tau.length },
    uSunAngR: shared.uSunAngR,
    uCamR: shared.uCamR,
    uSunR: shared.uSunR,
    uSunColor: U.uSunColor,
    uFlat: shared.uFlat,
    uHours: shared.uHours,
    uFApse: shared.uFApse,
    // planet light as a Lambert sphere matching Saturn's full-phase brightness (geometric albedo ~0.48 -> A = 1.5 p);
    // chroma halved like the globe's ringshine (otherwise planet light x salmon particles reads deep orange)
    uPlanetAlb: { value: new THREE.Vector3(0.77, 0.70, 0.60) },
    uGain: shared.uGain,
    uNear2: { value: 1e-3 },
    uTilt: { value: new THREE.Vector4(1, 0, 0, 0) },
    uCover: { value: 1 },
    uExposure: U.uExposure,
    uDebug: { value: 0 },
    uSShine: { value: data.sshine },
    uSSLift: shared.uSSLift,
  };
  const R = ctx.data.radius;
  const mk = (frag, half, geo, order) => {
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...uni, uHalf: { value: half } },
      vertexShader: VERT,
      fragmentShader: frag,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.SrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.scale.setScalar(R);
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    return mesh;
  };
  const gMain = annulus(66600 / 60268, 141700 / 60268, 1024);
  const gOuter = annulus(160000 / 60268, 178000 / 60268, 512);
  const farMain = mk(FRAG, 1, gMain, 10);
  const nearMain = mk(FRAG, -1, gMain, 13);
  const farOuter = mk(OUTER_FRAG, 1, gOuter, 9);
  const nearOuter = mk(OUTER_FRAG, -1, gOuter, 12);
  farMain.name = 'saturn-rings-far'; nearMain.name = 'saturn-rings-near';
  farOuter.name = 'saturn-g-ring-far'; nearOuter.name = 'saturn-g-ring-near';
  const group = new THREE.Group();
  group.name = 'saturn-rings';
  // E-ring volume: drawn before the main rings (additive, optically thin) so they attenuate the dust behind them
  const eMat = new THREE.ShaderMaterial({
    uniforms: { ...uni, uMoonsR: shared.uMoonsR },
    vertexShader: E_VERT,
    fragmentShader: E_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.BackSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
  const eVol = new THREE.Mesh(new THREE.SphereGeometry(16, 48, 24), eMat);
  eVol.scale.setScalar(R);
  eVol.renderOrder = 8;
  eVol.frustumCulled = false;
  eVol.name = 'saturn-e-ring';
  group.add(eVol, farOuter, farMain, nearOuter, nearMain);
  return { group, meshes: [farMain, nearMain, farOuter, nearOuter, eVol], uniforms: uni };
}
