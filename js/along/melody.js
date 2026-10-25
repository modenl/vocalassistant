// The original singer's melody from a song file: decoded to 44.1 kHz mono and
// given to MELODIA (see melody-worker.js). In pop songs the predominant melody
// is the lead vocal; in an instrumental intro or solo it's that instrument.

import { melodyFrames, notesOf } from './compare.js';

export const MEL_SR = 44100, MEL_HOP = 256; // 5.8 ms

// any audio file → Float32Array mono at 44.1 kHz (+ the decoded buffer, to play)
export async function decodeSong(blob, ctx) {
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  const off = new OfflineAudioContext(1, Math.ceil(buf.duration * MEL_SR), MEL_SR);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  return { buf, x: (await off.startRendering()).getChannelData(0) };
}

// → { frames: [{ t, midi }], notes: [{ t0, t1, midi, name }], secs }
export function extractMelody(x, a4 = 440) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./melody-worker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      w.terminate();
      if (e.data.error) { reject(new Error(e.data.error)); return; }
      const frames = melodyFrames(e.data.f0, MEL_HOP / MEL_SR, a4);
      resolve({ frames, notes: notesOf(frames), secs: x.length / MEL_SR });
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker failed')); };
    const copy = Float32Array.from(x);
    w.postMessage({ x: copy, hop: MEL_HOP }, [copy.buffer]);
  });
}

// samples captured at any rate (the tab's sound) → 44.1 kHz for MELODIA
export async function resampleTo44k(x, sr) {
  if (sr === MEL_SR) return x;
  const off = new OfflineAudioContext(1, Math.ceil((x.length / sr) * MEL_SR), MEL_SR);
  const buf = off.createBuffer(1, x.length, sr);
  buf.copyToChannel(x, 0);
  const src = off.createBufferSource();
  src.buffer = buf; src.connect(off.destination); src.start();
  return (await off.startRendering()).getChannelData(0);
}
