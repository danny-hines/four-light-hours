// HUD stylesheet (injected once). Everything is scoped under #flh-hud / #flh-splash.
//
// Every size is expressed in one unit, --u: 1 CSS px at 1600x900, growing on larger viewports (a 4K TV or a
// projector at 1:1 scaling gets --u = 2.4) so that type, rules, icons and offsets keep their proportion to the
// picture. Hairlines use --hl (a whole number of pixels, set from JS) so they stay crisp.
import { SANS, SERIF } from './fonts.js';

const u = (n) => `calc(${n} * var(--u))`;

export function css() {
  return /* css */ `
#flh-hud, #flh-splash {
  --u: clamp(1px, min(calc(100vh / 900), calc(100vw / 1440)), 2.6px);
  --hl: 1px;
  --sans: ${SANS};
  --serif: ${SERIF};
  --mx: clamp(20px, 6.2vw, ${u(116)});
  --mb: clamp(84px, 13.5vh, ${u(156)});
  --mt: clamp(16px, 4.4vh, ${u(46)});
  --lb: 0px;
  --hair: rgba(255,255,255,.34);
  --dim: rgba(255,255,255,.58);
  --ts: 0 0 1px rgba(0,0,0,.45), 0 1px 3px rgba(0,0,0,.40), 0 2px 22px rgba(0,0,0,.42);
  color: #fff;
  font-family: var(--sans);
  font-synthesis: none;
  font-kerning: normal;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
  -webkit-tap-highlight-color: transparent;
}
#flh-hud *, #flh-splash * { box-sizing: border-box; }
#flh-hud { position: fixed; inset: 0; pointer-events: none; z-index: 10; overflow: hidden; user-select: none; -webkit-user-select: none; }
#flh-hud [hidden], #flh-splash [hidden] { display: none !important; }
#flh-hud h1, #flh-hud h2, #flh-hud p, #flh-splash h1, #flh-splash p { margin: 0; font-weight: inherit; }
#flh-hud .flh-layer { position: absolute; inset: 0; }
#flh-hud .flh-overlay { transition: opacity .5s ease; }
#flh-hud .flh-scrims { transition: opacity .5s ease; }
#flh-hud.flh-clean .flh-overlay, #flh-hud.flh-clean .flh-labels, #flh-hud.flh-clean .flh-scrims { opacity: 0; }

/* ------------------------------------------------------------------ legibility scrims */
#flh-hud .flh-scrim { position: absolute; width: 0; height: 0; pointer-events: none; opacity: 0; will-change: opacity; }
/* corner-anchored, like a lens vignette that deepens only where text needs it (data-k: the text block's corner) */
#flh-hud .flh-scrim-bl { left: 0; bottom: 0; background: radial-gradient(ellipse 100% 100% at 0% 100%, rgba(0,0,0,.62) 0%, rgba(0,0,0,.55) 42%, rgba(0,0,0,.36) 64%, rgba(0,0,0,.14) 84%, rgba(0,0,0,0) 100%); }
#flh-hud .flh-scrim-bl[data-k=br] { left: auto; right: 0; background: radial-gradient(ellipse 100% 100% at 100% 100%, rgba(0,0,0,.62) 0%, rgba(0,0,0,.55) 42%, rgba(0,0,0,.36) 64%, rgba(0,0,0,.14) 84%, rgba(0,0,0,0) 100%); }
#flh-hud .flh-scrim-bl[data-k=tl] { bottom: auto; top: 0; background: radial-gradient(ellipse 100% 100% at 0% 0%, rgba(0,0,0,.62) 0%, rgba(0,0,0,.55) 42%, rgba(0,0,0,.36) 64%, rgba(0,0,0,.14) 84%, rgba(0,0,0,0) 100%); }
#flh-hud .flh-scrim-tr { right: 0; top: 0; background: radial-gradient(ellipse 100% 100% at 100% 0%, rgba(0,0,0,.6) 0%, rgba(0,0,0,.52) 42%, rgba(0,0,0,.32) 64%, rgba(0,0,0,.12) 84%, rgba(0,0,0,0) 100%); }
#flh-hud .flh-scrim-tr[data-k=tl] { right: auto; left: 0; background: radial-gradient(ellipse 100% 100% at 0% 0%, rgba(0,0,0,.6) 0%, rgba(0,0,0,.52) 42%, rgba(0,0,0,.32) 64%, rgba(0,0,0,.12) 84%, rgba(0,0,0,0) 100%); }
#flh-hud .flh-scrim-c { left: 0; top: 0; background: radial-gradient(farthest-side, rgba(0,0,0,.56) 0%, rgba(0,0,0,.5) 52%, rgba(0,0,0,.32) 72%, rgba(0,0,0,.11) 88%, rgba(0,0,0,0) 100%); }
/* line bands: one feathered band behind each line of a card / caption (geometry, colour and opacity from JS) */
#flh-hud .flh-band { position: absolute; left: 0; top: 0; pointer-events: none; opacity: 0; border-radius: 999px; will-change: opacity; }
/* adaptive halo: --halo (0..1) is the estimated brightness behind the text */
#flh-hud .flh-card, #flh-hud .flh-caption, #flh-hud .flh-open, #flh-hud .flh-end, #flh-hud .flh-tele, #flh-hud .flh-label {
  --halo: 0;
  text-shadow: 0 0 1px rgba(0,0,0,calc(.4 + .25 * var(--halo))), 0 1px ${u(3)} rgba(0,0,0,calc(.34 + .2 * var(--halo))),
               0 0 calc(${u(4)} + ${u(6)} * var(--halo)) rgba(0,0,0,calc(.12 + .38 * var(--halo))),
               0 0 calc(${u(16)} + ${u(14)} * var(--halo)) rgba(0,0,0,calc(.3 + .12 * var(--halo))); }

/* ------------------------------------------------------------------ chapter title card */
/* placement (chosen per beat to keep off the subject): default lower-left; .at-r lower-right; .at-t upper-left */
/* --lift: how far the transport controls push the lower text up while they are shown (set from JS) */
#flh-hud .flh-card, #flh-hud .flh-caption, #flh-hud .flh-chap { position: absolute; left: var(--mx); bottom: calc(var(--mb) + var(--lb)); margin-bottom: var(--lift, 0px); transition: margin-bottom .45s ease; }
#flh-hud .flh-card.at-t, #flh-hud .flh-caption.at-t { margin-bottom: 0; }
#flh-hud .flh-probe { position: absolute; left: 0; bottom: 0; width: var(--mx); height: var(--mb); visibility: hidden; pointer-events: none; }
#flh-hud .flh-card, #flh-hud .flh-caption, #flh-hud .flh-end { font-size: ${u(16)}; } /* em-based widths scale with --u */
#flh-hud .flh-card { max-width: calc(100vw - 2 * var(--mx)); will-change: opacity, transform; }
#flh-hud .at-r { left: auto; right: var(--mx); text-align: right; }
#flh-hud .at-t { bottom: auto; top: calc(var(--mt) + var(--lb) + ${u(4)}); }
#flh-hud .flh-measure { visibility: hidden !important; opacity: 1 !important; transform: none !important; pointer-events: none; }
#flh-hud .flh-measure * { opacity: 1 !important; transform: none !important; transition: none !important; }
#flh-hud .flh-kicker { display: flex; align-items: baseline; gap: .95em; font: 400 ${u(11)}/1 var(--sans); letter-spacing: .34em; text-transform: uppercase; color: rgba(255,255,255,calc(.76 + .2 * var(--halo))); white-space: nowrap; }
#flh-hud .flh-kicker .n { font-weight: 500; letter-spacing: .22em; color: #fff; }
/* chapter slate: names the chapter in the lower-left while the film travels, before its title card */
#flh-hud .flh-chap { display: flex; align-items: baseline; gap: .95em; font: 400 ${u(11)}/1 var(--sans); letter-spacing: .34em; text-transform: uppercase; color: rgba(255,255,255,.8); white-space: nowrap; will-change: opacity; }
#flh-hud .flh-chap .n { font-weight: 500; letter-spacing: .22em; color: #fff; }
#flh-hud .flh-chap .bar { display: inline-block; width: ${u(22)}; height: var(--hl); background: rgba(255,255,255,.5); transform: translateY(-.32em); }
#flh-hud .flh-chap.at-r { left: auto; right: var(--mx); margin-right: -.34em; }
#flh-hud .flh-kicker .bar { display: inline-block; width: ${u(22)}; height: var(--hl); background: rgba(255,255,255,.5); transform: translateY(-.32em); }
#flh-hud .flh-title { margin: .4em 0 0 -.04em; font: 250 clamp(34px, 4.1vw, ${u(68)})/1 var(--sans); letter-spacing: .24em; text-transform: uppercase; white-space: nowrap; font-variation-settings: 'wght' 250; }
#flh-hud .flh-title .c { display: inline-block; will-change: opacity, transform; }
#flh-hud .flh-rule { height: var(--hl); width: clamp(150px, 24vw, ${u(400)}); margin: clamp(16px, 2.4vh, ${u(26)}) 0 clamp(14px, 2vh, ${u(22)});
  background: linear-gradient(90deg, rgba(255,255,255,.78) 0%, rgba(255,255,255,.30) 55%, rgba(255,255,255,0) 100%); transform-origin: 0 50%; box-shadow: 0 0 ${u(10)} rgba(0,0,0,.35); }
#flh-hud .flh-sub { max-width: 31em; font: italic 500 clamp(18px, 1.62vw, ${u(27)})/1.34 var(--serif); color: rgba(255,255,255,.95); letter-spacing: .005em; text-wrap: balance; }
/* facts: equal columns (--nf of them), so the row keeps one rhythm whatever the values; values wrap balanced */
#flh-hud .flh-facts { display: grid; grid-template-columns: repeat(var(--nf, 3), 11.5em); gap: ${u(16)} clamp(20px, 2.4vw, ${u(40)}); margin-top: clamp(16px, 2.6vh, ${u(28)}); }
#flh-hud .flh-fact { min-width: 0; }
#flh-hud .flh-fact .v { text-wrap: balance; }
#flh-hud .flh-fact .k { font: 400 ${u(9.5)}/1 var(--sans); letter-spacing: .27em; text-transform: uppercase; color: rgba(255,255,255,calc(.66 + .26 * var(--halo))); margin-bottom: ${u(9)}; white-space: nowrap; }
#flh-hud .flh-fact .v { font: 300 clamp(13px, 1vw, ${u(15.5)})/1.32 var(--sans); letter-spacing: .025em; font-variant-numeric: tabular-nums lining-nums; color: rgba(255,255,255,.94); }
#flh-hud .flh-fact .v b { font-weight: 420; font-variation-settings: 'wght' 420; }
#flh-hud .flh-data { max-width: 46em; margin-top: clamp(14px, 2.2vh, ${u(20)}); padding-top: ${u(12)}; border-top: var(--hl) solid rgba(255,255,255,.16);
  font: 300 clamp(12px, .88vw, ${u(13.5)})/1.45 var(--sans); letter-spacing: .03em; color: rgba(255,255,255,calc(.76 + .2 * var(--halo))); font-variant-numeric: tabular-nums lining-nums; text-wrap: pretty; }
#flh-hud .flh-data b { font-weight: 420; font-variation-settings: 'wght' 420; color: rgba(255,255,255,.95); }
/* mirrored (lower-right) card: everything hangs from the right margin, trailing tracking compensated */
#flh-hud .flh-card.at-r .flh-kicker { justify-content: flex-end; margin-right: -.34em; }
#flh-hud .flh-card.at-r .flh-title { margin-left: 0; margin-right: -.24em; }
#flh-hud .flh-card.at-r .flh-rule { margin-left: auto; transform-origin: 100% 50%; background: linear-gradient(270deg, rgba(255,255,255,.78) 0%, rgba(255,255,255,.30) 55%, rgba(255,255,255,0) 100%); }
#flh-hud .flh-card.at-r .flh-sub, #flh-hud .flh-card.at-r .flh-data { margin-left: auto; }
#flh-hud .flh-card.at-r .flh-facts { justify-content: end; }
#flh-hud .flh-card.at-r .flh-fact .k { margin-right: -.27em; }
/* narrower reflow: the subtitle wraps sooner and the facts stack two by two */
#flh-hud .flh-card.f-narrow .flh-sub { max-width: 17em; }
#flh-hud .flh-card.f-narrow .flh-facts { grid-template-columns: repeat(2, 11.5em); gap: ${u(14)} clamp(20px, 2.4vw, ${u(40)}); }
#flh-hud .flh-card.at-r.f-narrow .flh-facts { justify-content: end; }
/* three facts two by two: the third spans the row instead of leaving a hole */
#flh-hud .flh-card.f-narrow .flh-fact:nth-child(3):last-child { grid-column: 1 / -1; }
#flh-hud .flh-card.f-narrow .flh-data { max-width: 24em; }
/* single column: for a big disc beside the card */
#flh-hud .flh-card.f-col .flh-sub { max-width: 13.5em; }
#flh-hud .flh-card.f-col .flh-facts { grid-template-columns: 14em; gap: ${u(13)}; }
#flh-hud .flh-card.at-r.f-col .flh-facts { justify-content: end; }
#flh-hud .flh-card.f-col .flh-fact { max-width: 15em; }
#flh-hud .flh-card.f-col .flh-data { max-width: 19em; }
/* short form when the subject fills every corner: name and subtitle only */
#flh-hud .flh-card.f-compact .flh-facts, #flh-hud .flh-card.f-compact .flh-data { display: none; }
/* ------------------------------------------------------------------ captions */
#flh-hud .flh-caption { max-width: min(30em, calc(100vw - 2 * var(--mx))); }
#flh-hud .flh-caption.f-narrow { max-width: min(21em, calc(100vw - 2 * var(--mx))); }
#flh-hud .flh-caption .kick { display: block; margin-bottom: ${u(14)}; font: 400 ${u(10)}/1 var(--sans); letter-spacing: .32em; text-transform: uppercase; color: rgba(255,255,255,calc(.7 + .26 * var(--halo))); }
#flh-hud .flh-caption .kick::before { content: ''; display: inline-block; width: ${u(22)}; height: var(--hl); margin-right: ${u(12)}; background: rgba(255,255,255,.5); vertical-align: .3em; }
#flh-hud .flh-caption.at-r .kick { margin-right: -.32em; }
#flh-hud .flh-caption.at-r .kick::before { display: none; }
#flh-hud .flh-caption.at-r .kick::after { content: ''; display: inline-block; width: ${u(22)}; height: var(--hl); margin-left: ${u(12)}; background: rgba(255,255,255,.5); vertical-align: .3em; }
#flh-hud .flh-caption .txt { font: italic 500 clamp(19px, 1.72vw, ${u(29)})/1.36 var(--serif); color: rgba(255,255,255,.96); text-wrap: balance; }
#flh-hud .flh-caption .meta { margin-top: ${u(12)}; font: 300 ${u(12)}/1.4 var(--sans); letter-spacing: .05em; color: rgba(255,255,255,calc(.7 + .24 * var(--halo))); font-variant-numeric: tabular-nums lining-nums; text-wrap: balance; }
#flh-hud .flh-caption .meta b { font-weight: 420; color: rgba(255,255,255,.92); }
#flh-hud .flh-caption .w { display: inline-block; white-space: pre; will-change: opacity; }

/* ------------------------------------------------------------------ cold open + closing */
#flh-hud .flh-open { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); text-align: center; padding: 0 16px; }
#flh-hud .flh-open .t { display: flex; flex-wrap: wrap; justify-content: center; column-gap: 1.25em; row-gap: .3em; font: 200 clamp(26px, 4.5vw, ${u(76)})/1.05 var(--sans); letter-spacing: .5em; text-transform: uppercase; font-variation-settings: 'wght' 200; }
#flh-hud .flh-open .word { display: inline-block; white-space: nowrap; margin-right: -.5em; }
#flh-hud .flh-open .c { display: inline-block; will-change: opacity, transform; }
#flh-hud .flh-open .r { height: var(--hl); width: min(46vw, ${u(560)}); margin: clamp(22px, 3.6vh, ${u(38)}) auto; background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.7) 50%, rgba(255,255,255,0)); }
#flh-hud .flh-open .s { font: italic 500 clamp(17px, 1.6vw, ${u(25)})/1.4 var(--serif); color: rgba(255,255,255,.88); text-wrap: balance; }
#flh-hud .flh-open .l { margin-top: clamp(14px, 2.4vh, ${u(22)}); font: 400 ${u(10)}/1.6 var(--sans); letter-spacing: .32em; text-transform: uppercase; color: rgba(255,255,255,.62); text-wrap: balance; }
/* portrait phone under the 2.39:1 matte: the title inside the picture strip, its lines below it in the bar */
#flh-hud .flh-open.split { top: 0; bottom: 0; transform: none; padding: 0; }
#flh-hud .flh-open.split .hd { position: absolute; left: 16px; right: 16px; top: 50%; transform: translateY(-50%); }
#flh-hud .flh-open.split .t { font-size: min(26px, 7.4vw, calc(var(--strip) * .17)); row-gap: .42em; }
#flh-hud .flh-open.split .r { margin: min(18px, calc(var(--strip) * .1)) auto 0; width: 52vw; }
#flh-hud .flh-open.split .ft { position: absolute; left: 22px; right: 22px; top: calc(50% + var(--strip) / 2 + 26px); }
#flh-hud .flh-open.split .s { font-size: 17px; }
#flh-hud .flh-end { position: absolute; left: 0; right: 0; bottom: clamp(150px, 17vh, ${u(200)}); text-align: center; padding: 0 16px; }
#flh-hud .flh-end .t { font: 250 clamp(20px, 2.4vw, ${u(38)})/1 var(--sans); letter-spacing: .5em; margin-right: -.5em; text-transform: uppercase; }
#flh-hud .flh-end .r { height: var(--hl); width: min(30vw, ${u(340)}); margin: clamp(16px, 2.6vh, ${u(26)}) auto; background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.6) 50%, rgba(255,255,255,0)); }
#flh-hud .flh-end .s { font: italic 500 clamp(15px, 1.3vw, ${u(21)})/1.45 var(--serif); color: rgba(255,255,255,.86); max-width: 36em; margin: 0 auto; text-wrap: balance; }
#flh-hud .flh-credits { display: grid; grid-template-columns: repeat(3, minmax(0, 15em)); justify-content: center; gap: ${u(18)} clamp(18px, 3vw, ${u(48)}); margin-top: clamp(22px, 4vh, ${u(40)}); }
#flh-hud .flh-credit .k { font: 400 ${u(9)}/1 var(--sans); letter-spacing: .28em; text-transform: uppercase; color: rgba(255,255,255,.6); margin-bottom: ${u(8)}; }
#flh-hud .flh-credit .v { font: 300 ${u(12.5)}/1.35 var(--sans); letter-spacing: .03em; color: rgba(255,255,255,.86); }
#flh-hud .flh-end-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: ${u(14)}; margin-top: clamp(20px, 3.5vh, ${u(34)}); transition: opacity .9s ease; }
#flh-hud .flh-end-actions.off { visibility: hidden; opacity: 0; pointer-events: none; }
#flh-hud .flh-replay { pointer-events: auto; margin-top: 0; }
#flh-hud .flh-replay.explore { background: rgba(255,255,255,.92); border-color: #fff; color: #05070a; }
#flh-hud .flh-replay.explore:hover { background: #fff; }

/* ------------------------------------------------------------------ telemetry */
#flh-hud .flh-tele { position: absolute; top: calc(var(--mt) + var(--lb)); right: var(--mx); width: ${u(272)}; color: rgba(255,255,255,.82); }
#flh-hud .flh-tele .top { height: var(--hl); background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.32)); margin-bottom: ${u(11)}; }
/* moved to the top-left for a stretch where a world would lie under it (hud.js planTelemetry) */
#flh-hud .flh-tele.at-l { right: auto; left: var(--mx); }
#flh-hud .flh-tele.at-l .top { background: linear-gradient(270deg, rgba(255,255,255,0), rgba(255,255,255,.32)); }
#flh-hud .flh-tele .cell { display: flex; justify-content: space-between; align-items: baseline; gap: ${u(14)}; margin: 0 0 ${u(7)}; }
#flh-hud .flh-tele .vv { text-align: right; min-width: 0; }
#flh-hud .flh-tele .k { flex: none; font: 400 ${u(8.5)}/1 var(--sans); letter-spacing: .26em; text-transform: uppercase; color: rgba(255,255,255,calc(.62 + .28 * var(--halo))); white-space: nowrap; }
#flh-hud .flh-tele .k .x { margin-left: .9em; letter-spacing: .08em; color: rgba(255,255,255,.4); }
#flh-hud .flh-tele .v { font: 300 ${u(12.5)}/1.3 var(--sans); letter-spacing: .03em; font-variant-numeric: tabular-nums lining-nums; white-space: nowrap; }
#flh-hud .flh-tele .v .u { color: rgba(255,255,255,calc(.62 + .26 * var(--halo))); font-size: .86em; margin-left: .28em; letter-spacing: .06em; }
#flh-hud .flh-tele .v .u + .n { margin-left: .5em; }
#flh-hud .flh-tele .v.sm { font-size: ${u(11)}; color: rgba(255,255,255,calc(.64 + .28 * var(--halo))); }
#flh-hud .flh-tele .v .nm { letter-spacing: .2em; text-transform: uppercase; font-size: ${u(10.5)}; font-weight: 400; color: rgba(255,255,255,.9); }
#flh-hud .flh-tele .ruler { position: relative; height: ${u(23)}; margin: ${u(3)} 0 ${u(8)}; }
#flh-hud .flh-tele .ruler .base { position: absolute; left: 0; right: 0; top: ${u(7)}; height: var(--hl); background: rgba(255,255,255,.24); }
#flh-hud .flh-tele .ruler .done { position: absolute; left: 0; top: ${u(7)}; height: var(--hl); background: rgba(255,255,255,.62); width: 0; }
#flh-hud .flh-tele .ruler .tk { position: absolute; top: ${u(4)}; width: var(--hl); height: ${u(7)}; background: rgba(255,255,255,.46); }
#flh-hud .flh-tele .ruler .tk.in { top: ${u(5.5)}; height: ${u(4)}; background: rgba(255,255,255,.38); }
#flh-hud .flh-tele .ruler .tk.sun { top: ${u(5.5)}; width: ${u(4)}; height: ${u(4)}; margin-left: ${u(-2)}; border-radius: 50%; background: rgba(255,240,210,.85); box-shadow: 0 0 ${u(6)} rgba(255,220,170,.7); }
#flh-hud .flh-tele .ruler .tl { position: absolute; top: ${u(13)}; font: 400 ${u(8)}/1 var(--sans); letter-spacing: .14em; margin-left: .07em; color: rgba(255,255,255,.58); transform: translateX(-50%); text-transform: uppercase; }
#flh-hud .flh-tele .ruler .me { position: absolute; top: ${u(1.5)}; width: ${u(1.5)}; height: ${u(12)}; margin-left: ${u(-0.75)}; background: #fff; box-shadow: 0 0 ${u(6)} rgba(255,255,255,.75); }
#flh-hud .flh-tele .ruler .end { position: absolute; right: 0; top: ${u(13)}; font: 400 ${u(8)}/1 var(--sans); letter-spacing: .12em; color: rgba(255,255,255,.5); }

/* ------------------------------------------------------------------ labels */
#flh-hud .flh-labels { transition: opacity .4s ease; }
#flh-hud .flh-label { position: absolute; left: 0; top: 0; will-change: transform, opacity; }
#flh-hud .flh-ret { position: absolute; left: 0; top: 0; border-radius: 50%; border: var(--hl) solid rgba(255,255,255,.66); box-shadow: 0 0 0 .5px rgba(0,0,0,.25), 0 0 ${u(8)} rgba(0,0,0,.35); }
#flh-hud .flh-ret::before, #flh-hud .flh-ret::after { content: ''; position: absolute; --tc: rgba(255,255,255,.66); --tl: ${u(4)}; }
#flh-hud .flh-ret::before { left: 50%; top: ${u(-6)}; bottom: ${u(-6)}; width: var(--hl); margin-left: -.5px; background: linear-gradient(180deg, var(--tc) 0 var(--tl), transparent var(--tl) calc(100% - var(--tl)), var(--tc) calc(100% - var(--tl))); }
#flh-hud .flh-ret::after { top: 50%; left: ${u(-6)}; right: ${u(-6)}; height: var(--hl); margin-top: -.5px; background: linear-gradient(90deg, var(--tc) 0 var(--tl), transparent var(--tl) calc(100% - var(--tl)), var(--tc) calc(100% - var(--tl))); }
#flh-hud .flh-ret.sm { border-color: rgba(255,255,255,.8); }
#flh-hud .flh-ret.sm::before, #flh-hud .flh-ret.sm::after { display: none; }
#flh-hud .flh-lead { position: absolute; left: 0; top: -.5px; height: var(--hl); width: 0; transform-origin: 0 50%; background: linear-gradient(90deg, rgba(255,255,255,.55), rgba(255,255,255,.3)); }
#flh-hud .flh-ltext { position: absolute; left: 0; top: 0; white-space: nowrap; }
#flh-hud .flh-ltext .nm { display: block; font: 400 ${u(10)}/1 var(--sans); letter-spacing: .24em; text-transform: uppercase; color: rgba(255,255,255,.94); }
#flh-hud .flh-ltext .sb { display: block; margin-top: ${u(5)}; font: 300 ${u(9.5)}/1 var(--sans); letter-spacing: .06em; font-variant-numeric: tabular-nums; color: rgba(255,255,255,calc(.6 + .3 * var(--halo))); }
#flh-hud .flh-ltext.left { text-align: right; }
/* callout column (points inside the Sun's glare): a small ringed dot and a leader with a dark keyline, so both
   read against the glare they start in */
#flh-hud .flh-label.col .flh-ret { border-color: rgba(255,255,255,.92); box-shadow: 0 0 0 1px rgba(0,0,0,.55), 0 0 ${u(4)} rgba(0,0,0,.5); }
#flh-hud .flh-label.col .flh-lead { background: rgba(255,255,255,.62); box-shadow: 0 0 0 .75px rgba(0,0,0,.45), 0 0 ${u(3)} rgba(0,0,0,.35); }

/* ------------------------------------------------------------------ toast */
#flh-hud .flh-toast { position: absolute; top: var(--mt); left: 50%; transform: translate(-50%, ${u(-6)}); opacity: 0; transition: opacity .35s ease, transform .35s ease;
  font: 400 ${u(10)}/1 var(--sans); letter-spacing: .3em; text-transform: uppercase; color: rgba(255,255,255,.85); text-shadow: var(--ts); white-space: nowrap; }
#flh-hud .flh-toast.on { opacity: 1; transform: translate(-50%, 0); }

/* ------------------------------------------------------------------ timeline + controls */
#flh-hud .flh-ctl { position: absolute; left: 0; right: 0; bottom: 0; height: ${u(138)}; padding: 0 var(--mx); pointer-events: none; opacity: 0; transform: translateY(${u(8)});
  transition: opacity .45s ease, transform .45s ease; background: linear-gradient(0deg, rgba(0,0,0,.55) 0%, rgba(0,0,0,.26) 45%, rgba(0,0,0,0) 100%); }
#flh-hud .flh-ctl.on { opacity: 1; transform: none; pointer-events: auto; }
#flh-hud .flh-row { position: absolute; left: var(--mx); right: var(--mx); bottom: ${u(46)}; height: ${u(40)}; display: flex; align-items: center; gap: ${u(6)}; }
#flh-hud .flh-row .sp { flex: 1; }
#flh-hud .flh-btn { appearance: none; -webkit-appearance: none; display: inline-grid; place-items: center; width: max(40px, ${u(40)}); height: max(40px, ${u(40)}); margin: 0; padding: 0; border: 0; border-radius: 50%;
  background: transparent; color: rgba(255,255,255,.82); cursor: pointer; transition: color .2s ease, background-color .2s ease; }
#flh-hud .flh-btn svg { width: ${u(20)}; height: ${u(20)}; }
#flh-hud .flh-btn:hover { color: #fff; background: rgba(255,255,255,.08); }
#flh-hud .flh-btn:focus-visible, #flh-splash button:focus-visible, #flh-hud .flh-track:focus-visible { outline: 1px solid rgba(255,255,255,.8); outline-offset: 2px; }
#flh-hud .flh-btn.off { color: rgba(255,255,255,.5); }
#flh-hud .flh-btn.play { margin-left: ${u(-10)}; }
#flh-hud .flh-btn.flh-explore { width: auto; display: inline-flex; align-items: center; gap: ${u(9)}; padding: 0 ${u(18)} 0 ${u(13)}; margin-right: ${u(10)}; border: 1px solid rgba(255,255,255,.4); border-radius: 999px;
  font: 400 ${u(9.5)}/1 var(--sans); letter-spacing: .3em; text-transform: uppercase; color: #fff; height: max(34px, ${u(34)}); }
#flh-hud .flh-btn.flh-explore span { margin-right: -.3em; padding-top: 1px; }
#flh-hud .flh-btn.flh-explore:hover { border-color: rgba(255,255,255,.9); }
#flh-hud .flh-btn.flh-explore svg { width: ${u(17)}; height: ${u(17)}; }
#flh-hud .flh-time { margin-left: ${u(6)}; font: 300 ${u(12)}/1 var(--sans); letter-spacing: .06em; font-variant-numeric: tabular-nums; color: rgba(255,255,255,.8); white-space: nowrap; }
#flh-hud .flh-time .tot { color: rgba(255,255,255,.5); }
#flh-hud .flh-now { margin-left: ${u(18)}; font: 400 ${u(9.5)}/1 var(--sans); letter-spacing: .3em; text-transform: uppercase; color: rgba(255,255,255,.74); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#flh-hud .flh-now .n { color: rgba(255,255,255,.5); margin-right: .9em; }
#flh-hud .flh-track { position: absolute; left: var(--mx); right: var(--mx); bottom: ${u(18)}; height: ${u(26)}; cursor: pointer; touch-action: none; outline: none; }
#flh-hud .flh-track .line { position: absolute; left: 0; right: 0; top: ${u(12.5)}; height: var(--hl); background: rgba(255,255,255,.24); transition: height .2s ease, top .2s ease; }
#flh-hud .flh-track .fill { position: absolute; left: 0; top: ${u(12.5)}; height: var(--hl); width: 100%; background: rgba(255,255,255,.82); transform-origin: 0 50%; transform: scaleX(0); transition: height .2s ease, top .2s ease; }
#flh-hud .flh-track:hover .line, #flh-hud .flh-track.drag .line, #flh-hud .flh-track:hover .fill, #flh-hud .flh-track.drag .fill { top: ${u(12)}; height: calc(2 * var(--hl)); }
#flh-hud .flh-track .tick { position: absolute; top: ${u(9)}; width: var(--hl); height: ${u(8)}; background: rgba(255,255,255,.5); }
#flh-hud .flh-track .head { position: absolute; top: ${u(9.5)}; left: 0; width: ${u(7)}; height: ${u(7)}; margin-left: ${u(-3.5)}; border-radius: 50%; background: #fff; box-shadow: 0 0 ${u(8)} rgba(255,255,255,.6); }
/* chapter names sit centred on their segment, clamped inside the track (JS sets left = the name's left edge) */
#flh-hud .flh-track .cl { position: absolute; bottom: ${u(21)}; font: 400 ${u(8.5)}/1 var(--sans); letter-spacing: .24em; margin-right: -.24em; text-transform: uppercase; color: rgba(255,255,255,.56); white-space: nowrap; transition: color .25s ease; }
#flh-hud .flh-track .cl.cur { color: rgba(255,255,255,.92); }
#flh-hud .flh-track .tip { position: absolute; bottom: ${u(28)}; transform: translateX(-50%); padding: ${u(6)} ${u(9)} ${u(5)}; font: 400 ${u(9.5)}/1 var(--sans); letter-spacing: .2em; text-transform: uppercase; white-space: nowrap;
  color: #fff; background: rgba(8,10,14,.82); border: 1px solid rgba(255,255,255,.16); border-radius: 2px; opacity: 0; transition: opacity .15s ease; }
#flh-hud .flh-track .tip .tm { font-variant-numeric: tabular-nums; letter-spacing: .06em; color: rgba(255,255,255,.6); margin-left: .8em; }
#flh-hud .flh-track:hover .tip, #flh-hud .flh-track.drag .tip { opacity: 1; }

html.flh-idle, html.flh-idle body, html.flh-idle canvas { cursor: none !important; }
/* capture mode: no wall-clock transitions, every frame is exactly its own state */
#flh-hud.flh-capture, #flh-hud.flh-capture * { transition: none !important; animation: none !important; }

/* ------------------------------------------------------------------ splash */
#flh-splash { position: fixed; inset: 0; z-index: 20; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; padding: 0 var(--mx);
  background: radial-gradient(ellipse 90% 90% at 72% 50%, rgba(6,8,12,.86) 0%, rgba(0,0,0,.97) 70%), #000; transition: opacity 1.4s ease, visibility 0s linear 1.4s; overflow: hidden; }
#flh-splash.gone { opacity: 0; visibility: hidden; pointer-events: none; }
#flh-splash.static, #flh-splash.static * { transition: none !important; animation: none !important; }
#flh-splash .sp-text { position: relative; z-index: 1; max-width: ${u(640)}; text-shadow: var(--ts); }
#flh-splash .sp-kicker { font: 400 ${u(10.5)}/1 var(--sans); letter-spacing: .36em; text-transform: uppercase; color: rgba(255,255,255,.62); }
#flh-splash h1 { margin: ${u(26)} 0 0 -.04em; display: flex; flex-wrap: wrap; column-gap: .55em; row-gap: .25em; font: 200 clamp(30px, 4.1vw, ${u(66)})/1.04 var(--sans); letter-spacing: .4em; text-transform: uppercase; font-variation-settings: 'wght' 200; }
#flh-splash h1 span { white-space: nowrap; margin-right: -.4em; }
#flh-splash .sp-line { margin: ${u(26)} 0 0; max-width: 25em; font: italic 500 clamp(18px, 1.55vw, ${u(25)})/1.4 var(--serif); color: rgba(255,255,255,.88); text-wrap: balance; }
#flh-splash .sp-prog { position: relative; margin: ${u(40)} 0 0; width: min(${u(340)}, 100%); height: var(--hl); background: rgba(255,255,255,.16); overflow: hidden; }
#flh-splash .sp-prog i { position: absolute; inset: 0; background: rgba(255,255,255,.8); transform-origin: 0 50%; transform: scaleX(0); transition: transform .35s ease; }
#flh-splash .sp-status { margin-top: ${u(14)}; height: ${u(12)}; font: 400 ${u(9.5)}/1 var(--sans); letter-spacing: .3em; text-transform: uppercase; color: rgba(255,255,255,.52); font-variant-numeric: tabular-nums; }
#flh-splash .sp-begin, #flh-hud .flh-replay { appearance: none; -webkit-appearance: none; margin: ${u(26)} 0 0; padding: ${u(15)} ${u(34)} ${u(14)} calc(${u(34)} + .42em); border: 1px solid rgba(255,255,255,.5); border-radius: 999px; background: rgba(255,255,255,.02);
  color: #fff; font: 400 ${u(11)}/1 var(--sans); letter-spacing: .42em; text-transform: uppercase; cursor: pointer; transition: background-color .3s ease, border-color .3s ease, opacity .8s ease; }
#flh-splash .sp-begin:hover, #flh-hud .flh-replay:hover { background: rgba(255,255,255,.1); border-color: rgba(255,255,255,.85); }
#flh-splash .sp-begin[disabled] { opacity: 0; pointer-events: none; }
#flh-splash .sp-notes { display: flex; flex-wrap: wrap; gap: ${u(10)} ${u(28)}; margin-top: ${u(46)}; font: 400 ${u(9)}/1.3 var(--sans); letter-spacing: .26em; text-transform: uppercase; color: rgba(255,255,255,.56); }
#flh-splash .sp-notes span { display: inline-flex; align-items: center; gap: ${u(9)}; }
#flh-splash .sp-notes svg { opacity: .8; flex: none; width: ${u(15)}; height: ${u(15)}; }
#flh-splash .sp-orrery { position: relative; margin: 0; justify-self: center; width: min(44vw, 82vh, ${u(760)}); }
#flh-splash .sp-orrery svg { display: block; width: 100%; height: auto; overflow: visible; }
#flh-splash .sp-orrery figcaption { margin-top: ${u(6)}; text-align: center; font: 400 ${u(8.5)}/1.5 var(--sans); letter-spacing: .24em; text-transform: uppercase; color: rgba(255,255,255,.46); }
#flh-splash .orb { fill: none; stroke: rgba(255,255,255,.15); stroke-width: 1.3; }
#flh-splash .orb.earth { stroke: rgba(150,190,255,.3); }
#flh-splash .route { fill: none; stroke: rgba(255,226,180,.5); stroke-width: 1.4; stroke-dasharray: 3 5; }
#flh-splash .sp-names { position: absolute; left: 0; top: 0; width: 100%; aspect-ratio: 1 / 1; pointer-events: none; }
#flh-splash .pl-name { position: absolute; font: 400 ${u(8.5)}/1 var(--sans); letter-spacing: .22em; margin-right: -.22em; text-transform: uppercase; color: rgba(255,255,255,.64); white-space: nowrap; }
#flh-splash .pl-name[data-id=earth] { color: rgba(170,205,255,.85); }
#flh-splash .anim-l { opacity: 0; animation: flh-fade 1.4s ease forwards; }
#flh-splash .belt circle { fill: rgba(255,255,255,.22); }
#flh-splash .anim .orb { stroke-dasharray: 1 1; stroke-dashoffset: 1; animation: flh-draw 2.6s cubic-bezier(.3,.6,.2,1) forwards; }
#flh-splash .anim .route { opacity: 0; animation: flh-fade 2s ease 2.4s forwards; }
#flh-splash .anim .pl, #flh-splash .anim .belt { opacity: 0; animation: flh-fade 1.4s ease forwards; }
#flh-splash .anim-in { opacity: 0; animation: flh-rise 1.6s cubic-bezier(.2,.7,.2,1) forwards; }
@keyframes flh-draw { to { stroke-dashoffset: 0; } }
@keyframes flh-fade { to { opacity: 1; } }
@keyframes flh-rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

/* ------------------------------------------------------------------ narrow / mobile (portrait-ish; a landscape phone is 'short', below) */
@media (max-width: 760px) and (min-height: 521px), (max-width: 760px) and (orientation: portrait) {
  #flh-hud, #flh-splash { --mx: 20px; --mb: 104px; --mt: 16px; }
  #flh-hud .flh-title { font-size: clamp(28px, 8.8vw, 46px); letter-spacing: .2em; }
  #flh-hud .flh-card.at-r .flh-title { margin-right: -.2em; }
  #flh-hud .flh-rule { width: 46vw; }
  #flh-hud .flh-sub { font-size: 17.5px; max-width: 21em; }
  #flh-hud .flh-facts, #flh-hud .flh-card.f-narrow .flh-facts { grid-template-columns: repeat(var(--nf, 3), minmax(0, 1fr)); gap: 14px 14px; margin-top: 16px; }
  #flh-hud .flh-fact { min-width: 0; }
  #flh-hud .flh-fact .k { font-size: 8.5px; letter-spacing: .22em; margin-bottom: 6px; }
  #flh-hud .flh-fact .v { font-size: 12.5px; }
  #flh-hud .flh-caption .txt { font-size: 19px; }
  /* upper placement on a phone: below the telemetry block (--tb = its bottom edge, set from JS) */
  #flh-hud .at-t { top: calc(var(--tb, 160px) + 22px); }
  #flh-hud .flh-tele { left: var(--mx); right: var(--mx); width: auto; display: grid; grid-template-columns: 1.15fr 1fr 1fr; gap: 9px 12px; }
  #flh-hud .flh-tele .top { grid-column: 1 / -1; margin-bottom: 2px; }
  #flh-hud .flh-tele .cell { display: block; margin: 0; }
  #flh-hud .flh-tele .vv { text-align: left; }
  #flh-hud .flh-tele .k { margin-bottom: 5px; font-size: 7.5px; letter-spacing: .22em; }
  #flh-hud .flh-tele .v { font-size: 11.5px; }
  #flh-hud .flh-tele .v.sm { font-size: 10px; }
  #flh-hud .flh-tele [data-c=utc] { grid-column: span 2; }
  #flh-hud .flh-tele .ruler { grid-column: 1 / -1; order: 10; margin: 0; }
  #flh-hud .flh-credits { grid-template-columns: 1fr 1fr; }
  #flh-hud .flh-now, #flh-hud .flh-track .cl:not(.cur) { display: none; }
  #flh-hud .flh-row { bottom: 44px; }
  #flh-splash { grid-template-columns: 1fr; grid-template-rows: auto auto; align-content: center; gap: 8px; overflow-y: auto; padding-top: 24px; padding-bottom: 24px; }
  #flh-splash .sp-orrery { order: -1; width: min(84vw, 44vh); margin-bottom: 22px; }
  #flh-splash .sp-orrery figcaption { font-size: 7.5px; }
  #flh-splash h1 { margin-top: 18px; font-size: clamp(26px, 8.4vw, 40px); letter-spacing: .3em; }
  #flh-splash h1 span { margin-right: -.3em; }
  #flh-splash .sp-line { margin-top: 18px; font-size: 18px; }
  #flh-splash .sp-prog { margin-top: 28px; }
  #flh-splash .sp-notes { margin-top: 30px; }
}
/* ------------------------------------------------------------------ short landscape (a phone on its side, a letterbox window)
   Everything shrinks with --u (floored at 0.62, mirrored by unitFor in hud.js); small caps keep a legible px floor.
   Telemetry collapses to one dim line along the top, title cards drop their data line, captions tighten. */
@media (orientation: landscape) and (max-height: 520px) {
  #flh-hud, #flh-splash { --u: clamp(0.62px, calc(100vh / 560), 1px); --mx: clamp(18px, 4.6vw, 52px); --mb: clamp(34px, 10.5vh, 52px); --mt: 12px; }
  #flh-hud .flh-kicker { font-size: max(8.5px, ${u(11)}); letter-spacing: .3em; }
  #flh-hud .flh-title { font-size: clamp(24px, 8.4vh, 40px); letter-spacing: .2em; margin-top: .34em; }
  #flh-hud .flh-card.at-r .flh-title { margin-right: -.2em; }
  #flh-hud .flh-rule { width: min(30vw, 260px); margin: 9px 0 8px; }
  #flh-hud .flh-sub { font-size: 15px; line-height: 1.28; max-width: 24em; }
  #flh-hud .flh-card.f-narrow .flh-sub { max-width: 16em; }
  #flh-hud .flh-facts { grid-template-columns: repeat(var(--nf, 3), 10.5em); gap: 8px 16px; margin-top: 10px; }
  #flh-hud .flh-card.f-narrow .flh-facts { grid-template-columns: repeat(2, 10.5em); }
  #flh-hud .flh-fact .k { font-size: 7.5px; letter-spacing: .22em; margin-bottom: 5px; }
  #flh-hud .flh-fact .v { font-size: 11.5px; line-height: 1.28; }
  #flh-hud .flh-data { display: none; }
  #flh-hud .flh-caption { max-width: min(26em, calc(100vw - 2 * var(--mx))); }
  #flh-hud .flh-caption .kick { font-size: 8px; margin-bottom: 8px; }
  #flh-hud .flh-caption .txt { font-size: 16px; line-height: 1.3; }
  #flh-hud .flh-caption .meta { font-size: 10px; margin-top: 7px; }
  #flh-hud .flh-chap { font-size: 8.5px; }
  /* telemetry: one line of cells (key over value) under a slim light-time ruler */
  #flh-hud .flh-tele { width: auto; display: flex; justify-content: flex-end; align-items: flex-start; gap: 0 16px; padding-top: 9px; }
  #flh-hud .flh-tele .top { display: none; }
  #flh-hud .flh-tele .cell { display: block; margin: 0; }
  #flh-hud .flh-tele .vv { text-align: left; }
  #flh-hud .flh-tele .k { font-size: 7px; letter-spacing: .22em; margin-bottom: 4px; }
  #flh-hud .flh-tele .k .x { display: none; }
  #flh-hud .flh-tele .v { font-size: 10.5px; }
  #flh-hud .flh-tele .v.sm { display: none; }
  #flh-hud .flh-tele [data-c=tgt] .vv { display: flex; align-items: baseline; gap: .8em; }
  #flh-hud .flh-tele [data-c=tgt] .v.sm { display: block; font-size: 10px; }
  #flh-hud .flh-tele .ruler { position: absolute; left: 0; right: 0; top: 0; height: 5px; margin: 0; }
  #flh-hud .flh-tele .ruler .base, #flh-hud .flh-tele .ruler .done { top: 2px; }
  #flh-hud .flh-tele .ruler .tk { top: 0; height: 5px; }
  #flh-hud .flh-tele .ruler .tk.in { top: 1px; height: 3px; }
  #flh-hud .flh-tele .ruler .tk.sun { top: 1px; width: 3px; height: 3px; margin-left: -1.5px; }
  #flh-hud .flh-tele .ruler .me { top: -2px; height: 9px; }
  #flh-hud .flh-tele .ruler .tl, #flh-hud .flh-tele .ruler .end { display: none; }
  #flh-hud .flh-time { font-size: 11px; }
  #flh-hud .flh-now { font-size: 8px; }
  #flh-hud .flh-track .cl { font-size: 7.5px; letter-spacing: .2em; }
  #flh-hud .flh-end { bottom: 18px; margin-bottom: var(--lift, 0px); transition: margin-bottom .45s ease; }
  #flh-hud .flh-end .t { font-size: 19px; }
  #flh-hud .flh-end .r { margin: 11px auto; }
  #flh-hud .flh-end .s { font-size: 13.5px; line-height: 1.38; max-width: 44em; }
  #flh-hud .flh-credits { grid-template-columns: repeat(3, minmax(0, 17em)); margin-top: 12px; gap: 8px 26px; }
  #flh-hud .flh-credit .k { font-size: 7px; margin-bottom: 4px; }
  #flh-hud .flh-credit .v { font-size: 10px; line-height: 1.3; }
  #flh-hud .flh-end-actions { margin-top: 12px; gap: 8px; }
  #flh-hud .flh-replay { padding: 10px 22px 9px calc(22px + .42em); font-size: 9px; }
  #flh-hud .flh-open .l { font-size: 8px; }
}
@media (prefers-reduced-motion: reduce) {
  #flh-splash .anim-l { animation: none !important; opacity: 1 !important; }
  #flh-splash .anim .orb, #flh-splash .anim .route, #flh-splash .anim .pl, #flh-splash .anim .belt, #flh-splash .anim-in { animation: none !important; opacity: 1 !important; stroke-dashoffset: 0 !important; transform: none !important; }
  #flh-hud .flh-ctl, #flh-hud .flh-toast { transition: opacity .2s linear; transform: none !important; }
}
`;
}
