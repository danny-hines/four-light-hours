# Audio — generative score (`src/audio/*`)

A WebAudio score synthesised entirely in code: no samples, no services, no keys. It is composed at load from
the director's chapters plus a cue track sampled from `director.evaluate()`. The music is a pure function of
journey time, so live playback, seeking and the offline renderer all produce the same piece, and it re-fits
itself to whatever chapter times the director provides (and to the fallback JOURNEY_ORDER timing).

## How to see / hear it

```bash
node src/audio/tools/render.mjs                 # full film, offline, real app -> shots/audio/score.wav,
                                                #   shots/audio/spectrogram.png, notes/audio-report.md  (~2-4 min)
                                                #   exits 3 if a musical check fails, 2 on an audio error
python src/audio/tools/loudcurve.py             # the loudness arc: shots/audio/loudness.png (anchors, legs by gesture)
python src/audio/tools/selfsim.py               # log-mel self-similarity, world x world: shots/audio/selfsim.png
node src/audio/tools/probe.mjs --quiet && node src/audio/tools/compose-check.mjs
                                                # the score in plain Node (~0.2 s): chords + voicings, legs with
                                                #   gestures and pivots, the melody plan, long lines, register per
                                                #   world, audits (exits 3 on a failure)
node src/audio/tools/live.mjs --wav shots/audio/score.wav
                                                # real page: start, seek, scrub, pause/suspend, resume, mute, a warp
                                                #   leg, audio-thread underruns at 6 dense moments, a 3 s stall, the
                                                #   film's end compared with the offline render -> notes/audio-live.md
node tools/shot.mjs --t 10 --out shots/audio/live_t10.png   # page loads with no audio errors (capture has no audio)
python src/audio/tools/zoom.py --t0 94 --t1 126 --out shots/audio/zoom_home_theme.png --fmin 60 --fmax 4000
                                                # zoomed spectrogram of any stretch, melody notes marked
node src/audio/tools/render.mjs --fast --seek-test   # 5 simulated seeks inside a render -> notes/audio-seek-report.md
node src/audio/tools/render.mjs --fallback --out shots/audio/fallback --report notes/audio-fallback-report.md
```

Best evidence: `notes/audio-report.md` (Score checks first; then master, chapters, legs with gesture + pivots,
world character, register and harmonic rhythm, spectral self-similarity, loudness arc, thematic plan, melody
salience, anchors), `shots/audio/spectrogram.png`, `shots/audio/loudness.png`, and the zooms
`shots/audio/zoom_home_theme.png`, `zoom_eclipse_theme.png`, `zoom_finale_theme.png`, `zoom_leg_jupiter_saturn.png`,
`zoom_leg_earth_mars.png`, `zoom_leg_mars_belt.png`.

## Latest full render (director 429.7 s, 2026-11-03)

`node src/audio/tools/render.mjs`: **all 21 checks pass, exit 0.** True peak -1.5 dBTP, integrated -17.1 LUFS,
LRA 11.3 LU, 0 NaN / 0 subnormal, longest silence 0.3 s (the fade from black), 151/151 melody notes >= +6 dB over
the local partials (worst +7.4), 0 melody/harmony rubs, 0 voicing rubs, 6/6 anchors prepared, peak 132 voices.
`live.mjs`: 0% underruns at all six dense moments, one resync after a 3 s stall (was 4), pause/suspend/resume/
mute/scrub all clean, the composed ending within ~1 dB of the offline render, no audio-related console errors
(other modules logged a WebGL shader error during that run).

| wave-1 gap | before (wave-1 critic, 441.5 s cut) | now (429.7 s cut) |
| --- | --- | --- |
| long lines | 31 of 45 events were 2-3-note fragments, longest 6 notes / ~7 s | 4 tunes of 8-27 notes, 16-39 s each: HOME (27 notes, 28 s), RISE (13, 17 s), ECLIPSE (22, 29 s), FINALE (20, 39 s); 27 fragments left as connective tissue |
| loudest moment | the Jupiter→Saturn riser (-10.9 LUFS ST) | the top 3 short-term moments are the anchors: pale blue dot -10.0, eclipse -10.0, Earthrise -10.7; loudest leg -16.6 |
| legs | one gesture repeated, hiss over a held chord; constant per-world `riserTrim`; render exit 3 on the cut | 5 gestures (riser, hush, choir, streak, brass); every leg moves cadence → 2 pivots → arrival; the riser follows a K-weighted music follower in the graph (no trims); crescendo legs -0.8..+2.6 dB, hush legs -10..-18 dB then +10..+20 dB bloom |
| register | top voice ~E4 in 8 of 12 worlds | per-world targets; neighbours differ by 5-12 semitones (Jupiter C4 → Saturn G#4 → Uranus E5 → Neptune B3 → finale E4) |
| harmonic rhythm | 6-9 s per chord nearly everywhere | Mercury 2.8 s, Mars 3.4 s (on bar lines), Uranus 4.1, finale 5.6 (bars shortening toward V-I), Earth 5.8, Saturn 6.9, Venus 6.8, Sun 7.3, Jupiter 9.6 (pedals), belt 11.6 |
| piano tells | one bit-identical buffer per pitch, gain-only velocity, linear release | velocity brightness (per-note low-pass), 2 round-robin seeds on melody notes, per-strike tuning, a soundboard knock (14 body modes), a damper release |
| voice tells | fixed -28 c / 130 ms scoop on every note | scoop depth/time follow the interval (from below after a leap up, from above after a step down), a breath into each note |
| seek | old generation retired with tau 86 ms while the new fades in over 0.5 s (5-11 dB dip) | equal-power sin/cos crossfade from the same instant over the same time; after a stall, no new resync for 5 s |

## Wave-2 changes (triage items, in order, root causes)

1. **Long themes (structural).** Root cause: every melodic line hung on ONE chord (`at`, `fit`), so a phrase could
   never be longer than a chord. New: `theory.js TUNES` (absolute-pitch bars written against their harmony, with
   passing notes marked `*`) and `worlds.js tunes` (`span: [firstChord, lastChord|'cad']`, parts, `alt`).
   chordTimeline keeps every spanned chord and gives it the time its bar needs (harmonic rhythm follows the tune;
   a cut stretches or squeezes the tempo within 0.6-1.6x or the tune gives way to its `alt` fragments);
   `realizeTunes` maps each bar onto its chord (notes may tie over bar lines). The four tunes:
   - **HOME** (Earth arrival, piano, 8 bars over Dmaj9-Gmaj9-Bm9-Gm6/9): A spun out; the antecedent ends open on the
     9th, the consequent takes the motif a third higher to the theme's peak B5, then the night side's Bb and an open
     A4 that the sunrise resolves. A **cello counter-melody** (new `bow` instrument) answers from bar 3, contrary to
     the tune (falling while it climbs). Pedalled with its harmony; the left hand changes with each bar.
   - **RISE** (Earthrise, piano + voice + cello): the appoggiatura form of A carried through the cadence.
   - **ECLIPSE** (Saturn, solo soprano): A_EXT, then a second phrase climbing through C#m11 to **C#6** over
     Amaj9#11 (the film's melodic high point), settling unresolved on the dominant's root.
   - **FINALE**: the theme over IV (resolution withheld), bars shortening 6-4-3-3 beats toward the V, the motif whole
     on the pale blue dot (V → I) with the voice joining, the Sun's raised fourth, home; cello throughout and a
     string section (`bow`, ensemble) growing underneath.
   compose-check and render.mjs assert at least 3 lines of 8+ notes lasting 12+ s.
2. **Legs.** Root causes: the riser was scaled by a constant per-world trim tuned on one cut, the music under every
   leg held one chord, and the riser followed the loudest departing music (Jupiter's horns). Now:
   - **The riser follows the music in the graph**: each generation has a K-weighted (BS.1770 pre-filter)
     average-rectified follower of the music after the world's level and before the warp duck (two one-pole IIR
     smoothers, tau 0.9 s; a biquad that low collapses numerically) driving the riser's gain (`FOLLOW_GAIN`). Pure
     DSP, so live and offline agree; `riserTrim` is gone.
   - **Pivots**: the arriving world's `approach.chords` are laid into the departing timeline from the departure
     (two pivots from ~3 s of leg): Sun → F#sus4 → G#sus4 → A (planing, a side-slip into Mercury); Mercury → Ebmaj9 →
     F9sus4 → Bb; Venus → Gmaj9 → A13sus4 → D; Earth → Cmaj9 → D6/9 → Em (Aeolian cadence); Mars → Am9 → D/C → C;
     belt → Ab/C → Bb/C → Cm (pedal); Jupiter → C#m11 → B11 → E; Saturn → Bm11 (quartal) → C#sus4 → F#m; Uranus →
     Em9 → F#7sus4 → Bm. Pivots speak quickly (pad attacks capped) and lean toward the next world's register.
   - **Gestures** (`composer.js GESTURES`, chosen by the arriving world): riser (Sun→Mercury, Mars→belt), hush
     (Mercury→Venus, Jupiter→Saturn, Uranus→Neptune: the music falls ~17 dB under one held high tone the pivots and
     the arrival share, no sub drop, a 2.4 s return), choir (Venus→Earth: the pivots sung on reverse swells), streak
     (Earth→Mars on the Mars pluck, Saturn→Uranus on bells: an arpeggio whose rate follows the speed), brass
     (belt→Jupiter: a low brass crescendo).
   - **Loudness plan**: Jupiter's level -1.5 → -3 dB, its brass and impact lower; anchor swells (`swell`: Earthrise
     +1.6 dB, eclipse +0.9 dB); Neptune's distant voice really distant. Checks: crescendo legs -1..+5 dB over the
     music they leave, slow drifts (peak warp < 0.5) sag <= 3 dB, hush legs fall >= 6 dB and the reveal rises >= 6 dB
     out of them, the top 3 short-term moments are the anchors, no leg within 1 dB of the quietest anchor.
3. **Register and harmonic rhythm.** Root cause: minimal-motion voice leading with one global register parked the
   line in D3-F#4 for the whole film. `voiceChord` now takes a per-world register (`reg`: centre with a cost per
   semitone of mean distance, spread, lo/hi, maxGap, nMax); the arrival chord moves there almost freely; the ceiling
   under a melody follows the notes sounding over each chord (a climbing tune lets the harmony climb); a
   counter-melody's notes are avoided instead of lowering the ceiling. Harmonic rhythm per world as in the table
   above (Mars's chord changes snap to bar lines of its 84 BPM pulse, `grid`). Extra sustained layers with
   cue-anchored edges (`layers.extra`, e.g. Saturn's high choir descant until `eclipse-1`). Spectral separation:
   Uranus icy and bass-less (pad high-pass 330 Hz, no sub), Mars dustier, Neptune darker. Checks: neighbours differ
   by >= 3 semitones in top-voice median (compose-check and render.mjs).
4. Also (wave-1 gaps 3 and 5): piano and voice realism, equal-power seek crossfades, one resync per stall (table
   above); textures ride the departure leg instead of stopping; every sustained layer is re-centred in the stereo
   field per world; ticks alternate sides; live.mjs refuses to compare the ending with a WAV of another cut.

## Harmonic plan

The tonal home is **D**. The Sun's light and Earth share it, and the finale returns to it. Each world ends on a
cadence chord that shares common tones with the arriving world's pivots; one voice-led line (3-5 voices) runs
through the whole film, moving register from world to world.

| world | key / harmony (chord every) | character, register, instruments |
| --- | --- | --- |
| cold open | D open fifth | soft pad swells out of black; the seed of A (A4 → F#5) on a distant bell; high glass |
| Sun | D Lydian: Dmaj9#11 → E/D → Bm9 → Esus4 (7-9 s) | radiant saw pad, "ah" choir, Lydian bells and glass, p-modes; **L sung by the solo voice**; open and high when the voice rests |
| Mercury | A5 → Bb5/A → A5 → G5/A → A5 → Bb5/A → C5/A → Bb5 (~3 s side-slips) | bare, low line played an octave up (thin, airless), heat-shimmer tremolo, glass fifths, piano L_HEAD, ticks |
| Venus | Bbmaj9 → (Ebmaj9#11) → A7sus4 (~10 s) | muffled warm pad, closed "u/o" choir, a high "u" haze; **A buried in a dark low horn** |
| Earth & Moon | **HOME** over Dmaj9-Gmaj9-Bm9-Gm6/9 → (sunrise) Dmaj9 → Gmaj9#11 → Em9 → A13sus4 → (Earthrise) **RISE** over Dmaj9 → Gmaj9#11 → D/E | felt piano + cello, warm low pads under it; A2 and the voice's first entry between the tunes |
| Mars | Em9 → A/E → Em9 → A/E → Gmaj7(6) → D/F# → Asus2 → Bm11 (one bar each at 84 BPM) | FM-pluck 3+3+2 pulse with dotted echo, soft kick, dust wind and sizzle; the sixth on Earth's piano in tempo |
| belt | Cmaj9#11 → Csus2 (~12 s) | high open glitter, granular pebbles, rock whooshes; L's skeleton on high glass |
| Jupiter | Cm(add9) → Bbsus2 → (skim) Cm(add9) → Ab(add9) (pedals 10-16 s) | vast low brass and pads (G2-C4), the horn call assembling itself, A_HORN at the skim; whistlers; Io's gong |
| Saturn | Emaj9 → C#m11 → Amaj9#11 → B11 → (eclipse) **ECLIPSE** over Emaj9 → C#m11 → Amaj9#11 → B11 → F#9sus4 | three-section choir with a high descant over the rings, ring glitter, glass L; the soprano at the eclipse |
| Uranus | quartal stacks F#m11 → Dmaj13#11 → Bm11 → C#m7sus4 → F#sus4 (~4 s rotation) | close and high (C#4-A5), no bass, cold FM bells in rotation, INV |
| Neptune | Bm(add9) → Gmaj7#11 → Em9 → F#sus4(b9) → Asus4 (~8 s) | deep and wide (E2-B3), sub, lonely wind; A_BROKEN alone on a high piano; a distant voice |
| finale | **FINALE** over Gmaj9 → Bm9 → Gm6/9 → A13sus4 → (pale blue dot) Dmaj9 → Gmaj9#11 → Dmaj9#11 | piano + voice + cello + strings; the motif whole after the real V → I, home with the Sun's raised fourth |

## Sound engine

- **Master:** dry + [mono send → 30 ms pre-delay (±3 ms at 0.11 Hz) → 6.6 s convolution hall (generated IR, five
  bands with their own decay, two all-pass ears) → HP4 220 Hz → LP 9.5 kHz] → DC block → LR4 150 Hz mono-maker + M/S
  width 1.05 → glue compression (2:1) → makeup → true-peak limiter at -1.5 dBTP (4x-oversampled lookahead
  AudioWorklet) → mute.
- **Generations:** every start/seek/resume builds a fresh set of buses (tilt, level, warp duck, pad chain +
  symmetric chorus, three choir formant sections, lead voice, horn, piano, **bow (cello/strings body)**, sub,
  pluck echo, noise beds, **the music follower**) with ~40 automation lanes in rolling 12 s chunks; sustained notes
  resume mid-envelope; generations crossfade equal-power.
- **Instruments:** pads, formant choir + solo voice (interval-aware scoop, breath onset), sub, FM bells, glass,
  felt piano (velocity brightness, round-robin, soundboard knock, damper), **bowed string** (Helmholtz saw, bow-
  coupled brightness, delayed vibrato, rosin scratch, ensemble mode), FM pluck, kick, brass, grains, pebbles, ticks,
  sparkle, chirps, p-modes, halo/hush tones, riser (follower-driven), suck, drop, whoosh.
- **Transport:** pause fades dry and sends while the hall rings out (suspend after 8 s); the film's end plays the
  composed tail; seek/resume start a new generation (scrubbing coalesced, queued voices of the old ones cancelled);
  mute is a ramp after the limiter; a hidden tab is a pause.
- **CPU:** per-category and global voice caps (150 sounding), k-rate automation on slowly moving params, 20 Hz
  scheduling with a 2.5 ms budget, 4 Hz sweeps that disconnect finished voices (including the follower's link into
  a riser / hush tone). Offline peak 132 voices; 0% underruns live.
- **Determinism:** every random choice is a mulberry32 seeded by world, section, line, cue or leg; noise loops,
  control noise, IR, piano strikes (tuning from the note's own time) are fixed-seed.

## Files

| file | what |
| --- | --- |
| `score.js` | contract API (`start / update / seek / setMuted`), throttled live scheduling, the end-of-film tail, `planFor`, `sampleCues`, `renderOffline` |
| `worlds.js` | per world: progressions, cadences, anchors, `tunes`, `lines`, `reg`, `approach` (pivots + gesture), `swell`, layers (incl. `extra`), lanes, `centroid`, `impact`; accents; chapter → world matching |
| `composer.js` | warp legs, sections, chord timelines + `fit()` (spans, grid), tunes (`realizeTunes`), fragments (`realizeLines`), the voice-led line, layer generators, `planLegs` + `GESTURES`, accents, lanes (hush duck, swells), audits, thematic / register stats |
| `theory.js` | seeded RNG, pitch parsing, modes, `THEMES` + `realize`, `TUNES` + `parseTune`, the voicing solvers (`voiceChord` with register targets, `stackVoicing`) |
| `instruments.js` | every voice; `kRate()` |
| `engine.js` | master chain, generations (incl. follower, bow bus), scheduler, voice limits, cancellation, cleanup, transport |
| `dsp.js` | noise loops, control noise, the hall IR, felt-piano synthesis (soundboard knock, round-robin seeds), wavetables |
| `limiter.js` | true-peak lookahead limiter (AudioWorklet), with a fallback |
| `tools/*` | `render.mjs` (+ checks), `analyze.js` (BS.1770, true peak, STFT, salience, legs, stereo, character, self-similarity, ST peaks, spectrogram, WAV), `compose-check.mjs`, `probe.mjs`, `live.mjs`, `underrun.mjs`, `profile.mjs`, `zoom.py`, `loudcurve.py`, `selfsim.py` |

## Known gaps

- Judged by analysis, not by ear (headless): levels, spectra, leg shapes, melody salience, harmony, register and
  stereo are checked; nobody has listened to the balance of the cello against the piano, or the soprano's top C#6.
- The director re-cut the film three times during this round (441.5 → 434.1 → 430.4 → 429.7 s; legs shortened to
  ~4.5 s). Everything re-fits (tunes take their tempo from their span, pivots from the leg, the riser from the
  music), and all checks pass on the 429.7 s cut; a cut that squeezes a tune's span below 0.6x of its written tempo
  falls back to its fragments (`alt`). The Sun→Mercury transition is now a slow drift (peak warp 0.37): its riser is
  faint and the move sags ~2.5 dB (the drift check allows 3).
- Long-term spectral similarity between neighbours is still high on a plain log-mel cosine (Earth/Mars 0.98,
  Saturn/Uranus 0.98, Neptune/finale 0.98; `selfsim.py`, standardised measure in the report): register and
  harmonic rhythm now differ by design, but the worlds share an orchestral palette.
- Seeks: equal-power crossfade, no dip on 3 of 5 simulated seeks; a seek into a passage whose piano and bell notes
  started before the seek point can still sound thin for ~0.5 s offline (live, prewarmed piano notes resume).
- The solo voice's formants follow the world's vowel lanes, not each note; the piano has no sympathetic resonance.
- Tested in Chrome only; the webkitAudioContext and no-AudioWorklet fallback paths are untested. Not measured on
  a mid laptop. `--fallback` timing was not re-run this round.

## Requests to integrator / other pieces

- **main.js:** while audio is running, please drive `app.t` from the audio clock (or at least don't clamp `dt` to
  0.1 s while playing). Below ~10 fps the picture runs slow; the score tolerates up to 2.5 s of drift.
- **Director:** please keep `shot.audio.{intensity, arrival, departure, cue}` and `audioCues` stable. Cue names used:
  `title, sun-reveal, sunrise, earthrise, phobos, io-shadow, jupiter-skim, rings, eclipse, titan, bullseye, triton,
  pale-blue-dot, end`. The tunes are timed by `sunrise`, `earthrise`, `eclipse`, `pale-blue-dot` and `end`.
- HUD: keep calling `ctx.app.start()` directly in the click handler (the AudioContext is created inside it).
- `window.__score` is a small debug hook (`info()`, `_engine()`) used by the live tools; harmless, removable.
