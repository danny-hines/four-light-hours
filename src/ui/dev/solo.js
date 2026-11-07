// HUD-only harness (dev only): the HUD module on a black page with a mock director whose chapter lengths match the
// planned film (cold open, ~34 s per world, a long finale), mock captions and labels, and a mock camera that sits
// a few radii from each world. Fast, and it exercises the cold open and the closing card at realistic timings.
//   node tools/shot.mjs --page src/ui/dev/solo.html --t 0:16:2 --sheet shots/hud/solo_open.png --cols 4
//   params: intro=<s> (default 18), chapter=<s> (34), finale=<s> (44)
import * as THREE from 'three';
import { BODIES, JOURNEY_ORDER } from '/src/core/bodies-data.js';
import { U } from '/src/core/uniforms.js';
import { heliocentricPosition, daysSinceJ2000, TIME_SCALE, AU, KM_PER_UNIT, C_KM_S } from '/src/core/astro.js';
import * as assets from '/src/core/assets.js';

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? +params.get(k) : d);
const epochDays = daysSinceJ2000(new Date('2026-11-02T12:00:00Z'));
const positions = { sun: new THREE.Vector3() };
for (const id of JOURNEY_ORDER) if (id !== 'sun') positions[id] = heliocentricPosition(id, epochDays);
const camera = new THREE.PerspectiveCamera(35, innerWidth / innerHeight, 1e-3, 1e9);

const app = {
  t: num('t', 0), playing: false, muted: false, isReady: false, failed: null,
  seek(t) { app.t = Math.max(0, Math.min(director.duration, t)); },
  play() { app.playing = true; }, pause() { app.playing = false; },
  togglePlay() { app.playing = !app.playing; }, setMuted(m) { app.muted = m; },
  async start() { app.play(); },
};
window.__app = app;

const INTRO = num('intro', 18), CH = num('chapter', 34), FIN = num('finale', 44);
const chapters = [{ id: 'intro', title: 'Four Light-Hours', t0: 0, t1: INTRO }];
let t = INTRO;
const ids = ['sun', 'mercury', 'venus', 'earth', 'mars', 'belt', 'jupiter', 'saturn', 'uranus', 'neptune'];
for (const id of ids) {
  chapters.push({ id, body: id === 'belt' ? undefined : id, title: id === 'belt' ? 'The Asteroid Belt' : BODIES[id].name, t0: t, t1: t + CH });
  t += CH;
}
chapters.push({ id: 'finale', title: 'Looking Back', t0: t, t1: t + FIN });
t += FIN;
const duration = t;

const director = {
  duration,
  chapters,
  evaluate(t) {
    let ci = chapters.findIndex((c) => t >= c.t0 && t < c.t1);
    if (ci < 0) ci = chapters.length - 1;
    const ch = chapters[ci];
    const id = ch.body || (ch.id === 'belt' ? 'mars' : ch.id === 'finale' ? 'neptune' : 'sun');
    const c = positions[id];
    const R = BODIES[id].radius;
    const toSun = c.lengthSq() ? c.clone().negate().normalize() : new THREE.Vector3(1, 0, 0);
    const u = (t - ch.t0) / (ch.t1 - ch.t0);
    const dir = toSun.applyAxisAngle(new THREE.Vector3(0, 1, 0), (30 + 40 * u) * Math.PI / 180);
    const dist = ch.id === 'finale' ? 400 * R * (1 + 30 * u) : R * (id === 'sun' ? 4 : 3.2);
    const camPos = c.clone().addScaledVector(dir, dist);
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(camPos, ch.id === 'finale' ? new THREE.Vector3() : c, new THREE.Vector3(0, 1, 0)));
    const travel = u > 0.8 ? Math.sin(Math.PI * (u - 0.8) / 0.2) : 0;
    const caps = [
      { id: ch.id + 'a', sub: 'Caption kicker', text: `A caption beat for ${ch.title}, timed by the director.`, t0: ch.t0 + 13, t1: ch.t0 + 19 },
      { id: ch.id + 'b', text: 'A second, longer caption that wraps onto another line to check the measure of the caption block.', t0: ch.t0 + 20, t1: ch.t0 + 26 },
    ];
    const labels = ch.id === 'finale' ? ['sun', 'mercury', 'venus', { id: 'earth', name: 'Earth', sub: 'you are here' }, 'mars', 'jupiter', 'saturn', 'uranus'] : null;
    return {
      camPos, camQuat: q, fov: 35, simDays: epochDays + (t * TIME_SCALE) / 86400, exposure: 1, warp: travel,
      speedC: travel * 60 + 0.004, skyGain: 1, focus: ch.id === 'finale' ? 'earth' : id, chapter: ch.id, chapterIndex: ci,
      fade: 0, letterbox: 0, captions: caps, labels,
    };
  },
};

const { create } = await import('/src/ui/hud.js');
const hud = await create({ THREE, app, capture: params.get('capture') === '1', visible: params.get('hud') !== '0', BODIES, U, assets, camera, positions, epochDays, quality: 'high' });
const bodies = {};
for (const id of JOURNEY_ORDER) bodies[id] = { id, radius: BODIES[id].radius, moons: [] };
await hud.attach({ director, bodies });
app.director = director;
app.bodies = bodies;
let last = null;
function render() {
  const shot = director.evaluate(app.t);
  last = shot;
  camera.aspect = innerWidth / innerHeight;
  camera.fov = shot.fov;
  camera.quaternion.copy(shot.camQuat);
  camera.position.set(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  hud.update(app.t, shot, { playing: app.playing, muted: app.muted, duration });
}
app.renderFrame = async () => {
  render();
  await new Promise((r) => requestAnimationFrame(r));
};
app.debugState = () => ({ t: app.t, chapter: last && last.chapter, hud: window.__hud && window.__hud.state });
app.gpuInfo = () => 'n/a (HUD solo harness)';
app.isReady = true;
console.log('[app] ready (HUD solo harness), duration', duration.toFixed(1));
if (params.get('capture') !== '1') {
  let prev = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
    if (app.playing) app.t = Math.min(duration, app.t + dt);
    if (app.t >= duration) app.playing = false;
    render();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
