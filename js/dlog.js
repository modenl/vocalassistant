// Diagnostics for analysing songs on phones, sent to the site's /api/log
// (a page that runs out of memory is closed by the system without a word, so
// nothing waits longer than 0.5 s). Steps, sizes, timings and errors
// only — no audio, no file contents.
const SID = Math.random().toString(36).slice(2, 8), T0 = performance.now();
const ua = navigator.userAgent.replace(/\(KHTML, like Gecko\)\s*/, '').slice(0, 160);

// lines go out every 0.5 s in one request (a burst of single requests was
// sampled away by `wrangler tail`), and at once when the page is hidden
let queue = [], timer = 0;
function flush() {
  timer = 0;
  if (!queue.length) return;
  const body = JSON.stringify(queue);
  queue = [];
  try { if (!navigator.sendBeacon?.('/api/log', body)) fetch('/api/log', { method: 'POST', body, keepalive: true }).catch(() => {}); } catch { /* offline */ }
}
export function dlog(event, data = {}) {
  queue.push({ sid: SID, t: Math.round(performance.now() - T0), event, ...data });
  timer ||= setTimeout(flush, 500);
}

let started = false;
// once per page: the device, and every uncaught error from then on
export function dlogStart() {
  if (started) return;
  started = true;
  dlog('page', { ua, gpu: !!navigator.gpu, cores: navigator.hardwareConcurrency, mem: navigator.deviceMemory, w: screen.width, h: screen.height, dpr: devicePixelRatio });
  addEventListener('error', (e) => dlog('error', { msg: String(e.message).slice(0, 300), at: `${e.filename}:${e.lineno}` }));
  addEventListener('unhandledrejection', (e) => dlog('rejection', { msg: String(e.reason?.message || e.reason).slice(0, 300) }));
  addEventListener('pagehide', () => { dlog('pagehide'); flush(); });
  document.addEventListener('visibilitychange', () => { dlog('visibility', { state: document.visibilityState }); if (document.visibilityState === 'hidden') flush(); });
}
