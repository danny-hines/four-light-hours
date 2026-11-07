"""Search NASA Image and Video Library: python -I nasa_search.py "<query>" [n]"""
import json, sys, urllib.parse, urllib.request
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
q = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv) > 2 else 12
u = "https://images-api.nasa.gov/search?media_type=image&q=" + urllib.parse.quote(q)
d = json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "space-animation-v1/1.0 (educational project)"}), timeout=60))
for it in d["collection"]["items"][:n]:
    x = it["data"][0]
    print("%-28s | %-70s | %s | %s" % (x["nasa_id"], x["title"][:70], x.get("center"), x.get("date_created", "")[:10]))
