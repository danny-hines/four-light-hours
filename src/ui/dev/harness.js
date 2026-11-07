// HUD test harness (dev only, never imported by the app). Wraps director.evaluate once the app is ready and adds
// mock `captions` and `labels` so the HUD paths can be tested before the real director provides them.
//   node tools/shot.mjs --page src/ui/dev/harness.html --t 30:60:5 --sheet shots/hud/harness.png
const LINES = [
  ['The surface', 'Granules the size of countries rise and sink in minutes.'],
  ['Terminator', 'Long shadows mark the line between a scorching day and a frozen night.'],
  ['Cloud deck', 'Sulphuric acid clouds hide the surface from every visible-light camera.'],
  ['Night side', 'City lights trace coastlines and rivers.'],
  ['Phobos', 'Mars’s inner moon circles faster than Mars turns.'],
  ['Great Red Spot', 'A storm wider than Earth, observed for centuries.'],
  ['The rings', 'Billions of ice fragments, from grains to boulders.'],
  ['Sideways', 'For decades at a time, one pole faces the Sun.'],
  ['Triton', 'Nitrogen geysers on a world colder than any other we have visited.'],
];
function patch(app) {
  const d = app.director;
  if (!d || d.__patched) return;
  d.__patched = true;
  const orig = d.evaluate.bind(d);
  const chapters = d.chapters || [];
  const order = ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
  d.evaluate = (t) => {
    const s = orig(t);
    const ci = s.chapterIndex ?? 0;
    const ch = chapters[ci];
    if (!ch) return s;
    const L = ch.t1 - ch.t0;
    const k = Math.max(0, ci - 1) % LINES.length;
    const caps = [{ id: 'c' + ci, sub: LINES[k][0], text: LINES[k][1], t0: ch.t0 + Math.min(11.8, L * 0.74), t1: ch.t1 - 0.2 }];
    s.captions = caps;
    const id = ch.body || ch.id;
    const next = order[order.indexOf(id) + 1];
    const labels = [];
    if (next) labels.push({ id: next, sub: 'next' });
    const b = app.bodies[id];
    if (b && b.moons) for (const m of b.moons) labels.push({ id: m.id, name: m.name || m.id });
    if (ci === chapters.length - 1) for (const p of order) labels.push(p === 'earth' ? { id: p, name: 'Earth', sub: 'you are here' } : p);
    s.labels = labels;
    return s;
  };
}
let _app;
Object.defineProperty(window, '__app', {
  configurable: true,
  get: () => _app,
  set(a) {
    _app = a;
    let ready = a.isReady;
    Object.defineProperty(a, 'isReady', {
      configurable: true,
      get: () => ready,
      set(v) {
        if (v) patch(a);
        ready = v;
      },
    });
  },
});
await import('/src/main.js');
