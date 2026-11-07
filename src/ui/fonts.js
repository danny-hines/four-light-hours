// Registers the HUD's embedded web fonts (Jost, Cormorant Garamond Italic) with graceful system fallbacks.
// The fonts are inlined in fonts-data.js, so they work offline and are ready before the first captured frame.

export const SANS = "'FLH Jost', 'Jost', 'Futura', 'Avenir Next', 'Century Gothic', 'Segoe UI', system-ui, sans-serif";
export const SERIF = "'FLH Cormorant', 'Cormorant Garamond', 'EB Garamond', 'Garamond', 'Iowan Old Style', 'Palatino Linotype', 'Book Antiqua', Georgia, serif";

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Resolves to { ok, families } — never rejects; times out after `timeoutMs`. */
export async function loadFonts(timeoutMs = 2500) {
  const status = { ok: false, families: [], error: null };
  try {
    if (typeof FontFace === 'undefined' || !document.fonts) throw new Error('FontFace API unavailable');
    const data = await import('./fonts-data.js');
    const faces = [
      new FontFace('FLH Jost', b64ToBytes(data.JOST), { weight: '200 600', style: 'normal', display: 'swap' }),
      new FontFace('FLH Cormorant', b64ToBytes(data.CORMORANT_ITALIC), { weight: '400 600', style: 'italic', display: 'swap' }),
    ];
    const loaded = await Promise.race([
      Promise.all(
        faces.map(async (f) => {
          await f.load();
          document.fonts.add(f);
          return f.family;
        })
      ),
      new Promise((_, rej) => setTimeout(() => rej(new Error('font load timeout')), timeoutMs)),
    ]);
    status.ok = true;
    status.families = loaded;
  } catch (e) {
    status.error = String((e && e.message) || e);
  }
  return status;
}
