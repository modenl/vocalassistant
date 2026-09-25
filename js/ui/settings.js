// Settings: language, voice type, reference pitch, microphone, sensitivity, data.

import { VOICE_TYPES, midiName } from '../config.js';
import { AudioEngine } from '../audio/engine.js';
import { listSessions, clearAll } from '../store/db.js';
import { L, detectLang } from '../i18n.js';

export async function renderSettings(root, app) {
  const s = app.settings;
  const devices = await AudioEngine.listInputs();
  const auto = detectLang('auto') === 'zh' ? '中文' : 'English';
  root.innerHTML = `
    <div class="panel" style="max-width:720px">
      <div class="ph"><h3>${L('设置', 'Settings')}</h3></div>
      <div class="form">
        <label>${L('语言 / Language', 'Language / 语言')}</label>
        <select id="sLang">
          <option value="auto" ${s.lang === 'auto' ? 'selected' : ''}>${L('跟随系统和浏览器', 'Follow system & browser')}（${auto}）</option>
          <option value="zh" ${s.lang === 'zh' ? 'selected' : ''}>中文</option>
          <option value="en" ${s.lang === 'en' ? 'selected' : ''}>English</option>
        </select>
        <div class="help">${L('默认跟随系统和浏览器的首选语言；选好后页面会刷新。', 'By default the app follows your system and browser language preference; changing it reloads the page.')}</div>
        <label>${L('声部', 'Voice type')}</label>
        <select id="sVoice">${Object.entries(VOICE_TYPES).map(([k, v]) => `<option value="${k}" ${k === s.voiceType ? 'selected' : ''}>${v.name}${L('（', ' (')}${midiName(v.low)}–${midiName(v.high)}${L('）', ')')}</option>`).join('')}</select>
        <div class="help">${L('只用来把课程的练习音放在你舒服的音区。拿不准就选相近的，唱着不舒服再换。', 'Only used to put lesson notes in a comfortable range. If unsure, pick the closest one and change it if the notes feel uncomfortable.')}</div>
        <label>${L('标准音 A4', 'Reference A4')}</label>
        <input type="number" id="sA4" min="415" max="466" step="1" value="${s.a4}" />
        <div class="help">${L('判断音准的参考（一般是 440 Hz；跟钢琴或伴奏对齐时再改）。', 'The reference for pitch (usually 440 Hz; change it only to match a piano or backing track).')}</div>
        <label>${L('麦克风', 'Microphone')}</label>
        <select id="sDev"><option value="">${L('系统默认', 'System default')}</option>${devices.map((d) => `<option value="${d.deviceId}" ${d.deviceId === s.deviceId ? 'selected' : ''}>${d.label || L('麦克风', 'Microphone')}</option>`).join('')}</select>
        <div class="help">${L('建议关闭耳机 / 系统的降噪，离麦克风 20–30 cm。', 'Turn off headset / system noise suppression and stay 20–30 cm from the microphone.')}</div>
        <label>${L('噪声门限', 'Noise gate')} ${s.gateDb} dBFS</label>
        <input type="range" id="sGate" min="-70" max="-30" step="1" value="${s.gateDb}" />
        <div class="help">${L('比这个更小的声音当作安静。环境吵就调高。', 'Anything quieter counts as silence. Raise it in a noisy room.')}</div>
        <label>${L('保存录音', 'Save recordings')}</label>
        <label><input type="checkbox" id="sSave" ${s.saveAudio ? 'checked' : ''}> ${L('唱完后把录音一起存到本机历史记录（方便回放）', 'Keep the audio with each take in History on this device (for playback)')}</label>
      </div>
    </div>
    <div class="panel" style="max-width:720px;margin-top:12px">
      <div class="ph"><h3>${L('数据', 'Data')}</h3><span class="sub">${L('所有数据只保存在这个浏览器里（IndexedDB），不会上传', 'Everything stays in this browser (IndexedDB); nothing is uploaded')}</span></div>
      <div class="cal-actions"><button class="btn" id="dExport">${L('导出全部记录 (JSON)', 'Export all takes (JSON)')}</button><button class="btn danger" id="dClear">${L('清空所有历史记录', 'Delete all history')}</button></div>
    </div>`;
  const $ = (id) => root.querySelector('#' + id);
  $('sLang').onchange = (e) => app.updateSettings({ lang: e.target.value });
  $('sVoice').onchange = (e) => app.updateSettings({ voiceType: e.target.value });
  $('sA4').onchange = (e) => app.updateSettings({ a4: Math.max(415, Math.min(466, +e.target.value || 440)) });
  $('sDev').onchange = (e) => app.updateSettings({ deviceId: e.target.value });
  $('sGate').oninput = (e) => { app.updateSettings({ gateDb: +e.target.value }); e.target.previousElementSibling.textContent = `${L('噪声门限', 'Noise gate')} ${e.target.value} dBFS`; };
  $('sSave').onchange = (e) => app.updateSettings({ saveAudio: e.target.checked });
  $('dExport').onclick = async () => {
    const all = (await listSessions()).filter((r) => r.version === 2).map((r) => ({ ...r, frames: undefined }));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(all, null, 1)], { type: 'application/json' }));
    a.download = `vocallab-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  };
  $('dClear').onclick = async () => {
    if (!confirm(L('清空所有历史记录和录音？此操作不能撤销。', 'Delete all takes and recordings? This can’t be undone.'))) return;
    await clearAll();
    alert(L('已清空。', 'Deleted.'));
  };
}
