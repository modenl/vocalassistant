// Linear-prediction formant analysis: decimate → pre-emphasis → Hamming →
// autocorrelation → Levinson-Durbin → polynomial roots (Durand-Kerner).

import { hamming } from './fft.js';

const TARGET_FS = 11025;
const lpCache = new Map();

function lowpassTaps(D, taps = 63) {
  const key = D + ':' + taps;
  if (lpCache.has(key)) return lpCache.get(key);
  const h = new Float64Array(taps);
  const fc = 0.45 / D; // cycles/sample at the original rate
  const m = (taps - 1) / 2;
  let sum = 0;
  for (let i = 0; i < taps; i++) {
    const x = i - m;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (taps - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (taps - 1));
    h[i] = sinc * w;
    sum += h[i];
  }
  for (let i = 0; i < taps; i++) h[i] /= sum;
  lpCache.set(key, h);
  return h;
}

export function levinson(r, p) {
  let a = new Float64Array(p + 1);
  a[0] = 1;
  let e = r[0];
  for (let i = 1; i <= p; i++) {
    let acc = r[i];
    for (let j = 1; j < i; j++) acc += a[j] * r[i - j];
    const k = -acc / e;
    const prev = a.slice();
    for (let j = 1; j < i; j++) a[j] = prev[j] + k * prev[i - j];
    a[i] = k;
    e *= 1 - k * k;
    if (e <= 0) break;
  }
  return { a, e: Math.max(e, 1e-20) };
}

// Roots of z^n + a1 z^(n-1) + ... + an  (a[0] must be 1).
export function polyRoots(a, maxIter = 300) {
  const n = a.length - 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ang = (2 * Math.PI * i) / n + 0.4;
    re[i] = 0.9 * Math.cos(ang);
    im[i] = 0.9 * Math.sin(ang);
  }
  for (let it = 0; it < maxIter; it++) {
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      const zr = re[i], zi = im[i];
      let pr = 1, pi = 0;
      for (let k = 1; k <= n; k++) {
        const nr = pr * zr - pi * zi + a[k];
        pi = pr * zi + pi * zr;
        pr = nr;
      }
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const wr = zr - re[j], wi = zi - im[j];
        const nr = dr * wr - di * wi;
        di = dr * wi + di * wr;
        dr = nr;
      }
      const den = dr * dr + di * di || 1e-30;
      const qr = (pr * dr + pi * di) / den;
      const qi = (pi * dr - pr * di) / den;
      re[i] -= qr; im[i] -= qi;
      const d = Math.abs(qr) + Math.abs(qi);
      if (d > maxDelta) maxDelta = d;
    }
    if (maxDelta < 1e-10) break;
  }
  const out = [];
  for (let i = 0; i < n; i++) out.push([re[i], im[i]]);
  return out;
}

// Returns { formants:[{f,b}], env:{freqs, db}, fs }
export function analyzeFormants(x, sr, order = 12, envPoints = 160) {
  const D = Math.max(1, Math.round(sr / TARGET_FS));
  const fs = sr / D;
  const h = lowpassTaps(D);
  const L = 512; // ~46 ms at 11 kHz
  const need = L * D + h.length;
  const start = Math.max(0, x.length - need);
  const y = new Float64Array(L);
  for (let m = 0; m < L; m++) {
    const base = start + m * D;
    let acc = 0;
    for (let j = 0; j < h.length; j++) {
      const idx = base + j;
      if (idx < x.length) acc += h[j] * x[idx];
    }
    y[m] = acc;
  }
  const pre = Math.exp((-2 * Math.PI * 50) / fs);
  const w = hamming(L);
  const z = new Float64Array(L);
  for (let i = L - 1; i >= 1; i--) z[i] = (y[i] - pre * y[i - 1]) * w[i];
  z[0] = 0;
  const r = new Float64Array(order + 1);
  for (let k = 0; k <= order; k++) {
    let s = 0;
    for (let i = k; i < L; i++) s += z[i] * z[i - k];
    r[k] = s;
  }
  if (r[0] < 1e-12) return null;
  r[0] *= 1 + 1e-6;
  // Gaussian lag window (60 Hz) for numerical stability
  for (let k = 1; k <= order; k++) r[k] *= Math.exp(-0.5 * Math.pow((2 * Math.PI * 60 * k) / fs, 2));
  const { a, e } = levinson(r, order);

  const roots = polyRoots(a);
  const cands = [];
  for (const [zr, zi] of roots) {
    if (zi <= 0) continue;
    const f = (Math.atan2(zi, zr) * fs) / (2 * Math.PI);
    const mag = Math.hypot(zr, zi);
    const b = (-Math.log(mag) * fs) / Math.PI;
    if (f > 90 && f < fs / 2 - 50 && b > 0 && b < 600) cands.push({ f, b });
  }
  cands.sort((p, q) => p.f - q.f);

  const formants = [];
  const ranges = [[180, 1300], [500, 3300], [1400, 4200], [2500, 5400]];
  let ci = 0;
  for (let k = 0; k < 4; k++) {
    const [lo, hi] = ranges[k];
    const prev = formants[k - 1];
    while (ci < cands.length && (cands[ci].f < lo || (prev && cands[ci].f < prev.f + 150))) ci++;
    if (ci < cands.length && cands[ci].f <= hi) { formants.push(cands[ci]); ci++; }
    else break;
  }

  // Spectral envelope 1/|A(e^jw)| on a log-frequency grid
  const freqs = new Float32Array(envPoints), db = new Float32Array(envPoints);
  const fmin = 50, fmax = fs / 2;
  const g = Math.sqrt(e);
  for (let i = 0; i < envPoints; i++) {
    const f = fmin * Math.pow(fmax / fmin, i / (envPoints - 1));
    const wv = (2 * Math.PI * f) / fs;
    let sr_ = 0, si = 0;
    for (let k = 0; k <= order; k++) { sr_ += a[k] * Math.cos(wv * k); si -= a[k] * Math.sin(wv * k); }
    freqs[i] = f;
    db[i] = 20 * Math.log10(g / Math.max(1e-12, Math.hypot(sr_, si)));
  }
  return { formants, env: { freqs, db }, fs };
}

// Iseli & Alwan (2004/2007) correction of harmonic amplitude for formant boosting.
export function formantCorrection(f, formants, sr) {
  let c = 0;
  for (let i = 0; i < Math.min(2, formants.length); i++) {
    const F = formants[i].f;
    const B = Math.max(50, Math.min(300, formants[i].b));
    const r = Math.exp((-Math.PI * B) / sr);
    const w = (2 * Math.PI * F) / sr;
    const wf = (2 * Math.PI * f) / sr;
    const num = Math.pow(1 - 2 * r * Math.cos(w) + r * r, 2);
    const den = (1 - 2 * r * Math.cos(wf + w) + r * r) * (1 - 2 * r * Math.cos(wf - w) + r * r);
    c += 10 * Math.log10(num / den);
  }
  return c;
}

// Vocal-tract length from formant spacing (uniform tube, Fitch 1997 style regression).
export function vocalTractLength(formants) {
  if (formants.length < 3) return 0;
  let num = 0, den = 0;
  formants.forEach((fm, i) => { const k = 2 * i + 1; num += fm.f * k; den += k * k; });
  const kHz = num / den; // F_i ≈ (2i-1)·c/(4L)
  const L = 35000 / (4 * kHz);
  return Math.max(9, Math.min(24, L));
}
