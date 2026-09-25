// Chinese / English. The language follows the system and browser language
// (navigator.languages, in the user's order of preference) unless one is picked
// in Settings; it's fixed at load time (switching reloads the page), so module
// constants can use it too. Strings sit side by side where they're used:
// L('中文', 'English').

const SETTINGS_KEY = 'vocalassistant.settings.v1';

// 'auto' → the first of the preferred languages that is Chinese or English;
// neither listed → English.
export function detectLang(pref = 'auto', langs = globalThis.navigator?.languages?.length ? globalThis.navigator.languages : [globalThis.navigator?.language || '']) {
  if (pref === 'zh' || pref === 'en') return pref;
  for (const l of langs) {
    const p = String(l).toLowerCase();
    if (p.startsWith('zh')) return 'zh';
    if (p.startsWith('en')) return 'en';
  }
  return 'en';
}

function initial() {
  if (globalThis.VOCAL_LANG) return globalThis.VOCAL_LANG; // tests
  if (!globalThis.window) return 'zh'; // Node tools and tests (Node has a navigator too)
  let pref = 'auto';
  try { pref = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}').lang || 'auto'; } catch { /* storage unavailable */ }
  return detectLang(pref);
}

let lang = initial();
if (globalThis.document) document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';

export const getLang = () => lang;
export const L = (zh, en) => (lang === 'en' ? en : zh);
// locale for dates and numbers
export const locale = () => (lang === 'en' ? 'en-US' : 'zh-CN');
