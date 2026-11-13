// Music theory core for the score: pitch parsing, seeded randomness, a voice-leading solver and the motif.
// Everything here is pure (no WebAudio) so the composer can run identically for live playback and offline renders.

// ------------------------------------------------------------------------------------------- randomness
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export class Rng {
  constructor(seed) {
    this.f = mulberry32(typeof seed === 'string' ? hashStr(seed) : seed);
  }
  next() {
    return this.f();
  }
  range(a, b) {
    return a + (b - a) * this.f();
  }
  int(a, b) {
    return a + Math.floor((b - a + 1) * this.f());
  }
  pick(arr) {
    return arr[Math.floor(this.f() * arr.length) % arr.length];
  }
  chance(p) {
    return this.f() < p;
  }
  gauss() {
    // Irwin-Hall approximation, plenty for humanisation
    return this.f() + this.f() + this.f() + this.f() - 2;
  }
  // exponential inter-arrival for a Poisson process of `rate` events per second
  exp(rate) {
    return -Math.log(1 - this.f() * 0.999999) / Math.max(1e-6, rate);
  }
}

// ------------------------------------------------------------------------------------------- pitch
const PC = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
const NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

export const pcOf = (name) => {
  if (!(name in PC)) throw new Error('bad pitch class ' + name);
  return PC[name];
};
export function midi(name) {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error('bad note ' + name);
  return 12 * (Number(m[2]) + 1) + pcOf(m[1]);
}
export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
export const mod12 = (m) => ((m % 12) + 12) % 12;
export const noteName = (m) => NAMES[mod12(Math.round(m))] + (Math.floor(Math.round(m) / 12) - 1);
export const parsePcs = (s) => s.trim().split(/\s+/).map(pcOf);

// A chord spec from worlds.js -> { name, bass (midi), pcs (priority order), req, motif, w, p, stack }
//   p      priority when a segment has no time for the whole progression (higher = kept longer; see fit())
//   stack  quartal chords: the voicing is written out as a stack of pitch classes, bottom to top, and is only
//          transposed by octaves (the solver would otherwise fold the fourths into seconds clusters)
export function chord(spec) {
  const stack = spec.stack ? parsePcs(spec.stack) : null;
  const pcs = spec.pcs ? parsePcs(spec.pcs) : [...new Set(stack)];
  return {
    name: spec.name,
    bass: midi(spec.bass),
    pcs,
    req: spec.req ? parsePcs(spec.req) : pcs.slice(0, Math.min(4, pcs.length)),
    motif: spec.motif || null,
    w: spec.w ?? 1,
    p: spec.p ?? 1,
    stack,
    final: !!spec.final,
    b9: !!spec.b9, // the chord asks for its minor ninth (e.g. F#sus4(b9)); otherwise minor ninths are avoided
  };
}

// A quartal (or any written-out) stack: each pitch class is placed above the previous one, then the whole
// stack is moved by octaves so its centre sits closest to the previous voicing's centre, inside [lo, hi].
export function stackVoicing(prev, stack, { lo = 48, hi = 81, n = 5, centre: target = null } = {}) {
  const rel = [stack[0]];
  for (let k = 1; k < stack.length; k++) {
    const last = rel[k - 1];
    let m = last + mod12(stack[k] - last);
    if (m === last) m += 12;
    rel.push(m);
  }
  while (rel.length < n) rel.push(rel[rel.length - 1] + 5);
  const v = rel.slice(0, n);
  // a world's own register (when given) wins over staying near the previous voicing
  const centre = target ?? prev.reduce((a, b) => a + b, 0) / prev.length;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  let best = null,
    bestD = Infinity;
  for (let o = -60; o <= 60; o += 12) {
    const lo0 = v[0] + o,
      hi0 = v[v.length - 1] + o;
    const out = Math.max(0, lo - lo0) + Math.max(0, hi0 - hi);
    const d = Math.abs(mean + o - centre) + 4 * out;
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  // a melody overhead: the top of the stack rests rather than collide with it (thinned from the top, >= 3 voices)
  const out = v.map((m) => m + best);
  while (out.length > 3 && out[out.length - 1] > hi) out.pop();
  return out;
}

// ------------------------------------------------------------------------------------------- voice leading
// Find the n-voice voicing (sorted, strictly rising) of pitch-class set `pcs` within [lo, hi] that moves
// least from `prev`, honouring classical constraints:
//   - every required tone present
//   - common tones held where possible (they cost nothing)
//   - penalties for parallel perfect fifths / octaves, doubled tones (doubling the root or fifth is cheap,
//     doubling a third/seventh/tension is not), minor ninths between voices, muddy close spacing low down,
//     wide gaps between upper voices, and voice crossing (impossible: candidates are kept sorted)
export function voiceLead(prev, pcs, req, { lo = 48, hi = 81, maxMove = 7, rootPc = null } = {}) {
  const n = prev.length;
  const pcSet = new Set(pcs);
  const cands = prev.map((p) => {
    const c = [];
    for (let m = Math.max(lo, p - maxMove); m <= Math.min(hi, p + maxMove); m++) if (pcSet.has(mod12(m))) c.push(m);
    return c;
  });
  let best = null,
    bestCost = Infinity;
  const cur = new Array(n);
  function cost() {
    let c = 0;
    for (let i = 0; i < n; i++) c += Math.abs(cur[i] - prev[i]);
    const counts = new Map();
    for (const m of cur) counts.set(mod12(m), (counts.get(mod12(m)) || 0) + 1);
    for (const r of req) if (!counts.has(r)) c += 9; // missing required tone
    for (const [p, k] of counts)
      if (k > 1) {
        const stable = rootPc !== null && (p === rootPc || p === (rootPc + 7) % 12);
        c += (stable ? 0.6 : pcs.length >= n ? 4.5 : 2.0) * (k - 1);
      }
    for (let i = 1; i < n; i++) {
      const iv = cur[i] - cur[i - 1];
      if (iv < 2) c += 5; // unison / minor-second clash inside the voicing
      if (iv < 3 && cur[i - 1] < 57) c += 4; // close seconds/thirds low down get muddy
      if (iv < 3 && cur[i - 1] < 53) c += 5; // a second below F3 is mud on any instrument
      if (iv > 12 && i > 1) c += 2; // big holes between upper voices
    }
    // minor ninths (or wider minor seconds) between any two voices: the harshest clash in a lush voicing
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (cur[j] - cur[i] > 12 && mod12(cur[j] - cur[i]) === 1) c += 4;
    // parallel perfect intervals (any pair), only when both voices actually move in the same direction
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const a = mod12(prev[j] - prev[i]),
          b = mod12(cur[j] - cur[i]);
        const di = cur[i] - prev[i],
          dj = cur[j] - prev[j];
        if (di !== 0 && Math.sign(di) === Math.sign(dj) && a === b && (a === 0 || a === 7)) c += 3;
      }
    return c;
  }
  function dfs(i, minNext) {
    if (i === n) {
      const c = cost();
      if (c < bestCost) {
        bestCost = c;
        best = cur.slice();
      }
      return;
    }
    for (const m of cands[i]) {
      if (m < minNext) continue;
      cur[i] = m;
      dfs(i + 1, m + 1);
    }
  }
  dfs(0, -Infinity);
  // a big register change (e.g. the pads making room for a melody): allow up to an octave per voice before
  // giving up on voice leading altogether
  if (!best && maxMove < 12) return voiceLead(prev, pcs, req, { lo, hi, maxMove: 12, rootPc });
  if (!best) {
    // nothing within reach (very distant key change): rebuild a fresh close voicing around the old centre
    const centre = prev.reduce((a, b) => a + b, 0) / n;
    const pool = [];
    for (let m = lo; m <= hi; m++) if (pcSet.has(mod12(m))) pool.push(m);
    pool.sort((a, b) => Math.abs(a - centre) - Math.abs(b - centre));
    best = pool.slice(0, n).sort((a, b) => a - b);
    while (best.length < n) best.push(best[best.length - 1] + 12);
  }
  return best;
}

// ------------------------------------------------------------------------------------------- voicing (v2)
// Variable-size voicing (3-5 voices) of pitch-class set `pcs` inside [lo, hi], led from `prev` (any size).
// Under a melody the ceiling drops, and instead of cramming five voices into a sixth the solver thins the
// chord: guide tones first (the first n-1 entries of `req`), colour tones left to the melody or a high halo.
// Hard rules (pruned): no unison or semitone between adjacent voices below C5, nothing closer than a major
// third below C3, upper gaps <= an octave, bottom gap <= a 12th. Costs: motion (nearest-voice distance, so
// common tones hold), missing guide tones, bad doublings, minor ninths (between voices, against the bass and
// against the melody: effectively forbidden unless the chord asks for b9), low thirds/seconds, crowding in the
// A2-A3 band, a 5-voice span under an octave, parallel fifths/octaves, and fewer voices than nMax.
// Register (v3): `centre` (MIDI) pulls the voicing's mean toward a world's own register (kc per semitone), so the
// line moves between worlds instead of parking in one octave; `spread` (semitones, bottom to top) prefers an open
// or a close voicing; `maxGap` lets a world leave a wide hole in the middle (Neptune); `inner` are the notes of a
// counter-melody inside the accompaniment's register: no voice may sit a semitone / minor ninth from one (either
// way) or double it.
export function voiceChord(prev, pcs, req, { lo = 45, hi = 79, rootPc = null, bass = null, nMax = 5, nMin = 3, melody = [], b9 = false, centre = null, kc = 1.2, spread = null, maxGap = 12, inner = [], motion = 1 } = {}) {
  const pcSet = new Set(pcs);
  const pool = [];
  for (let m = lo; m <= hi; m++) if (pcSet.has(mod12(m))) pool.push(m);
  const P = prev.length;
  let best = null,
    bestCost = Infinity;
  const cur = [];
  const near = (arr, m) => {
    let d = Infinity;
    for (const p of arr) d = Math.min(d, Math.abs(m - p));
    return Math.min(d, 12);
  };
  function cost() {
    const n = cur.length;
    let c = 0,
      a = 0,
      b = 0;
    for (const m of cur) a += near(prev, m);
    for (const p of prev) b += near(cur, p);
    c += motion * ((a * 5) / n + (0.5 * b * 5) / P);
    if (centre !== null) {
      let s = 0;
      for (const m of cur) s += m;
      c += kc * Math.abs(s / n - centre);
    }
    if (spread !== null) c += 0.35 * Math.abs(cur[n - 1] - cur[0] - spread);
    for (const m of cur)
      for (const q of inner) {
        const d = Math.abs(m - q);
        if (d === 0) c += 4;
        else if (mod12(d) === 1) c += 14; // a semitone / minor ninth against the counter-melody (either way)
      }
    const counts = new Map();
    for (const m of cur) counts.set(mod12(m), (counts.get(mod12(m)) || 0) + 1);
    const k = Math.min(req.length, Math.max(n - 1, 3)); // guide tones: all of a triad, n-1 of a richer chord
    req.forEach((r, i) => {
      if (!counts.has(r)) c += i < k ? 9 : 1.5;
    });
    for (const [p, cnt] of counts)
      if (cnt > 1) {
        const stable = rootPc !== null && (p === rootPc || p === (rootPc + 7) % 12);
        c += (stable ? 0.6 : pcs.length >= n ? 4.5 : 2.0) * (cnt - 1);
      }
    let band = 0;
    for (let i = 0; i < n; i++) {
      const m = cur[i];
      if (m < 48) c += 1; // prefer C3 and up when there is room
      if (m >= 45 && m < 57) band++;
      if (bass !== null) {
        const d = m - bass;
        if (m < 48 && d > 0 && mod12(d) !== 0 && mod12(d) !== 7) c += 8; // only 5ths/8ves over the bass down there
        if (d > 12 && mod12(d) === 1 && !b9) c += 20;
        if (d > 0 && d < 3) c += 10;
      }
      if (i > 0) {
        const iv = m - cur[i - 1];
        if (iv < 3 && cur[i - 1] < 53) c += 6;
        else if (iv < 3 && cur[i - 1] < 57) c += 3;
        if (iv === 2 && cur[i - 1] < 60) c += 1.5;
        if (iv > 12 && i > 1) c += maxGap > 12 ? 0.3 : 2;
        if (iv > 12 && i === 1) c += 0.8;
      }
      for (let j = i + 1; j < n; j++) {
        const iv = cur[j] - m;
        if (iv > 12 && mod12(iv) === 1 && !b9) c += 20;
      }
      for (const mm of melody) {
        const iv = mm - m;
        if (iv > 0 && mod12(iv) === 1) c += 14; // a minor ninth under the tune: worse than dropping a guide tone
        if (iv === 0) c += 3; // doubling the tune in the pad blurs it
      }
    }
    if (band > 2) c += 3 * (band - 2); // too many voices in A2-A3: that band turns to mud first
    if (n === 5 && cur[4] - cur[0] < 12) c += 6;
    if (n === 4 && cur[3] - cur[0] < 9) c += 4;
    c += (nMax - n) * 2;
    if (n === P)
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const pa = mod12(prev[j] - prev[i]),
            pb = mod12(cur[j] - cur[i]);
          const di = cur[i] - prev[i],
            dj = cur[j] - prev[j];
          if (di !== 0 && Math.sign(di) === Math.sign(dj) && pa === pb && (pa === 0 || pa === 7)) c += 3;
        }
    return c;
  }
  function dfs(start, n) {
    if (cur.length === n) {
      const c = cost();
      if (c < bestCost) {
        bestCost = c;
        best = cur.slice();
      }
      return;
    }
    for (let i = start; i < pool.length; i++) {
      if (pool.length - i < n - cur.length) break;
      const m = pool[i];
      if (cur.length) {
        const last = cur[cur.length - 1];
        const iv = m - last;
        if (iv > (cur.length === 1 ? 19 : maxGap)) break; // pool is ascending: every later pitch is further
        if (iv < 2 && last < 72) continue;
        if (last < 48 && iv < 4) continue;
      }
      cur.push(m);
      dfs(i + 1, n);
      cur.pop();
    }
  }
  for (let n = nMax; n >= nMin; n--) dfs(0, n);
  if (!best) {
    const fb = voiceLead(prev.length === 5 ? prev : [...prev, ...prev].slice(0, 5), pcs, req, { lo, hi, rootPc });
    best = [...new Set(fb)].sort((x, y) => x - y);
  }
  return best;
}

// ------------------------------------------------------------------------------------------- themes
// Themes are contours in SCALE STEPS from their first note, so transposition, inversion, augmentation and
// sequence are real operations on them and every realisation stays in the mode it is placed in.
// Entries: [onset in beats, scale steps from the first note, duration in beats, accent].
//
// Two themes and their family (see the thematic plan in worlds.js):
//   A  "the pale blue motif": 5 - 3' - 2' - 1', a rising sixth that falls home by step (Earth's theme)
//   L  "the light": 5 - 9 - 3' - #4', rising fifths and steps up to the Lydian raised fourth (the Sun's theme)
const MODES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  aeolian: [0, 2, 3, 5, 7, 8, 10],
  minor: [0, 2, 3, 5, 7, 8, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
};
export function scaleOf(spec) {
  const [tonic, mode] = spec.trim().split(/\s+/);
  const t = pcOf(tonic);
  return MODES[mode || 'major'].map((x) => (x + t) % 12);
}
export function stepScale(m, steps, pcs) {
  let x = m,
    k = Math.abs(steps);
  const dir = Math.sign(steps);
  while (k > 0) {
    x += dir;
    if (pcs.includes(mod12(x))) k--;
  }
  return x;
}
export const THEMES = {
  SEED: [[0, 0, 1.5, 0.8], [1.5, 5, 3.5, 1]],
  A: [[0, 0, 1, 0.85], [1, 5, 1.5, 1], [2.5, 4, 0.5, 0.75], [3, 3, 2.5, 0.8]],
  A2: [[0, 0, 1, 0.85], [1, 5, 1.5, 1], [2.5, 4, 0.5, 0.75], [3, 8, 3, 0.9]], // soaring: the last step leaps to the 6th
  A_APP: [[0, 0, 1, 0.85], [1, 6, 0.75, 1, 'app'], [1.75, 5, 0.75, 0.85], [2.5, 4, 0.5, 0.75], [3, 3, 3, 0.8]], // the 11th leans on the 3rd
  A_HORN: [[0, 0, 1.5, 0.9], [1.5, 5, 2, 1], [3.5, 4, 1, 0.8], [4.5, 3, 3, 0.85]], // a broad horn call (augmented, dotted)
  A_EXT: [[0, 0, 1, 0.85], [1, 5, 1.5, 1], [2.5, 4, 0.5, 0.75], [3, 5, 0.75, 0.85], [3.75, 4, 0.75, 0.75], [4.5, 3, 3, 0.8]], // the cadence delayed
  A_BROKEN: [[0, 0, 1.5, 0.85], [1.5, 5, 2.5, 1], [5, 4, 3, 0.7]], // stops on the 2nd: unresolved
  A_DEEP: [[0, 0, 2, 0.85], [2, 5, 2, 1], [4, 4, 1, 0.75], [5, 3, 3, 0.8]], // slow and even, in the bass (Venus)
  A_HOME: [[0, 0, 1.25, 0.85], [1.25, 5, 1.75, 1], [3, 4, 0.75, 0.8], [3.75, 3, 3.5, 0.8]], // the return, broadened
  INV: [[0, 0, 1, 0.85], [1, -5, 1.5, 1], [2.5, -4, 0.5, 0.75], [3, -3, 2.5, 0.8]], // the motif upside down
  B: [[0, 0, 1, 0.8], [1, -1, 3, 0.75]],
  B2: [[0, 0, 0.75, 0.85], [0.75, -1, 1, 0.8], [1.75, -2, 3, 0.75]],
  END: [[0, 0, 1, 0.8], [1, -1, 1, 0.75], [2, -2, 5, 0.7]],
  SIXTH: [[0, 0, 1, 0.85], [1, 5, 2.5, 1]], // the motif's head alone
  SIXTH_DOWN: [[0, 0, 1, 0.85], [1, -5, 2.5, 0.9]],
  L: [[0, 0, 1.5, 0.8], [1.5, 4, 1, 0.9], [2.5, 5, 0.75, 0.85], [3.25, 6, 3.5, 1]],
  L_HEAD: [[0, 0, 1, 0.8], [1, 4, 1, 0.9], [2, 8, 2.5, 1]], // the light's skeleton: stacked fifths
  L_TAIL: [[0, 0, 1, 0.9], [1, -1, 1, 0.8], [2, -2, 2.5, 0.75]],
  // semitone contours (not diatonic): Uranus's quartal fragments
  QUARTAL: { semis: true, notes: [[0, 0, 1, 0.85], [1, 5, 1, 0.9], [2, 10, 2.5, 1]] },
  QUARTAL_DOWN: { semis: true, notes: [[0, 0, 1, 0.9], [1, -5, 1, 0.85], [2, -10, 2.5, 0.8]] },
};
// ------------------------------------------------------------------------------------------- tunes
// The long themes: 8-16 bar melodies that span several chords, with an antecedent and a consequent, written out
// note by note in the key they are heard in (they are composed against their harmony, so they are absolute
// pitches, not contours). Each bar sounds over one chord of a world's progression (worlds.js `tunes`: the span of
// written chords); the composer gives each chord of the span the time its bar needs (harmonic rhythm follows the
// tune), so the tune's phrase structure always lines up with the chord changes, whatever the cut.
// Notation: `Pitch:beats` with `^` (the phrase's peak, accent 1.0) or `-` (light, 0.7), `*` (a passing note or an
// appoggiatura: allowed to rub against the chord), `r:beats` a rest, `|` a bar line (checked: a note may tie over
// it). Bars are `bars` beats long; parts share the bars (the melody and its counter-melody).
//
// THE HOME THEME. One melody, heard whole four times. It is a sentence: the pale blue motif (a rising sixth that
// falls home by step, 5 - 3' - 2' - 1'), the motif again a step higher over ii, again a fourth higher over IV to
// the peak, then the whole scale falling from the peak through V to the tonic:
//     (A4) F#5 E5 D5 . (B4) G5 F#5 E5 . (D5) B5 A5 G5 . (B5) A5 G5 F#5 E5 | D5
//          I               ii              IV              V9              I
//   HOME     Earth arrival, complete: felt piano, a cello in contrary motion from bar 2 (parallel sixths under the
//            cadence), the strings taking the tune from the peak; it resolves on the sunrise over the limb
//   RISE     Earthrise, developed: the head, then straight to the peak (the middle step left out), the voice's
//            first full line; left open on D/E as we leave home
//   ECLIPSE  Saturn, in E, the solo soprano with glass an octave above: head, peak (C#6, the highest note of the
//            film's melody), the falling scale, a deceptive cadence (vi) and an echo of the fall, settling on the 4th
//   FINALE_A the pull-back, intimate: the first two steps of the theme alone on the piano, slower, over IV and ii
//            (the tonic withheld)
//   FINALE   the pale blue dot: the theme whole and transformed (piano, voice, strings, horn an octave below), its
//            upbeat on the dominant so the sixth lands exactly on the dot; head, peak, the falling scale, home
// `@-1` starts a part one beat before its first bar (an upbeat over the chord before); `elastic` bars absorb
// whatever time a cut leaves over (a final held note), so the tune's tempo never depends on it.
//   NEPTUNE  the theme alone and far from home: its first step in B minor (the sixth now minor), then on G, where it
//            stops on the raised fourth, unresolved; a high piano over the deep pad, slow, with long silences
//   MARS     the theme's second step (B G F# E: the motif in E minor) spun into an 8-bar Dorian tune on a dry piano,
//            one bar per chord of the 84 BPM pulse, reaching the Dorian sixth (C#6)
export const TUNES = {
  HOME: {
    beat: 0.92,
    bars: [8, 8, 8, 8, 6],
    elastic: [4],
    parts: {
      mel: 'r:1 A4:1 F#5:2^ E5:1 D5:2 B4:1- | G5:2^ F#5:1 E5:4 D5:1- | B5:2^ A5:1 G5:4 B5:1- | A5:2 G5:1 F#5:2 E5:3 | D5:6',
      counter: 'r:8 | E3:2 G3:2 B3:3 A3:1 | G3:3 B3:2 D4:3 | C#4:2 B3:2 A3:2 G3:2 | F#3:6',
    },
  },
  RISE: {
    beat: 0.82,
    bars: [8, 8, 4],
    parts: {
      mel: 'r:.5 A4:1 F#5:2^ E5:1 D5:2.5 D5:1- | B5:2.5^ A5:1 G5:3 B5:1.5- | A5:1.5 F#5:.5- E5:2',
      counter: 'r:2 F#3:3 A3:3 | G3:2 B3:3 D4:3 | D4:2 B3:2',
    },
  },
  ECLIPSE: {
    beat: 0.88,
    bars: [8, 8, 8, 8, 8],
    elastic: [4],
    parts: {
      mel: 'r:1 B4:1 G#5:2^ F#5:1 E5:2 E5:1- | C#6:2.5^ B5:1 A5:3.5 C#6:1- | B5:2 A5:1 G#5:2 F#5:3 | E5:3 r:1 G#5:2 F#5:1 E5:1 | C#5:2 B4:6',
    },
  },
  FINALE_A: {
    beat: 1.0,
    bars: [8, 8],
    parts: {
      mel: 'r:2 A4:1 F#5:2 E5:1 D5:2 | r:1 B4:1 G5:2 F#5:1 E5:3',
    },
  },
  FINALE: {
    beat: 0.8,
    bars: [8, 6, 6, 8],
    elastic: [3],
    parts: {
      mel: '@-1 A4:1 F#5:2^ E5:1 D5:4 D5:1- | B5:2^ A5:1 G5:2 B5:1- | A5:1.5 G5:1 F#5:1.5 E5:2 | D5:8',
      counter: 'r:2 F#3:3 A3:3 | G3:2 B3:2 D4:2 | C#4:1.5 B3:1 A3:1.5 G3:2 | F#3:8',
    },
  },
  NEPTUNE: {
    beat: 1.25,
    bars: [8, 8],
    parts: {
      mel: 'r:1.5 F#5:1.5 D6:2.5^ C#6:1 B5:1.5 | r:1.5 G5:1.5 E6:2 D6:1 C#6:2',
    },
  },
  MARS: {
    beat: 0.714,
    bars: [4, 4, 4, 4, 4, 4, 4, 4],
    elastic: [7],
    parts: {
      mel: 'r:1 B4:1 G5:1.5^ F#5:.5- | E5:3 E5:1- | B5:1.5^ A5:.5- G5:1 F#5:1 | E5:1.5 C#6:2.5^ | B5:1.5 A5:.5- G5:1.5 E5:.5- | E5:1 F#5:1 A5:2 | B5:2^ A5:.5- F#5:.5- E5:1 | F#5:1 E5:.5- D5:.5- B4:2',
    },
  },
};
// -> { bars: [beats], starts: [beat each bar starts], parts: { name: [{ on, midi, dur, acc, app }] } } (beats absolute)
export function parseTune(name) {
  const T = TUNES[name];
  if (!T) throw new Error('unknown tune ' + name);
  const starts = [];
  let s = 0;
  for (const b of T.bars) {
    starts.push(s);
    s += b;
  }
  const total = s;
  const parts = {};
  for (const [part, src] of Object.entries(T.parts)) {
    const out = [];
    let pos = 0,
      bar = 0,
      lastOn = 0;
    for (const tok of src.trim().split(/\s+/)) {
      if (tok[0] === '@') {
        pos = Number(tok.slice(1)); // an upbeat: the part starts before its first bar
        lastOn = pos - 1;
        continue;
      }
      if (tok === '|') {
        bar++;
        const at = starts[bar];
        if (at === undefined || pos < at - 1e-6 || lastOn >= at - 1e-6) throw new Error(`tune ${name}.${part}: bar ${bar} does not line up (at beat ${pos}, bar starts ${at})`);
        continue;
      }
      const m = /^(r|[A-G][#b]?\d):([\d.]+)([\^*-]*)$/.exec(tok);
      if (!m) throw new Error(`tune ${name}.${part}: bad token ${tok}`);
      const d = Number(m[2]);
      const f = m[3];
      if (m[1] !== 'r') out.push({ on: pos, midi: midi(m[1]), dur: d, acc: f.includes('^') ? 1 : f.includes('-') ? 0.7 : 0.82, app: f.includes('*') });
      lastOn = pos;
      pos += d;
    }
    if (Math.abs(pos - total) > 1e-6) throw new Error(`tune ${name}.${part}: ${pos} beats, bars sum to ${total}`);
    parts[part] = out;
  }
  return { beat: T.beat, bars: T.bars.slice(), starts, total, parts, elastic: new Set(T.elastic || []) };
}

export const themeNotes = (th) => (Array.isArray(th) ? th : th.notes);
export function themeBeats(th) {
  let end = 0;
  for (const [on, , d] of themeNotes(th)) end = Math.max(end, on + d);
  return end;
}
// -> [{ on (beats), midi, dur (beats), acc }]
export function realize(name, { from, scale, inv = false }) {
  const th = THEMES[name];
  if (!th) throw new Error('unknown theme ' + name);
  const start = typeof from === 'number' ? from : midi(from);
  const pcs = scale ? scaleOf(scale) : null;
  const semis = !Array.isArray(th) && th.semis;
  if (!semis && pcs && !pcs.includes(mod12(start))) throw new Error(`theme ${name}: ${from} is not in ${scale}`);
  return themeNotes(th).map(([on, s, d, acc, tag]) => {
    const k = inv ? -s : s;
    return { on, midi: semis || !pcs ? start + k : stepScale(start, k, pcs), dur: d, acc: acc ?? 0.85, app: tag === 'app' };
  });
}

// ------------------------------------------------------------------------------------------- the motif (v1)
// The original semitone phrases, kept for the cold open's seed fallback and tools.
export const PHRASES = {
  major: {
    SEED: [[0, 7, 1.5, 0.8], [1.5, 16, 3.5, 1]],
    A: [[0, 7, 1, 0.85], [1, 16, 1.5, 1], [2.5, 14, 0.5, 0.75], [3, 12, 2.5, 0.8]],
    A2: [[0, 7, 1, 0.85], [1, 16, 1.5, 1], [2.5, 14, 0.5, 0.75], [3, 21, 3, 0.9]],
    B: [[0, 9, 1, 0.8], [1, 7, 3, 0.75]],
    B2: [[0, 11, 0.75, 0.85], [0.75, 9, 1, 0.8], [1.75, 7, 3, 0.75]],
    END: [[0, 16, 1, 0.8], [1, 14, 1, 0.75], [2, 12, 5, 0.7]],
  },
  minor: {
    SEED: [[0, 7, 1.5, 0.8], [1.5, 15, 3.5, 1]],
    A: [[0, 7, 1, 0.85], [1, 15, 1.5, 1], [2.5, 14, 0.5, 0.75], [3, 12, 2.5, 0.8]],
    A2: [[0, 7, 1, 0.85], [1, 15, 1.5, 1], [2.5, 14, 0.5, 0.75], [3, 19, 3, 0.9]],
    B: [[0, 8, 1, 0.8], [1, 7, 3, 0.75]],
    B2: [[0, 10, 0.75, 0.85], [0.75, 8, 1, 0.8], [1.75, 7, 3, 0.75]],
    END: [[0, 15, 1, 0.8], [1, 14, 1, 0.75], [2, 12, 5, 0.7]],
  },
};
export function phraseBeats(ph) {
  let end = 0;
  for (const [on, , d] of ph) end = Math.max(end, on + d);
  return end;
}
