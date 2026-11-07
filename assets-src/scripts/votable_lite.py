"""Minimal reader for VOTable BINARY streams as returned by the NASA HEASARC TAP service (no astropy needed).
Supports the field types HEASARC uses here: char arrays (variable length), short, int, float, double."""
import base64
import re
import struct

_SIZES = {'short': ('>h', 2), 'int': ('>i', 4), 'long': ('>q', 8), 'float': ('>f', 4), 'double': ('>d', 8),
          'unsignedByte': ('>B', 1), 'boolean': ('>c', 1)}


def read_votable(path):
    s = open(path, encoding='utf-8', errors='replace').read()
    fields = []
    for attrs in re.findall(r'<FIELD ([^>]*)>', s):
        name = re.search(r'name="([^"]*)"', attrs).group(1)
        dt = re.search(r'datatype="([^"]*)"', attrs).group(1)
        arr = re.search(r'arraysize="([^"]*)"', attrs)
        fields.append((name, dt, arr.group(1) if arr else None))
    m = re.search(r'<STREAM encoding="base64">(.*?)</STREAM>', s, re.S)
    b = base64.b64decode(m.group(1))
    rows = []
    p = 0
    while p < len(b):
        row = {}
        for name, dt, arr in fields:
            if dt == 'char':
                if arr == '*' or (arr and arr.endswith('*')):
                    n = struct.unpack('>I', b[p:p + 4])[0]
                    p += 4
                else:
                    n = int(arr or 1)
                row[name] = b[p:p + n].decode('latin-1').strip()
                p += n
            else:
                fmt, sz = _SIZES[dt]
                row[name] = struct.unpack(fmt, b[p:p + sz])[0]
                p += sz
        rows.append(row)
    return rows
