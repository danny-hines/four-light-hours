"""Earth continental-shelf depth map (earth piece, round 2).

usage: python -I process_earth_shelf.py <raw_dir> <assets_dir>

From the BMNG/GEBCO bathymetry (gebco_08_rev_bath_5400x2700.tif, 8-bit, 0..255 = -8000..0 m, land = 255).
Output assets/earth/shelf.webp (2048x1024, lossless gray): v = 255 * clamp(1 - depth / 200 m, 0, 1) in the ocean,
so only the shelves (where the sea floor shows through clear water) are non-zero. The Earth shader uses it for
shallow-water colour, and computes the deep-ocean colour itself instead of using the Blue Marble's bathymetry-
shaded ocean (which shows mid-ocean ridges as light lines).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image, np, resample_to, save_webp, to_u8  # noqa: E402

raw, assets = sys.argv[1], sys.argv[2]
b = np.asarray(Image.open(os.path.join(raw, "earth_topo", "gebco_08_rev_bath_5400x2700.tif")).convert("L")).astype(np.float32)
depth = (255.0 - b) / 255.0 * 8000.0          # metres below sea level (0 on land)
shallow = np.clip(1.0 - depth / 200.0, 0.0, 1.0)
shallow[b >= 255] = 1.0                        # land/coast: 'zero depth' (the water mask decides land vs sea)
out = resample_to(shallow * 255.0, (2048, 1024), k=2)
save_webp(to_u8(out), os.path.join(assets, "earth", "shelf.webp"), lossless=True)
print("shelf.webp", os.path.getsize(os.path.join(assets, "earth", "shelf.webp")), "bytes")
