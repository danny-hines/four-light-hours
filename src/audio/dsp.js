// Sample-level synthesis done once in JS: seeded noise loops, the convolution reverb's impulse response, the
// felt-piano notes, and the oscillator wavetables. All deterministic (fixed seeds), all denormal-safe.
import { mulberry32, mtof } from './theory.js';

const TINY = 1e-20;

function gaussian(rand) {
  // Box-Muller
  let u = 0,
    v = 0;
  while (u < 1e-12) u = rand();
  v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Crossfade the end of a buffer into its start so it loops without a click.
function makeLoopable(d, sr, fadeSec = 0.12) {
  const n = d.length,
    f = Math.min(Math.floor(n / 4), Math.round(fadeSec * sr));
  for (let i = 0; i < f; i++) {
    const x = i / f;
    const a = Math.sqrt(x),
      b = Math.sqrt(1 - x);
    d[i] = d[i] * a + d[n - f + i] * b;
  }
  // the last f samples are now duplicated at the start; trim by re-copying a shorter body
  return d.subarray(0, n - f);
}

export function noiseBuffer(ctx, kind, seconds, channels, seed) {
  const sr = ctx.sampleRate;
  const len = Math.round(seconds * sr);
  const chans = [];
  for (let c = 0; c < channels; c++) {
    const rand = mulberry32(seed * 7919 + c * 104729 + 17);
    const d = new Float32Array(len);
    if (kind === 'white') {
      for (let i = 0; i < len; i++) d[i] = rand() * 2 - 1;
    } else if (kind === 'pink') {
      // Paul Kellet's refined pink filter
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < len; i++) {
        const w = rand() * 2 - 1;
        b0 = 0.99886 * b0 + w * 0.0555179;
        b1 = 0.99332 * b1 + w * 0.0750759;
        b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856;
        b4 = 0.55 * b4 + w * 0.5329522;
        b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
        b6 = w * 0.115926;
      }
    } else {
      // brown: leaky integrated white noise
      let y = 0;
      for (let i = 0; i < len; i++) {
        y = 0.996 * y + (rand() * 2 - 1) * 0.06;
        d[i] = y;
      }
    }
    // remove DC and normalise to unit RMS
    let mean = 0;
    for (let i = 0; i < len; i++) mean += d[i];
    mean /= len;
    let ss = 0;
    for (let i = 0; i < len; i++) {
      d[i] -= mean;
      ss += d[i] * d[i];
    }
    const g = 1 / Math.sqrt(ss / len + TINY);
    for (let i = 0; i < len; i++) d[i] *= g * 0.5;
    chans.push(makeLoopable(d, sr));
  }
  const out = ctx.createBuffer(channels, chans[0].length, sr);
  chans.forEach((d, c) => out.copyToChannel(d, c));
  return out;
}

// Smooth random control signal in [-1, 1] (white noise through a 4-pole low-pass at `hz`), looping without a
// seam. Used for non-periodic pitch drift (pads) and vocal jitter (choir): unlike a sine LFO it never repeats
// within a note, so detuned voices do not beat at a fixed rate. Stored at 8 kHz; WebAudio resamples it.
export function controlNoise(ctx, seconds, hz, seed) {
  const sr = 8000;
  const n = Math.round(seconds * sr);
  const rand = mulberry32(seed * 104729 + 7);
  const d = new Float32Array(n + Math.round(4 * sr / hz));
  const a = 1 - Math.exp((-2 * Math.PI * hz) / sr);
  let y1 = 0, y2 = 0, y3 = 0, y4 = 0;
  for (let i = 0; i < d.length; i++) {
    y1 += a * (gaussian(rand) - y1);
    y2 += a * (y1 - y2);
    y3 += a * (y2 - y3);
    y4 += a * (y3 - y4);
    d[i] = y4;
  }
  // drop the filter's warm-up, crossfade the end into the start
  let x = d.subarray(d.length - n);
  const f = Math.round(Math.min(n / 4, (2 * sr) / hz));
  for (let i = 0; i < f; i++) {
    const w = i / f;
    x[i] = x[i] * Math.sqrt(w) + x[n - f + i] * Math.sqrt(1 - w);
  }
  x = x.subarray(0, n - f);
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;
  let pk = 0;
  for (let i = 0; i < x.length; i++) pk = Math.max(pk, Math.abs(x[i] - mean));
  const out = ctx.createBuffer(1, x.length, sr);
  const o = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) o[i] = (x[i] - mean) / (pk + TINY);
  out.copyToChannel(o, 0);
  return out;
}

// A dark, lush concert-hall-meets-cathedral impulse response, ~6.5 s, stereo.
// Late tail: white noise split into five bands (telescoping one-pole filters, so the bands sum back to the
// original) each with its own decay (low 7.2 s ... air 1.3 s), a smooth diffusion build-up, and a handful of
// early reflections. Energy-normalised so the wet send level is predictable.
// Each ear is the same tail through its own cascade of Schroeder all-passes: the same magnitude response at every
// frequency, different phases. Two independent noise tails would each have a Rayleigh-random response at any
// single frequency, so a held pitch came out 2-3 dB louder in one ear than the other (white noise through them
// balanced to 0.05 dB, a 330 Hz sine to -3.3 dB); with all-pass ears no held pitch can lean, and the hall is
// still wide (L/R correlation ~0.1-0.3 by band).
export function makeImpulse(ctx, seconds = 6.6, seed = 4242) {
  const sr = ctx.sampleRate;
  const len = Math.round(seconds * sr);
  const out = ctx.createBuffer(2, len, sr);
  const cuts = [180, 700, 2600, 7200]; // band edges (Hz)
  const t60 = [7.2, 6.3, 5.0, 3.1, 1.3]; // per band
  const ears = [];
  for (let ch = 0; ch < 1; ch++) {
    const rand = mulberry32(seed + ch * 7777);
    const d = new Float32Array(len);
    const lp = cuts.map(() => 0);
    const coef = cuts.map((f) => 1 - Math.exp((-2 * Math.PI * f) / sr));
    const k = t60.map((T) => -6.907755 / (T * sr)); // ln(1e-3)
    const env = t60.map(() => 1);
    const step = k.map((kk) => Math.exp(kk));
    for (let i = 0; i < len; i++) {
      const x = gaussian(rand);
      // telescoping band split: b0 = lp0, b1 = lp1 - lp0, ..., b4 = x - lp3
      let prev = 0,
        y = 0;
      for (let b = 0; b < cuts.length; b++) {
        lp[b] += coef[b] * (x - lp[b]);
        y += (lp[b] - prev) * env[b];
        prev = lp[b];
        env[b] *= step[b];
      }
      y += (x - prev) * env[cuts.length];
      env[cuts.length] *= step[cuts.length];
      const t = i / sr;
      const build = 1 - Math.exp(-t / 0.055); // diffusion build-up, no hard onset
      const fadeEnd = i > len - sr * 0.3 ? (len - i) / (sr * 0.3) : 1;
      d[i] = y * build * fadeEnd;
    }
    // early reflections: sparse, slightly low-passed taps
    const er = mulberry32(seed * 3 + ch * 31);
    for (let r = 0; r < 14; r++) {
      const t = 0.008 + er() * 0.085;
      const g = (0.55 - r * 0.03) * (er() < 0.5 ? -1 : 1) * Math.exp(-t / 0.08);
      const i0 = Math.round(t * sr);
      for (let j = 0; j < 24 && i0 + j < len; j++) d[i0 + j] += (g * Math.exp(-j / 5)) / 3;
    }
    ears.push(d);
  }
  // the two ears: one tail through two different cascades of Schroeder all-passes (|H| = 1 at every frequency),
  // so both have the tail's magnitude response exactly, different phases, and the same onset smear
  const allpass = (src, set) => {
    let x = src;
    for (const [ms, g] of set) {
      const D = Math.round((ms / 1000) * sr);
      const y = new Float32Array(len);
      for (let i = 0; i < len; i++) y[i] = -g * x[i] + (i >= D ? x[i - D] + g * y[i - D] : 0);
      x = y;
    }
    return x;
  };
  const tail = ears.pop();
  ears.push(allpass(tail, [[3.1, 0.6], [7.9, -0.55], [12.3, 0.55], [18.1, -0.5]]), allpass(tail, [[4.7, -0.6], [8.3, 0.58], [13.7, -0.52], [19.7, 0.55]]));
  ears.forEach((d, ch) => {
    let ss = 0;
    for (let i = 0; i < len; i++) ss += d[i] * d[i];
    const g = 1 / Math.sqrt(ss + TINY);
    for (let i = 0; i < len; i++) {
      const v = d[i] * g;
      d[i] = Math.abs(v) < TINY ? 0 : v;
    }
    out.copyToChannel(d, ch);
  });
  return out;
}

// Felt piano note, additive with real piano physics:
//  - stiff-string inharmonicity  f_n = n f0 sqrt(1 + B n^2)
//  - felt hammer: soft attack (5-8 ms raised cosine) and a steep spectral roll-off
//  - two detuned strings per partial with different damping: the classic piano double decay (prompt sound +
//    aftersound) and slow beating come out of the coupled pair, as they do in a real instrument
//  - higher partials die faster; a little low "felt thump" of filtered noise at the attack
//  - the soundboard: the hammer's knock rings a bank of 14 wooden body modes (90-600 Hz, 25-90 ms) under the
//    string sound, so a note has a body and not only partials
//  - `seed` is a round-robin: another seed is another piano (string detunes, phases, the knock's modes)
// The buffer is the hard-hammer (brightest) note; the instrument darkens it for softer notes with a low-pass that
// follows velocity (a felt hammer's spectrum narrows when it is played softly) and damps it at the key release.
// Computed with complex-rotation oscillators (no Math.sin in the loop), so a 6 s note costs ~10 ms.
export function pianoNote(ctx, m, seed = 1) {
  // synthesised at 24 kHz (WebAudio resamples on playback): partials stop near 7 kHz and the piano bus is
  // low-passed at 5.2 kHz, so nothing is lost and the note costs half as much to build
  const sr = 24000;
  const f0 = mtof(m);
  const ringT = Math.min(7, Math.max(3.2, 9 * Math.pow(261.6 / f0, 0.45))); // low notes ring longer
  const len = Math.round(ringT * sr);
  const d = new Float32Array(len);
  const B = 0.00018 * Math.pow(f0 / 261.6, 0.9);
  const nPart = Math.max(4, Math.min(14, Math.floor(7000 / f0)));
  const rand = mulberry32(seed * 977 + m * 131);
  for (let n = 1; n <= nPart; n++) {
    const fn = n * f0 * Math.sqrt(1 + B * n * n);
    if (fn > sr * 0.45) break;
    // felt hammer spectrum: soft, with a gentle hump around the 2nd-3rd partial
    const amp = (1 / Math.pow(n, 1.05)) * Math.exp(-n / 5.5) * (n === 2 ? 1.15 : 1);
    const tau1 = (ringT / 6.9) * 0.55 / (1 + 0.32 * (n - 1)); // prompt
    const tau2 = (ringT / 6.9) * 1.9 / (1 + 0.22 * (n - 1)); // aftersound
    for (let s = 0; s < 2; s++) {
      const cents = (s ? 1 : -1) * (0.6 + 0.5 * rand());
      const f = fn * Math.pow(2, cents / 1200);
      const w = (2 * Math.PI * f) / sr;
      const tau = s ? tau2 : tau1;
      const g = s ? 0.32 : 0.68;
      const r = Math.exp(-1 / (tau * sr));
      const c = Math.cos(w) * r,
        si = Math.sin(w) * r;
      const ph = rand() * 2 * Math.PI;
      let re = Math.cos(ph) * amp * g,
        im = Math.sin(ph) * amp * g;
      for (let i = 0; i < len; i++) {
        d[i] += im;
        const nre = re * c - im * si;
        im = re * si + im * c;
        re = nre;
        if ((i & 4095) === 0 && Math.abs(re) + Math.abs(im) < 1e-7) break;
      }
    }
  }
  // hammer attack and felt thump
  const atk = Math.round((0.0045 + 0.003 * Math.min(1, 261.6 / f0)) * sr);
  for (let i = 0; i < atk && i < len; i++) d[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / atk);
  let lp = 0;
  const thumpLen = Math.round(0.05 * sr);
  const a = 1 - Math.exp((-2 * Math.PI * 320) / sr);
  for (let i = 0; i < thumpLen && i < len; i++) {
    lp += a * (rand() * 2 - 1 - lp);
    d[i] += lp * 0.09 * Math.exp(-i / (0.012 * sr)) * Math.min(1, i / (0.002 * sr));
  }
  // the soundboard knock: wooden body modes excited by the hammer, fixed for the instrument (seed 1) with a little
  // per-seed variation, so every note of the piano shares one body
  const body = mulberry32(4049 + (seed - 1) * 7);
  for (let k = 0; k < 14; k++) {
    const fm = 90 * Math.pow(600 / 90, (k + 0.5 * body()) / 14);
    const tau = 0.025 + 0.065 * body();
    const w = (2 * Math.PI * fm) / sr,
      r = Math.exp(-1 / (tau * sr));
    const c = Math.cos(w) * r,
      si = Math.sin(w) * r;
    let re = 0,
      im = 0.007 * (0.6 + 0.8 * body()) * Math.pow(261.6 / Math.max(110, f0), 0.3);
    const n = Math.min(len, Math.round(tau * 9 * sr));
    for (let i = 0; i < n; i++) {
      d[i] += im * Math.min(1, i / (0.0015 * sr));
      const nre = re * c - im * si;
      im = re * si + im * c;
      re = nre;
    }
  }
  // normalise to a consistent loudness across the keyboard (slight low-end emphasis like a real piano)
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]));
  const norm = (0.5 / (peak + TINY)) * Math.pow(261.6 / f0, 0.12);
  const fadeN = Math.round(0.25 * sr);
  for (let i = 0; i < len; i++) {
    let v = d[i] * norm;
    if (i > len - fadeN) v *= (len - i) / fadeN;
    d[i] = Math.abs(v) < TINY ? 0 : v;
  }
  const buf = ctx.createBuffer(1, len, sr);
  buf.copyToChannel(d, 0);
  return buf;
}

// Oscillator wavetables.
export function makeWaves(ctx) {
  const mk = (n, fn) => {
    const re = new Float32Array(n + 1),
      im = new Float32Array(n + 1);
    for (let k = 1; k <= n; k++) im[k] = fn(k);
    return ctx.createPeriodicWave(re, im, { disableNormalization: false });
  };
  return {
    // softened saw: string-section warmth
    warm: mk(48, (k) => (1 / k) * Math.exp(-k / 14)),
    // nearly sine with a breath of 2nd/3rd: celesta-pad
    soft: mk(8, (k) => (k === 1 ? 1 : k === 2 ? 0.18 : k === 3 ? 0.08 : 0.02 / k)),
    // odd harmonics falling 1/k^1.6: hollow, clarinet-cold
    hollow: mk(31, (k) => (k % 2 ? 1 / Math.pow(k, 1.6) : 0.02 / k)),
    // glottal-like source for the choir: saw with a gentle -3 dB/oct extra tilt
    voice: mk(64, (k) => 1 / Math.pow(k, 1.25)),
    // brass: rich and bright, all harmonics, slightly flattened top
    brass: mk(48, (k) => 1 / Math.pow(k, 0.95)),
  };
}
