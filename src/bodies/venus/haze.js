// Venus — the haze above the cloud deck: a transparent shell integrated per pixel (single scattering of
// sunlight with analytic Chapman optical depths toward the Sun, plus approximate multiple scattering: the diffuse
// light of the bright cloud below, the forward-diffused part of the sunbeam, and the twilight that diffuses past
// the shadow line into the night side). It produces the soft bright limb, the broad twilight terminator, the
// forward-scattering crescent with its HDR glowing limb, and the cusps reaching round the night side into a ring.
//
// Blending: out = L + dst * T  (CustomBlending One / SrcAlpha), drawn after the opaque deck.
// Sampling is concentrated around the lowest point of each ray (where the exponential haze lives) and, near the
// limb, each pixel integrates 4 sub-rays across its radial footprint so the thin layers never alias.
//
// Compile cost (ANGLE -> HLSL -> FXC): every loop bound is a uniform (real loops, no unrolling); the per-sample
// body calls the Chapman function once per layer group and the planet-shadow test once.
import { VENUS_COMMON_GLSL, KM } from './common.js';

export function hazeShaders() {
  const vertexShader = /* glsl */ `
    varying vec3 vPos;
    void main() {
      vPos = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

  const fragmentShader = /* glsl */ `
    precision highp float;
    #define KM ${KM.toExponential(8)}
    ${VENUS_COMMON_GLSL}
    uniform vec3 uCamL;
    uniform vec3 uSunL;
    uniform vec3 uSunColor;
    uniform float uPix;
    uniform int uSteps;       // samples per ray segment (uniform => dynamic loop, fast compile)
    uniform int uSegs;        // always 2 (uniform => the segment loop is not unrolled either)
    uniform float uTwilight;  // e-folding (rad of solar zenith angle) of the multiply scattered twilight past the shadow line
    uniform float uTwA;       // twilight source strength at the shadow line (fraction of the overhead diffuse light)
    uniform float uTwK;       // diffusion attenuation of the twilight light per unit vertical optical depth above
    uniform float uMsF;       // forward-diffused share of the sunbeam that the single-scattering extinction removed
    uniform vec3 uMsTint;     // colour of multiply scattered light (the cloud's own cream: the unknown blue absorber)
    varying vec3 vPos;

    float sq(float x) { return x * x; }

    vec2 raySph(vec3 ro, vec3 rd, float r) {
      float tc = -dot(ro, rd);
      vec3 pc = ro + rd * tc;
      float h = r * r - dot(pc, pc);
      if (h < 0.0) return vec2(1e20, -1e20);
      h = sqrt(h);
      return vec2(tc - h, tc + h);
    }

    vec3 integrate(vec3 ro, vec3 rd, out vec3 T) {
      T = vec3(1.0);
      vec2 ta = raySph(ro, rd, uRt);
      if (ta.x > ta.y || ta.y <= 0.0) return vec3(0.0);
      vec2 tp = raySph(ro, rd, uRd);
      float t0 = max(ta.x, 0.0);
      float t1 = ta.y;
      if (tp.x < tp.y && tp.y > 0.0) t1 = max(tp.x, t0);
      if (t1 <= t0) return vec3(0.0);
      float tm = clamp(-dot(ro, rd), t0, t1);
      float c = dot(rd, uSunL);
      float pA = phaseAer(c), pR = phaseRay(c);
      // multiply scattered light still travels roughly sunward-to-antisunward: a broadened forward lobe
      float pMs = 0.75 * hg(0.6, c) + 0.25;
      vec3 L = vec3(0.0);
      vec3 tauV = vec3(0.0);   // view-path optical depth so far (camera side)
      float invN = 1.0 / float(uSteps);
      for (int seg = 0; seg < uSegs; seg++) {
        float a = seg == 0 ? t0 : tm;
        float b = seg == 0 ? tm : t1;
        float len = b - a;
        if (len <= 0.0) continue;
        float tPrev = a;
        for (int i = 1; i <= uSteps; i++) {
          float u = float(i) * invN;
          float tt = seg == 0 ? (b - len * sq(1.0 - u)) : (a + len * u * u);
          float ds = tt - tPrev;
          vec3 p = ro + rd * (tPrev + 0.5 * ds);
          tPrev = tt;
          float r = length(p);
          float h = max(r - uRd, 0.0);
          float y = p.y / r;
          float pol = polarHaze(y);
          float tap = hazeTaper(h);
          vec3 sA = ((uAerB * exp(-h / uHgt.x) + uUpB * exp(-h / uHgt.y)) * pol
                  + uExtB * exp(-h / uHgt.w) + uDetB * exp(-sq((h - uDet.x) / uDet.y))) * tap;
          vec3 sR = uRayB * exp(-h / uHgt.z);
          vec3 ext = sA * (AER_EXT / uHazeOmega) + sR;
          float mus = dot(p, uSunL) / r;
          // direct sunbeam (delta-scaled extinction) and the part of it that the aerosol scattered forward on the
          // way in: that light is not lost, it arrives as a broadened, cream-tinted forward glow (it is what lets
          // the optically thick limb glow beyond what single scattering gives)
          vec3 tS = tauToSun(r, mus, pol);
          float lit = sunVisible(r, mus);
          vec3 Ts = exp(-tS) * lit;
          vec3 Tf = (exp(-0.45 * tS) - exp(-tS)) * lit;
          // diffuse source: multiple scattering inside the cloud top and upwelling light from the deck below
          float mup = 0.04 * log(1.0 + exp(mus / 0.04));
          vec3 J = uMsTint * (1.97 * mup / (1.0 + 0.12 * mup) * mix(1.0, 0.7, smoothstep(0.0, 25.0 * KM, h)));
          // twilight: light that reached the haze near its shadow line keeps diffusing into the night side through
          // the haze (and between the haze and the bright deck below), decaying with the solar zenith angle past the
          // line where the Sun sets behind the cloud-top haze. It reaches a point through the haze above it, so it is
          // attenuated by the vertical optical depth above (diffusion), not by the grazing path of the direct beam.
          float chi = acos(clamp(mus, -1.0, 1.0));
          float sinLit = min((uRd + 2.5 * uHgt.x) / r, 1.0);
          float dchi = chi - (0.5 * PI + acos(sinLit));
          vec3 tw = vec3(0.0);
          if (dchi > -0.08) {
            float dc = max(dchi, 0.0);
            vec3 tauUp = (uAerB * uHgt.x * exp(-h / uHgt.x) + uUpB * uHgt.y * exp(-h / uHgt.y)) * pol + uExtB * uHgt.w * exp(-h / uHgt.w);
            tw = uMsTint * uTwA * exp(-dc / uTwilight - sq(dc / 0.5)) * smoothstep(-0.08, 0.04, dchi) * exp(-uTwK * tauUp);
          }
          vec3 src = Ts * pA + uMsF * Tf * uMsTint * pMs + J + tw * pMs;
          vec3 S = (sA * src + sR * (Ts * pR + J + tw)) * 0.25;
          // light that left the deep, optically thick limb has been scattered several times: give it the tint of
          // the slightly blue-absorbing droplets (uMsTint^n with n growing with the optical depth already crossed)
          // (a base share of it everywhere: even the thin high haze carries a trace of the absorber)
          S *= pow(uMsTint, vec3(0.35 + 0.15 * min(tauV.g, 6.0)));
          vec3 od = ext * ds;
          vec3 dT = exp(-od);
          vec3 seg_ = mix(vec3(ds), (1.0 - dT) / max(ext, vec3(1e-20)), step(vec3(1e-4), od));
          L += T * S * seg_;
          T *= dT;
          tauV += od;
        }
      }
      return L;
    }

    void main() {
      vec3 ro = uCamL;
      vec3 rd = normalize(vPos - ro);
      float tc = -dot(ro, rd);
      vec3 pc = ro + rd * tc;
      float b = length(pc);
      float pixR = max(tc, 1e-6) * uPix;
      vec3 L, T;
      // thin limb layers: integrate across the pixel's radial footprint (4 sub-rays), elsewhere one ray
      int nss = (b > uRd - 2.0 * pixR && b < uRd + 90.0 * KM && pixR > 0.6 * uHgt.x) ? 4 : 1;
      vec3 radial = pc / max(b, 1e-9);
      L = vec3(0.0); T = vec3(0.0);
      for (int k = 0; k < nss; k++) {
        float o = nss == 1 ? 0.0 : (float(k) - 1.5) * 0.25;
        vec3 Tk;
        L += integrate(ro, normalize(rd + radial * (uPix * o)), Tk);
        T += Tk;
      }
      float inv = 1.0 / float(nss);
      L *= inv; T *= inv;
      gl_FragColor = vec4(L * uSunColor, dot(T, vec3(1.0 / 3.0)));
    }`;
  return { vertexShader, fragmentShader };
}
