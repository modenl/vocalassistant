// The lead vocal out of a song: Demucs v4 (Hybrid Transformer Demucs, Rouard,
// Massa & Défossez 2023; Meta, MIT), Meta's published htdemucs weights, no
// training, run by onnxruntime-web (MIT). Two exports of the same model:
//  • with WebGPU: monteslu/htdemucs-web-onnx (MIT) — fp16 except the
//    convolutions, 126 MB, cut into 21 pieces run one after another. Each
//    piece is downloaded, made a session and its bytes dropped, so the page
//    never holds more than one piece (≤ 22 MB) besides the GPU's copy: the
//    single 180 MB file below, plus its copies while loading, made iPhones
//    reload the page ("a problem repeatedly occurred");
//  • without: timcsy/demucs-web-onnx (180 MB, fp32), on the CPU (WebAssembly).
// The STFT / iSTFT around the network: demucs-web@1.0.2 (MIT). The model is
// downloaded once and kept in the browser's cache; the audio never leaves the page.
// in: { x: Float32Array mono at 44.1 kHz } | { release } → out: { stage, progress } … { vocals, device, secs } | { error } | { released }

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/';
const DEMUCS = 'https://cdn.jsdelivr.net/npm/demucs-web@1.0.2/src/index.js';
const SPLIT = 'https://huggingface.co/monteslu/htdemucs-web-onnx/resolve/a4a57cc0cf707e5b9a3e6ad3c2c4b21fcbe608c1/';
const SPLIT_BYTES = 125886563;
const FULL = 'https://huggingface.co/timcsy/demucs-web-onnx/resolve/92e33df61cfc9eb820272aaa62d2ef6dcf4d950d/htdemucs_embedded.onnx';
const FULL_BYTES = 180534758, CACHE = 'vocallab-models-v1';
// piece 0's input normalisation gives NaN in fp16 on WebGPU: kept on the CPU (the export's own note)
const CPU_NODES = ['/ReduceMean', '/Sub', '/Pow', '/ReduceMean_1', '/Clip', '/Sqrt', '/Add', '/Div',
  '/ReduceMean_2', '/Sub_1', '/Pow_1', '/ReduceMean_3', '/Clip_1', '/Sqrt_1', '/Add_1', '/Div_1'];

let model = null, device = '', ort = null;
const say = (m) => self.postMessage(m);
const wlog = (event, data = {}) => self.postMessage({ log: { event, ...data } }); // diagnostics (js/dlog.js)

// a file's bytes: from the cache, else downloaded (progress: onBytes(n)) and cached
async function fetchBytes(url, onBytes = () => {}) {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) { const b = new Uint8Array(await hit.arrayBuffer()); onBytes(b.length); return b; } } catch { /* no cache storage */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed (${res.status})`);
  const parts = [], rd = res.body.getReader();
  let got = 0;
  for (;;) {
    const { done, value } = await rd.read();
    if (done) break;
    parts.push(value); got += value.length; onBytes(value.length);
  }
  const out = new Uint8Array(got);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  try { await cache?.put(url, new Response(out)); } catch { /* full: download again next time */ }
  return out;
}

// the 21 pieces, loaded one by one; what each run feeds forward is freed after its last use
async function loadSplit() {
  const manifest = JSON.parse(new TextDecoder().decode(await fetchBytes(`${SPLIT}htdemucs_split_manifest.json`)));
  let got = 0;
  const pieces = [];
  for (const [i, p] of manifest.pieces.entries()) {
    let bytes = await fetchBytes(`${SPLIT}${p.file}`, (n) => { got += n; say({ stage: 'download', progress: Math.min(1, got / SPLIT_BYTES), bytes: got, total: SPLIT_BYTES }); });
    wlog('piece-bytes', { i, mb: +(bytes.length / 1e6).toFixed(1) });
    const t0 = performance.now();
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: [i === 0 ? { name: 'webgpu', forceCpuNodeNames: CPU_NODES } : 'webgpu'],
      graphOptimizationLevel: 'all', preferredOutputLocation: 'gpu-buffer',
    });
    bytes = null; // only the GPU keeps it
    pieces.push({ ...p, session });
    wlog('piece-session', { i, ms: Math.round(performance.now() - t0) });
  }
  const last = {};
  pieces.forEach((p, i) => p.inputs.forEach((n) => { last[n] = i; }));
  // the cached single-file model isn't needed any more
  try { await (await caches.open(CACHE)).delete(FULL); } catch { /* none */ }
  return { split: true, pieces, last, out: manifest.outputs };
}

async function loadFull() {
  let got = 0;
  const bytes = await fetchBytes(FULL, (n) => { got += n; say({ stage: 'download', progress: Math.min(1, got / FULL_BYTES), bytes: got, total: FULL_BYTES }); });
  say({ stage: 'load', progress: 0 });
  const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'basic' });
  return { split: false, session };
}

async function load() {
  if (model) return model;
  ort = await import(`${ORT}ort.webgpu.min.mjs`);
  ort.env.wasm.wasmPaths = ORT;
  // threads need a cross-origin-isolated page (not this one: it embeds YouTube)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;
  let gpu = false;
  try {
    const ad = self.navigator.gpu && await self.navigator.gpu.requestAdapter();
    gpu = !!ad;
    if (ad) wlog('adapter', { vendor: ad.info?.vendor, arch: ad.info?.architecture, maxBuffer: ad.limits?.maxBufferSize, maxStorage: ad.limits?.maxStorageBufferBindingSize });
  } catch (err) { wlog('adapter-error', { msg: String(err?.message || err) }); }
  wlog('ort-ready', { gpu, threads: ort.env.wasm.numThreads });
  say({ stage: 'load', progress: 0, device: gpu ? 'webgpu' : 'wasm', model: gpu ? 'split-fp16' : 'full-fp32' });
  const errs = [];
  if (gpu) {
    try { model = await loadSplit(); device = 'webgpu'; wlog('model-ready', { model: 'split-fp16' }); return model; } catch (err) { errs.push(`webgpu: ${err?.message || err}`); wlog('split-error', { msg: String(err?.message || err).slice(0, 300) }); }
  }
  try { model = await loadFull(); device = 'wasm'; wlog('model-ready', { model: 'full-fp32' }); return model; } catch (err) { errs.push(`wasm: ${err?.message || err}`); wlog('full-error', { msg: String(err?.message || err).slice(0, 300) }); }
  throw new Error(errs.join(' | '));
}

// one 7.8 s segment through the network → { td: time branch, fd: frequency branch }
async function runSegment(M, waveform, magSpec, S, B, F) {
  const mix = new ort.Tensor('float32', waveform, [1, 2, S]), mag = new ort.Tensor('float32', magSpec, [1, 4, B, F]);
  if (!M.split) {
    const s = M.session, r = await s.run({ [s.inputNames[0]]: mix, [s.inputNames[1]]: mag });
    let td = null, fd = null;
    for (const name of s.outputNames) { const T = r[name]; if (T.dims.length === 4 && T.dims[2] === 2) td = T.data; else if (T.dims.length === 5 && T.dims[2] === 4) fd = T.data; }
    return { td, fd };
  }
  const map = { mix, mag }, keep = new Set(Object.values(M.out));
  for (const [i, p] of M.pieces.entries()) {
    const r = await p.session.run(Object.fromEntries(p.inputs.map((n) => [n, map[n]])));
    Object.assign(map, r);
    for (const n of p.inputs) if (M.last[n] === i && !keep.has(n) && n !== 'mix' && n !== 'mag') { map[n].dispose?.(); delete map[n]; }
  }
  const td = await map[M.out.time].getData(), fd = await map[M.out.freq].getData();
  map[M.out.time].dispose?.(); map[M.out.freq].dispose?.();
  return { td, fd };
}

// demucs-web's segment loop (25 % overlap, triangular cross-fades), keeping
// only what is needed: the vocal stem, one channel (the input is mono, so both
// output channels are the same). Its own loop runs the inverse STFT for all
// 4 stems × 2 channels in JavaScript: 8× the work, most of the time taken.
async function separate(x) {
  const { CONSTANTS: C, prepareModelInput, istft } = await import(DEMUCS);
  const S = C.TRAINING_SAMPLES, B = C.MODEL_SPEC_BINS, F = C.MODEL_SPEC_FRAMES, H = C.HOP_SIZE, NF = C.FFT_SIZE, VOC = 3;
  const n = x.length, stride = Math.floor(S * (1 - C.SEGMENT_OVERLAP));
  const out = new Float32Array(n), wsum = new Float32Array(n), segs = Math.max(1, Math.ceil(Math.max(0, n - S) / stride) + 1);
  const pb = B + 1, pf = F + 4, ilen = (pf - 1) * H + NF, off = NF / 2 + Math.floor(H / 2) * 3;
  let tGpu = 0, tCpu = 0, k = 0;
  for (let start = 0; start < n; start += stride) {
    const len = Math.min(S, n - start), seg = new Float32Array(S);
    seg.set(x.subarray(start, start + len));
    let t = performance.now();
    const inp = prepareModelInput(seg, seg);
    tCpu += performance.now() - t; t = performance.now();
    wlog('segment-start', { k, of: segs });
    const { td, fd } = await runSegment(model, inp.waveform, inp.magSpec, S, B, F);
    wlog('segment-done', { k, ms: Math.round(performance.now() - t) });
    tGpu += performance.now() - t; t = performance.now();
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
    // this stretch's vocal and band as envelopes (peak per 10 ms), for the page's animation
    const BIN = 441, nb = Math.ceil(len / BIN), ve = new Float32Array(nb), be = new Float32Array(nb);
    for (let i = 0; i < len; i++) { const vv = td[tb + i] + (fv ? fv[i] : 0), j = (i / BIN) | 0, a = Math.abs(vv), b = Math.abs(x[start + i] - vv); if (a > ve[j]) ve[j] = a; if (b > be[j]) be[j] = b; }
    tCpu += performance.now() - t;
    self.postMessage({ stage: 'separate', progress: ++k / segs, device, part: { start, ve, be, bin: BIN } }, [ve.buffer, be.buffer]);
  }
  for (let i = 0; i < n; i++) if (wsum[i] > 0) out[i] /= wsum[i];
  return { vocals: out, gpu: tGpu / 1000, cpu: tCpu / 1000 };
}

// every session's GPU buffers freed before the worker ends — a terminated
// worker's weren't, and every later separation ran slower (16 s of audio:
// 27, 50, 82 s in three runs one after another)
async function release() {
  const M = model; model = null;
  if (!M) return;
  for (const s of M.split ? M.pieces.map((p) => p.session) : [M.session]) { try { await s.release(); } catch { /* gone */ } }
}

self.onmessage = async (e) => {
  if (e.data.release) { await release(); wlog('released'); self.postMessage({ released: true }); return; }
  wlog('job', { secs: +(e.data.x.length / 44100).toFixed(1) });
  try {
    say({ stage: 'load', progress: 0 });
    await load();
    const t0 = performance.now(), r = await separate(e.data.x);
    self.postMessage({ ...r, device, model: model.split ? 'split-fp16' : 'full-fp32', secs: (performance.now() - t0) / 1000 }, [r.vocals.buffer]);
  } catch (err) { wlog('error', { msg: String(err?.message || err).slice(0, 300) }); say({ error: String(err?.message || err) }); }
};
