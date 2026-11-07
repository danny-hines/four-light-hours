// Light meter for text legibility: measures the brightness of the finished frame (after post: bloom, glare, flare)
// behind each HUD text block, so scrims and halos respond to what is really on screen.
//
// Capture stills: synchronous readPixels every frame (exact, deterministic; the stall does not matter there).
// Playback (and perf runs): asynchronous readback through a WebGL2 pixel-pack buffer + fence, so the GPU is never stalled; results
// arrive one or two frames late and are eased like a real meter. Falls back to null (the caller then uses its
// analytic estimate) when readback is unavailable.

const COLS = 5, ROWS = 3, B = 6; // sample grid per region, block size in drawing-buffer pixels

export function createMeter(renderer, capture) {
  let gl = null;
  try {
    gl = renderer && renderer.getContext();
  } catch {}
  const gl2 = !!gl && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  let dead = !gl;
  let pbo = null, fence = null, pendingLayout = null, last = {}, eased = {};
  const blockBytes = B * B * 4;

  function layout(regions, W, H) {
    const pr = renderer.getPixelRatio();
    const dbW = gl.drawingBufferWidth, dbH = gl.drawingBufferHeight;
    const out = [];
    for (const [key, r] of regions) {
      if (!r) continue;
      const blocks = [];
      for (let j = 0; j < ROWS; j++)
        for (let i = 0; i < COLS; i++) {
          const cx = (r.x + ((i + 0.5) / COLS) * r.w) * pr, cy = (r.y + ((j + 0.5) / ROWS) * r.h) * pr;
          const x = Math.max(0, Math.min(dbW - B, Math.round(cx - B / 2)));
          const y = Math.max(0, Math.min(dbH - B, Math.round(dbH - cy - B / 2)));
          blocks.push([x, y]);
        }
      out.push({ key, blocks });
    }
    return out;
  }

  const rgb = [0, 0, 0];
  function reduce(bytes, offset) {
    // mean display luma (sRGB-encoded, which is what matters for text contrast) of one block; rgb accumulates
    let s = 0;
    for (let k = 0; k < B * B; k++) {
      const o = offset + k * 4;
      s += 0.2126 * bytes[o] + 0.7152 * bytes[o + 1] + 0.0722 * bytes[o + 2];
      rgb[0] += bytes[o]; rgb[1] += bytes[o + 1]; rgb[2] += bytes[o + 2];
    }
    return s / (B * B * 255);
  }
  // per region: brightness (0..1, weighted toward the brightest block) and, as key + '_rgb', the mean colour
  function summarize(lay, bytes) {
    const res = {};
    let off = 0;
    for (const reg of lay) {
      let mx = 0, sum = 0;
      rgb[0] = rgb[1] = rgb[2] = 0;
      for (let b = 0; b < reg.blocks.length; b++) {
        const v = reduce(bytes, off);
        off += blockBytes;
        mx = Math.max(mx, v);
        sum += v;
      }
      res[reg.key] = 0.55 * mx + 0.45 * (sum / reg.blocks.length);
      const n = reg.blocks.length * B * B * 255;
      res[reg.key + '_rgb'] = [rgb[0] / n, rgb[1] / n, rgb[2] / n];
    }
    return res;
  }

  /** regions: [[key, rect|null], ...] in CSS px. Returns { key: brightness 0..1 } or null.
   *  exact: synchronous readback (capture stills); otherwise asynchronous (playback, including perf runs). */
  function measure(regions, W, H, exact = capture) {
    if (dead) return null;
    try {
      const lay = layout(regions, W, H);
      const total = lay.reduce((n, r) => n + r.blocks.length, 0);
      if (!total) return {};
      if (exact || !gl2) {
        // synchronous (capture: exact per frame; WebGL1: no async path)
        const px = new Uint8Array(blockBytes);
        const bytes = new Uint8Array(total * blockBytes);
        let off = 0;
        for (const reg of lay)
          for (const [x, y] of reg.blocks) {
            gl.readPixels(x, y, B, B, gl.RGBA, gl.UNSIGNED_BYTE, px);
            bytes.set(px, off);
            off += blockBytes;
          }
        last = summarize(lay, bytes);
        return last;
      }
      // asynchronous: collect a finished readback, then queue the next one
      if (fence) {
        const st = gl.clientWaitSync(fence, 0, 0);
        if (st === gl.ALREADY_SIGNALED || st === gl.CONDITION_SATISFIED) {
          gl.deleteSync(fence);
          fence = null;
          const n = pendingLayout.reduce((k, r) => k + r.blocks.length, 0);
          const bytes = new Uint8Array(n * blockBytes);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
          last = summarize(pendingLayout, bytes);
        } else if (st === gl.WAIT_FAILED) {
          dead = true;
          return null;
        }
      }
      if (!fence) {
        if (!pbo) pbo = gl.createBuffer();
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, total * blockBytes, gl.STREAM_READ);
        let off = 0;
        for (const reg of lay)
          for (const [x, y] of reg.blocks) {
            gl.readPixels(x, y, B, B, gl.RGBA, gl.UNSIGNED_BYTE, off);
            off += blockBytes;
          }
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        pendingLayout = lay;
      }
      // ease toward the latest reading (a meter with ~0.15 s response)
      for (const [key] of regions) {
        const v = last[key];
        if (v == null) continue;
        eased[key] = eased[key] == null ? v : eased[key] + (v - eased[key]) * 0.25;
        const c = last[key + '_rgb'];
        if (c) {
          const e = eased[key + '_rgb'] || (eased[key + '_rgb'] = c.slice());
          for (let i = 0; i < 3; i++) e[i] += (c[i] - e[i]) * 0.25;
        }
      }
      return eased;
    } catch (e) {
      dead = true;
      return null;
    }
  }

  return { measure, get available() { return !dead; } };
}
