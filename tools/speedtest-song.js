// The synthetic song of tools/speedtest.js (a sung melody under bass, chords
// and a hi-hat), on its own: for sep-test.html.
import { synth, VOWELS } from '../js/audio/synth.js';

const SR = 44100, D = 0.75, START = 2, hz = (m) => 440 * 2 ** ((m - 69) / 12);
const MEL = [52, 55, 57, 55, 52, 50, 48, 50, 52, 52, 55, 60, 59, 57, 55, 52, 57, 59, 60, 62, 64, 62, 60, 57];

// voice 3 dB under a band of bass, chords and hi-hat
export function song() {
  const segs = [{ dur: START }];
  MEL.forEach((m, i) => { segs.push({ dur: D - 0.08, f0: (t) => hz(m) * (1 + 0.006 * Math.sin(2 * Math.PI * 5.5 * t)), vowel: [VOWELS.a, VOWELS.e, VOWELS.i, VOWELS.u][i % 4], oq: 0.55, sq: 2.4, jitter: 0.004, shimmer: 0.04 }); segs.push({ dur: 0.08 }); });
  segs.push({ dur: 2 });
  const v = Float32Array.from(synth(segs, SR)), n = v.length, band = new Float32Array(n), chords = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55]];
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR, ch = chords[Math.floor(t / 3) % 4]; let s = 0;
    for (let k = 1; k <= 6; k++) s += (0.5 / k) * Math.sin(2 * Math.PI * k * hz(ch[0] - 12) * t);
    for (const m of ch) for (let k = 1; k <= 10; k++) s += (0.12 / k) * Math.sin(2 * Math.PI * k * hz(m) * t + k);
    const beat = t % 0.375; s += beat < 0.03 ? 0.25 * rnd() * (1 - beat / 0.03) : 0; band[i] = s;
  }
  const rms = (x) => Math.sqrt(x.reduce((a, b) => a + b * b, 0) / x.length), g = (rms(band) / rms(v)) * 0.7;
  const mix = new Float32Array(n); let P = 0;
  for (let i = 0; i < n; i++) { mix[i] = v[i] * g + band[i]; P = Math.max(P, Math.abs(mix[i])); }
  for (let i = 0; i < n; i++) mix[i] *= 0.9 / P;
  return mix;
}

