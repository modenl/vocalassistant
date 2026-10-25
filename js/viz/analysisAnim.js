// The song being analysed, shown as it happens (all of it real data): the
// three steps on top (model → separating the vocal → the melody) with the
// device, time taken, time left and speed; the mix's waveform, a beam over
// the stretch Demucs is working on, particles splitting off it into two lanes
// — the vocal and the band — which fill with what Demucs actually separated,
// stretch by stretch; then a scan along the vocal while MELODIA follows it,
// and the melody's notes appearing. Fixed size; runs on requestAnimationFrame
// while shown.
//   const a = new AnalysisAnim(canvas); a.setSong(x, sr); a.start();
//   a.update({ stage, progress, device, part, bytes, total }); a.melody(notes); a.stop();
// A song heard from a web player first: a.capturing(secs, scale) and a.feed(block, sr)
// as it comes in (step 0, "recording"), then setSong(x, sr, { scale, keep: true }).
// scale: song seconds per second of x (1.5 when it was played at 1.5×).

import { fit, THEME } from './common.js';
import { L } from '../i18n.js';
import { ALONG_COLORS } from './along.js';

const SANS = '-apple-system, "PingFang SC", sans-serif', MONO = 'ui-monospace, Menlo, monospace';
const VOX = ALONG_COLORS.ref, BAND = '#a58fd8', MIX = '#7d8699';
const SEG = 343980 / 44100, STRIDE = SEG * 0.75; // Demucs' 7.8 s stretches, 25 % overlap
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export class AnalysisAnim {
  constructor(canvas) {
    this.cv = canvas; this.raf = 0;
    this.reset();
  }

  reset() {
    this.capture = false; this.scale = 1;
    this.stage = 'prepare'; this.progress = 0; this.device = ''; this.t0 = performance.now();
    this.sepT0 = 0; this.segT = []; this.lastSegAt = 0; this.done = 0; this.total = 1;
    this.vox = null; this.band = null; this.particles = []; this.notes = null; this.notesAt = 0;
    this.bytes = 0; this.bytesTotal = 0; this.stageAt = { prepare: performance.now() };
  }

  // a song being recorded: secs (of the recording) expected — null when the
  // length isn't known (a player the page can't ask): the axis then grows with
  // it — played `scale`× fast
  capturing(secs, scale = 1) {
    this.reset();
    this.capture = true; this.scale = scale; this.stage = 'capture'; this.stageAt.capture = performance.now();
    this.open = !secs; this.secs = secs || 60;
    const room = this.open ? 20 * 60 : secs; // seconds of room
    this.bin = 480; this.mix = new Float32Array(Math.ceil(room * 100) + 1); this.norm = 4; this.got = 0; this.fed = 0;
    this.vox = new Float32Array(this.mix.length); this.band = new Float32Array(this.mix.length); this.filled = new Uint8Array(this.mix.length);
  }

  // recorded samples as they come in (at sr): the waveform grows
  feed(block, sr) {
    if (!this.capture || this.stage !== 'capture') return;
    const bin = sr / 100;
    for (let i = 0; i < block.length; i++) {
      const j = Math.floor((this.fed + i) / bin);
      if (j >= this.mix.length) break;
      const a = Math.abs(block[i]); if (a > this.mix[j]) this.mix[j] = a;
      if (a * this.norm > 1) this.norm = 1 / a;
    }
    this.fed += block.length; this.got = this.fed / sr;
    if (this.open) this.secs = Math.max(60, this.got + 20);
  }

  // the song (mono samples): its waveform as peaks per 10 ms
  setSong(x, sr = 44100, { scale = 1, keep = false } = {}) {
    const was = keep ? { t0: this.t0, stageAt: this.stageAt, capture: this.capture } : null;
    this.reset();
    if (was) { this.t0 = was.t0; this.stageAt = was.stageAt; this.capture = was.capture; }
    this.scale = scale;
    this.secs = x.length / sr; this.bin = Math.round(sr / 100);
    const n = Math.ceil(x.length / this.bin), env = new Float32Array(n);
    for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]), j = (i / this.bin) | 0; if (a > env[j]) env[j] = a; }
    let top = 1e-6; for (const v of env) top = Math.max(top, v);
    this.mix = env; this.norm = 1 / top;
    this.vox = new Float32Array(n); this.band = new Float32Array(n); this.filled = new Uint8Array(n);
    this.total = Math.max(1, Math.ceil(Math.max(0, this.secs - SEG) / STRIDE) + 1);
  }

  update({ stage, progress, device, part, bytes, total }) {
    const now = performance.now();
    if (stage && stage !== this.stage) { this.stage = stage; this.stageAt[stage] = now; if (stage === 'separate' && !this.sepT0) { this.sepT0 = now; this.lastSegAt = now; } }
    if (stage === 'load' && !this.sepT0) { this.sepT0 = 0; }
    if (progress != null) this.progress = progress;
    if (device) this.device = device;
    if (bytes != null) { this.bytes = bytes; this.bytesTotal = total; }
    if (part && this.vox) {
      // this stretch's vocal and band (the overlap: the newer one)
      const j0 = Math.round(part.start / this.bin);
      for (let k = 0; k < part.ve.length && j0 + k < this.vox.length; k++) { this.vox[j0 + k] = part.ve[k]; this.band[j0 + k] = part.be[k]; this.filled[j0 + k] = 1; }
      this.done++; this.segT.push(now - this.lastSegAt); this.lastSegAt = now;
    }
  }

  // step 3 over: the melody's notes ([{ t0, t1, midi }]) appear along the vocal
  melody(notes) { this.notes = notes; this.notesAt = performance.now(); this.stage = 'done'; }

  start() {
    cancelAnimationFrame(this.raf);
    // 30 frames a second, and no canvas shadows: the GPU is Demucs's meanwhile
    let last = 0;
    const tick = (t) => { if (t - last >= 32) { last = t; this.draw(); } this.raf = requestAnimationFrame(tick); };
    this.raf = requestAnimationFrame(tick);
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  draw() {
    const { ctx, w, h } = fit(this.cv), now = performance.now();
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#11151f'); bg.addColorStop(1, '#0c0f16');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    this.drawSteps(ctx, w, now);
    if (!this.mix) return;
    const x0 = 64, x1 = w - 14, lanes = [
      { key: 'mix', y: 114, hh: 32, color: MIX, label: L('原曲', 'Song'), sub: L('混音', 'mix') },
      { key: 'vox', y: 202, hh: 28, color: VOX, label: L('人声', 'Vocal'), sub: 'Demucs' },
      { key: 'band', y: 268, hh: 26, color: BAND, label: L('伴奏', 'Band'), sub: L('其余', 'the rest') },
    ];
    const X = (t) => x0 + (t / this.secs) * (x1 - x0), n = this.mix.length, cols = Math.max(1, Math.floor(x1 - x0));
    // the stretch being worked on, and the beam sweeping it
    const sep = this.stage === 'separate', segIdx = Math.min(this.done, this.total - 1);
    const avg = this.segT.length ? this.segT.reduce((a, b) => a + b, 0) / this.segT.length : 2500;
    const segA = segIdx * STRIDE, segB = Math.min(this.secs, segA + SEG);
    const beamT = sep ? Math.min(segB, segA + Math.min(1, (now - this.lastSegAt) / avg) * (segB - segA)) : this.stage === 'done' || this.stage === 'melody' ? this.secs : 0;
    if (sep) {
      const g = ctx.createLinearGradient(X(segA), 0, X(segB), 0);
      g.addColorStop(0, 'rgba(91,156,240,0)'); g.addColorStop(0.5, 'rgba(91,156,240,0.10)'); g.addColorStop(1, 'rgba(91,156,240,0)');
      ctx.fillStyle = g; ctx.fillRect(X(segA), 78, X(segB) - X(segA), h - 104);
    }
    for (const ln of lanes) {
      ctx.fillStyle = THEME.text; ctx.font = `bold 12px ${SANS}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(ln.label, x0 - 10, ln.y - 2);
      ctx.fillStyle = THEME.muted; ctx.font = `10.5px ${SANS}`; ctx.fillText(ln.sub, x0 - 10, ln.y + 12);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'; ctx.beginPath(); ctx.moveTo(x0, ln.y + 0.5); ctx.lineTo(x1, ln.y + 0.5); ctx.stroke();
      const src = ln.key === 'mix' ? this.mix : ln.key === 'vox' ? this.vox : this.band;
      for (let c = 0; c < cols; c++) {
        const a = Math.floor((c / cols) * n), b = Math.max(a + 1, Math.floor(((c + 1) / cols) * n));
        let v = 0, have = ln.key === 'mix';
        for (let j = a; j < b; j++) { if (src[j] > v) v = src[j]; if (!have && this.filled[j]) have = true; }
        if (!have) continue;
        const amp = Math.min(1, Math.sqrt(v * this.norm)) * ln.hh;
        const t = (c / cols) * this.secs;
        // the mix dims behind the beam: what's been separated has left it
        ctx.fillStyle = ln.key === 'mix' ? (t < beamT && sep ? 'rgba(125,134,153,0.35)' : 'rgba(125,134,153,0.8)') : ln.color;
        ctx.globalAlpha = ln.key === 'mix' ? 1 : ln.key === 'vox' && this.notes ? 0.35 : 0.85;
        ctx.fillRect(x0 + c, ln.y - amp, 1, 2 * amp);
      }
      ctx.globalAlpha = 1;
    }
    if (sep) this.drawBeam(ctx, X(beamT), lanes, now, h, Math.floor((beamT / this.secs) * n));
    if (this.stage === 'capture') this.drawRec(ctx, X(Math.min(this.secs, this.got)), lanes[0], now);
    this.drawParticles(ctx, now);
    if (this.stage === 'melody') this.drawScan(ctx, x0, x1, lanes[1], now);
    if (this.notes) this.drawNotes(ctx, X, lanes[1], now);
    // the time axis
    ctx.fillStyle = THEME.muted; ctx.font = `10px ${MONO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = this.secs * this.scale > 240 ? 60 : this.secs * this.scale > 90 ? 30 : 10;
    // the song's own time (a recording at 1.5× covers 1.5 s of song per second)
    const songSecs = this.secs * this.scale;
    for (let t = 0; t <= songSecs; t += step) ctx.fillText(`${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`, X(t / this.scale), h - 14);
  }

  drawSteps(ctx, w, now) {
    const order = [...(this.capture ? ['capture'] : []), 'prepare', 'separate', 'melody'], cur = this.stage === 'download' || this.stage === 'load' ? 'prepare' : this.stage === 'done' ? 'end' : this.stage;
    const N = order.length, idx = cur === 'end' ? N : order.indexOf(cur);
    const names = [...(this.capture ? [this.scale === 1 ? L('录下原曲', 'Record the song') : L(`${this.scale} 倍速录下原曲`, `Record at ${this.scale}×`)] : []), L('载入分离模型', 'Load the model'), L('分离人声与伴奏', 'Separate vocal / band'), L('提取原唱旋律', 'Extract the melody')];
    const subs = [...(this.capture ? [this.open ? `${fmt(this.got)}` : `${fmt(this.got * this.scale)} / ${fmt(this.secs * this.scale)}`] : []),
      this.stage === 'download' && this.bytesTotal ? `${(this.bytes / 1e6).toFixed(0)} / ${(this.bytesTotal / 1e6).toFixed(0)} MB` : 'Demucs v4 · htdemucs',
      this.device ? `${this.device === 'webgpu' ? 'WebGPU' : 'CPU'} · ${this.done}/${this.total} ${L('段', 'parts')}` : `${this.total} × 7.8 s`,
      'MELODIA · Essentia.js',
    ];
    const pw = Math.min(250, (w - 40) / N), gap = (w - N * pw) / (N + 1);
    for (let i = 0; i < N; i++) {
      const x = gap + i * (pw + gap), y = 12, active = i === idx, done = i < idx;
      if (i < N - 1) { ctx.strokeStyle = done ? 'rgba(111,220,111,0.6)' : 'rgba(255,255,255,0.12)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x + pw + 4, y + 20); ctx.lineTo(x + pw + gap - 4, y + 20); ctx.stroke(); }
      ctx.fillStyle = active ? 'rgba(91,156,240,0.14)' : 'rgba(255,255,255,0.03)'; ctx.strokeStyle = active ? `rgba(91,156,240,${0.55 + 0.35 * Math.sin(now / 260)})` : done ? 'rgba(111,220,111,0.45)' : 'rgba(255,255,255,0.08)';
      ctx.lineWidth = active ? 1.6 : 1; ctx.beginPath(); ctx.roundRect(x, y, pw, 40, 8); ctx.fill(); ctx.stroke();
      // the step's own progress along its bottom edge
      const step = order[i];
      const p = done ? 1 : active ? (step === 'capture' ? (this.open ? (now / 1400) % 1 : Math.min(1, this.got / this.secs)) : step === 'prepare' ? (this.stage === 'download' ? this.progress : this.stage === 'load' ? 0.5 + 0.5 * Math.sin(now / 300) ** 2 : 0) : step === 'separate' ? this.progress : (now / 1400) % 1) : 0;
      if (p > 0) { ctx.fillStyle = done ? '#6fdc6f' : VOX; ctx.fillRect(x + 8, y + 36, (pw - 16) * p, 2); }
      ctx.fillStyle = done ? '#6fdc6f' : active ? VOX : THEME.muted; ctx.beginPath(); ctx.arc(x + 18, y + 20, 9, 0, 2 * Math.PI); ctx.fill();
      ctx.fillStyle = '#0c0f16'; ctx.font = `bold 11px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(done ? '✓' : String(i + 1), x + 18, y + 20.5);
      ctx.fillStyle = active || done ? THEME.text : THEME.text2; ctx.font = `bold ${pw >= 150 ? 12.5 : 11}px ${SANS}`; ctx.textAlign = 'left'; ctx.textBaseline = pw >= 150 ? 'alphabetic' : 'middle'; ctx.fillText(names[i], x + 32, pw >= 150 ? y + 17 : y + 20, pw - 38);
      if (pw >= 150) { ctx.fillStyle = THEME.muted; ctx.font = `10.5px ${MONO}`; ctx.fillText(subs[i], x + 34, y + 31); }
    }
    // time taken, left, speed
    const el = (now - this.t0) / 1000;
    let right = L(`已用 ${el.toFixed(0)} 秒`, `${el.toFixed(0)} s so far`);
    if (this.stage === 'capture' && !this.open) right += L(` · 录音还剩约 ${Math.max(0, Math.ceil(this.secs - this.got))} 秒`, ` · about ${Math.max(0, Math.ceil(this.secs - this.got))} s of recording left`);
    if (this.stage === 'separate' && this.done > 0) {
      const per = this.segT.reduce((a, b) => a + b, 0) / this.segT.length / 1000, left = per * (this.total - this.done);
      right += L(` · 还剩约 ${Math.ceil(left)} 秒 · ${(STRIDE / per).toFixed(1)}× 实时`, ` · about ${Math.ceil(left)} s left · ${(STRIDE / per).toFixed(1)}× realtime`);
    }
    ctx.fillStyle = THEME.text2; ctx.font = `11px ${MONO}`; ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic'; ctx.fillText(right, w - 14, 68);
  }

  // recording: a red head where the sound is coming in
  drawRec(ctx, x, ln, now) {
    const a = 0.6 + 0.4 * Math.sin(now / 180);
    ctx.strokeStyle = `rgba(239,90,90,${0.3 * a})`; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(x, ln.y - ln.hh - 10); ctx.lineTo(x, ln.y + ln.hh + 10); ctx.stroke();
    ctx.strokeStyle = `rgba(239,90,90,${a})`; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, ln.y - ln.hh - 10); ctx.lineTo(x, ln.y + ln.hh + 10); ctx.stroke();
    ctx.fillStyle = `rgba(239,90,90,${a})`; ctx.beginPath(); ctx.arc(x + 10, ln.y - ln.hh - 6, 4, 0, 2 * Math.PI); ctx.fill();
    ctx.font = `bold 10.5px ${MONO}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText('REC', x + 17, ln.y - ln.hh - 6);
  }

  // the beam over the mix, and the sound splitting off it
  drawBeam(ctx, bx, lanes, now, h, j) {
    const g = ctx.createLinearGradient(bx - 18, 0, bx + 2, 0);
    g.addColorStop(0, 'rgba(91,156,240,0)'); g.addColorStop(1, 'rgba(150,200,255,0.55)');
    ctx.fillStyle = g; ctx.fillRect(bx - 18, 78, 20, h - 104);
    ctx.strokeStyle = 'rgba(91,156,240,0.35)'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(bx, 78); ctx.lineTo(bx, h - 26); ctx.stroke();
    ctx.strokeStyle = 'rgba(200,225,255,0.95)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bx, 78); ctx.lineTo(bx, h - 26); ctx.stroke();
    // particles: as many as the song is loud here; up to the vocal or down to the band
    const loud = Math.min(1, Math.sqrt((this.mix[Math.max(0, Math.min(this.mix.length - 1, j))] || 0) * this.norm));
    const born = Math.random() < 0.35 + 0.6 * loud ? 1 + (loud > 0.5 ? 1 : 0) : 0;
    for (let k = 0; k < born; k++) {
      const toVox = Math.random() < 0.5, target = toVox ? lanes[1] : lanes[2];
      this.particles.push({ x: bx, y: lanes[0].y + (Math.random() - 0.5) * 30, tx: bx - 6 - Math.random() * 40, ty: target.y + (Math.random() - 0.5) * target.hh, t0: now, life: 700 + Math.random() * 500, color: toVox ? VOX : BAND });
    }
  }

  drawParticles(ctx, now) {
    this.particles = this.particles.filter((p) => now - p.t0 < p.life);
    for (const p of this.particles) {
      const u = (now - p.t0) / p.life, e = 1 - (1 - u) ** 3, x = p.x + (p.tx - p.x) * e, y = p.y + (p.ty - p.y) * e;
      ctx.globalAlpha = 0.85 * (1 - u * u); ctx.fillStyle = p.color; ctx.beginPath(); ctx.arc(x, y, 1.8, 0, 2 * Math.PI); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // MELODIA following the vocal: a scan sweeping it
  drawScan(ctx, x0, x1, ln, now) {
    const u = ((now - (this.stageAt.melody || now)) / 1600) % 1, x = x0 + u * (x1 - x0);
    const g = ctx.createLinearGradient(x - 60, 0, x, 0); g.addColorStop(0, 'rgba(240,180,41,0)'); g.addColorStop(1, 'rgba(240,180,41,0.35)');
    ctx.fillStyle = g; ctx.fillRect(x - 60, ln.y - ln.hh - 8, 60, 2 * ln.hh + 16);
    ctx.strokeStyle = 'rgba(255,215,120,0.9)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(x, ln.y - ln.hh - 8); ctx.lineTo(x, ln.y + ln.hh + 8); ctx.stroke();
  }

  // the melody found: notes rising into place over the vocal, left to right
  drawNotes(ctx, X, ln, now) {
    const ns = this.notes; if (!ns.length) return;
    let lo = Infinity, hi = -Infinity; for (const n of ns) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    const span = Math.max(6, hi - lo), top = ln.y - ln.hh - 2, bot = ln.y + ln.hh - 2, el = now - this.notesAt;
    for (const n of ns) {
      const d = Math.max(0, Math.min(1, (el - (n.t0 / this.secs) * 900) / 250));
      if (d <= 0) continue;
      const y = bot - ((n.midi - lo) / span) * (bot - top) + (1 - d) * 10;
      ctx.globalAlpha = 0.3 * d; ctx.fillStyle = '#f0b429';
      ctx.fillRect(X(n.t0) - 1, y - 4, Math.max(2, X(n.t1) - X(n.t0)) + 2, 8);
      ctx.globalAlpha = d; ctx.fillStyle = '#f0c75e';
      ctx.fillRect(X(n.t0), y - 2, Math.max(2, X(n.t1) - X(n.t0)), 4);
    }
    ctx.globalAlpha = 1;
  }
}
