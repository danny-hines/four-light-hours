// Simulated clock: simDays(t). Each block ("stop") runs at its own rate (multiple of TIME_SCALE). Between stops
// (during warp legs, when the worlds are points of light) the clock follows a monotone cubic Hermite that also
// absorbs any forward offset found by a search (e.g. waiting for Io's shadow to be on the disc).
// Monotone and C1 everywhere, so moons and rotations never jump or run backwards.
import { TIME_SCALE } from '../core/astro.js';

export function makeClock(epochDays) {
  const K = TIME_SCALE / 86400; // simulated days per real second at rate 1
  const stops = []; // { t0, t1, rate, extra, S0, S1 }

  function recompute() {
    for (let i = 0; i < stops.length; i++) {
      const s = stops[i];
      if (i === 0) s.S0 = epochDays + s.extra + s.rate * K * s.t0;
      else {
        const p = stops[i - 1];
        const gap = Math.max(0, s.t0 - p.t1);
        s.S0 = p.S1 + 0.5 * (p.rate + s.rate) * K * gap + s.extra;
      }
      s.S1 = s.S0 + s.rate * K * (s.t1 - s.t0);
    }
  }

  function clock(t) {
    const n = stops.length;
    if (!n) return epochDays + K * t;
    if (t <= stops[0].t0) return stops[0].S0 + stops[0].rate * K * (t - stops[0].t0);
    for (let i = 0; i < n; i++) {
      const s = stops[i];
      if (t <= s.t1) {
        if (t >= s.t0) return s.S0 + s.rate * K * (t - s.t0);
        const p = stops[i - 1];
        const h = s.t0 - p.t1;
        const u = (t - p.t1) / h;
        const u2 = u * u, u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * p.S1 + (u3 - 2 * u2 + u) * h * p.rate * K + (-2 * u3 + 3 * u2) * s.S0 + (u3 - u2) * h * s.rate * K;
      }
    }
    const l = stops[n - 1];
    return l.S1 + l.rate * K * (t - l.t1);
  }
  clock.K = K;
  clock.stops = stops;
  clock.addStop = (t0, t1, rate) => {
    stops.push({ t0, t1, rate, extra: 0, S0: 0, S1: 0 });
    stops.sort((a, b) => a.t0 - b.t0);
    recompute();
    return stops.find((s) => s.t0 === t0);
  };
  clock.setExtra = (stop, extra) => {
    stop.extra = Math.max(0, extra);
    recompute();
  };
  clock.rateAt = (t) => (clock(t + 0.01) - clock(t - 0.01)) / 0.02 / K;
  return clock;
}
