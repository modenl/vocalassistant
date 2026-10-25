// The original and the singer at one moment, as spectra: where the fundamental
// (F0 = the pitch) and its harmonics lie, the singer's formants F1 / F2 (the
// vowel, not the pitch), and how the two pitches relate — in tune, sharp or
// flat, or an octave apart (then every 2nd harmonic of the lower voice sits on
// a harmonic of the higher one).

import { getFFT, hann } from '../dsp/fft.js';
import { analyzeFormants } from '../dsp/lpc.js';
import { formantTrust } from '../analysis/vowels.js';
import { midiName } from '../config.js';

const SPEC_N = 4096;

// dB spectrum (relative to its own peak) of x centred on sample `at`
export function spectrumAt(x, sr, at, N = SPEC_N) {
  const start = Math.round(at - N / 2);
  if (!x || start < 0 || start + N > x.length) return null;
  const fft = getFFT(N), w = hann(N), re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[start + i] * w[i];
  fft.transform(re, im);
  const db = new Float32Array(N / 2);
  let top = -Infinity;
  for (let k = 0; k < N / 2; k++) { db[k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-20); if (db[k] > top) top = db[k]; }
  if (!(top > -150)) return null;
  for (let k = 0; k < db.length; k++) db[k] -= top;
  return { db, binHz: sr / N };
}

// the harmonics of f0 seen in a spectrum, up to fmax: [{ k, f, db }]
export function harmonicsOf(spec, f0, fmax = 3000) {
  if (!spec || !(f0 > 0)) return [];
  const out = [];
  for (let k = 1; k * f0 <= fmax; k++) {
    const c = (k * f0) / spec.binHz, w = Math.max(1, Math.round((0.03 * k * f0) / spec.binHz));
    let b = Math.max(1, Math.round(c) - w);
    for (let i = b; i <= Math.min(spec.db.length - 2, Math.round(c) + w); i++) if (spec.db[i] > spec.db[b]) b = i;
    // the peak between bins (parabolic interpolation): bins are 10.8 Hz apart
    const y0 = spec.db[b - 1], y1 = spec.db[b], y2 = spec.db[b + 1], d = y0 - 2 * y1 + y2;
    const p = Math.abs(d) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d)) : 0;
    out.push({ k, f: (b + p) * spec.binHz, db: y1 - 0.25 * (y0 - y2) * p });
  }
  return out;
}

// the singer's F1, F2 from 2048 samples ending at `end` (where the pitch allows)
export function formantsAt(x, sr, end, f0) {
  if (formantTrust(f0) === 'none') return null;
  const n = Math.round((2048 * sr) / 44100) + 64, from = Math.round(end - n);
  if (!x || from < 0 || end > x.length) return null;
  const fr = analyzeFormants(x.subarray(from, Math.round(end)), sr, 12);
  return fr && fr.formants.length >= 2 ? fr.formants.slice(0, 2).map((q) => q.f) : null;
}

// how the singer's pitch relates to the original's
// → { octave, cents, kind: 'same' | 'near' | 'off', refName, userName }
export function pitchRelation(refF0, userF0) {
  if (!(refF0 > 0 && userF0 > 0)) return null;
  const d = 12 * Math.log2(userF0 / refF0), octave = Math.round(d / 12), cents = Math.round((d - 12 * octave) * 100), a = Math.abs(cents);
  const name = (f) => midiName(Math.round(69 + 12 * Math.log2(f / 440)));
  return { octave, cents, kind: a <= 25 ? 'same' : a <= 50 ? 'near' : 'off', refName: name(refF0), userName: name(userF0) };
}

// Ring (resonance) from the harmonics alone: the strongest harmonic in 0–2 kHz
// minus the strongest in 2–4 kHz, dB (the singing power ratio, Omori 1996 —
// smaller = brighter, more "ring"; good singing ≈ 10–20 dB). Only the voice's
// own harmonics count, which keeps most of a backing track out of it.
export function ringOf(harm) {
  const lo = harm.filter((h) => h.f < 2000), hi = harm.filter((h) => h.f >= 2000 && h.f <= 4000);
  if (!lo.length || !hi.length) return NaN;
  return Math.max(...lo.map((h) => h.db)) - Math.max(...hi.map((h) => h.db));
}

// F1, F2 from the harmonics alone: for the original, where the band is mixed
// in and an LPC fit of the recording would describe the whole mix. A clean
// signal is rebuilt from only the melody's harmonics (their measured levels;
// LPC sees just the power spectrum, so the phases don't matter) and the same
// LPC as for the singer runs on it. Gated like the singer's (none above 450 Hz).
export function envelopeFormants(harm, f0) {
  if (formantTrust(f0) === 'none') return null;
  const h = harm.filter((x) => x.f > 0 && x.f <= 4500);
  if (h.length < 4) return null;
  const sr = 11025, n = 1024, x = new Float32Array(n);
  for (const p of h) {
    const a = Math.pow(10, p.db / 20), w = (2 * Math.PI * p.f) / sr, ph = 0.7 * p.k * p.k;
    for (let i = 0; i < n; i++) x[i] += a * Math.cos(w * i + ph);
  }
  const fr = analyzeFormants(x, sr, 12);
  return fr && fr.formants.length >= 2 ? fr.formants.slice(0, 2).map((q) => q.f) : null;
}

// Everything one voice's spectrum view shows, from a stretch of audio: the
// spectrum, F0 with its note, the harmonics, the ring, and F1/F2 — by LPC
// (a voice alone) or from the harmonics' envelope (`mixed`: a voice in a band,
// marked as an estimate). Shared by the sing-along, the voice scope and the
// twang lesson. x: samples; at: the centre sample; N: window length.
export function voiceSide(x, sr, at, f0, { N = SPEC_N, mixed = false } = {}) {
  const spec = spectrumAt(x, sr, at, N);
  if (!spec) return null;
  const harm = f0 > 0 ? harmonicsOf(spec, f0, 4000) : [];
  const side = { spec, f0, harm, ring: f0 > 0 ? ringOf(harm) : NaN, name: f0 > 0 ? midiName(Math.round(69 + 12 * Math.log2(f0 / 440))) : '', est: mixed };
  if (f0 > 0) side.formants = (!mixed && formantsAt(x, sr, at + Math.round(0.02 * sr), f0)) || envelopeFormants(harm, f0);
  return side;
}
