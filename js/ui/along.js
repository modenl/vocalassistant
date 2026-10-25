// "跟原唱唱" / Sing along. Two steps, in this order and no other:
//   ① analyse the original — a YouTube video (played once at 1.5× by the
//      page), a Bilibili video or a song on any other site (played once by the
//      singer, only to be analysed: their sound shared from the tab), or a song
//      file: Demucs separates the lead vocal, MELODIA follows it; meanwhile
//      nothing on the page can be used;
//   ② sing along on headphones: the original's notes (known in full ahead) and
//      yours side by side, note names on both. Where the song is: the file's
//      own clock, the YouTube player's time, or — for the players the page
//      can't ask — the tab's sound matched against the recording (along/align.js).
//      The microphone hears only the singer.
// Nothing of the song is stored or sent anywhere.

import { AudioEngine } from '../audio/engine.js';
import { FrameAnalyzer } from '../dsp/analyzer.js';
import { PitchTracker } from '../analysis/pitch.js';
import { decodeSong, extractMelody, resampleTo44k } from '../along/melody.js';
import { separateVocals, releaseSeparator } from '../along/separate.js';
import { AnalysisAnim } from '../viz/analysisAnim.js';
import { videoIdOf, createPlayer, bilibiliEmbedOf } from '../along/youtube.js';
import { features, locate, RATE as AL_RATE } from '../along/align.js';
import { captureTabAudio, canCaptureTab } from '../along/tabcapture.js';
import { VOICE_TYPES, midiName } from '../config.js';
import { notesOf, bestLag, compareAlong, phrasesOf, coverOf } from '../along/compare.js';
import { drawAlong, drawSpectraPair, ALONG_COLORS } from '../viz/along.js';
import { pitchRelation, voiceSide } from '../along/spectra.js';
import { VoiceCards } from './voiceCards.js';
import { vowelOf } from '../analysis/vowels.js';
import { pitchNowHtml } from './pitchNow.js';
import { L } from '../i18n.js';

// A YouTube video is analysed from its sound played once, faster. A synthetic
// song with a known melody, sped up by the browser (pitch kept), captured and
// analysed (Demucs + MELODIA): 95 % of moments right at 1×, 92 % at 1.5×, 74 %
// at 2× — Demucs was trained on music at its real tempo (tools/speedtest.js)
const PRE_RATE = 1.5;

// The analysis step being run, kept in localStorage: a phone that runs out
// of memory reloads the page without a word ("a problem repeatedly
// occurred"), and this says afterwards which step it was in
const STEP_KEY = 'vocalassistant.along.step.v1';
const markStep = (step, song) => { try { localStorage.setItem(STEP_KEY, JSON.stringify({ step, name: song?.name || '', at: Date.now() })); } catch { /* private mode */ } };
const clearStep = () => { try { localStorage.removeItem(STEP_KEY); } catch { /* ignore */ } };
const STEP_NAMES = () => ({ read: L('读取文件', 'reading the file'), record: L('录下原曲', 'recording the song'), model: L('载入人声分离模型', 'loading the vocal-separation model'), separate: L('分离人声', 'separating the vocal'), melody: L('提取旋律', 'extracting the melody') });

const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const centsTxt = (c) => (c === 0 ? L('正好', 'spot on') : c > 0 ? L(`高 ${c} 音分`, `${c} cents sharp`) : L(`低 ${-c} 音分`, `${-c} cents flat`));
const octTxt = (k) => (k === 0 ? '' : k < 0 ? L(`低 ${-k} 个八度`, `${-k} octave${k < -1 ? 's' : ''} lower`) : L(`高 ${k} 个八度`, `${k} octave${k > 1 ? 's' : ''} higher`));
const STATUS_TXT = () => ({ good: L('准', 'in tune'), near: L('略偏', 'slightly off'), off: L('不准', 'off'), missed: L('没唱', 'not sung') });

export class AlongView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.song = null;   // { name, yt?, buf?, x?, mel: { frames, notes, secs }, vox?, ready }
    this.user = [];     // the singer's pitch: { t (song time), midi }
    this.result = null;
    this.busy = false; clearStep();  // analysing: every control greyed out
    this.keyMode = 'auto';  // compare in: 'auto' | 'relative' (the singer's key) | 'absolute' (the original's)
  }

  show() { if (!this.rendered) this.render(); }

  render() {
    this.rendered = true;
    this.root.innerHTML = `
      <div class="ph"><h3 style="font-size:16px">${L('跟原唱唱', 'Sing along')}</h3>
        <span class="sub">${L('先分析原唱，再戴耳机跟着唱：蓝色是原唱的每个音，彩色线是你，两边都标音名（如 A3）', 'Analyse the original first, then sing along on headphones: blue = the original’s notes, the coloured line = you, note names on both (e.g. A3)')}</span></div>
      <div class="al-in">
        <input class="al-url" id="alUrl" placeholder="${L('粘贴 YouTube 或 B站链接；其他网站：留空，点“① 分析”后到那个标签页播放', 'Paste a YouTube or Bilibili link; other sites: leave empty, press “① Analyse” and play it in its tab')}" />
        <button class="btn primary" id="alAna">${L('① 分析', '① Analyse')}</button>
        <span class="muted">${L('或', 'or')}</span>
        <button class="btn" id="alPick">${L('导入歌曲 / 视频文件', 'Import a song / video file')}</button>
        <input type="file" id="alFile" accept="audio/*,video/*" class="hidden" />
      </div>
      <div class="al-ytbox" id="alYtBox" hidden><div id="alYt"></div><div class="al-ytlock" id="alYtLock" hidden></div></div>
      <div class="al-sep" id="alSep"><span class="al-sep-t"></span><div class="bar"><div class="fill"></div></div></div>
      <div class="live-controls al-controls">
        <button class="btn primary" id="alGo" disabled>${L('② 开始跟唱', '② Sing along')}</button>
        <span class="status al-status" id="alStatus"></span>
        <div class="al-now" id="alNow"></div>
      </div>
      <p class="al-tip" id="alTip">🎧 ${L('请戴耳机：原唱只从耳机里放，麦克风就只录到你。用音箱外放时，麦克风会同时录到原唱，结果不准。', 'Wear headphones: the original plays only in them, so the microphone hears only you. Played through speakers, the microphone records the original too and the result isn’t reliable.')}</p>
      <div class="panel">
        <div class="al-scroll" id="alScroll"><canvas class="viz" id="alView" style="height:320px"></canvas></div>
        <canvas class="viz" id="alAnim" style="height:320px;display:none"></canvas>
        <div class="al-legend">
          <span><i style="background:${ALONG_COLORS.ref}"></i>${L('原唱的音（蓝字 = 音名）', 'the original’s notes (blue = note name)')}</span>
          <span><i style="background:${ALONG_COLORS.good}"></i>${L('你：准（±25 音分）', 'you: in tune (±25 cents)')}</span>
          <span><i style="background:${ALONG_COLORS.near}"></i>${L('略偏（±50）', 'slightly off (±50)')}</span>
          <span><i style="background:${ALONG_COLORS.off}"></i>${L('不准', 'off')}</span>
          <span><b style="color:${ALONG_COLORS.mine}">A3</b> ${L('橙字 = 你唱的音名', 'orange = the note you sang')}</span>
          <span><i style="background:rgba(154,163,181,0.45)"></i>${L('灰色 = 你没唱的地方，当作伴奏，不计分', 'grey = where you didn’t sing: taken as accompaniment, not scored')}</span>
        </div>
        <p class="muted al-cap">${L(`分析怎么做：YouTube 视频以 ${PRE_RATE} 倍速放一遍，程序录下这个标签页的声音（浏览器会问你共享什么：选“这个标签页”，打开“同时分享标签页音频”；只支持电脑版 Chrome / Edge）；歌曲文件直接读。然后用 Demucs 把人声从伴奏里分出来，再用 MELODIA 算法提取原唱的旋律（Essentia.js），全在你的电脑上算，不上传、不保存。`, `How the analysis works: a YouTube video plays once at ${PRE_RATE}× while the app records this tab’s sound (the browser asks what to share: pick “This tab” and turn on “Also share tab audio”; desktop Chrome / Edge only); a song file is read directly. Demucs then separates the vocal from the band and the MELODIA algorithm extracts the original’s melody (Essentia.js) — all on your computer, nothing uploaded or stored.`)}</p>
        <h4 class="ls-h">${L('频谱对照：同一时刻的原唱和你', 'Spectra: the original and you at the same moment')}</h4>
        <canvas class="viz" id="alSpec" style="height:270px"></canvas>
        <div id="alCards"></div>
        <p class="muted al-cap">${L('怎么看：粗竖线 F0 是基频，就是你听到的音高；连着各次谐波（F0 的 2 倍、3 倍……）的线是包络，它的形状由口腔喉咙决定。两条 F0 对齐 = 同一个音；低一个八度时，你的谐波密一倍，你的第 2 根谐波落在原唱的 F0 上（虚线），音名一样、只差八度。紫色 F1、F2 是共振峰——包络的前两个峰，决定元音，和音高无关（原唱的是从分出来的人声的谐波估计的，标 ≈）。蓝色区域 2–4 kHz 看共鸣：这一段的谐波比低频弱得越少，声音越亮、越有穿透力（好的歌声约 10–20 dB）。唱完以后，点上面音高图的任何位置，就显示那一刻。', 'How to read it: the thick line F0 is the fundamental — the pitch you hear; the line through the harmonics (2×, 3× F0 …) is the envelope, shaped by mouth and throat. F0s lined up = the same note; an octave lower, your harmonics are twice as dense and your 2nd sits on the original’s F0 (dashed) — the same note name, an octave apart. Purple F1, F2 are the formants — the envelope’s first two peaks, setting the vowel, not the pitch (for the original, estimated from the separated vocal’s harmonics: ≈). The blue 2–4 kHz band shows the ring: the less those harmonics fall below the lows, the brighter the voice carries (good singing ≈ 10–20 dB). After singing, click anywhere on the pitch chart above to see that moment.')}</p>
      </div>
      <div id="alRes"></div>`;
    const $ = (id) => this.root.querySelector('#' + id);
    $('alAna').onclick = () => this.analyse($('alUrl').value);
    $('alUrl').onkeydown = (e) => { if (e.key === 'Enter') this.analyse($('alUrl').value); };
    $('alPick').onclick = () => $('alFile').click();
    $('alFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.load(f); };
    $('alGo').onclick = () => (this.eng ? this.stop() : this.start());
    // after singing: a click on the pitch chart shows the spectra at that moment
    $('alView').onclick = (e) => {
      if (this.eng || !this.result || !this.lastWin) return;
      const r = $('alView').getBoundingClientRect(), [a, b] = this.lastWin, x0 = 44, x1 = r.width - 8;
      this.reviewT = a + ((e.clientX - r.left - x0) / (x1 - x0)) * (b - a);
      this.draw(null);
      this.drawSpectra(this.reviewT);
    };
    $('alNow').innerHTML = this.nowHtml(null, null);
    this.cards = new VoiceCards($('alCards'), [{ key: 'ref', label: L('原唱', 'Original'), color: ALONG_COLORS.ref }, { key: 'user', label: L('你', 'You'), color: ALONG_COLORS.mine }], { sex: VOICE_TYPES[this.app.settings.voiceType]?.sex });
    this.say(canCaptureTab() ? L('第一步：粘贴 YouTube / B站链接点“① 分析”（其他网站留空），或者导入歌曲 / 视频文件（mp3、m4a、wav、mp4、mov…）。', 'Step one: paste a YouTube / Bilibili link and press “① Analyse” (other sites: leave it empty), or import a song / video file (mp3, m4a, wav, mp4, mov…).') : L('第一步：导入歌曲 / 视频文件（mp3、m4a、wav、mp4、mov…）。这个浏览器不能分析网页里的视频（要电脑版 Chrome / Edge）。', 'Step one: import a song / video file (mp3, m4a, wav, mp4, mov…). This browser can’t analyse videos on web pages (desktop Chrome / Edge needed).'));
    this.controls();
    this.draw();
    try {
      const was = JSON.parse(localStorage.getItem(STEP_KEY) || 'null');
      clearStep();
      if (was && Date.now() - was.at < 30 * 60e3) this.say(L(`上次分析“${was.name}”时，在“${STEP_NAMES()[was.step] || was.step}”这一步页面被系统关掉了（多半是内存不够）。`, `Last time, analysing “${was.name}”, the page was closed by the system while ${STEP_NAMES()[was.step] || was.step} (most likely out of memory).`));
    } catch { /* ignore */ }
  }

  get $() { return (id) => this.root.querySelector('#' + id); }
  say(t) { const el = this.root.querySelector('#alStatus'); if (el) el.textContent = t; }

  // Which controls can be used now: none while analysing; while singing only
  // "stop"; singing only once a song is fully analysed.
  controls() {
    const $ = this.$, busy = this.busy, singing = !!this.eng;
    $('alUrl').disabled = $('alAna').disabled = busy || singing || !canCaptureTab();
    $('alPick').disabled = busy || singing;
    $('alGo').disabled = busy || !(singing || this.song?.ready);
    $('alYtLock').hidden = !busy;
  }

  // ① from a link: YouTube (the page plays it), Bilibili (embedded; the singer
  // plays it), anything else (empty or another site: played in its own tab)
  analyse(url) {
    if (this.busy || this.eng) return;
    const u = String(url || '').trim();
    if (videoIdOf(u)) return this.analyseYt(u);
    const bili = bilibiliEmbedOf(u);
    if (bili) return this.analyseTab({ embed: bili });
    if (u && !/^https?:\/\//i.test(u)) { this.say(L('这不像一个链接。YouTube / B站：粘贴视频链接；其他网站：留空。', 'That doesn’t look like a link. YouTube / Bilibili: paste the video link; other sites: leave it empty.')); return; }
    return this.analyseTab({});
  }

  // ① a YouTube video: share this tab's sound (asked first: the browser only
  // allows it right after a click), load the player, play it once at 1.5×
  // while recording, then the same analysis as a song file. Song time = the
  // video's own time: a straight line fitted to (seconds recorded,
  // player.getCurrentTime()) pairs maps the recording onto it.
  async analyseYt(url) {
    const $ = this.$, id = videoIdOf(url);
    if (this.busy || this.eng) return;
    if (!id) { this.say(L('这不是 YouTube 视频链接。其他网站的歌：留空再点“① 分析”，或者存成文件后点“导入歌曲 / 视频文件”。', 'That isn’t a YouTube video link. Songs from other sites: leave it empty and press “① Analyse”, or save them as a file and use “Import a song / video file”.')); return; }
    let tab;
    try { ({ stream: tab } = await captureTabAudio({ currentTab: true })); } catch (err) {
      this.say(err.message === 'no-audio'
        ? L('没有拿到声音：在共享窗口里选“这个标签页”，并打开“同时分享标签页音频”，再点一次“① 分析”。', 'Didn’t get any sound: in the share dialog pick “This tab” and turn on “Also share tab audio”, then press “① Analyse” again.')
        : L('没有共享这个标签页的声音（取消了？）。分析要听到视频的声音：再点一次“① 分析”，在弹窗里选“这个标签页”。', 'This tab’s sound wasn’t shared (cancelled?). The analysis needs to hear the video: press “① Analyse” again and pick “This tab”.'));
      return;
    }
    this.dropSong();
    this.busy = true; this.result = null; this.user = []; this.reviewT = null; $('alRes').innerHTML = '';
    const song = (this.song = { name: `YouTube ${id}`, yt: true, mel: { frames: [], notes: [], secs: 0 } });
    this.controls();
    const fail = (t) => { tab.getTracks().forEach((k) => k.stop()); this.busy = false; clearStep(); if (this.song === song) this.song = null; this.say(t); this.controls(); this.draw(0); };
    this.say(L('正在载入视频…', 'Loading the video…'));
    try {
      this.player?.destroy?.();
      $('alYtBox').hidden = false;
      $('alYt').innerHTML = '<div id="alYtEl"></div>';
      this.player = await createPlayer($('alYtEl'), id);
    } catch (err) { fail(L(`视频载入失败：${err.message}`, `The video didn’t load: ${err.message}`)); return; }
    const P = this.player, ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL('../audio/capture-worklet.js', import.meta.url));
    const src = ctx.createMediaStreamSource(tab), node = new AudioWorkletNode(ctx, 'vocal-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }), sink = ctx.createGain();
    sink.gain.value = 0; src.connect(node); node.connect(sink).connect(ctx.destination);
    const rate = (P.getAvailablePlaybackRates?.() || [1]).includes(PRE_RATE) ? PRE_RATE : 1;
    const dur = P.getDuration?.() || 0, chunks = [], marks = [];
    let n = 0, ended = null;
    const done = new Promise((r) => { ended = r; });
    // the analysis animation, from the recording on
    const scroll = $('alScroll'), acv = $('alAnim');
    scroll.style.display = 'none'; acv.style.display = '';
    const anim = (this.anim = new AnalysisAnim(acv));
    anim.capturing(Math.max(10, dur / rate), rate); anim.start();
    node.port.onmessage = (e) => { if (P.getPlayerState?.() !== 1) return; chunks.push(e.data); n += e.data.length; anim.feed(e.data, ctx.sampleRate); };
    const iv = setInterval(() => {
      if (P.getPlayerState?.() === 1) marks.push([n / ctx.sampleRate, P.getCurrentTime()]);
      if (P.getPlayerState?.() === 0 || (dur && P.getCurrentTime() >= dur - 0.2)) ended();
    }, 100);
    tab.getAudioTracks()[0].onended = () => ended();
    const box = $('alSep');
    markStep('record', song);
    box.className = 'al-sep busy'; box.querySelector('.al-sep-t').textContent = L(`第 1 步：视频以 ${rate} 倍速放一遍，录下它的声音（只在内存里）`, `Step 1: the video plays once at ${rate}× while its sound is recorded (in memory only)`);
    this.say(L(`正在分析，请稍候，分析完才能开始唱（一首 4 分钟的歌约 ${Math.round(4 / rate + 1.5)} 分钟）…`, `Analysing — please wait; singing starts once it’s done (about ${Math.round(4 / rate + 1.5)} min for a 4-minute song)…`));
    try { P.seekTo(0, true); P.setPlaybackRate(rate); P.playVideo(); } catch { /* it will be caught by the timeout below */ }
    const fillIv = setInterval(() => { box.querySelector('.fill').style.width = `${Math.round(100 * Math.min(1, (n / ctx.sampleRate) / Math.max(1, dur / rate)))}%`; }, 250);
    // a video that never starts (blocked autoplay, an embed refused by its owner)
    const stall = setTimeout(() => { if (n === 0) ended(); }, 12000);
    await done;
    clearInterval(iv); clearInterval(fillIv); clearTimeout(stall);
    try { P.pauseVideo(); P.setPlaybackRate(1); P.seekTo(0, true); } catch { /* gone */ }
    tab.getTracks().forEach((k) => k.stop()); ctx.close();
    if (this.song !== song) { anim.stop(); return; }
    if (n < ctx.sampleRate * 5) { anim.stop(); scroll.style.display = ''; acv.style.display = 'none'; box.className = 'al-sep warn'; box.querySelector('.al-sep-t').textContent = ''; fail(L('没录到视频的声音：视频没放起来，或者共享时没打开“同时分享标签页音频”。再点一次“① 分析”。', 'The video’s sound wasn’t recorded: it didn’t play, or “Also share tab audio” was off. Press “① Analyse” again.')); return; }
    // video time = a + b · seconds recorded
    const k = marks.length, sx = marks.reduce((q, p) => q + p[0], 0) / Math.max(1, k), sy = marks.reduce((q, p) => q + p[1], 0) / Math.max(1, k);
    const den = marks.reduce((q, p) => q + (p[0] - sx) ** 2, 0), b = k > 5 && den > 0 ? marks.reduce((q, p) => q + (p[0] - sx) * (p[1] - sy), 0) / den : rate, a = sy - b * sx;
    const x = new Float32Array(n); chunks.forEach((c, i) => x.set(c, i * c.length));
    try {
      const mel = await this.analyseSong(song, await resampleTo44k(x, ctx.sampleRate), { offset: a, rate, scale: b });
      if (this.song !== song) return;
      this.say(L(`分析好了：${fmtT(mel.secs)}，${mel.notes.length} 个旋律音。戴上耳机，点“② 开始跟唱”（视频从头原速播放）。`, `Analysed: ${fmtT(mel.secs)}, ${mel.notes.length} melody notes. Put on headphones and press “② Sing along” (the video plays from the start, normal speed).`));
    } catch (err) { if (this.song === song) this.song = null; this.say(L(`分析失败：${err.message}。再点一次“① 分析”。`, `The analysis failed: ${err.message}. Press “① Analyse” again.`)); }
    this.busy = false; clearStep(); this.controls(); this.draw(0);
  }

  // the previous song's player and shared sound let go
  dropSong() {
    this.song?.tab?.getTracks().forEach((k) => k.stop());
    if (this.song?.video) URL.revokeObjectURL(this.song.video);
    this.player?.destroy?.(); this.player = null;
    const $ = this.$; $('alYt').innerHTML = ''; $('alYtBox').hidden = true;
  }

  // ① a song on Bilibili or any other site: the singer plays it once, from the
  // start at normal speed, only to be analysed. Recording starts with the first
  // sound and ends after 4 s of silence (or when the sharing stops); the shared
  // sound is kept for singing along (no second dialog), with the recording's
  // features to find where the song is (along/align.js).
  async analyseTab({ embed = null }) {
    const $ = this.$;
    let tab;
    try { ({ stream: tab } = await captureTabAudio({ currentTab: !!embed })); } catch (err) {
      this.say(err.message === 'no-audio'
        ? L(`没有拿到声音：在共享窗口里选${embed ? '“这个标签页”' : '正在放歌的那个标签页'}，并打开“同时分享标签页音频”，再点一次“① 分析”。`, `Didn’t get any sound: in the share dialog pick ${embed ? '“This tab”' : 'the tab playing the song'} and turn on “Also share tab audio”, then press “① Analyse” again.`)
        : L('没有共享标签页的声音（取消了？）。分析要听到歌：再点一次“① 分析”，在弹窗里选标签页。', 'The tab’s sound wasn’t shared (cancelled?). The analysis needs to hear the song: press “① Analyse” again and pick the tab.'));
      return;
    }
    this.dropSong();
    this.busy = true; this.result = null; this.user = []; this.reviewT = null; $('alRes').innerHTML = '';
    const song = (this.song = { name: embed ? 'Bilibili' : L('另一个标签页', 'another tab'), mel: { frames: [], notes: [], secs: 0 } });
    if (embed) { $('alYtBox').hidden = false; $('alYt').innerHTML = `<iframe src="${embed}" allow="autoplay; fullscreen" referrerpolicy="no-referrer-when-downgrade"></iframe>`; }
    this.controls();
    $('alYtLock').hidden = true; // the singer presses play in it
    const ctx = new AudioContext();
    await ctx.audioWorklet.addModule(new URL('../audio/capture-worklet.js', import.meta.url));
    const src = ctx.createMediaStreamSource(tab), node = new AudioWorkletNode(ctx, 'vocal-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }), sink = ctx.createGain();
    sink.gain.value = 0; src.connect(node); node.connect(sink).connect(ctx.destination);
    const sr = ctx.sampleRate, chunks = [];
    let n = 0, quiet = 0, ended = null;
    const done = new Promise((r) => { ended = r; });
    const scroll = $('alScroll'), acv = $('alAnim');
    scroll.style.display = 'none'; acv.style.display = '';
    const anim = (this.anim = new AnalysisAnim(acv));
    anim.capturing(null, 1); anim.start();
    node.port.onmessage = (e) => {
      const b = e.data; let p = 0;
      for (let i = 0; i < b.length; i++) p += b[i] * b[i];
      const loud = 10 * Math.log10(p / b.length + 1e-12) > -55;
      if (!n && !loud) return; // waiting for it to start
      chunks.push(b); n += b.length; anim.feed(b, sr);
      quiet = loud ? 0 : quiet + b.length;
      if ((n > 10 * sr && quiet > 4 * sr) || n > 20 * 60 * sr) ended();
    };
    tab.getAudioTracks()[0].onended = () => ended();
    const box = $('alSep');
    markStep('record', song);
    box.className = 'al-sep busy'; box.querySelector('.al-sep-t').textContent = L('第 1 步：录下原曲（只在内存里）', 'Step 1: recording the song (in memory only)');
    box.querySelector('.fill').style.width = '0%';
    this.say(embed ? L('现在点视频上的 ▶，从头原速播放一遍——只是给程序分析，不用唱。播完停 4 秒会自动结束，之后才能唱。', 'Now press ▶ on the video and play it once from the start at normal speed — only for the analysis, don’t sing yet. It ends by itself after 4 s of silence; then you can sing.')
      : L('现在切到正在放歌的那个标签页，从头原速播放一遍——只是给程序分析，不用唱。播完停 4 秒会自动结束，之后才能唱。', 'Now go to the tab with the song and play it once from the start at normal speed — only for the analysis, don’t sing yet. It ends by itself after 4 s of silence; then you can sing.'));
    await done;
    node.port.onmessage = null; ctx.close();
    if (this.song !== song) { anim.stop(); tab.getTracks().forEach((k) => k.stop()); return; }
    const fail = (t) => { anim.stop(); scroll.style.display = ''; acv.style.display = 'none'; box.className = 'al-sep'; box.querySelector('.al-sep-t').textContent = ''; tab.getTracks().forEach((k) => k.stop()); this.song = null; this.busy = false; clearStep(); this.say(t); this.controls(); this.draw(0); };
    // the silence at the end isn't part of the song
    const keep = Math.max(0, n - quiet + Math.round(0.5 * sr));
    if (keep < 5 * sr) { fail(L('没录到歌（不到 5 秒）：没放起来，或者共享时没打开“同时分享标签页音频”。再点一次“① 分析”。', 'No song recorded (under 5 s): it didn’t play, or “Also share tab audio” was off. Press “① Analyse” again.')); return; }
    const x = new Float32Array(n); chunks.forEach((c, i) => x.set(c, i * c.length));
    const x44 = await resampleTo44k(x.subarray(0, keep), sr);
    song.align = features(x44, 44100); // to find the song again while singing
    song.tab = tab;
    try {
      const mel = await this.analyseSong(song, x44);
      if (this.song !== song) return;
      this.say(L(`分析好了：${fmtT(mel.secs)}，${mel.notes.length} 个旋律音。戴上耳机，点“② 开始跟唱”，再从头播放（原速）——程序会自己听出播到哪里。`, `Analysed: ${fmtT(mel.secs)}, ${mel.notes.length} melody notes. Put on headphones, press “② Sing along”, then play it from the start (normal speed) — the app hears where it is.`));
    } catch (err) { if (this.song === song) { tab.getTracks().forEach((k) => k.stop()); this.song = null; } this.say(L(`分析失败：${err.message}。再点一次“① 分析”。`, `The analysis failed: ${err.message}. Press “① Analyse” again.`)); }
    this.busy = false; clearStep(); this.controls(); this.draw(0);
  }

  // ① a song or video file: its sound decoded, then analysed. A video's
  // picture is shown (muted) and kept in step with the sound while singing.
  async load(file) {
    const $ = this.$;
    if (this.busy || this.eng) return;
    this.busy = true; this.result = null; this.user = []; this.reviewT = null; $('alRes').innerHTML = '';
    this.dropSong();
    const song = (this.song = { name: file.name, mel: { frames: [], notes: [], secs: 0 } });
    if (/^video\//.test(file.type) || /\.(mp4|m4v|mov|webm|mkv)$/i.test(file.name)) {
      song.video = URL.createObjectURL(file);
      $('alYtBox').hidden = false;
      $('alYt').innerHTML = `<video src="${song.video}" playsinline muted preload="auto"></video>`;
    }
    this.controls();
    this.say(L(`正在读取“${file.name}”…`, `Reading “${file.name}”…`));
    markStep('read', song);
    try {
      const tmp = new AudioContext();
      const { buf, x } = await decodeSong(file, tmp);
      tmp.close();
      let peak = 0;
      for (let i = 0; i < x.length; i += 31) peak = Math.max(peak, Math.abs(x[i]));
      if (peak < 1e-4) throw new Error(L('文件里没有声音', 'the file is silent'));
      Object.assign(song, { buf, x, sr: 44100 });
      const t = performance.now();
      this.say(L('正在分析，请稍候，分析完才能开始唱…', 'Analysing — please wait; singing starts once it’s done…'));
      const mel = await this.analyseSong(song, x);
      if (this.song !== song) return;
      this.say(L(`“${file.name}”分析好了：${fmtT(mel.secs)}，${mel.notes.length} 个旋律音（用了 ${((performance.now() - t) / 1000).toFixed(0)} 秒）。戴上耳机，点“② 开始跟唱”。`, `“${file.name}” analysed: ${fmtT(mel.secs)}, ${mel.notes.length} melody notes (in ${((performance.now() - t) / 1000).toFixed(0)} s). Put on headphones and press “② Sing along”.`));
    } catch (err) {
      if (this.song === song) { this.dropSong(); this.song = null; }
      // decodeAudioData can't read every container (some .mkv, odd codecs)
      const msg = /decod|EncodingError|Unable/i.test(`${err.name} ${err.message}`) ? L('读不出它的声音（换成 mp4 / mov / mp3 试试）', 'its sound can’t be read (try an mp4 / mov / mp3)') : err.message;
      this.say(L(`分析不了这个文件：${msg}`, `Can’t analyse this file: ${msg}`));
    }
    this.busy = false; clearStep(); this.controls(); this.draw(0);
  }

  // ② singing along (only with a song fully analysed)
  async start() {
    if (!this.song?.ready || this.busy || this.eng) return;
    if (this.app.live?.engine.running) { alert(L('请先结束“唱一段看问题”页面的录音。', 'Please stop the recording on the “Sing & check” page first.')); return; }
    return this.song.yt ? this.startYt() : this.song.align ? this.startTab() : this.startFile();
  }

  // a song file plays in the microphone's own audio context
  async startFile() {
    const $ = this.$, S = this.app.settings;
    const eng = new AudioEngine(), pt = new PitchTracker(S);
    let an = null;
    this.user = []; this.result = null; this.mic = null; this.reviewT = null; $('alRes').innerHTML = '';
    eng.onFrame = (frame, t) => {
      if (!an || this.eng !== eng || this.startMic == null) return;
      const st = pt.update(an.analyze(frame, { gateDb: S.gateDb, pitchOnly: true }), t);
      this.last = st;
      this.keepMic(frame, t, eng.sampleRate);
      if (st.voiced) this.user.push({ t: t - this.startMic, midi: st.midi });
    };
    try { await eng.startMic({ deviceId: S.deviceId, record: false }); } catch (err) { alert(L(`麦克风错误：${err.message}`, `Microphone error: ${err.message}`)); return; }
    an = new FrameAnalyzer(eng.sampleRate);
    this.eng = eng;
    this.controls();
    // the song plays in the same audio context: its start on the microphone's
    // clock is known; the rest of the delay (headphones, microphone) is found
    // afterwards by lining the two pitch tracks up
    const ctx = eng.ctx, src = ctx.createBufferSource(), lead = 0.3;
    src.buffer = this.song.buf; src.connect(ctx.destination);
    src.start(ctx.currentTime + lead);
    this.src = src;
    this.startMic = eng.now() + lead;
    this.lag = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + 0.03;
    src.onended = () => { if (this.eng === eng) this.stop(); };
    // a video file: its picture, muted, follows the sound being heard (the
    // song plays in the audio context; the picture is nudged back whenever it
    // drifts over 0.12 s)
    const vid = this.song.video ? this.root.querySelector('#alYt video') : null, outLat = ctx.outputLatency || 0;
    if (vid) { vid.muted = true; vid.currentTime = 0; setTimeout(() => { if (this.eng === eng) vid.play().catch(() => {}); }, (lead + outLat) * 1000); }
    this.singing(eng);
    let lagAt = 0;
    const tick = () => {
      if (this.eng !== eng) return;
      // the delay, lined up again every 2 s on the last 12 s sung
      const t = eng.now() - this.startMic;
      if (vid && !vid.paused && t - outLat > 0 && Math.abs(vid.currentTime - (t - outLat)) > 0.12) vid.currentTime = t - outLat;
      if (t - lagAt >= 2 && this.user.length > 100) {
        lagAt = t;
        const rec = this.user.filter((u) => u.t > t - 12), est = bestLag(this.song.mel.frames.filter((f) => f.t > t - 13 && f.t < t + 1), rec);
        if (est.share >= 0.3) this.lag = est.lag;
      }
      this.frame(t - this.lag);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // A YouTube video: song time = the video's time. The microphone's clock is
  // mapped onto it with the median of (player time − microphone time) over the
  // last 1.5 s while playing (the player's time comes in coarse steps); a pause
  // or a jump resets it, and nothing is taken in while the video isn't playing.
  async startYt() {
    const $ = this.$, S = this.app.settings, P = this.player;
    const eng = new AudioEngine(), pt = new PitchTracker(S);
    let an = null;
    this.user = []; this.result = null; this.mic = null; this.reviewT = null; $('alRes').innerHTML = '';
    this.startMic = null;
    const ds = [];
    eng.onFrame = (frame, t) => {
      if (!an || this.eng !== eng) return;
      this.keepMic(frame, t, eng.sampleRate); // all of it: the spectra find moments by the microphone's clock
      if (this.startMic == null || P.getPlayerState?.() !== 1) return;
      const st = pt.update(an.analyze(frame, { gateDb: S.gateDb, pitchOnly: true }), t);
      this.last = st;
      if (st.voiced) this.user.push({ t: t - this.startMic, midi: st.midi });
    };
    try { await eng.startMic({ deviceId: S.deviceId, record: false }); } catch (err) { alert(L(`麦克风错误：${err.message}`, `Microphone error: ${err.message}`)); return; }
    an = new FrameAnalyzer(eng.sampleRate);
    this.eng = eng;
    this.controls();
    this.lag = (eng.ctx.outputLatency || 0) + 0.03;
    let lastState = -1;
    this.vIv = setInterval(() => {
      const state = P.getPlayerState?.();
      if (state !== lastState) { ds.length = 0; lastState = state; }
      if (state === 0 && this.eng === eng) { this.stop(); return; }
      if (state !== 1) return;
      ds.push(P.getCurrentTime() - eng.now());
      if (ds.length > 15) ds.shift();
      const sorted = [...ds].sort((p, q) => p - q);
      this.startMic = -sorted[sorted.length >> 1]; // song time = microphone time − startMic
    }, 100);
    try { P.seekTo(0, true); P.setPlaybackRate(1); P.playVideo(); } catch { /* the singer can press play */ }
    this.singing(eng);
    const tick = () => {
      if (this.eng !== eng) return;
      if (this.startMic != null) this.frame(eng.now() - this.startMic - this.lag);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // A song on a player the page can't ask: where it is comes from its sound.
  // Every 0.5 s the tab's last 4 s — sounding all through, freshly arrived — are
  // matched against the analysis recording (all of it at first; then ±2 s
  // around where it should be — repeated choruses can't mix it up); song time
  // = microphone time + the median of the last 5 offsets. Lost 3 times in a row
  // (seeked, another song): searched all over again. What's sung before the
  // song is found is put in place once it is.
  async startTab() {
    const $ = this.$, S = this.app.settings, song = this.song;
    let tab = song.tab;
    if (!tab || tab.getAudioTracks()[0]?.readyState !== 'live') {
      try { ({ stream: tab } = await captureTabAudio({ currentTab: song.name === 'Bilibili' })); } catch { this.say(L('要再共享一次放歌的标签页（和它的音频），程序才听得出播到哪里。', 'Share the tab playing the song (with its audio) again, so the app can hear where it is.')); return; }
      song.tab = tab;
    }
    const eng = new AudioEngine(), pt = new PitchTracker(S);
    let an = null;
    this.user = []; this.result = null; this.mic = null; this.reviewT = null; $('alRes').innerHTML = '';
    this.startMic = null;
    let sounding = 0; // the tab's sound's end, microphone time, when it was last loud
    // sung while the song isn't found (it takes 4 s of its sound): kept on the
    // microphone's clock, put in place once it is; what was placed by a lock
    // that is then lost (a wrong place, a repeated chorus) goes back here too
    let pending = [], lockTm = Infinity, locked = false; // lockTm: microphone time from which the current lock placed what was sung
    eng.onFrame = (frame, t) => {
      if (!an || this.eng !== eng) return;
      this.keepMic(frame, t, eng.sampleRate);
      if (t - sounding > 0.5) return;
      const st = pt.update(an.analyze(frame, { gateDb: S.gateDb, pitchOnly: true }), t);
      this.last = st;
      if (!st.voiced) return;
      if (this.startMic == null || !locked) pending.push({ tm: t, midi: st.midi });
      else this.user.push({ t: t - this.startMic, midi: st.midi, tm: t });
    };
    try { await eng.startMic({ deviceId: S.deviceId, record: false }); } catch (err) { alert(L(`麦克风错误：${err.message}`, `Microphone error: ${err.message}`)); return; }
    an = new FrameAnalyzer(eng.sampleRate);
    this.eng = eng;
    this.controls();
    const ctx = eng.ctx, src = ctx.createMediaStreamSource(tab), node = new AudioWorkletNode(ctx, 'vocal-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }), sink = ctx.createGain();
    sink.gain.value = 0; src.connect(node); node.connect(sink).connect(ctx.destination);
    const sr = ctx.sampleRate, keepN = Math.ceil(4 * sr / 1024), ring = [];
    let endT = 0, since = null; // microphone time at the end of the newest block; when the sound began
    node.port.onmessage = (e) => {
      if (this.eng !== eng) return;
      const b = e.data; let p = 0;
      for (let i = 0; i < b.length; i++) p += b[i] * b[i];
      endT = eng.now();
      if (10 * Math.log10(p / b.length + 1e-12) > -55) { sounding = endT; since ??= endT - b.length / sr; } else if (endT - sounding > 0.3) since = null;
      ring.push(b); if (ring.length > keepN) ring.shift();
    };
    this.tabNode = { src, node };
    this.lag = (ctx.outputLatency || 0) + 0.03;
    const ds = [];
    let miss = 0;
    this.vIv = setInterval(() => {
      // only stretches of sound all through: a start out of silence would match
      // any silence-to-sound edge (the song's end, say), not the moment
      // and only fresh sound: if it stops coming in, the old stretch isn't matched again and again
      if (this.eng !== eng || ring.length < keepN || since == null || endT - since < 4 || eng.now() - endT > 0.3) return;
      const x = new Float32Array(ring.length * 1024); ring.forEach((c, i) => x.set(c, i * 1024));
      const t0 = endT - x.length / sr, live = features(x, sr);
      const guess = locked && this.startMic != null ? (t0 - this.startMic) * AL_RATE : null;
      const r = locate(song.align, live, guess != null ? { from: guess - 2 * AL_RATE, to: guess + 2 * AL_RATE } : {});
      // found anywhere: a clear match (score ≥ 0.4, ahead of any other place by
      // ≥ 0.1); followed nearby: a weaker one does (live sound matched 0.35–0.5
      // against the recording with a stand-in, against 0.8–1.0 file to file)
      if (r && (locked ? r.score >= 0.25 : r.score >= 0.4 && r.margin >= 0.1)) {
        miss = 0;
        ds.push(r.at / AL_RATE - t0); if (ds.length > 5) ds.shift();
        const sorted = [...ds].sort((p, q) => p - q), found = !locked;
        this.startMic = -sorted[sorted.length >> 1];
        locked = true;
        // just found: what was sung while it was being looked for, put in place
        if (found) {
          const back = pending.filter((p) => p.tm >= since - 0.5);
          lockTm = back.length ? back[0].tm : eng.now();
          this.user.push(...back.map((p) => ({ t: p.tm - this.startMic, midi: p.midi, tm: p.tm })));
          this.user.sort((p, q) => p.t - q.t);
          pending = [];
        }
      } else if (locked && ++miss >= 3) {
        // lost: look everywhere again; what this lock placed waits to be placed again
        locked = false; ds.length = 0;
        pending = this.user.filter((u) => u.tm >= lockTm).map((u) => ({ tm: u.tm, midi: u.midi })).sort((p, q) => p.tm - q.tm);
        this.user = this.user.filter((u) => u.tm < lockTm);
      }
    }, 500);
    this.singing(eng);
    this.say(L('正在跟唱…从头播放那首歌（原速），程序听出播到哪里后就开始记录。', 'Singing along… play the song from the start (normal speed); recording starts once the app hears where it is.'));
    const tick = () => {
      if (this.eng !== eng) return;
      if (this.startMic != null) this.frame(eng.now() - this.startMic - this.lag);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  singing(eng) {
    const $ = this.$;
    $('alGo').textContent = L('■ 停止', '■ Stop'); $('alGo').classList.add('recording');
    this.say(L('正在跟唱…', 'Singing along…'));
    this.showHeadsetTip(eng);
  }

  // one moment while singing: the chart, the spectra (10 a second), the notes now
  frame(now) {
    this.draw(now);
    if (!this.specAt || performance.now() - this.specAt > 100) { this.specAt = performance.now(); this.drawSpectra(now - 0.06); }
    this.$('alNow').innerHTML = this.nowHtml(this.refAt(now), this.last?.voiced ? this.last.f0 : 0);
  }

  // a Bluetooth headset's own microphone: say so where the headphone tip is
  showHeadsetTip(eng) {
    if (!eng.micIsHeadset) return;
    const el = this.root.querySelector('#alTip');
    el.classList.add('warn');
    el.textContent = L('🎧 正在用 AirPods 等蓝牙耳机自带的麦克风：可以跟唱，延迟会自动校准；但耳机会切到通话模式，听到的原唱音质变差。想听得更清楚，可到“设置”里把麦克风改成电脑自带的，耳机只用来听。', '🎧 Using the Bluetooth headset’s own microphone (AirPods and the like): fine for singing along, the delay is lined up automatically; but the headset switches to call mode and the original sounds worse. For better sound, pick the computer’s built-in microphone in Settings and use the headset only to listen.');
  }

  async stop() {
    const $ = this.$, eng = this.eng;
    if (!eng) return;
    this.eng = null;
    cancelAnimationFrame(this.raf);
    clearInterval(this.vIv);
    try { this.src?.stop?.(); } catch { /* ended */ }
    try { if (this.song?.yt) this.player?.pauseVideo(); } catch { /* gone */ }
    this.root.querySelector('#alYt video')?.pause();
    try { this.tabNode?.src.disconnect(); this.tabNode?.node.disconnect(); } catch { /* gone */ }
    this.tabNode = null;
    await eng.stop();
    $('alGo').textContent = L('● 再唱一遍', '● Sing again'); $('alGo').classList.remove('recording');
    $('alNow').innerHTML = this.nowHtml(null, null);
    this.controls();
    this.finish();
  }

  // The analysis itself: Demucs (along/separate.js) separates the lead vocal,
  // MELODIA follows it — with the band in the mix MELODIA follows chords and
  // bass much of the time (a synthetic song: 22 of 176 moments right on the mix,
  // 160 on the vocal). Then the model is released (≈ 1 GB of GPU / main
  // memory): nothing runs beside the singing. A failure is an error — there's
  // no half-right fallback. The progress line has a fixed height.
  // rate: x was played that many times faster (pitch kept); scale: song
  // seconds per second of x (measured; ≈ rate); offset: song time of x[0].
  // → the melody (set on the song with song.vox = the vocal, song.ready)
  async analyseSong(song, x, { offset = 0, rate = 1, scale = rate } = {}) {
    const box = this.root.querySelector('#alSep'), txt = box.querySelector('.al-sep-t'), fill = box.querySelector('.fill');
    const show = (t, p = null, cls = 'busy') => { if (this.song !== song) return; txt.textContent = t; box.className = `al-sep ${cls}`; if (p != null) fill.style.width = `${Math.round(p * 100)}%`; };
    const pct = (p) => `${Math.round(p * 100)}%`;
    let vox = null, why = '';
    // the analysis, animated where the pitch chart will be (the same size)
    const scroll = this.root.querySelector('#alScroll'), acv = this.root.querySelector('#alAnim');
    scroll.style.display = 'none'; acv.style.display = '';
    const go = this.anim?.capture && this.anim.raf, anim = go ? this.anim : (this.anim = new AnalysisAnim(acv));
    anim.setSong(x, 44100, { scale, keep: !!go }); if (!go) anim.start();
    show(L('第 1 步：准备人声分离模型（Demucs）…', 'Step 1: getting the vocal-separation model (Demucs) ready…'), 0);
    try {
      const r = await separateVocals(x, {
        onProgress: (d) => { anim.update(d); const { stage, progress, device } = d; markStep(stage === 'separate' ? 'separate' : 'model', song); show(
          stage === 'download' ? L(`第 1 步：下载人声分离模型（约 126 MB，只下载这一次）… ${pct(progress)}`, `Step 1: downloading the vocal-separation model (about 126 MB, this once only)… ${pct(progress)}`)
            : stage === 'load' ? L('第 1 步：载入人声分离模型…', 'Step 1: loading the vocal-separation model…')
            : L(`第 2 步：把原唱的人声和伴奏分开（${device === 'webgpu' ? 'GPU' : 'CPU，较慢'}）… ${pct(progress)}`, `Step 2: separating the original’s vocal from the band (${device === 'webgpu' ? 'GPU' : 'CPU, slower'})… ${pct(progress)}`),
          stage === 'load' ? 1 : progress); },
      });
      vox = r.vocals;
      why = L(`人声分离用 ${r.device === 'webgpu' ? 'GPU' : 'CPU'} ${r.secs.toFixed(0)} 秒`, `vocal separated on the ${r.device === 'webgpu' ? 'GPU' : 'CPU'} in ${r.secs.toFixed(0)} s`);
    } catch (err) {
      why = err.message;
    } finally {
      await releaseSeparator(); // the model leaves memory before the singing
    }
    const back = () => { anim.stop(); if (this.anim === anim) { acv.style.display = 'none'; scroll.style.display = ''; } };
    if (this.song !== song) { anim.stop(); return song.mel; }
    if (!vox) { back(); show(L(`人声分离失败（${why}）`, `Vocal separation failed (${why})`), null, 'warn'); throw new Error(L(`人声分离失败（${why}）`, `vocal separation failed (${why})`)); }
    show(L('第 3 步：从人声里提取原唱的旋律…', 'Step 3: extracting the original’s melody from the vocal…'), 1);
    markStep('melody', song);
    anim.update({ stage: 'melody' });
    const m = await extractMelody(vox, this.app.settings.a4, { rate }).catch(() => { back(); throw new Error(L('提取不出旋律', 'no melody could be extracted')); });
    if (m.notes.length < 3) { back(); show('', null, ''); throw new Error(L('找不到明显的旋律（纯伴奏、打击乐或说话？）', 'no clear melody (backing only, percussion or speech?)')); }
    // MELODIA's times are at the real pace (x seconds × rate) → song time
    const k = scale / rate, frames = m.frames.map((f) => ({ t: offset + k * f.t, midi: f.midi }));
    song.mel = { frames, notes: notesOf(frames), secs: Math.max(song.mel?.secs || 0, offset + scale * (x.length / 44100)) };
    // the notes rise into place (on x's own time), then the pitch chart takes over
    anim.melody(m.frames.length ? notesOf(m.frames.map((f) => ({ t: f.t / rate, midi: f.midi }))) : []);
    await new Promise((r) => setTimeout(r, 1400));
    back();
    song.vox = { x: vox, sr: 44100, offset, scale };
    song.ready = true;
    clearStep();
    show(L(`✓ 分析完成（${why}），模型已卸载`, `✓ Analysed (${why}), model unloaded`), null, 'ok');
    return song.mel;
  }

  // the delay lined up, every note compared, the whole song drawn
  finish() {
    const $ = this.$, mel = this.song.mel;
    if (!mel.notes.length) { this.draw(null); return; }
    if (this.user.length < 20) { $('alStatus').textContent = L('没听到你唱：检查麦克风，戴耳机再试。', 'Didn’t hear you sing: check the microphone and try again on headphones.'); this.draw(null); return; }
    // a player's sound, not a file: its clock and the recording's can sit a
    // fixed few tenths of a second apart (0.1–0.25 s with a stand-in), so the
    // delay is looked for over a wider range
    const L_ = bestLag(mel.frames, this.user, this.song.yt || this.song.align ? { min: -0.6, max: 1.0 } : {});
    this.lag = L_.lag;
    const user = this.user.map((u) => ({ t: u.t - this.lag, midi: u.midi }));
    const end = user[user.length - 1].t;
    const refNotes = mel.notes.filter((n) => n.t0 <= end);
    const R = compareAlong(refNotes, user, { key: this.keyMode });
    this.result = { R, user, refNotes, mine: notesOf(user), lag: L_ };
    $('alStatus').textContent = L(`唱完了：录放延迟已自动校准（${Math.round(this.lag * 1000)} 毫秒）。`, `Done: the recording delay was lined up automatically (${Math.round(this.lag * 1000)} ms).`);
    this.renderResult();
    this.draw(null);
  }

  // the newest hop of microphone audio, kept (in memory) for the spectra
  keepMic(frame, t, sr) {
    const hop = 1024;
    if (!this.mic) this.mic = { sr, chunks: [], t0: t + frame.length / (2 * sr) - hop / sr };
    this.mic.chunks.push(frame.slice(frame.length - hop));
  }

  // N samples centred on `center` from a list of equal chunks (null if outside)
  static windowOf(chunks, center, N = 4096) {
    if (!chunks?.length) return null;
    const per = chunks[0].length, start = Math.round(center - N / 2);
    if (start < 0 || start + N > chunks.length * per) return null;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) { const j = start + i; out[i] = chunks[Math.floor(j / per)][j % per]; }
    return out;
  }

  // the spectra of the original (its separated vocal) and the singer at song time t
  drawSpectra(t) {
    const cv = this.root.querySelector('#alSpec');
    if (!cv || !this.song || !Number.isFinite(t)) return;
    const N = 4096, song = this.song;
    let rx = null;
    const V = song.vox, rsr = 44100, vc = V ? ((t - V.offset) / (V.scale || 1)) * V.sr : -1;
    if (V && vc - N / 2 >= 0 && vc + N / 2 <= V.x.length) rx = V.x.subarray(Math.round(vc - N / 2), Math.round(vc - N / 2) + N);
    // the singer: the microphone at the matching moment (the delay lined up)
    let ux = null;
    const M = this.mic;
    if (M) ux = AlongView.windowOf(M.chunks, (t + this.lag + this.startMic - M.t0) * M.sr, N);
    const near = (fr, tt, dt) => { let b = null; for (const f of fr) { if (Math.abs(f.t - tt) <= dt && (!b || Math.abs(f.t - tt) < Math.abs(b.t - tt))) b = f; } return b; };
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    // the original's pitch: the nearest melody frame (MELODIA leaves gaps between
    // frames and in breaths: up to 0.1 s away), else the note the moment falls in
    const rf = near(song.mel.frames.filter((f) => Math.abs(f.t - t) < 0.12), t, 0.1) || this.refAt(t), uf = near(this.user.filter((u) => Math.abs(u.t - this.lag - t) < 0.08).map((u) => ({ t: u.t - this.lag, midi: u.midi })), t, 0.05);
    const rF0 = rf ? hz(rf.midi) : 0, uF0 = uf ? hz(uf.midi) : 0;
    const rel = pitchRelation(rF0, uF0);
    // the singer's F1/F2 by LPC; the original's from its separated vocal's harmonics
    const refS = rx && rx.length === N ? voiceSide(rx, rsr, N / 2, rF0, { N, mixed: true }) : null, user = ux ? voiceSide(ux, M.sr, N / 2, uF0, { N }) : null;
    this.cards?.update({ ref: refS?.f0 ? refS : null, user: user?.f0 ? user : null });
    drawSpectraPair(cv, { refLabel: L('原唱人声', 'Orig. vocal'), ref: refS, user, say: this.relationText(rel, rF0, uF0, t), say2: this.ringText(refS, user) });
  }

  // the ring (2–4 kHz below the lows) and the vowel, original against singer
  ringText(r, u) {
    const sex = VOICE_TYPES[this.app.settings.voiceType]?.sex;
    const vow = (s) => { const v = s?.formants && vowelOf(s.formants[0], s.formants[1], sex); return v ? L(`像“${v.zh}”`, `like “${v.en.split(' ')[0]}”`) : ''; };
    const rr = r?.ring, ur = u?.ring;
    if (!Number.isFinite(ur) && !Number.isFinite(rr)) return '';
    const vtxt = vow(r) && vow(u) && vow(r) !== vow(u) ? L(`；元音：原唱${vow(r)}，你${vow(u)}`, `; vowel: original ${vow(r)}, you ${vow(u)}`) : '';
    if (Number.isFinite(rr) && Number.isFinite(ur)) {
      const d = Math.round(ur - rr);
      return L(`共鸣（2–4 kHz 比低频弱多少，越小越亮）：原唱 ${Math.round(rr)} dB，你 ${Math.round(ur)} dB${Math.abs(d) < 3 ? '，差不多' : d > 0 ? `——你这一刻比原唱闷 ${d} dB` : `——你这一刻比原唱亮 ${-d} dB`}${vtxt}`,
        `Ring (2–4 kHz below the lows, smaller = brighter): original ${Math.round(rr)} dB, you ${Math.round(ur)} dB${Math.abs(d) < 3 ? ', about the same' : d > 0 ? ` — you’re ${d} dB duller here` : ` — you’re ${-d} dB brighter here`}${vtxt}`);
    }
    return Number.isFinite(ur) ? L(`你的共鸣：2–4 kHz 比低频弱 ${Math.round(ur)} dB（越小越亮，好的歌声约 10–20）`, `Your ring: 2–4 kHz ${Math.round(ur)} dB below the lows (smaller = brighter; good singing ≈ 10–20)`) : '';
  }

  relationText(rel, rF0, uF0, t) {
    const at = `${fmtT(Math.max(0, t))}  `, nm = (f) => midiName(Math.round(69 + 12 * Math.log2(f / 440)));
    if (!rF0 && !uF0) return at + L('这一刻原唱和你都没有音高', 'neither the original nor you have a pitch here');
    if (!rF0) return at + L('原唱这一刻没有旋律（可能是伴奏或换气）', 'no melody in the original here (accompaniment or a breath)');
    if (!uF0) return at + L(`原唱 ${nm(rF0)}，你这一刻没出声`, `original ${nm(rF0)}, you’re silent here`);
    const c = rel.cents, cTxt = c === 0 ? '' : c > 0 ? L(`，再偏高 ${c} 音分`, `, then ${c} cents sharp`) : L(`，再偏低 ${-c} 音分`, `, then ${-c} cents flat`);
    if (rel.octave) {
      const n = Math.abs(rel.octave), lower = rel.octave < 0, pc = rel.refName.replace(/-?\d+$/, '');
      return at + L(`你比原唱${lower ? '低' : '高'} ${n} 个八度${cTxt}：你的 F0 ${Math.round(uF0)} Hz ≈ 原唱 ${Math.round(rF0)} Hz 的 ${lower ? `1/${2 ** n}` : 2 ** n} 倍，${lower ? `你的第 ${2 ** n} 根谐波落在原唱的 F0 上` : `原唱的第 ${2 ** n} 根谐波落在你的 F0 上`}——音名一样（${pc}），只差八度`,
        `You are ${n} octave${n > 1 ? 's' : ''} ${lower ? 'below' : 'above'} the original${cTxt}: your F0 ${Math.round(uF0)} Hz ≈ ${lower ? `1/${2 ** n}` : `${2 ** n}×`} its ${Math.round(rF0)} Hz; ${lower ? `your harmonic ${2 ** n}` : `its harmonic ${2 ** n}`} sits on ${lower ? 'its' : 'your'} F0 — the same note name (${pc}), octaves apart`);
    }
    if (rel.kind === 'same') return at + L(`和原唱同一个音 ${rel.refName}（差 ${Math.abs(c)} 音分）：两条 F0 对齐`, `the same note as the original, ${rel.refName} (${Math.abs(c)} cents apart): the F0s line up`);
    return at + L(`比原唱${c > 0 ? '高' : '低'} ${Math.abs(c)} 音分：你的 F0 ${Math.round(uF0)} Hz，原唱 ${Math.round(rF0)} Hz（${rel.refName}）${rel.kind === 'off' ? '——超过半个半音，听得出来' : ''}`, `${Math.abs(c)} cents ${c > 0 ? 'sharp' : 'flat'} of the original: your F0 ${Math.round(uF0)} Hz, its ${Math.round(rF0)} Hz (${rel.refName})${rel.kind === 'off' ? ' — over half a semitone, audible' : ''}`);
  }

  // the original's note at song time t
  refAt(t) { return this.song?.mel.notes.find((n) => t >= n.t0 && t <= n.t1) || null; }

  nowHtml(ref, f0) {
    return `<div class="al-nowbox"><span class="muted">${L('原唱', 'Original')}</span><b style="color:${ALONG_COLORS.ref}">${ref ? ref.name : '—'}</b></div>
      <div class="al-nowbox"><span class="muted">${L('你', 'You')}</span>${pitchNowHtml(f0 || 0, this.app.settings.a4)}</div>`;
  }

  draw(now = null) {
    const cv = this.root.querySelector('#alView');
    if (!cv) return;
    const mel = this.song?.mel, notes = mel?.notes || [];
    const res = this.result;
    const shift = res ? -(12 * res.R.summary.octave + res.R.summary.key) : 0;
    // the whole song's range (the singer overlaid on it), fixed while singing
    // the melody's range without its strays (5th–95th percentile: one stray
    // instrument note mustn't squash the chart)
    const ms = notes.map((n) => n.midi).sort((a, b) => a - b), P = VOICE_TYPES[this.app.settings.voiceType];
    const q = (p) => ms[Math.round(p * (ms.length - 1))];
    let range = ms.length ? [Math.floor(q(0.05)) - 3, Math.ceil(q(0.95)) + 3] : [P.low - 3, P.high + 3];
    // each moment of the singer's line against the original's note there (octave aside)
    const statusOf = res ? (t) => res.R.notes.find((n) => t >= n.t0 && t <= n.t1)?.status : (t, midi) => {
      const r = this.refAt(t);
      if (!r || !Number.isFinite(midi)) return null;
      const d = midi - r.midi, c = Math.abs(d - 12 * Math.round(d / 12)) * 100;
      return c <= 25 ? 'good' : c <= 50 ? 'near' : 'off';
    };
    const liveShift = res ? shift : (() => { const r = this.refAt(now ?? 0), u = this.user[this.user.length - 1]; return r && u ? -12 * Math.round((u.midi - r.midi) / 12) : 0; })();
    const win = now == null ? [0, Math.max(10, (res ? res.user[res.user.length - 1].t : mel?.secs ?? 10) + 0.5)] : this.song?.yt ? [now - 8, now + 1] : [now - 5, now + 3];
    // the whole song after singing: 90 px a second, scrolled sideways (only the
    // width changes, so nothing on the page moves)
    const box = this.root.querySelector('#alScroll'), wide = now == null && res;
    cv.style.width = wide ? `${Math.max(box.clientWidth, Math.round((win[1] - win[0]) * 90))}px` : '100%';
    // where the singer sang is where the voice is: the original's notes outside
    // their phrases are accompaniment (after singing: as judged; while singing:
    // the notes already passed; the ones ahead stay blue to sing by)
    let ref = notes;
    if (res) ref = res.R.notes.map((n) => (n.status === 'accomp' ? { ...n, faint: true } : n)).concat(notes.filter((n) => n.t0 > res.user[res.user.length - 1].t).map((n) => ({ ...n, faint: true })));
    else if (now != null && this.user.length) {
      const ph = phrasesOf(this.user.map((u) => ({ t: u.t - this.lag, midi: u.midi })));
      ref = notes.map((n) => (n.t1 < now - 0.3 && coverOf(n, ph) < 0.5 ? { ...n, faint: true } : n));
    }
    this.lastWin = win;
    drawAlong(cv, {
      range, win, ref, now: now ?? this.reviewT ?? null,
      user: res ? res.user : this.user.map((u) => ({ t: u.t - this.lag, midi: u.midi })),
      mine: res ? res.mine : [], shift: res ? shift : liveShift, statusAt: statusOf,
    });
  }

  // compare again in another key (relative / absolute pitch)
  setKeyMode(mode) {
    this.keyMode = mode;
    const r = this.result;
    if (!r) return;
    r.R = compareAlong(r.refNotes, r.user, { key: mode });
    this.renderResult();
    this.draw(null);
  }

  renderResult() {
    const { R, lag } = this.result, s = R.summary, T = STATUS_TXT();
    const semi = (k) => L(`${Math.abs(k)} 个半音`, `${Math.abs(k)} semitone${Math.abs(k) > 1 ? 's' : ''}`);
    const keyTxt = s.key ? L(`你比原唱${s.key < 0 ? '低' : '高'} ${semi(s.key)}唱（换了调），按你唱的调比较：每个音和原唱移调后的音比，只看音与音之间准不准（相对音高）。`, `You sang ${semi(s.key)} ${s.key < 0 ? 'lower' : 'higher'} than the original (another key); compared in your key: each note against the original’s, moved to your key — how well the notes relate (relative pitch).`)
      : this.keyMode === 'absolute' ? L('按原调比较（绝对音高）：每个音和原唱的音直接比。', 'Compared in the original key (absolute pitch): each note straight against the original’s.') : '';
    const seg = `<div class="seg al-key">${[['auto', L('自动', 'Auto')], ['relative', L('按你唱的调（相对音高）', 'In your key (relative)')], ['absolute', L('按原调（绝对音高）', 'In the original key (absolute)')]].map(([k, t]) => `<button data-key="${k}" class="${this.keyMode === k ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    const pct = s.sung ? Math.round((s.inTune / s.sung) * 100) : 0;
    const tend = Math.abs(s.bias) < 10 ? L('整体不偏高也不偏低', 'no overall tendency') : s.bias > 0 ? L(`整体偏高约 ${s.bias} 音分`, `overall about ${s.bias} cents sharp`) : L(`整体偏低约 ${-s.bias} 音分`, `overall about ${-s.bias} cents flat`);
    const oct = s.octave ? L(`你比原唱${octTxt(s.octave)}唱（很正常，比如${s.octave < 0 ? '男生跟女歌手' : '女生跟男歌手'}），按同一个音名比较。`, `You sang ${octTxt(s.octave)} than the original (normal, e.g. ${s.octave < 0 ? 'a man along a woman' : 'a woman along a man'}); compared by note name.`) : '';
    const rows = R.notes.filter((n) => n.status !== 'accomp').map((n, i) => `<tr class="al-${n.status}"><td>${i + 1}</td><td>${fmtT(n.t0)}</td><td style="color:${ALONG_COLORS.ref}"><b>${n.name}</b>${s.key ? ` <small>→ ${midiName(Math.round(n.midi + s.key))}</small>` : ''}</td>
      <td style="color:${ALONG_COLORS.mine}">${n.sung ? `<b>${n.user.name}</b>${n.user.octave ? ` <small>${octTxt(n.user.octave)}</small>` : ''}` : '—'}</td>
      <td>${n.sung ? centsTxt(n.user.cents) : ''}</td><td><i class="al-dot" style="background:${ALONG_COLORS[n.status === 'missed' ? 'none' : n.status]}"></i>${T[n.status]}</td></tr>`).join('');
    this.root.querySelector('#alRes').innerHTML = `
      <div class="panel" style="margin-top:12px">
        <div class="ph"><h3>${L('这一遍的音准', 'Pitch this time')}</h3><span class="sub">${L(`录放延迟 ${Math.round(lag.lag * 1000)} 毫秒，已自动对齐`, `recording delay ${Math.round(lag.lag * 1000)} ms, lined up`)}</span></div>
        ${seg}
        ${keyTxt ? `<p style="font-size:13.5px;margin:4px 0">${keyTxt}</p>` : ''}
        <p style="font-size:15px">${L(`你唱的那几句里，原唱有 <b>${s.total}</b> 个音，你唱了 <b>${s.sung}</b> 个，其中 <b>${s.inTune}</b> 个在 ±50 音分以内（${pct}%）；${tend}。`, `In the lines you sang, the original has <b>${s.total}</b> notes; you sang <b>${s.sung}</b>, <b>${s.inTune}</b> of them within ±50 cents (${pct}%); ${tend}.`)} ${oct}</p>
        ${s.accomp ? `<p class="muted" style="font-size:12.5px">${L(`另有 ${s.accomp} 个音在你没唱的地方（句与句之间、前奏间奏），当作伴奏，不计分；整句没唱的也算在这里。`, `${s.accomp} more notes fall where you didn’t sing (between lines, intros, solos): taken as accompaniment, not scored — a whole line left out counts here too.`)}</p>` : ''}
        ${s.worst.length ? `<p><b>${L('最不准的音：', 'Furthest off: ')}</b>${s.worst.map((n) => L(`${fmtT(n.t0)} 原唱 <b style="color:${ALONG_COLORS.ref}">${n.name}</b>，你 <b style="color:${ALONG_COLORS.mine}">${n.user.name}</b>（${centsTxt(n.user.cents)}）`, `${fmtT(n.t0)} original <b style="color:${ALONG_COLORS.ref}">${n.name}</b>, you <b style="color:${ALONG_COLORS.mine}">${n.user.name}</b> (${centsTxt(n.user.cents)})`)).join('；')}</p>` : ''}
        <p class="muted" style="font-size:12px">${L('上面的图已经换成整首歌：蓝条是原唱，彩色线是你（颜色 = 准不准），橙字是你唱的音名。下表是每个音的对照。', 'The chart above now shows the whole song: blue bars = the original, the coloured line = you (colour = how close), orange = the note you sang. The table compares every note.')}</p>
        <div class="al-table"><table><thead><tr><th>#</th><th>${L('时间', 'Time')}</th><th>${L('原唱', 'Original')}</th><th>${L('你', 'You')}</th><th>${L('差', 'Difference')}</th><th>${L('结果', 'Result')}</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>`;
    this.root.querySelectorAll('#alRes [data-key]').forEach((b) => { b.onclick = () => this.setKeyMode(b.dataset.key); });
  }
}
