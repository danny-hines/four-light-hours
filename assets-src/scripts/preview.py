"""Save a small JPEG preview: python -I preview.py <src> <out.jpg> [width] [x0 y0 x1 y1 crop fractions]"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image  # noqa
src, out = sys.argv[1], sys.argv[2]
w = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
im = Image.open(src)
if len(sys.argv) > 7:
    f = [float(v) for v in sys.argv[4:8]]
    im = im.crop((int(f[0] * im.width), int(f[1] * im.height), int(f[2] * im.width), int(f[3] * im.height)))
if im.mode not in ("RGB", "L"):
    im = im.convert("RGB")
im.thumbnail((w, w * 4))
im.save(out, quality=85)
print(out, im.size)
