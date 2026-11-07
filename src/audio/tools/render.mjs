// Offline render of the whole score in headless Chrome (OfflineAudioContext, the same engine as live playback).
//
//   node src/audio/tools/render.mjs                    full film with the real director -> shots/audio/score.wav,
//                                                      shots/audio/spectrogram.png, notes/audio-report.md
//   node src/audio/tools/render.mjs --from 60 --to 120 a window (faster iteration)
//   node src/audio/tools/render.mjs --fast             load only the director for real (other modules fall back)
//   node src/audio/tools/render.mjs --fallback         ignore the director: fallback timing (adaptation test)
//   node src/audio/tools/render.mjs --seek-test        exercise the live seek/crossfade path inside a render
//   node src/audio/tools/render.mjs --no-wav           skip writing the WAV
//   --sr 48000  --makeup <dB>  --out <dir> (default shots/audio)  --report <md> (default notes/audio-report.md)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PORT = 5178;

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const k = argv[i].slice(2),
    v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) args[k] = true;
  else {
    args[k] = v;
    i++;
  }
}
const outDir = path.resolve(root, args.out || 'shots/audio');
const reportPath = path.resolve(root, args.report || (args['seek-test'] ? 'notes/audio-seek-report.md' : 'notes/audio-report.md'));
const sr = Number(args.sr || 48000);
const opts = {
  sr,
  from: Number(args.from || 0),
  to: args.to ? Number(args.to) : null,
  makeup: args.makeup !== undefined ? Number(args.makeup) : undefined,
  wav: !args['no-wav'],
  fallback: !!args.fallback,
  seeks: args['seek-test'] ? [[8, 150], [14, 40], [17, 41.5], [20, 300], [27, 90]] : [],
};
const tag = args['seek-test'] ? 'seek-test' : args.from || args.to ? `score_${opts.from}-${opts.to ?? 'end'}` : 'score';

async function serverUp() {
  try {
    return (await fetch(`http://localhost:${PORT}/package.json`)).ok;
  } catch {
    return false;
  }
}
async function ensureServer() {
  if (await serverUp()) return;
  const child = spawn(process.execPath, [path.join(root, 'tools', 'serve.mjs'), String(PORT)], { cwd: root, detached: true, stdio: 'ignore' });
  child.unref();
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await serverUp()) return;
  }
  throw new Error('dev server did not start');
}
function findChrome() {
  for (const c of [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].filter(Boolean))
    if (fs.existsSync(c)) return c;
  throw new Error('No Chrome/Edge found; set CHROME_PATH');
}

await ensureServer();
fs.mkdirSync(outDir, { recursive: true });
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-render-'));
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  userDataDir,
  protocolTimeout: 1800000,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'],
});
const audioRelated = (txt) => /audio|score|AudioContext|AudioParam|AudioNode|AudioScheduled|worklet|render\.mjs/i.test(txt);
const logs = [];
let errors = 0,
  checkFail = false;
const wavPath = path.join(outDir, `${tag}.wav`);
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.type();
    // long shader dumps from other pieces are cut to their first line
    if (t === 'error' || t === 'warn' || t === 'warning' || /\[audio\]|\[app\] (ready|module)/.test(m.text())) logs.push(`[console.${t}] ${m.text().split(String.fromCharCode(10))[0].slice(0, 300)}`);
    // only audio-related errors fail the render (other pieces are rebuilt in parallel; theirs are listed)
    if (t === 'error' && audioRelated(m.text())) errors++;
  });
  page.on('pageerror', (e) => {
    if (audioRelated(e.message + ' ' + (e.stack || ''))) errors++;
    logs.push(`[pageerror] ${e.message}`);
  });
  const q = ['capture=1', 'hud=0', args.fast ? 'only=director' : '', args.fallback ? 'only=none' : '', args.q || ''].filter(Boolean).join('&');
  const t0 = Date.now();
  await page.goto(`http://localhost:${PORT}/dev.html?${q}`, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__app && (window.__app.isReady === true || window.__app.failed)', { timeout: 300000, polling: 200 });
  console.log(`page ready in ${Date.now() - t0} ms`);
  if (opts.wav) fs.writeFileSync(wavPath, Buffer.alloc(0));
  await page.exposeFunction('__wavChunk', (b64) => fs.appendFileSync(wavPath, Buffer.from(b64, 'base64')));
  await page.exposeFunction('__progress', (p) => process.stdout.write(`\rrendering ${(p * 100).toFixed(0)}%   `));
  const res = await page.evaluate(async (o) => {
    const S = await import('/src/audio/score.js');
    const A = await import('/src/audio/tools/analyze.js');
    const director = o.fallback ? null : window.__app.director;
    let lastP = 0;
    const r = await S.renderOffline({
      director, sampleRate: o.sr, from: o.from, to: o.to, makeupDb: o.makeup, seeks: o.seeks,
      onProgress: (p) => { if (p - lastP > 0.05) { lastP = p; window.__progress(p); } },
    });
    const ta = performance.now();
    const a = A.analyze(r.buffer, r.plan, { from: o.seeks.length ? 0 : r.from });
    const png = A.spectrogram(r.buffer, r.plan, a, { from: o.seeks.length ? 0 : r.from, width: 2400 });
    // click detector for the seek test: biggest sample-to-sample step around each seek point vs elsewhere
    let clicks = null;
    if (o.seeks.length) {
      const L = r.buffer.getChannelData(0), sr = r.buffer.sampleRate;
      const maxStep = (a0, a1) => { let m = 0; for (let i = Math.max(1, a0); i < Math.min(L.length, a1); i++) m = Math.max(m, Math.abs(L[i] - L[i - 1])); return m; };
      clicks = o.seeks.map(([c, jt]) => ({ at: c, to: jt, stepAround: +maxStep(Math.floor((c - 0.1) * sr), Math.floor((c + 1.2) * sr)).toFixed(4), stepBefore: +maxStep(Math.floor((c - 2.5) * sr), Math.floor((c - 0.2) * sr)).toFixed(4) }));
    }
    const analyseMs = performance.now() - ta;
    if (o.wav) await A.streamWav(r.buffer, window.__wavChunk);
    const { _series, ...analysis } = a;
    const dir = window.__app.director;
    return {
      analysis, png, clicks, info: r.info, planMs: r.planMs, renderMs: r.renderMs, analyseMs, len: r.len,
      plan: { duration: r.plan.duration, events: r.plan.events.length, sections: r.plan.sections, phrases: r.plan.phrases, themes: r.plan.themes, registers: r.plan.registers, cues: r.plan.cues, lineAudit: r.plan.lineAudit, voicingAudit: r.plan.voicingAudit, warps: r.plan.warps.map((w) => ({ ws: w.ws, we: w.we, wp: w.wp, ta: w.ta, leg: w.leg, arrives: w.arrives, peak: w.peak, gesture: w.gesture, pivots: w.pivots, mv: w.mv })) },
      director: o.fallback || !dir ? 'fallback timing (no director)' : `${dir.chapters.length} chapters, ${dir.duration.toFixed(1)} s`,
      failures: window.__app.failures || [],
    };
  }, opts);
  process.stdout.write('\n');
  fs.writeFileSync(path.join(outDir, tag === 'score' ? 'spectrogram.png' : `${tag}_spectrogram.png`), Buffer.from(res.png.split(',')[1], 'base64'));
  fs.writeFileSync(path.join(outDir, `${tag}_analysis.json`), JSON.stringify({ ...res.analysis, info: res.info, plan: res.plan, clicks: res.clicks }, null, 1));
  const A = res.analysis;
  const ok = (b) => (b ? 'PASS' : 'FAIL');
  const lines = [];
  lines.push(`# Audio report — ${tag}`, '');
  lines.push(`Generated by \`node src/audio/tools/render.mjs${argv.length ? ' ' + argv.join(' ') : ''}\` (offline render in headless Chrome, same engine as live playback).`, '');
  lines.push(`- Director: ${res.director}; score plan: ${res.plan.events} events, ${res.plan.sections.length} music sections, ${res.plan.warps.length} warp legs (planned in ${res.planMs.toFixed(0)} ms)`);
  lines.push(`- Rendered ${res.len.toFixed(1)} s at ${sr} Hz in ${(res.renderMs / 1000).toFixed(1)} s (${(res.len / (res.renderMs / 1000)).toFixed(1)}x real time); analysis ${(res.analyseMs / 1000).toFixed(1)} s`);
  lines.push(`- Limiter: ${res.info.limiter}; voices created ${res.info.created}, peak simultaneous ${res.info.peakVoices} (${Object.entries(res.info.peakByCat).map(([k, v]) => `${k} ${v}`).join(', ')}); dropped ${res.info.dropped}, stolen ${res.info.stolen}; voice errors ${res.info.errors}`);
  lines.push(`- Files: \`${path.relative(root, wavPath).split(path.sep).join('/')}\`${opts.wav ? '' : ' (skipped)'}, \`${path.relative(root, path.join(outDir, tag === 'score' ? 'spectrogram.png' : tag + '_spectrogram.png')).split(path.sep).join('/')}\``, '');
  lines.push('## Master', '');
  lines.push('| check | value | target | |', '| --- | --- | --- | --- |');
  lines.push(`| true peak (4x oversampled) | ${A.truePeakDb} dBTP at ${A.truePeakAt} s | < -1.0 dBTP | ${ok(A.truePeakDb < -1)} |`);
  lines.push(`| sample peak | ${A.samplePeakDb} dBFS at ${A.samplePeakAt} s | < -1.0 dBFS | ${ok(A.samplePeakDb < -1)} |`);
  lines.push(`| integrated loudness (BS.1770-4, gated) | ${A.integratedLufs} LUFS | about -18 | ${ok(Math.abs(A.integratedLufs + 18) <= 2)} |`);
  lines.push(`| loudness range (EBU 3342) | ${A.lra} LU | cinematic: 6-15 | ${ok(A.lra >= 4 && A.lra <= 18)} |`);
  lines.push(`| max short-term loudness | ${A.shortTermMax} LUFS | | |`);
  if (!res.clicks) lines.push(`| longest silence (< -60 dBFS / 100 ms) inside the film | ${A.longestSilence.seconds} s at ${A.longestSilence.at} s | < 1.5 s | ${ok(A.longestSilence.seconds < 1.5)} |`);
  lines.push(`| DC offset L / R | ${A.integrity.dcL.toExponential(2)} / ${A.integrity.dcR.toExponential(2)} | < 1e-3 | ${ok(Math.abs(A.integrity.dcL) < 1e-3 && Math.abs(A.integrity.dcR) < 1e-3)} |`);
  lines.push(`| NaN / Inf samples | ${A.integrity.nan} | 0 | ${ok(A.integrity.nan === 0)} |`);
  lines.push(`| subnormal samples | ${A.integrity.subnormal} | 0 | ${ok(A.integrity.subnormal === 0)} |`, '');
  if (!res.clicks) {
  lines.push('## Per chapter', '');
  lines.push('Centroid = energy-weighted spectral centroid. Bands = share of energy: sub <60 Hz, low 60-250, low-mid 250-1k, mid 1-4k, high 4-12k, air >12k. Width = side/mid energy.', '');
  lines.push('| chapter | world | t (s) | RMS dBFS | peak dBFS | LUFS | ST max | centroid Hz | sub / low / lowmid / mid / high / air % | width | L/R corr | <150 Hz corr | L-R dB |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of A.chapters) {
    if (c.rmsDb === undefined) continue;
    const b = c.bands;
    lines.push(`| ${c.title || c.id} | ${c.world} | ${c.t0.toFixed(1)}-${c.t1.toFixed(1)} | ${c.rmsDb} | ${c.peakDb} | ${c.lufs} | ${c.stMax} | ${c.centroidHz} | ${b.sub} / ${b.low} / ${b.lowmid} / ${b.mid} / ${b.high} / ${b.air} | ${c.width} | ${c.corr} | ${c.lowCorr} | ${c.balanceDb} |`);
  }
  lines.push('', '## Music sections and harmony', '');
  lines.push('| world | t (s) | LUFS | centroid Hz | chords (voice-led) |', '| --- | --- | --- | --- | --- |');
  res.plan.sections.forEach((s, i) => {
    const a = A.sections[i] || {};
    lines.push(`| ${s.world} | ${s.t0.toFixed(1)}-${s.t1.toFixed(1)} | ${a.lufs ?? ''} | ${a.centroidHz ?? ''} | ${s.chords.map((c) => `${c.name}${c.lines && c.lines.length ? ' [' + c.lines.join(', ') + ']' : ''} (${c.bass} / ${c.voicing.join(' ')})`).join(' → ')} |`);
  });
  lines.push('', '## Warp legs', '');
  lines.push('HF rise = 4-16 kHz energy near peak speed vs the 3 s before the leg (the broadband riser). moves = when the camera starts to move (warp >= 10% of its peak; a director may hold the shot after its departure marker); pre = median momentary loudness (400 ms) of the 2 s before that (the music the leg takes over from); leg min / max = quietest / loudest 1 s inside the leg vs pre (a continuous crescendo: min >= -1 dB, max 0..+5 dB: the riser crests ~+2 dB, the music under it may swell too); arrival step = largest 50 ms RMS jump around the reveal vs the 0.5 s before it (< 8 dB: an arrival, not a jump-scare). Leg ST max / bloom / settled = short-term loudness during the leg, in the 8 s after the arrival and 4-20 s after it.', '');
  lines.push('Every leg is one gesture (composer.js GESTURES) whose harmony moves through the arriving world\'s approach chords (pivots) into the reveal. A crescendo leg at warp speed (riser, choir, streak, brass; peak warp >= 0.5) must stay within -1..+5 dB of the music it takes over from (a slower drift must not sag more than 3 dB); a hush leg must fall away (leg min <= -6 dB) and the reveal must rise out of the quiet (bloom >= the hush + 6 dB).', '');
  lines.push('| start | gesture | pivots | peak speed | arrival | kind | peak warp | HF rise dB | moves | pre LUFS | leg min vs pre | leg max vs pre | arrival step dB | leg ST max | bloom ST max | settled | leg - settled | bloom - leg |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  A.warps.forEach((w) => { const pw = res.plan.warps.find((x) => Math.abs(x.ws - w.ws) < 0.05) || {}; lines.push(`| ${w.ws} | ${pw.gesture || (w.leg ? 'riser' : 'cruise')} | ${(pw.pivots || []).join(' → ')} | ${pw.wp ? pw.wp.toFixed(2) : ''} | ${w.leg ? w.ta : '-'} | ${w.leg ? (w.arrives ? 'leg' : 'move inside a world') : 'cruise'} | ${w.peak} | ${w.hfRiseDb} | ${w.moves ?? ''} | ${w.preLeg ?? ''} | ${w.legMinVsPre ?? ''} | ${w.legMaxVsPre ?? ''} | ${w.arrivalStepDb ?? ''} | ${w.legStMax ?? ''} | ${w.bloomStMax ?? ''} | ${w.arrivalMedian ?? ''} | ${w.legOverArrival ?? ''} | ${w.bloomOverLeg ?? ''} |`); });
  lines.push('', '## World character', '');
  lines.push('Each world\'s music alone (3 s after it begins to the start of its departure leg): spectral centroid against the band chosen for that world (worlds.js `centroid`), the change from the world before it, band shares, and the stereo image (L/R correlation, correlation below 150 Hz, L-R balance).', '');
  lines.push('| world | t (s) | LUFS | centroid Hz | target Hz | vs previous (octaves) | sub / low / lowmid / mid / high / air % | corr | <150 Hz corr | L-R dB |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const c of A.character) lines.push(`| ${c.world} | ${c.t0}-${c.t1} | ${c.lufs ?? ''} | ${c.centroidHz ?? ''} | ${c.target ? c.target.join('-') : ''} ${c.inTarget === false ? '(outside)' : ''} | ${c.octavesFromPrev ?? ''} | ${c.bands ? Object.values(c.bands).join(' / ') : ''} | ${c.corr ?? ''} | ${c.lowCorr ?? ''} | ${c.balanceDb ?? ''} |`);
  // register and harmonic rhythm per world
  const NNr = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const nnr = (m) => (m === null || m === undefined ? '-' : NNr[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1));
  const REG = res.plan.registers || [];
  lines.push('', '## Register and harmonic rhythm', '');
  lines.push('The voice-led line every pad and choir layer reads from (theory.js voiceChord, pulled toward each world\'s own register, worlds.js `reg`): time-weighted medians of its top and bottom voice over the world\'s own chords; "sounding top" = the highest note sounding in the sustained accompaniment (pads, ensemble choir, strings, low brass, with their octave offsets). Neighbouring worlds must differ by at least a minor third in top-voice median.', '');
  lines.push('| world | top voice | bottom voice | mean (MIDI) | sounding top | vs previous (semitones) | seconds per chord | chords |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  REG.forEach((r, i) => lines.push(`| ${r.world} | ${nnr(r.top)} | ${nnr(r.bottom)} | ${r.mean} | ${nnr(r.sounding)} | ${i && REG[i - 1].top !== null && r.top !== null ? r.top - REG[i - 1].top : ''} | ${r.chordSec} | ${r.chords} |`));
  const SS = A.selfsim;
  if (SS) {
    lines.push('', '## Spectral self-similarity between worlds', '');
    lines.push('Each world\'s long-term spectral envelope (its own music, the spans of "World character"; 40 log bands, 40 Hz-16 kHz, dB). corr = Pearson correlation of the mean-removed envelopes (shape alone); cos = cosine of the envelopes floored 80 dB under the loudest band (shape and level, like a log-mel self-similarity matrix). Lower = more distinct.', '');
    lines.push('| world | ' + SS.worlds.join(' | ') + ' |', '| --- | ' + SS.worlds.map(() => '---').join(' | ') + ' |');
    SS.worlds.forEach((w, i) => lines.push(`| ${w} | ${SS.corr[i].map((x, j) => (x === null ? '' : j === i ? '-' : x.toFixed(2))).join(' | ')} |`));
    lines.push('', '| neighbours | corr | cos |', '| --- | --- | --- |');
    for (let i = 1; i < SS.worlds.length; i++) if (SS.corr[i][i - 1] !== null) lines.push(`| ${SS.worlds[i - 1]} → ${SS.worlds[i]} | ${SS.corr[i][i - 1]} | ${SS.cos[i][i - 1]} |`);
  }
  const CUES = res.plan.cues || [];
  const ANCH = ['earthrise', 'eclipse', 'pale-blue-dot'].map((id) => CUES.find((c) => c.id === id)).filter(Boolean);
  lines.push('', '## Loudness arc', '');
  lines.push(`The film's loudest short-term moments (3 s windows ending at t, at least 8 s apart), and the three emotional anchors (${ANCH.map((a) => a.id + ' ' + a.t.toFixed(1)).join(', ')}): the top 3 must be the anchors, and no warp leg may come within 1 dB of the quietest anchor.`, '');
  lines.push('| rank | t (s) | ST LUFS | anchor |', '| --- | --- | --- | --- |');
  (A.stPeaks || []).forEach((pk, i) => lines.push(`| ${i + 1} | ${pk.t} | ${pk.lufs} | ${ANCH.find((a) => pk.t >= a.t - 2 && pk.t <= a.t + 16)?.id || ''} |`));
  const TH = res.plan.themes;
  const NN0 = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const nn0 = (m) => NN0[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
  lines.push('', '## Thematic plan', '');
  lines.push(`**Long tunes** (theory.js TUNES, laid bar by bar over a span of chords by worlds.js \`tunes\`): ${(TH.long || []).map((l) => `${l.name} (${l.world}, ${l.t0}-${l.t1} s, ${l.notes} notes, ${l.inst})`).join('; ')}; ${TH.fragments} fragments of 3 notes or fewer between them. Two themes and their family (theory.js THEMES, placed by worlds.js \`lines\`): **A**, the pale blue motif (5 - 3' - 2' - 1') and **L**, the light (5 - 9 - 3' - #4'), developed by fragmentation (SIXTH, L_HEAD), inversion (INV), augmentation (A_HORN), appoggiatura (A_APP), an extended cadence (A_EXT) and a broken, unresolved form (A_BROKEN). ${TH.phrases} melodic events, the melody sounds ${(100 * TH.coverage).toFixed(0)}% of the film, the longest stretch without one is ${TH.maxGap} s (from ${TH.gapAt} s); ${TH.statements} statements of the motif family, the most common rhythm is shared by ${(100 * TH.identicalShare).toFixed(0)}% of them. Harmony audits: ${res.plan.lineAudit.length} melody notes rubbing a semitone / minor ninth against the chord, ${res.plan.voicingAudit.length} voicings with a rub below C5.`, '');
  lines.push('| t (s) | world | theme | instrument | role | notes |', '| --- | --- | --- | --- | --- | --- |');
  for (const p of res.plan.phrases) if (!p.duet) lines.push(`| ${p.t0.toFixed(1)}-${p.t1.toFixed(1)} | ${p.world} | ${p.name} | ${p.inst}${res.plan.phrases.some((q) => q.duet && Math.abs(q.t0 - p.t0) < 0.01) ? ' + voice' : ''} | ${p.role} | ${p.notes.map(nn0).join(' ')} |`);
  lines.push('', '## Melody salience', '');
  lines.push('Every melody note (piano, solo voice, horns): rise = its fundamental (+-40 cents) 0.16-0.6 s after the onset vs the same band just before; margin = its fundamental vs the strongest other partial within an octave either side (the phrase\'s own notes and their octaves excluded). Target: margin >= +6 dB.', '');
  lines.push('| t | world | instrument | phrase | note | rise dB | margin dB |', '| --- | --- | --- | --- | --- | --- | --- |');
  const NN = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];
  const nn = (m) => NN[((Math.round(m) % 12) + 12) % 12] + (Math.floor(Math.round(m) / 12) - 1);
  for (const m of A.motif) lines.push(`| ${m.t} | ${m.world} | ${m.inst} | ${m.phrase} | ${nn(m.midi)} | ${m.riseDb} | ${m.marginDb} |`);
  lines.push('', '## Harmonic anchors', '');
  lines.push('The chord heard just before each anchored arrival must be the one written before it in the world\'s progression (its preparation, e.g. the dominant).', '');
  lines.push('| world | cue | at (s) | anchor chord | chord before | written before | |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const s of res.plan.sections) for (const a of s.anchorChecks || []) lines.push(`| ${s.world} | ${a.cue} | ${a.at.toFixed(1)} | ${a.anchor} | ${a.before} | ${a.expected} | ${ok(a.ok)} |`);
  // ---- summary checks (the render exits with code 3 when a musical check fails)
  // the leg checks apply to the legs that carry us to a new world (not to a camera move inside one)
  const legs = A.warps.filter((w) => w.leg && w.arrives && w.legOverArrival !== undefined);
  const gest = (w) => (res.plan.warps.find((x) => Math.abs(x.ws - w.ws) < 0.05) || {}).gesture || 'riser';
  // a crescendo leg at warp speed (peak >= 0.5); a slower move between worlds (a drift) only must not sag > 3 dB
  const drift = legs.filter((w) => gest(w) !== 'hush' && w.peak < 0.5);
  const cres = legs.filter((w) => gest(w) !== 'hush' && w.peak >= 0.5),
    hush = legs.filter((w) => gest(w) === 'hush');
  const pk3 = (A.stPeaks || []).slice(0, 3);
  const anchorOf = (pk) => ANCH.find((a) => pk.t >= a.t - 2 && pk.t <= a.t + 16);
  const anchorPeaks = ANCH.map((a) => Math.max(-99, ...(A.stPeaks || []).filter((pk) => pk.t >= a.t - 2 && pk.t <= a.t + 16).map((pk) => pk.lufs)));
  const legLoudest = Math.max(...legs.map((w) => w.legStMax));
  const LONG = TH.long || [];
  const regBad = REG.filter((r, i) => i > 1 && REG[i - 1].top !== null && r.top !== null && Math.abs(r.top - REG[i - 1].top) < 3);
  const contrasts = A.character.filter((c) => c.octavesFromPrev !== null);
  const anchors = res.plan.sections.flatMap((s) => s.anchorChecks || []);
  const checks = [
    ['true peak < -1 dBTP', A.truePeakDb < -1, `${A.truePeakDb} dBTP`],
    ['integrated loudness -18 +- 2 LUFS', Math.abs(A.integratedLufs + 18) <= 2, `${A.integratedLufs} LUFS`],
    ['every crescendo leg: never below the pre-leg music by > 1 dB', cres.every((w) => w.legMinVsPre === null || w.legMinVsPre >= -1), `worst ${Math.min(...cres.map((w) => w.legMinVsPre ?? 0)).toFixed(1)} dB`],
    ['every crescendo leg crests 0..+5 dB above the pre-leg music', cres.every((w) => w.legMaxVsPre === null || (w.legMaxVsPre >= -0.5 && w.legMaxVsPre <= 5)), `${Math.min(...cres.map((w) => w.legMaxVsPre ?? 0)).toFixed(1)} .. ${Math.max(...cres.map((w) => w.legMaxVsPre ?? 0)).toFixed(1)} dB`],
    ['every slow drift between worlds (peak warp < 0.5) sags no more than 3 dB', drift.every((w) => w.legMinVsPre === null || w.legMinVsPre >= -3), drift.map((w) => `${w.ws}: ${w.legMinVsPre} dB (peak ${w.peak})`).join(', ') || 'none'],
    ['every hush leg falls away (<= -6 dB) and the reveal rises out of it (bloom >= hush + 6 dB)', hush.every((w) => (w.legMinVsPre ?? 0) <= -6 && w.bloomStMax - (w.preLeg + w.legMinVsPre) >= 6), hush.map((w) => `${w.ws}: ${w.legMinVsPre} dB, bloom +${(w.bloomStMax - (w.preLeg + w.legMinVsPre)).toFixed(1)}`).join(', ') || 'none'],
    ['the top 3 short-term moments are the anchors (Earthrise, eclipse, pale blue dot)', ANCH.length < 3 || (pk3.length === 3 && new Set(pk3.map((pk) => anchorOf(pk)?.id).filter(Boolean)).size === 3), pk3.map((pk) => `${pk.t} s ${pk.lufs} (${anchorOf(pk)?.id || 'not an anchor'})`).join(', ')],
    ['no warp leg within 1 dB of the quietest anchor', ANCH.length < 3 || legLoudest <= Math.min(...anchorPeaks) - 1, `loudest leg ${legLoudest.toFixed(1)}, quietest anchor ${Math.min(...anchorPeaks).toFixed(1)} LUFS`],
    ['at least 3 long melodic lines (8+ notes, 12+ s)', LONG.length >= 3, LONG.map((l) => `${l.name} ${l.notes} notes ${(l.t1 - l.t0).toFixed(0)} s`).join(', ')],
    ['neighbouring worlds differ by a minor third or more (top-voice median)', regBad.length === 0, regBad.map((r) => r.world).join(', ') || 'all'],
    ['every arrival step < 8 dB within 50 ms', legs.every((w) => w.arrivalStepDb < 8), `worst ${Math.max(...legs.map((w) => w.arrivalStepDb)).toFixed(1)} dB`],
    ['every reveal at least as loud as its leg (bloom - leg >= -0.5 dB; a hush leg: see its own check)', legs.every((w) => gest(w) === 'hush' || w.bloomOverLeg >= -0.5), `worst ${Math.min(...legs.filter((w) => gest(w) !== 'hush').map((w) => w.bloomOverLeg)).toFixed(1)} dB`],
    ['every world inside its own centroid band', A.character.every((c) => c.inTarget !== false), `${A.character.filter((c) => c.inTarget === false).map((c) => c.world + ' ' + c.centroidHz + ' Hz').join(', ') || 'all'}`],
    ['stereo: every world L/R correlation >= 0.3', A.character.every((c) => c.corr === null || c.corr >= 0.3), `lowest ${Math.min(...A.character.map((c) => c.corr ?? 1)).toFixed(2)}`],
    ['stereo: below 150 Hz correlation >= 0.9', A.character.every((c) => c.lowCorr === null || c.lowCorr >= 0.9), `lowest ${Math.min(...A.character.map((c) => c.lowCorr ?? 1)).toFixed(2)}`],
    ['stereo: |L-R| balance < 0.75 dB', A.character.every((c) => c.balanceDb === null || Math.abs(c.balanceDb) < 0.75), `worst ${Math.max(...A.character.map((c) => Math.abs(c.balanceDb ?? 0))).toFixed(2)} dB`],
    ['every melody note >= +6 dB over local partials', A.motif.length > 0 && A.motif.every((m) => m.marginDb >= 6), `${A.motif.filter((m) => m.marginDb >= 6).length}/${A.motif.length} notes, worst ${Math.min(...A.motif.map((m) => m.marginDb)).toFixed(1)} dB`],
    ['no stretch > 40 s without a melodic event', TH.maxGap <= 40, `${TH.maxGap} s`],
    ['< 50% of motif statements share one rhythm', TH.identicalShare < 0.5, `${(100 * TH.identicalShare).toFixed(0)}% of ${TH.statements}`],
    ['no melody note rubs the harmony; no voicing rubs below C5', res.plan.lineAudit.length === 0 && res.plan.voicingAudit.length === 0, `${res.plan.lineAudit.length} / ${res.plan.voicingAudit.length}`],
    ['every anchor prepared by its written chord', anchors.every((a) => a.ok), `${anchors.filter((a) => a.ok).length}/${anchors.length}`],
  ];
  res.checks = checks;
  lines.splice(lines.indexOf('## Master'), 0, '## Score checks', '', '| check | | value |', '| --- | --- | --- |', ...checks.map(([k, v, x]) => `| ${k} | ${ok(v)} | ${x} |`), '');
  }
  if (res.clicks) {
    lines.push('', '## Seek / crossfade test', '', 'Largest sample-to-sample step in the 1.3 s around each simulated seek vs the 2.3 s before it (a click would show as a spike).', '');
    lines.push('| ctx time | seek to | step around | step before |', '| --- | --- | --- | --- |');
    for (const c of res.clicks) lines.push(`| ${c.at} | ${c.to} | ${c.stepAround} | ${c.stepBefore} |`);
  }
  lines.push('', '## Console', '', logs.length ? logs.map((l) => '- ' + l.replace(/\|/g, '/')).join('\n') : '- no warnings or errors', '');
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`true peak ${A.truePeakDb} dBTP, sample peak ${A.samplePeakDb} dBFS, integrated ${A.integratedLufs} LUFS, LRA ${A.lra} LU, longest silence ${A.longestSilence.seconds} s, NaN ${A.integrity.nan}, subnormal ${A.integrity.subnormal}`);
  console.log(`render ${(res.renderMs / 1000).toFixed(1)} s for ${res.len.toFixed(1)} s audio; voices peak ${res.info.peakVoices}; wrote ${path.relative(root, reportPath)}`);
  if (res.checks) {
    for (const [k, v, x] of res.checks) console.log(`${v ? 'PASS' : 'FAIL'}  ${k}  (${x})`);
    if (!opts.from && !opts.to && res.checks.some(([, v]) => !v)) checkFail = true;
  }
  if (res.failures.length) console.log('app failures:', res.failures);
} catch (e) {
  errors++;
  logs.push(`[render.mjs] ${e.stack || e.message}`);
} finally {
  for (const l of logs) console.log(l);
  await browser.close();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}
process.exit(errors ? 2 : checkFail ? 3 : 0);
