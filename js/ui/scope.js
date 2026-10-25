// "声音显微镜" / Voice scope: the voice seen four ways at once — waveform,
// spectrum, spectrogram, and a schematic vocal tract estimated from the sound —
// with the problems it points to and a twang meter.

import { VOICE_TYPES, hzToMidi, midiName } from '../config.js';
import { AudioEngine } from '../audio/engine.js';
import { FrameAnalyzer } from '../dsp/analyzer.js';
import { VoiceState } from '../analysis/voiceState.js';
import { drawWave, Spectrogram, TractView, drawCompare, pool, SpecAvg, sprOf } from '../viz/scope.js';
import { ref, refsSection } from '../refs.js';
import { glossaryHtml } from './glossary.js';
import { pitchNowHtml } from './pitchNow.js';
import { drawVowelChart, drawFormantRows, rowColor } from '../viz/formants.js';
import { REF_VOWELS, vowelOf, fmMedians, formantTrust } from '../analysis/vowels.js';
import { twangVerdict, buildCurve, curveSpan, okCurve, levelOf } from '../analysis/twang.js';
import { loadTwang } from '../lessons/lessons.js';
import { drawVoiceSpectrum } from '../viz/voiceSpec.js';
import { harmonicsOf } from '../along/spectra.js';
import { L } from '../i18n.js';

const BASE_KEY = 'vocalassistant.scope.base.v1';
const loadBase = () => { try { return JSON.parse(localStorage.getItem(BASE_KEY) || 'null'); } catch { return null; } };
const saveBase = (b) => { try { localStorage.setItem(BASE_KEY, JSON.stringify(b)); } catch { /* ignore */ } };
// kept sounds for the formant rows: { n, F: [F1..F5], label, hollow }
const PIN_KEY = 'vocalassistant.scope.pins.v1';
const loadPins = () => { try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]'); } catch { return []; } };
const savePins = (p) => { try { localStorage.setItem(PIN_KEY, JSON.stringify(p)); } catch { /* ignore */ } };
// each kept sound keeps its colour (green is the voice now)
const pinColor = (p) => rowColor(1 + ((p.n || 1) - 1) % 5);

export class ScopeView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.eng = null;
    this.frozen = false;
  }

  get P() { return VOICE_TYPES[this.app.settings.voiceType]; }

  show() {
    if (this.eng) return;
    this.render();
  }

  render() {
    const view = this.view || 'wave';
    this.root.innerHTML = `
      <div class="ph"><h3 style="font-size:16px">${L('声音显微镜', 'Voice scope')}</h3>
        <span class="sub">${L('看你的声音：穿透力（亮不亮、传不传得远）、推测的口腔喉咙形状、有什么问题', 'Your voice seen: its ring (how bright it is and how far it carries), the estimated mouth and throat shape, and what to fix')}</span></div>
      <div class="live-controls">
        <button class="btn primary" id="scGo">${L('● 开始', '● Start')}</button>
        <button class="btn" id="scFile">${L('分析录音文件', 'Analyse a recording')}</button>
        <input type="file" id="scInput" accept="audio/*" class="hidden" />
        <button class="btn" id="scFreeze" disabled>${L('⏸ 冻结', '⏸ Freeze')}</button>
        <button class="btn" id="scBase" disabled title="${L('按下后 6 秒内，用平常的方式唱一个元音（比如“诶”），从低慢慢滑到高再滑下来：之后咽音在这个范围里唱哪个音都能和同一音高的普通唱法比——请用同一个元音', 'Press, then within 6 s glide plainly on one vowel (e.g. “eh”) from low to high and back: twang anywhere in that range is then compared with your plain voice at the same pitch — use the same vowel')}">${L('录普通唱法基准（滑音）', 'Record plain reference (glide)')}</button>
        <div class="level"><div id="scLevel"></div></div>
        <span class="status" id="scStatus">${L('安静的环境、离麦克风 20–30 cm。', 'A quiet room, 20–30 cm from the microphone.')}</span>
      </div>
      <div class="scope-main">
        <div class="panel">
          <div class="sc-readout" id="scReadout"></div>
          <canvas class="viz" id="scCompare" style="height:250px"></canvas>
        </div>
        <div class="panel">
          <div class="ph"><h3>${L('声道示意（根据声音推测）', 'Vocal tract (estimated from the sound)')}</h3></div>
          <div id="scTract"></div>
          <div id="scProblems" class="sc-problems"></div>
        </div>
      </div>
      <div class="panel" style="margin-top:12px">
        <div class="ph"><h3>${L('共振峰 F1–F5：每个发音的“指纹”', 'Formants F1–F5: each sound’s “fingerprint”')} ${ref('petersonBarney1952', 'sundbergThalen2010')}</h3><span class="sub" id="scFmNote"></span>
          <div class="ph-right fm-actions"><button class="btn" id="scPin">${L('📌 记下这个音', '📌 Keep this sound')}</button><button class="btn" id="scPinClear">${L('清空', 'Clear')}</button>
            <label class="muted"><input type="checkbox" id="scRefs" checked> ${L('参考元音', 'Reference vowels')}</label></div></div>
        <div class="fm-grid">
          <div><canvas class="viz" id="scVowel" style="height:240px"></canvas></div>
          <div><canvas class="viz" id="scRows" style="height:200px"></canvas></div>
        </div>
        <p class="muted" style="font-size:12px;margin:6px 0 0">${L('F1–F5 不是音高：音高是基频 F0（声带振动快慢），F1–F5 是口腔喉咙把声音放大的几个位置，由舌头、嘴型、喉咙形状决定，和唱多高基本无关。', 'F1–F5 are not the pitch: pitch is the fundamental F0 (how fast the vocal folds vibrate); F1–F5 are where the mouth and throat boost the sound, set by the tongue, lips and throat, and hardly depend on the note. ')}${L('怎么看：左图是元音图——横轴 F2（越往左舌头越靠前），纵轴 F1（越往上舌头越高、嘴张得越小），灰圈是标准元音的位置，绿点和它的轨迹是你现在的声音。右图每一行是一个发音，F1–F5 各一个点；彩色粗线是 F3 到 F5 的跨度，研究里那位歌手用咽音时它变短（F3、F5 降低）。唱一个音、按“记下这个音”，再换一个发音，就能并排比较。实心点 = 测得准（音高 ≤ 300 Hz），空心点 = 粗略估计（300–450 Hz），更高的音测不准，不显示。参考元音来自美式英语（Peterson & Barney 1952），只有 F1–F3。', 'How to read it: left is the vowel chart — F2 across (further left = tongue further forward), F1 down (higher up = tongue higher, mouth more closed); grey circles are standard vowels, the green dot and its trail are your voice now. On the right each row is one sound with F1–F5; the thick coloured line spans F3 to F5 — in the singer studied, twang shortened it (F3 and F5 fell). Sing, press “Keep this sound”, change the sound and compare side by side. Filled = reliable (pitch ≤ 300 Hz), hollow = rough (300–450 Hz); higher notes can’t be measured and aren’t shown. Reference vowels are American English (Peterson & Barney 1952), F1–F3 only.')}</p>
      </div>
      <div class="panel" style="margin-top:12px">
        <div class="seg" id="scViews">
          <button data-v="wave" class="${view === 'wave' ? 'on' : ''}">${L('波形（时域）', 'Waveform (time)')}</button>
          <button data-v="spec" class="${view === 'spec' ? 'on' : ''}">${L('瞬时频谱（谐波）', 'Spectrum now (harmonics)')}</button>
          <button data-v="gram" class="${view === 'gram' ? 'on' : ''}">${L('声谱图', 'Spectrogram')}</button>
          <span class="sub" id="scViewSub"></span>
        </div>
        <canvas class="viz" id="scDetail" style="height:180px"></canvas>
      </div>
      <details class="panel refs-box"><summary>${L('详细读数', 'Detailed readings')}</summary><div id="scNums" class="sc-nums"></div></details>
      ${glossaryHtml(['ring', 'ratio', 'peaks', 'spectrum', 'formant', 'db', 'twang', 'frequency'])}
      ${refsSection(['sundberg1974', 'omori1996', 'kondo2025', 'yanagisawa1989', 'sundbergThalen2010', 'titze2003', 'petersonBarney1952', 'hanson1997', 'chen1997', 'teixeira2013'])}`;
    const $ = (id) => this.root.querySelector('#' + id);
    $('scGo').onclick = () => (this.eng ? this.stop() : this.start());
    $('scFile').onclick = () => $('scInput').click();
    $('scInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.start(f); };
    $('scFreeze').onclick = () => { this.frozen = !this.frozen; $('scFreeze').textContent = this.frozen ? L('▶ 继续', '▶ Resume') : L('⏸ 冻结', '⏸ Freeze'); };
    // the reference: a plain glide over the next 6 s (see analysis/twang.js)
    $('scBase').onclick = () => {
      if (!this.eng) return;
      this.capture = { until: (this.vs?.lastT ?? 0) + 6, frames: [], spec: new SpecAvg(2) };
      $('scStatus').textContent = L('录基准：用平常的方式唱一个元音，从低慢慢滑到高再滑下来（6 秒）…', 'Recording the reference: glide plainly on one vowel from low to high and back (6 s)…');
    };
    $('scViews').onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; this.view = b.dataset.v; $('scViews').querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x === b)); this.draw(this.cur); };
    this.pins = loadPins();
    this.fmTrail = [];
    $('scPin').onclick = () => {
      const st = this.cur?.st;
      if (!st?.fm) { alert(L('唱着的时候按（音高 450 Hz 以下才能测共振峰）。', 'Press while singing (formants need a pitch below 450 Hz).')); return; }
      const v = vowelOf(st.fm[0], st.fm[1], this.P.sex), n = (this.pins[this.pins.length - 1]?.n || 0) + 1;
      this.pins.push({ n, F: st.fm.map((x) => Math.round(x)), label: L(`#${n} 像${v?.zh ?? '?'}`, `#${n} like ${v?.ipa ?? '?'}`), hollow: st.fmTrust === 'rough' });
      if (this.pins.length > 6) this.pins.shift();
      savePins(this.pins); this.draw(this.cur);
    };
    $('scPinClear').onclick = () => { this.pins = []; savePins([]); this.draw(this.cur); };
    $('scRefs').onchange = () => this.draw(this.cur);
    this.tract = new TractView($('scTract'));
    this.gram = new Spectrogram($('scDetail'));
    this.draw(null);
  }

  async start(file) {
    if (this.app.live?.engine.running) { alert(L('请先结束“唱一段看问题”页面的录音。', 'Please stop the recording on the “Sing & check” page first.')); return; }
    const S = this.app.settings, $ = (id) => this.root.querySelector('#' + id);
    const eng = new AudioEngine();
    let an = null;
    // the plain-voice reference: set here, or from step 1 of the twang lesson
    const tw = loadTwang().base;
    this.vs = new VoiceState({ sex: this.P.sex });
    const saved = loadBase();
    const base = (saved && okCurve(saved.curve) ? saved : null) || (tw ? { ...tw } : null);
    if (base) this.vs.setBase(base);
    this.gram = new Spectrogram($('scDetail'));
    this.avg = new SpecAvg(0.4);
    let lastT = -1;
    eng.onFrame = (frame, t) => {
      if (!an || t < 0 || this.eng !== eng || this.frozen) return;
      const f = an.analyze(frame, { gateDb: S.gateDb, f5: true });
      const st = this.vs.push(f, t);
      this.gram.push(f.spec, f.binHz, f.voiced ? f.f0 : 0);
      if (f.voiced && !f.irregular) this.avg.push(pool(f.spec, f.binHz), lastT < 0 ? 0.02 : Math.min(0.1, t - lastT));
      lastT = t;
      this.cur = { x: Float32Array.from(frame), sr: eng.sampleRate, f, st, spec: Float32Array.from(f.spec) };
      if (this.capture) this.captureFrame(f, t);
    };
    try {
      if (file) await eng.startFile(file, { onEnded: () => this.stop() });
      else await eng.startMic({ deviceId: S.deviceId, record: false });
    } catch (err) { alert(L(`麦克风错误：${err.message}`, `Microphone error: ${err.message}`)); return; }
    this.eng = eng;
    an = new FrameAnalyzer(eng.sampleRate);
    this.hop = 1024 / eng.sampleRate;
    $('scGo').textContent = L('■ 停止', '■ Stop'); $('scGo').classList.add('recording');
    $('scFreeze').disabled = false; $('scBase').disabled = false;
    $('scStatus').textContent = file ? L(`正在分析：${file.name}`, `Analysing: ${file.name}`) : L('正在听…', 'Listening…');
    this.loop();
  }

  // collecting the plain glide; at the end it becomes the reference
  captureFrame(f, t) {
    const C = this.capture, $ = (id) => this.root.querySelector('#' + id);
    if (f.voiced && !f.irregular) {
      C.frames.push({ midi: hzToMidi(f.f0, this.app.settings.a4), f0: f.f0, hbr: f.hbr, vdb: f.vdb, hnr: f.hnrLite, h1h2: f.h1h2c, cpp: f.cpp, fm: f.formants?.length ? f.formants.map((q) => q.f) : null });
      C.spec.push(pool(f.spec, f.binHz), 0.02);
    }
    $('scStatus').textContent = L(`录基准：从低慢慢滑到高再滑下来…还剩 ${Math.max(0, C.until - t).toFixed(0)} 秒`, `Recording the reference: glide low to high and back… ${Math.max(0, C.until - t).toFixed(0)} s left`);
    if (t < C.until) return;
    this.capture = null;
    const curve = buildCurve(C.frames), withFm = C.frames.filter((x) => x.fm && formantTrust(x.f0) !== 'none');
    const fm = withFm.length >= 5 ? fmMedians(withFm.map((x) => x.fm)) : null;
    if (curveSpan(curve) < 3 || !fm) { $('scStatus').textContent = curveSpan(curve) < 3 ? L('没录成：滑的范围太窄（要 ≥ 3 个半音）或声音断了，再按一次。', 'Not recorded: the glide was too narrow (≥ 3 semitones needed) or broke off — press again.') : L('没录成：测不出元音（音太高），从更低的音开始滑。', 'Not recorded: the vowel can’t be made out (too high) — start the glide lower.'); return; }
    const b = { v: 3, curve, fm, midi: (curve.lo + curve.hi) / 2, spec: C.spec.v ? Array.from(C.spec.v, (v) => Math.round(v * 10) / 10) : null, at: Date.now() };
    this.vs.setBase(b); saveBase(b);
    $('scStatus').textContent = L(`基准录好了：普通唱法 ${midiName(Math.round(curve.lo))}–${midiName(Math.round(curve.hi))}。在这个范围里唱咽音，哪个音都能比；灰色虚线是基准的平均频谱。`, `Reference recorded: plain voice ${midiName(Math.round(curve.lo))}–${midiName(Math.round(curve.hi))}. Twang anywhere in that range can be compared; the grey dashed line is its average spectrum.`);
  }

  async stop() {
    this.capture = null;
    const eng = this.eng;
    this.eng = null;
    this.frozen = false;
    cancelAnimationFrame(this.raf);
    if (eng) await eng.stop();
    const $ = (id) => this.root.querySelector('#' + id);
    if (!$('scGo')) return;
    $('scGo').textContent = L('● 开始', '● Start'); $('scGo').classList.remove('recording');
    $('scFreeze').disabled = true; $('scFreeze').textContent = L('⏸ 冻结', '⏸ Freeze');
    $('scBase').disabled = true;
  }

  loop() {
    cancelAnimationFrame(this.raf);
    const tick = () => {
      if (!this.eng || !this.root.querySelector('#scCompare')) return;
      if (!this.frozen) this.draw(this.cur);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  draw(c) {
    const $ = (id) => this.root.querySelector('#' + id);
    if (!$('scCompare')) return;
    const f = c?.f, st = c?.st, voiced = f?.voiced && !f.irregular;
    const base = this.vs?.base, singing = !!st?.singing;
    // the same verdict as the twang lesson (same note, same vowel, not shouted,
    // not squeezed), on the smoothed voice now; plus how long it has lasted
    const cur = singing ? { midi: st.f0 > 0 ? hzToMidi(st.f0, this.app.settings.a4) : NaN, hbr: st.hbr, vdb: st.vdb, hnr: st.hnr, h1h2: st.h1h2, cpp: st.cpp, fm: st.fm } : null;
    // at the difficulty chosen in the twang lesson
    const Lv = levelOf(this.app.settings.twangLevel), lvName = { easy: L('入门', 'beginner'), std: L('标准', 'standard'), strict: L('严格', 'strict') }[Lv.id];
    const v = base && cur ? twangVerdict(base, cur, { ringMin: Lv.ring, perDb: Lv.perDb, roughMax: Lv.rough, cppMax: Lv.cpp }) : { status: 'none' };
    const t = this.vs?.lastT ?? 0;
    if (v.status === 'twang') { if (this.twSince == null) this.twSince = t; } else this.twSince = null;
    const twFor = this.twSince == null ? 0 : t - this.twSince;
    // main view: the voice's spectrum (smoothed) against the reference
    drawCompare($('scCompare'), {
      cur: singing ? this.avg?.v : null, ref: base?.spec || null, curLabel: L('现在', 'now'), refLabel: L('我的基准', 'my reference'),
      target: Lv.ring, gain: Number.isFinite(v.ring) ? v.ring : null,
      good: base && singing ? v.status === 'twang' : null,
      gainLabel: L('穿透力提高（只变响不算）', 'ring gained (just louder doesn’t count)'), formants: voiced ? f.formants : [],
    });
    const ring = singing ? st.spr : NaN, gain = Number.isFinite(v.ring) ? v.ring : NaN, loud = Number.isFinite(v.loud) ? v.loud : NaN;
    const zone = v.status;
    const zoneTxt = {
      twang: L(`有咽音的声学特征（${lvName}）· 已保持 ${twFor.toFixed(1)} / ${Lv.hold} 秒${twFor >= Lv.hold ? ' ✓' : ''}`, `twang’s acoustic cues (${lvName}) · held ${twFor.toFixed(1)} / ${Lv.hold} s${twFor >= Lv.hold ? ' ✓' : ''}`),
      shout: L('主要是变响（像喊）', 'mostly louder (like shouting)'), plain: L(`普通（${lvName}要多 ≥ ${Lv.ring} dB）`, `plain (${lvName} needs ≥ ${Lv.ring} dB more)`),
      rough: L('杂音变多（挤或漏气），不算', 'noisier (squeezed or breathy) — doesn’t count'),
      breathy: L('声带没闭好、在漏气，不算', 'air leaking (folds not closing) — doesn’t count'),
      pressed: L('挤了（闭得紧但振动不规则），不算', 'squeezed (tight but irregular) — doesn’t count'),
      vowel: L('元音和基准不同，没法比', 'different vowel from the reference — can’t compare'),
      novowel: L('测不出元音，没法核对', 'vowel can’t be made out — can’t check'),
      range: L(`这个音不在基准滑过的范围里（${base?.curve ? `${midiName(Math.round(base.curve.lo))}–${midiName(Math.round(base.curve.hi))}` : '?'}），没法比`, `this note is outside the reference glide (${base?.curve ? `${midiName(Math.round(base.curve.lo))}–${midiName(Math.round(base.curve.hi))}` : '?'}) — can’t compare`),
      note: L(`音高和基准差 ${Math.round(Math.abs(v.dNote ?? 0) * 100)} 音分，换回基准的音（${base && Number.isFinite(base.midi) ? midiName(Math.round(base.midi)) : '?'}）才能比`, `${Math.round(Math.abs(v.dNote ?? 0) * 100)} cents off the reference — go back to its note (${base && Number.isFinite(base.midi) ? midiName(Math.round(base.midi)) : '?'}) to compare`),
      unknown: L('数据不足（基准不完整或测不到谐波），请重新设基准', 'not enough data (incomplete reference or no harmonics) — set the reference again'),
      none: '',
    }[zone];
    const grade = !Number.isFinite(ring) ? '' : ring <= 15 ? L('很亮、传得远', 'very bright, carries') : ring <= 21 ? L('比较亮', 'fairly bright') : ring <= 26 ? L('一般', 'average') : L('偏闷', 'dull');
    $('scReadout').innerHTML = `
      <div><span class="muted">${L('穿透力', 'Ring')} ${ref('omori1996', 'kondo2025')}</span><b class="mono">${Number.isFinite(ring) ? `${Math.round(ring)} dB` : '—'}</b><small>${Number.isFinite(ring) ? `${ring >= 0 ? L(`2–4 kHz 比低频弱 ${Math.round(ring)} dB`, `2–4 kHz ${Math.round(ring)} dB below the lows`) : L(`2–4 kHz 比低频还强 ${Math.round(-ring)} dB`, `2–4 kHz ${Math.round(-ring)} dB above the lows`)} · ${grade}` : L('唱起来就会显示', 'sing to see it')}</small></div>
      <div><span class="muted">${L('咽音（比基准）', 'Twang (vs reference)')} ${ref('sundbergThalen2010', 'yanagisawa1989')}</span><b class="mono" style="color:${zone === 'twang' ? '#2fbf71' : zone === 'shout' || zone === 'rough' || zone === 'pressed' ? '#ff8a8a' : zone === 'breathy' ? '#f0b429' : ['vowel', 'novowel', 'note', 'range', 'unknown'].includes(zone) ? '#f0b429' : 'inherit'}">${Number.isFinite(gain) ? `${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB` : '—'}</b><small>${!base ? L('先按“录普通唱法基准”', 'press “Record plain reference” first') : Number.isFinite(gain) ? `${L('穿透力提高', 'ring gained')} · ${L('音量', 'loudness')} ${Number.isFinite(loud) ? `${loud >= 0 ? '+' : ''}${loud.toFixed(1)} dB` : '—'} · <b>${zoneTxt}</b>` : ''}</small></div>
      <div><span class="muted">${L('现在唱的音', 'Note now')}</span>${pitchNowHtml(voiced ? f.f0 : 0, this.app.settings.a4)}</div>`;
    this.tract.update(st || { problems: [] });
    $('scLevel').style.width = `${Math.max(0, Math.min(100, ((f?.db ?? -100) + 60) * 2))}%`;
    const P = st?.problems || [];
    $('scProblems').innerHTML = !singing ? '' : P.length
      ? `<ol>${P.map((p) => `<li class="${p.level}"><b>${p.text}</b> ${ref(...({ dull: ['sundberg1974', 'omori1996'], breathy: ['hanson1997'], pressed: ['hanson1997'], larynxHigh: ['titze2003'], nasal: ['chen1997'], unsteady: ['teixeira2013'] }[p.key] || []))}<br><span class="t2">${p.fix}</span></li>`).join('')}</ol>`
      : `<p class="ok-line">${L('✓ 没有发现明显问题', '✓ No clear problems')}</p>`;
    // formants F1–F5: the vowel chart and one row per sound
    const fmNow = st?.fm, trust = st?.fmTrust || 'none', sex = this.P.sex;
    if (fmNow && trust !== 'none') { this.fmTrail.push({ F1: fmNow[0], F2: fmNow[1] }); if (this.fmTrail.length > 40) this.fmTrail.shift(); } else if (!singing) this.fmTrail = [];
    const vNow = fmNow ? vowelOf(fmNow[0], fmNow[1], sex) : null;
    const fmRows = [];
    if (fmNow && trust !== 'none') fmRows.push({ label: L('现在', 'now'), sub: vNow ? L(`像${vNow.zh}`, `like ${vNow.ipa}`) : '', F: fmNow, color: '#2fbf71', hollow: trust === 'rough' });
    if (base?.fm) { const vb = vowelOf(base.fm[0], base.fm[1], sex); fmRows.push({ label: L('我的基准', 'my reference'), sub: vb ? L(`像${vb.zh}`, `like ${vb.ipa}`) : '', F: base.fm, color: '#9aa3b5' }); }
    for (const p of this.pins || []) fmRows.push({ label: p.label, F: p.F, color: pinColor(p), hollow: p.hollow });
    if ($('scRefs').checked) for (const v of REF_VOWELS) fmRows.push({ label: L(`参考 ${v.zh}`, `ref ${v.ipa}`), F: [...v[sex === 'f' ? 'f' : 'm'], NaN, NaN], color: '#6e7689', ref: true });
    drawFormantRows($('scRows'), fmRows);
    const pts = (this.pins || []).map((p) => ({ F1: p.F[0], F2: p.F[1], label: p.label, color: pinColor(p), hollow: p.hollow }));
    if (base?.fm) pts.push({ F1: base.fm[0], F2: base.fm[1], label: L('基准', 'ref'), color: '#9aa3b5' });
    if (fmNow && trust !== 'none') pts.push({ F1: fmNow[0], F2: fmNow[1], label: L('现在', 'now'), color: '#2fbf71', hollow: trust === 'rough' });
    drawVowelChart($('scVowel'), { sex, points: pts, trail: this.fmTrail });
    const hz0 = voiced ? f.f0 : 0;
    $('scFmNote').textContent = !singing ? '' : trust === 'good' ? L(`音高 ${Math.round(hz0)} Hz：共振峰测得准`, `pitch ${Math.round(hz0)} Hz: formants reliable`) : trust === 'rough' ? L(`音高 ${Math.round(hz0)} Hz：只能粗略估计（空心点）`, `pitch ${Math.round(hz0)} Hz: rough estimate only (hollow)`) : L(`音高 ${Math.round(hz0)} Hz：太高，测不准共振峰`, `pitch ${Math.round(hz0)} Hz: too high to measure formants`);
    // detail view
    const view = this.view || 'wave', sub = $('scViewSub');
    if (view === 'wave') { drawWave($('scDetail'), c?.x, c?.sr, voiced ? f.f0 : 0); sub.textContent = L('声带每开合一次就是一个周期，越规整越稳', 'one cycle per opening and closing of the vocal folds; the more regular, the steadier'); }
    else if (view === 'spec') {
      // the same compact spectrum as the sing-along and the twang lesson
      const spec = c ? { db: c.spec, binHz: f.binHz } : null, f0 = voiced ? f.f0 : 0;
      drawVoiceSpectrum($('scDetail'), spec && { spec, f0, harm: harmonicsOf(spec, f0, 5000), formants: voiced ? (f.formants || []).map((q) => q.f) : [], ring: singing ? st.spr : NaN, name: f0 ? midiName(Math.round(hzToMidi(f0, this.app.settings.a4))) : '' }, { fmax: 5000 });
      sub.textContent = L('粗线 F0 = 音高；连着谐波的线 = 包络；紫线 F1、F2 = 元音；蓝色区 2–4 kHz = 共鸣', 'thick line F0 = the pitch; the line through the harmonics = the envelope; purple F1, F2 = the vowel; blue 2–4 kHz = the ring');
    }
    else { this.gram.draw(this.hop || 0.021); sub.textContent = L('横轴时间、纵轴频率，越亮越强；白线是音高', 'time across, frequency up, brighter = stronger; the white line is pitch'); }
    const rows = singing ? [
      [L('穿透力（2–4 kHz）', 'Ring (2–4 kHz)'), `${Math.round(st.spr)} dB`, L('2–4 kHz 比低频弱多少；越小越亮，歌剧演员 11–30', '2–4 kHz below the lows; smaller = brighter, opera singers 11–30')],
      ['F1 / F2', `${Number.isFinite(st.F1) ? Math.round(st.F1) : '—'} / ${Number.isFinite(st.F2) ? Math.round(st.F2) : '—'} Hz`, L('F1 低 = 舌高；F2 高 = 舌前', 'low F1 = high tongue; high F2 = front tongue')],
      [L('声门开放比', 'Open quotient'), Number.isFinite(st.oq) ? st.oq.toFixed(2) : '—', L('约 0.4–0.7；高 = 气声，低 = 挤', '≈ 0.4–0.7; high = breathy, low = pressed')],
      [L('周期抖动', 'Jitter'), Number.isFinite(st.jitter) ? `${st.jitter.toFixed(1)}%` : '—', L('平稳的歌声约 0.5–1.5%', 'steady singing ≈ 0.5–1.5%')],
      [L('鼻音指标 A1−P0', 'Nasality A1−P0'), Number.isFinite(st.nasal) ? `${Math.round(st.nasal)} dB` : '—', L('越低越鼻（只在低音开口元音测得到）', 'lower = more nasal (low pitch, open vowels only)')],
      [L('声道长度', 'Tract length'), Number.isFinite(st.vtl) ? `${st.vtl.toFixed(1)} cm` : '—', L('变短 = 喉位上提或嘴角咧开', 'shorter = larynx up or lips spread')],
    ] : [];
    $('scNums').innerHTML = rows.length ? rows.map(([k, v, h]) => `<div><span class="muted">${k}</span><b class="mono">${v}</b><small class="muted">${h}</small></div>`).join('') : `<p class="muted">${L('唱起来才有读数。', 'Readings appear while you sing.')}</p>`;
  }
}
