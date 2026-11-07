"""Jupiter piece: a 'structure map' derived from the Cassini PIA07782 map (assets/jupiter/cassini.webp).

Local relative RMS contrast of the luminance at ~200-1,500 km scales: high in the chaotic regions (SEB wake, NEB plumes,
turbulent mid-latitude belts), low in the smooth zones. The shader uses it to put the synthesized sub-map turbulence
where the real planet is turbulent. Output: assets/jupiter/structure.webp (512 x 256, grayscale, value = rel. RMS x 7).
Run:  python -I jupiter_structure.py <cassini.webp> <out.webp>
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402,F401
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

src, out = sys.argv[1], sys.argv[2]
a = np.asarray(Image.open(src).convert("RGB")).astype(np.float64) / 255.0
lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
L = lin @ np.array([0.2126, 0.7152, 0.0722])
H, W = L.shape


def blur(x, sig, lat=True):
    # separable gaussian, periodic in longitude, clamped in latitude
    r = int(3 * sig) + 1
    k = np.exp(-0.5 * (np.arange(-r, r + 1) / sig) ** 2)
    k /= k.sum()
    y = np.zeros_like(x)
    for i, w in enumerate(k):
        y += w * np.roll(x, i - r, axis=1)
    if not lat:
        return y
    p = np.pad(y, ((r, r), (0, 0)), mode="edge")
    z = np.zeros_like(x)
    for i, w in enumerate(k):
        z += w * p[i:i + H]
    return z


# high-pass along LONGITUDE only: zonally symmetric belt edges are not turbulence; eddies, ovals, plumes are
hp = L - blur(L, 4.0, lat=False)      # < ~900 km, non-zonal
rms = np.sqrt(blur(hp * hp, 5.0))     # local RMS over ~1,100 km
rel = rms / np.maximum(blur(L, 5.0), 0.04)
# the cassini map's polar regions are hazy and smeared: don't trust them
lat = (0.5 - (np.arange(H) + 0.5) / H) * 180
rel *= np.clip((75 - np.abs(lat)) / 15, 0, 1)[:, None] ** 0.5
v = np.clip(rel * 7.0, 0, 1)
img = Image.fromarray(np.round(v * 255).astype(np.uint8), "L").resize((512, 256), Image.LANCZOS)
img.save(out, quality=90, method=6)
print(out, os.path.getsize(out), "bytes; percentiles", np.percentile(v, [10, 50, 90, 99]).round(3))
