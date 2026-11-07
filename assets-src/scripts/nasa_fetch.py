"""Fetch an image from the NASA Image and Video Library.
usage: python -I nasa_fetch.py <nasa_id> <out_dir> [pref]   pref: orig|large|medium|small|thumb (default orig)
Writes <out_dir>/<file> and <out_dir>/metadata.json; prints the chosen URL."""
import json, os, sys, urllib.parse, urllib.request, shutil
H = {"User-Agent": "space-animation-v1/1.0 (educational project)"}
nid, out = sys.argv[1], sys.argv[2]
pref = sys.argv[3] if len(sys.argv) > 3 else "orig"
order = ["orig", "large", "medium", "small", "thumb"]
order = order[order.index(pref):] + order[:order.index(pref)][::-1]
os.makedirs(out, exist_ok=True)
def get(u):
    return urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=180)
man = json.load(get("https://images-api.nasa.gov/asset/" + urllib.parse.quote(nid)))
urls = [i["href"] for i in man["collection"]["items"]]
pick = None
for p in order:
    for u in urls:
        if ("~" + p + ".") in u and u.lower().endswith((".jpg", ".jpeg", ".png", ".tif")):
            pick = u; break
    if pick: break
if not pick:
    pick = [u for u in urls if u.lower().endswith((".jpg", ".jpeg", ".png"))][0]
pick = pick.replace("http://", "https://")
fn = os.path.join(out, urllib.parse.unquote(pick.rsplit("/", 1)[1]))
with get(pick) as r, open(fn, "wb") as f:
    shutil.copyfileobj(r, f)
meta_u = [u for u in urls if u.endswith("metadata.json")]
if meta_u:
    try:
        with get(meta_u[0].replace("http://", "https://")) as r, open(os.path.join(out, "metadata.json"), "wb") as f:
            shutil.copyfileobj(r, f)
    except Exception as e:
        print("  metadata fail", e)
print(pick, "->", fn, os.path.getsize(fn))
