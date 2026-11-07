// The cut as data (for HUD / audio retiming): node src/journey/dev/table.mjs [epochISO] [--md]
import { create } from '../director.js';
import { makeNodeCtx } from './node-ctx.mjs';
const args = process.argv.slice(2);
const epochISO = args.find((a) => /\d{4}-/.test(a)) || '2026-11-02T12:00:00Z';
const md = args.includes('--md');
const d = await create(makeNodeCtx(epochISO));
const f = (x) => x.toFixed(1);
if (md) {
  console.log(`Duration **${f(d.duration)} s** (${epochISO}). Cuts (dip to black, ~0.75 s, centred on): ${d._film.cuts.map(f).join(', ')}.\n`);
  console.log('| chapter | t0 | t1 | title card (body caption) | other captions | audio cues |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const c of d.chapters) {
    const caps = d.captions.filter((k) => k.t0 >= c.t0 - 0.01 && k.t0 < c.t1);
    const body = caps.filter((k) => k.kind === 'body').map((k) => `${k.id} ${f(k.t0)}-${f(k.t1)}`).join(', ');
    const other = caps.filter((k) => k.kind !== 'body').map((k) => `${k.title} ${f(k.t0)}-${f(k.t1)}`).join(', ');
    const cues = d.audioCues.filter((k) => k.t >= c.t0 - 0.01 && k.t < c.t1).map((k) => `${k.id} ${f(k.t)}`).join(', ');
    console.log(`| ${c.id} | ${f(c.t0)} | ${f(c.t1)} | ${body} | ${other} | ${cues} |`);
  }
} else {
  console.log('duration', f(d.duration));
  console.log('chapters:', d.chapters.map((c) => `${c.id} ${f(c.t0)}-${f(c.t1)}`).join(' | '));
  console.log('cuts:', d._film.cuts.map(f).join(' '));
  console.log('cues:', d.audioCues.map((c) => `${c.id}@${f(c.t)}(${f(c.dur)})`).join(' '));
  console.log('captions:', d.captions.map((c) => `${c.kind || ''}:${c.id || c.title} ${f(c.t0)}-${f(c.t1)}`).join(' | '));
}
