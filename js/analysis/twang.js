// Acoustic cues of twang, against the singer's own plain voice on the same vowel
// AT THE SAME PITCH. Plain and twang are hard to sing on exactly one note, and a
// plain voice's share of highs changes with pitch by itself (≈ 7–10 dB over an
// octave), so the reference is a curve: the plain voice gliding through a range,
// averaged over ±1 semitone at every half semitone. Twang may then be sung on
// any note inside that range and is compared with the curve there.
//   ring  = how much the 2–4 kHz harmonics rose RELATIVE to 0–2 kHz (dB): the
//           drop of the harmonic band ratio (analyzer `hbr`); loudness cancels;
//   loud  = how much the voice itself got louder (dB, harmonics only);
//   rough = how much the harmonics lost ground to the noise between them (dB).
// On synthetic voices C#3–B3 a plain voice reads −2…+2 dB against its own glide,
// twang +9…+20. Twang raises the ring through the vocal tract (Sundberg & Thalén
// 2010, one singer); getting louder brightens a voice too (shown for speech:
// Sundberg & Nordenberg 2006). So the ring must rise ≥ 6 dB AND by at least
// 0.8 dB per dB of loudness gained. 6, 0.8, 5 and 6 are this app's settings,
// checked on synthetic voices only — not thresholds from the literature.

import { sameVowel } from './vowels.js';

export const RING_MIN = 6;
export const PER_DB = 0.8;
export const SHOUT_LOUD = 5;
export const ROUGH_MAX = 6;
export const GLIDE_SPAN = 7;   // semitones the plain glide must cover (a fifth)

// Difficulty. The microphone can't measure how tightly the aryepiglottic
// sphincter closes; what it hears is the result — a tighter epilarynx tube
// strengthens the 2–4 kHz band more (Sundberg 1974). So a harder level asks for
// more ring over the plain voice, less of it from loudness, a cleaner tone and
// a longer hold. All app settings, not values from the literature.
export const LEVELS = {
  easy: { id: 'easy', ring: 6, perDb: 0.8, rough: 6, cpp: 4, hold: 2, scaleRing: 4 },
  std: { id: 'std', ring: 9, perDb: 1.0, rough: 5, cpp: 3, hold: 3, scaleRing: 6 },
  strict: { id: 'strict', ring: 12, perDb: 1.2, rough: 4, cpp: 2, hold: 4, scaleRing: 9 },
};
export const levelOf = (id) => LEVELS[id] || LEVELS.easy;

// 'twang' | 'shout' | 'plain' (ring and loudness only)
export function twangZone(ring, loud, ringMin = RING_MIN, perDb = PER_DB) {
  if (!Number.isFinite(ring)) return 'plain';
  const l = Number.isFinite(loud) ? loud : 0;
  if (l >= SHOUT_LOUD && ring < perDb * l) return 'shout';
  if (ring >= ringMin && ring >= perDb * l) return 'twang';
  return 'plain';
}

const MEASURES = ['midi', 'hbr', 'vdb', 'hnr'];
// the vocal folds' closure, when measured: H1*−H2* (formant-corrected; higher =
// more open, Hanson 1997) and cepstral peak prominence (CPP; lower = more noise
// in the voice, Hillenbrand 1994)
const GLOTTAL = ['h1h2', 'cpp'];
export const hasMeasures = (o) => !!o && MEASURES.every((k) => Number.isFinite(o[k]));

// The plain-voice curve from a glide. frames: [{ midi, hbr, vdb, hnr }] (voiced).
// → { lo, hi, hnr, pts: [{ midi, hbr, vdb, hnr }] } over the longest stretch of
// half semitones with ≥ 4 frames within ±1 semitone, or null. Harmonic clarity
// (hnr) jumps with pitch by itself (±5 dB as harmonics meet the formants), so
// the glide's median is the reference for it, not the value at the pitch.
export function buildCurve(frames, { minFrames = 4, w = 1 } = {}) {
  const use = frames.filter(hasMeasures);
  if (use.length < 10) return null;
  const ms = use.map((f) => f.midi);
  const lo = Math.ceil(Math.min(...ms) * 2) / 2, hi = Math.floor(Math.max(...ms) * 2) / 2;
  let best = [], run = [];
  for (let m = lo; m <= hi + 1e-9; m += 0.5) {
    const near = use.filter((f) => Math.abs(f.midi - m) <= w);
    const avg = (k) => near.reduce((s, f) => s + f[k], 0) / near.length;
    // closure measures where the frames have them (not every frame does)
    const opt = (k) => { const v = near.map((f) => f[k]).filter(Number.isFinite); return v.length >= minFrames ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
    if (near.length >= minFrames) { run.push({ midi: m, hbr: avg('hbr'), vdb: avg('vdb'), hnr: avg('hnr'), h1h2: opt('h1h2'), cpp: opt('cpp') }); if (run.length > best.length) best = run; }
    else run = [];
  }
  if (best.length < 2) return null;
  const hs = use.map((f) => f.hnr).sort((a, b) => a - b);
  return { lo: best[0].midi, hi: best[best.length - 1].midi, hnr: +hs[hs.length >> 1].toFixed(2), pts: best.map((p) => ({ midi: p.midi, hbr: +p.hbr.toFixed(2), vdb: +p.vdb.toFixed(2), hnr: +p.hnr.toFixed(2), ...Object.fromEntries(GLOTTAL.filter((k) => Number.isFinite(p[k])).map((k) => [k, +p[k].toFixed(2)])) })) };
}
export const curveSpan = (c) => (c ? c.hi - c.lo : 0);
export const okCurve = (c) => !!c && Number.isFinite(c.lo) && Number.isFinite(c.hi) && Array.isArray(c.pts) && c.pts.length >= 2 && c.pts.every(hasMeasures);

// The plain voice at this pitch (interpolated), or null outside the curve
// (half a semitone beyond its ends is allowed)
export function curveAt(c, midi) {
  if (!okCurve(c) || !Number.isFinite(midi) || midi < c.lo - 0.5 || midi > c.hi + 0.5) return null;
  const m = Math.max(c.lo, Math.min(c.hi, midi)), i = Math.min(c.pts.length - 2, Math.floor((m - c.lo) / 0.5));
  const a = c.pts[i], b = c.pts[i + 1], x = (m - a.midi) / 0.5;
  const lerp = (k) => a[k] + (b[k] - a[k]) * x;
  return { midi, hbr: lerp('hbr'), vdb: lerp('vdb'), hnr: Number.isFinite(c.hnr) ? c.hnr : lerp('hnr'), h1h2: lerp('h1h2'), cpp: lerp('cpp') };
}

// How the vocal folds close, against the plain voice at the same pitch (the
// microphone can't see them: these are acoustic signs). On synthetic voices:
// breathy → CPP −13…−15 dB with H1*−H2* +5…+8 dB; very breathy → CPP −16 dB
// with H1*−H2* swamped by the noise; squeezed and rough → CPP −7 dB with
// H1*−H2* low (closed); twang, and a firm but regular closure → CPP unchanged,
// H1*−H2* 2–5 dB lower. So: a big CPP drop, or a drop with H1*−H2* up = air
// leaking; a drop with H1*−H2* not up = squeezed; no drop = closing well.
// → { state: 'good' | 'breathy' | 'pressed' | 'unknown', dCpp, dH }
export function closureOf(ref, cur, cppMax = LEVELS.easy.cpp) {
  const dCpp = ref?.cpp - cur?.cpp, dH = cur?.h1h2 - ref?.h1h2;
  if (!Number.isFinite(dCpp)) return { state: 'unknown', dCpp, dH };
  if (dCpp >= 10 || (dCpp >= cppMax && dH >= 2)) return { state: 'breathy', dCpp, dH };
  if (dCpp >= cppMax) return { state: 'pressed', dCpp, dH };
  return { state: 'good', dCpp, dH };
}

// One comparison, everything checked. base: { curve, fm }; cur: { midi, hbr,
// vdb, hnr, fm }. status: 'unknown' (a measure missing) | 'range' (pitch outside
// the plain glide) | 'vowel' (another vowel) | 'novowel' (the vowel can't be
// checked) | 'breathy' (air leaking) | 'pressed' (squeezed) | 'rough' (noisier,
// cause unclear) | 'shout' | 'plain' | 'twang'.
// Only 'twang' counts.
export function twangVerdict(base, cur, { ringMin = RING_MIN, perDb = PER_DB, roughMax = ROUGH_MAX, cppMax = LEVELS.easy.cpp, allowNoVowel = false } = {}) {
  if (!okCurve(base?.curve) || !hasMeasures(cur)) return { status: 'unknown' };
  const ref = curveAt(base.curve, cur.midi);
  if (!ref) return { status: 'range' };
  const same = sameVowel(base.fm, cur.fm);
  if (same === false) return { status: 'vowel' };
  if (same === null && !allowNoVowel) return { status: 'novowel' };
  const ring = ref.hbr - cur.hbr, loud = cur.vdb - ref.vdb, rough = ref.hnr - cur.hnr;
  const zone = twangZone(ring, loud, ringMin, perDb);
  const closure = closureOf(ref, cur, cppMax);
  // air leaking or squeezing first: both make the highs look stronger
  const status = closure.state === 'breathy' || closure.state === 'pressed' ? closure.state : rough > roughMax ? 'rough' : zone;
  return { status, zone, ring, loud, rough, closure, ref, vowelChecked: same === true };
}
