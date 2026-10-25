// What the sound says about the vocal tract — an estimate, not an image.
// From each analysed frame (FrameAnalyzer, full mode) a smoothed state:
//   tongue height / frontness from F1 / F2 (standard vowel acoustics: a high
//     tongue lowers F1, a front tongue raises F2), scaled for female voices;
//   pharynx narrowing (twang) from the singer's formant, 2–4 kHz (SPR);
//   larynx height from the vocal-tract length the formants imply, only against
//     the singer's own reference on the same vowel (the estimate moves with the
//     vowel too; a raised larynx shortens the tract);
//   soft palate from the nasality measure A1−P0 (Chen 1997);
//   glottal closure from the open quotient (H1−H2), steadiness from jitter.
// Formants are only trustworthy below ≈ 350 Hz; above that the tongue, larynx
// and palate are shown as unknown. Every value may be NaN (unknown).
// Problems are named only when the evidence is clear, each tied to the part
// of the diagram it concerns.

import { L } from '../i18n.js';
import { formantTrust, fmMedians } from './vowels.js';

const clamp01 = (x) => Math.max(0, Math.min(1, x));
const TAU = 0.25; // s: smoothing

// The tract's shape from one moment's numbers, as the schematic draws it: the
// tongue from F1/F2 (k: 1.17 for a woman, whose formants run ≈ 17 % higher), the
// pharynx narrowing from the ring (absolute: no reference). Unknown = NaN.
export function tractOf({ F1, F2, ring, k = 1 }) {
  const fm = F1 > 0 && F2 > 0;
  return {
    tongueHigh: fm ? clamp01((850 - F1 / k) / (850 - 280)) : NaN,
    tongueFront: fm ? clamp01((F2 / k - 850) / (2300 - 850)) : NaN,
    pharynx: Number.isFinite(ring) ? clamp01((28 - ring) / 16) : NaN,
    larynx: NaN, velum: NaN, problems: [],
  };
}

export class VoiceState {
  constructor({ sex = 'm' } = {}) {
    this.k = sex === 'f' ? 1.17 : 1; // female formants ≈ 17 % higher
    this.s = {};      // smoothed raw measures
    this.lastT = -1;
    this.lastVoiced = -9;
    this.base = null; // the singer's reference: { spr, vtl }
    this.vtlHist = [];
    this.gBuf = [];   // recent F1–F5 lists for the formant views: { t, F }
  }

  setBase(base) { this.base = base; }
  // use what is showing now as the reference ("this is my normal voice")
  baseFromNow(a4 = 440) { this.base = { spr: this.s.spr, vdb: this.s.vdb, hnr: this.s.hnr, midi: this.s.f0 > 0 ? 69 + 12 * Math.log2(this.s.f0 / a4) : NaN, vtl: this.s.vtl, F1: this.s.F1, F2: this.s.F2, fm: this.fmNow() }; return this.base; }
  // F1–F5 now (for display): medians over the last 0.6 s, or null
  fmNow() { return this.gBuf.length >= 3 ? fmMedians(this.gBuf.map((b) => b.F)) : null; }

  ema(key, v, dt) {
    if (!Number.isFinite(v)) return;
    const a = 1 - Math.exp(-dt / TAU), o = this.s[key];
    this.s[key] = Number.isFinite(o) ? o + a * (v - o) : v;
  }

  push(f, t) {
    const dt = this.lastT < 0 ? 0.02 : Math.min(0.2, t - this.lastT);
    this.lastT = t;
    while (this.gBuf.length && t - this.gBuf[0].t > 0.6) this.gBuf.shift();
    const voiced = f.voiced && !f.irregular && f.f0 > 0;
    if (!voiced) {
      // after half a second of silence the picture fades to "not singing"
      if (t - this.lastVoiced > 0.5) this.s = { vtl: this.s.vtl };
      return this.state(t);
    }
    this.lastVoiced = t;
    this.ema('f0', f.f0, dt);
    this.ema('spr', f.spr, dt);
    this.ema('vdb', f.vdb, dt);
    this.ema('oq', f.oq, dt);
    this.ema('jitter', f.jitter, dt);
    this.ema('hnr', f.hnrLite, dt);
    this.ema('hbr', f.hbr, dt);
    this.ema('h1h2', f.h1h2c, dt);
    this.ema('cpp', f.cpp, dt);
    const fm = f.formants || [];
    if (f.formantReliable && fm.length >= 2) {
      this.ema('F1', fm[0].f, dt);
      this.ema('F2', fm[1].f, dt);
      if (fm[2]) this.ema('F3', fm[2].f, dt);
      if (f.vtl) {
        this.ema('vtl', f.vtl, dt);
        this.vtlHist.push(f.vtl);
        if (this.vtlHist.length > 400) this.vtlHist.shift();
      }
      this.s.fmT = t;
    }
    // F1–F5 for the formant views: also where only a rough estimate is possible
    const trust = formantTrust(f.f0);
    if (trust !== 'none' && fm.length >= 2) {
      this.gBuf.push({ t, F: fm.slice(0, 5).map((q) => q.f) });
      this.s.gT = t; this.s.gTrust = trust;
    }
    if (Number.isFinite(f.nasal)) {
      this.ema('nasal', f.nasal, dt); this.s.nasT = t;
      (this.nasTimes ||= []).push(t);
    }
    if (this.nasTimes) while (this.nasTimes.length && t - this.nasTimes[0] > 1) this.nasTimes.shift();
    return this.state(t);
  }

  state(t) {
    const s = this.s, singing = t - this.lastVoiced <= 0.5 && Number.isFinite(s.f0);
    const fresh = (tt) => Number.isFinite(tt) && t - tt < 1.0;
    // nasality (A1−P0) is only measurable at low pitch on open vowels, and noisy:
    // shown when ≥ 10 frames of the last second had it
    const fmOk = singing && fresh(s.fmT), nasOk = singing && fresh(s.nasT) && (this.nasTimes?.length ?? 0) >= 10;
    // reference tract length: set by the user, else the median so far
    const B = this.base, sameVowel = B && Math.abs(s.F1 - B.F1) <= 0.15 * B.F1 && Math.abs(s.F2 - B.F2) <= 0.15 * B.F2;
    const vtlRef = sameVowel ? B.vtl : NaN;
    const sprRef = this.base?.spr;
    const st = {
      singing, f0: s.f0, hasBase: !!B,
      tongueHigh: fmOk ? tractOf({ F1: s.F1, F2: s.F2, k: this.k }).tongueHigh : NaN,
      tongueFront: fmOk ? tractOf({ F1: s.F1, F2: s.F2, k: this.k }).tongueFront : NaN,
      // pharynx narrowing: against the reference if there is one, else absolute
      pharynx: singing && Number.isFinite(s.spr) ? (Number.isFinite(sprRef) ? clamp01((sprRef - s.spr) / 12) : tractOf({ ring: s.spr }).pharynx) : NaN,
      larynx: fmOk && Number.isFinite(vtlRef) && Number.isFinite(s.vtl) ? (vtlRef - s.vtl) / vtlRef : NaN, // + = raised
      velum: nasOk ? clamp01((s.nasal + 2) / 12) : NaN, // 1 = raised (oral), 0 = lowered (nasal: A1−P0 ≤ −2 dB)
      closure: singing && Number.isFinite(s.oq) ? clamp01((0.9 - s.oq) / 0.55) : NaN, // 1 = pressed, 0 = breathy
      fm: fresh(s.gT) && singing ? this.fmNow() : null, fmTrust: fresh(s.gT) && singing ? s.gTrust : 'none',
      spr: s.spr, hbr: s.hbr, h1h2: s.h1h2, cpp: s.cpp, vdb: s.vdb, F1: s.F1, F2: s.F2, F3: s.F3, vtl: s.vtl, vtlRef, oq: s.oq, jitter: s.jitter, nasal: s.nasal, hnr: s.hnr, sprRef,
    };
    // a problem shows once it has lasted (0.8 s; 1 s for jitter): no flicker
    const now = singing ? problemsOf(st, this.k) : [], since = (this.since ||= {});
    for (const k of Object.keys(since)) if (!now.some((p) => p.key === k)) delete since[k];
    for (const p of now) since[p.key] ??= t;
    st.problems = now.filter((p) => t - since[p.key] >= (p.key === 'unsteady' ? 1 : 0.8));
    return st;
  }
}

// part: which part of the diagram the problem points to
export function problemsOf(st, k = 1) {
  const P = [];
  // "oo" / "oh" (low F1 and F2) are dull by nature: not called out on them
  const rounded = st.F1 / k < 500 && st.F2 / k < 1100;
  if (st.spr > 26 && !rounded) P.push({ key: 'dull', part: 'pharynx', level: st.spr > 32 ? 'poor' : 'ok',
    text: L(`声音闷、传不远：决定穿透力的 2–4 kHz 这段太弱（比低频弱 ${Math.round(st.spr)} dB，好的歌声约 10–20）`, `Dull, no “ring”: 2–4 kHz is ${Math.round(st.spr)} dB below the lows (good singing ≈ 10–20)`),
    fix: L('想着声音往前、往鼻梁前面送；练「咽音」课，找又尖又亮的感觉。', 'Send the sound forward, in front of the bridge of the nose; the “Twang” lesson helps find a bright, focused sound.') });
  if (st.oq >= 0.8) P.push({ key: 'breathy', part: 'glottis', level: st.oq >= 0.88 ? 'poor' : 'ok',
    text: L('气声多：声带没有闭好，一部分气直接漏出去', 'Breathy: the vocal folds don’t close fully and air leaks through'),
    fix: L('先哼“嗯”，找声音集中、不漏气的感觉，再打开成“啊”。', 'Hum “mm” until the sound is focused with no air leaking, then open into “ah”.') });
  if (st.oq <= 0.33 && st.jitter > 2.5) P.push({ key: 'pressed', part: 'glottis', level: 'poor',
    text: L('喉咙挤得太紧：声门闭得过紧，声音发紧、发粗', 'Pressed: the vocal folds are squeezed shut too hard; the tone is tight and rough'),
    fix: L('音量放小，像叹气一样放松地发声，别憋气。', 'Get softer and phonate loosely, like a sigh; don’t hold your breath.') });
  if (st.larynx >= 0.08) P.push({ key: 'larynxHigh', part: 'larynx', level: st.larynx >= 0.12 ? 'poor' : 'ok',
    text: L(`喉位上提了：声道比你的基准短了 ${Math.round(st.larynx * 100)}%`, `Larynx rising: the vocal tract is ${Math.round(st.larynx * 100)}% shorter than your reference`),
    fix: L('往高唱时别跟着“够”，下巴和喉咙放松，想着打哈欠开头时喉咙打开的感觉。', 'Don’t reach up with the throat on high notes; relax the jaw and throat, as at the start of a yawn.') });
  if (st.velum <= 0.1) P.push({ key: 'nasal', part: 'velum', level: 'ok',
    text: L('鼻音偏重：软腭没有抬起来，声音走了鼻腔', 'Nasal: the soft palate is down and sound goes through the nose'),
    fix: L('捏住鼻子唱一下：如果声音变了，就是走了鼻腔。抬起软腭（打哈欠开头的感觉）。', 'Pinch your nose while singing: if the sound changes, it’s going through the nose. Lift the soft palate (the start of a yawn).') });
  // jitter in %; per-frame estimates in singing run ≈ 0.5–1.6 %, so only a
  // clearly raised smoothed value counts
  if (st.jitter > 3) P.push({ key: 'unsteady', part: 'glottis', level: st.jitter > 4 ? 'poor' : 'ok',
    text: L(`声带振动不稳：周期抖动 ${st.jitter.toFixed(1)}%（平稳的歌声约 0.5–1.5%）`, `Irregular vibration: cycle-to-cycle jitter ${st.jitter.toFixed(1)}% (steady singing ≈ 0.5–1.5%)`),
    fix: L('气息要匀，别压着唱；持续嘶哑请看医生。', 'Keep the airflow even and don’t press; see a doctor if hoarseness persists.') });
  return P;
}
