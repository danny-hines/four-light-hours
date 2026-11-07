// FALLBACK copy used by main.js when the real module fails to load. Do not edit.
export async function create(ctx) {
  return {
    async start() {},
    update(t, shot, playing) {},
    seek(t) {},
    setMuted(m) {},
  };
}
