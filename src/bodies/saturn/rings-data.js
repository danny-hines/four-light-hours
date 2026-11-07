// Saturn ring data: the Voyager 2 PPS delta-Sco optical-depth profile (1 km sampling, see assets-src/SOURCES.md)
// turned into GPU textures, plus the per-region particle properties and a CPU-side model used for ringshine.
//
// Textures (all radius-indexed, r from R0 to R1 km):
//   prof  16384 x 1  RGBA16F, hand-built mip chain. Channels are AVERAGES of exp(-tau*m) for m = 1, m0, 4, 16
//         (m0 = 1/mu0, the fixed solar incidence), so far-away pixels get the true mean transmission of the
//         unresolved ringlets instead of the transmission of the mean optical depth.
//   alb   16384 x 1  RGBA8 (auto mips): rgb = particle single-scattering albedo * colour, a = dust fraction of tau.
//   fine  4096 x 19  RGBA16F nearest: tau at 1 km (r), ~2 km (g), ~4 km (b) for close range (texelFetch).
import * as THREE from 'three';

export const RING_R0 = 66000; // km, first sample
export const RING_R1 = 142000; // km, last sample
export const PROF_W = 16384;
export const FINE_W = 4096;
export const KM_PER_TEXEL = (RING_R1 - RING_R0) / PROF_W;

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Parse rings_tau.bin -> Float32Array of tau at 1 km from RING_R0. */
export function parseProfile(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'SRTP') throw new Error('rings_tau.bin: bad magic');
  const n = dv.getUint32(4, true);
  const r0 = dv.getFloat32(8, true);
  const dr = dv.getFloat32(12, true);
  if (r0 !== RING_R0 || dr !== 1) throw new Error('rings_tau.bin: unexpected grid');
  const tau = new Float32Array(n);
  for (let i = 0; i < n; i++) tau[i] = dv.getUint16(16 + i * 2, true) / 10000;
  return tau;
}

// ---------------------------------------------------------------------------------------------------------------
// Particle properties by region (Cuzzi et al. 2009/2018, Cassini VIMS/ISS colour & phase studies, qualitatively):
//   C ring and Cassini Division: darker, greyer (more non-icy material), more dust;
//   B ring: brightest, most reddish ("salmon"); A ring: bright, a little less red, dustier outer edge.
// Returns [r, g, b, dust] for radius rk (km) and local tau (C-ring plateaus are brighter than the background).
export function particleProps(rk, tau) {
  const C = smooth(74400, 74700, rk) * (1 - smooth(91900, 92100, rk));
  const B = smooth(91900, 92100, rk) * (1 - smooth(117450, 117600, rk));
  const CD = smooth(117450, 117600, rk) * (1 - smooth(122050, 122250, rk));
  const A = smooth(122050, 122250, rk) * (1 - smooth(136700, 136800, rk));
  const D = 1 - smooth(74300, 74600, rk);
  const out = 1 - C - B - CD - A - D;
  // single-scattering albedo * colour (linear, red/green/blue ~ 650/550/450 nm)
  let r = 0, g = 0, b = 0, dust = 0;
  const plate = Math.min(1, tau / 0.35); // C-ring plateaus and CD ramp: brighter particles
  // C ring: grey-tan, darker than the B ring per particle but far from black: Cassini lit-face I/F of the C ring is
  // ~0.15-0.25 of the B ring's at low phase (with tau ~ 0.1 the slab factor alone gives ~0.1), the rest is the
  // brighter plateaus and the stronger forward-backward multiple scattering among its larger, more porous particles
  // (an effective albedo: it also absorbs what the classical slab misses for a thin, vertically extended layer)
  r += C * (0.58 + 0.2 * plate); g += C * (0.53 + 0.18 * plate); b += C * (0.47 + 0.15 * plate); dust += C * 0.03;
  // B ring: brightest, salmon; the inner B1 region a touch darker; denser bands brighter (lit-face structure)
  const b1 = 1 - smooth(92000, 99000, rk);
  const bd = 0.86 + 0.22 * smooth(0.9, 5.2, tau);
  r += B * (0.74 - 0.08 * b1) * bd; g += B * (0.60 - 0.07 * b1) * bd; b += B * (0.445 - 0.05 * b1) * bd; dust += B * 0.004;
  // Cassini Division: like the C ring
  r += CD * (0.66 + 0.14 * plate); g += CD * (0.615 + 0.125 * plate); b += CD * (0.57 + 0.11 * plate); dust += CD * 0.05;
  // A ring: bright, slightly less red; dustier outward of the Encke gap
  const aout = smooth(133000, 136700, rk);
  r += A * (0.63 + 0.03 * aout); g += A * (0.57 + 0.03 * aout); b += A * (0.485 + 0.03 * aout); dust += A * (0.008 + 0.03 * aout);
  // dusty Encke-gap ringlets
  dust = Math.max(dust, (smooth(133380, 133440, rk) - smooth(133730, 133790, rk)) * 0.9);
  // D ring and the space beyond the A ring: pure dust (neutral-blue tint at small sizes)
  r += (D + out) * 0.5; g += (D + out) * 0.5; b += (D + out) * 0.52; dust += (D + out) * 1.0;
  // chroma: the shaders' satDisplay() makes the displayed hue follow this linear chroma, so it is set to the
  // linearised hue of Cassini true-colour ring images (B ring tan-salmon, display B/R ~ 0.66; A ring greyer ~0.78;
  // C ring / Cassini Division grey-tan): x1.55 around the luminance in the dense rings, x1.25 in the C ring / CD
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const k = 1 + 0.55 * (B + A) + 0.25 * (C + CD);
  return [y + (r - y) * k, y + (g - y) * k, Math.max(0, y + (b - y) * k), dust];
}

// Fine dusty ringlets the PPS profile doesn't resolve (Encke-gap ringlets) are added to tau here.
function addDustyRinglets(tau) {
  const add = (rc, w, t) => {
    for (let k = Math.floor(rc - 4 * w); k <= Math.ceil(rc + 4 * w); k++) {
      const i = k - RING_R0;
      if (i >= 0 && i < tau.length) tau[i] += t * Math.exp(-0.5 * ((k - rc) / w) ** 2);
    }
  };
  // Encke gap ringlets (Pan's ringlet near the gap centre, plus two fainter ones)
  add(133585, 4, 0.03);
  add(133480, 3, 0.012);
  add(133700, 3, 0.012);
}

function boxAverage(src, n0, outW, fn) {
  // average fn(src) over equal bins of the 1 km grid -> Float64Array(outW * channels)
  const ch = fn(0, 0).length;
  const out = new Float64Array(outW * ch);
  const span = n0 / outW;
  for (let x = 0; x < outW; x++) {
    const a = x * span, b = a + span;
    let i = Math.floor(a);
    const acc = new Float64Array(ch);
    let wsum = 0;
    for (; i < Math.ceil(b); i++) {
      const w = Math.min(b, i + 1) - Math.max(a, i);
      if (w <= 0 || i >= n0) continue;
      const v = fn(i, src[i]);
      for (let c = 0; c < ch; c++) acc[c] += v[c] * w;
      wsum += w;
    }
    for (let c = 0; c < ch; c++) out[x * ch + c] = acc[c] / Math.max(wsum, 1e-9);
  }
  return out;
}

function halfMips(level0, w0, ch) {
  // successive 2:1 averages of a 1D, ch-channel Float64 array -> array of {data: Uint16Array (half), width, height}
  const mips = [];
  let cur = level0, w = w0;
  for (;;) {
    const data = new Uint16Array(w * 4);
    for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data[x * 4 + c] = THREE.DataUtils.toHalfFloat(c < ch ? cur[x * ch + c] : 1);
    mips.push({ data, width: w, height: 1 });
    if (w === 1) break;
    const nw = w >> 1;
    const nxt = new Float64Array(nw * ch);
    for (let x = 0; x < nw; x++) for (let c = 0; c < ch; c++) nxt[x * ch + c] = 0.5 * (cur[2 * x * ch + c] + cur[(2 * x + 1) * ch + c]);
    cur = nxt;
    w = nw;
  }
  return mips;
}

// ---------------------------------------------------------------------------------------------------------------
// Lit-face brightness structure. Cassini ISS shows the dense rings' reflectivity tracking their optical-depth fine
// structure (denser bands brighter, by 10-30 %) even where the ring is opaque and the classical slab formula has
// saturated, and the B ring's famous "irregular structure": abrupt 30-300 km bands of different brightness. The
// first comes from a high-pass of log(tau) (5 km vs 150 km smoothing); in the B ring, where the PPS is saturated and
// carries no information, a deterministic multi-scale band pattern with abrupt edges stands in for it.
// Returns a per-km multiplicative factor (~0.75 .. 1.3) for the particle albedo.
function boxBlur3(src, rad) {
  // three passes of a running-mean box filter ~ Gaussian with sigma ~ rad
  let a = Float32Array.from(src);
  const n = a.length;
  const b = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    let acc = 0;
    const w = 2 * rad + 1;
    for (let i = -rad; i <= rad; i++) acc += a[Math.min(n - 1, Math.max(0, i))];
    for (let i = 0; i < n; i++) {
      b[i] = acc / w;
      acc += a[Math.min(n - 1, i + rad + 1)] - a[Math.max(0, i - rad)];
    }
    a.set(b);
  }
  return a;
}
function hash1(i) {
  let x = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}
// piecewise-constant random bands with soft (few-km) edges: irregular structure
function bandNoise(rk, scale, seed, edge) {
  const x = rk / scale;
  const i = Math.floor(x), f = x - i;
  const v0 = hash1(i * 7 + seed) * 2 - 1, v1 = hash1((i + 1) * 7 + seed) * 2 - 1;
  // jittered band edge position
  const e = 0.5 + 0.35 * (hash1(i * 13 + seed * 3) - 0.5);
  const k = edge / scale;
  const t = Math.min(1, Math.max(0, (f - e) / Math.max(k, 1e-3) + 0.5));
  return v0 + (v1 - v0) * t * t * (3 - 2 * t);
}
export function brightnessStructure(tau) {
  const n = tau.length;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = Math.log(Math.max(tau[i], 0.02));
  const Ls = boxBlur3(L, 3), Ll = boxBlur3(L, 90);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const rk = RING_R0 + i;
    const tl = Math.exp(Ll[i]);
    const dense = smooth(0.35, 1.4, tl); // only where the slab is (nearly) opaque; thin rings follow tau already
    let hp = Math.max(-1.2, Math.min(1.2, Ls[i] - Ll[i]));
    // B ring (B2-B4): PPS saturated -> structure is noise; replace by irregular band structure
    const sat = smooth(99000, 100500, rk) * (1 - smooth(116800, 117300, rk));
    const irr = 0.5 * bandNoise(rk, 260, 11, 25) + 0.3 * bandNoise(rk, 95, 23, 8) + 0.2 * bandNoise(rk, 33, 37, 4) + 0.12 * bandNoise(rk, 11, 41, 2);
    hp = hp * (1 - 0.75 * sat) + irr * 0.55 * sat;
    // inner B ring (B1) and the A ring keep their real (unsaturated) structure, slightly enhanced
    out[i] = Math.exp(dense * 0.32 * hp);
  }
  return out;
}

/**
 * Build GPU textures and a CPU model from the 1 km tau profile.
 * mu0 = |sin(solar elevation above the ring plane)|.
 */
export function buildRingData(tau1km, mu0) {
  const n = tau1km.length;
  const tau = Float32Array.from(tau1km);
  addDustyRinglets(tau);
  const m0 = 1 / Math.max(mu0, 0.02);

  // --- prof: averages of exp(-tau m) ------------------------------------------------------------------------
  const lvl0 = boxAverage(tau, n, PROF_W, (i, t) => [Math.exp(-t), Math.exp(-t * m0), Math.exp(-t * 4), Math.exp(-t * 16)]);
  const prof = new THREE.DataTexture(null, PROF_W, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  prof.mipmaps = halfMips(lvl0, PROF_W, 4);
  prof.image = { data: prof.mipmaps[0].data, width: PROF_W, height: 1 };
  prof.generateMipmaps = false;
  prof.minFilter = THREE.LinearMipmapLinearFilter;
  prof.magFilter = THREE.LinearFilter;
  prof.wrapS = prof.wrapT = THREE.ClampToEdgeWrapping;
  prof.colorSpace = THREE.NoColorSpace;
  prof.needsUpdate = true;

  // --- alb: particle albedo colour + dust fraction --------------------------------------------------------
  const bright = brightnessStructure(tau);
  const albF = boxAverage(tau, n, PROF_W, (i, t) => {
    const p = particleProps(RING_R0 + i, t);
    const k = bright[i];
    return [p[0] * k, p[1] * k, p[2] * k, p[3]];
  });
  const albData = new Uint8Array(PROF_W * 4);
  for (let x = 0; x < PROF_W; x++)
    for (let c = 0; c < 4; c++) albData[x * 4 + c] = Math.round(Math.min(1, Math.max(0, albF[x * 4 + c])) * 255);
  const alb = new THREE.DataTexture(albData, PROF_W, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  alb.generateMipmaps = true;
  alb.minFilter = THREE.LinearMipmapLinearFilter;
  alb.magFilter = THREE.LinearFilter;
  alb.wrapS = alb.wrapT = THREE.ClampToEdgeWrapping;
  alb.colorSpace = THREE.NoColorSpace;
  alb.needsUpdate = true;

  // --- fine: tau at 1, ~2, ~4 km -------------------------------------------------------------------------
  const rows = Math.ceil(n / FINE_W);
  const fineData = new Uint16Array(FINE_W * rows * 4);
  const at = (i) => tau[Math.min(n - 1, Math.max(0, i))];
  for (let i = 0; i < n; i++) {
    const t1 = at(i);
    const t2 = 0.25 * at(i - 1) + 0.5 * at(i) + 0.25 * at(i + 1);
    let t4 = 0;
    for (let k = -3; k <= 3; k++) t4 += at(i + k) * [1, 6, 15, 20, 15, 6, 1][k + 3] / 64;
    fineData[i * 4 + 0] = THREE.DataUtils.toHalfFloat(t1);
    fineData[i * 4 + 1] = THREE.DataUtils.toHalfFloat(t2);
    fineData[i * 4 + 2] = THREE.DataUtils.toHalfFloat(t4);
    fineData[i * 4 + 3] = THREE.DataUtils.toHalfFloat(bright[i]);
  }
  const fine = new THREE.DataTexture(fineData, FINE_W, rows, THREE.RGBAFormat, THREE.HalfFloatType);
  fine.minFilter = THREE.NearestFilter;
  fine.magFilter = THREE.NearestFilter;
  fine.generateMipmaps = false;
  fine.colorSpace = THREE.NoColorSpace;
  fine.needsUpdate = true;

  // --- coarse CPU model (for ringshine): 1 sample per 250 km --------------------------------------------
  const cpu = [];
  for (let rk = 66500; rk < 141000; rk += 500) {
    const a = rk - 250 - RING_R0, b = rk + 250 - RING_R0;
    let sT = 0, sE0 = 0, cnt = 0;
    for (let i = a; i < b; i++) {
      sT += tau[i];
      sE0 += Math.exp(-tau[i] * m0);
      cnt++;
    }
    const p = particleProps(rk, sT / cnt);
    cpu.push({ r: rk, tau: sT / cnt, e0: sE0 / cnt, alb: p, taus: null, i0: a, i1: b });
  }
  // keep the 1 km samples for exact slab integrals in ringshine
  for (const c of cpu) c.taus = tau.subarray(c.i0, c.i1);

  return { prof, alb, fine, fineRows: rows, m0, tau, cpu };
}

// ---------------------------------------------------------------------------------------------------------------
// Ring photometry shared by the CPU ringshine integral (mirrors the GLSL in rings-glsl.js).
// HG phase function normalised to mean 1 over the sphere; cosT = cosine of the scattering angle (1 = forward).
export function hg(cosT, g) {
  const g2 = g * g;
  return (1 - g2) / Math.pow(Math.max(1 + g2 - 2 * g * cosT, 1e-6), 1.5);
}
export function particlePhase(cosT) {
  // macroscopic icy particles: backscattering (negative g) plus a weak forward term
  return 0.86 * hg(cosT, -0.42) + 0.14 * hg(cosT, 0.45);
}
export function dustPhase(cosT) {
  return 0.75 * hg(cosT, 0.78) + 0.25 * hg(cosT, 0.2);
}

/** Ring I/F for a slab with 1 km samples `taus`, seen at |cos| mu, sun |cos| mu0, same side flag lit. */
export function slabIF(taus, mu, mu0, lit, alb, cosT) {
  const m = 1 / Math.max(mu, 0.01), m0 = 1 / Math.max(mu0, 0.01);
  let s = 0;
  for (let k = 0; k < taus.length; k++) {
    const t = taus[k];
    if (lit) s += (mu0 / (mu + mu0)) * (1 - Math.exp(-t * (m + m0)));
    else if (Math.abs(mu - mu0) < 1e-3) s += t * m0 * Math.exp(-t * m0);
    else s += (mu0 / (mu - mu0)) * (Math.exp(-t * m) - Math.exp(-t * m0));
  }
  s /= taus.length;
  const pp = particlePhase(cosT), pd = dustPhase(cosT);
  const ph = (1 - alb[3]) * pp + alb[3] * pd * 0.6;
  // multiple scattering boost for the dense rings (classical-layer estimate, H(mu)H(mu0)-like)
  const ms = lit ? 1.35 : 1.15;
  return [alb[0] * ph * 0.25 * s * ms, alb[1] * ph * 0.25 * s * ms, alb[2] * ph * 0.25 * s * ms];
}

// ---------------------------------------------------------------------------------------------------------------
// Ringshine: irradiance (relative to direct sunlight) that the rings deliver to each point of the globe, tabulated
// over planetographic latitude and longitude from the sub-solar meridian (the configuration is fixed for the
// epoch). Lit-face and unlit-face (diffuse transmission) radiances, the planet's shadow on the rings and the local
// horizon are all included. Returns a HalfFloat RGBA DataTexture (W = |dlon| 0..pi, H = lat -90..90).
function planetShadowCPU(qx, qy, qz, s, flat) {
  const ox = qx, oy = qy / flat, oz = qz;
  let dx = s.x, dy = s.y / flat, dz = s.z;
  const l = Math.hypot(dx, dy, dz);
  dx /= l; dy /= l; dz /= l;
  const t = -(ox * dx + oy * dy + oz * dz);
  if (t <= 0) return 1;
  const ex = ox + dx * t, ey = oy + dy * t, ez = oz + dz * t;
  const dm = Math.hypot(ex, ey, ez);
  return smooth(0.997, 1.003, dm);
}

export function computeRingshine(data, sunR, flat, W = 24, H = 48) {
  const s = sunR.clone().normalize();
  const mu0 = Math.abs(s.y);
  const lonS = Math.atan2(-s.z, s.x);
  // merge 500 km cpu bins into 1000 km bins; precompute slab integrals vs mu
  const MU = 32;
  const bins = [];
  for (let i = 0; i + 1 < data.cpu.length; i += 2) {
    const a = data.cpu[i], b = data.cpu[i + 1];
    const taus = new Float32Array(a.taus.length + b.taus.length);
    taus.set(a.taus);
    taus.set(b.taus, a.taus.length);
    let mt = 0;
    for (const t of taus) mt += t;
    mt /= taus.length;
    if (mt < 2e-3) continue;
    const r = (a.r + b.r) / 2 / 60268;
    const alb = particleProps(a.r + 250, mt);
    const lit = new Float32Array(MU), unl = new Float32Array(MU);
    for (let k = 0; k < MU; k++) {
      const mu = (k + 0.5) / MU;
      let sl = 0, su = 0;
      for (let j = 0; j < taus.length; j += 2) {
        const t = taus[j];
        const Dn = smooth(0.2, 1.2, t), muE = mu + (Math.sqrt(mu * mu0) - mu) * 0.6 * Dn; // dense layer (rings.js)
        const msl = 1 + 0.85 * smooth(0.4, 3.0, t * 0.5 * (1 / mu + 1 / mu0));
        sl += (mu0 / (muE + mu0)) * (1 - Math.exp(-t * (1 / mu + 1 / mu0))) * msl;
        if (Math.abs(mu - mu0) < 1e-3) su += (t / mu0) * Math.exp(-t / mu0);
        else su += (mu0 / (mu - mu0)) * (Math.exp(-t / mu) - Math.exp(-t / mu0));
      }
      lit[k] = sl / (taus.length / 2);
      unl[k] = Math.max(0, su / (taus.length / 2));
    }
    bins.push({ r, dr: 1000 / 60268, alb, lit, unl });
  }
  // phase lookup tables over cos(scattering angle)
  const NP = 256;
  const pp = new Float32Array(NP), pd = new Float32Array(NP);
  for (let i = 0; i < NP; i++) {
    const c = -1 + (2 * i) / (NP - 1);
    pp[i] = particlePhase(c);
    pd[i] = dustPhase(c);
  }
  const NA = 48;
  // ring points
  const pts = [];
  for (const b of bins) {
    for (let a = 0; a < NA; a++) {
      const ph = ((a + 0.5) / NA) * Math.PI * 2;
      const qx = b.r * Math.cos(ph), qz = -b.r * Math.sin(ph);
      const sh = planetShadowCPU(qx, 0, qz, s, flat);
      pts.push({ qx, qz, sh, b, dA: b.r * b.dr * ((Math.PI * 2) / NA) });
    }
  }
  const out = new Uint16Array(W * H * 4);
  const dustAlb = [0.5, 0.52, 0.58];
  for (let j = 0; j < H; j++) {
    const lat = -Math.PI / 2 + (Math.PI * (j + 0.5)) / H;
    for (let i = 0; i < W; i++) {
      const lon = lonS + (Math.PI * (i + 0.5)) / W;
      const nx = Math.cos(lat) * Math.cos(lon), ny = Math.sin(lat), nz = -Math.cos(lat) * Math.sin(lon);
      const kk = 1 / Math.sqrt(nx * nx + nz * nz + flat * flat * ny * ny);
      const px = nx * kk, py = ny * flat * flat * kk, pz = nz * kk;
      let er = 0, eg = 0, eb = 0;
      for (const q of pts) {
        let ox = px - q.qx, oy = py, oz = pz - q.qz; // ring point -> planet point
        const d2 = ox * ox + oy * oy + oz * oz;
        const dd = Math.sqrt(d2);
        ox /= dd; oy /= dd; oz /= dd;
        const cosP = -(nx * ox + ny * oy + nz * oz);
        if (cosP <= 0) continue;
        const muR = Math.abs(oy);
        if (muR < 1e-3) continue;
        const litSide = oy * s.y > 0;
        const k = Math.min(MU - 1, Math.floor(muR * MU));
        const S = litSide ? q.b.lit[k] : q.b.unl[k];
        if (S <= 0) continue;
        const cosT = -(s.x * ox + s.y * oy + s.z * oz);
        const ip = Math.min(NP - 1, Math.max(0, Math.round(((cosT + 1) / 2) * (NP - 1))));
        const dust = q.b.alb[3];
        const w = 0.25 * S * (litSide ? 1.0 : 1.15) * q.sh * cosP * muR / d2 * q.dA / Math.PI;
        const a1 = pp[ip] * (1 - dust), a2 = pd[ip] * dust;
        er += w * (q.b.alb[0] * a1 + dustAlb[0] * a2);
        eg += w * (q.b.alb[1] * a1 + dustAlb[1] * a2);
        eb += w * (q.b.alb[2] * a1 + dustAlb[2] * a2);
      }
      const o = (j * W + i) * 4;
      out[o] = THREE.DataUtils.toHalfFloat(er);
      out[o + 1] = THREE.DataUtils.toHalfFloat(eg);
      out[o + 2] = THREE.DataUtils.toHalfFloat(eb);
      out[o + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const tex = new THREE.DataTexture(out, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------------------------------------------
// Saturnshine: irradiance that the sunlit globe delivers to each face of the ring plane, relative to direct sunlight
// at normal incidence, for an albedo-1 Lambertian planet (the shaders multiply by the planet's albedo colour).
// Integrated over the visible globe from each ring point: E = (1/pi) Int mu0(G) T(G) cos(th_ring) cos(th_G) dA / d^2,
// where T is the rings' own shadow on the globe (the sun ray from G through the ring plane, mean exp(-tau m0)) --
// in 2026 the B ring shadows the northern tropics, which lowers the north face's Saturnshine. Also stores the
// irradiance-weighted mean elevation cosine of the planet light (for the slab photometry) per face.
// Returns a HalfFloat RGBA DataTexture: x = ring radius (SS_R0..SS_R1 Saturn radii), y = |azimuth from the sub-solar
// meridian| / pi; R = E north face, G = E south face, B = mean mu north, A = mean mu south.
export const SS_R0 = 1.08, SS_R1 = 2.4;
export function computeSaturnshine(data, sunR, flat, NR = 40, NA = 32) {
  const s = sunR.clone().normalize();
  const lonS = Math.atan2(-s.z, s.x);
  // ring transmission toward the sun vs radius (500 km bins)
  const e0At = (rkm) => {
    const i = Math.round((rkm - 66500) / 500);
    return i < 0 || i >= data.cpu.length ? 1 : data.cpu[i].e0;
  };
  // globe samples (planetographic grid, area elements on the oblate surface)
  const NLAT = 36, NLON = 72;
  const G = [];
  for (let j = 0; j < NLAT; j++) {
    const lat = -Math.PI / 2 + (Math.PI * (j + 0.5)) / NLAT;
    for (let i = 0; i < NLON; i++) {
      const lon = lonS + (2 * Math.PI * (i + 0.5)) / NLON;
      const nx = Math.cos(lat) * Math.cos(lon), ny = Math.sin(lat), nz = -Math.cos(lat) * Math.sin(lon);
      const kk = 1 / Math.sqrt(nx * nx + nz * nz + flat * flat * ny * ny);
      const px = nx * kk, py = ny * flat * flat * kk, pz = nz * kk;
      const mu0 = nx * s.x + ny * s.y + nz * s.z;
      if (mu0 <= 0) continue;
      let T = 1;
      if (py * s.y < 0) { // the sun ray crosses the ring plane
        const t = -py / s.y;
        T = e0At(Math.hypot(px + s.x * t, pz + s.z * t) * 60268);
      }
      const dA = Math.cos(lat) * (Math.PI / NLAT) * ((2 * Math.PI) / NLON) * (0.5 + 0.5 * flat); // ~ oblate area
      G.push({ px, py, pz, nx, ny, nz, L: (mu0 * T) / Math.PI, dA });
    }
  }
  const out = new Uint16Array(NR * NA * 4);
  for (let a = 0; a < NA; a++) {
    const ph = lonS + (Math.PI * a) / (NA - 1);
    for (let k = 0; k < NR; k++) {
      const r = SS_R0 + ((SS_R1 - SS_R0) * k) / (NR - 1);
      const qx = r * Math.cos(ph), qz = -r * Math.sin(ph);
      let eN = 0, eS = 0, mN = 0, mS = 0;
      for (const g of G) {
        let dx = g.px - qx, dy = g.py, dz = g.pz - qz;
        const d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
        dx /= d; dy /= d; dz /= d;
        const cg = -(g.nx * dx + g.ny * dy + g.nz * dz);
        if (cg <= 0) continue;
        const cr = Math.abs(dy);
        const e = (g.L * cg * cr * g.dA) / d2;
        if (dy > 0) { eN += e; mN += e * cr; } else { eS += e; mS += e * cr; }
      }
      const o = (a * NR + k) * 4;
      out[o] = THREE.DataUtils.toHalfFloat(eN);
      out[o + 1] = THREE.DataUtils.toHalfFloat(eS);
      out[o + 2] = THREE.DataUtils.toHalfFloat(eN > 1e-9 ? mN / eN : 0.3);
      out[o + 3] = THREE.DataUtils.toHalfFloat(eS > 1e-9 ? mS / eS : 0.3);
    }
  }
  const tex = new THREE.DataTexture(out, NR, NA, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.userData = { eN: Array.from({ length: NR }, (_, k) => THREE.DataUtils.fromHalfFloat(out[k * 4])), data: out };
  return tex;
}
