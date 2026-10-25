// "跟原唱唱" / Sing along: import the original song (a file, or a YouTube video
// played in the page), sing along on headphones, and see the original's notes
// and yours side by side, note names on both. The original's melody comes from
// the song itself (MELODIA, see along/melody.js), not from the microphone — the
// microphone hears only the singer. A YouTube player's sound can't be read by
// the page: the singer shares the tab's sound through the browser's dialog
// (along/tabcapture.js); its melody is extracted every 2 s while singing (so it
// shows 1–2 s late) and once more over the whole take at the end.

import { AudioEngine } from '../audio/engine.js';
import { FrameAnalyzer } from '../dsp/analyzer.js';
import { PitchTracker } from '../analysis/pitch.js';
import { decodeSong, extractMelody, resampleTo44k } from '../along/melody.js';
import { videoIdOf, createPlayer, bilibiliEmbedOf } from '../along/youtube.js';
import { captureTabAudio, canCaptureTab } from '../along/tabcapture.js';
import { VOICE_TYPES, midiName } from '../config.js';
import { notesOf, bestLag, compareAlong, phrasesOf, coverOf } from '../along/compare.js';
import { drawAlong, drawSpectraPair, ALONG_COLORS } from '../viz/along.js';
import { pitchRelation, voiceSide } from '../along/spectra.js';
import { VoiceCards } from './voiceCards.js';
import { vowelOf } from '../analysis/vowels.js';
import { pitchNowHtml } from './pitchNow.js';
import { L } from '../i18n.js';

const fmtT = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const centsTxt = (c) => (c === 0 ? L('正好', 'spot on') : c > 0 ? L(`高 ${c} 音分`, `${c} cents sharp`) : L(`低 ${-c} 音分`, `${-c} cents flat`));
const octTxt = (k) => (k === 0 ? '' : k < 0 ? L(`低 ${-k} 个八度`, `${-k} octave${k < -1 ? 's' : ''} lower`) : L(`高 ${k} 个八度`, `${k} octave${k > 1 ? 's' : ''} higher`));
const STATUS_TXT = () => ({ good: L('准', 'in tune'), near: L('略偏', 'slightly off'), off: L('不准', 'off'), missed: L('没唱', 'not sung') });

export class AlongView {
  constructor(app, root) {
    this.app = app;
    this.root = root;
    this.song = null;   // { name, buf, mel: { frames, notes, secs } }
    this.user = [];     // the singer's pitch: { t (song time), midi }
    this.result = null;
    this.srcMode = 'file';  // where the original comes from: 'file' | 'yt'
    this.keyMode = 'auto';  // compare in: 'auto' | 'relative' (the singer's key) | 'absolute' (the original's)
  }

  show() { if (!this.rendered) this.render(); }

  render() {
    this.rendered = true;
    this.root.innerHTML = `
      <div class="ph"><h3 style="font-size:16px">${L('跟原唱唱', 'Sing along')}</h3>
        <span class="sub">${L('导入原唱，戴耳机跟着唱：蓝色是原唱的每个音，彩色线是你，两边都标音名（如 A3）', 'Import the original and sing along on headphones: blue = the original’s notes, the coloured line = you, note names on both (e.g. A3)')}</span></div>
      <div class="seg al-src" id="alSrc"><span class="muted">${L('原唱来源', 'The original from')}</span>
        <button data-src="file" class="on">${L('歌曲文件', 'A song file')}</button><button data-src="yt">${L('网页播放器（YouTube、B站…）', 'A web player (YouTube, Bilibili…)')}</button></div>
      <div class="al-yt" id="alYtRow" hidden>
        <div class="al-ytin"><input class="al-url" id="alUrl" placeholder="${L('粘贴 YouTube 或 B站视频链接；其他网站：在另一个标签页里播放，直接点“开始跟唱”', 'Paste a YouTube or Bilibili link; other sites: play it in another tab and just press “Sing along”')}" /><button class="btn" id="alYtLoad">${L('载入', 'Load')}</button></div>
        <div class="al-ytbox"><div id="alYt"></div></div>
        <p class="muted al-cap">${L('YouTube、B站的视频在这里播放；其他网站（网易云、QQ 音乐网页版等）就在另一个标签页里播放，把两个窗口并排放，边看这里边唱。点“开始跟唱”后，浏览器会弹出共享窗口：选正在放歌的那个标签页（这里的视频就选“这个标签页”），并打开“同时分享标签页音频”。程序要听到视频的声音才能找出原唱的旋律；声音只在内存里分析，不下载、不保存。只支持电脑版 Chrome / Edge。唱的时候原唱的音会晚 1–2 秒出现，唱完会对整段重新分析。', 'YouTube and Bilibili videos play here; for other sites (music sites and the like) play it in another tab and put the two windows side by side. After “Sing along” the browser asks what to share: pick the tab playing the music (“This tab” for a video here) and turn on “Also share tab audio”. The app needs to hear the video to find the original’s melody; the sound is analysed in memory only, never downloaded or stored. Desktop Chrome / Edge only. While singing the original’s notes show 1–2 s late; the whole take is analysed again at the end.')}</p>
      </div>
      <div class="live-controls al-controls">
        <button class="btn" id="alPick">${L('导入原唱文件', 'Import the original')}</button>
        <input type="file" id="alFile" accept="audio/*" class="hidden" />
        <button class="btn primary" id="alGo" disabled>${L('● 开始跟唱', '● Sing along')}</button>
        <span class="status al-status" id="alStatus">${L('支持 mp3、m4a、wav 等歌曲文件。', 'mp3, m4a, wav and other song files.')}</span>
        <div class="al-now" id="alNow"></div>
      </div>
      <p class="al-tip" id="alTip">🎧 ${L('请戴耳机：原唱只从耳机里放，麦克风就只录到你。用音箱外放时，麦克风会同时录到原唱，结果不准。', 'Wear headphones: the original plays only in them, so the microphone hears only you. Played through speakers, the microphone records the original too and the result isn’t reliable.')}</p>
      <div class="panel">
        <div class="al-scroll" id="alScroll"><canvas class="viz" id="alView" style="height:320px"></canvas></div>
        <div class="al-legend">
          <span><i style="background:${ALONG_COLORS.ref}"></i>${L('原唱的音（蓝字 = 音名）', 'the original’s notes (blue = note name)')}</span>
          <span><i style="background:${ALONG_COLORS.good}"></i>${L('你：准（±25 音分）', 'you: in tune (±25 cents)')}</span>
          <span><i style="background:${ALONG_COLORS.near}"></i>${L('略偏（±50）', 'slightly off (±50)')}</span>
          <span><i style="background:${ALONG_COLORS.off}"></i>${L('不准', 'off')}</span>
          <span><b style="color:${ALONG_COLORS.mine}">A3</b> ${L('橙字 = 你唱的音名', 'orange = the note you sang')}</span>
          <span><i style="background:rgba(154,163,181,0.45)"></i>${L('灰色 = 你没唱的地方，当作伴奏，不计分', 'grey = where you didn’t sing: taken as accompaniment, not scored')}</span>
        </div>
        <p class="muted al-cap" id="alCap">${L('原唱的旋律用 MELODIA 算法从歌曲里提取（Essentia.js）：前奏、间奏里的乐器旋律也可能被画出来，那几段不用跟。', 'The original’s melody is extracted from the song with the MELODIA algorithm (Essentia.js): instrumental intros and solos may show up too — no need to sing those.')}</p>
        <h4 class="ls-h">${L('频谱对照：同一时刻的原唱和你', 'Spectra: the original and you at the same moment')}</h4>
        <canvas class="viz" id="alSpec" style="height:270px"></canvas>
        <div id="alCards"></div>
        <p class="muted al-cap">${L('怎么看：粗竖线 F0 是基频，就是你听到的音高；连着各次谐波（F0 的 2 倍、3 倍……）的线是包络，它的形状由口腔喉咙决定。两条 F0 对齐 = 同一个音；低一个八度时，你的谐波密一倍，你的第 2 根谐波落在原唱的 F0 上（虚线），音名一样、只差八度。紫色 F1、F2 是共振峰——包络的前两个峰，决定元音，和音高无关（原唱混着伴奏，只用它旋律的谐波来估计，标 ≈）。蓝色区域 2–4 kHz 看共鸣：这一段的谐波比低频弱得越少，声音越亮、越有穿透力（好的歌声约 10–20 dB）。唱完以后，点上面音高图的任何位置，就显示那一刻。', 'How to read it: the thick line F0 is the fundamental — the pitch you hear; the line through the harmonics (2×, 3× F0 …) is the envelope, shaped by mouth and throat. F0s lined up = the same note; an octave lower, your harmonics are twice as dense and your 2nd sits on the original’s F0 (dashed) — the same note name, an octave apart. Purple F1, F2 are the formants — the envelope’s first two peaks, setting the vowel, not the pitch (for the original, mixed with the band, estimated from its melody’s harmonics: ≈). The blue 2–4 kHz band shows the ring: the less those harmonics fall below the lows, the brighter the voice carries (good singing ≈ 10–20 dB). After singing, click anywhere on the pitch chart above to see that moment.')}</p>
      </div>
      <div id="alRes"></div>`;
    const $ = (id) => this.root.querySelector('#' + id);
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
    $('alSrc').onclick = (e) => { const b = e.target.closest('[data-src]'); if (b && !this.eng) this.setSource(b.dataset.src); };
    $('alYtLoad').onclick = () => this.loadYt($('alUrl').value);
    $('alUrl').onkeydown = (e) => { if (e.key === 'Enter') this.loadYt($('alUrl').value); };
    $('alNow').innerHTML = this.nowHtml(null, null);
    this.cards = new VoiceCards($('alCards'), [{ key: 'ref', label: L('原唱', 'Original'), color: ALONG_COLORS.ref }, { key: 'user', label: L('你', 'You'), color: ALONG_COLORS.mine }], { sex: VOICE_TYPES[this.app.settings.voiceType]?.sex });
    this.draw();
  }

  get $() { return (id) => this.root.querySelector('#' + id); }

  setSource(src) {
    const $ = this.$;
    this.srcMode = src;
    $('alSrc').querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('on', b.dataset.src === src));
    $('alYtRow').hidden = src !== 'yt';
    $('alPick').hidden = src !== 'file';
    // a web player: any tab can be shared, so singing along needs no link first
    $('alGo').disabled = src === 'yt' ? !canCaptureTab() : !(this.song && !this.song.yt);
    $('alStatus').textContent = src === 'yt'
      ? (canCaptureTab() ? L('粘贴 YouTube / B站链接点“载入”，或者在另一个标签页里放歌，直接点“开始跟唱”。', 'Paste a YouTube / Bilibili link and press “Load”, or play the song in another tab and just press “Sing along”.') : L('这个浏览器不能共享标签页的声音：请用电脑版 Chrome 或 Edge。', 'This browser can’t share a tab’s sound: please use desktop Chrome or Edge.'))
      : L('支持 mp3、m4a、wav 等歌曲文件。', 'mp3, m4a, wav and other song files.');
  }

  async loadYt(url) {
    const $ = this.$, id = videoIdOf(url), bili = bilibiliEmbedOf(url);
    if (bili) {
      if (this.eng) await this.stop();
      this.player?.destroy?.(); this.player = null;
      $('alYt').innerHTML = `<iframe src="${bili}" allow="autoplay; fullscreen" referrerpolicy="no-referrer-when-downgrade"></iframe>`;
      this.song = { name: 'Bilibili', yt: true, embedded: true, mel: { frames: [], notes: [], secs: 0 } };
      this.user = []; this.result = null; this.mic = null; this.reviewT = null; $('alRes').innerHTML = '';
      $('alStatus').textContent = L('B站视频载入了。戴上耳机，点“开始跟唱”，共享“这个标签页”和音频，再点视频上的 ▶ 播放。', 'Bilibili video loaded. Put on headphones, press “Sing along”, share “This tab” with its audio, then press ▶ on the video.');
      $('alGo').disabled = false;
      this.draw(0);
      return;
    }
    if (!id) { this.player?.destroy?.(); this.player = null; $('alYt').innerHTML = ''; if (this.song?.yt) this.song = null; $('alStatus').textContent = L('这个链接不能嵌入（只支持 YouTube、B站）：请在另一个标签页里播放它，然后直接点“开始跟唱”，在共享窗口里选那个标签页。', 'This link can’t be embedded (YouTube and Bilibili only): play it in another tab, then press “Sing along” and pick that tab in the share dialog.'); return; }
    if (this.eng) await this.stop();
    $('alGo').disabled = true; $('alRes').innerHTML = '';
    $('alStatus').textContent = L('正在载入 YouTube 播放器…', 'Loading the YouTube player…');
    try {
      this.player?.destroy?.();
      $('alYt').innerHTML = '<div id="alYtEl"></div>';
      this.player = await createPlayer($('alYtEl'), id);
      this.song = { name: `YouTube ${id}`, yt: true, embedded: true, mel: { frames: [], notes: [], secs: 0 } };
      this.user = []; this.result = null;
      $('alStatus').textContent = L('视频载入了。戴上耳机，点“开始跟唱”，在弹窗里共享“这个标签页”和它的音频。', 'Video loaded. Put on headphones, press “Sing along” and share “This tab” with its audio.');
      $('alGo').disabled = false;
    } catch (err) {
      $('alStatus').textContent = L(`YouTube 载入失败：${err.message}`, `YouTube didn’t load: ${err.message}`);
    }
    this.draw(0);
  }

  async load(file) {
    const $ = this.$;
    if (this.eng) await this.stop();
    $('alGo').disabled = true; $('alRes').innerHTML = '';
    $('alStatus').textContent = L(`正在读取“${file.name}”…`, `Reading “${file.name}”…`);
    try {
      const tmp = new AudioContext();
      const { buf, x } = await decodeSong(file, tmp);
      tmp.close();
      let peak = 0;
      for (let i = 0; i < x.length; i += 31) peak = Math.max(peak, Math.abs(x[i]));
      if (peak < 1e-4) throw new Error(L('文件里没有声音', 'the file is silent'));
      $('alStatus').textContent = L('正在提取原唱的旋律…', 'Extracting the original’s melody…');
      const t = performance.now(), mel = await extractMelody(x, this.app.settings.a4).catch(() => { throw new Error(L('提取不出旋律', 'no melody could be extracted')); });
      if (mel.notes.length < 3) throw new Error(L('找不到明显的旋律（纯伴奏、打击乐或说话？）', 'no clear melody (backing only, percussion or speech?)'));
      this.song = { name: file.name, buf, mel, x, sr: 44100 };
      this.user = []; this.result = null;
      $('alStatus').textContent = L(`“${file.name}”：${fmtT(mel.secs)}，找到 ${mel.notes.length} 个旋律音（${((performance.now() - t) / 1000).toFixed(1)} 秒）。戴上耳机，点“开始跟唱”。`, `“${file.name}”: ${fmtT(mel.secs)}, ${mel.notes.length} melody notes found (${((performance.now() - t) / 1000).toFixed(1)} s). Put on headphones and press “Sing along”.`);
      $('alGo').disabled = false;
    } catch (err) {
      $('alStatus').textContent = L(`读不了这个文件：${err.message}`, `Can’t read this file: ${err.message}`);
    }
    this.draw(0);
  }

  async start() {
    const $ = this.$, S = this.app.settings;
    // a web player with nothing embedded: the music plays in another tab
    if (this.srcMode === 'yt' && !this.song?.embedded) this.song = { name: L('另一个标签页', 'another tab'), yt: true, embedded: false, mel: { frames: [], notes: [], secs: 0 } };
    if (!this.song) return;
    if (this.song.yt) return this.startYt();
    if (this.app.live?.engine.running) { alert(L('请先结束“唱一段看问题”页面的录音。', 'Please stop the recording on the “Sing & check” page first.')); return; }
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
    $('alGo').textContent = L('■ 停止', '■ Stop'); $('alGo').classList.add('recording');
    $('alStatus').textContent = L('正在跟唱…', 'Singing along…');
    this.showHeadsetTip(eng);
    let lagAt = 0;
    const tick = () => {
      if (this.eng !== eng) return;
      // the delay, lined up again every 2 s on the last 12 s sung
      const t = eng.now() - this.startMic;
      if (t - lagAt >= 2 && this.user.length > 100) {
        lagAt = t;
        const rec = this.user.filter((u) => u.t > t - 12), est = bestLag(this.song.mel.frames.filter((f) => f.t > t - 13 && f.t < t + 1), rec);
        if (est.share >= 0.3) this.lag = est.lag;
      }
      const now = t - this.lag;
      this.draw(now);
      if (!this.specAt || performance.now() - this.specAt > 100) { this.specAt = performance.now(); this.drawSpectra(now - 0.06); }
      $('alNow').innerHTML = this.nowHtml(this.refAt(now), this.last?.voiced ? this.last.f0 : 0);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // YouTube: the tab's sound comes in beside the microphone, on one clock
  async startYt() {
    const $ = this.$, S = this.app.settings;
    if (this.app.live?.engine.running) { alert(L('请先结束“唱一段看问题”页面的录音。', 'Please stop the recording on the “Sing & check” page first.')); return; }
    let tab;
    try { ({ stream: tab } = await captureTabAudio({ currentTab: this.song.embedded })); } catch (err) {
      $('alStatus').textContent = err.message === 'no-audio'
        ? L('没有拿到声音：在共享窗口里选正在放歌的标签页（这里的视频就选“这个标签页”），并打开“同时分享标签页音频”。', 'Didn’t get any sound: in the share dialog pick the tab playing the music (“This tab” for a video here) and turn on “Also share tab audio”.')
        : L('没有共享标签页的声音（取消了，或这个浏览器不支持；请用电脑版 Chrome / Edge）。', 'The tab’s sound wasn’t shared (cancelled, or not supported here; use desktop Chrome / Edge).');
      return;
    }
    const eng = new AudioEngine(), pt = new PitchTracker(S);
    let an = null;
    this.user = []; this.result = null; this.mic = null; this.reviewT = null; $('alRes').innerHTML = '';
    this.song.mel = { frames: [], notes: [], secs: 0 };
    this.startMic = null;
    eng.onFrame = (frame, t) => {
      if (!an || this.eng !== eng || this.startMic == null) return;
      const st = pt.update(an.analyze(frame, { gateDb: S.gateDb, pitchOnly: true }), t);
      this.last = st;
      this.keepMic(frame, t, eng.sampleRate);
      if (st.voiced) this.user.push({ t: t - this.startMic, midi: st.midi });
    };
    try { await eng.startMic({ deviceId: S.deviceId, record: false }); } catch (err) { tab.getTracks().forEach((t) => t.stop()); alert(L(`麦克风错误：${err.message}`, `Microphone error: ${err.message}`)); return; }
    an = new FrameAnalyzer(eng.sampleRate);
    this.eng = eng;
    const ctx = eng.ctx, src = ctx.createMediaStreamSource(tab), node = new AudioWorkletNode(ctx, 'vocal-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' }), sink = ctx.createGain();
    sink.gain.value = 0; src.connect(node); node.connect(sink).connect(ctx.destination);
    this.startMic = eng.now();
    // tab time 0 (its first sample) on the singer's clock: set by the first block
    const T = this.tab = { stream: tab, node, src, sr: ctx.sampleRate, chunks: [], offset: null };
    node.port.onmessage = (e) => { if (this.eng !== eng) return; if (T.offset == null) T.offset = eng.now() - e.data.length / T.sr - this.startMic; T.chunks.push(e.data); };
    tab.getAudioTracks()[0].onended = () => { if (this.eng === eng) this.stop(); };
    this.lag = (ctx.outputLatency || 0) + 0.03;
    try { this.player?.playVideo(); } catch { /* the singer can press play */ }
    this.melIv = setInterval(() => this.rollingMelody(), 2000);
    $('alGo').textContent = L('■ 停止', '■ Stop'); $('alGo').classList.add('recording');
    $('alStatus').textContent = L('正在跟唱…（原唱的音会晚 1–2 秒出现）', 'Singing along… (the original’s notes show 1–2 s late)');
    this.showHeadsetTip(eng);
    this.liveRange = null;
    const tick = () => {
      if (this.eng !== eng) return;
      const now = eng.now() - this.startMic - this.lag;
      this.draw(now);
      if (!this.specAt || performance.now() - this.specAt > 100) { this.specAt = performance.now(); this.drawSpectra(now - 0.06); }
      $('alNow').innerHTML = this.nowHtml(this.refAt(now), this.last?.voiced ? this.last.f0 : 0);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  // a Bluetooth headset's own microphone: say so where the headphone tip is
  showHeadsetTip(eng) {
    if (!eng.micIsHeadset) return;
    const el = this.root.querySelector('#alTip');
    el.classList.add('warn');
    el.textContent = L('🎧 正在用 AirPods 等蓝牙耳机自带的麦克风：可以跟唱，延迟会自动校准；但耳机会切到通话模式，听到的原唱音质变差。想听得更清楚，可到“设置”里把麦克风改成电脑自带的，耳机只用来听。', '🎧 Using the Bluetooth headset’s own microphone (AirPods and the like): fine for singing along, the delay is lined up automatically; but the headset switches to call mode and the original sounds worse. For better sound, pick the computer’s built-in microphone in Settings and use the headset only to listen.');
  }

  // the tab's sound so far → its melody, from the last 8 s (in the background)
  async rollingMelody() {
    const T = this.tab;
    if (!T || this.melBusy || T.offset == null || !T.chunks.length) return;
    const per = T.chunks[0].length, need = Math.ceil((8 * T.sr) / per), from = Math.max(0, T.chunks.length - need);
    const x = new Float32Array((T.chunks.length - from) * per);
    T.chunks.slice(from).forEach((c, i) => x.set(c, i * per));
    const a = (from * per) / T.sr, edge = from ? 0.5 : 0; // the window's start, minus a settling edge
    this.melBusy = true;
    try {
      const m = await extractMelody(await resampleTo44k(x, T.sr), this.app.settings.a4);
      if (this.tab !== T) return;
      const cut = a + edge + T.offset;
      const frames = this.song.mel.frames.filter((f) => f.t < cut).concat(m.frames.filter((f) => f.t >= edge).map((f) => ({ t: f.t + a + T.offset, midi: f.midi })));
      this.song.mel = { frames, notes: notesOf(frames), secs: frames.length ? frames[frames.length - 1].t : 0 };
    } catch { /* no melody in this stretch (silence, speech) */ } finally { this.melBusy = false; }
  }

  async stop() {
    const $ = this.$, eng = this.eng;
    if (!eng) return;
    this.eng = null;
    cancelAnimationFrame(this.raf);
    clearInterval(this.melIv);
    try { this.src?.stop?.(); } catch { /* ended */ }
    await eng.stop();
    $('alGo').textContent = L('● 再唱一遍', '● Sing again'); $('alGo').classList.remove('recording');
    $('alNow').innerHTML = this.nowHtml(null, null);
    if (this.song?.yt) await this.finishYt();
    this.finish();
  }

  // YouTube: the whole take's melody, once more, now that all of it is known
  async finishYt() {
    const $ = this.$, T = this.tab;
    try { this.player?.pauseVideo(); } catch { /* gone */ }
    if (!T) return;
    this.tab = null;
    T.stream.getTracks().forEach((t) => t.stop());
    try { T.src.disconnect(); T.node.disconnect(); } catch { /* ignore */ }
    if (!T.chunks.length || T.offset == null) return;
    $('alStatus').textContent = L('正在分析整段原唱…', 'Analysing the whole of the original…');
    const per = T.chunks[0].length, x = new Float32Array(T.chunks.length * per);
    T.chunks.forEach((c, i) => x.set(c, i * per));
    T.chunks = [];
    this.song.tabAudio = { x, sr: T.sr, offset: T.offset }; // in memory only, for the spectra; never stored
    try {
      const m = await extractMelody(await resampleTo44k(x, T.sr), this.app.settings.a4);
      const frames = m.frames.map((f) => ({ t: f.t + T.offset, midi: f.midi }));
      this.song.mel = { frames, notes: notesOf(frames), secs: x.length / T.sr };
    } catch { /* keep the rolling result */ }
  }

  // the delay lined up, every note compared, the whole song drawn
  finish() {
    const $ = this.$, mel = this.song.mel;
    if (!mel.notes.length) { $('alStatus').textContent = L('没有找到原唱的旋律：视频的声音没有共享到，或者视频里没有人声旋律。', 'No melody of the original found: the video’s sound wasn’t shared, or it has no vocal melody.'); this.draw(null); return; }
    if (this.user.length < 20) { $('alStatus').textContent = L('没听到你唱：检查麦克风，戴耳机再试。', 'Didn’t hear you sing: check the microphone and try again on headphones.'); this.draw(null); return; }
    const L_ = bestLag(mel.frames, this.user);
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

  // the spectra of the original and the singer at song time t
  drawSpectra(t) {
    const cv = this.root.querySelector('#alSpec');
    if (!cv || !this.song || !Number.isFinite(t)) return;
    const N = 4096, song = this.song;
    // the original: the song file, or the shared tab's sound (kept, or still coming in)
    let rx = null, rsr = 44100;
    if (song.x) { rx = song.x.subarray(Math.max(0, Math.round(t * song.sr - N / 2)), Math.round(t * song.sr + N / 2)); rsr = song.sr; }
    else if (song.tabAudio) { const A = song.tabAudio, c = (t - A.offset) * A.sr; rsr = A.sr; rx = A.x.subarray(Math.max(0, Math.round(c - N / 2)), Math.round(c + N / 2)); }
    else if (this.tab?.offset != null) { rsr = this.tab.sr; rx = AlongView.windowOf(this.tab.chunks, (t - this.tab.offset) * rsr, N); }
    // the singer: the microphone at the matching moment (the delay lined up)
    let ux = null;
    const M = this.mic;
    if (M) ux = AlongView.windowOf(M.chunks, (t + this.lag + this.startMic - M.t0) * M.sr, N);
    const near = (fr, tt, dt) => { let b = null; for (const f of fr) { if (Math.abs(f.t - tt) <= dt && (!b || Math.abs(f.t - tt) < Math.abs(b.t - tt))) b = f; } return b; };
    const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
    const rf = near(song.mel.frames.filter((f) => Math.abs(f.t - t) < 0.05), t, 0.03), uf = near(this.user.filter((u) => Math.abs(u.t - this.lag - t) < 0.08).map((u) => ({ t: u.t - this.lag, midi: u.midi })), t, 0.05);
    const rF0 = rf ? hz(rf.midi) : 0, uF0 = uf ? hz(uf.midi) : 0;
    const rel = pitchRelation(rF0, uF0);
    // the singer's F1/F2 by LPC; the original's from its melody's harmonics (the band is mixed in)
    const refS = rx && rx.length === N ? voiceSide(rx, rsr, N / 2, rF0, { N, mixed: true }) : null, user = ux ? voiceSide(ux, M.sr, N / 2, uF0, { N }) : null;
    this.cards?.update({ ref: refS?.f0 ? refS : null, user: user?.f0 ? user : null });
    drawSpectraPair(cv, { ref: refS, user, say: this.relationText(rel, rF0, uF0, t), say2: this.ringText(refS, user) });
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
    // YouTube: the notes arrive while singing — the range only ever widens
    if (this.song?.yt && this.eng) { const r = this.liveRange || [P.low - 3, P.high + 3]; range = this.liveRange = [Math.min(r[0], range[0]), Math.max(r[1], range[1])]; }
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
