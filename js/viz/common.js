// Canvas helpers shared by all visualizations.

export const THEME = {
  surface: '#12151c',
  surface2: '#181c26',
  grid: '#1f2430',
  gridStrong: '#2c3342',
  axis: '#6e7689',
  text: '#e8ebf1',
  text2: '#a9b0bf',
  muted: '#6e7689',
  accent: '#3987e5',
  critical: '#d03b3b',
  warning: '#fab219',
  good: '#0ca30c',
  font: '11px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif',
  fontMono: '11px ui-monospace, Menlo, monospace',
};

// Resize the backing store to CSS size × DPR and return a ready 2D context.
export function fit(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height, dpr };
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Perceptual sequential colormap for spectrogram (dark → bright, magma-like).
export function makeLut() {
  const stops = [[0, [11, 14, 20]], [0.2, [28, 16, 68]], [0.4, [79, 18, 123]], [0.6, [182, 54, 121]],
    [0.78, [251, 136, 97]], [0.92, [254, 206, 145]], [1, [252, 253, 191]]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let k = 0;
    while (k < stops.length - 2 && v > stops[k + 1][0]) k++;
    const [a, ca] = stops[k], [b, cb] = stops[k + 1];
    const u = (v - a) / (b - a);
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = ca[c] + (cb[c] - ca[c]) * u;
  }
  return lut;
}

export const logX = (f, fmin, fmax, x0, w) => x0 + (Math.log(f / fmin) / Math.log(fmax / fmin)) * w;

export function fmtHz(f) {
  return f >= 1000 ? `${(f / 1000).toFixed(f % 1000 ? 1 : 0)}k` : `${Math.round(f)}`;
}

// Hover tooltip shared across canvases.
const tip = () => document.getElementById('tooltip');
export function showTip(html, x, y) {
  const el = tip();
  if (!el) return;
  el.innerHTML = html;
  el.style.display = 'block';
  const r = el.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
export function hideTip() { const el = tip(); if (el) el.style.display = 'none'; }

export function attachHover(canvas, fn) {
  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const html = fn(e.clientX - r.left, e.clientY - r.top);
    if (html) showTip(html, e.clientX, e.clientY); else hideTip();
  });
  canvas.addEventListener('mouseleave', hideTip);
}
