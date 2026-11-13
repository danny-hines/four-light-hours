// Offline check of the explore beds (score.js setExplore, explore.js): renders beds back to back through the same
// ExploreBed controller the live page uses, and measures each stretch.
//   node src/audio/tools/explore.mjs                     every world's bed (45 s each, crossfaded) + a long Mars
//                                                        bed (rolls over to its next variation) -> notes/audio-explore.md,
//                                                        shots/audio/explore.wav
//   node src/audio/tools/explore.mjs --script "saturn:60,earth:60"
// Checks: no NaN, true peak < -1 dBTP, every bed's integrated loudness under the film's (and inside a 6 LU band),
// no click at any crossfade (largest sample step around it vs the bed's own), no silence inside a bed.
import puppeteer from 'puppeteer-core';
import { findChrome, ANGLE } from './chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
// --live <seconds>: a soak test in the real page instead: start(), setExplore('mars') (the busiest bed; it rolls
// over to a new variation every ~65 s), and every 10 s the engine's voices / generations, the JS heap and the
// audio thread's underruns (AudioContext.playbackStats). Nothing may grow.
if (arg('live', null)) {
  const secs = Number(arg('live'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-explore-live-'));
  const b = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', userDataDir: dir, protocolTimeout: 1800000, args: [ANGLE, '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--enable-precise-memory-info'] });
  let bad = 0;
  try {
    const page = await b.newPage();
    page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && /audio|score|Audio/i.test(m.text()) && (bad++, console.log('[console]', m.text().slice(0, 200))));
    await page.goto('http://localhost:5178/dev.html?' + arg('q', 'only=director,score'), { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 300000 });
    await page.evaluate(async (id) => { await window.__app.start(); window.__app.pause(); window.__score.api.setExplore(id); }, arg('world', 'mars'));
    const rows = [];
    for (let t = 10; t <= secs; t += 10) {
      await new Promise((r) => setTimeout(r, 10000));
      rows.push(await page.evaluate((t) => { const i = window.__score.info(); const ps = window.__score._engine().ctx.playbackStats; return { t, bed: i.explore && i.explore.world + '#' + i.explore.cycle, voices: i.voices, sounding: i.sounding, gens: i.generations, created: i.created, heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1e6).toFixed(1) : null, underrunMs: ps ? +(1000 * ps.underrunDuration).toFixed(1) : null, state: i.state }; }, t));
      const r = rows[rows.length - 1];
      console.log(`${String(r.t).padStart(4)} s  ${r.bed}  voices ${r.voices} (sounding ${r.sounding})  generations ${r.gens}  heap ${r.heapMB} MB  underruns ${r.underrunMs} ms  ${r.state}`);
    }
    const half = rows.slice(Math.floor(rows.length / 2));
    const vmax = Math.max(...rows.map((r) => r.voices)), vlate = Math.max(...half.map((r) => r.voices));
    const ok = rows.every((r) => r.state === 'running' && r.gens <= 2 && r.voices > 0) && vlate <= vmax && rows[rows.length - 1].underrunMs <= 0.005 * secs * 1000;
    console.log(ok ? 'OK: the bed ran without growth' : 'FAILED');
    const md = ['', '## Live soak', '', `\`node src/audio/tools/explore.mjs --live ${secs}\`: the real page, start(), film paused, setExplore('${arg('world', 'mars')}'), sampled every 10 s.`, '', '| s | bed (world#variation) | live voice sets | sounding | generations | JS heap MB | underruns ms (cumulative) | ctx |', '| --- | --- | --- | --- | --- | --- | --- | --- |', ...rows.map((r) => `| ${r.t} | ${r.bed} | ${r.voices} | ${r.sounding} | ${r.gens} | ${r.heapMB} | ${r.underrunMs} | ${r.state} |`), ''];
    const f = path.join(root, 'notes/audio-explore.md');
    let cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '# Audio — explore beds\n';
    const k = cur.indexOf('\n## Live soak');
    if (k >= 0) cur = cur.slice(0, k + 1);
    fs.writeFileSync(f, cur.replace(/\n+$/, '\n') + md.join('\n'));
    if (!ok) bad++;
  } finally {
    await b.close();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  process.exit(bad ? 3 : 0);
}
const ALL = ['sun', 'mercury', 'venus', 'earth', 'moon', 'mars', 'asteroids', 'jupiter', 'saturn', 'titan', 'uranus', 'neptune', 'triton', 'pluto'];
const script = arg('script', null) ? arg('script').split(',').map((x) => [x.split(':')[0], Number(x.split(':')[1] || 45)]) : [...ALL.map((w) => [w, 45]), ['mars', 150]];
const filmLufs = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'shots/audio/score_analysis.json'), 'utf8')).integratedLufs;
  } catch {
    return null;
  }
})();
const outDir = path.join(root, 'shots/audio');
fs.mkdirSync(outDir, { recursive: true });
const wavPath = path.join(outDir, 'explore.wav');
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-explore-'));
const browser = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', userDataDir, protocolTimeout: 1800000, args: [ANGLE, '--autoplay-policy=no-user-gesture-required'] });
let fail = 0;
try {
  const page = await browser.newPage();
  page.on('console', (m) => (m.type() === 'error' || m.type() === 'warn') && console.log('[console]', m.text().slice(0, 200)));
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://localhost:5178/dev.html?capture=1&hud=0&only=director', { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 300000 });
  fs.writeFileSync(wavPath, Buffer.alloc(0));
  await page.exposeFunction('__wavChunk', (b64) => fs.appendFileSync(wavPath, Buffer.from(b64, 'base64')));
  const res = await page.evaluate(async (script) => {
    const S = await import('/src/audio/score.js');
    const A = await import('/src/audio/tools/analyze.js');
    const X = await import('/src/audio/explore.js');
    const t0 = performance.now();
    const r = await S.renderExploreOffline({ script });
    const renderMs = performance.now() - t0;
    const segs = [];
    let at = 0;
    for (const [id, secs] of script) {
      // the bed alone: after its fade-in, before the next crossfade
      const m = A.measure(r.buffer, at + 4, at + secs - 0.5);
      const xf = A.measure(r.buffer, at - 0.3, at + 2.5); // around the crossfade into it
      const { st, ...mm } = m;
      segs.push({ id, t: at, secs, ...mm, xfStep: xf.maxStep, xfPeakDb: xf.truePeakDb });
      at += secs;
    }
    const whole = A.measure(r.buffer, 0, at);
    const cyc = r.marks.filter((m) => m.cycle).map((m) => ({ ...m, around: A.measure(r.buffer, m.t - 0.5, m.t + 8).maxStep, stAround: A.measure(r.buffer, m.t - 6, m.t + 12).st }));
    await A.streamWav(r.buffer, window.__wavChunk);
    return { segs, marks: r.marks, cyc, info: r.info, stats: r.stats, renderMs, whole: { lufs: whole.lufs, truePeakDb: whole.truePeakDb, nan: whole.nan, seconds: whole.seconds }, trim: X.EXPLORE.trimDb, cfg: { enter: X.EXPLORE.enter, swap: X.EXPLORE.swap, loop: X.EXPLORE.loop } };
  }, script);
  const lines = ['# Audio — explore beds (offline)', '', `Generated by \`node src/audio/tools/explore.mjs${process.argv.length > 2 ? ' ' + process.argv.slice(2).join(' ') : ''}\`: the beds played back to back through the live \`ExploreBed\` controller in an OfflineAudioContext (enter ${res.cfg.enter} s, world-to-world ${res.cfg.swap} s, variation-to-variation ${res.cfg.loop} s crossfades). Rendered ${res.whole.seconds} s in ${(res.renderMs / 1000).toFixed(1)} s; voices created ${res.info.created}, peak simultaneous ${res.info.peakVoices}, dropped ${res.info.dropped}, voice errors ${res.info.errors}; ${res.stats.beds} beds, ${res.stats.cycles} roll-overs.`, ''];
  lines.push(`Whole render: integrated ${res.whole.lufs} LUFS, true peak ${res.whole.truePeakDb} dBTP, NaN ${res.whole.nan}. The film's integrated loudness: ${filmLufs ?? 'n/a'} LUFS.`, '');
  lines.push('| bed (id) | from (s) | integrated LUFS | vs film | short-term min / max | true peak dBTP | largest step in the bed | largest step around the crossfade into it | trim dB |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of res.segs) {
    const w = res.marks.find((m) => m.id === s.id && Math.abs(m.t - s.t) < 0.6)?.world || s.id;
    lines.push(`| ${s.id}${w !== s.id ? ' → ' + w : ''} | ${s.t} | ${s.lufs} | ${filmLufs !== null ? (s.lufs - filmLufs).toFixed(1) : ''} | ${s.stMin} / ${s.stMax} | ${s.truePeakDb} | ${s.maxStep} | ${s.xfStep} | ${res.trim[w] ?? 0} |`);
  }
  if (res.cyc.length) {
    lines.push('', '## Roll-over to the next variation', '');
    for (const c of res.cyc) lines.push(`- ${c.id} at ${c.t} s (cycle ${c.cycle}, plan ${c.loop.toFixed(0)} s): largest step during the crossfade ${c.around}; short-term loudness from 6 s before to 12 s after: ${Math.min(...c.stAround)} .. ${Math.max(...c.stAround)} LUFS`);
  }
  const lufs = res.segs.map((s) => s.lufs);
  const checks = [
    ['no NaN', res.whole.nan === 0, String(res.whole.nan)],
    ['true peak < -1 dBTP', res.whole.truePeakDb < -1, res.whole.truePeakDb + ' dBTP'],
    ['every bed 1.5-8 LU under the film', filmLufs === null || lufs.every((l) => l <= filmLufs - 1.5 && l >= filmLufs - 8), `${Math.min(...lufs)} .. ${Math.max(...lufs)} LUFS (film ${filmLufs})`],
    ['no bed falls silent (short-term min > -40 LUFS)', res.segs.every((s) => s.stMin > -40), `lowest ${Math.min(...res.segs.map((s) => s.stMin))}`],
    ['no click at a crossfade (largest step around it <= 2.5x the largest step inside the two beds it joins, or tiny)', res.segs.every((s, i) => s.xfStep <= Math.max(0.02, 2.5 * Math.max(s.maxStep, i ? res.segs[i - 1].maxStep : 0))), `worst ratio ${Math.max(...res.segs.map((s, i) => s.xfStep / Math.max(1e-4, s.maxStep, i ? res.segs[i - 1].maxStep : 0))).toFixed(2)}`],
    ['roll-over: the level holds within 5 LU across the crossfade', res.cyc.every((c) => Math.max(...c.stAround) - Math.min(...c.stAround) <= 5), res.cyc.map((c) => (Math.max(...c.stAround) - Math.min(...c.stAround)).toFixed(1)).join(', ') || 'none rendered'],
    ['no voice errors, nothing left over', res.info.errors === 0, `errors ${res.info.errors}, generations alive at the end ${res.info.generations}, voices ${res.info.voices}`],
  ];
  lines.splice(4, 0, '| check | | value |', '| --- | --- | --- |', ...checks.map(([k, v, x]) => `| ${k} | ${v ? 'PASS' : 'FAIL'} | ${x} |`), '');
  const noteFile = path.join(root, 'notes/audio-explore.md');
  const prev = fs.existsSync(noteFile) ? fs.readFileSync(noteFile, 'utf8') : '';
  const soakAt = prev.indexOf('\n## Live soak');
  fs.writeFileSync(noteFile, lines.join('\n') + '\n' + (soakAt >= 0 ? prev.slice(soakAt) : ''));
  for (const s of res.segs) console.log(`${s.id.padEnd(9)} ${String(s.t).padStart(4)} s  ${s.lufs} LUFS  ST ${s.stMin}..${s.stMax}  TP ${s.truePeakDb}  step ${s.maxStep} / xfade ${s.xfStep}`);
  for (const c of res.cyc) console.log(`roll-over ${c.id} at ${c.t} s: step ${c.around}, ST ${Math.min(...c.stAround)}..${Math.max(...c.stAround)}`);
  for (const [k, v, x] of checks) {
    console.log(`${v ? 'PASS' : 'FAIL'}  ${k}  (${x})`);
    if (!v) fail++;
  }
  console.log(`whole: ${res.whole.lufs} LUFS, TP ${res.whole.truePeakDb}; wrote notes/audio-explore.md, shots/audio/explore.wav`);
} finally {
  await browser.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
process.exit(fail ? 3 : 0);
