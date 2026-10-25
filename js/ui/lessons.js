// Basic lessons: catalogue → lesson (steps) → step player with a clear pass rule.

import { LESSONS, lessonById, loadProgress, saveProgress, gradeOf, loadTwang, saveTwang } from '../lessons/lessons.js';
import { StepRunner } from '../lessons/runner.js';
import { VOICE_TYPES, midiName } from '../config.js';
import { PitchTrack } from '../viz/pitchTrack.js';
import { playRef, playGlide, stopTones } from '../audio/tone.js';
import { L as tr } from '../i18n.js';
import { drawCompare, drawTwangMap, drawRingCurve, drawClosureMap } from '../viz/scope.js';
import { SHOUT_LOUD, LEVELS, levelOf, twangVerdict, buildCurve } from '../analysis/twang.js';
import { ref, refsSection } from '../refs.js';
import { glossaryHtml } from './glossary.js';
import { pitchNowHtml } from './pitchNow.js';
import { drawFormantRows } from '../viz/formants.js';
import { vowelOf, recentFm, formantTrust } from '../analysis/vowels.js';

const SPAN = 10;
const LEVEL_NAMES = () => ({ easy: tr('入门', 'Beginner'), std: tr('标准', 'Standard'), strict: tr('严格', 'Strict') });
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
  // what the steps are judged against: earlier results, and the difficulty
  ctx() { return { ...loadTwang(), level: this.app.settings.twangLevel }; }
  get level() { return levelOf(this.app.settings.twangLevel); }

  // lessonId / stepNo (1-based) from the address; none → the catalogue
  show(lessonId, stepNo) {
    this.stopRunner();
    if (lessonId && lessonById(lessonId)) {
      this.lesson = lessonById(lessonId);
      this.stepIdx = stepNo >= 1 && stepNo <= this.lesson.steps.length ? stepNo - 1 : this.firstOpenStep();
      return this.renderLesson();
    }
    this.lesson = null;
    this.app.route(['lessons']);
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
    this.app.route(['lessons', L.id, this.stepIdx + 1]);
    const prog = loadProgress()[L.id] || {};
    const targets = step.targets(P, this.ctx());
    this.root.innerHTML = `
      <div class="lesson-head">
        <button class="btn" data-a="list">${tr('← 课程列表', '← All lessons')}</button>
        <h3 style="font-size:16px">${L.name}</h3>
        <div class="steps">${L.steps.map((s, i) => { const e = entry(prog[s.id]); return `<button class="stepbtn ${i === this.stepIdx ? 'active' : ''} ${e?.passed ? 'done' : ''}" data-step="${i}">${e?.passed ? '✓' : `${i + 1}.`} ${s.title}${Number.isFinite(e?.best) ? ` · ${e.best}` : ''}${e?.level ? ` · ${LEVEL_NAMES()[e.level]}` : ''}</button>`; }).join('')}</div>
        ${L.id === 'twang' ? this.levelHtml() : ''}
      </div>
      <div class="lesson-grid">
        <div class="panel">
          <div class="ph"><h3>${tr(`第 ${this.stepIdx + 1} 步`, `Step ${this.stepIdx + 1}`)} · ${step.title}</h3></div>
          <p style="font-size:14.5px">${step.goal}</p>
          <p><button class="btn" data-a="ref">${tr('▶ 听参考音', '▶ Reference')}${tr('（', ' (')}${targets.map(midiName).join(' → ')}${tr('）', ')')}</button></p>
          <p><b>${tr('怎么做', 'How')}</b></p>
          <ol class="cal-list">${step.how.map((h) => `<li>${h}</li>`).join('')}</ol>
          <div class="passrule"><b>${tr('通过标准：', 'To pass: ')}</b>${typeof step.pass === 'function' ? step.pass(this.level) : step.pass}${step.refs ? ` ${ref(...step.refs)}` : ''}</div>
        </div>
        <div class="panel">
          <div class="ph ls-head"><h3>${tr('跟着唱', 'Sing')}</h3><span class="sub" id="lsTimer"></span><div class="ph-right ls-pitch" id="lsPitch">${pitchNowHtml(0)}</div></div>
          <div class="seqchips" id="lsSeq">${targets.length > 1 && L.id !== 'glide' && !step.glideRef ? targets.map((m, i) => `<span class="chip ${i === 0 ? 'next' : ''}">${midiName(m)}</span>`).join('') : ''}</div>
          ${L.spectrum ? this.spectrumPanel(step) : `<canvas class="viz" id="lsTrace" style="height:240px"></canvas>
          <div class="ls-meter" id="lsMeter" hidden></div>
          <div class="ls-hint idle" id="lsHint">${tr('点“开始”，然后按左边的方法唱。绿色带子是目标音（落在带子里就算准）。', 'Press “Start”, then sing as described on the left. The green band is the target (inside it counts as in tune).')}</div>
          <div class="bar" style="margin-top:8px"><div class="fill" id="lsProg" style="width:0"></div></div>
          ${this.actionsHtml()}
          <div id="lsResult"></div>`}
        </div>
      </div>${L.spectrum ? glossaryHtml(['ring', 'ratio', 'peaks', 'spectrum', 'formant', 'db', 'twang', 'frequency']) : ''}${L.refs ? refsSection(L.refs) : ''}`;
    this.root.querySelectorAll('[data-a]').forEach((b) => { b.onclick = () => this.action(b.dataset.a, b); });
    this.root.querySelectorAll('[data-step]').forEach((b) => { b.onclick = () => { this.stepIdx = +b.dataset.step; this.renderLesson(); }; });
    this.root.querySelectorAll('[data-level]').forEach((b) => { b.onclick = () => { if (this.runner?.running) return; this.app.updateSettings({ twangLevel: b.dataset.level }); this.renderLesson(); }; });
    this.map = []; this.clos = []; this.ringTrail = []; this.live = []; this.liveCurve = null; this.liveT = null; this.trackT = null; this.now = null; this.nowRing = null;
    if (L.spectrum) this.drawSpec();
    else { this.trace = new PitchTrack(this.root.querySelector('#lsTrace')); this.drawTrace(); }
    window.scrollTo({ top: 0 });
  }

  actionsHtml() {
    return `<div class="cal-actions">
            <button class="btn primary" data-a="go" id="lsGo">${tr('● 开始', '● Start')}</button>
            ${this.stepIdx + 1 < this.lesson.steps.length ? `<button class="btn" data-a="next">${tr('跳过这一步', 'Skip this step')}</button>` : ''}
          </div>`;
  }

  // Spectrum lessons (twang): the controls and the words first, at fixed sizes,
  // then every chart at a fixed height — nothing above the buttons changes size
  // while singing, so they never move
  spectrumPanel(step) {
    const cap = (zh, en) => `<p class="muted ls-cap">${tr(zh, en)}</p>`;
    const glide = step.id === 'base';
    return `${this.actionsHtml()}
          <div class="bar" style="margin-top:8px"><div class="fill" id="lsProg" style="width:0"></div></div>
          <div class="ls-hint fixed idle" id="lsHint">${tr('点“开始”，然后按左边的方法唱。', 'Press “Start”, then sing as described on the left.')}</div>
          <div id="lsResult"></div>
          <h4 class="ls-h">${glide ? tr('滑音覆盖了哪些音（灰点）→ 普通唱法曲线', 'What the glide has covered (grey dots) → the plain-voice curve') : tr('穿透力：你现在 vs 同一音高的普通唱法', 'Ring: you now vs your plain voice at the same pitch')}</h4>
          <canvas class="viz" id="lsCurve" style="height:220px"></canvas>
          ${glide ? cap('横轴是音高，纵轴是 2–4 kHz 比低频弱多少（越往上越亮）。慢慢滑，灰点铺满一段（≥ 7 个半音）就有了“普通唱法曲线”，之后的咽音都和这条线上同一音高的值比。', 'Pitch across; up = brighter (2–4 kHz closer to the lows). Glide slowly until the grey dots cover ≥ 7 semitones: that’s your plain-voice curve, and every later twang is compared with it at the same pitch.')
    : cap('灰线是你的普通唱法，绿色虚线是这一档的通过线。白点是你现在：在哪个音唱都行，点要升到绿色区域里（比同一音高的普通唱法亮够），而且要保持。', 'The grey line is your plain voice, the dashed green line this level’s pass line. The white dot is you now: on any note, lift it into the green area (bright enough against your plain voice at that pitch) and keep it there.')}
          ${glide ? '' : `<div class="ls-viz2">
            <div><h4 class="ls-h">${tr('咽音还是喊', 'Twang or shouting')}</h4><canvas class="viz" id="lsMap" style="height:210px"></canvas></div>
            <div><h4 class="ls-h">${tr('声带闭合', 'Vocal-fold closure')} ${ref('hanson1997')}</h4><canvas class="viz" id="lsClos" style="height:210px"></canvas></div>
          </div>
          ${cap('左图：往上走是更亮，往右走只是更响——要往上，不要往右。右图：根据声音推测声带闭得怎么样（看不到声带）。绿色 = 闭合好；黄色 = 漏气（周期性降低、第一谐波变强）；红色 = 挤（闭得紧但振动不规则）。咽音本来就闭得紧一点，点在绿色区偏左是正常的。', 'Left: up is brighter, right is just louder — go up, not right. Right: the closure of the vocal folds, inferred from the sound (they can’t be seen). Green = closing well; yellow = air leaking (less periodic, a stronger first harmonic); red = squeezed (tight but irregular). Twang closes a bit more firmly, so a dot left in the green is normal.')}`}
          <h4 class="ls-h">${tr('频谱', 'Spectrum')}</h4>
          <canvas class="viz" id="lsSpec" style="height:220px"></canvas>
          ${cap('两条线都按左边低频的最高点对齐，所以比的是 2–4 kHz（蓝色区域）占多少，不是音量。咽音会让绿线在蓝色区域里明显高出灰线（灰线是基准的平均频谱，音高不同时只作参考）。', 'Both curves are aligned at their highest point on the left, so this compares how much 2–4 kHz (blue area) there is, not loudness. Twang lifts the green curve clearly above the grey one in the blue area (grey = the reference’s average spectrum; at another pitch, a guide only).')}
          <div class="ph" style="margin-top:6px"><h4 class="ls-h">${tr('共振峰 F1–F5（元音和咽音的“指纹”）', 'Formants F1–F5 (the vowel’s and twang’s “fingerprint”)')} ${ref('petersonBarney1952', 'sundbergThalen2010')}</h4><span class="sub ls-fmnote" id="lsFmNote"></span></div>
          <canvas class="viz" id="lsFm" style="height:132px"></canvas>
          ${cap('F1–F5 不是音高（音高是 F0），是口腔喉咙的共鸣位置。F1、F2 决定是哪个元音：要和第 1 步差不多，比较才公平。研究里那位歌手用咽音时 F3–F5 靠拢（粗线变短）、F1 和 F2 升高——这里只给你看，不参与判定。音高超过约 450 Hz 测不准，不显示。', 'F1–F5 are not the pitch (that’s F0) but where the mouth and throat resonate. F1 and F2 set the vowel: keep them close to step 1’s for a fair comparison. In the singer studied, twang drew F3–F5 together (the thick line shortens) and raised F1 and F2 — shown for you, not used to judge. Above about 450 Hz they can’t be measured and aren’t shown.')}`;
  }

  // Difficulty for the twang lesson: how much more ring (the sound of a tighter
  // aryepiglottic sphincter) a pass needs; shared with the voice scope
  levelHtml() {
    const cur = this.level, d = (L) => tr(`穿透力 ≥ ${L.ring} dB · 不靠喊 ≥ ${L.perDb} 倍 · 纯净度降 ≤ ${L.rough} dB · 保持 ${L.hold} 秒`, `ring ≥ ${L.ring} dB · not shouted ≥ ${L.perDb}× · clarity drop ≤ ${L.rough} dB · hold ${L.hold} s`);
    return `<div class="seg tw-level" title="${tr('收得越紧，2–4 kHz 增强得越多：难度越高，要求比普通唱法多出的穿透力越多，也更不许靠变响、挤或漏气', 'The tighter the narrowing, the more 2–4 kHz: a higher level asks for more ring over the plain voice and allows less loudness, squeezing or breathiness')}">
      <span class="muted">${tr('难度（收紧程度）', 'Level (how tight)')}</span>
      ${Object.values(LEVELS).map((L) => `<button data-level="${L.id}" class="${L.id === cur.id ? 'on' : ''}" title="${d(L)}">${LEVEL_NAMES()[L.id]}</button>`).join('')}
      <span class="sub">${d(cur)}</span></div>`;
  }

  // Spectrum lessons (twang): the voice now against the saved reference, with
  // the 2–4 kHz gap marked, and that gap over time.
  drawSpec() {
    const $ = (id) => this.root.querySelector('#' + id);
    const step = this.lesson.steps[this.stepIdx], ctx = this.ctx(), r = this.runner, ev = r?.ev, Lv = this.level;
    const need = step.id === 'scale' ? Lv.scaleRing : Lv.ring;
    // the plain-voice curve (or, during the glide, what it covers so far) and now
    if (step.id === 'base') { const t = step.targets(this.P, ctx); drawRingCurve($('lsCurve'), { curve: this.liveCurve || null, need, live: this.live || [], range: [Math.min(...t) - 1, Math.max(...t) + 1] }); }
    else drawRingCurve($('lsCurve'), { curve: ctx.base?.curve || null, need, trail: this.ringTrail || [], now: this.now || null, good: this.nowGood ?? null });
    if ($('lsMap')) drawTwangMap($('lsMap'), { trail: this.map || [], ringMin: need, perDb: Lv.perDb, shoutLoud: SHOUT_LOUD });
    if ($('lsClos')) drawClosureMap($('lsClos'), { trail: this.clos || [], cppMax: Lv.cpp });
    const cur = r?.spec?.v || null;
    const use = step.compare === 'twang' ? ctx.twang : step.compare === 'base' ? ctx.base : null;
    const label = { base: tr('你的普通唱法（第 1 步）', 'your plain voice (step 1)'), twang: tr('你的咽音（第 2 步）', 'your twang (step 2)') }[step.compare];
    drawCompare($('lsSpec'), {
      cur, ref: use?.spec || null, curLabel: tr('现在', 'now'), refLabel: label, refColor: step.compare === 'twang' ? '#f0b429' : '#9aa3b5',
      target: step.compare === 'base' ? need : null, gain: this.nowRing ?? null, good: step.compare === 'base' && this.now ? !!this.nowGood : null,
      gainLabel: step.compare === 'base' ? tr('比同一音高的普通唱法', 'over the plain voice at this pitch') : '',
    });
    this.drawFm(ctx);
  }

  // F1–F5 rows: step 1 (and step 2 on the pinch step) against the voice now
  drawFm(ctx) {
    const cv = this.root.querySelector('#lsFm');
    if (!cv) return;
    const step = this.lesson.steps[this.stepIdx], sex = this.P.sex, r = this.runner;
    const like = (F) => { const v = F && vowelOf(F[0], F[1], sex); return v ? tr(`像${v.zh}`, `like ${v.ipa}`) : ''; };
    const rows = [];
    if (ctx.base?.fm && step.id !== 'base') rows.push({ label: tr('第 1 步 普通', 'step 1 plain'), sub: like(ctx.base.fm), F: ctx.base.fm, color: '#9aa3b5' });
    if (ctx.twang?.fm && step.compare === 'twang') rows.push({ label: tr('第 2 步 咽音', 'step 2 twang'), sub: like(ctx.twang.fm), F: ctx.twang.fm, color: '#f0b429' });
    const now = recentFm(r?.take?.frames);
    if (now) rows.push({ label: tr('现在', 'now'), sub: like(now.F), F: now.F, color: '#2fbf71', hollow: now.trust === 'rough' });
    drawFormantRows(cv, rows, { minRows: 3 });
    const st = r?.last, trust = st?.voiced ? formantTrust(st.f0) : null;
    this.root.querySelector('#lsFmNote').textContent = !st?.voiced ? (rows.length ? '' : tr('唱起来就会显示', 'sing to see it'))
      : trust === 'none' ? tr(`现在 ${Math.round(st.f0)} Hz，太高测不准`, `${Math.round(st.f0)} Hz now: too high to measure`)
      : trust === 'rough' ? tr('音偏高，只是粗略估计（空心点）', 'high note: rough estimate (hollow)') : '';
  }

  drawTrace() {
    const step = this.lesson.steps[this.stepIdx], targets = step.targets(this.P, this.ctx());
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
      const step = L.steps[this.stepIdx], ref = step.ref(this.P, this.ctx()), a4 = this.app.settings.a4;
      stopTones();
      btn.disabled = true;
      try {
        if (L.id === 'glide' || step.glideRef) await playGlide(ref[0], ref[1], 4, a4);
        else await playRef(ref, { timbre: this.app.settings.refTimbre, sex: this.P.sex, a4, noteDur: ref.length > 1 ? 0.7 : 1.8 });
      } finally { btn.disabled = false; }
      return;
    }
    if (a === 'go') {
      if (this.runner?.running) return this.runner.stop();
      if (this.app.live?.engine.running) { alert(tr('请先结束“唱一段看问题”页面的录音。', 'Please stop the recording on the “Sing & check” page first.')); return; }
      stopTones();
      this.root.querySelector('#lsResult').innerHTML = '';
      this.map = []; this.clos = []; this.ringTrail = []; this.live = []; this.liveCurve = null; this.liveT = null; this.trackT = null; this.now = null; this.nowRing = null;
      this.runner = new StepRunner(this.app, L.steps[this.stepIdx], this.P, { onEnd: (r) => this.finish(r), ctx: this.ctx() });
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
    $('lsHint').className = `ls-hint${this.lesson.spectrum ? ' fixed' : ''} ${ev.pass ? 'pass' : ev.level}`;
    $('lsProg').style.width = `${Math.round((ev.progress || 0) * 100)}%`;
    $('lsProg').style.background = ev.pass ? 'var(--good)' : 'var(--accent)';
    if (ev.seq) {
      $('lsSeq').querySelectorAll('.chip').forEach((c, i) => {
        c.className = `chip ${i < ev.seq.done ? 'done' : i === ev.seq.done ? 'next' : ''}`;
        c.textContent = `${i < ev.seq.done ? '✓ ' : ''}${midiName(ev.seq.targets[i])}`;
      });
    }
    // a measure to steer by (e.g. the twang meter): the value against its target
    const M = ev.meter, mEl = $('lsMeter');
    if (mEl) mEl.hidden = !M || !Number.isFinite(M.value);
    if (mEl && M && Number.isFinite(M.value)) {
      const max = M.max ?? 40, pos = (v) => `${Math.max(0, Math.min(100, (v / max) * 100))}%`;
      const ok = M.target == null ? null : M.lower ? M.value <= M.target : M.value >= M.target;
      mEl.innerHTML = `<div class="lm-top"><span>${M.label}</span><b class="mono">${M.value.toFixed(1)} ${M.unit}</b></div>
        <div class="lm-bar"><i style="width:${pos(M.value)};background:${ok == null ? 'var(--accent)' : ok ? 'var(--good)' : 'var(--warning)'}"></i>${M.target != null ? `<s style="left:${pos(M.target)}"></s>` : ''}</div>`;
    }
    const st = r.last;
    $('lsTimer').textContent = st ? `${st.t.toFixed(1)} s` : '';
    $('lsPitch').innerHTML = pitchNowHtml(st?.voiced ? st.f0 : 0, this.app.settings.a4);
    if (this.lesson.spectrum) {
      this.trackTwang(r);
      this.drawSpec();
    } else this.drawTrace();
  }

  // The voice now (last 0.4 s) against the plain-voice curve, for the charts:
  // the same verdict as the steps use, at the chosen level (vowel left out here)
  trackTwang(r) {
    const step = this.lesson.steps[this.stepIdx], ctx = this.ctx(), Lv = this.level, fr = r.take.frames, st = r.last;
    if (!st) return;
    if (step.id === 'base') {
      if (this.liveT != null && st.t - this.liveT < 0.3) return;
      this.liveT = st.t;
      const pts = fr.filter((f) => f.voiced && !f.muted && Number.isFinite(f.midi) && Number.isFinite(f.hbr)).map((f) => ({ midi: f.midi, hbr: f.hbr, vdb: f.vdb, hnr: f.hnrLite }));
      this.live = pts.slice(-600);
      this.liveCurve = buildCurve(pts);
      return;
    }
    const end = fr.length ? fr[fr.length - 1].t : 0, rec = fr.filter((f) => f.voiced && !f.muted && end - f.t <= 0.4);
    const med = (k) => { const v = rec.map((f) => f[k]).filter(Number.isFinite).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : NaN; };
    if (rec.length < 4 || !ctx.base?.curve) { this.now = null; this.nowRing = null; return; }
    const now = { midi: med('midi'), hbr: med('hbr'), vdb: med('vdb'), hnr: med('hnrLite'), h1h2: med('h1h2'), cpp: med('cpp') };
    const need = step.id === 'scale' ? Lv.scaleRing : Lv.ring;
    const v = twangVerdict(ctx.base, now, { ringMin: need, perDb: Lv.perDb, roughMax: Lv.rough, cppMax: Lv.cpp, allowNoVowel: true });
    this.now = { midi: now.midi, hbr: now.hbr };
    this.nowGood = v.status === 'twang';
    this.nowRing = Number.isFinite(v.ring) ? v.ring : null;
    if (this.trackT != null && st.t - this.trackT < 0.1) return;
    this.trackT = st.t;
    const keep = (a, x) => { a.push(x); if (a.length > 30) a.shift(); };
    keep(this.ringTrail, this.now);
    if (Number.isFinite(v.ring)) keep(this.map, { t: st.t, ring: v.ring, loud: v.loud });
    if (Number.isFinite(v.closure?.dCpp)) keep(this.clos, { dH: v.closure.dH, dCpp: v.closure.dCpp });
  }

  finish(r) {
    cancelAnimationFrame(this.raf);
    if (!this.root.querySelector('#lsHint')) return;
    this.update(r);
    const L = this.lesson, step = r.step, ev = r.ev, pass = ev.pass;
    if (pass && ev.save) {
      // keep the spectrum with the saved reference (for the comparison views)
      const spec = r.spec?.v ? Array.from(r.spec.v, (v) => Math.round(v * 10) / 10) : null;
      for (const k of Object.keys(ev.save)) if (spec) ev.save[k].spec = spec;
      if (!saveTwang(ev.save)) alert(tr('没能保存这一步的结果（浏览器不允许本地存储），后面的步骤会用不了它。', 'Couldn’t save this step’s result (the browser blocks local storage); later steps won’t be able to use it.'));
    }
    const score = Number.isFinite(ev.score) ? ev.score : pass ? 60 : 0;
    const all = loadProgress();
    const prev = entry(all[L.id]?.[step.id]);
    const best = Math.max(prev?.best ?? 0, score);
    const isBest = !prev?.best || score > prev.best;
    // the twang lesson remembers the hardest level each step was passed at
    const rank = (id) => Object.keys(LEVELS).indexOf(id);
    const level = L.id === 'twang' && step.id !== 'base' ? (pass && rank(this.level.id) >= rank(prev?.level ?? '') ? this.level.id : prev?.level) : undefined;
    all[L.id] = { ...(all[L.id] || {}), [step.id]: { passed: !!(pass || prev?.passed), best, at: Date.now(), ...(level ? { level } : {}) } };
    saveProgress(all);
    const btn = this.root.querySelectorAll('.stepbtn')[this.stepIdx];
    if (btn && (pass || prev?.passed)) { btn.classList.add('done'); btn.textContent = `✓ ${step.title} · ${best}${level ? ` · ${LEVEL_NAMES()[level]}` : ''}`; }
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
