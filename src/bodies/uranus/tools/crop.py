"""Crop and enlarge part of a screenshot (dev only). usage: python -I crop.py in.png out.png x0 y0 x1 y1 [scale] [gain]"""
import site, sys
p = site.getusersitepackages()
if p not in sys.path:
    sys.path.append(p)
from PIL import Image
a = sys.argv
im = Image.open(a[1]).convert('RGB')
x0, y0, x1, y1 = map(int, a[3:7])
sc = float(a[7]) if len(a) > 7 else 2.0
gain = float(a[8]) if len(a) > 8 else 1.0
c = im.crop((x0, y0, x1, y1))
if gain != 1.0:
    c = c.point(lambda v: min(255, int(v * gain)))
c = c.resize((int((x1 - x0) * sc), int((y1 - y0) * sc)), Image.NEAREST)
c.save(a[2])
