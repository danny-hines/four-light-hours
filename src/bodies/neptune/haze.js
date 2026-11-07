// Neptune's upper atmosphere: stratospheric hydrocarbon haze (two exponential layers) plus Rayleigh gas above the
// cloud deck, single-scattered with Chapman-function sun extinction and the planet's own shadow. Drawn as a thin
// transparent shell after the globe: out = inscatter + dst * transmittance. Handles the oblate figure exactly by
// working in a frame scaled so the ellipsoid is a sphere.
// It gives the soft blue limb, the twilight wrap past the terminator, and the forward-scattering ring of the
// backlit crescent.
//
// Anti-aliasing of the limb: the low haze layer's scale height (~47 km) is far below a pixel at most distances, so
// its tangent column is a sub-pixel line that aliased into a bright hairline at the silhouette. Two fixes:
//  * each layer's scale height is floored at ~1.3 pixel footprints at the tangent point (vertical optical depth kept),
//    so the limb profile is always resolved;
//  * a pixel that straddles the silhouette is shaded as the coverage-weighted mean of a ray just missing the planet
//    and a ray just hitting it, matching the globe's MSAA coverage, so there is no step at the edge.
import * as THREE from 'three';
import { COMMON_GLSL } from './common.js';

export function makeHazeMaterial(ctx, { radius, flat, top }) {
  const { U } = ctx;
  const R = radius;
  const uniforms = {
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uResolution: U.uResolution,
    uCenterW: { value: new THREE.Vector3() },
    uRotW: { value: new THREE.Matrix3() },
    uFlat: { value: 1 - flat },
    uR: { value: R },
    uTop: { value: R * top },
    // haze layer 1 (dense, low), layer 2 (tenuous, extended): scale heights in scene units, vertical optical depths
    uH1: { value: R * 0.0019 },
    uTau1: { value: 0.016 },
    uH2: { value: R * 0.012 },
    uTau2: { value: 0.011 },
    uHR: { value: R * 0.0022 },
    uRayTau: { value: new THREE.Vector3(0.0025, 0.0075, 0.022) },
    // small (~0.1 um) particles: blue single-scattering albedo, extinction ~ lambda^-3.5
    uHazeAlb: { value: new THREE.Vector3(0.55, 0.78, 0.97) },
    uHazeSpec: { value: new THREE.Vector3(0.14, 0.4, 1.0) },
    uGain: { value: 1.0 },
    uInside: { value: false }, // camera inside the shell: draw its back faces (one double-sided program, no side switch)
    uTwo: { value: 2 },
    uThree: { value: 3 },
    uN: { value: 14 }, // samples per segment (a uniform bound: FXC would unroll a constant one)
  };
  const vertexShader = /* glsl */ `
    uniform vec2 uResolution;
    varying vec3 vPosW;
    varying float vPx;
    void main() {
      vPx = 2.0 / (projectionMatrix[1][1] * uResolution.y);   // pixel angle (rad)
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  const fragmentShader = /* glsl */ `
    precision highp float;
    uniform vec3 uSunPosW, uSunColor, uCenterW;
    uniform mat3 uRotW;
    uniform float uFlat, uR, uTop, uH1, uTau1, uH2, uTau2, uHR, uGain;
    uniform vec3 uRayTau, uHazeAlb, uHazeSpec;
    uniform bool uInside;
    uniform int uTwo, uN, uThree;
    varying vec3 vPosW;
    varying float vPx;
    ${COMMON_GLSL}

    // Chapman grazing-incidence function (Schuler 2012): column along a ray relative to the vertical column at the
    // deck, including the density at the sample. X = R/H, h = altitude/H.
    float chapman(float X, float h, float cosz) {
      float c = sqrt(X + h);
      float t1 = c / (1.0 + c * abs(cosz)) * exp(-h);
      float x0 = sqrt(max(1.0 - cosz * cosz, 0.0)) * (X + h);
      float t2 = 2.0 * sqrt(x0) * exp(min(X - x0, 80.0));
      return cosz >= 0.0 ? t1 : t2 - t1;   // (branch-free form of the same expression)
    }

    // single scattering along one ray through the shell (scaled frame); returns (inscatter, luminance transmittance)
    vec4 march(vec3 ro, vec3 rd, vec3 Ls, float k, vec3 Hs) {
      vec2 ta = nepRaySphere(ro, rd, uTop);
      if (ta.x > ta.y || ta.y <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
      vec2 tp = nepRaySphere(ro, rd, uR);
      bool hit = tp.x < tp.y && tp.y > 0.0;
      float t0 = max(ta.x, 0.0);
      float t1 = hit ? max(tp.x, t0) : ta.y;
      if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
      float tc = clamp(-dot(ro, rd), t0, t1);
      float H1 = Hs.x, H2 = Hs.y, HR = Hs.z;
      // vertical optical depths are kept when a scale height is widened
      float cosT = dot(rd, Ls);   // scattering angle: 1 = looking toward the Sun (forward scattering)
      float Ph = 0.93 * hg(cosT, 0.62) + 0.07 * hg(cosT, -0.3);
      float Pr = 0.75 * (1.0 + cosT * cosT);
      vec3 sumL = vec3(0.0);
      vec3 tauV = vec3(0.0);
      // two segments, samples clustered toward the lowest point (tangent point or deck hit); one flat loop
      float fN = float(uN);
      for (int kk = 0; kk < 2 * uN; kk++) {
        int seg = kk < uN ? 0 : 1;
        int i = kk - seg * uN;
        float a = seg == 0 ? t0 : tc;
        float b = seg == 0 ? tc : t1;
        if (b - a <= 1e-7) continue;
        {
          float s0 = float(i) / fN, s1 = float(i + 1) / fN;
          float u0 = seg == 0 ? 1.0 - (1.0 - s0) * (1.0 - s0) : s0 * s0;
          float u1 = seg == 0 ? 1.0 - (1.0 - s1) * (1.0 - s1) : s1 * s1;
          float ta_ = mix(a, b, u0), tb_ = mix(a, b, u1);
          float dt = (tb_ - ta_);
          vec3 pos = ro + rd * (0.5 * (ta_ + tb_));
          float r = length(pos);
          float h = max(r - uR, 0.0);
          float d1 = exp(-h / H1), d2 = exp(-h / H2), dR = exp(-h / HR);
          vec3 bh = (uTau1 / H1 * d1 + uTau2 / H2 * d2) * uHazeSpec;
          vec3 br = uRayTau / HR * dR;
          vec3 ext = bh + br;
          float dtw = dt / k;
          // sunlight reaching this sample: the planet's shadow cylinder, then the slant column toward the Sun
          float cz = dot(pos, Ls) / r;
          float sinz = sqrt(max(1.0 - cz * cz, 0.0));
          float sh = cz >= 0.0 ? 1.0 : smoothstep(uR * 0.9995, uR * 1.0012, r * sinz);
          vec3 tauS = vec3(0.0);
          if (sh > 0.0) {
            // the three species' slant columns toward the Sun in one loop (one chapman() call site)
            for (int l = 0; l < uThree; l++) {
              float Hl = l == 0 ? H1 : (l == 1 ? H2 : HR);
              vec3 tl = l == 0 ? uTau1 * uHazeSpec : (l == 1 ? uTau2 * uHazeSpec : uRayTau);
              tauS += tl * chapman(uR / Hl, h / Hl, cz);
            }
          }
          vec3 att = exp(-(tauV + 0.5 * ext * dtw) - min(tauS, vec3(60.0))) * sh;
          sumL += (uHazeAlb * bh * Ph + br * Pr) * att * dtw * 0.25;
          tauV += ext * dtw;
        }
      }
      return vec4(sumL, dot(exp(-tauV), vec3(0.2126, 0.7152, 0.0722)));
    }

    void main() {
      if (gl_FrontFacing == uInside) discard;   // front faces from outside, back faces from inside
      mat3 Ri = transpose(uRotW);
      vec3 sc = vec3(1.0, 1.0 / uFlat, 1.0);
      vec3 ro = (Ri * (-uCenterW)) * sc;
      vec3 rdw = normalize(vPosW);
      vec3 rd = (Ri * rdw) * sc;
      float k = length(rd);   // scaled length per world length
      rd /= k;
      vec3 Lw = normalize(uSunPosW - vPosW);
      vec3 Ls = normalize((Ri * Lw) * sc);

      // pixel footprint at the closest approach, and the impact parameter of the ray
      float tcl = -dot(ro, rd);
      vec3 pc = ro + rd * tcl;
      float bimp = length(pc);
      float foot = vPx * max(tcl, length(ro) * 0.05);
      vec3 Hs = max(vec3(uH1, uH2, uHR), vec3(1.3 * foot));
      // fraction of this pixel inside the silhouette (matches the globe's MSAA coverage)
      float fHit = clamp(0.5 + (uR - bimp) / max(foot, 1e-6), 0.0, 1.0);
      bool edge = tcl > 0.0 && fHit > 0.0 && fHit < 1.0;
      vec3 nrm = pc / max(bimp, 1e-9);

      vec4 acc = vec4(0.0);
      for (int i = 0; i < uTwo; i++) {
        if (i == 1 && !edge) break;
        vec3 r = rd;
        float w = 1.0;
        if (edge) {
          // i = 0: a ray just outside the limb, i = 1: one just inside it
          float bt = i == 0 ? uR + 0.5 * foot : uR - 0.5 * foot;
          r = normalize(rd + nrm * ((bt - bimp) / tcl));
          w = i == 0 ? 1.0 - fHit : fHit;
        }
        acc += w * march(ro, r, Ls, k, Hs);
      }
      if (acc.a > 0.99999 && dot(acc.rgb, vec3(1.0)) < 1e-9) discard;
      gl_FragColor = vec4(acc.rgb * uSunColor * uGain, acc.a);
    }`;
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    forceSinglePass: true,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}
