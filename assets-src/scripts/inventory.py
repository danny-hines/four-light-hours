"""List produced files with dimensions and sizes: python -I inventory.py <dir>..."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image  # noqa
for root in sys.argv[1:]:
    for dp, dn, fn in os.walk(root):
        for f in sorted(fn):
            p = os.path.join(dp, f); kb = os.path.getsize(p) / 1024
            try:
                im = Image.open(p); dims = "%dx%d %s" % (im.width, im.height, im.mode)
            except Exception:
                dims = "-"
            print("%-60s %-18s %8.1f KB" % (p.replace("\\", "/"), dims, kb))
