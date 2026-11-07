// True-peak-safe lookahead limiter, as an AudioWorklet loaded from a Blob URL (works in the single-file build).
//
// Detection: 4x oversampled peak estimate (polyphase windowed-sinc interpolation at 1/4, 1/2, 3/4 between
// samples) so inter-sample peaks are caught, not just sample peaks.
// Gain computer (sample-accurate, no overshoot by construction):
//   target[k] = min(1, ceiling / truePeak[k])
//   h = running minimum of target over the last W samples (monotonic deque)
//   r = h when falling, one-pole release toward h when rising (so r <= h always)
//   g = moving average of r over W samples (smooth attack that has fully arrived when the peak does)
//   y[n] = x[n - D] * g[n],  D = W + LAG - 1 (the detector judges sample n-LAG; deque/box windows span W)
// Because every r in the averaging window is <= the target of the sample being output, g never exceeds it.
// A final sample clamp at the ceiling is a belt-and-braces guard against float rounding.

const WORKLET_SRC = `
const TAPS = 16; // 16-tap polyphase interpolator: inter-sample peaks to within ~0.1 dB
const LAG = TAPS / 2; // the detector judges sample n - LAG
function sinc(x) { return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); }
class FourLightHoursLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = (options && options.processorOptions) || {};
    this.ceil = Math.pow(10, (o.ceilingDb !== undefined ? o.ceilingDb : -1.3) / 20);
    this.W = Math.max(32, Math.round((o.lookahead || 0.005) * sampleRate));
    this.D = this.W + LAG - 1;
    this.rel = Math.exp(-1 / ((o.release || 0.14) * sampleRate));
    // interpolation phases 0.25, 0.5, 0.75 between x[j] and x[j+1], taps over x[j-LAG+1 .. j+LAG]
    this.coef = [0.25, 0.5, 0.75].map((p) => {
      const c = new Float64Array(TAPS);
      let s = 0;
      for (let t = 0; t < TAPS; t++) {
        const x = t - (LAG - 1) - p; // distance from tap (j-LAG+1+t) to the interpolation point j+p
        const w = 0.5 + 0.5 * Math.cos((Math.PI * x) / (LAG + 0.5)); // Hann window over +-(LAG+0.5) samples
        c[t] = sinc(x) * w;
        s += c[t];
      }
      for (let t = 0; t < TAPS; t++) c[t] /= s;
      return c;
    });
    this.hist = [new Float64Array(2 * TAPS), new Float64Array(2 * TAPS)];
    this.hp = 0;
    this.dl = [new Float32Array(this.D + 1), new Float32Array(this.D + 1)];
    this.dp = 0;
    this.prevSeg = 0;
    // min-hold deque (values, indices) of size W+1
    this.qv = new Float64Array(this.W + 2);
    this.qi = new Float64Array(this.W + 2);
    this.qh = 0; this.qt = 0; this.qn = 0; this.n = 0;
    this.r = 1;
    this.box = new Float64Array(this.W);
    this.bp = 0;
    this.bsum = this.W; // filled with 1s
    for (let i = 0; i < this.W; i++) this.box[i] = 1;
    this.minG = 1;
    this.port.onmessage = (e) => { if (e.data === 'stats') { this.port.postMessage({ minGain: this.minG }); this.minG = 1; } };
  }
  pushMin(v, idx) {
    const cap = this.W + 2;
    while (this.qn > 0) {
      const last = (this.qt - 1 + cap) % cap;
      if (this.qv[last] >= v) { this.qt = last; this.qn--; } else break;
    }
    this.qv[this.qt] = v; this.qi[this.qt] = idx; this.qt = (this.qt + 1) % cap; this.qn++;
    while (this.qn > 0 && this.qi[this.qh] <= idx - this.W) { this.qh = (this.qh + 1) % cap; this.qn--; }
    return this.qv[this.qh];
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!out || !out.length) return true;
    const N = out[0].length;
    const nc = Math.min(2, out.length);
    const inL = inp && inp[0] ? inp[0] : null;
    const inR = inp && inp[1] ? inp[1] : inL;
    const ceil = this.ceil, W = this.W, D = this.D;
    for (let i = 0; i < N; i++) {
      const xl = inL ? inL[i] : 0, xr = inR ? inR[i] : 0;
      // history ring for interpolation
      const hl = this.hist[0], hr = this.hist[1];
      hl[this.hp] = xl; hl[this.hp + TAPS] = xl;
      hr[this.hp] = xr; hr[this.hp + TAPS] = xr;
      this.hp = this.hp + 1 === TAPS ? 0 : this.hp + 1;
      const o = this.hp; // h[o + t] = x[n - TAPS + 1 + t]
      // segment peak between x[j] and x[j+1] where j = n-LAG (the taps are the TAPS newest samples)
      let seg = 0;
      for (let ch = 0; ch < 2; ch++) {
        const h = ch ? hr : hl;
        const a = Math.abs(h[o + LAG - 1]), b = Math.abs(h[o + LAG]);
        if (a > seg) seg = a; if (b > seg) seg = b;
        for (let p = 0; p < 3; p++) {
          const c = this.coef[p];
          let s = 0;
          for (let t = 0; t < TAPS; t++) s += c[t] * h[o + t];
          s = Math.abs(s);
          if (s > seg) seg = s;
        }
      }
      const pk = Math.max(seg, this.prevSeg);
      this.prevSeg = seg;
      const target = pk > ceil ? ceil / pk : 1;
      const h = this.pushMin(target, this.n++);
      if (h < this.r) this.r = h; else this.r = h + (this.r - h) * this.rel;
      this.bsum += this.r - this.box[this.bp];
      this.box[this.bp] = this.r;
      this.bp = (this.bp + 1) % W;
      if ((this.n & 8191) === 0) { let s = 0; for (let k = 0; k < W; k++) s += this.box[k]; this.bsum = s; }
      const g = Math.min(1, this.bsum / W);
      if (g < this.minG) this.minG = g;
      // delay line
      const dl = this.dl[0], dr = this.dl[1];
      dl[this.dp] = xl; dr[this.dp] = xr;
      const rp = (this.dp + 1) % (D + 1); // oldest sample = D samples ago
      let yl = dl[rp] * g, yr = dr[rp] * g;
      this.dp = rp;
      if (yl > ceil) yl = ceil; else if (yl < -ceil) yl = -ceil;
      if (yr > ceil) yr = ceil; else if (yr < -ceil) yr = -ceil;
      out[0][i] = yl;
      if (nc > 1) out[1][i] = yr;
    }
    return true;
  }
}
registerProcessor('four-light-hours-limiter', FourLightHoursLimiter);
`;

const loaded = new WeakMap();

// Returns { input, output, node, kind } wired as a limiter. Falls back to a DynamicsCompressor + soft clipper
// if AudioWorklet is unavailable.
export async function createLimiter(ctx, { ceilingDb = -1.5, lookahead = 0.005, release = 0.14 } = {}) {
  try {
    if (!ctx.audioWorklet) throw new Error('no AudioWorklet');
    if (!loaded.get(ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      loaded.set(ctx, true);
    }
    const node = new AudioWorkletNode(ctx, 'four-light-hours-limiter', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { ceilingDb, lookahead, release },
    });
    return { input: node, output: node, node, kind: 'worklet', latency: (Math.max(32, Math.round(lookahead * ctx.sampleRate)) + 7) / ctx.sampleRate };
  } catch (e) {
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = ceilingDb - 2;
    comp.knee.value = 0;
    comp.ratio.value = 20;
    comp.attack.value = 0.001;
    comp.release.value = release;
    const shaper = ctx.createWaveShaper();
    const ceil = Math.pow(10, (ceilingDb - 0.3) / 20);
    const n = 4096,
      curve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      const ax = Math.abs(x),
        k = 0.75 * ceil;
      curve[i] = Math.sign(x) * (ax < k ? ax : k + (ceil - k) * Math.tanh((ax - k) / (ceil - k)));
    }
    shaper.curve = curve;
    shaper.oversample = '4x';
    comp.connect(shaper);
    return { input: comp, output: shaper, node: null, kind: 'compressor', latency: 0.006 };
  }
}
