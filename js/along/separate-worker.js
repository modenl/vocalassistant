// The lead vocal out of a song: Demucs v4 (Hybrid Transformer Demucs, Rouard,
// Massa & Défossez 2023; Meta, MIT), Meta's published htdemucs weights as the
// browser ONNX export timcsy/demucs-web-onnx (180 MB), with its JavaScript
// STFT / iSTFT and overlap-add, demucs-web (MIT), run by onnxruntime-web (MIT)
// on WebGPU, else on the CPU (WebAssembly). No training. The model is
// downloaded once and kept in the browser's cache; the audio never leaves the page.
// in: { x: Float32Array mono at 44.1 kHz } → out: { stage, progress } … { vocals, device, secs } | { error }

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const DEMUCS = 'https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/src/index.js';
const MODEL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df61cfc9eb820272aaa62d2ef6dcf4d950d/htdemucs_embedded.onnx';
const MODEL_BYTES = 180534758, CACHE = 'vocallab-models-v1';

let proc = null, device = '';
const say = (m) => self.postMessage(m);

// the model's bytes: from the cache, else downloaded (with progress) and cached
async function modelBytes() {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(MODEL); if (hit) return await hit.arrayBuffer(); } catch { /* no cache storage */ }
  const res = await fetch(MODEL);
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || MODEL_BYTES, out = new Uint8Array(total), rd = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    out.set(value, got); got += value.length;
    say({ stage: 'download', progress: got / total, bytes: got, total });
  }
  const bytes = got === total ? out : out.slice(0, got);
  try { await cache?.put(MODEL, new Response(bytes)); } catch { /* full: download again next time */ }
  return bytes.buffer;
}

async function load() {
  if (proc) return proc;
  const ort = await import(`${ORT}ort.webgpu.min.mjs`), { DemucsProcessor } = await import(DEMUCS);
  ort.env.wasm.wasmPaths = ORT;
  // threads need a cross-origin-isolated page (not this one: it embeds YouTube)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  const bytes = await modelBytes();
  say({ stage: 'load', progress: 0 });
  let gpu = false;
  try { gpu = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter()); } catch { /* none */ }
  const errs = [];
  for (const ep of gpu ? ['webgpu', 'wasm'] : ['wasm']) {
    try {
      const p = new DemucsProcessor({ ort, sessionOptions: { executionProviders: [ep] } });
      await p.loadModel(bytes.slice(0));
      device = ep;
      return (proc = p);
    } catch (err) { errs.push(`${ep}: ${err?.message || err}`); }
  }
  throw new Error(errs.join(' | '));
}

// demucs-web's segment loop (25 % overlap, triangular cross-fades), keeping
// only what is needed: the vocal stem, one channel (the input is mono, so both
// output channels are the same). Its own loop runs the inverse STFT for all
// 4 stems × 2 channels in JavaScript: 8× the work, most of the time taken.
async function separate(x) {
  const { CONSTANTS: C, prepareModelInput, istft } = await import(DEMUCS);
  const S = C.TRAINING_SAMPLES, B = C.MODEL_SPEC_BINS, F = C.MODEL_SPEC_FRAMES, H = C.HOP_SIZE, NF = C.FFT_SIZE, VOC = 3;
  const s = proc.session, ort = proc.ort, n = x.length, stride = Math.floor(S * (1 - C.SEGMENT_OVERLAP));
  const out = new Float32Array(n), wsum = new Float32Array(n), segs = Math.max(1, Math.ceil(Math.max(0, n - S) / stride) + 1);
  const pb = B + 1, pf = F + 4, ilen = (pf - 1) * H + NF, off = NF / 2 + Math.floor(H / 2) * 3;
  let tGpu = 0, tCpu = 0, k = 0;
  for (let start = 0; start < n; start += stride) {
    const len = Math.min(S, n - start), seg = new Float32Array(S);
    seg.set(x.subarray(start, start + len));
    let t = performance.now();
    const inp = prepareModelInput(seg, seg);
    tCpu += performance.now() - t; t = performance.now();
    const r = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', inp.waveform, [1, 2, S]), [s.inputNames[1]]: new ort.Tensor('float32', inp.magSpec, [1, 4, B, F]) });
    tGpu += performance.now() - t; t = performance.now();
    let td = null, fd = null;
    for (const name of s.outputNames) { const T = r[name]; if (T.dims.length === 4 && T.dims[2] === 2) td = T.data; else if (T.dims.length === 5 && T.dims[2] === 4) fd = T.data; }
    // the vocal's spectrogram (left channel), padded as demucs-web's standaloneIspec, back to time
    let fv = null;
    if (fd) {
      const re = new Float32Array(pf * pb), im = new Float32Array(pf * pb), base = VOC * 4 * B * F;
      for (let f = 0; f < F; f++) for (let b = 0; b < B; b++) { const d = (f + 2) * pb + b; re[d] = fd[base + b * F + f]; im[d] = fd[base + B * F + b * F + f]; }
      fv = istft(re, im, pf, pb, NF, H, ilen).subarray(off, off + S);
    }
    const tb = VOC * 2 * S;
    for (let i = 0; i < len; i++) {
      const w = Math.min(Math.min(i / (stride * 0.5), 1), Math.min((len - i) / (stride * 0.5), 1));
      out[start + i] += (td[tb + i] + (fv ? fv[i] : 0)) * w; wsum[start + i] += w;
    }
    for (const name of s.outputNames) r[name].dispose?.();
    // this stretch's vocal and band as envelopes (peak per 10 ms), for the page's animation
    const BIN = 441, nb = Math.ceil(len / BIN), ve = new Float32Array(nb), be = new Float32Array(nb);
    for (let i = 0; i < len; i++) { const vv = td[tb + i] + (fv ? fv[i] : 0), j = (i / BIN) | 0, a = Math.abs(vv), b = Math.abs(x[start + i] - vv); if (a > ve[j]) ve[j] = a; if (b > be[j]) be[j] = b; }
    tCpu += performance.now() - t;
    self.postMessage({ stage: 'separate', progress: ++k / segs, device, part: { start, ve, be, bin: BIN } }, [ve.buffer, be.buffer]);
  }
  for (let i = 0; i < n; i++) if (wsum[i] > 0) out[i] /= wsum[i];
  return { vocals: out, gpu: tGpu / 1000, cpu: tCpu / 1000 };
}

self.onmessage = async (e) => {
  // before the worker ends: the session's GPU buffers freed now — a terminated
  // worker's weren't, and every later separation ran slower (16 s of audio:
  // 27, 50, 82 s in three runs one after another)
  if (e.data.release) { try { await proc?.session?.release(); } catch { /* gone */ } proc = null; self.postMessage({ released: true }); return; }
  try {
    await load();
    const t0 = performance.now(), r = await separate(e.data.x);
    self.postMessage({ ...r, device, secs: (performance.now() - t0) / 1000 }, [r.vocals.buffer]);
  } catch (err) { say({ error: String(err?.message || err) }); }
};
