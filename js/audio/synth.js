// Source-filter singing synthesizer (browser + Node): Rosenberg glottal pulse
// (open quotient / speed quotient per cycle), radiated as its derivative, through
// a cascade of 2-pole formant resonators. Used for the sung reference notes
// (tone.js) and for tests.

let seed = 12345;
function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
function randn() { const u = rand() || 1e-9, v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

export const VOWELS = {
  a: [{ f: 730, b: 80 }, { f: 1150, b: 90 }, { f: 2500, b: 120 }, { f: 3300, b: 150 }, { f: 3900, b: 200 }],
  // "ah" of a female voice: formants ≈ 15 % higher (shorter vocal tract; Peterson & Barney 1952)
  aF: [{ f: 850, b: 90 }, { f: 1250, b: 100 }, { f: 2850, b: 130 }, { f: 3700, b: 160 }, { f: 4400, b: 220 }],
  e: [{ f: 480, b: 70 }, { f: 1950, b: 100 }, { f: 2600, b: 120 }, { f: 3400, b: 150 }, { f: 4000, b: 200 }],
  // nasal murmur of "n" (closed mouth): low F1, weak damped upper resonances
  n: [{ f: 260, b: 90 }, { f: 1100, b: 350 }, { f: 2300, b: 400 }, { f: 3300, b: 400 }, { f: 4000, b: 400 }],
  aRing: [{ f: 700, b: 80 }, { f: 1150, b: 90 }, { f: 2600, b: 100 }, { f: 2900, b: 100 }, { f: 3250, b: 120 }],
  i: [{ f: 300, b: 60 }, { f: 2250, b: 100 }, { f: 3000, b: 120 }, { f: 3500, b: 150 }, { f: 4200, b: 200 }],
  u: [{ f: 330, b: 60 }, { f: 850, b: 80 }, { f: 2400, b: 120 }, { f: 3300, b: 150 }, { f: 4000, b: 200 }],
};

// segments: [{dur, f0:(t)=>Hz, oq, sq, amp, noise, jitter, shimmer, vowel, attack, preNoise}]
// opts.gain: fixed output gain (keeps loudness differences between clips, soft-
// limited); default normalizes each clip to a 0.8 peak.
export function synth(segments, sr = 44100, opts = {}) {
  const total = segments.reduce((s, g) => s + g.dur, 0);
  const n = Math.ceil(total * sr);
  const src = new Float64Array(n);
  let phase = 0, idx = 0, cycF = 1, cycA = 1, prevG = 0;
  const segIndex = new Int32Array(n);
  segments.forEach((g, si) => {
    const len = Math.round(g.dur * sr);
    const oq = g.oq ?? 0.5, sq = g.sq ?? 2.5;
    const Tp = (oq * sq) / (1 + sq), Tn = oq / (1 + sq);
    const attack = g.attack ?? 0.04;
    for (let i = 0; i < len && idx < n; i++, idx++) {
      segIndex[idx] = si;
      const t = i / sr;
      if (!g.f0) { src[idx] = (g.noise ?? 0) * randn() * 0.02; prevG = 0; continue; }
      const release = g.release ?? 0.03;
      const env = Math.min(1, attack > 0 ? t / attack : 1) * (release > 0 ? Math.min(1, (g.dur - t) / release) : 1);
      const pre = g.preNoise ?? 0;
      const f = g.f0(t) * cycF;
      phase += f / sr;
      if (phase >= 1) {
        phase -= 1;
        cycF = 1 + (g.jitter ?? 0) * randn();
        cycA = 1 + (g.shimmer ?? 0) * randn();
      }
      let gl;
      if (phase < Tp) gl = 0.5 * (1 - Math.cos((Math.PI * phase) / Tp));
      else if (phase < Tp + Tn) gl = Math.cos((Math.PI * (phase - Tp)) / (2 * Tn));
      else gl = 0;
      const dg = (gl - prevG) * cycA;
      prevG = gl;
      const toneOn = t >= pre ? 1 : 0;
      const breath = (g.noise ?? 0) * randn() * 0.02 * (0.4 + gl);
      const preBreath = t < pre ? 0.012 * randn() : 0;
      src[idx] = (g.amp ?? 1) * env * (dg * toneOn + breath * toneOn) + preBreath;
    }
  });
  // formant filtering per segment (resonator state carried across)
  const out = new Float64Array(n);
  const state = Array.from({ length: 5 }, () => [0, 0]);
  const buf = new Float64Array(n);
  buf.set(src);
  for (let k = 0; k < 5; k++) {
    let [y1, y2] = state[k];
    for (let i = 0; i < n; i++) {
      const fm = (segments[segIndex[i]].vowel ?? VOWELS.a)[k];
      const r = Math.exp((-Math.PI * fm.b) / sr);
      const c = 2 * r * Math.cos((2 * Math.PI * fm.f) / sr);
      const gain = 1 - c + r * r;
      const y = gain * buf[i] + c * y1 - r * r * y2;
      y2 = y1; y1 = y;
      buf[i] = y;
    }
  }
  if (opts.gain) {
    for (let i = 0; i < n; i++) out[i] = Math.tanh(buf[i] * opts.gain);
    return out;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
  for (let i = 0; i < n; i++) out[i] = (buf[i] / peak) * 0.8;
  return out;
}

export const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
export const steady = (midi, vibRate = 0, vibCents = 0, detune = 0) => (t) =>
  hz(midi) * Math.pow(2, (detune + vibCents * Math.sin(2 * Math.PI * vibRate * t) * Math.min(1, t / 0.3)) / 1200);
