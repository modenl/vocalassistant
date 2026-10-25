// Browser-only experiment (load in the dev page's console with import()):
// does analysing a song captured at a faster playback rate (a web player sped
// up, pitch kept) still find its melody? A synthetic song with a known melody
// is played through an <audio> element at `rate`, captured, separated with
// Demucs and given to MELODIA (told the real pace); the melody is scored
// against the truth. Not part of the app.

import { synth, VOWELS } from '../js/audio/synth.js';
import { resampleTo44k, extractMelody } from '../js/along/melody.js';
import { separateVocals } from '../js/along/separate.js';

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

function wav(x) {
  const b = new ArrayBuffer(44 + x.length * 2), d = new DataView(b), W = (o, s) => [...s].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  W(0, 'RIFF'); d.setUint32(4, 36 + x.length * 2, true); W(8, 'WAVEfmt '); d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, SR, true); d.setUint32(28, SR * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true); W(36, 'data'); d.setUint32(40, x.length * 2, true);
  for (let i = 0; i < x.length; i++) d.setInt16(44 + i * 2, Math.max(-1, Math.min(1, x[i])) * 32767, true);
  return new Blob([b], { type: 'audio/wav' });
}

// played at `rate` and captured → { x (44.1 kHz), a, b: media time = a + b · capture time }
export async function capture(mix, rate) {
  const el = new Audio(URL.createObjectURL(wav(mix))); el.preservesPitch = true; el.playbackRate = rate;
  const ctx = new AudioContext(); await ctx.resume(); await ctx.audioWorklet.addModule(new URL('../js/audio/capture-worklet.js', import.meta.url));
  const src = ctx.createMediaElementSource(el), node = new AudioWorkletNode(ctx, 'vocal-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
  const g = ctx.createGain(); g.gain.value = 0; src.connect(node); node.connect(g).connect(ctx.destination);
  const chunks = [], marks = []; let n = 0;
  node.port.onmessage = (e) => { chunks.push(e.data); n += e.data.length; };
  const iv = setInterval(() => { if (!el.paused) marks.push([n / ctx.sampleRate, el.currentTime]); }, 100);
  await el.play(); await new Promise((r) => { el.onended = r; }); clearInterval(iv); ctx.close();
  const x = new Float32Array(n); chunks.forEach((c, i) => x.set(c, i * 1024));
  const k = marks.length, sx = marks.reduce((s, p) => s + p[0], 0) / k, sy = marks.reduce((s, p) => s + p[1], 0) / k;
  const b = marks.reduce((s, p) => s + (p[0] - sx) * (p[1] - sy), 0) / marks.reduce((s, p) => s + (p[0] - sx) ** 2, 0);
  return { x: await resampleTo44k(x, ctx.sampleRate), a: sy - b * sx, b };
}

export function score(frames) {
  let n = 0, hit = 0, miss = 0;
  for (let t = START; t < START + MEL.length * D; t += 0.05) {
    const i = Math.floor((t - START) / D), u = t - START - i * D;
    if (u < 0.08 || u > D - 0.12) continue;
    n++;
    let b = null; for (const f of frames) if (Math.abs(f.t - t) <= 0.04 && (!b || Math.abs(f.t - t) < Math.abs(b.t - t))) b = f;
    if (!b) miss++; else if (Math.abs(b.midi - MEL[i]) < 0.5) hit++;
  }
  return { hit, n, miss, pct: Math.round((100 * hit) / n) };
}

// rate 1 uses the song itself (no capture)
export async function run(rate) {
  const mix = song();
  const c = rate === 1 ? { x: mix, a: 0, b: 1 } : await capture(mix, rate);
  const r = await separateVocals(c.x), m = await extractMelody(r.vocals, 440, { rate });
  const frames = m.frames.map((f) => ({ t: c.a + (c.b / rate) * f.t, midi: f.midi }));
  return { rate, ...score(frames), sepSecs: +r.secs.toFixed(1), device: r.device };
}
