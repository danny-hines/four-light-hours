// Diffraction starburst of the lens: the Fraunhofer point-spread function |FFT(pupil)|^2, computed once at
// start-up (deterministic, ~40 ms) and summed over the visible spectrum with lambda-proportional scaling.
//
// Pupil: a 7-blade iris with slightly curved blades (the straight parts make the 14 spikes, the curvature fans
// them into soft wedges), blade-edge roughness (faint feathering along the spikes), a few dust specks and one
// fine hairline scratch on a rear element (a broad, very faint halo with rings, and one long faint ray).
// Everything else — spike beading, the 1/r^2 fall-off along a spike and ~1/r^3 between them, the red tips
// (longer wavelengths diffract further) — falls out of the physics instead of being painted on.
//
// The CPU does the pupil and the FFT (~30-50 ms); the spectral sum and the mip chain run on the GPU (post.js).

function fft1(re, im, n, stride, off, cosT, sinT, rev) {
  // in-place iterative radix-2 on re/im[off + i*stride], i < n
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      const a = off + i * stride, b = off + j * stride;
      let t = re[a]; re[a] = re[b]; re[b] = t;
      t = im[a]; im[a] = im[b]; im[b] = t;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1, step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0; k < half; k++) {
        const c = cosT[k * step], s = -sinT[k * step];
        const a = off + (i + k) * stride, b = off + (i + k + half) * stride;
        const xr = re[b] * c - im[b] * s, xi = re[b] * s + im[b] * c;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

// 2-D FFT of a real image that is zero outside rows [y0, y1]: rows are transformed only where they hold
// data, columns are gathered into a contiguous buffer (cache-friendly), and the power spectrum |F|^2 is
// written straight into `out` with the zero frequency moved to the centre (fftshift).
function powerSpectrum2(re, im, n, y0, y1, out) {
  const cosT = new Float64Array(n / 2), sinT = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    cosT[k] = Math.cos((2 * Math.PI * k) / n);
    sinT[k] = Math.sin((2 * Math.PI * k) / n);
  }
  const bits = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  for (let y = Math.max(0, y0); y <= Math.min(n - 1, y1); y++) fft1(re, im, n, 1, y * n, cosT, sinT, rev);
  const cr = new Float64Array(n), ci = new Float64Array(n);
  const h = n / 2;
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      cr[y] = re[y * n + x];
      ci[y] = im[y * n + x];
    }
    fft1(cr, ci, n, 1, 0, cosT, sinT, rev);
    const sx = (x + h) % n;
    for (let y = 0; y < n; y++) out[((y + h) % n) * n + sx] = cr[y] * cr[y] + ci[y] * ci[y];
  }
}

// small deterministic PRNG
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// CIE 1931 2-degree observer, multi-lobe Gaussian fit (Wyman, Sloan & Shirley 2013)
function cie(l) {
  const g = (x, m, s1, s2) => {
    const t = (x - m) / (x < m ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  const X = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
  const Y = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
  const Z = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  return [X, Y, Z];
}
function xyzToLinearSRGB([X, Y, Z]) {
  return [3.2406 * X - 1.5372 * Y - 0.4986 * Z, -0.9689 * X + 1.8758 * Y + 0.0415 * Z, 0.0557 * X - 0.204 * Y + 1.057 * Z];
}

export function buildPupilPSF({ N = 1024, blades = 7, seed = 20261102 } = {}) {
  const rnd = mulberry32(seed);
  const Ra = N / 4; // pupil circumradius in samples (largest radius whose PSF is still sampled without aliasing)
  const re = new Float64Array(N * N), im = new Float64Array(N * N);
  const seg = (2 * Math.PI) / blades;
  const rot0 = 0.0;

  // A real iris is not a perfect polygon: each blade is a separate stamped part on its own pivot, so its edge
  // sits at a slightly different angle (~1 deg) and distance, and its curvature varies. The opening is the
  // intersection of the blades' arcs (each arc bulges outward: a rounded aperture). Each edge's spike pair takes
  // its brightness from the edge length and its width from the arc's curvature, so the 7 pairs differ — the
  // starburst of a real lens, not a stock star filter.
  const hex = Ra * Math.cos(Math.PI / blades);
  const edges = [];
  for (let b = 0; b < blades; b++) {
    const phi = rot0 + (b + 0.5) * seg + ((rnd() * 2 - 1) * 1.3 * Math.PI) / 180;
    const h = hex * (1 + (rnd() * 2 - 1) * 0.006 + (b === 4 ? 0.016 : 0)); // one blade sits a little proud
    const k = 11 + 22 * rnd(); // arc radius / edge distance (larger = straighter edge)
    const Rc = h * k;
    const nx = Math.cos(phi), ny = Math.sin(phi);
    edges.push({ nx, ny, Rc, cx: -nx * (Rc - h), cy: -ny * (Rc - h) });
  }

  // blade-edge roughness: a smooth 1-D random profile per blade (value noise, ~36 bumps per edge)
  const NR = 36;
  const rough = [];
  for (let b = 0; b < blades; b++) {
    const a = new Float64Array(NR + 1);
    for (let i = 0; i <= NR; i++) a[i] = rnd() * 2 - 1;
    rough.push(a);
  }
  const roughAt = (b, u) => {
    // u in [0,1) along the blade edge
    const x = u * NR, i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
    return rough[b][i] * (1 - s) + rough[b][Math.min(NR, i + 1)] * s;
  };
  // dust specks and one hairline scratch
  const dust = [];
  for (let i = 0; i < 14; i++) {
    const rr = Math.sqrt(rnd()) * Ra * 0.85, aa = rnd() * 2 * Math.PI;
    dust.push({ x: rr * Math.cos(aa), y: rr * Math.sin(aa), r: 0.6 + 2.2 * rnd() ** 2, k: 0.55 + 0.45 * rnd() });
  }
  const scr = { x0: -0.35 * Ra, y0: 0.18 * Ra, x1: 0.22 * Ra, y1: 0.41 * Ra, w: 0.45, k: 0.6 };
  const sdx = scr.x1 - scr.x0, sdy = scr.y1 - scr.y0, sl2 = sdx * sdx + sdy * sdy;

  for (let y = 0; y < N; y++) {
    const py = y - N / 2 + 0.5;
    for (let x = 0; x < N; x++) {
      const px = x - N / 2 + 0.5;
      const rho = Math.hypot(px, py);
      if (rho > Ra * 1.06 + 3) continue;
      // signed distance to the nearest blade arc (positive inside the opening), with edge roughness
      let dmin = 1e9, bmin = 0;
      for (let b = 0; b < blades; b++) {
        const e = edges[b];
        const dx = px - e.cx, dy = py - e.cy;
        const dd = e.Rc - Math.sqrt(dx * dx + dy * dy);
        if (dd < dmin) {
          dmin = dd;
          bmin = b;
        }
      }
      if (dmin < -2) continue;
      {
        // position along the nearest edge (0..1) for its roughness profile
        const e = edges[bmin];
        const u = 0.5 + Math.atan2(e.nx * py - e.ny * px, e.nx * px + e.ny * py) / seg;
        dmin += 0.55 * roughAt(bmin, Math.min(1, Math.max(0, u)));
      }
      let t = Math.min(1, Math.max(0, dmin + 0.5)); // anti-aliased edge coverage
      if (t <= 0) continue;
      for (const d of dust) {
        const dx = px - d.x, dy = py - d.y, rr = d.r + 0.5;
        if (dx * dx + dy * dy >= rr * rr) continue;
        const dd = Math.sqrt(dx * dx + dy * dy) - d.r;
        t *= 1 - d.k * Math.min(1, 0.5 - dd);
      }
      const u = Math.min(1, Math.max(0, ((px - scr.x0) * sdx + (py - scr.y0) * sdy) / sl2));
      const ds = Math.hypot(px - (scr.x0 + u * sdx), py - (scr.y0 + u * sdy)) - scr.w;
      if (ds < 0.5) t *= 1 - scr.k * Math.min(1, 0.5 - ds);
      // slight transmission fall-off toward the rim (coatings / vignetting): softens the Airy rings a touch
      t *= 1 - 0.12 * (rho / Ra) ** 2;
      re[y * N + x] = t;
    }
  }

  const P = new Float32Array(N * N);
  powerSpectrum2(re, im, N, Math.floor(N / 2 - Ra * 1.06 - 4), Math.ceil(N / 2 + Ra * 1.06 + 4), P);
  let peak = 0;
  for (let i = 0; i < N * N; i++) if (P[i] > peak) peak = P[i];
  let tot = 0;
  for (let i = 0; i < N * N; i++) {
    P[i] /= peak;
    tot += P[i];
  }

  // spectral weights per linear-sRGB channel (positive lobes of the CIE->sRGB matching functions); the GPU
  // pass (SPECTRAL in shaders.js) sums PSF_lambda(theta) = s^2 PSF_550(theta s), s = 550/lambda, with them
  const lam = [];
  for (let l = 410; l <= 690; l += 28) lam.push(l);
  const W = lam.map((l) => xyzToLinearSRGB(cie(l)).map((v) => Math.max(0, v)));
  const sums = [0, 1, 2].map((c) => W.reduce((s, w) => s + w[c], 0));
  W.forEach((w) => [0, 1, 2].forEach((c) => (w[c] /= sums[c])));
  return {
    P, // N x N, centred (DC at index N/2), peak-normalised, 550 nm
    N,
    sum: tot, // sum of P: the energy normalisation (a sample holds P[i] / sum of the energy)
    lambdaScale: lam.map((l) => 550 / l),
    weights: W,
    airySamples: (1.22 * N) / (2 * Ra), // Airy first-zero radius in samples
    maxHalf: Math.floor(((N / 2 - 2) * lam[0]) / 550), // largest +-half-width (550 nm samples) the bluest band can fill
  };
}
