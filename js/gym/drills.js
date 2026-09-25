// Pitch trainer: auto-generated sing-back drills with an adaptive pass line.
// Pure logic — no DOM or audio — so it runs in Node tests.
//
// Three kinds, interleaved:
//   match  — hear a note, sing it back (random notes over an octave)
//   degree — hear do, sing another scale degree (mi, sol, la…)
//   echo   — hear a 3–4 note pattern, sing it back
// Why (details in README): singing out of tune is mostly a mapping problem
// between hearing and the voice, not hearing itself (Pfordresher & Brown 2007;
// Hutchins & Peretz 2012), so every drill is a sing-back. Training over an
// octave improved matching where training within a fifth didn't (Pfordresher
// & Greenspon 2025), and mixed practice is retained better than blocked
// (Stambaugh 2011): random targets over a wide range, kinds mixed. A live pitch
// display helps (Berglin et al. 2022) but learners come to depend on it (Paney
// & Tharp 2021): once accuracy holds, the trace is shown only after singing.

import { L as tr } from '../i18n.js';

export const TOLS = [50, 35, 25, 15]; // pass line (cents) per level
export const KINDS = ['match', 'degree', 'echo'];
export const MAX_WAIT = 7; // s without singing → no answer

const median = (a) => {
  const v = [...a].sort((x, y) => x - y), n = v.length;
  return !n ? NaN : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
};
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const cap = (d, c = 150) => Math.max(-c, Math.min(c, d));
const inOctave = (midi, target) => target + 12 * Math.round((midi - target) / 12);
const randInt = (a, b, rng) => a + Math.floor(rng() * (b - a + 1));
function pick(items, weights, rng) {
  let r = rng() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
}
const push = (arr, v, n) => { arr.push(v); while (arr.length > n) arr.shift(); };

// ------------------------------------------------------------------ what to sing
// Targets: an octave around the voice type's middle note (a…b), and at most
// lo…hi for patterns — 3 semitones inside the low end, 4 inside the high end.
export function rangeOf(P) {
  const lo = P.low + 3, hi = P.high - 4;
  const b = Math.min(hi, Math.max(lo, P.mid - 5) + 12);
  return { lo, hi, a: Math.max(lo, b - 12), b };
}
const binOf = (m, R) => (m <= R.a + 3 ? 'low' : m >= R.b - 3 ? 'high' : 'mid');

// Scale degrees relative to do (semitones), unlocked in this order: the major
// triad first (as in Kodály teaching), then the rest, then below do.
export const DEGREE_STAGES = [[4, 7], [2, 9], [5, 12], [11, -5], [-3, -1]];
const DEG = { 0: ['do', '1'], 2: ['re', '2'], 4: ['mi', '3'], 5: ['fa', '4'], 7: ['sol', '5'], 9: ['la', '6'], 11: ['ti', '7'] };
// "mi (3)", "low sol (5̣)", "high do (1̇)" — numbered notation marks octaves with dots
export function degreeName(off) {
  const d = DEG[((off % 12) + 12) % 12];
  if (!d) return null;
  const [n, num] = d;
  if (off < 0) return tr(`低音 ${n}（${num}̣）`, `low ${n} (${num}̣)`);
  if (off >= 12) return tr(`高音 ${n}（${num}̇）`, `high ${n} (${num}̇)`);
  return tr(`${n}（${num}）`, `${n} (${num})`);
}

// Echo patterns from the major scale, low sol … high do (index 3 = do):
// length, the part of the scale used, the largest step (in scale steps).
const SCALE = [-5, -3, -1, 0, 2, 4, 5, 7, 9, 11, 12];
export const ECHO_STAGES = [
  { len: 3, from: 3, to: 7, maxStep: 2 },  // do…sol; steps and thirds
  { len: 4, from: 1, to: 8, maxStep: 3 },  // low la…la; up to a fourth
  { len: 4, from: 0, to: 10, maxStep: 5 }, // low sol…high do; up to a sixth
];
export const intClass = (size) => `${Math.abs(size) >= 3 ? 'leap' : 'step'}${size > 0 ? 'Up' : 'Down'}`;

function pattern(S, rng) {
  const starts = [3, 5, 7].filter((i) => i >= S.from && i <= S.to); // start on do, mi or sol
  const idx = [starts[Math.floor(rng() * starts.length)]];
  while (idx.length < S.len) {
    const cur = idx[idx.length - 1], opts = [], w = [];
    for (let s = -S.maxStep; s <= S.maxStep; s++) {
      const j = cur + s;
      if (!s || j < S.from || j > S.to || Math.abs(SCALE[j] - SCALE[cur]) === 6) continue; // no tritones
      opts.push(j); w.push(Math.abs(s) === 1 ? 3 : Math.abs(s) === 2 ? 2 : 1); // mostly steps
    }
    idx.push(pick(opts, w, rng));
  }
  return idx.map((i) => SCALE[i]);
}

// Drill what goes wrong: weight = 1 + recent mean error / 25 cents (≤ 5); unknown 1.5.
const weightOf = (errs) => (errs?.length ? 1 + Math.min(4, mean(errs) / 25) : 1.5);

// An item: { kind, ref: notes played, notes: notes to sing, … }. st: trainer
// state (stages, recent errors); prev: the previous item (targets don't repeat).
export function makeItem(kind, P, st, rng = Math.random, prev = null) {
  const R = rangeOf(P);
  const last = prev ? prev.notes[prev.notes.length - 1] : null;
  if (kind === 'match') {
    const bins = { low: [R.a, R.a + 3], mid: [R.a + 4, R.b - 4], high: [R.b - 3, R.b] };
    const names = Object.keys(bins);
    const bin = pick(names, names.map((n) => weightOf(st.err.bin[n])), rng);
    let m = randInt(...bins[bin], rng);
    for (let k = 0; k < 20 && last != null && Math.abs(m - last) < 2; k++) m = randInt(...bins[bin], rng);
    return { kind, ref: [m], notes: [m], bin };
  }
  if (kind === 'degree') {
    const pool = DEGREE_STAGES.slice(0, st.degreeStage).flat();
    const off = pick(pool, pool.map((o) => weightOf(st.err.deg[o])), rng);
    // do and the target both inside lo…hi
    let t0 = Math.max(R.lo, R.lo - off), t1 = Math.min(R.hi, R.hi - off);
    if (t0 > t1) t0 = t1 = Math.min(Math.max(P.mid, R.lo - Math.min(0, off)), R.hi - Math.max(0, off));
    let tonic = randInt(t0, t1, rng);
    for (let k = 0; k < 10 && t1 > t0 && (tonic === prev?.tonic || tonic + off === last); k++) tonic = randInt(t0, t1, rng);
    return { kind, ref: [tonic], notes: [tonic + off], tonic, off };
  }
  const S = ECHO_STAGES[st.echoStage - 1];
  const cands = Array.from({ length: 6 }, () => pattern(S, rng));
  const offs = pick(cands, cands.map((o) => o.slice(1).reduce((a, x, i) => a + weightOf(st.err.int[intClass(x - o[i])]), 0)), rng);
  const lo = Math.min(...offs), hi = Math.max(...offs);
  let t0 = R.lo - lo, t1 = R.hi - hi;
  if (t0 > t1) t0 = t1 = Math.round((t0 + t1) / 2);
  const tonic = randInt(t0, t1, rng);
  const notes = offs.map((o) => tonic + o);
  return { kind, ref: notes, notes, tonic, offs };
}

// Ten items; mixed: 4 matching, 3 degrees, 3 echoes, shuffled, never the
// same kind three times running.
export function planRound(kinds = 'mix', rng = Math.random) {
  if (kinds !== 'mix') return Array(10).fill(kinds);
  const bag = ['match', 'match', 'match', 'match', 'degree', 'degree', 'degree', 'echo', 'echo', 'echo'];
  for (let tries = 0; ; tries++) {
    for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    if (tries > 50 || !bag.some((x, i) => i >= 2 && x === bag[i - 1] && x === bag[i - 2])) return bag.slice();
  }
}

// ------------------------------------------------------------------ judging
// frames: pitch-tracker states { t, voiced, midi }. Only frames at or after
// `from` count (the reference and its echo are over by then).

// voiced stretches (gaps ≤ 0.1 s)
export function runsFrom(frames, from) {
  const out = [];
  let cur = null, lastT = -Infinity;
  for (const f of frames) {
    if (f.t < from || !f.voiced || !Number.isFinite(f.midi)) continue;
    if (cur && f.t - lastT <= 0.1) cur.push(f);
    else { cur = [f]; out.push(cur); }
    lastT = f.t;
  }
  return out;
}

// The first note of ≥ 0.35 s since `from` (shorter sounds are false starts).
// Its pitch: the median from 0.15 s after its start — a scoop or a search at
// the onset doesn't count — to 1 s. Undecided (null) until the note has lasted
// 1 s or ended (0.25 s of silence).
export function firstNote(frames, from, now) {
  for (const r of runsFrom(frames, from)) {
    const t0 = r[0].t, t1 = r[r.length - 1].t, d = t1 - t0, ended = now - t1 >= 0.25;
    if (d < 0.35) { if (ended) continue; return null; }
    if (d < 1 && !ended) return null;
    const s = t0 + Math.min(0.15, 0.3 * d), e = Math.min(t1, t0 + 1);
    return { midi: median(r.filter((f) => f.t >= s && f.t <= e).map((f) => f.midi)), t0, t1: e };
  }
  return null;
}

// Notes in some singing: a new note after a pause, or when the pitch
// (averaged over 0.2 s — one vibrato cycle) moves ≥ 0.6 semitone from the
// current note for ≥ 0.06 s. A note's pitch is taken 0.1–0.25 s after its
// start, once a scoop has settled, so a scoop is not a note of its own.
// A last note under 0.12 s doesn't count.
export function countNotes(runs) {
  let n = 0;
  for (const r of runs) {
    let st = 0, a = 0, s = 0, ref = NaN, away = -1;
    for (let i = 0; i < r.length; i++) {
      s += r[i].midi;
      while (r[i].t - r[a].t > 0.2) s -= r[a++].midi;
      const m = s / (i - a + 1), t0 = r[st].t;
      if (!Number.isFinite(ref)) {
        if (r[i].t - t0 >= 0.25) ref = median(r.slice(st, i + 1).filter((f) => f.t - t0 >= 0.1).map((f) => f.midi));
        continue;
      }
      if (Math.abs(m - ref) < 0.6) { away = -1; continue; }
      if (away < 0) away = i;
      if (r[i].t - r[away].t >= 0.06) {
        n++; // the note that just ended
        st = a = away; ref = NaN; away = -1;
        s = 0;
        for (let j = a; j <= i; j++) s += r[j].midi; // the average restarts with the new note
      }
    }
    if (r[r.length - 1].t - r[st].t >= 0.12) n++;
  }
  return n;
}

// Split pitches into k consecutive notes (≥ minLen frames each) so each note
// varies least (least squares, dynamic programming). Returns k + 1 cut indices.
export function segment(ms, k, minLen = 4) {
  const n = ms.length, S = [0], Q = [0];
  for (const m of ms) { S.push(S[S.length - 1] + m); Q.push(Q[Q.length - 1] + m * m); }
  const cost = (i, j) => { const s = S[j] - S[i]; return Q[j] - Q[i] - (s * s) / (j - i); };
  const D = Array.from({ length: k + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const B = Array.from({ length: k + 1 }, () => new Int32Array(n + 1));
  D[0][0] = 0;
  for (let q = 1; q <= k; q++) {
    for (let j = q * minLen; j <= n; j++) {
      for (let i = (q - 1) * minLen; i <= j - minLen; i++) {
        const v = D[q - 1][i] + cost(i, j);
        if (v < D[q][j]) { D[q][j] = v; B[q][j] = i; }
      }
    }
  }
  const cuts = [n];
  for (let q = k, j = n; q >= 1; q--) { j = B[q][j]; cuts.unshift(j); }
  return cuts;
}

// Judge an attempt; null while still listening. Result:
// { ok, tol, notes: [{ target, sung, dev (cents) }], intervals: [{ size
// (semitones), err (cents) }], noAnswer?, octaveErr?, countErr? }.
// habit: the octave the singer tends to answer in (matching items), so a
// degree sung an octave down by someone who always does counts too.
export function judge(item, frames, from, now, tol, { habit = 0 } = {}) {
  if (item.kind === 'echo') return judgeEcho(item, frames, from, now, tol);
  const n = firstNote(frames, from, now);
  if (!n) {
    const r = runsFrom(frames, from), singing = r.length && now - r[r.length - 1].at(-1).t < 0.25;
    return now - from >= MAX_WAIT + (singing ? 2 : 0) ? { ok: false, noAnswer: true, tol, notes: [], intervals: [] } : null;
  }
  const T = item.notes[0];
  if (item.kind === 'match') {
    // any octave counts, as in pitch-matching research
    const tt = inOctave(n.midi, T), dev = (n.midi - tt) * 100;
    return { ok: Math.abs(dev) <= tol, tol, notes: [{ target: T, sung: n.midi, dev, t0: n.t0, t1: n.t1 }], intervals: [], oct: Math.round((tt - T) / 12) };
  }
  // degree: above / below do is part of the task; a habitual octave counts
  // (not for high do, which would then be do itself)
  const cands = item.off % 12 && habit ? [T, T + 12 * habit] : [T];
  const near = cands.reduce((a, c) => (Math.abs(n.midi - c) < Math.abs(n.midi - a) ? c : a));
  const dev = (n.midi - near) * 100;
  const octaveErr = Math.abs(dev) > tol && Math.abs(n.midi - inOctave(n.midi, T)) * 100 <= tol;
  return { ok: Math.abs(dev) <= tol, tol, notes: [{ target: T, sung: n.midi, dev, t0: n.t0, t1: n.t1 }], intervals: octaveErr ? [] : [{ size: item.off, err: dev }], octaveErr };
}

// Echo: listens until the notes are sung and the singer stops (0.5 s quiet
// after enough notes, 1.5 s otherwise, or K × 0.9 + 2.5 s in all). The whole
// pattern may be in another octave; each note must be within the pass line.
function judgeEcho(item, frames, from, now, tol) {
  const K = item.notes.length;
  const runs = runsFrom(frames, from).filter((r) => r[r.length - 1].t - r[0].t >= 0.08 || now - r[r.length - 1].t < 0.1);
  if (!runs.length) return now - from >= MAX_WAIT ? { ok: false, noAnswer: true, tol, notes: [], intervals: [] } : null;
  const first = runs[0][0].t, quiet = now - runs[runs.length - 1].at(-1).t;
  const count = countNotes(runs);
  if (!((count >= K && quiet >= 0.5) || quiet >= 1.5 || now - first >= K * 0.9 + 2.5)) return null;
  const fr = runs.flat();
  if (fr.length < K * 4) return { ok: false, tol, notes: [], intervals: [], countErr: { sung: count, need: K } };
  const cuts = segment(fr.map((f) => f.midi), K, 4);
  const centres = [], spans = [];
  for (let i = 0; i < K; i++) {
    const seg = fr.slice(cuts[i], cuts[i + 1]), trim = Math.floor(seg.length * 0.2);
    centres.push(median(seg.slice(trim, seg.length - trim).map((f) => f.midi)));
    spans.push([seg[0].t, seg[seg.length - 1].t]);
  }
  const k = Math.round(median(centres.map((c, i) => c - item.notes[i])) / 12);
  const notes = centres.map((c, i) => ({ target: item.notes[i], sung: c, dev: (c - item.notes[i] - 12 * k) * 100, t0: spans[i][0], t1: spans[i][1] }));
  const intervals = notes.slice(1).map((x, i) => ({ size: x.target - notes[i].target, err: x.dev - notes[i].dev }));
  // fewer notes than asked: two neighbours came out as one pitch
  const merged = count < K && centres.some((c, i) => i > 0 && Math.abs(c - centres[i - 1]) < 0.4);
  return { ok: !merged && notes.every((x) => Math.abs(x.dev) <= tol), tol, notes, intervals, oct: k, countErr: merged ? { sung: count, need: K } : null };
}

// While singing with the live trace: how far the current note is from the target.
export function liveDev(item, frames, from, now, habit = 0) {
  const r = runsFrom(frames, from), run = r[r.length - 1];
  if (!run || now - run[run.length - 1].t > 0.15 || run[run.length - 1].t - run[0].t < 0.15) return null;
  const m = median(run.filter((f) => run[run.length - 1].t - f.t <= 0.3).map((f) => f.midi));
  if (item.kind === 'echo') return { count: countNotes(r) };
  const T = item.notes[0];
  if (item.kind === 'match') return { dev: (m - inOctave(m, T)) * 100 };
  const cands = item.off % 12 && habit ? [T, T + 12 * habit] : [T];
  return { dev: (m - cands.reduce((a, c) => (Math.abs(m - c) < Math.abs(m - a) ? c : a))) * 100 };
}

// ------------------------------------------------------------------ texts
const cents = (d) => `${Math.round(Math.abs(d))} ${tr('音分', 'cents')}`;
export function devText(dev) {
  const a = Math.abs(dev);
  if (a < 5) return tr('正中', 'dead on');
  if (a >= 100) {
    const s = Math.round(a / 50) / 2;
    return dev < 0 ? tr(`低了 ${s} 个半音`, `${s} semitone${s === 1 ? '' : 's'} flat`) : tr(`高了 ${s} 个半音`, `${s} semitone${s === 1 ? '' : 's'} sharp`);
  }
  return dev < 0 ? tr(`偏低 ${cents(dev)}`, `${cents(dev)} flat`) : tr(`偏高 ${cents(dev)}`, `${cents(dev)} sharp`);
}

export const KIND_NAME = { match: tr('随机跟唱', 'Match'), degree: tr('听一唱二', 'Hear do, sing another'), echo: tr('回声短句', 'Echo') };

// What to do, shown while the item runs.
export function taskText(item) {
  if (item.kind === 'match') return tr('听一个音，唱出同一个音', 'Hear a note and sing it back');
  if (item.kind === 'degree') return tr(`听 do，唱 <b>${degreeName(item.off)}</b>`, `Hear do, sing <b>${degreeName(item.off)}</b>`);
  return tr(`听 ${item.notes.length} 个音，照着唱回来`, `Hear ${item.notes.length} notes and sing them back`);
}

// One line about an attempt.
export function resultText(item, res) {
  if (res.noAnswer) return tr('没听到你唱', 'Didn’t hear you sing');
  if (item.kind === 'match') return res.ok ? tr(`✓ 准（${devText(res.notes[0].dev)}）`, `✓ In tune (${devText(res.notes[0].dev)})`) : `✗ ${devText(res.notes[0].dev)}`;
  if (item.kind === 'degree') {
    const name = degreeName(item.off), d = res.notes[0].dev;
    if (res.ok) return tr(`✓ ${name} 唱准了（${devText(d)}）`, `✓ ${name} in tune (${devText(d)})`);
    if (res.octaveErr) return tr(`✗ 音对了，但差了一个八度——${item.off > 0 ? '要唱在 do 的上方' : '要唱在 do 的下方'}`, `✗ Right note, wrong octave — sing it ${item.off > 0 ? 'above' : 'below'} do`);
    const sang = Math.abs(d) >= 150 ? degreeName(Math.round(item.off + d / 100)) : null;
    return `✗ ${name} ${devText(d)}${sang ? tr(`（更像 ${sang}）`, ` (more like ${sang})`) : ''}`;
  }
  if (res.countErr) return tr(`✗ 只听到 ${res.countErr.sung} 个音，要唱 ${res.countErr.need} 个`, `✗ Heard ${res.countErr.sung} note${res.countErr.sung === 1 ? '' : 's'}; sing all ${res.countErr.need}`);
  if (res.ok) return tr(`✓ ${res.notes.length} 个音都准`, `✓ All ${res.notes.length} notes in tune`);
  // every note off by about the same: the intervals were right, the start wasn't
  const devs = res.notes.map((x) => x.dev), shift = mean(devs);
  if (Math.max(...devs) - Math.min(...devs) <= 30 && Math.abs(shift) > res.tol) {
    return tr(`✗ 整体${devText(shift)}：音和音之间的距离都对，是起音就${shift < 0 ? '低' : '高'}了——先把第一个音对准`,
      `✗ All ${devText(shift)}: the steps between notes were right, the first note wasn’t — tune the first note`);
  }
  const bad = res.notes.map((x, i) => ({ ...x, i })).filter((x) => Math.abs(x.dev) > res.tol);
  const w = bad.reduce((a, x) => (Math.abs(x.dev) > Math.abs(a.dev) ? x : a));
  return tr(`✗ 第 ${w.i + 1} 个音${devText(w.dev)}${bad.length > 1 ? `（还有 ${bad.length - 1} 个音也没唱准）` : ''}`,
    `✗ Note ${w.i + 1}: ${devText(w.dev)}${bad.length > 1 ? ` (${bad.length - 1} more off)` : ''}`);
}

// ------------------------------------------------------------------ state
export function newState() {
  return {
    v: 1,
    level: { match: 0, degree: 0, echo: 0 },  // index into TOLS
    streak: { match: 0, degree: 0, echo: 0 }, // passes in a row at this level
    degreeStage: 1, echoStage: 1,
    stageLog: { degree: [], echo: [] },       // within ±50 cents, per item at this stage
    err: { bin: {}, deg: {}, int: {} },       // recent errors (cents): what to drill more
    recent: [],                               // last answered items { k, ok } (feedback fade)
    octs: [],                                 // octave chosen on matching items
    fb: 'live',                               // automatic feedback: 'live' → 'blind'
    rounds: [],                               // round summaries
    prefs: { kinds: 'mix', feedback: 'auto' },
  };
}

// fill in anything missing (older saves)
export function restore(saved) {
  const st = newState();
  if (!saved || saved.v !== 1) return st;
  for (const k of Object.keys(st)) if (k in saved) st[k] = typeof st[k] === 'object' && !Array.isArray(st[k]) ? { ...st[k], ...saved[k] } : saved[k];
  return st;
}

export const tolOf = (st, kind) => TOLS[st.level[kind]];
// the octave the singer answers in: the usual one on the last matching items
export function habitOf(st) {
  const o = st.octs.slice(-8);
  for (const k of [-1, 1]) if (o.filter((x) => x === k).length >= 5) return k;
  return 0;
}
export const feedbackOf = (st) => (st.prefs.feedback === 'auto' ? st.fb : st.prefs.feedback);

// After an attempt: the pass line (3 passes in a row → tighter, a miss →
// looser — settles near 80 % passes), unlocks (4 of the last 5 items of a stage
// within ±50 cents), recent errors, the feedback fade (live → after-singing
// once 6 of the last 8 pass at ±35 cents or tighter; back after 4 misses in 6).
// Returns what changed.
export function record(st, item, res) {
  const ev = {};
  if (res.noAnswer) return ev;
  const k = item.kind;
  if (res.ok) {
    if (++st.streak[k] >= 3 && st.level[k] < TOLS.length - 1) { st.level[k]++; st.streak[k] = 0; ev.tighter = TOLS[st.level[k]]; }
  } else {
    st.streak[k] = 0;
    if (st.level[k] > 0) { st.level[k]--; ev.looser = TOLS[st.level[k]]; }
  }
  const valid = !res.countErr && !res.octaveErr;
  const e = (d) => (valid ? Math.min(150, Math.abs(d)) : 150);
  if (k === 'match') { push(st.err.bin[item.bin] ||= [], e(res.notes[0].dev), 8); push(st.octs, res.oct, 8); }
  if (k === 'degree') push(st.err.deg[item.off] ||= [], e(res.notes[0].dev), 8);
  if (k === 'echo') {
    const sizes = item.notes.slice(1).map((m, i) => m - item.notes[i]);
    sizes.forEach((s, i) => push(st.err.int[intClass(s)] ||= [], e(res.intervals[i]?.err ?? 150), 12));
  }
  if (k !== 'match') {
    const log = st.stageLog[k], key = `${k}Stage`, max = (k === 'degree' ? DEGREE_STAGES : ECHO_STAGES).length;
    push(log, valid && res.notes.every((x) => Math.abs(x.dev) <= 50) ? 1 : 0, 5);
    if (log.length >= 5 && log.reduce((a, b) => a + b, 0) >= 4 && st[key] < max) { st[key]++; st.stageLog[k] = []; ev.unlocked = k; }
  }
  push(st.recent, { k, ok: res.ok }, 8);
  const hits = st.recent.filter((r) => r.ok).length;
  if (st.fb === 'live' && st.recent.length >= 8 && hits >= 6 && Math.min(...st.recent.map((r) => st.level[r.k])) >= 1) {
    st.fb = 'blind'; st.recent = []; ev.fb = 'blind';
  } else if (st.fb === 'blind' && st.recent.length >= 6 && st.recent.slice(-6).filter((r) => r.ok).length <= 2) {
    st.fb = 'live'; st.recent = []; ev.fb = 'live';
  }
  return ev;
}

// ------------------------------------------------------------------ summary
// results: [{ item, res }]. Pass count, accuracy over all sung notes, and
// tendencies once there's enough data: flat / sharp overall, big leaps sung
// smaller (the typical sign of inaccurate singing, Pfordresher & Brown 2007),
// up vs down, the weakest part of the range, the degree missed most.
export function summarize(results, P) {
  const R = rangeOf(P);
  const ans = results.filter((r) => !r.res.noAnswer);
  const valid = ans.filter((r) => !r.res.countErr && !r.res.octaveErr);
  const notes = valid.flatMap((r) => r.res.notes);
  const ivs = valid.flatMap((r) => r.res.intervals);
  const S = {
    n: ans.length, ok: ans.filter((r) => r.res.ok).length, notes: notes.length,
    within50: notes.length ? notes.filter((x) => Math.abs(x.dev) <= 50).length / notes.length : NaN,
    typical: notes.length ? median(notes.map((x) => Math.abs(x.dev))) : NaN,
    findings: [],
  };
  // flat / sharp: most items (each item's mean) on one side — a couple of
  // clearly off items are not a tendency
  const items = valid.map((r) => mean(r.res.notes.map((x) => cap(x.dev))));
  if (items.length >= 5) {
    const b = median(items);
    const same = items.filter((d) => Math.sign(d) === Math.sign(b) && Math.abs(d) >= 5).length / items.length;
    if (Math.abs(b) >= 10 && same >= 0.65) S.findings.push({ key: b < 0 ? 'flat' : 'sharp', v: Math.abs(b) });
  }
  const big = ivs.filter((iv) => Math.abs(iv.size) >= 5);
  if (big.length >= 3) {
    const c = mean(big.map((iv) => Math.sign(iv.size) * cap(iv.err)));
    if (Math.abs(c) >= 15) S.findings.push({ key: c < 0 ? 'compress' : 'stretch', v: Math.abs(c) });
  }
  const up = ivs.filter((iv) => iv.size > 0).map((iv) => Math.abs(cap(iv.err)));
  const dn = ivs.filter((iv) => iv.size < 0).map((iv) => Math.abs(cap(iv.err)));
  if (up.length >= 3 && dn.length >= 3) {
    const u = mean(up), d = mean(dn);
    if (Math.abs(u - d) >= 10 && Math.max(u, d) >= 20) S.findings.push({ key: u > d ? 'up' : 'down', v: Math.max(u, d), w: Math.min(u, d) });
  }
  const bins = {};
  for (const x of notes) (bins[binOf(x.target, R)] ||= []).push(Math.abs(cap(x.dev)));
  const bm = Object.entries(bins).filter(([, v]) => v.length >= 3).map(([b, v]) => [b, mean(v)]).sort((a, b) => b[1] - a[1]);
  if (bm.length >= 2 && bm[0][1] - bm[bm.length - 1][1] >= 12 && bm[0][1] >= 20) S.findings.push({ key: 'register', bin: bm[0][0], v: bm[0][1], w: bm[bm.length - 1][1] });
  const deg = {};
  for (const r of ans) if (r.item.kind === 'degree') (deg[r.item.off] ||= []).push(r.res.ok ? 1 : 0);
  const worst = Object.entries(deg).filter(([, v]) => v.length >= 2 && mean(v) <= 0.5).sort((a, b) => mean(a[1]) - mean(b[1]))[0];
  if (worst) S.findings.push({ key: 'degree', off: +worst[0] });
  const oct = ans.filter((r) => r.res.octaveErr).length;
  if (oct >= 2) S.findings.push({ key: 'octave', n: oct });
  return S;
}

// A finding as { text, tip }.
export function findingText(f) {
  const c = (v) => `${Math.round(v)} ${tr('音分', 'cents')}`;
  const REG = { low: tr('低音区', 'the low part of your range'), mid: tr('中音区', 'the middle of your range'), high: tr('高音区', 'the high part of your range') };
  switch (f.key) {
    case 'flat': return { text: tr(`整体偏低，平均 ${c(f.v)}`, `Flat overall, ${c(f.v)} on average`), tip: tr('开口前先在心里把音“想”准；唱的时候气息往前送，别往下压。', 'Hear the note in your head before you start; keep the breath moving forward instead of pressing down.') };
    case 'sharp': return { text: tr(`整体偏高，平均 ${c(f.v)}`, `Sharp overall, ${c(f.v)} on average`), tip: tr('别往上顶：放松喉咙，让音“落”在目标上。', 'Don’t push up: relax the throat and let the note settle onto the target.') };
    case 'compress': return { text: tr(`大跳（四度以上）平均唱小了 ${c(f.v)}`, `Big leaps (a fourth or more) came out ${c(f.v)} too small`), tip: tr('这是唱不准最常见的规律。大跳前先在心里唱准目标音，想着“再远一点”。', 'The most common pattern in singing out of tune. Before a leap, hear the target in your head and think “a bit further”.') };
    case 'stretch': return { text: tr(`大跳（四度以上）平均唱大了 ${c(f.v)}`, `Big leaps (a fourth or more) came out ${c(f.v)} too big`), tip: tr('大跳别冲过头：先在心里唱准目标音再开口。', 'Don’t overshoot leaps: hear the target in your head before you sing it.') };
    case 'up': return { text: tr(`往上走比往下走不准（平均 ${c(f.v)} 对 ${c(f.w)}）`, `Going up is less accurate than going down (${c(f.v)} vs ${c(f.w)} on average)`), tip: tr('往上时别用力喊：轻一点、嘴型窄一点。', 'Don’t push going up: lighter, with a narrower mouth.') };
    case 'down': return { text: tr(`往下走比往上走不准（平均 ${c(f.v)} 对 ${c(f.w)}）`, `Going down is less accurate than going up (${c(f.v)} vs ${c(f.w)} on average)`), tip: tr('往下时别泄气：想着音在往下走，但声音的位置不掉。', 'Don’t let go going down: the note moves down but the voice keeps its place.') };
    case 'register': return { text: tr(`${REG[f.bin]}最不准（平均 ${c(f.v)}，最好的音区 ${c(f.w)}）`, `Least accurate in ${REG[f.bin]} (${c(f.v)} on average; best part ${c(f.w)})`), tip: f.bin === 'high' ? tr('高音轻一点、别喊；“基础课程 → 不喊唱”专门练这个。', 'Sing high notes lighter, without shouting; the lesson “No shouting” practises this.') : f.bin === 'low' ? tr('低音别压喉咙，声音往前放。', 'Don’t press the throat on low notes; keep the sound forward.') : tr('中音区最常用，多做“随机跟唱”。', 'The middle is where most songs sit: do more matching.') };
    case 'degree': return { text: tr(`最常唱错的是 ${degreeName(f.off)}`, `Missed most often: ${degreeName(f.off)}`), tip: tr('先在心里从 do 慢慢唱到它（do、re、mi…），记住这个距离。', 'In your head, walk up from do to it (do, re, mi…) and remember the distance.') };
    case 'octave': return { text: tr(`有 ${f.n} 次音对了但差一个八度`, `${f.n} times the right note in the wrong octave`), tip: tr('注意是要唱在 do 的上方还是下方。', 'Check whether the note is above or below do.') };
    default: return { text: '', tip: '' };
  }
}
