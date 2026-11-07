# dev: print pixel values of PNGs. usage: python px.py <png> x,y [x,y ...]   or  python px.py <png> row=<y> x0:x1:step
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
args = sys.argv[2:]
if args and args[0].startswith('row='):
    y = int(args[0][4:]); a, b, st = map(int, args[1].split(':'))
    print(' '.join('%d:%s' % (x, im.getpixel((x, y))) for x in range(a, b, st)))
elif args and args[0].startswith('col='):
    x = int(args[0][4:]); a, b, st = map(int, args[1].split(':'))
    print(' '.join('%d:%s' % (y, im.getpixel((x, y))) for y in range(a, b, st)))
else:
    for xy in args:
        x, y = map(int, xy.split(','))
        print(xy, im.getpixel((x, y)))
