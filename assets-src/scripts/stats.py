"""Quick value statistics for rasters: python -I stats.py <paths>"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import load_array, np  # noqa
for p in sys.argv[1:]:
    a = load_array(p)
    s = np.asarray(a[::7, ::7], dtype=np.float64)
    q = np.percentile(s, [0, 1, 5, 25, 50, 75, 95, 99, 99.9, 100])
    print(os.path.basename(p), a.shape, a.dtype, "pct[0,1,5,25,50,75,95,99,99.9,100]=", np.round(q, 3).tolist())
