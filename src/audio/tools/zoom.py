# Zoomed spectrogram of a stretch of the offline render, with the melody's notes marked.
#   python src/audio/tools/zoom.py [--wav shots/audio/score.wav] [--json shots/audio/score_analysis.json]
#                                  --t0 296 --t1 318 --out shots/audio/zoom_saturn_eclipse.png [--title ...]
#                                  [--fmin 40 --fmax 8000]
# Log-frequency STFT (mid channel, 8192-point Hann, 25 ms hop), top 75 dB, note-name axis; cyan ticks mark each
# melody note's onset and pitch (from the plan's phrases in the analysis JSON); the lower panel shows mid/side RMS.
import argparse, json, wave
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ap = argparse.ArgumentParser()
ap.add_argument('--wav', default='shots/audio/score.wav')
ap.add_argument('--json', default='shots/audio/score_analysis.json')
ap.add_argument('--t0', type=float, required=True)
ap.add_argument('--t1', type=float, required=True)
ap.add_argument('--out', required=True)
ap.add_argument('--title', default='')
ap.add_argument('--fmin', type=float, default=40)
ap.add_argument('--fmax', type=float, default=8000)
a = ap.parse_args()

w = wave.open(a.wav, 'rb')
sr = w.getframerate()
w.setpos(int(max(0, a.t0 - 0.2) * sr))
n = int((a.t1 - a.t0 + 0.4) * sr)
x = np.frombuffer(w.readframes(n), dtype=np.int16).reshape(-1, 2).astype(np.float64) / 32768
base = max(0, a.t0 - 0.2)
mid, side = x.mean(axis=1), (x[:, 0] - x[:, 1]) / 2
N, hop = 8192, int(0.025 * sr)
win = np.hanning(N)
cols = []
times = []
for o in range(0, len(mid) - N, hop):
    cols.append(np.abs(np.fft.rfft(mid[o:o + N] * win)) ** 2)
    times.append(base + (o + N / 2) / sr)
S = 10 * np.log10(np.array(cols).T + 1e-14)
f = np.fft.rfftfreq(N, 1 / sr)
nb = 600
edges = np.geomspace(a.fmin, a.fmax, nb + 1)
img = np.zeros((nb, S.shape[1]))
for b in range(nb):
    k0, k1 = np.searchsorted(f, edges[b]), np.searchsorted(f, edges[b + 1])
    img[b] = S[k0:max(k0 + 1, k1)].max(axis=0)
top = img.max()
fig, (ax, ax2) = plt.subplots(2, 1, figsize=(14.4, 8), gridspec_kw={'height_ratios': [4, 1]}, sharex=True)
ax.imshow(img, origin='lower', aspect='auto', cmap='magma', vmin=top - 75, vmax=top, extent=[times[0], times[-1], 0, nb])
names = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B']
ticks, labels = [], []
for m in range(24, 120):
    fr = 440 * 2 ** ((m - 69) / 12)
    if a.fmin <= fr <= a.fmax and m % 12 in (2, 9):
        ticks.append(np.log(fr / a.fmin) / np.log(a.fmax / a.fmin) * nb)
        labels.append(names[m % 12] + str(m // 12 - 1))
ax.set_yticks(ticks)
ax.set_yticklabels(labels)
try:
    J = json.load(open(a.json, encoding='utf8'))
    for ph in J.get('plan', {}).get('phrases', []) or []:
        if ph['t1'] < a.t0 - 1 or ph['t0'] > a.t1:
            continue
        ons = [m for m in J.get('motif', []) if ph['t0'] - 0.3 <= m['t'] <= ph['t1'] + 0.05 and m['inst'] == ph['inst']]
        for m in ons:
            fr = 440 * 2 ** ((m['midi'] - 69) / 12)
            y = np.log(fr / a.fmin) / np.log(a.fmax / a.fmin) * nb
            ax.plot([m['t'], m['t'] + 0.35], [y, y], color='cyan', lw=1.2)
            ax.text(m['t'], y + 4, f"{m['marginDb']:+.0f}", color='cyan', fontsize=7)
except Exception as e:
    print('no motif marks:', e)
ax.set_ylabel('note')
ax.set_title(a.title or f'{a.t0:.1f}-{a.t1:.1f} s (mid channel, top 75 dB; cyan = melody notes, margin dB)')
r = lambda s: [10 * np.log10(np.mean(s[i:i + int(0.05 * sr)] ** 2) + 1e-12) for i in range(0, len(s) - int(0.05 * sr), int(0.05 * sr))]
tt = base + np.arange(len(r(mid))) * 0.05
ax2.plot(tt, r(mid), lw=0.8, label='mid RMS 50 ms')
ax2.plot(tt, r(side), lw=0.8, label='side RMS 50 ms')
ax2.set_ylim(-70, 0)
ax2.set_xlim(a.t0, a.t1)
ax2.legend(fontsize=7, loc='lower right')
ax2.set_xlabel('s')
plt.tight_layout()
plt.savefig(a.out, dpi=100)
print('wrote', a.out)
