// Dumps the director's chapters, audio cues and sampled cue track (exactly what the score composes from) to
// shots/audio/cues.json, and prints a 1 Hz table of warp / fade / intensity / arrival / cue.
//   node src/audio/tools/probe.mjs [--quiet]
// The JSON lets the composer be iterated on in plain Node:  node src/audio/tools/compose-check.mjs
import puppeteer from 'puppeteer-core';
import { findChrome, ANGLE } from './chrome.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const quiet = process.argv.includes('--quiet');
const b = await puppeteer.launch({ executablePath: findChrome(), headless: 'new', args: [ANGLE] });
try {
  const p = await b.newPage();
  await p.goto('http://localhost:5178/dev.html?capture=1&hud=0&only=director');
  await p.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
  const r = await p.evaluate(async () => {
    const S = await import('/src/audio/score.js');
    const d = window.__app.director;
    const t0 = performance.now();
    const s = S.sampleCues(d);
    const ms = performance.now() - t0;
    const c = s.cues;
    return {
      sampleMs: ms,
      duration: d.duration,
      chapters: d.chapters.map((ch) => ({ id: ch.id, title: ch.title, body: ch.body, t0: ch.t0, t1: ch.t1 })),
      cues: { hz: c.hz, warp: Array.from(c.warp), fade: Array.from(c.fade), intensity: c.intensity && Array.from(c.intensity), arrival: c.arrival && Array.from(c.arrival), departure: c.departure && Array.from(c.departure), events: c.events },
    };
  });
  fs.mkdirSync(path.join(root, 'shots/audio'), { recursive: true });
  fs.writeFileSync(path.join(root, 'shots/audio/cues.json'), JSON.stringify(r));
  console.log(`duration ${r.duration} s, ${r.chapters.length} chapters, ${r.cues.events.length} cues; sampled in ${r.sampleMs.toFixed(0)} ms -> shots/audio/cues.json`);
  console.log(r.chapters.map((c) => `${c.id}@${c.t0.toFixed(1)}`).join('  '));
  console.log(r.cues.events.map((c) => `${c.id}@${c.t.toFixed(1)}`).join('  '));
  if (!quiet) {
    const c = r.cues;
    console.log('t\twarp\tfade\tint\tarrival');
    for (let i = 0; i < c.warp.length; i += c.hz) console.log([i / c.hz, c.warp[i].toFixed(2), c.fade[i].toFixed(2), c.intensity ? c.intensity[i].toFixed(2) : '-', c.arrival ? c.arrival[i].toFixed(2) : '-'].join('\t'));
  }
} finally {
  await b.close();
}
