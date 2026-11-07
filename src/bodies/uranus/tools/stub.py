"""Dev only: what-if FXC cost: stub named HLSL functions (body -> cheap return) and re-time.
usage: python -I stub.py file.hlsl func1[,func2] ..."""
import sys, re, collections
import os; sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fxc

def stub(src, name):
    # find "<type> name(<args>)\n{ ... }" and replace the body by returning a cheap value of the type
    m = re.search(r'^(float[234]?|void|_\w+)\s+' + re.escape(name) + r'\(([^)]*)\)\s*\{', src, re.M)
    if not m:
        print('  (not found)', name); return src
    i = m.end(); depth = 1
    while depth:
        c = src[i]; depth += (c == '{') - (c == '}'); i += 1
    ty = m.group(1)
    first = re.findall(r'in\s+(float[234]?)\s+(\w+)', m.group(2))
    arg = first[0][1] if first else '0'
    ret = {'float': f'return dot({arg}, {arg});' if first and first[0][0] != 'float' else f'return {arg};',
           'void': 'return;'}.get(ty, f'return ({ty})0;' if ty.startswith('float') else '')
    if ty.startswith('float') and ty != 'float': ret = f'return ({ty})(dot({arg},{arg}));' if first else f'return ({ty})0;'
    return src[:m.end()] + ret + '}' + src[i:]

f = sys.argv[1]
src = fxc.prep(open(f, encoding='utf-8').read())
def count(s):
    d = fxc.disasm(s)
    return len([l for l in d.split('\n') if l.strip() and not l.strip().startswith('//') and not l.strip().startswith('dcl_')])
hr, ms, size, msg = fxc.compile_ms(src, 0)
print(f'base: {ms:.0f} ms, {count(src)} instr')
for names in sys.argv[2:]:
    s = src
    for n in names.split(','): s = stub(s, n)
    hr, ms, size, msg = fxc.compile_ms(s, 0)
    print(f'stub {names}: hr {hr & 0xffffffff:#x} {ms:.0f} ms, {count(s) if hr == 0 else 0} instr' + ('' if hr == 0 else msg[:300]))
