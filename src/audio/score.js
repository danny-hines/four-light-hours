// FOUR LIGHT-HOURS — generative score. WebAudio only; every sound is synthesised in code.
//
// create(ctx) composes the whole piece up front from the director's chapters and a cue track sampled from
// director.evaluate() (warp legs, fades), so the music is a pure function of journey time: playing, seeking
// and the offline renderer all produce the same score. See notes/audio.md.
//
// Live behaviour
//   start()      on the user gesture: creates the AudioContext, builds the master chain (convolution hall,
//                M/S width, glue compressor, true-peak limiter), pre-synthesises piano notes in idle slices
//   update(...)  every frame: keeps journey time and audio time in sync (small drift re-anchors; a stall
//                crossfades back in; a slow picture is tolerated up to 2.5 s); at most 20 times a second it
//                schedules events up to 5 s ahead with a 2.5 ms time budget, and 4 times a second cleans up voices
//   the end      when the film stops on its last frame the score keeps playing its composed tail (final chord
//                release, closing bell and glass) on the audio clock, then stops; a seek or replay ends it
//   pause        dry signal and reverb sends fade out (~0.4 s) and the reverb tail rings on; after 8 s of
//                silence the context is suspended to save CPU
//   seek(t)      a fresh "generation" of buses starts at t, resuming every sustained note mid-envelope, and
//                crossfades with the old one (0.5 s); rapid scrubbing is coalesced
//   setMuted(b)  25 ms-scale ramp on the output, processing continues so unmute is instant
//   setExplore(id | null)
//                explore mode (the film's clock is frozen while the viewer orbits a world): crossfades (~2 s) from
//                whatever plays to an endless, slowly evolving bed in that world's own harmony, register and colour
//                (explore.js), another id crossfades between beds (~1.5 s), null fades the bed out and hands back to
//                the film (the next update() resumes it at the current t). The bed sounds whether or not the film
//                is `playing`; only mute silences it. Safe before start() (applied once started), a no-op when
//                called again with the same id.
import { compose, fallbackTimeline, TAIL } from './composer.js';
import { Engine } from './engine.js';
import { ExploreBed, EXPLORE } from './explore.js';
import { JOURNEY_ORDER } from '../core/bodies-data.js';

const CUE_HZ = 10; // director.evaluate() samples per second for the cue track
const LOOKAHEAD = 5; // seconds of journey time scheduled ahead (live)
const NEAR = 0.6; // scheduled immediately on a start / seek / resume
const BUDGET = 40; // max events scheduled per frame while the lookahead fills (offline/ending)
const SCHED_HZ = 20; // live scheduling runs at most 20 times a second, not every frame
const SCHED_MS = 2.5; // and spends at most ~2.5 ms of main thread per run (node creation spread over frames)
export const MAKEUP_DB = 0.6; // master makeup, calibrated with src/audio/tools/render.mjs

const clamp01 = (x) => (x > 1 ? 1 : x > 0 ? x : 0);

// Sample the director's cue track. Uses only the contract (chapters, duration, evaluate -> shot.warp/fade) and,
// when the director provides them, shot.audio = { intensity, arrival, cue } and director.audioCues.
export function sampleCues(director) {
  const duration = director.duration;
  const n = Math.ceil(duration * CUE_HZ) + 1;
  const warp = new Float32Array(n),
    fade = new Float32Array(n),
    intensity = new Float32Array(n),
    arrival = new Float32Array(n),
    departure = new Float32Array(n);
  let failed = 0,
    hasIntensity = false,
    hasArrival = false,
    lastCue = null;
  const runs = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(duration, i / CUE_HZ);
    try {
      const s = director.evaluate(t);
      warp[i] = clamp01(+s.warp || 0);
      fade[i] = clamp01(+s.fade || 0);
      const a = s.audio;
      intensity[i] = 0.6;
      if (a && typeof a === 'object') {
        if (Number.isFinite(+a.intensity) && a.intensity !== undefined) {
          intensity[i] = clamp01(+a.intensity);
          hasIntensity = true;
        }
        if (Number.isFinite(+a.arrival) && a.arrival !== undefined && Number.isFinite(+a.departure) && a.departure !== undefined) {
          arrival[i] = clamp01(+a.arrival);
          departure[i] = clamp01(+a.departure);
          hasArrival = true;
        }
        const cue = typeof a.cue === 'string' ? a.cue : null;
        if (cue && cue !== lastCue) runs.push({ id: cue, t });
        lastCue = cue;
      }
    } catch {
      failed++;
    }
  }
  const listed = Array.isArray(director.audioCues) ? director.audioCues.filter((c) => c && typeof c.id === 'string' && Number.isFinite(c.t)).map((c) => ({ id: c.id, t: c.t, dur: c.dur || 2 })) : null;
  return {
    failed: failed > n / 2,
    duration,
    cues: { hz: CUE_HZ, warp, fade, intensity: hasIntensity ? intensity : null, arrival: hasArrival ? arrival : null, departure: hasArrival ? departure : null, events: listed && listed.length ? listed : runs },
  };
}

// Compose the score for a director (or the fallback timing when there is none).
export function planFor(director) {
  if (!director || typeof director.evaluate !== 'function' || !director.chapters || !director.chapters.length || !(director.duration > 0)) {
    return compose(fallbackTimeline(JOURNEY_ORDER));
  }
  const s = sampleCues(director);
  if (s.failed) return compose(fallbackTimeline(JOURNEY_ORDER));
  return compose({ chapters: director.chapters, duration: s.duration, cues: s.cues });
}

export async function create(ctx) {
  const t0 = performance.now();
  let plan;
  try {
    plan = planFor(ctx.director);
  } catch (e) {
    console.warn('[audio] planning from the director failed; using fallback timing:', e && e.message);
    plan = compose(fallbackTimeline(JOURNEY_ORDER));
  }
  const planMs = performance.now() - t0;

  let ac = null,
    engine = null,
    gen = null;
  let started = false,
    active = false,
    ending = false, // the film has reached its last frame: the score plays its composed tail on the audio clock
    muted = false;
  let pendingSeek = null,
    lastRegen = -10,
    pauseAt = 0,
    driftEma = 0,
    shift = 0,
    lastT = 0,
    rateEma = 1, // picture clock / audio clock: < 1 when the page runs below ~10 fps (main.js clamps dt)
    prevUpd = null,
    lastSched = -1;
  const perf = { frames: 0, total: 0, max: 0, regenMax: 0, resyncs: 0 }; // main-thread cost of update()
  let exploreWant = null, // the world asked for with setExplore (null: the film)
    exploring = false,
    bed = null;

  // Enter / switch / leave explore mode (needs the engine: setExplore before start() is applied by start()).
  function applyExplore() {
    if (!engine) return;
    const now = ac.currentTime;
    const when = now + 0.03;
    if (exploreWant !== null) {
      if (ac.state !== 'running' && ac.resume) ac.resume().catch(() => {});
      engine.setTransport(true, now);
      if (!exploring) {
        // leave the film: its generations fade out as the bed fades in (the film is not "active" while exploring)
        for (const g of engine.gens) engine.retire(g, when, EXPLORE.enter);
        gen = null;
        active = false;
        ending = false;
        pendingSeek = null;
        exploring = true;
        bed.enter(exploreWant, when, EXPLORE.enter);
      } else bed.enter(exploreWant, when, EXPLORE.swap);
    } else if (exploring) {
      bed.leave(when, EXPLORE.enter);
      exploring = false;
      // back to the film: the next update() starts a generation at the current t if the film is playing; if it
      // is paused the bed rings out and the context suspends as after any pause
      pauseAt = now;
      prevUpd = null;
      rateEma = 1;
      lastSched = -1;
    }
  }

  const latency = () => (ac ? ac.outputLatency || ac.baseLatency || 0 : 0);

  // Start a new generation at journey time t and crossfade the old one(s) out.
  function regen(t, fadeIn = 0.5, fadeOut = 0.6) {
    const r0 = performance.now();
    const now = ac.currentTime;
    const when = now + 0.03;
    engine.anchor(t, now - latency());
    // one equal-power crossfade: the old generation fades out over the same time the new one fades in, from
    // the same instant (no dip, no swell)
    for (const g of engine.gens) engine.retire(g, when, Math.max(fadeIn, 0.3));
    // never keep more than a couple of fading generations alive while scrubbing
    const dying = engine.gens.filter((g) => g.dead);
    for (let i = 0; i < dying.length - 2; i++) dying[i].deadAt = now;
    gen = engine.newGeneration(engine.journeyAt(when), when, fadeIn);
    engine.scheduleUntil(gen, t + NEAR); // the near future at once; the rest of the lookahead over the next frames
    lastRegen = now;
    driftEma = 0;
    shift = 0;
    perf.regenMax = Math.max(perf.regenMax, performance.now() - r0);
  }
  function stop(now, fade = 0.3) {
    engine.setTransport(false, now); // the dry signal and sends fade; the reverb tail rings out
    for (const g of engine.gens) engine.retire(g, now + 0.6, fade);
    pauseAt = now;
  }

  const api = {
    async start() {
      if (started) return;
      started = true;
      try {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        ac = new AC({ latencyHint: 'playback' });
        if (ac.resume) ac.resume().catch(() => {}); // still inside the user gesture
        const e = new Engine(ac, plan, { realtime: true, makeupDb: MAKEUP_DB, lite: ctx.quality === 'low' });
        await e.init();
        e.setMuted(muted);
        engine = e;
        bed = new ExploreBed(engine);
        engine.prewarm();
        if (exploreWant !== null) applyExplore();
      } catch (err) {
        console.warn('[audio] unavailable:', err && err.message);
        engine = null;
      }
    },

    update(t, shot, playing) {
      lastT = t;
      if (!engine) return;
      const u0 = performance.now();
      const now = ac.currentTime;
      const hidden = typeof document !== 'undefined' && document.hidden;
      if (exploring) {
        // explore mode: the film's clock is frozen and none of its cues may fire; the bed runs on the audio clock
        if (now - lastSched >= 1 / SCHED_HZ || now < lastSched) {
          bed.tick(now, SCHED_MS);
          lastSched = now;
        }
        if (now - (engine.lastSweep || 0) > 0.25 || now < (engine.lastSweep || 0)) {
          engine.sweep(now);
          engine.lastSweep = now;
        }
        prevUpd = null;
        return;
      }
      const want = !!playing && !hidden;
      // The film's last frame is not a pause: main.js stops the clock at `duration`, but the score still has its
      // composed ending (final release, closing bell and glass, the hall's tail). Keep playing it on the audio
      // clock until plan.total; a seek, a replay or a hidden tab ends it early.
      if (active && !want && !hidden && pendingSeek === null && t >= plan.duration - 0.05) ending = true;
      if (ending && (want || hidden || pendingSeek !== null || t < plan.duration - 0.05)) ending = false;
      if (ending) {
        const tj = engine.journeyAt(now);
        engine.scheduleUntil(gen, tj + LOOKAHEAD, BUDGET, SCHED_MS);
        if (tj > plan.total + 0.5) {
          ending = false;
          active = false;
          stop(now, 0.6);
        }
      } else if (want !== active) {
        active = want;
        if (active) {
          if (ac.state !== 'running') {
            const r0 = performance.now();
            ac.resume().catch(() => {});
            perf.resumeMs = Math.max(perf.resumeMs || 0, performance.now() - r0);
          }
          engine.setTransport(true, now);
          regen(t, 0.45, 0.35);
          pendingSeek = null;
        } else stop(now);
      } else if (active) {
        // how fast is the picture running against the audio clock? (below ~10 fps main.js clamps dt to 0.1 s,
        // so the picture runs slow; chasing it every 2 s would crossfade the score constantly)
        if (prevUpd && now > prevUpd.now + 1e-3 && pendingSeek === null) {
          const r = (t - prevUpd.t) / (now - prevUpd.now);
          if (r > 0 && r < 2) rateEma += (r - rateEma) * Math.min(1, (now - prevUpd.now) / 2);
        }
        const slow = rateEma < 0.9;
        // after a resync, no other for 5 s (a stalled page re-anchors once instead of crossfading repeatedly)
        const tol = slow ? 2.5 : 0.6,
          minGap = slow ? 10 : 5;
        // a coalesced seek (or a big stall) restarts at the *current* journey time; only small drift re-anchors
        const drift = engine.journeyAt(now) - latency() - t;
        const stalled = (Math.abs(drift) > tol || Math.abs(shift) > 1 + (slow ? 1.5 : 0)) && now - lastRegen > minGap; // shift: lanes run on the old anchor
        if (pendingSeek !== null || stalled) {
          if (now - lastRegen > 0.12) {
            if (pendingSeek === null) perf.resyncs++;
            regen(t, 0.4, 0.45);
            pendingSeek = null;
          } else pendingSeek = t;
        } else if (!slow && Math.abs(drift) <= tol) {
          driftEma = driftEma * 0.9 + drift * 0.1;
          if (Math.abs(driftEma) > 0.04) {
            shift += drift;
            engine.anchor(t, now - latency());
            driftEma = 0;
          }
        }
        // the score is precomposed, so it is scheduled LOOKAHEAD s ahead (a long main-thread stall cannot starve
        // it); at most SCHED_HZ times a second with a SCHED_MS time budget, so no frame pays for the horizon
        if (now - lastSched >= 1 / SCHED_HZ || now < lastSched) {
          engine.scheduleUntil(gen, Math.max(t, engine.journeyAt(now)) + LOOKAHEAD, Infinity, SCHED_MS);
          lastSched = now;
        }
      }
      prevUpd = { t, now };
      if (!active && !ending && ac.state === 'running' && now - pauseAt > 8 && engine.voices.length === 0) ac.suspend().catch(() => {});
      if (now - (engine.lastSweep || 0) > 0.25 || now < (engine.lastSweep || 0)) {
        engine.sweep(now);
        engine.lastSweep = now;
      }
      const ms = performance.now() - u0;
      perf.frames++;
      perf.total += ms;
      if (ms > perf.max) perf.max = ms;
    },

    seek(t) {
      lastT = t;
      if (!engine || exploring) return; // (exploring: the film resumes at the current t when explore ends)
      if (ending) {
        // leaving the ending (a replay or a scrub back): the next update decides between play and pause
        ending = false;
        pendingSeek = t;
        return;
      }
      if (!active) return; // resuming always starts a fresh generation at the current time
      if (ac.currentTime - lastRegen < 0.12) pendingSeek = t;
      else regen(t, 0.5, 0.6);
    },

    setMuted(m) {
      muted = !!m;
      if (engine) engine.setMuted(muted);
    },

    setExplore(id) {
      const want = id === null || id === undefined || id === false ? null : String(id);
      if (want === exploreWant) return;
      exploreWant = want;
      try {
        applyExplore();
      } catch (err) {
        console.warn('[audio] explore failed:', err && err.message);
      }
    },
  };

  // debugging / observability hook (src/audio/tools/live.mjs reads it)
  if (typeof window !== 'undefined')
    window.__score = {
      planMs: +planMs.toFixed(1),
      sections: plan.sections.map((s) => `${s.world} ${s.t0.toFixed(1)}-${s.t1.toFixed(1)}`),
      events: plan.events.length,
      duration: plan.duration,
      total: plan.total,
      _engine: () => engine, // debugging only
      api, // the tools drive setExplore through it (main.js may not expose it on app)
      info: () => (engine ? { ...engine.info(), active, ending, muted, exploring, explore: bed && bed.cur ? { id: bed.cur.id, world: bed.cur.plan.explore.world, cycle: bed.cur.cycle, loop: bed.cur.plan.explore.loop, ...bed.stats } : null, lastT: +lastT.toFixed(2), journeyAudio: +engine.journeyAt(ac.currentTime).toFixed(2), rate: +rateEma.toFixed(3), resyncs: perf.resyncs, latency: +latency().toFixed(3), updateMsAvg: +(perf.total / Math.max(1, perf.frames)).toFixed(3), updateMsMax: +perf.max.toFixed(2), regenMsMax: +perf.regenMax.toFixed(2), resumeMsMax: +(perf.resumeMs || 0).toFixed(2), pianoNotesReady: engine.piano.size } : { started, engine: null }),
    };
  return api;
}

// Offline render of the whole score (or [from, to]) for tools/render.mjs. `seeks` = [[ctxTime, journeyT], ...]
// exercises the live seek/crossfade path inside the render.
export async function renderOffline({ director, sampleRate = 48000, from = 0, to = null, makeupDb = MAKEUP_DB, seeks = [], onProgress } = {}) {
  const tp = performance.now();
  const plan = planFor(director);
  const planMs = performance.now() - tp;
  const end = Math.min(plan.duration, to ?? plan.duration);
  const seekSpan = seeks.length ? Math.max(...seeks.map(([c]) => c)) + 10 : 0;
  const len = seeks.length ? Math.min(seekSpan, end - from) : end - from + (end >= plan.duration ? TAIL : 0.5);
  const oac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(len * sampleRate), sampleRate });
  const engine = new Engine(oac, plan, { realtime: false, makeupDb });
  await engine.init();
  engine.anchor(from, 0);
  let gen = engine.newGeneration(from, 0, from > 0 ? 0.25 : 0);
  let journeyNow = (c) => engine.journeyAt(c);
  const STEP = 1.0;
  engine.scheduleUntil(gen, from + STEP + 0.6);
  const pending = [...seeks].sort((a, b) => a[0] - b[0]);
  for (let ct = STEP; ct < len; ct += STEP) {
    const c = ct;
    oac.suspend(c).then(() => {
      while (pending.length && pending[0][0] <= c + 1e-6) {
        const [, jt] = pending.shift();
        engine.anchor(jt, c);
        for (const g of engine.gens) engine.retire(g, c + 0.03, 0.5);
        gen = engine.newGeneration(jt + 0.03, c + 0.03, 0.5);
      }
      engine.scheduleUntil(gen, journeyNow(c) + STEP + 0.6);
      engine.sweep(c);
      if (onProgress) onProgress(c / len);
      oac.resume();
    });
  }
  const tr = performance.now();
  const buffer = await oac.startRendering();
  return { buffer, plan, info: engine.info(), planMs, renderMs: performance.now() - tr, from, end, len };
}

// Offline render of explore beds for tools/explore.mjs: `script` = [[seconds, worldId], ...] played back to back
// through the same ExploreBed as live (first bed fades in from silence, the others crossfade; a segment longer
// than a bed's plan exercises the roll-over to its next variation).
export async function renderExploreOffline({ script = [['saturn', 60], ['earth', 60]], sampleRate = 48000, makeupDb = MAKEUP_DB } = {}) {
  const len = script.reduce((a, [, s]) => a + s, 0) + 3;
  const oac = new OfflineAudioContext({ numberOfChannels: 2, length: Math.ceil(len * sampleRate), sampleRate });
  const engine = new Engine(oac, null, { realtime: false, makeupDb });
  await engine.init();
  const bed = new ExploreBed(engine, { realtime: false });
  const marks = [];
  let at = 0;
  const pending = script.map(([id, secs]) => {
    const m = { id, t: at };
    at += secs;
    return m;
  });
  const end = at;
  bed.enter(pending[0].id, 0, EXPLORE.enter);
  marks.push({ ...pending.shift(), world: bed.cur.plan.explore.world, loop: bed.cur.plan.explore.loop });
  const STEP = 0.5;
  for (let ct = STEP; ct < len; ct += STEP) {
    const c = ct;
    oac.suspend(c).then(() => {
      if (pending.length && pending[0].t <= c + 1e-6) {
        bed.enter(pending[0].id, c + 0.03, EXPLORE.swap);
        marks.push({ ...pending.shift(), world: bed.cur.plan.explore.world, loop: bed.cur.plan.explore.loop });
      } else if (c >= end && bed.cur) bed.leave(c + 0.03, EXPLORE.enter);
      const cyc = bed.stats.cycles;
      bed.tick(c);
      if (bed.stats.cycles !== cyc) marks.push({ id: bed.cur.id, t: c, world: bed.cur.plan.explore.world, loop: bed.cur.plan.explore.loop, cycle: bed.cur.cycle });
      engine.sweep(c);
      oac.resume();
    });
  }
  const buffer = await oac.startRendering();
  return { buffer, marks, end, info: engine.info(), stats: bed.stats };
}
