# dev: compile ANGLE's translated HLSL (dev/hlsl/*.hlsl from dump-hlsl.mjs) with d3dcompiler_47 directly:
# prints compile time and the instruction count of the DXBC. usage: python fxc.py <file.hlsl> [ps|vs] [O0|O1|O2|O3]
import ctypes, re, sys, time
from ctypes import c_void_p, c_char_p, c_size_t, c_uint, POINTER, byref
d3d = ctypes.WinDLL('d3dcompiler_47.dll')
class Blob(ctypes.Structure):
    pass
def blob_str(b):
    # ID3DBlob vtable: QueryInterface, AddRef, Release, GetBufferPointer, GetBufferSize
    vt = ctypes.cast(b, POINTER(POINTER(c_void_p)))[0]
    gp = ctypes.WINFUNCTYPE(c_void_p, c_void_p)(vt[3]); gs = ctypes.WINFUNCTYPE(c_size_t, c_void_p)(vt[4])
    return ctypes.string_at(gp(b), gs(b))
def prep(src, stage):
    if stage == 'ps':
        vars_ = re.findall(r'^static\s{2}(float\d?|float\dx\d)\s+(_\w+) = ', src, re.M)
        decl = '\n'.join(f'  {t} v{i} : TEXCOORD{i};' for i, (t, n) in enumerate(vars_))
        pro = '\n'.join(f'{n} = input.v{i};' for i, (t, n) in enumerate(vars_))
        fc = 'gl_FragCoord = input.dx_Position;' if 'static float4 gl_FragCoord' in src else ''
        src = src.replace('@@ PIXEL OUTPUT @@', 'struct PS_INPUT { float4 dx_Position : SV_Position;\n' + decl + '\n};\nstruct PS_OUTPUT { float4 gl_Color0 : SV_Target0; };\nPS_OUTPUT generateOutput() { PS_OUTPUT o; o.gl_Color0 = out_pc_fragColor; return o; }')
        src = src.replace('@@ PIXEL MAIN PARAMETERS @@', 'PS_INPUT input')
        src = src.replace('@@ MAIN PROLOGUE @@', pro + '\n' + fc)
    else:
        attrs = [a for a in re.findall(r'^static\s(float\d?)\s+(_\w+) = ', src, re.M) if a[1] != 'gl_Position']
        outs = re.findall(r'^static\s{2}(float\d?)\s+(_\w+) = ', src, re.M)
        src = src.replace('@@ VERTEX ATTRIBUTES @@', 'struct VS_INPUT {\n' + '\n'.join(f'  {t} a{i} : TEXCOORD{i};' for i, (t, n) in enumerate(attrs)) + '\n};\nvoid initAttributes(VS_INPUT input) {\n' + '\n'.join(f'{n} = input.a{i};' for i, (t, n) in enumerate(attrs)) + '\n}')
        src = src.replace('@@ VERTEX OUTPUT @@', 'struct VS_OUTPUT { float4 gl_Position : SV_Position;\n' + '\n'.join(f'  {t} v{i} : TEXCOORD{i};' for i, (t, n) in enumerate(outs)) + '\n};\nVS_OUTPUT generateOutput(VS_INPUT input) { VS_OUTPUT o; o.gl_Position = gl_Position;\n' + '\n'.join(f'o.v{i} = {n};' for i, (t, n) in enumerate(outs)) + '\nreturn o; }')
        src = src.replace('@@ MAIN PROLOGUE @@', 'initAttributes(input);')
    return src
f = sys.argv[1]; stage = sys.argv[2] if len(sys.argv) > 2 else 'ps'; lev = sys.argv[3] if len(sys.argv) > 3 else 'O1'
flags = {'O0': 1 << 14, 'O1': 0, 'O2': (1 << 14) | (1 << 15), 'O3': 1 << 15}[lev]
src = prep(open(f, encoding='utf8').read(), stage).encode()
import os
reps = int(os.environ.get('FXC_REPS', '3'))
dt = 1e9
for _ in range(reps):
    code = c_void_p(); err = c_void_p()
    t0 = time.time()
    hr = d3d.D3DCompile(c_char_p(src), c_size_t(len(src)), c_char_p(b'x'), None, None, c_char_p(b'main'), c_char_p(b'ps_5_0' if stage == 'ps' else b'vs_5_0'), c_uint(flags), c_uint(0), byref(code), byref(err))
    dt = min(dt, time.time() - t0)
    if hr != 0: break
if hr != 0:
    print('FAILED', hex(hr & 0xffffffff), blob_str(err).decode(errors='replace')[:3000] if err else ''); sys.exit(1)
dis = c_void_p()
d3d.D3DDisassemble(c_void_p(ctypes.cast(blob_str_ptr := None, c_void_p).value) if False else None, 0, 0, None, None) if False else None
vt = ctypes.cast(code, POINTER(POINTER(c_void_p)))[0]
gp = ctypes.WINFUNCTYPE(c_void_p, c_void_p)(vt[3]); gs = ctypes.WINFUNCTYPE(c_size_t, c_void_p)(vt[4])
hr = d3d.D3DDisassemble(c_void_p(gp(code)), c_size_t(gs(code)), c_uint(0), None, byref(dis))
txt = blob_str(dis).decode(errors='replace') if hr == 0 else ''
m = re.search(r'// Approximately (\d+) instruction slots used', txt)
print(f'{f} {stage} {lev}: {dt*1000:.0f} ms, {m.group(1) if m else "?"} instruction slots, dxbc {gs(code)} bytes')
if len(sys.argv) > 4: open(sys.argv[4], 'w').write(txt)
