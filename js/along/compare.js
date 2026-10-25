// Singing along with the original: the original singer's melody (from the song
// file, see melody.js) against the singer's pitch from the microphone, note by
// note. Pure functions, so they can be tested without audio.

import { midiName } from '../config.js';

const median = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };

// Notes from a pitch track: frames [{ t, midi }] (voiced only, time-ordered).
// A note runs while the pitch stays within ±tol semitones of its recent
// median and frames keep coming (gap ≤ maxGap); shorter than minDur is dropped
// (ornaments, glides). → [{ t0, t1, midi, name }]
export function notesOf(frames, { tol = 0.6, minDur = 0.12, maxGap = 0.06 } = {}) {
  const notes = [];
  let cur = null;
  const close = () => {
    if (cur && cur.t1 - cur.t0 >= minDur) { const m = median(cur.v); notes.push({ t0: cur.t0, t1: cur.t1, midi: m, name: midiName(Math.round(m)) }); }
    cur = null;
  };
  for (const f of frames) {
    if (!Number.isFinite(f.midi)) continue;
    if (cur && f.t - cur.t1 <= maxGap && Math.abs(f.midi - median(cur.v.slice(-15))) <= tol) { cur.v.push(f.midi); cur.t1 = f.t; }
    else { close(); cur = { t0: f.t, t1: f.t, v: [f.midi] }; }
  }
  close();
  return notes;
}

// The melody as frames, from MELODIA's output (f0 per hop, 0 = no melody)
export function melodyFrames(f0, hop, a4 = 440) {
  const out = [];
  for (let i = 0; i < f0.length; i++) if (f0[i] > 0) out.push({ t: i * hop, midi: 69 + 12 * Math.log2(f0[i] / a4) });
  return out;
}

// The same pitch, octaves aside: semitones from a to b folded into ±6
const folded = (d) => d - 12 * Math.round(d / 12);

// What sounds at time t in a time-ordered frame list (nearest within maxDt)
function at(frames, t, maxDt = 0.03) {
  let lo = 0, hi = frames.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (frames[m].t < t) lo = m + 1; else hi = m; }
  let best = null;
  for (const i of [lo - 1, lo]) { const f = frames[i]; if (f && Math.abs(f.t - t) <= maxDt && (!best || Math.abs(f.t - t) < Math.abs(best.t - t))) best = f; }
  return best;
}

// The singer hears the song late (output latency) and is recorded late (input
// latency): their pitch appears `lag` seconds after the song's. The lag that
// lines the two tracks up best: most frames that follow the original's melody,
// octaves aside — within 0.35 semitone of the singer's usual offset at that lag,
// so a singer who is sharp or flat throughout still lines up (counting only
// frames in tune would pick a wrong lag for them). user: [{ t (song time,
// before the lag), midi }]
export function bestLag(ref, user, { min = -0.2, max = 0.8, step = 0.01 } = {}) {
  if (!ref.length || !user.length) return { lag: 0, matched: 0 };
  const scores = [];
  for (let lag = min; lag <= max + 1e-9; lag += step) {
    const d = [];
    for (const u of user) { const r = at(ref, u.t - lag); if (r) d.push(folded(u.midi - r.midi)); }
    const off = median(d);
    let n = 0;
    for (const x of d) if (Math.abs(folded(x - off)) <= 0.35) n++;
    scores.push({ lag, n });
  }
  // long held notes match equally over a range of lags: take the middle of
  // the best plateau, not its edge
  const top = Math.max(...scores.map((x) => x.n)), plateau = scores.filter((x) => x.n >= 0.98 * top);
  return { lag: +median(plateau.map((x) => x.lag)).toFixed(3), matched: top, share: top / user.length };
}

// Where the singer sang: their voiced frames joined into phrases (pauses under
// `gap` s inside a phrase), widened by `pad` s each side. The original's
// predominant melody is the voice only while someone sings — between lines it
// follows the instruments (a piano's lead-in note, a riff). The singer singing
// along is the sign that the voice is there: outside their phrases, the
// original's notes are taken as accompaniment.
export function phrasesOf(user, { gap = 0.5, pad = 0.3 } = {}) {
  const out = [];
  for (const u of user) {
    if (!Number.isFinite(u.midi)) continue;
    const last = out[out.length - 1];
    if (last && u.t - last.t1 <= gap) last.t1 = u.t; else out.push({ t0: u.t, t1: u.t });
  }
  return out.map((p) => ({ t0: p.t0 - pad, t1: p.t1 + pad }));
}
// the share of a note inside the phrases
export function coverOf(n, phrases) {
  let c = 0;
  for (const p of phrases) c += Math.max(0, Math.min(n.t1, p.t1) - Math.max(n.t0, p.t0));
  return c / Math.max(1e-9, n.t1 - n.t0);
}

// Note by note: for each note of the original, what the singer sang there.
// The singer may sing in another octave (a man along a woman): compared within
// the octave, and the octave is reported. They may also sing the whole song in
// another key (lower because the original is too high): `key` decides —
// 'auto': a usual offset of ≥ 0.75 semitone is taken as a key change, rounded
// to whole semitones (so being 30 cents flat throughout is still reported, and
// notes off within the new key still show); 'relative': always the singer's
// key; 'absolute': the original's key. user frames in song time (lag applied).
// → { notes: [{ ...ref, sung, user: { midi, name, octave, cents }, status }], summary }
// status: 'good' (≤ 25 cents) | 'near' (≤ 50) | 'off' (> 50) | 'missed' (in a
// phrase the singer sang, but not this note) | 'accomp' (outside their phrases:
// taken as accompaniment, not counted)
export function compareAlong(refNotes, user, { minSung = 0.4, phrases = phrasesOf(user), key = 'auto' } = {}) {
  // pass 1: what was sung on each note
  const notes = refNotes.map((r) => {
    if (coverOf(r, phrases) < 0.5) return { ...r, sung: false, status: 'accomp' };
    const dur = r.t1 - r.t0, from = r.t0 + Math.min(0.08, dur * 0.25); // the onset: the singer catches up
    const fr = user.filter((u) => u.t >= from && u.t <= r.t1 && Number.isFinite(u.midi));
    const span = fr.length > 1 ? fr[fr.length - 1].t - fr[0].t : 0;
    if (span < minSung * (r.t1 - from)) return { ...r, sung: false, status: 'missed' };
    return { ...r, sung: true, u: median(fr.map((f) => f.midi)) };
  });
  // the key the singer sang in, in whole semitones from the original's
  const sungN = notes.filter((n) => n.sung), med = sungN.length ? median(sungN.map((n) => folded(n.u - n.midi))) : 0;
  const shift = key === 'absolute' ? 0 : key === 'relative' || Math.abs(med) >= 0.75 ? Math.round(med) : 0;
  // pass 2: each note against the original in that key
  for (const n of sungN) {
    const d = n.u - n.midi - shift, octave = Math.round(d / 12), cents = Math.round((d - 12 * octave) * 100), a = Math.abs(cents);
    n.user = { midi: n.u, name: midiName(Math.round(n.u)), octave, cents };
    n.status = a <= 25 ? 'good' : a <= 50 ? 'near' : 'off';
    delete n.u;
  }
  const octaves = sungN.map((n) => n.user.octave);
  return {
    notes,
    summary: {
      total: notes.filter((n) => n.status !== 'accomp').length, sung: sungN.length,
      accomp: notes.filter((n) => n.status === 'accomp').length,
      inTune: sungN.filter((n) => n.status !== 'off').length,
      good: sungN.filter((n) => n.status === 'good').length,
      // the key the notes were judged in: semitones from the original's (0 = its key)
      key: shift, keyMode: key,
      // the usual octave (a man singing along a woman: −1)
      octave: octaves.length ? median(octaves) : 0,
      // overall tendency within that key: sharp (+) or flat (−), cents
      bias: sungN.length ? Math.round(median(sungN.map((n) => n.user.cents))) : 0,
      worst: [...sungN].filter((n) => n.status === 'off').sort((a, b) => Math.abs(b.user.cents) - Math.abs(a.user.cents)).slice(0, 5),
    },
  };
}

// A score for a take, 0–100: each of the original's notes in the lines sung
// scores 100 within ±25 cents (in the key and octave it was judged in), falling
// linearly to 0 at ±100 (a semitone); a note left out scores 0; the score is
// their mean. Also: pitch (the mean over the notes sung) and completeness (the
// share sung). Notes taken as accompaniment don't count.
export const noteScore = (cents) => Math.max(0, Math.min(100, 100 * (1 - (Math.abs(cents) - 25) / 75)));
export function scoreAlong(R) {
  const notes = R.notes.filter((n) => n.status !== 'accomp');
  if (!notes.length) return null;
  const sung = notes.filter((n) => n.sung && Number.isFinite(n.user?.cents)), per = sung.map((n) => noteScore(n.user.cents));
  const sum = per.reduce((a, b) => a + b, 0);
  return { score: Math.round(sum / notes.length), pitch: sung.length ? Math.round(sum / sung.length) : 0, complete: Math.round((100 * sung.length) / notes.length) };
}
