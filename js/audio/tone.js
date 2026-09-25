// Reference pitches (soft piano-like tone) for "listen first, then sing".
// stopTones() silences everything still sounding and cancels pending notes,
// so leaving a lesson never leaves a reference playing in the background.

import { midiToHz } from '../config.js';

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
