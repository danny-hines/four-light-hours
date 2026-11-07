// Jupiter's thin upper atmosphere as a transparent shell: H2 Rayleigh scattering above the ammonia cloud deck
// (vertical optical depth ~0.12 in blue, ~0.03 in red at ~0.6 bar) plus a forward-scattering stratospheric haze
// that thickens toward the poles. Scale heights are ~20-40 km on a 71,492 km planet, so instead of a naive
// raymarch the sun path uses the Chapman grazing-incidence function and the view path is sampled with points
// packed around the ray's closest approach. Blending: out = inscatter + dst * transmittance.
import * as THREE from 'three';
import { JUP_COMMON } from './glsl.js';

export const HAZE_PARAMS = /* glsl */ `
const float JR_KM = 71492.0;
const float H_R = 22.0;     // km, H2 scale height near the tropopause (T ~ 110-130 K, g = 24.8)
const float H_M = 32.0;     // km, upper-tropospheric haze just above the ammonia cloud tops
const float H_S = 80.0;     // km, stratospheric haze, extending up to ~1 mbar (~300 km): the limb's detached glow
const vec3 TAU_R = vec3(0.034, 0.064, 0.125);   // vertical Rayleigh optical depth above the clouds (630/540/460 nm)
// stratospheric haze is absorbing, brownish, darker in the blue (Zhang et al. 2013, Cassini ISS limb/phase fits)
const vec3 OMEGA_M = vec3(0.92, 0.88, 0.80);
// stratospheric haze: fractal aggregates, strongly forward scattering (g ~ 0.75), a little less absorbing
const vec3 OMEGA_S = vec3(0.95, 0.93, 0.88);
float hazeTau(float latAbs) {          // vertical haze optical depth vs latitude (polar haze caps)
  return 0.03 + 0.12 * smoothstep(0.85, 1.35, latAbs);
}
float hazeTauS(float latAbs) {
  return 0.024 + 0.04 * smoothstep(0.85, 1.35, latAbs);
}
// small haze particles: optical depth steeper toward the blue (relative to the green value above)
const vec3 HAZE_SPEC = vec3(0.8, 1.0, 1.25);
// sun transmittance at radius r (planet radii) with solar zenith cosine cosChi, latitude latAbs: the three layers
// (H2 Rayleigh, upper-tropospheric haze, stratospheric haze) at once as vec3 lanes, branch-free (a small, fast program).
// Chapman grazing-incidence function, relative to the density at r; below the local horizon
//   ch(X, chi > 90) = 2 ch(Xm, 90) exp(X - Xm) - ch(X, 180 - chi), Xm at the ray's closest approach.
vec3 sunTransmit(float r, float cosChi, float latAbs) {
  vec3 Hs = vec3(H_R, H_M, H_S);
  vec3 X = r * JR_KM / Hs;
  vec3 c = sqrt(1.5707963 * X);
  vec3 up = c / ((c - 1.0) * abs(cosChi) + 1.0);
  float rmin = r * sqrt(max(0.0, 1.0 - cosChi * cosChi));
  vec3 lo = 2.0 * sqrt(1.5707963 * rmin * JR_KM / Hs) * exp(min((r - rmin) * JR_KM / Hs, vec3(80.0))) - up;
  vec3 ch = cosChi >= 0.0 ? up : lo;
  vec3 dens = exp(-(r - 1.0) * JR_KM / Hs) * vec3(1.0, hazeTau(latAbs), hazeTauS(latAbs));
  vec3 tau = TAU_R * (dens.x * ch.x) + HAZE_SPEC * (dens.y * ch.y + dens.z * ch.z);
  return (cosChi < 0.0 && rmin < 1.0) ? vec3(0.0) : exp(-tau);   // (the sun ray hits the planet)
}
`;

export function createHaze({ R, flat, shared }) {
  const hTopKm = 600;
  const Rs = 1 + hTopKm / 71492;
  const uniforms = {
    ...shared,
    uCamJ: { value: new THREE.Vector3() },
    uShellR: { value: Rs },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    vertexShader: /* glsl */ `
      varying vec3 vPosJ;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vPosJ = mat3(modelMatrix) * position;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${JUP_COMMON}
      ${HAZE_PARAMS}
      uniform vec3 uCamJ;
      uniform vec3 uPoleW;
      uniform vec3 uSunJ;
      uniform vec3 uSunColor;
      uniform float uRadius;
      uniform float uFlat;
      uniform float uShellR;
      uniform float uDebug;
      uniform float uTime;
      uniform mat3 uRot;
      uniform vec4 uFlash[6];   // lightning strokes this frame (jupiter.js): xyz = unit position (body frame), w = intensity
      uniform vec4 uFlashR;     // glow radii (km) of the strokes 0-3; strokes 4, 5 use 600 km
      uniform int uI0;
      uniform float uSunR;
      uniform vec4 uMoon[4];
      varying vec3 vPosJ;

      vec3 toSph(vec3 p) { return (p + uPoleW * (dot(p, uPoleW) * (1.0 / (1.0 - uFlat) - 1.0))) / uRadius; }

      vec2 raySph(vec3 ro, vec3 rd, float r) {
        float tc = -dot(ro, rd);
        vec3 pc = ro + rd * tc;
        float h = r * r - dot(pc, pc);
        if (h < 0.0) return vec2(1e20, -1e20);
        h = sqrt(h);
        return vec2(tc - h, tc + h);
      }
      float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
      float phaseHG(float mu, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * mu, 1e-4), 1.5)); }

      void main() {
        float fpk = max(length(dFdx(vPosJ)), length(dFdy(vPosJ))) / uRadius * JR_KM;
        if (abs(uDebug - 9.0) < 0.5) discard;    // jdebug=9: deck only
        vec3 ro = toSph(uCamJ);
        bool outside = dot(ro, ro) > uShellR * uShellR;
        if (outside != gl_FrontFacing) discard;
        vec3 rd = normalize(toSph(vPosJ) - ro);
        vec2 ts = raySph(ro, rd, uShellR);
        vec2 tp = raySph(ro, rd, 1.0);
        float t0 = max(ts.x, 0.0);
        float t1 = ts.y;
        bool hitP = tp.x < tp.y && tp.x > 0.0;
        if (hitP) t1 = min(t1, tp.x);
        if (t1 <= t0) discard;
        float tc = clamp(-dot(ro, rd), t0, t1);
        if (hitP) tc = t1;

        vec3 Ls = normalize(uSunJ);
        float mu = dot(rd, Ls);
        float pR = phaseR(mu);
        float pM = 0.85 * phaseHG(mu, 0.70) + 0.15 * phaseHG(mu, -0.25);
        vec3 bR = TAU_R * (JR_KM / H_R);      // per planet radius at the reference level
        float kM = JR_KM / H_M;
        float kS = JR_KM / H_S;
        float pS = 0.9 * phaseHG(mu, 0.76) + 0.1 * phaseHG(mu, -0.2);

        vec3 sum = vec3(0.0);
        vec3 od = vec3(0.0);
        const int N = 7;
        // two halves, samples packed quadratically toward the closest-approach (or surface) point tc
        float len0 = tc - t0, len1 = t1 - tc;
        for (int it = 0; it < 2 * N + uI0; it++) {
          int half_ = it / N, i = it - N * half_;
          float len = half_ == 0 ? len0 : len1;
          if (len < 1e-7) continue;
          {
            float a = float(i) / float(N), b = float(i + 1) / float(N);
            // half 0 runs t0 -> tc, half 1 runs tc -> t1 (front to back), u^2 spacing packs samples near tc
            float uA = half_ == 0 ? 1.0 - a : a;
            float uB = half_ == 0 ? 1.0 - b : b;
            float um = 0.5 * (uA + uB);
            float ds = abs(uA * uA - uB * uB) * len;
            float t = half_ == 0 ? tc - len * um * um : tc + len * um * um;
            vec3 p = ro + rd * t;
            float r = length(p);
            float h = (r - 1.0) * JR_KM;
            float sl = abs(dot(p, uPoleW)) / r;
            float latAbs = sl * (1.0 + sl * sl * (0.1667 + 0.075 * sl * sl));   // ~asin, enough for the haze cap
            vec3 eR = bR * exp(-h / H_R);
            float tauM = hazeTau(latAbs);
            float eM = tauM * kM * exp(-h / H_M);
            float eS = hazeTauS(latAbs) * kS * exp(-h / H_S);
            vec3 ext = (eR + HAZE_SPEC * (eM + eS)) * ds;
            vec3 Ts = sunTransmit(r, dot(p / r, Ls), latAbs);
            sum += exp(-(od + 0.5 * ext)) * Ts * (eR * pR + HAZE_SPEC * (eM * OMEGA_M * pM + eS * OMEGA_S * pS)) * ds;
            od += ext;
          }
        }
        // rays that end on the cloud deck: the deck's own forward scattering is already in its BRDF (surface.js), so the
        // shell contributes less there (keeps the band contrast of the crescent); off-limb rays keep the full glow
        float onDeck = hitP ? 1.0 : 0.0;
        // ... except at grazing view angles on the disc, where the slant haze column (not the deck lobe) is what is seen:
        // keeps the blue-grey veil over the darkened limb (Hubble, Cassini)
        float muH = hitP ? max(dot(normalize(ro + rd * t1), -rd), 0.0) : 1.0;
        sum *= mix(1.0, mix(0.45, 1.0, smoothstep(0.45, 0.12, muH)), onDeck);
        od *= mix(1.0, 0.6, onDeck);
        vec3 T = exp(-od);
        // in-scatter is a radiance (phase functions per sr); the deck uses the "white Lambertian = 1" convention, i.e.
        // pi x radiance: same units here
        sum *= uSunColor * PI;
        // moon shadows (umbra + penumbra) on the deck point, for the deck seen through this shell and the haze above it
        vec3 pH = normalize(ro + rd * t1);
        float sh = 1.0;
        if (hitP) {
          vec3 pW = (pH - uPoleW * (dot(pH, uPoleW) * uFlat)) * uRadius;
          for (int i = 0; i < 4 + uI0; i++) sh *= sphereShadow(pW, uSunJ, uSunR, uMoon[i].xyz, uMoon[i].w);
        }
        sum *= sh;
        // ---- lightning on the night-side deck (Voyager, Galileo, Juno): a few storm cells, each flashing in short
        //      multi-stroke bursts; light diffuses through the deck into a 300-1000 km glow (suppressed under ~3 px)
        if (hitP && dot(pH, Ls) < 0.02) {
          vec3 uS = transpose(uRot) * pH;
          float flash = 0.0;
          for (int i = 0; i < 6 + uI0; i++) {
            vec4 st = uFlash[i];
            float gR = i < 4 ? uFlashR[i] : 600.0;
            float dd = length(uS - st.xyz) * JR_KM;
            flash += st.w * (exp(-dd * dd / (gR * gR)) + 0.3 * exp(-dd * dd / (4.0 * gR * gR))) * smoothstep(2.0, 4.0, gR / fpk);
          }
          sum += vec3(0.78, 0.86, 1.0) * flash * 0.5 * smoothstep(0.02, -0.08, dot(pH, Ls)) * T;
        }
        gl_FragColor = vec4(sum, dot(T, vec3(0.3333)) * sh);
      }`,
  });
  const geo = new THREE.SphereGeometry(R * Rs * 1.0004, 256, 128);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(1, 1 - flat, 1);
  mesh.name = 'jupiter-haze';
  mesh.renderOrder = 1;
  const qPole = new THREE.Quaternion();
  const yAxis = new THREE.Vector3(0, 1, 0);
  return {
    mesh,
    update(frame) {
      // camera relative to Jupiter centre, world axes (double precision on the JS side)
      uniforms.uCamJ.value.copy(frame.camUniverse).sub(frame.positions.jupiter);
      mesh.quaternion.copy(qPole.setFromUnitVectors(yAxis, shared.uPoleW.value));
    },
  };
}
