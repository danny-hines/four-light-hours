// Live camera: look-around during the film, and Explore mode (free orbit of any world).
//
// The film is rendered in real time, so the viewer may take the camera:
//   - during the film, dragging on the picture turns the view away from the director's framing; released, it
//     eases back (while paused it stays where it was left, so a paused frame can be looked around at leisure);
//   - Explore mode leaves the timeline: the camera orbits one world (drag to orbit, wheel / pinch to zoom), the
//     simulated clock keeps running, and a bar along the bottom jumps between worlds.
//
// main.js owns the state machine (app.explore*) and asks this module for the camera each frame:
//   explore.active                    -> bool
//   explore.applyLook(shot)           -> film shot with the look-around offset applied
//   explore.shot(sunVisible)          -> a complete shot for the orbit camera
//   explore.update(dt, playing)       -> integrate smoothing, clock, fades (call once per frame)
// URL (capture / testing): explore=<id>&xd=<radii>&xaz=<deg>&xel=<deg> starts in Explore mode at that view.
import { ICONS } from './icons.js';
import { KICKER, SUBTITLE } from './copy.js';
import { DEG, KM_PER_UNIT, C_KM_S, TIME_SCALE } from '../core/astro.js';

// worlds offered in the bar: every planet, and the moons the film itself visits (the ones built to be looked at)
const WORLDS = [
  { id: 'sun' },
  { id: 'mercury' },
  { id: 'venus' },
  { id: 'earth' },
  { id: 'moon', parent: 'earth' },
  { id: 'mars' },
  { id: 'jupiter' },
  { id: 'io', parent: 'jupiter' },
  { id: 'europa', parent: 'jupiter' },
  { id: 'ganymede', parent: 'jupiter' },
  { id: 'callisto', parent: 'jupiter' },
  { id: 'saturn' },
  { id: 'titan', parent: 'saturn' },
  { id: 'uranus' },
  { id: 'neptune' },
  { id: 'triton', parent: 'neptune' },
];
const EXTRA_SUB = {
  io: 'The most volcanic world known, kneaded without rest by Jupiter’s tides.',
  europa: 'A shell of cracked ice over a hidden ocean of salt water.',
  ganymede: 'The largest moon there is — bigger than the planet Mercury.',
  callisto: 'An ancient, battered face, almost unchanged in four billion years.',
};
// closest approach (altitude in radii) and the opening view per world
const VIEW = {
  sun: { hMin: 0.12, hMax: 40, h0: 2.6, az: 25, el: 8 },
  mercury: { hMin: 0.08 },
  venus: { hMin: 0.3 },
  earth: { hMin: 0.07, h0: 2.4, az: 28, el: 14 },
  moon: { hMin: 0.1 },
  mars: { hMin: 0.25, az: 30, el: 18 },
  jupiter: { hMin: 0.1, h0: 2.9, az: 32, el: 6 },
  // the textured moons hold up as discs, not as landscapes: the camera stays where their maps still resolve
  io: { hMin: 0.6 },
  europa: { hMin: 0.6 },
  ganymede: { hMin: 0.5 },
  callisto: { hMin: 0.3 },
  saturn: { hMin: 0.2, hMax: 120, h0: 5.2, az: 38, el: 16 },
  titan: { hMin: 0.55 },
  uranus: { hMin: 0.3, h0: 3.4, az: 30, el: 10 },
  neptune: { hMin: 0.25 },
  triton: { hMin: 0.5 },
  default: { hMin: 0.3, hMax: 150, h0: 2.6, az: 35, el: 10 },
};

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function createExplore(ctx) {
  const { THREE, app, BODIES, capture, director } = ctx;
  const params = new URLSearchParams(location.search);
  const moonParent = {};
  for (const id in BODIES) for (const mid in BODIES[id].moons || {}) moonParent[mid] = id;
  const dataOf = (id) => BODIES[id] || (moonParent[id] && BODIES[moonParent[id]].moons[id]) || null;
  const worlds = WORLDS.filter((w) => dataOf(w.id) && (!w.parent || ctx.bodies[w.parent]?.moons?.some((m) => m.id === w.id)));
  const known = (id) => worlds.some((w) => w.id === id);
  const viewOf = (id) => ({ ...VIEW.default, ...(VIEW[id] || {}) });

  const _c = new THREE.Vector3(), _s = new THREE.Vector3(), _d = new THREE.Vector3(), _r = new THREE.Vector3(), _u = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler();

  function centre(id, days, out) {
    if (id === 'sun') return out.set(0, 0, 0);
    if (ctx.positions[id]) return out.copy(ctx.positions[id]);
    const p = moonParent[id];
    const m = ctx.bodies[p].moons.find((x) => x.id === id);
    return out.copy(ctx.positions[p]).add(m.positionAt(days));
  }

  // ------------------------------------------------------------------------------------------ state
  const S = {
    active: false,
    id: 'earth',
    days: 0,
    // orbit camera: azimuth from the sunward direction about ecliptic north, elevation, altitude in radii (log-smoothed)
    az: 0, el: 0, h: 2, azT: 0, elT: 0, hT: 2,
    ev: 0,
    fade: 0, // 0..1 dip to black around a jump
    pending: null, // { id, then } while fading out
    idle: 0, // seconds since the last input (the camera drifts on its own after a while)
    resume: null, // { t, playing } to return to the film
    used: false, // the viewer has moved the camera at least once (hint goes away)
  };
  // film look-around
  const L = { yaw: 0, pitch: 0, yawT: 0, pitchT: 0, held: false, moved: 0 };

  // ------------------------------------------------------------------------------------------ camera
  function orbitDir(id, days, az, el, out) {
    centre(id, days, _c);
    // sunward direction flattened onto the ecliptic (for the Sun itself: +x)
    _s.copy(_c).negate();
    _s.y = 0;
    if (_s.lengthSq() < 1e-9) _s.set(1, 0, 0);
    _s.normalize();
    out.copy(_s).applyAxisAngle(UP, az * DEG);
    _r.crossVectors(out, UP).normalize();
    return out.applyAxisAngle(_r, el * DEG).normalize();
  }

  let sunVisSm = 1;
  function shot(sunVisible = 1) {
    const id = S.id, R = dataOf(id).radius, days = S.days;
    const dir = orbitDir(id, days, S.az, S.el, new THREE.Vector3());
    const C = centre(id, days, new THREE.Vector3());
    const dist = R * (1 + S.h);
    const camPos = C.clone().addScaledVector(dir, dist);
    const fov = 42;
    // aim: the centre from afar; close in, the view lifts until the limb and the sky above it share the frame
    const limb = Math.asin(Math.min(1, 1 / (1 + S.h)));
    const lift = smooth(1.6, 0.25, S.h) * Math.max(0, limb - fov * DEG * 0.2);
    _m.lookAt(camPos, C, UP);
    const camQuat = new THREE.Quaternion().setFromRotationMatrix(_m);
    // on a wide screen the world sits a little right of centre, clear of its own name (not in close passes)
    const asp = window.innerWidth / Math.max(1, window.innerHeight);
    const side = asp > 1.25 ? Math.atan(0.13 * Math.tan((fov * DEG) / 2) * asp) * smooth(0.3, 1.6, S.h) : 0;
    if (lift > 0 || side > 0) camQuat.multiply(_q.setFromEuler(_e.set(lift, side, 0, 'YXZ')));

    // exposure: the film's own levels, chosen from where the camera is instead of from the timeline
    sunVisSm += (sunVisible - sunVisSm) * 0.08;
    let ev;
    if (id === 'sun') ev = -12.3 + 0.6 * smooth(0.15, 1.2, S.h) + 2.7 * smooth(1.6, 5.5, S.h);
    else {
      _d.copy(camPos).sub(C).normalize();
      const phase = Math.acos(clamp(_d.dot(_s.copy(C).negate().normalize()), -1, 1)) / DEG;
      ev = 1.2 * smooth(112, 160, phase) + 2.0 * (1 - sunVisSm) * smooth(95, 140, phase);
      if (id === 'moon') ev += 0.35;
    }
    S.ev += (ev - S.ev) * 0.06;
    const sunDist = camPos.length();
    const ch = chapterFor(id);
    return {
      camPos,
      camQuat,
      fov,
      simDays: days,
      exposure: Math.pow(2, S.ev),
      angVel: 0,
      rollRate: 0,
      warp: 0,
      speedC: 0,
      speedKmS: 0,
      skyGain: id === 'sun' ? 0.45 : 0.6 / Math.pow(2, Math.max(0, S.ev) * 0.55),
      focus: id,
      focusDistance: Math.max(1e-4, dist - R),
      chapter: ch.id,
      chapterIndex: ch.index,
      fade: S.fade,
      letterbox: 0,
      captions: [],
      labels: null,
      lightTimeS: (sunDist * KM_PER_UNIT) / C_KM_S,
      sunDistanceKm: sunDist * KM_PER_UNIT,
      orbits: 0,
      flare: 1,
      glintGain: 1,
      glintFloor: 0,
      glintNorm: null,
      beltRing: 0,
      explore: true,
      audio: { chapter: ch.id, chapterIndex: ch.index, warp: 0, arrival: 0, departure: 0, explore: id },
    };
  }
  function chapterFor(id) {
    const chs = director.chapters || [];
    const want = [id, moonParent[id]];
    for (const w of want) {
      if (!w) continue;
      const i = chs.findIndex((c) => c.id === w || c.body === w);
      if (i >= 0) return { id: chs[i].id, index: i };
    }
    return { id: chs[0]?.id || 'intro', index: 0 };
  }

  function applyLook(shot) {
    if (Math.abs(L.yaw) < 1e-4 && Math.abs(L.pitch) < 1e-4) return shot;
    // narrow fields turn less per drag: the offset is in units of the current field of view
    const k = (shot.fov ?? 35) / 40;
    const q = shot.camQuat.clone().multiply(_q.setFromEuler(_e.set(L.pitch * k * DEG, L.yaw * k * DEG, 0, 'YXZ')));
    return { ...shot, camQuat: q, looking: Math.min(1, Math.hypot(L.yaw, L.pitch) / 4) };
  }

  // ------------------------------------------------------------------------------------------ per frame
  function update(dt, playing) {
    const k = 1 - Math.exp(-dt * 9);
    if (S.active) {
      if (playing) S.days += (dt * TIME_SCALE) / 86400;
      S.idle += dt;
      // after a few idle seconds the camera drifts slowly round the world on its own
      if (S.idle > 5 && !drag.on) S.azT += dt * 1.6 * smooth(5, 9, S.idle);
      S.az += (S.azT - S.az) * k;
      S.el += (S.elT - S.el) * k;
      S.h = Math.exp(Math.log(S.h) + (Math.log(S.hT) - Math.log(S.h)) * (1 - Math.exp(-dt * 6)));
    }
    // jumps between worlds (and in / out of the film) pass through black
    if (S.pending) {
      S.fade = Math.min(1, S.fade + dt / 0.38);
      if (S.fade >= 1) {
        const p = S.pending;
        S.pending = null;
        p.then();
      }
    } else if (S.fade > 0) S.fade = Math.max(0, S.fade - dt / 0.7);
    // film look-around: follows the pointer, and springs home when let go (unless the film is paused)
    if (!S.active) {
      if (!L.held && playing) {
        L.yawT *= Math.exp(-dt * 1.6);
        L.pitchT *= Math.exp(-dt * 1.6);
      }
      L.yaw += (L.yawT - L.yaw) * k;
      L.pitch += (L.pitchT - L.pitch) * k;
    }
    syncUI();
  }

  // ------------------------------------------------------------------------------------------ transitions
  function place(id, opts = {}) {
    const v = viewOf(id);
    S.id = id;
    S.az = S.azT = opts.az ?? v.az;
    S.el = S.elT = opts.el ?? v.el;
    S.h = S.hT = clamp(opts.h ?? v.h0, v.hMin, v.hMax);
    S.idle = 0;
    S.ev = id === 'sun' ? -9.6 : 0;
    sunVisSm = 1;
    app.onExplore?.(id);
  }
  function nearestWorld(focus) {
    if (known(focus)) return focus;
    if (moonParent[focus] && known(moonParent[focus])) return moonParent[focus];
    return 'earth';
  }
  function enter(id, opts = {}) {
    if (S.active || S.pending) return;
    const film = director.evaluate(app.t);
    const target = nearestWorld(id || film.focus);
    S.pending = {
      then: () => {
        S.resume = { t: app.t, playing: app.playing };
        S.days = film.simDays;
        S.active = true;
        L.yaw = L.pitch = L.yawT = L.pitchT = 0;
        place(target, opts);
        app.playing = true; // the simulated clock runs while exploring (Space pauses it)
      },
    };
    if (opts.instant) {
      S.pending.then();
      S.pending = null;
    }
  }
  function exit() {
    if (!S.active || S.pending) return;
    S.pending = {
      then: () => {
        S.active = false;
        app.onExplore?.(null);
        const r = S.resume || { t: 0, playing: true };
        const ended = r.t >= director.duration - 0.05;
        app.seek(ended ? 0 : r.t);
        app.playing = true;
      },
    };
  }
  function select(id) {
    if (!S.active || S.pending || id === S.id || !known(id)) return;
    S.pending = { then: () => place(id) };
  }

  // ------------------------------------------------------------------------------------------ input
  const drag = { on: false, id: -1, x: 0, y: 0, pts: new Map(), pinch: 0 };
  const onPicture = (e) => {
    const t = e.target;
    if (!t || !t.closest) return false;
    if (t.closest('button, a, input, .flh-ctl, .flh-x, #flh-splash')) return false;
    return true;
  };
  function pointerDown(e) {
    if (!onPicture(e) || (e.pointerType === 'mouse' && e.button !== 0)) return;
    drag.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.pts.size === 2) {
      const [a, b] = [...drag.pts.values()];
      drag.pinch = Math.hypot(a.x - b.x, a.y - b.y);
    }
    drag.on = true;
    drag.id = e.pointerId;
    drag.x = e.clientX;
    drag.y = e.clientY;
    L.held = true;
    L.moved = 0;
  }
  function pointerMove(e) {
    if (!drag.on || !drag.pts.has(e.pointerId)) return;
    const p = drag.pts.get(e.pointerId);
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (drag.pts.size === 2) {
      const [a, b] = [...drag.pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (S.active && drag.pinch > 0 && d > 0) zoom(Math.log(drag.pinch / d));
      drag.pinch = d;
      L.moved += 10;
      return;
    }
    L.moved += Math.abs(dx) + Math.abs(dy);
    if (L.moved < 4) return;
    const H = Math.max(320, window.innerHeight);
    if (S.active) {
      // a drag across the frame turns the world through about its own apparent size
      const kk = (110 / H) * clamp(S.h / 1.2, 0.12, 1);
      S.azT -= dx * kk;
      S.elT = clamp(S.elT + dy * kk, -86, 86);
      S.idle = 0;
      S.used = true;
    } else if (!capture) {
      const kk = 46 / H;
      L.yawT = clamp(L.yawT + dx * kk, -70, 70);
      L.pitchT = clamp(L.pitchT + dy * kk, -45, 45);
      S.used = true;
    }
  }
  function pointerUp(e) {
    drag.pts.delete(e.pointerId);
    if (drag.pts.size === 0) {
      drag.on = false;
      L.held = false;
      // a drag is not a click: controls.js checks this before toggling play / pause
      if (L.moved >= 4) app.lookDragAt = performance.now();
    }
  }
  function zoom(dLog) {
    const v = viewOf(S.id);
    S.hT = clamp(S.hT * Math.exp(dLog), v.hMin, v.hMax);
    S.idle = 0;
    S.used = true;
  }
  function wheel(e) {
    if (!S.active || !onPicture(e)) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1;
    zoom(clamp(e.deltaY * unit, -240, 240) * 0.0022);
  }
  function key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (document.getElementById('flh-splash') && !document.getElementById('flh-splash').classList.contains('gone')) return;
    const k = e.key;
    if (!S.active) {
      if (k === 'e' || k === 'E') {
        enter();
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      return;
    }
    let handled = true;
    const i = worlds.findIndex((w) => w.id === S.id);
    if (k === 'Escape' || k === 'e' || k === 'E') exit();
    else if (k === 'ArrowRight') select(worlds[(i + 1) % worlds.length].id);
    else if (k === 'ArrowLeft') select(worlds[(i + worlds.length - 1) % worlds.length].id);
    else if (k === 'ArrowUp' || k === '+' || k === '=') zoom(-0.35);
    else if (k === 'ArrowDown' || k === '-' || k === '_') zoom(0.35);
    else if (k === 'Home' || k === 'End') handled = true; // no timeline to jump along
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }
  if (!capture) {
    window.addEventListener('pointerdown', pointerDown);
    window.addEventListener('pointermove', pointerMove);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    window.addEventListener('wheel', wheel, { passive: false });
    window.addEventListener('keydown', key, true);
  }

  // ------------------------------------------------------------------------------------------ UI
  const root = document.getElementById('flh-hud');
  let ui = null;
  if (root) {
    const st = document.createElement('style');
    st.textContent = css();
    document.head.appendChild(st);
    const el = document.createElement('div');
    el.className = 'flh-x';
    el.innerHTML = `
      <div class="x-head">
        <div class="x-kick"><span class="x-mode">Explore</span><i></i><span class="x-kind"></span></div>
        <h2 class="x-title"></h2>
        <p class="x-sub"></p>
      </div>
      <div class="x-hint"></div>
      <div class="x-bar" role="toolbar" aria-label="Worlds">
        <div class="x-worlds"></div>
        <button class="x-back" type="button">${ICONS.play}<span>Back to the film</span></button>
      </div>`;
    root.appendChild(el);
    // one quiet line, once, early in the film: the picture is live and can be turned
    const tip = document.createElement('div');
    tip.className = 'flh-xtip';
    tip.textContent = window.matchMedia && matchMedia('(pointer: coarse)').matches ? 'This is rendered live · Drag to look around' : 'This is rendered live · Drag to look around · E to explore';
    root.appendChild(tip);
    const list = el.querySelector('.x-worlds');
    const btns = {};
    for (const w of worlds) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'x-w' + (w.parent ? ' moon' : '');
      b.textContent = dataOf(w.id).name.replace(/^The /, '');
      b.addEventListener('click', () => select(w.id));
      list.appendChild(b);
      btns[w.id] = b;
    }
    el.querySelector('.x-back').addEventListener('click', exit);
    ui = { el, btns, tip, tipOn: false, tipDone: false, kind: el.querySelector('.x-kind'), title: el.querySelector('.x-title'), sub: el.querySelector('.x-sub'), hint: el.querySelector('.x-hint'), back: el.querySelector('.x-back span'), shownId: null, on: null, hintOn: null };
    const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
    ui.hint.textContent = touch ? 'Drag to orbit · Pinch to zoom' : 'Drag to orbit · Scroll to zoom · ← → next world · Esc back to the film';
  }
  function syncUI() {
    if (!root) return;
    const on = S.active;
    if (!ui.tipDone && !capture) {
      const want = !on && !S.used && app.playing && app.t > 17 && app.t < 24.5;
      if (want !== ui.tipOn) ui.tip.classList.toggle('on', (ui.tipOn = want));
      if (app.t >= 24.5 || S.used || on) {
        ui.tipDone = true;
        ui.tip.classList.remove('on');
      }
    }
    if (on !== ui.on) {
      ui.on = on;
      root.classList.toggle('flh-exploring', on);
      ui.el.classList.toggle('on', on);
      if (on) ui.back.textContent = S.resume && S.resume.t >= director.duration - 0.05 ? 'Watch the film again' : 'Back to the film';
    }
    if (!on) return;
    // text swaps while the picture is black
    if (ui.shownId !== S.id) {
      ui.shownId = S.id;
      const d = dataOf(S.id);
      ui.kind.textContent = KICKER[S.id] || '';
      ui.title.textContent = d.name;
      ui.sub.textContent = SUBTITLE[S.id] || EXTRA_SUB[S.id] || '';
      for (const id in ui.btns) ui.btns[id].classList.toggle('cur', id === S.id);
      ui.btns[S.id]?.scrollIntoView?.({ block: 'nearest', inline: 'center', behavior: 'smooth' });
    }
    const a = (1 - S.fade).toFixed(3);
    if (a !== ui.a) ui.el.querySelector('.x-head').style.opacity = ui.a = a;
    const hintOn = !S.used || S.idle < 0;
    if (hintOn !== ui.hintOn) ui.hint.classList.toggle('on', (ui.hintOn = hintOn));
  }

  // capture / deep link: explore=<id>
  if (params.get('explore')) {
    const num = (k) => (params.has(k) ? Number(params.get(k)) : undefined);
    const id = params.get('explore');
    const film = director.evaluate(app.t);
    S.days = film.simDays + (num('days') || 0);
    S.resume = { t: app.t, playing: false };
    S.active = true;
    place(nearestWorld(id), { az: num('xaz'), el: num('xel'), h: num('xd') !== undefined ? num('xd') - 1 : undefined });
    // capture frames are single: no smoothing history to converge
    if (capture) {
      const s0 = shot(1);
      S.ev = Math.log2(s0.exposure);
    }
  }

  return {
    get active() {
      return S.active;
    },
    get id() {
      return S.id;
    },
    worlds,
    enter,
    exit,
    select,
    update,
    shot,
    applyLook,
    state: S,
  };
}

function css() {
  const u = (n) => `calc(${n} * var(--u))`;
  return /* css */ `
#flh-hud.flh-exploring .flh-open, #flh-hud.flh-exploring .flh-card, #flh-hud.flh-exploring .flh-caption, #flh-hud.flh-exploring .flh-end,
#flh-hud.flh-exploring .flh-chap, #flh-hud.flh-exploring .flh-ctl, #flh-hud.flh-exploring .flh-labels, #flh-hud.flh-exploring .flh-scrim-bl,
#flh-hud.flh-exploring .flh-scrim-c, #flh-hud.flh-exploring .flh-bands { display: none !important; }
#flh-hud .flh-x { position: absolute; inset: 0; pointer-events: none; opacity: 0; visibility: hidden; transition: opacity .6s ease, visibility 0s linear .6s; }
#flh-hud .flh-x.on { opacity: 1; visibility: visible; transition: opacity .6s ease .25s; }
#flh-hud.flh-clean .flh-x .x-head, #flh-hud.flh-clean .flh-x .x-hint { opacity: 0 !important; }
#flh-hud .flh-x .x-head { position: absolute; left: var(--mx); top: calc(var(--mt) + ${u(8)}); max-width: min(34em, calc(100vw - 2 * var(--mx)));
  text-shadow: 0 0 1px rgba(0,0,0,.5), 0 1px ${u(3)} rgba(0,0,0,.45), 0 0 ${u(22)} rgba(0,0,0,.5); }
#flh-hud .flh-x .x-head::before { content: ''; position: absolute; z-index: -1; left: calc(-1 * var(--mx)); top: calc(-1 * var(--mt) - ${u(8)}); width: calc(100% + 2.2 * var(--mx)); height: calc(100% + var(--mt) + ${u(90)});
  background: radial-gradient(ellipse 100% 100% at 0% 0%, rgba(0,0,0,.6) 0%, rgba(0,0,0,.48) 45%, rgba(0,0,0,.22) 72%, rgba(0,0,0,0) 100%); pointer-events: none; }
#flh-hud .flh-x .x-kick { display: flex; align-items: center; gap: ${u(12)}; font: 400 ${u(10)}/1 var(--sans); letter-spacing: .34em; text-transform: uppercase; color: rgba(255,255,255,.72); }
#flh-hud .flh-x .x-kick i { width: ${u(26)}; height: var(--hl); background: rgba(255,255,255,.5); }
#flh-hud .flh-x .x-kick .x-mode { color: #fff; }
#flh-hud .flh-x .x-title { margin: ${u(20)} 0 0 -.03em; font: 200 clamp(26px, 3.6vw, ${u(58)})/1.05 var(--sans); letter-spacing: .34em; text-transform: uppercase; font-variation-settings: 'wght' 200; white-space: nowrap; }
#flh-hud .flh-x .x-sub { margin: ${u(16)} 0 0; max-width: 22em; font: italic 500 clamp(15px, 1.35vw, ${u(22)})/1.4 var(--serif); color: rgba(255,255,255,.88); text-wrap: balance; }
#flh-hud .flh-x .x-hint { position: absolute; left: 0; right: 0; bottom: ${u(112)}; text-align: center; font: 400 ${u(9.5)}/1.6 var(--sans); letter-spacing: .3em; text-transform: uppercase;
  color: rgba(255,255,255,.7); text-shadow: var(--ts); opacity: 0; transition: opacity 1.2s ease; padding: 0 var(--mx); }
#flh-hud .flh-x .x-hint.on { opacity: 1; }
#flh-hud .flh-x .x-bar { position: absolute; left: 0; right: 0; bottom: 0; padding: ${u(34)} var(--mx) ${u(30)}; display: flex; align-items: center; gap: ${u(28)}; pointer-events: auto;
  background: linear-gradient(0deg, rgba(0,0,0,.62) 0%, rgba(0,0,0,.3) 55%, rgba(0,0,0,0) 100%); }
#flh-hud .flh-x .x-worlds { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: ${u(4)}; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch;
  mask-image: linear-gradient(90deg, transparent 0, #000 ${u(18)}, #000 calc(100% - ${u(18)}), transparent 100%); padding: 0 ${u(12)}; margin-left: ${u(-12)}; }
#flh-hud .flh-x .x-worlds::-webkit-scrollbar { display: none; }
#flh-hud .flh-x button { appearance: none; -webkit-appearance: none; border: 0; background: none; color: inherit; cursor: pointer; margin: 0; }
#flh-hud .flh-x .x-w { position: relative; flex: none; padding: ${u(12)} ${u(11)} ${u(13)}; font: 400 ${u(10.5)}/1 var(--sans); letter-spacing: .28em; margin-right: -.1em; text-transform: uppercase;
  color: rgba(255,255,255,.6); white-space: nowrap; transition: color .25s ease; }
#flh-hud .flh-x .x-w.moon { font-size: ${u(8.5)}; color: rgba(255,255,255,.44); padding-left: ${u(7)}; padding-right: ${u(7)}; }
#flh-hud .flh-x .x-w:hover { color: #fff; }
#flh-hud .flh-x .x-w.cur { color: #fff; }
#flh-hud .flh-x .x-w::after { content: ''; position: absolute; left: ${u(11)}; right: calc(${u(11)} + .28em); bottom: ${u(4)}; height: var(--hl); background: #fff; transform: scaleX(0); transition: transform .35s ease; }
#flh-hud .flh-x .x-w.moon::after { left: ${u(7)}; right: calc(${u(7)} + .28em); }
#flh-hud .flh-x .x-w.cur::after { transform: scaleX(1); }
#flh-hud .flh-x .x-w:focus-visible, #flh-hud .flh-x .x-back:focus-visible { outline: 1px solid rgba(255,255,255,.8); outline-offset: 2px; }
#flh-hud .flh-x .x-back { flex: none; display: inline-flex; align-items: center; gap: ${u(10)}; padding: ${u(12)} ${u(22)} ${u(11)} ${u(16)}; border: 1px solid rgba(255,255,255,.45); border-radius: 999px;
  font: 400 ${u(10)}/1 var(--sans); letter-spacing: .3em; text-transform: uppercase; color: #fff; background: rgba(255,255,255,.03); transition: background-color .3s ease, border-color .3s ease; }
#flh-hud .flh-x .x-back svg { width: ${u(14)}; height: ${u(14)}; }
#flh-hud .flh-x .x-back:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.85); }
@media (max-width: 760px), (max-height: 520px) {
  /* small screens: the telemetry block gives its corner to the world's name */
  #flh-hud.flh-exploring .flh-tele, #flh-hud.flh-exploring .flh-scrim-tr { display: none !important; }
}
@media (max-height: 520px) {
  #flh-hud .flh-x .x-hint { display: none; }
  #flh-hud .flh-x .x-bar { padding-top: 14px; padding-bottom: 12px; }
}
@media (max-width: 760px) {
  #flh-hud .flh-btn.flh-explore span { display: none; }
  #flh-hud .flh-btn.flh-explore { padding: 0 11px; margin-right: 2px; }
  #flh-hud .flh-x .x-bar { flex-direction: column-reverse; align-items: stretch; gap: 10px; padding-bottom: 18px; }
  #flh-hud .flh-x .x-back { align-self: flex-end; }
  #flh-hud .flh-x .x-hint { bottom: 132px; }
  #flh-hud .flh-x .x-w { font-size: 10px; padding: 12px 9px; }
  #flh-hud .flh-x .x-w.moon { font-size: 8.5px; }
}
#flh-hud .flh-xtip { position: absolute; left: 0; right: 0; top: calc(var(--mt) + var(--lb) + ${u(4)}); text-align: center; padding: 0 var(--mx); font: 400 ${u(9.5)}/1.6 var(--sans); letter-spacing: .3em; text-transform: uppercase;
  color: rgba(255,255,255,.74); text-shadow: var(--ts); opacity: 0; transition: opacity 1.4s ease; pointer-events: none; }
#flh-hud .flh-xtip.on { opacity: 1; }
#flh-hud.flh-clean .flh-xtip { opacity: 0; }
/* the picture can be grabbed */
html.flh-grab canvas#view { cursor: grab; }
html.flh-grabbing canvas#view { cursor: grabbing; }
`;
}
