// "唱一段看问题": live pitch trace, the five dimensions, and a short report at the end.

import { AudioEngine } from '../audio/engine.js';
import { FrameAnalyzer } from '../dsp/analyzer.js';
import { PitchTracker } from '../analysis/pitch.js';
import { SingingMetrics, STATUS, DIMS, CHECKS, wrapCents } from '../analysis/metrics.js';
import { VOICE_TYPES } from '../config.js';
import { PitchTrack, fmtT, TUNE, tuneClass } from '../viz/pitchTrack.js';
import { fit, THEME } from '../viz/common.js';
import { lessonById } from '../lessons/lessons.js';
import { saveSession, saveAudio } from '../store/db.js';
import { L } from '../i18n.js';

const $ = (id) => document.getElementById(id);
const SPAN = 12;

export const scoreColor = (s) => (s == null ? THEME.muted : s >= 90 ? '#2fbf71' : s >= 75 ? '#8bd46a' : s >= 60 ? '#f0b429' : '#ef5a5a');

// Radar of the five dimensions. Rings at 60 (passing) and 75 (good); a
// dimension without enough data has no vertex (its axis is dashed, label "—").
export function radarSvg(S) {
  const cx = 130, cy = 116, R = 78, n = DIMS.length;
  const ang = (i) => ((-90 + (360 / n) * i) * Math.PI) / 180;
  const at = (i, r) => [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))];
  const ring = (f) => DIMS.map((_, i) => at(i, R * f).map((v) => v.toFixed(1)).join(',')).join(' ');
  const pts = DIMS.map((d, i) => ({ d, i, s: S.dims?.[d.key]?.score })).filter((p) => p.s != null);
  const poly = pts.map((p) => at(p.i, (R * Math.max(4, p.s)) / 100).map((v) => v.toFixed(1)).join(',')).join(' ');
  return `<svg class="radar" viewBox="0 0 260 236" role="img" aria-label="${L('五维评分雷达图', 'Five-dimension radar')}">
    <polygon points="${ring(1)}" class="rg"/><polygon points="${ring(0.75)}" class="rg"/><polygon points="${ring(0.6)}" class="rg r60"/>
    ${DIMS.map((d, i) => { const [x, y] = at(i, R); const miss = S.dims?.[d.key]?.score == null; return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="ax${miss ? ' miss' : ''}"/>`; }).join('')}
    <text x="${cx + 3}" y="${(cy - R * 0.6 + 11).toFixed(1)}" class="rl">60</text><text x="${cx + 3}" y="${(cy - R * 0.75 + 11).toFixed(1)}" class="rl">75</text>
    ${DIMS.map((d, i) => { const D = S.dims?.[d.key]; if (!D || D.score != null || D.blocked || !D.progress) return ''; const [x, y] = at(i, R * D.progress); return `<line x1="${cx}" y1="${cy}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" class="axp"/>`; }).join('')}
    ${pts.length >= 3 ? `<polygon points="${poly}" class="rp"/>` : ''}
    ${pts.map((p) => { const [x, y] = at(p.i, (R * Math.max(4, p.s)) / 100); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" class="rv"><title>${p.d.title} ${p.s}</title></circle>`; }).join('')}
    ${DIMS.map((d, i) => {
      const [x, y] = at(i, R + 20), D = S.dims?.[d.key], s = D?.score;
      const anchor = Math.abs(x - cx) < 8 ? 'middle' : x > cx ? 'start' : 'end';
      const sub = s != null ? s : !D ? '—' : D.blocked ? L('无法判断', 'can’t judge') : L(`收集中 ${Math.round(D.progress * 100)}%`, `collecting ${Math.round(D.progress * 100)}%`);
      return `<text x="${x.toFixed(1)}" y="${(y - 2).toFixed(1)}" text-anchor="${anchor}" class="rt">${d.title}</text><text x="${x.toFixed(1)}" y="${(y + 13).toFixed(1)}" text-anchor="${anchor}" class="rs${s == null ? ' pend' : ''}">${sub}</text>`;
    }).join('')}
  </svg>`;
}

// The five dimensions: radar + total, then one card per dimension listing its
// checks (value, score, what it means, the scoring rule, and what to practise).
export function dimsHtml(S, { actions = true, rules = true } = {}) {
  const pill = (st) => `<span class="pill" style="color:${STATUS[st].color};border-color:${STATUS[st].color}">${STATUS[st].text}</span>`;
  return `<div class="dimwrap">
    <div class="panel radar-box">
      <div class="total"><span>${L('总分', 'Total')}</span><b style="color:${scoreColor(S.total)}">${S.total ?? '—'}</b></div>
      ${radarSvg(S)}
      <p class="muted" style="font-size:11.5px;margin:0">${L('每一维都不需要原唱或乐谱，按你自己的调和拍子判断。线在 60 以内 = 需要练，75 以外 = 好。', 'No original recording or score needed — judged against your own key and beat. Inside the 60 ring = practise, beyond 75 = good.')}</p>
    </div>
    <div class="dcards">${DIMS.map((d) => {
      const D = S.dims?.[d.key] || { score: null, status: 'na' };
      return `<div class="dcard s-${D.status}">
        <div class="dhead"><b>${d.title}</b><span class="dscore" style="color:${scoreColor(D.score)}">${D.score ?? '—'}</span>${pill(D.status)}</div>
        <div class="dsub">${d.sub}</div>
        ${D.score == null ? (D.blocked ? `<div class="dleft blocked">${L('无法判断：', 'Can’t judge: ')}${D.reason}</div>`
          : `<div class="pbar"><i style="width:${Math.round((D.progress || 0) * 100)}%"></i></div><div class="dleft">${L(`数据还不够（${Math.round((D.progress || 0) * 100)}%）· 还差：`, `Not enough yet (${Math.round((D.progress || 0) * 100)}%) · still needed: `)}${D.left || L('再唱一会儿', 'keep singing')}</div>`) : ''}
        ${d.checks.map(([k]) => {
          const r = S[k];
          const lesson = r.lesson && lessonById(r.lesson);
          const wait = r.score == null && !r.blocked && r.left;
          return `<div class="chk s-${r.status}">
            <div class="chead"><span class="cname">${r.title}</span><span class="cval">${wait ? `${L('还差：', 'needs: ')}${r.left}` : r.value}</span><span class="cscore" style="color:${scoreColor(r.score)}">${r.score ?? '—'}</span></div>
            ${wait ? `<div class="pbar thin"><i style="width:${Math.round(r.progress * 100)}%"></i></div>` : ''}
            <div class="cdetail">${r.detail}</div>
            ${actions && (r.status === 'ok' || r.status === 'poor') ? `<div class="maction">${r.action}${lesson ? ` <button class="btn" data-lesson="${r.lesson}">${L(`去练「${lesson.name}」→`, `Practise “${lesson.name}” →`)}</button>` : ''}</div>` : ''}
            ${rules && r.how ? `<div class="chow">${L('评分：', 'Scoring: ')}${r.how}</div>` : ''}
          </div>`;
        }).join('')}
      </div>`;
    }).join('')}</div>
  </div>`;
}

// Scoring progress: the total needs 3 scored dimensions. Each dimension shows
// its score, or how much of the singing it needs is there and what's missing,
// or that it can't be judged from this kind of singing.
export function progressHtml(S) {
  const R = S.ready || { scored: 0, need: 3, secs: 15, progress: 0 };
  const pend = DIMS.filter((d) => S.dims[d.key].score == null && !S.dims[d.key].blocked);
  const sung = Math.floor(S.voicedTime || 0);
  const msg = S.total != null
    ? L(`✓ 可以出总分了（已评 ${R.scored} / 5 维）${pend.length ? `；继续唱，${pend.map((d) => d.title).join('、')}也能评` : ''}`, `✓ Total score ready (${R.scored} / 5 dimensions)${pend.length ? `; keep singing and ${pend.map((d) => d.title).join(', ')} can be scored too` : ''}`)
    : R.scored >= R.need ? L(`再唱约 ${Math.max(1, Math.ceil(R.secs - (S.voicedTime || 0)))} 秒就出总分（至少唱满 ${R.secs} 秒）· 已唱 ${sung} 秒`, `About ${Math.max(1, Math.ceil(R.secs - (S.voicedTime || 0)))} s more for a total (${R.secs} s minimum) · sung ${sung} s`)
    : L(`还不能出总分：已评 ${R.scored} / 5 维，要 3 维，并且唱满 ${R.secs} 秒 · 已唱 ${sung} 秒`, `No total yet: ${R.scored} / 5 dimensions scored, needs 3 and ${R.secs} s of singing · sung ${sung} s`);
  return `<div class="sprog${S.total != null ? ' ready' : ''}">
    <div class="sp-head"><b>${L('评分进度', 'Scoring progress')}</b><span class="sp-msg">${msg}</span>
      <span class="sp-total">${S.total != null ? `${L('总分', 'Total')} <b style="color:${scoreColor(S.total)}">${S.total}</b>` : `<b>${Math.round(R.progress * 100)}%</b>`}</span></div>
    <div class="pbar sp-all"><i style="width:${Math.round(R.progress * 100)}%"></i></div>
    <div class="sp-segs">${DIMS.map((d) => {
      const D = S.dims[d.key], done = D.score != null;
      const state = done ? 'done' : D.blocked ? 'blocked' : 'wait';
      return `<div class="sp-seg ${state}">
        <div class="sp-top"><span>${d.title}</span><span style="${done ? `color:${scoreColor(D.score)}` : ''}">${done ? D.score : D.blocked ? L('无法判断', 'can’t judge') : `${Math.round(D.progress * 100)}%`}</span></div>
        <div class="pbar thin"><i style="width:${done || D.blocked ? 100 : Math.round(D.progress * 100)}%"></i></div>
        <div class="sp-left">${done ? L(`已评 ${D.judged} / ${D.of} 项`, `${D.judged} / ${D.of} checks scored`) : D.blocked ? L('这段演唱判断不了', 'can’t be judged from this take') : `${L('还差：', 'needs: ')}${D.left}`}</div>
      </div>`;
    }).join('')}</div>
  </div>`;
}

export function reportHtml(S) {
  const top = S.issues;
  if (!top.length) {
    const na = DIMS.filter((d) => S.dims?.[d.key]?.score == null).length;
    return na >= 3
      ? `<p class="t2">${L('唱的内容还不够判断大部分项目：试着唱一段有长音、有高低起伏、有节拍的歌（30 秒以上）。', 'Not enough to judge most items: try a song with long notes, highs and lows and a beat (30 s or more).')}</p>`
      : `<p style="font-size:15px">${L('🎉 这次没有发现明显问题。继续保持，也可以去「基础课程」巩固。', '🎉 No clear problems this time. Keep it up — or consolidate in “Lessons”.')}</p>`;
  }
  return `<ol class="report">${top.map((r) => `<li><b>${r.title}</b>${L('：', ': ')}${r.detail}<br><span class="t2">${L('怎么办：', 'What to do: ')}${r.action}</span>
    ${r.lesson ? `<br><button class="btn primary" data-lesson="${r.lesson}" style="margin-top:6px">${L(`去练「${lessonById(r.lesson)?.name}」→`, `Practise “${lessonById(r.lesson)?.name}” →`)}</button>` : ''}</li>`).join('')}</ol>`;
}

// markers on the pitch trace: phrase ends that sank, scooped onsets
export function marksOf(S) {
  return [
    ...(S.tail?.points || []).map((p) => ({ t: p.t, icon: '↘', color: '#f0b429', label: L('句尾掉音', 'phrase end sank') })),
    ...(S.scoop?.points || []).map((p) => ({ t: p.t, icon: '↗', color: '#f0b429', label: L('挑音', 'scoop') })),
  ];
}

export class LiveView {
  constructor(app) {
    this.app = app;
    this.engine = new AudioEngine();
    this.raf = 0;
    this.busy = false;
  }

  init() {
    this.track = new PitchTrack($('trackCanvas'));
    $('btnStart').onclick = () => (this.engine.running ? this.stop() : this.start('mic'));
    $('btnFile').onclick = () => $('fileInput').click();
    $('fileInput').onchange = (e) => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) this.start('file', f, f.name);
    };
    $('mcards').addEventListener('click', (e) => this.onLessonClick(e));
    this.reset();
    window.addEventListener('resize', () => { if (!this.engine.running) this.drawIdle(); });
  }

  onLessonClick(e) {
    const b = e.target.closest('[data-lesson]');
    if (b) this.app.showTab('lessons', b.dataset.lesson);
  }

  reset() {
    this.ring = { t: [], midi: [] };
    this.metrics = new SingingMetrics();
    this.lastCards = -1;
    this.marks = [];
    this.renderCards(this.metrics.summary());
    this.drawIdle();
  }

  view() {
    const P = VOICE_TYPES[this.app.settings.voiceType];
    return { lo: P.low + 4, hi: P.high - 4 };
  }

  drawIdle() {
    const v = this.view();
    this.track.draw(this.ring, { t0: 0, t1: SPAN, ...v, breaks: [] });
    drawCents($('centsCanvas'), 0, false);
  }

  async start(kind, blob, name = '') {
    if (this.busy) return;
    this.busy = true;
    const s = this.app.settings;
    this.analyzer = null;
    this.engine.onFrame = (frame, t) => { if (this.analyzer && t >= 0) this.process(frame, t); };
    try {
      if (kind === 'mic') await this.engine.startMic({ deviceId: s.deviceId, record: s.saveAudio });
      else await this.engine.startFile(blob, { onEnded: () => this.stop() });
    } catch (err) {
      $('status').textContent = kind === 'mic' ? L(`无法打开麦克风：${err.message}`, `Can’t open the microphone: ${err.message}`) : L(`无法解码音频：${err.message}`, `Can’t decode the audio: ${err.message}`);
      this.busy = false;
      return;
    }
    this.name = name || (kind === 'mic' ? L('麦克风演唱', 'Microphone take') : L('导入的录音', 'Imported recording'));
    this.pitch = new PitchTracker(s);
    this.reset();
    this.analyzer = new FrameAnalyzer(this.engine.sampleRate);
    $('scoreProg').classList.add('live');
    $('btnStart').textContent = L('■ 结束，看结果', '■ Stop & see results');
    $('btnStart').classList.add('recording');
    $('btnFile').disabled = true;
    $('status').textContent = kind === 'mic' ? L('正在听… 唱一首歌 30 秒以上（有长音、有高有低、有节拍）就能出完整的五维评分。', 'Listening… sing a song for 30 s or more (long notes, highs and lows, a beat) for a full five-dimension score.') : L(`正在分析：${name}`, `Analysing: ${name}`);
    $('status').classList.remove('warn');
    this.busy = false;
    this.raf = requestAnimationFrame(() => this.tick());
  }

  process(frame, t) {
    const st = this.pitch.update(this.analyzer.analyze(frame, { gateDb: this.app.settings.gateDb, pitchOnly: true }), t);
    this.metrics.push(st);
    const r = this.ring;
    r.t.push(t); r.midi.push(st.voiced ? st.midi : NaN);
    while (r.t.length && t - r.t[0] > SPAN + 1) { r.t.shift(); r.midi.shift(); }
    this.lastSt = st;
  }

  tick() {
    if (!this.engine.running) return;
    this.raf = requestAnimationFrame(() => this.tick());
    const st = this.lastSt;
    if (!st) return;
    const now = this.engine.now();
    $('timer').textContent = fmtT(now);
    $('level').style.width = `${Math.max(0, Math.min(100, (st.db + 60) * 1.8))}%`;
    $('level').style.background = st.db > -6 ? 'var(--critical)' : 'var(--good)';
    const tEnd = Math.max(SPAN, st.t);
    // judged against the singer's own tuning (clear a cappella offsets from A4 = 440)
    const off = this.metrics.offsetNow(st.t);
    this.track.draw(this.ring, { t0: tEnd - SPAN, t1: tEnd, ...this.view(), offset: off, breaks: this.metrics.breaks, marks: this.marks });
    const rel = wrapCents(st.cents - off);
    if (st.voiced) {
      $('noteName').textContent = st.noteName;
      const k = tuneClass(rel);
      $('noteCents').innerHTML = `<span style="color:${TUNE[k].color}">${rel >= 0 ? '+' : ''}${Math.round(rel)} ${L('音分', 'cents')} · ${TUNE[k].name}</span>`;
    } else { $('noteName').textContent = '—'; $('noteCents').innerHTML = '&nbsp;'; }
    $('tuneNote').textContent = Math.abs(off) >= 15 ? L(`按你的整体音高校正（比标准音${off < 0 ? '低' : '高'} ${Math.round(Math.abs(off))} 音分）`, `Adjusted to your overall tuning (${Math.round(Math.abs(off))} cents ${off < 0 ? 'below' : 'above'} standard pitch)`) : '';
    drawCents($('centsCanvas'), rel, st.voiced);
    if (now - this.lastCards > 0.6) {
      this.lastCards = now;
      const S = this.metrics.summary();
      this.renderCards(S);
      $('rangeText').textContent = S.range ? `${L('音域：', 'Range: ')}${S.range.loName} – ${S.range.hiName}` : '';
    }
  }

  renderCards(S) {
    this.marks = marksOf(S);
    $('scoreProg').innerHTML = progressHtml(S);
    $('mcards').innerHTML = dimsHtml(S, { rules: false });
  }

  // report: false when the take ends because the user left the page — it is
  // still saved, but no report pops up over the other page.
  async stop({ report = true } = {}) {
    if (this.busy || !this.engine.running) return;
    this.busy = true;
    cancelAnimationFrame(this.raf);
    this.analyzer = null;
    const duration = this.engine.now();
    const source = this.engine.mode;
    const audioOffset = source === 'mic' ? this.engine.recStart ?? 0 : 0; // recording start on the analysis clock
    const blob = await this.engine.stop();
    $('scoreProg').classList.remove('live');
    $('btnStart').textContent = L('● 开始唱', '● Start singing');
    $('btnStart').classList.remove('recording');
    $('btnFile').disabled = false;
    const S = this.metrics.finish();
    this.renderCards(S);
    this.busy = false;
    if (S.voicedTime < 2) {
      $('status').textContent = L('⚠ 唱得太短（不到 2 秒），无法评分，这次不保存。', '⚠ Too short to score (under 2 s); not saved.');
      $('status').classList.add('warn');
      if (report) this.showShort(S);
      return;
    }
    const why = report ? '' : L('离开页面时已自动结束，', 'Stopped when you left the page; ');
    const F = this.metrics.frames;
    const rec = {
      version: 2, id: `s${Date.now()}`, createdAt: Date.now(), name: this.name, source, duration,
      voiceType: this.app.settings.voiceType,
      frames: { t: Float32Array.from(F.t), midi: Float32Array.from(F.midi), db: Float32Array.from(F.db) },
      notes: this.metrics.notes.map(({ t0, t1, target, cents, db, steady }) => ({ t0, t1, target, cents, db, steady })),
      breaks: this.metrics.breaks.map((b) => ({ t: b.t, from: b.from, to: b.to })),
      summary: stripPoints(S),
    };
    rec.hasAudio = !!blob && (source === 'file' || this.app.settings.saveAudio);
    rec.audioOffset = audioOffset;
    try {
      await saveSession(rec);
      if (rec.hasAudio) await saveAudio(rec.id, blob);
      $('status').textContent = `${why}${L(`已保存到历史记录（${fmtT(duration)}）。`, `saved to History (${fmtT(duration)}).`)}`;
    } catch (err) {
      $('status').textContent = L(`保存失败：${err.message}`, `Saving failed: ${err.message}`);
    }
    if (report) this.showReport(rec);
  }

  // the take was too short to score anything
  showShort(S) {
    this.modal(`<h3 class="warn-title">${L('⚠ 唱得太短，无法评分', '⚠ Too short to score')}</h3>
      <p class="t2" style="margin:6px 0 10px">${L(`只听到 ${S.voicedTime.toFixed(1)} 秒的歌声：至少 2 秒才保存，唱 30 秒以上才能出完整的五维评分。如果你一直在唱，可能是麦克风没收到声音（看看上面的音量条有没有动，或者靠近一点）。`, `Only ${S.voicedTime.toFixed(1)} s of singing was heard: takes are saved from 2 s, and a full five-dimension score needs 30 s or more. If you were singing the whole time, the microphone may not be picking you up (check that the level bar moves, or move closer).`)}</p>
      ${progressHtml(S)}`);
  }

  modal(html, onClick) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal">${html}<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn" data-a="close">${L('关闭', 'Close')}</button></div></div>`;
    document.body.appendChild(back);
    back.onclick = (e) => { if (e.target === back || e.target.dataset.a === 'close') back.remove(); else onClick?.(e, back); };
  }

  showReport(rec) {
    const S = rec.summary;
    const back = document.createElement('div');
    back.className = 'modal-back';
    const partial = S.total == null;
    back.innerHTML = `<div class="modal">
      ${partial ? `<h3 class="warn-title">${L('这次还不能出总分', 'No total score this time')}</h3>
        <p class="t2" style="margin:4px 0 10px;font-size:13px">${L(`唱了 ${fmtT(S.voicedTime)}。出总分要唱满 ${S.ready.secs} 秒、五维里至少 3 维有足够的数据；这次评了 ${S.ready.scored} 维。下次唱一首歌 30 秒以上：有长音、有高有低、有稳定的节拍。`, `You sang ${fmtT(S.voicedTime)}. A total needs ${S.ready.secs} s of singing and enough data for at least 3 of the 5 dimensions; this take scored ${S.ready.scored}. Next time sing a song for 30 s or more, with long notes, highs and lows and a steady beat.`)}</p>
        ${progressHtml(S)}
        ${S.issues.length ? `<h3 style="font-size:15px;margin:14px 0 4px">${L('已经能看出的问题', 'Problems already visible')}</h3>` : ''}` : `<h3 style="font-size:17px;margin-bottom:4px">${L('这次最需要练的', 'What to practise most')}</h3>`}
      <p class="muted" style="margin:0 0 10px;font-size:12.5px">${L('时长', 'Length')} ${fmtT(rec.duration)} · ${L('唱了', 'sung')} ${fmtT(S.voicedTime)}${S.range ? ` · ${L('音域', 'range')} ${S.range.loName}–${S.range.hiName}` : ''}</p>
      ${partial && !S.issues.length ? '' : reportHtml(S)}
      ${partial ? '' : `<div class="report-dims">${radarSvg(S)}<div class="t2" style="font-size:13px">${L('总分', 'Total')} <b style="font-size:22px;color:${scoreColor(S.total)}">${S.total}</b><br>${DIMS.map((d) => `${d.title} ${S.dims[d.key].score ?? '—'}`).join(' · ')}</div></div>`}
      <details style="margin-top:6px"><summary class="t2" style="cursor:pointer">${L('五维评分详情', 'Five-dimension details')}</summary>${dimsHtml(S, { actions: false })}</details>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap">
        <button class="btn" data-a="close">${L('关闭', 'Close')}</button>
        <button class="btn" data-a="detail">${L('回放这次录音', 'Replay this take')}</button>
      </div></div>`;
    document.body.appendChild(back);
    back.onclick = (e) => {
      const a = e.target.dataset.a, l = e.target.closest('[data-lesson]');
      if (e.target === back || a === 'close') back.remove();
      if (a === 'detail') { back.remove(); this.app.showTab('history', rec.id); }
      if (l) { back.remove(); this.app.showTab('lessons', l.dataset.lesson); }
    };
  }
}

// drop large per-note arrays from a summary before storing
export function stripPoints(S) {
  const out = { ...S };
  for (const k of CHECKS) { const { points, ...rest } = S[k]; out[k] = rest; }
  out.issues = S.issues.map(({ points, ...rest }) => rest);
  return out;
}

// Horizontal cents meter: centre = in tune.
export function drawCents(canvas, cents, voiced) {
  const { ctx, w, h } = fit(canvas);
  ctx.clearRect(0, 0, w, h);
  const x0 = 10, x1 = w - 10, y = h / 2, X = (c) => x0 + ((c + 50) / 100) * (x1 - x0);
  const zones = [[-50, -40, TUNE.off.color], [-40, -25, TUNE.near.color], [-25, 25, TUNE.good.color], [25, 40, TUNE.near.color], [40, 50, TUNE.off.color]];
  for (const [a, b, c] of zones) { ctx.fillStyle = c; ctx.globalAlpha = 0.28; ctx.fillRect(X(a), y - 7, X(b) - X(a), 14); }
  ctx.globalAlpha = 1;
  ctx.fillStyle = THEME.muted; ctx.font = THEME.fontMono; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (const c of [-50, 0, 50]) ctx.fillText(c === 0 ? L('准', 'in tune') : `${c > 0 ? '+' : ''}${c}`, X(c), y + 10);
  if (voiced) {
    const x = X(Math.max(-50, Math.min(50, cents)));
    ctx.fillStyle = THEME.text;
    ctx.beginPath(); ctx.moveTo(x, y - 12); ctx.lineTo(x - 6, y - 20); ctx.lineTo(x + 6, y - 20); ctx.closePath(); ctx.fill();
    ctx.fillRect(x - 1.5, y - 12, 3, 24);
  }
}
