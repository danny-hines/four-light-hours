// Browser-side analysis of an offline render (runs in the page, on the float buffer, so NaNs/denormals are
// visible before 16-bit conversion). Used by src/audio/tools/render.mjs. Not part of the shipped bundle.
//
//   analyze(buffer, plan, {from})   -> loudness (ITU-R BS.1770-4 / EBU R128: K-weighting, 400 ms gated
//                                      integrated, 3 s short-term, LRA), sample & 4x-oversampled true peak,
//                                      DC, NaN/Inf/subnormal counts, silences, per-chapter/section stats,
//                                      spectral centroid and band energies, warp riser broadband rise
//   spectrogram(buffer, plan, a)    -> PNG data URL (log-frequency, chapter bands, warp markers, loudness)
//   streamWav(buffer, sink)         -> 16-bit PCM WAV with seeded TPDF dither, streamed in base64 chunks

const BANDS = [
  ['sub', 20, 60],
  ['low', 60, 250],
  ['lowmid', 250, 1000],
  ['mid', 1000, 4000],
  ['high', 4000, 12000],
  ['air', 12000, 20000],
];
const db = (x) => (x > 0 ? 10 * Math.log10(x) : -Infinity);
const amp = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

function biquad(x, b0, b1, b2, a1, a2) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}
// BS.1770 K-weighting at any sample rate (coefficients derived as in libebur128)
function kWeight(x, fs) {
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = biquad(x, (Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan((Math.PI * f0) / fs);
  a0 = 1 + K / Q + K * K;
  return biquad(s1, 1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0);
}

function gatedLoudness(blocks) {
  // blocks: mean-square (channel-summed) per 400 ms block
  const abs = blocks.filter((z) => -0.691 + db(z) > -70);
  if (!abs.length) return -Infinity;
  const m = abs.reduce((a, b) => a + b, 0) / abs.length;
  const rel = -0.691 + db(m) - 10;
  const g = abs.filter((z) => -0.691 + db(z) > rel);
  if (!g.length) return -Infinity;
  return -0.691 + db(g.reduce((a, b) => a + b, 0) / g.length);
}

// radix-2 FFT (in place)
function makeFFT(N) {
  const rev = new Uint32Array(N);
  const bits = Math.log2(N);
  for (let i = 0; i < N; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / N);
    sin[i] = -Math.sin((2 * Math.PI * i) / N);
  }
  return (re, im) => {
    for (let i = 0; i < N; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let i = 0; i < N; i += size)
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
    }
  };
}

export function analyze(buffer, plan, { from = 0 } = {}) {
  const sr = buffer.sampleRate;
  const L = buffer.getChannelData(0), R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const n = L.length;
  const tAt = (i) => from + i / sr;
  // integrity
  let nan = 0, sub = 0, peak = 0, peakAt = 0, sumL = 0, sumR = 0;
  for (let i = 0; i < n; i++) {
    for (const x of [L[i], R[i]]) {
      if (!Number.isFinite(x)) nan++;
      else if (x !== 0 && Math.abs(x) < 1.1754944e-38) sub++;
    }
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (a > peak) { peak = a; peakAt = i; }
    sumL += L[i]; sumR += R[i];
  }
  // true peak: 4x oversampling with a 32-tap Kaiser-ish windowed sinc, evaluated where the signal is loud
  const TP = 32;
  const phases = [0.25, 0.5, 0.75].map((p) => {
    const c = new Float64Array(TP);
    let s = 0;
    for (let t = 0; t < TP; t++) {
      const x = t - (TP / 2 - 1) - p;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / (TP / 2)) + 0.08 * Math.cos((2 * Math.PI * x) / (TP / 2));
      c[t] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * Math.max(0, w);
      s += c[t];
    }
    for (let t = 0; t < TP; t++) c[t] /= s;
    return c;
  });
  let tp = peak, tpAt = peakAt;
  const thr = peak * 0.5;
  for (const X of [L, R])
    for (let i = TP; i < n - TP; i++) {
      if (Math.abs(X[i]) < thr && Math.abs(X[i + 1]) < thr) continue;
      for (const c of phases) {
        let s = 0;
        const o = i - (TP / 2 - 1);
        for (let t = 0; t < TP; t++) s += c[t] * X[o + t];
        const a = Math.abs(s);
        if (a > tp) { tp = a; tpAt = i; }
      }
    }
  // loudness
  const kL = kWeight(L, sr), kR = kWeight(R, sr);
  const hop = Math.round(sr * 0.1);
  const nSeg = Math.floor(n / hop);
  const seg = new Float64Array(nSeg); // K-weighted mean square (L+R) per 100 ms
  const rms100 = new Float64Array(nSeg); // unweighted
  const side = new Float64Array(nSeg), mid = new Float64Array(nSeg);
  for (let s = 0; s < nSeg; s++) {
    let a = 0, b = 0, m = 0, d = 0;
    for (let i = s * hop; i < (s + 1) * hop; i++) {
      a += kL[i] * kL[i] + kR[i] * kR[i];
      b += L[i] * L[i] + R[i] * R[i];
      const M = (L[i] + R[i]) / 2, S = (L[i] - R[i]) / 2;
      m += M * M; d += S * S;
    }
    seg[s] = a / hop; rms100[s] = b / (2 * hop); mid[s] = m / hop; side[s] = d / hop;
  }
  const block = (s0, len) => {
    let a = 0;
    for (let k = s0; k < s0 + len; k++) a += seg[k];
    return a / len;
  };
  const blocks400 = [];
  for (let s = 0; s + 4 <= nSeg; s++) blocks400.push(block(s, 4));
  const shortTerm = new Float32Array(nSeg); // 3 s window ending at segment s
  for (let s = 0; s < nSeg; s++) {
    const s0 = Math.max(0, s - 29);
    shortTerm[s] = -0.691 + db(block(s0, s - s0 + 1));
  }
  const integrated = gatedLoudness(blocks400);
  // 50 ms RMS (unweighted, both channels) for transient steps, and the 150 Hz low band for stereo checks
  const hop50 = Math.round(sr * 0.05);
  const n50 = Math.floor(n / hop50);
  const rms50 = new Float32Array(n50);
  for (let s = 0; s < n50; s++) {
    let a = 0;
    for (let i = s * hop50; i < (s + 1) * hop50; i++) a += L[i] * L[i] + R[i] * R[i];
    rms50[s] = amp(Math.sqrt(a / (2 * hop50)) + 1e-12);
  }
  const lpK = Math.tan((Math.PI * 150) / sr), lpQ = Math.SQRT1_2, lpN = 1 / (1 + lpK / lpQ + lpK * lpK);
  const lpb0 = lpK * lpK * lpN, lpa1 = 2 * (lpK * lpK - 1) * lpN, lpa2 = (1 - lpK / lpQ + lpK * lpK) * lpN;
  // 4th order (two 2nd-order sections), so "below 150 Hz" means below 150 Hz
  const lowL = biquad(biquad(L, lpb0, 2 * lpb0, lpb0, lpa1, lpa2), lpb0, 2 * lpb0, lpb0, lpa1, lpa2), lowR = biquad(biquad(R, lpb0, 2 * lpb0, lpb0, lpa1, lpa2), lpb0, 2 * lpb0, lpb0, lpa1, lpa2);
  const stereo = (t0, t1) => {
    const i0 = Math.max(0, Math.floor((t0 - from) * sr)), i1 = Math.min(n, Math.floor((t1 - from) * sr));
    let lr = 0, ll = 0, rr = 0, a = 0, b = 0, c = 0;
    for (let i = i0; i < i1; i++) {
      lr += L[i] * R[i]; ll += L[i] * L[i]; rr += R[i] * R[i];
      a += lowL[i] * lowR[i]; b += lowL[i] * lowL[i]; c += lowR[i] * lowR[i];
    }
    // (a world with almost nothing below 150 Hz has no meaningful low-band correlation)
    const lowShare = (b + c) / (ll + rr + 1e-20);
    return { corr: +(lr / Math.sqrt(ll * rr + 1e-20)).toFixed(2), lowCorr: lowShare > 0.01 ? +(a / Math.sqrt(b * c + 1e-20)).toFixed(2) : null, balanceDb: +(10 * Math.log10((ll + 1e-20) / (rr + 1e-20))).toFixed(2) };
  };
  // LRA (EBU Tech 3342)
  const st = [];
  for (let s = 29; s < nSeg; s += 1) st.push(block(s - 29, 30));
  const stAbs = st.filter((z) => -0.691 + db(z) > -70);
  let lra = 0;
  if (stAbs.length > 10) {
    const m = stAbs.reduce((a, b) => a + b, 0) / stAbs.length;
    const rel = -0.691 + db(m) - 20;
    const v = stAbs.map((z) => -0.691 + db(z)).filter((x) => x > rel).sort((a, b) => a - b);
    lra = v[Math.floor(v.length * 0.95)] - v[Math.floor(v.length * 0.1)];
  }
  // longest silence (< -60 dBFS RMS per 100 ms) inside the film proper
  const filmSeg = Math.min(nSeg, Math.floor(((plan.duration - from) * sr) / hop));
  let longest = 0, run = 0, runStart = 0, longestAt = 0;
  for (let s = 0; s < filmSeg; s++) {
    if (db(rms100[s]) < -60) {
      if (!run) runStart = s;
      run++;
      if (run > longest) { longest = run; longestAt = runStart; }
    } else run = 0;
  }
  // spectral columns (also used by the spectrogram)
  const N = 8192, fft = makeFFT(N);
  const win = new Float64Array(N);
  let wsum = 0;
  for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); wsum += win[i]; }
  const colHop = Math.round(sr * 0.05);
  const nCol = Math.floor((n - N) / colHop) + 1;
  const NB = 384, fMin = 25, fMax = 20000;
  const logEdges = new Float64Array(NB + 1);
  for (let b = 0; b <= NB; b++) logEdges[b] = fMin * Math.pow(fMax / fMin, b / NB);
  const spec = new Float32Array(Math.max(0, nCol) * NB);
  const bandE = new Float32Array(Math.max(0, nCol) * BANDS.length);
  const centroid = new Float32Array(Math.max(0, nCol));
  const re = new Float64Array(N), im = new Float64Array(N), P = new Float64Array(N / 2);
  const binHz = sr / N;
  for (let c = 0; c < nCol; c++) {
    const o = c * colHop;
    for (let i = 0; i < N; i++) { re[i] = 0.5 * (L[o + i] + R[o + i]) * win[i]; im[i] = 0; }
    fft(re, im);
    let num = 0, den = 0;
    for (let k = 0; k < N / 2; k++) {
      const a = (2 * Math.hypot(re[k], im[k])) / wsum;
      P[k] = a * a;
      const f = k * binHz;
      if (f >= 20 && f <= 20000) { num += f * P[k]; den += P[k]; }
    }
    centroid[c] = den > 0 ? num / den : 0;
    for (let b = 0; b < BANDS.length; b++) {
      let e = 0;
      for (let k = Math.ceil(BANDS[b][1] / binHz); k <= Math.min(N / 2 - 1, Math.floor(BANDS[b][2] / binHz)); k++) e += P[k];
      bandE[c * BANDS.length + b] = e;
    }
    for (let b = 0; b < NB; b++) {
      const ka = logEdges[b] / binHz, kb = logEdges[b + 1] / binHz;
      let v = 0;
      if (Math.floor(kb) - Math.ceil(ka) >= 1) {
        for (let k = Math.ceil(ka); k <= Math.floor(kb); k++) v = Math.max(v, P[k]);
      } else {
        const kc = (ka + kb) / 2, k0 = Math.floor(kc), fr = kc - k0;
        v = P[k0] * (1 - fr) + P[Math.min(N / 2 - 1, k0 + 1)] * fr;
      }
      spec[c * NB + b] = v;
    }
  }
  const colT = (c) => from + (c * colHop + N / 2) / sr;
  // per-span stats
  const span = (t0, t1) => {
    const s0 = Math.max(0, Math.floor(((t0 - from) * sr) / hop)), s1 = Math.min(nSeg, Math.ceil(((t1 - from) * sr) / hop));
    if (s1 - s0 < 2) return null;
    let ms = 0, pk = 0, m = 0, d = 0, stMax = -Infinity;
    for (let s = s0; s < s1; s++) { ms += rms100[s]; m += mid[s]; d += side[s]; stMax = Math.max(stMax, shortTerm[s]); }
    const i0 = s0 * hop, i1 = s1 * hop;
    for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    const bl = [];
    for (let s = s0; s + 4 <= s1; s++) bl.push(block(s, 4));
    const c0 = Math.max(0, Math.floor((((t0 - from) * sr) - N / 2) / colHop)), c1 = Math.min(nCol, Math.ceil((((t1 - from) * sr) - N / 2) / colHop));
    const be = new Float64Array(BANDS.length);
    let cn = 0, cd = 0;
    for (let c = c0; c < c1; c++) {
      let tot = 0;
      for (let b = 0; b < BANDS.length; b++) { be[b] += bandE[c * BANDS.length + b]; tot += bandE[c * BANDS.length + b]; }
      cn += centroid[c] * tot; cd += tot;
    }
    const beTot = be.reduce((a, b) => a + b, 0) || 1;
    return {
      t0, t1,
      rmsDb: +amp(Math.sqrt(ms / (s1 - s0))).toFixed(1),
      peakDb: +amp(pk).toFixed(1),
      lufs: +gatedLoudness(bl).toFixed(1),
      stMax: +stMax.toFixed(1),
      centroidHz: Math.round(cd > 0 ? cn / cd : 0),
      bands: Object.fromEntries(BANDS.map(([k], b) => [k, +((100 * be[b]) / beTot).toFixed(1)])),
      width: +(d / Math.max(1e-12, m)).toFixed(3),
      ...stereo(t0, t1),
    };
  };
  const chapters = [];
  for (const s of plan.sections) for (const c of s.chapters) chapters.push({ id: c.id, title: c.title, world: s.world, ...(span(Math.max(from, c.t0), c.t1) || {}) });
  chapters.sort((a, b) => a.t0 - b.t0);
  const sections = plan.sections.map((s) => ({ world: s.world, label: s.label, chords: s.chords.map((c) => c.name), ...(span(Math.max(from, s.t0), s.t1) || {}) }));
  // warp risers: 4-16 kHz energy during the leg vs the 3 s before it
  const hfAt = (t0, t1) => {
    const c0 = Math.max(0, Math.floor((((t0 - from) * sr) - N / 2) / colHop)), c1 = Math.min(nCol, Math.ceil((((t1 - from) * sr) - N / 2) / colHop));
    let e = 0, k = 0;
    for (let c = c0; c < c1; c++) { e += bandE[c * BANDS.length + 4] + bandE[c * BANDS.length + 5]; k++; }
    return k ? e / k : 0;
  };
  // short-term loudness (3 s window ending at the segment) between journey times t0..t1
  const stSpan = (t0, t1) => {
    const s0 = Math.max(0, Math.floor(((t0 - from) * sr) / hop)), s1 = Math.min(nSeg, Math.ceil(((t1 - from) * sr) / hop));
    const v = [];
    for (let s = s0; s < s1; s++) if (Number.isFinite(shortTerm[s])) v.push(shortTerm[s]);
    return v;
  };
  const median = (v) => (v.length ? v.slice().sort((a, b) => a - b)[Math.floor(v.length / 2)] : -Infinity);
  const warps = plan.warps
    .filter((w) => w.we > from && w.ws < from + n / sr)
    .map((w) => {
      const o = { ws: +w.ws.toFixed(2), we: +w.we.toFixed(2), ta: +w.ta.toFixed(2), leg: w.leg, arrives: w.arrives !== false, peak: +w.peak.toFixed(2), hfRiseDb: +(db(hfAt(w.ws + 0.6 * (w.wp - w.ws), w.wp + 0.3 * (w.we - w.wp))) - db(hfAt(w.ws - 3, w.ws))).toFixed(1) };
      // the reveal vs the whoosh: peak short-term loudness during the leg, the arrival bloom (first 8 s) and
      // the arriving world's settled level (median of 4..20 s after the arrival)
      const next = plan.warps.find((x) => x.ws > w.ta + 1);
      if (w.leg && w.ta + 6 < from + n / sr) {
        // short-term windows that lie inside the leg (they end >= 3 s after it starts), plus the arrival thump
        const legPk = Math.max(...stSpan(Math.min(w.ws + 3, w.ta), w.ta + 0.3));
        const bloom = Math.max(...stSpan(w.ta + 0.3, w.ta + 8));
        const settled = median(stSpan(w.ta + 4, Math.min(w.ta + 20, next ? next.ws : Infinity)));
        Object.assign(o, { legStMax: +legPk.toFixed(1), bloomStMax: +bloom.toFixed(1), arrivalMedian: +settled.toFixed(1), legOverArrival: +(legPk - settled).toFixed(1), bloomOverLeg: +(bloom - legPk).toFixed(1) });
        // a continuous crescendo: the leg (1 s windows) never falls below the music it takes over from (400 ms
        // momentary loudness, median of the 2 s before the leg starts), and crests a little above it. The leg
        // starts when the camera does (the warp reaches 10% of its peak): a director may hold the shot for
        // seconds after its departure marker, and until it moves the world's own music simply continues.
        let mv = w.ws;
        if (w.curve) for (let i = 0; i < w.curve.length; i++) if (w.curve[i] >= 0.1 * w.peak) { mv = Math.max(w.ws, w.c0 + i / w.hz); break; }
        const mom = (s) => -0.691 + db(block(Math.max(0, s - 3), Math.min(4, s + 1)));
        const segOf = (t) => Math.floor(((t - from) * sr) / hop);
        const preV = [];
        for (let s = segOf(mv - 2); s < segOf(mv - 0.1); s++) if (s >= 3) preV.push(mom(s));
        const pre = median(preV);
        let lmin = Infinity, lmax = -Infinity;
        for (let s = segOf(mv + 0.5); s + 10 <= segOf(w.ta - 0.2); s++) {
          const v = -0.691 + db(block(s, 10));
          lmin = Math.min(lmin, v);
          lmax = Math.max(lmax, v);
        }
        // the arrival: the biggest 50 ms step (vs the mean of the 0.5 s before it) around the reveal
        let step = -Infinity;
        const s50 = (t) => Math.floor(((t - from) * sr) / hop50);
        for (let i = s50(w.ta - 0.3); i <= s50(w.ta + 0.6); i++) {
          if (i < 10 || i >= n50) continue;
          let m0 = 0;
          for (let k = i - 10; k < i; k++) m0 += rms50[k];
          step = Math.max(step, rms50[i] - m0 / 10);
        }
        Object.assign(o, { moves: +mv.toFixed(1), preLeg: +pre.toFixed(1), legMinVsPre: Number.isFinite(lmin) ? +(lmin - pre).toFixed(1) : null, legMaxVsPre: Number.isFinite(lmax) ? +(lmax - pre).toFixed(1) : null, arrivalStepDb: +step.toFixed(1) });
      }
      return o;
    });
  // each world's own colour: spectral centroid of its music alone (from 3 s after it starts to the start of its
  // departure leg, so neither the arriving bloom nor the next riser is counted), and the contrast in octaves
  // with the world before it
  const character = plan.sections.map((s) => {
    const a = Math.max(from, s.t0 + 3),
      b = Math.min(from + n / sr, s.depart ? s.depart.ws : s.t1);
    const st = b - a > 3 ? span(a, b) : null;
    return { world: s.world, t0: +a.toFixed(1), t1: +b.toFixed(1), centroidHz: st ? st.centroidHz : null, bands: st ? st.bands : null, lufs: st ? st.lufs : null, target: s.centroid, inTarget: st && s.centroid ? st.centroidHz >= s.centroid[0] && st.centroidHz <= s.centroid[1] : null, corr: st ? st.corr : null, lowCorr: st ? st.lowCorr : null, balanceDb: st ? st.balanceDb : null };
  });
  character.forEach((c, i) => {
    const p = character[i - 1];
    c.octavesFromPrev = p && p.centroidHz && c.centroidHz ? +Math.log2(c.centroidHz / p.centroidHz).toFixed(2) : null;
  });
  // the melody's salience: for every melody note, the level of its fundamental (+-40 cents) shortly after its
  // onset vs (a) the same band just before it (the rise) and (b) the strongest other partial within an octave
  // either side, ignoring the phrase's own notes and their octaves (the margin over the local pad partials)
  // Spectral self-similarity between worlds: each world's long-term spectral envelope (its own music, the same
  // spans as `character`) on 40 log-spaced bands from 40 Hz to 16 kHz, in dB. Two measures: `corr`, the Pearson
  // correlation of the mean-removed envelopes (the shape alone), and `cos`, the cosine of the envelopes floored at
  // -80 dB under the film's loudest band (shape and level, like a log-mel self-similarity matrix).
  const NBX = 40, fx0 = 40, fx1 = 16000;
  const envOf = (t0, t1) => {
    const c0 = Math.max(0, Math.floor((((t0 - from) * sr) - N / 2) / colHop)), c1 = Math.min(nCol, Math.ceil((((t1 - from) * sr) - N / 2) / colHop));
    if (c1 - c0 < 10) return null;
    const e = new Float64Array(NBX);
    for (let c = c0; c < c1; c++)
      for (let b = 0; b < NB; b++) {
        const f = Math.sqrt(logEdges[b] * logEdges[b + 1]);
        if (f < fx0 || f >= fx1) continue;
        const k = Math.floor((NBX * Math.log(f / fx0)) / Math.log(fx1 / fx0));
        e[k] += spec[c * NB + b];
      }
    return Array.from(e, (x) => 10 * Math.log10(x / (c1 - c0) + 1e-20));
  };
  const envs = character.map((c) => (c.t1 - c.t0 > 3 ? envOf(c.t0, c.t1) : null));
  const top = Math.max(...envs.filter(Boolean).flat());
  const corrOf = (a, b) => {
    const ma = a.reduce((x, y) => x + y, 0) / a.length, mb = b.reduce((x, y) => x + y, 0) / b.length;
    let n0 = 0, da = 0, db0 = 0;
    for (let i = 0; i < a.length; i++) { n0 += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db0 += (b[i] - mb) ** 2; }
    return n0 / Math.sqrt(da * db0 + 1e-20);
  };
  const cosOf = (a, b) => {
    const A = a.map((x) => Math.max(0, x - top + 80)), B = b.map((x) => Math.max(0, x - top + 80));
    let n0 = 0, da = 0, db0 = 0;
    for (let i = 0; i < A.length; i++) { n0 += A[i] * B[i]; da += A[i] ** 2; db0 += B[i] ** 2; }
    return n0 / Math.sqrt(da * db0 + 1e-20);
  };
  const selfsim = { worlds: character.map((c) => c.world), corr: envs.map((a) => envs.map((b) => (a && b ? +corrOf(a, b).toFixed(3) : null))), cos: envs.map((a) => envs.map((b) => (a && b ? +cosOf(a, b).toFixed(3) : null))) };
  const motif = [];
  const mtofA = (m) => 440 * Math.pow(2, (m - 69) / 12);
  const specMid = (tc) => {
    const o = Math.round((tc - from) * sr) - N / 2;
    if (o < 0 || o + N > n) return null;
    for (let i = 0; i < N; i++) { re[i] = 0.5 * (L[o + i] + R[o + i]) * win[i]; im[i] = 0; }
    fft(re, im);
    const p = new Float64Array(N / 2);
    for (let k = 0; k < N / 2; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    return p;
  };
  const bandMax = (p, f0, f1) => {
    let m = 0;
    for (let k = Math.max(1, Math.floor(f0 / binHz)); k <= Math.min(N / 2 - 1, Math.ceil(f1 / binHz)); k++) m = Math.max(m, p[k]);
    return m;
  };
  const LEAD_DELAY = { piano: 0.16, choir: 0.5, brass: 0.45 };
  for (const ph of plan.phrases || []) {
    if (!(ph.inst in LEAD_DELAY)) continue;
    if (ph.duet && ph.tune) continue; // a doubling of a tune (the voice, strings, a horn an octave below) is part of its blend: the tune itself is measured
    const evs = plan.events.filter((e) => e.motif && e.lead && e.t >= ph.t0 - 0.3 && e.t <= ph.t1 + 0.05 && (ph.inst === 'piano' ? e.type === 'piano' : ph.inst === 'choir' ? e.type === 'choir' : e.type === 'brass'));
    // melody notes still ringing (this phrase and any phrase that ended within 3 s) are the melody, not the pad
    const ringing = (plan.phrases || []).filter((q) => q.t0 <= ph.t1 && q.t1 + 3 >= ph.t0).flatMap((q) => q.notes);
    // the melody's own sound is not competition: its notes, their octaves, and their 3rd/4th harmonics (a horn's
    // C5 still ringing puts its 3rd harmonic G6 right next to the G#5 that follows it)
    const own = [...new Set(ringing)].flatMap((m) => [m - 12, m, m + 12, m + 19, m + 24]).map(mtofA);
    for (const e of evs) {
      const f = mtofA(e.midi);
      const pa = specMid(e.t + LEAD_DELAY[ph.inst] + (ph.inst === 'choir' ? 0.12 : 0)), pb = specMid(e.t - 0.13);
      if (!pa || !pb) continue;
      const c = Math.pow(2, 40 / 1200), x = Math.pow(2, 60 / 1200);
      const half = (g, cents, bins) => Math.max(g * (Math.pow(2, cents / 1200) - 1), bins * binHz);
      const note = bandMax(pa, f - half(f, 40, 1), f + half(f, 40, 1)), before = bandMax(pb, f - half(f, 40, 1), f + half(f, 40, 1));
      let other = 0;
      for (let k = Math.ceil(f / 2 / binHz); k <= Math.min(N / 2 - 1, Math.floor((2 * f) / binHz)); k++) {
        const fk = k * binHz;
        if (own.some((g) => Math.abs(fk - g) < half(g, 60, 1.6))) continue;
        other = Math.max(other, pa[k]);
      }
      motif.push({ t: +e.t.toFixed(2), world: ph.world, inst: ph.inst, phrase: ph.name, midi: e.midi, riseDb: +(db(note) - db(before)).toFixed(1), marginDb: +(db(note) - db(other)).toFixed(1) });
    }
  }
  return {
    sampleRate: sr,
    seconds: +(n / sr).toFixed(2),
    integrity: { nan, subnormal: sub, dcL: sumL / n, dcR: sumR / n },
    samplePeakDb: +amp(peak).toFixed(2),
    samplePeakAt: +tAt(peakAt).toFixed(2),
    truePeakDb: +amp(tp).toFixed(2),
    truePeakAt: +tAt(tpAt).toFixed(2),
    integratedLufs: +integrated.toFixed(1),
    lra: +lra.toFixed(1),
    shortTermMax: +Math.max(...shortTerm).toFixed(1),
    stPeaks: (() => {
      const film = Math.min(nSeg, Math.floor(((plan.duration - from) * sr) / hop));
      const idx = [];
      for (let k = 30; k < film; k++) idx.push(k);
      idx.sort((a, b) => shortTerm[b] - shortTerm[a]);
      const out = [];
      for (const k of idx) {
        const t = tAt(k * hop);
        if (out.every((o) => Math.abs(o.t - t) >= 8)) out.push({ t: +t.toFixed(1), lufs: +shortTerm[k].toFixed(1) });
        if (out.length >= 6) break;
      }
      return out;
    })(),
    longestSilence: { seconds: +((longest * hop) / sr).toFixed(1), at: +tAt(longestAt * hop).toFixed(1) },
    chapters,
    sections,
    warps,
    character,
    selfsim,
    motif,
    // series for the spectrogram (not serialised)
    _series: { shortTerm, rms100, hop, spec, nCol, NB, colHop, N, colT, fMin, fMax },
  };
}

const MAGMA = [[0, 0, 4], [28, 16, 68], [79, 18, 123], [129, 37, 129], [181, 54, 122], [229, 80, 100], [251, 135, 97], [254, 194, 135], [252, 253, 191]];
function cmap(x) {
  x = Math.max(0, Math.min(1, x)) * (MAGMA.length - 1);
  const i = Math.min(MAGMA.length - 2, Math.floor(x)), f = x - i;
  const a = MAGMA[i], b = MAGMA[i + 1];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export function spectrogram(buffer, plan, a, { from = 0, width = 2400 } = {}) {
  const S = a._series;
  const padL = 64, padR = 18, top = 58, specH = 620, gap = 26, loudH = 200, bottom = 34;
  const W = width, H = top + specH + gap + loudH + bottom;
  const plotW = W - padL - padR;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#07070a';
  g.fillRect(0, 0, W, H);
  const t0 = from, t1 = from + buffer.length / buffer.sampleRate;
  const X = (t) => padL + ((t - t0) / (t1 - t0)) * plotW;
  // spectrogram image
  const img = g.createImageData(plotW, specH);
  let mx = 0;
  for (let i = 0; i < S.spec.length; i += 7) mx = Math.max(mx, S.spec[i]);
  const top_dB = Math.min(-6, 10 * Math.log10(mx + 1e-20)), range = 85;
  for (let x = 0; x < plotW; x++) {
    const tt = t0 + ((x + 0.5) / plotW) * (t1 - t0);
    const c = Math.max(0, Math.min(S.nCol - 1, Math.round(((tt - from) * buffer.sampleRate - S.N / 2) / S.colHop)));
    for (let y = 0; y < specH; y++) {
      const b = Math.max(0, Math.min(S.NB - 1, Math.floor(((specH - 1 - y) / specH) * S.NB)));
      const v = 10 * Math.log10(S.spec[c * S.NB + b] + 1e-20);
      const [r, gg, bb] = cmap((v - (top_dB - range)) / range);
      const k = (y * plotW + x) * 4;
      img.data[k] = r; img.data[k + 1] = gg; img.data[k + 2] = bb; img.data[k + 3] = 255;
    }
  }
  g.putImageData(img, padL, top);
  // frequency axis
  g.font = '12px monospace';
  g.textAlign = 'right';
  const fy = (f) => top + specH - (Math.log(f / S.fMin) / Math.log(S.fMax / S.fMin)) * specH;
  for (const f of [30, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    const y = fy(f);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(padL, y, plotW, 1);
    g.fillStyle = '#bbb';
    g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), padL - 6, y + 4);
  }
  // chapter bands and boundaries
  const chs = [];
  for (const s of plan.sections) for (const c of s.chapters) chs.push({ ...c, world: s.world });
  chs.sort((p, q) => p.t0 - q.t0);
  g.textAlign = 'left';
  chs.forEach((c, i) => {
    const xa = X(Math.max(t0, c.t0)), xb = X(Math.min(t1, c.t1));
    if (xb <= padL || xa >= W - padR) return;
    g.fillStyle = i % 2 ? '#1b1b24' : '#26263a';
    g.fillRect(xa, 6, xb - xa, 22);
    g.fillStyle = '#e8e8f0';
    g.font = '12px sans-serif';
    g.save();
    g.beginPath(); g.rect(xa, 6, xb - xa, 22); g.clip();
    g.fillText(String(c.title || c.id), xa + 4, 21);
    g.restore();
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(xa, top, 1, specH + gap + loudH);
  });
  // music sections (world colours) strip
  plan.sections.forEach((s) => {
    const xa = X(Math.max(t0, s.t0)), xb = X(Math.min(t1, s.t1));
    if (xb <= padL) return;
    g.fillStyle = 'rgba(120,200,255,0.25)';
    g.fillRect(xa + 1, 32, xb - xa - 2, 10);
    g.fillStyle = '#9cd';
    g.font = '10px monospace';
    g.save(); g.beginPath(); g.rect(xa, 30, xb - xa, 14); g.clip();
    g.fillText(s.world, xa + 3, 41);
    g.restore();
  });
  // warp legs
  for (const w of plan.warps) {
    const xa = X(w.ws), xb = X(w.we);
    if (xb < padL || xa > W - padR) continue;
    g.fillStyle = 'rgba(255,150,40,0.85)';
    g.fillRect(xa, 46, Math.max(2, xb - xa), 7);
    g.fillStyle = 'rgba(255,150,40,0.9)';
    g.fillRect(xb - 1, top + specH - 60, 2, 60);
  }
  // loudness panel
  const ly0 = top + specH + gap;
  g.fillStyle = '#0e0e14';
  g.fillRect(padL, ly0, plotW, loudH);
  const LY = (v) => ly0 + loudH - ((v + 60) / 60) * loudH;
  g.font = '11px monospace';
  g.textAlign = 'right';
  for (const v of [-60, -48, -36, -24, -18, -12, -6, -1, 0]) {
    g.fillStyle = v === -18 ? 'rgba(80,220,255,0.5)' : v === -1 ? 'rgba(255,80,80,0.7)' : 'rgba(255,255,255,0.1)';
    g.fillRect(padL, LY(v), plotW, 1);
    g.fillStyle = '#aaa';
    if (v !== 0) g.fillText(String(v), padL - 6, LY(v) + 4);
  }
  // sample peak per pixel (dBFS) in grey, short-term LUFS in cyan
  const sr = buffer.sampleRate, Lc = buffer.getChannelData(0), Rc = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : Lc;
  g.fillStyle = 'rgba(200,200,210,0.35)';
  for (let x = 0; x < plotW; x++) {
    const i0 = Math.floor((x / plotW) * Lc.length), i1 = Math.floor(((x + 1) / plotW) * Lc.length);
    let pk = 0;
    for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(Lc[i]), Math.abs(Rc[i]));
    const v = Math.max(-60, 20 * Math.log10(pk + 1e-9));
    g.fillRect(padL + x, LY(v), 1, ly0 + loudH - LY(v));
  }
  g.strokeStyle = '#4de3ff';
  g.lineWidth = 1.6;
  g.beginPath();
  const st = S.shortTerm;
  for (let s = 0; s < st.length; s++) {
    const x = padL + (((s + 1) * S.hop) / sr / (t1 - t0)) * plotW;
    const v = Math.max(-60, st[s]);
    if (s === 0) g.moveTo(x, LY(v));
    else g.lineTo(x, LY(v));
  }
  g.stroke();
  // time axis
  g.fillStyle = '#bbb';
  g.textAlign = 'center';
  g.font = '12px monospace';
  const stepT = t1 - t0 > 240 ? 30 : t1 - t0 > 60 ? 10 : 5;
  for (let t = Math.ceil(t0 / stepT) * stepT; t <= t1; t += stepT) g.fillText(mmss(t), X(t), H - 12);
  g.textAlign = 'left';
  g.fillStyle = '#ddd';
  g.font = '13px sans-serif';
  g.fillText(`FOUR LIGHT-HOURS score — integrated ${a.integratedLufs} LUFS, LRA ${a.lra} LU, true peak ${a.truePeakDb} dBTP   (orange: warp legs; cyan: short-term LUFS, grey: sample peak; red line -1 dBFS)`, padL, ly0 - 8);
  return cv.toDataURL('image/png');
}

// 16-bit PCM WAV, TPDF dither from a fixed-seed LCG, streamed to `sink(base64)` in chunks.
export async function streamWav(buffer, sink, chunkFrames = 1 << 19) {
  const sr = buffer.sampleRate, nch = Math.min(2, buffer.numberOfChannels), n = buffer.length;
  const L = buffer.getChannelData(0), R = nch > 1 ? buffer.getChannelData(1) : L;
  const header = new DataView(new ArrayBuffer(44));
  const w4 = (o, s) => { for (let i = 0; i < 4; i++) header.setUint8(o + i, s.charCodeAt(i)); };
  w4(0, 'RIFF'); header.setUint32(4, 36 + n * nch * 2, true); w4(8, 'WAVE'); w4(12, 'fmt ');
  header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, nch, true);
  header.setUint32(24, sr, true); header.setUint32(28, sr * nch * 2, true); header.setUint16(32, nch * 2, true); header.setUint16(34, 16, true);
  w4(36, 'data'); header.setUint32(40, n * nch * 2, true);
  const toB64 = (u8) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1] || ''); fr.readAsDataURL(new Blob([u8])); });
  await sink(await toB64(new Uint8Array(header.buffer)));
  let seed = 22222;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let s = 0; s < n; s += chunkFrames) {
    const e = Math.min(n, s + chunkFrames);
    const out = new Int16Array((e - s) * nch);
    for (let i = s, k = 0; i < e; i++) {
      for (let c = 0; c < nch; c++) {
        const x = (c ? R[i] : L[i]) * 32767 + (rnd() - rnd());
        out[k++] = Math.max(-32768, Math.min(32767, Math.round(x)));
      }
    }
    await sink(await toB64(new Uint8Array(out.buffer)));
  }
}

// A compact measurement of one stretch [t0, t1) of a buffer (the explore-bed tool): BS.1770 integrated loudness
// (gated) and the short-term (3 s) curve, sample peak, the 4x-oversampled true peak, the largest sample-to-sample
// step (a click shows as a step far above the stretch's typical one), NaN count.
export function measure(buffer, t0 = 0, t1 = Infinity) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.floor(t0 * sr)),
    b = Math.min(buffer.length, Math.floor(t1 * sr));
  const L = buffer.getChannelData(0).subarray(a, b),
    R = (buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : buffer.getChannelData(0)).subarray(a, b);
  const n = L.length;
  let peak = 0, step = 0, stepAt = 0, nan = 0, sq = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) nan++;
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (p > peak) peak = p;
    sq += L[i] * L[i] + R[i] * R[i];
    if (i) {
      const d = Math.max(Math.abs(L[i] - L[i - 1]), Math.abs(R[i] - R[i - 1]));
      if (d > step) { step = d; stepAt = i; }
    }
  }
  // true peak (4x): linear-phase windowed-sinc interpolation where the signal is within 6 dB of its peak
  const TP = 32;
  const phases = [0.25, 0.5, 0.75].map((p) => {
    const c = new Float64Array(TP);
    let s = 0;
    for (let t = 0; t < TP; t++) {
      const x = t - (TP / 2 - 1) - p;
      const w = 0.42 + 0.5 * Math.cos((Math.PI * x) / (TP / 2)) + 0.08 * Math.cos((2 * Math.PI * x) / (TP / 2));
      c[t] = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * Math.max(0, w);
      s += c[t];
    }
    for (let t = 0; t < TP; t++) c[t] /= s;
    return c;
  });
  let tp = peak;
  for (const X of [L, R])
    for (let i = TP; i < n - TP; i++) {
      if (Math.abs(X[i]) < peak * 0.5 && Math.abs(X[i + 1]) < peak * 0.5) continue;
      for (const c of phases) {
        let s = 0;
        const o = i - (TP / 2 - 1);
        for (let t = 0; t < TP; t++) s += c[t] * X[o + t];
        if (Math.abs(s) > tp) tp = Math.abs(s);
      }
    }
  const kl = kWeight(L, sr), kr = kWeight(R, sr);
  const hop = Math.round(0.1 * sr);
  const hops = [];
  for (let i = 0; i + hop <= n; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += kl[j] * kl[j] + kr[j] * kr[j];
    hops.push(s / hop);
  }
  const win = (k) => {
    const out = [];
    for (let i = k; i <= hops.length; i++) {
      let s = 0;
      for (let j = i - k; j < i; j++) s += hops[j];
      out.push(s / k);
    }
    return out;
  };
  const st = win(30).map((z) => +(-0.691 + db(z)).toFixed(1));
  return {
    seconds: +(n / sr).toFixed(1),
    lufs: +gatedLoudness(win(4)).toFixed(1),
    stMin: st.length ? Math.min(...st) : null,
    stMax: st.length ? Math.max(...st) : null,
    rmsDb: +(db(sq / (2 * Math.max(1, n)))).toFixed(1),
    peakDb: +amp(peak).toFixed(2),
    truePeakDb: +amp(tp).toFixed(2),
    maxStep: +step.toFixed(4),
    maxStepAt: +(t0 + stepAt / sr).toFixed(3),
    nan,
    st,
  };
}
