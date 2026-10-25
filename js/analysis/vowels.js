// Reference vowels and vowel identity from F1 / F2.
// Averages of Peterson & Barney (1952), 33 men and 28 women, American English
// (F1–F3; F4 and F5 have no standard averages and aren't invented here).
// Chinese vowels differ somewhat; the closest ones are named.

import { L } from '../i18n.js';

export const REF_VOWELS = [
  { ipa: 'i', zh: '衣', en: 'ee (see)', m: [270, 2290, 3010], f: [310, 2790, 3310] },
  { ipa: 'ɛ', zh: '诶', en: 'eh (bed)', m: [530, 1840, 2480], f: [610, 2330, 2990] },
  { ipa: 'æ', zh: '哎', en: 'a (cat)', m: [660, 1720, 2410], f: [860, 2050, 2850] },
  { ipa: 'ɑ', zh: '啊', en: 'ah (father)', m: [730, 1090, 2440], f: [850, 1220, 2810] },
  { ipa: 'ɔ', zh: '哦', en: 'aw (law)', m: [570, 840, 2410], f: [590, 920, 2710] },
  { ipa: 'u', zh: '乌', en: 'oo (boot)', m: [300, 870, 2240], f: [370, 950, 2670] },
];
export const vowelName = (v) => (v ? L(`${v.zh}（${v.ipa}）`, `${v.en.split(' ')[0]} (${v.ipa})`) : '—');

// the closest reference vowel (log-distance in the F1–F2 plane)
export function vowelOf(F1, F2, sex = 'm') {
  if (!(F1 > 0 && F2 > 0)) return null;
  let best = null, bd = Infinity;
  for (const v of REF_VOWELS) {
    const r = v[sex === 'f' ? 'f' : 'm'], d = Math.hypot(Math.log(F1 / r[0]), Math.log(F2 / r[1]));
    if (d < bd) { bd = d; best = v; }
  }
  return best;
}

// Same vowel? a, b: [F1, F2, …]. Twang raises F1 and F2 by ≈ 15–20 %
// (Sundberg & Thalén 2010), so that much is allowed; changing the vowel moves
// them more (啊 → 诶: F2 +70 %). null when either is unknown.
export function sameVowel(a, b) {
  if (!(a?.[0] > 0 && a?.[1] > 0 && b?.[0] > 0 && b?.[1] > 0)) return null;
  const r1 = b[0] / a[0], r2 = b[1] / a[1];
  return r1 >= 0.8 && r1 <= 1.4 && r2 >= 0.74 && r2 <= 1.35;
}

// how far formants can be trusted at this pitch (measured on synthetic vowels:
// ≤ 300 Hz F1–F4 within ≈ 5 %; 300–450 Hz rough; above that unusable)
export const formantTrust = (f0) => (!(f0 > 0) ? 'none' : f0 <= 300 ? 'good' : f0 <= 450 ? 'rough' : 'none');

// F1–F5 from several frames' formant lists ([F1, F2, …] each): per-formant
// medians, each from at least a fifth of the frames (F5 is missed in many).
// F4 and F5 only when steady (median deviation ≤ 2.5 %): where the highs are weak
// (e.g. "oo") LPC puts a stray pole up there that wanders by hundreds of Hz from
// frame to frame, while a real one on a held vowel stays within ≈ 1 %.
export function fmMedians(list) {
  if (!list?.length) return null;
  const F = [0, 1, 2, 3, 4].map((k) => {
    const v = list.map((f) => f?.[k]).filter(Number.isFinite).sort((a, b) => a - b);
    if (!v.length || v.length * 5 < list.length) return NaN;
    const m = v[v.length >> 1];
    if (k >= 3 && [...v].map((x) => Math.abs(x - m)).sort((a, b) => a - b)[v.length >> 1] > 0.025 * m) return NaN;
    return m;
  });
  return F[0] > 0 && F[1] > 0 ? F : null;
}

// F1–F5 now: over the last `secs` of voiced frames whose pitch allows formants
// (frames carry f0 and fm). null when there are too few.
export function recentFm(frames, secs = 0.6) {
  if (!frames?.length) return null;
  const tEnd = frames[frames.length - 1].t, use = [];
  for (let i = frames.length - 1; i >= 0 && frames[i].t >= tEnd - secs; i--) {
    const f = frames[i];
    if (f.voiced && f.fm?.length >= 2 && formantTrust(f.f0) !== 'none') use.push(f);
  }
  const F = use.length >= 4 ? fmMedians(use.map((f) => f.fm)) : null;
  return F && { F, trust: use.every((f) => formantTrust(f.f0) === 'good') ? 'good' : 'rough' };
}
