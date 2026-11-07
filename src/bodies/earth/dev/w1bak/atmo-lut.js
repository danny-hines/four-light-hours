// Earth atmosphere look-up tables, computed once on the CPU at startup (deterministic, ~60 ms).
//
// Units: scene units (1 = 6371 km). Physically based: Rayleigh + Mie + ozone (Bruneton 2017 / Hillaire 2020 values).
//  - transmittance LUT  (256 x 64): sun/view transmittance from (r, mu) to the top of the atmosphere, Bruneton's
//                                    horizon-preserving parametrisation (no banding near the horizon).
//  - multi-scattering LUT (32 x 32): Hillaire's isotropic second-and-higher-order scattering Psi_ms(r, mu_s).
//  - sky-irradiance LUT  (64 x 1):  irradiance on the ground from the whole sky dome vs sun zenith cosine,
//                                    used for skylight on land/ocean and the twilight wedge past the terminator.
// All radiances are "per unit sun irradiance" (physical); shaders multiply by PI to match the contract's
// exposure model (white Lambertian surface under the sun = 1.0).
import * as THREE from 'three';

const KM = 1 / 6371;

// Single source of truth for the atmosphere (the shaders interpolate these numbers, see earth-glsl.js).
// Heights in km, coefficients in 1e-6 / m. S = modest vertical exaggeration of the whole atmosphere (all heights x S,
// all coefficients / S): every vertical column - and so the colour of the disc seen from above - is unchanged, while the
// limb seen edge-on is S times thicker on screen (a true 60 km shell is a hairline from low orbit) and slightly less
// dense (tangent optical depth ~ 1 / sqrt(S)).
//  - Rayleigh: Bruneton / Hillaire coefficients.
//  - Boundary-layer aerosol: AOD ~0.05 at 550 nm (a clean continental / maritime day). The Bruneton default (AOD
//    0.005) is laboratory-clean air: no white horizon haze from orbit, no aerial perspective in low-orbit views.
//    Single-scattering albedo 0.9, HG g 0.8.
//  - Stratospheric (Junge) aerosol layer near 20 km, tau ~0.006: the bright forward-scattering glow hugging the limb at an
//    orbital sunrise, and the yellow-white layer above the red troposphere band.
//  - Ozone: sRGB-CHANNEL-INTEGRATED Chappuis absorption (see below).
export const ATMO = {
  S: 1.35,
  topKm: 60, HRkm: 8.0, HMkm: 1.2, hOkm: 25, wOkm: 15, hJkm: 20, wJkm: 6,
  betaR: [5.802, 13.558, 33.1],
  betaMs: 36.0, betaMe: 40.0,
  // stratospheric aerosol peak, relative to the boundary-layer density at the ground
  kJ: 0.0145,
  // Ozone absorption is sRGB-channel-integrated, not monochromatic at the Bruneton/Hillaire sample wavelengths
  // (680 / 550 / 440 nm -> 0.650, 1.881, 0.085 e-6/m). The Chappuis band peaks at 602 nm, inside the red channel;
  // sampling red at 680 nm puts the whole band into "green", and along long tangent / grazing paths (airmass ~40
  // through the ozone layer) that depletes green against red and blue and turns twilight haze, the crescent rim and
  // the sunlit surface toward the sun mauve. Serdyuchenko cross-sections averaged over each channel give
  // (2.4, 1.70, 0.17) e-6/m at the 25 km peak: the zenith stays blue, grazing forward-scattered haze white-blue,
  // the twilight wedge orange, and the stratospheric band of the limb blue (ozone transmits blue).
  betaO: [2.4, 1.70, 0.17],
  g: 0.8,
};

export function earthAtmosphereParams(Rp) {
  const A = ATMO, S = A.S;
  const s = 6.371e6 * 1e-6 / S; // (1e-6 / m) -> per scene unit, divided by the exaggeration
  return {
    Rp,
    Rt: Rp + A.topKm * S * KM,
    HR: A.HRkm * S * KM,
    HM: A.HMkm * S * KM,
    betaR: A.betaR.map((v) => v * s),
    betaMs: A.betaMs * s,
    betaMe: A.betaMe * s,
    betaO: A.betaO.map((v) => v * s),
    hO: A.hOkm * S * KM,
    wO: A.wOkm * S * KM,
    g: A.g,
    hJ: A.hJkm * S * KM,
    wJ: A.wJkm * S * KM,
    kJ: A.kJ,
    groundAlbedo: 0.07,
  };
}

export const T_W = 256, T_H = 64, MS_N = 32, IRR_N = 64;

function extinction(P, h, out) {
  const dR = Math.exp(-Math.max(h, 0) / P.HR);
  // boundary-layer aerosol + a thin stratospheric (Junge) aerosol layer near 20 km (tau ~0.005): the latter makes
  // the bright forward-scattering glow that hugs the limb around an orbital sunrise
  const dM = Math.exp(-Math.max(h, 0) / P.HM) + P.kJ * Math.exp(-(((h - P.hJ) / P.wJ) ** 2));
  const dO = Math.max(0, 1 - Math.abs(h - P.hO) / P.wO);
  out[0] = P.betaR[0] * dR + P.betaMe * dM + P.betaO[0] * dO;
  out[1] = P.betaR[1] * dR + P.betaMe * dM + P.betaO[1] * dO;
  out[2] = P.betaR[2] * dR + P.betaMe * dM + P.betaO[2] * dO;
  DEN[0] = dR;
  DEN[1] = dM;
  return DEN;
}
const DEN = [0, 0]; // reused (no per-sample allocation in the hot loops)

function distToTop(P, r, mu) {
  const disc = r * r * (mu * mu - 1) + P.Rt * P.Rt;
  return Math.max(0, -r * mu + Math.sqrt(Math.max(disc, 0)));
}
function distToBottom(P, r, mu) {
  const disc = r * r * (mu * mu - 1) + P.Rp * P.Rp;
  return Math.max(0, -r * mu - Math.sqrt(Math.max(disc, 0)));
}
function hitsGround(P, r, mu) {
  return mu < 0 && r * r * (mu * mu - 1) + P.Rp * P.Rp >= 0;
}

// --- Bruneton transmittance parametrisation -------------------------------------------------------------
function transUVtoRMu(P, x_mu, x_r) {
  const H = Math.sqrt(P.Rt * P.Rt - P.Rp * P.Rp);
  const rho = H * x_r;
  const r = Math.sqrt(rho * rho + P.Rp * P.Rp);
  const dMin = P.Rt - r, dMax = rho + H;
  const d = dMin + x_mu * (dMax - dMin);
  let mu = d === 0 ? 1 : (H * H - rho * rho - d * d) / (2 * r * d);
  mu = Math.max(-1, Math.min(1, mu));
  return [r, mu];
}
function transRMuToUV(P, r, mu) {
  const H = Math.sqrt(P.Rt * P.Rt - P.Rp * P.Rp);
  const rho = Math.sqrt(Math.max(r * r - P.Rp * P.Rp, 0));
  const d = distToTop(P, r, mu);
  const dMin = P.Rt - r, dMax = rho + H;
  const x_mu = (d - dMin) / Math.max(dMax - dMin, 1e-12);
  const x_r = rho / H;
  return [x_mu, x_r];
}

function buildTransmittance(P) {
  const data = new Float32Array(T_W * T_H * 3);
  const ext = [0, 0, 0];
  const N = 96;
  for (let j = 0; j < T_H; j++) {
    for (let i = 0; i < T_W; i++) {
      const [r, mu] = transUVtoRMu(P, i / (T_W - 1), j / (T_H - 1));
      const d = distToTop(P, r, mu);
      const ds = d / N;
      let o0 = 0, o1 = 0, o2 = 0;
      for (let k = 0; k <= N; k++) {
        const t = k * ds;
        const h = Math.sqrt(r * r + t * t + 2 * r * mu * t) - P.Rp;
        extinction(P, h, ext);
        const w = k === 0 || k === N ? 0.5 : 1;
        o0 += ext[0] * w; o1 += ext[1] * w; o2 += ext[2] * w;
      }
      const o = (j * T_W + i) * 3;
      data[o] = Math.exp(-o0 * ds);
      data[o + 1] = Math.exp(-o1 * ds);
      data[o + 2] = Math.exp(-o2 * ds);
    }
  }
  return data;
}

function sampleTrans(P, T, r, mu, out) {
  const uvT = transRMuToUV(P, r, mu);
  const xm = uvT[0], xr = uvT[1];
  const fx = Math.max(0, Math.min(1, xm)) * (T_W - 1), fy = Math.max(0, Math.min(1, xr)) * (T_H - 1);
  const x0 = Math.min(T_W - 2, Math.floor(fx)), y0 = Math.min(T_H - 2, Math.floor(fy));
  const ax = fx - x0, ay = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = T[(y0 * T_W + x0) * 3 + c], b = T[(y0 * T_W + x0 + 1) * 3 + c];
    const cc = T[((y0 + 1) * T_W + x0) * 3 + c], dd = T[((y0 + 1) * T_W + x0 + 1) * 3 + c];
    out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + dd * ax) * ay;
  }
  return out;
}

// transmittance to the sun with the planet's shadow (sun disc ~0.27 deg softening)
function sunTrans(P, T, r, mu, out) {
  if (hitsGround(P, r, mu)) {
    const muH = -Math.sqrt(Math.max(0, 1 - (P.Rp / r) ** 2));
    const vis = Math.max(0, Math.min(1, (mu - muH) / 0.0047 + 0.5));
    sampleTrans(P, T, r, Math.max(mu, muH + 1e-5), out);
    out[0] *= vis; out[1] *= vis; out[2] *= vis;
    return out;
  }
  return sampleTrans(P, T, r, mu, out);
}

function phaseR(nu) {
  return (3 / (16 * Math.PI)) * (1 + nu * nu);
}
function phaseM(nu, g) {
  const g2 = g * g;
  return (3 / (8 * Math.PI)) * ((1 - g2) * (1 + nu * nu)) / ((2 + g2) * Math.pow(Math.max(1 + g2 - 2 * g * nu, 1e-4), 1.5));
}

// Fibonacci sphere directions (deterministic, uniform)
function sphereDirs(n) {
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2;
    const rr = Math.sqrt(1 - y * y);
    out.push([Math.cos(ga * i) * rr, y, Math.sin(ga * i) * rr]);
  }
  return out;
}

// Hillaire 2020 multiple scattering LUT: Psi_ms(r, mu_s) = L2 / (1 - f_ms)
function buildMultiScattering(P, T) {
  const data = new Float32Array(MS_N * MS_N * 3);
  const dirs = sphereDirs(64);
  const STEPS = 18;
  const ext = [0, 0, 0], ts = [0, 0, 0], tg = [0, 0, 0];
  for (let j = 0; j < MS_N; j++) {
    const r = P.Rp + ((j + 0.5) / MS_N) * (P.Rt - P.Rp);
    for (let i = 0; i < MS_N; i++) {
      const muS = -1 + (2 * (i + 0.5)) / MS_N;
      const sun = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];
      let L0 = 0, L1 = 0, L2 = 0, F0 = 0, F1 = 0, F2 = 0;
      for (const d of dirs) {
        const mu = d[1];
        const ground = hitsGround(P, r, mu);
        const tMax = ground ? distToBottom(P, r, mu) : distToTop(P, r, mu);
        const dt = tMax / STEPS;
        let tv0 = 1, tv1 = 1, tv2 = 1;
        let l0 = 0, l1 = 0, l2 = 0, f0 = 0, f1 = 0, f2 = 0;
        for (let k = 0; k < STEPS; k++) {
          const t = (k + 0.5) * dt;
          const px = d[0] * t, py = r + d[1] * t, pz = d[2] * t;
          const pr = Math.sqrt(px * px + py * py + pz * pz);
          const den = extinction(P, pr - P.Rp, ext);
          const dR = den[0], dM = den[1];
          const sR0 = P.betaR[0] * dR + P.betaMs * dM, sR1 = P.betaR[1] * dR + P.betaMs * dM, sR2 = P.betaR[2] * dR + P.betaMs * dM;
          const muSp = (px * sun[0] + py * sun[1] + pz * sun[2]) / pr;
          sunTrans(P, T, pr, muSp, ts);
          const iso = 1 / (4 * Math.PI);
          const e0 = Math.exp(-ext[0] * dt), e1 = Math.exp(-ext[1] * dt), e2 = Math.exp(-ext[2] * dt);
          // energy-conserving analytic integration over the step
          const k0 = (1 - e0) / Math.max(ext[0], 1e-9), k1 = (1 - e1) / Math.max(ext[1], 1e-9), k2 = (1 - e2) / Math.max(ext[2], 1e-9);
          l0 += tv0 * sR0 * ts[0] * iso * k0;
          l1 += tv1 * sR1 * ts[1] * iso * k1;
          l2 += tv2 * sR2 * ts[2] * iso * k2;
          f0 += tv0 * sR0 * k0;
          f1 += tv1 * sR1 * k1;
          f2 += tv2 * sR2 * k2;
          tv0 *= e0; tv1 *= e1; tv2 *= e2;
        }
        if (ground) {
          // light bounced off the ground (Lambertian albedo)
          const gx = d[0] * tMax, gy = r + d[1] * tMax, gz = d[2] * tMax;
          const gr = Math.sqrt(gx * gx + gy * gy + gz * gz);
          const muG = (gx * sun[0] + gy * sun[1] + gz * sun[2]) / gr;
          sunTrans(P, T, gr, muG, tg);
          const a = (P.groundAlbedo / Math.PI) * Math.max(muG, 0);
          l0 += tv0 * tg[0] * a; l1 += tv1 * tg[1] * a; l2 += tv2 * tg[2] * a;
        }
        L0 += l0; L1 += l1; L2 += l2; F0 += f0; F1 += f1; F2 += f2;
      }
      const w = (4 * Math.PI) / dirs.length / (4 * Math.PI); // uniform-sphere average with isotropic phase
      L0 *= w; L1 *= w; L2 *= w; F0 *= w; F1 *= w; F2 *= w;
      const o = (j * MS_N + i) * 3;
      data[o] = L0 / Math.max(1 - F0, 1e-3);
      data[o + 1] = L1 / Math.max(1 - F1, 1e-3);
      data[o + 2] = L2 / Math.max(1 - F2, 1e-3);
    }
  }
  return data;
}

function sampleMS(P, M, r, muS, out) {
  const fx = Math.max(0, Math.min(MS_N - 1, ((muS + 1) / 2) * MS_N - 0.5));
  const fy = Math.max(0, Math.min(MS_N - 1, ((r - P.Rp) / (P.Rt - P.Rp)) * MS_N - 0.5));
  const x0 = Math.min(MS_N - 2, Math.floor(fx)), y0 = Math.min(MS_N - 2, Math.floor(fy));
  const ax = fx - x0, ay = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = M[(y0 * MS_N + x0) * 3 + c], b = M[(y0 * MS_N + x0 + 1) * 3 + c];
    const cc = M[((y0 + 1) * MS_N + x0) * 3 + c], dd = M[((y0 + 1) * MS_N + x0 + 1) * 3 + c];
    out[c] = (a * (1 - ax) + b * ax) * (1 - ay) + (cc * (1 - ax) + dd * ax) * ay;
  }
  return out;
}

// Irradiance on the ground from the sky dome (single + multiple scattering) as a function of sun zenith cosine.
function buildSkyIrradiance(P, T, M) {
  const data = new Float32Array(IRR_N * 3);
  const dirs = sphereDirs(160).filter((d) => d[1] > 0.0);
  const STEPS = 16;
  const ext = [0, 0, 0], ts = [0, 0, 0], ms = [0, 0, 0];
  const r = P.Rp + 1e-6;
  for (let i = 0; i < IRR_N; i++) {
    const muS = -0.35 + (1.35 * i) / (IRR_N - 1);
    const sun = [Math.sqrt(Math.max(0, 1 - muS * muS)), muS, 0];
    let E0 = 0, E1 = 0, E2 = 0;
    for (const d of dirs) {
      const tMax = distToTop(P, r, d[1]);
      const dt = tMax / STEPS;
      const nu = d[0] * sun[0] + d[1] * sun[1] + d[2] * sun[2];
      const pR = phaseR(nu), pM = phaseM(nu, P.g);
      let tv0 = 1, tv1 = 1, tv2 = 1, l0 = 0, l1 = 0, l2 = 0;
      for (let k = 0; k < STEPS; k++) {
        const t = (k + 0.5) * dt;
        const px = d[0] * t, py = r + d[1] * t, pz = d[2] * t;
        const pr = Math.sqrt(px * px + py * py + pz * pz);
        const den = extinction(P, pr - P.Rp, ext);
        const dR = den[0], dM = den[1];
        const muSp = (px * sun[0] + py * sun[1] + pz * sun[2]) / pr;
        sunTrans(P, T, pr, muSp, ts);
        sampleMS(P, M, pr, muSp, ms);
        const e = [Math.exp(-ext[0] * dt), Math.exp(-ext[1] * dt), Math.exp(-ext[2] * dt)];
        const S = (c) => (P.betaR[c] * dR * pR + P.betaMs * dM * pM) * ts[c] + (P.betaR[c] * dR + P.betaMs * dM) * ms[c];
        l0 += tv0 * S(0) * (1 - e[0]) / ext[0];
        l1 += tv1 * S(1) * (1 - e[1]) / ext[1];
        l2 += tv2 * S(2) * (1 - e[2]) / ext[2];
        tv0 *= e[0]; tv1 *= e[1]; tv2 *= e[2];
      }
      const c = d[1];
      E0 += l0 * c; E1 += l1 * c; E2 += l2 * c;
    }
    const w = (2 * Math.PI) / dirs.length;
    data[i * 3] = E0 * w;
    data[i * 3 + 1] = E1 * w;
    data[i * 3 + 2] = E2 * w;
  }
  return data;
}

function toHalfTexture(rgb, w, h) {
  const n = w * h;
  const out = new Uint16Array(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = THREE.DataUtils.toHalfFloat(rgb[i * 3]);
    out[i * 4 + 1] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 1]);
    out[i * 4 + 2] = THREE.DataUtils.toHalfFloat(rgb[i * 3 + 2]);
    out[i * 4 + 3] = THREE.DataUtils.toHalfFloat(1);
  }
  const tex = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function buildEarthLUTs(P) {
  const T = buildTransmittance(P);
  const M = buildMultiScattering(P, T);
  const E = buildSkyIrradiance(P, T, M);
  return {
    transmittance: toHalfTexture(T, T_W, T_H),
    multiScattering: toHalfTexture(M, MS_N, MS_N),
    skyIrradiance: toHalfTexture(E, IRR_N, 1),
    raw: { T, M, E },
  };
}
