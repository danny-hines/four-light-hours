"""Yale Bright Star Catalogue (BSC5, ADC V/50) -> compact little-endian binary.

usage: python -I build_stars.py <ybsc5.gz> <BSC5 binary (cross-check)> <out_sky_dir>

stars.bin layout: uint32 count; then per star float32 ra (rad, J2000), float32 dec (rad, J2000),
float32 vmag, float32 b_v (0.6 when the catalogue has no B-V). Stars appear in HR order;
entries without a position (14 non-stellar/withdrawn HR numbers) are skipped.
"""
import gzip
import json
import math
import os
import struct
import sys

ascii_path, bin_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
os.makedirs(out_dir, exist_ok=True)


def fld(line, a, b):  # 1-based inclusive byte columns, as in the ADC ReadMe
    return line[a - 1:b].strip()


stars = []
for raw in gzip.open(ascii_path, "rt", encoding="latin-1"):
    line = raw.rstrip("\n").ljust(197)
    hr = int(fld(line, 1, 4))
    if not fld(line, 76, 77):
        continue  # no J2000 position
    ra_h = int(fld(line, 76, 77)) + int(fld(line, 78, 79)) / 60 + float(fld(line, 80, 83)) / 3600
    sign = -1.0 if line[83] == "-" else 1.0
    dec_d = sign * (int(fld(line, 85, 86)) + int(fld(line, 87, 88)) / 60 + int(fld(line, 89, 90)) / 3600)
    vm = fld(line, 103, 107)
    if not vm:
        continue
    bv = fld(line, 110, 114)
    stars.append({
        "hr": hr, "name": line[4:14], "ra": math.radians(ra_h * 15.0), "dec": math.radians(dec_d),
        "vmag": float(vm), "bv": float(bv) if bv else 0.6, "bv_missing": not bv,
    })

# ---- cross-check positions against the Harvard binary BSC5 (J2000 radians, doubles) ----
with open(bin_path, "rb") as f:
    data = f.read()
for bo in "<>":
    star0, star1, starn, stnum, mprop, nmag, nbent = struct.unpack(bo + "7i", data[:28])
    if abs(starn) == 9110:
        break
binpos = {}
for i in range(abs(starn)):
    xno, sra, sdec, _is, mag, _pm1, _pm2 = struct.unpack(bo + "fdd2shff", data[28 + 32 * i: 60 + 32 * i])
    binpos[int(round(xno))] = (sra, sdec, mag / 100.0)
worst = 0.0
for s in stars:
    if s["hr"] in binpos:
        ra2, de2, _m = binpos[s["hr"]]
        d = math.degrees(math.acos(min(1.0, math.sin(s["dec"]) * math.sin(de2) +
                                       math.cos(s["dec"]) * math.cos(de2) * math.cos(s["ra"] - ra2)))) * 3600
        worst = max(worst, d)
print("cross-check vs binary BSC5 (%s-endian, %d entries): max separation %.2f arcsec"
      % ("little" if bo == "<" else "big", abs(starn), worst))

# ---- binary ----
with open(os.path.join(out_dir, "stars.bin"), "wb") as f:
    f.write(struct.pack("<I", len(stars)))
    for s in stars:
        f.write(struct.pack("<ffff", s["ra"], s["dec"], s["vmag"], s["bv"]))

by_hr = {s["hr"]: (i, s) for i, s in enumerate(stars)}


def example(name, hr):
    i, s = by_hr[hr]
    return {"name": name, "hr": hr, "index": i, "ra_deg": round(math.degrees(s["ra"]), 4),
            "dec_deg": round(math.degrees(s["dec"]), 4), "vmag": s["vmag"], "bv": s["bv"]}


meta = {
    "source": "Yale Bright Star Catalogue, 5th rev. (Hoffleit & Warren 1991), ADC/CDS V/50; "
              "file ybsc5 from tdc-www.harvard.edu (public domain)",
    "count": len(stars),
    "minMag": min(s["vmag"] for s in stars),
    "maxMag": max(s["vmag"] for s in stars),
    "layout": "u32 count; then f32 ra, f32 dec, f32 vmag, f32 bv per star",
    "endianness": "little",
    "units": {"ra": "radians, J2000 (0..2pi)", "dec": "radians, J2000 (-pi/2..pi/2)", "vmag": "V magnitude",
              "bv": "B-V colour index (0.6 substituted when missing)"},
    "order": "HR (Harvard Revised) number ascending; entries with no position skipped",
    "bvMissingCount": sum(s["bv_missing"] for s in stars),
    "bytes": 4 + 16 * len(stars),
    "examples": [example("Sirius", 2491), example("Vega", 7001), example("Betelgeuse", 2061),
                 example("Polaris", 424), example("Rigel", 1713)],
}
json.dump(meta, open(os.path.join(out_dir, "stars.json"), "w"), indent=2)
for e in meta["examples"]:
    print("  ", e)

# ---- common names (57 navigational stars + Polaris, Castor, Mimosa), matched by Bayer designation ----
NAMES = [
    ("Alpheratz", "Alp", "And"), ("Ankaa", "Alp", "Phe"), ("Schedar", "Alp", "Cas"), ("Diphda", "Bet", "Cet"),
    ("Achernar", "Alp", "Eri"), ("Hamal", "Alp", "Ari"), ("Polaris", "Alp", "UMi"), ("Acamar", "The", "Eri"),
    ("Menkar", "Alp", "Cet"), ("Mirfak", "Alp", "Per"), ("Aldebaran", "Alp", "Tau"), ("Rigel", "Bet", "Ori"),
    ("Capella", "Alp", "Aur"), ("Bellatrix", "Gam", "Ori"), ("Elnath", "Bet", "Tau"), ("Alnilam", "Eps", "Ori"),
    ("Betelgeuse", "Alp", "Ori"), ("Canopus", "Alp", "Car"), ("Sirius", "Alp", "CMa"), ("Adhara", "Eps", "CMa"),
    ("Procyon", "Alp", "CMi"), ("Castor", "Alp", "Gem"), ("Pollux", "Bet", "Gem"), ("Avior", "Eps", "Car"),
    ("Suhail", "Lam", "Vel"), ("Miaplacidus", "Bet", "Car"), ("Alphard", "Alp", "Hya"), ("Regulus", "Alp", "Leo"),
    ("Dubhe", "Alp", "UMa"), ("Denebola", "Bet", "Leo"), ("Gienah", "Gam", "Crv"), ("Acrux", "Alp", "Cru"),
    ("Gacrux", "Gam", "Cru"), ("Mimosa", "Bet", "Cru"), ("Alioth", "Eps", "UMa"), ("Spica", "Alp", "Vir"),
    ("Alkaid", "Eta", "UMa"), ("Hadar", "Bet", "Cen"), ("Menkent", "The", "Cen"), ("Arcturus", "Alp", "Boo"),
    ("Rigil Kentaurus", "Alp", "Cen"), ("Zubenelgenubi", "Alp", "Lib"), ("Kochab", "Bet", "UMi"),
    ("Alphecca", "Alp", "CrB"), ("Antares", "Alp", "Sco"), ("Atria", "Alp", "TrA"), ("Sabik", "Eta", "Oph"),
    ("Shaula", "Lam", "Sco"), ("Rasalhague", "Alp", "Oph"), ("Eltanin", "Gam", "Dra"),
    ("Kaus Australis", "Eps", "Sgr"), ("Vega", "Alp", "Lyr"), ("Nunki", "Sig", "Sgr"), ("Altair", "Alp", "Aql"),
    ("Peacock", "Alp", "Pav"), ("Deneb", "Alp", "Cyg"), ("Enif", "Eps", "Peg"), ("Alnair", "Alp", "Gru"),
    ("Fomalhaut", "Alp", "PsA"), ("Markab", "Alp", "Peg"),
]
named = []
for nm, greek, con in NAMES:
    # Name field: cols 5-7 Flamsteed, 8-10 Bayer Greek, 11 superscript, 12-14 constellation
    cands = [s for s in stars if s["name"][-3:] == con and s["name"][-7:-4] == greek.ljust(3)]
    if not cands:
        print("  !! no match for", nm, greek, con)
        continue
    s = min(cands, key=lambda c: c["vmag"])  # brightest component of multiples (alpha Cen, alpha Cru, ...)
    named.append({"name": nm, "hr": s["hr"], "ra": round(s["ra"], 6), "dec": round(s["dec"], 6),
                  "vmag": s["vmag"], "bayer": " ".join(s["name"].split())})
named.sort(key=lambda n: n["vmag"])
json.dump(named, open(os.path.join(out_dir, "star_names.json"), "w"), indent=1)
print("named stars:", len(named))
for n in named:
    print("   %-16s HR%-5d %-10s V=%5.2f ra=%7.3f dec=%7.3f deg" % (
        n["name"], n["hr"], n["bayer"], n["vmag"], math.degrees(n["ra"]), math.degrees(n["dec"])))
