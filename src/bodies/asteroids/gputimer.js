// Debug GPU timing of the asteroid passes (astdbg=gpu): EXT_disjoint_timer_query_webgl2 queries around every
// draw of this piece's objects, summed per category per frame. Results land a few frames late (async) in
// stats.gpu (last complete frame, ms) and stats.gpuMin (minimum over all frames so far, ms) - the min is the
// meaningful number on a GPU shared with other work.
export function createGpuTimer(renderer, stats) {
  const gl = renderer.getContext();
  const ext = gl.getExtension && gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!ext) return null;
  const pending = [];
  const frames = new Map();
  let frameId = 0;
  let cur = null;
  stats.gpu = {};
  stats.gpuMin = {};
  stats.gpuFrames = 0;
  function wrap(obj, cat) {
    obj.onBeforeRender = () => {
      if (cur) return;
      const q = gl.createQuery();
      gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
      cur = { q, cat, f: frameId };
    };
    obj.onAfterRender = () => {
      if (!cur) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(cur);
      const fr = frames.get(cur.f) || { n: 0, done: 0, sums: {} };
      fr.n++;
      frames.set(cur.f, fr);
      cur = null;
    };
  }
  function poll() {
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i];
      if (!gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)) continue;
      const ns = disjoint ? NaN : gl.getQueryParameter(p.q, gl.QUERY_RESULT);
      gl.deleteQuery(p.q);
      pending.splice(i, 1);
      const fr = frames.get(p.f);
      if (!fr) continue;
      fr.sums[p.cat] = (fr.sums[p.cat] || 0) + ns / 1e6;
      fr.done++;
      if (fr.done === fr.n) {
        frames.delete(p.f);
        let total = 0;
        for (const k in fr.sums) total += fr.sums[k];
        fr.sums.total = total;
        if (Number.isFinite(total)) {
          stats.gpu = fr.sums;
          stats.gpuFrames++;
          for (const k in fr.sums) stats.gpuMin[k] = Math.min(stats.gpuMin[k] ?? Infinity, fr.sums[k]);
        }
      }
    }
    // drop frames whose queries were never issued (objects culled) so the map cannot grow
    for (const [f] of frames) if (f < frameId - 120) frames.delete(f);
    frameId++;
  }
  return { wrap, poll };
}
