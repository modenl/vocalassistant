// Sing-along view: the original's notes as bars with their names (scientific
// pitch notation, e.g. A3), the singer's pitch as a line coloured by how close
// it is to the original at that moment, and the singer's own note names.
// Time across (song time), pitch up; the pitch range is the whole song's, so
// the axis never moves while singing.

import { fit, THEME } from './common.js';
import { midiName } from '../config.js';
import { L } from '../i18n.js';

export const ALONG_COLORS = { ref: '#5b9cf0', good: '#2fbf71', near: '#f0b429', off: '#ef5a5a', none: '#9aa3b5', mine: '#ff9f43' };
const NATURAL = new Set([0, 2, 4, 5, 7, 9, 11]);

// range: [lo, hi] MIDI; win: [t0, t1] song seconds; ref: notes (faint: taken as
// accompaniment — drawn grey, unnamed); user: frames
// { t, midi } in song time; mine: the singer's notes (names as sung); shift:
// semitones added to the singer's pitch to overlay the original (−12·octave);
// statusAt(t, midi): how close the singer's pitch at t is (colours the line);
// now: song time of the cursor (null = none)
export function drawAlong(canvas, { range, win, ref = [], user = [], mine = [], shift = 0, statusAt = () => null, now = null } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const [lo, hi] = range, [t0, t1] = win;
  const x0 = 44, x1 = w - 8, y0 = 8, y1 = h - 22;
  const X = (t) => x0 + ((t - t0) / (t1 - t0)) * (x1 - x0);
  const Y = (m) => y1 - ((m - lo) / (hi - lo)) * (y1 - y0);
  const rowH = (y1 - y0) / (hi - lo);
  // pitch grid: a line per semitone, names on the natural notes
  ctx.font = THEME.font; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let m = Math.ceil(lo); m <= hi; m++) {
    const nat = NATURAL.has(((m % 12) + 12) % 12);
    ctx.strokeStyle = m % 12 === 0 ? THEME.gridStrong : THEME.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x0, Y(m) + 0.5); ctx.lineTo(x1, Y(m) + 0.5); ctx.stroke();
    if (nat && rowH >= 7) { ctx.fillStyle = m % 12 === 0 ? THEME.text2 : THEME.muted; ctx.fillText(midiName(m), x0 - 5, Y(m)); }
  }
  // time ticks
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = THEME.muted;
  const step = t1 - t0 > 40 ? 10 : t1 - t0 > 16 ? 5 : 1;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) { const m = Math.floor(t / 60), s = Math.round(t % 60); ctx.fillText(`${m}:${String(s).padStart(2, '0')}`, X(t), y1 + 4); }
  ctx.save(); ctx.beginPath(); ctx.rect(x0, y0 - 6, x1 - x0, y1 - y0 + 12); ctx.clip();
  // the original's notes
  const bh = Math.max(4, Math.min(12, rowH * 0.8));
  for (const n of ref) {
    if (n.t1 < t0 || n.t0 > t1) continue;
    const xa = X(n.t0), xb = Math.max(xa + 2, X(n.t1)), y = Y(n.midi);
    ctx.fillStyle = n.faint ? 'rgba(154,163,181,0.10)' : 'rgba(91,156,240,0.35)'; ctx.strokeStyle = n.faint ? 'rgba(154,163,181,0.35)' : ALONG_COLORS.ref; ctx.lineWidth = n.faint ? 1 : 1.5;
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(xa, y - bh / 2, xb - xa, bh, 3) : ctx.rect(xa, y - bh / 2, xb - xa, bh); ctx.fill(); ctx.stroke();
    if (!n.faint && (xb - xa >= 16 || n.t1 - n.t0 >= 0.25)) { ctx.fillStyle = ALONG_COLORS.ref; ctx.font = 'bold 11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(n.name, xa, y - bh / 2 - 2); }
  }
  // the singer's pitch, coloured by the original's note at that moment
  ctx.lineWidth = 2.5; ctx.lineCap = 'round';
  let prev = null;
  for (const u of user) {
    if (u.t < t0 - 0.1 || u.t > t1 + 0.1 || !Number.isFinite(u.midi)) { prev = null; continue; }
    if (prev && u.t - prev.t <= 0.06) {
      ctx.strokeStyle = ALONG_COLORS[statusAt(u.t, u.midi) || 'none'];
      ctx.beginPath(); ctx.moveTo(X(prev.t), Y(prev.midi + shift)); ctx.lineTo(X(u.t), Y(u.midi + shift)); ctx.stroke();
    }
    prev = u;
  }
  // the singer's own note names (as sung, before any octave overlay)
  ctx.fillStyle = ALONG_COLORS.mine; ctx.font = 'bold 11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  let lastX = -1e9;
  for (const n of mine) {
    if (n.t1 < t0 || n.t0 > t1 || n.t1 - n.t0 < 0.2) continue;
    const x = X(n.t0);
    if (x - lastX < 26) continue;
    ctx.fillText(n.name, x, Y(n.midi + shift) + bh / 2 + 3);
    lastX = x;
  }
  ctx.restore();
  if (now != null && now >= t0 && now <= t1) { ctx.strokeStyle = 'rgba(232,235,241,0.6)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(X(now) + 0.5, y0); ctx.lineTo(X(now) + 0.5, y1); ctx.stroke(); }
  if (!ref.length) { ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(L('导入原唱后，这里显示原唱的每个音', 'Import the original: its notes show here'), (x0 + x1) / 2, (y0 + y1) / 2); }
}

// The original (top lane) and the singer (bottom lane) at one moment, on one
// linear frequency axis: each spectrum, its F0 (the pitch) with the note name,
// the harmonics numbered, the singer's F1 / F2 (the vowel), and dashed links
// where a harmonic of one sits on a harmonic of the other (an octave apart:
// every 2nd harmonic of the lower voice). `say`: one line on top.
// side: { spec: { db, binHz }, f0, name, harm: [{ k, f, db }], formants: [F1, F2] }
export function drawSpectraPair(canvas, { ref = null, user = null, say = '', fmax = 2500 } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const x0 = 44, x1 = w - 10, top = 42, laneH = (h - top - 26) / 2;
  const X = (f) => x0 + (Math.min(fmax, f) / fmax) * (x1 - x0);
  const lanes = [{ side: ref, y0: top, color: ALONG_COLORS.ref, label: L('原唱', 'Original') }, { side: user, y0: top + laneH, color: ALONG_COLORS.mine, label: L('你', 'You') }];
  // the words on top: up to two lines, wrapped by character (Chinese has no spaces)
  ctx.font = 'bold 12.5px -apple-system, "PingFang SC", sans-serif'; ctx.fillStyle = THEME.text; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  const text = say || L('唱起来、或在上面的音高图上点一下，就显示那一刻的频谱', 'Sing, or click the pitch chart above, to see the spectra at that moment');
  const lines = [''];
  for (const ch of text) {
    const cur = lines[lines.length - 1];
    if (ctx.measureText(cur + ch).width > x1 - x0) { if (lines.length === 2) { lines[1] = cur.slice(0, -1) + '…'; break; } lines.push(ch.trim() ? ch : ''); } else lines[lines.length - 1] = cur + ch;
  }
  lines.forEach((ln, i) => ctx.fillText(ln, x0, 3 + i * 16));
  // frequency grid
  ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let f = 0; f <= fmax; f += 250) {
    ctx.strokeStyle = f % 1000 === 0 ? THEME.gridStrong : THEME.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X(f) + 0.5, top); ctx.lineTo(X(f) + 0.5, top + 2 * laneH); ctx.stroke();
    if (f % 500 === 0) { ctx.fillStyle = THEME.muted; ctx.fillText(f ? `${f} Hz` : '0', X(f), top + 2 * laneH + 4); }
  }
  for (const { side, y0, color, label } of lanes) {
    const yb = y0 + laneH - 4, Ydb = (db) => yb - (Math.max(-70, Math.min(0, db)) + 70) / 70 * (laneH - 26);
    ctx.fillStyle = THEME.text2; ctx.font = 'bold 11px -apple-system, "PingFang SC", sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(label, x0 - 6, y0 + laneH / 2);
    if (!side?.spec) continue;
    // the spectrum
    const { db, binHz } = side.spec;
    ctx.strokeStyle = color; ctx.globalAlpha = 0.85; ctx.lineWidth = 1.2; ctx.beginPath();
    for (let k = 1; k * binHz <= fmax; k++) { const x = X(k * binHz), y = Ydb(db[k]); k === 1 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); }
    ctx.stroke(); ctx.globalAlpha = 1;
    // F1 / F2 (the singer): where the mouth and throat resonate — not the pitch
    for (const [i, F] of (side.formants || []).entries()) {
      ctx.strokeStyle = '#c792ea'; ctx.setLineDash([3, 3]); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(F) + 0.5, y0 + 14); ctx.lineTo(X(F) + 0.5, yb); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#c792ea'; ctx.font = 'bold 11px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(`F${i + 1}`, X(F), y0 + 2);
    }
    // harmonics, numbered; F0 = harmonic 1, with its frequency and note
    for (const hm of side.harm || []) {
      const x = X(hm.f), y = Ydb(hm.db);
      ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, hm.k === 1 ? 4.5 : 2.8, 0, 2 * Math.PI); ctx.fill();
      if (hm.k <= 8) { ctx.fillStyle = THEME.text2; ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(hm.k, x, y - 5); }
    }
    if (side.f0 > 0) {
      const x = X(side.f0);
      ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(x + 0.5, y0 + 14); ctx.lineTo(x + 0.5, yb); ctx.stroke();
      ctx.fillStyle = color; ctx.font = 'bold 11.5px -apple-system, "PingFang SC", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText(`F0 ${Math.round(side.f0)} Hz · ${side.name}`, Math.min(x + 4, x1 - 120), y0 + 14);
    }
  }
  // links where harmonics of the two coincide (within 3 %)
  if (ref?.harm?.length && user?.harm?.length) {
    ctx.strokeStyle = 'rgba(232,235,241,0.35)'; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
    for (const a of ref.harm) {
      const b = user.harm.find((u) => Math.abs(u.f / a.f - 1) <= 0.03);
      if (!b) continue;
      ctx.beginPath(); ctx.moveTo(X(a.f) + 0.5, top + laneH - 4); ctx.lineTo(X(b.f) + 0.5, top + laneH + 14); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
