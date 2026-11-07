"""Print size/mode/TIFF layout for each raster path given on the command line."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import read_tiff_tags, Image  # noqa
for p in sys.argv[1:]:
    line = os.path.basename(p) + ": "
    if p.lower().endswith((".tif", ".tiff")):
        try:
            bo, t = read_tiff_tags(p)
            line += "W=%s H=%s bps=%s spp=%s comp=%s planar=%s fmt=%s tiled=%s nstrips=%s" % (
                t.get(256), t.get(257), t.get(258), t.get(277), t.get(259), t.get(284), t.get(339),
                322 in t, len(t[273]) if isinstance(t.get(273), tuple) else 1)
        except Exception as e:
            line += "tiff parse err %s" % e
    else:
        im = Image.open(p); line += "%s %s" % (im.size, im.mode)
    print(line)
