// Instruments: each builds one voice for an event, starting at ctx time `when`, `off` seconds into the note
// (non-zero when a seek resumes a sustained note mid-way). Every voice ends in a dedicated "steal" gain so the
// engine can fade it out when a voice limit is hit, and reports `end` so finished nodes are disconnected.
import { mtof } from './theory.js';

// nominal per-voice levels (linear); the master is calibrated from the offline loudness report
const G = { bow: 0.07, pad: 0.05, choir: 0.055, sub: 0.085, bell: 0.11, glass: 0.085, piano: 0.34, pluck: 0.16, kick: 0.32, brass: 0.045, grain: 0.09, pebble: 0.11, tick: 0.09, sparkle: 0.05, chirp: 0.05, pmodes: 0.03, tone: 0.03, riser: 0.05, drop: 0.2, whoosh: 0.12, suck: 0.07 };

// Control-rate automation: a parameter that only moves slowly (filter sweeps, pitch drift, vibrato) is computed
// once per 128-sample render quantum instead of per sample. For a BiquadFilterNode this is the difference
// between recomputing its coefficients 128 times per quantum and once. (Audio-rate FM stays a-rate.)
export function kRate(param) {
  try {
    param.automationRate = 'k-rate';
  } catch {}
  return param;
}

// ------------------------------------------------------------------------------------------- envelopes
// Piecewise-linear envelope with breakpoints [[t, v], ...] relative to note start, resumed at `off`.
function ramp(param, when, off, pts) {
  let k = 0;
  while (k < pts.length - 1 && pts[k + 1][0] <= off) k++;
  let v0;
  if (k >= pts.length - 1) v0 = pts[pts.length - 1][1];
  else {
    const [ta, va] = pts[k],
      [tb, vb] = pts[k + 1];
    v0 = tb > ta ? va + ((vb - va) * (off - ta)) / (tb - ta) : vb;
  }
  param.setValueAtTime(v0, when);
  for (let j = k + 1; j < pts.length; j++) if (pts[j][0] > off) param.linearRampToValueAtTime(pts[j][1], when + pts[j][0] - off);
}
// Slow swell: raised-cosine attack, hold, exponential-like release.
function swellPts(A, dur, R, peak) {
  const a = Math.max(0.04, Math.min(A, dur * 0.95));
  const pts = [[0, 0]];
  for (const x of [0.15, 0.35, 0.6, 0.85, 1]) pts.push([a * x, peak * (0.5 - 0.5 * Math.cos(Math.PI * x))]);
  const hold = Math.max(a, dur);
  if (hold > a) pts.push([hold, peak]);
  for (const [x, y] of [[0.08, 0.66], [0.2, 0.37], [0.4, 0.14], [0.65, 0.04], [1, 0]]) pts.push([hold + R * x, peak * y]);
  return pts;
}
function hannPts(d, peak) {
  return [[0, 0], [0.15 * d, 0.35 * peak], [0.5 * d, peak], [0.85 * d, 0.35 * peak], [d, 0]];
}
// Percussive: linear attack then exponential decay (time constant tau). Returns the time the voice is inaudible.
function perc(param, when, off, atk, peak, tau) {
  if (off < atk) {
    param.setValueAtTime((peak * off) / atk, when);
    param.linearRampToValueAtTime(peak, when + atk - off);
    param.setTargetAtTime(0, when + atk - off, tau);
  } else {
    param.setValueAtTime(peak * Math.exp(-(off - atk) / tau), when);
    param.setTargetAtTime(0, when, tau);
  }
  return when + Math.max(0, atk - off) + 9 * tau - Math.max(0, off - atk);
}
function curveFrom(fn, dur, off, rate = 60) {
  const n = Math.max(2, Math.ceil((dur - off) * rate) + 1);
  const arr = new Float32Array(n);
  for (let i = 0; i < n; i++) arr[i] = fn(off + ((dur - off) * i) / (n - 1));
  return arr;
}

// ------------------------------------------------------------------------------------------- helpers
function voice(E, g, bus, pan) {
  const ctx = E.ctx;
  const env = ctx.createGain();
  env.gain.value = 0;
  const steal = ctx.createGain();
  let p = null;
  if (pan !== undefined && pan !== 0) {
    p = ctx.createStereoPanner();
    p.pan.value = pan;
    env.connect(p).connect(steal);
  } else env.connect(steal);
  steal.connect(g.bus[bus]);
  return { env, steal, nodes: [env, steal, ...(p ? [p] : [])], srcs: [], out: steal };
}
function osc(E, type, f, detune = 0) {
  const o = E.ctx.createOscillator();
  if (E.waves[type]) o.setPeriodicWave(E.waves[type]);
  else o.type = type;
  o.frequency.value = f;
  o.detune.value = detune;
  return o;
}
function gain(E, v) {
  const n = E.ctx.createGain();
  n.gain.value = v;
  return n;
}
function startAll(v, when, end) {
  end = Math.max(end, when + 0.02); // never schedule a stop before the start
  for (const s of v.srcs) {
    if (s._off !== undefined) s.start(when, s._off);
    else s.start(when);
    s.stop(end);
  }
  v.end = end;
  return v;
}
// a looping control-signal / noise buffer source that starts at a seeded offset
function loopSrc(E, buf, seed, rate = 1) {
  const s = E.ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  s.playbackRate.value = rate;
  s._off = (((seed || 0) % 9973) / 9973) * buf.duration;
  return s;
}

// ------------------------------------------------------------------------------------------- instruments
export const INSTRUMENTS = {
  // Evolving pad: three oscillators (saw or wavetable) with non-uniform detune and unequal levels, a smooth
  // random (non-periodic) pitch drift that pushes them apart and together by different amounts, optional
  // sub-octave and tremolo; the pad bus adds a modulated low-pass, the motif carve/duck and a stereo chorus.
  pad(E, g, e, when, off) {
    const v = voice(E, g, 'pad', e.pan);
    const f = mtof(e.midi);
    const type = e.wave === 'saw' ? 'sawtooth' : e.wave;
    let target = v.env;
    if (e.tremolo) {
      const trem = gain(E, 1 - e.tremolo[1] / 2);
      const tl = osc(E, 'sine', e.tremolo[0] * (0.9 + 0.2 * ((e.seed % 100) / 100)));
      const tg = gain(E, e.tremolo[1] / 2);
      tl.connect(tg).connect(trem.gain);
      trem.connect(v.env);
      target = trem;
      v.nodes.push(trem, tg);
      v.srcs.push(tl);
    }
    const DET = [-1, 0.37, 0.9],
      AMP = [0.84, 0.66, 0.5],
      DRIFT = [1, -0.8, 0.45];
    const dr = loopSrc(E, E.ctl.drift, e.seed, Math.max(0.4, Math.min(1.6, e.lfo / 0.09)));
    v.srcs.push(dr);
    for (let k = 0; k < 3; k++) {
      const o = osc(E, type, f, e.detune * DET[k]);
      kRate(o.detune);
      const a = gain(E, AMP[k]);
      o.connect(a).connect(target);
      const dg = gain(E, e.drift * DRIFT[k]);
      dr.connect(dg).connect(o.detune);
      v.srcs.push(o);
      v.nodes.push(a, dg);
    }
    if (e.subOct) {
      const o3 = osc(E, 'sine', f / 2);
      const g3 = gain(E, 0.22);
      o3.connect(g3).connect(target);
      v.srcs.push(o3);
      v.nodes.push(g3);
    }
    const peak = (G.pad * e.vel) / (type === 'sawtooth' ? 1.25 : 1);
    ramp(v.env.gain, when, off, swellPts(e.attack, e.dur, e.release, peak));
    return startAll(v, when, when + Math.max(e.attack, e.dur) + e.release - off + 0.05);
  },

  // Choir: glottal-like source pairs with vibrato that blooms in, a few cents of smooth random jitter and a
  // breath of aspiration noise in every voice. Sustained voices are spread over three formant "sections"
  // (slightly different vocal tracts); the solo voice has its own brighter path and slides up into each note.
  choir(E, g, e, when, off) {
    const bus = e.solo ? 'leadVox' : 'choir' + (Math.abs(e.seed | 0) % 3);
    const v = voice(E, g, g.bus[bus] ? bus : 'choir', e.pan);
    const f = mtof(e.midi);
    const det = e.detune ?? 7;
    // a solo singer is one voice: a second detuned source beats against the first (at G#5, ~5 Hz with ~100% depth);
    // an ensemble voice keeps a quieter second source for the chorus (unequal levels: shallow beating)
    const o1 = osc(E, 'voice', f, e.solo ? 0 : -det),
      o2 = osc(E, 'voice', f * 1.0009, det);
    kRate(o1.detune);
    kRate(o2.detune);
    o1.connect(v.env);
    const g2 = gain(E, e.solo ? 0 : 0.55);
    o2.connect(g2).connect(v.env);
    v.nodes.push(g2);
    const vib = osc(E, 'sine', 4.7 + ((e.seed || 0) % 90) / 100);
    const vg = gain(E, 0);
    vib.connect(vg);
    vg.connect(o1.detune);
    vg.connect(o2.detune);
    const depth = e.solo ? 22 : 15;
    ramp(vg.gain, when, off, [[0, 0], [Math.min(1.2, e.attack + 0.4), depth * 0.6], [Math.min(2.4, e.dur), depth]]);
    const jt = loopSrc(E, E.ctl.jitter, (e.seed || 0) + 17, 0.8 + (((e.seed || 0) >> 4) % 40) / 100);
    const j1 = gain(E, 4.5),
      j2 = gain(E, -3.5);
    jt.connect(j1).connect(o1.detune);
    jt.connect(j2).connect(o2.detune);
    // aspiration: the solo voice breathes on its own; ensemble voices share their section's breath bed (engine)
    if (e.solo) {
      const ns = loopSrc(E, E.buf.pink, (e.seed || 0) + 101);
      const nh = E.ctx.createBiquadFilter();
      nh.type = 'highpass';
      nh.frequency.value = 1000;
      const ng = gain(E, 0.05);
      ns.connect(nh).connect(ng).connect(v.env);
      v.srcs.push(ns);
      v.nodes.push(nh, ng);
      if (off < 0.05) {
        // a breath into the note: the aspiration is three times stronger for the first ~50 ms
        ng.gain.setValueAtTime(0.15, when);
        ng.gain.setTargetAtTime(0.05, when + 0.02, 0.045);
      }
    }
    if (e.solo && off < 0.05) {
      // the scoop: a singer arrives at a pitch from below after a leap up (deeper and slower the wider the leap)
      // and settles onto it from a touch above after a step down (e.scoop cents, e.scoopT s; composer)
      o1.detune.setValueAtTime(e.scoop ?? -28, when);
      o1.detune.linearRampToValueAtTime(0, when + (e.scoopT ?? 0.13));
    }
    v.srcs.push(o1, o2, vib, jt);
    v.nodes.push(vg, j1, j2);
    const peak = G.choir * e.vel * (e.solo ? 2.0 : 1.2); // (level kept: the second source is quieter or gone)
    ramp(v.env.gain, when, off, swellPts(e.attack, e.dur, e.release, peak));
    return startAll(v, when, when + Math.max(e.attack, e.dur) + e.release - off + 0.05);
  },

  // Sub swell: sine plus a little 2nd/3rd harmonic so it still reads on laptop speakers.
  sub(E, g, e, when, off) {
    const v = voice(E, g, 'sub');
    const f = mtof(e.midi);
    const o1 = osc(E, 'sine', f),
      o2 = osc(E, 'sine', f * 2),
      o3 = osc(E, 'sine', f * 3);
    const g2 = gain(E, 0.32),
      g3 = gain(E, 0.08);
    o1.connect(v.env);
    o2.connect(g2).connect(v.env);
    o3.connect(g3).connect(v.env);
    v.srcs.push(o1, o2, o3);
    v.nodes.push(g2, g3);
    ramp(v.env.gain, when, off, swellPts(e.attack, e.dur, e.release, G.sub * e.vel));
    return startAll(v, when, when + Math.max(e.attack, e.dur) + e.release - off + 0.05);
  },

  // FM bell / cold bell: inharmonic modulator ratio, index decays faster than the amplitude (bright strike,
  // pure hum), plus a quiet sub-partial for body.
  bell(E, g, e, when, off) {
    if (off > 1.5) return null;
    const v = voice(E, g, 'bell', e.pan);
    const f = mtof(e.midi);
    const car = osc(E, 'sine', f),
      mod = osc(E, 'sine', f * e.ratio);
    const mg = gain(E, 0);
    const idx = e.index * f * e.ratio;
    mg.gain.setValueAtTime(idx * Math.exp(-off / (e.decay * 0.12)), when);
    mg.gain.setTargetAtTime(idx * 0.08, when, e.decay * 0.12);
    mod.connect(mg).connect(car.frequency);
    const hum = osc(E, 'sine', f * 0.5);
    const hg = gain(E, 0.22);
    hum.connect(hg).connect(v.env);
    car.connect(v.env);
    v.srcs.push(car, mod, hum);
    v.nodes.push(mg, hg);
    const end = perc(v.env.gain, when, off, 0.0025, G.bell * e.vel, e.decay / 6.9);
    return startAll(v, when, end);
  },

  // Glass harmonica / ice: near-sine with soft attack and a few partials, very long decay.
  glass(E, g, e, when, off) {
    if (off > 2) return null;
    const v = voice(E, g, 'glass', e.pan);
    const f = mtof(e.midi);
    const a = osc(E, 'sine', f),
      b = osc(E, 'sine', f * 2.003),
      c = osc(E, 'sine', f * 3.011);
    const gb = gain(E, 0.22),
      gc = gain(E, 0.07);
    a.connect(v.env);
    b.connect(gb).connect(v.env);
    c.connect(gc).connect(v.env);
    v.srcs.push(a, b, c);
    v.nodes.push(gb, gc);
    const end = perc(v.env.gain, when, off, 0.025, G.glass * e.vel, e.decay / 6.9);
    return startAll(v, when, end);
  },

  // Felt piano: pre-synthesised physical-additive notes (see dsp.js; e.rr picks the round-robin seed). The buffer is
  // the hard-hammer note: a per-note low-pass follows velocity (soft = darker, as a felt hammer's spectrum narrows),
  // each note is tuned a cent or so from the last (no two strikes identical), and the key release is a damper, not
  // a fade: the felt kills the upper partials first (the low-pass falls toward the fundamental) while the note
  // decays over ~0.3 s.
  piano(E, g, e, when, off) {
    const m = Math.round(e.midi),
      rr = e.rr || 0;
    // resuming a note mid-way (after a seek) is not worth building a buffer on the spot; onsets always play
    if (off > 0.05 && !E.piano.has(m * 2 + rr)) return null;
    const buf = E.pianoBuffer(m, rr);
    if (off >= Math.min(buf.duration, e.ring) - 0.1) return null;
    const v = voice(E, g, 'piano', e.pan);
    const f0 = mtof(m);
    const src = E.ctx.createBufferSource();
    src.buffer = buf;
    // a cent or so of tuning per strike, from the note's own time (deterministic)
    src.detune.value = 1.6 * Math.sin(e.t * 12.9898 + m * 78.233);
    const lp = E.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = -3;
    kRate(lp.frequency);
    const vn = Math.max(0.12, Math.min(1, e.vel / 1.25));
    const bright = Math.min(14000, f0 * (3.5 + 16 * Math.pow(vn, 1.3)) + 900 * vn);
    src.connect(lp).connect(v.env);
    const peak = G.piano * e.vel;
    const ring = Math.min(buf.duration, e.ring);
    const rel = when + Math.max(0.02, ring - off - 0.3);
    lp.frequency.setValueAtTime(bright, when);
    lp.frequency.setValueAtTime(bright, rel);
    lp.frequency.setTargetAtTime(Math.max(120, 1.6 * f0), rel, 0.06);
    v.env.gain.setValueAtTime(peak, when);
    v.env.gain.setValueAtTime(peak, rel);
    v.env.gain.setTargetAtTime(0, rel, 0.075);
    src.start(when, off);
    src.stop(when + ring - off + 0.25);
    v.srcs.push(src);
    v.nodes.push(lp);
    v.end = when + ring - off + 0.25;
    return v;
  },

  // Bowed string (the cello counter-melody; e.ens: a desk of players for the finale's strings). A sawtooth (the
  // Helmholtz motion of a bowed string) through a low-pass whose cutoff follows the bow (more bow, brighter: the
  // same amplitude-brightness coupling as brass, gentler), the body resonances on the shared 'bow' bus (engine),
  // a vibrato that arrives ~0.3 s into the note (a player settles the pitch first), a few cents of slow drift, a
  // short scratch of rosin noise at the bow's start and a breath of bow noise riding the tone.
  bow(E, g, e, when, off) {
    const v = voice(E, g, 'bow', e.pan);
    const ctx = E.ctx;
    const f = mtof(e.midi);
    const seed = e.seed || 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.7;
    kRate(lp.frequency);
    lp.connect(v.env);
    const players = e.ens ? [-7, 6] : [0];
    const vib = osc(E, 'sine', (e.ens ? 4.7 : 5.3) + (seed % 60) / 100);
    const vg = gain(E, 0);
    vib.connect(vg);
    const depth = e.ens ? 7 : 15;
    ramp(vg.gain, when, off, [[0, 0], [Math.min(0.3, 0.4 * e.dur), 0], [Math.min(1.1, 0.8 * e.dur + 0.2), depth]]);
    const jt = loopSrc(E, E.ctl.jitter, seed + 29, 0.35 + ((seed >> 5) % 30) / 100);
    const jg = gain(E, e.ens ? 5 : 3);
    jt.connect(jg);
    players.forEach((d, k) => {
      const o = osc(E, 'sawtooth', f * (k ? 1.0006 : 1), d);
      kRate(o.detune);
      vg.connect(o.detune);
      jg.connect(o.detune);
      const pg = gain(E, players.length > 1 ? 0.62 : 1);
      o.connect(pg).connect(lp);
      v.srcs.push(o);
      v.nodes.push(pg);
    });
    // bow noise: band-limited around the string's upper partials, riding the tone's envelope
    const nz = loopSrc(E, E.buf.pink, seed + 7);
    const nb = ctx.createBiquadFilter();
    nb.type = 'bandpass';
    nb.frequency.value = Math.min(5500, f * 7);
    nb.Q.value = 0.9;
    const ng = gain(E, 0.028);
    nz.connect(nb).connect(ng).connect(lp);
    v.srcs.push(vib, jt, nz);
    v.nodes.push(vg, jg, nb, ng, lp);
    const peak = G.bow * e.vel;
    const amp = swellPts(e.attack, e.dur, e.release, peak);
    ramp(v.env.gain, when, off, amp);
    ramp(lp.frequency, when, off, amp.map(([t, a]) => [t, 500 + f * 2.4 + 2600 * Math.pow(a / peak, 1.3)]));
    if (off < 0.05) {
      // the rosin scratch as the bow bites (~25 ms)
      const sc = ctx.createBufferSource();
      sc.buffer = E.buf.white;
      const sb = ctx.createBiquadFilter();
      sb.type = 'bandpass';
      sb.frequency.value = Math.min(4000, f * 9);
      sb.Q.value = 1.2;
      const sg = gain(E, 0);
      perc(sg.gain, when, 0, 0.004, peak * 0.35, 0.018);
      sc.connect(sb).connect(sg).connect(v.steal);
      sc.start(when, (seed % 997) / 997, 0.2);
      v.nodes.push(sc, sb, sg);
    }
    return startAll(v, when, when + Math.max(e.attack, e.dur) + e.release - off + 0.05);
  },

  // Mars pulse: short FM pluck, index envelope much faster than the amplitude.
  pluck(E, g, e, when, off) {
    if (off > 0.05) return null;
    const v = voice(E, g, 'pluck', e.pan);
    const f = mtof(e.midi);
    const car = osc(E, 'triangle', f),
      mod = osc(E, 'sine', f * 2);
    const mg = gain(E, 0);
    mg.gain.setValueAtTime(f * 2.2 * e.bright, when);
    mg.gain.setTargetAtTime(f * 0.15, when, 0.035);
    mod.connect(mg).connect(car.frequency);
    car.connect(v.env);
    v.srcs.push(car, mod);
    v.nodes.push(mg);
    const end = perc(v.env.gain, when, 0, 0.002, G.pluck * e.vel, e.decay / 4);
    return startAll(v, when, end);
  },

  // Soft heartbeat kick under the Mars pulse.
  kick(E, g, e, when, off) {
    if (off > 0.05) return null;
    const v = voice(E, g, 'sub');
    const o = osc(E, 'sine', 76);
    o.frequency.setValueAtTime(76, when);
    o.frequency.exponentialRampToValueAtTime(47, when + 0.2);
    o.connect(v.env);
    v.srcs.push(o);
    const end = perc(v.env.gain, when, 0, 0.004, G.kick * e.vel, 0.11);
    return startAll(v, when, end);
  },

  // Low brass: three bright oscillators through a low-pass whose cutoff tracks the amplitude, which is what
  // makes brass sound like brass (louder = brighter). The horn lead adds the lip "blat" (a short burst of
  // band-passed breath noise) and a quick rise into the pitch at each onset, plus a late vibrato.
  brass(E, g, e, when, off) {
    const v = voice(E, g, e.lead ? 'leadBrass' : 'brass', e.pan);
    const f = mtof(e.midi);
    const lp = E.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 0.9;
    kRate(lp.frequency);
    lp.connect(v.env);
    const os = [];
    for (const d of e.lead ? [-3, 0, 2.5] : [-7, 0, 6]) { // a solo horn line is (almost) one player
      const o = osc(E, 'brass', f, d);
      kRate(o.detune);
      o.connect(lp);
      os.push([o, d]);
      v.srcs.push(o);
    }
    if (e.lead) {
      const vib = osc(E, 'sine', 4.6);
      const vg = gain(E, 0);
      ramp(vg.gain, when, off, [[0, 0], [0.5, 0], [1.5, 9]]);
      vib.connect(vg);
      for (const [o] of os) vg.connect(o.detune);
      v.srcs.push(vib);
      v.nodes.push(vg);
      if (off < 0.05) {
        for (const [o, d] of os) {
          o.detune.setValueAtTime(d - 35, when);
          o.detune.linearRampToValueAtTime(d, when + 0.09);
        }
        const n = E.ctx.createBufferSource();
        n.buffer = E.buf.white;
        const bp = E.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = Math.min(3200, f * 4);
        bp.Q.value = 1.5;
        const ng = gain(E, 0);
        perc(ng.gain, when, 0, 0.004, G.brass * e.vel * 0.9, 0.035);
        n.connect(bp).connect(ng).connect(v.steal);
        n.start(when, ((e.midi * 0.173) % 2) + 0.1, 0.3);
        v.nodes.push(n, bp, ng);
      }
    }
    v.nodes.push(lp);
    const peak = G.brass * e.vel;
    const amp = swellPts(e.attack, e.dur, e.release, peak);
    ramp(v.env.gain, when, off, amp);
    const fc = amp.map(([t, a]) => [t, 80 + f * 1.5 + e.bright * 2300 * Math.pow(a / peak, 1.5)]);
    ramp(lp.frequency, when, off, fc);
    return startAll(v, when, when + Math.max(e.attack, e.dur) + e.release - off + 0.05);
  },

  // Granular noise grain: a short Hann-windowed slice of a noise loop through a band-pass.
  grain(E, g, e, when, off) {
    if (off > 0.02) return null;
    const v = voice(E, g, 'grain', e.pan);
    const src = E.ctx.createBufferSource();
    src.buffer = E.buf[e.buf] || E.buf.white;
    const bp = E.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = e.freq;
    bp.Q.value = e.q;
    src.connect(bp).connect(v.env);
    v.nodes.push(bp);
    const comp = Math.min(6, Math.sqrt(e.q) * Math.sqrt(2500 / e.freq) + 0.5);
    ramp(v.env.gain, when, 0, hannPts(e.dur, G.grain * e.vel * comp));
    src.start(when, (e.off || 0) * (src.buffer.duration - e.dur - 0.01), e.dur + 0.01);
    v.srcs.push(src);
    v.end = when + e.dur + 0.02;
    return v;
  },

  // A pebble: inharmonic FM ping (stony) plus a tiny noise click.
  pebble(E, g, e, when, off) {
    if (off > 0.02) return null;
    const v = voice(E, g, 'grain', e.pan);
    const f = mtof(e.midi);
    const car = osc(E, 'sine', f),
      mod = osc(E, 'sine', f * e.ratio);
    const mg = gain(E, 0);
    mg.gain.setValueAtTime(f * 3, when);
    mg.gain.setTargetAtTime(f * 0.2, when, 0.006);
    mod.connect(mg).connect(car.frequency);
    car.connect(v.env);
    const click = E.ctx.createBufferSource();
    click.buffer = E.buf.white;
    const hp = E.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500;
    const cg = gain(E, 0);
    cg.gain.setValueAtTime(0.5, when);
    cg.gain.setTargetAtTime(0, when, 0.0012);
    click.connect(hp).connect(cg).connect(v.env);
    click.start(when, (e.midi * 0.0137) % 2, 0.012);
    v.srcs.push(car, mod);
    v.nodes.push(mg, hp, cg, click);
    const end = perc(v.env.gain, when, 0, 0.0015, G.pebble * e.vel, e.decay / 5);
    return startAll(v, when, end);
  },

  // Thermal-stress tick (Mercury's rocks cracking between 430 °C and -180 °C): a band-limited click.
  tick(E, g, e, when, off) {
    if (off > 0.01) return null;
    const v = voice(E, g, 'grain', e.pan);
    const src = E.ctx.createBufferSource();
    src.buffer = E.buf.white;
    const bp = E.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = e.freq;
    bp.Q.value = 1.4;
    src.connect(bp).connect(v.env);
    v.nodes.push(bp);
    const end = perc(v.env.gain, when, 0, 0.0008, G.tick * e.vel, e.decay / 3);
    src.start(when, (e.freq * 0.00031) % 2, end - when + 0.01);
    v.srcs.push(src);
    v.end = end + 0.01;
    return v;
  },

  // Saturn ring glitter: tiny high sine grains.
  sparkle(E, g, e, when, off) {
    if (off > 0.02) return null;
    const v = voice(E, g, 'glass', e.pan);
    const f = mtof(e.midi);
    const a = osc(E, 'sine', f),
      b = osc(E, 'sine', f * 2.01);
    const gb = gain(E, 0.2);
    a.connect(v.env);
    b.connect(gb).connect(v.env);
    v.nodes.push(gb);
    v.srcs.push(a, b);
    ramp(v.env.gain, when, 0, hannPts(e.dur, G.sparkle * e.vel));
    return startAll(v, when, when + e.dur + 0.02);
  },

  // Plasma-wave radio sonifications: Earth's dawn chorus (rising chirps), Jupiter's whistlers (descending,
  // with the real dispersion law t ~ 1/sqrt(f)), Saturn kilometric radiation (slow warbling tones).
  chirp(E, g, e, when, off) {
    if (off > 0.05) return null;
    const v = voice(E, g, 'chirp', e.pan);
    const o = osc(E, 'sine', e.f0);
    kRate(o.frequency);
    const d = e.dur;
    let fn;
    if (e.kind === 'rise') fn = (t) => e.f0 + (e.f1 - e.f0) * Math.pow(t / d, 1.5);
    else if (e.kind === 'whistler') {
      const s0 = Math.sqrt(e.f0),
        s1 = Math.sqrt(e.f1);
      const t0 = (d * s1) / (s0 - s1),
        D = s0 * t0;
      fn = (t) => Math.pow(D / (t + t0), 2);
    } else fn = (t) => e.f0 * (1 + 0.12 * Math.sin(2 * Math.PI * 0.8 * t) + 0.04 * Math.sin(2 * Math.PI * 3.3 * t)) * (1 - e.f1 * (t / d));
    o.frequency.setValueCurveAtTime(curveFrom(fn, d, 0), when, d);
    o.connect(v.env);
    v.srcs.push(o);
    const pts = e.kind === 'rise' ? [[0, 0], [0.2 * d, G.chirp * e.vel], [d, 0]] : hannPts(d, G.chirp * e.vel);
    ramp(v.env.gain, when, 0, pts);
    return startAll(v, when, when + d + 0.02);
  },

  // Helioseismology: the Sun rings in millions of acoustic p-modes around 3.1 mHz, spaced by the "large
  // separation" (~135 uHz), with l=0 and l=1 modes interleaved at half that spacing. Mapped so nu_max = D3,
  // keeping the real ratio Delta-nu / nu_max = 0.0435: a slowly beating cluster under the Sun's chord.
  pmodes(E, g, e, when, off) {
    const v = voice(E, g, 'drone', 0);
    const dnu = e.centre * 0.0435;
    for (let l = 0; l < 2; l++)
      for (let k = -3; k <= 3; k++) {
        const fq = e.centre + (k + l * 0.5) * dnu;
        const o = osc(E, 'sine', fq);
        const a = gain(E, Math.exp(-(k * k) / 4.5) * (l ? 0.7 : 1));
        o.connect(a).connect(v.env);
        v.srcs.push(o);
        v.nodes.push(a);
      }
    ramp(v.env.gain, when, off, swellPts(e.attack, e.dur, e.release, G.pmodes * e.vel));
    return startAll(v, when, when + Math.max(e.attack, e.dur) + e.release - off + 0.05);
  },

  // Thin sustained tone with slow beating (Mercury's heat-shimmer whine).
  tone(E, g, e, when, off) {
    // (a hush leg's held tone goes to the sfx bus: it is not ducked with the music it floats over)
    const v = voice(E, g, e.bus === 'sfx' ? 'sfx' : 'drone', e.pan);
    const f = mtof(e.midi);
    const a = osc(E, 'sine', f),
      b = osc(E, 'sine', f + e.beat);
    let into = v.env;
    if (e.follow && g.follow) {
      // its level follows the music (the engine's follower), as the riser's does
      const fg = gain(E, 0);
      g.follow.connect(fg.gain);
      fg.connect(v.env);
      into = fg;
      v.nodes.push(fg);
      v.onDispose = () => g.follow.disconnect(fg.gain);
    }
    a.connect(into);
    b.connect(into);
    v.srcs.push(a, b);
    ramp(v.env.gain, when, off, swellPts(e.attack, e.dur, e.release, G.tone * e.vel));
    return startAll(v, when, when + Math.max(e.attack, e.dur) + e.release - off + 0.05);
  },

  // Warp riser, calibrated by the composer to the music the leg leaves (e.vel carries the pre-leg level):
  //   noise body  pink noise, +12 dB shelf, band-pass sweeping from 260 Hz to the leg's top (8-10.5 kHz)
  //   air         broadband top that opens toward peak speed
  //   doppler     a detuned saw pair (fifth, fourth or octave apart) whose pitch rises with speed and falls past
  //               the target, heard through a band-pass that rides its 3rd harmonic, panned along a seeded path
  // Each leg's shape (curve exponent, sweep top, Q, interval, pan direction and rate) is seeded per leg.
  riser(E, g, e, when, off) {
    const D = e.dur;
    const T = D + 0.9;
    if (off > D) return null;
    const ctx = E.ctx;
    const wAt = (tau) => {
      const j = (e.t + tau - e.c0) * e.hz;
      const a = Math.floor(j);
      if (a < 0) return 0;
      if (a + 1 >= e.curve.length) return 0;
      // normalised to the leg's own peak: a short hop (inner planets) still sweeps the full spectrum; and it
      // anticipates: from the departure marker it already leans forward (up to 0.6 by peak speed), so the
      // seconds before the camera really accelerates are not a lull
      const x = Math.min(1, (e.curve[a] + (e.curve[a + 1] - e.curve[a]) * (j - a)) / Math.max(0.2, e.peak || 1));
      const lean = tau < tp ? 0.6 * Math.sqrt(Math.sin((Math.PI / 2) * Math.min(1, tau / Math.max(0.5, tp)))) : 0.6 * Math.max(0, 1 - (tau - tp) / Math.max(0.5, D - tp));
      return Math.max(x, lean);
    };
    const tp = e.wp - e.t;
    // the level holds after peak speed (the camera decelerates, the sweep and the doppler fall, but the gesture
    // keeps building into the reveal: ~-2 dB by the arrival, where the suck takes over)
    const wLvl = (tau) => (tau <= tp ? wAt(tau) : Math.max(wAt(tau), 1 - 0.22 * Math.min(1, (tau - tp) / Math.max(0.5, D - tp))));
    const ex = e.ex || 1.6,
      top = e.top || 9880,
      dir = e.dir || 1,
      pr = e.panRate || 1;
    const v = voice(E, g, 'sfx', 0);
    // the riser's level is the music's: the generation's K-weighted music follower (engine) drives this gain, so
    // every leg crests by the same amount over the music it leaves, measured, on any cut (e.vel is the gesture's
    // own scale); without a follower (an old engine) it falls back to unity
    if (g.follow) {
      v.env.gain.value = 0;
      g.follow.connect(v.env.gain);
      v.onDispose = () => g.follow.disconnect(v.env.gain);
    } else v.env.gain.setValueAtTime(1, when);
    // noise body
    const src = ctx.createBufferSource();
    src.buffer = E.buf.pink;
    src.loop = true;
    const hs = ctx.createBiquadFilter();
    hs.type = 'highshelf';
    hs.frequency.value = 2500;
    hs.gain.value = 12;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = e.q || 0.6;
    kRate(bp.frequency);
    const ng = gain(E, 0);
    src.connect(hs).connect(bp).connect(ng).connect(v.env);
    bp.frequency.setValueCurveAtTime(curveFrom((t) => 260 * Math.pow(top / 260, Math.min(1, wAt(t))), T, off, 40), when, T - off);
    ng.gain.setValueCurveAtTime(curveFrom((t) => G.riser * 1.26 * e.vel * Math.pow(t < D ? wLvl(t) : wAt(t), ex), T, off, 40), when, T - off);
    // air
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 5500;
    const ag = gain(E, 0);
    hs.connect(hp).connect(ag).connect(v.env);
    ag.gain.setValueCurveAtTime(curveFrom((t) => G.riser * 0.55 * e.vel * Math.pow(t < D ? wLvl(t) : wAt(t), 2.2), T, off, 40), when, T - off);
    // tonal doppler through a moving band-pass
    const f = mtof(e.midi);
    const cents = (t) => {
      const w = wAt(t);
      const rise = 1500 * Math.pow(w, 1.2);
      const fall = t > tp ? Math.pow(Math.min(1, (t - tp) / Math.max(0.3, D - tp)), 1.4) : 0;
      return rise * (1 - fall) + fall * ((e.toMidi - e.midi) * 100 - 700);
    };
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.Q.value = 1.6;
    kRate(band.frequency);
    const tg = gain(E, 0);
    const pan = ctx.createStereoPanner();
    kRate(pan.pan);
    band.connect(tg).connect(pan).connect(v.env);
    // one saw and a quieter one an interval above (fifth, fourth or octave), exactly in tune: a detuned pair heard
    // through a band-pass on its coinciding partials beats audibly
    const oscs = [osc(E, 'sawtooth', f), osc(E, 'sawtooth', f * (e.dop || 1.5))];
    const og = gain(E, 0.45);
    const detCurve = curveFrom(cents, T, off, 40);
    oscs.forEach((o, k) => {
      kRate(o.detune);
      (k ? o.connect(og) : o).connect(band);
      o.detune.setValueCurveAtTime(detCurve, when, T - off);
    });
    v.nodes.push(og);
    band.frequency.setValueCurveAtTime(curveFrom((t) => Math.min(9000, 2.5 * f * Math.pow(2, cents(t) / 1200)), T, off, 40), when, T - off);
    tg.gain.setValueCurveAtTime(curveFrom((t) => G.riser * 0.42 * e.vel * Math.pow(wAt(t), 1.5), T, off, 40), when, T - off);
    pan.pan.setValueCurveAtTime(curveFrom((t) => 0.6 * dir * Math.sin((2 * Math.PI * pr * t) / Math.max(2, D)), T, off, 40), when, T - off);
    src.start(when, (e.t * 0.37) % 4);
    src.stop(when + T - off + 0.02);
    v.nodes.push(hs, bp, ng, hp, ag, band, tg, pan, src);
    v.srcs.push(...oscs);
    return startAll(v, when, when + T - off + 0.02);
  },

  // Reverse-reverb "suck" into an arrival: the arriving chord's tones and a brightening breath of noise swell
  // from nothing on a reversed-decay curve and stop dead at the reveal (the hall rings on after the cut).
  suck(E, g, e, when, off) {
    if (off > 0.05) return null;
    const ctx = E.ctx;
    const D = e.dur;
    const v = voice(E, g, 'sfx', e.pan || 0);
    const peak = G.suck * e.vel;
    const src = ctx.createBufferSource();
    src.buffer = E.buf.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 0.8;
    kRate(bp.frequency);
    bp.frequency.setValueAtTime(700, when);
    bp.frequency.exponentialRampToValueAtTime(4800, when + D);
    const ng = gain(E, 0.55);
    src.connect(bp).connect(ng).connect(v.env);
    src.start(when, (e.t * 0.29) % 5, D + 0.1);
    const tones = e.tones || [];
    for (const m of tones) {
      const o = osc(E, 'sine', mtof(m)),
        o2 = osc(E, 'sine', 2 * mtof(m));
      const a = gain(E, 0.9 / Math.max(1, tones.length)),
        a2 = gain(E, 0.25 / Math.max(1, tones.length));
      o.connect(a).connect(v.env);
      o2.connect(a2).connect(v.env);
      v.srcs.push(o, o2);
      v.nodes.push(a, a2);
    }
    v.env.gain.setValueCurveAtTime(curveFrom((t) => peak * Math.pow(Math.max(0, t / D), 2.6), D, 0, 200), when, D);
    v.env.gain.linearRampToValueAtTime(0, when + D + 0.015);
    v.nodes.push(src, bp, ng);
    return startAll(v, when, when + D + 0.04);
  },

  // Arrival: sine sweep 92 -> 30 Hz with a felt-soft thump and a breath of air. Its size is the world's (the
  // composer scales e.vel by the world's impact); the attack is soft enough that it swells rather than slams.
  drop(E, g, e, when, off) {
    if (off > 0.3) return null;
    const ctx = E.ctx;
    const v = voice(E, g, 'sfxDry', 0);
    const o = osc(E, 'sine', 92),
      o2 = osc(E, 'sine', 184);
    o.frequency.setValueAtTime(92, when);
    o.frequency.exponentialRampToValueAtTime(30, when + 2.2);
    o2.frequency.setValueAtTime(184, when);
    o2.frequency.exponentialRampToValueAtTime(60, when + 2.2);
    const g2 = gain(E, 0.28);
    o.connect(v.env);
    o2.connect(g2).connect(v.env);
    const end = perc(v.env.gain, when, 0, 0.035, G.drop * e.vel, 0.75);
    const th = ctx.createBufferSource();
    th.buffer = E.buf.brown;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 170;
    const tg = gain(E, 0);
    perc(tg.gain, when, 0, 0.022, 0.3 * e.vel, 0.16);
    th.connect(lp).connect(tg).connect(v.steal);
    th.start(when, 1.3, 2);
    const air = ctx.createBufferSource();
    air.buffer = E.buf.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1300;
    bp.Q.value = 0.7;
    const ag = gain(E, 0);
    perc(ag.gain, when, 0, 0.25, 0.09 * e.vel, 0.7);
    air.connect(bp).connect(ag).connect(g.bus.sfx);
    air.start(when, 2.1, 6);
    v.srcs.push(o, o2);
    v.nodes.push(g2, lp, tg, th, bp, ag, air);
    return startAll(v, when, Math.max(end, when + 6));
  },

  // A rock passing close in the belt: band-passed noise with a doppler sweep and a pan across.
  whoosh(E, g, e, when, off) {
    if (off > 0.2) return null;
    const ctx = E.ctx;
    const v = voice(E, g, 'sfx', 0);
    const src = ctx.createBufferSource();
    src.buffer = E.buf.pink;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.1;
    kRate(bp.frequency);
    const pan = ctx.createStereoPanner();
    kRate(pan.pan);
    src.connect(bp).connect(pan).connect(v.env);
    const d = e.dur;
    bp.frequency.setValueCurveAtTime(curveFrom((t) => e.freq * (1.6 - 1.0 * (0.5 + 0.5 * Math.tanh((t / d - 0.5) * 6))), d, 0, 40), when, d);
    pan.pan.setValueCurveAtTime(curveFrom((t) => e.pan0 + (e.pan1 - e.pan0) * (0.5 + 0.5 * Math.tanh((t / d - 0.5) * 5)), d, 0, 40), when, d);
    v.env.gain.setValueCurveAtTime(curveFrom((t) => G.whoosh * e.vel * Math.exp(-Math.pow((t / d - 0.5) * 4.2, 2)), d, 0, 40), when, d);
    v.nodes.push(bp, pan);
    src.start(when, (e.freq * 0.001) % 5, d + 0.05);
    v.srcs.push(src);
    v.end = when + d + 0.05;
    return v;
  },
};
