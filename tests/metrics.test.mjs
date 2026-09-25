// Run: node tests/metrics.test.mjs — the five measures on synthetic singing with
// known answers (full pipeline: analyzer → pitch tracker → metrics).
import { synth, hz, VOWELS } from '../tools/synth.mjs';
import { runPipeline } from '../tools/analyze-file.mjs';

const sr = 44100;
let fails = 0;
const ok = (name, cond, info) => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(46)} ${info}`); };
const run = (segs) => runPipeline(Float32Array.from(synth(segs, sr)), sr).summary;
const V = { oq: 0.5, sq: 2.5, vowel: VOWELS.a, jitter: 0.002, shimmer: 0.02 };
// the synthesizer's radiated level rises 6 dB/octave with f0: amp ∝ 1/f0 keeps it level
const lvl = (m) => Math.pow(2, -(m - 48) / 12);
const note = (m, dur, extra = {}) => ({ dur, f0: () => hz(m), ...V, amp: lvl(m), ...extra });
const gap = { dur: 0.15 };
const seq = (ms, dur, f = (m, i) => ({})) => ms.flatMap((m, i) => [note(m, dur, f(m, i)), gap]);
const vib = (m, rate, cents) => (t) => hz(m + (cents / 100) * Math.sin(2 * Math.PI * rate * t) * Math.min(1, t / 0.3));
const lin = (m0, m1, d) => (t) => hz(m0 + ((m1 - m0) * t) / d);
const ARP = [48, 52, 55, 60, 64, 67, 60, 55, 52, 48];

// 1) intonation
let S = run(seq(ARP, 0.6));
ok('in tune → intonation good', S.intonation.status === 'good', `${S.intonation.value} offset ${S.intonation.offset?.toFixed(0)}`);
S = run(seq(ARP.map((m) => m - 0.4), 0.6));
ok('all 40 cents flat (a cappella) → in tune, offset reported', S.intonation.status === 'good' && Math.abs(S.intonation.offset + 40) < 8 && /低 \d+ 音分/.test(S.intonation.detail), `${S.intonation.value} offset ${S.intonation.offset?.toFixed(0)}`);
const SCATTER = [25, -30, 0, 35, -20, 30, -35, 10, -30, 20];
S = run(seq(ARP.map((m, i) => m + SCATTER[i] / 100), 0.6));
ok('notes scattered ±20–35 cents → not good (注意)', S.intonation.status === 'ok' || S.intonation.status === 'poor', `${S.intonation.value} ${S.intonation.status}`);
S = run(seq(ARP.map((m, i) => m + (i % 3 === 1 ? -0.2 : 0)), 0.6));
ok('some notes 20 cents off → still good', S.intonation.status === 'good', `${S.intonation.value}`);

// 2) stability
S = run(seq([50, 53, 57, 55], 2.0));
ok('steady long notes → stability good', S.stability.status === 'good', S.stability.value);
S = run([50, 53, 57, 55].flatMap((m) => [{ ...note(m, 2.0), f0: lin(m, m + 0.7, 2.0) }, gap]));
ok('long notes drifting 70 cents → not good (注意)', S.stability.status === 'ok' || S.stability.status === 'poor', `${S.stability.value} ${S.stability.status}`);
S = run([50, 53, 57, 55].flatMap((m) => [{ ...note(m, 2.0), f0: lin(m, m + 1.2, 2.0) }, gap]));
ok('long notes drifting 120 cents → stability poor', S.stability.status === 'poor', S.stability.value);
S = run([52, 55, 57, 59].flatMap((m) => [{ ...note(m, 2.0), f0: vib(m, 5.5, 60) }, gap]));
ok('steady notes with ±60 cents vibrato → stability good', S.stability.status === 'good', S.stability.value);

// 3) breaks: a flip (pitch jump + level drop) inside a glide vs a smooth glide
const M1 = { ...V, oq: 0.45, sq: 3, attack: 0, release: 0 }, M2 = { ...V, oq: 0.82, sq: 1.4, noise: 0.4, amp: 0.4, attack: 0, release: 0 };
const flip = [{ dur: 2.0, f0: lin(48, 63, 2.0), ...M1, attack: 0.05 }, { dur: 1.2, f0: lin(65, 70, 1.2), ...M2, release: 0.05 }, gap];
S = run([...flip, ...flip]);
ok('glide with two flips → 2 breaks', S.breaks.count === 2, `${S.breaks.value} ${S.breaks.detail}`);
S = run([{ dur: 3.2, f0: lin(48, 70, 3.2), ...V }, gap, { dur: 3.2, f0: lin(70, 48, 3.2), ...V }, gap]);
ok('smooth glide → no breaks, no pitch judgement', S.breaks.count === 0 && S.intonation.status === 'na', `${S.breaks.value}, intonation ${S.intonation.status}`);
S = run(seq(ARP, 0.6));
ok('legato arpeggio (leaps) → no breaks', S.breaks.count === 0, S.breaks.value);

// song-like singing that is NOT a break (false alarms seen on real songs)
// a) syllables: a voiced consonant between notes dips the level ~12 dB for 70 ms
//    while the pitch moves to the next note
const MEL = [50, 52, 55, 53, 57, 52, 50, 54, 50];
const syllables = MEL.flatMap((m, i) => {
  const next = MEL[i + 1] ?? m;
  return [{ ...note(m, 0.45), attack: i ? 0 : 0.04, release: 0 },
    ...(i < MEL.length - 1 ? [{ ...note(m, 0.07), f0: lin(m, next, 0.07), amp: lvl(m) * 0.25, attack: 0, release: 0 }] : [])];
});
S = run([...syllables, gap]);
ok('sung syllables (consonant dips at note changes) → no breaks', S.breaks.count === 0, `${S.breaks.value}`);
// b) accented leaps: up and louder, down and quieter (level follows the pitch)
S = run([{ ...note(50, 1.2), release: 0 }, { ...note(54, 1.2), amp: lvl(54) * 2, attack: 0, release: 0 }, { ...note(50, 1.2), amp: lvl(50) * 0.5, attack: 0 }, gap]);
ok('accented leaps (level follows pitch) → no breaks', S.breaks.count === 0, `${S.breaks.value}`);
// c) a fast siren whose level falls while it rises (opposite trend, but gradual)
const sirenSlices = Array.from({ length: 80 }, (_, i) => {
  const u0 = i / 80, u1 = (i + 1) / 80, m0 = 48 + 14 * Math.sin(Math.PI * u0), m1 = 48 + 14 * Math.sin(Math.PI * u1);
  return { ...note(m0, 0.05), f0: lin(m0, m1, 0.05), amp: lvl(m0) * Math.pow(10, (-0.8 * (m0 - 48)) / 20), attack: i ? 0 : 0.04, release: i === 79 ? 0.05 : 0 };
});
S = run([...sirenSlices, gap]);
ok('fast siren, level falling as it rises (gradual) → no breaks', S.breaks.count === 0, `${S.breaks.value}`);
// d) a real flip down (falsetto → chest): pitch down, level UP, sound continuous
// (a clear falsetto; a flip hidden in a voicing dropout is deliberately not flagged)
S = run([{ dur: 1.8, f0: lin(67, 63, 1.8), ...M2, noise: 0.15, attack: 0.05 }, { dur: 1.8, f0: lin(60, 55, 1.8), ...M1, release: 0.05 }, gap]);
ok('flip down into chest (pitch ↓, level ↑) → 1 break', S.breaks.count === 1, `${S.breaks.value}`);

// 4) shouting: level climbs 1.8 dB per semitone vs constant level
const SCALE = [48, 50, 52, 53, 55, 57, 59, 60];
S = run(seq(SCALE, 0.6, (m) => ({ amp: lvl(m) * Math.pow(10, (1.8 * (m - 48)) / 20) / 8 })));
ok('level +1.8 dB/semitone → shouting poor', S.shout.status === 'poor', `${S.shout.value} slope ${S.shout.slope?.toFixed(2)}`);
S = run(seq(SCALE, 0.6, (m) => ({ amp: lvl(m) * Math.pow(10, (0.8 * (m - 48)) / 20) })));
ok('natural rise +0.8 dB/semitone → not shouting', S.shout.status === 'good', `${S.shout.value} slope ${S.shout.slope?.toFixed(2)}`);
S = run(seq(SCALE, 0.6));
ok('constant level → shouting good', S.shout.status === 'good', `${S.shout.value} slope ${S.shout.slope?.toFixed(2)}`);

// 5) vibrato
S = run([52, 55, 57, 59].flatMap((m) => [{ ...note(m, 2.0), f0: vib(m, 5.5, 50) }, gap]));
ok('5.5 Hz ±50 cents → healthy', S.vibrato.status === 'good' && S.vibrato.count.healthy >= 3, `${S.vibrato.value} ${JSON.stringify(S.vibrato.count)}`);
S = run([52, 55, 57, 59].flatMap((m) => [{ ...note(m, 2.0), f0: vib(m, 9, 40) }, gap]));
ok('9 Hz → too fast (poor)', S.vibrato.status === 'poor' && S.vibrato.count.tremolo >= 3, `${S.vibrato.value} ${JSON.stringify(S.vibrato.count)}`);
S = run(seq([52, 55, 57, 59], 2.0));
ok('straight tone → fine (not a problem)', S.vibrato.status === 'good' && S.vibrato.count.straight >= 3, `${S.vibrato.value}`);
ok('vibrato notes still count as in tune', run([52, 55, 57, 59].flatMap((m) => [{ ...note(m, 2.0), f0: vib(m, 5.5, 50) }, gap])).intonation.status !== 'poor', '');

// 6) range
S = run(seq(ARP, 0.6));
ok('range C3–G4', S.range && S.range.loName === 'C3' && S.range.hiName === 'G4', S.range ? `${S.range.loName}–${S.range.hiName}` : '—');


// 7) 整体偏移: the singer's own tuning sinks 70 cents over 30 s (intervals stay right)
const MELODY = [55, 57, 59, 60, 62, 60, 59, 57];
const long = (detune) => Array.from({ length: 40 }, (_, i) => MELODY[i % 8]).flatMap((m, i) => [note(m + detune(i / 39) / 100, 0.6), gap]);
S = run(long(() => 0));
ok('steady tuning over 30 s → no drift', S.keyDrift.status === 'good' && S.intonation.status === 'good', `${S.keyDrift.value}`);
S = run(long((u) => -70 * u));
ok('sinking 70 cents → 越唱越低 flagged, intervals still in tune', S.keyDrift.status !== 'good' && S.keyDrift.drift < -40 && /越唱越低/.test(S.keyDrift.value) && S.intonation.status === 'good', `${S.keyDrift.value} · ${S.intonation.value}`);

// 8) 节奏: "小星星" at 100/min (6 quarters + a half per phrase, breath after the half),
// consonant dips between syllables; onsets jittered like a real singer
let rs = 11;
const rnd = () => { rs = (rs * 1664525 + 1013904223) >>> 0; return rs / 4294967296; };
const randn = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd());
const TW = ['1155665', '4433221', '5544332', '5544332', '1155665', '4433221'].flatMap((p) => [...p].map((d, i) => [{ 1: 55, 2: 57, 3: 59, 4: 60, 5: 62, 6: 64 }[d], i === 6 ? 2 : 1]));
function song({ beat = () => 0.6, jitter = 0.02 } = {}) {
  const on = [];
  let b = 0;
  const tAt = (bb) => { let t = 0; for (let x = 0; x < bb; x += 0.01) t += beat(x) * Math.min(0.01, bb - x); return t; };
  TW.forEach(([, len], i) => { on.push(tAt(b) + (i ? jitter * randn() : 0)); b += len; });
  const end = tAt(b), segs = [];
  let t = 0;
  TW.forEach(([m, len], i) => {
    const t1 = i + 1 < on.length ? on[i + 1] : end, voiced = len === 2 ? t1 - on[i] - 0.25 : t1 - on[i];
    if (on[i] > t) segs.push({ dur: on[i] - t });
    const prev = i ? TW[i - 1][0] : m, cons = i && TW[i - 1][1] === 1 && len !== 2 ? 0.07 : 0;
    if (cons) segs.push({ ...note(m, cons), f0: lin(prev, m, cons), amp: lvl(m) * 0.25, attack: 0, release: 0 });
    segs.push({ ...note(m, voiced - cons), attack: cons ? 0 : 0.04, release: len === 2 ? 0.05 : 0 });
    t = on[i] + voiced;
  });
  return [...segs, { dur: 0.3 }];
}
S = run(song());
ok('steady song (±20 ms) → 节拍均匀 + 速度稳定 good', S.beat.status === 'good' && S.tempo.status === 'good', `${S.beat.value} · ${S.tempo.value}`);
S = run(song({ beat: (b) => 0.6 * (1 - (0.22 * b) / 48) }));
ok('speeding up 22 % → 越唱越快 flagged', S.tempo.status !== 'good' && S.tempo.change > 0 && /快/.test(S.tempo.value), `${S.tempo.value}`);
S = run(song({ jitter: 0.09 }));
ok('sloppy timing (±90 ms) → 节拍均匀 not good, or no clear beat', S.beat.status !== 'good', `${S.beat.status} ${S.beat.value}`);
// accents: legato syllables, every other one stressed (+7 dB) — the beat is in the
// stresses even where single onsets are blurred
{
  const segs = [];
  for (let i = 0; i < 64; i++) {
    const m = [52, 55, 57, 55][i % 4], acc = i % 2 === 0;
    segs.push({ ...note(m, 0.33), amp: lvl(m) * (acc ? 1 : 0.45), attack: 0.03, release: 0.02 });
  }
  S = run([...segs, { dur: 0.3 }]);
  ok('stressed beats at 91/min (legato) → beat heard in the accents', S.beat.score != null && Math.abs(S.beat.bpm - 91) < 6, `${S.beat.value} · ${S.beat.detail.slice(0, 30)}`);
}
// wide leaps sung legato, sliding 0.25 s into each note (the old onset rules missed these)
{
  const LEAP = [49, 57, 54, 57, 49, 57, 54, 57, 50, 57, 54, 57, 49, 57, 54, 57, 50, 57, 54, 57, 49, 57, 54, 57, 49, 57, 54, 57];
  const segs = LEAP.map((m, i) => { const p = i ? LEAP[i - 1] : m; return { ...note(m, 0.5), f0: (t) => hz(t < 0.25 ? p + (m - p) * (t / 0.25) : m), attack: i ? 0 : 0.04, release: 0 }; });
  S = run([...segs, { dur: 0.3 }]);
  ok('steady wide leaps with slides → beat found, 节拍均匀 good', S.beat.status === 'good', `${S.beat.value} ${S.beat.detail.slice(0, 40)}`);
}
S = run(seq([50, 53, 57, 55, 52], 2.5));
ok('long-tone exercise → rhythm not judged', S.beat.status === 'na' && S.tempo.status === 'na' && S.dims.rhythm.score == null, S.beat.detail);

// 9) 句尾掉音: phrase-final long notes sink 70 cents over their last 0.45 s
const phrase = (m, end) => [note(m, 0.5), note(m + 2, 0.5), { ...note(m + 4, 1.2), f0: end(m + 4, 1.2) }, { dur: 0.4 }];
const flatEnd = (m) => () => hz(m);
const sagEnd = (m, d) => (t) => hz(m - (t > d - 0.45 ? (0.7 * (t - (d - 0.45))) / 0.45 : 0));
const fallOff = (m, d) => (t) => hz(m - (t > d - 0.2 ? (3 * (t - (d - 0.2))) / 0.2 : 0));
const vibEnd = (m) => vib(m, 5.5, 50);
const phrases = (end) => [50, 52, 48, 51, 49].flatMap((m) => phrase(m, end));
S = run(phrases(flatEnd));
ok('phrase ends held → 句尾掉音 good', S.tail.status === 'good', S.tail.value);
S = run(phrases(sagEnd));
ok('phrase ends sinking 70 cents → 句尾掉音 poor', S.tail.status === 'poor' && S.tail.points.length >= 4, S.tail.value);
S = run(phrases(vibEnd));
ok('phrase ends with ±50 cents vibrato → not a sag', S.tail.status === 'good', S.tail.value);
S = run(phrases(fallOff));
ok('deliberate fall-off (3 semitones in 0.2 s) → not a sag', S.tail.status !== 'poor', S.tail.value);

// 10) 挑音: every note after a pause starts 1.5 semitones low and slides up for 0.2 s
const scooped = (m) => (t) => hz(m - (t < 0.2 ? 1.5 * (1 - t / 0.2) : 0));
S = run([50, 53, 55, 52, 57, 50, 54].flatMap((m) => [{ ...note(m, 0.8), f0: scooped(m) }, { dur: 0.25 }]));
ok('every note scooped from below → 挑音 poor', S.scoop.status === 'poor', S.scoop.value);
S = run([50, 53, 55, 52, 57, 50, 54].flatMap((m) => [note(m, 0.8), { dur: 0.25 }]));
ok('clean onsets → 挑音 good', S.scoop.status === 'good', S.scoop.value);

// 11) 强弱对比: ten 4-note phrases, soft and loud (8 dB apart) vs all the same
const phr = (k, amp) => [0, 2, 4, 2].map((d) => note(50 + d + (k % 3), 0.6, { amp: lvl(50 + d + (k % 3)) * amp }));
S = run(Array.from({ length: 10 }, (_, k) => [...phr(k, k % 2 ? 1 : 0.4), { dur: 0.4 }]).flat());
ok('phrases 8 dB apart → 强弱对比 good', S.dynamics.status === 'good', S.dynamics.value);
S = run(Array.from({ length: 10 }, (_, k) => [...phr(k, 1), { dur: 0.4 }]).flat());
ok('every phrase equally loud → 强弱对比 not good', S.dynamics.status !== 'good', S.dynamics.value);

// 12) dimensions and total
S = run(song());
ok('a clean song → total ≥ 75, every judged dimension scored', S.total >= 75 && Object.values(S.dims).filter((d) => d.score != null).length >= 3, `total ${S.total} ${Object.values(S.dims).map((d) => `${d.title} ${d.score ?? '—'}`).join(' ')}`);
S = run(phrases(sagEnd));
ok('a poor check caps its dimension below 75', S.tail.score < 60 && S.dims.breath.score <= 74, `气息 ${S.dims.breath.score} (句尾 ${S.tail.score}, 长音 ${S.stability.score ?? '—'})`);


// 13) scoring progress: what's still missing before a check / dimension / the total can be scored
const { SingingMetrics } = await import('../js/analysis/metrics.js');
S = new SingingMetrics().summary();
ok('nothing sung → 0 % everywhere, total needs 3 dimensions', S.ready.progress === 0 && S.total == null && Object.values(S.dims).every((d) => d.progress === 0 && d.left), Object.values(S.dims).map((d) => `${d.title}: ${d.left}`).join(' · '));
S = run(seq([50, 53], 0.6));
ok('two notes → 音准 half way, "再唱 2 个稳定的音"', S.intonation.progress === 0.5 && /再唱 2 个/.test(S.intonation.left) && S.dims.pitch.score == null && S.total == null, `${Math.round(S.dims.pitch.progress * 100)}% ${S.dims.pitch.left}`);
S = run(song());
ok('a full song → total ready (100 %)', S.total != null && S.ready.progress === 1 && S.ready.scored >= 3, `ready ${JSON.stringify(S.ready)}`);
rs = 101;
S = run(Array.from({ length: 26 }, () => { const m = 50 + Math.floor(rnd() * 9); return [note(m, 0.3 + rnd() * 1.9), { dur: 0.1 + rnd() * 0.7 }]; }).flat());
ok('free rhythm, plenty of notes → 节奏 "无法判断" (blocked), not "sing more"', S.dims.rhythm.score == null && S.dims.rhythm.blocked && S.beat.blocked, S.dims.rhythm.reason);
// the note being sung counts towards progress while it lasts
const live = new SingingMetrics();
{
  const x = Float32Array.from(synth([note(50, 0.6), gap, note(53, 0.6), gap, note(55, 0.6), gap, note(57, 1.2)], sr));
  const { FrameAnalyzer } = await import('../js/dsp/analyzer.js'), { PitchTracker } = await import('../js/analysis/pitch.js'), { DEFAULT_SETTINGS } = await import('../js/config.js');
  const an = new FrameAnalyzer(sr), pt = new PitchTracker(DEFAULT_SETTINGS);
  for (let end = an.N; end <= x.length; end += 1024) live.push(pt.update(an.analyze(x.subarray(end - an.N, end), { gateDb: -52, pitchOnly: true }), (end - an.N / 2) / sr));
}
S = live.summary(); // the 4th note is still sounding
ok('the note being sung completes the count → "把这个音唱完"', S.intonation.score == null && S.intonation.progress === 0.95 && /唱完/.test(S.intonation.left), `${S.intonation.progress} ${S.intonation.left}`);

console.log(fails ? `\n${fails} FAILED` : '\nall metric checks passed');
process.exitCode = fails ? 1 : 0;
