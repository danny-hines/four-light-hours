// Hairline SVG icons (24x24 grid, 1.25 px stroke, currentColor).
const svg = (body, extra = '') =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" ${extra}>${body}</svg>`;

export const ICONS = {
  play: svg('<path d="M8 5.5v13l10.5-6.5z" fill="currentColor" fill-opacity=".9" stroke="none"/>'),
  pause: svg('<path d="M8.5 5.5v13M15.5 5.5v13" stroke-width="1.6"/>'),
  replay: svg('<path d="M5.2 9.5A7.5 7.5 0 1 1 4.5 12"/><path d="M4.5 5.5v4h4"/>'),
  soundOn: svg('<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.2 9.2a4 4 0 0 1 0 5.6M17.6 6.8a7.4 7.4 0 0 1 0 10.4"/>'),
  soundOff: svg('<path d="M4.5 9.5h3l4.5-4v13l-4.5-4h-3z"/><path d="M15.5 9.5l5 5M20.5 9.5l-5 5"/>'),
  fullscreen: svg('<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>'),
  fullscreenExit: svg('<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>'),
  // HUD toggle: a frame with a text line in its lower-left (the title card)
  hud: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M6.5 15.5h6M6.5 13h3.5"/>'),
  hudOff: svg('<rect x="3.5" y="5" width="17" height="14" rx="1.5"/><path d="M6.5 15.5h6M6.5 13h3.5" opacity=".35"/><path d="M3 3l18 18"/>'),
  // labels: a reticle
  labels: svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3"/>'),
  headphones: svg('<path d="M4.5 15.5v-3a7.5 7.5 0 0 1 15 0v3"/><rect x="3.5" y="14.5" width="4" height="6" rx="1.4"/><rect x="16.5" y="14.5" width="4" height="6" rx="1.4"/>', 'width="15" height="15"'),
};
