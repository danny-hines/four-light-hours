"""Print title/size/description for NASA image IDs: python -I nasa_info.py ID [ID...]"""
import json, sys, urllib.parse, urllib.request
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
H = {"User-Agent": "space-animation-v1/1.0 (educational project)"}
for nid in sys.argv[1:]:
    try:
        d = json.load(urllib.request.urlopen(urllib.request.Request("https://images-api.nasa.gov/search?nasa_id=" + urllib.parse.quote(nid), headers=H), timeout=60))
        it = d["collection"]["items"][0]; x = it["data"][0]
        canon = [l for l in it.get("links", []) if l.get("rel") == "canonical"]
        dims = ("%sx%s" % (canon[0].get("width"), canon[0].get("height"))) if canon else "?"
        print("== %s | %s | %s | %s | %s" % (nid, x["title"], x.get("center"), x.get("secondary_creator", x.get("photographer", "")), dims))
        print("   ", x.get("description", "")[:500].replace("\n", " "))
    except Exception as e:
        print("== %s ERROR %s" % (nid, e))
