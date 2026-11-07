// Diffuse objects drawn procedurally on top of the Milky Way texture: emission and reflection nebulae, the
// Magellanic Clouds, Andromeda, M33 and the two great globular clusters. Positions are J2000 (degrees); sizes and
// position angles are from the standard catalogues (NGC/IC, Sharpless, RC3). Brightness is either a peak surface
// brightness `mu` (V mag / arcsec^2) or an integrated magnitude `V` (spread over the profile, so the object carries
// exactly the light of a star of that magnitude).
//
// kind: 0 emission (filamentary noise), 1 reflection (smooth), 2 galaxy / smooth stellar (exponential),
//       3 globular cluster (King-like core, grainy)
// r: scale radius (deg)   q: minor/major axis ratio   pa: major-axis position angle (deg, N through E)
// ring: 0 = filled; >0 = shell radius in units of r   side: [pa, strength] brighten one side (Barnard's Loop)

// H-alpha (656 nm) dominates every emission nebula on a daylight-balanced photograph: a deep red, lifted toward
// rose where H-beta and [O III] add blue-green (bright, high-excitation cores turn cream/teal in the shader)
const PINK = [1.0, 0.24, 0.33];
const RED = [1.0, 0.15, 0.22];
const BLUE = [0.52, 0.72, 1.25];
const TEAL = [0.75, 1.0, 1.0];

export const OBJECTS = [
  // ---- structure sprites (assets/sky/nebulae.webp, built by assets-src/scripts/build_nebulae.py): kind 4.
  //      mu = peak emission surface brightness, muR = peak reflection / starlight (or V / VR = integrated light)
  { name: 'M42/M43/NGC 1977', sprite: 'm42', ra: 83.8187, dec: -5.3897, kind: 4, mu: 16.9, stretch: 0.85, col: [1.0, 0.3, 0.36], muR: 21.6, colR: [0.55, 0.75, 1.25] },
  { name: 'Lagoon M8', sprite: 'lagoon', ra: 270.92, dec: -24.38, kind: 4, mu: 18.8, stretch: 0.82, col: [1.0, 0.26, 0.34] },
  { name: 'Trifid M20', sprite: 'trifid', ra: 270.6, dec: -23.02, kind: 4, mu: 20.8, stretch: 0.8, col: [1.0, 0.24, 0.33], muR: 21.4, colR: [0.52, 0.72, 1.25] },
  { name: 'Carina NGC 3372', sprite: 'carina', ra: 161.265, dec: -59.685, kind: 4, mu: 18.8, stretch: 0.82, col: [1.0, 0.25, 0.32] },
  { name: 'North America & Pelican', sprite: 'nan', ra: 313.6, dec: 44.3, kind: 4, mu: 21.2, col: [1.0, 0.17, 0.24] },
  { name: 'rho Oph complex', sprite: 'rhooph', ra: 246.6, dec: -24.8, kind: 4, mu: 22.9, col: [1.0, 0.17, 0.24], muR: 21.4, colR: [0.5, 0.72, 1.25] },
  { name: 'Rosette', sprite: 'rosette', ra: 97.98, dec: 4.95, kind: 4, mu: 22.1, stretch: 0.78, col: [1.0, 0.2, 0.28] },
  { name: 'LMC', sprite: 'lmc', ra: 80.89, dec: -69.76, kind: 4, mu: 19.6, col: [1.0, 0.28, 0.38], VR: 0.6, colR: [0.97, 0.98, 1.03], dust: 1, stretch: 1.0 },
  // ---- Orion
  { name: 'M42 core', ra: 83.82, dec: -5.39, r: 0.11, q: 0.85, pa: 0, kind: 0, mu: 17.6, col: [1.0, 0.82, 0.8], noise: 0.35 , fallback: true },
  { name: 'M42', ra: 83.86, dec: -5.32, r: 0.42, q: 0.8, pa: 15, kind: 0, mu: 20.2, col: PINK, noise: 0.6 , fallback: true },
  { name: 'M43', ra: 83.89, dec: -5.27, r: 0.05, q: 1, pa: 0, kind: 0, mu: 20.5, col: PINK, noise: 0.3 , fallback: true },
  { name: 'M78', ra: 86.69, dec: 0.07, r: 0.08, q: 0.7, pa: 30, kind: 1, mu: 21.5, col: BLUE, noise: 0.3 },
  { name: 'IC 434 / Flame', ra: 85.3, dec: -2.2, r: 0.3, q: 0.3, pa: 0, kind: 0, mu: 23.8, col: RED, noise: 0.85 },
  { name: 'Flame NGC 2024', ra: 85.42, dec: -1.9, r: 0.08, q: 0.9, pa: 0, kind: 0, mu: 21.8, col: [1.0, 0.55, 0.45], noise: 0.6 },
  { name: "Barnard's Loop", ra: 85.6, dec: -3.4, r: 6.6, q: 0.62, pa: 5, kind: 0, mu: 24.4, col: RED, noise: 0.9, ring: 0.97, rw: 0.09, side: [90, 0.85] },
  { name: 'Lambda Ori ring', ra: 83.8, dec: 9.9, r: 3.4, q: 0.95, pa: 0, kind: 0, mu: 24.6, col: RED, noise: 0.75, ring: 0.75, rw: 0.35 },
  // ---- winter Milky Way
  { name: 'Rosette', ra: 97.98, dec: 4.95, r: 0.55, q: 0.92, pa: 0, kind: 0, mu: 22.8, col: PINK, noise: 0.55, ring: 0.62, rw: 0.38 , fallback: true },
  { name: 'NGC 2264', ra: 100.25, dec: 9.6, r: 0.35, q: 0.7, pa: 0, kind: 0, mu: 23.5, col: RED, noise: 0.7 },
  { name: 'Seagull', ra: 105.7, dec: -10.6, r: 0.9, q: 0.45, pa: 120, kind: 0, mu: 24.0, col: RED, noise: 0.7 },
  { name: 'California', ra: 60.25, dec: 36.4, r: 1.15, q: 0.28, pa: 128, kind: 0, mu: 23.4, col: RED, noise: 0.7 },
  // the Pleiades reflection nebula: striated (the cluster is ploughing through a sheet of dust), brightest around
  // Merope (NGC 1435) and Maia; streaks along PA ~ -60 deg
  { name: 'Pleiades', ra: 56.72, dec: 24.07, r: 0.5, q: 0.8, pa: -60, kind: 1, mu: 22.2, col: BLUE, noise: 0.7, streak: 3 },
  { name: 'Merope nebula', ra: 56.6, dec: 23.88, r: 0.12, q: 0.65, pa: -50, kind: 1, mu: 21.2, col: BLUE, noise: 0.6, streak: 2.5 },
  { name: 'Maia nebula', ra: 56.48, dec: 24.4, r: 0.07, q: 0.8, pa: -60, kind: 1, mu: 21.9, col: BLUE, noise: 0.5, streak: 2 },
  { name: 'Heart', ra: 38.2, dec: 61.45, r: 0.55, q: 0.9, pa: 0, kind: 0, mu: 23.8, col: RED, noise: 0.7 },
  { name: 'Soul', ra: 42.8, dec: 60.4, r: 0.55, q: 0.8, pa: 90, kind: 0, mu: 24.0, col: RED, noise: 0.7 },
  // ---- summer Milky Way (Cygnus, Cepheus)
  { name: 'North America', ra: 314.6, dec: 44.3, r: 0.85, q: 0.85, pa: 0, kind: 0, mu: 22.3, col: RED, noise: 0.6 , fallback: true },
  { name: 'Pelican', ra: 312.8, dec: 44.4, r: 0.45, q: 0.8, pa: 0, kind: 0, mu: 23.2, col: RED, noise: 0.7 , fallback: true },
  { name: 'IC 1318', ra: 305.4, dec: 40.3, r: 1.6, q: 0.7, pa: 40, kind: 0, mu: 24.0, col: RED, noise: 0.8 },
  { name: 'IC 1396', ra: 324.7, dec: 57.5, r: 1.3, q: 0.95, pa: 0, kind: 0, mu: 23.8, col: RED, noise: 0.65 },
  { name: 'Veil', ra: 312.75, dec: 30.7, r: 1.45, q: 0.92, pa: 0, kind: 0, mu: 23.6, col: TEAL, noise: 0.8, ring: 1.0, rw: 0.06 },
  // ---- Sagittarius / Scorpius / Ophiuchus
  { name: 'Lagoon', ra: 270.92, dec: -24.38, r: 0.5, q: 0.55, pa: 90, kind: 0, mu: 19.6, col: PINK, noise: 0.5 , fallback: true },
  { name: 'Trifid', ra: 270.6, dec: -23.03, r: 0.12, q: 1, pa: 0, kind: 0, mu: 21.0, col: PINK, noise: 0.45 , fallback: true },
  { name: 'Trifid blue', ra: 270.62, dec: -22.9, r: 0.1, q: 1, pa: 0, kind: 1, mu: 21.7, col: BLUE, noise: 0.3 , fallback: true },
  { name: 'M16', ra: 274.7, dec: -13.8, r: 0.2, q: 0.85, pa: 0, kind: 0, mu: 21.9, col: PINK, noise: 0.8 },
  { name: 'M16 halo', ra: 274.72, dec: -13.75, r: 0.45, q: 0.85, pa: 20, kind: 0, mu: 23.8, col: RED, noise: 0.85 },
  { name: 'M17', ra: 275.2, dec: -16.18, r: 0.1, q: 0.5, pa: 120, kind: 0, mu: 20.4, col: PINK, noise: 0.6 },
  { name: 'M17 halo', ra: 275.15, dec: -16.15, r: 0.32, q: 0.75, pa: 110, kind: 0, mu: 23.2, col: RED, noise: 0.8 },
  { name: 'NGC 6334', ra: 260.2, dec: -35.95, r: 0.3, q: 0.8, pa: 0, kind: 0, mu: 22.4, col: RED, noise: 0.7 },
  { name: 'NGC 6357', ra: 261.2, dec: -34.3, r: 0.3, q: 0.8, pa: 0, kind: 0, mu: 22.6, col: RED, noise: 0.7 },
  { name: 'IC 4628', ra: 254.3, dec: -40.33, r: 0.5, q: 0.8, pa: 0, kind: 0, mu: 23.7, col: RED, noise: 0.7 },
  { name: 'Rho Oph blue', ra: 246.4, dec: -23.45, r: 0.55, q: 0.85, pa: 0, kind: 1, mu: 22.0, col: BLUE, noise: 0.5 , fallback: true },
  { name: 'Antares nebula', ra: 247.35, dec: -26.43, r: 0.45, q: 0.9, pa: 0, kind: 1, mu: 21.6, col: [1.25, 0.95, 0.5], noise: 0.4 },
  { name: 'Sh2-9', ra: 245.3, dec: -25.6, r: 0.45, q: 0.9, pa: 0, kind: 0, mu: 23.2, col: RED, noise: 0.6 , fallback: true },
  { name: 'NGC 6726/6727 (R CrA)', ra: 285.17, dec: -36.9, r: 0.09, q: 0.75, pa: 150, kind: 1, mu: 20.4, col: BLUE, noise: 0.35 },
  { name: 'IC 4812', ra: 284.83, dec: -37.05, r: 0.05, q: 0.8, pa: 0, kind: 1, mu: 22.2, col: BLUE, noise: 0.3 },
  { name: 'Sh2-27', ra: 249.3, dec: -10.57, r: 4.2, q: 0.9, pa: 0, kind: 0, mu: 25.0, col: RED, noise: 0.7 },
  // ---- southern Milky Way
  { name: 'Carina core', ra: 161.2, dec: -59.75, r: 0.35, q: 0.8, pa: 60, kind: 0, mu: 19.0, col: PINK, noise: 0.5 , fallback: true },
  { name: 'Carina', ra: 161.0, dec: -59.6, r: 0.9, q: 0.75, pa: 60, kind: 0, mu: 20.8, col: PINK, noise: 0.7 , fallback: true },
  { name: 'IC 2944', ra: 174.5, dec: -63.0, r: 0.5, q: 0.8, pa: 0, kind: 0, mu: 23.4, col: RED, noise: 0.7 },
  { name: 'Gum Nebula', ra: 128.0, dec: -43.0, r: 15.0, q: 0.9, pa: 0, kind: 0, mu: 25.3, col: RED, noise: 0.8, ring: 0.75, rw: 0.35 },
  { name: 'Vela SNR', ra: 128.5, dec: -45.5, r: 3.4, q: 0.95, pa: 0, kind: 0, mu: 24.8, col: TEAL, noise: 0.85, ring: 0.8, rw: 0.3 },
  // ---- extragalactic: light totals from integrated V magnitudes
  { name: 'LMC disk', ra: 80.89, dec: -69.76, r: 2.0, q: 0.85, pa: 170, kind: 2, V: 1.05, col: [1.0, 0.98, 1.0], noise: 0.85 , fallback: true },
  { name: 'LMC bar', ra: 80.0, dec: -69.75, r: 0.95, q: 0.33, pa: 112, kind: 2, V: 2.9, col: [1.06, 1.0, 0.9], noise: 0.35 , fallback: true },
  { name: 'N44', ra: 80.9, dec: -67.95, r: 0.08, q: 0.8, pa: 0, kind: 0, mu: 21.8, col: PINK, noise: 0.5 , fallback: true },
  { name: 'N159/N160', ra: 84.9, dec: -69.7, r: 0.1, q: 0.6, pa: 0, kind: 0, mu: 21.6, col: PINK, noise: 0.5 , fallback: true },
  { name: 'Tarantula', ra: 84.68, dec: -69.1, r: 0.12, q: 0.9, pa: 0, kind: 0, mu: 20.0, col: PINK, noise: 0.45 , fallback: true },
  { name: 'N11', ra: 74.2, dec: -66.45, r: 0.1, q: 0.8, pa: 0, kind: 0, mu: 21.6, col: PINK, noise: 0.5 , fallback: true },
  { name: 'SMC', ra: 13.19, dec: -72.83, r: 0.85, q: 0.5, pa: 45, kind: 2, V: 2.8, col: [0.98, 0.98, 1.02], noise: 0.55 },
  { name: 'SMC wing', ra: 20.5, dec: -73.4, r: 0.7, q: 0.6, pa: 100, kind: 2, V: 4.6, col: [0.95, 0.98, 1.05], noise: 0.6 },
  { name: 'NGC 346', ra: 14.77, dec: -72.18, r: 0.06, q: 0.9, pa: 0, kind: 0, mu: 21.4, col: PINK, noise: 0.4 },
  { name: 'M31 disk', ra: 10.6847, dec: 41.269, r: 0.4, q: 0.31, pa: 38, kind: 2, V: 3.9, col: [1.0, 0.98, 0.96], noise: 0.25, lane: 1 },
  { name: 'M31 bulge', ra: 10.6847, dec: 41.269, r: 0.045, q: 0.75, pa: 45, kind: 2, V: 4.55, col: [1.12, 1.0, 0.82], noise: 0 },
  { name: 'M32', ra: 10.674, dec: 40.865, r: 0.012, q: 0.8, pa: 170, kind: 2, V: 8.1, col: [1.1, 1.0, 0.85], noise: 0 },
  { name: 'M110', ra: 10.092, dec: 41.685, r: 0.06, q: 0.5, pa: 170, kind: 2, V: 8.5, col: [1.05, 1.0, 0.9], noise: 0 },
  { name: 'M33', ra: 23.462, dec: 30.66, r: 0.17, q: 0.62, pa: 23, kind: 2, V: 5.7, col: [0.95, 0.98, 1.06], noise: 0.4 },
  { name: '47 Tuc', ra: 6.024, dec: -72.081, r: 0.035, q: 1, pa: 0, kind: 3, V: 4.09, col: [1.1, 1.0, 0.85], noise: 0.6 },
  { name: 'Omega Cen', ra: 201.697, dec: -47.479, r: 0.05, q: 0.93, pa: 100, kind: 3, V: 3.9, col: [1.08, 1.0, 0.88], noise: 0.6 },
];
