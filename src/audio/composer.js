// The composer: turns the director's chapters + sampled cue track into a complete, deterministic score —
// a time-sorted list of note/SFX events plus continuous automation lanes. Pure JS (no WebAudio), so live
// playback, seeking and the offline renderer all play exactly the same piece.
import { WORLDS, FINAL_CHORD, ACCENTS, worldOf } from './worlds.js';
import { chord, voiceChord, stackVoicing, Rng, midi, mtof, mod12, THEMES, themeBeats, realize, noteName, parseTune } from './theory.js';

export const LANE_HZ = 20; // automation lane resolution (samples per journey second)
export const TAIL = 7; // seconds of music after the film's last frame (reverb and final release)

const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerp = (a, b, x) => a + (b - a) * x;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Every event carries a voice category (for voice limits) and whether it may be resumed mid-note after a seek.
const CAT = {
  pad: 'pad', choir: 'choir', sub: 'sub', bell: 'bell', glass: 'glass', piano: 'piano', grain: 'grain', pebble: 'grain',
  tick: 'grain', sparkle: 'grain', pluck: 'pluck', kick: 'sub', brass: 'brass', chirp: 'chirp', pmodes: 'drone', tone: 'drone',
  riser: 'sfx', drop: 'sfx', whoosh: 'sfx', suck: 'sfx', bow: 'bow',
};
const RELEASE_OF = (e) => (e.release ?? 0) + (e.ring ?? 0) + (e.decay ? e.decay * 1.2 : 0);

// ------------------------------------------------------------------------------------------- cues
// Warp legs from the sampled cue track: contiguous runs where shot.warp > threshold. Each run gets
//   ta     its arrival: when shot.audio.arrival first reaches 1 inside the run (the director's "the leg is over,
//          the world is framed" moment), else an 'arrive' cue, else the end of the run
//   leg    whether it really carries us to a new world (has an arrival) or is a cruise (sun reveal, pull-back)
//   curve  the *effective* warp the music follows: the raw warp until arrival, released quickly afterwards;
//          for cruises a fatigue envelope, so a 30 s pull-back at warp 1 doesn't keep a riser screaming
export function findWarps(cues) {
  const { hz, warp, arrival, departure } = cues;
  const N = warp.length;
  const runsOf = (thr) => {
    const segs = [];
    let s0 = -1;
    for (let i = 0; i <= N; i++) {
      const w = i < N ? warp[i] : 0;
      if (s0 < 0 && w > thr) s0 = i;
      else if (s0 >= 0 && w <= thr) {
        segs.push([s0, i]);
        s0 = -1;
      }
    }
    return segs;
  };
  // effective-warp segment builder: raw warp until the arrival, then a quick release; cruises tire out
  const build = (i0, i1, ta, leg) => {
    i0 = Math.max(0, i0);
    i1 = Math.min(N, i1);
    const ws = (i0 + 1) / hz;
    const ew = [];
    let epeak = 0,
      ep = ws,
      raw = 0;
    for (let i = i0; i < i1; i++) {
      const t = i / hz;
      let v = warp[i];
      raw = Math.max(raw, v);
      if (leg && t > ta) v *= Math.exp(-(t - ta) / 0.7);
      if (!leg) v *= t - ws < 7 ? 1 : Math.exp(-(t - ws - 7) / 4);
      ew.push(v);
      if (v > epeak) {
        epeak = v;
        ep = t;
      }
    }
    return { ws, we: i1 / hz, wp: ep, ta: leg ? ta : i1 / hz, leg, peak: epeak, rawPeak: raw, curve: ew, c0: i0 / hz, hz };
  };
  const out = [];
  if (arrival && departure) {
    // legs from the director's own departure -> arrival markers
    const rising = (arr) => {
      const r = [];
      for (let i = 1; i < N; i++) if (arr[i] >= 0.97 && arr[i - 1] < 0.97) r.push(i);
      if (arr[0] >= 0.97) r.unshift(0);
      return r;
    };
    const deps = rising(departure),
      arrs = rising(arrival);
    const legs = [];
    let prevEnd = 0;
    for (const d of deps) {
      const a = arrs.find((x) => x > d);
      if (a === undefined) continue;
      let s = d;
      while (s > prevEnd && warp[s] > 0.05) s--; // the riser starts where the speed-up starts
      let e = a;
      while (e < N - 1 && warp[e] > 0.03 && e - a < 12 * hz) e++;
      legs.push([s - 1, e + 1, a / hz]);
      prevEnd = a;
    }
    for (const [i0, i1, ta] of legs) out.push(build(i0, i1, ta, true));
    // whatever fast motion is left (approach reveals, the final pull-back) is a cruise
    for (const [a, b] of runsOf(0.03)) {
      let s = a;
      for (const [i0, i1] of legs) if (s >= i0 && s < i1 + 0.5 * hz) s = Math.max(s, i1 + 0.5 * hz);
      if (b - s < 0.8 * hz) continue;
      let pk = 0;
      for (let i = s; i < b; i++) pk = Math.max(pk, warp[i]);
      if (pk < 0.15 || legs.some(([i0, i1]) => s < i1 && b > i0)) continue;
      out.push(build(s - 1, b + 1, null, false));
    }
  } else {
    // plain directors: every sizeable warp run is a leg arriving at its end (or at an 'arrive' cue)
    const arriveCues = (cues.events || []).filter((e) => e.id === 'arrive').map((e) => e.t);
    const merged = [];
    for (const s of runsOf(0.03)) {
      const last = merged[merged.length - 1];
      if (last && (s[0] - last[1]) / hz < 0.6) last[1] = s[1];
      else merged.push(s.slice());
    }
    for (const [a, b] of merged) {
      let pk = 0;
      for (let i = a; i < b; i++) pk = Math.max(pk, warp[i]);
      if (pk < 0.15 || (b - a) / hz < 0.8) continue;
      const c = arriveCues.find((t) => t >= a / hz && t <= b / hz + 1);
      out.push(build(a - 1, b + 1, c !== undefined ? c : b / hz, true));
    }
  }
  return out.filter((w) => w.peak >= 0.15).sort((p, q) => p.ws - q.ws);
}
// the first time a warp leg's (effective) speed reaches `frac` of its peak
function warpReach(w, frac) {
  for (let i = 0; i < w.curve.length; i++) if (w.curve[i] >= frac * w.peak) return w.c0 + i / w.hz;
  return w.wp;
}
function effectiveWarpAt(warps, t) {
  for (const w of warps) {
    const end = w.c0 + (w.curve.length - 1) / w.hz;
    if (t < w.c0 || t > end) continue;
    const j = (t - w.c0) * w.hz,
      k = Math.floor(j);
    if (k + 1 >= w.curve.length) return w.curve[w.curve.length - 1] || 0;
    return w.curve[k] + (w.curve[k + 1] - w.curve[k]) * (j - k);
  }
  return 0;
}

// ------------------------------------------------------------------------------------------- sections
function buildSections(chapters, duration, warps) {
  let spans = chapters
    .map((c, i) => {
      const t1 = c.t1 ?? duration;
      return { world: worldOf(c), t0: clamp(c.t0, 0, duration), t1: clamp(t1, 0, duration), chapters: [{ id: c.id, title: c.title, index: i, t0: c.t0, t1 }] };
    })
    .filter((s) => s.t1 > s.t0)
    .sort((a, b) => a.t0 - b.t0);
  if (!spans.length) spans = [{ world: 'transit', t0: 0, t1: duration, chapters: [] }];
  spans[0].t0 = 0;
  for (let i = 0; i < spans.length - 1; i++) spans[i].t1 = spans[i + 1].t0;
  spans[spans.length - 1].t1 = duration;
  // merge consecutive chapters that map to the same world
  const merged = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && last.world === s.world) {
      last.t1 = s.t1;
      last.chapters.push(...s.chapters);
    } else merged.push(s);
  }
  // Move each boundary onto the arrival of the warp leg that carries us across it: the departing world's
  // music rides the leg out, and the next world blooms the moment it is framed.
  const used = new Set();
  for (let i = 0; i < merged.length - 1; i++) {
    const A = merged[i],
      B = merged[i + 1];
    const b = A.t1;
    const lb = B.t1 - B.t0;
    let best = null,
      bestD = Infinity;
    for (const w of warps) {
      if (used.has(w) || !w.leg) continue;
      if (w.ta > B.t0 + 0.6 * lb) continue; // the arrival must fall early in the next chapter
      const d = b < w.ws ? w.ws - b : b > w.ta ? b - w.ta : 0;
      if (d <= 4 && d < bestD) {
        best = w;
        bestD = d;
      }
    }
    if (best) {
      used.add(best);
      const nb = clamp(best.ta, A.t0 + 2, B.t1 - 2);
      A.t1 = B.t0 = nb;
      A.depart = best;
      B.arrive = best;
    }
  }
  for (const s of merged) {
    s.cruiseEnd = s.depart ? clamp(s.depart.ws + 0.25 * (s.depart.ta - s.depart.ws), s.t0 + 1, s.t1) : s.t1;
    s.W = WORLDS[s.world];
  }
  return merged;
}

// ------------------------------------------------------------------------------------------- harmony
// The progression is laid over the section's cruise time. Worlds may pin a chord to a named film cue
// (`anchors: { eclipse: 4 }` = chord 4 starts exactly on the eclipse), so the motif lands on the picture.
//
// When a segment has less time than its chords need, fit() decides what to play. It never keeps a prefix:
//   - a segment may run its chords faster (down to 0.7x chordDur, 0.5x in front of an anchor) before losing any
//   - the first chord, the LAST chord of a segment that leads into an anchor (the dominant that prepares the
//     arrival), and the world's cadence are always kept
//   - the remaining chords are kept in order of their priority `p` (worlds.js), in their written order
function fit(chords, L, W, cadence, lastSeg, preAnchor, lined = new Set(), must = new Set()) {
  const len = chords.length;
  const cad = lastSeg && cadence ? 1 : 0;
  // chords a tune is written over (worlds.js `tunes`) are always kept, in order, and never repeated
  const mustN = chords.filter((c) => must.has(c.idx)).length;
  let n = Math.max(1, Math.round(L / W.chordDur));
  const want = len + cad;
  if (n < want) n = Math.min(want, Math.max(n, Math.floor(L / (W.chordDur * (W.compress ?? (preAnchor ? 0.5 : 0.7))) + 1e-6)));
  if (cad && n === 1 && L > 0.9 * W.chordDur) n = 2;
  n = Math.max(n, mustN + (cad ? 1 : 0));
  const slots = cad && n >= 2 ? n - 1 : n;
  let seq;
  if (slots >= len) {
    seq = chords.slice();
    // a long segment repeats the body of the progression (never its last chord), so it still ends where written
    if (slots >= 2 * len - 1 && len >= 3 && !mustN) seq = [...chords.slice(0, len - 1), ...chords];
  } else {
    const keep = new Set([0]);
    for (let i = 0; i < len; i++) if (must.has(chords[i].idx)) keep.add(i);
    if (preAnchor && slots >= 2) keep.add(len - 1);
    const rest = chords.map((_, i) => i).filter((i) => !keep.has(i)).sort((a, b) => chords[b].p - chords[a].p || a - b);
    for (const i of rest) {
      if (keep.size >= slots) break;
      keep.add(i);
    }
    seq = [...keep].sort((a, b) => a - b).map((i) => chords[i]);
  }
  if (cad && n >= 2) seq.push(cadence);
  // never sound the same chord twice in a row: merge the repeat into one longer chord
  const out = [];
  for (const c of seq) {
    const last = out[out.length - 1];
    if (last && last.name === c.name && last.bass === c.bass && !lined.has(c.idx) && !must.has(c.idx)) out[out.length - 1] = { ...last, w: last.w + c.w };
    else out.push(c);
  }
  return out;
}

// The written chords a world's tunes span (worlds.js `tunes`), as { idxs, parsed, spec }: `span: [a, b]` runs from
// written chord a to b, where b may be 'cad' (the world's cadence closes the tune).
function tuneSpans(W) {
  return (W.tunes || []).map((spec) => {
    const parsed = parseTune(spec.tune);
    const [a, b] = spec.span;
    const idxs = [];
    for (let i = a; i <= (b === 'cad' ? W.prog.length - 1 : b); i++) idxs.push(i);
    if (b === 'cad') idxs.push('cad');
    if (idxs.length !== parsed.bars.length) throw new Error(`tune ${spec.tune}: ${parsed.bars.length} bars over ${idxs.length} chords`);
    return { spec, parsed, idxs };
  });
}
// a spanned chord's weight in its segment: the time its bar needs at the tune's own tempo, in units of the
// world's chordDur (the unit every other chord's `w` is written in)
function spanWeights(W, spans) {
  const m = new Map();
  for (const sp of spans) sp.idxs.forEach((idx, k) => m.set(idx, (sp.parsed.bars[k] * sp.parsed.beat) / W.chordDur));
  return m;
}
function chordTimeline(sec, prevChord, nextSec, isLast, cueTimes) {
  const W = sec.W;
  const segs = [];
  if (sec.world === 'transit' || !W.prog.length) {
    // pivot: the tones shared by where we were and where we are going
    const nextFirst = nextSec && nextSec.W.prog.length ? chord(nextSec.W.prog[0]) : null;
    const a = prevChord ? prevChord.pcs : [2, 9, 4];
    const b = nextFirst ? nextFirst.pcs : a;
    let common = a.filter((p) => b.includes(p));
    if (common.length < 2) common = [...new Set([...a.slice(0, 2), ...b.slice(0, 2)])];
    const name = 'pivot (' + common.map((p) => noteName(p + 60).replace(/-?\d+$/, '')).join(' ') + ')';
    segs.push({ t0: sec.t0, t1: sec.cruiseEnd, seq: [{ name, bass: prevChord ? prevChord.bass : midi('D2'), pcs: common, req: common.slice(0, 3), idx: 'pivot', w: 1 }] });
  } else {
    // a tune claims its chords only if the time it would get can hold it at 0.6x of its written tempo or slower
    // (otherwise it gives way to its fragments, and its chords are fitted like any others)
    const spanTime = (sp) => {
      const first = sp.idxs[0];
      const after = Object.entries(W.anchors || {}).filter(([cue, idx]) => idx <= first && cueTimes[cue] !== undefined && cueTimes[cue] > sec.t0 + 3 && cueTimes[cue] < sec.cruiseEnd - 2);
      const t0 = after.length ? Math.max(...after.map(([cue]) => cueTimes[cue])) : sec.t0;
      const next = Object.entries(W.anchors || {}).filter(([cue, idx]) => idx > first && cueTimes[cue] !== undefined && cueTimes[cue] > t0 + 1 && cueTimes[cue] < sec.cruiseEnd - 2).map(([cue]) => cueTimes[cue]);
      return (next.length ? Math.min(...next) : sec.cruiseEnd) - t0;
    };
    const spans = tuneSpans(W).filter((sp) => spanTime(sp) >= 0.6 * sp.parsed.total * sp.parsed.beat);
    const sw = spanWeights(W, spans);
    const must = new Set(sw.keys());
    const prog = W.prog.map((spec, i) => ({ ...chord(spec), idx: i, ...(sw.has(i) ? { w: sw.get(i) } : {}) }));
    const cadence = !isLast && W.cadence ? { ...chord(W.cadence), idx: 'cad', ...(sw.has('cad') ? { w: sw.get('cad') } : {}) } : null;
    const lined = new Set((W.lines || []).map((l) => l.at));
    const cuts = [];
    for (const [name, idx] of Object.entries(W.anchors || {})) {
      const t = cueTimes[name];
      if (t !== undefined && t > sec.t0 + 3 && t < sec.cruiseEnd - 2 && idx > 0 && idx < prog.length) cuts.push({ t, idx });
    }
    cuts.sort((p, q) => p.t - q.t);
    let ta = sec.t0,
      ia = 0;
    sec.anchorChecks = [];
    for (const c of cuts) {
      if (c.idx <= ia) continue;
      const seq = fit(prog.slice(ia, c.idx), c.t - ta, W, null, false, true, lined, must);
      segs.push({ t0: ta, t1: c.t, seq });
      // the chord heard just before an anchored arrival must be the one written before it (its preparation)
      const cue = Object.keys(W.anchors).find((k) => W.anchors[k] === c.idx && cueTimes[k] === c.t);
      sec.anchorChecks.push({ cue, at: c.t, anchor: prog[c.idx].name, before: seq[seq.length - 1].name, expected: prog[c.idx - 1].name, ok: seq[seq.length - 1].name === prog[c.idx - 1].name });
      ta = c.t;
      ia = c.idx;
    }
    segs.push({ t0: ta, t1: sec.cruiseEnd, seq: fit(prog.slice(ia), sec.cruiseEnd - ta, W, cadence, true, false, lined, must) });
  }
  if (isLast) {
    const last = segs[segs.length - 1];
    if (!last.seq[last.seq.length - 1].final) {
      const fin = { ...chord(FINAL_CHORD), idx: 'final', w: 2.5 };
      if (last.seq.length >= 3) last.seq[last.seq.length - 1] = fin;
      else if (last.t1 - last.t0 > 9) last.seq.push(fin);
      else last.seq = [fin];
    }
  }
  const out = [];
  segs.forEach((sg, si) => {
    const Ls = Math.max(0.5, sg.t1 - sg.t0);
    const wsum = sg.seq.reduce((a, c) => a + c.w, 0);
    // a world with a pulse (Mars) changes chord on bar lines: whole bars per chord (largest remainder), the
    // segment's last chord absorbing what is left of the segment
    let bars = null;
    if (W.grid) {
      const nb = Math.max(sg.seq.length, Math.round(Ls / W.grid));
      // cumulative rounding: bar lines at round(cumulative weight), each chord at least one bar
      bars = [];
      let cum = 0,
        prevB = 0;
      sg.seq.forEach((c, k) => {
        cum += c.w;
        let b = Math.max(prevB + 1, Math.round((cum / wsum) * nb));
        b = Math.min(b, nb - (sg.seq.length - 1 - k));
        bars.push(b - prevB);
        prevB = b;
      });
    }
    let t = sg.t0;
    sg.seq.forEach((c, k) => {
      const d = bars ? (k === sg.seq.length - 1 ? sg.t1 - t : bars[k] * W.grid) : (Ls * c.w) / wsum;
      const lastOfAll = si === segs.length - 1 && k === sg.seq.length - 1;
      out.push({ t0: t, t1: lastOfAll ? sec.t1 : t + d, cruise1: t + d, chord: c, k: out.length });
      t += d;
    });
  });
  return out;
}

// ------------------------------------------------------------------------------------------- generators
// Each generator reads one world layer's parameters and emits events into the section.
function makeEmitter(list, sec) {
  return (e) => {
    e.cat = CAT[e.type];
    e.end = e.t + (e.dur || 0) + RELEASE_OF(e);
    e.sec = sec.index;
    list.push(e);
  };
}
function chordAt(chords, t) {
  for (const c of chords) if (t < c.t1) return c;
  return chords[chords.length - 1];
}
function tonesIn(c, lo, hi) {
  const pcs = new Set([...c.chord.pcs, mod12(c.chord.bass)]);
  const out = [];
  for (let m = lo; m <= hi; m++) if (pcs.has(mod12(m))) out.push(m);
  return out;
}
const PANS = [-0.5, 0.42, -0.22, 0.28, -0.05];
// a chord's k voices alternate sides by pitch order with zero mean (any k), so a 3-voice chord does not lean
const PANS_K = [null, [0], [-0.35, 0.35], [-0.42, 0.42, 0], [-0.45, 0.4, -0.25, 0.3], PANS.map((p) => p + 0.014)];
// a voice's pan, narrowed toward the centre in the low register (the low end stays mono-compatible)
const panFor = (i, m, jitter, k = 5) => clamp(((PANS_K[Math.min(5, Math.max(1, k))] || PANS)[i] + jitter) * clamp((m - 50) / 20, 0, 1), -0.8, 0.8);

// Which of a chord's n voices (bottom = 0) a layer written for five voices plays: the layer's slots are mapped
// proportionally, so a layer of the top three voices of a 5-voice chord plays the top two of a 3-voice chord.
function slotsFor(voices, n) {
  if (n >= 5) return voices.filter((v) => v < n);
  return [...new Set(voices.map((v) => Math.round((v * (n - 1)) / 4)))].sort((a, b) => a - b);
}
export const vAt = (c, i) => c.voicing[Math.max(0, Math.min(c.voicing.length - 1, i))];

// Sustained layer: the chord's voicing (3-5 voices) as notes; a pitch present in consecutive chords is held
// through the change (common tones: true legato voice leading), others end and begin at the change.
// A layer's edges: a fraction of the section, or a film cue with an offset ('eclipse-1' = 1 s before the eclipse).
function edgeAt(S, x, dflt) {
  const { sec } = S;
  const L = sec.t1 - sec.t0;
  if (x === undefined || x === null) return dflt;
  if (typeof x === 'number') return sec.t0 + x * L;
  const m = /^(.*?)([+-]d+(?:.d+)?)?$/.exec(String(x));
  const t = S.cueTimes && S.cueTimes[m[1]];
  return t === undefined ? dflt : clamp(t + Number(m[2] || 0), sec.t0, sec.t1);
}

function genSustained(S, P, type) {
  const { sec, chords, rng } = S;
  // every note of the layer is collected, then the layer is re-centred: held common tones keep the pan they
  // started with, so over a world a layer can lean to one side; its energy-weighted mean pan is removed
  const mine = [];
  const emit = (e) => {
    mine.push(e);
    S.emit(e);
  };
  const w0 = edgeAt(S, P.from, sec.t0),
    w1 = edgeAt(S, P.to, sec.t1);
  const flush = (cur) => {
    const a = Math.max(cur.start, w0),
      b = Math.min(cur.end, w1);
    if (b - a < 0.8) return;
    const atk = cur.bloom ? Math.min(P.attack, 1.6) : cur.pivot ? Math.min(P.attack, 0.9) : P.attack;
    const lead = cur.first ? 0 : Math.min(0.4 * atk, 1.6);
    const t = Math.max(0, a - lead);
    // clear the stage: a voice within an octave below a melody phrase that ends just before or during it
    // lets go in ~1.5 s instead of ringing on under the tune
    const inPhrase = S.phrases.some((ph) => ph.weight > 0 && b > ph.t0 - 1.5 && b < ph.t1 && cur.midi >= ph.lo - 12);
    emit({
      type, t, dur: b - t, midi: cur.midi, attack: atk, release: inPhrase ? Math.min(P.release, 1.5) : P.release,
      vel: P.vel * (cur.top ? 1 : 0.82) * (0.95 + 0.05 * rng.next()),
      pan: clamp(panFor(cur.i, cur.midi, rng.range(-0.06, 0.06), cur.k) - cur.bias, -0.8, 0.8),
      wave: P.wave, detune: P.detune, drift: P.drift, lfo: P.lfo * rng.range(0.8, 1.25),
      // the sub-octave only under the lowest voice, and only when it is high enough not to growl
      subOct: P.subOct && cur.low && cur.midi >= 50, tremolo: P.tremolo, ens: P.ens,
      seed: rng.int(0, 1e9),
    });
  };
  const active = new Map();
  for (const c of chords) {
    const set = slotsFor(P.voices, c.voicing.length).map((i) => c.voicing[i] + (P.oct || 0));
    // the chord's pans sum to zero after the low-register narrowing (otherwise a chord leans to one side)
    // (weighted like the voices' levels: the top voice is the loudest)
    const wt = (i) => (i === set.length - 1 ? 1 : 0.67);
    const bias = set.reduce((acc, m, i) => acc + wt(i) * panFor(i, m, 0, set.length), 0) / set.reduce((acc, _, i) => acc + wt(i), 0);
    for (const [m, cur] of active)
      if (!set.includes(m)) {
        flush(cur);
        active.delete(m);
      }
    set.forEach((m, i) => {
      const cur = active.get(m);
      if (cur) {
        cur.end = c.t1;
        cur.top = cur.top || i === set.length - 1;
      } else active.set(m, { midi: m, start: c.t0, end: c.t1, bloom: c.k === 0 && !!sec.arrive, first: c.k === 0, pivot: !!c.pivot, top: i === set.length - 1, low: i === 0, i, k: set.length, bias });
    });
  }
  for (const cur of active.values()) flush(cur);
  let wsum = 0,
    psum = 0;
  for (const e of mine) {
    const wgt = e.vel * e.vel * e.dur * clamp((e.midi - 50) / 20, 0, 1);
    wsum += wgt;
    psum += wgt * e.pan;
  }
  if (wsum > 0) for (const e of mine) e.pan = clamp(e.pan - psum / wsum, -0.85, 0.85);
}

function genSub(S, P) {
  const { sec, chords, emit } = S;
  let cur = null;
  const flush = () => {
    if (!cur) return;
    emit({ type: 'sub', t: cur.start, dur: cur.end - cur.start, midi: cur.midi, attack: cur.bloom ? 1.2 : P.attack, release: P.release, vel: P.vel });
  };
  for (const c of chords) {
    let m = c.chord.bass;
    while (m > 40) m -= 12; // E2 at most: the sub sits between ~44 and ~82 Hz
    while (m < 29) m += 12;
    if (cur && cur.midi === m) {
      cur.end = c.t1;
      continue;
    }
    flush();
    cur = { midi: m, start: c.t0, end: c.t1, bloom: c.k === 0 && !!sec.arrive };
  }
  flush();
}

// (every texture rides the departure leg out by default: the world's sound thins into the riser instead of
// stopping when the camera starts to move)
function poisson(S, rate, from, to, fn, shape = true, ride = true) {
  const { sec, rng } = S;
  // a texture that `ride`s keeps going through the departure leg until just before the next world appears
  const L = (ride && sec.depart ? Math.max(sec.cruiseEnd, sec.depart.ta - 1) : sec.cruiseEnd) - sec.t0;
  const a = sec.t0 + (from ?? 0) * L,
    b = sec.t0 + (to ?? 1) * L;
  let t = a + rng.exp(rate) * 0.5;
  while (t < b) {
    const u = (t - sec.t0) / Math.max(1e-3, L);
    const dens = shape ? 0.45 + 0.55 * Math.sin(Math.PI * clamp(u, 0, 1)) : 1;
    if (rng.next() < dens) fn(t, u);
    t += rng.exp(rate);
  }
}

function genBells(S, P) {
  const { chords, rng, emit } = S;
  let side = 1;
  poisson(S, P.rate / ((P.phrase[0] + P.phrase[1]) / 2), P.from, P.to, (t0) => {
    side = -side;
    const n = rng.int(P.phrase[0], P.phrase[1]);
    const c = chordAt(chords, t0);
    const tones = tonesIn(c, P.range[0], P.range[1]);
    if (!tones.length) return;
    let idx = rng.int(0, tones.length - 1);
    let t = t0;
    for (let k = 0; k < n; k++) {
      const pan = P.rotate ? 0.75 * Math.sin((2 * Math.PI * t) / 9.3) : (k % 2 ? 1 : -1) * side * rng.range(0.15, 0.7);
      emit({ type: 'bell', t, midi: tones[idx], vel: P.vel * rng.range(0.6, 1) * (k === 0 ? 1 : 0.85), ratio: P.ratio, index: P.index, decay: P.decay * rng.range(0.8, 1.2), pan });
      idx = clamp(idx + rng.pick([-2, -1, 1, 1, 2]), 0, tones.length - 1);
      t += rng.range(P.gap[0], P.gap[1]);
    }
  });
}

function genGlass(S, P) {
  const { chords, rng, emit } = S;
  let side = 1;
  poisson(S, P.rate, P.from, P.to, (t) => {
    const c = chordAt(chords, t);
    const tones = tonesIn(c, P.range[0], P.range[1]);
    if (!tones.length) return;
    const m = rng.pick(tones);
    side = -side; // alternate sides: random pans in a sparse passage tip the balance
    const pan = side * rng.range(0.2, 0.7);
    emit({ type: 'glass', t, midi: m, vel: P.vel * rng.range(0.6, 1), decay: P.decay * rng.range(0.8, 1.2), pan });
    if (P.dyad) emit({ type: 'glass', t: t + rng.range(0.0, 0.05), midi: m + P.dyad, vel: P.vel * 0.7 * rng.range(0.6, 1), decay: P.decay, pan: -pan });
  });
}

// ------------------------------------------------------------------------------------------- melody
// The thematic plan (worlds.js `lines`): every line hangs on a chord of the world's written progression (by its
// index, or 'cad' for the cadence), starts `delay` s into it, and is a theme from theory.js THEMES realised in a
// mode from a start note. The beat is the line's own (or fitted to its chord) and is compressed, never
// truncated, if the next line or the departure comes sooner; a line with no room is skipped, so the plan adapts
// to whatever chapter times the director provides.
const INST_TYPE = { piano: 'piano', voice: 'choir', horn: 'brass', bell: 'bell', glass: 'glass', cello: 'bow' };
const LEADS = new Set(['piano', 'choir', 'brass', 'bow']);
// The closing phrase when the film happens to end in a world without one (fallback timing).
const FINAL_LINE = { theme: 'END', from: 'F#5', scale: 'D major', inst: ['piano'], beat: 0.95, lh: true, coda: true, role: 'theme' };
export const LEAD_GAIN = 1.41; // theme statements are mixed as leads (+3 dB); fragments sit a little lower

// The long tunes (theory.js TUNES, placed by worlds.js `tunes`): each bar is laid over its chord of the span, so
// the tune's tempo is the span's own (chordTimeline gave every spanned chord the time its bar needs; a cut that
// stretches or squeezes the span stretches or squeezes the tempo, within 0.6-1.6x of the written beat, or the
// tune gives way to its `alt` fragments). A note may tie over a bar line; its end is mapped through both bars.
// Every part becomes one phrase per instrument: the melody (lead), a counter-melody (`counter`: inside the
// accompaniment's register, so the pads avoid its notes rather than lowering their ceiling under it), and any
// doubling instrument (`from`/`to` bars: the voice joining the piano on the pale blue dot).
function realizeTunes(sections) {
  const phrases = [];
  const failed = [];
  for (const s of sections) {
    for (const sp of tuneSpans(s.W)) {
      const { spec, parsed, idxs } = sp;
      const k0 = s.chords.findIndex((c) => c.chord.idx === idxs[0]);
      const bars = k0 < 0 ? null : idxs.map((idx, k) => s.chords[k0 + k]).filter((c, k) => c && c.chord.idx === idxs[k]);
      if (!bars || bars.length !== idxs.length) {
        failed.push({ s, spec, why: 'span chords missing' });
        continue;
      }
      const beats = bars.map((c, k) => (c.cruise1 - c.t0) / parsed.bars[k]);
      const ratio = beats.map((b) => b / parsed.beat);
      if (ratio.some((r) => r < 0.6 || r > 1.6)) {
        failed.push({ s, spec, why: `tempo ${ratio.map((r) => r.toFixed(2)).join('/')}` });
        continue;
      }
      // absolute beat -> journey time, bar by bar
      const at = (b) => {
        let k = parsed.starts.length - 1;
        while (k > 0 && parsed.starts[k] > b + 1e-9) k--;
        return bars[k].t0 + (b - parsed.starts[k]) * beats[k];
      };
      const barOf = (b) => {
        let k = parsed.starts.length - 1;
        while (k > 0 && parsed.starts[k] > b + 1e-9) k--;
        return k;
      };
      for (const part of spec.parts) {
        const notes = parsed.parts[part.part];
        if (!notes) throw new Error(`tune ${spec.tune}: no part ${part.part}`);
        const ev = notes
          .filter((n) => {
            const k = barOf(n.on);
            return k >= (part.from ?? 0) && k <= (part.to ?? Infinity);
          })
          .map((n) => ({ t: at(n.on), midi: n.midi + 12 * (part.oct || 0), dur: at(n.on + n.dur) - at(n.on), acc: n.acc, app: n.app, bar: barOf(n.on) }));
        if (!ev.length) continue;
        const counter = part.part !== 'mel';
        const inst = INST_TYPE[part.inst];
        const last = ev[ev.length - 1];
        const ns = ev.map((n) => n.midi);
        phrases.push({
          t0: ev[0].t, t1: last.t + last.dur, notes: ns, lo: Math.min(...ns), hi: Math.max(...ns), ev, inst,
          duet: !counter && !!part.double, counter, tune: true, role: 'theme', lead: LEADS.has(inst),
          // the melody makes the accompaniment step back fully; a counter-melody is part of the accompaniment
          weight: counter || part.double ? 0 : spec.duck ?? 1,
          name: spec.tune + (counter ? '.' + part.part : ''), world: s.world, sec: s.index, chord: bars[0].chord.name,
          line: { ...spec, ...part, role: 'theme' }, beat: beats.reduce((a, b) => a + b, 0) / beats.length, c: bars[0], bars,
        });
      }
    }
  }
  return { phrases, failed };
}

function realizeLines(sections, total, tunes = { phrases: [], failed: [] }) {
  const phrases = [];
  sections.forEach((s, si) => {
    const lines = (s.W.lines || []).slice();
    // a tune that could not be laid out for this cut gives way to its fragments
    for (const f of tunes.failed) if (f.s === s && f.spec.alt) lines.push(...f.spec.alt);
    const lastChord = s.chords[s.chords.length - 1];
    const tuneHere = tunes.phrases.filter((p) => p.sec === s.index && !p.counter && !p.duet);
    if (si === sections.length - 1 && lastChord.chord.final && !lines.some((l) => l.at === lastChord.chord.idx) && !tuneHere.some((p) => p.bars.includes(lastChord))) lines.push({ ...FINAL_LINE, at: lastChord.chord.idx });
    const items = [];
    for (const ln of lines) {
      const c = s.chords.find((ch) => ch.chord.idx === ln.at);
      if (!c) continue; // its chord was not kept for this timing
      const cd = c.cruise1 - c.t0;
      const t = c.t0 + (ln.delay ?? Math.min(0.7, 0.1 * cd));
      if (tuneHere.some((p) => t > p.t0 - 1 && t < p.t1 + 0.3)) continue; // a tune is sounding: it is the melody
      items.push({ ln, c, t });
    }
    // fragments end before a tune begins (the tune is the line they lead into)
    for (const p of tuneHere) items.push({ wall: true, t: p.t0 });
    items.sort((a, b) => a.t - b.t);
    items.forEach((it, i) => {
      if (it.wall) return;
      const { ln, c } = it;
      const beats = themeBeats(THEMES[ln.theme]);
      const cd = c.cruise1 - c.t0;
      let beat = (ln.beat ?? clamp((cd * 0.82) / beats, 0.5, 1.1)) * (ln.aug || 1);
      const nominal = beat;
      const next = items.slice(i + 1).find((x) => x.t > it.t + 0.5);
      // a line ends before the next one, and before the camera leaves the world (the leg belongs to the riser)
      // (a line marked `ride` may carry its last note into the leg: a farewell the riser builds under)
      // (riding: until the camera really accelerates, i.e. the leg's warp reaches half its peak)
      const limit = Math.min(next ? next.t - 0.3 : Infinity, ln.coda ? total - 1.5 : s.depart ? (ln.ride ? Math.min(s.depart.ta - 1, Math.max(s.depart.ws + 0.45 * (s.depart.ta - s.depart.ws), warpReach(s.depart, 0.5))) : s.depart.ws - 1.0) : s.cruiseEnd + 0.6);
      beat = Math.min(beat, (limit - it.t) / beats);
      if (beat < Math.max(0.35, 0.55 * nominal)) return;
      const ev = realize(ln.theme, { from: ln.from, scale: ln.scale, inv: ln.inv }).map((n) => ({ t: it.t + n.on * beat, midi: n.midi + 12 * (ln.oct || 0), dur: n.dur * beat, acc: n.acc, app: n.app }));
      // a sustained line that rides the departure holds its last note into the leg: the riser builds under it
      if (ln.ride && s.depart && (ln.inst === 'horn' || ln.inst === 'voice')) {
        const lastN = ev[ev.length - 1];
        lastN.dur = Math.max(lastN.dur, limit - lastN.t);
      }
      // a long note never sustains into a later chord it would rub against (a minor ninth over the new bass, or a
      // non-chord tone a semitone from one): it lets go at the change (this matters when timings are compressed)
      if (!ln.clash)
        for (const n of ev)
          for (const c2 of s.chords) {
            if (c2 === c || c2.t0 <= n.t + 0.05 || c2.t0 >= n.t + n.dur) continue;
            const pcs = new Set([...c2.chord.pcs, mod12(c2.chord.bass)]);
            const pc = mod12(n.midi);
            const rub = mod12(n.midi - c2.chord.bass) === 1 || (!pcs.has(pc) && (pcs.has((pc + 1) % 12) || pcs.has((pc + 11) % 12)));
            if (rub) n.dur = Math.max(0.25, c2.t0 - n.t - 0.05);
          }
      const insts = (Array.isArray(ln.inst) ? ln.inst : [ln.inst]).map((x) => INST_TYPE[x]);
      const last = ev[ev.length - 1];
      const notes = ev.map((n) => n.midi);
      insts.forEach((inst, k) =>
        phrases.push({
          t0: ev[0].t, t1: last.t + last.dur, notes, lo: Math.min(...notes), hi: Math.max(...notes), ev, inst, duet: k > 0,
          role: ln.role || 'frag', lead: LEADS.has(inst),
          // how hard the accompaniment makes room (motif lanes): a statement fully, a fragment half, bells/glass not
          weight: LEADS.has(inst) ? (ln.duck ?? (ln.role === 'theme' ? 1 : 0.5)) : 0,
          name: ln.theme, world: s.world, sec: s.index, chord: c.chord.name, line: ln, beat, c,
        })
      );
    });
  });
  return phrases.sort((a, b) => a.t0 - b.t0);
}

function emitLines(sections, phrases, events) {
  for (const p of phrases) {
    const s = sections[p.sec];
    const rng = new Rng(`four-light-hours/line/${p.world}/${p.name}/${p.t0.toFixed(2)}/${p.inst}`);
    const emit = makeEmitter(events, s);
    const ln = p.line;
    const Ly = s.W.layers;
    const v = ln.vel ?? 1;
    const theme = p.role === 'theme';
    // lines alternate sides: each instrument's phrases in a world take turns left and right
    const same = phrases.filter((q) => q.sec === p.sec && q.inst === p.inst && !q.duet);
    const panSide = (p.sec % 2 ? 1 : -1) * (same.indexOf(p) % 2 ? 1 : -1) * rng.range(0.1, 0.3);
    if (p.inst === 'piano') {
      const base = (Ly.piano ? Ly.piano.vel : 0.8) * (theme ? LEAD_GAIN : 1.3) * v;
      p.ev.forEach((n, i) => {
        // agogic accent: in a statement the leap to the high note leans a touch late, as a pianist would
        const lean = theme && (p.tune ? n.acc >= 1 : i === 1) ? 0.045 : 0;
        // a tune is pedalled with its harmony: each note rings on until a little after its chord changes
        let ring = Math.max(2.5, n.dur + 2.5);
        if (p.tune) {
          const endBar = p.bars.findIndex((c) => c.t0 > n.t + n.dur - 0.05);
          const pedal = (endBar > 0 ? p.bars[endBar - 1] : p.bars[p.bars.length - 1]).cruise1 + 0.35;
          ring = clamp(pedal - n.t, n.dur + 0.25, n.dur + 3.5);
        }
        emit({ type: 'piano', t: n.t + lean + rng.gauss() * 0.008, midi: n.midi, vel: base * n.acc * rng.range(0.93, 1.02), ring, pan: 0.03, motif: true, lead: true, rr: i % 2 });
      });
      if (ln.lh && p.tune) {
        // left hand, bar by bar: the bass an octave up on the change, a soft inner voice after it
        const pv = (Ly.piano ? Ly.piano.vel : 0.8) * v;
        p.bars.forEach((c, k) => {
          if (k < (ln.from ?? 0) || !c.voicing) return;
          let lb = c.chord.bass;
          while (lb < 38) lb += 12;
          const cd = c.cruise1 - c.t0;
          emit({ type: 'piano', t: c.t0 - 0.02, midi: lb, vel: pv * 0.4, ring: Math.min(8, cd + 0.4), pan: -0.06 });
          emit({ type: 'piano', t: c.t0 + Math.min(0.45, 0.12 * cd), midi: vAt(c, 1), vel: pv * 0.26, ring: Math.min(6, cd + 0.3), pan: -0.05 });
        });
      } else if (ln.lh && p.c.voicing) {
        // left hand: the bass an octave up, and a soft inner voice
        let lb = p.c.chord.bass;
        while (lb < 38) lb += 12;
        const pv = (Ly.piano ? Ly.piano.vel : 0.8) * v;
        emit({ type: 'piano', t: p.t0 - 0.02, midi: lb, vel: pv * 0.42, ring: ln.coda ? 8 : 5, pan: -0.06 });
        if (!ln.coda) emit({ type: 'piano', t: p.t0 + 0.33, midi: vAt(p.c, 1), vel: pv * 0.3, ring: 4.5, pan: -0.05 });
      }
      if (ln.coda) {
        // the last word: a high pale bell (the pale blue dot), then the Sun's Lydian fourth on glass
        const last = p.ev[p.ev.length - 1];
        emit({ type: 'bell', t: last.t + 2.4, midi: 90, vel: 0.18, ratio: 3.5, index: 0.8, decay: 9, pan: 0.3, accent: true }); // F#6
        emit({ type: 'glass', t: last.t + 4.2, midi: 92, vel: 0.12, decay: 10, pan: -0.35, accent: true }); // G#6
      }
    } else if (p.inst === 'choir') {
      // the solo voice: its own brighter formant path and pre-delay (engine 'leadVox' bus), never ducked; a slight
      // scoop into each note (instruments.choir) and legato overlaps between notes
      p.ev.forEach((n, i) => {
        const iv = i ? n.midi - p.ev[i - 1].midi : 5;
        const a = Math.min(9, Math.abs(iv));
        const scoop = iv > 0 ? -(12 + 3.6 * a) : iv < 0 ? 6 + 1.2 * a : -8;
        emit({ type: 'choir', t: n.t - 0.12, dur: n.dur + 0.3, midi: n.midi, attack: 0.3, release: 2.4, vel: 0.62 * n.acc * v, pan: 0.04 * (i % 2 ? 1 : -1), detune: 4, drift: 4, lfo: 0.1, solo: true, motif: true, lead: true, scoop, scoopT: 0.06 + 0.014 * a, seed: rng.int(0, 1e9) });
      });
    } else if (p.inst === 'bow') {
      // the cello: legato bowing (each note overlaps the next by a bow change), seated a little left of centre
      p.ev.forEach((n) => emit({ type: 'bow', t: n.t - 0.05, dur: n.dur + 0.1, midi: n.midi, attack: clamp(0.3 * n.dur, 0.12, 0.35), release: 0.9, vel: 0.95 * n.acc * v, pan: ln.pan ?? -0.22, seed: rng.int(0, 1e9), motif: true, lead: true }));
    } else if (p.inst === 'brass') {
      // horns: a real horn speaks in ~0.1 s; legato (each note overlaps the next a little), own un-ducked lead bus
      const base = (Ly.brass ? Ly.brass.vel : 0.85) * 1.7 * v * (theme ? 1 : 0.9);
      p.ev.forEach((n) => emit({ type: 'brass', t: n.t, dur: n.dur + 0.15, midi: n.midi, attack: Math.min(0.12, n.dur * 0.2), release: 2.2, vel: base * n.acc, bright: ln.bright ?? 1.0, pan: 0.05, lead: true, motif: true }));
    } else if (p.inst === 'bell') {
      p.ev.forEach((n, i) => emit({ type: 'bell', t: n.t, midi: n.midi, vel: 0.42 * n.acc * v, ratio: ln.cold ? 3.5 : 2, index: ln.cold ? 1.3 : 0.7, decay: ln.cold ? 6 : 7.5, pan: ln.cold ? 0.7 * Math.sin((2 * Math.PI * n.t) / 9.3) : 0.3 * panSide + (i % 2 ? 0.18 : -0.18), motif: true, lead: true }));
    } else if (p.inst === 'glass') {
      p.ev.forEach((n, i) => emit({ type: 'glass', t: n.t, midi: n.midi, vel: 0.34 * n.acc * v, decay: 7.5, pan: 0.3 * panSide + (i % 2 ? -0.2 : 0.2), motif: true, lead: true }));
    }
  }
}

// A quiet high halo: when a phrase thins the chord below it, the colour tones the pad gave up (9th, #11, 7th)
// float a fifth or more above the tune as a pair of slowly beating sines (string harmonics, glass), so the
// harmony keeps its colour without crowding the low-mid register.
function genHalo(S) {
  const { sec, chords, rng, emit } = S;
  if (sec.W.halo === false) return;
  for (const c of chords) {
    if (c.voicing.length >= 5) continue;
    const ph = S.phrases.filter((p) => p.sec === sec.index && p.weight >= 0.5 && !p.duet && p.t0 < c.t1 && p.t1 > c.t0);
    if (!ph.length) continue;
    const top = Math.max(...ph.map((p) => p.hi));
    const have = new Set(c.voicing.map(mod12));
    const root = mod12(c.chord.bass);
    const tune = new Set(ph.flatMap((p) => p.notes.map(mod12)));
    // never a colour tone a semitone below a melody note (it would sound a minor ninth against it)
    const colour = c.chord.pcs.filter((pc) => pc !== root && !have.has(pc) && !tune.has((pc + 1) % 12) && !tune.has((pc + 11) % 12));
    if (!colour.length) continue;
    let m = top + 7;
    while (mod12(m) !== colour[0]) m++;
    if (m > 98) continue;
    emit({ type: 'tone', t: c.t0, dur: Math.max(1.5, c.t1 - c.t0), midi: m, attack: Math.min(2.5, 0.4 * (c.t1 - c.t0)), release: 3, vel: 0.22, beat: rng.range(0.18, 0.4), pan: rng.range(-0.45, 0.45), halo: true });
  }
}

function genPiano(S, P) {
  const { sec, chords, rng, emit } = S;
  for (const c of chords) {
    const cd = c.cruise1 - c.t0;
    const hasMotif = S.phrases.some((p) => p.sec === sec.index && p.inst === 'piano' && p.t0 < c.cruise1 && p.t1 > c.t0);
    if (P.arps && rng.next() < P.arps && !c.chord.final) {
      let lb = c.chord.bass;
      while (lb < 38) lb += 12;
      const pool = [lb, ...c.voicing.slice(0, hasMotif ? 2 : 4)].sort((a, b) => a - b);
      const step = clamp((cd * 0.55) / pool.length, 0.3, 0.8);
      const t0 = c.t0 + (hasMotif ? cd * 0.55 : 0.15);
      pool.forEach((m, i) => {
        if (t0 + i * step > c.cruise1 - 0.4) return;
        emit({ type: 'piano', t: t0 + i * step + rng.gauss() * 0.012, midi: m, vel: P.vel * (hasMotif ? 0.26 : 0.36) * (1 - i * 0.06) * rng.range(0.9, 1.05), ring: 4, pan: m < 50 ? 0 : -0.2 + 0.1 * i });
      });
    }
  }
  if (P.lowHits) {
    let side = 1;
    poisson(S, P.lowHits, 0.1, 0.95, (t) => {
      const c = chordAt(chords, t);
      side = -side; // sparse hits alternate sides
      emit({ type: 'piano', t, midi: rng.pick([c.chord.bass, c.chord.bass + 7, c.chord.bass + 12]) + (P.hitsUp || 0), vel: P.vel * rng.range(0.45, 0.7), ring: 6, pan: side * rng.range(0.1, 0.3) });
    });
  }
}

function genBrass(S, P) {
  const { chords, rng, emit } = S;
  for (const c of chords) {
    const cd = c.t1 - c.t0;
    let lb = c.chord.bass;
    while (lb < 36) lb += 12;
    const notes = [lb, vAt(c, 0) - 12, vAt(c, 1) - 12, vAt(c, 2) - 12].filter((m) => m >= 33);
    const uniq = [...new Set(notes)].sort((a, b) => a - b);
    uniq.forEach((m, i) =>
      emit({ type: 'brass', t: c.t0 + i * 0.12, dur: Math.max(1.5, cd - i * 0.12), midi: m, attack: clamp(0.45 * (c.cruise1 - c.t0), 1.5, 5), release: 4.5, vel: P.vel * (i === 0 ? 1 : 0.75) * rng.range(0.92, 1.0), bright: P.bright * (0.85 + 0.1 * i), pan: m < 50 ? 0 : [-0.1, -0.35, 0.35, 0.1][i % 4] })
    );
  }
}

function genPluck(S, P) {
  const { sec, chords, rng, emit } = S;
  const eighth0 = sec.W.grid ? sec.W.grid / 8 : sec.W.chordDur / 16;
  // the pulse rides the departure leg out and dissolves into the riser just before the next world appears
  const pend = sec.depart ? Math.max(sec.cruiseEnd, sec.depart.ta - 1.2) : sec.cruiseEnd;
  for (const c of chords) {
    const cd = Math.min(c.t1, pend) - c.t0;
    const steps = Math.max(1, Math.round(cd / eighth0));
    const e8 = cd / steps;
    let root = c.chord.bass;
    while (root < 50) root += 12;
    const tones = [root, vAt(c, 1), vAt(c, 2), vAt(c, 3)];
    for (let i = 0; i < steps; i++) {
      const t = c.t0 + i * e8;
      if (t >= pend - 0.1) break;
      const u = (t - sec.t0) / (pend - sec.t0);
      // fades in over the first bars, and out only over the last ~2.5 s before the next world (it rides the leg)
      const fade = smooth(u / 0.12) * smooth((pend - t) / 2.5);
      const acc = P.accents[i % 8];
      const m = tones[P.pattern[i % 8] % tones.length];
      emit({ type: 'pluck', t: t + rng.gauss() * 0.004, midi: m, vel: P.vel * acc * fade * rng.range(0.9, 1.05), decay: P.decay * (acc > 0.85 ? 1.5 : 1), pan: 0.32 * Math.sin(i * 1.7), bright: 0.6 + 0.4 * acc });
      if (P.kick && (i % 8 === 0 || i % 8 === 3) && fade > 0.2) emit({ type: 'kick', t, vel: P.kick * fade * (i % 8 === 0 ? 1 : 0.6) });
    }
  }
}

function genGrains(S, G, extra = {}) {
  const { rng, emit } = S;
  poisson(S, G.rate, G.from, G.to, (t) => {
    const f = G.f[0] * Math.pow(G.f[1] / G.f[0], rng.next());
    emit({ type: 'grain', t, dur: rng.range(G.dur[0], G.dur[1]), freq: f, q: G.q, vel: G.vel * rng.range(0.4, 1), buf: G.buf, pan: rng.range(-0.85, 0.85), off: rng.next(), ...extra });
  });
}

function genPebbles(S, P) {
  const { chords, rng, emit } = S;
  // the belt's stones keep knocking as the camera flies out of the field
  poisson(S, P.rate, 0, 1, (t) => {
    const c = chordAt(chords, t);
    const tones = tonesIn(c, P.range[0], P.range[1]);
    const one = (tt, v) => emit({ type: 'pebble', t: tt, midi: rng.pick(tones) + rng.range(-0.15, 0.15), vel: v, decay: rng.range(0.03, 0.14), pan: rng.range(-0.9, 0.9), ratio: rng.range(2.1, 2.9) });
    one(t, P.vel * rng.range(0.3, 1));
    if (rng.next() < P.cluster) {
      // a rattle: a few stones knocking together, quieter each time
      const k = rng.int(2, 5);
      let tt = t;
      for (let i = 0; i < k; i++) {
        tt += rng.range(0.025, 0.09);
        one(tt, P.vel * rng.range(0.2, 0.6) * (1 - i / (k + 1)));
      }
    }
  }, true, true);
}

function genTicks(S, P) {
  const { rng, emit } = S;
  let side = 1;
  poisson(S, P.rate, 0.05, 1, (t) => emit({ type: 'tick', t, freq: 2500 * Math.pow(3.4, rng.next()), vel: P.vel * rng.range(0.2, 1), decay: rng.range(0.004, 0.02), pan: (side = -side) * rng.range(0.1, 0.6) }), false);
}

function genShimmer(S, P) {
  const { rng, emit } = S;
  const pent = [4, 6, 8, 11, 1]; // E F# G# B C#
  const tones = [];
  for (let m = P.range[0]; m <= P.range[1]; m++) if (pent.includes(mod12(m))) tones.push(m);
  poisson(S, P.rate, 0.05, 1, (t) => emit({ type: 'sparkle', t, midi: rng.pick(tones), dur: rng.range(0.05, 0.16), vel: P.vel * rng.range(0.25, 1), pan: rng.range(-0.95, 0.95) }));
}

function genChirps(S, P) {
  const { rng, emit } = S;
  let side = 1;
  poisson(S, P.rate, P.from, P.to, (t) => {
    side = -side; // alternate sides
    if (P.kind === 'rise') {
      const n = rng.int(2, 5);
      let tt = t;
      for (let i = 0; i < n; i++) {
        const f0 = rng.range(900, 1700);
        emit({ type: 'chirp', kind: 'rise', t: tt, dur: rng.range(0.14, 0.36), f0, f1: f0 * rng.range(1.7, 2.5), vel: P.vel * rng.range(0.5, 1), pan: rng.range(-0.8, 0.8) });
        tt += rng.range(0.09, 0.26);
      }
    } else if (P.kind === 'whistler') {
      emit({ type: 'chirp', kind: 'whistler', t, dur: rng.range(1.0, 2.2), f0: rng.range(4200, 7000), f1: rng.range(480, 900), vel: P.vel * rng.range(0.5, 1), pan: side * rng.range(0.2, 0.7) });
    } else {
      emit({ type: 'chirp', kind: 'skr', t, dur: rng.range(1.6, 3.4), f0: rng.range(260, 560), f1: rng.range(0.05, 0.12), vel: P.vel * rng.range(0.5, 1), pan: side * rng.range(0.2, 0.6) });
    }
  });
}

function genWhoosh(S, P) {
  const { rng, emit } = S;
  poisson(S, P.rate, 0.1, 0.95, (t) => {
    const dir = rng.next() < 0.5 ? -1 : 1;
    emit({ type: 'whoosh', t, dur: rng.range(1.1, 2.4), freq: rng.range(700, 2600), vel: P.vel * rng.range(0.5, 1), pan0: -0.9 * dir, pan1: 0.9 * dir });
  });
}

function generateSection(sec, chords, events, cueTimes = {}, phrases = []) {
  const W = sec.W;
  const rng = new Rng(`four-light-hours/${sec.world}/${sec.index}`);
  const emit = makeEmitter(events, sec);
  const S = { sec, chords, rng, emit, phrases, cueTimes };
  const Ly = W.layers;
  // the melody is already planned (phrases): the accompaniment makes room for it
  if (Ly.piano) genPiano(S, Ly.piano);
  if (Ly.brass) genBrass(S, Ly.brass);
  if (Ly.pad) genSustained(S, Ly.pad, 'pad');
  if (Ly.choir) genSustained(S, Ly.choir, 'choir');
  if (Ly.air) genSustained(S, Ly.air, Ly.air.type || 'choir');
  if (Ly.extra) for (const P of Ly.extra) genSustained(S, P, P.type || 'choir');
  if (Ly.sub) genSub(S, Ly.sub);
  if (Ly.bells) genBells(S, Ly.bells);
  if (Ly.glass) genGlass(S, Ly.glass);
  if (Ly.pluck) genPluck(S, Ly.pluck);
  if (Ly.pebbles) genPebbles(S, Ly.pebbles);
  if (Ly.ticks) genTicks(S, Ly.ticks);
  if (Ly.shimmer) genShimmer(S, Ly.shimmer);
  if (Ly.chirps) genChirps(S, Ly.chirps);
  if (Ly.whoosh) genWhoosh(S, Ly.whoosh);
  if (Ly.grains) for (const g of Ly.grains) genGrains(S, g);
  genHalo(S);
  if (Ly.pmodes) emit({ type: 'pmodes', t: sec.t0, dur: Math.max(2, sec.cruiseEnd - sec.t0), attack: Math.min(6, (sec.cruiseEnd - sec.t0) * 0.3), release: 6, vel: Ly.pmodes.vel, centre: 146.83 });
  if (Ly.whine) {
    const L = sec.cruiseEnd - sec.t0;
    for (const m of Ly.whine.midi) emit({ type: 'tone', t: sec.t0 + 0.15 * L, dur: 0.75 * L, midi: m, attack: 0.3 * L, release: 4, vel: Ly.whine.vel, beat: rng.range(0.15, 0.45), pan: m === Ly.whine.midi[0] ? -0.25 : 0.25 });
  }
  if (Ly.seed && cueTimes.title === undefined) {
    const L = sec.cruiseEnd - sec.t0;
    const t0 = sec.t0 + Ly.seed.at * L;
    const beat = clamp(L / 12, 0.45, 1.1);
    const notes = realize('SEED', { from: 'A4', scale: 'D major' }).map((n) => ({ t: t0 + n.on * beat, midi: n.midi + (Ly.seed.oct || 0), dur: n.dur * beat, acc: n.acc }));
    phrases.push({ t0: notes[0].t, t1: notes[1].t + notes[1].dur, notes: notes.map((n) => n.midi), lo: notes[0].midi, hi: notes[1].midi, ev: notes, inst: 'bell', role: 'frag', weight: 0, name: 'SEED', world: sec.world, sec: sec.index, chord: chords[0].chord.name, line: {} });
    notes.forEach((n) => emit({ type: 'bell', t: n.t, midi: n.midi, vel: Ly.seed.vel * n.acc, ratio: 2, index: 0.7, decay: 7, pan: 0.25, motif: true }));
  }
}

// Clear space for the melody: decorative layers (bells, glass, sparkle, chirps) that would sound inside a phrase
// are softened, strongly when they fall within a sixth of one of its notes (statements clear more than fragments).
const DECOR = new Set(['bell', 'glass', 'sparkle', 'chirp']);
function clearSpace(events, phrases) {
  const ph = phrases.filter((p) => p.weight > 0 && !p.duet).sort((a, b) => a.t0 - b.t0);
  if (!ph.length) return;
  for (const e of events) {
    if (e.motif || e.accent || !DECOR.has(e.type)) continue;
    for (const p of ph) {
      if (p.t0 - 0.5 > e.t) break;
      if (e.t < p.t1 + 0.8) {
        const near = e.midi === undefined ? e.type === 'chirp' : p.notes.some((m) => Math.abs(m - e.midi) <= 9);
        e.vel *= p.weight >= 1 ? (near ? 0.3 : 0.6) : near ? 0.55 : 0.85;
        break;
      }
    }
  }
}

// A rough level estimate of the music sounding between t0 and t1, from the events themselves: per-voice
// nominal levels (instruments.js) times velocity, through each voice's envelope (attack / hold / release for
// sustained voices, an exponential decay for struck ones), power-summed at four instants. Enough to tell a
// passage with a horn call or a full choir from a bare pad, which is what the riser calibration needs.
const CONTENT_G = { bow: 0.07, pad: 0.05, choir: 0.066, sub: 0.085, brass: 0.075, piano: 0.17, tone: 0.03, pmodes: 0.1, pluck: 0.05, bell: 0.04, glass: 0.03 };
const CONTENT_PERC = { piano: 1.2, bell: 0, glass: 0, pluck: 0.1 }; // decay time constants (0: from the event)
const CONTENT_REF = 0.1;
function envAt(e, t) {
  if (t < e.t) return 0;
  const x = t - e.t;
  if (e.type in CONTENT_PERC) return Math.exp(-x / (CONTENT_PERC[e.type] || (e.decay || 5) / 6.9));
  const a = e.attack || 0.1,
    d = Math.max(a, e.dur || 0);
  if (x < a) return x / a;
  if (x <= d) return 1;
  return Math.exp(-(x - d) / Math.max(0.3, (e.release || 1) / 3));
}
function contentLevel(events, t0, t1) {
  let s = 0;
  for (const e of events) {
    const g = CONTENT_G[e.type];
    if (!g || e.t > t1 || e.end < t0) continue;
    let p = 0;
    for (let k = 0; k < 4; k++) p += envAt(e, t0 + ((k + 0.5) * (t1 - t0)) / 4) ** 2 / 4;
    s += (g * (e.vel || 0)) ** 2 * p;
  }
  return Math.sqrt(s);
}

// Every leg is one of a small set of gestures (worlds.js `approach.gesture` of the world it arrives at), and its
// harmony moves: the departing cadence gives way to the arriving world's approach chords (its pivots: e.g. vi - V
// into Saturn, bVI - bVII - i over a C pedal into Jupiter), so the reveal lands as a cadence.
//   riser   the full gesture: pink-noise band sweeping to 8-10.5 kHz, air, doppler saws, star-streak grains
//   hush    the music falls away to near silence under one sustained high tone (a pitch the pivots and the
//           arriving chord share), a whisper of noise; the reveal blooms out of it (no riser to outshout)
//   choir   a reverse-choir swell: the pivots sung "ah" on long crescendo attacks; a lighter riser
//   streak  a star-streak arpeggio of the pivots with an accelerando that follows the speed; a lighter riser
//   brass   a low brass crescendo on the pivots (the giant arriving); a lighter riser
// The riser's level is the music's (the engine's music follower), so no leg needs a per-world trim; e.vel is the
// gesture's own scale.
export const GESTURES = {
  riser: { riser: 1.55, stars: 1 },
  hush: { riser: 0.13, stars: 0.3, duckDb: -17 },
  choir: { riser: 0.65, stars: 0.6 },
  streak: { riser: 0.75, stars: 0.45 },
  brass: { riser: 0.62, stars: 0.8 },
};

// The pivots: the arriving world's approach chords, laid into the departing section's chord timeline once the
// camera moves (the cadence holds until then), the last one (the dominant) longest. Run before the melody and the
// voicing, so lines that ride into a leg let go where they would rub, and the pivots are voice-led like any chord
// (leaning toward the next world's register).
function planLegs(sections) {
  sections.forEach((s, i) => {
    const w = s.depart,
      A = sections[i + 1];
    if (!w || !A || A.arrive !== w) return;
    const ap = A.W.approach || {};
    w.gesture = GESTURES[ap.gesture] ? ap.gesture : 'riser';
    w.inst = ap.inst;
    w.mv = clamp(warpReach(w, 0.1), s.cruiseEnd, w.ta - 1);
    const specs = ap.chords || [];
    // the harmony starts to move as the departure begins (the turn toward the next world), not only once the
    // camera is fast; the cadence keeps at least 1.5 s
    const last = s.chords[s.chords.length - 1];
    let t = Math.max(w.ws, last.t0 + 1.5) + 0.2;
    const L = w.ta - t;
    if (!specs.length || L < 2.2) return;
    // (a warp is fast: two pivots fit from ~3 s, the harmony accelerating with the camera)
    const n = Math.min(specs.length, L < 3 ? 1 : L < 6 ? 2 : 3);
    const use = specs.slice(-n);
    const wts = use.map((_, k) => (k === use.length - 1 ? 1.5 : 1));
    const sum = wts.reduce((a, b) => a + b, 0);
    const span = w.ta - t;
    last.t1 = t;
    last.cruise1 = Math.min(last.cruise1, t);
    use.forEach((spec, k) => {
      const d = (span * wts[k]) / sum;
      s.chords.push({ t0: t, t1: k === use.length - 1 ? s.t1 : t + d, cruise1: t + d, chord: { ...chord(spec), idx: 'pivot' + k }, k: s.chords.length, pivot: true });
      t += d;
    });
    w.pivots = s.chords.filter((c) => c.pivot);
  });
}

function generateWarp(w, idx, sections, events, lanes) {
  const rng = new Rng(`four-light-hours/warp/${idx}`);
  const emit = makeEmitter(events, { index: -1 });
  const arriving = sections.find((s) => s.arrive === w);
  const here = sections.find((s) => w.ws >= s.t0 && w.ws < s.t1);
  const leaving = sections.find((s) => s.depart === w) || here;
  const fromTonic = leaving ? midi(leaving.W.key.tonic) : midi('D4');
  const toTonic = arriving ? midi(arriving.W.key.tonic) : fromTonic;
  const GS = GESTURES[w.gesture] || GESTURES.riser;
  // the music the leg leaves (lane level x what is sounding in the 2 s before it): sizes the short sounds that
  // cannot follow the music in the graph (star grains, the suck)
  const li = Math.max(0, Math.min(lanes.level.length - 1, Math.round((w.ws - 0.5) * LANE_HZ)));
  const pre = lanes.level[li] * clamp(contentLevel(events, w.ws - 2, w.ws) / CONTENT_REF, 0.2, 4);
  const shape = { ex: rng.range(1.05, 1.5), top: rng.range(8000, 10500), q: rng.range(0.5, 0.85), dop: rng.pick([1.4983, 1.3348, 2.0]), dir: rng.next() < 0.5 ? -1 : 1, panRate: rng.range(0.7, 1.4) };
  if (w.gesture === 'hush') shape.top = rng.range(5200, 6500); // a whisper, not a roar
  if (w.peak >= 0.2) {
    const dur = (w.leg ? w.ta : w.c0 + (w.curve.length - 1) / w.hz) - w.ws;
    // a warp that carries us to no new world (a camera move inside one, e.g. Saturn -> Titan) is a cruise swell
    emit({ type: 'riser', t: w.ws, dur, curve: w.curve, c0: w.c0, hz: w.hz, peak: w.peak, wp: w.wp, midi: fromTonic - 12, toMidi: toTonic - 12, vel: GS.riser * (0.85 + 0.15 * w.peak) * (arriving ? 1 : 0.5) * (w.gesture === 'streak' ? (w.inst === 'pluck' ? 1.25 : 0.7) : 1), gesture: w.gesture || 'cruise', ...shape });
  }
  // star-streak grains: density and brightness follow the (effective) warp
  for (let i = 0; i < w.curve.length - 1; i++) {
    const t = w.c0 + i / w.hz;
    const x = w.curve[i];
    const rate = 24 * x * x * Math.sqrt(GS.stars);
    let tt = t + rng.exp(Math.max(0.01, rate));
    while (tt < t + 1 / w.hz) {
      emit({ type: 'grain', t: tt, dur: rng.range(0.02, 0.07), freq: 900 + 9000 * x * rng.range(0.6, 1.3), q: 4, vel: 0.17 * x * Math.sqrt(pre) * Math.sqrt(GS.stars), buf: 'white', pan: rng.range(-0.95, 0.95), off: rng.next() });
      tt += rng.exp(Math.max(0.01, rate));
    }
  }
  if (!arriving || !w.leg) return;
  const piv = w.pivots || [];
  const mv = w.mv ?? w.ws;
  const lvl0 = Math.sqrt(lanes.level[li] * pre); // the departing music: its fader and what it has sounding
  if (w.gesture === 'hush') {
    // one sustained high tone: the highest pitch class the pivots and the arriving chord share (else the arriving
    // chord's fifth), placed high, as the music under it falls away
    const arr = arriving.chords[0].chord;
    const sets = [...piv.map((c) => new Set([...c.chord.pcs, mod12(c.chord.bass)])), new Set([...arr.pcs, mod12(arr.bass)])];
    let pc = [...sets[0]].filter((p) => sets.every((S) => S.has(p)));
    pc = pc.length ? pc : [mod12(arr.bass + 7)];
    let m = 86;
    while (!pc.includes(mod12(m))) m++;
    const t0 = mv + 0.1 * (w.ta - mv);
    // (its level follows the music it floats over: the engine's music follower, like the riser)
    emit({ type: 'tone', t: t0, dur: w.ta - t0 + 0.4, midi: m, attack: Math.max(0.8, 0.3 * (w.ta - t0)), release: 3.5, vel: 0.5, beat: rng.range(0.12, 0.25), pan: 0, bus: 'sfx', follow: true });
    emit({ type: 'tone', t: t0 + 0.3, dur: w.ta - t0 - 0.1, midi: m - 12, attack: Math.max(1.0, 0.4 * (w.ta - t0)), release: 3, vel: 0.22, beat: rng.range(0.1, 0.2), pan: 0, bus: 'sfx', follow: true });
  } else if (w.gesture === 'choir') {
    // the pivots sung on reverse swells: each chord's upper voices (the top an octave up), crescendo into the next
    piv.forEach((c, k) => {
      const d = c.t1 - c.t0;
      const vs = c.voicing.slice(-3);
      vs.forEach((m0, j) => {
        const m = j === vs.length - 1 && m0 < 72 ? m0 + 12 : m0;
        emit({ type: 'choir', t: c.t0 - 0.2, dur: d + 0.25, midi: m, attack: Math.max(0.8, 0.85 * d), release: 1.6, vel: (0.2 + 0.1 * (k / Math.max(1, piv.length - 1))) * lvl0, pan: [-0.35, 0.35, 0][j % 3], detune: 6, drift: 4, lfo: 0.1, seed: rng.int(0, 1e9) });
      });
    });
  } else if (w.gesture === 'streak') {
    // a star-streak arpeggio through the pivots, up and around three octaves, its rate following the speed
    const inst = w.inst || 'bell';
    let t = Math.max(w.ws, mv - 0.6),
      i = 0;
    while (t < w.ta - 0.25) {
      const c = piv.find((p) => t >= p.t0 && t < p.t1) || piv[piv.length - 1] || leaving.chords[leaving.chords.length - 1];
      const tones = tonesIn(c, 67, 98);
      if (!tones.length) break;
      const m = tones[(i * 2 + Math.floor(i / tones.length)) % tones.length];
      const x = clamp(effectiveWarpAt([w], t) / Math.max(0.2, w.peak), 0, 1);
      const u = (t - mv) / Math.max(0.5, w.ta - mv);
      const v = (0.35 + 0.65 * Math.sin(Math.PI * Math.min(1, u * 1.15))) * lvl0;
      const pan = 0.75 * Math.sin(i * 0.9 + shape.dir);
      // (on the Mars pluck it grows into the pulse's own level: the arpeggio hands over to the 84 BPM pulse)
      if (inst === 'pluck') emit({ type: 'pluck', t, midi: m - 12, vel: 1.5 * v, decay: 0.28, pan, bright: 0.85 });
      else emit({ type: 'bell', t, midi: m, vel: 0.11 * v, ratio: 3.5, index: 1.1, decay: 2.8, pan });
      t += 1 / (2.6 + 11 * Math.pow(Math.max(x, u * 0.6), 1.3));
      i++;
    }
  } else if (w.gesture === 'brass') {
    // the giant arriving: low brass swelling through the pivots
    piv.forEach((c, k) => {
      const d = c.t1 - c.t0;
      let lb = c.chord.bass;
      while (lb < 36) lb += 12;
      const ns = [...new Set([lb, vAt(c, 0) - 12, vAt(c, 1) - 12, vAt(c, 2)])].filter((m) => m >= 33).sort((a, b) => a - b);
      ns.forEach((m, j) => emit({ type: 'brass', t: c.t0 + j * 0.1, dur: d, midi: m, attack: Math.max(0.8, 0.8 * d), release: 1.8, vel: (0.3 + 0.2 * (k / Math.max(1, piv.length - 1))) * lvl0 * (j ? 0.8 : 1), bright: 0.75 + 0.15 * k, pan: m < 50 ? 0 : [-0.3, 0.3, -0.1, 0.1][j % 4] }));
    });
  }
  const ch = arriving.chords[0];
  // the suck: the arriving chord's guide tones and its bass an octave up, swelling in reverse into the reveal
  let bass = ch.chord.bass;
  while (bass < 45) bass += 12;
  const tones = [bass, ...ch.voicing.slice(-3)];
  const suck = rng.range(0.3, 0.5);
  emit({ type: 'suck', t: w.ta - suck, dur: suck, tones, vel: pre * 0.9 * (w.gesture === 'hush' ? 0.7 : 1), pan: shape.dir * 0.2 });
  const impact = arriving.W.impact ?? 0.4;
  if (impact > 0 && w.peak > 0.3) emit({ type: 'drop', t: w.ta - 0.03, vel: 0.42 * impact * (0.6 + 0.4 * w.peak) * Math.sqrt(arriving.W.levelLin || 1) * (w.gesture === 'hush' ? 0.3 : 1) });
  emit({ type: 'glass', t: w.ta + 0.05, midi: toTonic + 24, vel: 0.22, decay: 7, pan: rng.range(-0.3, 0.3) });
}

// Named film cues get small, harmony-aware musical accents (see ACCENTS in worlds.js).
function generateAccents(cueEvents, sections, events, phrases = []) {
  cueEvents.forEach((cue, idx) => {
    let c = cue;
    const kind = ACCENTS[c.id];
    if (!kind) return;
    const sec = sections.find((s) => c.t >= s.t0 && c.t < s.t1);
    if (!sec) return;
    if (kind === 'gong' || kind === 'lonely' || kind === 'warmGlass') {
      const on = phrases.find((p) => p.weight > 0 && p.t0 - 0.4 < c.t && p.t1 + 0.3 > c.t);
      if (on && on.t1 + 0.3 - c.t <= 4) c = { ...c, t: on.t1 + 0.3 };
    }
    const ch = chordAt(sec.chords, c.t + 0.2);
    const rng = new Rng(`four-light-hours/accent/${c.id}/${idx}`);
    const emit = makeEmitter(events, sec);
    const tones = (lo, hi) => tonesIn(ch, lo, hi);
    // a melody phrase sounding around this cue: accents stay out of its register
    const near = phrases.filter((p) => p.t1 + 1 > c.t - 1.5 && p.t0 - 1 < c.t + 5);
    const motifLo = near.length ? Math.min(...near.flatMap((p) => p.notes)) : Infinity;
    const arp = (list, t0, step, vel, type = 'glass', decay = 6) => list.forEach((m, i) => emit({ type, t: t0 + i * step + rng.gauss() * 0.01, midi: m, vel: vel * (1 - 0.08 * i), decay, ratio: 3.5, index: 0.9, pan: -0.6 + (1.2 * i) / Math.max(1, list.length - 1), accent: true }));
    if (kind === 'title') {
      // the seed of the motif, far away: A4 -> F#5 (the rising sixth), then a low bloom
      const seed = realize('SEED', { from: 'A4', scale: 'D major' }).map((n) => ({ t: c.t + 1.6 + n.on * 0.95, midi: n.midi, dur: n.dur * 0.95, acc: n.acc }));
      phrases.push({ t0: seed[0].t, t1: seed[1].t + seed[1].dur, notes: seed.map((n) => n.midi), lo: seed[0].midi, hi: seed[1].midi, ev: seed, inst: 'bell', role: 'frag', weight: 0, name: 'SEED', chord: ch.chord.name, world: sec.world, sec: sec.index, line: {} });
      seed.forEach((n) => emit({ type: 'bell', t: n.t, midi: n.midi, vel: 0.42 * n.acc, ratio: 2, index: 0.7, decay: 8, pan: 0.06, motif: true }));
      emit({ type: 'sub', t: c.t, dur: 5, midi: 38, attack: 3, release: 6, vel: 0.3 });
    } else if (kind === 'bloom') {
      const up = tones(Math.max(76, motifLo + 13), 100);
      arp(up.filter((_, i) => i % 2 === 0).slice(0, 5), c.t, 0.16, 0.2);
      const hiVox = Math.min(74, motifLo - 3);
      for (const m of tones(52, hiVox).slice(-3)) emit({ type: 'choir', t: c.t - 1.5, dur: 4.5, midi: m, attack: 2.2, release: 5, vel: 0.35, pan: rng.range(-0.4, 0.4), detune: 7, drift: 4, lfo: 0.1, seed: rng.int(0, 1e9) });
    } else if (kind === 'sunrise') {
      // first light over the limb: a fast rising glass arpeggio into a high held tone, an octave above the melody
      const up = tones(Math.max(74, motifLo + 13), 104);
      arp(up.slice(0, 7), c.t - 0.9, 0.11, 0.17);
      emit({ type: 'glass', t: c.t, midi: up[up.length - 1] || 93, vel: 0.2, decay: 9, pan: 0.2, accent: true });
    } else if (kind === 'whoosh') {
      emit({ type: 'whoosh', t: c.t + 0.4, dur: 2.6, freq: 1500, vel: 0.55, pan0: -0.95, pan1: 0.95 });
    } else if (kind === 'gong') {
      // Io's shadow touching the clouds: a low inharmonic bell, felt more than heard
      emit({ type: 'bell', t: c.t, midi: (ch.chord.bass % 12) + 48, vel: 0.5, ratio: 1.41, index: 2.6, decay: 10, pan: -0.15 });
      emit({ type: 'bell', t: c.t + 0.02, midi: (ch.chord.bass % 12) + 60, vel: 0.22, ratio: 2.76, index: 1.2, decay: 8, pan: 0.2 });
    } else if (kind === 'shimmerBurst') {
      const pent = tones(86, 105);
      for (let t = c.t; t < c.t + (c.dur || 6); t += rng.exp(26)) emit({ type: 'sparkle', t, midi: rng.pick(pent), dur: rng.range(0.04, 0.12), vel: 0.1 * rng.range(0.3, 1) * Math.sin(Math.PI * Math.min(1, (t - c.t) / (c.dur || 6))), pan: rng.range(-0.95, 0.95) });
    } else if (kind === 'warmGlass') {
      arp(tones(64, 76).slice(0, 2), c.t + 0.3, 0.5, 0.18, 'glass', 8);
    } else if (kind === 'iceBells') {
      arp(tones(81, 100).reverse().slice(0, 6), c.t + 0.2, 0.19, 0.3, 'bell', 6);
    } else if (kind === 'lonely') {
      emit({ type: 'bell', t: c.t + 0.5, midi: tones(78, 86)[0] || 78, vel: 0.3, ratio: 2, index: 0.6, decay: 9, pan: 0.2 });
    } else if (kind === 'paleDot') {
      // one pale blue pixel: a single high, very quiet tone after the motif begins
      emit({ type: 'glass', t: c.t + 3.2, midi: 95, vel: 0.15, decay: 10, pan: 0.15 });
    }
  });
}

// ------------------------------------------------------------------------------------------- lanes
const VOWELS = { a: [800, 1150, 2800], e: [420, 1650, 2650], i: [320, 1900, 2700], o: [480, 820, 2600], u: [340, 720, 2450] };
function boxSmooth(arr, win) {
  const n = arr.length,
    h = Math.max(1, Math.round(win / 2));
  const out = new Float32Array(n);
  const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + arr[i];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h),
      b = Math.min(n, i + h + 1);
    out[i] = (pref[b] - pref[a]) / (b - a);
  }
  return out;
}

// Motif lanes: while a melody phrase sounds, the pad / sustained-choir / sustained-brass buses duck by 3.5 dB
// (250 ms attack, 1.5 s release) and a peaking cut (-7 dB, Q 0.9) carves a pocket just under the middle of the
// phrase's register (the accompaniment sits below the tune), so the tune reads in front of the wash. A fragment
// (weight 0.5) gets half of that; bells and glass none.
export const MOTIF_MIX = { duckDb: -3.5, carveDb: -7, attack: 0.25, release: 1.5 };
function motifLanes(phrases, N) {
  const env = new Float32Array(N),
    duck = new Float32Array(N),
    carveF = new Float32Array(N),
    carveG = new Float32Array(N);
  const ph = phrases
    .filter((p) => p.weight > 0 && !p.duet)
    .map((p) => ({ a: p.t0 - 0.25, b: p.t1 + 0.4, w: p.weight, f: Math.sqrt(mtof(Math.min(...p.notes)) * Math.exp(p.notes.reduce((acc, m) => acc + Math.log(mtof(m)), 0) / p.notes.length)) }))
    .sort((x, y) => x.a - y.a);
  const dt = 1 / LANE_HZ;
  const ka = 1 - Math.exp(-dt / MOTIF_MIX.attack),
    kr = 1 - Math.exp(-dt / MOTIF_MIX.release);
  let y = 0,
    j = 0,
    cur = ph.length ? ph[0].f : 700;
  for (let i = 0; i < N; i++) {
    const t = i * dt;
    while (j < ph.length && ph[j].b < t) j++;
    let on = 0;
    for (let k = j; k < ph.length && ph[k].a <= t; k++) if (t <= ph[k].b) on = Math.max(on, ph[k].w);
    y += (on - y) * (on > y ? ka : kr);
    env[i] = y;
    if (y < 0.03 && j < ph.length && ph[j].a < t + 0.5) cur = ph[j].f; // retune the carve only while it is inactive
    carveF[i] = cur;
    carveG[i] = MOTIF_MIX.carveDb * y;
    duck[i] = Math.pow(10, (MOTIF_MIX.duckDb * y) / 20);
  }
  return { mduck: duck, carveF, carveG, motifEnv: env };
}

function buildLanes(sections, duration, cues, warps, phrases = []) {
  const total = duration + TAIL;
  const N = Math.ceil(total * LANE_HZ) + 2;
  const names = ['level', 'duck', 'wet', 'padCut', 'padQ', 'f1', 'f2', 'f3', 'breath', 'airGain', 'airFreq', 'airQ', 'rumbleGain', 'rumbleCut', 'loShelf', 'hiShelf', 'pianoCut', 'padHP', 'chorus'];
  const base = {};
  for (const k of names) base[k] = new Float32Array(N);
  const hasIntensity = !!cues.intensity;
  let si = 0;
  for (let i = 0; i < N; i++) {
    const t = i / LANE_HZ;
    while (si < sections.length - 1 && t >= sections[si].t1) si++;
    const s = sections[si];
    const Ln = s.W.lanes;
    const u = clamp((t - s.t0) / Math.max(1e-3, s.t1 - s.t0), 0, 1);
    base.level[i] = s.W.level + s.W.arc * (hasIntensity ? 0.35 : 1) * (Math.pow(Math.sin(Math.PI * u), 1.5) - 0.5);
    base.wet[i] = Ln.wet;
    base.padCut[i] = Math.log(Ln.padCut);
    base.padQ[i] = Ln.padQ;
    const vs = Ln.vowel;
    const vx = u * (vs.length - 1);
    const va = VOWELS[vs[Math.floor(vx)]],
      vb = VOWELS[vs[Math.min(vs.length - 1, Math.floor(vx) + 1)]];
    const fr = vx - Math.floor(vx);
    base.f1[i] = lerp(va[0], vb[0], smooth(fr));
    base.f2[i] = lerp(va[1], vb[1], smooth(fr));
    base.f3[i] = lerp(va[2], vb[2], smooth(fr));
    base.breath[i] = Ln.breath;
    base.airGain[i] = Ln.air[0];
    base.airFreq[i] = Math.log(Ln.air[1]);
    base.airQ[i] = Ln.air[2];
    base.rumbleGain[i] = Ln.rumble[0];
    base.rumbleCut[i] = Math.log(Ln.rumble[1]);
    const tilt = Ln.tilt || [0, 0];
    base.loShelf[i] = tilt[0];
    base.hiShelf[i] = tilt[1];
    base.pianoCut[i] = Math.log(Ln.pianoCut || 5200);
    base.padHP[i] = Math.log(Ln.padHP || 25);
    base.chorus[i] = Ln.chorus ?? 1;
  }
  // crossfade worlds over ~3.5 s around each boundary
  const L = {};
  for (const k of names) L[k] = boxSmooth(boxSmooth(base[k], 3.5 * LANE_HZ * 0.5), 3.5 * LANE_HZ * 0.5);
  const sample = (arr, t, dflt) => {
    if (!arr) return dflt;
    const j = t * cues.hz,
      a = Math.floor(j);
    if (a < 0) return arr[0];
    if (a + 1 >= arr.length) return arr[arr.length - 1];
    return lerp(arr[a], arr[a + 1], j - a);
  };
  // arrival bloom: +3 dB rising in ~1 s from the moment a new world is framed, relaxing over ~9 s, so each
  // reveal is the loudness peak of its leg (the riser is scaled below it)
  const arrivals = sections.filter((s) => s.arrive).map((s) => s.arrive.ta);
  const swells = [];
  for (const s of sections) for (const [cue, db] of Object.entries(s.W.swell || {})) { const e = (cues.events || []).find((x) => x.id === cue); if (e && e.t >= s.t0 && e.t < s.t1) swells.push([e.t, db]); }
  const swellDb = (t) => {
    let b = 0;
    for (const [tc, db] of swells) {
      const x = t - tc;
      if (x < -2 || x > 30) continue;
      b = Math.max(b, db * smooth((x + 2) / 3.5) * (x > 9 ? Math.exp(-(x - 9) / 5) : 1));
    }
    return b;
  };
  const bloomDb = (t) => {
    let b = 0;
    for (const ta of arrivals) {
      const x = t - ta;
      if (x < -0.4 || x > 30) continue;
      b = Math.max(b, 3 * smooth((x + 0.4) / 1.2) * Math.exp(-Math.max(0, x - 0.8) / 9));
    }
    return b;
  };
  // a leg is one continuous crescendo: the director's intensity may relax as the camera leaves a world, but
  // the music under the leg holds the level it had when the leg began (the riser builds on top of it)
  const legs = warps.filter((w) => w.leg).map((w) => [w.ws, w.ta, sample(cues.intensity, w.ws, 0.6)]);
  const hushes = warps.filter((w) => w.leg && w.gesture === 'hush' && w.mv !== undefined);
  const holdI = (t, I) => {
    for (const [ws, ta, I0] of legs) if (t >= ws && t <= ta + 0.5) return Math.max(I, I0);
    return I;
  };
  si = 0;
  for (let i = 0; i < N; i++) {
    const t = i / LANE_HZ;
    while (si < sections.length - 1 && t >= sections[si].t1) si++;
    const s = sections[si];
    const Ln = s.W.lanes;
    const inFilm = t <= duration;
    const w = inFilm ? effectiveWarpAt(warps, t) : 0;
    const fd = inFilm ? sample(cues.fade, t, 0) : 1;
    const I = inFilm ? holdI(t, sample(cues.intensity, t, 0.6)) : 0.3; // the director's dramatic intent, 0..1
    const [period, depth] = Ln.cutMod;
    const am = Ln.am;
    const gust = 0.5 + 0.5 * Math.sin(2 * Math.PI * am[0] * t + 0.7 * Math.sin(2 * Math.PI * am[0] * 0.37 * t));
    const tailFade = t > duration ? smooth((duration + TAIL - t) / TAIL) : 1;
    let lvl = Math.pow(10, (L.level[i] + 9 * (I - 0.6) + (inFilm ? bloomDb(t) + swellDb(t) : 0)) / 20) * (1 - 0.45 * fd);
    lvl *= smooth(t / 0.6); // never start with a click
    L.level[i] = lvl;
    // -5 dB at full warp, and only once the riser has built (w > 0.25): the riser builds on the music, not instead
    const wNow = inFilm ? warps.find((x) => t >= x.c0 && t <= x.c0 + (x.curve.length - 1) / x.hz) : null;
    const dScale = wNow && wNow.gesture ? Math.min(1, (GESTURES[wNow.gesture] || GESTURES.riser).riser * 1.3) : 1;
    L.duck[i] = 1 - 0.37 * dScale * Math.pow(clamp((w - 0.25) / 0.75, 0, 1), 1.5);
    // a hush leg: the music falls away (to -17 dB) as the camera moves and comes back over ~1.6 s into the reveal
    for (const h of hushes)
      if (t > h.mv && t < h.ta + 0.8) {
        const x = smooth((t - h.mv) / Math.max(0.8, 0.4 * (h.ta - h.mv))) * (1 - smooth((t - (h.ta - 1.4)) / 2.4));
        L.duck[i] = Math.min(L.duck[i], Math.pow(10, (GESTURES.hush.duckDb * x) / 20));
      }
    L.wet[i] = L.wet[i] * (1 + 0.45 * w);
    // the world's own cutoff is the spectral target; intensity only nudges it (+-12%), the warp darkens it
    L.padCut[i] = Math.min(16000, Math.exp(L.padCut[i]) * (0.88 + 0.24 * I) * (1 + depth * Math.sin((2 * Math.PI * t) / period)) * (1 - 0.3 * w));
    L.pianoCut[i] = Math.exp(L.pianoCut[i]);
    L.padHP[i] = Math.exp(L.padHP[i]);
    L.airGain[i] = (L.airGain[i] * (1 - am[1] * 0.6 + am[1] * 0.6 * gust) + 0.05 * w) * tailFade;
    L.airFreq[i] = Math.min(15000, Math.exp(L.airFreq[i]) * (1 + 0.25 * Math.sin(2 * Math.PI * 0.031 * t)) * (1 + 1.8 * w));
    L.rumbleGain[i] = L.rumbleGain[i] * (1 - am[1] + am[1] * gust * (0.75 + 0.25 * Math.sin(2 * Math.PI * 1.7 * am[0] * t))) * tailFade;
    L.rumbleCut[i] = Math.exp(L.rumbleCut[i]) * (1 + 0.3 * gust);
    const drift = 1 + 0.04 * Math.sin(2 * Math.PI * 0.07 * t);
    L.f1[i] *= drift;
    L.f2[i] *= 2 - drift;
  }
  Object.assign(L, motifLanes(phrases, N));
  // the low rumble bed (Venus's pressure, Jupiter's depths) steps back under a melody too
  for (let i = 0; i < N; i++) L.rumbleGain[i] *= 1 - 0.6 * L.motifEnv[i];
  return L;
}

// The register a chord's accompaniment may use, given the melody sounding over it: a phrase above (the usual
// case) lowers the ceiling to a fourth below its lowest note (a minor third for bells/glass, and nothing for
// bells/glass far overhead); a phrase in the bass (Venus's buried horn) lifts the floor above it instead.
// The ceiling follows the notes sounding over THIS chord (a long tune that climbs lets the harmony under it climb
// too); a counter-melody inside the register gives no ceiling, its notes are avoided instead (`inner`).
function registerFor(s, c, phrases) {
  let lo = 45,
    hi = 79;
  // (the film's last chord, wherever the film ends, is voiced in the open middle register, not the world's own)
  const R = c.chord.final ? {} : s.W.reg || {};
  if (s.W.voiceRange && !c.chord.final) [lo, hi] = s.W.voiceRange; // a world may keep its pads in a register of its own
  if (R.lo !== undefined) lo = R.lo;
  if (R.hi !== undefined) hi = R.hi;
  if (s.world === 'intro') {
    hi = 66; // the title's seed (A4 -> F#5) sounds over the opening chord
    lo = 45;
  }
  const a = c.t0 - 0.3,
    b = c.t1;
  const mel = new Set(),
    inner = new Set();
  for (const p of phrases) {
    if (p.t0 > b || p.t1 + 1.2 < a) continue;
    const tonal = p.inst === 'bell' || p.inst === 'glass';
    const here = p.ev.filter((n) => n.t < b && n.t + n.dur + 0.5 > a && !n.app).map((n) => n.midi);
    if (!here.length) continue;
    if (p.counter) {
      for (const m of here) inner.add(m);
      continue;
    }
    for (const m of here) mel.add(m);
    const plo = p.tune ? Math.min(...here) : p.lo,
      phi = p.tune ? Math.max(...here) : p.hi;
    if (tonal && plo >= 76) continue; // far overhead: no ceiling, but still no minor ninths under it
    if (phi <= 57) lo = Math.max(lo, phi + 4);
    else hi = Math.min(hi, plo - (tonal ? 3 : p.inst === 'brass' ? 7 : 5));
  }
  if (hi - lo < 10) hi = lo + 10;
  return { lo, hi, mel: [...mel], inner: [...inner] };
}

// Harmonic audit of the melody: a sustained melody note a semitone (or minor ninth) away from a chord tone it
// sounds against (bass or accompaniment), unless the line asks for the rub (Mercury's side-slip).
function lineAudit(sections, phrases) {
  const out = [];
  for (const p of phrases) {
    if (p.duet || !p.ev || (p.line && p.line.clash)) continue;
    const s = sections[p.sec];
    if (!s) continue;
    for (const n of p.ev) {
      if (n.dur < 0.3 || n.app) continue; // passing notes and written appoggiaturas are meant to lean
      for (const c of s.chords) {
        if (c.t1 <= n.t + 0.05 || c.t0 >= n.t + n.dur - 0.05) continue;
        const tones = [c.chord.bass, ...c.voicing];
        // the upper of the two a semitone (or minor ninth) above the lower; a major seventh is not a rub
        const bad = tones.filter((m) => mod12(Math.max(m, n.midi) - Math.min(m, n.midi)) === 1);
        // a semitone against the chord is a rub only if the note is not itself a chord tone of a b9 chord
        if (bad.length && !(c.chord.b9 && c.chord.pcs.includes(mod12(n.midi)))) out.push({ t: +n.t.toFixed(2), world: p.world, phrase: p.name, note: noteName(n.midi), chord: c.chord.name, against: bad.map(noteName).join(' ') });
      }
    }
  }
  return out;
}

// Voicing audit: semitones / minor ninths inside a voicing below C5, against the bass, and 5-voice spans
// under an octave (compose-check fails on any).
export function voicingAudit(sections) {
  const out = [];
  for (const s of sections)
    for (const c of s.chords) {
      const v = c.voicing,
        issues = [];
      for (let i = 0; i < v.length; i++) {
        for (let j = i + 1; j < v.length; j++) {
          const iv = v[j] - v[i];
          if (iv === 1 && v[i] < 72) issues.push(`semitone ${noteName(v[i])}-${noteName(v[j])}`);
          if (iv > 12 && mod12(iv) === 1 && !c.chord.b9) issues.push(`minor 9th ${noteName(v[i])}-${noteName(v[j])}`);
        }
        const d = v[i] - c.chord.bass;
        if (d > 12 && mod12(d) === 1 && !c.chord.b9) issues.push(`minor 9th over the bass ${noteName(c.chord.bass)}-${noteName(v[i])}`);
        if (i > 0 && v[i - 1] < 48 && v[i] - v[i - 1] < 4) issues.push(`low ${v[i] - v[i - 1] === 3 ? 'minor third' : 'second'} ${noteName(v[i - 1])}-${noteName(v[i])}`);
      }
      if (v.length === 5 && v[4] - v[0] < 12) issues.push('5 voices inside an octave');
      if (issues.length) out.push({ world: s.world, t: +c.t0.toFixed(1), chord: c.chord.name, voicing: v.map(noteName).join(' '), issues });
    }
  return out;
}

// Thematic coverage: the longest stretch of the film without any melodic event (statement or fragment), and
// how many statements of the motif family share one rhythm.
function themeStats(phrases, duration) {
  const ph = phrases.filter((p) => !p.duet && p.t0 <= duration).sort((a, b) => a.t0 - b.t0);
  let maxGap = 0,
    gapAt = 0,
    end = 0,
    covered = 0;
  for (const p of ph) {
    if (p.t0 - end > maxGap) {
      maxGap = p.t0 - end;
      gapAt = end;
    }
    covered += Math.max(0, Math.min(p.t1, duration) - Math.max(p.t0, end));
    end = Math.max(end, p.t1);
  }
  if (duration - end > maxGap) {
    maxGap = duration - end;
    gapAt = end;
  }
  const family = ph.filter((p) => (/^(A|INV)/.test(p.name) || p.tune) && !p.counter && p.role === 'theme');
  const byName = {};
  for (const p of family) byName[p.name] = (byName[p.name] || 0) + 1;
  const same = Math.max(0, ...Object.values(byName));
  // long lines: melodies (not counter-melodies) of 8+ notes lasting 12 s or more
  const long = ph.filter((p) => !p.counter && p.notes.length >= 8 && p.t1 - p.t0 >= 12).map((p) => ({ name: p.name, world: p.world, t0: +p.t0.toFixed(1), t1: +p.t1.toFixed(1), notes: p.notes.length, inst: p.inst }));
  const frags = ph.filter((p) => !p.counter && p.notes.length <= 3).length;
  return { phrases: ph.length, statements: family.length, coverage: +(covered / duration).toFixed(3), maxGap: +maxGap.toFixed(1), gapAt: +gapAt.toFixed(1), identicalShare: family.length ? +(same / family.length).toFixed(2) : 0, rhythms: byName, long, fragments: frags };
}

// Register per world: the voice-led line's top / bottom / mean (time-weighted medians over the world's own chords,
// not the leg's pivots) and the top of what actually sounds in the sustained accompaniment (pads, ensemble choir,
// strings, low brass, with their octave offsets), sampled every 0.25 s.
const SUSTAIN = new Set(['pad', 'choir', 'bow', 'brass']);
function registerStats(sections, events) {
  const med = (pairs) => {
    const v = pairs.filter(([, w]) => w > 0).sort((a, b) => a[0] - b[0]);
    const tot = v.reduce((a, [, w]) => a + w, 0);
    let acc = 0;
    for (const [x, w] of v) if ((acc += w) >= tot / 2) return x;
    return null;
  };
  return sections.map((s) => {
    const own = s.chords.filter((c) => !c.pivot && c.t0 < s.cruiseEnd);
    const wt = (c) => Math.max(0, Math.min(c.t1, s.cruiseEnd) - c.t0);
    const top = med(own.map((c) => [c.voicing[c.voicing.length - 1], wt(c)]));
    const bottom = med(own.map((c) => [c.voicing[0], wt(c)]));
    const mean = med(own.map((c) => [c.voicing.reduce((a, b) => a + b, 0) / c.voicing.length, wt(c)]));
    const ev = events.filter((e) => e.sec === s.index && SUSTAIN.has(e.type) && !e.solo && !e.lead && e.midi !== undefined);
    const tops = [];
    for (let t = s.t0 + 1; t < s.cruiseEnd; t += 0.25) {
      let m = -Infinity;
      for (const e of ev) if (e.t <= t && e.t + (e.dur || 0) >= t) m = Math.max(m, e.midi);
      if (m > -Infinity) tops.push([m, 1]);
    }
    const harm = own.map((c) => wt(c)).filter((d) => d > 0.5);
    return { world: s.world, top, bottom, mean: mean === null ? null : +mean.toFixed(1), sounding: med(tops), chordSec: harm.length ? +(harm.reduce((a, b) => a + b, 0) / harm.length).toFixed(1) : null, chords: harm.length };
  });
}

// ------------------------------------------------------------------------------------------- compose
// cues = { hz, warp, fade, intensity?, arrival?, events?: [{ id, t, dur }] } sampled from director.evaluate()
export function compose({ chapters, duration, cues }) {
  const warps = findWarps(cues);
  const sections = buildSections(chapters, duration, warps);
  sections.forEach((s, i) => (s.index = i));
  const cueEvents = (cues.events || []).filter((e) => e.t >= 0 && e.t <= duration);
  const cueTimes = {};
  for (const e of cueEvents) if (!(e.id in cueTimes)) cueTimes[e.id] = e.t;
  // 1. chord timelines
  let prevChord = null;
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    s.chords = chordTimeline(s, prevChord, sections[i + 1], i === sections.length - 1, cueTimes);
    prevChord = s.chords[s.chords.length - 1].chord;
  }
  // the legs: gestures, and the arriving world's approach chords (pivots) laid into each departure
  planLegs(sections);
  // 2. the melody (it depends only on the chord timing), 3. one continuous voice-led line through the whole
  // film that makes room for it
  const tunes = realizeTunes(sections);
  const phrases = [...tunes.phrases, ...realizeLines(sections, duration + TAIL, tunes)].sort((a, b) => a.t0 - b.t0);
  let prev = [45, 50, 57, 62, 64]; // A2 D3 A3 D4 E4: the open fifth the film begins on
  for (const s of sections)
    s.chords.forEach((c, k) => {
      const { lo, hi, mel, inner } = registerFor(s, c, phrases);
      const rootPc = mod12(c.chord.bass);
      const pool = c.chord.pcs.includes(rootPc) ? c.chord.pcs : [...c.chord.pcs, rootPc]; // the root may double, never required
      // each world has its own register (worlds.js `reg`): the arrival chord moves there almost freely (a new
      // place), the rest of the world is voice-led with a pull toward it; a pivot chord in a leg already leans
      // toward the next world's register
      const R = (c.chord.final ? null : c.pivot && sections[s.index + 1] ? sections[s.index + 1].W.reg : s.W.reg) || {};
      const centre = R.centre ?? null;
      const motion = k === 0 && s.index > 0 ? 0.35 : c.pivot ? 0.7 : 1;
      c.voicing = c.chord.stack
        ? stackVoicing(prev, c.chord.stack, { lo, hi, centre: R.centre })
        : voiceChord(prev, pool, c.chord.req, { lo, hi, rootPc, bass: c.chord.bass, melody: mel, inner, b9: c.chord.b9, centre: centre !== null ? Math.min(centre, hi - 4) : null, kc: R.kc ?? 1.2, spread: R.spread ?? null, maxGap: R.maxGap ?? 12, motion, nMax: R.nMax ?? 5 });
      c.hi = hi;
      prev = c.voicing;
    });
  const events = [];
  for (const s of sections) generateSection(s, s.chords, events, cueTimes, phrases);
  emitLines(sections, phrases, events);
  generateAccents(cueEvents, sections, events, phrases);
  clearSpace(events, phrases);
  phrases.sort((a, b) => a.t0 - b.t0);
  const lanes = buildLanes(sections, duration, cues, warps, phrases);
  for (const s of sections) s.W.levelLin = Math.pow(10, s.W.level / 20);
  warps.forEach((w, i) => generateWarp(w, i, sections, events, lanes));
  for (const e of events) {
    if (e.t < 0) {
      e.dur = (e.dur || 0) + e.t;
      e.t = 0;
    }
  }
  events.sort((a, b) => a.t - b.t || (a.type < b.type ? -1 : 1));
  let maxSpan = 0;
  for (const e of events) maxSpan = Math.max(maxSpan, e.end - e.t);
  return {
    duration,
    total: duration + TAIL,
    events,
    lanes,
    maxSpan,
    warps: warps.map((w0) => {
      const { pivots, ...w } = w0;
      return { ...w, arrives: sections.some((s) => s.arrive === w0), pivots: pivots ? pivots.map((c) => c.chord.name) : [] };
    }),
    cues: cueEvents,
    phrases: phrases.map(({ c, line, ev, bars, ...p }) => ({ ...p, ev: ev ? ev.map((n) => ({ t: +n.t.toFixed(3), midi: n.midi, dur: +n.dur.toFixed(3) })) : undefined })),
    themes: themeStats(phrases, duration),
    registers: registerStats(sections, events),
    lineAudit: lineAudit(sections, phrases),
    voicingAudit: voicingAudit(sections),
    sections: sections.map((s) => ({
      index: s.index,
      world: s.world,
      label: s.W.label,
      t0: s.t0,
      t1: s.t1,
      cruiseEnd: s.cruiseEnd,
      arrive: s.arrive ? { ws: s.arrive.ws, we: s.arrive.we, ta: s.arrive.ta } : null,
      depart: s.depart ? { ws: s.depart.ws, we: s.depart.we, ta: s.depart.ta } : null,
      chapters: s.chapters,
      arrivalAt: s.arrive ? s.arrive.ta : null,
      centroid: s.W.centroid || null,
      anchorChecks: s.anchorChecks || [],
      chords: s.chords.map((c) => ({ t0: c.t0, t1: c.t1, name: c.chord.name, voicing: c.voicing.map(noteName), bass: noteName(c.chord.bass), lines: phrases.filter((p) => p.c === c && !p.duet).map((p) => p.name) })),
    })),
  };
}

// The same timing the fallback director uses (src/fallback/director.js), for when no director is present.
export function fallbackTimeline(order) {
  const HOLD = 10,
    TRAVEL = 6,
    INTRO = 3;
  const chapters = [{ id: 'intro', title: 'Intro', t0: 0, t1: INTRO }];
  let t = INTRO;
  for (const id of order) {
    chapters.push({ id, body: id, title: id, t0: t, t1: t + HOLD + TRAVEL });
    t += HOLD + TRAVEL;
  }
  const duration = t;
  const hz = 10;
  const n = Math.ceil(duration * hz) + 1;
  const warp = new Float32Array(n),
    fade = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const tt = i / hz;
    const ch = chapters.find((c) => tt >= c.t0 && tt < c.t1);
    if (!ch || !ch.body) continue;
    const lt = tt - ch.t0;
    const last = order.indexOf(ch.body) === order.length - 1;
    if (lt >= HOLD && !last) warp[i] = Math.sin(Math.PI * ((lt - HOLD) / TRAVEL));
  }
  return { chapters, duration, cues: { hz, warp, fade } };
}
