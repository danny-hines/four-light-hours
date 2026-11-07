// Number / date formatting for telemetry. Deterministic, locale-independent (no toLocaleString).
import { AU, KM_PER_UNIT, C_KM_S } from '../core/astro.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const MINUS = '−';

/** 1234567 -> "1,234,567" */
export function group(n) {
  const neg = n < 0;
  const s = String(Math.round(Math.abs(n)));
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return (neg ? MINUS : '') + out;
}

/** Fixed decimals with a typographic minus. */
export function fixed(n, d) {
  const s = Math.abs(n).toFixed(d);
  return (n < 0 && +s !== 0 ? MINUS : '') + s;
}

/** Round to `sig` significant figures, keeping integer formatting with thousands separators. */
export function sigKm(km, sig = 4) {
  if (km < 1) return fixed(km, 2);
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(km)) + 1 - sig));
  return group(Math.round(km / p) * p);
}

export function auFromUnits(u) {
  return u / AU;
}
export function kmFromUnits(u) {
  return u * KM_PER_UNIT;
}

/** AU with sensible precision. */
export function fmtAU(au) {
  if (au < 0.1) return fixed(au, 4);
  if (au < 10) return fixed(au, 3);
  return fixed(au, 2);
}

/** Large distances in km: "930,000 km", "108.2 million km", "4.50 billion km". Returns [number, unit]. */
export function fmtKmParts(km) {
  if (km < 1e6) return [sigKm(km, km < 1e4 ? 3 : 4), 'km'];
  if (km < 1e9) return [fixed(km / 1e6, km < 1e8 ? 2 : 1), 'million km'];
  return [fixed(km / 1e9, 3), 'billion km'];
}

/** Light-time: "3.1 s", "6 min 01 s", "1 h 12 min". Returns array of [value, unit] pairs. */
export function fmtLightTime(seconds) {
  if (seconds < 60) return [[fixed(seconds, seconds < 10 ? 2 : 1), 's']];
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h === 0) return [[String(m), 'min'], [pad(sec), 's']];
  return [[String(h), 'h'], [pad(m), 'min'], [pad(sec), 's']];
}

export function lightSecondsFromUnits(u) {
  return (u * KM_PER_UNIT) / C_KM_S;
}

/** Apparent speed from multiples of c: "37.2 c", "0.31 c", or "1,840 km/s" when slow. Returns [value, unit]. */
export function fmtSpeed(speedC) {
  if (!(speedC > 0)) return ['0', 'km/s'];
  if (speedC >= 100) return [group(speedC), 'c'];
  if (speedC >= 10) return [fixed(speedC, 1), 'c'];
  if (speedC >= 0.1) return [fixed(speedC, 2), 'c'];
  const kms = speedC * C_KM_S;
  if (kms >= 100) return [group(kms), 'km/s'];
  return [fixed(kms, kms < 10 ? 2 : 1), 'km/s'];
}

/** "2 Nov 2026" and "14:32" (UTC) */
export function fmtDateUTC(date) {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}
export function fmtTimeUTC(date) {
  return `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}
export function fmtDateLong(date) {
  return `${date.getUTCDate()} ${MONTHS_LONG[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** Light-time as running text, in the telemetry's own format: "1 h 18 min 23 s" */
export function fmtLightTimeText(seconds) {
  return fmtLightTime(seconds).map(([n, u]) => `${n} ${u}`).join(' ');
}

// a duration written in running text: "78 min 23 s", "2 h 42 min", "6 h 23 min", "15.6 s"
const DUR_RE = /(\d+(?:\.\d+)?)\s*h(?:\s+(\d+)\s*min)?(?:\s+(\d+(?:\.\d+)?)\s*s)?(?![A-Za-z])|(\d+)\s*min(?:\s+(\d+(?:\.\d+)?)\s*s)?(?![A-Za-z])/g;
/** Every duration in a string: [{ text, index, seconds }] */
export function durationsIn(s) {
  const out = [];
  for (const m of String(s).matchAll(DUR_RE)) {
    const sec = m[1] != null ? +m[1] * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : +m[4] * 60 + (+m[5] || 0);
    out.push({ text: m[0], index: m.index, seconds: sec, hasSeconds: m[1] != null ? m[3] != null : m[5] != null });
  }
  return out;
}

const MONTH_RE = '(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)';
const UNIT_AFTER = /(\d) (?=(?:min|s|h|km\/h|km|AU|°C|°|K|m|days?|years?|hours?|minutes?|seconds?|million|billion|times|×|%)(?![A-Za-z]))/g;
/** Typographic glue for running text: a date never splits ("2 November 2026"), a number keeps its unit. */
export function typo(s) {
  if (!s) return s || '';
  return String(s)
    .replace(new RegExp(`(\\d{1,2}) (${MONTH_RE}) (\\d{4})`, 'g'), '$1 $2 $3')
    .replace(UNIT_AFTER, '$1 ')
    .replace(/(million|billion) (?=(?:km|°C|years|kilometres)(?![A-Za-z]))/g, '$1 ')
    .replace(/ (—|–) /g, ' $1 ');
}

/** Film clock: "4:07" */
export function fmtClock(t) {
  t = Math.max(0, Math.floor(t + 1e-6));
  return `${Math.floor(t / 60)}:${pad(t % 60)}`;
}
