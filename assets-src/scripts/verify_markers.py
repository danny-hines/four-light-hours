"""Draw lon/lat markers (east lon, 0 at centre) on equirect maps.
usage: python -I verify_markers.py <out.jpg> <img> "lon,lat;lon,lat" [<img> "..."]..."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image  # noqa
from PIL import ImageDraw
out = sys.argv[1]; items = sys.argv[2:]
tiles = []
for i in range(0, len(items), 2):
    im = Image.open(items[i]).convert("RGB").resize((800, 400), Image.LANCZOS)
    d = ImageDraw.Draw(im)
    d.line([(400, 0), (400, 400)], fill=(0, 255, 0)); d.line([(0, 200), (800, 200)], fill=(0, 255, 0))
    for pt in filter(None, items[i + 1].split(";")):
        lon, lat = map(float, pt.split(","))
        x = (lon + 180) / 360 * 800; y = (90 - lat) / 180 * 400
        d.ellipse([x - 9, y - 9, x + 9, y + 9], outline=(255, 0, 255), width=2)
    d.text((4, 4), os.path.basename(os.path.dirname(items[i])) + "/" + os.path.basename(items[i]), fill=(255, 255, 0))
    tiles.append(im)
cols = 2; rows = -(-len(tiles) // cols)
sheet = Image.new("RGB", (800 * cols, 400 * rows))
for k, t in enumerate(tiles):
    sheet.paste(t, ((k % cols) * 800, (k // cols) * 400))
sheet.save(out, quality=85); print(out, sheet.size)
