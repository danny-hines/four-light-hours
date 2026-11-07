// Timeline + transport controls: chapter markers, scrub/seek (mouse, pen, touch), play/pause, mute, labels,
// HUD toggle, fullscreen, keyboard, and idle auto-hide. Interactive chrome only — the film itself never depends on it.
import { ICONS } from './icons.js';
import { fmtClock } from './format.js';

const IDLE_MS = 3000;

export function createControls({ root, app, capture, forceShow, onToggleHud, onToggleLabels, toast, isSplashOpen, reduceMotion }) {
  const fsSupported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
  const ctl = document.createElement('div');
  ctl.className = 'flh-ctl';
  ctl.setAttribute('role', 'group');
  ctl.setAttribute('aria-label', 'Playback controls');
  ctl.innerHTML = `
    <div class="flh-row">
      <button class="flh-btn play" type="button" data-k="play" aria-label="Play (Space)" title="Play · Space">${ICONS.play}</button>
      <div class="flh-time"><span class="cur">0:00</span><span class="tot"> / 0:00</span></div>
      <div class="flh-now"><span class="n"></span><span class="nm"></span></div>
      <div class="sp"></div>
      <button class="flh-btn off" type="button" data-k="labels" aria-label="Show planet labels (L)" title="Planet labels · L" aria-pressed="false">${ICONS.labels}</button>
      <button class="flh-btn" type="button" data-k="mute" aria-label="Mute (M)" title="Sound · M">${ICONS.soundOn}</button>
      <button class="flh-btn" type="button" data-k="hud" aria-label="Hide titles and telemetry (H)" title="Titles and telemetry · H" aria-pressed="true">${ICONS.hud}</button>
      <button class="flh-btn" type="button" data-k="fs" aria-label="Fullscreen (F)" title="Fullscreen · F"${fsSupported ? '' : ' hidden'}>${ICONS.fullscreen}</button>
    </div>
    <div class="flh-track" role="slider" tabindex="0" aria-label="Timeline" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0">
      <div class="line"></div><div class="fill"></div><div class="marks"></div><div class="head"></div>
      <div class="tip"><span class="tn"></span><span class="tm"></span></div>
    </div>`;
  root.appendChild(ctl);
  const $ = (s) => ctl.querySelector(s);
  const btn = { play: $('[data-k=play]'), mute: $('[data-k=mute]'), hud: $('[data-k=hud]'), labels: $('[data-k=labels]'), fs: $('[data-k=fs]') };
  const track = $('.flh-track'), fill = $('.fill'), head = $('.head'), marks = $('.marks'), tip = $('.tip');
  const curEl = $('.flh-time .cur'), totEl = $('.flh-time .tot'), nowN = $('.flh-now .n'), nowNm = $('.flh-now .nm');

  let chapters = [], duration = 0;
  let lastActivity = -1e9, hovering = false, dragging = false, wasPlaying = false;
  let state = { t: 0, playing: false, muted: false };
  let shown = false, last = {};
  let labelEls = [];

  function setChapters(chs, dur) {
    chapters = chs;
    duration = dur || 0;
    track.setAttribute('aria-valuemax', String(Math.round(duration)));
    totEl.textContent = ' / ' + fmtClock(duration);
    marks.innerHTML = '';
    labelEls = [];
    chs.forEach((c, i) => {
      if (i > 0) {
        const tk = document.createElement('div');
        tk.className = 'tick';
        tk.style.left = ((100 * c.t0) / duration).toFixed(3) + '%';
        marks.appendChild(tk);
      }
      const cl = document.createElement('div');
      cl.className = 'cl';
      cl.textContent = c.short;
      cl._full = c.short;
      cl._alias = c.alias && c.alias !== c.short ? c.alias : null;
      cl.style.left = ((100 * (c.t0 + c.t1)) / 2 / duration).toFixed(3) + '%';
      marks.appendChild(cl);
      labelEls.push(cl);
    });
    layoutLabels();
  }

  // hide chapter labels whose segment is narrower than the label (the current one always shows)
  function placeLabel(el, i, w) {
    const c = chapters[i];
    if (el._alias && el.textContent !== el._full) el.textContent = el._full;
    let lw = el.offsetWidth;
    if (!lw) return false; // not displayed (phones show only the current one): placed when it becomes current
    const segW = ((c.t1 - c.t0) / duration) * w;
    // too long for its segment: the short name ("Belt", "Finale")
    if (lw + 10 >= segW && el._alias) {
      el.textContent = el._alias;
      lw = el.offsetWidth;
    }
    el.dataset.fits = lw + 10 < segW ? '1' : '0';
    // centred on its segment, but its whole box stays inside the track
    const cx = (((c.t0 + c.t1) / 2) / duration) * w;
    el.style.left = Math.max(0, Math.min(w - lw, cx - lw / 2)).toFixed(1) + 'px';
    return true;
  }
  function layoutLabels() {
    const w = track.clientWidth || window.innerWidth;
    labelEls.forEach((el, i) => placeLabel(el, i, w));
    last.ci = -1; // re-apply visibility
  }
  window.addEventListener('resize', layoutLabels);

  function chapterAt(t) {
    for (let i = chapters.length - 1; i >= 0; i--) if (t >= chapters[i].t0 - 1e-6) return i;
    return 0;
  }

  // ---------------------------------------------------------------- actions
  function activity() {
    lastActivity = performance.now();
  }
  function togglePlay() {
    if (!app.playing && duration && app.t >= duration - 0.05) app.seek(0);
    app.togglePlay();
    toast(app.playing ? '' : 'Paused');
  }
  function toggleMute() {
    app.setMuted(!app.muted);
    toast(app.muted ? 'Sound off' : 'Sound on');
  }
  function fullscreen() {
    const d = document;
    const el = d.documentElement;
    if (d.fullscreenElement || d.webkitFullscreenElement) (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    else if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
  }
  function seekChapter(dir) {
    if (!chapters.length) return;
    const t = app.t;
    const i = chapterAt(t);
    let target;
    if (dir > 0) target = i + 1 < chapters.length ? chapters[i + 1].t0 : duration;
    else target = t - chapters[i].t0 > 2.5 || i === 0 ? chapters[i].t0 : chapters[i - 1].t0;
    app.seek(target);
    const j = chapterAt(target + 1e-3);
    toast(chapters[j] ? chapters[j].short : '');
  }

  btn.play.addEventListener('click', togglePlay);
  btn.mute.addEventListener('click', toggleMute);
  btn.hud.addEventListener('click', () => onToggleHud());
  btn.labels.addEventListener('click', () => onToggleLabels());
  btn.fs.addEventListener('click', fullscreen);
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    btn.fs.innerHTML = on ? ICONS.fullscreenExit : ICONS.fullscreen;
    btn.fs.setAttribute('aria-label', on ? 'Exit fullscreen (F)' : 'Fullscreen (F)');
  });

  // ---------------------------------------------------------------- scrubbing
  function tAtX(clientX) {
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
  }
  function showTip(clientX) {
    const r = track.getBoundingClientRect();
    const t = tAtX(clientX);
    const c = chapters[chapterAt(t)];
    tip.querySelector('.tn').textContent = c ? c.short : '';
    tip.querySelector('.tm').textContent = fmtClock(t);
    const x = Math.max(40, Math.min(r.width - 40, clientX - r.left));
    tip.style.left = x + 'px';
  }
  track.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    wasPlaying = app.playing;
    if (wasPlaying) app.pause();
    track.classList.add('drag');
    track.setPointerCapture(e.pointerId);
    app.seek(tAtX(e.clientX));
    showTip(e.clientX);
    activity();
    e.preventDefault();
  });
  track.addEventListener('pointermove', (e) => {
    showTip(e.clientX);
    if (dragging) app.seek(tAtX(e.clientX));
  });
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('drag');
    try {
      track.releasePointerCapture(e.pointerId);
    } catch {}
    if (wasPlaying) app.play();
    activity();
  };
  track.addEventListener('pointerup', endDrag);
  track.addEventListener('pointercancel', endDrag);
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // slider semantics when focused: 5 s steps (chapter jumps stay on the global handler with no focus)
      app.seek(app.t + (e.key === 'ArrowRight' ? 5 : -5));
      e.preventDefault();
      e.stopPropagation();
    }
  });
  ctl.addEventListener('pointerenter', () => (hovering = true));
  ctl.addEventListener('pointerleave', () => (hovering = false));

  // ---------------------------------------------------------------- global input
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') activity();
  });
  // click / tap on the picture itself (not on controls)
  window.addEventListener('pointerdown', (e) => {
    if (isSplashOpen() || ctl.contains(e.target) || (e.target.closest && e.target.closest('button'))) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      // tap toggles the controls
      if (shown) lastActivity = -1e9;
      else activity();
    } else if (e.button === 0) {
      activity();
    }
  });
  // single click on the picture = play/pause (delayed so that a double click can mean fullscreen instead)
  let clickTimer = 0;
  window.addEventListener('click', (e) => {
    if (isSplashOpen() || ctl.contains(e.target) || (e.target.closest && e.target.closest('button'))) return;
    if (e.pointerType === 'touch' || e.pointerType === 'pen') return;
    clearTimeout(clickTimer);
    if (e.detail === 1) clickTimer = setTimeout(togglePlay, 230);
  });
  window.addEventListener('dblclick', (e) => {
    if (isSplashOpen() || ctl.contains(e.target)) return;
    clearTimeout(clickTimer);
    fullscreen();
  });
  // Capture phase: Space / K always mean play-pause, even while a control button has focus (a focused button would
  // otherwise take Space as its own click). Real text inputs keep their keys.
  const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  window.addEventListener('keyup', (e) => {
    if (e.key === ' ' && !isSplashOpen() && !typing(e.target) && e.target && e.target.closest && e.target.closest('#flh-hud')) e.preventDefault();
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isSplashOpen() || typing(e.target)) return;
    const k = e.key;
    if (e.target === track && (k === 'ArrowLeft' || k === 'ArrowRight')) return; // the focused slider steps 5 s
    let handled = true;
    if (k === ' ' || k === 'k' || k === 'K') {
      if (e.repeat) return e.preventDefault();
      togglePlay();
    } else if (k === 'ArrowRight') e.shiftKey ? app.seek(app.t + 10) : seekChapter(1);
    else if (k === 'ArrowLeft') e.shiftKey ? app.seek(app.t - 10) : seekChapter(-1);
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'f' || k === 'F') fullscreen();
    else if (k === 'h' || k === 'H') onToggleHud();
    else if (k === 'l' || k === 'L') onToggleLabels();
    else if (k === 'Home') app.seek(0);
    else if (k === 'End') app.seek(duration);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
      activity();
    }
  }, true);
  // a mouse click must not leave focus on a button (keyboard Tab focus is untouched)
  ctl.addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'mouse') return;
    const b = e.target.closest && e.target.closest('button');
    if (b) setTimeout(() => b.blur(), 0);
  });

  // ---------------------------------------------------------------- per frame
  function update(t, playing, muted, hudOn, labelsOn) {
    state = { t, playing, muted };
    const now = performance.now();
    const want = !isSplashOpen() && (forceShow || (!capture && (dragging || hovering || !playing || now - lastActivity < IDLE_MS)));
    if (want !== shown) {
      shown = want;
      ctl.classList.toggle('on', shown);
    }
    const idle = !capture && !shown && playing && !isSplashOpen();
    if (idle !== last.idle) {
      last.idle = idle;
      document.documentElement.classList.toggle('flh-idle', idle);
    }
    if (!shown && !forceShow) return;

    const p = duration ? Math.max(0, Math.min(1, t / duration)) : 0;
    const pk = p.toFixed(4);
    if (pk !== last.p) {
      last.p = pk;
      fill.style.transform = `scaleX(${pk})`;
      head.style.left = (p * 100).toFixed(3) + '%';
      track.setAttribute('aria-valuenow', String(Math.round(t)));
      track.setAttribute('aria-valuetext', fmtClock(t));
    }
    const clk = fmtClock(t);
    if (clk !== last.clk) curEl.textContent = last.clk = clk;
    const ended = !playing && duration && t >= duration - 0.05;
    const pk2 = playing ? 'p' : ended ? 'e' : 's';
    if (pk2 !== last.playing) {
      last.playing = pk2;
      btn.play.innerHTML = playing ? ICONS.pause : ended ? ICONS.replay : ICONS.play;
      btn.play.setAttribute('aria-label', playing ? 'Pause (Space)' : ended ? 'Replay (Space)' : 'Play (Space)');
    }
    if (muted !== last.muted) {
      last.muted = muted;
      btn.mute.innerHTML = muted ? ICONS.soundOff : ICONS.soundOn;
      btn.mute.classList.toggle('off', muted);
      btn.mute.setAttribute('aria-label', muted ? 'Unmute (M)' : 'Mute (M)');
    }
    if (hudOn !== last.hudOn) {
      last.hudOn = hudOn;
      btn.hud.innerHTML = hudOn ? ICONS.hud : ICONS.hudOff;
      btn.hud.classList.toggle('off', !hudOn);
      btn.hud.setAttribute('aria-pressed', String(hudOn));
    }
    if (labelsOn !== last.labelsOn) {
      last.labelsOn = labelsOn;
      btn.labels.classList.toggle('off', !labelsOn);
      btn.labels.setAttribute('aria-pressed', String(labelsOn));
    }
    const ci = chapterAt(t);
    if (ci !== last.ci) {
      last.ci = ci;
      const c = chapters[ci];
      nowN.textContent = c && c.numeral ? c.numeral : '';
      nowNm.textContent = c ? c.short : '';
      labelEls.forEach((el, i) => {
        el.classList.toggle('cur', i === ci);
        el.style.visibility = i === ci || el.dataset.fits === '1' ? '' : 'hidden';
      });
      if (labelEls[ci]) placeLabel(labelEls[ci], ci, track.clientWidth || window.innerWidth);
    }
  }

  // how far up from the bottom edge the transport row reaches (px), for lifting the lower text above it
  let insetKey = '', insetPx = 0;
  function inset() {
    const k = window.innerWidth + 'x' + window.innerHeight;
    if (k !== insetKey) {
      const cb = ctl.getBoundingClientRect().bottom;
      let top = Infinity;
      for (const e of ctl.querySelectorAll('.flh-row > *')) {
        const r = e.getBoundingClientRect();
        if (r.height > 0) top = Math.min(top, r.top);
      }
      insetPx = isFinite(top) ? Math.max(0, cb - top) : 0;
      insetKey = insetPx ? k : '';
    }
    return insetPx;
  }

  return { setChapters, update, activity, isShown: () => shown, inset, element: ctl, layoutLabels };
}
