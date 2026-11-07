"""Galilean moon colour maps for the jupiter piece at 2048x1024 (Ganymede and Callisto were 1024x512).

usage (from assets-src/scripts): python -I process_jupiter_moons.py ../raw ../../assets [body ...]
Same conventions and resampling as process_bodies.py (east right, lon 0 at the centre, no-data filled).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_array, nonzero_pixels, resample_to, roll_half, save_webp, to_u8  # noqa: E402

raw, assets = sys.argv[1], sys.argv[2]
only = set(sys.argv[3:])
JOBS = {
    "ganymede": ("ganymede_usgs/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif", True, False),
    "callisto": ("callisto_usgs/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif", True, True),
}
for body, (src, roll, gray) in JOBS.items():
    if only and body not in only:
        continue
    print(body, "<-", src)
    a = load_array(os.path.join(raw, src))
    out = resample_to(a, (2048, 1024), valid=nonzero_pixels)
    if roll:
        out = roll_half(out)
    if gray and out.ndim == 3:
        out = out.mean(axis=2)
    save_webp(to_u8(out), os.path.join(assets, body, "color.webp"), quality=86)
    print("  wrote", os.path.join(assets, body, "color.webp"))
