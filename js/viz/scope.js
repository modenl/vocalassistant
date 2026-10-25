// "Voice scope" views: the waveform (time domain), the spectrum and a scrolling
// spectrogram (frequency domain), and a schematic vocal tract driven by the
// estimates in analysis/voiceState.js.

import { fit, THEME, makeLut } from './common.js';
import { L } from '../i18n.js';
import { midiName } from '../config.js';

const FMAX = 5000; // Hz shown

// Waveform: ~3 periods of the latest frame, started at a rising zero crossing
// so a steady note stands still (like an oscilloscope's trigger).
export function drawWave(canvas, x, sr, f0) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke();
  if (!x) return;
  const span = Math.round(f0 > 0 ? Math.min(0.03, 3 / f0) * sr : 0.02 * sr);
  let start = x.length - span - 1;
  for (let i = Math.max(1, x.length - span - Math.round(sr / Math.max(60, f0 || 100))); i > 1; i--) {
    if (x[i - 1] < 0 && x[i] >= 0) { start = i; break; }
    if (x.length - span - i > sr * 0.02) break;
  }
  start = Math.max(0, Math.min(start, x.length - span));
  let peak = 1e-4;
  for (let i = start; i < start + span; i++) peak = Math.max(peak, Math.abs(x[i]));
  ctx.strokeStyle = THEME.accent; ctx.lineWidth = 2; ctx.beginPath();
  for (let i = 0; i < span; i++) {
    const X = (i / (span - 1)) * w, Y = h / 2 - (x[start + i] / peak) * (h / 2 - 8);
    i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
  }
  ctx.stroke();
  ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
  ctx.fillText(f0 > 0 ? L(`${(span / sr * 1000).toFixed(0)} 毫秒 · 一个周期 ${(1000 / f0).toFixed(2)} 毫秒（${Math.round(f0)} Hz）`, `${(span / sr * 1000).toFixed(0)} ms · one period ${(1000 / f0).toFixed(2)} ms (${Math.round(f0)} Hz)`) : L('没有稳定的音高', 'no steady pitch'), 6, 4);
}

// Spectrum 0–5 kHz: the frame's spectrum, the noise floor, the harmonics of f0,
// the formant envelope (LPC) with F1–F3, and the singer's-formant band 2–4 kHz.
export function drawSpectrum(canvas, S) {
  const { ctx, w, h } = fit(canvas);
  const x0 = 34, x1 = w - 6, y0 = 8, y1 = h - 18;
  const X = (f) => x0 + (f / FMAX) * (x1 - x0);
  const top = S?.spec ? Math.max(-20, Math.ceil((Math.max(...Array.from(S.spec.subarray(1, Math.round(FMAX / S.binHz)))) + 5) / 10) * 10) : -20, bot = top - 80;
  const Y = (db) => y0 + ((top - Math.max(bot, Math.min(top, db))) / (top - bot)) * (y1 - y0);
  ctx.clearRect(0, 0, w, h);
  // the 2–4 kHz band
  ctx.fillStyle = 'rgba(57,135,229,0.10)'; ctx.fillRect(X(2000), y0, X(4000) - X(2000), y1 - y0);
  ctx.fillStyle = 'rgba(120,170,240,0.9)'; ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText(L('歌手共振峰带 2–4 kHz', "singer's formant 2–4 kHz") + (Number.isFinite(S?.spr) ? L(`：比低频弱 ${Math.round(S.spr)} dB`, `: ${Math.round(S.spr)} dB below the lows`) : ''), (X(2000) + X(4000)) / 2, y0 + 2);
  // grid
  ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.fillStyle = THEME.muted; ctx.textBaseline = 'top';
  for (let f = 0; f <= FMAX; f += 1000) { ctx.beginPath(); ctx.moveTo(X(f) + 0.5, y0); ctx.lineTo(X(f) + 0.5, y1); ctx.stroke(); ctx.fillText(f ? `${f / 1000}k` : '0', X(f), y1 + 3); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let d = top; d >= bot; d -= 20) { ctx.beginPath(); ctx.moveTo(x0, Y(d) + 0.5); ctx.lineTo(x1, Y(d) + 0.5); ctx.stroke(); ctx.fillText(`${d}`, x0 - 4, Y(d)); }
  if (!S?.spec) return;
  const n = Math.round(FMAX / S.binHz);
  // noise floor (median of the shown spectrum)
  const floor = [...S.spec.subarray(1, n)].sort((a, b) => a - b)[n >> 1];
  ctx.setLineDash([4, 4]); ctx.strokeStyle = 'rgba(160,160,160,0.6)';
  ctx.beginPath(); ctx.moveTo(x0, Y(floor)); ctx.lineTo(x1, Y(floor)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = THEME.muted; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillText(L('底噪', 'noise floor'), x1, Y(floor) - 2);
  // spectrum
  ctx.strokeStyle = THEME.text2; ctx.lineWidth = 1.2; ctx.beginPath();
  for (let k = 1; k < n; k++) { const px = X(k * S.binHz), py = Y(S.spec[k]); k > 1 ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
  ctx.stroke();
  // harmonics
  if (S.f0 > 0) {
    ctx.fillStyle = '#f0b429';
    for (let k = 1; k * S.f0 < FMAX; k++) {
      const b = Math.round((k * S.f0) / S.binHz);
      let m = b; for (let i = b - 2; i <= b + 2; i++) if (S.spec[i] > S.spec[m]) m = i;
      ctx.beginPath(); ctx.arc(X(m * S.binHz), Y(S.spec[m]), 2.6, 0, 2 * Math.PI); ctx.fill();
    }
  }
  // formant envelope, lifted to sit on the harmonic peaks
  if (S.env) {
    const { freqs, db } = S.env;
    let off = -Infinity;
    for (let i = 0; i < freqs.length; i++) if (freqs[i] < FMAX) { const k = Math.round(freqs[i] / S.binHz); off = Math.max(off, S.spec[k] - db[i]); }
    ctx.strokeStyle = '#2fbf71'; ctx.lineWidth = 2; ctx.beginPath();
    let first = true;
    for (let i = 0; i < freqs.length; i++) { if (freqs[i] > FMAX) break; const px = X(freqs[i]), py = Y(db[i] + off); first ? ctx.moveTo(px, py) : ctx.lineTo(px, py); first = false; }
    ctx.stroke();
    ctx.fillStyle = '#2fbf71'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    (S.formants || []).slice(0, 3).forEach((fm, i) => {
      if (fm.f > FMAX) return;
      ctx.strokeStyle = 'rgba(47,191,113,0.5)'; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(X(fm.f), y0 + 16); ctx.lineTo(X(fm.f), y1); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillText(`F${i + 1} ${Math.round(fm.f)}`, X(fm.f), y0 + 30);
    });
  }
}

// Scrolling spectrogram: one column per analysed frame, 0–5 kHz, with the
// pitch drawn on top. Kept in an offscreen canvas and blitted.
export class Spectrogram {
  constructor(canvas, cols = 420) {
    this.canvas = canvas; this.cols = cols; this.rows = 160;
    this.off = document.createElement('canvas'); this.off.width = cols; this.off.height = this.rows;
    this.octx = this.off.getContext('2d');
    this.octx.fillStyle = '#0b0e14'; this.octx.fillRect(0, 0, cols, this.rows);
    this.col = this.octx.createImageData(1, this.rows);
    this.lut = makeLut();
    this.f0s = [];
  }
  push(spec, binHz, f0) {
    const o = this.octx, R = this.rows, d = this.col.data;
    o.drawImage(this.off, -1, 0);
    let peak = -200;
    for (let r = 0; r < R; r++) peak = Math.max(peak, spec[Math.round(((r + 0.5) / R) * FMAX / binHz)]);
    const ref = Math.max(peak, -40);
    for (let r = 0; r < R; r++) {
      const v = spec[Math.round(((R - r - 0.5) / R) * FMAX / binHz)];
      const u = Math.max(0, Math.min(255, Math.round(((v - (ref - 70)) / 70) * 255)));
      d[r * 4] = this.lut[u * 3]; d[r * 4 + 1] = this.lut[u * 3 + 1]; d[r * 4 + 2] = this.lut[u * 3 + 2]; d[r * 4 + 3] = 255;
    }
    o.putImageData(this.col, this.cols - 1, 0);
    this.f0s.push(f0 > 0 ? f0 : NaN);
    if (this.f0s.length > this.cols) this.f0s.shift();
  }
  draw(secsPerCol) {
    const { ctx, w, h } = fit(this.canvas);
    const x0 = 34, y0 = 4, y1 = h - 16, pw = w - x0 - 4;
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.off, x0, y0, pw, y1 - y0);
    ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (let f = 0; f <= FMAX; f += 1000) ctx.fillText(f ? `${f / 1000}k` : '0', x0 - 4, y1 - (f / FMAX) * (y1 - y0));
    // pitch line
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5; ctx.beginPath();
    let on = false; const n = this.f0s.length;
    for (let i = 0; i < n; i++) {
      const f = this.f0s[i], px = x0 + pw - ((n - 1 - i) / this.cols) * pw;
      if (!Number.isFinite(f)) { on = false; continue; }
      const py = y1 - (f / FMAX) * (y1 - y0);
      on ? ctx.lineTo(px, py) : ctx.moveTo(px, py); on = true;
    }
    ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(L(`最近 ${(this.cols * secsPerCol).toFixed(0)} 秒 · 白线 = 音高`, `last ${(this.cols * secsPerCol).toFixed(0)} s · white line = pitch`), x0 + 4, y1 + 2);
  }
}

// Schematic vocal tract, midsagittal (face to the left). Driven by the
// estimates: tongue height / frontness, pharynx narrowing (twang), larynx
// height, soft palate. Unknown parts are drawn faint and labelled "测不了".
// Parts with a problem glow red and are pointed at.
export class TractView {
  constructor(el) {
    this.el = el;
    el.innerHTML = `<svg viewBox="0 0 340 300" class="tract" role="img" aria-label="${L('声道示意图', 'Vocal tract diagram')}">
      <defs><marker id="tvArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#ef5a5a"/></marker></defs>
      <path class="tv-head" d="M70,18 C130,2 220,4 262,34 C292,58 300,110 292,150 C286,190 270,215 262,300 L140,300 C138,262 132,240 112,226 C92,218 70,214 56,206 C46,200 44,190 46,182 C40,178 36,170 40,164 C34,160 32,152 38,146 C32,140 32,132 40,126 C44,120 42,116 30,108 C22,102 20,96 24,90 C34,72 48,40 70,18 Z"/>
      <path class="tv-nose" d="M52,92 C90,80 150,82 196,96 L200,108 C150,104 96,106 58,110 Z"/>
      <path class="tv-air" id="tvAir" d=""/>
      <path class="tv-palate" d="M50,124 C90,112 140,108 180,110"/>
      <path class="tv-velum" id="tvVelum" d=""/>
      <path class="tv-wall" id="tvWall" d=""/>
      <path class="tv-tongue" id="tvTongue" d=""/>
      <path class="tv-epi" id="tvEpiglottis" d=""/>
      <path class="tv-ary" id="tvEpi" d=""/>
      <g id="tvLarynx"><path class="tv-larynx" d="M204,-4 L244,-4 L248,20 L200,20 Z"/><path class="tv-folds" d="M206,4 L242,4"/><path class="tv-trachea" d="M208,20 L208,60 M240,20 L240,60"/></g>
      <path class="tv-lips" d="M42,136 C36,140 36,146 40,150"/>
      <g id="tvLabels" class="tv-labels"></g>
      <g id="tvCallouts"></g>
    </svg>`;
    this.$ = (id) => el.querySelector('#' + id);
  }

  update(st) {
    const known = (v) => Number.isFinite(v);
    const hi = known(st.tongueHigh) ? st.tongueHigh : 0.45, fr = known(st.tongueFront) ? st.tongueFront : 0.45;
    const ph = known(st.pharynx) ? st.pharynx : 0, lar = known(st.larynx) ? Math.max(-0.12, Math.min(0.15, st.larynx)) : 0;
    const vel = known(st.velum) ? st.velum : 1;
    const lY = 262 - lar * 160;                              // vocal folds
    const wallX = 238 - ph * 14;                             // back wall of the pharynx
    const hx = 82 + (1 - fr) * 88, hy = 176 - hi * 52;       // tongue hump
    const rootX = Math.min(wallX - 20, 200 - (1 - fr) * 8);  // tongue root
    const jaw = (1 - hi) * 10;                               // an open vowel drops the jaw
    // tongue: tip behind the lower teeth, the hump, the root down to the epiglottis
    this.$('tvTongue').setAttribute('d', `M50,${168 + jaw} C54,${hy + 6} ${hx - 34},${hy} ${hx},${hy} C${hx + 38},${hy} ${rootX + 8},${hy + 26} ${rootX},${lY - 36}
      C${rootX - 4},${lY - 24} ${rootX - 30},${lY - 22} ${rootX - 60},${212 + jaw} C120,${214 + jaw} 70,${204 + jaw} 50,${168 + jaw} Z`);
    this.$('tvTongue').classList.toggle('unknown', !known(st.tongueHigh));
    this.$('tvEpiglottis').setAttribute('d', `M${rootX - 2},${lY - 30} C${rootX + 6},${lY - 44} ${rootX + 14},${lY - 50} ${rootX + 18},${lY - 52}`);
    this.$('tvWall').setAttribute('d', `M214,96 C${wallX + 4},120 ${wallX},180 ${wallX - ph * 6},${lY - 12} L${wallX - ph * 6},290`);
    this.$('tvWall').classList.toggle('unknown', !known(st.pharynx));
    // epilarynx (the ring above the folds) narrows with twang
    const g = 14 - ph * 9, cx = 224;
    this.$('tvEpi').setAttribute('d', `M${cx - g - 6},${lY - 30} L${cx - g / 2},${lY - 3} M${cx + g + 6},${lY - 30} L${cx + g / 2},${lY - 3}`);
    this.$('tvEpi').classList.toggle('unknown', !known(st.pharynx));
    this.$('tvLarynx').setAttribute('transform', `translate(0,${lY - 4})`);
    this.$('tvLarynx').classList.toggle('unknown', !known(st.larynx));
    // soft palate: raised to the back wall (oral) or hanging down (nasal)
    const vx = 196 + vel * (wallX - 204), vy = 150 - vel * 38;
    this.$('tvVelum').setAttribute('d', `M180,110 C192,112 ${vx - 8},${vy - 14} ${vx},${vy}`);
    this.$('tvVelum').classList.toggle('unknown', !known(st.velum));
    // the airway: mouth, over the tongue, down the pharynx to the folds
    this.$('tvAir').setAttribute('d', `M42,${143 + jaw / 2} C60,${hy - 6} ${hx - 20},${hy - 14} ${hx},${hy - 12} C${hx + 50},${hy - 14} 205,${hy - 18} ${wallX - 4},${hy - 4}
      L${wallX - 4 - ph * 6},${lY - 8} L${cx},${lY} L${rootX + 4},${lY - 34} C${rootX + 8},${hy + 24} ${hx + 36},${hy + 4} ${hx},${hy + 2} C${hx - 30},${hy + 2} 56,${hy + 10} 44,${150 + jaw} Z`);
    const unk = L('测不了', 'n/a');
    const tongueTxt = known(st.tongueHigh) ? `${hi >= 0.6 ? L('高', 'high') : hi <= 0.35 ? L('低', 'low') : L('中', 'mid')} · ${fr >= 0.6 ? L('靠前', 'front') : fr <= 0.35 ? L('靠后', 'back') : L('居中', 'central')}` : unk;
    const lab = [
      // [name, value, label x, label y, anchor point]
      [L('舌', 'Tongue'), tongueTxt, 70, 262, [hx, hy + 14]],
      [L('软腭', 'Soft palate'), known(st.velum) ? (vel >= 0.5 ? L('抬起', 'raised') : L('下垂（鼻音）', 'lowered (nasal)')) : unk, 150, 58, [vx, vy]],
      [L('咽腔', 'Pharynx'), known(st.pharynx) ? (ph >= 0.6 ? L('2–4 kHz 强（可能收窄）', 'strong 2–4 kHz (maybe narrowed)') : ph >= 0.3 ? L('2–4 kHz 偏强', 'some 2–4 kHz') : L('2–4 kHz 弱', 'little 2–4 kHz')) : unk, 312, 150, [wallX, 170]],
      [L('喉', 'Larynx'), known(st.larynx) ? (lar >= 0.06 ? L('偏高', 'raised') : lar <= -0.06 ? L('偏低', 'lowered') : L('正常', 'normal')) : st.hasBase ? L('元音和基准不同', 'vowel ≠ reference') : L('设基准后可测', 'set a reference'), 312, 250, [246, lY]],
    ];
    this.$('tvLabels').innerHTML = lab.map(([t, v, x, y, [ax, ay]]) => `<line x1="${x}" y1="${y + 4}" x2="${ax}" y2="${ay}" class="tl-lead"/><text x="${x}" y="${y}" text-anchor="middle"><tspan class="tl-name">${t}</tspan><tspan x="${x}" dy="12" class="tl-val">${v}</tspan></text>`).join('');
    // problems: the part glows and a numbered arrow points at it
    const where = { pharynx: [wallX - 2, 190], glottis: [224, lY], larynx: [224, lY], velum: [vx, vy], tongue: [hx, hy] };
    const probs = st.problems || [];
    this.el.querySelectorAll('.bad').forEach((n) => n.classList.remove('bad'));
    for (const p of probs) {
      const id = { pharynx: 'tvWall', glottis: 'tvLarynx', larynx: 'tvLarynx', velum: 'tvVelum', tongue: 'tvTongue' }[p.part];
      if (id) this.$(id).classList.add('bad');
    }
    this.$('tvCallouts').innerHTML = probs.slice(0, 3).map((p, i) => {
      const [x, y] = where[p.part] || [160, 150], lx = 120 + i * 26;
      return `<line x1="${lx}" y1="30" x2="${x}" y2="${y}" stroke="#ef5a5a" stroke-width="1.4" marker-end="url(#tvArrow)"/><circle cx="${lx}" cy="24" r="8" fill="#ef5a5a"/><text x="${lx}" y="28" text-anchor="middle" class="tv-callout">${i + 1}</text>`;
    }).join('');
  }
}

// ------------------------------------------------------------------ comparing spectra
// Spectra pooled to 200 points over 0–5 kHz (25 Hz each; the loudest bin, so
// harmonic peaks survive), smoothed over time, and normalised so the strongest
// point below 2 kHz is 0 dB. Two such curves then differ in the 2–4 kHz band by
// exactly the difference in singing power ratio: the extra "ring".
export const SPEC_N = 200;
export function pool(spec, binHz) {
  const out = new Float32Array(SPEC_N);
  for (let i = 0; i < SPEC_N; i++) {
    const a = Math.max(1, Math.floor((i * FMAX) / SPEC_N / binHz)), b = Math.max(a + 1, Math.floor(((i + 1) * FMAX) / SPEC_N / binHz));
    let m = -200;
    for (let k = a; k < b; k++) if (spec[k] > m) m = spec[k];
    out[i] = m;
  }
  return out;
}
export class SpecAvg {
  constructor(tau = 0.4) { this.tau = tau; this.v = null; }
  push(p, dt) {
    if (!this.v) { this.v = Float32Array.from(p); return; }
    const a = 1 - Math.exp(-dt / this.tau);
    for (let i = 0; i < SPEC_N; i++) this.v[i] += a * (p[i] - this.v[i]);
  }
}
const iOf = (f) => Math.min(SPEC_N - 1, Math.round((f / FMAX) * SPEC_N));
const maxIn = (p, f1, f2) => { let m = -Infinity; for (let i = iOf(f1); i < iOf(f2); i++) m = Math.max(m, p[i]); return m; };
export const normSpec = (p) => { if (!p) return null; const m = maxIn(p, 80, 2000); return Array.from(p, (v) => v - m); };
// 2–4 kHz below 0–2 kHz (dB): the singing power ratio of a pooled spectrum
export const sprOf = (p) => (p ? maxIn(p, 80, 2000) - maxIn(p, 2000, 4000) : NaN);

// cur / ref: pooled spectra. Draws the reference (line) and the current voice
// (filled), the 2–4 kHz band, and the gap there as a labelled arrow.
export function drawCompare(canvas, { cur, ref, curLabel, refLabel, refColor = '#9aa3b5', target = null, formants = [], gain = null, gainLabel = '', good = null } = {}) {
  const { ctx, w, h } = fit(canvas);
  const x0 = 34, x1 = w - 8, y0 = 26, y1 = h - 20, TOP = 0, BOT = -60;
  const X = (f) => x0 + (f / FMAX) * (x1 - x0);
  const Y = (db) => y0 + ((TOP - Math.max(BOT, Math.min(TOP, db))) / (TOP - BOT)) * (y1 - y0);
  ctx.clearRect(0, 0, w, h);
  // band
  ctx.fillStyle = 'rgba(57,135,229,0.13)'; ctx.fillRect(X(2000), y0, X(4000) - X(2000), y1 - y0);
  ctx.fillStyle = '#8fb8f0'; ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.fillText('2–4 kHz', (X(2000) + X(4000)) / 2, y0 + 3);
  ctx.fillText(L('决定亮不亮、传多远', 'brightness & carry'), (X(2000) + X(4000)) / 2, y0 + 16);
  // grid
  ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.fillStyle = THEME.muted; ctx.textBaseline = 'top'; ctx.textAlign = 'center';
  for (let f = 0; f <= FMAX; f += 1000) { ctx.beginPath(); ctx.moveTo(X(f) + 0.5, y0); ctx.lineTo(X(f) + 0.5, y1); ctx.stroke(); ctx.fillText(f ? `${f / 1000} kHz` : '0', X(f), y1 + 4); }
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let d = TOP; d >= BOT; d -= 20) { ctx.beginPath(); ctx.moveTo(x0, Y(d) + 0.5); ctx.lineTo(x1, Y(d) + 0.5); ctx.stroke(); ctx.fillText(`${d}`, x0 - 4, Y(d)); }
  const C = normSpec(cur), R = normSpec(ref);
  const path = (p) => { ctx.beginPath(); p.forEach((v, i) => { const px = X(((i + 0.5) / SPEC_N) * FMAX), py = Y(v); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); };
  if (R) { ctx.setLineDash([5, 3]); ctx.strokeStyle = refColor; ctx.lineWidth = 2; path(R); ctx.stroke(); ctx.setLineDash([]); }
  if (C) {
    path(C); ctx.lineTo(x1, y1); ctx.lineTo(x0, y1); ctx.closePath();
    ctx.fillStyle = 'rgba(47,191,113,0.22)'; ctx.fill();
    ctx.strokeStyle = '#2fbf71'; ctx.lineWidth = 2; path(C); ctx.stroke();
  }
  for (const [i, fm] of formants.slice(0, 3).entries()) {
    if (!(fm.f < FMAX)) continue;
    ctx.fillStyle = THEME.muted; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(`F${i + 1}`, X(fm.f), y1 - 2);
  }
  // the gap in the band
  if (C && R) {
    // the number shown is the judged one when given (frame medians), the arrow the curves'
    const c = maxIn(C, 2000, 4000), r = maxIn(R, 2000, 4000), g = Number.isFinite(gain) ? gain : c - r, xm = X(3000);
    // good: the caller's verdict (e.g. twang, not shouting) overrides the target
    const ok = good != null ? good : target == null ? g >= 0 : g >= target, col = ok ? '#2fbf71' : '#fab219';
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 2;
    for (const yy of [Y(c), Y(r)]) { ctx.beginPath(); ctx.moveTo(xm - 34, yy); ctx.lineTo(xm + 34, yy); ctx.stroke(); }
    ctx.beginPath(); ctx.moveTo(xm, Y(r)); ctx.lineTo(xm, Y(c)); ctx.stroke();
    const tip = (yy, dir) => { ctx.beginPath(); ctx.moveTo(xm, yy); ctx.lineTo(xm - 5, yy + dir * 8); ctx.lineTo(xm + 5, yy + dir * 8); ctx.closePath(); ctx.fill(); };
    if (Math.abs(Y(c) - Y(r)) > 18) tip(Y(c), g > 0 ? 1 : -1);
    ctx.font = 'bold 20px ui-monospace, Menlo, monospace'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`${g >= 0 ? '+' : ''}${g.toFixed(1)} dB`, xm + 40, (Y(c) + Y(r)) / 2);
    if (gainLabel) { ctx.font = THEME.font; ctx.fillText(gainLabel, xm + 40, (Y(c) + Y(r)) / 2 + 18); }
  }
  // legend
  ctx.font = THEME.font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  let lx = x0 + 6;
  const item = (color, text, dashed) => {
    ctx.strokeStyle = color; ctx.lineWidth = 2; if (dashed) ctx.setLineDash([5, 3]);
    ctx.beginPath(); ctx.moveTo(lx, 10); ctx.lineTo(lx + 18, 10); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = THEME.text2; ctx.fillText(text, lx + 22, 10); lx += 30 + ctx.measureText(text).width;
  };
  if (C && curLabel) item('#2fbf71', curLabel);
  if (R && refLabel) item(refColor, refLabel, true);
  if (!C) { ctx.fillStyle = THEME.muted; ctx.textAlign = 'center'; ctx.fillText(L('唱起来就会显示', 'Sing to see it'), (x0 + x1) / 2, (y0 + y1) / 2); }
}

// The gain over time: series [{ t, v }] (last 10 s), with the target line.
export function drawGainStrip(canvas, series, { target = 6, max = 18, label = '' } = {}) {
  const { ctx, w, h } = fit(canvas);
  const x0 = 34, x1 = w - 8, y0 = 14, y1 = h - 14;
  ctx.clearRect(0, 0, w, h);
  const tEnd = series.length ? series[series.length - 1].t : 10, t0 = tEnd - 10;
  const X = (t) => x0 + ((t - t0) / 10) * (x1 - x0), Y = (v) => y1 - (Math.max(0, Math.min(max, v)) / max) * (y1 - y0);
  ctx.strokeStyle = THEME.grid; ctx.beginPath(); ctx.moveTo(x0, y1 + 0.5); ctx.lineTo(x1, y1 + 0.5); ctx.stroke();
  ctx.setLineDash([4, 3]); ctx.strokeStyle = '#8fb8f0'; ctx.beginPath(); ctx.moveTo(x0, Y(target)); ctx.lineTo(x1, Y(target)); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(`${target}`, x0 - 4, Y(target)); ctx.fillText('0', x0 - 4, y1);
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(label, x0 + 4, 0);
  ctx.lineWidth = 2.5;
  for (let i = 1; i < series.length; i++) {
    const a = series[i - 1], b = series[i];
    if (b.t < t0 || b.t - a.t > 0.5 || !Number.isFinite(a.v) || !Number.isFinite(b.v)) continue;
    ctx.strokeStyle = b.v >= target ? '#2fbf71' : '#fab219';
    ctx.beginPath(); ctx.moveTo(X(a.t), Y(a.v)); ctx.lineTo(X(b.t), Y(b.v)); ctx.stroke();
  }
}

// Twang or shouting? x = how much louder than the plain voice (dB), y = how
// much the 2–4 kHz share rose (dB). Zones from analysis/twang.js; the current
// point with its recent trail.
export function drawTwangMap(canvas, { trail = [], ringMin = 6, perDb = 0.8, shoutLoud = 5 } = {}) {
  const { ctx, w, h } = fit(canvas);
  const x0 = 36, x1 = w - 10, y0 = 10, y1 = h - 26, XMIN = -6, XMAX = 18, YMIN = -4, YMAX = 18;
  const X = (v) => x0 + ((Math.max(XMIN, Math.min(XMAX, v)) - XMIN) / (XMAX - XMIN)) * (x1 - x0);
  const Y = (v) => y1 - ((Math.max(YMIN, Math.min(YMAX, v)) - YMIN) / (YMAX - YMIN)) * (y1 - y0);
  ctx.clearRect(0, 0, w, h);
  // zones, filled per cell
  const cols = 60, rows = 40;
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const lx = XMIN + ((i + 0.5) / cols) * (XMAX - XMIN), ry = YMIN + ((j + 0.5) / rows) * (YMAX - YMIN);
    const z = lx >= shoutLoud && ry < perDb * lx ? 'shout' : ry >= ringMin && ry >= perDb * lx ? 'twang' : null;
    if (!z) continue;
    ctx.fillStyle = z === 'twang' ? 'rgba(47,191,113,0.16)' : 'rgba(239,90,90,0.13)';
    const xa = X(XMIN + (i / cols) * (XMAX - XMIN)), xb = X(XMIN + ((i + 1) / cols) * (XMAX - XMIN));
    const ya = Y(YMIN + ((j + 1) / rows) * (YMAX - YMIN)), yb = Y(YMIN + (j / rows) * (YMAX - YMIN));
    ctx.fillRect(xa, ya, xb - xa + 0.5, yb - ya + 0.5);
  }
  // axes
  ctx.strokeStyle = THEME.gridStrong; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0) + 0.5, y0); ctx.lineTo(X(0) + 0.5, y1); ctx.moveTo(x0, Y(0) + 0.5); ctx.lineTo(x1, Y(0) + 0.5); ctx.stroke();
  ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let v = -5; v <= 15; v += 5) ctx.fillText(`${v > 0 ? '+' : ''}${v}`, X(v), y1 + 3);
  ctx.fillText(L('音量比你的普通唱法大了多少（dB）→', 'how much louder than the plain voice (dB) →'), (x0 + x1) / 2, y1 + 14);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= 15; v += 5) ctx.fillText(`${v > 0 ? '+' : ''}${v}`, x0 - 4, Y(v));
  ctx.save(); ctx.translate(10, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(L('穿透力提高了多少（dB）→', 'ring gained (dB) →'), 0, 0); ctx.restore();
  // zone names
  ctx.font = 'bold 13px -apple-system, "PingFang SC", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillStyle = '#6fdc6f'; ctx.fillText(L('咽音', 'Twang'), X(-5), Y(16.5));
  ctx.fillStyle = '#ff8a8a'; ctx.textAlign = 'right'; ctx.fillText(L('喊（主要是变响）', 'Shouting (mostly louder)'), X(17.5), Y(3));
  ctx.fillStyle = THEME.muted; ctx.textAlign = 'left'; ctx.fillText(L('普通', 'Plain'), X(-5), Y(2.5));
  // trail and the current point
  const pts = trail.filter((p) => Number.isFinite(p.ring) && Number.isFinite(p.loud));
  pts.forEach((p, i) => {
    const a = (i + 1) / pts.length, last = i === pts.length - 1;
    ctx.fillStyle = last ? '#ffffff' : `rgba(143,184,240,${0.15 + 0.5 * a})`;
    ctx.beginPath(); ctx.arc(X(p.loud), Y(p.ring), last ? 7 : 3, 0, 2 * Math.PI); ctx.fill();
    if (last) { ctx.strokeStyle = '#3987e5'; ctx.lineWidth = 2.5; ctx.stroke(); }
  });
}

// The plain-voice curve (twang lesson): pitch across, the 2–4 kHz share up
// (harmonic band ratio, smaller = brighter, so the axis runs downwards), with
// the pass line (curve + need) and where the voice is now. During the glide
// itself (no curve yet) the raw points show what has been covered.
// curve: { lo, hi, pts: [{ midi, hbr }] } | null; trail/live: [{ midi, hbr }];
// now: { midi, hbr } | null; good: colour the current point green
export function drawRingCurve(canvas, { curve = null, need = 6, trail = [], live = [], now = null, good = null, range = null } = {}) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const pts = curve?.pts || [];
  const fin = (p) => p && Number.isFinite(p.midi) && Number.isFinite(p.hbr);
  const all = [...pts, ...pts.map((p) => ({ midi: p.midi, hbr: p.hbr - need })), ...trail, ...live, ...(now ? [now] : [])].filter(fin);
  const mLo = curve ? curve.lo - 1 : range ? range[0] : all.length ? Math.min(...all.map((p) => p.midi)) - 1 : 48;
  const mHi = curve ? curve.hi + 1 : range ? range[1] : all.length ? Math.max(...all.map((p) => p.midi)) + 1 : 60;
  const ys = all.map((p) => p.hbr);
  const yTop = ys.length ? Math.min(...ys) - 3 : 0, yBot = ys.length ? Math.max(...ys) + 3 : 40;
  const x0 = 40, x1 = w - 12, y0 = 12, y1 = h - 30;
  const X = (m) => x0 + ((Math.max(mLo, Math.min(mHi, m)) - mLo) / (mHi - mLo || 1)) * (x1 - x0);
  const Y = (v) => y0 + ((Math.max(yTop, Math.min(yBot, v)) - yTop) / (yBot - yTop || 1)) * (y1 - y0);
  // grid: notes across, dB down
  ctx.strokeStyle = THEME.grid; ctx.lineWidth = 1; ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let m = Math.ceil(mLo); m <= mHi; m++) {
    ctx.beginPath(); ctx.moveTo(X(m) + 0.5, y0); ctx.lineTo(X(m) + 0.5, y1); ctx.stroke();
    if ((m - Math.ceil(mLo)) % 2 === 0) ctx.fillText(midiName(m), X(m), y1 + 3);
  }
  ctx.fillText(L('音高 →', 'pitch →'), (x0 + x1) / 2, y1 + 15);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  const step = yBot - yTop > 24 ? 10 : 5;
  for (let v = Math.ceil(yTop / step) * step; v <= yBot; v += step) { ctx.beginPath(); ctx.moveTo(x0, Y(v) + 0.5); ctx.lineTo(x1, Y(v) + 0.5); ctx.stroke(); ctx.fillText(`${v}`, x0 - 4, Y(v)); }
  ctx.save(); ctx.translate(10, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center';
  ctx.fillText(L('2–4 kHz 比低频弱（dB）↑ 越亮', '2–4 kHz below the lows (dB) ↑ brighter'), 0, 0); ctx.restore();
  // the pass zone: above curve + need
  if (pts.length >= 2) {
    ctx.fillStyle = 'rgba(47,191,113,0.12)';
    ctx.beginPath(); ctx.moveTo(X(pts[0].midi), y0);
    pts.forEach((p) => ctx.lineTo(X(p.midi), Y(p.hbr - need)));
    ctx.lineTo(X(pts[pts.length - 1].midi), y0); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#9aa3b5'; ctx.lineWidth = 2; ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p.midi), Y(p.hbr)) : ctx.moveTo(X(p.midi), Y(p.hbr)))); ctx.stroke();
    ctx.strokeStyle = '#2fbf71'; ctx.setLineDash([5, 4]); ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p.midi), Y(p.hbr - need)) : ctx.moveTo(X(p.midi), Y(p.hbr - need)))); ctx.stroke(); ctx.setLineDash([]);
    const e = pts[pts.length - 1];
    ctx.font = THEME.font; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = THEME.text2; ctx.fillText(L('你的普通唱法', 'your plain voice'), X(e.midi) - 4, Y(e.hbr) + 4);
    ctx.fillStyle = '#6fdc6f'; ctx.textBaseline = 'bottom'; ctx.fillText(L(`通过线：多 ${need} dB`, `pass line: +${need} dB`), X(e.midi) - 4, Y(e.hbr - need) - 4);
  }
  // the glide so far, the recent path, and now
  ctx.fillStyle = 'rgba(154,163,181,0.55)';
  for (const p of live.filter(fin)) { ctx.beginPath(); ctx.arc(X(p.midi), Y(p.hbr), 2, 0, 2 * Math.PI); ctx.fill(); }
  const tr_ = trail.filter(fin);
  tr_.forEach((p, i) => { ctx.fillStyle = `rgba(143,184,240,${0.15 + 0.55 * ((i + 1) / tr_.length)})`; ctx.beginPath(); ctx.arc(X(p.midi), Y(p.hbr), 3, 0, 2 * Math.PI); ctx.fill(); });
  if (fin(now)) {
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(X(now.midi), Y(now.hbr), 7, 0, 2 * Math.PI); ctx.fill();
    ctx.strokeStyle = good == null ? '#3987e5' : good ? '#2fbf71' : '#f0b429'; ctx.lineWidth = 3; ctx.stroke();
  }
}

// How the vocal folds close (twang lesson), against the plain voice at the
// same pitch: H1*−H2* change across (left = closing more firmly, right = more
// open), periodicity (CPP) drop down. Zones as in analysis/twang.js closureOf.
// trail: [{ dH, dCpp }]
export function drawClosureMap(canvas, { trail = [], cppMax = 4 } = {}) {
  const { ctx, w, h } = fit(canvas);
  const x0 = 36, x1 = w - 10, y0 = 10, y1 = h - 26, XMIN = -8, XMAX = 10, YMIN = -2, YMAX = 18;
  const X = (v) => x0 + ((Math.max(XMIN, Math.min(XMAX, v)) - XMIN) / (XMAX - XMIN)) * (x1 - x0);
  const Y = (v) => y0 + ((Math.max(YMIN, Math.min(YMAX, v)) - YMIN) / (YMAX - YMIN)) * (y1 - y0);
  ctx.clearRect(0, 0, w, h);
  const zone = (dH, dC) => (dC >= 10 || (dC >= cppMax && dH >= 2) ? 'breathy' : dC >= cppMax ? 'pressed' : 'good');
  const cols = 54, rows = 40, col = { good: 'rgba(47,191,113,0.16)', breathy: 'rgba(240,180,41,0.15)', pressed: 'rgba(239,90,90,0.15)' };
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const xa = XMIN + (i / cols) * (XMAX - XMIN), xb = XMIN + ((i + 1) / cols) * (XMAX - XMIN), ya = YMIN + (j / rows) * (YMAX - YMIN), yb = YMIN + ((j + 1) / rows) * (YMAX - YMIN);
    ctx.fillStyle = col[zone((xa + xb) / 2, (ya + yb) / 2)];
    ctx.fillRect(X(xa), Y(ya), X(xb) - X(xa) + 0.5, Y(yb) - Y(ya) + 0.5);
  }
  ctx.strokeStyle = THEME.gridStrong; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(X(0) + 0.5, y0); ctx.lineTo(X(0) + 0.5, y1); ctx.moveTo(x0, Y(0) + 0.5); ctx.lineTo(x1, Y(0) + 0.5); ctx.stroke();
  ctx.fillStyle = THEME.muted; ctx.font = THEME.font; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let v = -5; v <= 10; v += 5) ctx.fillText(`${v > 0 ? '+' : ''}${v}`, X(v), y1 + 3);
  ctx.fillText(L('← 闭得更紧　H1−H2 比普通唱法（dB）　更松 →', '← firmer   H1−H2 vs plain voice (dB)   looser →'), (x0 + x1) / 2, y1 + 14);
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  for (let v = 0; v <= 15; v += 5) ctx.fillText(`${v}`, x0 - 4, Y(v));
  ctx.save(); ctx.translate(10, (y0 + y1) / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'center'; ctx.fillText(L('周期性下降（dB）↓ 噪声多', 'periodicity drop (dB) ↓ noisier'), 0, 0); ctx.restore();
  ctx.font = 'bold 13px -apple-system, "PingFang SC", sans-serif'; ctx.textBaseline = 'top';
  ctx.fillStyle = '#6fdc6f'; ctx.textAlign = 'right'; ctx.fillText(L('闭合好', 'Closing well'), X(9.5), Y(-1.5));
  ctx.textAlign = 'left';
  ctx.fillStyle = '#ff8a8a'; ctx.fillText(L('挤（紧但不规则）', 'Squeezed (tight, irregular)'), X(-7.5), Y(cppMax + 1.5));
  ctx.fillStyle = '#f0b429'; ctx.textAlign = 'right'; ctx.fillText(L('漏气', 'Air leaking'), X(9.5), Y(cppMax + 1.5));
  const pts = trail.filter((p) => Number.isFinite(p.dH) && Number.isFinite(p.dCpp));
  pts.forEach((p, i) => {
    const last = i === pts.length - 1;
    ctx.fillStyle = last ? '#ffffff' : `rgba(143,184,240,${0.15 + 0.5 * ((i + 1) / pts.length)})`;
    ctx.beginPath(); ctx.arc(X(p.dH), Y(p.dCpp), last ? 7 : 3, 0, 2 * Math.PI); ctx.fill();
    if (last) { ctx.strokeStyle = { good: '#2fbf71', breathy: '#f0b429', pressed: '#ef5a5a' }[zone(p.dH, p.dCpp)]; ctx.lineWidth = 2.5; ctx.stroke(); }
  });
}
