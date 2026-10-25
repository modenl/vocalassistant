// One voice's spectrum, compact and reusable: the raw spectrum faint, the line
// through its harmonics (the envelope the mouth and throat give), F0 (the
// pitch) bold, F1 / F2 (the vowel) purple — dashed when only estimated — and
// the 2–4 kHz band with the ring (2–4 kHz below the lows, dB: smaller =
// brighter). Drawn into a box of any canvas: the sing-along stacks two, the
// voice scope and the twang lesson show one.
// side: { spec: { db, binHz }, f0, name, harm: [{ k, f, db }], formants: [F1, F2], est, ring }

import { fit, THEME } from './common.js';
import { L } from '../i18n.js';

export const FM_COLOR = '#c792ea';
const RING_COLOR = 'rgba(143,184,240,0.95)';
const SANS = '-apple-system, "PingFang SC", sans-serif', MONO = 'ui-monospace, Menlo, monospace';

// the frequency grid of a box (lines inside it, labels under it)
export function drawFreqGrid(ctx, { x0, x1, y0, y1 }, fmax = 4000, { labels = true } = {}) {
  const X = (f) => x0 + (f / fmax) * (x1 - x0);
  ctx.fillStyle = 'rgba(57,135,229,0.09)'; ctx.fillRect(X(2000), y0, X(Math.min(4000, fmax)) - X(2000), y1 - y0);
  ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let f = 0; f <= fmax; f += 500) {
    ctx.strokeStyle = f % 1000 === 0 ? THEME.gridStrong : THEME.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(f) + 0.5, y0); ctx.lineTo(X(f) + 0.5, y1); ctx.stroke();
    if (labels && f % 1000 === 0) { ctx.fillStyle = THEME.muted; ctx.fillText(f ? `${f / 1000}k` : '0', X(f), y1 + 3); }
  }
}

// one voice in a box; small boxes (under 110 px high) get smaller words
export function drawVoiceLane(ctx, box, side, { color = '#2fbf71', label = '', fmax = 4000 } = {}) {
  const { x0, x1, y0, y1 } = box, small = y1 - y0 < 110;
  const X = (f) => x0 + (Math.min(fmax, f) / fmax) * (x1 - x0);
  const fs = (n) => `${small ? n - 1.5 : n}px`;
  if (label) {
    ctx.fillStyle = THEME.text2; ctx.font = `bold ${fs(11)} ${SANS}`; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x0 - 6, (y0 + y1) / 2);
  }
  if (!side?.spec) return;
  const { db, binHz } = side.spec, n = Math.min(db.length - 1, Math.floor(fmax / binHz));
  // levels relative to the loudest point shown, 70 dB deep
  let top = -Infinity;
  for (let k = 1; k <= n; k++) if (db[k] > top) top = db[k];
  const head = small ? 26 : 30, yb = y1 - 3;
  const Ydb = (d) => yb - (Math.max(-70, Math.min(0, d - top)) + 70) / 70 * (yb - y0 - head);
  ctx.strokeStyle = color; ctx.globalAlpha = 0.22; ctx.lineWidth = 1; ctx.beginPath();
  for (let k = 1; k <= n; k++) { const x = X(k * binHz), y = Ydb(db[k]); k === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
  ctx.stroke(); ctx.globalAlpha = 1;
  const hm = (side.harm || []).filter((p) => p.f <= fmax);
  if (hm.length > 1) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.globalAlpha = 0.7; ctx.beginPath();
    hm.forEach((p, i) => (i ? ctx.lineTo(X(p.f), Ydb(p.db)) : ctx.moveTo(X(p.f), Ydb(p.db)))); ctx.stroke(); ctx.globalAlpha = 1;
  }
  for (const p of hm) {
    if (p.k === 1) continue;
    ctx.fillStyle = color; ctx.globalAlpha = 0.6; ctx.beginPath(); ctx.arc(X(p.f), Ydb(p.db), small ? 1.6 : 2, 0, 2 * Math.PI); ctx.fill(); ctx.globalAlpha = 1;
    if (p.k <= 4 && !small) { ctx.fillStyle = THEME.muted; ctx.font = `9.5px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(p.k, X(p.f), Ydb(p.db) - 4); }
  }
  // words on a dark backing so lines never run through them; returns [left, right]
  const tag = (text, x, y, align, fill, font) => {
    ctx.font = font; const tw = ctx.measureText(text).width, lx = align === 'center' ? x - tw / 2 : align === 'right' ? x - tw : x;
    ctx.fillStyle = 'rgba(18,21,28,0.82)'; ctx.fillRect(lx - 2, y - 1, tw + 4, small ? 13 : 15);
    ctx.fillStyle = fill; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(text, lx, y);
    return [lx, lx + tw];
  };
  // F1, F2 (≈: estimated from the harmonics); F2's words move right if F1's are in the way
  let fmRight = -Infinity;
  for (const [i, F] of (side.formants || []).slice(0, 2).entries()) {
    if (!(F > 0) || F > fmax) continue;
    ctx.strokeStyle = FM_COLOR; ctx.lineWidth = small ? 2 : 2.5; ctx.setLineDash(side.est ? [4, 3] : []);
    ctx.beginPath(); ctx.moveTo(X(F) + 0.5, y0 + 15); ctx.lineTo(X(F) + 0.5, yb); ctx.stroke(); ctx.setLineDash([]);
    const text = `F${i + 1}${side.est ? '≈' : ' '}${Math.round(F)}`, font = `bold ${fs(11.5)} ${MONO}`;
    ctx.font = font;
    const half = ctx.measureText(text).width / 2;
    fmRight = tag(text, Math.max(X(F), fmRight + 6 + half), y0 + 1, 'center', FM_COLOR, font)[1];
  }
  // a pitch but no F1/F2: say why
  if (side.f0 > 0 && !(side.formants?.length)) {
    const font = `${fs(11)} ${SANS}`;
    fmRight = tag(side.f0 > 450 ? L('F1/F2 测不了：音高 > 450 Hz，谐波太稀', 'F1/F2 n/a: pitch > 450 Hz, harmonics too sparse') : L('F1/F2 这一刻测不出', 'F1/F2 not found here'), X(fmax * 0.3), y0 + 1, 'left', THEME.muted, font)[1];
  }
  // F0: the pitch
  let f0Right = -Infinity;
  if (side.f0 > 0) {
    const x = X(side.f0), y = Ydb(hm[0]?.db ?? top - 10);
    ctx.strokeStyle = color; ctx.lineWidth = small ? 2.5 : 3; ctx.beginPath(); ctx.moveTo(x + 0.5, y0 + 15); ctx.lineTo(x + 0.5, yb); ctx.stroke();
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, small ? 4 : 5, 0, 2 * Math.PI); ctx.fill();
    f0Right = tag(`F0 ${Math.round(side.f0)} Hz${side.name ? ` · ${side.name}` : ''}`, Math.min(x + 5, X(fmax * 0.36)), y0 + 16, 'left', color, `bold ${fs(12)} ${SANS}`)[1];
  }
  // the ring, at the top of the 2–4 kHz band (a line lower if F0's words reach it)
  const ringTxt = Number.isFinite(side.ring) ? L(`共鸣：比低频弱 ${Math.round(side.ring)} dB`, `ring: ${Math.round(side.ring)} dB below the lows`) : L('2–4 kHz 共鸣', '2–4 kHz ring');
  const rFont = `bold ${fs(11.5)} ${SANS}`;
  ctx.font = rFont;
  const rx = X(Math.min(4000, fmax)) - 4, rLeft = rx - ctx.measureText(ringTxt).width;
  tag(ringTxt, rx, rLeft < f0Right + 6 ? y0 + 32 : y0 + 16, 'right', RING_COLOR, rFont);
}

// a single voice on its own canvas: an optional line of words on top, the lane, the axis
export function drawVoiceSpectrum(canvas, side, { color = '#2fbf71', say = '', fmax = 4000, empty = '' } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const top = say ? 18 : 2, box = { x0: 30, x1: w - 8, y0: top, y1: h - 16 };
  if (say) { ctx.fillStyle = THEME.text2; ctx.font = `12px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(say, box.x0, 2); }
  drawFreqGrid(ctx, box, fmax);
  if (side?.spec) drawVoiceLane(ctx, box, side, { color, fmax });
  else { ctx.fillStyle = THEME.muted; ctx.font = `12px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(empty || L('唱起来就会显示', 'sing to see it'), (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2); }
}
