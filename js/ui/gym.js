// Pitch trainer page: rounds of 10 generated sing-back items. Each item:
// hear the reference → think it for a second → sing → at once how far off it
// was. The microphone stays open for the whole round; while the reference
// plays (and its echo dies away) it counts as silence.

import { VOICE_TYPES, midiName } from '../config.js';
import { AudioEngine } from '../audio/engine.js';
import { FrameAnalyzer } from '../dsp/analyzer.js';
import { PitchTracker } from '../analysis/pitch.js';
import { playRef, stopTones, refSounding } from '../audio/tone.js';
import { PitchTrack } from '../viz/pitchTrack.js';
import {
  TOLS, KINDS, KIND_NAME, DEGREE_STAGES, ECHO_STAGES, makeItem, planRound, judge, liveDev, record, summarize,
  newState, restore, tolOf, habitOf, feedbackOf, degreeName, devText, taskText, resultText, findingText,
} from '../gym/drills.js';
import { L as tr } from '../i18n.js';
import { pitchNowHtml } from './pitchNow.js';

const KEY = 'vocalassistant.gym.v1';
const THINK = 1.0; // s of silence after the reference: hear it in your head first
const load = () => { try { return restore(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return newState(); } };
const save = (st) => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* storage unavailable */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
const CIRCLED = ['①', '②', '③', '④', '⑤', '⑥'];

export class GymView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.st = load();
    this.phase = 'idle'; // idle · play · think · sing · result · paused · done
    this.gen = 0;
    this.results = [];
    this.frames = [];
  }

  get P() { return VOICE_TYPES[this.app.settings.voiceType]; }
  get inRound() { return ['play', 'think', 'sing', 'result', 'paused'].includes(this.phase); }

  show() {
    if (this.inRound) return;
    this.render();
  }

  // ------------------------------------------------------------------ page
  render() {
    const st = this.st, pr = st.prefs, S = this.app.settings;
    const opt = (v, cur, text) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${text}</option>`;
    this.root.innerHTML = `
      <div class="ph"><h3 style="font-size:16px">${tr('音准训练场', 'Pitch trainer')}</h3>
        <span class="sub">${tr('每轮 10 题，自动出题：随机跟唱、听一唱二、回声短句。唱准了判定线自动收紧；唱稳了，改成唱完才显示音高线。', 'Rounds of 10 generated items: matching, hear do & sing another note, echoes. The pass line tightens as you get it right; once you’re steady, the pitch line appears only after you sing.')}</span></div>
      <div class="gym-opts">
        <label>${tr('题型', 'Items')} <select id="gKinds">${opt('mix', pr.kinds, tr('混合（推荐）', 'Mixed (recommended)'))}${KINDS.map((k) => opt(k, pr.kinds, tr(`只练${KIND_NAME[k]}`, `${KIND_NAME[k]} only`))).join('')}</select></label>
        <label>${tr('反馈', 'Feedback')} <select id="gFb">${opt('auto', pr.feedback, tr('自动（推荐）', 'Automatic (recommended)'))}${opt('live', pr.feedback, tr('边唱边看音高线', 'Pitch line while singing'))}${opt('blind', pr.feedback, tr('唱完再看', 'Only after singing'))}</select></label>
        <label>${tr('参考音', 'Reference')} <select id="gTimbre">${opt('voice', S.refTimbre, tr('人声“啊”（推荐）', 'Sung “ah” (recommended)'))}${opt('piano', S.refTimbre, tr('钢琴', 'Piano'))}</select></label>
        <span class="pill" id="gFbNow"></span>
      </div>
      <div class="gym-grid">
        <div class="panel gym-task">
          <div class="gym-top"><div class="gym-dots" id="gDots"></div><span class="sub" id="gCount"></span></div>
          <div class="gym-kind"><span class="pill" id="gKind"></span> <span class="muted" id="gTol"></span></div>
          <div class="gym-say" id="gSay"></div>
          <div class="gym-phases" id="gPhases">
            <span data-p="play">${tr('① 听', '① Listen')}</span><span data-p="think">${tr('② 心里唱一遍', '② Hear it in your head')}</span><span data-p="sing">${tr('③ 唱', '③ Sing')}</span>
          </div>
          <div class="ls-hint idle" id="gHint"></div>
          <div id="gRes"></div>
          <div class="cal-actions" id="gBtns">
            <button class="btn primary" id="gGo">${tr('● 开始一轮', '● Start a round')}</button>
            <button class="btn" id="gRef" hidden>${tr('▶ 再听一遍', '▶ Hear it again')}</button>
            <button class="btn" id="gSkip" hidden>${tr('跳过这题', 'Skip')}</button>
            <button class="btn" id="gPause" hidden>${tr('⏸ 暂停', '⏸ Pause')}</button>
          </div>
        </div>
        <div class="panel">
          <div class="ph"><h3>${tr('音高线', 'Pitch line')}</h3><div class="ph-right" id="gPitch">${pitchNowHtml(0)}</div><span class="sub">${tr('绿带 = 要唱的音，带子宽度就是现在的判定线；灰带 = 只听不唱的 do', 'Green band = the note to sing, as wide as the current pass line; grey band = do (heard, not sung)')}</span></div>
          <div class="gym-trace"><canvas class="viz" id="gTrace" style="height:260px"></canvas>
            <div class="gym-blind" id="gBlind" hidden>${tr('唱完再显示音高线<br><span class="muted">这一阶段练的是：不看屏幕也能唱准</span>', 'The pitch line appears after you sing<br><span class="muted">This stage trains singing in tune without watching the screen</span>')}</div></div>
          <div class="gym-level"><span class="muted">${tr('麦克风', 'Mic')}</span><div class="level"><div id="gLevel"></div></div></div>
        </div>
      </div>
      <div id="gSummary"></div>
      <div class="panel gym-status" id="gStatus"></div>
      <details class="panel gym-why"><summary>${tr('为什么这样练', 'Why it works this way')}</summary>
        <ul>
          <li>${tr('唱不准的人多半不是耳朵有问题，而是“听到的音”和“嗓子该怎么动”没对上，所以每一题都是听了就唱（Pfordresher & Brown 2007；Hutchins & Peretz 2012）。', 'Singing out of tune is rarely a hearing problem; the link between the note you hear and what the voice must do is off. So every item is hear-then-sing (Pfordresher & Brown 2007; Hutchins & Peretz 2012).')}</li>
          <li>${tr('目标音在你舒服音区的一个八度里随机出，题型也穿插着出：在一个八度里练比在五度里练更有效，穿插练比同一题反复练记得牢（Pfordresher & Greenspon 2025；Stambaugh 2011）。', 'Targets are random over an octave of your comfortable range, and the kinds are mixed: training over an octave worked better than within a fifth, and mixed practice is retained better than repeating one thing (Pfordresher & Greenspon 2025; Stambaugh 2011).')}</li>
          <li>${tr('“听一唱二”从 do 出发唱别的音，先练 mi、sol，唱准了再解锁 re、la、fa、高音 do、ti 和 do 下方的音。唱不准的人常把大跳唱小，回声短句里会逐步加入更大的跳进。', '“Hear do, sing another” starts with mi and sol and unlocks re, la, fa, high do, ti and the notes below do as you get them right. Inaccurate singers tend to shrink big leaps; echoes add bigger leaps step by step.')}</li>
          <li>${tr('听完先在心里唱一遍再开口：脑子里越能“听见”目标音，唱得越准（Pfordresher & Halpern 2013）。', 'Hear the note in your head before singing: the more vividly you can imagine the target, the more accurately you sing it (Pfordresher & Halpern 2013).')}</li>
          <li>${tr(`判定线会自己调整：同一题型连续唱准 3 题就收紧（±${TOLS.join(' → ±')} 音分），唱错一题就放宽一级，让你一直在“努力一下就能做到”的难度上练（大约八成能过）。`, `The pass line adapts: 3 passes in a row of one kind tighten it (±${TOLS.join(' → ±')} cents), a miss loosens it one step, so you always practise at “just about doable” (about 80 % passes).`)}</li>
          <li>${tr('反馈会慢慢撤掉：开始时边唱边看音高线；一旦稳定，就改成唱完才显示。一直看着屏幕练出来的准，撤掉屏幕后容易退回去（Paney & Tharp 2021）。', 'Feedback fades: at first you watch the pitch line while singing; once you’re steady it shows only afterwards. Accuracy practised while always watching a screen tends to fade when the screen goes (Paney & Tharp 2021).')}</li>
          <li>${tr('参考音默认是人声“啊”，按你的声部放在你的八度：跟人声比跟乐器更容易唱准（Watts & Hall 2008）。播放参考音时麦克风不收音，所以不用戴耳机。', 'The reference is a sung “ah” in your octave (from your voice type): people match a voice more accurately than an instrument (Watts & Hall 2008). The microphone ignores the reference while it plays, so no headphones are needed.')}</li>
        </ul>
        <p class="muted" style="font-size:12px;margin:6px 0 0"><button class="btn" id="gReset">${tr('重置难度和记录', 'Reset level and records')}</button></p>
      </details>`;
    const $ = (id) => this.root.querySelector('#' + id);
    $('gKinds').onchange = (e) => { this.st.prefs.kinds = e.target.value; save(this.st); };
    $('gFb').onchange = (e) => { this.st.prefs.feedback = e.target.value; save(this.st); this.renderFbNow(); };
    $('gTimbre').onchange = (e) => this.app.updateSettings({ refTimbre: e.target.value });
    $('gGo').onclick = () => (this.inRound ? this.stop() : this.start());
    $('gRef').onclick = () => this.again();
    $('gSkip').onclick = () => this.skip();
    $('gPause').onclick = () => this.togglePause();
    $('gReset').onclick = () => {
      if (!confirm(tr('把判定线、解锁进度和每轮记录都清零？', 'Reset the pass lines, unlocked items and round records?'))) return;
      const prefs = this.st.prefs;
      this.st = newState(); this.st.prefs = prefs; save(this.st); this.render();
    };
    this.trace = new PitchTrack($('gTrace'));
    this.renderFbNow();
    this.renderStatus();
    if (this.phase === 'done' && this.summary) this.renderSummary(this.summary);
    this.renderIdle();
  }

  renderFbNow() {
    const el = this.root.querySelector('#gFbNow');
    if (!el) return;
    const fb = feedbackOf(this.st);
    el.textContent = fb === 'live' ? tr('现在：边唱边看', 'Now: line while singing') : tr('现在：唱完再看', 'Now: line after singing');
    el.title = this.st.prefs.feedback === 'auto' ? tr('自动：连续唱得稳就改成唱完再看；失误多了再回到边唱边看', 'Automatic: once you’re steady the line shows only after singing; after several misses it comes back') : '';
  }

  // levels, unlocked items, recent rounds
  renderStatus() {
    const el = this.root.querySelector('#gStatus');
    if (!el) return;
    const st = this.st;
    const degs = DEGREE_STAGES.slice(0, st.degreeStage).flat().map(degreeName).join(tr('、', ', '));
    const E = ECHO_STAGES[st.echoStage - 1];
    const rounds = st.rounds.slice(-8);
    el.innerHTML = `<div class="ph"><h3>${tr('你的进度', 'Your progress')}</h3><span class="sub">${tr('保存在这个浏览器里', 'Saved in this browser')}</span></div>
      <div class="gym-prog">
        ${KINDS.map((k) => `<div><span class="muted">${KIND_NAME[k]}</span><b class="mono">±${tolOf(st, k)}</b><span class="muted">${tr('音分判定线', 'cents pass line')}</span></div>`).join('')}
      </div>
      <p class="t2" style="font-size:13px;margin:8px 0 4px">${tr(`听一唱二已解锁：${degs}`, `Hear do, sing another — unlocked: ${degs}`)}${st.degreeStage < DEGREE_STAGES.length ? tr(`（下一批：${DEGREE_STAGES[st.degreeStage].map(degreeName).join('、')}）`, ` (next: ${DEGREE_STAGES[st.degreeStage].map(degreeName).join(', ')})`) : ''}</p>
      <p class="t2" style="font-size:13px;margin:0 0 4px">${tr(`回声短句：第 ${st.echoStage} / ${ECHO_STAGES.length} 级，${E.len} 个音`, `Echoes: level ${st.echoStage} / ${ECHO_STAGES.length}, ${E.len} notes`)}</p>
      ${rounds.length ? `<p class="t2" style="font-size:13px;margin:0">${tr('最近几轮唱在 ±50 音分以内的音：', 'Recent rounds, notes within ±50 cents: ')}<span class="mono">${rounds.map((r) => pct(r.within50)).join(' → ')}</span></p>` : ''}`;
  }

  renderIdle() {
    const $ = (id) => this.root.querySelector('#' + id);
    if (!$('gHint')) return;
    this.setButtons();
    $('gDots').innerHTML = '';
    $('gCount').textContent = '';
    $('gKind').textContent = tr('准备好了吗', 'Ready?');
    $('gTol').textContent = '';
    $('gSay').innerHTML = tr('每题：听 → 在心里唱一遍 → 唱出来', 'Each item: listen → hear it in your head → sing');
    $('gHint').className = 'ls-hint idle';
    $('gHint').textContent = tr('点“开始一轮”并允许麦克风。用“啊”或“嗯”唱，每个音唱 1 秒左右就行。', 'Press “Start a round” and allow the microphone. Sing on “ah” or a hum; about a second per note is enough.');
    $('gRes').innerHTML = '';
    this.setPhase(null);
    this.draw();
  }

  setButtons() {
    const $ = (id) => this.root.querySelector('#' + id);
    if (!$('gGo')) return;
    const r = this.inRound;
    $('gGo').textContent = r ? tr('■ 结束这一轮', '■ End round') : this.phase === 'done' ? tr('● 再来一轮', '● Another round') : tr('● 开始一轮', '● Start a round');
    $('gGo').classList.toggle('recording', r);
    $('gRef').hidden = !r;
    $('gSkip').hidden = !r || !['play', 'think', 'sing'].includes(this.phase);
    $('gPause').hidden = !['result', 'paused'].includes(this.phase);
    $('gPause').textContent = this.phase === 'paused' ? tr('▶ 继续', '▶ Continue') : tr('⏸ 暂停', '⏸ Pause');
    for (const id of ['gKinds', 'gFb', 'gTimbre']) $(id).disabled = r;
  }

  setPhase(p) {
    this.root.querySelectorAll('#gPhases span').forEach((s) => {
      const order = ['play', 'think', 'sing'];
      s.className = s.dataset.p === p ? 'on' : p && order.indexOf(s.dataset.p) < order.indexOf(p) ? 'done' : '';
    });
  }

  renderDots() {
    const el = this.root.querySelector('#gDots');
    if (!el || !this.plan) return;
    el.innerHTML = this.plan.map((k, i) => {
      const r = this.results[i];
      const c = i === this.idx && !r ? 'cur' : !r ? '' : r.res.skipped || r.res.noAnswer ? 'skip' : r.res.ok ? 'ok' : 'bad';
      return `<i class="${c}" title="${KIND_NAME[k]}"></i>`;
    }).join('');
    this.root.querySelector('#gCount').textContent = tr(`第 ${Math.min(this.idx + 1, this.plan.length)} / ${this.plan.length} 题`, `Item ${Math.min(this.idx + 1, this.plan.length)} / ${this.plan.length}`);
  }

  // ------------------------------------------------------------------ round
  async start() {
    if (this.app.live?.engine.running) { alert(tr('请先结束“唱一段看问题”页面的录音。', 'Please stop the recording on the “Sing & check” page first.')); return; }
    stopTones();
    const my = ++this.gen;
    const S = this.app.settings;
    const eng = new AudioEngine();
    let an = null;
    eng.onFrame = (frame, t) => { if (an && t >= 0 && this.eng === eng) this.onFrame(an.analyze(frame, { gateDb: S.gateDb, pitchOnly: true }), t); };
    try { await eng.startMic({ deviceId: S.deviceId, record: false }); } catch (err) { alert(tr(`麦克风错误：${err.message}`, `Microphone error: ${err.message}`)); return; }
    if (my !== this.gen) { eng.stop(); return; }
    this.eng = eng;
    an = new FrameAnalyzer(eng.sampleRate);
    this.pt = new PitchTracker(S);
    this.t = 0;
    this.plan = planRound(this.st.prefs.kinds);
    this.results = [];
    this.idx = -1;
    this.item = null;
    this.noAnswers = 0;
    this.summary = null;
    this.root.querySelector('#gSummary').innerHTML = '';
    this.loop();
    this.next(my);
  }

  onFrame(feat, t) {
    this.t = t;
    const muted = refSounding();
    const st = this.pt.update(muted ? { ...feat, voiced: false } : feat, t);
    this.db = muted ? -100 : feat.db;
    if (!['play', 'think', 'sing'].includes(this.phase)) return;
    this.frames.push(st);
    if (this.phase === 'play') return;
    if (this.from == null && !muted) this.from = t; // the reference and its echo are over
    if (this.phase === 'think' && t >= this.thinkEnd) { this.phase = 'sing'; this.setPhase('sing'); }
    if (this.from != null && t - this.lastEval >= 0.1) {
      this.lastEval = t;
      const res = judge(this.item, this.frames, this.from, t, this.tol, { habit: habitOf(this.st) });
      if (res) this.finishItem(res);
    }
  }

  ref(notes) {
    const S = this.app.settings;
    return playRef(notes, { timbre: S.refTimbre, sex: this.P.sex, a4: S.a4, noteDur: notes.length > 1 && this.item.kind === 'echo' ? 0.6 : 1.3, gap: 0.1 });
  }

  async next(my) {
    if (my !== this.gen) return;
    this.idx++;
    if (this.idx >= this.plan.length) return this.endRound();
    const kind = this.plan[this.idx];
    this.item = makeItem(kind, this.P, this.st, Math.random, this.item);
    this.tol = tolOf(this.st, kind);
    this.fb = feedbackOf(this.st);
    this.renderItem();
    await this.listen(my);
  }

  // play the reference, then the thinking second, then singing
  async listen(my) {
    this.frames = []; this.from = null; this.lastEval = -1; this.res = null;
    this.itemT0 = this.t;
    this.phase = 'play';
    this.setPhase('play');
    this.setButtons();
    this.hint(tr('听…', 'Listen…'), 'idle');
    const done = await this.ref(this.item.ref);
    if (my !== this.gen || this.phase !== 'play' || !done) return;
    this.phase = 'think';
    this.thinkEnd = this.t + THINK;
    this.setPhase('think');
    this.setButtons();
    this.hint(tr('在心里唱一遍…', 'Hear it in your head…'), 'idle');
  }

  renderItem() {
    const $ = (id) => this.root.querySelector('#' + id);
    const it = this.item;
    $('gKind').textContent = KIND_NAME[it.kind];
    $('gTol').textContent = tr(`判定线 ±${this.tol} 音分`, `pass line ±${this.tol} cents`);
    $('gSay').innerHTML = taskText(it);
    $('gRes').innerHTML = '';
    this.renderDots();
    this.renderFbNow();
  }

  hint(text, level) {
    const el = this.root.querySelector('#gHint');
    if (!el) return;
    el.textContent = text;
    el.className = `ls-hint ${level}`;
  }

  finishItem(res) {
    const my = this.gen, it = this.item;
    this.phase = 'result';
    this.res = res;
    const ev = record(this.st, it, res);
    save(this.st);
    this.results[this.idx] = { item: it, res };
    this.noAnswers = res.noAnswer ? this.noAnswers + 1 : 0;
    this.setPhase(null);
    this.setButtons();
    this.renderDots();
    this.renderResult(ev);
    (async () => {
      // after a miss: the right answer once more (for a degree: do, then the note)
      if (!res.ok && !res.noAnswer) {
        await sleep(400);
        if (my !== this.gen || this.phase !== 'result') return;
        await this.ref(it.kind === 'degree' ? [it.tonic, it.notes[0]] : it.notes);
      }
      await sleep(res.ok ? 1300 : res.noAnswer ? 800 : 2200);
      if (my !== this.gen || this.phase !== 'result') return;
      if (this.noAnswers >= 2) { this.pause(tr('连续两题没听到声音，先暂停了。准备好了点“继续”。', 'Didn’t hear you twice in a row, so it’s paused. Press “Continue” when you’re ready.')); return; }
      this.next(my);
    })();
  }

  renderResult(ev) {
    const it = this.item, res = this.res;
    this.hint(resultText(it, res), res.ok ? 'pass' : res.noAnswer ? 'idle' : 'off');
    const notes = res.notes || [];
    const chips = it.kind === 'echo' && notes.length
      ? `<div class="gym-notes">${notes.map((n, i) => `<span class="${Math.abs(n.dev) <= res.tol ? 'ok' : 'bad'}">${CIRCLED[i]} ${Math.abs(n.dev) <= res.tol ? '✓' : '✗'} ${n.dev > 0 ? '+' : ''}${Math.round(n.dev)}</span>`).join('')}</div>`
      : notes.length && !res.octaveErr ? `<div class="muted" style="font-size:12.5px;margin-top:6px">${tr('目标', 'Target')} ${midiName(notes[0].target)} · ${tr('你唱的：', 'you: ')}${devText(notes[0].dev)}</div>` : '';
    const msgs = [];
    if (ev.tighter) msgs.push(tr(`连续唱准 3 题：${KIND_NAME[it.kind]}的判定线收紧到 ±${ev.tighter} 音分`, `3 in a row: the ${KIND_NAME[it.kind]} pass line tightens to ±${ev.tighter} cents`));
    if (ev.looser) msgs.push(tr(`${KIND_NAME[it.kind]}的判定线放宽到 ±${ev.looser} 音分`, `The ${KIND_NAME[it.kind]} pass line loosens to ±${ev.looser} cents`));
    if (ev.unlocked === 'degree') msgs.push(tr(`解锁新的音：${DEGREE_STAGES[this.st.degreeStage - 1].map(degreeName).join('、')}`, `New notes unlocked: ${DEGREE_STAGES[this.st.degreeStage - 1].map(degreeName).join(', ')}`));
    if (ev.unlocked === 'echo') msgs.push(tr(`回声短句升到第 ${this.st.echoStage} 级：${ECHO_STAGES[this.st.echoStage - 1].len} 个音，跳进更大`, `Echoes level ${this.st.echoStage}: ${ECHO_STAGES[this.st.echoStage - 1].len} notes, bigger leaps`));
    if (ev.fb === 'blind') msgs.push(tr('唱得很稳：接下来改成唱完再看音高线', 'Nice and steady: from now on the pitch line shows after you sing'));
    if (ev.fb === 'live') msgs.push(tr('先回到边唱边看音高线', 'Back to the pitch line while singing for now'));
    const again = !res.ok && !res.noAnswer ? `<div class="muted" style="font-size:12.5px;margin-top:6px">${tr('再放一遍正确的音…', 'Playing the right notes again…')}</div>` : '';
    this.root.querySelector('#gRes').innerHTML = chips + again + msgs.map((m) => `<div class="gym-ev">${m}</div>`).join('');
    this.renderFbNow();
  }

  // replay the reference: during an item it restarts the attempt; afterwards it pauses
  async again() {
    const my = this.gen;
    if (['result', 'paused'].includes(this.phase)) {
      this.pause();
      stopTones();
      const it = this.item;
      await this.ref(it.kind === 'degree' ? [it.tonic, it.notes[0]] : it.notes);
      return;
    }
    if (!['play', 'think', 'sing'].includes(this.phase)) return;
    stopTones();
    await sleep(50);
    if (my === this.gen) this.listen(my);
  }

  skip() {
    if (!['play', 'think', 'sing'].includes(this.phase)) return;
    stopTones();
    this.results[this.idx] = { item: this.item, res: { skipped: true, noAnswer: true, ok: false, notes: [], intervals: [] } };
    this.noAnswers = 0;
    this.renderDots();
    const my = ++this.gen; // drops the pending reference / thinking
    this.next(my);
  }

  pause(msg) {
    if (!this.inRound) return;
    this.phase = 'paused';
    this.setButtons();
    if (msg) this.hint(msg, 'idle');
  }

  togglePause() {
    if (this.phase === 'paused') { stopTones(); this.phase = 'result'; this.next(++this.gen); return; }
    this.pause();
  }

  async stop() {
    const had = this.results.some(Boolean);
    this.gen++;
    stopTones();
    const eng = this.eng;
    this.eng = null;
    cancelAnimationFrame(this.raf);
    if (eng) await eng.stop();
    if (this.inRound) {
      if (had) return this.endRound(true);
      this.phase = 'idle';
      this.renderIdle();
    }
  }

  async endRound(early = false) {
    this.gen++;
    cancelAnimationFrame(this.raf);
    const eng = this.eng;
    this.eng = null;
    if (eng) eng.stop();
    const results = this.results.filter(Boolean);
    const S = summarize(results, this.P);
    S.early = early;
    S.planned = this.plan.length;
    if (S.n) {
      this.st.rounds.push({ at: Date.now(), n: S.n, ok: S.ok, within50: S.within50, typical: S.typical });
      while (this.st.rounds.length > 30) this.st.rounds.shift();
      save(this.st);
    }
    this.summary = S;
    this.phase = 'done';
    if (!this.root.querySelector('#gHint')) return;
    this.renderSummary(S);
    this.renderStatus();
    this.renderIdle();
    this.renderDots();
    this.hint(tr('这一轮结束了，看看下面的小结。', 'Round over — see the summary below.'), 'idle');
    this.root.querySelector('#gSummary').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  renderSummary(S) {
    const el = this.root.querySelector('#gSummary');
    if (!el) return;
    const rounds = this.st.rounds;
    const prev = rounds.length >= 2 ? rounds[rounds.length - 2] : null;
    const f = S.findings.map(findingText);
    el.innerHTML = `<div class="panel gym-sum">
      <div class="ph"><h3>${tr('这一轮小结', 'Round summary')}</h3><span class="sub">${S.early ? tr(`提前结束，答了 ${S.n} 题`, `Ended early after ${S.n} item${S.n === 1 ? '' : 's'}`) : tr(`答了 ${S.n} / ${S.planned} 题`, `${S.n} / ${S.planned} items answered`)}</span></div>
      ${S.n ? `<div class="gym-stats">
        <div><b class="mono">${S.ok} / ${S.n}</b><span>${tr('通过（按当时的判定线）', 'passed (at the pass line of the moment)')}</span></div>
        <div><b class="mono">${pct(S.within50)}</b><span>${tr('唱在 ±50 音分以内的音——研究里“唱对了音”的标准', 'notes within ±50 cents — the research line for “the right note”')}${prev && Number.isFinite(prev.within50) ? `<br><span class="muted">${tr('上一轮', 'last round')} ${pct(prev.within50)}</span>` : ''}</span></div>
        <div><b class="mono">${Number.isFinite(S.typical) ? Math.round(S.typical) : '—'}</b><span>${tr('一般偏差（音分，中位数）；专业歌手约 20–30', 'typical deviation (cents, median); professional singers ≈ 20–30')}</span></div>
      </div>
      ${f.length ? `<ul class="gym-find">${f.map((x) => `<li><b>${x.text}</b><br><span class="t2">${x.tip}</span></li>`).join('')}</ul>`
        : `<p class="t2" style="font-size:13px">${S.notes >= 5 ? tr('没有发现明显的规律性偏差，继续保持。', 'No consistent tendency found — keep it up.') : tr('唱的音还不够多，再多答几题才能看出规律。', 'Not enough notes yet to see tendencies — answer a few more items.')}</p>`}`
        : `<p class="t2">${tr('这一轮没有作答的题。', 'No items were answered in this round.')}</p>`}
    </div>`;
  }

  // ------------------------------------------------------------------ drawing
  loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.eng || !this.root.querySelector('#gTrace')) return;
      this.draw();
      const lv = this.root.querySelector('#gLevel');
      if (lv) lv.style.width = `${Math.max(0, Math.min(100, ((this.db ?? -100) + 60) * 2))}%`;
      const pn = this.root.querySelector('#gPitch'), lf = this.frames[this.frames.length - 1];
      // in "after singing" mode the pitch stays hidden while singing, like the line
      if (pn) pn.innerHTML = pitchNowHtml(lf?.voiced && !(this.fb === 'blind' && this.phase === 'sing') ? lf.f0 : 0, this.app.settings.a4);
      if (this.phase === 'think' || this.phase === 'sing') this.liveHint();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  liveHint() {
    if (this.fb === 'blind') {
      if (this.phase === 'sing') this.hint(tr('唱吧——唱完告诉你结果', 'Sing — the result comes when you’re done'), 'idle');
      return;
    }
    const d = this.from == null ? null : liveDev(this.item, this.frames, this.from, this.t, habitOf(this.st));
    if (!d) { if (this.phase === 'sing') this.hint(tr('唱！', 'Sing!'), 'idle'); return; }
    if (d.count != null) { this.hint(tr(`第 ${Math.min(d.count, this.item.notes.length)} / ${this.item.notes.length} 个音…`, `Note ${Math.min(d.count, this.item.notes.length)} / ${this.item.notes.length}…`), 'ok'); return; }
    const a = Math.abs(d.dev);
    if (a > 600) this.hint(tr('差了一个八度', 'An octave off'), 'off');
    else if (a <= this.tol) this.hint(tr(`准（${devText(d.dev)}），保持…`, `In tune (${devText(d.dev)}), hold it…`), 'ok');
    else this.hint(`${devText(d.dev)}${d.dev < 0 ? tr('，往上一点', ' — a little up') : tr('，往下一点', ' — a little down')}`, 'off');
  }

  draw() {
    const cv = this.root.querySelector('#gTrace');
    if (!cv || !this.trace) return;
    const it = this.item, blindNow = this.fb === 'blind' && ['play', 'think', 'sing'].includes(this.phase);
    this.root.querySelector('#gBlind').hidden = !blindNow;
    const fr = it && this.inRound ? this.frames : [];
    const data = { t: fr.map((f) => f.t), midi: fr.map((f) => (f.voiced ? f.midi : NaN)) };
    const t0 = it && this.inRound ? this.itemT0 : 0;
    const tEnd = Math.max(t0 + 6, fr.length ? fr[fr.length - 1].t : 0);
    const R = { lo: this.P.mid - 7, hi: this.P.mid + 7 };
    const targets = [];
    if (it && this.inRound) {
      // the singer's octave, if they're in another one (matching / echo: any octave counts)
      const sung = data.midi.filter(Number.isFinite).slice(-40).sort((a, b) => a - b);
      const mid = it.notes.reduce((a, b) => a + b, 0) / it.notes.length;
      const k = it.kind !== 'degree' && sung.length > 10 ? Math.round((sung[sung.length >> 1] - mid) / 12) : 0;
      if (it.kind === 'degree') targets.push({ midi: it.tonic, label: 'do', ref: true, tol: 20 });
      it.notes.forEach((m, i) => targets.push({ midi: m + 12 * k, tol: this.tol, label: it.kind === 'echo' ? CIRCLED[i] : it.kind === 'degree' ? degreeName(it.off) : midiName(m + 12 * k) }));
    }
    const all = targets.map((g) => g.midi);
    this.trace.draw(blindNow ? { t: [], midi: [] } : data, {
      t0: tEnd - Math.max(6, tEnd - t0), t1: tEnd,
      lo: all.length ? Math.min(...all) - 2 : R.lo, hi: all.length ? Math.max(...all) + 2 : R.hi,
      targets: blindNow ? [] : targets,
      marks: !blindNow && this.phase !== 'play' && this.res?.notes ? this.res.notes.filter((n) => n.t0 != null).map((n) => ({ t: (n.t0 + n.t1) / 2, icon: Math.abs(n.dev) <= this.res.tol ? '✓' : '✗', color: Math.abs(n.dev) <= this.res.tol ? '#2fbf71' : '#ef5a5a', label: devText(n.dev) })) : [],
    });
  }
}
