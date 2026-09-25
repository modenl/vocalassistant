// Reference pitches for "listen first, then sing": a sung "ah" (default) or a
// soft piano-like tone. People match a voice more accurately than an
// instrument (Watts & Hall 2008), and a voice in their own octave avoids
// octave confusion. stopTones() silences everything still sounding and
// cancels pending notes, so leaving a page never leaves a reference playing.

import { midiToHz } from '../config.js';
import { synth, VOWELS } from './synth.js';

let ctx = null;
const sounding = new Set(); // output nodes of tones still playing
let gen = 0;                // bumped by stopTones(): pending notes resolve as stopped
let until = 0;              // performance.now() when the last scheduled tone ends

// True while a reference is audible, plus a tail for room echo and audio
// latency. A lesson take ignores the microphone meanwhile — otherwise the
// speaker's reference tone would be scored as the singer's voice.
export function refSounding(tailMs = 400) {
  return performance.now() < until + tailMs;
}
const scheduled = (dur) => { until = Math.max(until, performance.now() + (dur + 0.05) * 1000); };

async function ready() {
  if (!ctx || ctx.state === 'closed') ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  return ctx;
}

// Resolves after `dur` seconds: true if it played to the end, false if stopped.
function hold(out, dur, my) {
  sounding.add(out);
  return new Promise((r) => setTimeout(() => { sounding.delete(out); r(my === gen); }, dur * 1000));
}

export function stopTones() {
  gen++;
  until = Math.min(until, performance.now());
  for (const out of sounding) { try { out.disconnect(); } catch { /* already gone */ } }
  sounding.clear();
}

export async function playTone(midi, dur = 1.6, a4 = 440) {
  const my = gen;
  const c = await ready();
  if (my !== gen) return false;
  const f = midiToHz(midi, a4);
  const t0 = c.currentTime + 0.02;
  const out = c.createGain();
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(0.22, t0 + 0.02);
  out.gain.exponentialRampToValueAtTime(0.06, t0 + dur * 0.6);
  out.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  out.connect(c.destination);
  scheduled(dur);
  [[1, 1], [2, 0.35], [3, 0.15], [4, 0.06]].forEach(([k, a]) => {
    const o = c.createOscillator();
    const g = c.createGain();
    o.frequency.value = f * k;
    g.gain.value = a;
    o.connect(g).connect(out);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  });
  return hold(out, dur, my);
}

// Notes one after another; stops early if stopTones() is called.
export async function playSequence(notes, noteDur = 0.7, a4 = 440) {
  for (const m of notes) if (!(await playTone(m, noteDur, a4))) return false;
  return true;
}

// Sung reference: the notes on "ah" (male or female vowel formants), rendered
// by the source-filter synthesizer. Notes of ≥ 0.8 s get a slight, slow
// vibrato (±8 cents) so they sound sung while their centre stays unambiguous.
export async function playVoice(notes, { noteDur = 1.4, gap = 0.08, a4 = 440, sex = 'm' } = {}) {
  const my = gen;
  const c = await ready();
  if (my !== gen) return false;
  const vowel = sex === 'f' ? VOWELS.aF : VOWELS.a;
  const vib = noteDur >= 0.8 ? 8 : 0;
  const segs = notes.flatMap((m, i) => {
    const f = midiToHz(m, a4);
    const note = { dur: noteDur, vowel, oq: 0.55, sq: 2.4, jitter: 0.002, shimmer: 0.02, attack: 0.05, release: 0.08,
      f0: (t) => f * Math.pow(2, (vib * Math.sin(2 * Math.PI * 5.2 * t) * Math.min(1, Math.max(0, t - 0.3) / 0.3)) / 1200) };
    return i < notes.length - 1 ? [note, { dur: gap }] : [note];
  });
  const x = synth(segs, c.sampleRate); // peak 0.8
  const buf = c.createBuffer(1, x.length, c.sampleRate);
  buf.copyToChannel(Float32Array.from(x), 0);
  const src = c.createBufferSource();
  src.buffer = buf;
  const out = c.createGain();
  out.gain.value = 0.4;
  src.connect(out).connect(c.destination);
  const dur = x.length / c.sampleRate;
  scheduled(dur);
  src.start();
  return hold(out, dur, my);
}

// The reference in the chosen timbre ('voice' | 'piano'). Resolves true if it
// played to the end, false if stopped.
export function playRef(notes, { timbre = 'voice', sex = 'm', a4 = 440, noteDur, gap } = {}) {
  if (timbre === 'piano') return notes.length > 1 ? playSequence(notes, noteDur ?? 0.7, a4) : playTone(notes[0], noteDur ?? 1.6, a4);
  return playVoice(notes, { noteDur: noteDur ?? (notes.length > 1 ? 0.6 : 1.4), gap, a4, sex });
}

// Demo siren: glide from `lo` up to `hi` and back down (sine-ish, soft).
export async function playGlide(lo, hi, dur = 5, a4 = 440) {
  const my = gen;
  const c = await ready();
  if (my !== gen) return false;
  const t0 = c.currentTime + 0.02, half = dur / 2;
  const f = (m) => midiToHz(m, a4);
  const out = c.createGain();
  out.gain.setValueAtTime(0, t0);
  out.gain.linearRampToValueAtTime(0.18, t0 + 0.08);
  out.gain.setValueAtTime(0.18, t0 + dur - 0.15);
  out.gain.linearRampToValueAtTime(0.0001, t0 + dur);
  out.connect(c.destination);
  scheduled(dur);
  [[1, 1], [2, 0.3], [3, 0.1]].forEach(([k, a]) => {
    const o = c.createOscillator(), g = c.createGain();
    o.frequency.setValueAtTime(f(lo) * k, t0);
    o.frequency.exponentialRampToValueAtTime(f(hi) * k, t0 + half);
    o.frequency.exponentialRampToValueAtTime(f(lo) * k, t0 + dur);
    g.gain.value = a;
    o.connect(g).connect(out);
    o.start(t0); o.stop(t0 + dur + 0.05);
  });
  return hold(out, dur, my);
}
