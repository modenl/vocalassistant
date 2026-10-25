// Run: node tests/along.test.mjs — singing along with the original: the
// recording delay found, every note of the original compared with what was
// sung (octave aside), from a synthetic singer through the real pipeline.
import { FrameAnalyzer } from '../js/dsp/analyzer.js';
import { PitchTracker } from '../js/analysis/pitch.js';
import { DEFAULT_SETTINGS } from '../js/config.js';
import { notesOf, bestLag, compareAlong, noteScore, scoreAlong } from '../js/along/compare.js';
import { spectrumAt, harmonicsOf, formantsAt, pitchRelation, ringOf, envelopeFormants } from '../js/along/spectra.js';
import { synth, hz, VOWELS } from '../tools/synth.mjs';

const sr = 44100;
let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(58)} ${info}`); };

// the original: 8 notes (as MELODIA would give them: frames every 5.8 ms)
const MEL = [55, 57, 59, 60, 62, 60, 59, 57], DUR = 0.6, GAP = 0.1, START = 1.0;
const refFrames = [];
MEL.forEach((m, i) => { const t0 = START + i * (DUR + GAP); for (let t = t0; t < t0 + DUR; t += 256 / 44100) refFrames.push({ t, midi: m + 0.05 * Math.sin(2 * Math.PI * 5.5 * t) }); });
const ref = notesOf(refFrames);
ok('the original’s notes found', ref.length === MEL.length && ref.every((n, i) => Math.abs(n.midi - MEL[i]) < 0.1), ref.map((n) => n.name).join(' '));

// a singer, `delay` s late, with changes per note: { i: cents } and missing notes
function sing({ delay = 0.25, cents = {}, skip = [], octave = 0, settings = DEFAULT_SETTINGS } = {}) {
  const segs = [{ dur: START + delay }];
  MEL.forEach((m, i) => {
    segs.push(skip.includes(i) ? { dur: DUR } : { dur: DUR, f0: () => hz(m + 12 * octave + (cents[i] || 0) / 100), vowel: VOWELS.a, oq: 0.55, sq: 2.4, jitter: 0.003, shimmer: 0.03 });
    segs.push({ dur: GAP });
  });
  const x = Float32Array.from(synth(segs, sr));
  const an = new FrameAnalyzer(sr), pt = new PitchTracker(settings), out = [];
  for (let end = an.N; end <= x.length; end += 1024) { const t = (end - an.N / 2) / sr, st = pt.update(an.analyze(x.subarray(end - an.N, end), { gateDb: -52, pitchOnly: true }), t); if (st.voiced) out.push({ t, midi: st.midi }); }
  return out;
}
const run = (opts) => { const u = sing(opts), L = bestLag(refFrames, u); return { L, R: compareAlong(ref, u.map((f) => ({ ...f, t: f.t - L.lag }))) }; };

{
  const { L, R } = run({ delay: 0.25, cents: { 3: 60 }, skip: [6] });
  ok('the recording delay is found', Math.abs(L.lag - 0.25) <= 0.04, `lag ${L.lag} s`);
  ok('in-tune notes: good', R.notes.filter((n, i) => ![3, 6].includes(i)).every((n) => n.status === 'good'), R.notes.map((n) => `${n.name}:${n.status}`).join(' '));
  ok('a note 60 cents sharp: off, +60', R.notes[3].status === 'off' && Math.abs(R.notes[3].user.cents - 60) <= 10, `${R.notes[3].user?.cents}`);
  ok('a note not sung: missed', R.notes[6].status === 'missed');
  ok('summary: 7 of 8 sung, 6 in tune', R.summary.sung === 7 && R.summary.inTune === 6, JSON.stringify({ sung: R.summary.sung, inTune: R.summary.inTune }));
}
{
  // a man an octave below the original: same notes, octave reported
  const { L, R } = run({ delay: 0.1, octave: -1 });
  ok('an octave below: still in tune, octave −1', R.notes.every((n) => n.status === 'good' && n.user.octave === -1) && R.summary.octave === -1, `lag ${L.lag} · ${R.notes.map((n) => n.user?.name).join(' ')}`);
}
{
  // sharp throughout by 60 cents: the delay is still found, every note off, +60
  const { L, R } = run({ delay: 0.3, cents: Object.fromEntries(MEL.map((_, i) => [i, 60])) });
  ok('60 cents sharp throughout: delay still found', Math.abs(L.lag - 0.3) <= 0.04, `lag ${L.lag} s`);
  ok('60 cents sharp throughout: every note off, bias +60', R.notes.every((n) => n.status === 'off') && Math.abs(R.summary.bias - 60) <= 10, `bias ${R.summary.bias}`);
}
{
  // flat throughout by 40 cents: in tune (≤ 50) but the tendency shows
  const { R } = run({ delay: 0.2, cents: Object.fromEntries(MEL.map((_, i) => [i, -40])) });
  ok('40 cents flat throughout: near, bias −40', R.notes.every((n) => n.status === 'near') && Math.abs(R.summary.bias + 40) <= 10, `bias ${R.summary.bias}`);
}

{
  // a whole song sung 2 semitones lower (another key): in tune relative to it
  const low = sing({ delay: 0.2, cents: Object.fromEntries(MEL.map((_, i) => [i, i === 4 ? -260 : -200])) }), Lk = bestLag(refFrames, low);
  const lowT = low.map((f) => ({ ...f, t: f.t - Lk.lag }));
  const A = compareAlong(ref, lowT), Ab = compareAlong(ref, lowT, { key: 'absolute' });
  ok('2 semitones lower throughout: taken as a key change (−2)', A.summary.key === -2, `key ${A.summary.key}`);
  ok('…in tune in that key, except the note 60 cents flat of it', A.notes.filter((n, i) => i !== 4).every((n) => n.status === 'good') && A.notes[4].status === 'off' && Math.abs(A.notes[4].user.cents + 60) <= 10, A.notes.map((n) => n.user?.cents).join(' '));
  ok('…and judged in the original key on request: all off', Ab.summary.key === 0 && Ab.notes.every((n) => n.status === 'off'));
  const flat = compareAlong(ref, sing({ delay: 0.2, cents: Object.fromEntries(MEL.map((_, i) => [i, -30])) }).map((f) => ({ ...f, t: f.t - 0.2 })));
  ok('30 cents flat throughout: not a key change, the flatness is reported', flat.summary.key === 0 && Math.abs(flat.summary.bias + 30) <= 10, `key ${flat.summary.key} · bias ${flat.summary.bias}`);
}
{
  // the singer's phrases decide where the voice is: a piano note between lines
  // (the original's melody there, nobody singing) is accompaniment, not "missed";
  // a note skipped inside a sung phrase is "missed"
  const piano = { t0: START + MEL.length * (DUR + GAP) + 0.4, t1: START + MEL.length * (DUR + GAP) + 1.6, midi: 50, name: 'D3' };
  const u = sing({ delay: 0.25, skip: [6] }), Lg = bestLag(refFrames, u);
  const R = compareAlong([...ref, piano], u.map((f) => ({ ...f, t: f.t - Lg.lag })));
  ok('a note between lines (nobody singing): accompaniment, not counted', R.notes[R.notes.length - 1].status === 'accomp' && R.summary.total === MEL.length && R.summary.accomp === 1, `${R.notes[R.notes.length - 1].status} · total ${R.summary.total}`);
  ok('a note skipped inside a sung phrase: still "missed"', R.notes[6].status === 'missed', R.notes[6].status);
}

{
  // the spectra view: F0 and its harmonics where they are, the singer's F1/F2,
  // and how two pitches relate (an octave apart shows as every 2nd harmonic)
  const r1 = pitchRelation(220, 110), r2 = pitchRelation(220, 214), r3 = pitchRelation(220, 221);
  ok('relation: an octave below', r1.octave === -1 && r1.cents === 0 && r1.refName === 'A3' && r1.userName === 'A2');
  ok('relation: 214 vs 220 Hz → 48 cents flat, near', r2.octave === 0 && r2.cents === -48 && r2.kind === 'near', `${r2.cents}`);
  ok('relation: 221 vs 220 Hz → the same note', r3.kind === 'same');
  const x = Float32Array.from(synth([{ dur: 1, f0: () => 110, vowel: VOWELS.a, oq: 0.55, sq: 2.4 }], sr));
  const sp = spectrumAt(x, sr, 22050), hm = harmonicsOf(sp, 110, 2500);
  ok('harmonics: found at k × F0', hm.length >= 20 && hm.every((h) => Math.abs(h.f / (h.k * 110) - 1) < 0.01), hm.slice(0, 4).map((h) => Math.round(h.f)).join(' '));
  const fm = formantsAt(x, sr, 22050, 110);
  ok('the singer’s F1, F2 (“ah”: 730, 1150 Hz)', fm && Math.abs(fm[0] / 730 - 1) < 0.1 && Math.abs(fm[1] / 1150 - 1) < 0.1, fm?.map(Math.round).join(' / '));
  // F1/F2 from the harmonics' levels (used for the original, mixed with a band)
  const hm4 = harmonicsOf(sp, 110, 4000), ef = envelopeFormants(hm4, 110);
  ok('F1, F2 from the harmonics alone (“ah”)', ef && Math.abs(ef[0] / 730 - 1) < 0.12 && Math.abs(ef[1] / 1150 - 1) < 0.12, ef?.map(Math.round).join(' / '));
  // …also at a higher, sparser pitch and for other vowels (an LPC envelope through
  // the harmonics, not their raw peaks: at 220 Hz "ah"'s F1 and F2 merge into one hump)
  for (const [v, f0, F] of [['a', 220, [730, 1150]], ['i', 220, [300, 2250]], ['u', 220, [330, 850]], ['a', 330, [730, 1150]]]) {
    const xv = Float32Array.from(synth([{ dur: 1, f0: () => f0, vowel: VOWELS[v], oq: 0.55, sq: 2.4 }], sr));
    const e = envelopeFormants(harmonicsOf(spectrumAt(xv, sr, 22050), f0, 4000), f0);
    ok(`F1, F2 from the harmonics: “${v}” at ${f0} Hz`, e && Math.abs(e[0] / F[0] - 1) < 0.32 && Math.abs(e[1] / F[1] - 1) < 0.12, e?.map(Math.round).join(' / '));
  }
  // ring from the harmonics: a ringing “ah” (F3–F5 close) rings more than a plain one
  const xr = Float32Array.from(synth([{ dur: 1, f0: () => 110, vowel: VOWELS.aRing, oq: 0.55, sq: 2.4 }], sr));
  const plainRing = ringOf(hm4), ringing = ringOf(harmonicsOf(spectrumAt(xr, sr, 22050), 110, 4000));
  ok('ring from the harmonics: the ringing voice is brighter', ringing < plainRing - 6, `ringing ${ringing.toFixed(0)} dB vs plain ${plainRing.toFixed(0)} dB`);
}

{
  // the score: 100 within ±25 cents, 0 at a semitone, a note left out 0
  ok('note score: ±25 cents → 100, 62.5 cents → 50, a semitone → 0', noteScore(20) === 100 && noteScore(-62.5) === 50 && noteScore(100) === 0 && noteScore(-140) === 0);
  const all = scoreAlong(run({ delay: 0.25 }).R), part = scoreAlong(run({ delay: 0.25, cents: { 3: 60 }, skip: [6] }).R);
  ok('a take all in tune scores 100', all.score === 100 && all.pitch === 100 && all.complete === 100, JSON.stringify(all));
  ok('one note 60 cents sharp, one left out (of 8): about 81', part.complete === Math.round(700 / 8) && part.score >= 78 && part.score <= 84, JSON.stringify(part));
}

console.log(fails ? `\n${fails} FAILED` : '\nall sing-along checks passed');
process.exitCode = fails ? 1 : 0;
