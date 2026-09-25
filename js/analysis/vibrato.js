// Vibrato analysis from the pitch contour (rate, extent, regularity).
// Reference ranges: Sundberg (1987), Prame (1994): classical rate ≈ 5.5–7.5 Hz,
// extent ≈ ±50–100 cents; pop/musical-theatre usually narrower.

const FS = 100; // resample rate of the contour

export class VibratoAnalyzer {
  constructor() { this.pts = []; this.last = null; }

  reset() { this.pts = []; this.last = null; }

  push(t, cents) {
    const p = this.pts;
    // A gap, or a move of > 1.5 semitones within ~70 ms (new note, scoop,
    // portamento), starts a fresh analysis window.
    const back = p[Math.max(0, p.length - 3)];
    if (p.length && (t - p[p.length - 1].t > 0.09 || Math.abs(cents - back.c) > 150)) p.length = 0;
    p.push({ t, c: cents });
    while (p.length && t - p[0].t > 1.6) p.shift();
  }

  // Spectral analysis of the pitch contour: vibrato lives at 3.5–9 Hz; slow
  // (< 3 Hz) movement is phrasing/intonation and is deliberately ignored.
  analyze() {
    const p = this.pts;
    if (p.length < 20) return (this.last = null);
    const t0 = p[0].t, dur = p[p.length - 1].t - t0;
    if (dur < 1.0) return (this.last = null);
    const n = Math.floor(dur * FS);
    const y = new Float64Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = t0 + i / FS;
      while (j < p.length - 2 && p[j + 1].t < t) j++;
      const a = p[j], b = p[j + 1];
      const u = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
      y[i] = a.c + (b.c - a.c) * Math.max(0, Math.min(1, u));
    }
    const mean = y.reduce((q, v) => q + v, 0) / n;
    detrendQuadratic(y);
    // Hann-windowed DFT, amplitude-normalised so a sinusoid of amplitude A reads A.
    let wsum = 0;
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) { w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); wsum += w[i]; }
    const step = 0.2, spec = [];
    for (let f = 1; f <= 14.001; f += step) {
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const ph = (2 * Math.PI * f * i) / FS; re += w[i] * y[i] * Math.cos(ph); im -= w[i] * y[i] * Math.sin(ph); }
      spec.push({ f, a: (2 * Math.hypot(re, im)) / wsum });
    }
    const band = spec.filter((q) => q.f >= 3.5 && q.f <= 12);
    let pk = null;
    for (let i = 1; i < spec.length - 1; i++) {
      const q = spec[i];
      if (q.f < 3.5 || q.f > 9) continue;
      if (q.a >= spec[i - 1].a && q.a >= spec[i + 1].a && (!pk || q.a > pk.a)) pk = { ...q, i };
    }
    // Hann main lobe spreads a pure tone over ≈ ±2/dur Hz; energy share within it = regularity
    const bandPow = band.reduce((q, b) => q + b.a * b.a, 0) || 1e-9;
    let rate = 0, extent = 0, regularity = 0;
    if (pk) {
      const a = spec[pk.i - 1].a, b = pk.a, c = spec[pk.i + 1].a;
      const d = a - 2 * b + c;
      rate = pk.f + (Math.abs(d) > 1e-9 ? (0.5 * (a - c)) / d : 0) * step;
      extent = pk.a;
      const lobe = 2 / dur + step;
      const lobePow = band.filter((q) => Math.abs(q.f - pk.f) <= lobe).reduce((q, b) => q + b.a * b.a, 0);
      regularity = Math.min(1, lobePow / bandPow);
    }
    // overall fluctuation amplitude in the band (sinusoid-equivalent)
    const lobeBins = Math.max(1, (2 * (2 / dur)) / step);
    const bandAmp = Math.sqrt(bandPow / lobeBins * 1.5);
    const sd = Math.sqrt(y.reduce((q, v) => q + v * v, 0) / n);

    // Thresholds (Sundberg 1987; Prame 1994): healthy ≈ 4.5–8 Hz, ±30–150 cents;
    // bleat / tremolo > 8 Hz; wobble = slow AND wide; < 20 cents of movement
    // is ordinary micro-fluctuation of a straight tone.
    let type;
    if (Math.max(extent, bandAmp) < 20) type = 'straight';
    else if (regularity < 0.45) type = bandAmp > 25 ? 'irregular' : 'straight';
    else if (rate < 4.2 && extent > 50) type = 'wobble';
    else if (rate > 8.0) type = 'tremolo';
    else if (extent > 150) type = 'wide';
    else type = 'healthy';
    return (this.last = { rate, extent, regularity, bandAmp, sd, mean, type, dur });
  }
}

function detrendQuadratic(y) {
  const n = y.length;
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (let i = 0; i < n; i++) {
    const x = i / n, x2 = x * x;
    s1 += x; s2 += x2; s3 += x2 * x; s4 += x2 * x2;
    t0 += y[i]; t1 += x * y[i]; t2 += x2 * y[i];
  }
  const [a, b, c] = solve3([[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]], [t0, t1, t2]);
  for (let i = 0; i < n; i++) { const x = i / n; y[i] -= a + b * x + c * x * x; }
}

function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let p = c;
    for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    const d = m[c][c] || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === c) continue;
      const f = m[r][c] / d;
      for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k];
    }
  }
  return [m[0][3] / (m[0][0] || 1e-12), m[1][3] / (m[1][1] || 1e-12), m[2][3] / (m[2][2] || 1e-12)];
}
