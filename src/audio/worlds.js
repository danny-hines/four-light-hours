// The harmonic plan: one musical "world" per stop on the journey.
//
// Key scheme (tonal home is D — the Sun's light and Earth's home share it, and the finale returns to it):
//   cold open  D (open fifth)          stars fade up out of a single low D
//   Sun        D Lydian                radiant: Dmaj9#11 / E over D — the raised 4th is the "light"
//   Mercury    A fifths, Bb side-slip  sparse, airless, tense: bare fifths over an A pedal slip a semitone up
//   Venus      Bb major (bVI of D)     warm and muffled under 92 bar of CO2; ends on A7sus4, the dominant of home
//   Earth      D major 9               the tender motif on felt piano; minor iv (Gm6) for the ache
//   Moon       G -> D                  Earthrise: the motif sung, intimate
//   Mars       E Dorian                same notes as Earth, new centre: a rusty pulse with the Dorian IV (A/E)
//   Belt       C Lydian                suspended; granular pebbles. C shared with Jupiter
//   Jupiter    C minor (i-bVI-bVII)    vast low brass swells; the motif in minor on the horns
//   Saturn     E major                 Ab -> E is a hexatonic-pole shift (Ab = G# held): an ethereal lift; choir
//   Uranus     F# quartal              cold written-out stacks of fourths, FM bells, almost no bass
//   Neptune    B minor                 deep and lonely: the motif alone, its sixth now minor; ends on Asus4
//   Finale     D major                 the motif returns whole and resolves to Dmaj9#11 (the Sun's Lydian sparkle)
//
// Every world ends on a `cadence` chord that shares common tones with the next world's first chord, so the
// voice-leading solver can carry the pad voices across the warp with minimal motion.
//
// Chord specs: pcs are listed in priority order (the first four are required in the voicing unless `req`).

// Chord `p` = priority when a segment's time cannot hold the whole progression (fit() in composer.js): the
// first chord, the chord that leads into an anchor (the dominant before Earthrise, the eclipse, the pale blue
// dot) and the cadence are always kept; the rest are kept in order of p.
//
// THE THEMATIC PLAN (`lines`): two themes (theory.js THEMES, contours in scale steps) and their development.
//   A  the pale blue motif, 5 - 3' - 2' - 1' (a rising sixth that falls home by step): Earth's theme
//   L  the light, 5 - 9 - 3' - #4' (rising fifths, then steps up to the Lydian raised fourth): the Sun's theme
//   cold open  the seed of A (its rising sixth) on a distant bell
//   Sun        L sung by the solo voice on the reveal, its tail falling on a bell, A's head far away on glass
//   Mercury    L's skeleton (stacked fifths) side-slipping with the harmony: A, Bb, G; quartal glass
//   Venus      A buried: a dark low horn under the clouds (F2 D3 C3 Bb2); the seed again over the dominant
//   Earth      A on felt piano, its answer B; the night side's minor answer; A2 (soaring) at sunrise; the voice's
//              first entry over Em9; A_APP (the 11th leaning on the 3rd) for piano and voice at Earthrise
//   Mars       fragmentation: A's rising sixth alone, in time with the 84 BPM pulse; Earth's own A -> F# over D
//   belt       the sixth on a bell, L's skeleton on glass
//   Jupiter    the horn call assembling itself: its head, the head a fourth higher, then A_HORN (augmented,
//              dotted) at the cloud-top skim, riding into the departure
//   Saturn     L on glass as the rings catch the light; A_EXT (the cadence delayed) sung at the eclipse; B2
//   Uranus     quartal bell fragments and INV (A upside down) on cold rotating bells
//   Neptune    A_BROKEN (stops on the 2nd, unresolved) alone on a high piano; a distant voice; L's skeleton
//   finale     L's skeleton over G, the night side's answer, A whole after the real V -> I, END over home
// compose-check / render.mjs assert: no stretch > 40 s without a melodic event, < 50% of motif statements in
// one rhythm, no melody note a semitone / minor ninth against the harmony, no voicing rub below C5.
// Line fields: at (written chord index, or 'cad'), delay (s into it), theme, from, scale, inst (piano | voice |
// horn | bell | glass, or a list for a duet), beat (s) or fit (to the chord), role ('theme' | fragment),
// vel, duck (how hard the accompaniment makes room, 0..1), ride (may carry into the departure leg), lh (piano
// left hand), coda (the last phrase's bell and glass), clash (a written rub, e.g. Mercury's side-slip), cold.
//
// Spectral design (lanes.tilt = [low shelf dB @ 180 Hz, high shelf dB @ 4 kHz] on the music bus, plus the pad
// low-pass, pad high-pass and felt-piano low-pass): each world has its own colour, and `centroid` is the band
// chosen for that world (render.mjs checks every world lands inside its own band):
//   intro dark ~300 Hz | Sun radiant ~900 | Mercury thin, bright ~1.9k | Venus muffled ~300 | Earth open ~600 |
//   Mars rusty ~450 | belt glittering ~750 | Jupiter vast, horn-lit ~650 | Saturn ethereal ~650 | Uranus icy ~1.1k
//   Neptune deep ~450 | finale warm-bright ~600
// impact (0..1) sizes the arrival: a sub drop for the giants, none for Venus, Uranus and Neptune (their reveal is a
// soft bloom). lanes.chorus scales the pad's stereo chorus (thin, high worlds decorrelate easily).
//
// THE LONG THEMES (`tunes`, theory.js TUNES): 8-16 bar melodies laid over a span of written chords, one bar per
// chord (`span: [first, last]`, 'cad' = the cadence). The span's chords are always kept and get the time their bars
// need, so harmonic rhythm follows the tune: HOME at Earth's arrival (piano, cello counter-melody), RISE at Earthrise
// (piano and voice), ECLIPSE at Saturn (solo soprano, to C#6, the film's melodic high point), FINALE (piano, cello,
// the voice joining on the pale blue dot, strings growing under it). `alt` = the fragments used instead if a cut
// leaves no room for the tune. The fragments (`lines`) are the connective tissue between them.
//
// REGISTER (`reg`): each world's own register for the voice-led line (theory.js voiceChord): centre (MIDI, the
// voicing's mean is pulled toward it), spread (bottom to top), lo / hi, maxGap, nMax. The arrival chord moves there
// almost freely; compose-check asserts the top-voice median moves by a minor third or more between neighbours.
//   Sun open and high (top ~B4) | Mercury bare and low (pads an octave up: thin) | Venus thick under the clouds |
//   Earth warm, low under the piano | Mars rusty mid | belt high glitter (top ~C5) | Jupiter vast and low (A1-C4) |
//   Saturn lifted | Uranus close and high (top E5-A5) | Neptune deep and wide, a hole in the middle | finale warm
// HARMONIC RHYTHM (`chordDur`, s): Mercury side-slips every ~3 s, Mars changes every bar of its 84 BPM pulse
// (`grid`: chord changes land on bar lines), Uranus's stacks rotate every ~4.5 s; the Sun, Venus, the belt and Neptune
// move every 9-12 s, Jupiter's pedals 13 s; Earth, Saturn's eclipse and the finale follow their tunes (the finale's
// bars shorten 6-4-3-3 beats toward the V -> I).
//
// THE LEGS (`approach`, the world being arrived at): its pivot chords (laid into the departing world's timeline once
// the camera moves; the last one prepares the arrival: V, V7sus, bVII or a planed sus chord) and the leg's gesture
// (composer.js GESTURES): riser | hush | choir | streak (`inst`: pluck | bell) | brass.

export const WORLDS = {
  intro: {
    label: 'Cold open — D open fifth, stars fade up',
    key: { tonic: 'D4', mode: 'major' },
    chordDur: 30,
    prog: [{ name: 'D5(add9)', bass: 'D2', pcs: 'A D E' }],
    cadence: null,
    impact: 0.3,
    centroid: [200, 450], // the world's own spectral band (render.mjs checks it)
    reg: { centre: 55 },
    level: -6,
    arc: 2,
    lanes: { padCut: 520, padQ: 0.7, cutMod: [23, 0.35], wet: 1.25, vowel: ['u', 'o'], breath: 0.0, air: [0.05, 1800, 0.6], rumble: [0.018, 140], am: [0.07, 0.4], tilt: [0, -1] },
    layers: {
      pad: { voices: [0, 1, 2, 3], wave: 'soft', detune: 6, drift: 5, lfo: 0.05, attack: 6, release: 7, vel: 0.65 },
      sub: { vel: 0.3, attack: 6, release: 7 },
      glass: { rate: 0.22, range: [74, 93], decay: 6, vel: 0.22, from: 0.25 },
      seed: { inst: 'bell', at: 0.5, vel: 0.5, oct: 0 },
      grains: [{ rate: 2.2, f: [5200, 11000], q: 9, dur: [0.03, 0.09], vel: 0.08, buf: 'white', from: 0.15 }],
    },
  },

  sun: {
    label: 'The Sun — D Lydian radiant swell, solar p-modes',
    key: { tonic: 'D4', mode: 'major' },
    chordDur: 9,
    prog: [
      { name: 'Dmaj9#11', bass: 'D2', pcs: 'F# C# G# E A', w: 2 },
      { name: 'E/D', bass: 'D2', pcs: 'E G# B F#', w: 1.5, p: 3 },
      { name: 'C#m11', bass: 'C#2', pcs: 'E G# B F#', w: 1.5, p: 2 },
      { name: 'Bm9', bass: 'B1', pcs: 'D A C# F# B', w: 1.5, p: 2.5 },
      { name: 'Dmaj9#11', bass: 'D2', pcs: 'F# C# G# E A', w: 2, p: 1 },
      { name: 'E/D', bass: 'D2', pcs: 'E G# B F#', w: 2, p: 1.5 },
    ],
    cadence: { name: 'Esus4', bass: 'E2', pcs: 'A B E' },
    // the Light theme, sung, on the Sun's reveal: rising through the Lydian to the raised fourth (held: G# is the
    // light), its tail falling on a bell, then the head of Earth's motif heard for the first time, far away
    lines: [
      { at: 0, delay: 2.2, theme: 'L', from: 'A4', scale: 'D lydian', inst: 'voice', beat: 1.0, role: 'theme' },
      { at: 1, delay: 1.0, theme: 'L_TAIL', from: 'G#5', scale: 'D lydian', inst: 'bell', beat: 0.8 },
      { at: 2, delay: 1.0, theme: 'L_HEAD', from: 'C#5', scale: 'E major', inst: 'glass', beat: 0.8 },
      { at: 3, delay: 0.8, theme: 'SIXTH', from: 'F#5', scale: 'D major', inst: 'glass', beat: 0.9 },
      { at: 4, delay: 1.0, theme: 'L_HEAD', from: 'A5', scale: 'D lydian', inst: 'glass', beat: 0.8 },
    ],
    reg: { centre: 63, spread: 22 },
    impact: 0.5,
    centroid: [650, 1400], // the world's own spectral band (render.mjs checks it)
    level: 0,
    arc: 3,
    lanes: { padCut: 5200, padQ: 0.8, cutMod: [11, 0.3], wet: 1.0, vowel: ['a', 'e', 'a'], breath: 0.25, air: [0.06, 6500, 0.6], rumble: [0.03, 220], am: [0.31, 0.55], tilt: [-2, 3.5] },
    layers: {
      pad: { voices: [0, 1, 2, 3, 4], wave: 'saw', detune: 11, drift: 7, lfo: 0.09, attack: 4.5, release: 6, vel: 0.85 },
      choir: { voices: [2, 3, 4], vel: 0.55, attack: 5, release: 6, from: 0.18, to: 1 },
      sub: { vel: 0.24, attack: 3.5, release: 6 },
      bells: { rate: 0.6, ratio: 3.5, index: 1.6, decay: 4.5, range: [81, 98], vel: 0.4, phrase: [2, 5], gap: [0.14, 0.3] },
      glass: { rate: 0.34, range: [86, 100], decay: 5, vel: 0.22 },
      shimmer: { rate: 5, range: [93, 105], vel: 0.08 },
      pmodes: { vel: 0.2 },
      grains: [{ rate: 7, f: [2500, 9000], q: 3, dur: [0.012, 0.05], vel: 0.24, buf: 'white' }],
    },
  },

  mercury: {
    label: 'Mercury — bare fifths over an A pedal, side-slipping a semitone; thin, airless, bright',
    key: { tonic: 'A3', mode: 'minor' },
    chordDur: 3.2, // nervous side-slips every ~3 s
    prog: [
      { name: 'A5 (stacked fifths)', bass: 'A1', pcs: 'E B A', req: 'E B A' },
      { name: 'Bb5 over A (side-slip)', bass: 'A1', pcs: 'F C Bb', req: 'F C Bb', p: 3, b9: true },
      { name: 'A5', bass: 'A1', pcs: 'E B A', req: 'E B A', p: 1 },
      { name: 'G5 over A', bass: 'A1', pcs: 'D A G', req: 'D A G', p: 2.5 },
      { name: 'A5', bass: 'A1', pcs: 'E B A', req: 'E B A', p: 1.2 },
      { name: 'Bb5 over A', bass: 'A1', pcs: 'F C Bb', req: 'F C Bb', p: 2, b9: true },
      { name: 'C5 over A', bass: 'A1', pcs: 'G D C', req: 'G D C', p: 1.5 },
    ],
    cadence: { name: 'Bb5', bass: 'Bb1', pcs: 'F C Bb', req: 'F C Bb' },
    // the Light theme's skeleton (stacked fifths), side-slipping with the harmony: A, Bb, G
    lines: [
      { at: 0, delay: 0.6, theme: 'L_HEAD', from: 'A4', scale: 'A dorian', inst: 'piano', beat: 0.55 },
      { at: 2, delay: 0.3, theme: 'QUARTAL_DOWN', from: 'E6', inst: 'glass', beat: 0.55 },
      { at: 3, delay: 0.3, theme: 'L_HEAD', from: 'G4', scale: 'G major', inst: 'piano', beat: 0.55 },
      { at: 5, delay: 0.3, theme: 'L_HEAD', from: 'Bb4', scale: 'Bb lydian', inst: 'glass', beat: 0.55, clash: true },
    ],
    reg: { lo: 50, hi: 62, centre: 54, nMax: 3 },
    // arriving from the Sun: sus chords planing up by step, the last a semitone under Mercury's A (a side-slip)
    approach: { gesture: 'riser', chords: [{ name: 'F#sus4', bass: 'F#1', pcs: 'B C# F#' }, { name: 'G#sus4', bass: 'G#1', pcs: 'C# D# G#' }] },
    impact: 0.35,
    centroid: [900, 2400], // the world's own spectral band (render.mjs checks it)
    level: -0.5,
    arc: 2,
    lanes: { chorus: 0.35, padCut: 2600, padQ: 2.2, cutMod: [7, 0.3], wet: 0.6, vowel: ['i', 'e'], breath: 0.0, air: [0.07, 7000, 1.4], rumble: [0, 90], am: [5.3, 0.15], tilt: [-7, 5.5], padHP: 300 },
    layers: {
      pad: { voices: [2, 3, 4], wave: 'hollow', detune: 4, drift: 3, lfo: 0.13, attack: 2.5, release: 5, vel: 0.7, tremolo: [6.2, 0.22], oct: 12 },
      glass: { rate: 0.14, range: [84, 98], decay: 5, vel: 0.32, dyad: 7 },
      ticks: { rate: 2.6, vel: 0.9 },
      whine: { vel: 0.08, midi: [88, 95] },
      piano: { arps: 0, lowHits: 0.07, hitsUp: 24, vel: 0.45 },
    },
  },

  venus: {
    label: 'Venus — Bb major 9, muffled, under 92 atmospheres',
    key: { tonic: 'Bb3', mode: 'major' },
    chordDur: 9.5,
    prog: [
      { name: 'Bbmaj9', bass: 'Bb1', pcs: 'D A C F', w: 2 },
      { name: 'Gm9', bass: 'G1', pcs: 'Bb F A D', w: 1.5, p: 1.5 },
      { name: 'Ebmaj9#11', bass: 'Eb2', pcs: 'G D F A Bb', w: 2, p: 3 },
      { name: 'Fsus4(9)', bass: 'F1', pcs: 'Bb C G F', w: 1.5, p: 2 },
    ],
    cadence: { name: 'A7sus4', bass: 'A1', pcs: 'D G E A' },
    // Earth's motif, buried: a dark horn deep under the clouds; then the seed (A -> F#) over the dominant
    lines: [
      { at: 0, delay: 1.2, theme: 'A_DEEP', from: 'F2', scale: 'Bb major', inst: 'horn', beat: 0.95, role: 'theme', bright: 0.6, vel: 2.6 },
      { at: 3, delay: 1.0, theme: 'B', from: 'G3', scale: 'Bb major', inst: 'horn', beat: 1.1, bright: 0.55, vel: 1.4 },
      { at: 'cad', delay: 1.0, theme: 'SEED', from: 'A4', scale: 'D major', inst: 'bell', beat: 0.85, ride: true }, // into the leg to Earth
    ],
    reg: { centre: 61, hi: 67, spread: 12 },
    // from Mercury's bare Bb fifth, the music falls away to one high tone, then the clouds: vi - IV - V9sus -> I
    approach: { gesture: 'hush', chords: [{ name: 'Gm9', bass: 'G1', pcs: 'Bb F A D' }, { name: 'Ebmaj9', bass: 'Eb2', pcs: 'G D F Bb' }, { name: 'F9sus4', bass: 'F1', pcs: 'Bb Eb G C' }] },
    impact: 0,
    centroid: [250, 650], // the world's own spectral band (render.mjs checks it)
    level: -3.5,
    arc: 2,
    lanes: { padCut: 420, padQ: 1.6, cutMod: [13, 0.4], wet: 1.15, vowel: ['u', 'o', 'u'], breath: 0.1, air: [0.018, 4800, 0.7], rumble: [0.06, 160], am: [0.16, 0.6], tilt: [0.5, -4] },
    layers: {
      pad: { voices: [0, 1, 2, 3, 4], wave: 'warm', detune: 13, drift: 9, lfo: 0.06, attack: 5, release: 7, vel: 1.05 },
      choir: { voices: [1, 2, 3], vel: 0.45, attack: 6, release: 7, from: 0.3, to: 0.95 },
      air: { type: 'choir', voices: [4], oct: 12, vel: 0.2, attack: 7, release: 7, from: 0.2, to: 0.95 }, // high 'u', an octave up
      sub: { vel: 0.36, attack: 4, release: 6 },
      grains: [{ rate: 1.4, f: [450, 1200], q: 12, dur: [0.05, 0.16], vel: 0.06, buf: 'pink', from: 0.3 }],
    },
  },

  earth: {
    label: 'Earth — D major 9 with the tender motif on felt piano',
    key: { tonic: 'D4', mode: 'major' },
    chordDur: 7,
    // first statement on arrival; the soaring variant (A2) at the sunrise over the limb; the choir takes the
    // motif at Earthrise. Gm6/9 (the night side's minor iv) and A13sus4 (the dominant) prepare the two anchors.
    anchors: { sunrise: 4, earthrise: 8 },
    swell: { earthrise: 1.6 }, // dB: the anchors are the film's loudest moments
    prog: [
      { name: 'Dmaj9', bass: 'D2', pcs: 'F# C# E A' },
      { name: 'Gmaj9', bass: 'G1', pcs: 'B F# A D', p: 3 },
      { name: 'Bm9', bass: 'B1', pcs: 'D A C# F#', p: 1 },
      { name: 'Gm6/9 (night side)', bass: 'G1', pcs: 'Bb E A D', p: 2 },
      { name: 'Dmaj9 (sunrise)', bass: 'D2', pcs: 'F# C# E A' },
      { name: 'Gmaj9#11', bass: 'G1', pcs: 'B F# A C#', p: 3 },
      { name: 'Em9', bass: 'E2', pcs: 'G D F# B', p: 2 },
      { name: 'A13sus4', bass: 'A1', pcs: 'D G B E F#', p: 1 },
      { name: 'Dmaj9 (Earthrise)', bass: 'D2', pcs: 'F# C# E A', w: 1.4 },
      { name: 'Gmaj9#11', bass: 'G1', pcs: 'B F# A C#', p: 2 },
    ],
    cadence: { name: 'D/E', bass: 'E2', pcs: 'D F# A' },
    // HOME on arrival (the piano, the cello answering from bar 3, contrary to it); the soaring variant at sunrise
    // and its answer; the voice's first entry over Em9; RISE at Earthrise (piano and voice, the 11th leaning on the
    // 3rd, carried on through the cadence)
    tunes: [
      {
        tune: 'HOME', span: [0, 3],
        parts: [{ part: 'mel', inst: 'piano', lh: true }, { part: 'counter', inst: 'cello', vel: 1.0 }],
        alt: [
          { at: 0, theme: 'A', from: 'A4', scale: 'D major', inst: 'piano', fit: true, lh: true, role: 'theme' },
          { at: 1, theme: 'B', from: 'B4', scale: 'D major', inst: 'piano', fit: true, lh: true, role: 'theme' },
          { at: 3, delay: 1.8, theme: 'B', from: 'Bb4', scale: 'D minor', inst: 'piano', beat: 0.95, vel: 1.2, duck: 1 },
        ],
      },
      {
        tune: 'RISE', span: [8, 'cad'],
        parts: [{ part: 'mel', inst: 'piano', lh: true }, { part: 'mel', inst: 'voice', double: true, vel: 0.95 }, { part: 'counter', inst: 'cello', vel: 0.85 }],
        alt: [
          { at: 8, theme: 'A_APP', from: 'A4', scale: 'D major', inst: ['piano', 'voice'], fit: true, lh: true, role: 'theme' },
          { at: 9, theme: 'B2', from: 'C#5', scale: 'D major', inst: ['piano', 'voice'], fit: true, lh: true, role: 'theme' },
        ],
      },
    ],
    lines: [
      { at: 4, theme: 'A2', from: 'A4', scale: 'D major', inst: 'piano', fit: true, lh: true, role: 'theme' },
      { at: 5, theme: 'B2', from: 'C#5', scale: 'D major', inst: 'piano', fit: true, lh: true, role: 'theme' },
      { at: 6, delay: 1.2, theme: 'SIXTH', from: 'B4', scale: 'D major', inst: 'voice', beat: 1.0, vel: 1.0 },
    ],
    reg: { centre: 54, spread: 16 },
    // the Blue Marble: the pivots sung (a reverse-choir swell), vi - IV - V13sus -> I
    approach: { gesture: 'choir', chords: [{ name: 'Bm9', bass: 'B1', pcs: 'D A C# F#' }, { name: 'Gmaj9', bass: 'G1', pcs: 'B F# A D' }, { name: 'A13sus4', bass: 'A1', pcs: 'D G B E F#' }] },
    impact: 0.45,
    centroid: [420, 950], // the world's own spectral band (render.mjs checks it)
    level: -0.5,
    arc: 2.5,
    lanes: { padCut: 2600, padQ: 0.8, cutMod: [17, 0.3], wet: 0.95, vowel: ['o', 'u', 'a'], breath: 0.18, air: [0.05, 5200, 0.45], rumble: [0.01, 120], am: [0.12, 0.3], tilt: [-1, 3], pianoCut: 7800 },
    layers: {
      pad: { voices: [0, 1, 2, 3, 4], wave: 'warm', detune: 9, drift: 6, lfo: 0.08, attack: 4, release: 6, vel: 0.8 },
      choir: { voices: [2, 3, 4], vel: 0.4, attack: 5, release: 6, from: 0.45, to: 1 },
      sub: { vel: 0.3, attack: 4, release: 6 },
      piano: { arps: 1, vel: 0.85 },
      bells: { rate: 0.14, ratio: 2, index: 0.9, decay: 4, range: [79, 93], vel: 0.2, phrase: [1, 3], gap: [0.3, 0.6] },
      chirps: { kind: 'rise', rate: 1.3, vel: 0.06, from: 0.35, to: 0.75 },
    },
  },

  moon: {
    label: 'The Moon — Earthrise: the motif sung',
    key: { tonic: 'D4', mode: 'major' },
    chordDur: 7.5,
    prog: [
      { name: 'Gmaj9', bass: 'G1', pcs: 'B F# A D' },
      { name: 'Em9', bass: 'E2', pcs: 'G D F# B', p: 1 },
      { name: 'Aadd9', bass: 'A1', pcs: 'C# E B A', p: 2 },
      { name: 'Dmaj9', bass: 'D2', pcs: 'F# C# E A', p: 4 },
      { name: 'Gmaj9#11', bass: 'G1', pcs: 'B F# A C#', p: 3 },
      { name: 'Bm9', bass: 'B1', pcs: 'D A C# F#', p: 1.5 },
    ],
    cadence: { name: 'D/E', bass: 'E2', pcs: 'D F# A' },
    lines: [
      { at: 3, theme: 'A_APP', from: 'A4', scale: 'D major', inst: ['piano', 'voice'], fit: true, lh: true, role: 'theme' },
      { at: 4, theme: 'B2', from: 'C#5', scale: 'D major', inst: ['piano', 'voice'], fit: true, lh: true, role: 'theme' },
    ],
    impact: 0.3,
    centroid: [400, 950], // the world's own spectral band (render.mjs checks it)
    level: -3,
    arc: 2,
    lanes: { padCut: 1500, padQ: 0.8, cutMod: [19, 0.3], wet: 1.2, vowel: ['u', 'o'], breath: 0.22, air: [0.03, 3800, 0.6], rumble: [0.003, 100], am: [0.1, 0.2], tilt: [-1, 2], pianoCut: 7000 },
    layers: {
      pad: { voices: [0, 1, 2, 3], wave: 'soft', detune: 8, drift: 5, lfo: 0.07, attack: 4.5, release: 7, vel: 0.75 },
      choir: { voices: [2, 3, 4], vel: 0.5, attack: 4, release: 7, from: 0.0, to: 1 },
      piano: { arps: 0.6, vel: 0.7 },
      glass: { rate: 0.1, range: [81, 96], decay: 6, vel: 0.12 },
    },
  },

  mars: {
    label: 'Mars — E Dorian pulse (3+3+2), dusty wind',
    key: { tonic: 'E3', mode: 'minor' },
    chordDur: 2.857, // one bar of 4/4 at 84 BPM: the harmony moves with the pulse
    grid: 2.857, // chord changes land on bar lines
    prog: [
      { name: 'Em9', bass: 'E2', pcs: 'G D F# B', w: 2 },
      { name: 'A/E (Dorian IV)', bass: 'E2', pcs: 'C# A E', p: 3 },
      { name: 'Em9', bass: 'E2', pcs: 'G D F# B', p: 1 },
      { name: 'A/E', bass: 'E2', pcs: 'C# A E', p: 1.2 },
      { name: 'Gmaj7(6)', bass: 'G1', pcs: 'B F# D E', p: 2 },
      { name: 'Dadd9/F#', bass: 'F#1', pcs: 'D E A', p: 1.5 },
      { name: 'Asus2', bass: 'A1', pcs: 'B E A', p: 2.5, w: 2 },
    ],
    cadence: { name: 'Bm11', bass: 'B1', pcs: 'D A E F#', w: 2 },
    // fragmentation: the motif's rising sixth alone, on Earth's piano, in time with the pulse (beat = 84 BPM):
    // the Dorian major sixth over A/E, then Earth's own two notes (A -> F#) over D: Earth as an evening star
    lines: [
      { at: 0, delay: 2.86, theme: 'SIXTH', from: 'B4', scale: 'E dorian', inst: 'piano', beat: 0.714, vel: 1.15 },
      { at: 1, delay: 0.0, theme: 'SIXTH', from: 'E5', scale: 'E dorian', inst: 'piano', beat: 0.714 },
      { at: 4, delay: 0.36, theme: 'B', from: 'E5', scale: 'E dorian', inst: 'piano', beat: 0.714, vel: 1.5, duck: 1 },
      { at: 5, delay: 0.0, theme: 'SIXTH', from: 'A4', scale: 'D major', inst: 'piano', beat: 0.714, vel: 1.1 },
      { at: 'cad', delay: 0.36, theme: 'SIXTH_DOWN', from: 'F#5', scale: 'E dorian', inst: 'piano', beat: 0.714, vel: 2.1, duck: 1 },
    ],
    reg: { lo: 50, centre: 62, spread: 14 },
    // out of Earth: an Aeolian cadence (bVI - bVII - i), a star-streak arpeggio on the Mars pluck accelerating
    // into the 84 BPM pulse
    approach: { gesture: 'streak', inst: 'pluck', chords: [{ name: 'Cmaj9', bass: 'C2', pcs: 'E B D G' }, { name: 'D6/9', bass: 'D2', pcs: 'F# B E A' }] },
    impact: 0.6,
    centroid: [350, 850], // the world's own spectral band (render.mjs checks it)
    level: 4,
    arc: 2.5,
    lanes: { padCut: 1000, padQ: 2.0, cutMod: [5.714, 0.4], wet: 0.7, vowel: ['o', 'a'], breath: 0.0, air: [0.06, 1100, 1.1], rumble: [0.02, 130], am: [0.21, 0.7], tilt: [-3, 1.5], padHP: 110 },
    layers: {
      pad: { voices: [1, 2, 3, 4], wave: 'saw', detune: 7, drift: 5, lfo: 0.11, attack: 3, release: 4, vel: 0.55 },
      sub: { vel: 0.12, attack: 2.5, release: 4 },
      pluck: { vel: 1.05, decay: 0.32, pattern: [0, 2, 1, 3, 2, 1, 3, 2], accents: [1, 0.55, 0.6, 0.95, 0.55, 0.6, 0.9, 0.6], kick: 0.18 },
      bells: { rate: 0.08, ratio: 1.41, index: 2.4, decay: 3, range: [72, 86], vel: 0.15, phrase: [1, 2], gap: [0.2, 0.4] },
      grains: [
        { rate: 4, f: [300, 1300], q: 2, dur: [0.08, 0.3], vel: 0.1, buf: 'pink' },
        { rate: 7, f: [5000, 11000], q: 5, dur: [0.008, 0.03], vel: 0.085, buf: 'white' }, // dust sizzle on the wind
      ],
    },
  },

  belt: {
    label: 'Asteroid belt — C Lydian, granular pebbles',
    key: { tonic: 'C4', mode: 'major' },
    chordDur: 12,
    prog: [
      { name: 'Cmaj9#11', bass: 'C2', pcs: 'E B D F#' },
      { name: 'D/C (Lydian II)', bass: 'C2', pcs: 'D F# A E' },
    ],
    cadence: { name: 'Csus2 (open)', bass: 'C2', pcs: 'G D C' },
    lines: [
      { at: 0, delay: 2.0, theme: 'SIXTH', from: 'G5', scale: 'C lydian', inst: 'bell', beat: 0.8 },
      { at: 0, delay: 6.5, theme: 'L_HEAD', from: 'E5', scale: 'C lydian', inst: 'glass', beat: 0.7 },
      { at: 1, delay: 1.5, theme: 'L_HEAD', from: 'D6', scale: 'D major', inst: 'glass', beat: 0.7 },
      { at: 'cad', delay: 1.8, theme: 'L_HEAD', from: 'C6', scale: 'C lydian', inst: 'glass', beat: 0.75 },
    ],
    reg: { centre: 65, spread: 17 },
    // out of Mars's Bm11: the Lydian II over the C pedal that is about to arrive
    approach: { gesture: 'riser', chords: [{ name: 'Am9', bass: 'A1', pcs: 'C G B E' }, { name: 'D/C (Lydian II)', bass: 'C2', pcs: 'D F# A E' }] },
    impact: 0.5,
    centroid: [550, 1500], // the world's own spectral band (render.mjs checks it)
    level: -1.5,
    arc: 2.5,
    lanes: { padCut: 1400, padQ: 1.0, cutMod: [9, 0.35], wet: 0.95, vowel: ['o', 'u'], breath: 0.0, air: [0.06, 6000, 0.8], rumble: [0.01, 110], am: [0.09, 0.4], tilt: [-3, 5] },
    layers: {
      pad: { voices: [1, 2, 3, 4], wave: 'soft', detune: 9, drift: 7, lfo: 0.1, attack: 4, release: 6, vel: 0.7 },
      sub: { vel: 0.22, attack: 4, release: 6 },
      pebbles: { rate: 11, cluster: 0.25, vel: 0.75, range: [79, 103] },
      whoosh: { rate: 0.13, vel: 0.35 },
      grains: [{ rate: 9, f: [3500, 12000], q: 6, dur: [0.006, 0.025], vel: 0.15, buf: 'white' }],
    },
  },

  jupiter: {
    label: 'Jupiter — C minor, vast low brass swells, the motif on horns; whistlers',
    // tonic C4: the motif (G4 Eb5 D5 C5) sits in the horn register, an octave clear of the low brass and pad
    key: { tonic: 'C4', mode: 'minor' },
    chordDur: 13, // long pedals
    compress: 1, // (never squeezed to fit more chords before an anchor: the pedals stay long)
    // the motif, in minor, on the horns as we skim the cloud tops; Bbsus2 (bVII) prepares it
    anchors: { 'jupiter-skim': 3 },
    prog: [
      { name: 'Cm(add9)', bass: 'C2', pcs: 'Eb G D C', w: 1.5 },
      { name: 'Abmaj7', bass: 'Ab1', pcs: 'C Eb G Ab', p: 1 },
      { name: 'Bbsus2', bass: 'Bb1', pcs: 'C F Bb D', p: 2 },
      { name: 'Cm(add9) (skim)', bass: 'C2', pcs: 'Eb G D C', w: 1.5 },
      { name: 'Fm9', bass: 'F1', pcs: 'Ab Eb G C', p: 2 },
      { name: 'Ebmaj7/G', bass: 'G1', pcs: 'Bb D Eb G', p: 1 },
    ],
    cadence: { name: 'Ab(add9)', bass: 'Ab1', pcs: 'C Eb Bb Ab' },
    // the horn call assembles itself: its head (G -> Eb), the head a fourth higher (C -> Ab), then the whole
    // motif in augmentation, broad and dotted, as we skim the cloud tops
    lines: [
      { at: 0, delay: 3.0, theme: 'SIXTH', from: 'G4', scale: 'C minor', inst: 'horn', beat: 1.1, vel: 2.9, duck: 1 },
      { at: 1, delay: 0.8, theme: 'SIXTH', from: 'C5', scale: 'C minor', inst: 'horn', beat: 1.1, vel: 2.6, duck: 1 }, // (before Io's shadow gong)
      { at: 3, delay: 0.5, theme: 'A_HORN', from: 'G4', scale: 'C minor', inst: 'horn', beat: 1.5, role: 'theme', vel: 2.3, ride: true }, // its last note held into the leg
    ],
    reg: { lo: 40, hi: 64, centre: 51, spread: 20 },
    // out of the belt's open C: bVI - bVII over the C pedal, a low brass crescendo, the giant arriving on i
    approach: { gesture: 'brass', chords: [{ name: 'Abmaj7/C', bass: 'C2', pcs: 'Ab Eb G C' }, { name: 'Bbsus2/C', bass: 'C2', pcs: 'Bb F C D' }] },
    impact: 0.85,
    centroid: [300, 750], // the world's own spectral band (render.mjs checks it)
    level: -3,
    arc: 3,
    lanes: { padCut: 800, padQ: 1.1, cutMod: [9, 0.5], wet: 1.1, vowel: ['a', 'o'], breath: 0.12, air: [0.02, 900, 0.7], rumble: [0.064, 170], am: [0.13, 0.65], tilt: [0, -3.5] },
    layers: {
      pad: { voices: [1, 2, 3, 4], wave: 'warm', detune: 10, drift: 6, lfo: 0.07, attack: 5, release: 7, vel: 0.55 },
      brass: { vel: 0.7, bright: 1 },
      choir: { voices: [1, 2, 3], vel: 0.35, attack: 6, release: 7, from: 0.4, to: 1, oct: -12 },
      sub: { vel: 0.4, attack: 4.5, release: 7 },
      chirps: { kind: 'whistler', rate: 0.32, vel: 0.11, from: 0.15, to: 0.9 },
    },
  },

  saturn: {
    label: 'Saturn — E major, ethereal choir, ring shimmer',
    key: { tonic: 'E4', mode: 'major' },
    chordDur: 10,
    // the solo voice sings the motif when the Sun goes behind Saturn and the rings light up; B11 (V) prepares it
    anchors: { eclipse: 4 },
    swell: { eclipse: 0.9 },
    prog: [
      { name: 'Emaj9', bass: 'E2', pcs: 'G# D# F# B', w: 1.5 },
      { name: 'C#m11', bass: 'C#2', pcs: 'E B G# F#', p: 1 },
      { name: 'Amaj9#11', bass: 'A1', pcs: 'C# G# B D#', p: 2 },
      { name: 'B11', bass: 'B1', pcs: 'E F# C# A', p: 1.5 },
      { name: 'Emaj9 (eclipse)', bass: 'E2', pcs: 'G# D# F# B', w: 1.5 },
      { name: 'C#m11', bass: 'C#2', pcs: 'E B G# F#', p: 1 },
      { name: 'Amaj9#11', bass: 'A1', pcs: 'C# G# B D#', p: 2 },
      { name: 'B11', bass: 'B1', pcs: 'E F# C# A', p: 1.5 },
    ],
    cadence: { name: 'F#9sus4', bass: 'F#1', pcs: 'B E G# C#', w: 0.5 },
    // the rings catch the light (the Light theme on glass, in A Lydian, over a high choir); at the eclipse the solo
    // soprano sings ECLIPSE: A_EXT, then a second phrase climbing to C#6 over Amaj9#11, settling on the dominant
    tunes: [
      {
        tune: 'ECLIPSE', span: [4, 7],
        parts: [{ part: 'mel', inst: 'voice', vel: 1.05 }],
        alt: [
          { at: 4, delay: 0.7, theme: 'A_EXT', from: 'B4', scale: 'E major', inst: 'voice', fit: true, role: 'theme' },
          { at: 5, delay: 1.2, theme: 'B2', from: 'D#5', scale: 'E major', inst: 'voice', beat: 0.95, vel: 0.95 },
          { at: 7, delay: 1.0, theme: 'L_HEAD', from: 'B4', scale: 'E major', inst: 'glass', beat: 0.8 },
        ],
      },
    ],
    lines: [
      { at: 0, delay: 3.0, theme: 'SIXTH', from: 'B5', scale: 'E major', inst: 'glass', beat: 0.9 },
      { at: 2, delay: 0.4, theme: 'L', from: 'E5', scale: 'A lydian', inst: 'glass', beat: 0.75 },
    ],
    reg: { centre: 63, spread: 16 },
    // out of Jupiter's Ab (G#): the music falls away to one high tone, then vi - V -> I, and the choir blooms
    approach: { gesture: 'hush', chords: [{ name: 'C#m11', bass: 'C#2', pcs: 'E B G# F#' }, { name: 'B11', bass: 'B1', pcs: 'E F# C# A' }] },
    impact: 0.85,
    centroid: [500, 1100], // the world's own spectral band (render.mjs checks it)
    level: -0.5,
    arc: 2.5,
    lanes: { chorus: 0.5, padCut: 3400, padQ: 2.2, cutMod: [8, 0.4], wet: 1.0, vowel: ['a', 'o', 'a'], breath: 0.3, air: [0.05, 7500, 0.8], rumble: [0.005, 110], am: [0.08, 0.3], tilt: [-1.5, 3] },
    layers: {
      pad: { voices: [0, 1, 2, 3], wave: 'soft', detune: 10, drift: 7, lfo: 0.06, attack: 5, release: 7, vel: 0.6 },
      choir: { voices: [1, 2, 3, 4], vel: 0.6, attack: 4, release: 7, from: 0.0, to: 1 },
      // the high choir over the rings (a descant an octave up), until the eclipse
      extra: [{ type: 'choir', voices: [2, 3, 4], oct: 12, vel: 0.42, attack: 5, release: 5, from: 0.05, to: 'eclipse-1' }],
      sub: { vel: 0.2, attack: 5, release: 7 },
      shimmer: { rate: 10, range: [88, 107], vel: 0.115 },
      glass: { rate: 0.18, range: [83, 98], decay: 6, vel: 0.15 },
      chirps: { kind: 'skr', rate: 0.12, vel: 0.03, from: 0.5, to: 0.95 },
    },
  },

  uranus: {
    label: 'Uranus — F# quartal stacks, cold FM bells, rotating on its side',
    key: { tonic: 'F#4', mode: 'minor' },
    chordDur: 4.5, // the stacks rotate
    // written-out stacks of perfect fourths (only moved by octaves); the last two share one stack over a
    // bass that slips D -> C#
    prog: [
      { name: 'F#m11 (quartal)', bass: 'F#1', stack: 'C# F# B E A' },
      { name: 'Dmaj13#11 (quartal)', bass: 'D2', stack: 'G# C# F# B E', p: 2 },
      { name: 'Bm11 (quartal)', bass: 'B1', stack: 'F# B E A D', p: 1.5 },
      { name: 'C#m7sus4 (quartal)', bass: 'C#2', stack: 'G# C# F# B E', p: 3 },
    ],
    cadence: { name: 'F#sus4', bass: 'F#1', pcs: 'B C# E F#' },
    // cold bells: quartal fragments and the motif turned upside down (5, down a sixth, up by step)
    lines: [
      { at: 0, delay: 1.0, theme: 'QUARTAL', from: 'F#5', inst: 'bell', beat: 0.65, cold: true },
      { at: 1, delay: 0.5, theme: 'INV', from: 'C#6', scale: 'F# dorian', inst: 'bell', beat: 0.7, cold: true, role: 'theme' },
      { at: 3, delay: 0.6, theme: 'QUARTAL_DOWN', from: 'E6', inst: 'bell', beat: 0.65, cold: true },
    ],
    reg: { lo: 52, hi: 88, centre: 71 },
    // out of Saturn's F#9sus4: ice crystals accelerating (a bell streak) through iv - V sus
    approach: { gesture: 'streak', inst: 'bell', chords: [{ name: 'Bm11 (quartal)', bass: 'B1', stack: 'F# B E A D' }, { name: 'C#sus4', bass: 'C#2', pcs: 'F# G# C#' }] },
    impact: 0,
    centroid: [900, 2200], // the world's own spectral band (render.mjs checks it)
    level: 0,
    arc: 2,
    lanes: { padCut: 5200, padQ: 0.7, cutMod: [15, 0.25], wet: 1.3, vowel: ['i', 'e'], breath: 0.0, air: [0.065, 9000, 1.2], rumble: [0, 100], am: [0.05, 0.4], tilt: [-7, 3.5], padHP: 330 },
    layers: {
      pad: { voices: [1, 2, 3, 4], wave: 'hollow', detune: 5, drift: 3, lfo: 0.05, attack: 4, release: 6, vel: 0.6 },
      bells: { rate: 0.6, ratio: 3.5, index: 2.2, decay: 6, range: [76, 96], vel: 0.32, phrase: [3, 6], gap: [0.28, 0.7], rotate: true },
      glass: { rate: 0.2, range: [88, 100], decay: 7, vel: 0.13 },
      sub: { vel: 0.04, attack: 6, release: 7 },
    },
  },

  neptune: {
    label: 'Neptune — B minor, deep and lonely; the motif alone, high above a dark pad',
    // tonic B4: the solitary piano line floats an octave above the deep pad and sub (and never fights them)
    key: { tonic: 'B4', mode: 'minor' },
    chordDur: 10,
    prog: [
      { name: 'Bm(add9)', bass: 'B1', pcs: 'D F# C# B', w: 1.3 },
      { name: 'Gmaj7#11', bass: 'G1', pcs: 'B F# D C#', p: 3 },
      { name: 'Em9', bass: 'E2', pcs: 'G D F# B', p: 1.5 },
      { name: 'F#sus4(b9)', bass: 'F#1', pcs: 'B C# E G', p: 2, b9: true },
    ],
    cadence: { name: 'Asus4', bass: 'A1', pcs: 'D E A G' },
    // the motif alone on a high piano, its sixth minor, stopping on the 2nd (unresolved); a distant voice; the
    // light's skeleton as the camera turns back toward the Sun
    lines: [
      { at: 0, delay: 1.8, theme: 'A_BROKEN', from: 'F#5', scale: 'B minor', inst: 'piano', fit: true, aug: 1.35, role: 'theme' },
      { at: 1, theme: 'B', from: 'G5', scale: 'B minor', inst: 'piano', fit: true, aug: 1.35, role: 'theme' },
      { at: 2, delay: 2.0, theme: 'SIXTH', from: 'B4', scale: 'B minor', inst: 'voice', beat: 1.2, vel: 0.8, duck: 1 },
      { at: 3, delay: 2.5, theme: 'B', from: 'G5', scale: 'B minor', inst: 'voice', beat: 1.1, vel: 0.6 },
      { at: 'cad', delay: 1.2, theme: 'L_HEAD', from: 'A4', scale: 'D major', inst: 'glass', beat: 0.8 },
    ],
    // deep and wide, with a hole in the middle (the pads sink; the piano floats far above)
    reg: { lo: 40, hi: 61, centre: 48, spread: 22, maxGap: 17 },
    // out of Uranus: the cold music falls away to one tone (Neptune is the quietest, loneliest world), iv - V7sus -> i
    approach: { gesture: 'hush', chords: [{ name: 'Em9', bass: 'E2', pcs: 'G D F# B' }, { name: 'F#7sus4', bass: 'F#1', pcs: 'B E C# A' }] },
    impact: 0,
    centroid: [220, 650], // the world's own spectral band (render.mjs checks it)
    level: -1.3,
    arc: 2,
    lanes: { padCut: 560, padQ: 1.2, cutMod: [21, 0.35], wet: 0.95, vowel: ['u', 'o'], breath: 0.15, air: [0.03, 5600, 0.9], rumble: [0.022, 90], am: [0.27, 0.55], tilt: [0.5, -2.5], pianoCut: 6800 },
    layers: {
      pad: { voices: [0, 1, 2, 3], wave: 'warm', detune: 8, drift: 6, lfo: 0.05, attack: 6, release: 8, vel: 0.75, subOct: true },
      sub: { vel: 0.32, attack: 6, release: 8 },
      piano: { arps: 0, vel: 0.55, },
      choir: { voices: [3], vel: 0.35, attack: 7, release: 8, from: 0.45, to: 0.9 },
      grains: [{ rate: 1.0, f: [450, 1100], q: 18, dur: [0.4, 1.2], vel: 0.09, buf: 'pink' }],
    },
  },

  finale: {
    label: 'Finale — D major: the motif returns and resolves to the Sun\'s Lydian chord',
    key: { tonic: 'D4', mode: 'major' },
    chordDur: 6,
    // pull back (the resolution withheld: G, Bm, the bittersweet Gm6, the A13sus4 dominant) ... the motif
    // returns whole in D exactly when Earth is found as a pale blue dot (a real V -> I) ... and the home chord
    // on the end card (IV -> I, the "amen")
    anchors: { 'pale-blue-dot': 4, end: 6 },
    prog: [
      { name: 'Gmaj9', bass: 'G1', pcs: 'B F# A D' },
      { name: 'Bm9', bass: 'B1', pcs: 'D A C# F#', p: 1 },
      { name: 'Gm6/9', bass: 'G1', pcs: 'Bb E A D', p: 2 },
      { name: 'A13sus4', bass: 'A1', pcs: 'D G B E F#', p: 1.5 },
      { name: 'Dmaj9 (pale blue dot)', bass: 'D2', pcs: 'F# C# E A', w: 1.3 },
      { name: 'Gmaj9#11', bass: 'G1', pcs: 'B F# A C#', p: 2 },
      { name: 'Dmaj9#11 (home, with the Sun\'s raised fourth)', bass: 'D2', pcs: 'F# C# E A G#', req: 'F# C# E G#', final: true, w: 2.5 },
    ],
    cadence: null,
    // the light's skeleton over G; the night side's answer (Bb -> A); the motif whole after the real V -> I, with
    // the voice; the closing phrase over the home chord
    // FINALE: the theme over IV, the bars shortening toward the V; the motif whole on the pale blue dot with the
    // voice joining; the Sun's raised fourth; home. The cello under all of it, strings growing from the second bar.
    tunes: [
      {
        tune: 'FINALE', span: [0, 6],
        parts: [
          { part: 'mel', inst: 'piano', lh: true, coda: true },
          { part: 'mel', inst: 'voice', double: true, from: 4, vel: 0.95 },
          { part: 'counter', inst: 'cello', vel: 1.0 },
        ],
        alt: [
          { at: 0, delay: 1.5, theme: 'L_HEAD', from: 'D5', scale: 'G lydian', inst: 'glass', beat: 0.8 },
          { at: 2, delay: 1.0, theme: 'B', from: 'Bb4', scale: 'D minor', inst: 'piano', beat: 1.0, vel: 1.3, duck: 1 },
          { at: 4, theme: 'A_HOME', from: 'A4', scale: 'D major', inst: ['piano', 'voice'], fit: true, lh: true, role: 'theme' },
          { at: 5, theme: 'B2', from: 'C#5', scale: 'D major', inst: ['piano', 'voice'], fit: true, lh: true, role: 'theme', vel: 1.2 },
          { at: 6, delay: 0.7, theme: 'END', from: 'F#5', scale: 'D major', inst: ['piano', 'voice'], beat: 0.95, lh: true, coda: true, role: 'theme' },
        ],
      },
    ],
    lines: [],
    reg: { centre: 58, spread: 18 },
    impact: 0.3,
    centroid: [450, 950], // the world's own spectral band (render.mjs checks it)
    level: -0.5,
    arc: 3,
    lanes: { padCut: 3000, padQ: 0.8, cutMod: [17, 0.3], wet: 1.15, vowel: ['o', 'a', 'o'], breath: 0.2, air: [0.04, 4800, 0.6], rumble: [0.01, 120], am: [0.1, 0.3], tilt: [-1, 2.5], pianoCut: 7200 },
    layers: {
      pad: { voices: [0, 1, 2, 3, 4], wave: 'warm', detune: 10, drift: 6, lfo: 0.07, attack: 4, release: 8, vel: 0.85 },
      choir: { voices: [2, 3, 4], vel: 0.5, attack: 5, release: 8, from: 0.3, to: 1 },
      sub: { vel: 0.36, attack: 4, release: 8 },
      piano: { arps: 0.5, vel: 0.95 },
      bells: { rate: 0.14, ratio: 3.5, index: 1.2, decay: 5, range: [81, 96], vel: 0.18, phrase: [1, 3], gap: [0.3, 0.6] },
      glass: { rate: 0.1, range: [86, 98], decay: 7, vel: 0.14, from: 0.6 },
      // the strings: a desk of bowed voices growing under the return
      extra: [{ type: 'bow', ens: true, voices: [1, 2, 3, 4], vel: 0.45, attack: 5, release: 7, from: 0.12 }],
    },
  },

  // Bridges chapters the score does not recognise (e.g. a separate "travel" chapter): a held pivot chord made of
  // the tones the neighbouring worlds share, with the warp riser on top.
  transit: {
    label: 'Transit — pivot drone on common tones',
    key: { tonic: 'D4', mode: 'major' },
    chordDur: 14,
    prog: [],
    cadence: null,
    impact: 0.3,
    centroid: [200, 1200], // the world's own spectral band (render.mjs checks it)
    level: -5,
    arc: 1,
    lanes: { padCut: 900, padQ: 0.8, cutMod: [9, 0.3], wet: 1.3, vowel: ['u'], breath: 0.0, air: [0.04, 2600, 0.7], rumble: [0.013, 120], am: [0.1, 0.3] },
    layers: {
      pad: { voices: [1, 2, 3], wave: 'soft', detune: 9, drift: 6, lfo: 0.06, attack: 4, release: 6, vel: 0.6 },
      sub: { vel: 0.19, attack: 4, release: 6 },
    },
  },
};

// Named film cues (director.audioCues / shot.audio.cue) -> small musical accents, voiced from the chord
// sounding at that moment (see generateAccents in composer.js).
export const ACCENTS = {
  title: 'title', // the motif's seed (A -> F#, the rising sixth) on a distant bell, a low bloom
  'sun-reveal': 'bloom',
  sunrise: 'sunrise', // first light over Earth's limb: a fast rising glass arpeggio
  earthrise: 'bloom',
  phobos: 'whoosh', // Phobos crossing close in front
  'io-shadow': 'gong', // Io's shadow touching Jupiter's clouds
  rings: 'shimmerBurst', // skimming the rings: a burst of icy glitter
  eclipse: 'bloom',
  titan: 'warmGlass',
  bullseye: 'iceBells', // Uranus's rings seen as a bullseye
  triton: 'lonely',
  'pale-blue-dot': 'paleDot', // one high, very quiet tone: the single pale blue pixel
};

// The last chord of the whole film, wherever the film ends.
export const FINAL_CHORD = { name: 'Dmaj9#11 (home, with the Sun\'s raised fourth)', bass: 'D2', pcs: 'F# C# E A G#', req: 'F# C# E G#', final: true };

// Chapter -> world. The director's chapters are matched by body, then id, then title.
const MATCH = [
  ['moon', /\bmoon\b|earthrise|luna/i],
  ['earth', /earth|terra|blue marble/i],
  ['mercury', /mercury/i],
  ['venus', /venus/i],
  ['mars', /mars|phobos|deimos/i],
  ['belt', /belt|asteroid|ceres|vesta/i],
  ['jupiter', /jupiter|jovian|\bio\b|europa|ganymede|callisto/i],
  ['saturn', /saturn|titan|enceladus|cassini/i],
  ['uranus', /uranus|miranda|ariel|titania|oberon|umbriel/i],
  ['neptune', /neptune|triton/i],
  ['finale', /final|outro|credit|epilog|farewell|look.?back|pale|coda|\bend\b|home/i],
  ['intro', /intro|open|cold|title|prolog/i],
  ['sun', /\bsun\b|solar|photosphere|corona|\bsol\b/i],
];
export function worldOf(ch) {
  const id = String(ch.id || ''),
    title = String(ch.title || ''),
    body = String(ch.body || '');
  if (/\bmoon\b|earthrise/i.test(id) || /earthrise/i.test(title)) return 'moon';
  if (body === 'asteroids') return 'belt';
  if (body && WORLDS[body]) return body;
  for (const [w, re] of MATCH) if (re.test(id)) return w;
  for (const [w, re] of MATCH) if (re.test(title)) return w;
  return 'transit';
}
