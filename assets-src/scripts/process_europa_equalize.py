"""Europa: equalise the USGS mosaic's strip-to-strip texture contrast (mixed Voyager/Galileo resolutions and baked
relief shading make visible strip seams) while keeping the real albedo pattern and lineae.

usage (from assets-src/scripts): python -I process_europa_equalize.py ../raw ../../assets
Reads the raw USGS mosaic again (not the webp) so nothing is recompressed twice.
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
    # separable gaussian with wrap in longitude, reflect in latitude
    r = int(3 * s) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / s) ** 2)
    k /= k.sum()
    xp = np.concatenate([x[:, -r:], x, x[:, :r]], axis=1)
    y = np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 1, xp)
    yp = np.concatenate([y[r:0:-1], y, y[-2:-r - 2:-1]], axis=0)
    return np.apply_along_axis(lambda v: np.convolve(v, k, mode="valid"), 0, yp)


low = blur(img, 5.0)
high = img - low
lstd = np.sqrt(blur(high ** 2, 36.0)) + 1e-3
target = float(np.median(lstd))
hn = high / lstd * target
hn = np.clip(hn, -3.5 * target, 3.5 * target)
# keep mostly dark detail (lineae, chaos), damp bright embossing highlights
hn = np.where(hn > 0, hn * 0.55, hn)
# strip seams live mostly in the mid band (sharp steps between differently processed strips): keep the broad
# albedo pattern (trailing-hemisphere darkening, chaos regions) and damp the mid band
low2 = blur(low, 30.0)
out = np.clip(low2 + (low - low2) * 0.5 + hn * 0.95, 0, 255)
save_webp(to_u8(out), os.path.join(assets, "europa", "color.webp"), quality=88)
print("europa equalised; target high-pass std %.2f" % target)
