// FALLBACK copy used by main.js when the real module fails to load. Do not edit.
export async function create(ctx) {
  const { app, capture, visible } = ctx;
  const style = document.createElement('style');
  style.textContent = `
    #hud { position: fixed; inset: 0; pointer-events: none; color: #fff; font: 14px system-ui, sans-serif; }
    #hud .title { position: absolute; left: 32px; bottom: 32px; font-size: 28px; letter-spacing: .2em; text-transform: uppercase; }
    #splash { position: fixed; inset: 0; display: grid; place-items: center; background: #000; color: #fff; font: 16px system-ui; z-index: 5; }
    #splash button { pointer-events: auto; font: inherit; padding: 12px 28px; background: none; color: #fff; border: 1px solid #fff8; cursor: pointer; }
  `;
  document.head.appendChild(style);
  const root = document.createElement('div');
  root.id = 'hud';
  root.style.display = visible === false ? 'none' : '';
  root.innerHTML = `<div class="title"></div>`;
  document.body.appendChild(root);
  const title = root.querySelector('.title');

  let splash = null;
  if (!capture) {
    splash = document.createElement('div');
    splash.id = 'splash';
    splash.innerHTML = `<div><div class="load">Loading…</div><button hidden>Begin</button></div>`;
    document.body.appendChild(splash);
  }
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') app.togglePlay();
  });

  let director = null;
  return {
    setLoading(p) {
      if (splash) splash.querySelector('.load').textContent = `Loading ${Math.round(p * 100)}%`;
    },
    async attach(o) {
      director = o.director;
      if (splash) {
        splash.querySelector('.load').textContent = '';
        const b = splash.querySelector('button');
        b.hidden = false;
        b.onclick = async () => {
          splash.remove();
          await app.start();
        };
      }
    },
    update(t, shot) {
      const ch = director?.chapters?.[shot.chapterIndex];
      title.textContent = ch ? ch.title : shot.focus || '';
    },
  };
}
