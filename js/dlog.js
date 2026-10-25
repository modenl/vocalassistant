// Diagnostics for analysing songs on phones: each line goes straight to the
// site's /api/log (a page that runs out of memory is closed by the system
// without a word, so nothing is batched). Steps, sizes, timings and errors
// only — no audio, no file contents.
const SID = Math.random().toString(36).slice(2, 8), T0 = performance.now();
const ua = navigator.userAgent.replace(/\(KHTML, like Gecko\)\s*/, '').slice(0, 160);

export function dlog(event, data = {}) {
  const line = { sid: SID, t: Math.round(performance.now() - T0), event, ...data };
  try { fetch('/api/log', { method: 'POST', body: JSON.stringify(line), keepalive: true }).catch(() => {}); } catch { /* offline */ }
}

let started = false;
// once per page: the device, and every uncaught error from then on
export function dlogStart() {
  if (started) return;
  started = true;
  dlog('page', { ua, gpu: !!navigator.gpu, cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, w: screen.width, h: screen.height, dpr: devicePixelRatio });
  addEventListener('error', (e) => dlog('error', { msg: String(e.message).slice(0, 300), at: `${e.filename}:${e.lineno}` }));
  addEventListener('unhandledrejection', (e) => dlog('rejection', { msg: String(e.reason?.message || e.reason).slice(0, 300) }));
  addEventListener('pagehide', () => dlog('pagehide'));
  document.addEventListener('visibilitychange', () => dlog('visibility', { state: document.visibilityState }));
}
