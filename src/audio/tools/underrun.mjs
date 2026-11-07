// Audio-thread underrun probe (AudioContext.playbackStats, Chrome) at one moment of the score, A/B'd:
//   node src/audio/tools/underrun.mjs [--q "only=director,score"] [--t 292] [--secs 10]
// Runs: the full engine; the hall (convolver) bypassed; and a bare context (an oscillator) as the machine baseline.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const q = arg('q', 'only=director,score');
const T = Number(arg('t', 292));
const SECS = Number(arg('secs', 10));
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-underrun-'));
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir, protocolTimeout: 600000, defaultViewport: { width: 1280, height: 720 },
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
});
try {
  const page = await browser.newPage();
  await page.goto('http://localhost:5178/dev.html?' + q, { waitUntil: 'load', timeout: 180000 });
  await page.waitForFunction('window.__app && (window.__app.isReady || window.__app.failed)', { timeout: 300000, polling: 200 });
  const r = await page.evaluate(async (T, SECS) => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const ps = (ctx) => { const s = ctx.playbackStats; return s ? { d: s.underrunDuration, n: s.underrunEvents, T: s.totalDuration } : null; };
    const diff = (a, b) => ({ pct: +((100 * (b.d - a.d)) / Math.max(1e-6, b.T - a.T)).toFixed(2), events: b.n - a.n, seconds: +(b.T - a.T).toFixed(1) });
    const bare = async () => { const c = new AudioContext({ latencyHint: 'playback' }); const o = c.createOscillator(); const g = c.createGain(); g.gain.value = 0.001; o.connect(g).connect(c.destination); o.start(); await sleep(1500); const a = ps(c); await sleep(SECS * 1000); const b = ps(c); await c.close(); return a ? diff(a, b) : null; };
    const out = { bareBefore: await bare() };
    await window.__app.start();
    const E = window.__score._engine();
    if (!ps(E.ctx)) return { error: 'playbackStats unavailable' };
    window.__app.seek(T);
    await sleep(2500);
    let a = ps(E.ctx);
    await sleep(SECS * 1000);
    out.full = { ...diff(a, ps(E.ctx)), voices: window.__score.info().voices, sounding: window.__score.info().sounding };
    window.__app.seek(T);
    E.tWet.disconnect();
    await sleep(8000);
    a = ps(E.ctx);
    await sleep(SECS * 1000);
    out.noHall = diff(a, ps(E.ctx));
    window.__app.pause();
    await sleep(500);
    await E.ctx.suspend();
    out.bareAfter = await bare();
    out.latency = { base: E.ctx.baseLatency, output: E.ctx.outputLatency };
    return out;
  }, T, SECS);
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
}
