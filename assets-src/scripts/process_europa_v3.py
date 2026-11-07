"""Europa (fix round 3): make the USGS Voyager/Galileo mosaic uniform at disc scale.

The mosaic mixes sources of very different resolution: some tiles are high-resolution "stucco" (dense small dark dots
and fine ridges), others are smooth Voyager-resolution blur. The previous equalisation matched the high-pass RMS, but
the *character* of the detail still changed at the tile boundaries (a hard vertical seam at disc scale), and the
dots were turned into a uniform field of brown freckles by the shader.

Here the high-pass layer is filtered by its local orientation coherence (structure tensor): linear features (lineae,
ridges, bands, which are real and continuous across tiles) are kept, isotropic dot texture (stucco, noise, the
high-resolution tiles' small-scale mottling) is suppressed. The remaining high-pass is amplitude-compressed (never
boosted) toward a low common level, and the mid band that carries the strip-to-strip processing steps is damped.
The broad albedo pattern (trailing-hemisphere darkening, the dark mottled terrain, the big lineae) is kept.
Procedural detail in the shader then supplies the fine texture uniformly everywhere.

usage (from assets-src/scripts): python -I process_europa_v3.py ../raw ../../assets
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image, load_array, nonzero_pixels, np, resample_to, roll_half, save_webp, to_u8  # noqa: E402

raw, assets = sys.argv[1], sys.argv[2]
src = os.path.join(raw, "europa_usgs", "Europa_Voyager_GalileoSSI_global_mosaic_500m.tif")
a = load_array(src)
img = resample_to(a, (2048, 1024), valid=nonzero_pixels)
img = roll_half(img)
if img.ndim == 3:
    img = img.mean(axis=2)
img = img.astype(np.float64)


def blur(x, s):
    r = int(3 * s) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / s) ** 2)
    k /= k.sum()
    xp = np.concatenate([x[:, -r:], x, x[:, :r]], axis=1)
    y = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 1, xp)
    yp = np.concatenate([y[r:0:-1], y, y[-2:-r - 2:-1]], axis=0)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 0, yp)


low = blur(img, 4.0)
high = img - low
# orientation coherence of the detail (structure tensor of the lightly smoothed image)
sm = blur(img, 1.2)
gx = (np.roll(sm, -1, axis=1) - np.roll(sm, 1, axis=1)) * 0.5
gy = np.zeros_like(sm)
gy[1:-1] = (sm[2:] - sm[:-2]) * 0.5
Jxx, Jxy, Jyy = blur(gx * gx, 3.0), blur(gx * gy, 3.0), blur(gy * gy, 3.0)
tr = Jxx + Jyy
det = np.sqrt((Jxx - Jyy) ** 2 + 4 * Jxy ** 2)
coh = (det / (tr + 1e-6)) ** 2
coh = np.clip((coh - 0.15) / 0.55, 0, 1)
hp = high * (0.18 + 0.82 * coh ** 0.8)
# compress (never boost) the local detail amplitude toward a low common level
lstd = np.sqrt(blur(hp ** 2, 40.0)) + 1e-3
target = float(np.percentile(lstd, 30))
gain = np.minimum(1.0, target / lstd)
hp = hp * gain
hp = np.clip(hp, -3.5 * target, 3.5 * target)
hp = np.where(hp > 0, hp * 0.6, hp)          # damp baked bright embossing highlights; lineae are dark
# mid band (strip seams between differently processed strips): damp, keep the broad albedo pattern
low2 = blur(low, 30.0)
mid = low - low2
mstd = np.sqrt(blur(mid ** 2, 60.0)) + 1e-3
mid = mid * np.minimum(1.0, float(np.percentile(mstd, 40)) / mstd) * 0.75
out = np.clip(low2 + mid + hp, 0, 255)
save_webp(to_u8(out), os.path.join(assets, "europa", "color.webp"), quality=88)
Image.fromarray(to_u8(out)).resize((1024, 512)).save(os.path.join(raw, "europa_usgs", "v3_preview.png"))
print("europa v3: high-pass target %.2f, coherent fraction %.2f" % (target, float(np.mean(coh > 0.5))))
