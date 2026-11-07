// Composes the score in plain Node from shots/audio/cues.json (written by probe.mjs) or the fallback timing,
// and prints the music sections, chords with voice-led voicings, warp legs and event counts.
//   node src/audio/tools/compose-check.mjs            (real director cues)
//   node src/audio/tools/compose-check.mjs --fallback (fallback director timing)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compose, fallbackTimeline } from '../composer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const order = ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
let input;
if (process.argv.includes('--fallback')) input = fallbackTimeline(order);
else {
  const j = JSON.parse(fs.readFileSync(path.join(root, 'shots/audio/cues.json'), 'utf8'));
  const F = (a) => (a ? Float32Array.from(a) : null);
  input = { chapters: j.chapters, duration: j.duration, cues: { ...j.cues, warp: F(j.cues.warp), fade: F(j.cues.fade), intensity: F(j.cues.intensity), arrival: F(j.cues.arrival), departure: F(j.cues.departure) } };
}
const t0 = performance.now();
const plan = compose(input);
console.log(`composed in ${(performance.now() - t0).toFixed(1)} ms: ${plan.events.length} events, duration ${plan.duration} s, max span ${plan.maxSpan.toFixed(1)} s`);
for (const s of plan.sections) {
  console.log(`\n${s.world.padEnd(8)} ${s.t0.toFixed(1)}-${s.t1.toFixed(1)} (cruise to ${s.cruiseEnd.toFixed(1)})${s.arrive ? ' arrives' : ''}${s.depart ? ' departs' : ''}`);
  for (const c of s.chords) console.log(`   ${c.t0.toFixed(1).padStart(6)}  ${c.name.padEnd(46)} ${c.bass.padEnd(4)} | ${c.voicing.join(' ').padEnd(20)}${c.lines.length ? '   lines ' + c.lines.join(', ') : ''}`);
}
console.log('\nwarps:');
for (const w of plan.warps) console.log(`  ${w.ws.toFixed(1)}-${w.we.toFixed(1)} ${w.leg ? 'leg, arrival ' + w.ta.toFixed(1) : 'cruise'}  peak(eff) ${w.peak.toFixed(2)} raw ${w.rawPeak.toFixed(2)}${w.gesture ? '  ' + w.gesture + (w.mv !== undefined ? ' (moves ' + w.mv.toFixed(1) + ')' : '') : ''}${w.pivots && w.pivots.length ? '  pivots ' + w.pivots.join(' -> ') : ''}`);
const byType = {};
for (const e of plan.events) byType[e.type] = (byType[e.type] || 0) + 1;
console.log('\nevents:', JSON.stringify(byType));
const bad = plan.events.filter((e) => !Number.isFinite(e.t) || !Number.isFinite(e.end) || (e.midi !== undefined && !Number.isFinite(e.midi)) || (e.dur !== undefined && !(e.dur >= 0)));
console.log('bad events:', bad.length, bad.slice(0, 3));
for (const [k, a] of Object.entries(plan.lanes)) {
  let mn = Infinity,
    mx = -Infinity,
    nan = 0;
  for (const v of a) {
    if (!Number.isFinite(v)) nan++;
    mn = Math.min(mn, v);
    mx = Math.max(mx, v);
  }
  if (nan || (mn < 0 && !['loShelf', 'hiShelf', 'carveG'].includes(k))) console.log('lane', k, mn, mx, nan ? 'NaN ' + nan : ''); // dB lanes may be negative
}
// The chord heard just before each anchored arrival must be the chord written before it (the preparation: the
// dominant before Earthrise, the eclipse and the pale blue dot). fit() never drops it.
let anchorFail = 0;
console.log('\nanchors:');
for (const s of plan.sections)
  for (const a of s.anchorChecks || []) {
    console.log(`  ${a.ok ? 'ok  ' : 'FAIL'} ${s.world.padEnd(8)} ${String(a.cue).padEnd(14)} ${a.at.toFixed(1).padStart(6)}  ${a.before} -> ${a.anchor}${a.ok ? '' : '   (written: ' + a.expected + ')'}`);
    if (!a.ok) anchorFail++;
  }
// The melody plan: every phrase, its pitches, instrument and role.
const NN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
const nn = (m) => NN[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
console.log('');
console.log('melody plan:');
for (const p of plan.phrases) if (!p.duet) console.log(`  ${p.t0.toFixed(1).padStart(6)}-${p.t1.toFixed(1).padEnd(6)} ${p.world.padEnd(8)} ${p.name.padEnd(12)} ${p.inst.padEnd(6)} ${p.role.padEnd(5)} ${p.notes.map(nn).join(' ')}`);
const T = plan.themes;
console.log('');
console.log(`themes: ${T.phrases} phrases, coverage ${(100 * T.coverage).toFixed(0)}%, longest gap ${T.maxGap} s (from ${T.gapAt} s), ${T.statements} motif statements, identical rhythm share ${T.identicalShare} ${JSON.stringify(T.rhythms)}`);
const LG = T.long || [];
console.log(`long lines (8+ notes, 12+ s): ${LG.length}  ${LG.map((l) => `${l.name} ${l.world} ${l.t0}-${l.t1} (${l.notes} notes, ${(l.t1 - l.t0).toFixed(1)} s, ${l.inst})`).join('; ')}; fragments (<= 3 notes): ${T.fragments}`);
// register per world: the voice-led line's top-voice median (and what sounds on top of the sustained accompaniment),
// and the harmonic rhythm (mean seconds per chord)
console.log('register / harmonic rhythm:');
let regFail = 0;
plan.registers.forEach((r, i) => {
  const p0 = plan.registers[i - 1];
  const d = p0 && p0.top !== null && r.top !== null ? r.top - p0.top : null;
  const bad = d !== null && Math.abs(d) < 3 && r.world !== 'intro' && p0.world !== 'intro';
  if (bad) regFail++;
  console.log(`  ${bad ? 'FAIL' : 'ok  '} ${r.world.padEnd(8)} top ${r.top !== null ? nn(r.top).padEnd(4) : '-   '} bottom ${r.bottom !== null ? nn(r.bottom).padEnd(4) : '-   '} mean ${String(r.mean).padEnd(5)} sounding top ${r.sounding !== null ? nn(r.sounding).padEnd(4) : '-   '} vs previous ${d === null ? '-' : (d > 0 ? '+' : '') + d}  chord every ${r.chordSec} s (${r.chords})`);
});
console.log(`melody vs harmony rubs: ${plan.lineAudit.length}`);
for (const r of plan.lineAudit) console.log(`  ${r.t} ${r.world} ${r.phrase} ${r.note} over ${r.chord} against ${r.against}`);
console.log(`voicing issues: ${plan.voicingAudit.length}`);
for (const r of plan.voicingAudit) console.log(`  ${r.t} ${r.world} ${r.chord} [${r.voicing}]: ${r.issues.join('; ')}`);
let fail = 0;
if (anchorFail) {
  console.log(`${anchorFail} anchor(s) not prepared by their written chord`);
  fail++;
}
if (T.maxGap > 40) (fail++, console.log('FAIL thematic gap > 40 s'));
// (the fallback timing, used only without a director, gives every world 16 s: no room for a 30 s tune, and too
// little for a register to establish itself; there these two are reported, not failed)
const FB = process.argv.includes('--fallback');
if (LG.length < 3) (FB ? 0 : fail++, console.log(`${FB ? 'note' : 'FAIL'} fewer than 3 long lines (8+ notes, 12+ s)`));
if (regFail) (FB ? 0 : fail++, console.log(`${FB ? 'note' : 'FAIL'} neighbouring worlds within a minor third (top-voice median)`));
if (T.identicalShare >= 0.5) (fail++, console.log('FAIL >= 50% of motif statements share one rhythm'));
if (plan.voicingAudit.length) (fail++, console.log('FAIL voicing issues'));
if (plan.lineAudit.length) (fail++, console.log('FAIL melody rubs against the harmony'));
if (fail) process.exit(3);
