"""Dev only: instruction counts of an HLSL dump split by loop nesting (where FXC time goes).
usage: python -I segs.py file.hlsl [--asm out.asm]"""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxc
src = fxc.prep(open(sys.argv[1], encoding='utf-8').read())
d = fxc.disasm(src)
lines = [l for l in d.split('\n') if l.strip() and not l.strip().startswith('//') and not l.strip().startswith('dcl_')]
if '--asm' in sys.argv:
    open(sys.argv[sys.argv.index('--asm') + 1], 'w').write('\n'.join(lines))
depth = 0; seg = 0; out = []
for l in lines:
    op = l.split()[0]
    if op == 'loop':
        out.append(f"{'  ' * depth}{seg}"); seg = 0; depth += 1; out.append(f"{'  ' * (depth - 1)}loop {{")
    elif op == 'endloop':
        out.append(f"{'  ' * depth}{seg}"); seg = 0; depth -= 1; out.append(f"{'  ' * depth}}}")
    else:
        seg += 1
out.append(str(seg))
print('total', len(lines))
print('\n'.join(out))
