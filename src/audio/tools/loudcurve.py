# The film's loudness arc from the offline render: BS.1770 short-term loudness (3 s) and momentary (400 ms),
# with the world sections, warp legs (by gesture) and the anchor cues marked; prints the loudest moments and the
# short-term peak around each anchor and each leg.
#   python src/audio/tools/loudcurve.py [--wav shots/audio/score.wav] [--json shots/audio/score_analysis.json]
#                                       [--out shots/audio/loudness.png]
import argparse, json, wave
import numpy as np
from scipy.signal import lfilter
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ap = argparse.ArgumentParser()
ap.add_argument('--wav', default='shots/audio/score.wav')
ap.add_argument('--json', default='shots/audio/score_analysis.json')
ap.add_argument('--out', default='shots/audio/loudness.png')
a = ap.parse_args()

w = wave.open(a.wav, 'rb')
sr = w.getframerate()
x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, 2).astype(np.float64) / 32768
# K-weighting (BS.1770-4, coefficients for any rate via the bilinear-transform design)
def kfilt(sig):
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    aa = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    y = lfilter(b, aa, sig)
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / sr)
    aa = [1, 2 * (K * K - 1) / (1 + K / Q + K * K), (1 - K / Q + K * K) / (1 + K / Q + K * K)]
    return lfilter([1, -2, 1], aa, y)
k = kfilt(x[:, 0]) ** 2 + kfilt(x[:, 1]) ** 2
hop = int(0.1 * sr)
seg = k[:len(k) // hop * hop].reshape(-1, hop).mean(axis=1)
def win(n):
    c = np.convolve(seg, np.ones(n) / n, mode='full')[:len(seg)]
    return -0.691 + 10 * np.log10(c + 1e-12)
st, mom = win(30), win(4)
t = (np.arange(len(seg)) + 1) * 0.1

J = json.load(open(a.json))
P = J['plan']
cues = {c['id']: c['t'] for c in (P.get('cues') or [])}
dur = P['duration']
fig, ax = plt.subplots(figsize=(18, 5.5))
ax.plot(t, mom, color='#9ab', lw=0.5, label='momentary (400 ms)')
ax.plot(t, st, color='#135', lw=1.4, label='short-term (3 s)')
cols = {'riser': '#d62', 'hush': '#28a', 'choir': '#a3c', 'streak': '#3a3', 'brass': '#b80', 'cruise': '#888'}
for wv in P['warps']:
    g = wv.get('gesture') or ('riser' if wv['leg'] else 'cruise')
    ax.axvspan(wv['ws'], wv['ta'] if wv['leg'] else wv['we'], color=cols.get(g, '#888'), alpha=0.18)
    ax.text(wv['ws'], -9.3, g, fontsize=7, color=cols.get(g, '#888'))
for s in P['sections']:
    ax.axvline(s['t0'], color='k', lw=0.4, alpha=0.4)
    ax.text(s['t0'] + 0.5, -42, s['world'], fontsize=8, rotation=90, va='bottom')
for cid in ['earthrise', 'eclipse', 'pale-blue-dot', 'sunrise', 'jupiter-skim', 'sun-reveal']:
    if cid in cues:
        ax.axvline(cues[cid], color='#c00', lw=0.8, ls='--')
        ax.text(cues[cid] + 0.4, -12.5, cid, fontsize=8, color='#c00')
ax.set_xlim(0, dur + 7)
ax.set_ylim(-45, -8)
ax.set_xlabel('s')
ax.set_ylabel('LUFS')
ax.grid(alpha=0.25)
ax.legend(loc='lower right', fontsize=8)
ax.set_title('loudness arc (BS.1770 short-term / momentary); shaded = warp legs by gesture; red = anchors')
plt.tight_layout()
plt.savefig(a.out, dpi=100)
pk = lambda t0, t1: float(st[(t >= t0) & (t <= t1)].max())
print('anchors (ST max from cue-1 to cue+12):', ', '.join(f'{c} {pk(cues[c] - 1, cues[c] + 12):.1f}' for c in ['sunrise', 'earthrise', 'jupiter-skim', 'eclipse', 'pale-blue-dot'] if c in cues))
print('legs (ST max inside the leg / 8 s after):', ', '.join(f"{wv['ws']:.0f} {wv.get('gesture')} {pk(wv['ws'] + 1, wv['ta']):.1f}/{pk(wv['ta'], wv['ta'] + 8):.1f}" for wv in P['warps'] if wv['leg']))
order = np.argsort(-st)
tops = []
for i in order:
    if t[i] > dur: continue
    if all(abs(t[i] - q) >= 8 for q, _ in tops): tops.append((t[i], st[i]))
    if len(tops) >= 8: break
print('loudest moments:', ', '.join(f'{q:.1f} s {v:.1f}' for q, v in tops))
print('wrote', a.out)
