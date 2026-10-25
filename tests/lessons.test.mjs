// Run: node tests/lessons.test.mjs — every lesson step through the full pipeline
// (synthetic singing → analyzer → pitch → take → check): a correct performance
// must pass, a typical mistake must fail.
import { FrameAnalyzer } from '../js/dsp/analyzer.js';
import { Take } from '../js/lessons/runner.js';
import { LESSONS, loadTwang, saveTwang } from '../js/lessons/lessons.js';
import { DEFAULT_SETTINGS, VOICE_TYPES, midiName } from '../js/config.js';
import { synth, hz, VOWELS } from '../tools/synth.mjs';

const sr = 44100;
let fails = 0;
const ok = (name, cond, info) => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(44)} ${info}`); };

// muteUntil: frames before this time are heard while the reference tone plays
// (the runner mutes them) — the reference must never pass a step.
function judge(step, P, segs, { muteUntil = -1, ctx, gain, post } = {}) {
  let x = Float32Array.from(synth(segs, sr, gain ? { gain } : {}));
  if (post) x = post(x);
  const an = new FrameAnalyzer(sr), take = new Take(DEFAULT_SETTINGS), check = step.check(P, ctx);
  let passed = false, ev, best = null;
  for (let end = an.N; end <= x.length; end += 1024) {
    const t = (end - an.N / 2) / sr;
    take.push(an.analyze(x.subarray(end - an.N, end), { gateDb: -52, pitchOnly: !step.glottal, formants: 'compare' in step }), t, t < muteUntil);
    if (take.frames.length % 6 === 0) { ev = check(take); if (ev.pass) { passed = true; best = best || ev; } }
  }
  take.m.finish();
  ev = check(take);
  const final = ev.pass ? ev : best || ev; // the runner stops shortly after a pass
  return { passed: passed || ev.pass, hint: ev.hint, score: final.score, parts: final.parts, save: final.save };
}

// voice: the synthesizer's level rises 6 dB/octave with f0 — amp ∝ 1/f0 keeps it even
const V = { oq: 0.55, sq: 2.4, vowel: VOWELS.a, jitter: 0.002, shimmer: 0.02 };
const lvl = (m) => Math.pow(2, -(m - 48) / 12);
const hold = (m, dur, x = {}) => ({ dur, f0: () => hz(m), ...V, amp: lvl(m), ...x });
const gap = { dur: 0.2 };
const notes = (ms, dur, x = () => ({})) => ms.flatMap((m, i) => [hold(m, dur, x(m, i)), { dur: 0.06 }]).concat(gap);
const vib = (m, rate, c) => (t) => hz(m + (c / 100) * Math.sin(2 * Math.PI * rate * t) * Math.min(1, t / 0.3));
const lin = (a, b, d) => (t) => hz(a + ((b - a) * t) / d);
const sirenFn = (lo, hi, d) => (t) => hz(lo + (hi - lo) * Math.sin((Math.PI * t) / d));
// amplitude ramps: split into slices
// (pitch(u) optional: pitch in semitones over the ramp, u = 0…1)
const ramp = (m, dur, dbFrom, dbTo, pitch = null) => {
  const n = Math.round(dur / 0.05);
  return Array.from({ length: n }, (_, i) => {
    const u = i / (n - 1), db = dbFrom + (dbTo - dbFrom) * u, pm = pitch ? pitch(u) : m;
    return { ...hold(pm, 0.05), amp: lvl(m) * Math.pow(10, db / 20), attack: 0, release: 0 };
  });
};

const P = VOICE_TYPES.baritone, M = P.mid; // F3
const S = Object.fromEntries(LESSONS.flatMap((l) => l.steps.map((s) => [`${l.id}.${s.id}`, s])));
const T = (id, want, segs, label, opts) => { const r = judge(S[id], P, segs, opts); ok(`${id}: ${label}`, r.passed === want, `passed=${r.passed} score=${r.score} — ${r.hint}`); return r; };

T('pitch.one', true, [hold(M, 3), gap], 'in tune 3 s');
T('pitch.one', true, [hold(M - 0.45, 3), gap], '45 cents flat (within ±50)');
T('pitch.one', true, [hold(M - 12, 3), gap], 'an octave lower counts');
T('pitch.one', true, [hold(M, 0.9), gap, hold(M, 0.9), gap], 'two short tries add up');
T('pitch.one', true, [{ ...hold(M, 3), f0: vib(M, 5.5, 50) }, gap], 'in tune with ±50 cents vibrato');
T('pitch.one', false, [hold(M - 0.65, 3), gap], '65 cents flat');
// the reference tone leaking from the speaker into the microphone
T('pitch.one', false, [gap, hold(M, 1.8), gap], 'reference heard by the mic (muted) → no pass', { muteUntil: 99 });
T('pitch.one', true, [gap, hold(M, 1.8), { dur: 0.6 }, hold(M, 2), gap], 'reference muted, then sung in tune → pass', { muteUntil: 2.7 });
T('pitch.one', false, [gap, hold(M, 1.8), { dur: 0.6 }, hold(M, 1.0), gap], 'reference muted, then only 1 s sung → no pass', { muteUntil: 2.7 });
T('pitch.three', true, notes([M, M + 4, M + 7], 1.0), 'do–mi–sol in tune');
T('pitch.three', true, notes([M, M + 3.6, M + 7], 1.0), 'mi 40 cents flat (within ±50)');
T('pitch.three', true, notes([M - 12, M - 8, M - 5], 1.0), 'whole pattern an octave lower');
T('pitch.three', false, notes([M, M + 3.3, M + 7], 1.0), 'mi 70 cents flat');
T('pitch.scale', true, notes([0, 2, 4, 5, 7, 5, 4, 2, 0].map((d) => M + d), 0.5), 'scale in tune');
T('pitch.scale', false, notes([0, 2, 3, 5, 7, 5, 3, 2, 0].map((d) => M + d), 0.5), 'minor third instead of major');

// scale sung legato (no pauses), as people actually sing it
function legato(pitches, noteDur, { port = 0.06, vibc = 0 } = {}) {
  const f0 = (t) => {
    const i = Math.min(pitches.length - 1, Math.floor(t / noteDur)), u = t - i * noteDur, prev = i ? pitches[i - 1] : pitches[0];
    const m = u < port ? prev + (pitches[i] - prev) * (0.5 - 0.5 * Math.cos((Math.PI * u) / port)) : pitches[i];
    return hz(m + (vibc / 100) * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3));
  };
  return [gap, { ...hold(M, pitches.length * noteDur), f0, amp: 1 }, { dur: 0.8 }];
}
const SC = [0, 2, 4, 5, 7, 5, 4, 2, 0];
T('pitch.scale', true, legato(SC.map((d) => M + d), 0.45), 'legato, 0.45 s per note');
T('pitch.scale', false, legato(SC.map((d) => M + d), 0.7), 'the reference scale heard by the mic (muted) → no pass', { muteUntil: 99 });
T('pitch.scale', true, legato(SC.map((d) => M + d), 0.6, { vibc: 40 }), 'legato with ±40 cents vibrato');
T('pitch.scale', true, legato(SC.map((d, i) => M + d - (0.65 * i) / 8), 0.6), 'drifts flat to -65 cents (intervals right)');
T('pitch.scale', true, legato(SC.map((d) => M - 12 + d), 0.6), 'an octave lower');
T('pitch.scale', false, legato([0, 2, 4, 5, 7, 5, 3, 2, 0].map((d) => M + d), 0.6), 'wrong note (flat 3rd on the way down)');
T('pitch.scale', false, legato([0, 2, 4, 7, 5, 4, 2, 0].map((d) => M + d), 0.6), 'skips the 4th going up');
T('pitch.scale', false, legato(SC.map((d, i) => M + d + (i === 4 ? -0.7 : 0)), 0.6), 'top note 70 cents flat of the others');
T('pitch.scale', false, legato(SC.map((d, i) => M + d - (1.1 * i) / 8), 0.6), 'drifts flat to -110 cents');
T('pitch.scale', false, [gap, { ...hold(M, 4), f0: (t) => hz(M + 7 * Math.sin((Math.PI * t) / 4)), amp: 1 }, { dur: 0.8 }], 'a siren through the notes (no held notes)');

T('sustain.s5', true, [hold(M + 2, 6), gap], 'steady 6 s');
T('sustain.s5', true, [{ ...hold(M + 2, 6), f0: vib(M + 2, 5.5, 50) }, gap], 'steady with ±50 cents vibrato');
T('sustain.s5', false, [{ ...hold(M + 2, 6), f0: lin(M + 2, M + 1, 6) }, gap], 'pitch sags 100 cents');
T('sustain.s5', false, [...ramp(M + 2, 6, 0, -14), gap], 'level fades 14 dB');
T('sustain.s10', true, [hold(M + 2, 11), gap], 'steady 11 s');
T('sustain.s10', false, [hold(M + 2, 6), gap], 'only 6 s');
T('sustain.s10', false, [{ ...hold(M + 2, 11), f0: lin(M + 2, M + 1.4, 11) }, gap], 'pitch sags 60 cents (step 2: ≤ 40)');
const quiet = { dur: 1 };
T('sustain.mpt', true, [hold(M, 18, { release: 0.3 }), quiet], 'one breath, 18 s');
T('sustain.mpt', true, [{ ...hold(M, 14), f0: vib(M, 5.5, 50) }, quiet], '14 s with vibrato');
T('sustain.mpt', false, [hold(M, 7), quiet], 'only 7 s');
T('sustain.mpt', false, [hold(M, 1.5), quiet], 'a false start (1.5 s) is not judged');
T('sustain.mpt', false, [{ ...hold(M, 14), f0: sirenFn(M - 5, M + 7, 14) }, quiet], 'a 14-s siren is not one note');
T('sustain.mpt', false, [hold(M, 15)], 'still singing → not judged yet');

T('glide.fifth', true, [{ ...hold(M, 3), f0: sirenFn(M, M + 7.3, 3) }, gap], 'smooth siren');
const flipGlide = [{ ...V, dur: 1.2, f0: lin(M, M + 4, 1.2), amp: lvl(M), attack: 0.05, release: 0 },
  { ...V, dur: 1.2, f0: lin(M + 6, M + 7.5, 1.2), oq: 0.82, sq: 1.4, noise: 0.4, amp: lvl(M) * 0.3, attack: 0, release: 0 },
  { ...V, dur: 1.5, f0: lin(M + 7.5, M, 1.5), oq: 0.82, sq: 1.4, noise: 0.4, amp: lvl(M) * 0.3, attack: 0 }, gap];
T('glide.fifth', false, flipGlide, 'siren with a crack');
T('glide.octave', true, [{ ...hold(M, 4), f0: sirenFn(M - 2, M + 10.3, 4) }, gap], 'smooth octave siren');
T('glide.octave', false, [{ ...hold(M, 3), f0: sirenFn(M - 2, M + 6, 3) }, gap], 'only reaches a sixth');

T('dynamics.messa', true, [...ramp(M + 2, 3, -14, 0), ...ramp(M + 2, 3, 0, -14), gap], 'soft→loud→soft 14 dB');
T('dynamics.messa', false, [hold(M + 2, 6), gap], 'no dynamics');
T('dynamics.messa', false, [...ramp(M + 2, 3, -14, 0, (u) => M + 2 + 0.7 * u), ...ramp(M + 2, 3, 0, -14, (u) => M + 2.7 - 0.7 * u), gap], 'pitch rises with loudness');

const five = [0, 2, 4, 5, 7].map((d) => M + 2 + d);
T('noshout.five', true, notes(five, 0.6), 'even level');
T('noshout.five', false, notes(five, 0.6, (m) => ({ amp: lvl(m) * Math.pow(10, (1.6 * (m - five[0])) / 20) })), '+1.6 dB per semitone');
const arp = [0, 4, 7, 12, 7, 4, 0].map((d) => M + d);
T('noshout.arp', true, notes(arp, 0.6), 'even level');
T('noshout.arp', false, notes(arp, 0.6, (m) => ({ amp: lvl(m) * Math.pow(10, (0.9 * (m - M)) / 20) })), 'top note +11 dB');

T('vibrato.straight', true, [hold(M + 2, 4), gap], 'straight tone');
T('vibrato.straight', false, [{ ...hold(M + 2, 4), f0: vib(M + 2, 6, 60) }, gap], 'with vibrato');
T('vibrato.natural', true, [{ ...hold(M + 2, 4), f0: vib(M + 2, 5.5, 50) }, gap], '5.5 Hz ±50 cents');
T('vibrato.natural', false, [hold(M + 2, 4), gap], 'straight tone');
T('vibrato.natural', false, [{ ...hold(M + 2, 4), f0: vib(M + 2, 9, 40) }, gap], '9 Hz (too fast)');

// ---- scores: better performances score higher; passes are 60–100
const SC_ = (id, segs, opts) => judge(S[id], P, segs, opts).score;
const band = (name, v, lo, hi) => ok(`score: ${name}`, v >= lo && v <= hi, `${v} (expected ${lo}–${hi})`);
band('one note in tune', SC_('pitch.one', [hold(M, 3), gap]), 95, 100);
band('one note 20 cents flat', SC_('pitch.one', [hold(M - 0.2, 3), gap]), 85, 95);
band('one note 30 cents flat', SC_('pitch.one', [hold(M - 0.3, 3), gap]), 75, 88);
band('one note 45 cents flat', SC_('pitch.one', [hold(M - 0.45, 3), gap]), 60, 74);
band('do–mi–sol, mi 40 cents flat', SC_('pitch.three', notes([M, M + 3.6, M + 7], 1.0)), 70, 85);
band('scale in tune (legato)', SC_('pitch.scale', legato(SC.map((d) => M + d), 0.5)), 95, 100);
band('scale ±20 cents scatter', SC_('pitch.scale', legato(SC.map((d, i) => M + d + [0.2, -0.2, 0.15, -0.1, 0.2, -0.15, 0.1, -0.2, 0.15][i]), 0.6)), 75, 92);
band('scale drifting flat to -65', SC_('pitch.scale', legato(SC.map((d, i) => M + d - (0.65 * i) / 8), 0.6)), 60, 95);
band('one breath 26 s (male average) → full marks', SC_('sustain.mpt', [hold(M, 26.5), { dur: 1 }]), 98, 100);
band('one breath 15 s → a pass, well below full', SC_('sustain.mpt', [hold(M, 15), { dur: 1 }]), 65, 80);
band('long note with ±50 cents vibrato', SC_('sustain.s5', [{ ...hold(M + 2, 6), f0: vib(M + 2, 5.5, 50) }, gap]), 88, 100);
band('long note sagging 40 cents (step 1)', SC_('sustain.s5', [{ ...hold(M + 2, 6), f0: lin(M + 2, M + 1.6, 6) }, gap]), 70, 90);
band('vibrato scores above a sagging note', SC_('sustain.s5', [{ ...hold(M + 2, 6), f0: vib(M + 2, 5.5, 50) }, gap]) > SC_('sustain.s5', [{ ...hold(M + 2, 6), f0: lin(M + 2, M + 1.6, 6) }, gap]) ? 1 : 0, 1, 1);
band('octave arpeggio at even effort', SC_('noshout.arp', notes(arp, 0.6)), 85, 100);


// the rule itself: more 2–4 kHz share than loudness (× 0.8), and ≥ 6 dB
{
  const { twangZone } = await import('../js/analysis/twang.js');
  const z = [[8, 2], [8, 12], [7, 18], [3, 0], [10, 12], [2, 11]].map(([r, l]) => twangZone(r, l)).join(',');
  ok('twang zones: +8/+2 twang, +8/+12 shout, +7/+18 shout, +3/0 plain, +10/+12 twang, +2/+11 shout', z === 'twang,shout,shout,plain,twang,shout', z);
}
// 咽音 / twang: judged against the singer's own plain glide at the same pitch, so
// the twang may be sung on any note of the glide. Twang per Sundberg & Thalén
// 2010: F1, F2 up, F3–F5 drawn together, firmer closure.
{
  const TWF = [{ f: 850, b: 70 }, { f: 1350, b: 80 }, { f: 2400, b: 90 }, { f: 2850, b: 90 }, { f: 3250, b: 110 }];
  const G = 0.3; // fixed gain: loudness differences between takes are kept
  const VV = { ...V, jitter: 0.003, shimmer: 0.03 };
  const say = (m, x, dur = 3) => [gap, { dur, f0: () => hz(m), ...VV, ...x }, gap];
  const plain = { vowel: VOWELS.a, oq: 0.55, sq: 2.4 }, twang = { vowel: TWF, oq: 0.42, sq: 3.0 }, shout = { vowel: VOWELS.a, oq: 0.4, sq: 3.2, amp: 2.5 };
  // the plain glide D3 → C4 → D3 (6 s), then quiet: it is judged once it's over
  const glide = (x) => [gap, { dur: 3, f0: lin(M - 3, M + 7, 3), ...VV, ...x }, { dur: 3, f0: lin(M + 7, M - 3, 3), ...VV, ...x }, { dur: 0.7 }];
  const TJ = (id, want, segs, label, ctx, extra = {}) => { const r = judge(S[id], P, segs, { ctx, gain: G, ...extra }); ok(`${id}: ${label}`, r.passed === want, `passed=${r.passed} score=${r.score} — ${r.hint}`); return r; };
  const b = TJ('twang.base', true, glide(plain), 'plain glide on “ah” → reference curve saved');
  const C = b.save?.base?.curve;
  ok('twang.base: the curve spans the glide', C && C.lo <= M - 2.5 && C.hi >= M + 6.5, C && `${C.lo}–${C.hi}, ${C.pts.length} points`);
  TJ('twang.base', false, [gap, { dur: 4, f0: lin(M, M + 3, 4), ...VV, ...plain }, gap], 'a glide of only 3 semitones → not yet');
  const ctx = { base: b.save.base };
  TJ('twang.twang', false, say(M + 2, twang), 'without step 1 → asks for the reference', {});
  // the point of the glide: twang on any note of it, against the plain voice there
  for (const m of [M - 1, M + 2, M + 4, M + 6]) TJ('twang.twang', true, say(m, twang), `twang on ${midiName(m)} → pass`, ctx);
  for (const m of [M - 1, M + 2, M + 4, M + 6]) TJ('twang.twang', false, say(m, plain), `plain on ${midiName(m)} → not twang`, ctx);
  const vib = (m) => (t) => hz(m + 0.4 * Math.sin(2 * Math.PI * 5.5 * t));
  TJ('twang.twang', true, [gap, { dur: 3, f0: vib(M + 3), ...VV, ...twang }, gap], 'twang with vibrato → pass', ctx);
  TJ('twang.twang', false, [gap, { dur: 3, f0: vib(M + 3), ...VV, ...plain }, gap], 'plain with vibrato → not twang', ctx);
  const sh = TJ('twang.twang', false, say(M + 4, shout), 'just louder → not twang (shouting)', ctx);
  ok('twang.twang: shouting is named', /喊/.test(sh.hint), sh.hint);
  const hard = TJ('twang.twang', false, say(M + 4, { vowel: VOWELS.a, oq: 0.3, sq: 5, amp: 4 }), 'hard shouting → still shouting', ctx);
  ok('twang.twang: hard shouting is named', /喊/.test(hard.hint), hard.hint);
  const br = TJ('twang.twang', false, say(M + 4, { vowel: VOWELS.a, oq: 0.7, sq: 2.0, noise: 0.6 }), 'breathy (air noise) → not twang', ctx);
  ok('twang.twang: breathiness is named', /漏气/.test(br.hint), br.hint);
  const sq = TJ('twang.twang', false, say(M + 2, { ...twang, jitter: 0.03, shimmer: 0.25, noise: 3 }), 'squeezed (rough) → not passed', ctx);
  ok('twang.twang: squeezing is named', /挤/.test(sq.hint), sq.hint);
  // the vocal folds' closure, against the plain voice at the same pitch
  const bt = TJ('twang.twang', false, say(M + 2, { vowel: TWF, oq: 0.7, sq: 2.0, noise: 0.5 }), 'breathy twang (folds not closing) → not passed', ctx);
  ok('twang.twang: air leaking is named', /漏气/.test(bt.hint) && !/挤了/.test(bt.hint), bt.hint);
  const pr = TJ('twang.twang', false, say(M + 2, { vowel: TWF, oq: 0.3, sq: 5.0, jitter: 0.02, shimmer: 0.15 }), 'squeezed twang (tight, irregular) → not passed', ctx);
  ok('twang.twang: squeezing is named', /挤了/.test(pr.hint), pr.hint);
  const fm_ = TJ('twang.twang', true, say(M + 2, { vowel: TWF, oq: 0.3, sq: 5.0 }), 'firm but regular closure (twang) → pass', ctx);
  ok('twang.twang: firm closure reported as closing well', fm_.parts?.some((p) => /闭合好/.test(p.text)), JSON.stringify(fm_.parts?.map((p) => p.text)));
  const out = TJ('twang.twang', false, say(M - 7, twang), 'twang below the glide → asks to stay in range', ctx);
  ok('twang.twang: the range is named', /范围/.test(out.hint), out.hint);
  const EH = [{ f: 530, b: 70 }, { f: 1840, b: 90 }, { f: 2480, b: 110 }, { f: 3400, b: 150 }, { f: 4100, b: 200 }];
  const EHT = [{ f: 610, b: 70 }, { f: 2100, b: 80 }, { f: 2450, b: 90 }, { f: 2850, b: 90 }, { f: 3250, b: 110 }]; // "eh" with twang
  const vc = TJ('twang.twang', false, say(M + 2, { ...twang, vowel: EHT }), 'reference "ah", twang on "eh" → vowel differs', ctx);
  ok('twang.twang: the vowel change is named', vc.hint.includes('元音和第 1 步不一样'), vc.hint);
  const be = judge(S['twang.base'], P, glide({ vowel: EH }), { gain: G });
  ok('twang.base on "eh": vowel recorded as 诶', be.passed && /诶/.test(be.hint), be.hint);
  TJ('twang.twang', true, say(M + 2, { ...twang, vowel: EHT }), 'reference "eh", twang on "eh" → pass', { base: be.save.base });

  // difficulty: a higher level asks for more ring (a tighter narrowing) and a longer hold
  const A = VOWELS.a, mix = (k) => A.map((f, i) => ({ f: f.f + (TWF[i].f - f.f) * k, b: f.b + (TWF[i].b - f.b) * k }));
  const light = { vowel: mix(0.6), oq: 0.42, sq: 3.0 };
  TJ('twang.twang', true, say(M + 4, light, 5), 'light twang (≈ +9 dB) → passes beginner', { ...ctx, level: 'easy' });
  TJ('twang.twang', false, say(M + 4, light, 5), 'light twang → not enough for standard', { ...ctx, level: 'std' });
  TJ('twang.twang', false, say(M + 4, light, 5), 'light twang → not enough for strict', { ...ctx, level: 'strict' });
  TJ('twang.twang', true, say(M + 2, twang, 5), 'clear twang (≈ +13 dB) held 4.7 s → passes strict', { ...ctx, level: 'strict' });
  TJ('twang.twang', false, say(M + 2, twang, 3), 'clear twang held only 2.7 s → strict wants 4 s', { ...ctx, level: 'strict' });
  const L3 = (await import('../js/analysis/twang.js')).levelOf('strict');
  ok('twang levels: pass rule shows the level’s numbers', S['twang.twang'].pass(L3).includes('≥ 12 dB') && S['twang.twang'].pass(L3).includes('4 秒'));

  // false passes found in review (Codex, 2026-10): none of these is twang
  const hum = (x) => x.map((v, i) => v + 0.003 * Math.sin((2 * Math.PI * 3100 * i) / sr));
  TJ('twang.twang', false, say(M + 2, plain), 'plain voice + a 3.1 kHz whine → not twang', ctx, { post: hum });
  TJ('twang.twang', false, [gap, { dur: 1.7, f0: () => hz(M + 2), ...VV, ...twang }, { dur: 1.3, f0: () => hz(M + 2), ...VV, ...plain }, gap], 'twang 1.4 s then plain on one note → no pass', ctx);
  for (const [what, broken] of [['the curve', { curve: null }], ['the vowel', { fm: null }], ['an old single-note reference', { curve: undefined, spr: 31, midi: 55 }]]) {
    const r = TJ('twang.twang', false, say(M + 2, twang), `reference without ${what} → no pass`, { base: { ...ctx.base, ...broken } });
    ok(`twang.twang: reference without ${what} → redo step 1`, /重做第 1 步/.test(r.hint), r.hint);
  }

  // nose pinched: compared with step 2 through the curve, so the note may differ
  const tw = judge(S['twang.twang'], P, say(M + 2, twang), { ctx, gain: G });
  const ctx2 = { ...ctx, twang: tw.save.twang };
  TJ('twang.pinch', true, say(M + 2, twang), 'nose pinched, same twang → oral, pass', ctx2);
  TJ('twang.pinch', true, say(M + 4, twang), 'nose pinched, same twang two semitones higher → pass', ctx2);
  const nz = TJ('twang.pinch', false, say(M + 2, { vowel: VOWELS.n, oq: 0.42, sq: 3.0 }), 'nose pinched, sound goes dull → nasal twang', ctx2);
  ok('twang.pinch: nasal twang is named', /鼻腔/.test(nz.hint), nz.hint);

  // the five notes, placed inside the glide, each against the plain voice at its pitch
  const SCL = S['twang.scale'].targets(P, ctx2);
  ok('twang.scale: the notes sit inside the glide', SCL.every((m) => m >= C.lo - 0.5 && m <= C.hi + 0.5), SCL.map(midiName).join(' '));
  const run = (x) => [gap, ...SCL.flatMap((m) => [{ dur: 0.5, f0: () => hz(m), ...VV, ...x }, { dur: 0.06 }]), gap];
  TJ('twang.scale', true, run(twang), 'twang on every note → pass', ctx2);
  TJ('twang.scale', false, run(plain), 'plain scale → twang lost', ctx2);
  const shs = TJ('twang.scale', false, run(shout), 'shouted scale → not twang', ctx2);
  ok('twang.scale: shouting named', /变响/.test(shs.hint), shs.hint);
  const badCurve = { ...ctx2.base, curve: { ...C, pts: C.pts.map((p, i) => (i === 3 ? { ...p, hbr: NaN } : p)) } };
  TJ('twang.scale', false, run(twang), 'a broken curve (NaN point) → no pass', { ...ctx2, base: badCurve });

  // what is stored: complete records of the current reference only
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)) };
  mem.set('vocalassistant.twang.v1', 'null');
  ok('twang store: stored null → empty, no crash', JSON.stringify(loadTwang()) === '{}');
  saveTwang({ base: b.save.base }); saveTwang({ twang: tw.save.twang });
  const L1 = loadTwang();
  ok('twang store: base and twang kept', !!(L1.base && L1.twang));
  saveTwang({ base: { ...b.save.base, at: b.save.base.at + 1 } });
  const L2 = loadTwang();
  ok('twang store: a new reference drops the old twang', !!L2.base && !L2.twang);
  mem.set('vocalassistant.twang.v1', JSON.stringify({ base: { midi: 55, spr: 31, vdb: -20, hnr: 20, bands: [0, 0, 0, 0, 0], fm: [730, 1150], at: 1 } }));
  ok('twang store: an old single-note reference is not used', !loadTwang().base);
  delete globalThis.localStorage;
}

console.log(fails ? `\n${fails} FAILED` : '\nall lesson checks passed');
process.exitCode = fails ? 1 : 0;
