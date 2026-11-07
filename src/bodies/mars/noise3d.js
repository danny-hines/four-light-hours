// A baked, periodic 3D gradient-noise texture shared by the Mars surface layers and the moons.
//
// FXC (ANGLE/D3D11) inlines every call of an analytic noise function, and the Mars programs used to take seconds to
// compile because of it. One trilinear fetch of this texture replaces the analytic noise: 64^3 half-float RGBA
// = (value, d/dx, d/dy, d/dz) of quintic Perlin noise with a period of 16 lattice cells at 4 texels per cell
// (2 MB, deterministic, built once at load). Units: lattice cells, so a lookup at q / 16 (q in cells) gives
// noise(q) and its gradient per cell. Normalised to the statistics of gnoised() in glsl.js (value RMS 0.31,
// gradient RMS ~1.4 per cell), so the amplitudes written for it carry over.
let NOISE3 = null;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function noiseTexture3D(THREE) {
  if (NOISE3) return NOISE3;
  const N = 64, P = 16, K = N / P;
  const grad = new Float32Array(P * P * P * 3);
  const rnd = mulberry32(90210);
  for (let i = 0; i < P * P * P; i++) {
    const z = rnd() * 2 - 1, ph = rnd() * 2 * Math.PI, r = Math.sqrt(1 - z * z);
    grad[3 * i] = r * Math.cos(ph);
    grad[3 * i + 1] = r * Math.sin(ph);
    grad[3 * i + 2] = z;
  }
  const out = new Float32Array(N * N * N * 4);
  const corner = new Float32Array(8);
  const cg = new Float32Array(24);
  let sv = 0, sg = 0;
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        // texel centres: the texture is sampled with linear filtering, so store the noise at (i + 0.5) / K cells
        const px = (x + 0.5) / K, py = (y + 0.5) / K, pz = (z + 0.5) / K;
        const ix = Math.floor(px), iy = Math.floor(py), iz = Math.floor(pz);
        const fx = px - ix, fy = py - iy, fz = pz - iz;
        for (let c = 0; c < 8; c++) {
          const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
          const gi = 3 * ((((iz + oz) % P) * P + ((iy + oy) % P)) * P + ((ix + ox) % P));
          const gx = grad[gi], gy = grad[gi + 1], gz = grad[gi + 2];
          corner[c] = gx * (fx - ox) + gy * (fy - oy) + gz * (fz - oz);
          cg[3 * c] = gx;
          cg[3 * c + 1] = gy;
          cg[3 * c + 2] = gz;
        }
        const q = (t) => t * t * t * (t * (t * 6 - 15) + 10);
        const dq = (t) => 30 * t * t * (t * (t - 2) + 1);
        const u = q(fx), v = q(fy), w = q(fz), du = dq(fx), dv = dq(fy), dw = dq(fz);
        // trilinear blend of the 8 corner planes with quintic weights; analytic gradient
        let val = 0, gxs = 0, gys = 0, gzs = 0;
        for (let c = 0; c < 8; c++) {
          const ox = c & 1, oy = (c >> 1) & 1, oz = (c >> 2) & 1;
          const wx = ox ? u : 1 - u, wy = oy ? v : 1 - v, wz = oz ? w : 1 - w;
          const dwx = ox ? du : -du, dwy = oy ? dv : -dv, dwz = oz ? dw : -dw;
          const wt = wx * wy * wz;
          val += wt * corner[c];
          gxs += wt * cg[3 * c] + dwx * wy * wz * corner[c];
          gys += wt * cg[3 * c + 1] + wx * dwy * wz * corner[c];
          gzs += wt * cg[3 * c + 2] + wx * wy * dwz * corner[c];
        }
        const o = 4 * ((z * N + y) * N + x);
        out[o] = val;
        out[o + 1] = gxs;
        out[o + 2] = gys;
        out[o + 3] = gzs;
        sv += val * val;
        sg += gxs * gxs + gys * gys + gzs * gzs;
      }
  const n = N * N * N;
  const k = 0.31 / Math.sqrt(sv / n);
  const half = new Uint16Array(n * 4);
  for (let i = 0; i < n * 4; i++) half[i] = THREE.DataUtils.toHalfFloat(out[i] * k);
  const tex = new THREE.Data3DTexture(half, N, N, N);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.HalfFloatType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  tex.userData.gradRms = Math.sqrt(sg / n) * k;
  NOISE3 = tex;
  return tex;
}
