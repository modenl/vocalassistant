// Per-frame acoustic feature extraction for singing voice.
// Pure computation (no DOM) so it can run in Node tests as well.

import { getFFT, hann } from './fft.js';
import { Yin } from './yin.js';
import { analyzeFormants, formantCorrection, vocalTractLength } from './lpc.js';

// ≈46 ms at 44.1/48 kHz: two periods of the lowest sung notes (~E2), and short
// enough that vibrato up to ~9 Hz is not averaged away by the window.
// F5 only where the voice has energy: a harmonic near it within 65 dB of the
// strongest and standing out of the noise. Where the highs are that weak (e.g.
// "oo", ≈ 80 dB down) LPC puts a stray pole up there; a real F5 of an open or
// front vowel sits ≈ 50–58 dB down, twang's ≈ 30.
// (Looked up in the spectrum itself: the harmonic list stops at the 40th, below
// F5 for a low voice.)
function dropUnheardF5(formants, an, hs, f0) {
  const F5 = formants?.[4]?.f;
  if (!F5 || !hs?.length) return;
  const { specDb, binHz } = an, top = Math.max(...hs.map((h) => h.db));
  const w = Math.max(f0, 0.08 * F5), lo = Math.max(1, Math.floor((F5 - w) / binHz)), hi = Math.min(specDb.length - 1, Math.ceil((F5 + w) / binHz));
  let b = lo;
  for (let i = lo; i <= hi; i++) if (specDb[i] > specDb[b]) b = i;
  const half = Math.max(2, Math.round((0.5 * f0) / binHz));
  let valley = Infinity;
  for (let i = Math.max(0, b - half); i <= Math.min(specDb.length - 1, b + half); i++) valley = Math.min(valley, specDb[i]);
  if (!(specDb[b] >= top - 65 && specDb[b] - valley >= 6)) formants.length = 4;
}

export function frameSizeFor(sr) {
  return sr > 70000 ? 4096 : 2048;
}

export class FrameAnalyzer {
  constructor(sr) {
    this.sr = sr;
    this.N = frameSizeFor(sr);
    this.specN = this.N * 2;
    this.binHz = sr / this.specN;
    this.yin = new Yin(sr, this.N);
    this.win = hann(this.N);
    this.winSum = this.win.reduce((s, v) => s + v, 0);
    this.fftSpec = getFFT(this.specN);
    this.re = new Float64Array(this.specN);
    this.im = new Float64Array(this.specN);
    this.specDb = new Float32Array(this.specN / 2);
    this.specPow = new Float64Array(this.specN / 2);
    this.fftCep = getFFT(this.N);
    this.cre = new Float64Array(this.N);
    this.cim = new Float64Array(this.N);
    this.frameNo = 0;
    this.lastJS = null;
  }

  bin(f) { return Math.max(0, Math.min(this.specN / 2 - 1, Math.round(f / this.binHz))); }

  computeSpectrum(x) {
    const { N, re, im, win, specDb, specPow } = this;
    const off = x.length - N;
    re.fill(0); im.fill(0);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * win[i];
    this.fftSpec.transform(re, im);
    const norm = 2 / this.winSum;
    for (let k = 0; k < specDb.length; k++) {
      const m = Math.hypot(re[k], im[k]) * norm;
      specPow[k] = m * m;
      specDb[k] = 20 * Math.log10(m + 1e-10);
    }
  }

  bandPower(f1, f2) {
    let s = 0;
    for (let k = this.bin(f1), e = this.bin(f2); k <= e; k++) s += this.specPow[k];
    return s;
  }

  // A voice's harmonic series at `f` (or the octave above / below — the
  // estimator's usual slips): of harmonics 1–10 below 4.5 kHz, ≥ 3 stand ≥ 10 dB
  // above the noise floor (spectrum median, 80–5000 Hz), two of them adjacent.
  // Returns the f0 that fits, or 0.
  harmonicF0(f) {
    if (!(f > 0)) return 0;
    const sp = this.specDb, b = this.binHz;
    const vals = Array.from(sp.subarray(this.bin(80), this.bin(5000)));
    vals.sort((p, q) => p - q);
    const floor = vals[vals.length >> 1];
    for (const g of [f, 2 * f, f / 2]) {
      if (g < 70 || g > 1100) continue;
      let n = 0, run = 0, best = 0;
      for (let h = 1; h <= 10 && h * g < 4500; h++) {
        const c = Math.round((h * g) / b), w = Math.max(1, Math.round((0.03 * h * g) / b));
        let pk = -Infinity;
        for (let k = c - w; k <= c + w; k++) if (sp[k] > pk) pk = sp[k];
        if (pk - floor >= 10) { n++; best = Math.max(best, ++run); } else run = 0;
      }
      if (n >= 3 && best >= 2) return g;
    }
    return 0;
  }

  // The voice's own level, room noise left out: the power at the harmonics of
  // f0 (below 5 kHz, ±2 bins around each peak) minus the noise measured between
  // the harmonics in this frame (median power of those bins). Noise between the
  // harmonics never counts, and what it adds under them is subtracted. In dB
  // (relative: compare it with itself, not with `db`).
  voiceDb(f0) {
    const P = this.specPow, b = this.binHz, top = Math.min(this.bin(5000), P.length - 3);
    const isH = new Uint8Array(top + 3), rad = Math.max(2, Math.round((0.25 * f0) / b));
    for (let k = 1; k * f0 < 5000; k++) {
      const c = Math.round((k * f0) / b);
      for (let i = Math.max(1, c - rad); i <= Math.min(top, c + rad); i++) isH[i] = 1;
    }
    const between = [];
    for (let i = this.bin(80); i <= top; i++) if (!isH[i]) between.push(P[i]);
    between.sort((x, y) => x - y);
    const noise = between.length ? between[between.length >> 1] : 0;
    let v = 0, h = 0, nb = 0, vLo = 0, vHi = 0;
    for (let k = 1; k * f0 < 5000; k++) {
      const c = Math.round((k * f0) / b);
      let m = c;
      for (let i = Math.max(1, c - rad); i <= Math.min(top, c + rad); i++) if (P[i] > P[m]) m = i;
      for (let i = Math.max(1, m - 2); i <= Math.min(top, m + 2); i++) { v += Math.max(0, P[i] - noise); h += P[i]; }
      // the band ratio below counts only a local peak right at k·f0, so a
      // narrow-band sound between the harmonics (a whine, a beep) is left out
      const x = (k * f0) / b, w = 1 + Math.floor((k * f0 * 0.004) / b);
      let q = Math.max(1, Math.round(x) - w);
      for (let i = q; i <= Math.min(top, Math.round(x) + w); i++) if (P[i] > P[q]) q = i;
      if (Math.abs(q - x) <= w && P[q] >= P[q - 1] && P[q] >= P[q + 1]) {
        let e = 0;
        for (let i = Math.max(1, q - 2); i <= Math.min(top, q + 2); i++) e += Math.max(0, P[i] - noise);
        if (k * f0 < 2000) vLo += e; else if (k * f0 <= 4000) vHi += e;
      }
    }
    // harmonic band ratio: all the voice's harmonic power in 0–2 kHz over that in
    // 2–4 kHz (dB), room noise taken off. Like the singing power ratio, but summed
    // over the band instead of its strongest harmonic: when only the pitch moves,
    // single harmonics slide on and off the formant peaks (±6 dB a semitone) while
    // a band's total barely changes — so a voice can be compared across notes.
    this.lastHbr = vLo > 0 && vHi > 0 ? 10 * Math.log10(vLo / vHi) : NaN;
    for (const q of between) nb += q;
    // harmonics vs what lies between them (breath noise, roughness, room noise):
    // compare it only within one recording (same room), not across takes
    this.lastHnr = 10 * Math.log10((h + 1e-20) / (nb + 1e-20));
    return 10 * Math.log10(v + 1e-20);
  }

  // Spectral shape of a voiced frame: level of five bands relative to their
  // sum (dB) — 80–500, 500–1000, 1000–2000, 2000–4000, 4000–6000 Hz.
  bandShape() {
    const P = this.specPow, edges = [80, 500, 1000, 2000, 4000, 6000], e = [];
    let tot = 0;
    for (let j = 0; j < 5; j++) {
      let s = 0;
      for (let i = this.bin(edges[j]); i < this.bin(edges[j + 1]); i++) s += P[i];
      e.push(s); tot += s;
    }
    return e.map((x) => 10 * Math.log10((x + 1e-20) / (tot + 1e-20)));
  }

  bandMedianDb(f1, f2) {
    const v = Array.from(this.specDb.subarray(this.bin(f1), this.bin(f2) + 1)).sort((a, b) => a - b);
    return v[v.length >> 1];
  }

  bandMaxDb(f1, f2) {
    let m = -Infinity;
    for (let k = this.bin(f1), e = this.bin(f2); k <= e; k++) if (this.specDb[k] > m) m = this.specDb[k];
    return m;
  }

  // Strongest harmonic of f0 between f1 and f2 (dB), or NaN. Only a local peak
  // at k·f0 counts, so a narrow-band sound that isn't the voice (a hum, a whine,
  // a beep between the harmonics) can't pass for the voice's ring.
  harmonicMaxDb(f0, f1, f2) {
    const { specDb, binHz } = this, top = specDb.length - 2;
    let m = -Infinity;
    for (let k = Math.max(1, Math.ceil(f1 / f0)); k * f0 <= f2; k++) {
      const c = (k * f0) / binHz, w = 1 + Math.floor((k * f0 * 0.004) / binHz);
      const lo = Math.max(1, Math.round(c) - w), hi = Math.min(top, Math.round(c) + w);
      let b = lo;
      for (let i = lo; i <= hi; i++) if (specDb[i] > specDb[b]) b = i;
      if (specDb[b] >= specDb[b - 1] && specDb[b] >= specDb[b + 1] && Math.abs(b - c) <= w && specDb[b] > m) m = specDb[b];
    }
    return Number.isFinite(m) ? m : NaN;
  }

  analyze(x, opts = {}) {
    const gateDb = opts.gateDb ?? -55;
    const sr = this.sr, N = this.N;
    const off = x.length - N;
    let s = 0;
    for (let i = 0; i < N; i++) s += x[off + i] * x[off + i];
    const rms = Math.sqrt(s / N);
    const db = 20 * Math.log10(rms + 1e-12);
    this.frameNo++;
    this.computeSpectrum(x);

    const out = {
      rms, db, voiced: false, f0: 0, clarity: 0, hiMed: NaN, hiPk: NaN, vdb: NaN, hnrLite: NaN, hbr: NaN, bands: null, irregular: false, transient: false, polyphonic: false,
      spec: this.specDb, binHz: this.binHz,
      harmonics: [], h1h2: NaN, h1h2c: NaN, hslope: NaN, h2h4: NaN, oq: NaN,
      alpha: NaN, spr: NaN, centroid: NaN, richness: NaN, strongHarm: 0,
      hnr: NaN, cpp: NaN, jitter: NaN, shimmer: NaN,
      formants: [], env: null, formantReliable: false, vtl: 0, nasal: NaN, nasalRaw: NaN,
    };
    // the 2–4 kHz band (singer's formant): its median level, over the take a
    // measure of the room noise there (resonance is judged only well above it)
    out.hiMed = this.bandMedianDb(2000, 4000);
    if (db < gateDb) return out;

    // Frames straddling a note onset/offset (one half much quieter than the
    // other) give unreliable pitch — treat them as transient, not voiced.
    let eA = 0, eB = 0;
    for (let i = 0; i < N / 2; i++) eA += x[off + i] * x[off + i];
    for (let i = N / 2; i < N; i++) eB += x[off + i] * x[off + i];
    const bal = 10 * Math.log10((eB + 1e-12) / (eA + 1e-12));
    if (Math.abs(bal) > 10) { out.transient = true; return out; }

    const p = this.yin.detect(x, 40, 2300, 0.15);
    out.f0 = p.f0; out.clarity = p.clarity;
    if (p.clarity > 0.72 && p.f0 > 40) out.voiced = true;
    else if (p.f0 > 20 && p.f0 < 110 && p.clarity > 0.4) { out.voiced = true; out.irregular = true; }
    else {
      // Waveform periodicity suffers from room noise, reverb and breathy tone,
      // but a sung vowel still shows a series of harmonic peaks well above the
      // noise floor. Such a frame is "weak": the pitch tracker keeps it only as
      // part of a continuing note (see pitch.js). The estimator's sub-octave
      // picks are corrected here: a series needs neighbouring harmonics.
      const f = this.harmonicF0(p.f0);
      if (f) { out.voiced = true; out.weak = true; out.f0 = f; }
    }
    if (!out.voiced) return out;
    const f0 = out.f0;

    // Spectral balance measures
    const pLow = this.bandPower(50, 1000), pHigh = this.bandPower(1000, 5000);
    out.alpha = 10 * Math.log10((pHigh + 1e-20) / (pLow + 1e-20));
    out.vdb = this.voiceDb(f0);
    out.hnrLite = this.lastHnr;
    out.hbr = this.lastHbr;
    out.bands = this.bandShape();
    // singing power ratio (Omori et al. 1996), from the voice's harmonics only
    out.hiPk = this.harmonicMaxDb(f0, 2000, 4000);
    out.spr = this.harmonicMaxDb(f0, 50, 2000) - out.hiPk;
    let num = 0, den = 0;
    for (let k = this.bin(50), e = this.bin(8000); k <= e; k++) { num += k * this.binHz * this.specPow[k]; den += this.specPow[k]; }
    out.centroid = den > 0 ? num / den : NaN;

    // Harmonic amplitudes
    const hs = this.harmonics(f0);
    out.harmonics = hs;

    // Accompaniment / chord guard. A single voice has a smooth harmonic
    // envelope (source slope × formants). A chord (e.g. a piano cue) analysed
    // at its common sub-period leaves isolated harmonics 20+ dB below both
    // neighbours, and usually a missing "fundamental".
    if (hs.length >= 4) {
      const hmax = Math.max(...hs.slice(0, 12).map((h) => h.db));
      let notches = 0;
      for (let i = 1; i < Math.min(12, hs.length - 1); i++) {
        if (hs[i].db < hs[i - 1].db - 20 && hs[i].db < hs[i + 1].db - 20) notches++;
      }
      const lowWeak = Math.max(hs[0].db, hs[1].db) < hmax - 22;
      if (notches >= 3 || (f0 < 120 && (notches >= 2 || lowWeak))) {
        out.voiced = false;
        out.polyphonic = true;
        return out;
      }
    }
    // pitch-only mode: voicing, f0 and level are all the app needs
    // pitch-only mode can still ask for the formants (the twang lesson's vowel check)
    if (opts.pitchOnly && opts.formants) {
      const fr = analyzeFormants(x, sr, 12, 160, { f5: true });
      if (fr) { dropUnheardF5(fr.formants, this, hs, f0); out.formants = fr.formants; out.formantReliable = f0 < 350 && fr.formants.length >= 3; }
    }
    if (opts.pitchOnly) return out;
    if (hs.length >= 2) {
      const hmax = Math.max(...hs.map((h) => h.db));
      const in5k = hs.filter((h) => h.f <= 5000);
      const rich = in5k.filter((h) => h.db > hmax - 40 && h.prom > 6).length;
      out.richness = in5k.length ? rich / in5k.length : 0;
      out.strongHarm = hs.filter((h) => h.db > hmax - 30 && h.prom > 6).length;
      out.h1h2 = hs[0].db - hs[1].db;
      if (hs.length >= 4) out.h2h4 = hs[1].db - hs[3].db;
      out.hslope = harmonicSlope(hs, f0);
    }

    // Formants (LPC) — only trustworthy for moderate f0
    const fr = analyzeFormants(x, sr, 12, 160, { f5: !!opts.f5 });
    if (fr) {
      if (opts.f5) dropUnheardF5(fr.formants, this, hs, f0);
      out.formants = fr.formants;
      out.env = fr.env;
      out.formantReliable = f0 < 350 && fr.formants.length >= 3;
      if (out.formantReliable) out.vtl = vocalTractLength(fr.formants.slice(0, 4));
    }
    out.h1h2c = out.h1h2;
    out.h1h2Corrected = false;
    // Correct up to 500 Hz as long as F1 is not sitting on a harmonic (LPC tends
    // to lock onto harmonics at high f0, which would make the correction bogus).
    const f1 = fr?.formants[0]?.f;
    const f1Free = f1 && Math.abs(f1 / f0 - Math.round(f1 / f0)) > 0.12;
    if (hs.length >= 2 && fr && fr.formants.length >= 2 && (out.formantReliable || (f0 < 500 && f1Free))) {
      out.h1h2Corrected = true;
      const c1 = formantCorrection(hs[0].f, fr.formants, sr);
      const c2 = formantCorrection(hs[1].f, fr.formants, sr);
      out.h1h2c = (hs[0].db - c1) - (hs[1].db - c2);
    }
    // Nasality proxy A1−P0 (Chen 1997): A1 = level of the harmonic at F1,
    // P0 = level of the harmonic nearest 250 Hz (low nasal pole). Velopharyngeal
    // opening raises P0 and damps A1, so A1−P0 falls. Only meaningful for
    // open vowels (F1 well above 250 Hz) at moderate f0.
    // At higher f0 the "harmonic near 250 Hz" is H1 itself, whose level is
    // dominated by the voice source (a thin/M2 voice has a strong H1), so the
    // measure is restricted to f0 ≤ 200 Hz and compensated for source tilt.
    out.nasal = NaN; out.nasalRaw = NaN;
    if (out.formantReliable && f0 <= 200 && fr.formants[0].f > 450 && hs.length > 6) {
      const F1 = fr.formants[0].f;
      let a1 = null;
      for (const h of hs) if (Math.abs(h.f - F1) <= f0 * 0.75 && (!a1 || h.db > a1.db)) a1 = h;
      const p0 = hs[Math.max(1, Math.round(250 / f0) - 1)];
      if (a1 && p0 && p0.f < 420 && a1.k > p0.k) {
        out.nasalRaw = a1.db - p0.db;
        const tilt = Number.isFinite(out.hslope) ? out.hslope * Math.log2(a1.k / p0.k) : 0;
        out.nasal = out.nasalRaw - tilt;
      }
    }
    // Open-quotient estimate from H1-H2 via the LF-model relation
    // H1-H2 ≈ -6 + 0.27·e^(5.5·OQ)  (Fant 1995; used in Henrich et al. 2001)
    if (Number.isFinite(out.h1h2c)) {
      const v = Math.max(-5.7, Math.min(28, out.h1h2c));
      out.oq = Math.max(0.3, Math.min(0.95, Math.log((v + 6) / 0.27) / 5.5));
    }

    out.hnr = this.hnr(x, f0);
    out.cpp = this.cpp(x, f0);
    if (this.frameNo % 2 === 0 || !this.lastJS) this.lastJS = jitterShimmer(x.subarray ? x.subarray(off) : x.slice(off), sr, f0);
    if (this.lastJS) { out.jitter = this.lastJS.jitter; out.shimmer = this.lastJS.shimmer; }
    return out;
  }

  harmonics(f0) {
    const { specDb, binHz } = this;
    const hs = [];
    const maxF = Math.min(8000, this.sr / 2 - 200);
    const maxK = Math.min(40, Math.floor(maxF / f0));
    const rad = Math.max(2, (0.12 * f0) / binHz);
    const half = Math.max(2, (0.5 * f0) / binHz);
    for (let k = 1; k <= maxK; k++) {
      const bc = (k * f0) / binHz;
      const lo = Math.max(1, Math.floor(bc - rad)), hi = Math.min(specDb.length - 2, Math.ceil(bc + rad));
      let m = lo;
      for (let i = lo; i <= hi; i++) if (specDb[i] > specDb[m]) m = i;
      const a = specDb[m - 1], b = specDb[m], c = specDb[m + 1];
      const d = a - 2 * b + c;
      const pp = Math.abs(d) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      const peak = b - 0.25 * (a - c) * pp;
      let valley = Infinity;
      const vlo = Math.max(0, Math.floor(bc - half)), vhi = Math.min(specDb.length - 1, Math.ceil(bc + half));
      for (let i = vlo; i <= vhi; i++) if (specDb[i] < valley) valley = specDb[i];
      hs.push({ k, f: (m + pp) * binHz, db: peak, prom: peak - valley });
    }
    return hs;
  }

  // Boersma-style HNR from the normalized autocorrelation at the period lag,
  // over a short window (≥3 periods, ≥30 ms) at the end of the frame so that
  // vibrato / legato pitch movement is not mistaken for noise.
  hnr(x, f0) {
    const sr = this.sr, end = x.length;
    const T = sr / f0;
    const W = Math.min(this.N / 2, Math.max(Math.round(3 * T), Math.round(0.03 * sr)));
    const lo = Math.max(2, Math.floor(T * 0.94)), hi = Math.ceil(T * 1.06);
    if (end - W - hi < 0) return NaN;
    let best = 0;
    for (let lag = lo; lag <= hi; lag++) {
      let c = 0, e1 = 0, e2 = 0;
      for (let i = end - W; i < end; i++) {
        const a = x[i], b = x[i - lag];
        c += a * b; e1 += a * a; e2 += b * b;
      }
      const r = c / Math.sqrt(e1 * e2 + 1e-20);
      if (r > best) best = r;
    }
    const r = Math.max(1e-6, Math.min(0.99999, best));
    return Math.min(40, 10 * Math.log10(r / (1 - r)));
  }

  // Cepstral peak prominence (Hillenbrand et al. 1994).
  cpp(x, f0) {
    const { N, cre, cim, win, sr } = this;
    const off = x.length - N;
    for (let i = 0; i < N; i++) { cre[i] = x[off + i] * win[i]; cim[i] = 0; }
    this.fftCep.transform(cre, cim);
    for (let i = 0; i < N; i++) {
      cre[i] = 10 * Math.log10(cre[i] * cre[i] + cim[i] * cim[i] + 1e-20);
      cim[i] = 0;
    }
    this.fftCep.transform(cre, cim);
    const qStart = Math.ceil(0.001 * sr);
    const qEnd = Math.min(N / 2 - 1, Math.floor(sr / 55));
    const cep = (q) => 10 * Math.log10(cre[q] * cre[q] + cim[q] * cim[q] + 1e-20);
    // regression line
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
    for (let q = qStart; q <= qEnd; q++) {
      const y = cep(q);
      sx += q; sy += y; sxx += q * q; sxy += q * y; n++;
    }
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const icpt = (sy - slope * sx) / n;
    const qLo = Math.max(qStart, Math.floor(sr / Math.min(1100, f0 * 1.25)));
    const qHi = Math.min(qEnd, Math.ceil(sr / Math.max(50, f0 * 0.8)));
    let pk = -Infinity, pq = qLo;
    for (let q = qLo; q <= qHi; q++) { const y = cep(q); if (y > pk) { pk = y; pq = q; } }
    return pk - (slope * pq + icpt);
  }
}

// Source spectral slope: regression of harmonic level (dB) on log2(harmonic
// number) up to 5 kHz, in dB/octave. Averaging across many harmonics makes it
// less sensitive to a single formant than H1–H2 (useful at high f0).
export function harmonicSlope(hs, f0) {
  const maxK = Math.max(3, Math.min(16, Math.floor(5000 / f0)));
  let sx = 0, sy = 0, sxx = 0, sxy = 0, n = 0;
  for (const h of hs) {
    if (h.k > maxK) break;
    if (h.prom < 3 && h.k > 1) continue;
    const x = Math.log2(h.k);
    sx += x; sy += h.db; sxx += x * x; sxy += x * h.db; n++;
  }
  if (n < 3) return NaN;
  return (n * sxy - sx * sy) / (n * sxx - sx * sx);
}

// Cycle-to-cycle perturbation by waveform matching (period marks via normalized
// cross-correlation of consecutive cycles). Returns percentages (local jitter/shimmer).
export function jitterShimmer(x, sr, f0) {
  const T = sr / f0;
  const Ti = Math.round(T);
  const N = x.length;
  if (N < 5 * T || Ti < 8) return null;
  let p = 0;
  for (let i = 1; i < Ti; i++) if (x[i] > x[p]) p = i;
  const marks = [p];
  let cur = p;
  const maxCycles = 40;
  while (marks.length < maxCycles) {
    const lo = Math.floor(cur + 0.85 * T), hi = Math.ceil(cur + 1.15 * T);
    if (hi + Ti >= N) break;
    let e0 = 0;
    for (let j = 0; j < Ti; j++) e0 += x[cur + j] * x[cur + j];
    let best = -Infinity, bi = lo;
    const cc = new Float64Array(hi - lo + 1);
    for (let s = lo; s <= hi; s++) {
      let c = 0, e = 0;
      for (let j = 0; j < Ti; j++) { const v = x[s + j]; c += x[cur + j] * v; e += v * v; }
      const r = c / Math.sqrt(e0 * e + 1e-20);
      cc[s - lo] = r;
      if (r > best) { best = r; bi = s; }
    }
    if (best < 0.5) break;
    let frac = 0;
    const k = bi - lo;
    if (k > 0 && k < cc.length - 1) {
      const d = cc[k - 1] - 2 * cc[k] + cc[k + 1];
      if (Math.abs(d) > 1e-12) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (cc[k - 1] - cc[k + 1])) / d));
    }
    marks.push(bi + frac);
    cur = bi;
  }
  if (marks.length < 5) return null;
  const P = [], A = [];
  for (let i = 0; i < marks.length - 1; i++) {
    P.push(marks[i + 1] - marks[i]);
    const a = Math.round(marks[i]), b = Math.round(marks[i + 1]);
    let mx = -Infinity, mn = Infinity;
    for (let j = a; j < b; j++) { if (x[j] > mx) mx = x[j]; if (x[j] < mn) mn = x[j]; }
    A.push(mx - mn);
  }
  let dj = 0, ds = 0;
  for (let i = 0; i < P.length - 1; i++) { dj += Math.abs(P[i] - P[i + 1]); ds += Math.abs(A[i] - A[i + 1]); }
  const mp = P.reduce((s, v) => s + v, 0) / P.length;
  const ma = A.reduce((s, v) => s + v, 0) / A.length;
  return {
    jitter: (dj / (P.length - 1) / mp) * 100,
    shimmer: (ds / (A.length - 1) / (ma + 1e-12)) * 100,
    cycles: P.length,
  };
}
