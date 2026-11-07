// Deterministic layout of the Sun's surface features (sunspot groups, plage, prominences).
//
// Coordinates are heliographic in the Sun's body frame (astro.js convention: +y north, +x lon 0, -z 90 E).
// The Sun's rotation phase is referenced to REF_DATE (see sun.js), so at the start of the film the same
// hemisphere faces +x (the default body-view camera direction) whatever the viewer's date is. The composition
// is laid out around the hemisphere centred near (lat +12, lon -143), which is what the body-view shots see.
//
// Late 2026 is the declining phase of solar cycle 25: active regions sit at low latitudes (5-25 deg), polar
// coronal holes are developing (polar plumes), and quiescent / polar-crown prominences are common.
// Sizes: 1 deg of heliographic arc = 12,140 km = 1.906 scene units.

// ---------------------------------------------------------------- sunspot groups
// Each active region is generated deterministically from a few parameters, like a real bipolar group: a big leading
// spot (west, toward the rotation, i.e. higher east-longitude, and a little closer to the equator: Joy's-law tilt
// ~0.56 x latitude), a few intermediate spots scattered about the group axis with lateral offsets, and a
// fragmented follower cluster of small spots with rudimentary one-sided penumbrae, plus pores, with a power-law size
// distribution. Positions are rejection-sampled so penumbrae do not pile on top of each other.
//   lat, lon: leading spot; rp: its penumbra radius (deg); len: leader-follower separation (deg); mid / fol /
//   pores: member counts; cores: umbral cores of the leader (2-3 give light bridges); seed.
// Output spot fields: lat, lon, ru (umbra radius, deg), rp (penumbra radius, deg; 0 = pore), cores (1-3),
// one (0..1, one-sidedness of the penumbra), depth (Wilson depression, x 600 km), seed.
const REGIONS = [
  // AR A: the group under the photosphere skim (lower half of the skim frame)
  { lat: -4.4, lon: -140.4, rp: 1.25, len: 9.5, mid: 2, fol: 7, pores: 6, cores: 2, seed: 11 },
  // AR B: the big northern complex near disc centre (full-disc and wide views; on the disc in the limb view)
  { lat: 16.8, lon: -118.6, rp: 1.65, len: 12.5, mid: 3, fol: 9, pores: 7, cores: 3, seed: 23 },
  // AR C: near the west limb of the limb view (Wilson effect, limb faculae)
  { lat: 9.0, lon: -97.0, rp: 1.0, len: 6.0, mid: 1, fol: 4, pores: 3, cores: 1, seed: 37 },
  // AR D: southern group, lower left of the full disc
  { lat: -15.8, lon: -163.0, rp: 0.85, len: 6.5, mid: 1, fol: 4, pores: 3, cores: 2, seed: 41 },
  // AR E: near the east limb of the full disc
  { lat: -21.0, lon: 157.0, rp: 0.75, len: 4.5, mid: 0, fol: 3, pores: 2, cores: 1, seed: 53 },
  // AR F: a small, decaying northern group
  { lat: 23.5, lon: -158.5, rp: 0.42, len: 3.2, mid: 0, fol: 2, pores: 3, cores: 1, seed: 61 },
  // far hemisphere (for other camera directions)
  { lat: 12.0, lon: 22.0, rp: 1.25, len: 7.5, mid: 1, fol: 5, pores: 3, cores: 2, seed: 71 },
  { lat: -14.0, lon: 62.0, rp: 0.95, len: 6.0, mid: 1, fol: 3, pores: 2, cores: 1, seed: 83 },
  { lat: 18.0, lon: 86.0, rp: 0.7, len: 4.5, mid: 0, fol: 3, pores: 2, cores: 1, seed: 97 },
  { lat: -9.0, lon: -22.0, rp: 0.8, len: 5.0, mid: 1, fol: 3, pores: 2, cores: 1, seed: 101 },
];

function prng(seed) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
}

function makeGroup(G) {
  const rnd = prng(G.seed);
  const out = [];
  const hemi = Math.sign(G.lat) || 1;
  // Joy's law: the follower end sits poleward of the leader by ~0.56 x |lat| deg of tilt (with scatter)
  const tilt = ((0.56 * Math.abs(G.lat) + (rnd() - 0.5) * 8) * Math.PI) / 180;
  const cl = Math.cos((G.lat * Math.PI) / 180);
  // group axis (deg east, deg north) from the leader toward the follower end
  const ax = [-Math.cos(tilt), hemi * Math.sin(tilt)];
  const px = [-ax[1], ax[0]];
  const place = (t, lat0off, spread) => {
    const a = t * G.len + (rnd() - 0.5) * spread[0];
    const b = (rnd() - 0.5) * 2 * spread[1];
    const e = a * ax[0] + b * px[0], n = a * ax[1] + b * px[1];
    return { lat: G.lat + n + lat0off, lon: G.lon + e / cl };
  };
  const fits = (p, rp) => out.every((q) => {
    const dl = (p.lon - q.lon) * cl, dn = p.lat - q.lat;
    return Math.hypot(dl, dn) > 0.8 * (Math.max(rp, q.ru * 1.6) + Math.max(q.rp, q.ru * 1.6)) + 0.12;
  });
  const add = (p, ru, rp, extra) => out.push({ lat: p.lat, lon: p.lon, ru, rp, cores: 1, one: 0, depth: 0.6, seed: rnd(), ...extra });
  // leader: big, roundish, a small asymmetry; 1-3 umbral cores
  add({ lat: G.lat, lon: G.lon }, G.rp * (0.4 + 0.06 * rnd()), G.rp, { cores: G.cores, one: 0.1 + 0.15 * rnd(), depth: 1.0 });
  const tryPlace = (t, spread, rp, n = 24) => {
    for (let k = 0; k < n; k++) {
      const p = place(t, 0, spread);
      if (fits(p, rp)) return p;
    }
    return null;
  };
  // intermediate spots along the axis, offset laterally by 20-40 % of the spacing
  for (let i = 0; i < G.mid; i++) {
    const t = 0.28 + (0.42 * (i + rnd())) / Math.max(G.mid, 1);
    const rp = G.rp * (0.28 + 0.3 * rnd());
    const p = tryPlace(t, [0.12 * G.len, 0.3 * G.len / Math.max(G.mid + 1, 2)], rp);
    if (p) add(p, rp * (0.38 + 0.08 * rnd()), rp, { cores: rnd() < 0.3 ? 2 : 1, one: 0.35 + 0.5 * rnd(), depth: 0.8 });
  }
  // follower cluster: the largest member has a partial penumbra, the rest are small spots and pores (power law)
  for (let i = 0; i < G.fol; i++) {
    const big = i === 0;
    const sz = big ? 0.42 + 0.15 * rnd() : 0.5 * Math.pow(rnd(), 1.6) + 0.08;
    const rp = G.rp * sz;
    const p = tryPlace(big ? 1.0 : 0.85 + 0.35 * rnd(), [0.4 * G.len, 0.2 * G.len], rp);
    if (!p) continue;
    const ruDeg = rp * (0.38 + 0.12 * rnd());
    if (!big && rp < 0.3) add(p, Math.max(0.05, rp * 0.55), 0, { cores: 1 }); // a pore
    else add(p, ruDeg, rp, { cores: big && rnd() < 0.5 ? 2 : 1, one: big ? 0.5 + 0.3 * rnd() : 0.7 + 0.3 * rnd(), depth: big ? 0.85 : 0.6 });
  }
  // scattered pores along the group (and around the leader)
  for (let i = 0; i < G.pores; i++) {
    const p = tryPlace(rnd() * 1.1, [0.25 * G.len, 0.22 * G.len], 0.12);
    if (p) add(p, 0.05 + 0.07 * rnd(), 0, { cores: 1 });
  }
  return out;
}

export const SPOT_GROUPS = REGIONS.map((G) => ({ ...G, spots: makeGroup(G) }));
export const SPOTS = SPOT_GROUPS.flatMap((g) => g.spots);

// ---------------------------------------------------------------- plage (facular regions around active regions)
// lat, lon, radius (deg), strength: one envelope per group, centred between leader and follower, plus decaying
// plage without spots (bright faculae near the limbs of the main views)
function groupPlage(g) {
  let la = 0, lo = 0;
  for (const s of g.spots) { la += s.lat; lo += s.lon; }
  la /= g.spots.length;
  lo /= g.spots.length;
  return { lat: la, lon: lo, r: 0.6 * g.len + 2.2, s: Math.min(1.1, 0.55 + 0.3 * g.rp) };
}
export const PLAGES = [
  ...SPOT_GROUPS.map(groupPlage),
  { lat: 6.0, lon: -66.0, r: 6.0, s: 0.75 },
  { lat: 8.0, lon: 134.0, r: 5.5, s: 0.7 },
  { lat: -24.0, lon: -82.0, r: 5.0, s: 0.6 },
  { lat: 28.0, lon: -95.0, r: 4.5, s: 0.55 },
];

// ---------------------------------------------------------------- prominences
// type: 'arch' (a bundle of twisted loop strands), 'hedge' (quiescent hedgerow sheet of vertical threads),
//       'erupt' (tall, wide, strongly twisted loop).
// lat, lon: anchor (centre of the base); az: orientation of the long axis (deg from north toward east);
// L: half length along the axis, H: height, W: half thickness (scene units; 1 unit = 6371 km); seed.
export const PROMINENCES = [
  // limb view (dist 1.9, look 17,0): west limb at lon ~ -85
  { type: 'arch', lat: 9.5, lon: -84.5, az: 8, L: 13.5, H: 9.5, W: 3.0, strands: 8, lean: 0.25, seed: 1.7 },
  { type: 'hedge', lat: -6.5, lon: -86.5, az: -4, L: 9.0, H: 6.2, W: 1.4, seed: 4.2 },
  // full disc & wide corona: west limb (~ lon -62) and east limb (~ lon 134)
  { type: 'arch', lat: -4.0, lon: -60.0, az: 4, L: 10.0, H: 12.5, W: 3.0, strands: 8, seed: 7.3 },
  { type: 'hedge', lat: 9.0, lon: 132.0, az: -10, L: 17.0, H: 10.5, W: 1.8, seed: 2.9 },
  { type: 'erupt', lat: -25.0, lon: 138.0, az: 6, L: 16.0, H: 21.0, W: 5.0, strands: 8, lean: -0.2, seed: 9.1 },
  { type: 'hedge', lat: -31.0, lon: -71.0, az: 30, L: 6.0, H: 4.5, W: 1.1, seed: 5.5 },
  { type: 'arch', lat: 34.0, lon: 137.0, az: 25, L: 5.5, H: 5.0, W: 1.6, strands: 5, seed: 3.3 },
  // polar crown (north) and a southern high-latitude hedgerow
  { type: 'hedge', lat: 66.0, lon: 10.0, az: 92, L: 16.0, H: 6.5, W: 1.4, seed: 6.6 },
  { type: 'hedge', lat: -58.0, lon: -100.0, az: 70, L: 8.0, H: 4.2, W: 1.1, seed: 8.8 },
  // photosphere skim: a low active-region filament over AR A, and prominences beyond the horizon
  // (dens: opacity multiplier; the horizon pair is seen at a shallow angle from ~50 units, so it is made denser;
  // both are seen side-on)
  { type: 'arch', lat: -2.0, lon: -145.2, az: 104, L: 9.5, H: 5.0, W: 2.2, strands: 5, seed: 11.4 },
  { type: 'hedge', lat: -15.5, lon: -127.5, az: 46, L: 10.0, H: 7.5, W: 1.8, seed: 12.6, dens: 1.4 },
  { type: 'arch', lat: -13.5, lon: -164.0, az: -45, L: 7.5, H: 8.5, W: 2.2, strands: 6, seed: 13.9, dens: 2.0 },
  // far hemisphere
  { type: 'arch', lat: 15.0, lon: 30.0, az: 10, L: 9.0, H: 9.0, W: 2.5, strands: 6, seed: 14.2 },
  { type: 'hedge', lat: -20.0, lon: 70.0, az: -20, L: 12.0, H: 7.0, W: 1.5, seed: 15.7 },
  { type: 'hedge', lat: 35.0, lon: -20.0, az: 60, L: 10.0, H: 6.0, W: 1.4, seed: 16.1 },
  { type: 'arch', lat: -8.0, lon: 100.0, az: -5, L: 8.0, H: 8.0, W: 2.2, strands: 6, seed: 17.5 },
  { type: 'arch', lat: 5.0, lon: -10.0, az: 15, L: 7.0, H: 6.5, W: 2.0, strands: 5, seed: 18.3 },
];

// ---------------------------------------------------------------- helmet streamers
// lat, lon of the streamer axis; s strength; bw bulb half-width (deg); rc cusp height (radii); sw stalk
// half-width (deg); cav depth of the coronal cavity (0..1) over a prominence.
// The hero views (sub-observer point near lat 12, lon -143) see the limb near lon -55 (west), lon 128 (east)
// and the poles; streamers there stand out as petals, the rest serve other camera directions.
export const STREAMERS = [
  { lat: -12, lon: -57, s: 1.0, bw: 19, rc: 2.25, sw: 4.7, cav: 0.55 },   // west limb, over the arch prominence
  { lat: 24, lon: -64, s: 0.65, bw: 13, rc: 1.9, sw: 3.6, cav: 0.0 },    // west, northern pseudo-streamer
  { lat: 18, lon: 126, s: 1.0, bw: 21, rc: 2.4, sw: 5.4, cav: 0.35 },    // east limb, over the hedgerow
  { lat: -27, lon: 136, s: 0.8, bw: 16, rc: 2.0, sw: 4.0, cav: 0.0 },    // east, south
  { lat: -42, lon: -100, s: 0.45, bw: 12, rc: 1.8, sw: 3.2, cav: 0.0 },
  { lat: 8, lon: 30, s: 0.9, bw: 20, rc: 2.3, sw: 4.7, cav: 0.4 },
  { lat: -18, lon: 70, s: 0.7, bw: 15, rc: 2.0, sw: 4.0, cav: 0.0 },
  { lat: 15, lon: -10, s: 0.75, bw: 17, rc: 2.1, sw: 4.3, cav: 0.0 },
  { lat: -6, lon: -150, s: 0.6, bw: 18, rc: 2.2, sw: 4.3, cav: 0.0 },     // faces the hero camera (halo on the disc)
  { lat: 30, lon: 175, s: 0.5, bw: 13, rc: 1.9, sw: 3.6, cav: 0.0 },
];

// Differential rotation (Snodgrass & Ulrich 1990), deg/day sidereal, minus the IAU (Carrington-like) rate the
// body frame already spins at. Used to shear the active regions slowly during the film.
export function diffRotationOffsetDeg(latDeg, dDays) {
  const s2 = Math.sin(latDeg * (Math.PI / 180)) ** 2;
  const omega = 14.713 - 2.396 * s2 - 1.787 * s2 * s2;
  return (omega - 14.1844) * dDays;
}

/** Unit vector (body frame) for heliographic lat/lon in degrees. */
export function dirFromLatLon(latDeg, lonDeg, out) {
  const la = latDeg * (Math.PI / 180), lo = lonDeg * (Math.PI / 180);
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}
