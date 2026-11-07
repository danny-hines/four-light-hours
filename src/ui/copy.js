// HUD copy: chapter kickers, subtitles, which facts to show, credits.
// Numbers NEVER live here: every figure on a title card comes from BODIES[id].facts (src/core/bodies-data.js).
// Subtitles are deliberately number-free (the one exception, Neptune's "four hours", restates its lightTime fact).

// Short classification line above the title (no numbers).
export const KICKER = {
  sun: 'Our star',
  mercury: 'Terrestrial planet',
  venus: 'Terrestrial planet',
  earth: 'Terrestrial planet',
  moon: 'Natural satellite of Earth',
  mars: 'Terrestrial planet',
  phobos: 'Moon of Mars',
  deimos: 'Moon of Mars',
  asteroids: 'Main belt',
  jupiter: 'Gas giant',
  io: 'Moon of Jupiter',
  europa: 'Moon of Jupiter',
  ganymede: 'Moon of Jupiter',
  callisto: 'Moon of Jupiter',
  saturn: 'Gas giant',
  titan: 'Moon of Saturn',
  enceladus: 'Moon of Saturn',
  uranus: 'Ice giant',
  neptune: 'Ice giant',
  triton: 'Moon of Neptune',
  finale: 'Looking back',
};

// One poetic, truthful line per chapter. Director chapters may override with `subtitle`.
export const SUBTITLE = {
  intro: 'Sunlight takes about four hours to reach the last planet. Follow it.',
  sun: 'The star that every world in this film is falling around.',
  mercury: 'The swiftest planet: scorched by day, frozen by night.',
  venus: 'Earth’s twin in size, sealed beneath a lid of sulphuric cloud.',
  earth: 'Home. A blue world under a layer of air as thin as a breath.',
  moon: 'Our companion, drifting a little farther from us every year.',
  mars: 'A rusted desert of giant volcanoes and dry riverbeds.',
  asteroids: 'Leftovers of planet-building — drawn here far denser than life.',
  jupiter: 'More massive than all the other planets put together.',
  saturn: 'Rings of ice as wide as worlds, and only a few storeys thick.',
  titan: 'A moon with a sky: orange haze over methane seas.',
  uranus: 'Knocked onto its side, it rolls around the Sun.',
  neptune: 'The last planet. Here, sunlight is four hours old.',
  triton: 'Pink nitrogen frost and dark geyser plumes, seen once by Voyager 2.',
  finale: 'Every planet, on a single night, seen from the edge.',
};

// Which facts (keys of BODIES[id].facts) a title card shows, in order: three, so a card reads at a glance. The
// distance from the Sun is not among them — the telemetry shows the true one on the epoch, and a "mean distance"
// beside it would read as a contradiction.
export const FACT_KEYS = {
  sun: ['diameter', 'core', 'mass'],
  mercury: ['year', 'day', 'temperature'],
  venus: ['day', 'temperature', 'pressure'],
  earth: ['diameter', 'day', 'temperature'],
  moon: ['distance', 'diameter', 'lightTime'],
  mars: ['day', 'temperature', 'highest'],
  jupiter: ['diameter', 'day', 'storm'],
  saturn: ['rings', 'density', 'moons'],
  uranus: ['tilt', 'year', 'temperature'],
  neptune: ['winds', 'year', 'moons'],
};

// Tighter wording for a few long fact values. Same numbers, fewer words: hud.js checks that every number here is
// exactly a number of BODIES[id].facts[key] (and falls back to the full value otherwise).
export const FACT_SHORT = {
  mercury: { day: '176 Earth days' },
  venus: { day: '243 Earth days, retrograde' },
  saturn: { rings: '280,000 km wide, mostly ~10 m thick' },
  uranus: { tilt: '97.8° — on its side' },
  neptune: { winds: 'Up to 2,100 km/h, fastest of any planet' },
};

export const FACT_LABEL = {
  distance: 'Mean distance',
  diameter: 'Diameter',
  day: 'Day',
  year: 'Year',
  temperature: 'Temperature',
  moons: 'Known moons',
  gravity: 'Gravity',
  pressure: 'Surface pressure',
  surface: 'Surface',
  core: 'Core',
  mass: 'Mass',
  lightToEarth: 'Light to Earth',
  life: 'Life',
  highest: 'Highest peak',
  storm: 'Storm',
  rings: 'Rings',
  density: 'Density',
  tilt: 'Axial tilt',
  winds: 'Winds',
  lightTime: 'Light-time',
};
// Per-body label overrides. The `distance` facts are mean (semi-major-axis) distances, while the telemetry shows
// the true distance on the epoch date — so the card says "Mean distance".
export const FACT_LABEL_FOR = {
  moon: { distance: 'Mean distance', lightTime: 'Light to Earth' },
  mercury: { day: 'Solar day' },
  saturn: { rings: 'Main rings' },
};

// Timeline names: the chapter title when it fits its segment, else this short form.
export const TIMELINE_SHORT = { intro: 'Opening', sun: 'Sun', earth: 'Earth', asteroids: 'Belt', finale: 'Solar System' };

export const CREDITS = [
  ['Planet positions', 'JPL Keplerian elements (E. M. Standish)'],
  ['Orientation', 'IAU WGCCRE rotational elements'],
  ['Imagery and terrain', 'NASA · JPL · USGS Astrogeology'],
  ['Coastlines', 'Natural Earth'],
  ['Stars', 'Yale Bright Star Catalogue (BSC5)'],
  ['Type', 'Jost · Cormorant Garamond (SIL OFL)'],
];

export const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII', 'XIII', 'XIV', 'XV', 'XVI', 'XVII', 'XVIII', 'XIX', 'XX'];
