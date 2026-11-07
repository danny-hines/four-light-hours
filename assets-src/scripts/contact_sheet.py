"""Contact sheet of images: python -I contact_sheet.py <out.jpg> <cell_px> <img>..."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import Image  # noqa
from PIL import ImageDraw
out, cell = sys.argv[1], int(sys.argv[2]); ims = sys.argv[3:]
cols = 4; rows = -(-len(ims) // cols)
sheet = Image.new("RGB", (cols * cell, rows * (cell + 14)), (40, 40, 40))
d = ImageDraw.Draw(sheet)
for k, p in enumerate(ims):
    im = Image.open(p).convert("RGB"); im.thumbnail((cell, cell))
    x, y = (k % cols) * cell, (k // cols) * (cell + 14)
    sheet.paste(im, (x, y + 14)); d.text((x + 2, y + 1), os.path.basename(p)[:40], fill=(255, 255, 0))
sheet.save(out, quality=85); print(out, sheet.size)
