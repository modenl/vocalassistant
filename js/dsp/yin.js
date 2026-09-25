// YIN fundamental-frequency estimator (de Cheveigné & Kawahara, JASA 2002),
// with the difference function computed through an FFT cross-correlation.

import { getFFT } from './fft.js';

export class Yin {
  constructor(sr, n) {
    this.sr = sr;
    this.n = n;
    this.W = n >> 1;
    this.fft = getFFT(n);
    this.ar = new Float64Array(n); this.ai = new Float64Array(n);
    this.br = new Float64Array(n); this.bi = new Float64Array(n);
    this.cs = new Float64Array(n + 1);
    this.dp = new Float64Array(this.W);
  }

  // Uses the last `n` samples of x. Returns { f0, clarity } where clarity = 1 - d'(τ).
  detect(x, minF = 40, maxF = 2200, threshold = 0.12) {
    const { n, W, sr, ar, ai, br, bi, cs, dp } = this;
    const off = x.length - n;
    cs[0] = 0;
    for (let i = 0; i < n; i++) {
      const v = x[off + i];
      br[i] = v; bi[i] = 0;
      ar[i] = i < W ? v : 0; ai[i] = 0;
      cs[i + 1] = cs[i] + v * v;
    }
    if (cs[n] < 1e-10) return { f0: 0, clarity: 0 };
    this.fft.transform(ar, ai);
    this.fft.transform(br, bi);
    for (let i = 0; i < n; i++) {
      const r = ar[i] * br[i] + ai[i] * bi[i];
      const im = ar[i] * bi[i] - ai[i] * br[i];
      ar[i] = r; ai[i] = im;
    }
    this.fft.transform(ar, ai, true);

    const e1 = cs[W];
    const tauMin = Math.max(2, Math.floor(sr / maxF));
    const tauMax = Math.min(W - 1, Math.ceil(sr / minF));
    dp[0] = 1;
    let run = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      const r = ar[tau] / n;
      const e2 = cs[tau + W] - cs[tau];
      const d = Math.max(0, e1 + e2 - 2 * r);
      run += d;
      dp[tau] = run > 0 ? (d * tau) / run : 1;
    }

    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (dp[t] < threshold) {
        while (t + 1 <= tauMax && dp[t + 1] < dp[t]) t++;
        tau = t;
        break;
      }
    }
    if (tau < 0) {
      // No dip under threshold: take the shortest-lag local minimum that is
      // close to the global minimum (avoids sub-harmonic picks in rough voices).
      let best = Infinity;
      for (let t = tauMin; t <= tauMax; t++) if (dp[t] < best) best = dp[t];
      for (let t = tauMin + 1; t < tauMax; t++) {
        if (dp[t] <= dp[t - 1] && dp[t] <= dp[t + 1] && dp[t] < best + 0.08 && dp[t] < 0.3) { tau = t; break; }
      }
      if (tau < 0) for (let t = tauMin; t <= tauMax; t++) if (dp[t] === best) { tau = t; break; }
    }
    // Octave check: prefer a shorter period that is almost as good (guards
    // against sub-harmonic picks when two notes overlap in the window).
    for (let k = 4; k >= 2; k--) {
      const tk = Math.round(tau / k);
      if (tk < tauMin) continue;
      let bk = tk;
      for (let d = -2; d <= 2; d++) if (tk + d >= tauMin && dp[tk + d] < dp[bk]) bk = tk + d;
      if (dp[bk] < 0.2 && dp[bk] <= dp[tau] + 0.1) {
        // halving the period is only right if the lower pitch's odd harmonics are
        // really absent; a chest voice with a weak H1 and strong H2 (e.g. "ei"
        // with F1 near 2·f0) still has H3/H5 there
        if (k === 2 && this.oddHarmonicsReal(x, off, sr / tau)) break;
        tau = bk; break;
      }
    }
    // The first dip can be half the true period when H1 is weak and H2 strong
    // (chest voice on "ei", F1 near 2·f0). Go down an octave when the doubled
    // period is as periodic and the lower pitch's odd harmonics are clearly
    // there (true pitch: ≥ −15 dB; a wrong octave-down: ≤ −33 dB, measured).
    const t2 = tau * 2;
    if (t2 + 2 <= tauMax) {
      let b2 = t2;
      for (let d = -2; d <= 2; d++) if (dp[t2 + d] < dp[b2]) b2 = t2 + d;
      if (dp[b2] < 0.15 && dp[b2] <= dp[tau] + 0.05 && this.oddHarmonicsReal(x, off, sr / b2)) tau = b2;
    }
    let refined = tau;
    if (tau > tauMin && tau < tauMax) {
      const a = dp[tau - 1], b = dp[tau], c = dp[tau + 1];
      const den = a - 2 * b + c;
      if (Math.abs(den) > 1e-12) refined = tau + Math.max(-1, Math.min(1, (0.5 * (a - c)) / den));
    }
    return { f0: sr / refined, clarity: Math.max(0, Math.min(1, 1 - dp[tau])) };
  }

  // Does a pitch f have its own odd harmonics (1, 3, 5)? A signal at 2f cannot.
  // They must be within 22 dB of the even ones and clearly above the noise
  // between harmonics (breath noise alone must not count). Goertzel energies.
  oddHarmonicsReal(x, off, f) {
    const { n, sr } = this;
    const energy = (fr) => {
      const w = (2 * Math.PI * fr) / sr, c = 2 * Math.cos(w);
      let s1 = 0, s2 = 0;
      for (let i = 0; i < n; i++) {
        const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
        const s0 = x[off + i] * hann + c * s1 - s2;
        s2 = s1; s1 = s0;
      }
      return s1 * s1 + s2 * s2 - c * s1 * s2;
    };
    let odd = 0, even = 0, noise = 0, nOdd = 0, nNoise = 0;
    for (let h = 1; h <= 6 && (h + 0.75) * f < sr / 2; h++) {
      if (h % 2) { odd += energy(h * f); nOdd++; } else even += energy(h * f);
      noise += energy((h + 0.25) * f) + energy((h + 0.75) * f); nNoise += 2;
    }
    const db = (a, b) => 10 * Math.log10((a + 1e-12) / (b + 1e-12));
    return db(odd, even) > -22 && db(odd / nOdd, noise / nNoise) > 10;
  }
}
