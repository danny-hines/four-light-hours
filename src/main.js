// Entry point: renderer, floating-origin world, module wiring, main loop and the capture API (window.__app).
//
// URL parameters
//   capture=1           deterministic mode for tools/shot.mjs: no splash, no audio, paused, frames rendered on demand
//   hud=0|1             show the HUD overlay (default 1)
//   t=<s>               start at journey time t
//   epoch=<ISO date>    date the planets are positioned for (default: now; capture default 2026-11-02T12:00:00Z)
//   q=low|med|high      quality preset (render scale)
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
import * as assets from './core/assets.js';

import { placeholderBody } from './fallback/body.js';

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
  const renderScale = { low: 0.6, med: 0.8, high: 1.0 }[QUALITY] ?? 1.0;
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2) * renderScale;
  renderer.setPixelRatio(pixelRatio);
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

  const post = await createModule('post', ctx);
  const score = CAPTURE ? null : await createModule('score', ctx);

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
    const shot = VIEW === 'body' ? bodyViewShot() : director.evaluate(t);
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
  function renderAt(t, dt) {
    const frame = evaluate(t, dt);
    const sun = computeSun(frame);
    post.render({ scene, camera, shot: frame.shot, sun, dt, t });
    safe('hud', () => hud?.update?.(t, frame.shot, { playing: app.playing, muted: app.muted, duration: director.duration }));
    safe('score', () => score?.update?.(t, frame.shot, app.playing));
    lastFrame = frame;
  }

  // ---------------------------------------------------------------- capture / control API
  app.director = director;
  app.renderer = renderer;
  app.scene = scene;
  app.camera = camera;
  app.bodies = bodies;
  app.seek = (t) => {
    app.t = Math.max(0, Math.min(director.duration, t));
    havePrev = false;
    score?.seek?.(app.t);
  };
  app.renderFrame = async () => {
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

  let prev = performance.now();
  function loop(now) {
    const dt = Math.min(0.1, (now - prev) / 1000);
    prev = now;
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
  const el = document.createElement('pre');
  el.style.cssText = 'position:fixed;inset:0;margin:0;padding:24px;color:#f88;background:#000;font:12px monospace;white-space:pre-wrap;z-index:99';
  el.textContent = 'Failed to start:\n' + app.failed;
  document.body.appendChild(el);
});

export { TIME_SCALE };
