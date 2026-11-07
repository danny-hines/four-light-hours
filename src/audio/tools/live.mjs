// Live-path test: loads the real page (not capture mode), starts audio the way the HUD's button does
// (app.start()), then plays, seeks, scrubs, pauses (long enough to auto-suspend), resumes, mutes, and plays
// through a warp leg — printing the engine state after each step and every console warning/error.
//   node src/audio/tools/live.mjs [--seconds 20]  -> also writes notes/audio-live.md
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const secIdx = process.argv.indexOf('--seconds');
const PLAY = secIdx > 0 ? Number(process.argv[secIdx + 1]) : 20;
// --q "<query>" loads the page with another query (e.g. a light page: --q "only=director,score"); --out <md>
const qIdx = process.argv.indexOf('--q');
const QUERY = qIdx > 0 ? process.argv[qIdx + 1] : 'q=low';
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? process.argv[outIdx + 1] : 'notes/audio-live.md';
const wavIdx = process.argv.indexOf('--wav');
const args = { wav: wavIdx > 0 ? process.argv[wavIdx + 1] : null }; // the offline render the ending is compared with
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-live-'));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  userDataDir,
  protocolTimeout: 600000,
  defaultViewport: { width: 1280, height: 720 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
const logs = [];
let errors = 0; // audio-related only (other modules being rebuilt in parallel are listed, not counted)
const audioRelated = (txt) => /audio|score|AudioContext|AudioParam|AudioNode|AudioScheduled|worklet/i.test(txt);
const rows = [];
let stall = null,
  ending = null,
  underruns = null;
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.type();
    if (t === 'error' || t === 'warn' || t === 'warning' || /\[audio\]/.test(m.text())) logs.push(`[console.${t}] ${m.text()}`);
    if (t === 'error' && audioRelated(m.text())) errors++;
  });
  page.on('pageerror', (e) => {
    if (audioRelated(e.message + ' ' + (e.stack || ''))) errors++;
    logs.push(`[pageerror] ${e.message}`);
  });
  await page.goto('http://localhost:5178/dev.html?' + QUERY, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 300000, polling: 200 });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = async (label) => {
    const s = await page.evaluate(() => ({ t: +window.__app.t.toFixed(2), playing: window.__app.playing, info: window.__score ? window.__score.info() : null }));
    const i = s.info || {};
    const row = { label, t: s.t, playing: s.playing, state: i.state, active: i.active, voices: i.voices, generations: i.generations, byCat: i.byCat, muted: i.muted, limiter: i.limiter, latency: i.latency, updAvg: i.updateMsAvg, updMax: i.updateMsMax, regenMax: i.regenMsMax, resumeMax: i.resumeMsMax, piano: i.pianoNotesReady, dropped: i.dropped, stolen: i.stolen, errors: i.errors };
    rows.push(row);
    console.log(`${label.padEnd(34)} t=${String(row.t).padEnd(7)} ${row.state} active=${row.active} voices=${row.voices} gens=${row.generations} upd avg ${row.updAvg} ms max ${row.updMax} ms regen max ${row.regenMax} ms resume() max ${row.resumeMax} ms piano ${row.piano}`);
  };
  const plan = await page.evaluate(() => window.__score && { sections: window.__score.sections, events: window.__score.events, planMs: window.__score.planMs });
  console.log('score plan:', JSON.stringify(plan));
  await page.evaluate(() => window.__app.start());
  await sleep(3000);
  await snap('start() + 3 s playing');
  await page.evaluate(() => window.__app.seek(130));
  await sleep(1500);
  await snap('seek(130) Earth, +1.5 s');
  for (let i = 0; i < 25; i++) {
    await page.evaluate((x) => window.__app.seek(x), 200 + i * 2);
    await sleep(40);
  }
  await sleep(300);
  await snap('scrub 25 seeks in 1 s');
  await sleep(2000);
  await snap('after scrub +2 s (old gens gone)');
  await page.evaluate(() => window.__app.pause());
  await sleep(1200);
  await snap('pause +1.2 s');
  await sleep(9000);
  await snap('pause +10 s (should be suspended)');
  await page.evaluate(() => window.__app.play());
  await sleep(1500);
  await snap('resume +1.5 s');
  await page.evaluate(() => window.__app.setMuted(true));
  await sleep(500);
  await snap('muted');
  await page.evaluate(() => window.__app.setMuted(false));
  await page.evaluate(() => window.__app.seek(255));
  await sleep(PLAY * 1000);
  await snap(`seek(255) + play ${PLAY} s (Saturn leg)`);
  // Audio-thread underruns (AudioContext.playbackStats, Chrome): 8 s in each of the densest moments of the score.
  // Fails above 0.5% of playback time.
  underruns = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ctx = window.__score._engine().ctx;
    if (!ctx.playbackStats) return null;
    const ps = () => ({ d: ctx.playbackStats.underrunDuration, n: ctx.playbackStats.underrunEvents, T: ctx.playbackStats.totalDuration });
    const out = [];
    for (const [label, t] of [['Sun', 20], ['Earth sunrise', 128], ['Jupiter skim', 254], ['Saturn eclipse', 292], ['Uranus', 344], ['finale', 414]]) {
      window.__app.seek(t);
      await sleep(2500);
      const a = ps();
      await sleep(8000);
      const b = ps(),
        i1 = window.__score.info();
      out.push({ label, t, seconds: +(b.T - a.T).toFixed(2), underrunMs: +(1000 * (b.d - a.d)).toFixed(1), events: b.n - a.n, pct: +((100 * (b.d - a.d)) / Math.max(1e-6, b.T - a.T)).toFixed(2), voices: i1.voices, sounding: i1.sounding, updMax: i1.updateMsMax });
    }
    return out;
  });
  if (underruns) {
    for (const u of underruns) console.log(`underruns ${u.label.padEnd(15)} ${String(u.pct).padStart(5)}% (${u.events} events, ${u.underrunMs} ms in ${u.seconds} s), voices ${u.voices} (sounding ${u.sounding})`);
    if (underruns.some((u) => u.pct > 0.5)) {
      errors++;
      logs.push('[live.mjs] audio underruns above 0.5% of playback time');
    }
  } else console.log('AudioContext.playbackStats not available in this browser: underruns not measured');
  // Tap the real output (after the limiter and mute stage) ON THE AUDIO THREAD: a tiny AudioWorklet posts the RMS
  // of every 50 ms block with its context time, so the measurement is exact even while the page's main thread
  // is stalled (messages arrive late, but they are timestamped).
  await page.evaluate(async () => {
    const E = window.__score._engine();
    const src = `class Tap extends AudioWorkletProcessor { constructor(){ super(); this.s = 0; this.n = 0; this.N = Math.round(sampleRate * 0.05); }
      process(inputs){ const x = inputs[0]; if (x && x[0]) { for (let c = 0; c < x.length; c++) { const d = x[c]; for (let i = 0; i < d.length; i++) this.s += d[i] * d[i]; } this.n += x[0].length;
        if (this.n >= this.N) { this.port.postMessage([currentTime, this.s / (this.n * x.length)]); this.s = 0; this.n = 0; } } return true; } }
      registerProcessor('fl-tap', Tap);`;
    const url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    await E.ctx.audioWorklet.addModule(url);
    const tap = new AudioWorkletNode(E.ctx, 'fl-tap', { numberOfInputs: 1, numberOfOutputs: 0 });
    E.mute.connect(tap);
    window.__blocks = [];
    tap.port.onmessage = (m) => window.__blocks.push(m.data);
    window.__marks = [];
    window.__mark = (label) => window.__marks.push({ label, ctx: E.ctx.currentTime, t: window.__app.t, anchorT: E.anchorT, anchorCtx: E.anchorCtx });
  });
  const mean = (a) => (a.length ? +(10 * Math.log10(a.reduce((x, y) => x + y, 0) / a.length + 1e-12)).toFixed(1) : null);
  const winDb = (blocks, a, b) => mean(blocks.filter(([c]) => c >= a && c < b).map(([, ms]) => ms));
  // a 3 s main-thread stall while playing (a shader compile, a GC storm): the 5 s lookahead keeps the music going
  await page.evaluate(() => window.__app.seek(120));
  await sleep(5000);
  const st = await page.evaluate(() => {
    const ctx = window.__score._engine().ctx;
    const c0 = ctx.currentTime, t0 = performance.now();
    while (performance.now() - t0 < 3000) {} // block the main thread (audio keeps rendering on its own thread)
    return { c0, c1: ctx.currentTime };
  });
  await sleep(3000);
  const b1 = await page.evaluate(() => window.__blocks.splice(0));
  stall = { beforeDb: winDb(b1, st.c0 - 2, st.c0), duringDb: winDb(b1, st.c0, st.c0 + 3), lastSecondOfStallDb: winDb(b1, st.c0 + 2, st.c0 + 3), afterDb: winDb(b1, st.c0 + 3.5, st.c0 + 5.5), resyncs: await page.evaluate(() => window.__score.info().resyncs) };
  console.log('stall test', JSON.stringify(stall));
  await snap('3 s main-thread stall in Earth, +3 s');
  // The end of the film: main.js stops the picture at `duration`; the composed tail (final chord release, closing
  // bell and glass) must keep playing on the audio clock. Compare the live output with the offline render at the
  // same journey times (shots/audio/score.wav).
  await page.evaluate(() => window.__app.seek(window.__app.director.duration - 8));
  await page.waitForFunction(() => window.__app.t >= window.__app.director.duration - 0.01, { timeout: 120000, polling: 50 });
  await page.evaluate(() => window.__mark('picture reached the end'));
  await sleep(11000);
  const b2 = await page.evaluate(() => window.__blocks.splice(0));
  const mk = (await page.evaluate(() => window.__marks)).find((m) => m.label === 'picture reached the end');
  const dur = await page.evaluate(() => window.__app.director.duration);
  // journey time of the audio clock at the end mark (the engine's anchor maps ctx -> journey time)
  const ja = mk.anchorT + (mk.ctx - mk.anchorCtx);
  const live = [];
  for (let k = 0; k < 9; k++) live.push(winDb(b2, mk.ctx + (dur + k - ja), mk.ctx + (dur + k + 1 - ja)));
  let offline = null;
  try {
    // offline reference: 16-bit stereo WAV written by render.mjs
    // (--wav <file> picks another render; a WAV rendered for a different cut is not compared: its length must be
    // this film's duration plus the composed tail, within 0.5 s)
    const buf = fs.readFileSync(path.join(root, args.wav || 'shots/audio/score.wav'));
    const sr = buf.readUInt32LE(24),
      data = 44;
    const wavSec = (buf.length - data) / 4 / sr;
    if (Math.abs(wavSec - (dur + 7)) > 0.5) throw new Error(`stale reference WAV (${wavSec.toFixed(1)} s for a ${dur.toFixed(1)} s film)`);
    const rms = (t0, t1) => {
      let s = 0,
        n = 0;
      for (let i = Math.floor(t0 * sr); i < Math.floor(t1 * sr); i++) {
        const o = data + i * 4;
        if (o + 4 > buf.length) break;
        const l = buf.readInt16LE(o) / 32768,
          r = buf.readInt16LE(o + 2) / 32768;
        s += (l * l + r * r) / 2;
        n++;
      }
      return n ? +(10 * Math.log10(s / n + 1e-12)).toFixed(1) : null;
    };
    offline = [];
    for (let k = 0; k < 9; k++) offline.push(rms(dur + k, dur + k + 1));
  } catch (e) {
    offline = [String(e.message || e)];
  }
  ending = { audioAheadOfPictureAtEnd: +(ja - dur).toFixed(2), sawEnding: true, live, offline, finalActive: await page.evaluate(() => window.__score.info().active) };
  console.log('ending test', JSON.stringify(ending));
  await snap('end of film +11 s (tail played, then stop)');
  const hidden = await page.evaluate(() => document.hidden);
  console.log('document.hidden', hidden);
} catch (e) {
  errors++;
  logs.push(`[live.mjs] ${e.stack || e.message}`);
} finally {
  for (const l of logs) console.log(l);
  await browser.close();
  try {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  } catch {}
}
const md = [
  '# Audio live-path test',
  '',
  `Generated by node src/audio/tools/live.mjs${QUERY !== 'q=low' ? ' --q "' + QUERY + '"' : ''} (page query ${QUERY}): real page (no capture mode), app.start(), then seek, a 25-seek scrub, pause (long enough to auto-suspend), resume, mute, a warp leg, audio-thread underruns in the densest moments, a 3 s main-thread stall and the film's end.`,
  '',
  '| step | journey t | ctx state | active | voices | generations | update() avg / max ms | dropped / stolen / voice errors |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.label} | ${r.t} | ${r.state} | ${r.active} | ${r.voices} | ${r.generations} | ${r.updAvg} / ${r.updMax} | ${r.dropped} / ${r.stolen} / ${r.errors} |`),
  '',
  '"voices" counts every live voice node set, including notes already scheduled up to 5 s ahead.',
  '',
  '## Audio-thread underruns',
  '',
  'AudioContext.playbackStats over 8 s of playback in each of the densest moments (after a seek and 2.5 s of settling). Fails above 0.5% of playback time.',
  '',
  underruns ? ['| moment | journey t | underrun % | events | ms | live voice sets | sounding |', '| --- | --- | --- | --- | --- | --- | --- |', ...underruns.map((u) => `| ${u.label} | ${u.t} | ${u.pct} | ${u.events} | ${u.underrunMs} | ${u.voices} | ${u.sounding} |`)].join(String.fromCharCode(10)) : '- playbackStats not available',
  '',
  '## Main-thread stall',
  '',
  'The page blocks its main thread for 3 s while playing Earth (t ~124). The score is scheduled 5 s ahead, so the audio thread keeps playing the composed music; output RMS (after the limiter) is compared just before and just after the stall.',
  '',
  stall ? `- output RMS (audio-thread tap): 2 s before ${stall.beforeDb} dBFS, during the 3 s stall ${stall.duringDb} (its last second ${stall.lastSecondOfStallDb}), 0.5-2.5 s after ${stall.afterDb}; resync crossfades so far: ${stall.resyncs}` : '- not run',
  '',
  '## End of the film',
  '',
  'Seek to duration - 6 s and play through the last frame. main.js stops the picture at `duration`; the score must keep playing its composed tail (final chord release, closing bell and glass, the hall) and then stop. Output RMS after the last frame:',
  '',
  ending
    ? [
        `- audio clock vs picture at the last frame: ${ending.audioAheadOfPictureAtEnd} s; score still active 11 s later: ${ending.finalActive}`,
        '',
        '| journey time after the last frame (s) | ' + ending.live.map((_, k) => `${k}-${k + 1}`).join(' | ') + ' |',
        '| --- | ' + ending.live.map(() => '---').join(' | ') + ' |',
        '| live RMS dBFS | ' + ending.live.join(' | ') + ' |',
        '| offline render RMS dBFS | ' + (ending.offline || []).join(' | ') + ' |',
      ].join(String.fromCharCode(10))
    : '- not run',
  '',
  `Audio-related console errors: ${errors}. All console warnings/errors seen (including other modules): ${logs.length ? '' : 'none'}`,
  ...logs.map((l) => '- ' + l.replace(/\|/g, '/')),
  '',
];
fs.writeFileSync(path.join(root, OUT), md.join('\n'));
console.log(errors ? `FAILED with ${errors} audio-related errors` : `OK, no audio-related errors${logs.length ? ' (' + logs.length + ' messages from other modules listed above)' : ''}`);
process.exit(errors ? 2 : 0);
