// Sing-along view: the original's notes as bars with their names (scientific
// pitch notation, e.g. A3), the singer's pitch as a line coloured by how close
// it is to the original at that moment, and the singer's own note names.
// Time across (song time), pitch up; the pitch range is the whole song's, so
// the axis never moves while singing.

import { fit, THEME } from './common.js';
import { midiName } from '../config.js';
import { L } from '../i18n.js';
import { drawFreqGrid, drawVoiceLane } from './voiceSpec.js';

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
// frequency axis up to 4 kHz, each drawn by the shared voice lane (viz/voiceSpec.js):
// F0 with its note, F1/F2 (≈ for the original, estimated from its harmonics),
// the envelope, the ring in the 2–4 kHz band. Dashed links join the first
// coinciding harmonics (an octave apart: every 2nd harmonic of the lower
// voice). `say`, `say2`: two lines on top (the pitch, then the ring).
export function drawSpectraPair(canvas, { ref = null, user = null, say = '', say2 = '', fmax = 4000 } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const x0 = 44, x1 = w - 10, top = 42, laneH = (h - top - 20) / 2;
  const X = (f) => x0 + (Math.min(fmax, f) / fmax) * (x1 - x0);
  // the words on top: two lines, each cut to the width
  const fitText = (t) => { let s = t; while (s && ctx.measureText(s).width > x1 - x0) s = s.slice(0, -2) + '…'; return s; };
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.font = 'bold 12.5px -apple-system, "PingFang SC", sans-serif'; ctx.fillStyle = THEME.text;
  ctx.fillText(fitText(say || L('唱起来、或在上面的音高图上点一下，就显示那一刻的频谱', 'Sing, or click the pitch chart above, to see the spectra at that moment')), x0, 3);
  if (say2) { ctx.font = '12px -apple-system, "PingFang SC", sans-serif'; ctx.fillStyle = THEME.text2; ctx.fillText(fitText(say2), x0, 20); }
  drawFreqGrid(ctx, { x0, x1, y0: top, y1: top + 2 * laneH }, fmax);
  drawVoiceLane(ctx, { x0, x1, y0: top, y1: top + laneH }, ref, { color: ALONG_COLORS.ref, label: L('原唱', 'Original'), fmax });
  drawVoiceLane(ctx, { x0, x1, y0: top + laneH, y1: top + 2 * laneH }, user, { color: ALONG_COLORS.mine, label: L('你', 'You'), fmax });
  // links where the first harmonics of the two coincide (within 3 %)
  if (ref?.harm?.length && user?.harm?.length) {
    ctx.strokeStyle = 'rgba(232,235,241,0.3)'; ctx.setLineDash([2, 4]); ctx.lineWidth = 1;
    for (const a of ref.harm.filter((p) => p.k <= 4)) {
      const b = user.harm.find((u) => u.k <= 8 && Math.abs(u.f / a.f - 1) <= 0.03);
      if (!b) continue;
      ctx.beginPath(); ctx.moveTo(X(a.f) + 0.5, top + laneH - 4); ctx.lineTo(X(b.f) + 0.5, top + laneH + 14); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
