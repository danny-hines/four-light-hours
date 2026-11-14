// How the film's 16:9 composition maps onto screens of other shapes (portrait phones, tablets).
//
// The director composes every shot for a 16:9 frame: its `fov` is the vertical field of a 16:9 picture, subjects are
// placed off-centre in that frame, and the safe box is measured in it. On a screen narrower than 16:9 a fixed
// vertical field crops the sides, and on a portrait phone (aspect ~0.5) a world composed a third of the way across
// falls off the edge. fitFov widens the vertical field just enough that the screen still shows FIT of the 16:9
// frame's width (Hor+ down to that point), so the subject stays in the picture without shrinking it to a stamp.
//
// The 2.39:1 matte is the same idea: on a landscape screen the picture strip is 2.39:1; on a portrait screen a
// 2.39:1 strip would be a sliver a quarter of the height, so the strip's ratio relaxes toward ~1.5:1 as the screen
// narrows (still a band, still cinematic, but with room for the picture).

export const FIT = 0.68; // fraction of the 16:9 frame's width that stays on screen, however narrow the screen
const DESIGN = 16 / 9;

/** Vertical field of view (deg) to render a shot composed for 16:9 at `fov` on a screen of this aspect. */
export function fitFov(fov, aspect) {
  const tv = Math.tan((fov * Math.PI) / 360);
  const need = (FIT * DESIGN * tv) / Math.max(0.1, aspect);
  return need > tv ? (360 / Math.PI) * Math.atan(need) : fov;
}

/** Picture height (fraction of the screen height) inside the letterbox matte when it is fully up. */
export function matteStrip(aspect) {
  const ratio = aspect >= 1.2 ? 2.39 : Math.max(1.4, 2.39 * Math.sqrt(aspect / 1.2));
  return Math.min(1, aspect / ratio);
}
/** Height in px of each matte bar (fully up) on a W x H screen. */
export const matteBarPx = (W, H) => (H * (1 - matteStrip(W / H))) / 2;
