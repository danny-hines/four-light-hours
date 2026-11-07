// The belt as a whole, for wide shots: ~75,000 asteroids placed on real-statistics Keplerian orbits (positions at
// the epoch, like the planets). Semi-major axes follow the main-belt distribution with the Kirkwood gaps at the
// 4:1 (2.06 AU), 3:1 (2.50), 5:2 (2.82), 7:3 (2.96), 9:4 (3.03) and 2:1 (3.28) mean-motion resonances with
// Jupiter; eccentricities and inclinations are Rayleigh-distributed. Also: the Hungarias (1.9 AU, high
// inclination), the sparse Cybeles, the Hildas in 3:2 resonance (their aphelia avoid Jupiter, which draws the
// famous triangle with corners at Jupiter's L3/L4/L5), and the Jupiter Trojan swarms 60 deg ahead of and behind
// Jupiter. Rendered as faint flux-conserving Gaussian points with an airless phase function.
import * as THREE from 'three';
import { AU, DEG } from '../../core/astro.js';
import { mulberry32 } from './hash.js';
import { PHOTOMETRY_GLSL } from './rockMaterial.js';

function sst01(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function rayleigh(rng, sigma) {
  return sigma * Math.sqrt(-2 * Math.log(1 - rng() * 0.999999));
}

function keplerPos(a, e, inc, Om, w, M, out, o) {
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 8; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const xp = a * (Math.cos(E) - e), yp = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(Om), sO = Math.sin(Om), cI = Math.cos(inc), sI = Math.sin(inc);
  const X = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
  const Y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
  const Z = sw * sI * xp + cw * sI * yp;
  out[o] = X * AU;
  out[o + 1] = Z * AU;
  out[o + 2] = -Y * AU;
}

// main-belt semi-major-axis density (relative), with resonance gaps
function beltDensity(a) {
  if (a < 2.06 || a > 3.55) return 0;
  let d;
  if (a < 2.15) d = (a - 2.06) / 0.09;
  else if (a < 2.5) d = 1.0;
  else if (a < 2.825) d = 0.92;
  else if (a < 2.958) d = 0.42; // "pristine zone"
  else if (a < 3.279) d = 0.8;
  else d = 0.07 * Math.exp(-(a - 3.3) / 0.12); // Cybele group
  const gap = (a0, w, depth) => 1 - depth * Math.exp(-Math.pow((a - a0) / w, 2));
  // gap half-widths ~0.015-0.035 AU (the libration widths of the resonances, a little generous so the 3:1 and
  // 5:2 gaps still read when the whole belt is only a few hundred pixels across)
  d *= gap(2.065, 0.022, 0.95) * gap(2.502, 0.03, 0.97) * gap(2.825, 0.022, 0.95) * gap(2.958, 0.014, 0.85) * gap(3.03, 0.008, 0.55) * gap(3.279, 0.035, 0.98);
  return Math.max(0, d);
}

export function createRing(ctx) {
  const { U, positions } = ctx;
  const rng = mulberry32(0xbe17);
  const N_MAIN = 60000, N_HUN = 1400, N_HIL = 2600, N_TRO = 10000;
  const N = N_MAIN + N_HUN + N_HIL + N_TRO;
  const pos = new Float32Array(N * 3);
  const attr = new Float32Array(N * 2); // size weight, population
  let k = 0;
  const jp = positions?.jupiter || new THREE.Vector3(-3.674 * AU, 0, -3.84 * AU);
  const lamJ = Math.atan2(-jp.z, jp.x); // ecliptic longitude of Jupiter
  const sizeW = () => Math.pow(1 - rng() * 0.995, -1 / 1.4) * 0.12; // a few bright ones, many faint
  // main belt
  while (k < N_MAIN) {
    const a = 2.0 + rng() * 1.6;
    if (rng() > beltDensity(a)) continue;
    const e = Math.min(0.3, rayleigh(rng, 0.035));
    const inc = Math.min(30 * DEG, rayleigh(rng, 6.5 * DEG));
    keplerPos(a, e, inc, rng() * 2 * Math.PI, rng() * 2 * Math.PI, rng() * 2 * Math.PI, pos, k * 3);
    attr[k * 2] = sizeW();
    attr[k * 2 + 1] = 0;
    k++;
  }
  // Hungarias
  for (let i = 0; i < N_HUN; i++, k++) {
    const a = 1.82 + rng() * 0.17;
    keplerPos(a, rayleigh(rng, 0.05), (16 + rng() * 14) * DEG, rng() * 6.283, rng() * 6.283, rng() * 6.283, pos, k * 3);
    attr[k * 2] = sizeW() * 0.6;
    attr[k * 2 + 1] = 1;
  }
  // Hildas: 3:2 resonance, sigma = 3 lambda_J - 2 lambda - varpi librates about 0
  for (let i = 0; i < N_HIL; i++, k++) {
    const a = 3.97 + (rng() - 0.5) * 0.08;
    const e = 0.08 + rng() * 0.2;
    const M = rng() * 2 * Math.PI;
    const sig = (rng() - 0.5) * 2 * 40 * DEG;
    const br = Math.floor(rng() * 3);
    const varpi = (3 * lamJ - 2 * M - sig) / 3 + (br * 2 * Math.PI) / 3;
    const Om = rng() * 2 * Math.PI;
    keplerPos(a, e, rayleigh(rng, 7 * DEG), Om, varpi - Om, M, pos, k * 3);
    attr[k * 2] = sizeW() * 0.9;
    attr[k * 2 + 1] = 2;
  }
  // Trojans (L4 leads by 60 deg, L5 trails; L4 is the more populous)
  for (let i = 0; i < N_TRO; i++, k++) {
    const L4 = rng() < 0.6;
    const lib = (rng() - 0.5) * 2 * 28 * DEG * Math.sqrt(rng());
    const lam = lamJ + (L4 ? 60 : -60) * DEG + lib;
    const a = 5.2 + (rng() - 0.5) * 0.12;
    const e = Math.min(0.2, rayleigh(rng, 0.06));
    const varpi = rng() * 2 * Math.PI, Om = rng() * 2 * Math.PI;
    keplerPos(a, e, Math.min(40 * DEG, rayleigh(rng, 12 * DEG)), Om, varpi - Om, lam - varpi, pos, k * 3);
    attr[k * 2] = sizeW() * 1.1;
    attr[k * 2 + 1] = 3;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geom.setAttribute('aInfo', new THREE.BufferAttribute(attr, 2));
  const uniforms = {
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uGain: { value: 1.0 },
    uNearFade: { value: new THREE.Vector2(900, 5000) },
    uPixelRatio: U.uPixelRatio,
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      ${PHOTOMETRY_GLSL}
      in vec2 aInfo;
      uniform vec3 uSunPosW;
      uniform float uGain, uPixelRatio;
      uniform vec2 uNearFade;
      out vec3 vCol;
      float sst(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vec3 rel = wp.xyz; // camera-relative
        float d = length(rel);
        vec3 V = -rel / d;
        vec3 L = normalize(uSunPosW - rel);
        float alpha = acos(clamp(dot(L, V), -1.0, 1.0));
        float ph = airlessDisc(alpha, 0.5);
        // flux ~ 1/d^2 (so the belt has a distance-independent surface brightness, like any extended source),
        // scaled artistically to a faint band (~0.01 radiance face-on) and capped so near ones stay dim dots
        float au = d / ${AU.toFixed(2)};
        float flux = min(16.0 * aInfo.x * ph / (au * au), 0.035);
        float fade = sst(uNearFade.x, uNearFade.y, d);
        float pop = aInfo.y;
        float popGain = pop > 2.5 ? 0.85 : 1.0;
        vCol = vec3(flux * fade * uGain * popGain);
        gl_PointSize = 3.0 * uPixelRatio;
        gl_Position = projectionMatrix * viewMatrix * wp;
        if (fade <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform vec3 uSunColor;
      uniform float uPixelRatio;
      in vec3 vCol;
      out vec4 fragColor;
      void main() {
        vec2 r = (gl_PointCoord - 0.5) * 3.0;
        float w = exp(-dot(r, r) / (2.0 * 0.36)) / (6.2831853 * 0.36);
        fragColor = vec4(vCol * vec3(1.03, 1.0, 0.94) * uSunColor * w, 1.0);
      }`,
  });
  const points = new THREE.Points(geom, mat);
  points.frustumCulled = false;
  points.name = 'asteroid-belt-ring';
  const band = createBand(ctx);
  const group = new THREE.Group();
  group.name = 'asteroid-belt';
  group.add(points, band.mesh);
  function update(frame) {
    const c = frame?.camUniverse;
    // Where the belt may draw at all (every mode, view=body included). Seen from inside the ecliptic plane away
    // from the belt (Mercury, Venus, Earth, Mars, Saturn...) the belt's integrated light lies edge-on along the
    // ecliptic: physically it is a few per cent of the zodiacal light, far below anything a camera exposed for a
    // sunlit planet records, so it must not draw there (it read as a grey 15-degree band / a speckled dust lens).
    // It draws (a) within ~0.25-0.45 AU of the belt annulus (approach, crossing, departure) and (b) from well out
    // of the ecliptic (ecliptic latitude > ~10-16 deg seen from the Sun: the finale), where it projects as a ring
    // around the Sun instead of a band along the ecliptic.
    let gate = 0, inBelt = 0;
    if (c) {
      const r = Math.hypot(c.x, c.z) / AU, z = Math.abs(c.y) / AU;
      const dB = Math.hypot(Math.max(0, 2.06 - r, r - 3.3), Math.max(0, z - 0.3));
      const nearG = 1 - sst01(0.25, 0.45, dB);
      const lat = Math.atan2(z, Math.max(r, 1e-9)) / DEG;
      const wideG = sst01(10, 16, lat);
      gate = Math.max(nearG, wideG);
      // inside the belt itself the local swarm (field, glow, dust) carries the light: the band would cost a
      // full-screen march for a few per cent of background, so it fades out over the annulus around the camera
      inBelt = Math.min(1, Math.max(0, (Math.min(r - 1.85, 3.6 - r) / 0.15))) * Math.min(1, Math.max(0, (0.5 - z) / 0.1));
    }
    // director's wish (shot.beltRing, 0..1; absent in body views) times the geometric gate
    const g = (frame?.shot?.beltRing ?? 1) * gate;
    uniforms.uGain.value = g;
    points.visible = g > 1e-4;
    band.uniforms.uGain.value = g * (1 - inBelt);
    if (frame?.camera) band.uniforms.uTanHalf.value = 1 / frame.camera.projectionMatrix.elements[5];
    band.mesh.visible = band.uniforms.uGain.value > 1e-4;
  }
  return { object: group, uniforms, count: N, update, band };
}

// ------------------------------------------------------------------------------------------ the band
// The belt's integrated light as a volume: surface density Sigma(r) from the gap-carved semi-major-axis
// distribution (number per unit area ~ N(a)/a), a Gaussian vertical structure with sigma_z = 0.08 r (6.5 deg
// Rayleigh inclinations), 1/r^2 sunlight and the airless disc phase law. The profile is a mip-mapped 1-D texture:
// along each view ray the sample spacing in r picks the mip, so face-on views show the 4:1, 3:1, 5:2, 7:3 and 2:1
// Kirkwood gaps as dark lanes while oblique and edge-on rays blur them, as the belt's thickness really does.
// Artistic gain: a faint band a few per cent above the sky background, faded near the camera (inside the belt the
// local swarm takes over) and by the director's shot.beltRing.
const BAND_R0 = 1.7, BAND_R1 = 3.75, BAND_N = 512;
function createBand(ctx) {
  const { U } = ctx;
  const prof = new Float32Array(BAND_N);
  // fine semi-major-axis density (main belt + Hungarias), smoothed with sigma 0.012 AU
  const fine = 4096, raw = new Float32Array(fine);
  for (let i = 0; i < fine; i++) {
    const a = BAND_R0 + ((i + 0.5) / fine) * (BAND_R1 - BAND_R0);
    const hun = a > 1.8 && a < 2.0 ? 0.05 * Math.sin(((a - 1.8) / 0.2) * Math.PI) : 0;
    raw[i] = (beltDensity(a) + hun) / a;
  }
  const da = (BAND_R1 - BAND_R0) / fine, sig = 0.012 / da;
  const ker = [];
  for (let k = -Math.ceil(3 * sig); k <= Math.ceil(3 * sig); k++) ker.push([k, Math.exp(-(k * k) / (2 * sig * sig))]);
  let mx = 0;
  for (let j = 0; j < BAND_N; j++) {
    const ic = ((j + 0.5) / BAND_N) * fine;
    let acc = 0, w = 0;
    for (const [k, kw] of ker) {
      const i = Math.round(ic + k);
      if (i < 0 || i >= fine) continue;
      acc += raw[i] * kw;
      w += kw;
    }
    prof[j] = acc / Math.max(w, 1e-9);
    mx = Math.max(mx, prof[j]);
  }
  const data = new Uint8Array(BAND_N * 4);
  for (let j = 0; j < BAND_N; j++) {
    const v = Math.round((255 * prof[j]) / mx);
    data[j * 4] = data[j * 4 + 1] = data[j * 4 + 2] = v;
    data[j * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, BAND_N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const uniforms = {
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uProfile: { value: tex },
    uGain: { value: 1 },
    uBandGain: { value: 0.1 },
    uTanHalf: { value: 0.4 },
    uExposure: U.uExposure,
  };
  const geom = new THREE.SphereGeometry(1, 48, 24);
  const mat = new THREE.ShaderMaterial({
    uniforms,
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.BackSide,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      out vec3 vDir;
      void main() {
        vDir = position;
        // camera-centred: world space is camera-relative (the camera sits at the origin)
        gl_Position = projectionMatrix * viewMatrix * vec4(position * 4.0e7, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      ${PHOTOMETRY_GLSL}
      uniform vec3 uSunPosW, uSunColor;
      uniform sampler2D uProfile;
      uniform float uGain, uBandGain, uTanHalf, uExposure;
      in vec3 vDir;
      out vec4 fragColor;
      const float AUU = ${AU.toFixed(3)};
      float sst(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
      void main() {
        if (uGain <= 0.0) discard;
        vec3 v = normalize(vDir);
        // ray in AU, relative to the Sun: q(t) = C + v t, C = camera position relative to the Sun
        vec3 C = -uSunPosW / AUU;
        // how far the camera is out of the belt plane (sine of its ecliptic latitude seen from the Sun): the
        // legibility aids and the dust-band forward lobe are for wide shots from outside; seen edge-on from
        // inside the plane (Mars departure) the band stays the faint rock-light it physically is
        float wE = sst(0.06, 0.3, abs(C.y) / max(length(C), 1e-6));
        float H = 0.08 * ${BAND_R1.toFixed(2)} * 2.6;
        float t0 = 0.0, t1 = 1e4;
        if (abs(v.y) > 1e-6) {
          float ta = (-H - C.y) / v.y, tb = (H - C.y) / v.y;
          t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb));
        } else if (abs(C.y) > H) discard;
        float a = dot(v.xz, v.xz), b = dot(C.xz, v.xz), c = dot(C.xz, C.xz) - ${(BAND_R1 * BAND_R1).toFixed(3)};
        float disc = b * b - a * c;
        if (disc <= 0.0 || a < 1e-12) discard;
        float sq = sqrt(disc);
        t0 = max(t0, (-b - sq) / a); t1 = min(t1, (-b + sq) / a);
        if (t1 <= t0) discard;
        const int K = 28;
        float dt = (t1 - t0) / float(K);
        float L = 0.0;
        float rPrev = -1.0;
        for (int i = 0; i < K; i++) {
          float t = t0 + (float(i) + 0.5) * dt;
          vec3 q = C + v * t;
          float r = length(q.xz);
          float u = (r - ${BAND_R0.toFixed(2)}) / ${(BAND_R1 - BAND_R0).toFixed(2)};
          if (u <= 0.0 || u >= 1.0) continue;
          float sz = 0.08 * r;
          float g = exp(-0.5 * q.y * q.y / (sz * sz)) / (2.5066 * sz);
          // mip from the radial distance covered by one step (blurs gaps on oblique / edge-on rays)
          float drStep = abs(dot(q.xz / max(r, 1e-6), v.xz)) * dt + abs(v.y) * dt * 0.0;
          float lod = log2(max(drStep / ${((BAND_R1 - BAND_R0) / BAND_N).toFixed(5)}, 1.0));
          float sig = textureLod(uProfile, vec2(u, 0.5), lod).r;
          vec3 toSun = -q;
          float rs = length(toSun);
          float cosA = dot(toSun / rs, -v);
          float alpha = acos(clamp(cosA, -1.0, 1.0));
          // rocks (airless disc law, bright at low phase) + the belt's dust bands (forward-scattering, g = 0.6),
          // so the backlit near side of the ring does not vanish
          float cs = -cosA;
          float hgD = 0.64 / (12.566 * pow(1.36 - 1.2 * cs, 1.5));
          float ph = airlessDisc(alpha, 0.5) + 0.8 * hgD * wE;
          float near = sst(0.05, 0.3, t);
          L += sig * g * ph * (7.29 / (rs * rs)) * near * dt;
        }
        // Legibility (artistic, documented): (1) exposure floor, so a Sun-exposed wide shot does not crush the
        // band to nothing; (2) in the Sun's glare the band is lifted the way the glare rises (post's veil +
        // bloom fall off ~ r^-2 in frame-height units around the Sun, at a near-constant display level whatever
        // the Sun's distance; calibrated on the finale frame, Sun at 46 AU in a 29.5-degree field, glare ~0.1 at
        // 0.11 frame heights), so the band still adds ~30-50% where its profile peaks and its lanes read.
        float gE = clamp(1.41 / max(uExposure, 1e-3), 1.0, 6.0);
        float fh = 2.0 * atan(uTanHalf);
        vec3 sdir = normalize(uSunPosW);
        float x = max(acos(clamp(dot(v, sdir), -1.0, 1.0)) / fh, 0.01);
        float boost = 1.0 + min(2.6 * (0.11 / x) * (0.11 / x), 30.0) * wE;
        gE = mix(1.0, gE, wE);
        // edge-on (camera in the belt plane) the optically thin band integrates a ~20x longer column than face-on:
        // a soft knee keeps it a faint band there instead of a bright wall, leaving face-on views unchanged
        float Lb = L * uBandGain;
        Lb = Lb / sqrt(1.0 + (Lb / 0.03) * (Lb / 0.03));
        vec3 col = Lb * uGain * gE * boost * vec3(1.03, 1.0, 0.95) * uSunColor;
        fragColor = vec4(col, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -900;
  mesh.name = 'asteroid-belt-band';
  return { mesh, uniforms };
}
