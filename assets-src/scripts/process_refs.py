"""Reference photographs for the art critic (not shipped in the app).

usage: python -I process_refs.py <raw_dir> <bar_refs_dir>
Each output is a JPEG (q90) with long edge <= 1600 px; crops are given in source pixels.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image  # noqa: E402

raw, out = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)

JOBS = [
    # (output name, raw dir, file, crop box or None)
    ("sun_sdo.jpg", "refs_sun_sdo", "latest_2048_0304.jpg", None),
    ("sun_sdo_aia171.jpg", "refs_sun_sdo", "latest_2048_0171.jpg", None),
    ("sun_sdo_hmi_visible.jpg", "refs_sun_sdo", "latest_2048_HMIIC.jpg", None),
    ("mercury_messenger.jpg", "refs_mercury", "PIA15160~orig.jpg", None),
    ("venus_mariner10_or_akatsuki.jpg", "refs_venus", "PIA23791~orig.jpg", (0, 0, 1096, 1096)),  # left (natural) panel
    ("earth_bluemarble_apollo17.jpg", "refs_earth_apollo17", "as17-148-22727~orig.jpg", None),
    ("earth_iss_limb_night.jpg", "refs_earth_iss_night", "iss062e103874~orig.jpg", None),
    ("moon_full.jpg", "refs_moon_iss", "iss008e08451~orig.jpg", (1119, 490, 2119, 1490)),
    ("moon_full_apollo17.jpg", "refs_moon_apollo17", "as17-152-23311~orig.jpg", None),
    ("mars_viking_or_rosetta_osiris_truecolor.jpg", "refs_mars", "PIA00407~orig.jpg", None),
    ("jupiter_juno_or_cassini.jpg", "refs_jupiter", "PIA04866~orig.jpg", None),
    ("jupiter_io_shadow_hubble.jpg", "refs_jupiter_shadow", "GSFC_20171208_Archive_e000795~orig.jpg", None),
    ("saturn_cassini_equinox.jpg", "refs_saturn_equinox", "PIA11667~orig.jpg", None),
    ("saturn_cassini_backlit.jpg", "refs_saturn_backlit", "PIA08329~orig.jpg", None),
    ("uranus_voyager2.jpg", "refs_uranus", "PIA18182~orig.jpg", None),
    ("neptune_voyager2.jpg", "refs_neptune", "PIA01492~orig.jpg", None),
    ("milkyway_eso_or_nasa.jpg", "refs_milkyway", "PIA26718~orig.png", None),
    ("pale_blue_dot_revisited.jpg", "refs_palebluedot", "PIA23645~orig.jpg", None),
    # native-resolution crop around Earth (the speck is ~1-2 px and vanishes when the full frame is downscaled)
    ("pale_blue_dot_revisited_crop.jpg", "refs_palebluedot", "PIA23645~orig.jpg", (3111 - 600, 2685 - 400, 3111 + 600, 2685 + 400)),
]

for name, d, f, crop in JOBS:
    im = Image.open(os.path.join(raw, d, f)).convert("RGB")
    src = im.size
    if crop:
        im = im.crop(crop)
    if max(im.size) > 1600:
        s = 1600 / max(im.size)
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    p = os.path.join(out, name)
    im.save(p, "JPEG", quality=90, optimize=True)
    print("%-44s %4dx%-4d (src %dx%d%s) %4.0f KB" % (name, im.width, im.height, src[0], src[1],
                                                    " crop" if crop else "", os.path.getsize(p) / 1024))
