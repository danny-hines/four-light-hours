// Mars' thin dusty atmosphere as a transparent shell. Output = in-scattered light + dst x transmittance.
//
// Dust (exponential, H ~9.5 km, tau ~0.21 at the datum in the clear northern-spring season), with the optics
// from glsl.js (diffraction peak + broad lobe + backscatter, blue-absorbing), treated consistently:
//   - extinction is delta-scaled (light diffracted into the narrow forward peak stays in the beam), for the
//     sunbeam, the view path and the background transmittance alike; the bluer light keeps more of its forward
//     peak, so sunlight that grazes through the dust near the terminator turns slightly blue;
//   - single scattering uses the full phase function with the matching scattering coefficient (no double count);
//   - a small second-order term: sunlight already scattered once (isotropic, reddened by omega^2) and light
//     reflected by the orange ground below (which is what makes the low haze butterscotch).
// Plus a detached dust layer (~24 km), two thin water-ice haze layers (~46 and ~61 km: the bright lines seen
// over the limb in orbiter images), modulated along the limb, and a trace of CO2 Rayleigh scattering.
// Works in body-fixed coordinates with the oblateness stretched out (y / (1 - f)) so the geometry is spherical.
import { MARS_COMMON } from './glsl.js';

export function createAtmosphereMaterial(ctx, { params, relief }) {
  const { THREE, U } = ctx;
  const uniforms = {
    uSunDir: { value: new THREE.Vector3(1, 0, 0) },
    uCamKm: { value: new THREE.Vector3(10000, 0, 0) }, // body-fixed, km, y already stretched
    uSunColor: U.uSunColor,
    uRp: { value: params.radiusKm },
    uRa: { value: params.radiusKm + params.topKm },
    uFlat: { value: params.flattening },
    uTau0: { value: params.tau0 },
    uHd: { value: params.Hdust },
    uSunAng: { value: 0.003 },
    uHazeGain: { value: 1.0 },
    uMS: { value: 1.0 },
    uPixAngle: { value: 0.001 },
    uLs: { value: params.ls ?? 0 },
    tRelief: { value: relief ? relief.texture : null },
    uNA: { value: 22 },
    uNB: { value: 16 },
    uNoiseN: { value: 5 },
    // 1 when the camera is inside the shell: the back faces draw (without depth test) instead of the front faces.
    // (one DoubleSide program: switching material.side would compile a second program mid-film)
    uInside: { value: 0 },
  };
  // dev-only overrides: ?mars_tau=0.3&mars_haze=1&mars_ms=1
  const qp = new URLSearchParams(globalThis.location ? globalThis.location.search : '');
  if (qp.has('mars_haze')) uniforms.uHazeGain.value = Number(qp.get('mars_haze'));
  if (qp.has('mars_ms')) uniforms.uMS.value = Number(qp.get('mars_ms'));
  const vertexShader = /* glsl */ `
    uniform float uRa, uFlat;
    varying vec3 vPosKm;
    void main() {
      // geometry: oblate shell in km (the mesh carries a km -> scene-unit scale); shading works in
      // stretched space where the shell and the planet are spheres
      vPosKm = vec3(position.x, position.y / (1.0 - uFlat), position.z);
      gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
    }`;
  const fragmentShader = /* glsl */ `
    ${MARS_COMMON}
    uniform vec3 uSunDir, uCamKm, uSunColor;
    uniform float uRp, uRa, uFlat, uTau0, uHd, uSunAng, uHazeGain, uMS, uPixAngle, uLs;
    uniform sampler2D tRelief;
    uniform int uNA, uNB, uNoiseN;
    uniform float uInside;
    varying vec3 vPosKm;

    // mean surface albedo under the haze (bright dust / dark basalt mix), for the ground-lit term
    const vec3 ALB_G = vec3(0.27, 0.125, 0.055);

    vec2 raySph(vec3 ro, vec3 rd, float r) {
      float b = dot(ro, rd);
      float c = dot(ro, ro) - r * r;
      float h = b * b - c;
      if (h < 0.0) return vec2(1e20, -1e20);
      h = sqrt(h);
      return vec2(-b - h, -b + h);
    }

    // geometric shadow of the planet for a point at radius r with sun zenith cosine mu (finite solar disc)
    float planetShadow(float r, float mu) {
      if (mu >= 0.0) return 1.0;
      float rp = r * sqrt(max(1.0 - mu * mu, 0.0));
      float w = sqrt(max(r * r - uRp * uRp, 1.0)) * uSunAng;
      return smoothstep(uRp - w, uRp + w, rp);
    }

    void main() {
      if (gl_FrontFacing == (uInside > 0.5)) discard;
      vec3 ro = uCamKm;
      vec3 rd = normalize(vPosKm - ro);
      vec2 ta = raySph(ro, rd, uRa);
      if (ta.y <= 0.0 || ta.x > ta.y) discard;
      float t0 = max(ta.x, 0.0), t1 = ta.y;
      // the haze stops at the terrain: the dust column over Tharsis and Olympus (10-21 km up) is a fraction of the
      // one over Hellas (-7 km), so the limb haze thins over the volcanoes and thickens over the basins. The
      // (smoothed) MOLA height is sampled once, under the point of closest approach
      float tc = clamp(-dot(ro, rd), t0, t1);
      vec3 dC = normalize(ro + rd * tc);
      float hS = textureLod(tRelief, vec2(atan(-dC.z, dC.x) * 0.15915494 + 0.5, asin(clamp(dC.y, -1.0, 1.0)) * 0.31830989 + 0.5), 4.0).r;
      hS = clamp(hS, -7.0, 18.0);
      vec2 tp = raySph(ro, rd, uRp + hS);
      bool hitsGround = tp.x < tp.y && tp.x > 0.0;
      if (hitsGround) t1 = min(t1, tp.x);
      if (t1 <= t0) discard;
      vec3 L = uSunDir;
      float muS = dot(rd, L);

      // split the path at the closest approach to the centre and crowd samples toward it
      float tm = clamp(-dot(ro, rd), t0, t1);

      // haze structure varies along the limb: sample slow noise once, at the point nearest the planet
      vec3 dTan = normalize(ro + rd * tm);
      // (one noise call site in a loop: FXC inlines a copy of the noise per call site)
      float n1 = 0.0, n2 = 0.0, n3 = 0.0, hn = 0.0;
      for (int i = 0; i < uNoiseN; i++) {
        vec3 q = i == 0 ? dTan * 3.1 + 4.0 : i == 1 ? dTan * 9.7 + 1.0 : i == 2 ? dTan * 6.3 + 8.0
               : i == 3 ? dTan * vec3(14.0, 5.0, 14.0) + 21.0 : dTan * 31.0 + 2.0;
        float v = gnoised(q).x;
        if (i == 0) n1 = v; else if (i == 1) n2 = v; else if (i == 2) n3 = v; else if (i == 3) hn += 0.6 * v; else hn += 0.4 * v;
      }
      // northern spring: the dust is concentrated at low latitudes; the high latitudes are clearer
      float latF = 1.0 - 0.45 * smoothstep(0.7, 0.95, abs(dTan.y));
      float dustMod = (1.0 + 0.2 * n1 + 0.09 * n2) * latF;
      // detached dust layer near 24 km (common at low latitudes in northern spring/summer, MCS)
      float detA = 0.08 * clamp(0.6 + 0.8 * n3, 0.0, 1.4), detH = 24.0 + 3.0 * n1;
      // water-ice haze: a main layer near 46 km and a fainter one near 61 km; patchy along the limb
      float i1H = 46.0 + 2.5 * n2, i1W = 2.6, i1T = 0.006 * clamp(0.55 + 0.9 * n3, 0.1, 1.6);
      float i2H = 61.0 + 2.0 * n1, i2W = 2.2, i2T = 0.0016 * clamp(0.6 - 0.8 * n2, 0.1, 1.4);
      // a layer thinner than a pixel at the limb would alias into dots: widen it to the pixel footprint there
      // (normalised by width, so the layer's column -- and its integrated brightness -- is unchanged)
      float fpK = length(ro + rd * tm - ro) * uPixAngle;
      i1W = sqrt(i1W * i1W + fpK * fpK);
      i2W = sqrt(i2W * i2W + fpK * fpK);
      float detW = sqrt(16.0 + fpK * fpK);

      float betaD = uTau0 / uHd;                    // dust extinction (true) at the datum, per km
      vec3 betaR = vec3(0.0011, 0.0024, 0.0052) / 11.0; // CO2 Rayleigh (tau ~0.001..0.005, H 11 km)
      float i1N = i1T / (i1W * 1.7724539), i2N = i2T / (i2W * 1.7724539);
      // north polar hood (water-ice haze over the retreating seasonal cap in early spring, ~50-75 N, 8-25 km),
      // thinning as the season advances; streaky and patchy (sampled once per pixel along the limb point)
      float hoodSeason = 1.0 - smoothstep(20.0, 60.0, uLs) * (1.0 - smoothstep(150.0, 180.0, uLs));
      float hoodN = 0.035 * hoodSeason * clamp(0.5 + 0.9 * hn, 0.0, 1.4) / (7.0 * 1.7724539);

      vec3 sumD = vec3(0.0), sumM = vec3(0.0), sumG = vec3(0.0), sumI = vec3(0.0), sumR = vec3(0.0);
      // od: true optical depth along the view (attenuates the in-scattered light: energy-consistent single
      // scattering); odB: delta-scaled (the ground image behind the haze keeps its forward-scattered light)
      vec3 od = vec3(0.0);
      float odB = 0.0;
      // one loop over both segments (uNA + uNB samples; uniform bounds so FXC emits a real loop)
      for (int it = 0; it < uNA + uNB; it++) {
        int seg = it < uNA ? 0 : 1;
        int k = it - seg * uNA;
        float a = seg == 0 ? t0 : tm;
        float b = seg == 0 ? tm : t1;
        float len = b - a;
        if (len <= 1e-3) continue;
        int n = seg == 0 ? uNA : uNB;
        {
          float x = (float(k) + 0.5) / float(n);
          // seg 0 crowds toward its end (tm), seg 1 toward its start (tm)
          float s = seg == 0 ? b - len * (1.0 - x) * (1.0 - x) : a + len * x * x;
          float ds = seg == 0 ? 2.0 * len * (1.0 - x) / float(n) : 2.0 * len * x / float(n);
          vec3 p = ro + rd * s;
          float r = length(p);
          float h = r - uRp;
          float zd = (h - detH) / detW;
          float dD = (exp(-h / uHd) + detA * (4.0 / detW) * exp(-zd * zd)) * dustMod;
          float z1 = (h - i1H) / i1W, z2 = (h - i2H) / i2W;
          float latS = p.y / r;                        // sin(latitude)
          float zh = (h - 15.0) / 7.0;
          float hoodW = smoothstep(0.75, 0.83, latS) * (1.0 - smoothstep(0.94, 0.985, latS));
          float dI = i1N * exp(-z1 * z1) + i2N * exp(-z2 * z2) + hoodN * hoodW * exp(-zh * zh);
          float dR = exp(-h / 11.0);
          vec3 dtau = (betaD * dD + dI + betaR * dR) * ds;
          vec3 Tv = exp(-(od + 0.5 * dtau));
          // sunlight at p: planet shadow x dust extinction (Chapman grazing incidence)
          float mu = dot(p, L) / r;
          float sh = planetShadow(r, mu);
          float tauS = min(uTau0 * exp(-h / uHd) * chapman(r / uHd, mu) * dustMod, 60.0);
          vec3 Ts = vec3(sh * exp(-tauS));
          // ground below p: its sunlit, orange reflection lights the haze from beneath
          float mg = dot(p / r, L);
          vec3 Tg = exp(-min(DUST_EXT * uTau0 * chapman(uRp / uHd, mg), vec3(60.0))) * smoothstep(-0.01, 0.03, mg);
          vec3 w = Tv * ds * dD;
          sumD += w * Ts;
          // higher orders. Only light scattered OUT of the delta-scaled beam is available for a second
          // scattering (the diffraction peak stays in the beam and is already in Ts), so the probability that a
          // photon scatters again is ~ the local delta-scaled optical thickness (sun path + dust below), and the
          // second-order light is spread over the broad part of the phase function, not isotropically: this is
          // ~40% of the old (double-counting) estimate. Each order is reddened by omega (orders 2..3).
          float kap = 0.55 * (1.0 - exp(-DUST_EXT.g * (tauS + uTau0 * exp(-h / uHd))));
          vec3 wk = DUST_OMEGA * kap;
          sumM += w * sh * exp(-DUST_EXT.g * tauS) * wk * (1.0 + wk);
          // light reflected by the ground below lights the haze from beneath. Its forward-scattered part (seen
          // looking down) stays in the ground image (delta-scaled background transmittance), so only the broad
          // non-forward part of the phase function, at the real scattering angle (upwelling -> toward camera), counts
          float cg = dot(p / r, -rd);
          sumG += w * max(mg, 0.0) * Tg * dustPhaseBroad(cg);
          sumI += Tv * ds * dI * Ts;
          sumR += Tv * ds * dR * Ts;
          od += dtau;
          odB += (DUST_EXT.g * betaD * dD + 0.6 * dI) * ds;
        }
      }
      vec3 Ld = betaD * DUST_OMEGA * dustPhase(muS) * sumD;
      vec3 Lm = uMS * betaD * DUST_OMEGA * (0.5 / (4.0 * PI)) * sumM;
      // ground radiance ALB_G mu0 / pi, scattered with the broad lobe (sr^-1, already in sumG)
      // (per unit solar flux: ground radiance ALB_G mu0 Tg / pi from ~2 pi sr below -> 2 P ALB_G mu0 Tg)
      vec3 Lg = uMS * betaD * DUST_OMEGA * ALB_G * 2.0 * sumG;
      // water ice: brighter, near-neutral, strongly forward-scattering
      vec3 Li = sumI * (0.7 * hgPhase(muS, 0.75) + 0.3 * hgPhase(muS, 0.1)) * vec3(0.92, 0.96, 1.0);
      vec3 Lr = sumR * betaR * (3.0 / (16.0 * PI)) * (1.0 + muS * muS);
      vec3 col = PI * (Ld + Lm + Lg + Li + Lr) * uSunColor * uHazeGain;
      float T = exp(-odB);
      gl_FragColor = vec4(col, T);
    }`;
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
    forceSinglePass: true, // (otherwise three.js draws transparent double-sided materials as two programs)
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.SrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
  });
}
