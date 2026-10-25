// The lead vocal out of a song, with Demucs (see separate-worker.js). One
// worker for the page: the model loads once, jobs run one after another.
//   const { vocals, device, secs } = await separateVocals(x, { onProgress: ({ stage, progress }) => … })
// x: Float32Array mono at 44.1 kHz → vocals: the same length; device: 'webgpu' | 'wasm'

let worker = null, queue = Promise.resolve();

export function separateVocals(x, { onProgress } = {}) {
  const job = queue.then(() => new Promise((resolve, reject) => {
    worker ||= new Worker(new URL('./separate-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.error) { reject(new Error(d.error)); return; }
      if (d.vocals) { resolve(d); return; }
      onProgress?.(d);
    };
    worker.onerror = (e) => { worker.terminate(); worker = null; reject(new Error(e.message || 'separation failed')); };
    const copy = Float32Array.from(x);
    worker.postMessage({ x: copy }, [copy.buffer]);
  }));
  queue = job.catch(() => {});
  return job;
}
