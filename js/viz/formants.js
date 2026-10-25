// Formant views: the vowel chart (F2 across, F1 down — where the tongue is)
// and one row per sound with F1–F5 on a 0–5 kHz axis (the sound's "fingerprint";
// twang draws F3–F5 together).

import { fit, THEME } from './common.js';
import { REF_VOWELS } from '../analysis/vowels.js';
import { L } from '../i18n.js';

const COLORS = ['#2fbf71', '#f0b429', '#e0708e', '#8fb8f0', '#c792ea', '#5fd4c4'];
export const rowColor = (i) => COLORS[i % COLORS.length];

// points: [{ F1, F2, label, color, hollow }]; trail: [{ F1, F2 }] (the current one's recent path).
// A small canvas (under 220 × 340) gets the compact version: shorter words, smaller marks.
export function drawVowelChart(canvas, { sex = 'm', points = [], trail = [] } = {}) {
  const { ctx, w, h } = fit(canvas);
  const f = sex === 'f', mini = h < 220 || w < 340;
  const F2MIN = f ? 700 : 600, F2MAX = f ? 3100 : 2600, F1MIN = f ? 250 : 200, F1MAX = f ? 1150 : 1000;
  const x0 = 40, x1 = w - 10, y0 = 10, y1 = h - 30;
  // phonetic convention: front vowels (high F2) on the left, high tongue (low F1) on top; log scales
  const X = (F2) => x1 - ((Math.log(Math.max(F2MIN, Math.min(F2MAX, F2))) - Math.log(F2MIN)) / (Math.log(F2MAX) - Math.log(F2MIN))) * (x1 - x0);
  const Y = (F1) => y0 + ((Math.log(Math.max(F1MIN, Math.min(F1MAX, F1))) - Math.log(F1MIN)) / (Math.log(F1MAX) - Math.log(F1MIN))) * (y1 - y0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.fillStyle = THEME.muted; ctx.font = THEME.font;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const v of [800, 1000, 1500, 2000, 2500, 3000]) if (v >= F2MIN && v <= F2MAX) { ctx.beginPath(); ctx.moveTo(X(v) + 0.5, y0); ctx.lineTo(X(v) + 0.5, y1); ctx.stroke(); ctx.fillText(`${v}`, X(v), y1 + 3); }
  ctx.fillText(mini ? L('← 舌头靠前　F2　舌头靠后 →', '← tongue forward   F2   tongue back →') : L('← F2 高：舌头靠前　　　F2（Hz）　　　F2 低：舌头靠后 →', '← high F2: tongue forward        F2 (Hz)        low F2: tongue back →'), (x0 + x1) / 2, y1 + 15);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (const v of [300, 400, 500, 600, 800, 1000]) if (v >= F1MIN && v <= F1MAX) { ctx.beginPath(); ctx.moveTo(x0, Y(v) + 0.5); ctx.lineTo(x1, Y(v) + 0.5); ctx.stroke(); ctx.fillText(`${v}`, x0 - 4, Y(v)); }
  ctx.save(); ctx.translate(10, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
  ctx.fillText(mini ? L('F1 ↓ 舌头高', 'F1 ↓ tongue high') : L('F1（Hz）↓ 越低舌头越高', 'F1 (Hz) ↓ lower = tongue higher'), 0, 0); ctx.restore();
  // reference vowels (Peterson & Barney 1952)
  for (const v of REF_VOWELS) {
    const r = v[f ? 'f' : 'm'], px = X(r[1]), py = Y(r[0]);
    ctx.fillStyle = 'rgba(169,176,191,0.18)'; ctx.beginPath(); ctx.arc(px, py, mini ? 11 : 16, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = THEME.text2; ctx.font = `bold ${mini ? 11 : 13}px -apple-system, "PingFang SC", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(L(v.zh, v.ipa), px, py);
  }
  // the current sound's path
  if (trail.length > 1) {
    ctx.strokeStyle = 'rgba(47,191,113,0.45)'; ctx.lineWidth = 2; ctx.beginPath();
    trail.forEach((p, i) => { const px = X(p.F2), py = Y(p.F1); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  }
  for (const p of points) {
    if (!(p.F1 > 0 && p.F2 > 0)) continue;
    const px = X(p.F2), py = Y(p.F1);
    ctx.lineWidth = 2.5; ctx.strokeStyle = p.color; ctx.fillStyle = p.hollow ? 'rgba(0,0,0,0)' : p.color;
    ctx.beginPath(); ctx.arc(px, py, mini ? 5 : 6.5, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    ctx.fillStyle = p.color; ctx.font = THEME.font; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(p.label, px + 9, py - 3);
  }
}

// rows: [{ label, sub, F: [F1..F5] (NaN = not measured), color, hollow, ref }]
const spanTxt = (F) => L(`F3–F5 跨 ${Math.round(F[4] - F[2])} Hz`, `F3–F5 span ${Math.round(F[4] - F[2])} Hz`);
const noRefTxt = () => L('F4、F5 无参考值', 'no F4/F5 norms');

// minRows: room kept for that many rows, so the chart doesn't change height
// (and move what's below it) as rows come and go
export function drawFormantRows(canvas, rows, { minRows = 0 } = {}) {
  const { ctx, w } = fit(canvas);
  // room on the right for the widest note ("F3–F5 跨 … Hz")
  ctx.font = THEME.font;
  const notes = rows.map((r) => (r.F?.[2] > 0 && r.F?.[4] > 0 ? spanTxt(r.F) : r.ref ? noRefTxt() : ''));
  const right = Math.max(0, ...notes.map((t) => (t ? ctx.measureText(t).width + 14 : 0)));
  const x0 = 118, x1 = w - Math.max(20, right), FMAX = 5000, rowH = 30, top = 22;
  const X = (fq) => x0 + (Math.min(FMAX, fq) / FMAX) * (x1 - x0);
  const need = top + Math.max(rows.length, minRows) * rowH + 20;
  if (Math.abs(canvas.getBoundingClientRect().height - need) > 2) canvas.style.height = `${need}px`;
  const { h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  // the 2–4 kHz band and the axis
  ctx.fillStyle = 'rgba(57,135,229,0.10)'; ctx.fillRect(X(2000), top - 6, X(4000) - X(2000), rows.length * rowH + 6);
  ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
  for (let fq = 0; fq <= FMAX; fq += 1000) { ctx.beginPath(); ctx.moveTo(X(fq) + 0.5, top - 6); ctx.lineTo(X(fq) + 0.5, top + rows.length * rowH); ctx.stroke(); ctx.fillText(fq ? `${fq / 1000} kHz` : '0', X(fq), top - 8); }
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    ctx.fillStyle = r.ref ? THEME.muted : THEME.text; ctx.font = r.ref ? THEME.font : 'bold 12px -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillText(r.label, x0 - 10, y - (r.sub ? 6 : 0));
    if (r.sub) { ctx.font = THEME.font; ctx.fillStyle = THEME.muted; ctx.fillText(r.sub, x0 - 10, y + 7); }
    ctx.strokeStyle = r.ref ? 'rgba(169,176,191,0.25)' : 'rgba(169,176,191,0.4)'; ctx.setLineDash(r.ref ? [3, 3] : []);
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.setLineDash([]);
    const F = r.F || [];
    // F3–F5 span: the cluster twang pulls together
    if (F[2] > 0 && F[4] > 0) {
      ctx.strokeStyle = r.color; ctx.globalAlpha = 0.35; ctx.lineWidth = 8; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(X(F[2]), y); ctx.lineTo(X(F[4]), y); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineCap = 'butt';
      ctx.fillStyle = THEME.text2; ctx.font = THEME.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(spanTxt(F), x1 + 8, y);
    } else if (r.ref) { ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(noRefTxt(), x1 + 8, y); }
    F.forEach((fq, k) => {
      if (!(fq > 0)) return;
      const px = X(fq);
      ctx.lineWidth = 2; ctx.strokeStyle = r.color; ctx.fillStyle = r.hollow || r.ref ? '#12151c' : r.color;
      ctx.beginPath(); ctx.arc(px, y, r.ref ? 4.5 : 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = r.ref ? THEME.muted : THEME.text; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillText(`F${k + 1}`, px, y - 7);
    });
  });
}
