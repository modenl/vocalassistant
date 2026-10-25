// The lead vocal out of a song, with Demucs (see separate-worker.js). One
// worker while songs are being analysed; releaseSeparator() ends it, freeing
// the model (≈ 1 GB of GPU / main memory) before the singing starts.
//   const { vocals, device, secs } = await separateVocals(x, { onProgress: ({ stage, progress }) => … })
// x: Float32Array mono at 44.1 kHz → vocals: the same length; device: 'webgpu' | 'wasm'

let worker = null, pending = null;

export function separateVocals(x, { onProgress } = {}) {
  releaseSeparator(); // one song at a time: a newer one replaces the older
  return new Promise((resolve, reject) => {
    pending = reject;
    worker = new Worker(new URL('./separate-worker.js', import.meta.url), { type: 'module' });
    const done = (fn, v) => { pending = null; fn(v); };
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.error) done(reject, new Error(d.error));
      else if (d.vocals) done(resolve, d);
      else onProgress?.(d);
    };
    worker.onerror = (e) => { releaseSeparator(); done(reject, new Error(e.message || 'separation failed')); };
    const copy = Float32Array.from(x);
    worker.postMessage({ x: copy }, [copy.buffer]);
  });
}

// end the worker and with it the model (a job still running is cancelled)
export function releaseSeparator() {
  if (worker) { worker.terminate(); worker = null; }
  if (pending) { const r = pending; pending = null; r(new Error('cancelled')); }
}
