// Voice types (only used to place lesson notes in a comfortable range) and settings.

import { L } from './i18n.js';

// low/high: typical singing range (MIDI); mid: a comfortable middle note.
export const VOICE_TYPES = {
  bass:     { name: L('男低音', 'Bass'), sex: 'm', low: 40, high: 64, mid: 50 },
  baritone: { name: L('男中音', 'Baritone'), sex: 'm', low: 45, high: 69, mid: 53 },
  tenor:    { name: L('男高音', 'Tenor'), sex: 'm', low: 48, high: 72, mid: 56 },
  alto:     { name: L('女低音', 'Alto'), sex: 'f', low: 53, high: 77, mid: 60 },
  mezzo:    { name: L('女中音', 'Mezzo-soprano'), sex: 'f', low: 57, high: 81, mid: 62 },
  soprano:  { name: L('女高音', 'Soprano'), sex: 'f', low: 60, high: 86, mid: 64 },
};

export const DEFAULT_SETTINGS = {
  voiceType: 'baritone',
  a4: 440,
  gateDb: -52,
  voicingClarity: 0.65,
  saveAudio: true,
  deviceId: '',
  lang: 'auto', // 'auto' (system / browser language), 'zh' or 'en'
  refTimbre: 'voice', // reference notes: 'voice' (sung "ah") or 'piano'
};

const SETTINGS_KEY = 'vocalassistant.settings.v1';
export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const out = { ...DEFAULT_SETTINGS };
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in s) out[k] = s[k];
      if (!VOICE_TYPES[out.voiceType]) out.voiceType = DEFAULT_SETTINGS.voiceType;
      return out;
    }
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_SETTINGS };
}
export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export function midiName(m) {
  const n = Math.round(m);
  return NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
}
export const hzToMidi = (f, a4 = 440) => 69 + 12 * Math.log2(f / a4);
export const midiToHz = (m, a4 = 440) => a4 * Math.pow(2, (m - 69) / 12);
export const isBlack = (m) => [1, 3, 6, 8, 10].includes(((Math.round(m) % 12) + 12) % 12);
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const clamp01 = (v) => clamp(v, 0, 1);
export const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
