"""Moon, Mars, Mercury, Galilean moons, Triton, Jupiter.

usage: python -I process_bodies.py <raw_dir> <assets_dir> [body ...]

All outputs are equirectangular, east longitude increasing to the right, north up,
longitude 0 at the image centre (left edge = 180 W / -180 E).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image, load_array, nonzero_pixels, np, resample_to, roll_half, save_webp, to_u8  # noqa: E402

raw, assets = sys.argv[1], sys.argv[2]
only = set(sys.argv[3:])
ranges_path = os.path.join(assets, "height_ranges.json")
ranges = json.load(open(ranges_path)) if os.path.exists(ranges_path) else {}


def R(*p):
    return os.path.join(raw, *p)


def color(body, src, size, roll=False, name="color.webp", gray=False, quality=88, nodata=False, valid=None):
    print(body, "<-", os.path.basename(src))
    a = load_array(src)
    if nodata:
        # report the no-data (all-zero) fraction and its latitude extent at a coarse stride
        s = np.asarray(a[::8, ::8])
        bad = (s.max(axis=-1) if s.ndim == 3 else s) == 0
        rows = np.where(bad.mean(axis=1) > 0.5)[0]
        print("  no-data fraction %.4f; rows >50%% empty: %s" % (bad.mean(), (
            "lat %.1f..%.1f (%d rows)" % (90 - rows.min() * 8 * 180 / a.shape[0], 90 - rows.max() * 8 * 180 / a.shape[0], len(rows))
            if len(rows) else "none")))
    out = resample_to(a, size, valid=valid or (nonzero_pixels if nodata else None))
    if roll:
        out = roll_half(out)
    if gray and out.ndim == 3:
        out = out.mean(axis=2)
    save_webp(to_u8(out), os.path.join(assets, body, name), quality=quality)


def height(body, a, size, roll, scale_km, ref, valid=None, note=""):
    """a: raw elevation array; scale_km converts raw units to km."""
    print(body, "height", a.shape, a.dtype)
    out = resample_to(a, size, valid=valid) * scale_km
    if roll:
        out = roll_half(out)
    lo, hi = float(out.min()), float(out.max())
    u8 = to_u8((out - lo) / (hi - lo) * 255.0)
    save_webp(u8, os.path.join(assets, body, "height.webp"), lossless=True)
    ranges[body] = {"min_km": round(lo, 4), "max_km": round(hi, 4), "reference": ref,
                    "encoding": "height_km = min_km + (v/255) * (max_km - min_km)", "note": note}
    print("  range %.3f .. %.3f km" % (lo, hi))


def want(b):
    return not only or b in only


# ---------------- Moon (NASA SVS 4720 CGI Moon Kit) ----------------
if want("moon"):
    color("moon", R("moon_svs4720", "lroc_color_poles_4k.tif"), (2048, 1024))
    dem = load_array(R("moon_svs4720", "ldem_16.tif"))  # float32 km rel. 1737.4 km sphere
    height("moon", dem, (2048, 1024), False, 1.0, "LOLA, km relative to 1737.4 km sphere")

# ---------------- Mars ----------------
if want("mars"):
    color("mars", R("mars_viking_usgs", "Mars_Viking_ClrMosaic_global_925m.tif"), (4096, 2048))
    raw16 = np.fromfile(R("mars_mola_megdr", "megt90n000eb.img"), dtype=">i2").reshape(2880, 5760)
    height("mars", raw16, (2048, 1024), True, 0.001,
           "MOLA MEGDR median topography, km relative to the GMM3 areoid")

# ---------------- Mercury ----------------
if want("mercury"):
    color("mercury", R("mercury_usgs", "Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif"), (2048, 1024), nodata=True)
    dem = load_array(R("mercury_dem_usgs", "Mercury_Messenger_USGS_DEM_Global_665m_v2.tif"))
    height("mercury", dem, (2048, 1024), True, 0.001,
           "USGS MESSENGER DEM v2, km relative to 2439.4 km sphere",
           valid=lambda b: b > -30000)

# ---------------- Galilean moons ----------------
if want("io"):
    color("io", R("io_usgs", "Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif"), (2048, 1024), nodata=True)
if want("europa"):
    color("europa", R("europa_usgs", "Europa_Voyager_GalileoSSI_global_mosaic_500m.tif"), (2048, 1024), roll=True, nodata=True)
if want("ganymede"):
    color("ganymede", R("ganymede_usgs", "Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif"), (1024, 512), roll=True, nodata=True)
if want("callisto"):
    color("callisto", R("callisto_usgs", "Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif"), (1024, 512), roll=True, nodata=True)

# ---------------- Triton ----------------
if want("triton"):
    color("triton", R("triton_usgs", "Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif"), (1024, 512), nodata=True,
          # dark speckle along the data edge is partial-coverage junk: treat max<16 as no-data
          valid=lambda b: np.repeat((b.max(axis=-1) >= 16)[..., None], b.shape[-1], axis=-1))

# ---------------- Jupiter (Cassini PIA07782 cylindrical map) ----------------
if want("jupiter"):
    p = R("jupiter_pia07782", "PIA07782~orig.jpg")
    if os.path.exists(p):
        color("jupiter", p, (2048, 1024), name="cassini.webp")

json.dump(ranges, open(ranges_path, "w"), indent=2)
print("wrote", ranges_path)
