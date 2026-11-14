// FOUR LIGHT-HOURS — HUD: splash, cold-open title, chapter title cards, captions, telemetry, labels, closing
// credits, timeline and controls. All film-synchronous animation here is a pure function of the journey time t
// (so seek(t) and capture are deterministic); only the interactive chrome (controls, toasts) uses wall-clock time.
//
// URL parameters read here (in addition to main.js's):
//   splash=1     capture mode: show the splash screen (its finished, loaded state)
//   controls=1   capture mode: show the timeline + transport controls
//   labels=1     start with the planet-label overlay on (also the L key)
//   motion=0     behave as if prefers-reduced-motion were set
//   card=0       body-view: hide the inspection title card
//   fonts=0      skip the embedded web fonts (preview the system fallback stacks)
//   meter=0|1    0: legibility from the analytic brightness estimate only (the default during playback); 1: read the
//                frame back during playback too (capture stills always do, unless meter=0)
import { loadFonts } from './fonts.js';
import { css } from './style.js';
import { ICONS } from './icons.js';
import { KICKER, SUBTITLE, FACT_KEYS, FACT_LABEL, FACT_LABEL_FOR, FACT_SHORT, TIMELINE_SHORT, CREDITS, ROMAN } from './copy.js';
import * as F from './format.js';
import { orrerySVG, layoutOrreryLabels } from './orrery.js';
import { createLabels } from './labels.js';
import { matteBarPx } from '../core/frame.js';
import { createControls } from './controls.js';
import { createMeter } from './meter.js';
import { createComposer, textRects, unionRect } from './layout.js';
import { AU, KM_PER_UNIT, C_KM_S, TIME_SCALE, dateFromDays, poleVector, orbitalElements, eclToThree } from '../core/astro.js';

// One HUD unit: 1 CSS px at 1600x900, scaling up on large viewports (4K TV, projector) so the type keeps its
// proportion to the picture. Mirrors --u in style.js.
// Three forms: 'wide' (desktop, tablet, TV), 'narrow' (a portrait phone) and 'short' (a phone on its side or any
// letterbox-shaped window: landscape and <= 520 px tall), where the unit drops below 1 (floor 0.62). Mirrors the
// media queries in style.js.
export const formFor = (W, H) => (W > H && H <= 520 ? 'short' : W <= 760 ? 'narrow' : 'wide');
export const unitFor = (W, H) =>
  formFor(W, H) === 'short' ? Math.max(0.62, Math.min(1, H / 560)) : Math.max(1, Math.min(2.6, Math.min(H / 900, W / 1440)));

// "1 s = 20 min": how fast the simulated clock runs
const CLOCK_NOTE = `<span class="u" style="margin:0">1 s of film = ${TIME_SCALE % 60 === 0 ? TIME_SCALE / 60 + ' min' : TIME_SCALE + ' s'}</span>`;
const EPOCH_NOTE = '<span class="u" style="margin:0">planet positions</span>';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const easeOut = (a, b, x) => 1 - Math.pow(1 - clamp01((x - a) / (b - a)), 3);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// numbers inside a fact value get a touch more weight
const numHL = (s) => esc(s).replace(/([~−\-]?\d[\d,.]*)/g, '<b>$1</b>');

// rough visual albedo used only for the legibility estimate behind text
const ALBEDO = { mercury: 0.16, venus: 0.78, earth: 0.36, moon: 0.15, mars: 0.25, jupiter: 0.52, saturn: 0.47, uranus: 0.5, neptune: 0.42, io: 0.6, europa: 0.65, enceladus: 0.9, titan: 0.24, triton: 0.7 };

export async function create(ctx) {
  const { THREE, app, capture, BODIES, camera, positions, epochDays } = ctx;
  const visible = ctx.visible !== false;
  const params = new URLSearchParams(location.search);
  const VIEW = params.get('view') || 'journey';
  const SHOW_SPLASH = !capture || params.get('splash') === '1';
  const FORCE_CONTROLS = params.get('controls') === '1';
  const DEBUG_LAYOUT = params.get('hudlayout') === '1';
  const SLOW_MS = +(params.get('hudslow') || 25); // dev: frames slower than this record a per-section profile
  const reduceMotion = params.get('motion') === '0' || (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // fonts=0: skip the embedded fonts to preview the system fallbacks
  const fontStatus = params.get('fonts') === '0' ? { ok: false, families: [], error: 'disabled by fonts=0' } : await loadFonts();
  const style = document.createElement('style');
  style.id = 'flh-style';
  style.textContent = css();
  document.head.appendChild(style);

  // ---------------------------------------------------------------- id helpers
  const MOON = {}; // moonId -> { parent, data }
  for (const id in BODIES) for (const mid in BODIES[id].moons || {}) MOON[mid] = { parent: id, data: BODIES[id].moons[mid] };
  const dataOf = (id) => BODIES[id] || (MOON[id] && MOON[id].data) || null;
  const nameOf = (id) => {
    if (id === 'asteroids' || id === 'belt') return 'Main belt';
    const d = dataOf(id);
    return d ? d.name : String(id || '').replace(/^\w/, (c) => c.toUpperCase());
  };
  let bodies = null;
  const _p = new THREE.Vector3();
  function positionOf(id, simDays, out = new THREE.Vector3()) {
    if (id === 'sun') return out.set(0, 0, 0);
    if (positions[id]) return out.copy(positions[id]);
    const m = MOON[id];
    if (m && bodies && bodies[m.parent]) {
      const mm = bodies[m.parent].moons && bodies[m.parent].moons.find((x) => x.id === id);
      if (mm) return out.copy(positions[m.parent]).add(mm.positionAt(simDays));
    }
    return null;
  }
  const radiusOf = (id) => (dataOf(id) ? dataOf(id).radius : 0);
  const epochDate = dateFromDays(epochDays);

  // ---------------------------------------------------------------- DOM
  const root = document.createElement('div');
  root.id = 'flh-hud';
  if (capture) root.classList.add('flh-capture');
  if (!visible) root.style.display = 'none';
  root.innerHTML = `
    <div class="flh-layer flh-scrims"><div class="flh-scrim flh-scrim-bl"></div><div class="flh-scrim flh-scrim-tr"></div><div class="flh-scrim flh-scrim-c"></div><div class="flh-bands"></div></div>
    <div class="flh-layer flh-labels" aria-hidden="true"></div>
    <div class="flh-layer flh-overlay">
      <section class="flh-open" aria-live="polite" hidden></section>
      <section class="flh-card" aria-live="polite" hidden></section>
      <section class="flh-caption" aria-live="polite" hidden><span class="kick"></span><div class="txt"></div><div class="meta"></div></section>
      <section class="flh-end" hidden></section>
      <section class="flh-chap" aria-live="polite" hidden></section>
      <aside class="flh-tele" aria-label="Telemetry"></aside>
    </div>
    <div class="flh-toast" role="status"></div><i class="flh-probe"></i>`;
  document.body.appendChild(root);
  const $ = (s) => root.querySelector(s);
  const el = {
    scrimBL: $('.flh-scrim-bl'), scrimTR: $('.flh-scrim-tr'), scrimC: $('.flh-scrim-c'),
    labels: $('.flh-labels'), overlay: $('.flh-overlay'), open: $('.flh-open'), card: $('.flh-card'),
    caption: $('.flh-caption'), capKick: $('.flh-caption .kick'), capTxt: $('.flh-caption .txt'), capMeta: $('.flh-caption .meta'), end: $('.flh-end'), tele: $('.flh-tele'), toast: $('.flh-toast'), chap: $('.flh-chap'),
  };

  let toastTimer = 0;
  function toast(msg) {
    clearTimeout(toastTimer);
    if (!msg) return el.toast.classList.remove('on');
    el.toast.textContent = msg;
    el.toast.classList.add('on');
    toastTimer = setTimeout(() => el.toast.classList.remove('on'), 1400);
  }

  // ---------------------------------------------------------------- telemetry
  el.tele.innerHTML = `
    <div class="top"></div>
    <div class="cell" data-c="dist"><div class="k">From the Sun</div><div class="vv"><div class="v"></div><div class="v sm"></div></div></div>
    <div class="cell" data-c="lt"><div class="k">Light-time</div><div class="vv"><div class="v"></div></div></div>
    <div class="ruler" title="Light-time from the Sun, linear: the inner planets crowd the first few pixels"><div class="base"></div><div class="done"></div><div class="marks"></div><div class="me"></div></div>
    <div class="cell" data-c="spd"><div class="k">Apparent speed</div><div class="vv"><div class="v"></div></div></div>
    <div class="cell" data-c="utc"><div class="k">Sim. clock<span class="x">UTC</span></div><div class="vv"><div class="v"></div><div class="v sm"></div></div></div>
    <div class="cell" data-c="tgt"><div class="k">Target</div><div class="vv"><div class="v"></div><div class="v sm"></div></div></div>`;
  const tv = {};
  for (const c of el.tele.querySelectorAll('.cell')) {
    const vs = c.querySelectorAll('.v');
    tv[c.dataset.c] = { a: vs[0], b: vs[1] || null, la: null, lb: null, k: c.querySelector('.k'), cell: c };
  }
  const ruler = { me: el.tele.querySelector('.ruler .me'), done: el.tele.querySelector('.ruler .done'), marks: el.tele.querySelector('.ruler .marks'), max: 1 };
  {
    const PL = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
    ruler.max = positions.neptune.length() * 1.035;
    let h = '<div class="tk sun" style="left:0"></div>';
    for (const id of PL) {
      const f = (100 * positions[id].length()) / ruler.max;
      h += `<div class="tk${['jupiter', 'saturn', 'uranus', 'neptune'].includes(id) ? '' : ' in'}" style="left:${f.toFixed(2)}%"></div>`;
      if (['jupiter', 'saturn', 'uranus', 'neptune'].includes(id)) h += `<div class="tl" style="left:${f.toFixed(2)}%">${BODIES[id].name[0]}</div>`;
    }
    ruler.marks.innerHTML = h;
  }
  function setV(slot, which, html) {
    const o = tv[slot];
    const key = which === 'a' ? 'la' : 'lb';
    if (o[key] === html || !o[which]) return;
    o[key] = html;
    o[which].innerHTML = html;
  }
  const U = (n, u) => `<span class="n">${n}</span><span class="u">${u}</span>`;

  // ---------------------------------------------------------------- cards
  let chapters = [];
  let director = null;
  let finaleT0 = null; // start of the finale chapter (the telemetry's clock row shows the epoch from here)
  let cardKey = null, cardParts = null, cardRect = null;

  function factsFor(id) {
    const d = dataOf(id);
    if (!d || !d.facts) return [];
    const keys = (FACT_KEYS[id] || Object.keys(d.facts)).filter((k) => d.facts[k] != null).slice(0, 3);
    // a shorter wording is used only if its numbers are exactly the fact's numbers
    const nums = (x) => (String(x).match(/\d[\d,.]*/g) || []).join('|');
    const val = (k) => {
      const sh = FACT_SHORT[id] && FACT_SHORT[id][k];
      return sh && nums(sh) === nums(d.facts[k]) ? sh : d.facts[k];
    };
    return keys.map((k) => [(FACT_LABEL_FOR[id] && FACT_LABEL_FOR[id][k]) || FACT_LABEL[k] || k, val(k)]);
  }

  function finaleSub() {
    return `Every planet where it really is, on ${F.fmtDateLong(epochDate)}.`;
  }
  function cardInfo(ch, bodyId, extra = {}) {
    const id = bodyId;
    const kind = ch ? ch.kind : 'body';
    const fin = kind === 'finale' || id === 'finale';
    const sub = (ch && ch.subtitle) || (fin ? finaleSub() : SUBTITLE[id] || SUBTITLE[ch && ch.id] || '');
    return {
      key: extra.key || (ch ? 'ch:' + ch.index : 'body:') + id,
      numeral: ch ? ch.numeral : '',
      kicker: (ch && ch.kicker) || KICKER[id] || (fin ? KICKER.finale : '') || '',
      title: extra.title || (ch && ch.title) || nameOf(id),
      sub,
      facts: fin ? [] : factsFor(id),
      data: extra.data || '',
    };
  }

  // A director 'body' caption becomes a title card: its title and timing, our subtitle and BODIES facts, plus one
  // line of the director's computed data that the facts do not already say (e.g. "0.33 AU from the Sun · sunlight
  // takes 2 min 43 s", "Right now its north pole faces the Sun").
  // a quantity = number + the start of its unit ("15 °C" and "15 s" differ; "4 h" in "4 h 08 min" and "4 h 10 min" match)
  const NUM_RE = /(\d[\d,.]*\d|\d)\s*([^\s\d,.·—–-]{0,2})/g;
  const quantities = (x) => [...String(x).matchAll(NUM_RE)].map((m) => m[1] + '|' + (m[2] || '').toLowerCase());
  function cardInfoFromCaption(c, ch) {
    const id = c.id || (ch && (ch.body || ch.id));
    const base = cardInfo(ch && (ch.body === id || ch.id === id) ? ch : ch ? { ...ch, title: null, subtitle: null, kicker: null } : null, id, { key: 'cap:' + c.t0 + ':' + id, title: c.title });
    const d = dataOf(id);
    const factVals = d && d.facts ? Object.values(d.facts).map(String) : [];
    const nums = new Set();
    for (const v of factVals) for (const q of quantities(v)) nums.add(q);
    const words = (x) => new Set(String(x).toLowerCase().match(/[a-z]{4,}/g) || []);
    const subW = words(base.sub);
    const dup = (line) => {
      if (!line) return true;
      line = String(line);
      if (quantities(line).some((k) => nums.has(k))) return true;
      if (factVals.some((v) => v.length >= 8 && (v.includes(line) || line.includes(v)))) return true;
      const w = words(line);
      let common = 0;
      for (const x of w) if (subW.has(x)) common++;
      return w.size > 0 && common / w.size >= 0.5;
    };
    // what the telemetry will read beside the card (the camera's own distance and light-time)
    const camShot = director ? director.evaluate(Math.min(c.t1, c.t0 + 2)) : null;
    const camKm = camShot ? camShot.camPos.length() * KM_PER_UNIT : 0;
    const camAU = camKm / (AU * KM_PER_UNIT), camLT = camKm / C_KM_S;
    const ltBody = positions[id] ? (positions[id].length() * KM_PER_UNIT) / C_KM_S : null;
    // One clause of the director's data. Light-times are rewritten in the telemetry's format ("78 min 23 s" ->
    // "1 h 18 min 23 s", exact from the real distance); a clause whose every quantity is what the telemetry already
    // shows (within 1 %, or the clause's own rounding) is dropped instead of being stated twice.
    const clause = (x) => {
      if (!x) return null;
      let s = String(x);
      let quantities = 0, same = 0;
      const sunlit = /sunlight|light\b|left it/i.test(s);
      for (const d of F.durationsIn(s).reverse()) {
        if (!sunlit) continue;
        quantities++;
        let sec = d.seconds;
        if (ltBody != null && Math.abs(sec - ltBody) < 90) sec = ltBody;
        const tol = Math.max(0.01 * camLT, d.hasSeconds ? 1 : 30);
        if (camShot && Math.abs(sec - camLT) <= tol) same++;
        s = s.slice(0, d.index) + F.fmtLightTimeText(sec) + s.slice(d.index + d.text.length);
      }
      for (const m of s.matchAll(/(\d+(?:\.(\d+))?)\s*AU\b/g)) {
        quantities++;
        const v = +m[1], half = 0.5 * Math.pow(10, -(m[2] ? m[2].length : 0));
        if (camShot && Math.abs(v - camAU) <= Math.max(0.01 * camAU, half)) same++;
      }
      if (quantities && same === quantities) return null;
      if (ltBody != null && /^sunlight takes [^·]*$/i.test(s.trim()) && !/reach/i.test(s)) s = s.trim() + ' to reach ' + nameOf(id);
      return s;
    };
    const parts = [];
    for (const p of String(c.subtitle || '').split(/\s+·\s+/)) {
      const q = clause(p);
      if (q && !dup(q)) parts.push(q);
    }
    const uniq = (c.lines || []).map(clause).find((l) => l && !dup(l));
    if (uniq) parts.push(uniq);
    base.data = F.typo(parts.join(' · '));
    return base;
  }

  function cardHTML(info) {
    const letters = [...info.title.toUpperCase()].map((c) => `<span class="c">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('');
    return (
      `<div class="flh-kicker">${info.numeral ? `<span class="n">${info.numeral}</span><span class="bar"></span>` : ''}<span class="kk">${esc(info.kicker)}</span></div>` +
      `<h2 class="flh-title" aria-label="${esc(info.title)}">${letters}</h2>` +
      `<div class="flh-rule"></div>` +
      (info.sub ? `<p class="flh-sub">${esc(F.typo(info.sub))}</p>` : '') +
      (info.facts.length ? `<div class="flh-facts" style="--nf:${info.facts.length}">${info.facts.map(([k, v]) => `<div class="flh-fact"><div class="k">${esc(k)}</div><div class="v">${numHL(F.typo(v).replace(/([A-Z][a-z]+) (?=[A-Z][a-z]+)/g, '$1 '))}</div></div>`).join('')}</div>` : '') +
      (info.data ? `<p class="flh-data">${numHL(info.data)}</p>` : '')
    );
  }
  function buildCard(info) {
    el.card.innerHTML = cardHTML(info);
    cardParts = {
      kicker: el.card.querySelector('.flh-kicker'),
      letters: [...el.card.querySelectorAll('.flh-title .c')],
      title: el.card.querySelector('.flh-title'),
      rule: el.card.querySelector('.flh-rule'),
      sub: el.card.querySelector('.flh-sub'),
      facts: [...el.card.querySelectorAll('.flh-fact')],
      data: el.card.querySelector('.flh-data'),
    };
    cardLayout = null; // placed once the card is displayed
    cardRect = null;
  }
  let cardLayout = null, capLayout = null;
  // Long names ("The Solar System") must not run across the frame: shrink the title until its letters fit 44 % of
  // the width (the whole width on phones). scale < 1: the tighter variant used to clear a nearby limb.
  function fitTitleEl(T, scale = 1) {
    T.style.fontSize = '';
    const W = window.innerWidth, H = window.innerHeight, u = unitFor(W, H), form = formFor(W, H);
    const maxW = form === 'narrow' ? W - 40 : form === 'short' ? W * 0.5 : Math.min(W * 0.44, 860 * u);
    let fs = parseFloat(getComputedStyle(T).fontSize) * scale;
    if (scale !== 1) T.style.fontSize = fs.toFixed(1) + 'px';
    const bb = unionRect(textRects(T)); // the letters, not the block (which is as wide as the widest row)
    const w = bb ? bb.w : T.scrollWidth;
    if (w > maxW) {
      fs = Math.max(24, (fs * maxW) / w);
      T.style.fontSize = fs.toFixed(1) + 'px';
    }
    return fs;
  }

  // The card's beat: the name (letters, rule) and its line first, then the facts close behind, all solid ~2 s in, so
  // that at an 8 s beat the facts read at full opacity for ~4.7 s before the 1.2 s fade (FACT_* in seconds of the body
  // beat; SUB_* the subtitle; the fade-out is CARD_OUT).
  const FACT_AT = 1.2, FACT_STEP = 0.12, FACT_FADE = 0.6, SUB_IN = [0.7, 1.6];
  const CARD_OUT = (L) => Math.min(1.2, L * 0.18);
  // per-frame card animation; dt = seconds since the card started, out = 0..1 visibility envelope
  let lastCardSig = '';
  function animateCard(dt, out, dtBody = dt) {
    const P = cardParts;
    const sig = out.toFixed(3) + '|' + Math.min(dt, 4.5).toFixed(3) + '|' + Math.min(dtBody, 5).toFixed(3);
    if (sig === lastCardSig) return;
    lastCardSig = sig;
    el.card.style.opacity = out.toFixed(3);
    el.card.style.transform = out < 1 ? `translateY(${(-(1 - out) * 8).toFixed(2)}px)` : '';
    // two beats: the name and its line first; the facts arrive ~2 s later while the line steps back a little
    const subDim = 1 - 0.2 * smooth(FACT_AT, FACT_AT + 1, dtBody);
    if (reduceMotion) {
      const a = smooth(0.2, 1.2, dt).toFixed(3), ab = smooth(SUB_IN[0], SUB_IN[1], dtBody), af = smooth(FACT_AT, FACT_AT + 0.8, dtBody).toFixed(3);
      P.kicker.style.opacity = a;
      P.title.style.opacity = a;
      P.rule.style.opacity = a;
      if (P.sub) P.sub.style.opacity = (ab * subDim).toFixed(3);
      P.facts.forEach((f) => (f.style.opacity = af));
      if (P.data) P.data.style.opacity = af;
      return;
    }
    P.kicker.style.opacity = smooth(0.1, 0.9, dt).toFixed(3);
    const n = P.letters.length;
    const track = 1 - easeOut(0.2, 3.4, dt); // tracking settles in (toward the anchored edge)
    const fromRight = !!(cardLayout && cardLayout.cls.includes('at-r'));
    const step = Math.min(0.055, 0.6 / Math.max(1, n)); // a long name arrives as quickly as a short one
    for (let i = 0; i < n; i++) {
      const a0 = 0.22 + (fromRight ? n - 1 - i : i) * step;
      const a = smooth(a0, a0 + 0.95, dt);
      const y = (1 - easeOut(a0, a0 + 1.2, dt)) * 0.16;
      const st = P.letters[i].style;
      st.opacity = a.toFixed(3);
      st.transform = `translate(${(track * (fromRight ? i - (n - 1) : i) * 0.075).toFixed(3)}em, ${y.toFixed(3)}em)`;
    }
    P.rule.style.transform = `scaleX(${easeOut(0.5, 2.3, dt).toFixed(4)})`;
    if (P.sub) {
      P.sub.style.opacity = (smooth(SUB_IN[0], SUB_IN[1], dtBody) * subDim).toFixed(3);
      P.sub.style.transform = `translateY(${((1 - easeOut(SUB_IN[0], SUB_IN[1] + 0.4, dtBody)) * 9).toFixed(2)}px)`;
    }
    P.facts.forEach((f, j) => {
      const a0 = FACT_AT + j * FACT_STEP;
      f.style.opacity = smooth(a0, a0 + FACT_FADE, dtBody).toFixed(3);
      f.style.transform = `translateY(${((1 - easeOut(a0, a0 + FACT_FADE + 0.3, dtBody)) * 6).toFixed(2)}px)`;
    });
    const d0 = FACT_AT + 0.15 + P.facts.length * FACT_STEP;
    if (P.data) P.data.style.opacity = smooth(d0, d0 + FACT_FADE, dtBody).toFixed(3);
  }
  // when a chapter card is visible: [start, fade-out end] relative to the chapter start
  const cardWindow = (L) => [0, Math.max(2.2, Math.min(L - 0.6, 11.5))];

  // ---------------------------------------------------------------- placement (subject avoidance)
  // Candidate placements, in order of preference (the bias is what a candidate must save, in covered text area as
  // a fraction of the default card's text area, to be chosen). bl/br/tl = lower-left / lower-right / upper-left;
  // t = title 15 % smaller, n = narrower reflow (2-column facts), k = a single narrow column, c = short form
  // (name + subtitle only).
  const CANDS = {
    card: {
      wide: [['bl', 0], ['bl t', 0.006], ['br', 0.012], ['br t', 0.018], ['bl n', 0.02], ['br n', 0.026], ['bl n t', 0.028], ['br n t', 0.032], ['tl', 0.034], ['tl n', 0.04],
        ['bl k', 0.04], ['bl k t', 0.046], ['br k', 0.05], ['br k t', 0.056], ['bl c', 0.1], ['br c', 0.106], ['tl c', 0.112]],
      narrow: [['bl', 0], ['bl t', 0.008], ['tl', 0.03], ['tl t', 0.036], ['bl c', 0.1], ['tl c', 0.11]],
      // a phone on its side: the frame is short, so the short form is a near alternative, not a last resort
      short: [['bl', 0], ['br', 0.012], ['bl n', 0.02], ['br n', 0.026], ['bl c', 0.03], ['br c', 0.036], ['tl', 0.04], ['tl c', 0.05]],
    },
    caption: {
      wide: [['bl', 0], ['br', 0.012], ['bl n', 0.02], ['br n', 0.026], ['tl', 0.034], ['tl n', 0.04]],
      narrow: [['bl', 0], ['tl', 0.03]],
      short: [['bl', 0], ['br', 0.012], ['bl n', 0.02], ['br n', 0.026], ['tl', 0.034], ['tl n', 0.04]],
    },
  };
  const CLS = { br: 'at-r', tl: 'at-t', t: 'f-tight', n: 'f-narrow', k: 'f-col', c: 'f-compact' };
  const classesOf = (spec) => spec.split(' ').filter((k) => k !== 'bl').map((k) => CLS[k]);
  const ALL_LAYOUT_CLS = Object.values(CLS);
  const layoutCache = new Map();
  let curShot = null; // the shot being drawn (body view has no director timeline)
  const lbFor = (shot, W, H) => {
    const barPx = matteBarPx(W, H);
    return W / H >= 1.2 && barPx < H * 0.2 ? barPx * clamp01(shot.letterbox || 0) : 0;
  };
  // rows of visible text of a card / caption element: [{x,y,w,h,stage}] ('name' shows from the arrival, 'body' at the beat)
  function rowsOf(e, kind) {
    const out = [];
    const add = (sel, stage, box = false) => {
      for (const x of e.querySelectorAll(sel)) {
        if (box) {
          const b = x.getBoundingClientRect();
          if (b.width > 0) out.push({ x: b.left, y: b.top - 2, w: b.width, h: b.height + 4, stage });
        } else for (const r of textRects(x)) out.push({ ...r, stage });
      }
    };
    if (kind === 'card') {
      add('.flh-kicker', 'name');
      add('.flh-title', 'name');
      add('.flh-rule', 'name', true);
      add('.flh-sub', 'body');
      add('.flh-fact', 'body');
      add('.flh-data', 'body');
    } else {
      add('.kick', 'name');
      add('.txt', 'name');
      add('.meta', 'name');
    }
    return out;
  }
  /**
   * Choose where a text block goes for its whole beat. win = { pre?, t0, t1 } in journey time, or null to use the
   * current shot (body view). Returns { spec, cls[], rows, top, lb } — rows measured at lb (the letterbox inset).
   */
  function chooseLayout(kind, e, key, win) {
    const W = window.innerWidth, H = window.innerHeight, u = unitFor(W, H);
    const ck = `${kind}|${key}|${W}x${H}`;
    if (layoutCache.has(ck)) return layoutCache.get(ck);
    const tA = performance.now();
    let tCov = 0;
    const form = formFor(W, H);
    let cands = CANDS[kind][form];
    if (VIEW === 'body') cands = cands.filter(([s]) => !/\bc\b/.test(s)); // inspection: always the full card
    const lbNow = curShot ? lbFor(curShot, W, H) : 0;
    // the frames this block will be seen over
    const samples = [];
    if (win && director && VIEW !== 'body') {
      const a = win.pre ?? win.t0, b = win.t1;
      const n = Math.max(4, Math.min(14, Math.round((b - a) / 0.6)));
      for (let i = 0; i < n; i++) {
        const ts = a + ((b - a) * (i + 0.5)) / n;
        const shot = director.evaluate(ts);
        const stages = new Set(win.pre != null && ts < win.t0 ? ['name'] : ['name', 'body']);
        // how visible the block is at ts (fade-in from its start, fade-out over its last ~1.4 s)
        const L = win.t1 - win.t0;
        const wt = Math.max(0.15, smooth(a, a + 1, ts) * (1 - smooth(L - (kind === 'card' ? CARD_OUT(L) : Math.min(1.4, L * 0.2)), L, ts - win.t0)));
        samples.push({ S: composer.snapshot(shot, W, H, { u }), stages, dy: lbFor(shot, W, H) - lbNow, wt });
      }
    } else if (curShot) samples.push({ S: composer.snapshot(curShot, W, H, { u }), stages: new Set(['name', 'body']), dy: 0 });
    // measure every candidate on an invisible clone (no transforms, full opacity)
    const clone = e.cloneNode(true);
    clone.removeAttribute('hidden');
    clone.removeAttribute('aria-live');
    clone.style.cssText = '';
    const base = kind === 'card' ? 'flh-card' : 'flh-caption';
    el.overlay.appendChild(clone);
    const T = clone.querySelector('.flh-title');
    const teles = win && director && VIEW !== 'body' ? teleRectsOver(win.pre ?? win.t0, win.t1, W) : teleRect ? [teleRect] : [];
    let best = null, ref = 0;
    const table = [];
    for (const [spec, bias] of cands) {
      clone.className = [base, 'flh-measure', ...classesOf(spec)].join(' ');
      if (T) fitTitleEl(T, /\bt\b/.test(spec) ? 0.85 : 1);
      const rows = rowsOf(clone, kind);
      const area = rows.reduce((s, r) => s + r.w * r.h, 0);
      if (!ref) ref = area;
      const top = /\btl\b/.test(spec);
      const tc = performance.now();
      let { cost, mean, peak } = composer.coverage(rows, samples, ref, top);
      tCov += performance.now() - tc;
      // never on the telemetry, never off screen
      const bb = unionRect(rows);
      for (const tele of teles) if (bb && tele && bb.x < tele.x + tele.w + 12 && bb.x + bb.w > tele.x - 12 && bb.y < tele.y + tele.h + 12 && bb.y + bb.h > tele.y - 12) cost += 1;
      if (bb && (bb.x < 0 || bb.y < 0 || bb.x + bb.w > W || bb.y + bb.h > H)) cost += 1;
      const score = cost + bias;
      table.push([spec, +cost.toFixed(4), +mean.toFixed(4), +peak.toFixed(4)]);
      if (!best || score < best.score) best = { spec, score, cost, rows, top, fs: T ? T.style.fontSize : '' };
    }
    clone.remove();
    // Early exit: if the subject is clear of the text as the block starts to fade but then slides under it before
    // the fade is over (a disc growing as we close in), the block leaves sooner and faster (0.45 s), so its text is
    // never seen crossing the subject.
    let exit = null;
    if (win && director && VIEW !== 'body') {
      const L = win.t1 - win.t0;
      const tScan = Math.max(win.t0 + 2.5, win.t1 - (kind === 'card' ? CARD_OUT(L) : Math.min(1.4, L * 0.2)) - 1.2);
      const all = new Set(['name', 'body']);
      const covAt = (ts) => {
        const shot = director.evaluate(ts);
        return composer.coverage(best.rows, [{ S: composer.snapshot(shot, W, H, { u, labels: false }), stages: all, dy: lbFor(shot, W, H) - lbNow, wt: 1 }], ref, best.top).mean;
      };
      const c0 = covAt(tScan);
      if (c0 < 0.002) for (let ts = tScan + 0.1; ts <= win.t1 + 1e-6; ts += 0.1) if (covAt(ts) > Math.max(0.0025, c0 + 0.002)) { exit = ts - 0.05; break; }
    }
    const res = { spec: best.spec, cls: classesOf(best.spec), rows: best.rows, top: best.top, lb: lbNow, lift: curLift, cost: best.cost, fs: best.fs, table, exit };
    layoutCache.set(ck, res);
    (window.__hud.layout || (window.__hud.layout = {}))[key] = { spec: res.spec, cost: +res.cost.toFixed(4), table, rows: best.rows.map((r) => [r.x | 0, r.y | 0, r.w | 0, r.h | 0, r.stage]), win, exit, ms: +(performance.now() - tA).toFixed(1), covMs: +tCov.toFixed(1) };
    return res;
  }
  // apply a chosen layout to the live element
  function applyLayout(e, L) {
    for (const c of ALL_LAYOUT_CLS) e.classList.toggle(c, L.cls.includes(c));
  }
  // the chosen layout's text rows, shifted for the current letterbox (for label avoidance)
  let curLift = 0;
  function liveRows(L, lbCur) {
    if (!L) return [];
    const dy = (L.top ? 1 : -1) * (lbCur - L.lb) - (L.top ? 0 : curLift - (L.lift || 0));
    return L.rows.map((r) => ({ ...r, y: r.y + dy }));
  }

  // ---------------------------------------------------------------- cold open
  let openParts = null;
  function buildOpen(beat) {
    const words = String(beat.title || 'Four Light-Hours').split(/\s+/);
    el.open.innerHTML =
      `<div class="hd"><h1 class="t" aria-label="${esc(beat.title)}">${words.map((w) => `<span class="word">${[...w.toUpperCase()].map((c) => `<span class="c">${esc(c)}</span>`).join('')}</span>`).join('')}</h1>` +
      `<div class="r"></div></div><div class="ft"><p class="s">${esc(F.typo(beat.sub))}</p>` +
      (beat.line ? `<p class="l">${esc(F.typo(beat.line))}</p>` : '') + '</div>';
    openParts = { letters: [...el.open.querySelectorAll('.c')], rule: el.open.querySelector('.r'), sub: el.open.querySelector('.s'), line: el.open.querySelector('.l') };
  }
  let lastOpenSig = '';
  // dt: seconds since the beat began; L: its length. Returns how much of it is visible (for scrims and captions).
  function animateOpen(dt, L) {
    const k = Math.min(1, L / 7.5);
    const out = 1 - smooth(L - 1.6 * k, L, dt);
    const vis = out * smooth(0, 1.2 * k, dt);
    const sig = out.toFixed(3) + '|' + Math.min(dt, 6).toFixed(3);
    if (sig === lastOpenSig) return vis;
    lastOpenSig = sig;
    el.open.style.opacity = out.toFixed(3);
    const P = openParts;
    const n = P.letters.length;
    for (let i = 0; i < n; i++) {
      const a0 = i * 0.075 * k;
      const s2 = P.letters[i].style;
      s2.opacity = (reduceMotion ? smooth(0, 1.2 * k, dt) : smooth(a0, a0 + 1.4 * k, dt)).toFixed(3);
      if (!reduceMotion) s2.transform = `translateY(${((1 - easeOut(a0, a0 + 1.8 * k, dt)) * 0.12).toFixed(3)}em)`;
    }
    P.rule.style.transform = `scaleX(${(reduceMotion ? 1 : easeOut(1.0 * k, 3.0 * k, dt)).toFixed(4)})`;
    P.rule.style.opacity = smooth(1.0 * k, 1.8 * k, dt).toFixed(3);
    P.sub.style.opacity = smooth(1.8 * k, 3.1 * k, dt).toFixed(3);
    if (P.line) P.line.style.opacity = smooth(2.6 * k, 3.8 * k, dt).toFixed(3);
    return vis;
  }

  // ---------------------------------------------------------------- closing card
  let endParts = null;
  function buildEnd() {
    el.end.innerHTML =
      `<div class="t">Four Light-Hours</div><div class="r"></div>` +
      `<p class="s">${esc(F.typo(`The planets were drawn at their true sizes and distances, where they really were on ${F.fmtDateLong(epochDate)}.`))} ` +
      `${esc(lightLine(director ? director.duration : 0))}</p>` +
      `<div class="flh-credits">${CREDITS.map(([k, v]) => `<div class="flh-credit"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>` +
      `<div class="flh-end-actions off"><button class="flh-replay explore" type="button" tabindex="-1">Explore the worlds</button>` +
      `<button class="flh-replay again" type="button" tabindex="-1">Watch again</button></div>`;
    endParts = { t: el.end.querySelector('.t'), r: el.end.querySelector('.r'), s: el.end.querySelector('.s'), credits: [...el.end.querySelectorAll('.flh-credit')], replay: el.end.querySelector('.flh-end-actions'), buttons: [...el.end.querySelectorAll('.flh-replay')] };
    el.end.querySelector('.flh-replay.again').addEventListener('click', () => {
      app.seek(0);
      app.play();
    });
    el.end.querySelector('.flh-replay.explore').addEventListener('click', () => app.enterExplore && app.enterExplore('earth'));
  }
  // How far sunlight that left the Sun as the film began has got by its end — computed from the real distances.
  function lightLine(duration) {
    const PL = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
    const lt = (id) => (positions[id].length() * KM_PER_UNIT) / C_KM_S;
    let passed = null, next = null;
    for (const id of PL) {
      if (lt(id) <= duration) passed = id;
      else {
        next = id;
        break;
      }
    }
    const N = (id) => BODIES[id].name;
    if (!duration) return '';
    if (!passed) return `Sunlight that left the Sun as this film began has not yet reached ${N(next)}.`;
    if (!next) return `Sunlight that left the Sun as this film began has now passed Neptune.`;
    if (next === 'earth') return `Sunlight that left the Sun as this film began has passed ${N(passed)}, and has not yet reached us.`;
    return `Sunlight that left the Sun as this film began has passed ${N(passed)}, and has not yet reached ${N(next)}.`;
  }
  let lastEndSig = '';
  function animateEnd(dt, L) {
    const k = Math.max(0.6, Math.min(1, L / 7));
    const sig = Math.min(dt, 8).toFixed(3);
    if (sig === lastEndSig) return;
    lastEndSig = sig;
    const P = endParts;
    P.t.style.opacity = smooth(0, 1.6 * k, dt).toFixed(3);
    P.r.style.transform = `scaleX(${easeOut(0.5 * k, 2.4 * k, dt).toFixed(4)})`;
    P.s.style.opacity = smooth(1.2 * k, 2.6 * k, dt).toFixed(3);
    P.credits.forEach((c, j) => (c.style.opacity = smooth((2.6 + j * 0.22) * k, (3.5 + j * 0.22) * k, dt).toFixed(3)));
  }

  // ---------------------------------------------------------------- beats: when each text block shows
  // Built once at attach from the director's caption list when it has typed beats (kind: title | body | note |
  // credits), otherwise from the chapters. beats.open / beats.end: { t0, t1, ... }; beats.cards: [{ t0, t1, info }].
  const beats = { open: null, cards: [], end: null, arrivals: [], slates: [], labelHold: null };
  // a card beat's placement (the same one the card will use), measured on a temporary element
  function layoutOfBeat(b) {
    const tmp = document.createElement('section');
    tmp.className = 'flh-card';
    tmp.innerHTML = cardHTML(b.info);
    el.overlay.appendChild(tmp);
    try {
      return chooseLayout('card', tmp, b.info.key, { pre: b.pre, t0: b.t0, t1: b.t1 });
    } finally {
      tmp.remove();
    }
  }
  // does body `id`'s disc read on screen at journey time ts? (≥ 16 px across at 900 px tall, inside the frame,
  // clear of the Sun's disc and glare)
  function discReads(ts, id, W, H) {
    const shot = director.evaluate(ts);
    const d = composer.screenDisc(shot, id, W, H);
    if (!d) return false;
    const k = H / 900;
    if (d.r < 8 * k) return false;
    if (d.sx < 0.03 * W || d.sx > 0.97 * W || d.sy < 0.03 * H || d.sy > 0.97 * H) return false;
    const sn = d.S.items.find((x) => x.isSun);
    if (sn && d.S.glare && sn.c.z < 0) {
      const sx = W / 2 + (sn.c.x / -sn.c.z) * d.S.f, sy = H / 2 - (sn.c.y / -sn.c.z) * d.S.f;
      if (Math.hypot(d.sx - sx, d.sy - sy) < sn.rpx + 0.12 * H) return false;
    }
    return true;
  }
  function chapterAtT(t) {
    let ci = 0;
    for (let i = chapters.length - 1; i >= 0; i--)
      if (t >= chapters[i].t0 - 1e-6) {
        ci = i;
        break;
      }
    return chapters[ci];
  }
  function buildBeats(dur) {
    const caps = (director && Array.isArray(director.captions) ? director.captions : []).filter((c) => c && c.t0 != null && c.t1 != null);
    const title = caps.find((c) => c.kind === 'title');
    if (title) beats.open = { t0: title.t0, t1: title.t1, title: title.title || 'Four Light-Hours', sub: title.subtitle || SUBTITLE.intro, line: (title.lines || [])[0] || '' };
    else if (chapters.length && chapters[0].kind === 'intro') {
      const c = chapters[0], L = c.t1 - c.t0;
      beats.open = { t0: c.t0 + Math.min(1.5, L * 0.12), t1: c.t1 - Math.min(0.5, L * 0.05), title: 'Four Light-Hours', sub: SUBTITLE.intro, line: '' };
    }
    if (beats.open) buildOpen(beats.open);
    const bodyCaps = caps.filter((c) => c.kind === 'body');
    if (bodyCaps.length) {
      beats.cards = bodyCaps.map((c) => ({ id: c.id, t0: c.t0, t1: c.t1, info: cardInfoFromCaption(c, chapterAtT(c.t0 + 0.01)) }));
      // Arrival: when a chapter opens with travel and its own card comes seconds later, the name (kicker, title,
      // rule) appears as the destination swells from a point of light; subtitle and facts follow at the beat.
      // The name waits until the destination's disc actually reads (not a speck, not lost in the Sun's glare);
      // until then a reticle marks the point of light it is coming from.
      const W = window.innerWidth, H = window.innerHeight;
      for (const ch of chapters) {
        if (ch.kind === 'intro') continue;
        const first = beats.cards.find((b) => b.t0 >= ch.t0 - 1e-6 && b.t0 < ch.t1);
        if (!first || first.pre != null) continue;
        let pre = ch.t0 + 0.8;
        const prevEnd = Math.max(0, ...beats.cards.filter((b) => b !== first && b.t1 <= first.t0).map((b) => b.t1));
        if (!(first.t0 - pre > 1.5 && pre >= prevEnd + 0.3)) continue;
        // (a card with no world to arrive at — the finale's map — has no arrival stage: its chapter's slate names
        // it while the camera travels, and the card comes with the picture it describes)
        if (!positionOf(first.id, director.evaluate(pre).simDays)) continue;
        let seen = null;
        for (let ts = pre; ts <= first.t0 - 1.2 + 1e-6; ts += 0.2) if (discReads(ts, first.id, W, H)) { seen = ts; break; }
        beats.arrivals.push({ id: first.id, t0: ch.t0 + 0.4, t1: seen ?? first.t0 });
        if (seen == null) continue;
        first.pre = Math.round(seen * 10) / 10;
      }
    }
    if (!bodyCaps.length)
      beats.cards = chapters
        .filter((c) => c.kind !== 'intro' && c.card !== false)
        .map((c) => ({ id: c.body || c.id, t0: c.t0, t1: c.t0 + cardWindow(c.t1 - c.t0)[1], info: cardInfo(c, c.body || c.id) }));
    // Chapter slates: when a chapter opens with travel and its title card comes seconds later, a small
    // "II — Mercury" names the chapter in the card's corner from its first second, and gives way to the card.
    for (const ch of chapters) {
      if (ch.kind === 'intro') continue;
      const first = beats.cards.find((b) => b.t0 >= ch.t0 - 1e-6 && b.t0 < ch.t1);
      if (!first) continue;
      const start = first.pre ?? first.t0;
      if (start - ch.t0 < 2.6) continue;
      beats.slates.push({ t0: ch.t0 + 0.5, t1: start, numeral: ch.numeral, name: ch.title, beat: first });
    }
    // The finale's labelled map hands over to the zoom onto Earth and the pale blue dot: find both label beats
    // (director.evaluate is pure) and hold the planets' names across the gap between them, so they leave by the
    // frame edges as the field narrows and Earth keeps its name the whole way down.
    beats.labelHold = null;
    const fin = chapters.find((c) => c.kind === 'finale');
    if (fin && director) {
      let pl = null, pb = null;
      for (let ts = fin.t0; ts <= dur + 1e-6; ts += 0.25) {
        const L = director.evaluate(ts).labels;
        if (!Array.isArray(L)) continue;
        const planets = L.filter((l) => l && l.kind === 'planet');
        if (planets.length > 2) pl = pl ? { ...pl, t1: ts } : { t0: ts, t1: ts, ids: planets.map((l) => l.id) };
        if (L.some((l) => l && l.kind === 'pale-blue-dot')) pb = pb ? { ...pb, t1: ts } : { t0: ts, t1: ts };
      }
      if (pl && pb && pb.t0 > pl.t1 - 2 && pb.t0 - pl.t1 < 10) beats.labelHold = { t0: pl.t1 - 1.7, t1: pb.t0 + 1.8, from: pl.t1 - 1.2, to: pb.t0 + 0.3, ids: pl.ids };
    }
    const cred = caps.find((c) => c.kind === 'credits');
    if (cred) beats.end = { t0: cred.t0, t1: Math.max(cred.t1, cred.t0 + 3) };
    else {
      const fin = chapters.find((c) => c.kind === 'finale');
      const L = fin ? fin.t1 - fin.t0 : 0;
      const t0 = fin && L >= 22 ? Math.max(fin.t0 + cardWindow(L)[1] + 0.4, dur - 26) : fin ? fin.t0 + Math.min(1, L * 0.1) : Math.max(0, dur - 14);
      beats.end = { t0, t1: dur };
    }
    window.__hud.beats = { open: beats.open && [beats.open.t0, beats.open.t1], cards: beats.cards.map((b) => [b.info.title, b.pre != null ? +b.pre.toFixed(2) : null, +b.t0.toFixed(2), +b.t1.toFixed(2)]), end: [beats.end.t0, beats.end.t1], arrivals: beats.arrivals.map((a) => [a.id, +a.t0.toFixed(2), +a.t1.toFixed(2)]), slates: beats.slates.map((a) => [a.name, +a.t0.toFixed(2), +a.t1.toFixed(2)]), labelHold: beats.labelHold && [+beats.labelHold.t0.toFixed(2), +beats.labelHold.t1.toFixed(2)] };
  }

  // ---------------------------------------------------------------- captions
  let capKey = null, capWords = [];
  // A caption that says how high we are ("400 km up — ...") must agree with the telemetry's altitude beside it.
  // The film's real altitude over the caption is sampled from the director: if it matches (within 15 %) the line
  // stands; if it holds steady at another height the number is corrected; if the camera is far from that height
  // the number is kept but made to describe the orbit it belongs to, not the camera ("A low orbit 400 km up ...").
  const honestCache = new Map();
  function honestText(it, text) {
    const m = /(\d[\d,]*(?:\.\d+)?)\s*km up(?![A-Za-z])/i.exec(text);
    if (!m || !director || it.t0 == null || it.t1 == null) return text;
    const key = it.t0 + '|' + text;
    if (honestCache.has(key)) return honestCache.get(key);
    const N = +m[1].replace(/,/g, '');
    const alts = [];
    for (let i = 0; i < 9; i++) {
      const sh = director.evaluate(it.t0 + ((it.t1 - it.t0) * (i + 0.5)) / 9);
      const fp = sh.focus && positionOf(sh.focus, sh.simDays, new THREE.Vector3());
      if (fp) alts.push((fp.distanceTo(sh.camPos) - radiusOf(sh.focus)) * KM_PER_UNIT);
    }
    let out = text;
    if (alts.length) {
      const lo = Math.min(...alts), hi = Math.max(...alts);
      if (lo >= N * 0.85 && hi <= N * 1.15) out = text;
      else if (hi <= lo * 1.25) {
        const mean = alts.reduce((a, b) => a + b, 0) / alts.length;
        const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(mean)) - 1));
        out = text.slice(0, m.index) + `${F.group(Math.round(mean / p) * p)} km up` + text.slice(m.index + m[0].length);
      } else {
        const rest = text.slice(m.index + m[0].length).replace(/^\s*[—–-]\s*/, '');
        const om = /^an? (?:low )?orbit\s+(.*)$/i.exec(rest);
        if (om && m.index === 0) out = `A low orbit ${m[1]} km up ${om[1]}`;
        else if (m.index === 0) out = rest.replace(/^\w/, (c) => c.toUpperCase());
      }
    }
    honestCache.set(key, out);
    return out;
  }
  function normCaption(shot, t) {
    let c = shot.captions ?? shot.caption;
    if (!c) return null;
    if (typeof c === 'string') return { key: c, text: c, sub: '', alpha: 1, since: 99 };
    const list = Array.isArray(c) ? c : [c];
    let best = null;
    for (const raw of list) {
      if (!raw) continue;
      const it = typeof raw === 'string' ? { text: raw } : raw;
      if (it.kind === 'title' || it.kind === 'body' || it.kind === 'credits') continue; // rendered as open / card / end beats
      const hasLines = Array.isArray(it.lines) && it.lines.length > 0;
      const text = honestText(it, it.text || (hasLines ? it.lines.join(' ') : '') || it.title || it.body || '');
      if (!text) continue;
      let alpha = it.alpha != null ? +it.alpha : 1;
      let since = 99;
      if (it.t0 != null && it.t1 != null && it.alpha == null) {
        const fi = Math.min(0.9, (it.t1 - it.t0) * 0.25);
        alpha = smooth(it.t0, it.t0 + fi, t) * (1 - smooth(it.t1 - fi, it.t1, t));
      }
      if (it.t0 != null) since = t - it.t0;
      const kick = it.sub || it.kicker || (!it.text && hasLines ? it.title : '') || '';
      if (!best || alpha > best.alpha) best = { key: (it.id || '') + '|' + text, text: F.typo(text), sub: kick, meta: hasLines ? F.typo(it.subtitle || '') : '', alpha, since, t0: it.t0, t1: it.t1 };
    }
    return best && best.alpha > 0.001 ? best : null;
  }
  function fillCaption(root, c) {
    const kick = root.querySelector('.kick'), txt = root.querySelector('.txt'), meta = root.querySelector('.meta');
    kick.textContent = c.sub;
    kick.style.display = c.sub ? '' : 'none';
    // words fade in one by one; a no-break space keeps a number with its unit ("90 minutes")
    const words = c.text.split(/([ \t\n]+)/);
    txt.innerHTML = words.map((w) => (/^[ \t\n]+$/.test(w) ? w : `<span class="w">${esc(w)}</span>`)).join('');
    meta.innerHTML = c.meta ? numHL(c.meta) : '';
    meta.style.display = c.meta ? '' : 'none';
  }
  function buildCaption(c) {
    fillCaption(el.caption, c);
    capWords = [...el.capTxt.querySelectorAll('.w')];
  }
  // Placements are chosen ahead of time, a beat per idle slice, so that a card or caption never costs a frame
  // when it appears (they are cached by beat and viewport; a resize clears them and this runs again).
  let preQueue = null;
  function precomputeLayouts() {
    if (capture || VIEW === 'body' || !director) return;
    preQueue = [];
    for (const b of beats.cards) preQueue.push(['card', b]);
    for (const c of director.captions || []) if (c && c.kind !== 'title' && c.kind !== 'body' && c.kind !== 'credits' && c.t0 != null) preQueue.push(['caption', c]);
    const idle = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 400 }) : (f) => setTimeout(f, 30);
    const step = () => {
      if (!preQueue || !preQueue.length) return;
      // the next beat after the playhead first (then the following ones), so a seek is covered quickly
      const now = app.t || 0;
      let k = 0, bestD = Infinity;
      preQueue.forEach(([, b], i) => {
        const d = (b.pre ?? b.t0) - now;
        const key = d >= -0.5 ? d : 1e6 - d;
        if (key < bestD) (bestD = key), (k = i);
      });
      const [kind, b] = preQueue.splice(k, 1)[0];
      try {
        if (kind === 'card') layoutOfBeat(b);
        else {
          const n = normCaption({ captions: [b] }, (b.t0 + b.t1) / 2);
          if (n) {
            const tmp = el.caption.cloneNode(true);
            tmp.removeAttribute('hidden');
            fillCaption(tmp, n);
            el.overlay.appendChild(tmp);
            chooseLayout('caption', tmp, n.key, { t0: b.t0, t1: b.t1 });
            tmp.remove();
          }
        }
      } catch (e) {
        console.warn('[hud] layout precompute', e);
      }
      idle(step);
    };
    idle(step);
  }

  // ---------------------------------------------------------------- labels
  const labels = createLabels(THREE, el.labels);
  // The light meter reads the finished frame back. In capture stills that is exact and free; during playback even
  // the asynchronous path (pixel-pack buffer + fence) costs a round trip to the GPU process, which stalls the main
  // thread for a whole frame or more whenever the GPU is the bottleneck (measured: up to 80 ms per readback in
  // Mercury's low pass on an Apple M5 Pro, one hitch every ~9 frames). So playback uses the analytic estimate
  // unless meter=1 asks for the readback; meter=0 turns it off everywhere.
  const meterOn = params.get('meter') === '1' || (capture && params.get('meter') !== '0');
  const meter = createMeter(meterOn ? ctx.renderer : null, capture);
  let userLabels = params.get('labels') === '1';
  let hudOn = true;
  // The director dims a label it thinks is crowded (near another point, near its planet's limb, near the frame
  // edge). The HUD places names itself — clear of every disc, fanned out on leaders, inner planets in a callout
  // column beside the Sun — so a dimmed label would only read as a ghost or vanish (Mercury, Venus and Mars in the
  // finale map). A label in a group of its kind (moons, the finale's planets) takes the group's time envelope (the
  // brightest of its kind); any other dimmed label is either shown or not, with a short ramp.
  function relabel(raw) {
    if (!Array.isArray(raw) || raw.length <= 1) return raw;
    const env = {};
    for (const it of raw) if (it && typeof it === 'object' && it.alpha != null) env[it.kind || ''] = Math.max(env[it.kind || ''] || 0, +it.alpha);
    return raw.map((it) => {
      if (!it || typeof it !== 'object' || it.alpha == null) return it;
      const e = env[it.kind || ''] || 0;
      if (!(e > 0)) return it;
      const group = it.kind === 'moon' || it.kind === 'planet' || (MOON[it.id] && it.kind !== 'planet');
      return { ...it, alpha: group ? e : e * smooth(0.45, 0.8, +it.alpha / e) };
    });
  }
  function normLabels(shot, t) {
    let raw = shot.labels;
    const out = [];
    const days = shot.simDays;
    const add = (it) => {
      if (!it) return;
      if (typeof it === 'string') it = { id: it };
      const id = it.id || it.body;
      let pos = it.position || it.pos || null;
      if (pos && Array.isArray(pos)) pos = new THREE.Vector3(pos[0], pos[1], pos[2]);
      if (!pos && id) pos = positionOf(id, days);
      if (!pos) return;
      out.push({ name: it.name || it.text || it.label || nameOf(id), sub: it.sub || it.detail || '', pos, radius: it.radius ?? radiusOf(id), ownId: id, alpha: it.alpha != null ? +it.alpha : 1, priority: it.priority });
    };
    raw = relabel(raw);
    // the finale: the planets' names are held from the map through the zoom to Earth, where Earth's reticle grows
    // into the pale-blue-dot ring (one continuous label, never a gap or a second reticle)
    const LH = beats.labelHold;
    const holdA = LH ? smooth(LH.t0 - 0.01, LH.t0, t) * (1 - smooth(LH.t1 - 0.4, LH.t1, t)) : 0;
    if (holdA > 0 && (raw == null || Array.isArray(raw))) {
      raw = raw || [];
      raw = raw.filter((it) => !(it && it.kind === 'planet' && it.id === 'earth' && raw.some((o) => o && o.kind === 'pale-blue-dot')));
      for (const id of LH.ids) {
        const i = raw.findIndex((o) => o && (o.id === id || o === id));
        const cur = i >= 0 ? raw[i] : { id, kind: 'planet', alpha: 0 };
        const a = Math.max(cur.alpha ?? 0, holdA);
        let it = { ...(typeof cur === 'string' ? { id } : cur), alpha: a };
        if (id === 'earth') {
          // reticle radius as for a disc of k px (labels.js sizes it from `radius`): 0 -> the pale-blue-dot ring
          const pos = positionOf('earth', days, new THREE.Vector3());
          const kpx = 9 * smooth(LH.from, LH.to, t);
          const fpx900 = 450 / Math.tan(((shot.fov ?? 35) * Math.PI) / 360);
          if (kpx > 0.3) it.radius = Math.max(radiusOf('earth'), (pos.distanceTo(shot.camPos) * kpx) / fpx900);
          if (cur.kind === 'pale-blue-dot' && cur.radius) it.radius = Math.max(it.radius || 0, cur.radius);
        }
        if (i >= 0) raw[i] = it;
        else raw.push(it);
      }
    }
    if (Array.isArray(raw)) raw.forEach(add);
    else if (raw && typeof raw === 'object') for (const id in raw) add(typeof raw[id] === 'object' ? { id, ...raw[id] } : { id, alpha: +raw[id] });
    // the destination while it is still a point of light (before its title card's name appears)
    if (VIEW !== 'body') {
      for (const a of beats.arrivals) {
        if (t < a.t0 || t > a.t1 + 0.6 || out.some((o) => o.ownId === a.id)) continue;
        const al = smooth(a.t0, a.t0 + 0.8, t) * (1 - smooth(a.t1 - 0.2, a.t1 + 0.6, t));
        if (al > 0.002) add({ id: a.id, sub: 'Arriving', alpha: al * 0.95, priority: 3 });
      }
    }
    if (userLabels) {
      const have = new Set(out.map((o) => o.ownId));
      for (const id of ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
        if (have.has(id) || id === shot.focus) continue;
        const p = positionOf(id, days);
        const d = _p.copy(p).sub(shot.camPos).length();
        const au = d / AU;
        const sub = au > 0.02 ? `${F.fmtAU(au)} AU` : F.fmtKmParts(d * KM_PER_UNIT).join(' ');
        out.push({ name: nameOf(id), sub, pos: p, radius: radiusOf(id), ownId: id, alpha: 0.9 });
      }
    }
    return out;
  }
  const occluders = [];
  function buildOccluders(days, out = occluders) {
    out.length = 0;
    for (const id of ['sun', 'mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
      out.push({ id, pos: positionOf(id, days, new THREE.Vector3()), radius: radiusOf(id), albedo: ALBEDO[id] ?? 0.3 });
      const b = bodies && bodies[id];
      if (b && b.moons) for (const m of b.moons) out.push({ id: m.id, pos: new THREE.Vector3().copy(positions[id]).add(m.positionAt(days)), radius: m.radius, albedo: ALBEDO[m.id] ?? 0.28 });
    }
    return out;
  }
  // the director's labelled points for a shot (universe positions), for keeping text blocks off them
  function labelPoints(shot) {
    const raw = relabel(shot.labels);
    const out = [];
    const add = (it) => {
      if (!it) return;
      if (typeof it === 'string') it = { id: it };
      const a = it.alpha != null ? +it.alpha : 1;
      if (!(a > 0.1)) return;
      let pos = it.position || it.pos || null;
      if (pos && Array.isArray(pos)) pos = new THREE.Vector3(pos[0], pos[1], pos[2]);
      else if (pos && !(pos instanceof THREE.Vector3)) pos = new THREE.Vector3(pos.x, pos.y, pos.z);
      if (!pos && (it.id || it.body)) pos = positionOf(it.id || it.body, shot.simDays);
      if (pos) out.push({ pos, alpha: Math.min(1, a) });
    };
    if (Array.isArray(raw)) raw.forEach(add);
    else if (raw && typeof raw === 'object') for (const id in raw) add(typeof raw[id] === 'object' ? { id, ...raw[id] } : { id, alpha: +raw[id] });
    return out;
  }
  const composer = createComposer({
    THREE, BODIES,
    spheresAt: (days) => buildOccluders(days, []),
    satPole: poleVector('saturn'),
    ringIn: 74658 / KM_PER_UNIT, ringOut: 136775 / KM_PER_UNIT,
    labelPoints,
    orbitLines: orbitPolylines(),
  });
  // the planets' orbits on the epoch (the same Keplerian ellipses the director draws in the finale), universe coords
  function orbitPolylines() {
    const out = [];
    const v = new THREE.Vector3();
    for (const id of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
      const el = orbitalElements(id, epochDays);
      const N = 360, pts = new Float32Array((N + 1) * 3);
      const cw = Math.cos(el.w), sw = Math.sin(el.w), cO = Math.cos(el.O), sO = Math.sin(el.O), cI = Math.cos(el.I), sI = Math.sin(el.I);
      for (let i = 0; i <= N; i++) {
        const E = (i / N) * Math.PI * 2;
        const xp = el.a * (Math.cos(E) - el.e), yp = el.a * Math.sqrt(1 - el.e * el.e) * Math.sin(E);
        const X = (cw * cO - sw * sO * cI) * xp + (-sw * cO - cw * sO * cI) * yp;
        const Y = (cw * sO + sw * cO * cI) * xp + (-sw * sO + cw * cO * cI) * yp;
        const Z = sw * sI * xp + cw * sI * yp;
        eclToThree(X * AU, Y * AU, Z * AU, v).toArray(pts, i * 3);
      }
      out.push(pts);
    }
    return out;
  }

  // The Sun seen as a small, unoccluded point: the disc of its glare on screen (names keep out of it). null otherwise.
  const _sv = new THREE.Vector3();
  function sunGlare(camU, W, H) {
    _sv.copy(camU).negate();
    const d = _sv.length(), R = BODIES.sun.radius;
    if (!(d > R * 1.001)) return null;
    camera.updateMatrixWorld();
    const cz = _sv.clone().applyMatrix4(camera.matrixWorldInverse).z;
    if (cz > -1e-9) return null;
    const dir = _sv.clone().divideScalar(d);
    for (const o of occluders) {
      if (o.id === 'sun') continue;
      cW.copy(o.pos).sub(camU);
      const b = cW.dot(dir);
      if (b > 0 && b < d && cW.lengthSq() - b * b < o.radius * o.radius) return null;
    }
    const fpx = H / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const rpx = fpx * Math.tan(Math.asin(Math.min(1, R / d)));
    if (rpx > 0.12 * H) return null;
    _sv.project(camera);
    return { x: (_sv.x * 0.5 + 0.5) * W, y: (-_sv.y * 0.5 + 0.5) * H, r: rpx * 1.4 + 0.075 * Math.max(H, 0.5625 * W) };
  }

  // ---------------------------------------------------------------- legibility estimate behind text regions
  let flareNow = 1; // the director's flare gain for the current shot (the glare estimate follows it)
  const ray = new THREE.Vector3(), sunW = new THREE.Vector3(), hit = new THREE.Vector3(), nrm = new THREE.Vector3(), cW = new THREE.Vector3();
  const satPole = poleVector('saturn');
  const RING_IN = 74658 / KM_PER_UNIT, RING_OUT = 136775 / KM_PER_UNIT;
  function luminanceAt(sx, sy, W, H, camU, exposure) {
    ray.set((sx / W) * 2 - 1, -(sy / H) * 2 + 1, 0.5).unproject(camera).normalize();
    sunW.copy(camU).negate();
    let best = Infinity, lum = 0;
    for (const o of occluders) {
      cW.copy(o.pos).sub(camU);
      const b = cW.dot(ray);
      if (b <= 0) continue;
      const d2 = cW.lengthSq() - b * b;
      const r2 = o.radius * o.radius;
      if (d2 >= r2) continue;
      const tHit = b - Math.sqrt(r2 - d2);
      if (tHit >= best) continue;
      best = tHit;
      if (o.id === 'sun') {
        lum = 30;
        continue;
      }
      hit.copy(ray).multiplyScalar(tHit);
      nrm.copy(hit).sub(cW).divideScalar(o.radius);
      const l = sunW.clone().sub(hit).normalize();
      lum = o.albedo * 1.25 * Math.max(0, nrm.dot(l)) + (o.id === 'venus' || o.id === 'titan' ? 0.06 : 0);
    }
    // Saturn's rings
    const sat = occluders.find((o) => o.id === 'saturn');
    if (sat) {
      cW.copy(sat.pos).sub(camU);
      const den = ray.dot(satPole);
      if (Math.abs(den) > 1e-6) {
        const tr = cW.dot(satPole) / den;
        if (tr > 0 && tr < best) {
          hit.copy(ray).multiplyScalar(tr).sub(cW);
          const rr = hit.length();
          if (rr > RING_IN && rr < RING_OUT) {
            best = tr;
            lum = rr > 92000 / KM_PER_UNIT && rr < 117580 / KM_PER_UNIT ? 0.5 : 0.28;
          }
        }
      }
    }
    // glare around the Sun
    const sd = sunW.length();
    const ang = Math.acos(Math.max(-1, Math.min(1, ray.dot(sunW) / sd)));
    const angR = Math.asin(Math.min(1, BODIES.sun.radius / sd));
    // disc halo (scale-free) + the lens bloom, which post spreads over a roughly constant number of pixels (so a
    // telephoto field is not "all glare"), weaker as the director calms the flare
    if (ang > angR && best === Infinity) {
      const fpx = H / 2 / Math.tan((camera.fov * Math.PI) / 360), kpx = 0.028 * Math.max(H, 0.5625 * W);
      lum += Math.pow(angR / ang, 1.6) * 1.8 + 1.1 * (0.35 + 0.65 * Math.min(1, flareNow)) * Math.pow(kpx / ((ang - angR) * fpx + kpx), 2);
    }
    return 1 - Math.exp(-1.5 * lum * exposure);
  }
  function regionBrightness(r, W, H, camU, exposure) {
    if (!r) return 0;
    let sum = 0, mx = 0, n = 0;
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 5; i++) {
        const v = luminanceAt(r.x + ((i + 0.5) / 5) * r.w, r.y + ((j + 0.5) / 3) * r.h, W, H, camU, exposure);
        sum += v;
        mx = Math.max(mx, v);
        n++;
      }
    return 0.55 * mx + 0.45 * (sum / n);
  }
  // union of the text boxes inside an element (for full-width centred blocks), ignoring hidden subtrees
  const textRectOf = (e) => {
    const rg = document.createRange();
    const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!n.textContent.trim() || !n.parentElement || n.parentElement.closest('[hidden]')) continue;
      rg.selectNodeContents(n);
      const b = rg.getBoundingClientRect();
      if (!b.width) continue;
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top); x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    return x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };
  const rectOf = (e) => {
    const b = e.getBoundingClientRect();
    return b.width > 0 ? { x: b.left, y: b.top, w: b.width, h: b.height } : null;
  };
  let teleRect = null, capRect = null, endRect = null, openRect = null, teleSig = 0, slateRect = null, slateKey = null;
  // How much of the subject lies under a screen rect (0..1), discounted when the subject fills the whole frame
  // (then there is nothing to uncover and legibility comes first).
  // raw: no discount (the telemetry plan compares two corners of the same frame)
  function subjectUnder(shot, r, W, H, spheres = occluders, raw = false) {
    const S = composer.snapshot(shot, W, H, { u: unitFor(W, H), labels: false, spheres, lines: false });
    if (!S.items.length && !S.ring) return 0;
    let a = 0, b = 0;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 8; i++) a += composer.weightAt(S, r.x + ((i + 0.5) / 8) * r.w, r.y + ((j + 0.5) / 4) * r.h);
    if (a < 0.5 || raw) return a / 32;
    for (let j = 0; j < 5; j++) for (let i = 0; i < 8; i++) b += composer.weightAt(S, ((i + 0.5) / 8) * W, ((j + 0.5) / 5) * H) > 0.25 ? 1 : 0;
    return (a / 32) * (1 - smooth(0.45, 0.75, b / 40));
  }
  // ---------------------------------------------------------------- telemetry corner plan
  // The telemetry lives top-right. Where a world's disc (a crescent's limb, the rings) would lie under it for more
  // than a second and the top-left corner is clear, it moves there for that stretch, with a 0.6 s fade out and in
  // at each move. Planned once per viewport from the director's path (pure), so seek(t) and capture agree.
  // telePlan: [{ t0, t1 }] spans at top-left; teleRectR: the measured top-right box (top-left = its mirror).
  let telePlan = [], telePlanKey = '', teleRectR = null, teleSide = 'r', teleRows = null;
  const TELE_FADE = 0.6;
  const mirrorRect = (r, W) => r && { ...r, x: W - r.x - r.w };
  function planTelemetry(W, H) {
    telePlan = [];
    telePlanKey = W + 'x' + H;
    if (!director || VIEW === 'body' || !teleRectR || formFor(W, H) !== 'wide') return;
    const dur = director.duration, step = 0.25;
    const lb0 = curShot ? lbFor(curShot, W, H) : 0;
    const R = teleRectR, L = mirrorRect(teleRectR, W);
    const want = [];
    const covL = [], covR = [];
    for (let i = 0; i * step <= dur + 1e-6; i++) {
      const ts = i * step, sh = director.evaluate(ts);
      const sp = buildOccluders(sh.simDays, []);
      const dy = lbFor(sh, W, H) - lb0;
      const cr = subjectUnder(sh, { ...R, y: R.y + dy }, W, H, sp, true);
      const cl = subjectUnder(sh, { ...L, y: L.y + dy }, W, H, sp, true);
      covL.push(cl);
      covR.push(cr);
      want.push(cr > 0.3 && cl < 0.1 && cl < 0.35 * cr);
    }
    // runs of >= 1 s, widened by the fades, merged across short gaps, and never landing the block on a subject
    let runs = [];
    for (let i = 0; i < want.length; ) {
      if (!want[i]) { i++; continue; }
      let j = i;
      while (j + 1 < want.length && want[j + 1]) j++;
      if ((j - i + 1) * step >= 1) runs.push([i * step - 0.5, (j + 1) * step + 0.5]);
      i = j + 1;
    }
    const merged = [];
    for (const r of runs) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] < 2.5) last[1] = r[1];
      else merged.push([...r]);
    }
    const clearL = (a, b) => {
      for (let ts = Math.max(0, a - TELE_FADE); ts <= Math.min(dur, b + TELE_FADE); ts += step) if (covL[Math.round(ts / step)] > 0.15) return false;
      return true;
    };
    for (const [a, b] of merged) if (b - a >= 2.5 && clearL(a, b)) telePlan.push({ t0: Math.max(0, a), t1: Math.min(dur, b) });
    window.__hud.telePlan = telePlan.map((s) => [+s.t0.toFixed(2), +s.t1.toFixed(2)]);
    // dev: coverage of the two corners, 1 s apart ([t, right, left])
    window.__hud.teleCov = covR.filter((_, i) => i % 4 === 0).map((c, i) => [i, +c.toFixed(2), +covL[i * 4].toFixed(2)]);
  }
  // which corner at t, and the fade (0..1) of the move
  function teleCornerAt(t) {
    for (const s of telePlan) {
      if (t < s.t0 - TELE_FADE || t > s.t1 + TELE_FADE) continue;
      const side = t >= s.t0 && t < s.t1 ? 'l' : 'r';
      const d = Math.min(Math.abs(t - s.t0), Math.abs(t - s.t1));
      return { side, a: smooth(0, TELE_FADE, d) };
    }
    return { side: 'r', a: 1 };
  }
  // the telemetry box(es) a text block shown over [a, b] must keep clear of
  function teleRectsOver(a, b, W) {
    if (!teleRectR) return teleRect ? [teleRect] : [];
    const out = [teleRectR];
    if (telePlan.some((s) => s.t0 - TELE_FADE < b && s.t1 + TELE_FADE > a)) out.push(mirrorRect(teleRectR, W));
    return out;
  }
  // margins as CSS resolves them (--mx, --mb), re-measured per viewport size
  let metrics = { key: '', mx: 20, mb: 84 };
  function metricsFor(W, H) {
    const key = W + 'x' + H;
    if (metrics.key !== key) {
      const pr = root.querySelector('.flh-probe');
      metrics = { key, mx: pr.offsetWidth || 20, mb: pr.offsetHeight || 84 };
    }
    return metrics;
  }
  let preTimer = 0;
  window.addEventListener('resize', () => {
    layoutCache.clear();
    cardLayout = capLayout = null;
    clearTimeout(preTimer);
    preTimer = setTimeout(precomputeLayouts, 300);
    cardRect = teleRect = teleRectR = capRect = endRect = openRect = slateRect = null;
    teleRows = null;
    telePlanKey = '';
    slateKey = null;
    lastCardSig = '';
  });
  const scrimAlpha = (b) => clamp01((b - 0.05) / 0.45);
  function setHalo(e, b) {
    const k = (Math.round(clamp01(b) * 10) / 10).toFixed(1);
    if (e._halo !== k) e.style.setProperty('--halo', (e._halo = k));
  }
  // corner: 'bl' | 'tr' anchor the vignette at that screen corner; 'c' centres a soft ellipse on the rect
  function placeScrim(s, r, a, corner, W, H) {
    if (r) {
      const key = `${corner}${r.x | 0},${r.y | 0},${r.w | 0},${r.h | 0},${W},${H}`;
      if (s._key !== key) {
        s._key = key;
        const u = unitFor(W, H);
        if (s.dataset.k !== corner) s.dataset.k = corner;
        if (corner === 'bl' || corner === 'br' || corner === 'tl') {
          // the vignette grows from the screen corner the text block is anchored to
          const right = corner === 'br', top = corner === 'tl';
          s.style.width = Math.min(W * 1.2, (right ? W - r.x : r.x + r.w) * 1.55 + 60 * u).toFixed(0) + 'px';
          s.style.height = Math.min(H * 1.2, (top ? r.y + r.h : H - r.y) * 1.6 + 40 * u).toFixed(0) + 'px';
        } else if (corner === 'tr') {
          s.style.width = Math.min(W * 1.2, (W - r.x) * 1.85 + 80 * u).toFixed(0) + 'px';
          s.style.height = Math.min(H * 1.2, (r.y + r.h) * 1.75 + 50 * u).toFixed(0) + 'px';
        } else {
          const ex = Math.max(90 * u, r.w * 0.32), ey = Math.max(70 * u, r.h * 0.6);
          s.style.transform = `translate(${(r.x - ex).toFixed(0)}px, ${(r.y - ey).toFixed(0)}px)`;
          s.style.width = (r.w + 2 * ex).toFixed(0) + 'px';
          s.style.height = (r.h + 2 * ey).toFixed(0) + 'px';
        }
      }
    }
    const ak = (r ? a : 0).toFixed(3);
    if (s._a !== ak) s.style.opacity = s._a = ak;
  }

  // ---------------------------------------------------------------- line bands (legibility behind a text block)
  const bandLayer = root.querySelector('.flh-bands');
  const bandPools = { card: [], tele: [] };
  function bandEl(pool, i) {
    if (pool[i]) return pool[i];
    const e = document.createElement('div');
    e.className = 'flh-band';
    bandLayer.appendChild(e);
    return (pool[i] = { e, key: '', a: '', bg: '' });
  }
  // rows: [{x,y,w,h,a}] text line boxes with their visibility; b: 0..1 how much help the text needs;
  // rgb: mean display colour behind the block (from the light meter), or null; maxA: the darkest a band gets
  function drawBands(rows, b, rgb, u, pool = bandPools.card, maxA = 0.34) {
    const lines = [];
    for (const r of rows) {
      if (!(r.a > 0.01) || r.w < 2 || r.h < 4) continue; // hairlines need no band
      const L = lines.find((l) => {
        const h = Math.max(l.h, r.h);
        return Math.abs(l.y + l.h / 2 - (r.y + r.h / 2)) < h * 0.5 && r.x < l.x + l.w + 3 * h && r.x + r.w > l.x - 3 * h;
      });
      if (L) {
        const x1 = Math.max(L.x + L.w, r.x + r.w), y1 = Math.max(L.y + L.h, r.y + r.h);
        L.x = Math.min(L.x, r.x); L.y = Math.min(L.y, r.y); L.w = x1 - L.x; L.h = y1 - L.y; L.a = Math.max(L.a, r.a);
      } else lines.push({ ...r });
    }
    let col = '0,0,0';
    if (rgb) {
      // the colour behind, much darker and a little richer (a shadow on the surface, not grey)
      const m = (rgb[0] + rgb[1] + rgb[2]) / 3;
      col = rgb.map((c) => Math.round(255 * Math.max(0, 0.24 * (m + (c - m) * 2)))).join(',');
    }
    let n = 0;
    for (const l of lines) {
      // a solid box a little inside the line box, blurred in proportion to the type size: neighbouring lines
      // melt into one soft shadow that hugs the text (no edges, no corner vignette)
      const h = Math.max(l.h, 10 * u);
      const x = l.x - 0.3 * h, w = l.w + 0.6 * h, y = l.y + 0.12 * l.h, bh = Math.max(4, 0.76 * l.h);
      const blur = 0.36 * h + 6 * u;
      const o = bandEl(pool, n++);
      const key = `${x | 0},${y | 0},${w | 0},${bh | 0},${blur | 0}`;
      if (o.key !== key) {
        o.key = key;
        o.e.style.transform = `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px)`;
        o.e.style.width = w.toFixed(0) + 'px';
        o.e.style.height = bh.toFixed(0) + 'px';
        o.e.style.filter = `blur(${blur.toFixed(1)}px)`;
      }
      const bg = `rgb(${col})`;
      if (o.bg !== bg) o.e.style.background = o.bg = bg;
      const a = (Math.min(maxA, (maxA + 0.02) * clamp01(b)) * l.a).toFixed(3);
      if (o.a !== a) o.e.style.opacity = o.a = a;
    }
    for (let i = n; i < pool.length; i++) if (pool[i].a !== '0') pool[i].e.style.opacity = pool[i].a = '0';
  }

  // ---------------------------------------------------------------- splash
  let splash = null, splashOpen = false, loadP = 0;
  if (SHOW_SPLASH) {
    splashOpen = true;
    splash = document.createElement('div');
    splash.id = 'flh-splash';
    splash.setAttribute('role', 'dialog');
    splash.setAttribute('aria-label', 'Four Light-Hours');
    const anim = !capture && !reduceMotion;
    const dl = F.fmtDateLong(epochDate);
    const tm = F.fmtTimeUTC(epochDate);
    const orr = orrerySVG(positions, epochDays, { animate: anim });
    splash.innerHTML = `
      <div class="sp-text">
        <div class="sp-kicker${anim ? ' anim-in' : ''}">A real-time film · true to scale</div>
        <h1 class="${anim ? 'anim-in' : ''}" style="animation-delay:.15s" aria-label="Four Light-Hours"><span>Four</span><span>Light-Hours</span></h1>
        <p class="sp-line${anim ? ' anim-in' : ''}" style="animation-delay:.45s">${esc(SUBTITLE.intro)}</p>
        <div class="sp-prog" aria-hidden="true"><i></i></div>
        <div class="sp-status" aria-live="polite">Loading</div>
        <button class="sp-begin" type="button" disabled>Begin</button>
        <div class="sp-notes${anim ? ' anim-in' : ''}" style="animation-delay:.8s"><span>${ICONS.headphones}Headphones recommended</span><span>Positions computed for ${esc(dl).replace(/ /g, '&nbsp;')}&nbsp;·&nbsp;${tm}&nbsp;UTC</span></div>
      </div>
      <figure class="sp-orrery" aria-label="The planets on ${esc(dl)}">
        ${orr.html}
        <figcaption>The planets on ${esc(F.fmtDateUTC(epochDate))}, seen from above the ecliptic<br>Dashed: our route · radial scale logarithmic</figcaption>
      </figure>`;
    if (capture) splash.classList.add('static');
    document.body.appendChild(splash);
    const fig = splash.querySelector('.sp-orrery');
    layoutOrreryLabels(fig, orr.labels, orr.S);
    window.addEventListener('resize', () => splashOpen && layoutOrreryLabels(fig, orr.labels, orr.S));
  }
  const spBegin = splash && splash.querySelector('.sp-begin');
  const spBar = splash && splash.querySelector('.sp-prog i');
  const spStatus = splash && splash.querySelector('.sp-status');

  function begin() {
    if (!splashOpen) return;
    splashOpen = false;
    splash.classList.add('gone');
    setTimeout(() => splash && splash.remove(), 1600);
    controls && controls.activity();
    Promise.resolve(app.start()).catch((e) => console.warn('[hud] start failed', e));
  }
  if (spBegin) spBegin.addEventListener('click', begin);
  window.addEventListener('keydown', (e) => {
    if (splashOpen && spBegin && !spBegin.disabled && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      begin();
    }
  });

  // ---------------------------------------------------------------- controls
  let controls = null;
  const toggleHud = () => {
    hudOn = !hudOn;
    root.classList.toggle('flh-clean', !hudOn);
    toast(hudOn ? 'Titles and telemetry on' : 'Titles and telemetry hidden · H to restore');
  };
  const toggleLabels = () => {
    userLabels = !userLabels;
    toast(userLabels ? 'Planet labels on' : 'Planet labels off');
  };

  window.__hud = { fonts: fontStatus, reduceMotion, state: null };

  // hairlines: a whole number of device-independent pixels that grows with the HUD unit (crisp at any size)
  function applyUnit() {
    const hl = Math.max(1, Math.round(unitFor(window.innerWidth, window.innerHeight) * 0.8)) + 'px';
    root.style.setProperty('--hl', hl);
    if (splash) splash.style.setProperty('--hl', hl);
  }
  applyUnit();
  window.addEventListener('resize', applyUnit);
  // dev: forget every placement (the next frame chooses again)
  window.__hud.composer = composer;
  window.__hud.relayout = () => {
    layoutCache.clear();
    cardLayout = capLayout = null;
  };

  // ---------------------------------------------------------------- module API
  let lastLB = null, lastTeleA = null, lastShown = {};
  function show(e, on) {
    if (lastShown[e.className] === on) return;
    lastShown[e.className] = on;
    e.hidden = !on;
  }

  return {
    setLoading(p) {
      if (!splash) return;
      loadP = Math.max(loadP, Math.min(1, p || 0));
      spBar.style.transform = `scaleX(${loadP.toFixed(3)})`;
      spStatus.textContent = `Loading · ${Math.round(loadP * 100)}%`;
    },

    // second loading phase: the GPU building every shader before the film starts (main.js warm-up)
    setWarmup(p) {
      if (!splash) return;
      const q = Math.min(1, Math.max(0, p || 0));
      spBar.style.transform = `scaleX(${q.toFixed(3)})`;
      spStatus.textContent = `Preparing the GPU · ${Math.round(q * 100)}%`;
    },

    async attach(o) {
      director = o.director;
      bodies = o.bodies;
      const raw = (director && director.chapters) || [];
      const last = raw.length - 1;
      let num = 0;
      chapters = raw.map((c, i) => {
        const id = c.id || '';
        let body = c.body || (BODIES[id] || MOON[id] ? id : null);
        if (!body && /belt|aster/i.test(id)) body = 'asteroids';
        let kind = 'body';
        if (/finale|outro|epilog|credits|home|end/i.test(id) || (i === last && !body && i > 0)) kind = 'finale';
        else if (i === 0 && !body) kind = 'intro';
        else if (!body) kind = 'other';
        const numeral = kind === 'intro' ? '' : ROMAN[++num] || String(num);
        let title = c.title || (body ? nameOf(body) : id);
        // the finale goes by one name everywhere (slate, timeline, transport, card): its title card's
        if (kind === 'finale') {
          const fc = ((director && director.captions) || []).find((x) => x && x.kind === 'body' && x.t0 >= c.t0 - 1e-6 && x.t0 < c.t1 && x.title);
          if (fc) title = fc.title;
        }
        return { ...c, index: i, body, kind, numeral, title, short: kind === 'intro' ? 'Opening' : title, alias: TIMELINE_SHORT[id] || TIMELINE_SHORT[kind] || null };
      });
      const dur = director ? director.duration : 0;
      const finCh = chapters.find((c) => c.kind === 'finale');
      finaleT0 = finCh ? finCh.t0 : null;
      buildBeats(dur);
      buildEnd();

      controls = createControls({
        root, app, capture, forceShow: FORCE_CONTROLS, toast, reduceMotion,
        onToggleHud: toggleHud, onToggleLabels: toggleLabels, isSplashOpen: () => splashOpen,
      });
      controls.setChapters(chapters, dur);
      if (VIEW === 'body') controls.element.hidden = true;

      if (splash) {
        loadP = 1;
        spBar.style.transform = 'scaleX(1)';
        spStatus.textContent = 'Ready';
        spBegin.disabled = false;
        if (!capture) setTimeout(() => spBegin.focus({ preventScroll: true }), 50);
      }
    },

    update(t, shot, opts = {}) {
      if (!shot) return;
      const tStart = performance.now();
      const PROF = [['start', tStart]];
      const W = window.innerWidth, H = window.innerHeight;
      const duration = opts.duration || (director && director.duration) || 0;
      const camU = shot.camPos;
      const days = shot.simDays;
      const fade = clamp01(shot.fade || 0);
      buildOccluders(days);
      flareNow = shot.flare ?? 1;

      // letterbox: keep text inside the picture (2.39:1 matte, relaxed on portrait screens: core/frame.js)
      // (landscape only: on a portrait phone the bars are tall enough to hold the text, like subtitles in a matte)
      const barPx = matteBarPx(W, H);
      const lbPx = lbFor(shot, W, H);
      curShot = shot;
      const lbk = lbPx.toFixed(1);
      if (lbk !== lastLB) {
        // the matte moved: text blocks anchored to the top / bottom move with it, so their boxes shift by the same
        // amount (no re-measuring, which would force a layout on every frame of a letterbox animation)
        const d = lastLB == null ? 0 : lbPx - +lastLB;
        lastLB = lbk;
        root.style.setProperty('--lb', lbk + 'px');
        const sh = (r, k) => r && { ...r, y: r.y + k * d };
        teleRect = sh(teleRect, 1);
        teleRectR = sh(teleRectR, 1);
        teleRows = null;
        cardRect = sh(cardRect, cardLayout && cardLayout.top ? 1 : -1);
        capRect = sh(capRect, capLayout && capLayout.top ? 1 : -1);
        slateRect = sh(slateRect, -1);
        endRect = openRect = null;
      }
      const form = formFor(W, H), uu = unitFor(W, H);
      const M = metricsFor(W, H), mxPx = M.mx;
      // while the transport controls are shown they push the lower text blocks up, so the two never collide
      const ctlIn = controls && controls.isShown() ? controls.inset() : 0;
      const lift = ctlIn > 0 ? Math.max(0, Math.round(ctlIn + 10 * uu - M.mb)) : 0;
      if (lift !== curLift) {
        curLift = lift;
        root.style.setProperty('--lift', lift + 'px');
        cardRect = capRect = slateRect = null;
      }
      // portrait phone with the matte up: the cold-open title goes inside the picture strip, its lines below it
      const strip = H - 2 * barPx * clamp01(shot.letterbox || 0);
      const split = W / H < 1.2 && barPx * clamp01(shot.letterbox || 0) > 40;
      if (split !== lastShown._split) {
        lastShown._split = split;
        el.open.classList.toggle('split', split);
        openRect = null;
      }
      if (split) {
        const sk = strip.toFixed(0);
        if (sk !== lastShown._strip) root.style.setProperty('--strip', (lastShown._strip = sk) + 'px');
      }

      PROF.push(['which', performance.now()]);
      // ------------------------------------------------ which chapter
      let ci = shot.chapterIndex;
      if (VIEW !== 'body' && (ci == null || !chapters[ci])) {
        ci = 0;
        for (let i = chapters.length - 1; i >= 0; i--) if (t >= chapters[i].t0) { ci = i; break; }
      }
      const ch = VIEW === 'body' ? null : chapters[ci];

      PROF.push(['closing', performance.now()]);
      // ------------------------------------------------ closing card
      let endA = 0;
      const E = beats.end;
      if (VIEW !== 'body' && E && duration && t >= E.t0) {
        endA = smooth(E.t0, E.t0 + Math.min(1.2, (E.t1 - E.t0) * 0.2), t);
        show(el.end, true);
        animateEnd(t - E.t0, E.t1 - E.t0);
        el.end.style.opacity = endA.toFixed(3);
        const ended = !opts.playing && t >= duration - 0.05;
        // the button's space is always reserved, so the card does not jump when the film ends
        if (endParts.replay.classList.contains('off') === ended) {
          endParts.replay.classList.toggle('off', !ended);
          for (const b of endParts.buttons) b.tabIndex = ended ? 0 : -1;
        }
      } else show(el.end, false);

      PROF.push(['cold', performance.now()]);
      // ------------------------------------------------ cold open
      let openA = 0;
      const O = beats.open;
      if (VIEW !== 'body' && O && openParts && t >= O.t0 && t <= O.t1) {
        show(el.open, true);
        openA = animateOpen(t - O.t0, O.t1 - O.t0);
      } else show(el.open, false);

      PROF.push(['telemetry', performance.now()]);
      // ------------------------------------------------ telemetry
      let teleA = 1;
      if (ch && ch.kind === 'intro') teleA = smooth(ch.t1 - 2.5, ch.t1, t);
      teleA *= 1 - endA;
      {
        // always filled (even while faded out) so its box is measured before it first shows
        const rU = camU.length();
        const au = rU / AU;
        const km = rU * KM_PER_UNIT;
        setV('dist', 'a', U(F.fmtAU(au), 'AU'));
        const [kn, ku] = F.fmtKmParts(km);
        setV('dist', 'b', U(kn, ku));
        setV('lt', 'a', F.fmtLightTime(km / C_KM_S).map(([n, u]) => U(n, u)).join(''));
        let sc = shot.speedC;
        // the director's own speed when it reports one; otherwise (or a bare 0 from a placeholder) differentiate the path
        if (typeof sc !== 'number' || !isFinite(sc) || (sc === 0 && shot.speedKmS === undefined)) sc = derivedSpeedC(t, duration);
        const [sn, su] = F.fmtSpeed(Math.abs(sc));
        setV('spd', 'a', U(sn, su));
        // The simulated clock runs (1 s of film = 20 min) so worlds turn, but the planets stay where they were on the
        // epoch. In the finale, where the film says "every planet where it really is", the row shows that epoch.
        const fin = VIEW !== 'body' && finaleT0 != null && t >= finaleT0 - 0.3;
        const date = dateFromDays(fin ? epochDays : days);
        if (fin !== tv.utc.fin) {
          tv.utc.fin = fin;
          tv.utc.k.innerHTML = fin ? 'Epoch<span class="x">UTC</span>' : 'Sim. clock<span class="x">UTC</span>';
        }
        setV('utc', 'a', `${F.fmtDateUTC(date)}<span class="u"></span><span class="n">${F.fmtTimeUTC(date)}</span>`);
        setV('utc', 'b', fin ? EPOCH_NOTE : CLOCK_NOTE);
        // the row eases out and back in around the switch
        const ua = finaleT0 == null || VIEW === 'body' ? 1 : t < finaleT0 - 0.3 ? 1 - smooth(finaleT0 - 1.1, finaleT0 - 0.3, t) : smooth(finaleT0 - 0.3, finaleT0 + 0.6, t);
        const uak = ua.toFixed(2);
        if (uak !== tv.utc.al) tv.utc.cell.style.opacity = tv.utc.al = uak;
        const fid = VIEW === 'body' ? params.get('target') || shot.focus : shot.focus;
        if (fid) {
          setV('tgt', 'a', `<span class="nm">${esc(nameOf(fid))}</span>`);
          const fp = positionOf(fid, days, _p);
          const fr = radiusOf(fid);
          if (fp && fr) {
            const dc = fp.sub(camU).length(); // centre distance, scene units
            const alt = dc - fr;
            // near a world: altitude above its surface. Far from it (beyond 100 radii or 0.01 AU) the radius is lost
            // in the rounding, so it is the distance — and for the Sun that is the FROM THE SUN row already.
            const far = alt > 100 * fr || alt > 0.01 * AU;
            if (fid === 'sun' && far) setV('tgt', 'b', '');
            else {
              const v = far ? dc : alt;
              const parts = v > AU * 0.02 ? [F.fmtAU(v / AU), 'AU'] : F.fmtKmParts(Math.max(0, v * KM_PER_UNIT));
              const what = far ? 'distance' : fid === 'sun' ? 'above photosphere' : 'altitude';
              setV('tgt', 'b', `<span class="u" style="margin:0 .5em 0 0">${what}</span>${U(parts[0], parts[1])}`);
            }
          } else setV('tgt', 'b', '');
        }
        const f = clamp01(rU / ruler.max);
        const fk = (f * 100).toFixed(2);
        if (fk !== ruler.last) {
          ruler.last = fk;
          ruler.me.style.left = fk + '%';
          ruler.done.style.width = fk + '%';
        }
        // the block's box: re-measured whenever its text changes length (the one-line phone form is content-sized)
        let sig = 0;
        for (const k in tv) sig = (sig * 31 + (tv[k].la ? tv[k].la.length : 0) + 7 * (tv[k].lb ? tv[k].lb.length : 0)) % 1e9;
        if (sig !== teleSig) {
          teleSig = sig;
          if (form === 'short') teleRect = null;
        }
        if (!teleRect) {
          teleRect = textRectOf(el.tele) || rectOf(el.tele);
          teleRectR = teleRect && teleSide === 'l' ? mirrorRect(teleRect, W) : teleRect;
          teleRows = null;
          if (teleRect) root.style.setProperty('--tb', (teleRect.y + teleRect.h).toFixed(0) + 'px');
          // placements need the telemetry's box (and its corner plan): start choosing them once it is known
          if (teleRect && !preQueue) setTimeout(precomputeLayouts, 0);
        }
      }
      // corner: top-right, or top-left over a stretch where a world would otherwise lie under the block (planned
      // per viewport from the director's path; wide form only — on phones it is a full-width strip)
      const wideTele = form === 'wide' && VIEW !== 'body';
      if (wideTele && teleRectR && telePlanKey !== W + 'x' + H) planTelemetry(W, H);
      const corner = wideTele ? teleCornerAt(t) : { side: 'r', a: 1 };
      if (corner.side !== teleSide) {
        teleSide = corner.side;
        el.tele.classList.toggle('at-l', teleSide === 'l');
        teleRect = teleRectR && (teleSide === 'l' ? mirrorRect(teleRectR, W) : teleRectR);
        teleRows = null;
      }
      teleA *= corner.a;
      // where a subject still lies under it (nowhere to go: the rings across the whole top), the block stays
      // legible — line shadows, brighter keys — and steps back only a little
      const teleCov = teleRect && teleA > 0.01 ? subjectUnder(shot, teleRect, W, H) : 0;
      teleA *= 1 - 0.12 * smooth(0.06, 0.4, teleCov);
      const tak = teleA.toFixed(2);
      if (tak !== lastTeleA) {
        lastTeleA = tak;
        el.tele.style.opacity = (teleA * 0.92).toFixed(3);
        el.tele.style.visibility = teleA < 0.01 ? 'hidden' : '';
      }

      PROF.push(['title', performance.now()]);
      // ------------------------------------------------ title card
      let curBeat = null;
      let cardA = 0, cardVis = 0; // cardA: envelope that drives the DOM; cardVis: how much text is actually visible
      let info = null, dt = 0, dtBody = 0;
      if (VIEW === 'body') {
        if (params.get('card') !== '0') {
          // the same card the film shows for this body (numeral, director data line), or a plain one
          const id = params.get('target') || shot.focus || params.get('body');
          const fb = beats.cards.find((b) => b.id === id);
          info = fb ? fb.info : cardInfo(null, id);
          dt = 8;
          cardA = 1;
        }
      } else {
        let B = null;
        for (const b of beats.cards) if (t >= (b.pre ?? b.t0) && t <= b.t1) B = b; // latest-starting active card wins
        curBeat = B;
        if (B) {
          const L = B.t1 - B.t0;
          dt = t - (B.pre ?? B.t0);
          dtBody = B.pre != null ? t - B.t0 + 0.9 : dt;
          cardA = (1 - smooth(L - CARD_OUT(L), L, t - B.t0)) * (1 - endA);
          info = B.info;
        }
      }
      if (info && cardA > 0.001) {
        if (info.key !== cardKey) {
          cardKey = info.key;
          buildCard(info);
          lastCardSig = '';
        }
        show(el.card, true);
        if (!cardLayout) {
          // where this card goes for its whole beat: off the subject (chosen once per beat and viewport)
          cardLayout = chooseLayout('card', el.card, info.key + (VIEW === 'body' ? '|' + location.search : ''), curBeat ? { pre: curBeat.pre, t0: curBeat.t0, t1: curBeat.t1 } : null);
          applyLayout(el.card, cardLayout);
          if (cardParts.title) cardParts.title.style.fontSize = cardLayout.fs;
          cardRect = null;
          lastCardSig = '';
        }
        if (cardLayout.exit != null) cardA *= 1 - smooth(cardLayout.exit - 0.45, cardLayout.exit, t);
        animateCard(dt, cardA, VIEW === 'body' ? dt : dtBody);
        cardVis = cardA * (reduceMotion ? smooth(0.2, 1.2, dt) : smooth(0.15, 1.1, dt));
        if (!cardRect) cardRect = rectOf(el.card);
      } else {
        show(el.card, false);
      }

      PROF.push(['caption', performance.now()]);
      // ------------------------------------------------ caption
      let capA = 0;
      const cap = VIEW === 'body' ? null : normCaption(shot, t);
      if (cap) {
        capA = cap.alpha * (1 - smooth(0.05, 0.4, cardA)) * (1 - endA) * (1 - smooth(0.02, 0.3, openA));
        if (capA > 0.002) {
          if (cap.key !== capKey) {
            capKey = cap.key;
            buildCaption(cap);
            capRect = null;
            capLayout = null;
          }
          show(el.caption, true);
          if (!capLayout) {
            capLayout = chooseLayout('caption', el.caption, cap.key, cap.t0 != null && cap.t1 != null ? { t0: cap.t0, t1: cap.t1 } : null);
            applyLayout(el.caption, capLayout);
            capRect = null;
          }
          if (capLayout.exit != null) capA *= 1 - smooth(capLayout.exit - 0.45, capLayout.exit, t);
          el.caption.style.opacity = capA.toFixed(3);
          const s = cap.since;
          capWords.forEach((w, i) => {
            const a = reduceMotion || s > 40 ? 1 : smooth(i * 0.045, i * 0.045 + 0.55, s);
            w.style.opacity = a.toFixed(3);
          });
          if (!capRect) capRect = rectOf(el.caption);
        } else show(el.caption, false);
      } else show(el.caption, false);

      PROF.push(['slate', performance.now()]);
      // ------------------------------------------------ chapter slate (names the chapter while the film travels)
      let slateA = 0;
      if (VIEW !== 'body') {
        const sl = beats.slates.find((b) => t >= b.t0 && t <= b.t1);
        if (sl) {
          slateA = smooth(sl.t0, sl.t0 + 0.9, t) * (1 - smooth(sl.t1 - 0.6, sl.t1, t)) * (1 - endA) * (1 - smooth(0.02, 0.3, capA)) * (1 - fade);
          if (slateA > 0.002) {
            if (slateKey !== sl) {
              slateKey = sl;
              el.chap.innerHTML = `${sl.numeral ? `<span class="n">${esc(sl.numeral)}</span><span class="bar"></span>` : ''}<span class="nm">${esc(sl.name)}</span>`;
              // in the corner its title card will use
              el.chap.classList.toggle('at-r', layoutOfBeat(sl.beat).cls.includes('at-r'));
              slateRect = null;
            }
            show(el.chap, true);
            const sa = slateA.toFixed(3);
            if (el.chap._a !== sa) el.chap.style.opacity = el.chap._a = sa;
            if (!slateRect) slateRect = textRectOf(el.chap);
          }
        }
      }
      if (slateA <= 0.002) show(el.chap, false);

      PROF.push(['labels', performance.now()]);
      // ------------------------------------------------ labels
      const items = normLabels(shot, t);
      const showLabels = hudOn && visible;
      const lblAlpha = (1 - fade) * (1 - 0.85 * openA) * (1 - 0.7 * endA);
      // text blocks are hard obstacles for names and leaders; a point under a visible block fades out
      const avoid = [];
      if (cardA > 0.02) {
        const ab = VIEW === 'body' ? cardA : cardA * smooth(SUB_IN[0], SUB_IN[1], dtBody);
        for (const r of liveRows(cardLayout, lbPx)) avoid.push({ ...r, a: r.stage === 'body' ? ab : cardVis });
      }
      if (teleA > 0.05 && teleRect) avoid.push({ ...teleRect, a: teleA });
      if (slateA > 0.02 && slateRect) avoid.push({ ...slateRect, a: slateA });
      if (ctlIn > 0) avoid.push({ x: 0, y: H - ctlIn - 6 * uu, w: W, h: ctlIn + 6 * uu, a: 1 }); // the transport controls
      if (capA > 0.02) for (const r of liveRows(capLayout, lbPx)) avoid.push({ ...r, a: capA });
      const exposure0 = shot.exposure ?? 1;
      window.__hud.labelStats = [items.length, labels.update(showLabels ? items : [], camera, camU, W, H, occluders, avoid, lblAlpha, barPx * clamp01(shot.letterbox || 0), {
        u: unitFor(W, H),
        inset: Math.max(12, 0.45 * mxPx), // half the side margin (--mx)
        lum: (x, y) => luminanceAt(x, y, W, H, camU, exposure0),
        glare: sunGlare(camU, W, H),
      }), labels.why];

      PROF.push(['scrims', performance.now()]);
      // ------------------------------------------------ scrims (legibility): a corner vignette + text halo behind
      // each text block, only as strong as the brightness behind it — measured from the finished frame when the
      // light meter can read it back, otherwise estimated analytically from the scene geometry
      const exposure = shot.exposure ?? 1;
      const blR = cardVis > 0.01 ? cardRect : capA > 0.01 ? capRect : null;
      const trR = teleRect && teleA > 0.01 ? teleRect : null;
      let cR = null;
      if (endA > 0.01) cR = endRect || (endRect = textRectOf(el.end));
      else if (openA > 0.01) cR = openRect || (openRect = textRectOf(el.open));
      const tm0 = performance.now();
      const meas = meter.measure([['bl', blR], ['tr', trR], ['c', cR]], W, H, capture && !opts.playing);
      const meterMs = performance.now() - tm0; // a synchronous capture readback waits for the GPU frame
      const bright = (key, r) => {
        if (!r) return 0;
        const m = meas && meas[key];
        return m != null ? Math.max(m, 0.6 * regionBrightness(r, W, H, camU, exposure)) : regionBrightness(r, W, H, camU, exposure);
      };
      const blB = scrimAlpha(bright('bl', blR));
      const blA = blB * Math.max(cardVis, capA);
      // behind a card or caption: one soft band per line of text (not a corner vignette), only as dark as the
      // brightness behind it needs, tinted toward what is behind so a lit planet keeps its colour
      let bandRows = [];
      if (cardVis > 0.01 && cardLayout) {
        const ab = VIEW === 'body' ? cardA : cardA * smooth(SUB_IN[0], SUB_IN[1], dtBody);
        bandRows = liveRows(cardLayout, lbPx).map((r) => ({ ...r, a: r.stage === 'body' ? ab : cardVis }));
      } else if (capA > 0.01 && capLayout) bandRows = liveRows(capLayout, lbPx).map((r) => ({ ...r, a: capA }));
      drawBands(bandRows, blB, meas && meas.bl_rgb, uu);
      setHalo(cardVis > 0.01 ? el.card : el.caption, blB);
      const trB = scrimAlpha(bright('tr', trR));
      const trA = trB * teleA;
      // the telemetry: line shadows like the cards' (darker: its type is small), plus the corner vignette only where
      // the frame behind is bright all over
      if (trR && !teleRows) teleRows = textRects(el.tele);
      drawBands(trR ? teleRows.map((r) => ({ ...r, a: teleA })) : [], Math.max(trB, smooth(0.05, 0.3, teleCov)), meas && meas.tr_rgb, uu, bandPools.tele, 0.5);
      placeScrim(el.scrimTR, trR, trA * 0.6, teleSide === 'l' ? 'tl' : 'tr', W, H);
      setHalo(el.tele, Math.max(trB, 0.6 * smooth(0.05, 0.3, teleCov)));
      let cA = 0;
      if (cR) {
        const bc = scrimAlpha(bright('c', cR));
        setHalo(endA > 0.01 ? el.end : el.open, bc);
        cA = endA > 0.01 ? Math.max(0.35, bc) * endA : bc * openA;
      }
      placeScrim(el.scrimC, cR, cA, 'c', W, H);

      if (DEBUG_LAYOUT) drawLayoutDebug(shot, W, H);

      PROF.push(['controls', performance.now()]);
      // ------------------------------------------------ controls
      if (controls) controls.update(t, !!opts.playing, !!opts.muted, hudOn, userLabels);
      window.__hud.ms = +(performance.now() - tStart - meterMs).toFixed(3);
      if (window.__hud.ms > SLOW_MS) {
        PROF.push(['end', performance.now()]);
        (window.__hud.slow || (window.__hud.slow = [])).push([+t.toFixed(2), PROF.slice(1).map((p, i) => p[0] + ':' + (p[1] - PROF[i][1]).toFixed(1)).join(' ')]);
      }
      window.__hud.meterMs = +meterMs.toFixed(3);
      window.__hud.state = { t, chapter: ch ? ch.id : null, card: cardA > 0.001 ? cardKey : null, cardA: +cardA.toFixed(3), capA: +capA.toFixed(3), openA: +openA.toFixed(3), endA: +endA.toFixed(3), scrim: [+blA.toFixed(2), +trA.toFixed(2), +cA.toFixed(2)], meter: meas ? Object.fromEntries(Object.entries(meas).map(([k, v]) => [k, typeof v === 'number' ? +v.toFixed(3) : v.map((x) => +x.toFixed(3))])) : null };
    },
  };

  // dev (hudlayout=1): the subject weight field as the composer sees it (red) and the chosen text rows (cyan)
  function drawLayoutDebug(shot, W, H) {
    let cv = document.getElementById('flh-layout-debug');
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'flh-layout-debug';
      cv.style.cssText = 'position:fixed;inset:0;z-index:30;pointer-events:none';
      document.body.appendChild(cv);
    }
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    const S = composer.snapshot(shot, W, H, { u: unitFor(W, H) });
    const st = 10;
    for (let y = st / 2; y < H; y += st)
      for (let x = st / 2; x < W; x += st) {
        const w = composer.weightAt(S, x, y);
        if (w > 0) { g.fillStyle = `rgba(255,40,40,${(w * 0.45).toFixed(3)})`; g.fillRect(x - st / 2, y - st / 2, st, st); }
      }
    g.strokeStyle = 'rgba(0,255,255,.9)';
    for (const L of [cardLayout, capLayout]) for (const r of liveRows(L, lbFor(shot, W, H))) g.strokeRect(r.x, r.y, r.w, r.h);
  }

  function derivedSpeedC(t, duration) {
    if (!director || VIEW === 'body' || !duration) return 0;
    const h = 0.05;
    const a = director.evaluate(Math.max(0, t - h)).camPos, b = director.evaluate(Math.min(duration, t + h)).camPos;
    const span = Math.min(duration, t + h) - Math.max(0, t - h);
    return span > 0 ? (a.distanceTo(b) * KM_PER_UNIT) / span / C_KM_S : 0;
  }
}
