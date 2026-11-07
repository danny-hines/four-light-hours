// Audio engine: the master chain, "generations" (one complete set of per-section buses + automation lanes,
// created at every start / seek / resume and crossfaded), the event scheduler, voice limits and cleanup.
// Works identically on an AudioContext (live) and an OfflineAudioContext (tools/render.mjs).
//
// Signal flow (per generation)
//   pad voices   -> high-pass (world) -> low-pass (lane) -> motif carve (peaking cut) -> motif duck -> chorus
//   choir voices -> one of three formant "sections" (offset vocal tracts) -> motif carve -> motif duck
//   solo voice   -> its own brighter formant path + presence lift, 18 ms pre-delay into the hall (never ducked)
//   brass        -> motif duck;  horn lead -> presence lift + pre-delay (never ducked)
//   piano        -> felt low-pass (lane), pre-delayed hall send
//   everything   -> dry & reverb sends -> world tilt (low/high shelves) -> warp duck -> level (world arc)
//                -> generation crossfade gain -> transport (pause fades dry+send, so reverb tails ring out)
// Master
//   dry + [pre-delay -> 6.6 s stereo convolution hall -> HPF/LPF] -> DC block -> M/S width
//          -> glue compressor -> makeup -> true-peak limiter (-1.5 dBTP) -> mute -> destination
import { INSTRUMENTS, kRate } from './instruments.js';
import { noiseBuffer, makeImpulse, pianoNote, makeWaves, controlNoise } from './dsp.js';
import { createLimiter } from './limiter.js';
import { LANE_HZ } from './composer.js';

// Voice limits per category, shared by all live generations, counted over voices that actually overlap the new
// note's start (so scheduling far ahead does not eat the budget). Short, dense categories drop new notes when
// full; sustained ones steal (fade out) their oldest overlapping voice at the new note's start.
const MAX = { pad: 26, choir: 18, sub: 6, bell: 14, glass: 12, piano: 22, grain: 36, pluck: 10, brass: 14, chirp: 8, drone: 8, sfx: 12, bow: 14 };
// all categories together, all generations together (a scrub can otherwise stack up retired voices)
const MAX_TOTAL = 150;
const DROP_WHEN_FULL = new Set(['grain', 'chirp', 'glass', 'bell', 'pluck']);
// Event types that are resumed mid-note after a seek (everything else only plays from its onset).
const CATCHUP = new Set(['pad', 'choir', 'sub', 'brass', 'pmodes', 'tone', 'riser', 'piano', 'bell', 'glass', 'bow']);
// [dry, reverb send] per category
const SENDS = { pad: [0.8, 0.55], choir: [0.62, 0.95], leadVox: [0.92, 0.72], piano: [0.85, 0.42], bell: [0.55, 0.9], glass: [0.42, 1.0], sub: [1, 0], brass: [0.85, 0.55], leadBrass: [0.95, 0.5], bow: [0.85, 0.62], pluck: [0.8, 0.28], grain: [0.62, 0.7], chirp: [0.3, 1.0], drone: [0.8, 0.5], bed: [0.85, 0.35] };
// lead instruments reach the hall 18 ms after their dry sound (plus the hall's own 28 ms), so they read in front
const LEAD_PREDELAY = 0.018;
// the three choir "sections": vocal-tract offsets of F1/F2/F3, so voices do not share identical formants
const SECTIONS = [
  [0.955, 0.97, 0.985],
  [1, 1, 1],
  [1.045, 1.035, 1.02],
];

const LANE_CHUNK = 12; // seconds of automation scheduled per chunk
// Web Audio's lowpass/highpass `Q` is a resonance in dB (not a linear Q): a linear Q as the value it expects
export const QDB = (q) => 20 * Math.log10(q);

export const MASTER = { makeupDb: 0, width: 1.05, monoBelowHz: 150, ceilingDb: -1.5 };
// the music follower's scale: its output is ~1.0 for music at the level the riser was designed against
export const FOLLOW_GAIN = 18;
const ABS_CURVE = (() => {
  const n = 4097,
    c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = Math.abs((i / (n - 1)) * 2 - 1);
  return c;
})();
// equal-power crossfade curves between generations (a seek, a resync): the old and the new generation play the
// same notes with unrelated phases, so their powers add
const XF_N = 64;
const XFADE_IN = Float32Array.from({ length: XF_N }, (_, i) => Math.sin((Math.PI / 2) * (i / (XF_N - 1))));
const XFADE_OUT = Float32Array.from({ length: XF_N }, (_, i) => Math.cos((Math.PI / 2) * (i / (XF_N - 1))));

function lowerBound(ev, t) {
  let a = 0,
    b = ev.length;
  while (a < b) {
    const m = (a + b) >> 1;
    if (ev[m].t < t) a = m + 1;
    else b = m;
  }
  return a;
}
function softClipCurve(drive = 1.6) {
  const n = 2048,
    c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(drive * x) / Math.tanh(drive);
  }
  return c;
}
function holdAndRamp(param, now, target, tau) {
  if (param.cancelAndHoldAtTime) param.cancelAndHoldAtTime(now);
  else {
    const v = param.value;
    param.cancelScheduledValues(now);
    param.setValueAtTime(v, now);
  }
  param.setTargetAtTime(target, now, tau);
}

export class Engine {
  constructor(ctx, plan, { realtime = false, makeupDb = MASTER.makeupDb, lite = false } = {}) {
    this.lite = lite; // q=low: shorter hall, 70% voice limits
    this.ctx = ctx;
    this.plan = plan;
    this.realtime = realtime;
    this.makeupDb = makeupDb;
    this.voices = [];
    this.byCat = {}; // the same voices, per category (voice limits look only at their own category)
    this.gens = [];
    this.counts = {};
    this.anchorT = 0;
    this.anchorCtx = 0;
    this.piano = new Map();
    this.stats = { created: 0, dropped: 0, stolen: 0, peakVoices: 0, peakByCat: {}, generations: 0, errors: 0 };
    // formant lanes for each choir section (scaled copies of the vowel lanes)
    const L = plan.lanes;
    const scale = (arr, k) => (k === 1 ? arr : arr.map((v) => v * k));
    this.sectionLanes = SECTIONS.map(([a, b, c]) => [scale(L.f1, a), scale(L.f2, b), scale(L.f3, c)]);
  }

  async init() {
    const ctx = this.ctx;
    this.waves = makeWaves(ctx);
    this.buf = {
      white: noiseBuffer(ctx, 'white', 3, 1, 11),
      pink: noiseBuffer(ctx, 'pink', 8, 2, 23),
      brown: noiseBuffer(ctx, 'brown', 8, 2, 37),
    };
    // smooth random control signals: slow pitch drift for pads, ~4 Hz vocal jitter for the choir
    this.ctl = { drift: controlNoise(ctx, 41, 0.18, 5), jitter: controlNoise(ctx, 13, 4.5, 9) };
    const G = (v) => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const F = (type, f, q) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      if (q !== undefined) n.Q.value = q;
      return n;
    };
    this.tDry = G(1);
    this.tWet = G(1);
    const sum = G(1);
    this.tDry.connect(sum);
    // reverb: fed in mono (the mid of the send), a stereo hall out (the IR's two ears are partly correlated)
    const send = ctx.createGain();
    send.channelCount = 1;
    send.channelCountMode = 'explicit';
    send.channelInterpretation = 'speakers';
    const pre = ctx.createDelay(0.2);
    pre.delayTime.value = 0.03;
    // a slowly modulated pre-delay (+-3 ms at 0.11 Hz, <4 cents of pitch movement on the wet only): a held pitch
    // interferes with the hall's steady-state response differently in each ear (|1+H_L| vs |1+H_R| at that
    // frequency), which left sparse, held passages leaning ~1 dB to one side; moving the wet's phase averages it out
    const preMod = ctx.createOscillator();
    preMod.frequency.value = 0.11;
    const preDepth = G(0.003);
    preMod.connect(preDepth).connect(pre.delayTime);
    preMod.start();
    this.preMod = preMod;
    const conv = ctx.createConvolver();
    conv.normalize = false;
    conv.buffer = makeImpulse(ctx, this.lite ? 5.2 : 6.6);
    // 4th-order Butterworth high-pass at 200 Hz: the hall never muddies (or decorrelates) the low end
    // (Web Audio's lowpass/highpass Q is a resonance in dB: Butterworth sections are QDB(0.541), QDB(1.307))
    const wetHP1 = F('highpass', 220, QDB(0.541)),
      wetHP2 = F('highpass', 220, QDB(1.307)),
      wetLP = F('lowpass', 9500, 0.5);
    this.tWet.connect(send).connect(pre).connect(conv).connect(wetHP1).connect(wetHP2).connect(wetLP).connect(sum);
    // DC / subsonic block
    const dc = F('highpass', 18, 0.6);
    sum.connect(dc);
    // Mono below ~150 Hz, a touch of width above: a Linkwitz-Riley (LR4) crossover. The low band is the mid
    // signal (L+R)/2 through LP4; the high band is L and R each through HP4, widened by M/S gains. LP4 + HP4 sums
    // to an all-pass, so mono content is untouched, and the side keeps the same phase as the mid at every
    // frequency. (High-passing only the side channel shifts its phase against the mid near the corner, which
    // flips the image of low-mid voices: a right-panned E3 came out on the left.)
    const w = MASTER.width,
      fx = MASTER.monoBelowHz;
    const split = ctx.createChannelSplitter(2),
      merge = ctx.createChannelMerger(2);
    dc.connect(split);
    const mid = G(1);
    split.connect(G(0.5), 0).connect(mid);
    split.connect(G(0.5), 1).connect(mid);
    const BW = QDB(Math.SQRT1_2); // Butterworth (-3.01 dB): two of them in series make each LR4 branch
    const low = mid.connect(F('lowpass', fx, BW)).connect(F('lowpass', fx, BW));
    low.connect(merge, 0, 0);
    low.connect(merge, 0, 1);
    const hiL = G(1),
      hiR = G(1);
    split.connect(hiL, 0);
    split.connect(hiR, 1);
    const Lh = hiL.connect(F('highpass', fx, BW)).connect(F('highpass', fx, BW));
    const Rh = hiR.connect(F('highpass', fx, BW)).connect(F('highpass', fx, BW));
    // L' = a L + b R, R' = a R + b L with a = (1+w)/2, b = (1-w)/2 (M/S width on the high band)
    Lh.connect(G((1 + w) / 2)).connect(merge, 0, 0);
    Rh.connect(G((1 - w) / 2)).connect(merge, 0, 0);
    Rh.connect(G((1 + w) / 2)).connect(merge, 0, 1);
    Lh.connect(G((1 - w) / 2)).connect(merge, 0, 1);
    // glue compression
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.knee.value = 9;
    comp.ratio.value = 2;
    comp.attack.value = 0.04;
    comp.release.value = 0.35;
    merge.connect(comp);
    const makeup = G(Math.pow(10, this.makeupDb / 20));
    comp.connect(makeup);
    this.limiter = await createLimiter(ctx, { ceilingDb: MASTER.ceilingDb, lookahead: 0.005, release: 0.14 });
    makeup.connect(this.limiter.input);
    this.mute = G(1);
    this.limiter.output.connect(this.mute).connect(ctx.destination);
    this.master = { sum, comp, makeup };
    this.ready = true;
  }

  // one buffer per pitch and round-robin seed (melody notes alternate between two strings sets, so a repeated
  // pitch is never bit-identical; accompaniment notes use one)
  pianoBuffer(m, rr = 0) {
    const key = m * 2 + rr;
    let b = this.piano.get(key);
    if (!b) {
      b = pianoNote(this.ctx, m, 1 + rr);
      this.piano.set(key, b);
    }
    return b;
  }
  // live: synthesise the piano notes the score will need in idle slices, so no note is built mid-frame
  prewarm() {
    const need = [...new Set(this.plan.events.filter((e) => e.type === 'piano').map((e) => Math.round(e.midi) * 2 + (e.rr || 0)))]; // events are time-sorted: first use first
    const idle = typeof requestIdleCallback === 'function' ? (f) => requestIdleCallback(f, { timeout: 400 }) : (f) => setTimeout(f, 30);
    const step = () => {
      const m = need.shift();
      if (m === undefined) return;
      this.pianoBuffer(m >> 1, m & 1);
      idle(step);
    };
    idle(step);
  }

  anchor(t, ctxTime) {
    this.anchorT = t;
    this.anchorCtx = ctxTime;
  }
  toCtx(T) {
    return this.anchorCtx + (T - this.anchorT);
  }
  journeyAt(ctxTime) {
    return this.anchorT + (ctxTime - this.anchorCtx);
  }

  // ------------------------------------------------------------------------------------- generations
  newGeneration(tStart, when, fadeIn = 0.5) {
    const ctx = this.ctx;
    const g = { t0: tStart, when, next: 0, nodes: [], srcs: [], bus: {}, dead: false, deadAt: Infinity, id: ++this.stats.generations };
    const G = (v) => {
      const n = ctx.createGain();
      n.gain.value = v;
      g.nodes.push(n);
      return n;
    };
    const F = (type, f, q, gainDb) => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      if (q !== undefined) n.Q.value = q;
      if (gainDb !== undefined) n.gain.value = gainDb;
      // the generation's filters follow 20 Hz lanes: coefficients once per render quantum, not per sample
      kRate(n.frequency);
      kRate(n.Q);
      kRate(n.gain);
      g.nodes.push(n);
      return n;
    };
    const D = (t) => {
      const n = ctx.createDelay(Math.max(0.1, t * 2));
      n.delayTime.value = t;
      g.nodes.push(n);
      return n;
    };
    const loop = (buf, offset, rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      s.playbackRate.value = rate;
      s.start(when, offset % buf.duration);
      g.srcs.push(s);
      return s;
    };
    g.outDry = G(0);
    g.outWet = G(0);
    g.outDry.connect(this.tDry);
    g.outWet.connect(this.tWet);
    for (const o of [g.outDry, g.outWet]) {
      o.gain.setValueAtTime(0, when);
      // equal-power fade-in (the retiring generation fades out on the complementary curve at the same instant)
      if (fadeIn > 0.01) o.gain.setValueCurveAtTime(XFADE_IN, when, fadeIn);
      else o.gain.setValueAtTime(1, when);
    }
    // music sums -> world tilt (shelves) -> world level -> warp duck
    const mDry = G(1),
      mWet = G(1);
    const loD = F('lowshelf', 180, undefined, 0),
      hiD = F('highshelf', 4000, undefined, 0),
      loW = F('lowshelf', 180, undefined, 0),
      hiW = F('highshelf', 4000, undefined, 0);
    const duckD = G(1),
      duckW = G(1),
      lvlD = G(1),
      lvlW = G(1),
      wetL = G(1);
    mDry.connect(loD).connect(hiD).connect(lvlD).connect(duckD).connect(g.outDry);
    mWet.connect(loW).connect(hiW).connect(lvlW).connect(duckW).connect(wetL).connect(g.outWet);
    // The music follower: a K-weighted (BS.1770 pre-filter) average-rectified level of the music after the
    // world's level and before the warp duck, smoothed over ~2 s (a leg of 3-6 s rides on the level the music had as it began). It drives the warp riser's gain, so a leg is
    // always calibrated against the music it leaves, measured, whatever the cut, the world's filtering or the
    // melody that happens to ride into the leg (no per-world trims). Pure DSP, so live and offline agree.
    {
      const fin = G(1);
      lvlD.connect(fin);
      lvlW.connect(G(0.6)).connect(fin); // the hall send counts, a little less than the dry sound
      const kS = F('highshelf', 1500, undefined, 4),
        kH = F('highpass', 60, QDB(0.5));
      const rect = ctx.createWaveShaper();
      rect.curve = ABS_CURVE;
      g.nodes.push(rect);
      // two one-pole smoothers (tau 0.9 s each) as IIR filters: a biquad this far below the sample rate loses
      // its precision and collapses, the IIR filter runs in double precision
      const pole = Math.exp(-1 / (0.9 * ctx.sampleRate));
      const sm = () => {
        const n = ctx.createIIRFilter([1 - pole], [1, -pole]);
        g.nodes.push(n);
        return n;
      };
      const s1 = sm(),
        s2 = sm();
      fin.connect(kS).connect(kH).connect(G(0.5)).connect(rect).connect(s1).connect(s2);
      g.follow = s2.connect(G(FOLLOW_GAIN));
    }
    // sfx are not ducked, tilted or levelled by the world arc
    const sfx = G(1),
      sfxDry = G(1);
    sfx.connect(G(0.85)).connect(g.outDry);
    sfx.connect(G(0.5)).connect(g.outWet);
    sfxDry.connect(g.outDry);
    g.bus.sfx = sfx;
    g.bus.sfxDry = sfxDry;
    const cat = (name, input, output, preDelay = 0) => {
      const [d, w] = SENDS[name];
      if (d) output.connect(G(d)).connect(mDry);
      if (w) {
        const s = output.connect(G(w));
        (preDelay ? s.connect(D(preDelay)) : s).connect(mWet);
      }
      g.bus[name] = input;
    };
    // motif duck lane (one gain per ducked bus) and carve (peaking cut) lanes
    const L = this.plan.lanes;
    const lanes = [];
    const motifed = (input, carve = true) => {
      let x = input;
      if (carve) {
        const pk = F('peaking', 700, 0.9, 0);
        lanes.push([pk.frequency, L.carveF], [pk.gain, L.carveG]);
        x = x.connect(pk);
      }
      const dk = G(1);
      lanes.push([dk.gain, L.mduck]);
      return x.connect(dk);
    };
    // pad: high-pass (thin worlds), slowly modulated resonant low-pass, motif carve + duck, stereo chorus
    const padIn = G(1),
      padHP = F('highpass', 25, 0.6),
      padLP = F('lowpass', 1500, 0.8);
    padIn.connect(padHP).connect(padLP);
    const padM = motifed(padLP);
    const padOut = G(1);
    padM.connect(G(0.82)).connect(padOut);
    const chorusIn = F('highpass', 250, QDB(Math.SQRT1_2)); // the chorus only widens above 250 Hz: the pad's low end stays mono
    padM.connect(chorusIn);
    {
      // two independently modulated delay lines (L / R) mixed under the dry pad: the per-partial beating of
      // detuned oscillators is smeared into an ensemble shimmer instead of a regular tremolo
      const sp = ctx.createChannelSplitter(2),
        mg = ctx.createChannelMerger(2);
      g.nodes.push(sp, mg);
      chorusIn.connect(sp);
      // one LFO, the two ears in opposite phase around the same base delay: each ear's comb filter sweeps the
      // same range, so neither side is louder on average (different base delays per ear left a fixed comb that
      // made some pitches louder on one side)
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.23;
      lfo.start(when);
      g.srcs.push(lfo);
      [1, -1].forEach((sign, ch) => {
        const dl = D(0.018);
        const lg = G(0.0028 * sign);
        lfo.connect(lg).connect(dl.delayTime);
        sp.connect(dl, ch);
        dl.connect(mg, 0, ch);
      });
      const ch = G(0.3);
      lanes.push([ch.gain, L.chorusGain || (L.chorusGain = L.chorus.map((x) => 0.3 * x))]);
      mg.connect(ch).connect(padOut);
    }
    cat('pad', padIn, padOut);
    // choir: three formant sections (formants belong to the vocal tract, not the pitch), shared body, carve, duck
    const chSum = G(1);
    const chBody = F('lowpass', 480, 0.5);
    chBody.connect(G(0.28)).connect(chSum);
    const breath = loop(this.buf.pink, tStart * 0.61);
    const brG = G(0);
    const brHP = F('highpass', 1400, 0.5);
    breath.connect(brHP).connect(brG);
    SECTIONS.forEach((_, k) => {
      const inp = G(1);
      const fb = [F('bandpass', 800, 6), F('bandpass', 1150, 8), F('bandpass', 2800, 11)];
      const fg = [G(1.5), G(1.1), G(0.75)];
      fb.forEach((b, i) => inp.connect(b).connect(fg[i]).connect(chSum));
      inp.connect(chBody);
      brG.connect(G(0.035)).connect(inp);
      const sl = this.sectionLanes[k];
      lanes.push([fb[0].frequency, sl[0]], [fb[1].frequency, sl[1]], [fb[2].frequency, sl[2]]);
      g.bus['choir' + k] = inp;
    });
    cat('choir', g.bus.choir1, motifed(chSum));
    // the solo voice: wider formants (more of its own harmonics), the singer's-formant lift near 2.9 kHz, a
    // direct body path that keeps its fundamental strong; pre-delayed into the hall, never ducked
    {
      const inp = G(1),
        sum = G(1);
      const fb = [F('bandpass', 800, 4.5), F('bandpass', 1150, 6), F('bandpass', 2800, 8)];
      const fg = [G(1.45), G(1.0), G(0.8)];
      fb.forEach((b, i) => inp.connect(b).connect(fg[i]).connect(sum));
      inp.connect(F('lowpass', 1100, 0.6)).connect(G(0.42)).connect(sum);
      const pres = F('peaking', 2900, 1.2, 3);
      sum.connect(pres);
      lanes.push([fb[0].frequency, L.f1], [fb[1].frequency, L.f2], [fb[2].frequency, L.f3]);
      cat('leadVox', inp, pres, LEAD_PREDELAY);
    }
    // felt piano (the melody instrument in most worlds): world-dependent felt low-pass, pre-delayed hall send
    const piIn = G(1),
      piLP = F('lowpass', 5200, 0.5);
    piIn.connect(piLP);
    cat('piano', piIn, piLP, LEAD_PREDELAY);
    // bowed strings (the cello counter-melody, the finale's string section): one shared body, i.e. the
    // instrument's resonances (the air mode ~105 Hz, the main wood modes ~200 and ~420 Hz, the bridge hill
    // ~2.4 kHz) and the dip between them, then the f-hole radiation roll-off above ~5 kHz
    {
      const inp = G(1);
      const b1 = F('peaking', 105, 1.6, 3),
        b2 = F('peaking', 205, 2.2, 4),
        b3 = F('peaking', 420, 1.8, 2.5),
        dip = F('peaking', 900, 1.2, -3),
        hill = F('peaking', 2400, 1.1, 3.5),
        roll = F('lowpass', 5200, QDB(0.6));
      inp.connect(b1).connect(b2).connect(b3).connect(dip).connect(hill).connect(roll);
      cat('bow', inp, roll, LEAD_PREDELAY);
    }
    // sub: low-pass and gentle drive for harmonics
    const sbIn = G(1),
      sbLP = F('lowpass', 150, 0.6);
    const sh = ctx.createWaveShaper();
    sh.curve = softClipCurve(1.4);
    g.nodes.push(sh);
    sbIn.connect(sbLP).connect(sh);
    cat('sub', sbIn, sh);
    // pluck with a dotted-eighth echo at 84 BPM
    const plIn = G(1),
      plLP = F('lowpass', 4600, 0.6),
      plSum = G(1);
    plIn.connect(plLP).connect(plSum);
    const dl = D((60 / 84) * 0.75);
    const dlLP = F('lowpass', 2600, 0.5),
      fbk = G(0.34),
      echo = G(0.55);
    plLP.connect(dl);
    dl.connect(dlLP);
    dlLP.connect(fbk);
    fbk.connect(dl);
    dlLP.connect(echo).connect(plSum);
    cat('pluck', plIn, plSum);
    // brass: sustained chords duck under a melody; the horn lead has its own presence lift and pre-delay
    {
      const inp = G(1);
      cat('brass', inp, motifed(inp, false));
      const lead = G(1),
        pres = F('peaking', 1700, 0.9, 2.5);
      lead.connect(pres);
      cat('leadBrass', lead, pres, LEAD_PREDELAY);
    }
    for (const name of ['bell', 'glass', 'grain', 'chirp', 'drone']) {
      const n = G(1);
      cat(name, n, n);
    }
    // continuous noise beds: "air" (band-passed pink) and "rumble" (low-passed brown)
    const bed = G(1);
    cat('bed', bed, bed);
    const airBP = F('bandpass', 1200, 0.7),
      airG = G(0);
    loop(this.buf.pink, tStart * 0.37 + 1.1).connect(airBP).connect(airG).connect(bed);
    const rumLP = F('lowpass', 150, 0.5),
      rumG = G(0);
    loop(this.buf.brown, tStart * 0.53 + 2.3).connect(rumLP).connect(rumG).connect(bed);
    // automation lanes for the rest of the film
    lanes.push(
      [lvlD.gain, L.level], [lvlW.gain, L.level], [duckD.gain, L.duck], [duckW.gain, L.duck], [wetL.gain, L.wet],
      [loD.gain, L.loShelf], [hiD.gain, L.hiShelf], [loW.gain, L.loShelf], [hiW.gain, L.hiShelf],
      [padLP.frequency, L.padCut], [padLP.Q, L.padQ], [padHP.frequency, L.padHP], [piLP.frequency, L.pianoCut],
      [brG.gain, L.breath], [airBP.frequency, L.airFreq], [airBP.Q, L.airQ], [airG.gain, L.airGain], [rumLP.frequency, L.rumbleCut], [rumG.gain, L.rumbleGain],
    );
    this.startLanes(g, lanes, tStart, when);
    g.next = lowerBound(this.plan.events, tStart);
    this.gens.push(g);
    this.catchUp(g, tStart, when);
    return g;
  }

  // Automation lanes are scheduled in rolling chunks (setValueCurveAtTime costs ~0.25 us per point, so handing
  // it the rest of the film at every seek would hitch the main thread).
  startLanes(g, lanes, t0, when) {
    const x = t0 * LANE_HZ;
    let i0 = Math.ceil(x);
    if (i0 - x < 1e-4) i0++;
    for (const [param, arr] of lanes) {
      const a = Math.min(arr.length - 1, Math.floor(x));
      const v0 = a + 1 < arr.length ? arr[a] + (arr[a + 1] - arr[a]) * (x - a) : arr[arr.length - 1];
      param.value = v0;
      param.setValueAtTime(v0, when);
    }
    g.lanes = lanes;
    g.laneNext = i0;
    g.laneWhen = (i) => when + (i / LANE_HZ - t0);
    this.extendLanes(g, t0 + LANE_CHUNK);
  }
  extendLanes(g, tTo) {
    const len = g.lanes[0][1].length;
    const iEnd = Math.min(len - 1, Math.ceil(tTo * LANE_HZ));
    if (iEnd - g.laneNext < 2) return;
    const start = g.laneWhen(g.laneNext),
      dur = (iEnd - g.laneNext) / LANE_HZ;
    for (const [param, arr] of g.lanes) param.setValueCurveAtTime(arr.subarray(g.laneNext, iEnd + 1), start, dur);
    g.laneNext = iEnd + 1; // the next chunk starts one lane step later (the value holds for 50 ms in between)
  }

  // Resume every sustained note that should already be sounding at tStart, part-way through its envelope.
  catchUp(g, tStart, when) {
    const ev = this.plan.events;
    for (let i = lowerBound(ev, tStart - this.plan.maxSpan); i < ev.length && ev[i].t < tStart; i++) {
      const e = ev[i];
      if (e.end > tStart + 0.1 && CATCHUP.has(e.type)) this.play(g, e, when, tStart - e.t);
    }
  }

  retire(g, when, fade = 0.6) {
    if (!g || g.dead) return;
    g.dead = true;
    // equal-power fade out over `fade`, from the instant the new generation starts fading in
    for (const o of [g.outDry, g.outWet]) {
      const p = o.gain;
      const v0 = Math.max(0, Math.min(1, p.value));
      if (p.cancelAndHoldAtTime) p.cancelAndHoldAtTime(when);
      else p.cancelScheduledValues(when);
      p.setValueAtTime(v0, when);
      p.setValueCurveAtTime(XFADE_OUT.map((x) => x * v0), when + 1e-4, Math.max(0.05, fade));
    }
    g.deadAt = when + fade + 0.15;
    // voices of this generation that have not started by the time it is silent never will be heard: cancel them
    // now (stop + disconnect) instead of keeping them queued until deadAt
    let w = 0;
    for (const v of this.voices) {
      if (v.gen === g && v.start > g.deadAt) {
        this.dispose(v);
        v.cancelled = true;
      } else this.voices[w++] = v;
    }
    this.voices.length = w;
    for (const k in this.byCat) this.byCat[k] = this.byCat[k].filter((v) => !v.cancelled);
  }

  // ------------------------------------------------------------------------------------- scheduling
  // Schedule every event with t < tEnd (at most `budget` of them this call: the caller extends the horizon a
  // little every frame, so a long lookahead never costs one long frame).
  scheduleUntil(g, tEnd, budget = Infinity, msBudget = Infinity) {
    if (!g || g.dead) return;
    if (g.lanes && tEnd + 8 > g.laneNext / LANE_HZ) this.extendLanes(g, Math.max(tEnd, g.laneNext / LANE_HZ) + LANE_CHUNK);
    const ev = this.plan.events;
    const now = this.ctx.currentTime;
    const t0 = msBudget < Infinity ? performance.now() : 0;
    let n = 0;
    while (g.next < ev.length && ev[g.next].t < tEnd && n < budget) {
      // a time budget (live): node creation is spread over frames instead of landing in one
      if (msBudget < Infinity && (n & 7) === 7 && performance.now() - t0 > msBudget) break;
      const e = ev[g.next++];
      n++;
      let when = this.toCtx(e.t),
        off = 0;
      if (when < now + 0.01) {
        off = now + 0.01 - when;
        when = now + 0.01;
        // late: resume sustained notes part-way, drop short ones and anything that would already be over
        if (off > 0.08 && (!CATCHUP.has(e.type) || e.end - e.t - off < 0.1)) continue;
      }
      this.play(g, e, when, off);
    }
    return g.next < ev.length ? ev[g.next].t : Infinity; // the journey time scheduled up to
  }

  // voices of a category sounding at ctx time `when`
  activeAt(cat, when) {
    let n = 0;
    for (const v of this.byCat[cat] || []) if (!v.stolen && v.start <= when + 1e-3 && v.end > when) n++;
    return n;
  }
  totalAt(when) {
    let n = 0;
    for (const v of this.voices) if (!v.stolen && v.start <= when + 1e-3 && v.end > when) n++;
    return n;
  }

  play(g, e, when, off) {
    const cat = e.cat || 'grain';
    const scale = this.lite ? 0.7 : 1;
    if (this.activeAt(cat, when) >= Math.round((MAX[cat] || 16) * scale)) {
      if (DROP_WHEN_FULL.has(cat)) {
        this.stats.dropped++;
        return;
      }
      this.stealOldest(cat, when);
    }
    if (this.voices.length > MAX_TOTAL * scale * 0.8 && this.totalAt(when) >= MAX_TOTAL * scale) {
      if (DROP_WHEN_FULL.has(cat) || cat === 'sfx') {
        this.stats.dropped++;
        return;
      }
      this.stealOldest(cat, when);
    }
    const inst = INSTRUMENTS[e.type];
    if (!inst) return;
    let v;
    try {
      v = inst(this, g, e, when, off);
    } catch (err) {
      this.stats.errors++;
      if (this.stats.errors <= 2) console.warn('[audio] voice failed:', e.type, err && err.message);
      return;
    }
    if (!v) return;
    v.cat = cat;
    v.gen = g;
    v.start = when;
    this.voices.push(v);
    (this.byCat[cat] || (this.byCat[cat] = [])).push(v);
    this.counts[cat] = (this.counts[cat] || 0) + 1;
    this.stats.created++;
    if (this.voices.length > this.stats.peakVoices) this.stats.peakVoices = this.voices.length;
    const live = this.activeAt(cat, when);
    if (live > (this.stats.peakByCat[cat] || 0)) this.stats.peakByCat[cat] = live;
  }

  // fade out the oldest voice of a category that is sounding at `when`, at `when` (which may be in the future)
  stealOldest(cat, when) {
    let old = null;
    for (const v of this.byCat[cat] || []) if (!v.stolen && v.start <= when + 1e-3 && v.end > when && (!old || v.start < old.start)) old = v;
    if (!old) return;
    const at = Math.max(this.ctx.currentTime, old.start, when);
    old.stolen = true;
    old.out.gain.setTargetAtTime(0, at, 0.02);
    old.end = Math.min(old.end, at + 0.15);
    this.counts[cat]--;
    this.stats.stolen++;
  }

  dispose(v) {
    if (v.onDispose) {
      try {
        v.onDispose();
      } catch {}
    }
    for (const s of v.srcs) {
      try {
        s.stop();
      } catch {}
      try {
        s.disconnect();
      } catch {}
    }
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {}
    }
    if (!v.stolen) this.counts[v.cat]--;
  }

  // Disconnect finished voices and retired generations.
  sweep(now) {
    let w = 0;
    for (const v of this.voices) {
      if (v.end < now || (v.gen.dead && v.gen.deadAt < now)) this.dispose(v);
      else this.voices[w++] = v;
    }
    this.voices.length = w;
    for (const k in this.byCat) {
      const arr = this.byCat[k];
      let j = 0;
      for (const v of arr) if (!(v.end < now || (v.gen.dead && v.gen.deadAt < now)) && !v.cancelled) arr[j++] = v;
      arr.length = j;
    }
    this.gens = this.gens.filter((g) => {
      if (!(g.dead && g.deadAt < now)) return true;
      for (const s of g.srcs) {
        try {
          s.stop();
        } catch {}
        try {
          s.disconnect();
        } catch {}
      }
      for (const n of g.nodes) {
        try {
          n.disconnect();
        } catch {}
      }
      return false;
    });
  }

  liveGen() {
    for (let i = this.gens.length - 1; i >= 0; i--) if (!this.gens[i].dead) return this.gens[i];
    return null;
  }

  // ------------------------------------------------------------------------------------- transport
  setTransport(on, when = this.ctx.currentTime) {
    holdAndRamp(this.tDry.gain, when, on ? 1 : 0, on ? 0.12 : 0.07);
    holdAndRamp(this.tWet.gain, when, on ? 1 : 0, on ? 0.12 : 0.07);
  }
  setMuted(m) {
    holdAndRamp(this.mute.gain, this.ctx.currentTime, m ? 0 : 1, 0.05);
  }
  info() {
    const now = this.ctx.currentTime;
    let sounding = 0;
    for (const v of this.voices) if (v.start <= now && v.end > now && !v.stolen) sounding++;
    return {
      state: this.ctx.state,
      time: +now.toFixed(3),
      voices: this.voices.length,
      sounding,
      byCat: { ...this.counts },
      limiter: this.limiter?.kind,
      ...this.stats,
      generationsCreated: this.stats.generations,
      generations: this.gens.length,
    };
  }
}
