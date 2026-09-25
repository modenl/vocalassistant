// App shell: tabs, settings, cross-view wiring.

import { VOICE_TYPES, loadSettings, saveSettings, midiName } from './config.js';
import { L, getLang, detectLang } from './i18n.js';
import { LiveView } from './ui/live.js';
import { HistoryView } from './ui/history.js';
import { LessonsView } from './ui/lessons.js';
import { GymView } from './ui/gym.js';
import { renderSettings } from './ui/settings.js';

const app = {
  settings: loadSettings(),
  tab: 'live',

  updateSettings(patch) {
    Object.assign(this.settings, patch);
    saveSettings(this.settings);
    // the language is fixed at load time: switching reloads the page
    if ('lang' in patch) { location.reload(); return; }
    if ('voiceType' in patch) {
      document.getElementById('voiceType').value = this.settings.voiceType;
      if (!this.live.engine.running) this.live.drawIdle();
      if (this.tab === 'lessons') this.lessons.lesson ? this.lessons.renderLesson() : this.lessons.show();
      if (this.tab === 'gym') this.gym.show();
    }
  },

  // Leaving a page stops whatever it is playing or recording.
  async showTab(name, arg) {
    if (name !== 'live' && this.live.engine.running) await this.live.stop({ report: false });
    if (name !== 'history') this.history.stop();
    this.tab = name;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${name}`));
    if (name !== 'lessons') this.lessons.stopRunner();
    if (name !== 'gym') await this.gym.stop();
    if (name === 'lessons') this.lessons.show(arg);
    if (name === 'gym') this.gym.show();
    if (name === 'history') await this.history.show(arg);
    if (name === 'settings') await renderSettings(document.getElementById('tab-settings'), this);
    if (name === 'live' && !this.live.engine.running) this.live.drawIdle();
    window.scrollTo({ top: 0 });
  },
};

// static page text: English lives in data-en / data-en-title attributes
function translateStatic() {
  if (getLang() !== 'en') return;
  document.title = 'VocalLab — singing practice';
  document.querySelectorAll('[data-en]').forEach((el) => { el.innerHTML = el.dataset.en; });
  document.querySelectorAll('[data-en-title]').forEach((el) => { el.title = el.dataset.enTitle; });
  document.querySelectorAll('[data-hide-en]').forEach((el) => { el.hidden = true; });
}

function init() {
  translateStatic();
  // following the system / browser language: follow it when it changes, too
  window.addEventListener('languagechange', () => { if (app.settings.lang === 'auto') location.reload(); });
  const sel = document.getElementById('voiceType');
  sel.innerHTML = Object.entries(VOICE_TYPES).map(([k, v]) => `<option value="${k}">${v.name}${L('（', ' (')}${midiName(v.low)}–${midiName(v.high)}${L('）', ')')}</option>`).join('');
  sel.value = app.settings.voiceType;
  sel.onchange = () => app.updateSettings({ voiceType: sel.value });
  // language switch in the header (same setting as in Settings)
  const ls = document.getElementById('langSel');
  const auto = detectLang('auto') === 'zh' ? '中文' : 'English';
  ls.innerHTML = [['auto', `🌐 ${L('自动', 'Auto')}（${auto}）`], ['zh', '🌐 中文'], ['en', '🌐 English']]
    .map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
  ls.value = app.settings.lang || 'auto';
  ls.onchange = () => app.updateSettings({ lang: ls.value });
  app.live = new LiveView(app);
  app.history = new HistoryView(app, document.getElementById('tab-history'));
  app.lessons = new LessonsView(app, document.getElementById('tab-lessons'));
  app.gym = new GymView(app, document.getElementById('tab-gym'));
  app.live.init();
  document.getElementById('tabs').onclick = (e) => {
    const b = e.target.closest('button');
    if (b) app.showTab(b.dataset.tab);
  };
  if (!window.isSecureContext) {
    document.getElementById('status').textContent = L('⚠ 麦克风需要 https 或 localhost 环境。', '⚠ The microphone needs https or localhost.');
  }
  window.vocalApp = app; // handy for debugging in the console
}

init();
