"""Earth textures.

usage: python -I process_earth.py <raw_dir> <assets_dir>
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image, np, resample_to, save_webp, to_u8  # noqa: E402
from PIL import ImageDraw  # noqa: E402

raw, assets = sys.argv[1], sys.argv[2]
out = os.path.join(assets, "earth")


def rgb(path):
    return np.asarray(Image.open(path).convert("RGB"))


# Day colour: Blue Marble NG (July 2004) with topography + bathymetry, no clouds.
print("day")
day = rgb(os.path.join(raw, "earth_bmng", "world.topo.bathy.200407.3x5400x2700.jpg"))
save_webp(to_u8(resample_to(day, (4096, 2048), k=1)), os.path.join(out, "day.webp"), quality=88)

# Night lights: Black Marble 2016 grayscale (lights only, black background).
print("night")
night = np.asarray(Image.open(os.path.join(raw, "earth_blackmarble", "BlackMarble_2016_3km_gray_geo.tif")).convert("L"))
save_webp(to_u8(resample_to(night, (4096, 2048))), os.path.join(out, "night.webp"), quality=90)

# Height: BMNG/GEBCO land topography, 0..255 linear = 0..6400 m, sea = 0.
print("height")
elev = np.asarray(Image.open(os.path.join(raw, "earth_topo", "gebco_08_rev_elev_5400x2700.tif")).convert("L"))
save_webp(to_u8(resample_to(elev, (2048, 1024), k=2)), os.path.join(out, "height.webp"), lossless=True)

# Clouds: Blue Marble 2002 combined cloud map (native 2048x1024), grayscale.
print("clouds")
cl = rgb(os.path.join(raw, "earth_clouds_bm2002", "cloud_combined_2048.tif")).astype(np.float32).mean(axis=2)
save_webp(to_u8(cl), os.path.join(out, "clouds.webp"), quality=90)

# Water mask from Natural Earth: white = water (ocean + lakes), black = land + ice shelves.
print("water mask")
SS = 4
W, H = 2048 * SS, 1024 * SS
mask = Image.new("L", (W, H), 255)
dr = ImageDraw.Draw(mask)


def proj(ring):
    return [((lon + 180.0) / 360.0 * W - 0.5, (90.0 - lat) / 180.0 * H - 0.5) for lon, lat in ring]


def polys(path):
    gj = json.load(open(path, encoding="utf-8"))
    for f in gj["features"]:
        g = f["geometry"]
        if g is None:
            continue
        if g["type"] == "Polygon":
            yield g["coordinates"]
        elif g["type"] == "MultiPolygon":
            yield from g["coordinates"]


def draw(path, fill, holes_fill):
    n = 0
    for poly in polys(path):
        dr.polygon(proj(poly[0]), fill=fill)
        for hole in poly[1:]:
            dr.polygon(proj(hole), fill=holes_fill)
        n += 1
    print("  %s: %d polygons" % (os.path.basename(path), n))


ne = os.path.join(raw, "earth_naturalearth")
draw(os.path.join(ne, "ne_10m_land.geojson"), 0, 255)
draw(os.path.join(ne, "ne_50m_lakes.geojson"), 255, 0)
draw(os.path.join(ne, "ne_50m_antarctic_ice_shelves_polys.geojson"), 0, 0)
m = mask.reduce(SS)  # box average -> anti-aliased coastlines
save_webp(np.asarray(m), os.path.join(out, "water_mask.webp"), lossless=True)
print("water fraction: %.3f" % (np.asarray(m, np.float64).mean() / 255))
