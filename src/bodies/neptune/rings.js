// Neptune's ring system (Voyager 2 / Keck / JWST): Galle, Le Verrier, Lassell, Arago, Adams, and the Adams-ring
// arcs Fraternite, Egalite 1 & 2, Liberte and Courage, which co-rotate at the Galatea 42:43 corotation-resonance
// rate (820.1185 deg/day). Liberte and Courage are drawn faded, as observed after ~2005.
//
// Optically thin single scattering: I/F = tau / (4 mu) * [f_dust * w_dust * HG(g=0.7) + (1 - f_dust) * w_big * P_lambert(a)]
// so the rings are nearly invisible in backscatter and light up only near the Sun (forward scattering), as in the
// Voyager 2 departure frames. Narrow rings are filtered by their equivalent width over the pixel footprint, so they
// stay a stable, energy-preserving line when sub-pixel (no shimmer). Neptune's shadow falls on them analytically.
import * as THREE from 'three';
import { COMMON_GLSL, KM_PER_UNIT } from './common.js';

export const ADAMS_RATE_DEG_PER_DAY = 820.1185;
const DEG = Math.PI / 180;

export function makeRings(ctx, { radius, flat }) {
  const { U } = ctx;
  const inner = 39500 / KM_PER_UNIT,
    outer = 64200 / KM_PER_UNIT;
  const geo = new THREE.RingGeometry(inner, outer, 1024, 1);
  geo.rotateX(-Math.PI / 2); // into the x-z plane; +y = Neptune's pole
  const uniforms = {
    uSunPosW: U.uSunPosW,
    uSunColor: U.uSunColor,
    uSunRadius: U.uSunRadius,
    uCenterW: { value: new THREE.Vector3() },
    uPoleW: { value: new THREE.Vector3(0, 1, 0) },
    uRotW: { value: new THREE.Matrix3() }, // pole frame (no spin) -> world, for the oblate shadow test
    uR: { value: radius },
    uFlat: { value: 1 - flat },
    uArc: { value: 0 }, // rotation of the arc pattern (radians)
    uGain: { value: 55.0 }, // cinematic gain over the physical I/F (rings are ~1e-3 of the planet)
    uKm: { value: KM_PER_UNIT },
    // Adams-ring arcs relative to Fraternite's centre: (centre, half-length rad, peak tau, seed)
    uArcs: {
      value: [
        [0.0, 4.8, 0.16, 3],
        [12.6, 0.8, 0.13, 11],
        [15.6, 1.5, 0.1, 17],
        [26.0, 1.9, 0.03, 23],
        [33.5, 0.6, 0.035, 29],
      ].map(([c, hl, tp, sd]) => new THREE.Vector4(c * DEG, hl * DEG, tp, sd)),
    },
    uNArcs: { value: 5 },
  };
  const vertexShader = /* glsl */ `
    varying vec3 vPosL;
    varying vec3 vPosW;
    void main() {
      vPosL = position;
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vPosW = wp.xyz;
      gl_Position = projectionMatrix * viewMatrix * wp;
    }`;
  const fragmentShader = /* glsl */ `
    precision highp float;
    uniform vec3 uSunPosW, uSunColor, uCenterW, uPoleW;
    uniform float uSunRadius, uR, uFlat, uArc, uGain, uKm;
    uniform mat3 uRotW;
    uniform vec4 uArcs[5];
    uniform int uNArcs;
    varying vec3 vPosL;
    varying vec3 vPosW;
    ${COMMON_GLSL}

    // narrow ring: centre c, FWHM w (km), peak normal optical depth tp; filtered over footprint fr (km)
    float narrow(float r, float c, float w, float tp, float fr) {
      float s0 = w / 2.3548;
      float s = sqrt(s0 * s0 + 0.25 * fr * fr);
      float d = (r - c) / s;
      return tp * (s0 / s) * exp(-0.5 * d * d);
    }
    // broad band [a, b] with soft edges e (km), box-filtered by the footprint
    float band(float r, float a, float b, float e, float tp, float fr) {
      float ee = max(e, fr);
      return tp * smoothstep(a - ee, a + ee, r) * (1.0 - smoothstep(b - ee, b + ee, r));
    }
    float wrapPi(float a) { return mod(a + PI, TAU) - PI; }
    float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
    float vn(float x) { float i = floor(x), f = fract(x); return mix(h11(i), h11(i + 1.0), f * f * (3.0 - 2.0 * f)); }
    // clumpy arc: centre angle c, half-length hl (rad), peak tau tp; ft = angular footprint (rad).
    // Voyager and Keck resolve each arc into a few bright clumps ~0.5-1 deg long with fainter gaps between them.
    float arc(float th, float c, float hl, float tp, float ft, float seed) {
      float d = wrapPi(th - c);
      float hh = hl + ft;
      if (abs(d) > hh * 1.4) return 0.0;
      float env = smoothstep(hh * 1.2, hh * 0.7, abs(d));
      float x = d / 0.0115 + seed;
      float cl = vn(x);
      float cl2 = vn(d / 0.0045 + seed * 1.7 + 9.0);
      float clumps = 0.12 + 1.5 * cl * cl * (0.65 + 0.7 * cl2);
      // averaged by the footprint when the clumps are sub-pixel
      clumps = mix(0.62, clumps, smoothstep(0.03, 0.004, ft));
      return tp * env * clumps;
    }

    void main() {
      float rk = length(vPosL.xz) * uKm;
      float th = atan(-vPosL.z, vPosL.x);
      float fr = max(fwidth(rk), 0.5);
      float ft = fr / rk;

      // dusty, broad components
      float tauD = 0.0;
      // (broad sheets are ~1/5 of the narrow rings' brightness at typical pixel footprints, as in Voyager's frames)
      tauD += band(rk, 40900.0, 42900.0, 450.0, 3.0e-5, fr);           // Galle
      tauD += band(rk, 53200.0, 57200.0, 300.0, 3.5e-5, fr);           // Lassell (sheet)
      tauD += narrow(rk, 57200.0, 90.0, 3.0e-4, fr);                   // Arago
      // narrow rings with a larger macroscopic-particle fraction
      float tauN = 0.0;
      tauN += narrow(rk, 53200.0, 113.0, 2.0e-3, fr);                  // Le Verrier
      // Adams: faint azimuthal structure along the whole ring
      float az = 0.75 + 0.25 * vn(th * 9.0 + 3.0) + 0.12 * (vn(th * 37.0) - 0.5);
      tauN += narrow(rk, 62932.0, 35.0, 3.0e-3 * az, fr);              // Adams
      // Adams arcs (relative to Fraternite's centre, degrees -> rad), 15 km wide, clumpy
      float ta = th - uArc;
      // Fraternite, Egalite 1, Egalite 2, Liberte (faded), Courage (faded, moved ahead): one loop, one call site
      float arcs = 0.0;
      if (abs(rk - 62932.0) < 60.0 + 3.0 * fr) {
        for (int i = 0; i < uNArcs; i++) arcs += arc(ta, uArcs[i].x, uArcs[i].y, uArcs[i].z, ft, uArcs[i].w);
      }
      vec3 V = normalize(-vPosW);
      vec3 toSun = uSunPosW - vPosW;
      float dSun = length(toSun);
      vec3 L = toSun / dSun;
      float mu = max(abs(dot(V, uPoleW)), 0.015);
      float cosA = dot(L, V);              // cos(phase angle)
      float cosT = -cosA;                  // cos(scattering angle)
      float alpha = acos(clamp(cosA, -1.0, 1.0));
      // At low phase the cinematic gain would show the dense arcs alone, a stray scratch with no ring around it:
      // there they are held to a few times the ring's own brightness, and reach their full contrast when backlit.
      float arcVis = mix(0.12, 1.0, smoothstep(radians(80.0), radians(150.0), alpha));
      tauN += arcs * arcVis * narrow(rk, 62932.0, 15.0, 1.0, fr);

      float tau = tauD + tauN;
      if (tau < 1e-8) discard;
      float Plam = 8.0 / (3.0 * PI) * (sin(alpha) + (PI - alpha) * cosA);
      // the cinematic gain lifts the forward-scattering dust lobe fully, the backscatter terms only ~1/3, so the rings
      // glow when backlit (as in Voyager's departure frames) but stay near-invisible across a low-phase disc
      float gB = 0.33;
      float Pd = 0.85 * hg(cosT, 0.72) + gB * 0.15 * hg(cosT, -0.2);
      // dust fraction: broad rings ~70 % dust, narrow rings / arcs ~40 %; dust albedo 0.5, big particles 0.05
      float sD = 0.7 * 0.5 * Pd + gB * 0.3 * 0.05 * Plam;
      float sN = 0.4 * 0.5 * Pd + gB * 0.6 * 0.05 * Plam;
      float IF = (tauD * sD * 2.0 + tauN * sN) / (4.0 * mu);

      // Neptune's shadow (oblate: test in the frame where the ellipsoid is a sphere)
      mat3 Ri = transpose(uRotW);
      vec3 sc = vec3(1.0, 1.0 / uFlat, 1.0);
      vec3 P = (Ri * (vPosW - uCenterW)) * sc;
      vec3 Ls = normalize((Ri * L) * sc);
      float b = dot(P, Ls);
      float shadow = 1.0;
      if (b < 0.0) {
        float d = sqrt(max(dot(P, P) - b * b, 0.0));
        float pw = max(-b * uSunRadius / dSun, 1e-5) + uR * 0.004;
        shadow = smoothstep(uR - pw, uR + pw, d);
      }
      vec3 tint = vec3(1.0, 0.82, 0.68);   // reddish: dark, radiation-processed organics on the particles (Voyager)
      vec3 col = IF * uGain * shadow * tint * uSunColor;
      float T = exp(-tau / mu);
      gl_FragColor = vec4(col, T);
    }`;
  const mat = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
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
  mesh.name = 'neptune-rings';
  mesh.renderOrder = 2;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
