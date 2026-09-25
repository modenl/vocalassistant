// Piano-roll pitch trace. Held notes are coloured by intonation (green in tune,
// amber slightly off, red clearly off); glides are grey. Optional: target bands
// (lessons), break markers, other problem markers, a playhead. Used live, in
// lessons and in history.

import { fit, THEME, attachHover } from './common.js';
import { midiName, isBlack } from '../config.js';
import { L as tr } from '../i18n.js';

export const TUNE = {
  good: { max: 25, color: '#2fbf71', name: tr('准', 'in tune') },
  near: { max: 40, color: '#f0b429', name: tr('略偏', 'slightly off') },
  off: { max: 99, color: '#ef5a5a', name: tr('不准', 'off') },
  glide: { color: '#7c8698', name: tr('滑音 / 过渡', 'glide') },
};
export const tuneClass = (cents) => (Math.abs(cents) <= TUNE.good.max ? 'good' : Math.abs(cents) <= TUNE.near.max ? 'near' : 'off');

const wrap = (c) => ((((c + 50) % 100) + 100) % 100) - 50;
// Colour class per frame, from pitch smoothed over 0.2 s (≈ one vibrato cycle,
// so vibrato doesn't read as sliding): held (the smoothed pitch moved < 0.3
// semitone in the last 0.15 s) → by cents from `offset` (the singer's own
// tuning; 0 = A4 440); otherwise a glide.
export function classify(t, midi, offset = 0) {
  const n = t.length, out = new Array(n).fill(null), sm = new Array(n).fill(NaN);
  let a = 0, sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(midi[i])) { sum += midi[i]; cnt++; }
    while (t[i] - t[a] > 0.2) { if (Number.isFinite(midi[a])) { sum -= midi[a]; cnt--; } a++; }
    if (!Number.isFinite(midi[i])) { continue; }
    // a gap inside the window starts over (new phrase)
    let gap = false;
    for (let k = i; k > a; k--) if (!Number.isFinite(midi[k - 1]) || t[k] - t[k - 1] > 0.12) { gap = true; break; }
    sm[i] = gap ? midi[i] : sum / cnt;
  }
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(sm[i])) continue;
    while (t[i] - t[j] > 0.15) j++;
    let lo = sm[i], hi = sm[i], ok = true;
    for (let k = j; k <= i; k++) {
      if (!Number.isFinite(sm[k])) { ok = false; break; }
      lo = Math.min(lo, sm[k]); hi = Math.max(hi, sm[k]);
    }
    out[i] = ok && hi - lo < 0.3 && t[i] - t[j] > 0.1 ? tuneClass(wrap((sm[i] - Math.round(sm[i])) * 100 - offset)) : 'glide';
  }
  return out;
}

export class PitchTrack {
  constructor(canvas, { onSeek } = {}) {
    this.canvas = canvas;
    this.last = null;
    attachHover(canvas, (x, y) => this.hover(x, y));
    if (onSeek) {
      canvas.style.cursor = 'pointer';
      canvas.addEventListener('click', (e) => {
        if (!this.last) return;
        const r = canvas.getBoundingClientRect(), { x0, pw, t0, t1 } = this.last;
        const t = t0 + ((e.clientX - r.left - x0) / pw) * (t1 - t0);
        if (t >= t0 && t <= t1) onSeek(t);
      });
    }
  }

  // data: { t, midi }; opts: { t0, t1, lo, hi, offset, targets: [{ midi, label? }], breaks: [{ t }],
  //   marks: [{ t, icon, color, label }] (other problems at a moment: ↘ phrase end sank, ↗ scooped onset), playhead }
  draw(data, opts) {
    const { ctx, w, h } = fit(this.canvas);
    const { t0, t1 } = opts;
    const x0 = 44, x1 = w - 8, y0 = 10, y1 = h - 20, pw = x1 - x0, ph = y1 - y0;
    ctx.clearRect(0, 0, w, h);
    let lo = opts.lo, hi = opts.hi;
    for (let i = 0; i < data.t.length; i++) {
      const m = data.midi[i];
      if (data.t[i] >= t0 && Number.isFinite(m)) { lo = Math.min(lo, Math.floor(m) - 1); hi = Math.max(hi, Math.ceil(m) + 1); }
    }
    for (const g of opts.targets || []) { lo = Math.min(lo, g.midi - 2); hi = Math.max(hi, g.midi + 2); }
    const X = (t) => x0 + ((t - t0) / (t1 - t0)) * pw;
    const Y = (m) => y1 - ((m - lo) / (hi - lo)) * ph;
    const rowH = ph / (hi - lo);

    for (let m = Math.ceil(lo); m <= hi; m++) {
      if (isBlack(m)) { ctx.fillStyle = 'rgba(255,255,255,0.025)'; ctx.fillRect(x0, Y(m + 0.5), pw, rowH); }
      const isC = ((m % 12) + 12) % 12 === 0;
      ctx.strokeStyle = isC ? THEME.gridStrong : THEME.grid;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, Y(m) + 0.5); ctx.lineTo(x1, Y(m) + 0.5); ctx.stroke();
      if (isC || rowH > 13) {
        ctx.fillStyle = isC ? THEME.text2 : THEME.muted;
        ctx.font = THEME.fontMono; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
        ctx.fillText(midiName(m), x0 - 6, Y(m));
      }
    }
    // target bands: the passing zone (g.tol cents either side, default ±50)
    // (active = the note to sing next: drawn stronger; ref = heard only, grey)
    const anyActive = (opts.targets || []).some((g) => g.active);
    for (const g of opts.targets || []) {
      const dim = anyActive && !g.active, hw = (g.tol ?? 50) / 100;
      const [r, gg, b] = g.ref ? [124, 134, 152] : [47, 191, 113];
      ctx.fillStyle = `rgba(${r},${gg},${b},${g.active ? 0.28 : dim ? 0.06 : 0.14})`;
      ctx.fillRect(x0, Y(g.midi + hw), pw, Y(g.midi - hw) - Y(g.midi + hw));
      ctx.strokeStyle = `rgba(${r},${gg},${b},${dim ? 0.35 : 0.8})`; ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(x0, Y(g.midi)); ctx.lineTo(x1, Y(g.midi)); ctx.stroke(); ctx.setLineDash([]);
      if (g.label) { ctx.fillStyle = `rgba(${r},${gg},${b},0.95)`; ctx.font = THEME.font; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText(g.label, x0 + 4, Y(g.midi + Math.max(hw, 0.3)) - 1); }
    }
    // trace
    const cls = classify(data.t, data.midi, opts.offset || 0);
    ctx.lineWidth = 3; ctx.lineCap = 'round';
    for (let i = 1; i < data.t.length; i++) {
      const a = data.midi[i - 1], b = data.midi[i];
      if (!Number.isFinite(a) || !Number.isFinite(b) || data.t[i] < t0 || data.t[i] - data.t[i - 1] > 0.12) continue;
      ctx.strokeStyle = (TUNE[cls[i]] || TUNE.glide).color;
      ctx.beginPath(); ctx.moveTo(X(data.t[i - 1]), Y(a)); ctx.lineTo(X(data.t[i]), Y(b)); ctx.stroke();
    }
    // breaks
    for (const b of opts.breaks || []) {
      if (b.t < t0 || b.t > t1) continue;
      const x = X(b.t);
      ctx.strokeStyle = 'rgba(239,90,90,0.6)'; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ef5a5a'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText('⚡', x, y0);
    }
    // other problem markers: a small icon under the top edge, a faint tick below it
    for (const m of opts.marks || []) {
      if (m.t < t0 || m.t > t1) continue;
      const x = X(m.t);
      ctx.strokeStyle = m.color; ctx.globalAlpha = 0.45; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y0 + 17); ctx.lineTo(x, y0 + 30); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = m.color; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillText(m.icon, x, y0 + 1);
    }
    if (Number.isFinite(opts.playhead)) {
      const x = X(opts.playhead);
      ctx.strokeStyle = THEME.text; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
    }
    // time axis
    ctx.fillStyle = THEME.muted; ctx.font = THEME.fontMono; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const span = t1 - t0, step = span > 60 ? 10 : span > 20 ? 5 : span > 8 ? 2 : 1;
    for (let s = Math.ceil(t0 / step) * step; s <= t1; s += step) ctx.fillText(fmtT(s), X(s), y1 + 4);
    this.last = { data, cls, X, Y, x0, pw, t0, t1, lo, hi, y0, y1, offset: opts.offset || 0, marks: opts.marks || [], breaks: opts.breaks || [] };
  }

  hover(x, y) {
    const L = this.last;
    if (!L || x < L.x0 || y < L.y0 || y > L.y1) return null;
    const t = L.t0 + ((x - L.x0) / L.pw) * (L.t1 - L.t0);
    let best = -1, bd = 1e9;
    for (let i = 0; i < L.data.t.length; i++) { const d = Math.abs(L.data.t[i] - t); if (d < bd) { bd = d; best = i; } }
    if (best < 0 || bd > 0.1 || !Number.isFinite(L.data.midi[best])) return null;
    const m = L.data.midi[best], c = wrap((m - Math.round(m)) * 100 - (L.offset || 0)), k = L.cls[best];
    // a marker within ±0.25 s of the cursor is named too
    const near = [...L.marks, ...L.breaks.map((b) => ({ t: b.t, icon: '⚡', label: tr('断档', 'break') }))].filter((mk) => Math.abs(mk.t - t) <= 0.25);
    return `<b>${midiName(m)}</b> ${c >= 0 ? '+' : ''}${Math.round(c)} ${tr('音分', 'cents')} · ${(TUNE[k] || TUNE.glide).name}${near.map((mk) => `<br>${mk.icon} ${mk.label}`).join('')}<br><span class="muted">${fmtT(L.data.t[best])}</span>`;
  }
}

export function fmtT(s) {
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, '0')}`;
}
