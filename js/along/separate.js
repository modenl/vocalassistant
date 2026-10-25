// The lead vocal out of a song, with Demucs (see separate-worker.js). One
// worker while songs are being analysed; releaseSeparator() ends it, freeing
// the model (≈ 1 GB of GPU / main memory) before the singing starts.
//   const { vocals, device, secs } = await separateVocals(x, { onProgress: ({ stage, progress }) => … })
// x: Float32Array mono at 44.1 kHz → vocals: the same length; device: 'webgpu' | 'wasm'

import { dlog } from '../dlog.js';

let worker = null, pending = null;

export async function separateVocals(x, { onProgress } = {}) {
  await releaseSeparator(); // one song at a time: a newer one replaces the older
  return new Promise((resolve, reject) => {
    pending = reject;
    worker = new Worker(new URL('./separate-worker.js', import.meta.url), { type: 'module' });
    const done = (fn, v) => { pending = null; fn(v); };
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.log) { dlog(`w.${d.log.event}`, d.log); return; }
      if (d.error) done(reject, new Error(d.error));
      else if (d.vocals) done(resolve, d);
      else if (!d.released) onProgress?.(d);
    };
    worker.onerror = (e) => { dlog('worker-onerror', { msg: String(e.message) }); releaseSeparator(); done(reject, new Error(e.message || 'separation failed')); };
    const copy = Float32Array.from(x);
    worker.postMessage({ x: copy }, [copy.buffer]);
  });
}

// end the worker and with it the model, its GPU memory released first (a job
// still running is cancelled)
export async function releaseSeparator() {
  const w = worker;
  worker = null;
  if (pending) { const r = pending; pending = null; r(new Error('cancelled')); }
  if (!w) return;
  await new Promise((res) => {
    const t = setTimeout(res, 3000);
    w.onmessage = (e) => { if (e.data?.released) { clearTimeout(t); res(); } };
    w.postMessage({ release: true });
  });
  w.terminate();
}
