// Where in the song a few seconds of it are: for singing along with a player
// the page can't ask (Bilibili, any other site), the tab's sound while singing
// is matched against the recording made for the analysis. Each 10 ms frame is
// described by its loudness in 8 bands and in the 12 pitch classes (chroma,
// 100–2000 Hz: which notes and chords sound — the bands alone mostly follow
// the drums and bass, and mixed up repeated bars); each dimension's mean is
// taken out over the stretch, so the pattern counts, not the volume. The best
// lag is the one where the patterns correlate most.

import { getFFT, hann } from '../dsp/fft.js';

export const RATE = 100;           // frames a second
const EDGES = [60, 150, 300, 600, 1200, 2400, 4800, 9600, 16000];
const NB = EDGES.length - 1;
export const BANDS = NB + 12; // dimensions per frame: 8 bands, 12 pitch classes

// x (mono, any sr) → { F: Float32Array frames × BANDS (log energy), n }
export function features(x, sr) {
  const hop = sr / RATE, N = 2048, n = Math.max(0, Math.floor((x.length - N) / hop) + 1);
  const fft = getFFT(N), w = hann(N), re = new Float64Array(N), im = new Float64Array(N), F = new Float32Array(n * BANDS);
  const bins = EDGES.map((f) => Math.min(N / 2, Math.round((f * N) / sr)));
  // each bin from 100 to 2000 Hz → its pitch class
  const k0 = Math.ceil((100 * N) / sr), k1 = Math.floor((2000 * N) / sr), pc = new Int8Array(k1 + 1);
  for (let k = k0; k <= k1; k++) pc[k] = ((Math.round(12 * Math.log2((k * sr) / N / 440)) % 12) + 12) % 12;
  const chroma = new Float64Array(12);
  for (let i = 0; i < n; i++) {
    const s = Math.round(i * hop);
    for (let k = 0; k < N; k++) { re[k] = x[s + k] * w[k]; im[k] = 0; }
    fft.transform(re, im);
    for (let b = 0; b < NB; b++) {
      let e = 1e-10;
      for (let k = bins[b]; k < bins[b + 1]; k++) e += re[k] * re[k] + im[k] * im[k];
      F[i * BANDS + b] = Math.log10(e);
    }
    chroma.fill(1e-10);
    for (let k = k0; k <= k1; k++) chroma[pc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    for (let c = 0; c < 12; c++) F[i * BANDS + NB + c] = Math.log10(chroma[c]);
  }
  return { F, n };
}

// each dimension's mean out, scaled to unit variance: what's left is the
// pattern, not the volume. The song: its local mean (a centred 4 s average)
// out, so any stretch of it compares with a live stretch normalised by its own
// mean; done once, then every lag costs one dot product.
function zLive(F, n) {
  const out = new Float32Array(n * BANDS);
  for (let k = 0; k < BANDS; k++) {
    let m = 0; for (let i = 0; i < n; i++) m += F[i * BANDS + k]; m /= n;
    let v = 0; for (let i = 0; i < n; i++) { const d = F[i * BANDS + k] - m; v += d * d; }
    const sd = Math.sqrt(v / n) || 1;
    for (let i = 0; i < n; i++) out[i * BANDS + k] = (F[i * BANDS + k] - m) / sd;
  }
  return out;
}
export function prepare(song) {
  if (song.Z) return song.Z;
  const { F, n } = song, W = 2 * RATE, Z = new Float32Array(n * BANDS);
  for (let k = 0; k < BANDS; k++) {
    const c = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) c[i + 1] = c[i] + F[i * BANDS + k];
    let v = 0;
    for (let i = 0; i < n; i++) { const a = Math.max(0, i - W), b = Math.min(n, i + W + 1), d = F[i * BANDS + k] - (c[b] - c[a]) / (b - a); Z[i * BANDS + k] = d; v += d * d; }
    const sd = Math.sqrt(v / n) || 1;
    for (let i = 0; i < n; i++) Z[i * BANDS + k] /= sd;
  }
  return (song.Z = Z);
}

// The frame of `song` where `live` matches best, searched over [from, to)
// (frames; default: all of the song). → { at (frame of the song where live's
// first frame falls), score (mean correlation), margin (best minus the best
// ≥ 0.5 s away: how sure) } or null
export function locate(song, live, { from = 0, to = Infinity } = {}) {
  const L = live.n;
  if (L < RATE || song.n < L) return null;
  const Z = prepare(song), q = zLive(live.F, L), lo = Math.max(0, Math.floor(from)), hi = Math.min(song.n - L, Math.floor(to));
  if (hi < lo) return null;
  const scores = new Float32Array(hi - lo + 1), len = L * BANDS;
  for (let s = lo; s <= hi; s++) {
    let c = 0; const o = s * BANDS;
    for (let i = 0; i < len; i++) c += Z[o + i] * q[i];
    scores[s - lo] = c / len;
  }
  let best = 0; for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;
  let other = -1; for (let i = 0; i < scores.length; i++) if (Math.abs(i - best) >= RATE / 2 && scores[i] > other) other = scores[i];
  return { at: lo + best, score: scores[best], margin: scores[best] - Math.max(0, other) };
}
