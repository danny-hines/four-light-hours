# Log-mel self-similarity of the offline render (2 s frames), with the score's world sections marked, and the mean
# similarity between each pair of worlds (each world's own music: from 3 s after it begins to its departure leg).
#   python src/audio/tools/selfsim.py [--wav shots/audio/score.wav] [--json shots/audio/score_analysis.json]
#                                     [--out shots/audio/selfsim.png]
# Frames: 64 mel bands (30 Hz - 16 kHz) of the mid channel, 2 s windows, power -> dB (floored 80 dB under the
# loudest), each band standardised over the film, cosine similarity. Prints the world-by-world mean similarity and the neighbour pairs.
import argparse, json, wave
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ap = argparse.ArgumentParser()
ap.add_argument('--wav', default='shots/audio/score.wav')
ap.add_argument('--json', default='shots/audio/score_analysis.json')
ap.add_argument('--out', default='shots/audio/selfsim.png')
a = ap.parse_args()

w = wave.open(a.wav, 'rb')
sr = w.getframerate()
x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).reshape(-1, 2).astype(np.float64) / 32768
mid = x.mean(axis=1)
N, hop = 4096, 2048
win = np.hanning(N)
nfr = (len(mid) - N) // hop
f = np.fft.rfftfreq(N, 1 / sr)
mel = lambda hz: 2595 * np.log10(1 + hz / 700)
imel = lambda m: 700 * (10 ** (m / 2595) - 1)
edges = imel(np.linspace(mel(30), mel(16000), 66))
fb = np.zeros((64, len(f)))
for b in range(64):
    l, c, r = edges[b], edges[b + 1], edges[b + 2]
    fb[b] = np.clip(np.minimum((f - l) / (c - l), (r - f) / (r - c)), 0, None)
P = np.empty((nfr, 64))
for i in range(nfr):
    s = np.abs(np.fft.rfft(mid[i * hop:i * hop + N] * win)) ** 2
    P[i] = fb @ s
per = int(round(2.0 * sr / hop))
nblk = nfr // per
B = P[:nblk * per].reshape(nblk, per, 64).mean(axis=1)
D = 10 * np.log10(B + 1e-14)
D = np.clip(D, D.max() - 80, None)
# each band standardised over the film (so a frame is described by how it departs from the film's average
# spectrum), frames of near silence left out of the statistics
loud = D.mean(axis=1) > np.percentile(D.mean(axis=1), 5)
Z = (D - D[loud].mean(axis=0)) / (D[loud].std(axis=0) + 1e-9)
Dn = Z / (np.linalg.norm(Z, axis=1, keepdims=True) + 1e-12)
S = Dn @ Dn.T
# (also the plain measure: cosine of the floored dB frames, which rates almost any two passages of music alike)
F = D - (D.max() - 80)
Fn = F / (np.linalg.norm(F, axis=1, keepdims=True) + 1e-12)
S2 = Fn @ Fn.T
tb = (np.arange(nblk) + 0.5) * per * hop / sr

J = json.load(open(a.json))
secs = J['plan']['sections']
chars = J.get('character', [])
worlds = []
for k, s in enumerate(secs):
    c = chars[k] if k < len(chars) else None
    t0 = c['t0'] if c else s['t0'] + 3
    t1 = c['t1'] if c else s['t1']
    m = (tb >= t0) & (tb < t1)
    if m.sum() >= 2:
        worlds.append((s['world'], m))
names = [n for n, _ in worlds]
M = np.array([[S[np.ix_(mi, mj)].mean() for _, mj in worlds] for _, mi in worlds])
print('world-by-world mean log-mel similarity (2 s frames):')
print('         ' + ' '.join(n[:7].rjust(7) for n in names))
for i, n in enumerate(names):
    print(n[:8].ljust(8) + ' ' + ' '.join(f'{M[i, j]:7.2f}' for j in range(len(names))))
print('neighbours: ' + ', '.join(f'{names[i - 1]}->{names[i]} {M[i, i - 1]:.2f}' for i in range(1, len(names))))
M2 = np.array([[S2[np.ix_(mi, mj)].mean() for _, mj in worlds] for _, mi in worlds])
print('mean off-diagonal (standardised): %.3f; plain floored-dB cosine neighbours: ' % ((M.sum() - np.trace(M)) / (len(names) ** 2 - len(names))) + ', '.join(f'{names[i - 1]}->{names[i]} {M2[i, i - 1]:.3f}' for i in range(1, len(names))))
hi = [(names[i], names[j], M[i, j]) for i in range(len(names)) for j in range(i + 1, len(names)) if M[i, j] >= 0.5]
print('pairs >= 0.50 (standardised): ' + (', '.join(f'{p}/{q} {v:.2f}' for p, q, v in hi) or 'none'))

fig, ax = plt.subplots(1, 2, figsize=(16, 7.5), gridspec_kw={'width_ratios': [1.25, 1]})
im = ax[0].imshow(S, origin='lower', extent=[0, tb[-1], 0, tb[-1]], vmin=-0.5, vmax=1.0, cmap='viridis')
for s in secs:
    for v in (s['t0'],):
        ax[0].axvline(v, color='w', lw=0.4, alpha=0.6)
        ax[0].axhline(v, color='w', lw=0.4, alpha=0.6)
    ax[0].text((s['t0'] + s['t1']) / 2, -8, s['world'][:4], ha='center', va='top', fontsize=7, rotation=90)
ax[0].set_title('self-similarity (log-mel, 2 s, bands standardised)')
fig.colorbar(im, ax=ax[0], fraction=0.046)
im2 = ax[1].imshow(M, vmin=-0.5, vmax=1.0, cmap='viridis')
ax[1].set_xticks(range(len(names)), names, rotation=60, fontsize=8)
ax[1].set_yticks(range(len(names)), names, fontsize=8)
for i in range(len(names)):
    for j in range(len(names)):
        ax[1].text(j, i, f'{M[i, j]:.2f}', ha='center', va='center', fontsize=6.5, color='w' if M[i, j] < 0.6 else 'k')
ax[1].set_title('world x world mean similarity')
fig.colorbar(im2, ax=ax[1], fraction=0.046)
plt.tight_layout()
plt.savefig(a.out, dpi=110)
print('wrote', a.out)
