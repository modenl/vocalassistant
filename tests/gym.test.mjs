// Run: node tests/gym.test.mjs — the pitch trainer: generated items stay in a
// comfortable range and never repeat; attempts (synthetic singing → analyzer →
// pitch tracker → judge) are judged right; the pass line adapts; the round
// summary finds tendencies.
import { FrameAnalyzer } from '../js/dsp/analyzer.js';
import { PitchTracker } from '../js/analysis/pitch.js';
import { DEFAULT_SETTINGS, VOICE_TYPES } from '../js/config.js';
import { synth, hz, VOWELS } from '../tools/synth.mjs';
import * as G from '../js/gym/drills.js';

const sr = 44100;
let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(58)} ${info}`); };
const rngOf = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// ------------------------------------------------------------------ items
for (const [name, P] of Object.entries(VOICE_TYPES)) {
  const R = G.rangeOf(P), rng = rngOf(7), st = G.newState();
  let bad = [], prev = null;
  for (let i = 0; i < 300; i++) {
    const it = G.makeItem('match', P, st, rng, prev);
    if (it.notes[0] < R.a || it.notes[0] > R.b) bad.push(`out ${it.notes[0]}`);
    if (prev && Math.abs(it.notes[0] - prev.notes[0]) < 2) bad.push(`close ${prev.notes[0]}→${it.notes[0]}`);
    prev = it;
  }
  ok(`${name}: matching notes within the octave ${R.a}–${R.b}, no near-repeats`, !bad.length && R.b - R.a === 12, bad.slice(0, 3).join(', '));
  bad = [];
  for (let stage = 1; stage <= G.DEGREE_STAGES.length; stage++) {
    st.degreeStage = stage;
    const pool = G.DEGREE_STAGES.slice(0, stage).flat();
    for (let i = 0; i < 100; i++) {
      const it = G.makeItem('degree', P, st, rng, prev);
      if (!pool.includes(it.off) || it.notes[0] - it.tonic !== it.off) bad.push(`deg ${it.off}`);
      if (Math.min(it.tonic, it.notes[0]) < R.lo || Math.max(it.tonic, it.notes[0]) > R.hi) bad.push(`range ${it.tonic}+${it.off}`);
      prev = it;
    }
  }
  ok(`${name}: degrees from the unlocked pool, do and target in range`, !bad.length, bad.slice(0, 3).join(', '));
  bad = [];
  for (let stage = 1; stage <= G.ECHO_STAGES.length; stage++) {
    st.echoStage = stage;
    for (let i = 0; i < 100; i++) {
      const it = G.makeItem('echo', P, st, rng, prev), n = it.notes;
      if (n.length !== G.ECHO_STAGES[stage - 1].len) bad.push(`len ${n.length}`);
      if (Math.min(...n) < R.lo || Math.max(...n) > R.hi) bad.push(`range ${n}`);
      if (n.some((m, j) => j && (m === n[j - 1] || Math.abs(m - n[j - 1]) === 6))) bad.push(`repeat/tritone ${n}`);
    }
  }
  ok(`${name}: echo patterns in range, no repeats or tritones`, !bad.length, bad.slice(0, 3).join(', '));
}
{
  let bad = 0;
  for (let s = 1; s <= 200; s++) {
    const r = G.planRound('mix', rngOf(s));
    const c = (k) => r.filter((x) => x === k).length;
    if (r.length !== 10 || c('match') !== 4 || c('degree') !== 3 || c('echo') !== 3 || r.some((x, i) => i >= 2 && x === r[i - 1] && x === r[i - 2])) bad++;
  }
  ok('a mixed round: 4 / 3 / 3, never the same kind 3 times running', !bad, `${bad} bad of 200`);
}

// ------------------------------------------------------------------ judging
const V = { oq: 0.55, sq: 2.4, vowel: VOWELS.a, jitter: 0.002, shimmer: 0.02 };
const lvl = (m) => Math.pow(2, -(m - 48) / 12);
const hold = (m, dur, x = {}) => ({ dur, f0: () => hz(m), ...V, amp: lvl(m), ...x });
const quiet = (dur) => ({ dur });
const vib = (m, c) => (t) => hz(m + (c / 100) * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3));
const scoop = (m, depth = 1.5, d = 0.12) => (t) => hz(m - depth * Math.max(0, 1 - t / d));
function legato(ms, noteDur, port = 0.07, vibc = 0) {
  const f0 = (t) => {
    const i = Math.min(ms.length - 1, Math.floor(t / noteDur)), u = t - i * noteDur, p = i ? ms[i - 1] : ms[0];
    const m = u < port ? p + (ms[i] - p) * (0.5 - 0.5 * Math.cos((Math.PI * u) / port)) : ms[i];
    return hz(m + (vibc / 100) * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3));
  };
  return { ...hold(ms[0], ms.length * noteDur), f0, amp: lvl(ms[0]) };
}
function framesOf(segs) {
  const x = Float32Array.from(synth(segs, sr));
  const an = new FrameAnalyzer(sr), pt = new PitchTracker(DEFAULT_SETTINGS), out = [];
  for (let end = an.N; end <= x.length; end += 1024) {
    const t = (end - an.N / 2) / sr;
    out.push(pt.update(an.analyze(x.subarray(end - an.N, end), { gateDb: -52, pitchOnly: true }), t));
  }
  return out;
}
// as the page does: ask every ~0.1 s until decided (silence continues after the clip)
function attempt(item, segs, tol = 50, opts = {}) {
  const fr = framesOf(segs);
  for (let i = 0; i < fr.length; i += 4) {
    const res = G.judge(item, fr.slice(0, i + 1), 0, fr[i].t, tol, opts);
    if (res) return { res, at: fr[i].t };
  }
  const end = fr[fr.length - 1].t;
  for (let now = end; now < end + 12; now += 0.1) {
    const res = G.judge(item, fr, 0, now, tol, opts);
    if (res) return { res, at: now };
  }
  return { res: null, at: NaN };
}
const dv = (r) => r.res?.notes?.map((n) => Math.round(n.dev)).join(' ');
const J = (label, item, segs, want, tol, opts, extra = () => true) => {
  const r = attempt(item, segs, tol, opts);
  ok(label, !!r.res && r.res.ok === want && extra(r), `ok=${r.res?.ok} dev=${dv(r)} at ${r.at?.toFixed(2)} s — ${r.res ? G.resultText(item, r.res) : 'undecided'}`);
  return r;
};

const M = 53; // F3, baritone
const match = { kind: 'match', notes: [M], ref: [M], bin: 'mid' };
J('match: in tune', match, [quiet(0.3), hold(M, 1.5), quiet(0.5)], true, 50, {}, (r) => Math.abs(r.res.notes[0].dev) < 10);
J('match: decided ~1 s after the note starts', match, [quiet(0.3), hold(M, 3)], true, 50, {}, (r) => r.at < 0.3 + 1.2);
J('match: 40 cents flat passes at ±50', match, [quiet(0.3), hold(M - 0.4, 1.5)], true, 50, {}, (r) => Math.abs(r.res.notes[0].dev + 40) < 8);
J('match: 40 cents flat fails at ±25', match, [quiet(0.3), hold(M - 0.4, 1.5)], false, 25);
J('match: an octave lower counts', match, [quiet(0.3), hold(M - 12, 1.5)], true, 50, {}, (r) => r.res.oct === -1);
J('match: a scoop at the onset is skipped', match, [quiet(0.3), { ...hold(M, 1.5), f0: scoop(M) }], true, 25, {}, (r) => Math.abs(r.res.notes[0].dev) < 15);
J('match: ±50 cents vibrato, centre in tune', match, [quiet(0.3), { ...hold(M, 1.6), f0: vib(M, 50) }], true, 25, {}, (r) => Math.abs(r.res.notes[0].dev) < 12);
J('match: a 0.2 s false start is ignored', match, [quiet(0.3), hold(M + 3, 0.2), quiet(0.4), hold(M, 1.5)], true, 50, {}, (r) => Math.abs(r.res.notes[0].dev) < 10);
J('match: a short note (0.6 s) is judged when it ends', match, [quiet(0.3), hold(M + 0.3, 0.6), quiet(1)], true, 50, {}, (r) => Math.abs(r.res.notes[0].dev - 30) < 10);
{
  const r = attempt(match, [quiet(9)]);
  ok('match: silence → no answer after 7 s', r.res?.noAnswer && r.at >= 7 && r.at < 7.3, `at ${r.at?.toFixed(2)}`);
}

const deg = { kind: 'degree', tonic: M, off: 4, notes: [M + 4], ref: [M] };
J('degree: mi sung in tune', deg, [quiet(0.3), hold(M + 4, 1.4)], true, 50, {}, (r) => r.res.intervals[0].size === 4);
J('degree: re instead of mi → "more like re"', deg, [quiet(0.3), hold(M + 2, 1.4)], false, 50, {}, (r) => /re/.test(G.resultText(deg, r.res)));
J('degree: mi an octave below → wrong octave', deg, [quiet(0.3), hold(M - 8, 1.4)], false, 50, {}, (r) => r.res.octaveErr);
J('degree: … unless the singer always answers an octave down', deg, [quiet(0.3), hold(M - 8, 1.4)], true, 50, { habit: -1 });
const hiDo = { kind: 'degree', tonic: M, off: 12, notes: [M + 12], ref: [M] };
J('degree: high do is never do itself', hiDo, [quiet(0.3), hold(M, 1.4)], false, 50, { habit: -1 }, (r) => r.res.octaveErr);

const pat = [M, M + 4, M + 2, M + 7];
const echo = { kind: 'echo', notes: pat, ref: pat };
const detached = (ms, d = 0.5, g = 0.15, x = () => ({})) => [quiet(0.3), ...ms.flatMap((m, i) => [hold(m, d, x(m, i)), quiet(g)]), quiet(0.2)];
J('echo: 4 notes, detached, in tune', echo, detached(pat), true, 25, {}, (r) => r.res.notes.every((n) => Math.abs(n.dev) < 12));
J('echo: 4 notes, legato with glides', echo, [quiet(0.3), legato(pat, 0.55), quiet(0.3)], true, 25);
J('echo: legato with ±40 cents vibrato', echo, [quiet(0.3), legato(pat, 0.6, 0.07, 40), quiet(0.3)], true, 35);
J('echo: each note scooped from below', echo, detached(pat, 0.55, 0.15, (m) => ({ f0: scoop(m, 1) })), true, 35);
J('echo: the whole pattern an octave lower', echo, detached(pat.map((m) => m - 12)), true, 25, {}, (r) => r.res.oct === -1);
J('echo: third note 60 cents flat', echo, detached(pat.map((m, i) => (i === 2 ? m - 0.6 : m))), false, 50, {}, (r) => /3/.test(G.resultText(echo, r.res)));
J('echo: a note left out', echo, detached([M, M + 2, M + 7]), false, 50);
J('echo: slow singing with pauses still waits for all 4', echo, detached(pat, 0.6, 1.1), true, 25);
{
  const r = attempt({ kind: 'echo', notes: [M, M + 7], ref: [M, M + 7] }, detached([M, M + 6.6]));
  ok('echo: the leap\'s interval error is measured', r.res && Math.abs(r.res.intervals[0].err + 40) < 10 && r.res.intervals[0].size === 7, `err=${r.res?.intervals[0]?.err?.toFixed(0)}`);
}
{
  const runs = (segs) => G.runsFrom(framesOf(segs), 0);
  const c = [G.countNotes(runs(detached(pat))), G.countNotes(runs([quiet(0.3), legato(pat, 0.55), quiet(0.3)])),
    G.countNotes(runs([quiet(0.3), { ...hold(M, 1.2), f0: scoop(M, 2, 0.15) }, quiet(0.3)])), G.countNotes(runs([quiet(0.3), { ...hold(M, 1.6), f0: vib(M, 50) }, quiet(0.3)]))];
  ok('counting notes: detached 4, legato 4, one scooped note 1, vibrato note 1', c.join() === '4,4,1,1', c.join());
}

// ------------------------------------------------------------------ adapting
{
  const st = G.newState(), it = { kind: 'match', notes: [M], bin: 'mid' };
  const pass = { ok: true, notes: [{ dev: 5 }], intervals: [], oct: 0 }, miss = { ok: false, notes: [{ dev: 70 }], intervals: [], oct: 0 };
  const lv = [];
  for (const r of [pass, pass, pass, pass, pass, pass, miss, pass]) { G.record(st, it, r); lv.push(G.tolOf(st, 'match')); }
  ok('pass line: 3 passes → tighter, a miss → looser', lv.join() === '50,50,35,35,35,25,35,35', lv.join());
  const st2 = G.newState(), d = { kind: 'degree', off: 4, notes: [57] };
  let ev = {};
  for (const r of [pass, pass, miss, pass, pass]) ev = G.record(st2, d, { ...r, notes: [{ dev: r.ok ? 5 : 70 }] });
  ok('degrees: 4 of 5 within ±50 cents unlock the next ones', st2.degreeStage === 2 && ev.unlocked === 'degree', `stage ${st2.degreeStage}`);
  const st3 = G.newState();
  st3.level.match = 1;
  for (let i = 0; i < 8; i++) ev = G.record(st3, it, i % 4 === 3 ? miss : pass);
  const blind = st3.fb;
  for (let i = 0; i < 6; i++) G.record(st3, it, i < 4 ? miss : pass);
  ok('feedback: after-singing once 6 of 8 pass; back to live after misses', blind === 'blind' && st3.fb === 'live', `${blind} → ${st3.fb}`);
  const st4 = G.newState();
  for (const o of [-1, -1, 0, -1, -1, -1]) G.record(st4, it, { ...pass, oct: o });
  ok('the octave the singer usually answers in', G.habitOf(st4) === -1 && G.habitOf(G.newState()) === 0);
  const st5 = G.restore({ v: 1, level: { match: 2 }, rounds: [{ ok: 7 }] });
  ok('saved state restores (missing parts filled in)', st5.level.match === 2 && st5.level.echo === 0 && st5.rounds.length === 1 && st5.prefs.kinds === 'mix');
}

// ------------------------------------------------------------------ summary
{
  const P = VOICE_TYPES.baritone;
  const R = (item, devs, okv = true) => ({ item, res: { ok: okv, notes: devs.map((d, i) => ({ target: item.notes[i], dev: d })), intervals: devs.slice(1).map((d, i) => ({ size: item.notes[i + 1] - item.notes[i], err: d - devs[i] })) } });
  const m = (n) => ({ kind: 'match', notes: [n] });
  const flat = [R(m(50), [-30]), R(m(53), [-25]), R(m(56), [-35]), R(m(58), [-20]), R(m(51), [-28]), R(m(55), [5])];
  const S = G.summarize(flat, P);
  ok('summary: flat overall is found', S.findings.some((f) => f.key === 'flat') && S.n === 6 && S.ok === 6, JSON.stringify(S.findings));
  const e = (ns) => ({ kind: 'echo', notes: ns });
  const comp = [R(e([50, 57, 50]), [0, -40, 0]), R(e([52, 45, 52]), [0, 45, 5]), R(e([48, 57, 55]), [0, -35, -30])];
  const S2 = G.summarize(comp, P);
  ok('summary: big leaps sung smaller are found', S2.findings.some((f) => f.key === 'compress'), JSON.stringify(S2.findings));
  const dg = (off, okv) => ({ item: { kind: 'degree', off, notes: [53 + off] }, res: { ok: okv, notes: [{ target: 53 + off, dev: okv ? 5 : 80 }], intervals: [] } });
  const S3 = G.summarize([dg(9, false), dg(9, false), dg(4, true), dg(7, true)], P);
  ok('summary: the degree missed most', S3.findings.some((f) => f.key === 'degree' && f.off === 9), JSON.stringify(S3.findings));
  const none = G.summarize([R(m(50), [5]), R(m(53), [-8]), R(m(56), [3])], P);
  ok('summary: nothing flagged from a few good notes', !none.findings.length && none.within50 === 1, JSON.stringify(none));
  const two = G.summarize([R(m(50), [0]), R(m(53), [5]), R(m(56), [-3]), R(e([50, 52, 54]), [70, 70, 70], false), R(m(58), [70], false), R(m(51), [2]), R(m(55), [-4])], P);
  ok('summary: two sharp items are not "sharp overall"', !two.findings.some((f) => f.key === 'sharp'), JSON.stringify(two.findings));
  const shifted = G.resultText(e([50, 52, 54]), { ok: false, tol: 50, notes: [{ dev: 68 }, { dev: 72 }, { dev: 70 }], intervals: [] });
  ok('echo: all notes off alike → "the first note was off"', /整体偏高 70/.test(shifted), shifted);
}

console.log(fails ? `\n${fails} FAILED` : '\nall pitch-trainer checks passed');
process.exitCode = fails ? 1 : 0;
