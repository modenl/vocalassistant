// Basic lessons: catalogue → lesson (steps) → step player with a clear pass rule.

import { LESSONS, lessonById, loadProgress, saveProgress, gradeOf } from '../lessons/lessons.js';
import { StepRunner } from '../lessons/runner.js';
import { VOICE_TYPES, midiName } from '../config.js';
import { PitchTrack } from '../viz/pitchTrack.js';
import { playTone, playGlide, playSequence, stopTones } from '../audio/tone.js';
import { L as tr } from '../i18n.js';

const SPAN = 10;
// progress entries: { passed, best, at } (older versions stored a timestamp when passed)
const entry = (v) => (typeof v === 'number' ? { passed: true, best: null, at: v } : v || null);
const scoreColor = (s) => (s >= 90 ? '#2fbf71' : s >= 75 ? '#8bd46a' : s >= 60 ? '#f0b429' : '#ef5a5a');

export class LessonsView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.lesson = null;
    this.stepIdx = 0;
  }

  get P() { return VOICE_TYPES[this.app.settings.voiceType]; }

  show(lessonId) {
    this.stopRunner();
    if (lessonId && lessonById(lessonId)) { this.lesson = lessonById(lessonId); this.stepIdx = this.firstOpenStep(); return this.renderLesson(); }
    this.lesson = null;
    const prog = loadProgress();
    this.root.innerHTML = `
      <div class="ph"><h3 style="font-size:16px">${tr('基础课程', 'Lessons')}</h3><span class="sub">${tr('每一步只练一件事，程序能明确判断你做到了没有。建议按顺序练。', 'Each step practises one thing, and the app can tell for sure whether you did it. Best taken in order.')}</span></div>
      <div class="cards">${LESSONS.map((l, i) => {
        const es = l.steps.map((s) => entry(prog[l.id]?.[s.id]));
        const done = es.filter((e) => e?.passed).length;
        const bests = es.filter((e) => e?.passed && Number.isFinite(e.best)).map((e) => e.best);
        const avg = bests.length ? Math.round(bests.reduce((a, b) => a + b, 0) / bests.length) : null;
        return `<div class="card lesson-card">
          <h4>${i + 1}. ${l.name} ${done === l.steps.length ? `<span class="pill ok">${tr('✓ 完成', '✓ Done')}</span>` : ''}</h4>
          <p>${l.desc}</p>
          <p class="tagline">${tr(`${l.steps.length} 步 · 已通过 ${done} 步`, `${l.steps.length} steps · ${done} passed`)}${avg != null ? `${tr(' · 最好成绩平均 ', ' · average best ')}<b style="color:${scoreColor(avg)}">${avg}</b>` : ''}</p>
          <button class="btn primary" data-open="${l.id}">${done ? tr('继续', 'Continue') : tr('开始', 'Start')}</button>
        </div>`;
      }).join('')}</div>`;
    this.root.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => this.show(b.dataset.open); });
  }

  firstOpenStep() {
    const p = loadProgress()[this.lesson.id] || {};
    const i = this.lesson.steps.findIndex((s) => !entry(p[s.id])?.passed);
    return i < 0 ? 0 : i;
  }

  renderLesson() {
    this.stopRunner();
    const L = this.lesson, step = L.steps[this.stepIdx], P = this.P;
    const prog = loadProgress()[L.id] || {};
    const targets = step.targets(P);
    this.root.innerHTML = `
      <div class="lesson-head">
        <button class="btn" data-a="list">${tr('← 课程列表', '← All lessons')}</button>
        <h3 style="font-size:16px">${L.name}</h3>
        <div class="steps">${L.steps.map((s, i) => { const e = entry(prog[s.id]); return `<button class="stepbtn ${i === this.stepIdx ? 'active' : ''} ${e?.passed ? 'done' : ''}" data-step="${i}">${e?.passed ? '✓' : `${i + 1}.`} ${s.title}${Number.isFinite(e?.best) ? ` · ${e.best}` : ''}</button>`; }).join('')}</div>
      </div>
      <div class="lesson-grid">
        <div class="panel">
          <div class="ph"><h3>${tr(`第 ${this.stepIdx + 1} 步`, `Step ${this.stepIdx + 1}`)} · ${step.title}</h3></div>
          <p style="font-size:14.5px">${step.goal}</p>
          <p><button class="btn" data-a="ref">${tr('▶ 听参考音', '▶ Reference')}${tr('（', ' (')}${targets.map(midiName).join(' → ')}${tr('）', ')')}</button></p>
          <p><b>${tr('怎么做', 'How')}</b></p>
          <ol class="cal-list">${step.how.map((h) => `<li>${h}</li>`).join('')}</ol>
          <div class="passrule"><b>${tr('通过标准：', 'To pass: ')}</b>${step.pass}</div>
        </div>
        <div class="panel">
          <div class="ph"><h3>${tr('跟着唱', 'Sing')}</h3><span class="sub" id="lsTimer"></span></div>
          <div class="seqchips" id="lsSeq">${targets.length > 1 && L.id !== 'glide' ? targets.map((m, i) => `<span class="chip ${i === 0 ? 'next' : ''}">${midiName(m)}</span>`).join('') : ''}</div>
          <canvas class="viz" id="lsTrace" style="height:240px"></canvas>
          <div class="ls-hint idle" id="lsHint">${tr('点“开始”，然后按左边的方法唱。绿色带子是目标音（落在带子里就算准）。', 'Press “Start”, then sing as described on the left. The green band is the target (inside it counts as in tune).')}</div>
          <div class="bar" style="margin-top:8px"><div class="fill" id="lsProg" style="width:0"></div></div>
          <div class="cal-actions">
            <button class="btn primary" data-a="go" id="lsGo">${tr('● 开始', '● Start')}</button>
            ${this.stepIdx + 1 < L.steps.length ? `<button class="btn" data-a="next">${tr('跳过这一步', 'Skip this step')}</button>` : ''}
          </div>
          <div id="lsResult"></div>
        </div>
      </div>`;
    this.root.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => this.action(b.dataset.a, b); });
    this.root.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { this.stepIdx = +b.dataset.step; this.renderLesson(); }; });
    this.trace = new PitchTrack(this.root.querySelector('#lsTrace'));
    this.drawTrace();
    window.scrollTo({ top: 0 });
  }

  drawTrace() {
    const step = this.lesson.steps[this.stepIdx], targets = step.targets(this.P);
    const r = this.runner;
    const fr = r ? r.take.frames : [];
    const data = { t: fr.map((f) => f.t), midi: fr.map((f) => (f.voiced ? f.midi : NaN)) };
    const tEnd = Math.max(SPAN, fr.length ? fr[fr.length - 1].t : 0);
    // singing in another octave counts: show the targets in the singer's octave too
    const sung = data.midi.slice(-40).filter(Number.isFinite).sort((a, b) => a - b);
    const mean = targets.reduce((a, b) => a + b, 0) / targets.length;
    const k = sung.length > 10 ? Math.round((sung[sung.length >> 1] - mean) / 12) : 0;
    const uniq = [...new Set(targets)];
    const seq = r?.ev?.seq, next = seq && seq.done < targets.length ? targets[seq.done] : null;
    const bands = uniq.map((m) => ({ midi: m, label: midiName(m), active: m === next }));
    if (k) bands.push(...uniq.map((m) => ({ midi: m + 12 * k, label: `${midiName(m + 12 * k)}${tr(`（${k < 0 ? '低' : '高'}八度，也算对）`, ` (octave ${k < 0 ? 'lower' : 'higher'} — counts too)`)}`, active: m === next })));
    const all = bands.map((b) => b.midi);
    const lo = Math.min(...all) - 3, hi = Math.max(...all) + 3;
    this.trace.draw(data, { t0: tEnd - SPAN, t1: tEnd, lo, hi, targets: bands, breaks: r ? r.take.m.breaks : [] });
  }

  async action(a, btn) {
    const L = this.lesson;
    if (a === 'list') return this.show();
    if (a === 'next') { this.stepIdx = Math.min(L.steps.length - 1, this.stepIdx + 1); return this.renderLesson(); }
    if (a === 'ref') {
      const step = L.steps[this.stepIdx], ref = step.ref(this.P), a4 = this.app.settings.a4;
      stopTones();
      btn.disabled = true;
      try {
        if (L.id === 'glide') await playGlide(ref[0], ref[1], 4, a4);
        else if (ref.length > 1) await playSequence(ref, 0.7, a4);
        else await playTone(ref[0], 1.8, a4);
      } finally { btn.disabled = false; }
      return;
    }
    if (a === 'go') {
      if (this.runner?.running) return this.runner.stop();
      if (this.app.live?.engine.running) { alert(tr('请先结束“唱一段看问题”页面的录音。', 'Please stop the recording on the “Sing & check” page first.')); return; }
      stopTones();
      this.root.querySelector('#lsResult').innerHTML = '';
      this.runner = new StepRunner(this.app, L.steps[this.stepIdx], this.P, { onEnd: (r) => this.finish(r) });
      try { await this.runner.start(); } catch (err) { alert(tr(`麦克风错误：${err.message}`, `Microphone error: ${err.message}`)); return; }
      btn.textContent = tr('■ 停止', '■ Stop');
      btn.classList.add('recording');
      this.loop();
    }
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      const r = this.runner;
      if (!r || !this.root.querySelector('#lsHint')) return;
      this.update(r);
      if (r.running) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  update(r) {
    const $ = (id) => this.root.querySelector('#' + id);
    const ev = r.ev;
    $('lsHint').textContent = ev.hint || '…';
    $('lsHint').className = `ls-hint ${ev.pass ? 'pass' : ev.level}`;
    $('lsProg').style.width = `${Math.round((ev.progress || 0) * 100)}%`;
    $('lsProg').style.background = ev.pass ? 'var(--good)' : 'var(--accent)';
    if (ev.seq) {
      $('lsSeq').querySelectorAll('.chip').forEach((c, i) => {
        c.className = `chip ${i < ev.seq.done ? 'done' : i === ev.seq.done ? 'next' : ''}`;
        c.textContent = `${i < ev.seq.done ? '✓ ' : ''}${midiName(ev.seq.targets[i])}`;
      });
    }
    const st = r.last;
    $('lsTimer').textContent = st ? `${st.t.toFixed(1)} s${st.voiced ? ` · ${st.noteName} ${st.cents >= 0 ? '+' : ''}${Math.round(st.cents)} ${tr('音分', 'cents')}` : ''}` : '';
    this.drawTrace();
  }

  finish(r) {
    cancelAnimationFrame(this.raf);
    if (!this.root.querySelector('#lsHint')) return;
    this.update(r);
    const L = this.lesson, step = r.step, ev = r.ev, pass = ev.pass;
    const score = Number.isFinite(ev.score) ? ev.score : pass ? 60 : 0;
    const all = loadProgress();
    const prev = entry(all[L.id]?.[step.id]);
    const best = Math.max(prev?.best ?? 0, score);
    const isBest = !prev?.best || score > prev.best;
    all[L.id] = { ...(all[L.id] || {}), [step.id]: { passed: !!(pass || prev?.passed), best, at: Date.now() } };
    saveProgress(all);
    const btn = this.root.querySelectorAll('.stepbtn')[this.stepIdx];
    if (btn && (pass || prev?.passed)) { btn.classList.add('done'); btn.textContent = `✓ ${step.title} · ${best}`; }
    const go = this.root.querySelector('#lsGo');
    if (go) { go.textContent = tr('● 再来一次', '● Again'); go.classList.remove('recording'); }
    const last = this.stepIdx + 1 >= L.steps.length;
    const parts = ev.parts || [];
    const weakest = parts.filter((p) => p.s < 0.9).sort((a, b) => a.s * a.w - b.s * b.w)[0];
    this.root.querySelector('#lsResult').innerHTML = `<div class="ls-result ${pass ? 'pass' : 'fail'}">
      <div class="ls-score"><b style="color:${scoreColor(score)}">${score}</b><small>${tr(' 分', '')} · ${gradeOf(score)}</small>
        ${isBest && prev?.best ? `<span class="pill ok">${tr('新纪录', 'New best')}</span>` : prev?.best ? `<span class="muted" style="font-size:12px">${tr(`最好 ${best} 分`, `best ${best}`)}</span>` : ''}</div>
      <p class="t2" style="margin:4px 0 8px">${ev.hint}</p>
      ${parts.length ? `<div class="parts">${parts.map((p) => `<div class="part">
        <span class="pname">${p.name}</span>
        <span class="pbar"><i style="width:${Math.round(p.s * 100)}%;background:${scoreColor(60 + 40 * p.s)}"></i></span>
        <span class="ptext">${p.text} <span class="muted">${tr('（满分：', '(full marks: ')}${p.full}${tr('）', ')')}</span></span></div>`).join('')}</div>
        <p style="font-size:13px;margin:8px 0 0">${weakest ? `${tr('想拿更高分：', 'For a higher score: ')}${weakest.tip}` : tr('非常好，几乎满分！', 'Excellent — nearly full marks!')}</p>` : ''}
      <div class="cal-actions">${pass ? `<button class="btn primary" data-r="next">${last ? tr('完成本课，回到课程列表', 'Lesson done — back to all lessons') : tr('下一步 →', 'Next step →')}</button><button class="btn" data-r="again">${tr('再来一次，争取更高分', 'Again, for a higher score')}</button>` : `<button class="btn primary" data-r="again">${tr('再来一次', 'Try again')}</button>`}</div>
    </div>`;
    this.root.querySelectorAll('[data-r]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.r === 'again') return this.action('go', this.root.querySelector('#lsGo'));
        if (last) return this.show();
        this.stepIdx++; this.renderLesson();
      };
    });
  }

  stopRunner() {
    stopTones();
    cancelAnimationFrame(this.raf);
    if (this.runner?.running) { this.runner.onEnd = null; this.runner.stop(); }
    this.runner = null;
  }
}
