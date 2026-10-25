// History: past takes with their five-dimension report, full pitch trace and audio playback.

import { listSessions, getSession, getAudio, deleteSession, saveSession } from '../store/db.js';
import { STATUS, SingingMetrics, DIMS } from '../analysis/metrics.js';
import { VOICE_TYPES } from '../config.js';
import { PitchTrack, fmtT } from '../viz/pitchTrack.js';
import { dimsHtml, reportHtml, progressHtml, stripPoints, marksOf, scoreColor } from './live.js';
import { L, locale } from '../i18n.js';
import { FrameAnalyzer } from '../dsp/analyzer.js';
import { PitchTracker } from '../analysis/pitch.js';

// default take names were saved in the language of the day
const NAMES = { '麦克风演唱': 'Microphone take', '导入的录音': 'Imported recording' };
const nameOf = (r) => { const n = r.name || ''; return L(Object.entries(NAMES).find(([, en]) => en === n)?.[0] || n, NAMES[n] || n); };

// Takes recorded before the pitch tracker followed harmonics through room
// noise (pitchV 2) lost much of the voice, and before pitchV 3 no spectrum was
// kept for resonance, before pitchV 4 no voice-only level, before pitchV 5 no
// mark for pitches far below the voice type (accompaniment): with the recording
// kept, the track is rebuilt from the audio, on the analysis clock (audio + offset).
const PITCH_V = 5;
async function retrack(rec, blob, settings) {
  const buf = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(await blob.arrayBuffer());
  // older takes didn't store where the recording starts on the analysis clock
  if (rec.audioOffset == null && rec.source !== 'file') { const d = rec.duration - buf.duration; rec.audioOffset = d > 0.05 && d < 5 ? d : 0; }
  const x = buf.getChannelData(0), sr = buf.sampleRate, off = rec.audioOffset ?? 0;
  const an = new FrameAnalyzer(sr), pt = new PitchTracker(settings), t = [], midi = [], db = [], spr = [], hiPk = [], hiMed = [], vdb = [], out = [];
  for (let end = an.N; end <= x.length; end += 1024) {
    const tt = (end - an.N / 2) / sr, st = pt.update(an.analyze(x.subarray(end - an.N, end), { gateDb: settings.gateDb, pitchOnly: true }), tt);
    t.push(tt + off); midi.push(st.voiced ? st.midi : NaN); db.push(st.db);
    spr.push(st.voiced ? st.spr : NaN); hiPk.push(st.voiced ? st.hiPk : NaN); hiMed.push(st.hiMed); vdb.push(st.voiced ? st.vdb : NaN); out.push(st.outside ? 1 : 0);
    if (t.length % 500 === 0) await new Promise((ok) => setTimeout(ok, 0)); // keep the page responsive
  }
  rec.frames = { t, midi, db, spr, hiPk, hiMed, vdb, out };
  rec.pitchV = PITCH_V;
}

// Re-run the current measures on a record's stored pitch/level track, so older
// records follow the current rules (five dimensions, fewer false breaks).
// Returns the full summary (with per-note points for the trace markers).
function reanalyze(rec) {
  const m = new SingingMetrics(), F = rec.frames;
  for (let i = 0; i < F.t.length; i++) {
    const midi = F.midi[i], voiced = Number.isFinite(midi);
    m.push({ t: F.t[i], voiced, midi: voiced ? midi : NaN, raw: voiced ? midi : NaN, db: F.db[i], spr: F.spr?.[i], hiPk: F.hiPk?.[i], hiMed: F.hiMed?.[i], vdb: F.vdb?.[i], outside: !!F.out?.[i] });
  }
  const full = m.finish(), S = stripPoints(full);
  const breaks = m.breaks.map((b) => ({ t: b.t, from: b.from, to: b.to }));
  const changed = JSON.stringify(S) !== JSON.stringify(rec.summary) || breaks.length !== (rec.breaks || []).length;
  rec.summary = S;
  rec.breaks = breaks;
  rec.notes = m.notes.map(({ t0, t1, target, cents, db, steady }) => ({ t0, t1, target, cents, db, steady }));
  return { changed, full };
}

// total score + one dot per dimension
const dotsHtml = (S) => (S.dims?.resonance
  ? `<b class="mono" style="color:${scoreColor(S.total)}">${S.total ?? '—'}</b>${DIMS.map((d) => { const D = S.dims[d.key]; return `<span title="${d.title}${L('：', ': ')}${D.score ?? L('数据不足', 'not enough data')}" style="background:${STATUS[D.status].color}"></span>`; }).join('')}`
  : `<span class="muted" style="font-size:11px">${L('更新中…', 'updating…')}</span>`);

export class HistoryView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
  }

  // Pause and release the playing recording (switching record or leaving the tab).
  stop() {
    cancelAnimationFrame(this.raf);
    const a = this.audio;
    this.audio = null;
    if (a) { a.pause(); URL.revokeObjectURL(a.src); a.removeAttribute('src'); a.load(); }
  }

  async show(id) {
    this.stop();
    const all = await listSessions();
    const recs = all.filter((r) => r.version === 2);
    const old = all.length - recs.length;
    if (!recs.length) {
      this.app.route(['history']);
      this.root.innerHTML = `<div class="empty" style="padding:40px">${L('还没有记录。在“唱一段看问题”里唱完一段，就会保存在这里。', 'No takes yet. Sing something on “Sing & check” and it will be saved here.')}</div>${old ? this.oldHtml(old) : ''}`;
      this.bindOld(all);
      return;
    }
    const cur = recs.find((r) => r.id === id) || recs[0];
    this.app.route(['history', cur.id], { replace: !id });
    this.root.innerHTML = `<div class="hist-layout">
      <div class="panel"><div class="ph"><h3>${L('记录', 'Takes')}</h3><span class="sub">${recs.length}</span></div>
        <div class="sess-list">${recs.map((r) => `<div class="sess-item ${r.id === cur.id ? 'active' : ''}" data-id="${r.id}">
          <div class="top"><b>${new Date(r.createdAt).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</b><span class="muted">${fmtT(r.duration)}</span></div>
          <div class="muted" style="font-size:12px">${esc(nameOf(r))}${r.summary.range ? ` · ${r.summary.range.loName}–${r.summary.range.hiName}` : ''}</div>
          <div class="dots">${dotsHtml(r.summary)}</div>
        </div>`).join('')}</div>${old ? this.oldHtml(old) : ''}</div>
      <div id="histDetail"></div></div>`;
    this.root.querySelectorAll('.sess-item').forEach((el) => { el.onclick = () => this.show(el.dataset.id); });
    this.bindOld(all);
    await this.detail(await getSession(cur.id));
    this.upgrade(recs.filter((r) => !r.summary.dims?.resonance && r.id !== cur.id));
  }

  // records saved before the five dimensions: re-analysed one by one in the background
  async upgrade(list) {
    for (const r of list) {
      await new Promise((ok) => setTimeout(ok, 30));
      const el = this.root.querySelector(`.sess-item[data-id="${r.id}"] .dots`);
      if (!el) return; // the page changed
      reanalyze(r);
      saveSession(r).catch(() => {});
      el.innerHTML = dotsHtml(r.summary);
    }
  }

  oldHtml(n) {
    return `<p class="muted" style="font-size:12px;margin-top:10px">${L(`另有 ${n} 条旧版本的记录（格式已不兼容）。`, `${n} more take${n > 1 ? 's' : ''} from an older version (incompatible format). `)}<button class="btn" id="delOld">${L('删除旧记录', 'Delete old takes')}</button></p>`;
  }

  bindOld(all) {
    const b = this.root.querySelector('#delOld');
    if (b) b.onclick = async () => {
      if (!confirm(L('删除所有旧版本的记录（包括录音）？', 'Delete all takes from the older version (including audio)?'))) return;
      for (const r of all.filter((x) => x.version !== 2)) await deleteSession(r.id);
      this.show();
    };
  }

  async detail(rec) {
    this.stop();
    const el = this.root.querySelector('#histDetail');
    const blob = rec.hasAudio ? await getAudio(rec.id) : null;
    const retracked = blob && (rec.pitchV || 1) < PITCH_V;
    if (retracked) {
      el.innerHTML = `<div class="panel empty">${L('正在用新的音高识别重新分析这段录音…', 'Re-analysing this recording with the new pitch tracking…')}</div>`;
      try { await retrack(rec, blob, this.app.settings); } catch { rec.pitchV = PITCH_V; /* undecodable: keep the stored track */ }
      if (!el.isConnected) return;
    }
    const { changed, full } = reanalyze(rec);
    if (changed || retracked) saveSession(rec).catch(() => {});
    const item = this.root.querySelector(`.sess-item[data-id="${rec.id}"] .dots`);
    if (item) item.innerHTML = dotsHtml(rec.summary);
    const S = rec.summary;
    el.innerHTML = `<div class="panel">
        <div class="ph"><h3>${esc(nameOf(rec))}</h3><span class="sub">${new Date(rec.createdAt).toLocaleString(locale())} · ${fmtT(rec.duration)} · ${L('声部', 'voice')} ${VOICE_TYPES[rec.voiceType]?.name || ''}${S.range ? ` · ${L('音域', 'range')} ${S.range.loName}–${S.range.hiName}` : ''}</span>
          <button class="btn" id="dlRec" style="margin-left:auto">${L('⬇ 下载录音', '⬇ Download audio')}</button>
          <button class="btn danger" id="delRec">${L('删除', 'Delete')}</button></div>
        <div id="audioBox"></div>
        <canvas class="viz" id="histTrace" style="height:280px"></canvas>
        <p class="muted" style="font-size:12px;margin:4px 0 0">${L('点击轨迹可以跳到那个位置播放。绿 = 准 · 黄 = 略偏 · 红 = 不准 · 灰 = 滑音 · ⚡ = 断档 · ↘ = 句尾掉音 · ↗ = 挑音', 'Click the trace to play from there. Green = in tune · amber = slightly off · red = off · grey = glide · ⚡ = break · ↘ = phrase end sank · ↗ = scoop')}</p>
      </div>
      <div class="panel" style="margin-top:12px"><div class="ph"><h3>${L('这次最需要练的', 'What to practise most')}</h3></div>${reportHtml(S)}</div>
      <div class="ph" style="margin-top:14px"><h3>${L('五维评分', 'Five-dimension score')}</h3><span class="sub">${DIMS.map((d) => d.title).join(' · ')}</span></div>
      ${S.total == null ? `<p class="warn-title" style="font-size:14px;margin:0 0 6px">${L('这次唱得不够，还不能出总分', 'Not enough singing in this take for a total score')}</p>${progressHtml(S)}` : ''}
      ${dimsHtml(S)}`;
    el.addEventListener('click', (e) => { const b = e.target.closest('[data-lesson]'); if (b) this.app.showTab('lessons', b.dataset.lesson); });
    el.querySelector('#delRec').onclick = async () => { if (confirm(L('删除这条记录？', 'Delete this take?'))) { await deleteSession(rec.id); this.show(); } };

    const F = rec.frames, data = { t: Array.from(F.t), midi: Array.from(F.midi) };
    const finite = data.midi.filter(Number.isFinite);
    const lo = finite.length ? Math.floor(Math.min(...finite)) - 1 : 48, hi = finite.length ? Math.ceil(Math.max(...finite)) + 1 : 72;
    let audio = null;
    const marks = marksOf(full);
    // the recording may start later than the analysis clock (microphone warm-up):
    // audio time = analysis time − off. Older takes didn't store it: estimated
    // from the lengths once the audio is decoded.
    let off = rec.audioOffset ?? 0;
    const track = new PitchTrack(el.querySelector('#histTrace'), { onSeek: (t) => { if (audio) { audio.currentTime = Math.max(0, t - off); audio.play(); } } });
    const draw = (ph) => track.draw(data, { t0: 0, t1: Math.max(rec.duration, 1), lo, hi, offset: S.intonation.offset || 0, breaks: rec.breaks, marks, playhead: ph });
    draw();
    el.querySelector('#dlRec').style.display = rec.hasAudio ? '' : 'none';
    if (rec.hasAudio) {
      const dl = el.querySelector('#dlRec');
      if (blob) {
        dl.onclick = () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          const d = new Date(rec.createdAt), p2 = (n) => String(n).padStart(2, '0'); // local time, as shown in the list
          a.download = `vocallab-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}-${p2(d.getMinutes())}.${/mp4/.test(blob.type) ? 'm4a' : /wav/.test(blob.type) ? 'wav' : /ogg/.test(blob.type) ? 'ogg' : 'webm'}`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        };
      }
      if (blob && el.isConnected) {
        audio = document.createElement('audio');
        audio.controls = true;
        audio.src = URL.createObjectURL(blob);
        el.querySelector('#audioBox').appendChild(audio);
        this.audio = audio;
        const loop = () => { draw(audio.currentTime + off); if (!audio.paused && this.audio === audio) this.raf = requestAnimationFrame(loop); };
        audio.onplay = () => { cancelAnimationFrame(this.raf); loop(); };
        audio.onseeked = () => draw(audio.currentTime + off);
        if (rec.audioOffset == null && rec.source !== 'file') {
          try {
            const ctx = new OfflineAudioContext(1, 1, 44100);
            const len = (await ctx.decodeAudioData(await blob.arrayBuffer())).duration;
            const d = rec.duration - len;
            if (d > 0.05 && d < 5) { off = d; rec.audioOffset = d; saveSession(rec).catch(() => {}); }
          } catch { /* keep 0 */ }
        }
      }
    }
  }
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
