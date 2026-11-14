// Entry point: renderer, floating-origin world, module wiring, main loop and the capture API (window.__app).
//
// URL parameters
//   capture=1           deterministic mode for tools/shot.mjs: no splash, no audio, paused, frames rendered on demand
//   hud=0|1             show the HUD overlay (default 1)
//   t=<s>               start at journey time t
//   epoch=<ISO date>    date the planets are positioned for (default: now; capture default 2026-11-02T12:00:00Z)
//   q=low|med|high      starting resolution budget (1.0 / 1.4 / 2.0 megapixels); playback then adapts it to the frame rate
//   res=<MP>            pin the drawing buffer to this many megapixels (no adaptation)
//   view=body           inspect one body instead of running the journey:
//     body=<id>           sun, mercury, venus, earth, mars, jupiter, saturn, uranus, neptune, asteroids
//     target=<moonId>     centre on one of that body's moons instead (e.g. body=earth&target=moon)
//     dist=<radii>        camera distance from the target centre in target radii (default 3)
//     phase=<deg>         angle Sun-target-camera; 0 = looking at the fully lit face, 90 = half lit, 160 = crescent
//     el=<deg>            camera elevation above the target's orbital plane (default 10)
//     roll=<deg>          camera roll (default 0)
//     fov=<deg>           vertical field of view (default 35)
//     look=<x,y>          aim offset in degrees (yaw, pitch) away from the target centre
//     rel=<id>            measure phase from the direction toward body/moon <id> instead of the Sun
//     aim=<id>            look at body/moon <id> instead of the target (e.g. Earthrise: body=earth&target=moon&rel=earth&phase=88&dist=1.01&aim=earth)
//     aimRaDec=<ra,dec>   look toward J2000 sky coordinates in degrees (e.g. Orion 84,-2)
//     sky=<gain>          star / Milky Way gain
//   body=asteroids: camera sits dist*50 units before the belt crossing point, looking along the flight path (phase/el = yaw/pitch)
//     days=<d>            simulated days added to the epoch (rotation / moon phase); default 0
//     exposure=<f>        exposure override (default 1)
//   free=1              free-fly orbit camera around the current focus (dev)
import * as THREE from 'three';
import { U } from './core/uniforms.js';
import { AU, DEG, TIME_SCALE, daysSinceJ2000, heliocentricPosition, radecToThree } from './core/astro.js';
import { BODIES, JOURNEY_ORDER } from './core/bodies-data.js';
import { fitFov } from './core/frame.js';
import * as assets from './core/assets.js';

import { placeholderBody } from './fallback/body.js';
import { createExplore } from './ui/explore.js';

// Modules are loaded dynamically so that one broken module falls back to a placeholder instead of
// taking the whole app down (important while many builders work in parallel).
const MODULES = {
  sun: () => import('./bodies/sun.js'),
  mercury: () => import('./bodies/mercury.js'),
  venus: () => import('./bodies/venus.js'),
  earth: () => import('./bodies/earth.js'),
  mars: () => import('./bodies/mars.js'),
  jupiter: () => import('./bodies/jupiter.js'),
  saturn: () => import('./bodies/saturn.js'),
  uranus: () => import('./bodies/uranus.js'),
  neptune: () => import('./bodies/neptune.js'),
  asteroids: () => import('./bodies/asteroids.js'),
  sky: () => import('./sky/sky.js'),
  post: () => import('./render/post.js'),
  glints: () => import('./render/glints.js'),
  director: () => import('./journey/director.js'),
  hud: () => import('./ui/hud.js'),
  score: () => import('./audio/score.js'),
};
const FALLBACKS = {
  asteroids: () => import('./fallback/asteroids.js'),
  sky: () => import('./fallback/sky.js'),
  post: () => import('./fallback/post.js'),
  glints: () => import('./fallback/glints.js'),
  director: () => import('./fallback/director.js'),
  hud: () => import('./fallback/hud.js'),
  score: () => import('./fallback/score.js'),
};
const FALLBACK_COLORS = { sun: 0xfff1d0, mercury: 0x8c8680, venus: 0xe8d6a8, earth: 0x3a6fb0, mars: 0xb5552e, jupiter: 0xc9a27a, saturn: 0xd8c08a, uranus: 0x9fd8e0, neptune: 0x3456c8 };

const params = new URLSearchParams(location.search);
const num = (k, d) => (params.has(k) ? Number(params.get(k)) : d);
const CAPTURE = params.get('capture') === '1';
const VIEW = params.get('view') || 'journey';
const QUALITY = params.get('q') || 'high';
const SHOW_HUD = params.get('hud') !== '0';
// only=<id,id,...>: load just these modules for real; everything else uses fallbacks (fast, isolated testing)
const ONLY = params.get('only') ? new Set(params.get('only').split(',')) : null;
const failures = [];

async function createModule(key, ctx) {
  const useReal = !ONLY || ONLY.has(key);
  if (useReal) {
    try {
      const mod = await MODULES[key]();
      return await mod.create(ctx);
    } catch (e) {
      console.error(`[app] module "${key}" failed, using fallback:`, e);
      failures.push(`${key}: ${e && e.message}`);
    }
  }
  if (FALLBACKS[key]) return (await FALLBACKS[key]()).create(ctx);
  return placeholderBody(ctx, { id: key, radius: ctx.data.radius, color: FALLBACK_COLORS[key], emissive: key === 'sun' });
}

// Per-frame calls are isolated too: a module that throws is reported once and skipped afterwards.
const broken = new Set();
function safe(key, fn) {
  if (broken.has(key)) return;
  try {
    fn();
  } catch (e) {
    broken.add(key);
    failures.push(`${key} (runtime): ${e && e.message}`);
    console.error(`[app] module "${key}" threw at runtime and is now disabled:`, e);
  }
}

const app = {
  isReady: false,
  failed: null,
  t: num('t', 0),
  playing: false,
  muted: false,
  free: params.get('free') === '1',
};
window.__app = app;

function log(...a) {
  console.log('[app]', ...a);
}

async function boot() {
  const epochDate = params.get('epoch') ? new Date(params.get('epoch')) : CAPTURE ? new Date('2026-11-02T12:00:00Z') : new Date();
  const epochDays = daysSinceJ2000(epochDate);

  // ---------------------------------------------------------------- renderer
  const canvas = document.createElement('canvas');
  canvas.id = 'view';
  document.body.appendChild(canvas);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true,
    preserveDrawingBuffer: CAPTURE,
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.autoClear = false;
  // Resolution: the drawing buffer is sized from a megapixel budget, not from the display. A Retina laptop in
  // fullscreen is ~6 MP, four times what the heaviest shots can shade at 60 fps on its GPU; the film's own soft
  // optics (bloom, grain) upscale gracefully and the HUD is DOM, so it stays sharp. During playback the budget
  // adapts to the measured frame rate (see `adapt` below). res=<MP> pins it; capture mode renders 1:1.
  const DPR_CAP = Math.min(window.devicePixelRatio || 1, 2);
  const MP_LEVELS = [0.5, 0.7, 1.0, 1.4, 2.0, 2.8, 4.0, 5.6, 8.0];
  const resPinned = params.has('res') ? Math.max(0.2, Number(params.get('res'))) : null;
  const res = { level: MP_LEVELS.indexOf({ low: 1.0, med: 1.4, high: 2.0 }[QUALITY] ?? 2.0), ceiling: MP_LEVELS.length - 1 };
  const ratioFor = (mp) => Math.min(DPR_CAP, Math.sqrt((mp * 1e6) / Math.max(1, window.innerWidth * window.innerHeight)));
  const targetRatio = () => (CAPTURE && resPinned === null ? Math.min(window.devicePixelRatio || 1, 2) : ratioFor(resPinned ?? MP_LEVELS[res.level]));
  renderer.setPixelRatio(targetRatio());
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  if (!renderer.capabilities.reversedDepthBuffer) log('warning: EXT_clip_control unavailable; reversed depth disabled');

  const scene = new THREE.Scene();
  const world = new THREE.Group(); // floating origin: positioned at -cameraUniverse each frame
  world.name = 'world';
  scene.add(world);
  const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 1e-4, 1e9);
  scene.add(camera);

  const ctx = { THREE, renderer, scene, world, camera, U, BODIES, assets, quality: QUALITY, capture: CAPTURE, epochDays };

  // ---------------------------------------------------------------- bodies
  const positions = { sun: new THREE.Vector3() };
  for (const id of JOURNEY_ORDER) if (id !== 'sun') positions[id] = heliocentricPosition(id, epochDays);
  ctx.positions = positions;

  const hud = SHOW_HUD || !CAPTURE ? await createModule('hud', { ...ctx, app, capture: CAPTURE, visible: SHOW_HUD }) : null;
  // the static first-paint card of the web build hands over to the real splash
  const bootEl = document.getElementById('boot');
  if (bootEl) {
    bootEl.classList.add('gone');
    setTimeout(() => bootEl.remove(), 900);
  }
  const offProgress = assets.onProgress((d, n) => hud?.setLoading?.(n ? d / n : 0));

  const bodyList = await Promise.all(JOURNEY_ORDER.map((id) => createModule(id, { ...ctx, data: BODIES[id] })));
  const bodies = {};
  for (const b of bodyList) {
    bodies[b.id] = b;
    b.object.position.copy(positions[b.id]);
    world.add(b.object);
  }
  ctx.bodies = bodies;

  const belt = await createModule('asteroids', ctx);
  world.add(belt.object);
  const sky = await createModule('sky', ctx);
  scene.add(sky.object);
  const glints = await createModule('glints', ctx);
  world.add(glints.object);

  const director = await createModule('director', ctx);
  if (director.beltCrossing && belt.setCrossing) belt.setCrossing(director.beltCrossing.position, director.beltCrossing.direction);
  if (director.object) world.add(director.object); // e.g. orbit lines for the finale
  ctx.director = director;
  // every consumer of the film's shots (renderer, HUD composer, labels, explore) sees the field of view fitted to this
  // screen's shape, so a portrait phone keeps the subject in the picture (core/frame.js)
  if (director.evaluate) {
    const evaluate16x9 = director.evaluate.bind(director);
    director.evaluate = (t) => {
      const s = evaluate16x9(t);
      return { ...s, fov: fitFov(s.fov ?? 35, window.innerWidth / Math.max(1, window.innerHeight)) };
    };
  }

  const post = await createModule('post', ctx);
  const score = CAPTURE ? null : await createModule('score', ctx);

  // live camera: look-around during the film and Explore mode (created before the HUD's controls attach, so its
  // key handling comes first while exploring)
  let explore = null;
  if (VIEW !== 'body') {
    try {
      explore = createExplore({ ...ctx, app, capture: CAPTURE });
    } catch (e) {
      console.error('[app] explore mode unavailable:', e);
    }
  }
  // the score follows the world being explored (moons of Jupiter share its bed)
  const AMBIENT = { io: 'jupiter', europa: 'jupiter', ganymede: 'jupiter', callisto: 'jupiter' };
  app.onExplore = (id) => {
    app.exploring = !!id;
    safe('score', () => score?.setExplore?.(id ? AMBIENT[id] || id : null));
  };
  app.enterExplore = (id, opts) => explore?.enter(id, opts);
  app.exitExplore = () => explore?.exit();
  app.explore = explore;

  // ---------------------------------------------------------------- body-inspection view
  // universe position of any body or moon id at a given simulated day
  function positionOf(id, days) {
    if (id === 'sun') return new THREE.Vector3();
    if (bodies[id]) return bodies[id].object.position.clone();
    for (const b of Object.values(bodies)) {
      const m = b.moons?.find((m) => m.id === id);
      if (m) return b.object.position.clone().add(m.positionAt(days));
    }
    return null;
  }

  function bodyViewShot() {
    const id = params.get('body') || 'earth';
    const days = epochDays + num('days', 0);
    const up = new THREE.Vector3(0, 1, 0);
    let center, radius;
    if (id === 'asteroids') {
      // dist = units*50 behind the crossing point along the flight direction; phase = yaw away from it
      const bc = director.beltCrossing;
      const c = bc ? bc.position.clone() : new THREE.Vector3(2.7 * AU, 0, 0);
      const fwd = bc ? bc.direction.clone().normalize() : new THREE.Vector3(0, 0, -1);
      const camPos = c.clone().addScaledVector(fwd, -num('dist', 0) * 50);
      const lookDir = fwd.clone().applyAxisAngle(up, num('phase', 0) * DEG);
      lookDir.applyAxisAngle(new THREE.Vector3().crossVectors(lookDir, up).normalize(), num('el', 0) * DEG);
      const m = new THREE.Matrix4().lookAt(camPos, camPos.clone().add(lookDir), up);
      const q = new THREE.Quaternion().setFromRotationMatrix(m);
      return { camPos, camQuat: q, fov: num('fov', 50), simDays: days, exposure: num('exposure', 1), warp: 0, speedC: 0, skyGain: num('sky', 1), focus: 'asteroids', fade: 0, letterbox: 0 };
    }
    const body = bodies[id];
    center = body.object.position.clone();
    radius = body.radius;
    const tid = params.get('target');
    if (tid && body.moons) {
      const m = body.moons.find((m) => m.id === tid);
      if (m) {
        center.add(m.positionAt(days));
        radius = m.radius;
      }
    }
    const dist = num('dist', 3) * radius;
    // phase is measured from the direction toward the Sun, or toward rel=<id> if given
    const relPos = params.get('rel') ? positionOf(params.get('rel'), days) : null;
    const base = relPos ? relPos.sub(center) : center.clone().negate();
    const toRef = base.lengthSq() > 0 ? base.normalize() : new THREE.Vector3(1, 0, 0);
    const dir = toRef.clone().applyAxisAngle(up, num('phase', 30) * DEG);
    const side = new THREE.Vector3().crossVectors(dir, up).normalize();
    dir.applyAxisAngle(side, num('el', 10) * DEG).normalize();
    const camPos = center.clone().addScaledVector(dir, dist);
    // aim at the target centre, at aim=<id>, or at aimRaDec=<ra,dec> (degrees, J2000 sky coordinates)
    let lookAt = center;
    if (params.get('aim')) lookAt = positionOf(params.get('aim'), days) || center;
    if (params.get('aimRaDec')) {
      const [ra, dec] = params.get('aimRaDec').split(',').map(Number);
      lookAt = camPos.clone().add(radecToThree(ra * DEG, dec * DEG).multiplyScalar(1000));
    }
    const m = new THREE.Matrix4().lookAt(camPos, lookAt, up);
    const q = new THREE.Quaternion().setFromRotationMatrix(m);
    const look = (params.get('look') || '0,0').split(',').map(Number);
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(look[1] * DEG, -look[0] * DEG, num('roll', 0) * DEG, 'YXZ')));
    return {
      camPos,
      camQuat: q,
      fov: num('fov', 35),
      simDays: days,
      exposure: num('exposure', 1),
      warp: 0,
      speedC: 0,
      skyGain: num('sky', 1),
      focus: id,
      fade: 0,
      letterbox: 0,
    };
  }

  // ---------------------------------------------------------------- frame evaluation
  const prevCam = new THREE.Vector3();
  let havePrev = false;
  const tmp = new THREE.Vector3();
  let lastShot = null;

  function evaluate(t, dt) {
    let shot = VIEW === 'body' ? bodyViewShot() : explore?.active ? explore.shot(sunInfo.visible) : explore ? explore.applyLook(director.evaluate(t)) : director.evaluate(t);
    // (the director's shots come fitted already; body view and Explore are composed for 16:9 the same way)
    if (VIEW === 'body' || explore?.active) shot = { ...shot, fov: fitFov(shot.fov ?? 35, window.innerWidth / Math.max(1, window.innerHeight)) };
    lastShot = shot;
    const camU = shot.camPos;

    world.position.copy(camU).negate();
    camera.position.set(0, 0, 0);
    camera.quaternion.copy(shot.camQuat);
    camera.fov = shot.fov ?? 35;
    camera.aspect = window.innerWidth / window.innerHeight;

    // near plane from the closest surface (reversed float depth keeps precision; this just avoids clipping)
    let nearest = Infinity;
    for (const id in bodies) {
      const b = bodies[id];
      nearest = Math.min(nearest, tmp.copy(b.object.position).sub(camU).length() - b.radius * 1.2);
      if (b.moons)
        for (const m of b.moons) nearest = Math.min(nearest, tmp.copy(b.object.position).add(m.positionAt(shot.simDays)).sub(camU).length() - m.radius * 1.2);
    }
    if (belt.nearestDistance) nearest = Math.min(nearest, belt.nearestDistance(camU));
    camera.near = THREE.MathUtils.clamp(nearest * 0.25, 1e-5, 10);
    camera.far = 1e9;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);

    // shared uniforms
    U.uTime.value = t;
    U.uSimDays.value = shot.simDays;
    U.uSunPosW.value.copy(camU).negate();
    U.uSkyGain.value = shot.skyGain ?? 1;
    U.uWarp.value = shot.warp ?? 0;
    U.uExposure.value = shot.exposure ?? 1;
    if (havePrev && dt > 0) U.uCamVelW.value.copy(camU).sub(prevCam).divideScalar(dt);
    else U.uCamVelW.value.set(0, 0, 0);
    prevCam.copy(camU);
    havePrev = true;

    const frame = { t, dt, simDays: shot.simDays, camera, camUniverse: camU, shot, positions, bodies };
    for (const id in bodies) safe(id, () => bodies[id].update(frame));
    safe('asteroids', () => belt.update(frame));
    safe('sky', () => sky.update(frame));
    safe('glints', () => glints.update(frame));
    safe('director', () => director.update?.(frame));
    world.updateMatrixWorld(true);
    return frame;
  }

  // Sun visibility for the lens flare: analytic occlusion by every body / moon sphere.
  const sunInfo = { ndc: new THREE.Vector3(), onScreen: false, visible: 1, angularRadius: 0, distance: 0 };
  function computeSun(frame) {
    const camU = frame.camUniverse;
    const toSun = tmp.copy(camU).negate();
    const dist = toSun.length();
    const dir = toSun.clone().divideScalar(dist);
    const sunR = BODIES.sun.radius;
    sunInfo.distance = dist;
    sunInfo.angularRadius = Math.asin(Math.min(1, sunR / dist));
    // fraction of the solar disc not covered by any sphere (approximate disc-overlap)
    let visible = 1;
    const test = (center, r) => {
      const oc = center.clone().sub(camU);
      const d = oc.length();
      if (d > dist || d < r) return;
      const ang = oc.angleTo(dir);
      const rs = sunInfo.angularRadius, ro = Math.asin(Math.min(1, r / d));
      if (ang >= rs + ro) return;
      let cover;
      if (ang <= ro - rs) cover = 1;
      else if (ang <= rs - ro) cover = (ro * ro) / (rs * rs);
      else cover = THREE.MathUtils.clamp(((rs + ro - ang) / (2 * rs)) * Math.min(1, (ro * ro) / (rs * rs) * 2), 0, 1);
      visible = Math.min(visible, 1 - cover);
    };
    for (const id in bodies) {
      if (id === 'sun') continue;
      const b = bodies[id];
      test(b.object.position, b.radius);
      if (b.moons) for (const m of b.moons) test(b.object.position.clone().add(m.positionAt(frame.simDays)), m.radius);
    }
    sunInfo.visible = visible;
    sunInfo.ndc.copy(U.uSunPosW.value).project(camera);
    sunInfo.onScreen = sunInfo.ndc.z < 1 && Math.abs(sunInfo.ndc.x) < 1.6 && Math.abs(sunInfo.ndc.y) < 1.6;
    return sunInfo;
  }

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setPixelRatio(targetRatio());
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    U.uResolution.value.copy(db);
    U.uPixelRatio.value = renderer.getPixelRatio();
    post.setSize(db.x, db.y);
  }
  window.addEventListener('resize', resize);
  resize();

  let lastFrame = null;
  // CPU time per stage (ms, running mean and worst since the last read): app.prof() — for finding main-thread hitches
  const prof = { n: 0, sum: [0, 0, 0, 0], max: [0, 0, 0, 0] };
  function renderAt(t, dt) {
    const a = performance.now();
    const frame = evaluate(t, dt);
    const sun = computeSun(frame);
    const b = performance.now();
    post.render({ scene, camera, shot: frame.shot, sun, dt, t });
    const c = performance.now();
    safe('hud', () => hud?.update?.(t, frame.shot, { playing: app.playing, muted: app.muted, duration: director.duration, explore: explore?.active ? explore.id : null }));
    const d = performance.now();
    safe('score', () => score?.update?.(t, frame.shot, app.playing));
    const e = performance.now();
    lastFrame = frame;
    const v = [b - a, c - b, d - c, e - d];
    prof.n++;
    for (let i = 0; i < 4; i++) {
      prof.sum[i] += v[i];
      if (v[i] > prof.max[i]) prof.max[i] = v[i];
    }
  }
  app.prof = () => {
    const r = { frames: prof.n };
    ['evaluate', 'render', 'hud', 'score'].forEach((k, i) => (r[k] = { avg: +(prof.sum[i] / Math.max(1, prof.n)).toFixed(2), max: +prof.max[i].toFixed(1) }));
    prof.n = 0;
    prof.sum.fill(0);
    prof.max.fill(0);
    return r;
  };

  // ---------------------------------------------------------------- capture / control API
  app.director = director;
  app.renderer = renderer;
  app.scene = scene;
  app.camera = camera;
  app.bodies = bodies;
  app.seek = (t) => {
    app.t = Math.max(0, Math.min(director.duration, t));
    havePrev = false;
    app.adaptHold?.();
    score?.seek?.(app.t);
  };
  app.renderFrame = async () => {
    explore?.update(0, false);
    renderAt(app.t, 1 / 60);
    await new Promise((r) => requestAnimationFrame(() => r()));
  };
  app.play = () => {
    app.playing = true;
  };
  app.pause = () => {
    app.playing = false;
  };
  app.togglePlay = () => (app.playing ? app.pause() : app.play());
  app.setMuted = (m) => {
    app.muted = m;
    score?.setMuted?.(m);
  };
  app.start = async () => {
    // called by the HUD splash on the user's first click (audio needs a gesture)
    await score?.start?.();
    app.play();
  };
  app.gpuInfo = () => {
    const gl = renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  };
  app.failures = failures;
  app.debugState = () => {
    const s = lastShot;
    if (!s) return null;
    return {
      t: +app.t.toFixed(2),
      focus: s.focus,
      chapter: s.chapter,
      cam: s.camPos.toArray().map((v) => +(v / AU).toFixed(5)),
      fov: +(s.fov ?? 0).toFixed(1),
      warp: +(s.warp ?? 0).toFixed(2),
      ...(failures.length ? { failures } : {}),
    };
  };
  app.perfTest = async ({ t, seconds = 5 }) => {
    if (t !== null && t !== undefined) app.seek(t);
    const times = [];
    let prev = performance.now();
    const end = prev + seconds * 1000;
    app.playing = true;
    await new Promise((resolve) => {
      function step(now) {
        const dt = (now - prev) / 1000;
        prev = now;
        times.push(dt * 1000);
        app.t = Math.min(director.duration, app.t + dt);
        renderAt(app.t, dt);
        if (now < end) requestAnimationFrame(step);
        else resolve();
      }
      requestAnimationFrame(step);
    });
    app.playing = false;
    times.shift();
    const sorted = [...times].sort((a, b) => a - b);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const db = renderer.getDrawingBufferSize(new THREE.Vector2());
    return {
      frames: times.length,
      avgMs: +avg.toFixed(2),
      p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(2),
      maxMs: +sorted[sorted.length - 1].toFixed(2),
      fps: +(1000 / avg).toFixed(1),
      buffer: `${db.x}x${db.y}`,
      endT: +app.t.toFixed(2),
    };
  };

  // ---------------------------------------------------------------- shader warm-up
  // ANGLE (Chrome on Windows, D3D11) builds a program's real executable at its first draw, not at link time, and
  // the heaviest shaders here take seconds. So before the film starts, draw every object once off screen into a
  // target shaped like post's HDR target, then render a frame every few seconds of the film (post's passes, LOD
  // switches, textures). Runs behind the splash; in capture mode only with warm=1 (or app.warmup()).
  const warmRT = new THREE.WebGLRenderTarget(16, 16, {
    type: THREE.HalfFloatType,
    samples: 4,
    depthBuffer: true,
    depthTexture: new THREE.DepthTexture(16, 16, THREE.FloatType),
  });
  const owners = new Map();
  for (const id in bodies) owners.set(bodies[id].object, id);
  owners.set(belt.object, 'asteroids');
  owners.set(sky.object, 'sky');
  owners.set(glints.object, 'glints');
  if (director.object) owners.set(director.object, 'director');
  function ownerOf(o) {
    const names = [];
    for (let p = o; p; p = p.parent) {
      if (owners.has(p)) return owners.get(p) + (names.length ? ':' + names.reverse().join('/') : '');
      if (p.name) names.push(p.name);
    }
    return 'scene' + (names.length ? ':' + names.reverse().join('/') : '');
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  async function compileAllAsync(onProgress) {
    const shown = [];
    scene.traverse((o) => {
      shown.push([o, o.visible]);
      o.visible = true;
    });
    const prevTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(warmRT);
    const pending = renderer.compileAsync(scene, camera);
    renderer.setRenderTarget(prevTarget);
    for (const [o, v] of shown) o.visible = v;
    let settled = false;
    pending.then(() => (settled = true));
    while (!settled) {
      const progs = renderer.info.programs;
      onProgress?.(0.7 * (progs.filter((p) => p.isReady()).length / Math.max(1, progs.length)));
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  // serial: skip the parallel phase so each object's own compile cost shows up in the report
  async function warmup({ onProgress, report = false, serial = false } = {}) {
    const gl = renderer.getContext();
    const objs = [];
    scene.traverse((o) => {
      if (o.material && (o.isMesh || o.isPoints || o.isLine || o.isSprite)) objs.push(o);
    });
    const times = [], films = [];
    // 1. create every program with the HDR target bound (three keys programs on the target's colour space, so a
    //    compile against the canvas would build the wrong variants) and let KHR_parallel_shader_compile build
    //    them on the driver's worker threads while the page stays responsive.
    const a0 = performance.now();
    const nProg0 = renderer.info.programs.length;
    if (!serial) await compileAllAsync(onProgress);
    const compileMs = performance.now() - a0;

    const step = 4;
    const filmTimes = [];
    for (let t = 0; t < director.duration; t += step) filmTimes.push(t);
    filmTimes.push(director.duration);
    const total = objs.length + filmTimes.length;
    const prevTarget = renderer.getRenderTarget();
    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      const saved = [];
      for (let p = o; p; p = p.parent) {
        saved.push([p, p.visible]);
        p.visible = true;
      }
      const kids = [];
      for (const c of o.children) {
        kids.push([c, c.visible]);
        c.visible = false;
      }
      const culled = o.frustumCulled;
      o.frustumCulled = false;
      const a = performance.now();
      renderer.setRenderTarget(warmRT);
      try {
        renderer.render(o, camera);
        if (report) gl.finish();
      } catch (e) {
        console.warn('[app] warm-up draw failed for', ownerOf(o), e);
      }
      const ms = performance.now() - a;
      o.frustumCulled = culled;
      for (const [c, v] of kids) c.visible = v;
      for (const [p, v] of saved) p.visible = v;
      if (report) times.push({ ms: Math.round(ms), owner: ownerOf(o), type: o.type, name: o.name || '' });
      onProgress?.(0.7 + 0.3 * ((i + 1) / total));
      if (!report && ms > 30) await nextFrame();
    }
    renderer.setRenderTarget(prevTarget);
    for (let i = 0; i < filmTimes.length; i++) {
      const a = performance.now();
      const frame = evaluate(filmTimes[i], 0);
      safe('post', () => post.render({ scene, camera, shot: frame.shot, sun: computeSun(frame), dt: 0, t: filmTimes[i] }));
      if (report) gl.finish();
      const ms = performance.now() - a;
      if (report) films.push({ t: filmTimes[i], ms: Math.round(ms) });
      onProgress?.(0.7 + 0.3 * ((objs.length + i + 1) / total));
      if (!report && ms > 30) await nextFrame();
    }
    havePrev = false;
    return { compileMs: Math.round(compileMs), programs: [nProg0, renderer.info.programs.length], objects: times, frames: films };
  }
  app.warmup = warmup;
  if (!CAPTURE || params.get('warm') === '1') {
    const a = performance.now();
    // asset loading drove the bar to ~100%; the warm-up restarts it as its own phase
    await warmup({ onProgress: (p) => hud?.setWarmup?.(p) });
    log(`warm-up ${Math.round(performance.now() - a)} ms`);
  }
  await hud?.attach?.({ director, bodies });
  offProgress();

  renderAt(app.t, 0);
  app.isReady = true;
  log(`ready: ${JOURNEY_ORDER.length} bodies, epoch ${epochDate.toISOString()}, duration ${director.duration.toFixed(1)} s`);

  if (CAPTURE) return; // frames are driven by tools/shot.mjs

  // ---------------------------------------------------------------- adaptive resolution
  // Frame times are watched in ~0.8 s windows while the film plays. Two marginal windows in a row, or one clearly overloaded one, step the
  // megapixel budget down (two steps when frames take twice the budget); after several seconds of clean vsync it
  // probes one step up, and a probe that fails lowers the ceiling for a while (longer each time) so playback does
  // not oscillate. Re-allocating the HDR chain costs a frame or two, so the steps are coarse (x1.4 in pixels),
  // changes are rare, and none happens while the film is still or just after a seek (cold frames are not load).
  const adapt = { times: [], settle: 0, good: 0, bad: 0, failAt: -1, failCount: 0, lastUp: -1e9 };
  function setLevel(l, now) {
    l = Math.max(0, Math.min(res.ceiling, l));
    // levels above what the display can show are the same buffer: clamp to the first one that reaches the cap
    while (l > 0 && ratioFor(MP_LEVELS[l - 1]) >= DPR_CAP) l--;
    if (l === res.level) return false;
    res.level = l;
    resize();
    adapt.times.length = 0;
    adapt.settle = now + 700;
    adapt.good = adapt.bad = 0;
    return true;
  }
  app.adaptHold = (ms = 900) => {
    adapt.times.length = 0;
    adapt.bad = 0;
    adapt.settle = Math.max(adapt.settle, performance.now() + ms);
  };
  function adaptStep(now, dtMs) {
    // a new chapter is a new load (Mercury's raymarched ground costs ten times Saturn's eclipse per pixel): what
    // failed in the last one says nothing here, so the ceiling lifts and the probes start again
    const ci = lastShot ? lastShot.chapterIndex : -1;
    if (ci !== adapt.chapter) {
      adapt.chapter = ci;
      res.ceiling = MP_LEVELS.length - 1;
      adapt.failAt = -1;
      adapt.failCount = 0;
    }
    if (resPinned !== null || !app.playing || document.hidden || now < adapt.settle) return;
    if (dtMs > 400) return app.adaptHold(600); // the tab was away, or a one-off stall: not a measurement
    adapt.times.push(dtMs);
    const span = adapt.times.reduce((a, b) => a + b, 0);
    if (span < 800) return;
    // judged on the 86th percentile (dropped frames come in ones and twos between good ones, so a median hides
    // them) with the single worst frame set aside (a GC pause is not a GPU limit)
    const sorted = adapt.times.slice().sort((a, b) => a - b);
    sorted.pop();
    const med = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.86))];
    const best = sorted[sorted.length >> 2];
    adapt.times.length = 0;
    if (med > 20.5) {
      adapt.good = 0;
      // a probe that failed: step straight back, remember it and wait longer before the next one
      const failedProbe = now - adapt.lastUp < 7000;
      if (failedProbe) {
        res.ceiling = Math.max(0, res.level - 1);
        adapt.failAt = now;
        adapt.failCount++;
      } else if (++adapt.bad < 2 && med < 27) return; // a marginal window gets a second opinion; a clear overload does not
      setLevel(res.level - (med > 36 && !failedProbe ? 2 : 1), now);
      return;
    }
    adapt.bad = 0;
    if (adapt.failAt >= 0 && now - adapt.failAt > 60000 * Math.min(8, 2 ** (adapt.failCount - 1))) {
      res.ceiling = MP_LEVELS.length - 1;
      adapt.failAt = -1;
    }
    adapt.good = med < 17.6 ? adapt.good + 1 : 0;
    // ~6 s of clean frames (sooner when a 120 Hz display shows real headroom)
    if (adapt.good >= (best < 11 && med < 11 ? 4 : 8) && res.level < res.ceiling && ratioFor(MP_LEVELS[res.level]) < DPR_CAP) {
      if (setLevel(res.level + 1, now)) adapt.lastUp = now;
    }
  }
  app.resolution = () => ({ mp: resPinned ?? MP_LEVELS[res.level], level: res.level, ceiling: res.ceiling, ratio: renderer.getPixelRatio() });

  let prev = performance.now();
  function loop(now) {
    const rawDt = now - prev;
    const dt = Math.min(0.1, rawDt / 1000);
    prev = now;
    adaptStep(now, rawDt);
    explore?.update(dt, app.playing);
    if (explore?.active) {
      // off the timeline: the film clock waits, the explore clock (inside the module) runs
      renderAt(app.t, app.playing ? dt : 0);
      requestAnimationFrame(loop);
      return;
    }
    if (app.playing) {
      app.t += dt;
      if (app.t >= director.duration) {
        app.t = director.duration;
        app.playing = false;
      }
    }
    renderAt(app.t, app.playing ? dt : 0);
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}

boot().catch((e) => {
  console.error(e);
  app.failed = String(e && e.stack ? e.stack : e);
  // a visitor without WebGL 2 (or with the GPU blocked) gets a plain explanation, not a stack trace
  const noGL = /WebGL|context/i.test(app.failed);
  const bootEl = document.getElementById('boot');
  if (bootEl && !CAPTURE) {
    bootEl.classList.remove('gone');
    bootEl.querySelector('i')?.remove();
    const p = document.createElement('p');
    p.textContent = noGL
      ? 'This film is rendered live on your graphics card and needs WebGL 2, which this browser or device is not offering. Try a recent Chrome, Edge, Firefox or Safari on a computer with hardware acceleration turned on.'
      : 'Something went wrong while starting the film. Reloading the page usually fixes it.';
    bootEl.appendChild(p);
    return;
  }
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;color:#f88;background:#000;font:12px monospace;white-space:pre-wrap;z-index:99';
  el.textContent = 'Failed to start:\n' + app.failed;
  document.body.appendChild(el);
});

export { TIME_SCALE };
