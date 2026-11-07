// Times the pieces of a live seek (new generation, catch-up, scheduling) in the real page.
//   node src/audio/tools/profile.mjs
import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', protocolTimeout: 300000, args: ['--use-angle=d3d11', '--autoplay-policy=no-user-gesture-required'] });
try {
  const p = await b.newPage();
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log('[console]', m.text()); });
  await p.goto('http://localhost:5178/dev.html?q=low&only=director,score');
  await p.waitForFunction('window.__app && window.__app.isReady', { timeout: 120000 });
  const r = await p.evaluate(async () => {
    await window.__app.start();
    window.__app.play();
    await new Promise((r) => setTimeout(r, 3000));
    const E = window.__score._engine();
    const out = [];
    for (const t of [130, 240, 300, 60, 400, 250, 251, 252]) {
      const now = E.ctx.currentTime;
      const t0 = performance.now();
      E.anchor(t, now);
      for (const g of E.gens) E.retire(g, now, 0.5);
      const t1 = performance.now();
      const g = E.newGeneration(t, now + 0.03, 0.5);
      const t2 = performance.now();
      E.scheduleUntil(g, t + 0.6);
      const t3 = performance.now();
      out.push({ t, retire: +(t1 - t0).toFixed(2), newGen: +(t2 - t1).toFixed(2), sched: +(t3 - t2).toFixed(2), voices: E.voices.length });
      await new Promise((r) => setTimeout(r, 400));
    }
    // isolate: lanes only (one 20 s chunk for 16 params)
    const ctx = E.ctx, L = E.plan.lanes;
    const g0 = performance.now();
    { const lanes = []; for (let k = 0; k < 16; k++) lanes.push([ctx.createGain().gain, L.level]); E.startLanes({}, lanes, 100, ctx.currentTime + 0.1); }
    const g1 = performance.now();
    // isolate: building 20 pad voices
    const ev = E.plan.events.find((e) => e.type === 'pad' && e.t > 120);
    const p0 = performance.now();
    for (let k = 0; k < 20; k++) E.play(E.liveGen(), ev, ctx.currentTime + 0.1, 0.5);
    const p1 = performance.now();
    return { out, lanes16: +(g1 - g0).toFixed(2), pad20: +(p1 - p0).toFixed(2) };
  });
  console.log(JSON.stringify(r, null, 1));
} finally {
  await b.close();
}
