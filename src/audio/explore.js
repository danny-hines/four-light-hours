// Explore mode (score.js setExplore): an endless ambient bed for one world while the film's clock is frozen.
//
// A bed is an explore plan (composer.js composeExplore: the world's own harmony, register, layers and lanes over
// ~70-130 s, no legs or arrivals, a sparse fragment of the themes now and then) played by an engine generation on
// its own clock. Before a plan runs out the next variation of the same world (cycle + 1: every seeded choice
// re-drawn) is composed and the two are crossfaded equal-power, so the bed never loops and never ends, and
// nothing accumulates: the old generation, its voices and its plan are released by the engine's sweep.
// Switching worlds is the same crossfade, shorter. Used identically live and in the offline render.
import { composeExplore } from './composer.js';

export const EXPLORE = {
  enter: 2.0, // s: film -> bed, bed -> film
  swap: 1.5, // s: bed -> another world's bed
  loop: 7.0, // s: one variation of a bed -> the next
  start: 6.0, // a bed starts this far into its plan, so its sustained layers are already sounding (resumed mid-envelope)
  lookahead: 5.0,
  stall: 2.5, // s without a tick (a hidden tab): the bed restarts where it should be by now
  // per-world trims (dB) that put every bed a little under the film's average loudness (measured offline:
  // src/audio/tools/explore.mjs -> notes/audio-explore.md)
  trimDb: { sun: -1.8, mercury: 3.7, venus: 1.3, earth: -1.6, moon: 2.7, mars: 2, belt: 1, jupiter: 1.6, saturn: 2.3, titan: 2.6, uranus: 0, neptune: 3.2, triton: 3, transit: 6 },
};
const lin = (db) => Math.pow(10, db / 20);

export class ExploreBed {
  constructor(engine, { realtime = true } = {}) {
    this.engine = engine;
    this.realtime = realtime;
    this.cur = null;
    this.stats = { beds: 0, cycles: 0, restarts: 0 };
  }
  get id() {
    return this.cur ? this.cur.id : null;
  }
  // Start a world's bed, or switch to it, at ctx time `when` (a crossfade of `fade` s with whatever bed plays).
  enter(id, when, fade = EXPLORE.swap) {
    if (this.cur && this.cur.id === id) return;
    this.leave(when, fade);
    this.cur = this.begin(id, 0, when, fade);
    this.stats.beds++;
  }
  leave(when, fade = EXPLORE.enter) {
    if (!this.cur) return;
    this.engine.retire(this.cur.g, when, fade);
    this.cur = null;
  }
  begin(id, cycle, when, fade, plan = null, tStart = EXPLORE.start) {
    const E = this.engine;
    plan = plan || composeExplore(id, cycle);
    if (this.realtime) E.prewarm(plan); // its piano notes, in idle slices
    const g = E.newGeneration(tStart, when, fade, { plan, gain: lin(EXPLORE.trimDb[plan.explore.world] ?? 0) });
    E.scheduleUntil(g, tStart + 0.6);
    return { id, cycle, plan, g, t0: tStart, when, last: when, next: null };
  }
  // Call regularly (every frame live, every step offline): schedules ahead, rolls over to the next variation.
  tick(now, msBudget = Infinity) {
    const c = this.cur;
    if (!c) return;
    const t = c.t0 + (now - c.when); // plan time now
    const L = c.plan.explore.loop;
    if (now - c.last > EXPLORE.stall && this.realtime) {
      // the page stalled (a hidden tab): everything scheduled has played out; restart the bed where it should be
      this.engine.retire(c.g, now + 0.03, 0.5);
      const tt = EXPLORE.start + ((Math.max(t, EXPLORE.start) - EXPLORE.start) % (L - EXPLORE.loop - 1 - EXPLORE.start));
      this.cur = this.begin(c.id, c.cycle, now + 0.03, 0.5, c.plan, tt);
      this.stats.restarts++;
      return;
    }
    c.last = now;
    // the next variation is composed a few seconds early (a few ms of main thread, away from the crossfade)
    if (!c.next && t > L - EXPLORE.loop - 6) c.next = composeExplore(c.id, c.cycle + 1);
    if (t > L - EXPLORE.loop - 1) {
      const when = now + 0.05;
      this.engine.retire(c.g, when, EXPLORE.loop);
      this.cur = this.begin(c.id, c.cycle + 1, when, EXPLORE.loop, c.next);
      this.stats.cycles++;
      return;
    }
    this.engine.scheduleUntil(c.g, t + EXPLORE.lookahead, Infinity, msBudget);
  }
}
