"""Dev only: compile ANGLE-translated HLSL (from hlsl.mjs) with the system d3dcompiler_47.dll and time it.
usage: python -I fxc.py file.hlsl [file2.hlsl ...] [--flags 0,4,...]
Fills ANGLE's @@ placeholders with a minimal pixel-shader entry (one float3 varying vPosW)."""
import ctypes, sys, time, re, os
from ctypes import c_void_p, c_char_p, c_size_t, c_uint, POINTER, byref

d3dc = ctypes.WinDLL('d3dcompiler_47.dll')


class Blob(ctypes.Structure):
    pass


ID3DBlob = POINTER(c_void_p)


def blob_str(b):
    if not b:
        return ''
    vt = ctypes.cast(b, POINTER(POINTER(c_void_p))).contents
    GetBufferPointer = ctypes.WINFUNCTYPE(c_void_p, c_void_p)(vt[3])
    GetBufferSize = ctypes.WINFUNCTYPE(c_size_t, c_void_p)(vt[4])
    p = GetBufferPointer(b)
    n = GetBufferSize(b)
    return ctypes.string_at(p, n)


D3DCompile = d3dc.D3DCompile
D3DCompile.argtypes = [c_char_p, c_size_t, c_char_p, c_void_p, c_void_p, c_char_p, c_char_p, c_uint, c_uint, POINTER(c_void_p), POINTER(c_void_p)]
D3DCompile.restype = ctypes.c_long


def prep(src):
    # varyings: every "static float3 _vX = ..." under "// Varyings" becomes an input
    vary = re.findall(r'static\s+(float[234]?)\s+(_v\w+)\s*=', src)
    params = ['float4 dx_Position : SV_Position'] + [f'{t} in_{n} : TEXCOORD{i}' for i, (t, n) in enumerate(vary)]
    prologue = '\n'.join(f'{n} = in_{n};' for _, n in vary)
    out = 'struct PS_OUTPUT { float4 gl_Color0 : SV_TARGET0; };\nPS_OUTPUT generateOutput() { PS_OUTPUT o; o.gl_Color0 = out_pc_fragColor; return o; }\n'
    src = src.replace('@@ PIXEL OUTPUT @@', out).replace('@@ PIXEL MAIN PARAMETERS @@', ', '.join(params)).replace('@@ MAIN PROLOGUE @@', prologue)
    src = src.replace('gl_FragColor', 'out_pc_fragColor')
    return src


def compile_ms(src, flags):
    b = src.encode()
    code = c_void_p()
    err = c_void_p()
    # thread CPU time, not wall time: other processes loading the machine do not inflate it
    t0 = time.thread_time()
    hr = D3DCompile(b, len(b), b'shader', None, None, b'main', b'ps_5_0', flags, 0, byref(code), byref(err))
    ms = (time.thread_time() - t0) * 1000
    msg = blob_str(err).decode(errors='replace') if err else ''
    return hr, ms, (len(blob_str(code)) if code else 0), msg


def disasm(src, flags=0):
    b = src.encode()
    code = c_void_p()
    err = c_void_p()
    D3DCompile(b, len(b), b'shader', None, None, b'main', b'ps_5_0', flags, 0, byref(code), byref(err))
    bc = blob_str(code)
    D3DDisassemble = d3dc.D3DDisassemble
    D3DDisassemble.argtypes = [c_char_p, c_size_t, c_uint, c_char_p, POINTER(c_void_p)]
    out = c_void_p()
    D3DDisassemble(bc, len(bc), 0, None, byref(out))
    return blob_str(out).decode(errors='replace')


def count(src, flags=0):
    d = disasm(src, flags)
    return len([l for l in d.split('\n') if l.strip() and not l.strip().startswith('//') and not l.strip().startswith('dcl_')])


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    flags = [0]
    if '--flags' in sys.argv:
        flags = [int(x) for x in sys.argv[sys.argv.index('--flags') + 1].split(',')]
        args = [a for a in args if a != sys.argv[sys.argv.index('--flags') + 1]]
    for f in args:
        src = prep(open(f, encoding='utf-8').read())
        for fl in flags:
            reps = int(os.environ.get('FXC_REPS', '1'))
            res = [compile_ms(src, fl) for _ in range(reps)]
            hr, ms, size, msg = min(res, key=lambda r: r[1])
            n = count(src, fl) if hr == 0 else 0
            print(f'{os.path.basename(f):14s} {ms:7.0f} ms  {n:5d} instr  dxbc {size:6d} B' + ('' if hr == 0 else '\n' + msg[:2000]))

