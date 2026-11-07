// Procedural surface of the Galilean moons: ONE program for all four (uKind selects 0 Io, 1 Europa, 2 Ganymede,
// 3 Callisto; the per-moon switches are uniforms, so the four materials share a single compiled program). Requires
// JUP_COMMON. moonSurface returns the (pre-albedo-scale) linear albedo and a perturbed body-local normal. Every
// procedural feature is footprint-filtered (fp = pixel footprint in moon radii): it appears only once it spans a few
// pixels, and thresholded edges are anti-aliased by the footprint, so nothing speckles or crawls. Below the USGS maps'
// resolution (~1-6 km/px) the detail takes over.
//
//   impacts (Europa sparse, Ganymede, Callisto saturated): power-law size-frequency distribution (one octave per halving
//     of size), per-crater age-driven depth and rim degradation, ellipticity and polygonal wobble, flat floors and
//     central peaks or central pits for the large ones, bright ejecta and rays for the young ones
//   Europa: great-circle and cycloid lineae with double-ridge profiles (two bright crests, dark central trough, reddish
//     diffuse margins), cross-cutting generations
//   Ganymede: grooved sulci, the groove orientation changing from swath to swath
//   Io: no impact craters - irregular dark paterae with diffuse halos and rare Pele-type red rings, sulfur mottling,
//     white SO2 frost, glowing hot spots on the night side
export const MOON_DETAIL = /* glsl */ `
uniform int uKind;
uniform int uI0;           // always 0 (loop bounds that are not compile-time constants: real loops, fast FXC compile)
uniform int uNArcs;        // Europa: number of global lineae (0 for the others)
uniform vec4 uArcs[96];    // Europa lineae: [2i] = great-circle normal xyz, start angle; [2i+1] = length, width (rad), age, cycloid amp
uniform vec4 uCrat;        // impacts: x = relief strength (0 = none), y = largest crater-tile scale (radii)
uniform sampler2D uCraterT;  // bake.js craterTile: r height, gb gradient, a fresh / floor
uniform vec2 uCratS;       // its decode scales (height, gradient)
uniform int uNVolc;        // Io: number of hot spots
uniform vec4 uVolc[10];    // Io hot spots: xyz = unit centre, w = radius km (sign: strength packed in uVolcS)
uniform vec4 uVolcS[3];    // hot-spot strengths, 4 per vec4

uniform sampler2D uNoise;  // bake.js noiseTile: tileable 2-D gradient noise, 32 lattice cells per tile (r value, gb gradient)

const vec3 LUMM = vec3(0.2126, 0.7152, 0.0722);

// tri-planar gradient noise at x (lattice units) on the sphere point with normal nrm; w = footprint (lattice units).
// Returns (value, d/dx): three fetches instead of a 3-D simplex evaluation.
vec4 triNoise(vec3 x, vec3 nrm, float w) {
  vec3 bw = nrm * nrm;
  bw *= bw;
  bw /= bw.x + bw.y + bw.z;
  vec2 gw = vec2(w / 32.0, 0.0);
  vec3 tx = textureGrad(uNoise, x.yz / 32.0, gw, gw.yx).rgb;
  vec3 ty = textureGrad(uNoise, x.zx / 32.0 + 0.31, gw, gw.yx).rgb;
  vec3 tz = textureGrad(uNoise, x.xy / 32.0 + 0.67, gw, gw.yx).rgb;
  float v = (tx.r * bw.x + ty.r * bw.y + tz.r * bw.z) * 2.0 - 1.0;
  vec3 gx = (tx - 0.5) * 5.0, gy = (ty - 0.5) * 5.0, gz = (tz - 0.5) * 5.0;
  return vec4(v, vec3(gy.b * bw.y + gz.g * bw.z, gx.g * bw.x + gz.b * bw.z, gx.b * bw.x + gy.g * bw.y));
}

float fbm3(vec3 p, int oct, float fp, float lam0, float gain, out vec3 grad) {
  float s = 0.0, a = 1.0, lam = lam0;
  grad = vec3(0.0);
  for (int i = 0; i < oct + uI0; i++) {
    float fade = smoothstep(1.5, 4.0, lam / fp);
    if (fade <= 0.0) break;
    vec4 n = triNoise(p / lam + float(i) * vec3(5.3, 1.7, 9.1), p, fp / lam);
    s += n.x * a * fade;
    grad += n.yzw * (a * fade / lam);
    a *= gain;
    lam *= 0.5;
  }
  return s;
}

// tangent frame at p (unit sphere)
void tframe(vec3 p, out vec3 e1, out vec3 e2) {
  vec3 a = abs(p.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  e1 = normalize(cross(a, p));
  e2 = cross(p, e1);
}

// ---- impact craters from the baked crater tile (bake.js craterTile), tri-planar at three scales (each 2.5x finer):
// h = height (radii), grad = tangential gradient, fresh = ejecta brightness, flo = floor mask
float craterField(vec3 p, float fp, out vec3 grad, out float fresh, out float flo) {
  vec3 bw = p * p;
  bw *= bw;
  bw *= bw;
  bw /= bw.x + bw.y + bw.z;
  float h = 0.0, lam = uCrat.y;
  grad = vec3(0.0);
  fresh = 0.0;
  flo = 0.0;
  for (int o = 0; o < 3 + uI0; o++) {
    // the tile spans lam radii; its smallest craters (2.5 px of 512) must cover a few screen pixels
    float fade = smoothstep(1.0, 3.0, lam * 0.012 / fp) * mix(0.4, 1.0, smoothstep(0.004, 0.0012, fp));
    if (fade <= 0.0) break;
    vec3 x = p / lam + float(o) * vec3(0.37, 0.61, 0.13);
    vec2 gw = vec2(fp / lam, 0.0);
    vec4 tx = textureGrad(uCraterT, x.yz, gw, gw.yx), ty = textureGrad(uCraterT, x.zx, gw, gw.yx), tz = textureGrad(uCraterT, x.xy, gw, gw.yx);
    vec4 t = tx * bw.x + ty * bw.y + tz * bw.z;
    vec3 gx = (tx.rgb - 0.5) * 2.0, gy = (ty.rgb - 0.5) * 2.0, gz = (tz.rgb - 0.5) * 2.0;
    grad += vec3(gy.b * bw.y + gz.g * bw.z, gx.g * bw.x + gz.b * bw.z, gx.b * bw.x + gy.g * bw.y) * (uCratS.y * fade);
    h += (t.r * 2.0 - 1.0) * uCratS.x * lam * fade;
    fresh = max(fresh, (t.a * 2.0 - 1.0) * fade);
    flo = max(flo, (1.0 - 2.0 * t.a) * fade);
    lam *= 0.4;
  }
  return h;
}

// double-ridge profile across a lineament at signed distance s (in units of its half-width)
void ridgeProfile(float s, float age, inout float hgt, inout float ds, inout float dark, inout float brt) {
  float a = abs(s);
  float crest = exp(-(a - 0.55) * (a - 0.55) / 0.06);
  float trough = exp(-a * a / 0.03);
  float margin = exp(-a * a / 2.2);
  float fr = 1.0 - 0.7 * age;
  hgt += (crest - 0.6 * trough) * fr;
  ds += (crest * -2.0 * (a - 0.55) / 0.06 * sign(s) - 0.6 * trough * (-2.0 * s / 0.03)) * fr;
  brt = max(brt, crest * fr * 0.6);
  dark = max(dark, max(trough * 0.9, margin * 0.55) * (0.35 + 0.65 * fr));
}

vec3 moonSurface(vec3 p, float lat, vec3 base, vec3 baseLo, float fp, float Rkm, out vec3 nLoc) {
  vec3 g;
  float n = fbm3(p, 7, fp, 0.05, 0.5, g);
  vec3 alb = base;
  float lum = dot(base, LUMM), lumLo = dot(baseLo, LUMM);
  vec3 relief = g * (uKind == 1 ? 0.00025 : 0.0005);
  vec3 t1, t2;
  tframe(p, t1, t2);
  if (uKind == 0) {
    // ---------------------------------------------------------------- Io
    // the USGS colour is an enhanced Galileo SSI composite (greenish); real Io is sulfur-yellow/cream with orange-red
    // and white frost. Shift green toward yellow-orange, keep ~85% saturation.
    vec3 c = base * vec3(1.06, 0.97, 0.9);
    alb = mix(vec3(dot(c, LUMM)), c, 0.88) * (1.0 + 0.07 * n);
    // below the map's resolution (5.6 km/px): sulfur-plains mottling (orange-tan flows, pale SO2-rich patches) and
    // white frost, all soft-edged; the two fields come from the same noise (its value and its gradient direction)
    float fineI = smoothstep(0.0022, 0.0007, fp);
    float mot = n * 1.6, mot2 = dot(g, vec3(0.031, -0.022, 0.027));
    vec3 tint = mix(vec3(1.0), vec3(1.1, 0.9, 0.7), smoothstep(-0.1, 0.55, mot));
    tint = mix(tint, vec3(1.02, 1.03, 1.05), smoothstep(0.15, 0.7, mot2) * 0.6);
    alb = mix(alb, alb * tint, fineI);
    alb = mix(alb, vec3(0.92, 0.9, 0.84) * max(lum, 0.5) * 1.1, smoothstep(0.35, 0.95, -mot2) * 0.22 * fineI * (1.0 - smoothstep(0.6, 1.1, abs(lat))));
    // paterae below the map resolution: dark lava floors where the relief noise is lowest, with diffuse dark-orange
    // pyroclastic halos around them (no impact craters on Io)
    float pz = n + 0.6 * mot2;
    float pat = smoothstep(-0.55, -0.68, pz) * fineI;
    float halo = smoothstep(-0.3, -0.55, pz) * (1.0 - pat) * fineI;
    alb = mix(alb, mix(alb, vec3(0.5, 0.3, 0.16) * 0.7, 0.55), halo * 0.5);
    alb = mix(alb, mix(vec3(0.035, 0.032, 0.027), vec3(0.07, 0.072, 0.045), smoothstep(-0.3, 0.3, mot2 * 4.0)), pat * 0.95);
    relief *= 1.0 + 3.0 * smoothstep(0.45, 0.85, n);     // Io's isolated massifs rise up to ~17 km
  } else if (uKind == 1) {
    // ---------------------------------------------------------------- Europa
    // water ice; tan-brown lineae and chaos; the trailing hemisphere (+90 E here) is darker and redder (Io-plasma sulfur)
    float trail = 0.5 + 0.5 * dot(p, vec3(0.0, 0.0, -1.0));
    vec3 ice = vec3(1.0, 0.97, 0.92);
    vec3 dirt = mix(vec3(0.72, 0.52, 0.38), vec3(0.62, 0.42, 0.28), trail);
    float rel = lum / max(lumLo, 1e-3);
    // the map is equalised (process_europa_v3.py); its darker-than-average terrain is the reddish-brown mottled/chaos
    // material, its fine dark detail the lineae
    float broad = smoothstep(1.0, 0.8, lumLo / max(dot(textureLod(uMap, vec2(0.5), 12.0).rgb, LUMM), 1e-3));
    float dkMap = clamp(0.95 * smoothstep(1.0, 0.84, rel), 0.0, 1.0) * mix(1.0, 0.5, smoothstep(0.002, 0.0004, fp));
    alb = lum * mix(ice, dirt, clamp(max(dkMap, 0.8 * broad), 0.0, 1.0)) * mix(1.0, 0.9, trail * trail) * (1.0 - 0.18 * broad);
    // global lineae: great-circle arcs and cycloid chains with double-ridge profiles (cross-cutting generations)
    float hgt = 0.0, dk = 0.0, br = 0.0;
    vec3 hg = vec3(0.0);
    for (int i = 0; i < uNArcs; i++) {
      vec4 A = uArcs[2 * i], B = uArcs[2 * i + 1];
      float sd = dot(p, A.xyz);
      float w = B.y;
      if (abs(sd) > 6.0 * w + 0.05) continue;
      vec3 uu = normalize(cross(A.xyz, vec3(0.31, 0.83, 0.47)));
      float ph = atan(dot(p, cross(A.xyz, uu)), dot(p, uu));
      float rel0 = mod(ph - A.w + 6.2832, 6.2832);
      if (rel0 > B.x) continue;
      float taper = smoothstep(0.0, 0.06, rel0) * smoothstep(B.x, B.x - 0.06, rel0);
      float cyc = B.w * (abs(sin(ph * 38.0 + float(i))) - 0.6);
      float vis = smoothstep(0.7, 2.0, w / fp) * taper;
      // sub-pixel lineae: area-weighted darkening only (no aliasing)
      dk = max(dk, 0.35 * taper * smoothstep(3.0 * fp, 0.0, abs(sd - cyc)) * min(w / fp, 1.0) * (1.0 - vis));
      float hh = 0.0, dsd = 0.0, dd = 0.0, bb = 0.0;
      ridgeProfile((sd - cyc) / w, B.z, hh, dsd, dd, bb);
      hgt += hh * vis * w;
      hg += A.xyz * dsd * vis;
      dk = max(dk, dd * vis);
      br = max(br, bb * vis);
    }
    alb = mix(alb, alb * vec3(0.62, 0.47, 0.36), dk * 0.85);
    alb = mix(alb, alb * 1.15, br);
    alb *= 1.0 + 0.035 * n;
    relief += hg * 0.012;
  } else if (uKind == 2) {
    // ---------------------------------------------------------------- Ganymede
    // dark ancient terrain + bright grooved sulci, rayed craters, central-pit craters, polar frost
    alb = mix(vec3(lum), base, 0.85);
    float bright = smoothstep(0.17, 0.27, lum);
    // grooves (spacing 6-13 km): the orientation turns from swath to swath (a coarse noise picks one of two families
    // and rotates it), and the ridges truncate at the swath boundaries
    vec4 sw = vec4(n, g * 0.05);       // the swath field: the relief noise's value and gradient
    float a = 1.3 * step(0.0, sw.x) + 0.7 * sw.x + 0.5;
    vec3 gd = t1 * cos(a) + t2 * sin(a);
    float sp = mix(0.0035, 0.0075, 0.5 + 0.5 * sw.y / max(length(sw.yzw), 1e-3));
    float ph = dot(p, gd) / sp * 6.2832 + 30.0 * n;
    float gfade = smoothstep(3.0, 6.0, sp / fp) * bright * smoothstep(0.0, 0.25, abs(sw.x));
    alb *= 1.0 + 0.11 * sin(ph) * gfade;
    relief += gd * cos(ph) * (6.2832 / sp) * 0.00009 * gfade;
    alb *= 1.0 + 0.06 * n;
  } else {
    // ---------------------------------------------------------------- Callisto: dark, ancient, saturated with craters
    alb = lum * vec3(1.03, 0.95, 0.85) * (1.0 + 0.1 * n);
  }
  if (uCrat.x > 0.0) {
    vec3 cg; float fr, fl;
    float ch = craterField(p, fp, cg, fr, fl);
    relief += cg * (0.85 * uCrat.x);
    if (uKind == 1) alb = mix(alb, alb * 1.1, fr * 0.4);
    else if (uKind == 2) {
      float bright = smoothstep(0.17, 0.27, lum);
      alb = mix(alb, max(alb, vec3(0.42, 0.41, 0.39)), fr * (0.4 + 0.4 * smoothstep(-0.2, 0.5, n)));
      alb *= 1.0 - 0.12 * fl * (1.0 - bright);
    } else {
      // frost on rims and high ground, dark lag on the floors
      alb = mix(alb, max(alb * 1.8, vec3(0.16, 0.155, 0.145)), clamp(fr * 0.7 + smoothstep(0.0, 0.004, ch) * 0.35, 0.0, 1.0) * (0.4 + 0.6 * smoothstep(-0.3, 0.5, n)));
      alb *= 1.0 - 0.25 * fl;
    }
  }
  vec3 gt = relief - p * dot(relief, p);
  nLoc = normalize(p - gt);
  return alb;
}

// Io's active hot spots glowing at ~1,300-1,600 K (night side and eclipse; Galileo / New Horizons)
vec3 moonEmission(vec3 p, float mu0, float fp, float Rkm) {
  vec3 e = vec3(0.0);
  for (int i = 0; i < uNVolc; i++) {
    vec4 V = uVolc[i];
    float d = length(p - V.xyz) * Rkm;
    float r = max(V.w, fp * Rkm * 1.5);                 // never smaller than a pixel or two
    vec4 S4 = uVolcS[i / 4];
    int k = i - 4 * (i / 4);
    float st = k == 0 ? S4.x : (k == 1 ? S4.y : (k == 2 ? S4.z : S4.w));
    e += st * exp(-d * d / (r * r)) * (V.w * V.w) / (r * r);
  }
  return e * vec3(1.0, 0.34, 0.08) * 0.35 * (0.1 + 0.9 * smoothstep(0.08, -0.05, mu0));
}
`;

// Io's hot spots: (lat, east lon) deg, radius km, strength
export const IO_VOLCANOES = [
  [13.0, 51.0, 35.0, 1.0],   // Loki Patera
  [-19.0, 105.0, 14.0, 0.8], // Pele
  [-12.0, 116.0, 12.0, 0.5], // Pillan
  [-28.0, 150.0, 12.0, 0.45], // Marduk
  [-2.0, -153.0, 12.0, 0.5], // Prometheus
  [24.0, -115.0, 12.0, 0.35], // Amirani
  [63.0, -124.0, 15.0, 0.55], // Tvashtar
  [-45.0, -56.0, 10.0, 0.3], // Masubi
  [-18.0, -37.0, 10.0, 0.35], // Kanehekili
  [-5.0, -39.0, 10.0, 0.3],  // Janus Patera
];

// Europa's global lineae (48 arcs), deterministic: great-circle normals, start angle, length, half-width, age, cycloid amp
export function europaArcs(THREE) {
  let s = 1234567;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  for (let i = 0; i < 48; i++) {
    const z0 = rnd() * 2 - 1, a = rnd() * Math.PI * 2;
    // no arc may run (nearly) along the equator: a ruler-straight equatorial line is unlike any real lineament set
    const z = Math.abs(z0) > 0.8 ? z0 * 0.55 : z0;
    const r = Math.sqrt(1 - z * z);
    const n = new THREE.Vector3(r * Math.cos(a), z, r * Math.sin(a));
    const start = rnd() * Math.PI * 2;
    const len = 0.4 + rnd() * 1.8;                       // 600 - 3,500 km
    const wKm = 0.9 + Math.pow(rnd(), 2.5) * 11;          // half-width 0.9 - 12 km (wide triple bands are rare)
    const age = rnd();
    const cyc = rnd() < 0.25 ? 0.006 + rnd() * 0.012 : 0;  // a quarter are cycloidal chains
    out.push(new THREE.Vector4(n.x, n.y, n.z, start), new THREE.Vector4(len, wKm / 1560.8, age, cyc));
  }
  return out;
}
