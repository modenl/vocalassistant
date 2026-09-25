// Five dimensions of a singing take — 音准 · 节奏 · 气息 · 技巧 · 表现力 — all
// judged without a score or a reference recording, from the pitch and level
// streams only. Each dimension is made of checks; every check has a status,
// a 0–100 score with a published rule (\`how\`), and a concrete next step:
//   音准   intonation (notes vs the singer's own tuning) · keyDrift (越唱越低/高)
//   节奏   beat (evenness of the most common note length) · tempo (越唱越快/慢)
//   气息   stability (long notes) · tail (句尾掉音)
//   技巧   breaks (断档) · shout (喊唱) · scoop (挑音) · vibrato (颤音)
//   表现力 dynamics (phrase-to-phrase loudness contrast)
// plus the range sung.

import { VibratoAnalyzer } from './vibrato.js';
import { rhythmOf, meterOf } from './rhythm.js';
import { midiName, median } from '../config.js';
import { L } from '../i18n.js';

const MA_WIN = 0.4;       // s — about two vibrato cycles: smooths vibrato for note tracking
const NOTE_TOL = 0.6;     // semitones the smoothed pitch may wander before a new note starts
const MIN_NOTE = 0.25;    // s
const GAP = 0.08;         // s of silence that ends a note
const TOTAL_SECS = 15;    // s of singing before a total score is given

export class SingingMetrics {
  constructor() {
    this.notes = [];
    this.breaks = [];
    this.frames = { t: [], midi: [], db: [] };
    this.voicedTime = 0;
    this.cur = null;
    this.prev = null;
    this.runStart = null;
    this.recent = [];  // all frames of the last 0.8 s (break confirmation)
    this.pending = []; // break candidates waiting for 0.2 s of what follows
    this.back = [];
  }

  // st: PitchTracker output
  push(st) {
    const F = this.frames;
    F.t.push(st.t); F.midi.push(st.voiced ? st.midi : NaN); F.db.push(st.db);
    const prev = this.prev;
    const dt = prev ? Math.min(0.1, st.t - prev.t) : 0;
    // confirm break candidates once 0.2 s of what follows is known
    this.recent.push({ t: st.t, v: st.voiced, midi: st.midi, db: st.db });
    while (this.recent.length && st.t - this.recent[0].t > 0.8) this.recent.shift();
    let brk = null;
    while (this.pending.length && st.t - this.pending[0].t >= 0.2) {
      const b = this.checkBreak(this.pending.shift());
      if (b) { this.breaks.push(b); brk = b; }
    }
    if (!st.voiced) {
      if (this.cur && st.t - this.cur.lastT > GAP) this.endNote();
      this.prev = st;
      return brk;
    }
    this.voicedTime += dt;
    if (this.runStart == null || st.t - (this.lastVoicedT ?? -9) > GAP) { this.runStart = st.t; this.back.length = 0; }
    this.lastVoicedT = st.t;

    // break candidate: the pitch jumps ≥ 2 semitones within 120 ms (≥ 17 semitones
    // per second — far faster than any glide; dropped frames at the flip allowed).
    // Confirmed 0.2 s later by checkBreak.
    const back = this.back;
    back.push({ t: st.t, midi: st.midi });
    while (back.length && st.t - back[0].t > 0.12) back.shift();
    if (back.length >= 3) {
      const a = back[0], b = back[back.length - 1];
      const lastC = this.pending[this.pending.length - 1] || this.breaks[this.breaks.length - 1];
      if (Math.abs(b.midi - a.midi) >= 2 && (!lastC || b.t - lastC.t > 0.3)) {
        this.pending.push({ t: b.t, from: a.midi, to: b.midi });
      }
    }

    // note tracking on the smoothed pitch
    const c = this.cur;
    if (c) {
      c.fr.push({ t: st.t, midi: st.midi, raw: st.raw, db: st.db });
      const sm = this.smoothed(c);
      c.sm.push(sm);
      if (c.fr.length > 6 && Math.abs(sm - median(c.sm)) > NOTE_TOL) {
        const moved = c.fr.splice(c.fr.length - 3);
        c.sm.splice(c.sm.length - 3);
        this.endNote();
        this.cur = { fr: moved, sm: moved.map((f) => f.midi), lastT: st.t };
      } else c.lastT = st.t;
    } else {
      this.cur = { fr: [{ t: st.t, midi: st.midi, raw: st.raw, db: st.db }], sm: [st.midi], lastT: st.t };
    }
    this.prev = st;
    return brk;
  }

  // A register break / crack: inside one continuous sound (no silence, not at a
  // phrase start) the pitch steps ≥ 1.5 semitones and STAYS there — abruptly, not
  // as a fast glide — while the level steps ≥ 5 dB the OPPOSITE way — up into falsetto gets quieter, back
  // down into chest louder (M2 is ≈ 8–10 dB weaker than M1 at the same effort;
  // Castellengo et al. 2007). A consonant between syllables only dips the level
  // briefly, and a melodic leap doesn't flip the level against the pitch.
  checkBreak(c) {
    const span = this.recent.filter((f) => f.t >= c.t - 0.27 && f.t <= c.t + 0.2);
    // continuous sound through the jump: a flip keeps the voice going — a few
    // frames may drop right at it (the level changes inside the analysis window),
    // but no silence > 100 ms (a breath between phrases). Enough sound on both sides.
    let maxGap = 0, lastV = null;
    for (const f of span) if (f.v) { if (lastV != null) maxGap = Math.max(maxGap, f.t - lastV); lastV = f.t; }
    if (maxGap > 0.1 || span.filter((f) => !f.v).length > 6) return null;
    const pre = span.filter((f) => f.v && f.t <= c.t - 0.07);
    const post = span.filter((f) => f.v && f.t >= c.t + 0.03);
    if (pre.length < 4 || post.length < 4) return null;
    // lasting steps: medians after vs before
    const dbPre = median(pre.map((f) => f.db)), dbPost = median(post.map((f) => f.db));
    const dM = median(post.map((f) => f.midi)) - median(pre.map((f) => f.midi));
    const dDb = dbPost - dbPre;
    if (Math.abs(dM) < 1.5 || Math.abs(dDb) < 5 || Math.sign(dM) === Math.sign(dDb)) return null;
    // no dip: between syllables the level falls below BOTH neighbours (a
    // consonant, voiced or not); across a flip it goes straight from one to the other
    const mid = this.recent.filter((f) => f.t > c.t - 0.12 && f.t < c.t + 0.08);
    if (mid.length && Math.min(...mid.map((f) => f.db)) < Math.min(dbPre, dbPost) - 6) return null;
    // abrupt, not a fast glide: the change across the jump exceeds what the glide
    // speed on either side explains by ≥ 1.5 semitones
    const slope = (fr) => {
      const mt = fr.reduce((a, f) => a + f.t, 0) / fr.length, mv = fr.reduce((a, f) => a + f.midi, 0) / fr.length;
      let sxy = 0, sxx = 0;
      for (const f of fr) { sxy += (f.t - mt) * (f.midi - mv); sxx += (f.t - mt) ** 2; }
      return sxx ? sxy / sxx : 0;
    };
    const a = pre[pre.length - 1], b = post[0];
    const expected = Math.max(Math.abs(slope(pre)), Math.abs(slope(post))) * (b.t - a.t);
    if (Math.abs(b.midi - a.midi) - expected < 1.5 || Math.sign(b.midi - a.midi) !== Math.sign(dM)) return null;
    return { t: c.t, from: c.from, to: c.to, dDb };
  }

  smoothed(c) {
    const t = c.fr[c.fr.length - 1].t;
    let s = 0, n = 0;
    for (let i = c.fr.length - 1; i >= 0 && t - c.fr[i].t <= MA_WIN; i--) { s += c.fr[i].midi; n++; }
    return s / n;
  }

  endNote() {
    const c = this.cur;
    this.cur = null;
    if (!c || c.fr.length < 3) return;
    const t0 = c.fr[0].t, t1 = c.fr[c.fr.length - 1].t, dur = t1 - t0;
    if (dur < MIN_NOTE) return;
    const core = c.fr.filter((f) => f.t >= t0 + 0.1 && f.t <= t1 - 0.06);
    if (core.length < 3) return;
    const center = median(core.map((f) => f.midi));
    const target = Math.round(center);
    // centred moving average (vibrato removed) for steadiness and drift
    const ma = core.map((f, i) => {
      let s = 0, n = 0;
      for (let j = 0; j < core.length; j++) if (Math.abs(core[j].t - f.t) <= MA_WIN / 2) { s += core[j].midi; n++; }
      return s / n;
    });
    // steadiness: 10–90 % range of the smoothed pitch, onset (0.2 s) and
    // release (last 0.15 s) excluded — scoops and fall-offs are expression
    const settled = ma.filter((_, i) => core[i].t >= t0 + 0.2 && core[i].t <= t1 - 0.15).sort((a, b) => a - b);
    const range = settled.length > 4 ? settled[Math.floor(settled.length * 0.9)] - settled[Math.floor(settled.length * 0.1)] : 0;
    // a glide (siren, portamento) moves steadily; a held note does not
    // (raw pitch: over a whole note vibrato averages out of the regression)
    const mt = core.reduce((a, f) => a + f.t, 0) / core.length, mm = core.reduce((a, f) => a + f.midi, 0) / core.length;
    let sxy = 0, sxx = 0;
    core.forEach((f) => { sxy += (f.t - mt) * (f.midi - mm); sxx += (f.t - mt) ** 2; });
    const slope = sxx ? sxy / sxx : 0; // semitones per second
    const note = {
      t0, t1, dur, midi: center, target, name: midiName(target), cents: (center - target) * 100,
      db: median(core.map((f) => f.db)), held: Math.abs(slope) < 1.2, steady: range <= 0.7 && Math.abs(slope) < 1.2, slope, drift: dur >= 0.8 ? range * 100 : NaN, vib: null,
    };
    if (dur >= 1.0) {
      const va = new VibratoAnalyzer();
      for (const f of core) va.push(f.t, (f.raw ?? f.midi) * 100);
      note.vib = va.analyze();
    }
    this.notes.push(note);
  }

  // the singer's current tuning offset (cents vs A4 = 440) from recent notes
  offsetNow(t) {
    const recent = this.notes.filter((n) => n.steady && t - n.t0 <= 10);
    return recent.length >= 3 ? circMeanCents(recent.map((n) => ({ cents: n.cents, w: n.dur }))) : 0;
  }

  // the note being sung right now (not yet finalized): { midi, dur, t0 }
  currentNote() {
    const c = this.cur;
    if (!c || c.fr.length < 3) return null;
    const t0 = c.fr[0].t, dur = c.fr[c.fr.length - 1].t - t0;
    return { midi: median(c.fr.slice(-12).map((f) => f.midi)), dur, t0 };
  }

  finish() {
    for (const c of this.pending.splice(0)) { const b = this.checkBreak(c); if (b) this.breaks.push(b); }
    this.endNote();
    return this.summary();
  }

  // ---------------------------------------------------------------- summary
  summary() {
    const notes = this.notes.filter((n) => n.steady);
    const R = rhythmOf(this.frames, this.notes);
    // the meter heard in the singing (preferred); note-by-note timing is the fallback
    R.meter = meterOf(this.frames);
    R.metered = !!(R.meter?.found && R.onsets.length >= 16 && R.meter.windows >= 4);
    // the note being sung right now counts towards the progress of the
    // not-yet-judged checks (never towards a judgement)
    const cur = this.currentNote();
    const M = {
      voicedTime: this.voicedTime,
      noteCount: notes.length,
      intonation: intonation(notes, cur),
      keyDrift: keyDrift(notes, cur),
      beat: beat(R),
      tempo: tempo(R),
      // every held (non-glide) note, including the ones that drift
      stability: stability(this.notes.filter((n) => n.held), cur),
      tail: tail(this.notes, this.frames),
      breaks: breaks(this.breaks, this.voicedTime),
      shout: shout(notes, cur),
      scoop: scoop(this.frames),
      vibrato: vibrato(notes, cur),
      dynamics: dynamics(this.notes, this.voicedTime),
      range: range(notes),
    };
    M.dims = dimsOf(M);
    // the total needs 3 scored dimensions and at least TOTAL_SECS of singing
    // (a few good notes shouldn't make a 100); progress = the 3 most advanced
    // dimensions, or the time sung, whichever is further behind
    const avail = DIMS.filter((d) => M.dims[d.key].score != null);
    const top = DIMS.map((d) => { const D = M.dims[d.key]; return D.score != null ? 1 : D.blocked ? 0 : D.progress; }).sort((a, b) => b - a).slice(0, 3);
    M.ready = { scored: avail.length, need: 3, secs: TOTAL_SECS, progress: Math.min(top.reduce((a, x) => a + x, 0) / 3, this.voicedTime / TOTAL_SECS) };
    M.total = avail.length >= 3 && this.voicedTime >= TOTAL_SECS ? Math.round(avail.reduce((a, d) => a + M.dims[d.key].score, 0) / avail.length) : null;
    M.issues = CHECKS
      .map((k) => ({ key: k, ...M[k] }))
      .filter((x) => x.status === 'poor' || x.status === 'ok')
      .sort((a, b) => (a.status === b.status ? a.rank - b.rank : a.status === 'poor' ? -1 : 1))
      .slice(0, 3);
    return M;
  }
}

// ------------------------------------------------------------------ dimensions
// A dimension's score is the weighted mean of its judged checks; a check that
// needs practice (< 60) caps its dimension at 74 so a problem is never averaged
// away. The total is the mean of the judged dimensions (at least 3, after at
// least 15 s of singing).
export const DIMS = [
  { key: 'pitch', title: L('音准', 'Pitch'), sub: L('音与音之间准不准（按你自己的调判断），整体有没有越唱越低 / 高', 'Are the notes in tune with each other (judged against your own key), and does the whole thing sink or rise'), checks: [['intonation', 3], ['keyDrift', 1]] },
  { key: 'rhythm', title: L('节奏', 'Rhythm'), sub: L('按你自己的拍子判断：同样长的音唱得匀不匀，速度有没有越来越快 / 慢', 'Judged against your own beat: are equal notes equally long, do you speed up or slow down'), checks: [['beat', 1], ['tempo', 1]] },
  { key: 'breath', title: L('气息', 'Breath'), sub: L('长音稳不稳，句尾有没有掉下来', 'Are long notes steady, do phrase endings sink'), checks: [['stability', 1], ['tail', 1]] },
  { key: 'technique', title: L('技巧', 'Technique'), sub: L('有没有技术毛病：断档、喊唱、挑音、颤音问题', 'Technical faults: breaks, shouting, scooping, vibrato problems'), checks: [['breaks', 1], ['shout', 1], ['scoop', 1], ['vibrato', 1]] },
  { key: 'expression', title: L('表现力', 'Expression'), sub: L('有没有强弱变化（感情对不对，要你和听众来判断）', 'Is there any loud–soft contrast (whether the emotion is right is for you and your listeners to judge)'), checks: [['dynamics', 1]] },
];
export const CHECKS = DIMS.flatMap((d) => d.checks.map(([k]) => k));
export const statusOf = (score) => (score == null ? 'na' : score >= 75 ? 'good' : score >= 60 ? 'ok' : 'poor');

function dimsOf(M) {
  const out = {};
  for (const d of DIMS) {
    const judged = d.checks.filter(([k]) => M[k].score != null);
    let score = null;
    if (judged.length) {
      const w = judged.reduce((a, [, wt]) => a + wt, 0);
      score = Math.round(judged.reduce((a, [k, wt]) => a + wt * M[k].score, 0) / w);
      if (judged.some(([k]) => M[k].score < 60)) score = Math.min(score, 74);
    }
    // not scored yet: the most advanced of its checks shows how far along it is
    const open = d.checks.map(([k]) => M[k]).filter((r) => r.score == null && !r.blocked).sort((a, b) => b.progress - a.progress);
    out[d.key] = {
      title: d.title, score, status: statusOf(score), judged: judged.length, of: d.checks.length,
      progress: score != null ? 1 : open.length ? open[0].progress : 1, left: open.length ? open[0].left : '',
      blocked: score == null && !open.length, reason: score == null && !open.length ? M[d.checks[0][0]].detail : '',
    };
  }
  return out;
}

// Piecewise-linear score through anchor points [[value, score], …] (values ascending).
function band(x, pts) {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) { const [x0, y0] = pts[i - 1]; return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0); }
  }
  return pts[pts.length - 1][1];
}
// keep a score inside its status band (good ≥ 75, ok 60–74, poor < 60)
const inBand = (score, status) => Math.round(status === 'good' ? Math.max(75, score) : status === 'ok' ? Math.min(74, Math.max(60, score)) : Math.min(59, score));
// Not judged (yet). progress 0…1 = how much of the singing it needs is there;
// left = what is still missing, in the singer's words. blocked = enough was sung
// but it still can't be judged (e.g. no steady beat) — more of the same won't help.
const KEEP = () => L('保持。', 'Keep it up.');
const na = (out, detail, progress = 0, left = '', blocked = false) =>
  ({ ...out, status: 'na', value: '—', detail, score: null, progress: Math.max(0, Math.min(1, progress)), left, blocked });
// progress of a note count; the note being sung may be the one that completes it
const soFar = (have, need, live, zh, en) => {
  const n = have + (live ? 1 : 0);
  return n >= need ? [0.95, L('把这个音唱完', 'finish this note')] : [n / need, L(`再唱 ${need - n} 个${zh}`, `sing ${need - n} more ${en}`)];
};

// frames between two times (F.t ascending)
function lowerBound(a, x) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < x) lo = m + 1; else hi = m; } return lo; }
// lowest pitch in [a, b] (3-frame median, so a single glitch doesn't count)
function minPitch(F, a, b) {
  const p = [];
  for (let i = lowerBound(F.t, a); i < F.t.length && F.t[i] <= b; i++) if (Number.isFinite(F.midi[i])) p.push(F.midi[i]);
  let lo = Infinity;
  for (let i = 1; i < p.length - 1; i++) lo = Math.min(lo, median([p[i - 1], p[i], p[i + 1]]));
  return lo;
}
function meanPitch(F, a, b) {
  let s = 0, c = 0;
  for (let i = lowerBound(F.t, a); i < F.t.length && F.t[i] <= b; i++) if (Number.isFinite(F.midi[i])) { s += F.midi[i]; c++; }
  return c >= 5 ? s / c : NaN;
}

// Every measure returns { status: good|ok|poor|na, value, detail, action, lesson, rank }.
// rank orders issues of the same status (lower = more important).

// Cents wrap at ±50 (a note 60 cents sharp is 40 cents flat of the next one),
// so the singer's own tuning is a circular mean.
export const wrapCents = (c) => ((((c + 50) % 100) + 100) % 100) - 50;
export function circMeanCents(items) {
  let x = 0, y = 0;
  for (const { cents, w = 1 } of items) { const a = (cents / 100) * 2 * Math.PI; x += w * Math.cos(a); y += w * Math.sin(a); }
  return x || y ? (Math.atan2(y, x) / (2 * Math.PI)) * 100 : 0;
}
// Tuning reference around time t: notes within ±8 s, weighted by duration.
export function localOffset(notes, t) {
  const near = notes.filter((n) => Math.abs(n.t0 - t) <= 8);
  return circMeanCents(near.map((n) => ({ cents: n.cents, w: n.dur })));
}

// Free singing has no reference key: notes are judged against the singer's own
// (slowly moving) tuning, i.e. whether they are in tune with each other. A
// constant offset from A4 = 440 is reported separately — it only matters when
// singing with accompaniment. Tolerance ±25 cents (Larrouy-Maestri 2018: trained
// listeners ≈ ±10–25; professionals deviate ≈ 30 cents in performance).
function intonation(notes, cur) {
  const out = { rank: 2, lesson: 'pitch', title: L('相对音准', 'Relative pitch'), how: L('唱准（和你自己的调相差 ≤ 25 音分）的音占百分之几，就是几分', 'the percentage of notes in tune (within ±25 cents of your own key) is the score') };
  if (notes.length < 4) return na(out, L('再多唱几个长一点的音（每个 ≥ 0.3 秒）', 'Sing a few more longer notes (≥ 0.3 s each)'), ...soFar(notes.length, 4, cur?.dur >= 0.3, '稳定的音', 'steady notes'));
  const rel = notes.map((n) => ({ n, d: wrapCents(n.cents - localOffset(notes, n.t0)) }));
  const good = rel.filter((r) => Math.abs(r.d) <= 25).length / rel.length;
  const meanAbs = rel.reduce((a, r) => a + Math.abs(r.d), 0) / rel.length;
  const offset = circMeanCents(notes.map((n) => ({ cents: n.cents, w: n.dur })));
  const status = good >= 0.75 ? 'good' : good >= 0.6 ? 'ok' : 'poor';
  const worst = [...rel].sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3).filter((r) => Math.abs(r.d) > 25);
  const flatTop = rel.filter((r) => r.d < -25).length > rel.filter((r) => r.d > 25).length * 2;
  const sharpTop = rel.filter((r) => r.d > 25).length > rel.filter((r) => r.d < -25).length * 2;
  const offNote = Math.abs(offset) >= 20 ? L(` 另外，整体比标准音（A4 = 440）${offset < 0 ? '低' : '高'} ${Math.round(Math.abs(offset))} 音分——清唱没关系，跟伴奏唱时会显得不准。`, ` Also, your overall tuning is ${Math.round(Math.abs(offset))} cents ${offset < 0 ? 'below' : 'above'} standard pitch (A4 = 440) — fine a cappella, but it will sound off with an accompaniment.`) : '';
  return {
    ...out, status, good, meanAbs, offset, score: Math.round(good * 100),
    value: L(`${Math.round(good * 100)}% 的音唱准`, `${Math.round(good * 100)}% of notes in tune`),
    detail: (status === 'good' ? L(`音与音之间很准（平均偏差 ${Math.round(meanAbs)} 音分）。`, `The notes are well in tune with each other (average deviation ${Math.round(meanAbs)} cents).`)
      : L(`有 ${Math.round((1 - good) * 100)}% 的音偏了 25 音分以上（平均偏差 ${Math.round(meanAbs)} 音分）${worst.length ? `；偏得最多：${worst.map((r) => `${r.n.name} ${r.d > 0 ? '+' : ''}${Math.round(r.d)}`).join('、')}` : ''}。`,
        `${Math.round((1 - good) * 100)}% of notes were more than 25 cents off (average deviation ${Math.round(meanAbs)} cents)${worst.length ? `; furthest off: ${worst.map((r) => `${r.n.name} ${r.d > 0 ? '+' : ''}${Math.round(r.d)}`).join(', ')}` : ''}.`)) + offNote,
    action: status === 'good' ? KEEP() : flatTop ? L('偏低的音多：唱之前先在心里听到这个音，气息保持往前送，别让音“掉下来”。去练「音准」。', 'Mostly flat: hear each note in your head before singing it and keep the breath moving forward so the note doesn’t drop. Practise “Pitch”.')
      : sharpTop ? L('偏高的音多：常见原因是用力往上顶，放松下巴和脖子，别推。去练「音准」。', 'Mostly sharp: usually from pushing up. Relax the jaw and neck, don’t push. Practise “Pitch”.')
      : L('先听参考音再唱，慢速逐个音对准。去练「音准」。', 'Listen to a reference first, then tune note by note, slowly. Practise “Pitch”.'),
    points: rel.map((r) => ({ t: r.n.t0, midi: r.n.target, cents: r.d })),
  };
}

function stability(notes, cur) {
  const out = { rank: 6, lesson: 'sustain', title: L('长音稳定', 'Steady long notes'), how: L('长音里音高漂移（中位数）：≤ 15 音分满分，35 音分 75 分，60 音分 60 分', 'pitch drift within long notes (median): ≤ 15 cents = 100, 35 = 75, 60 = 60') };
  const long = notes.filter((n) => Number.isFinite(n.drift));
  if (long.length < 3) return na(out, L('唱几个 1 秒以上的长音才能判断', 'Sing a few notes of 1 s or longer'), ...soFar(long.length, 3, cur?.dur >= 0.8, ' 1 秒左右的长音', 'long notes (about 1 s)'));
  const d = median(long.map((n) => n.drift));
  const bad = long.filter((n) => n.drift > 50).length / long.length;
  const status = d <= 35 && bad <= 0.3 ? 'good' : d <= 60 ? 'ok' : 'poor';
  return {
    ...out, status, drift: d, score: inBand(band(d, [[15, 100], [35, 75], [60, 60], [120, 20]]), status),
    value: L(`长音漂移 ${Math.round(d)} 音分`, `drift ${Math.round(d)} cents`),
    detail: status === 'good' ? L('长音音高稳定。', 'Long notes hold their pitch.') : L(`长音里音高慢慢跑偏（${Math.round(bad * 100)}% 的长音漂移超过 50 音分）。`, `The pitch wanders during long notes (${Math.round(bad * 100)}% drift by more than 50 cents).`),
    action: status === 'good' ? KEEP() : L('长音要靠均匀的气息：吸气后像慢慢吹蜡烛一样匀速出气，别越唱越松或越唱越挤。去练「长音」。', 'Long notes need an even airflow: after breathing in, let the air out steadily as if slowly blowing on a candle — don’t let go or squeeze towards the end. Practise “Long notes”.'),
  };
}

function breaks(list, voicedTime) {
  const out = { rank: 0, lesson: 'glide', title: L('断档 / 破音', 'Breaks / cracks'), how: L('每分钟断档次数：0 次满分，0.5 次 75 分，2 次 60 分（只有 1 次不扣到 75 以下）', 'breaks per minute: 0 = 100, 0.5 = 75, 2 = 60 (a single one never drops below 75)') };
  if (voicedTime < 3) return na(out, L('再唱一会儿', 'Keep singing'), voicedTime / 3, L(`再唱 ${Math.ceil(3 - voicedTime)} 秒`, `sing ${Math.ceil(3 - voicedTime)} s more`));
  // per minute of singing: an occasional flip in a song is normal (and often intended)
  const n = list.length, perMin = n / (voicedTime / 60);
  const status = n <= 1 || perMin <= 0.5 ? 'good' : perMin <= 2 ? 'ok' : 'poor';
  return {
    ...out, status, count: n, score: inBand(band(perMin, [[0, 100], [0.5, 75], [2, 60], [6, 20]]), status),
    value: n ? L(`${n} 次`, `${n}`) : L('没有', 'none'),
    detail: n ? L(`检测到 ${n} 次声音突然“翻”了（音高突然跳开，同时音量反向突变并保持）：${list.slice(0, 3).map((b) => `${midiName(b.from)}→${midiName(b.to)}`).join('、')}。${status === 'good' ? '偶尔一次没关系。' : '如果是有意的真假声转换（流行里常用），可以忽略。'}`,
      `The voice suddenly “flipped” ${n} time${n > 1 ? 's' : ''} (the pitch jumped while the loudness stepped the other way and stayed): ${list.slice(0, 3).map((b) => `${midiName(b.from)}→${midiName(b.to)}`).join(', ')}. ${status === 'good' ? 'Once in a while is fine.' : 'If it was a deliberate flip into falsetto (common in pop), ignore it.'}`) : L('声音连贯，没有突然断开。', 'The voice stays connected, no sudden breaks.'),
    action: n ? L('断档多出现在换声的地方：用唇颤音或“呜”的警笛滑音，慢慢滑过那几个音，让声音不断开、音量不突变。去练「滑音不断」。', 'Breaks happen around the register change: slide slowly through those notes on a lip trill or an “oo” siren, keeping the sound connected and the loudness even. Practise “Smooth glides”.') : KEEP(),
    points: list,
  };
}

function shout(notes, cur) {
  const out = { rank: 1, lesson: 'noshout', title: L('喊唱', 'Shouting'), how: L('每升高一个半音音量涨多少：≤ 0.8 dB 满分，1.2 dB 75 分，1.6 dB 60 分（高音也要明显更响才算喊）', 'loudness gained per semitone up: ≤ 0.8 dB = 100, 1.2 dB = 75, 1.6 dB = 60 (high notes must also be clearly louder)') };
  const lo = notes.length ? Math.min(...notes.map((n) => n.midi)) : 0, hi = notes.length ? Math.max(...notes.map((n) => n.midi)) : 0;
  if (notes.length < 6) {
    const all = [...notes.map((n) => n.midi), ...(cur?.dur >= 0.3 ? [cur.midi] : [])], span = all.length ? Math.max(...all) - Math.min(...all) : 0;
    const [p, left] = soFar(notes.length, 6, cur?.dur >= 0.3, '高低不同的音', 'notes at different heights');
    return na(out, L('需要高低不同的多个音', 'Needs several notes at different heights'), Math.min(p, span / 5), left);
  }
  if (hi - lo < 5) return na(out, L('音高跨度不到 5 个半音，无法判断', 'The notes span less than 5 semitones'), (hi - lo) / 5, L(`唱得再高一点或低一点（现在跨 ${Math.round(hi - lo)} 个半音，要 5 个）`, `sing higher or lower (span ${Math.round(hi - lo)} semitones, needs 5)`));
  // least-squares slope of level (dB) against pitch (semitones)
  const mx = notes.reduce((a, n) => a + n.midi, 0) / notes.length, my = notes.reduce((a, n) => a + n.db, 0) / notes.length;
  let sxy = 0, sxx = 0;
  for (const n of notes) { sxy += (n.midi - mx) * (n.db - my); sxx += (n.midi - mx) ** 2; }
  const slope = sxy / (sxx || 1);
  const sorted = [...notes].sort((a, b) => a.midi - b.midi), k = Math.max(2, Math.floor(sorted.length / 3));
  const rise = median(sorted.slice(-k).map((n) => n.db)) - median(sorted.slice(0, k).map((n) => n.db));
  // At the same effort a voice gets ≈ 0.5–0.8 dB louder per semitone anyway
  // (voice range profile), so only a clearly steeper climb counts.
  const status = slope >= 1.6 && rise >= 14 ? 'poor' : slope >= 1.2 && rise >= 10 ? 'ok' : 'good';
  return {
    ...out, status, slope, rise, score: inBand(band(slope, [[0.8, 100], [1.2, 75], [1.6, 60], [2.4, 20]]), status),
    value: L(`高音比低音响 ${rise >= 0 ? '+' : ''}${Math.round(rise)} dB`, `high vs low notes ${rise >= 0 ? '+' : ''}${Math.round(rise)} dB`),
    detail: status === 'good' ? L('往高唱时音量没有猛涨，很好。', 'The loudness doesn’t shoot up as you go higher — good.') : L(`音越高越响：每升高一个半音音量涨 ${slope.toFixed(1)} dB。如果是歌曲高潮有意唱响，可以忽略；如果高音时喉咙紧、吃力，就是在用音量“推”。`, `The higher, the louder: +${slope.toFixed(1)} dB per semitone. If it’s a deliberately loud climax, ignore it; if your throat feels tight and effortful up there, you are pushing with volume.`),
    action: status === 'good' ? KEEP() : L('往上唱时反过来想：越高越轻、嘴型越窄（像说“呜”），让音量基本不变。去练「不喊唱」。', 'Going up, think the opposite: higher = lighter, a narrower mouth (like “oo”), and keep the loudness about the same. Practise “No shouting”.'),
    points: notes.map((n) => ({ midi: n.midi, db: n.db })),
  };
}

const VIB = {
  straight: L('直音', 'straight tone'), healthy: L('自然颤音', 'natural vibrato'), wobble: L('太慢（晃）', 'too slow (wobble)'), tremolo: L('太快（抖）', 'too fast (bleat)'), wide: L('太宽', 'too wide'), irregular: L('不规则波动（可能是装饰音）', 'irregular (maybe ornaments)'),
};
function vibrato(notes, cur) {
  const out = { rank: 9, lesson: 'vibrato', title: L('颤音', 'Vibrato'), how: L('有毛病（太快、太慢、太宽）的颤音占多少：0% 满分，30% 75 分，50% 60 分；直音不扣分', 'share of faulty vibrato (too fast, slow or wide): 0% = 100, 30% = 75, 50% = 60; straight tone costs nothing') };
  const long = notes.filter((n) => n.vib);
  if (long.length < 2) return na(out, L('唱几个 1 秒以上的长音才能判断', 'Sing a few notes of 1 s or longer'), ...soFar(long.length, 2, cur?.dur >= 1, ' 1 秒以上的长音', 'notes of 1 s or longer'));
  const count = {};
  for (const n of long) count[n.vib.type] = (count[n.vib.type] || 0) + 1;
  // irregular pitch movement is often ornamentation in pop — not counted as a problem
  const probs = ['tremolo', 'wobble', 'wide'].filter((k) => count[k]);
  const probShare = probs.reduce((a, k) => a + count[k], 0) / long.length;
  const healthy = long.filter((n) => n.vib.type === 'healthy');
  const main = Object.entries(count).sort((a, b) => b[1] - a[1])[0][0];
  const nProb = probs.reduce((a, k) => a + count[k], 0);
  const status = probShare >= 0.5 && nProb >= 3 ? 'poor' : probShare >= 0.3 && nProb >= 2 ? 'ok' : 'good';
  const rate = healthy.length ? median(healthy.map((n) => n.vib.rate)) : NaN;
  const topProb = probs.sort((a, b) => count[b] - count[a])[0];
  return {
    ...out, status, count, score: inBand(band(probShare, [[0, 100], [0.3, 75], [0.5, 60], [1, 20]]), status),
    value: main === 'healthy' && Number.isFinite(rate) ? L(`自然颤音 ${rate.toFixed(1)} 次/秒`, `natural vibrato ${rate.toFixed(1)}/s`) : VIB[main],
    detail: status === 'good'
      ? (main === 'straight' ? L('长音基本是直音（没有颤音）——这不是问题，流行唱法常用直音。', 'Long notes are mostly straight (no vibrato) — not a problem; pop singing often uses straight tone.') : main === 'irregular' ? L('长音上有不规则的音高波动，多半是装饰音，不算问题。', 'Irregular pitch movement on long notes — most likely ornaments, not a problem.') : L('颤音速度和幅度都在自然范围（每秒 4.5–8 次）。', 'Vibrato rate and width are in the natural range (4.5–8 per second).'))
      : L(`${Math.round(probShare * 100)}% 的长音颤音${VIB[topProb]}。`, `On ${Math.round(probShare * 100)}% of long notes the vibrato is ${VIB[topProb]}.`),
    action: status === 'good' ? KEEP()
      : topProb === 'tremolo' ? L('颤得太快通常是喉咙紧：先唱稳定的直音，再放松地让声音自然波动。去练「颤音」。', 'Too-fast vibrato usually means a tight throat: sing a steady straight tone first, then relax and let the voice move naturally. Practise “Vibrato”.')
      : topProb === 'wobble' || topProb === 'wide' ? L('颤得太慢、太宽通常是气息推得太多：减小音量，先唱稳直音。去练「颤音」。', 'Slow or wide vibrato usually comes from pushing too much air: sing softer and steady the straight tone first. Practise “Vibrato”.')
      : L('先练稳定的直音，再练有规律的颤音。去练「颤音」。', 'Practise a steady straight tone first, then a regular vibrato. Practise “Vibrato”.'),
  };
}

// 越唱越低 / 高: the singer's own tuning near the start vs near the end. A
// cappella singers often sink; alone nobody notices, but with an accompaniment
// or a partner it sounds out of tune. Local tuning (±5 s) at each note,
// unwrapped along the take; the first quarter vs the last quarter.
function keyDrift(notes, cur) {
  const out = { rank: 8, lesson: 'pitch', title: L('整体偏移', 'Key drift'), how: L('开头和结尾的整体音高差：≤ 10 音分满分，30 音分 75 分，60 音分 60 分', 'overall pitch at the end vs the start: ≤ 10 cents = 100, 30 = 75, 60 = 60') };
  const span = notes.length ? notes[notes.length - 1].t0 - notes[0].t0 : 0;
  if (notes.length < 12 || span < 20) {
    const first = notes.length ? notes[0].t0 : cur?.t0, sung = first == null ? 0 : (cur ? cur.t0 + cur.dur : notes[notes.length - 1].t0) - first;
    const [p, left] = soFar(notes.length, 12, cur?.dur >= 0.3, '稳定的音', 'steady notes');
    return na(out, L('唱 20 秒以上才能判断', 'Needs 20 s or more of singing'), Math.min(p, sung / 20), sung < 20 ? L(`再唱约 ${Math.ceil(20 - sung)} 秒`, `about ${Math.ceil(20 - sung)} s more`) : left);
  }
  const offs = [];
  for (const n of notes) {
    const near = notes.filter((x) => Math.abs(x.t0 - n.t0) <= 5);
    let o = circMeanCents(near.map((x) => ({ cents: x.cents, w: x.dur })));
    if (offs.length) o += 100 * Math.round((offs[offs.length - 1] - o) / 100); // unwrap
    offs.push(o);
  }
  const T0 = notes[0].t0, T1 = notes[notes.length - 1].t0, q = (T1 - T0) / 4;
  const d = median(offs.filter((_, i) => notes[i].t0 >= T1 - q)) - median(offs.filter((_, i) => notes[i].t0 <= T0 + q));
  const a = Math.abs(d), score = Math.round(band(a, [[10, 100], [30, 75], [60, 60], [120, 20]])), status = statusOf(score);
  const dir = d < 0 ? '低' : '高', dirEn = d < 0 ? 'flat' : 'sharp';
  return {
    ...out, status, score, drift: d,
    value: a < 10 ? L('几乎没有', 'hardly any') : L(`越唱越${dir} ${Math.round(a)} 音分`, `${Math.round(a)} cents ${dirEn} by the end`),
    detail: status === 'good' ? L(`从头到尾整体音高基本没变（${dir}了 ${Math.round(a)} 音分）。`, `Your key stayed put from start to end (${Math.round(a)} cents ${dirEn}).`)
      : L(`唱到后面整体${dir}了 ${Math.round(a)} 音分（越唱越${dir}）。清唱时自己听不出来，但跟伴奏或别人一起唱就会显得跑调。`, `By the end you were ${Math.round(a)} cents ${dirEn} overall. Alone you won’t hear it, but with an accompaniment or other singers it sounds out of tune.`),
    action: status === 'good' ? KEEP() : d < 0 ? L('越唱越低常见于气息跟不上或越唱越累：每句开头先在心里找准第一个音，句尾保持气息往前送。去练「音准」。', 'Sinking usually comes from running short of breath or tiring: find the first note of each phrase in your head before singing, and keep the breath moving through phrase ends. Practise “Pitch”.')
      : L('越唱越高常见于越唱越紧张、往上顶：放松下巴和喉咙。去练「音准」。', 'Rising usually comes from growing tension and pushing up: relax the jaw and throat. Practise “Pitch”.'),
  };
}

// 节拍稳定 (see rhythm.js): the meter found in the singing, and how much the
// local tempo wobbles along the take. Where no meter comes through, the spread
// of the most common note length (note-by-note timing) is the fallback.
function beat(R) {
  const out = { rank: 3, lesson: null, title: L('节拍稳定', 'Steady beat'),
    how: L('整首歌里本地速度的波动：≤ 1.5% 满分，4% 75 分，7% 60 分（拍子从轻重音和音符变化里找）',
      'how much the local tempo wobbles through the song: ≤ 1.5% = 100, 4% = 75, 7% = 60 (the beat is found from accents and note changes)') };
  const M = R.meter;
  if (R.metered && Number.isFinite(M.wobble)) {
    const w = M.wobble * 100, score = Math.round(band(w, [[1.5, 100], [4, 75], [7, 60], [12, 20]])), status = statusOf(score);
    const meter = L(`每分钟约 ${Math.round(M.bpm)} 拍、${M.bar} 拍一小节`, `about ${Math.round(M.bpm)} beats per minute, ${M.bar} beats to the bar`);
    return {
      ...out, status, score, wobble: w, bpm: M.bpm,
      value: L(`速度波动 ${w.toFixed(1)}%`, `tempo wobble ${w.toFixed(1)}%`),
      detail: status === 'good' ? L(`找到了你的拍子：${meter}；整首歌拍子很稳（本地速度只波动 ${w.toFixed(1)}%）。`, `Found your beat: ${meter}; it stays steady through the song (the local tempo wobbles only ${w.toFixed(1)}%).`)
        : L(`找到了你的拍子（${meter}），但速度时快时慢（本地速度波动 ${w.toFixed(1)}%，≤ 4% 算稳）。如果是有意的自由处理，可以忽略。`, `Found your beat (${meter}), but the tempo keeps changing (local wobble ${w.toFixed(1)}%; ≤ 4% counts as steady). If it’s deliberate rubato, ignore it.`),
      action: status === 'good' ? KEEP() : L('跟着节拍器唱（设成你自己的速度），先练最容易赶或拖的那几句。', 'Sing with a metronome set to your own tempo; practise first the lines where you tend to rush or drag.'),
    };
  }
  if (!R.beat) {
    const n = R.onsets.length, secs = M?.secs ?? 0;
    if (secs < 15) return na(out, L('唱一段有节拍的歌（15 秒以上）才能判断', 'Sing a song with a beat for 15 s or more'), secs / 15, L(`再唱约 ${Math.ceil(15 - secs)} 秒`, `about ${Math.ceil(15 - secs)} s more`));
    if (n < 16) return na(out, L('唱一段有节拍的歌（20 个音以上）才能判断', 'Sing a song with a beat (20+ notes)'), n / 16, L(`再唱 ${16 - n} 个音`, `sing ${16 - n} more notes`));
    return na(out, L('这段演唱里听不出重复的拍子（轻重音和音符变化都没有规律地重复）。可能是自由节奏或练声；如果是有固定节拍的歌，试着把重拍唱得更明显，或者跟着节拍器唱。',
      'No repeating beat comes through in this take (neither accents nor note changes repeat regularly). It may be free rhythm or an exercise; if the song has a regular beat, try stressing the strong beats more, or sing with a metronome.'), 1, '', true);
  }
  const cv = R.beat.cv * 100, score = Math.round(band(cv, [[5, 100], [11, 75], [13.5, 60], [20, 20]])), status = statusOf(score);
  return {
    ...out, status, score, cv,
    value: L(`时长波动 ${cv.toFixed(0)}%`, `length varies ${cv.toFixed(0)}%`),
    detail: status === 'good' ? L(`同样长的音唱得很匀（最常见的音约 ${R.beat.noteLen.toFixed(2)} 秒，波动 ${cv.toFixed(0)}%）。`, `Equal notes are sung evenly (the most common note ≈ ${R.beat.noteLen.toFixed(2)} s, varying ${cv.toFixed(0)}%).`)
      : L(`同样长的音唱得时长时短（波动 ${cv.toFixed(0)}%，≤ 11% 算匀）。如果是有意的自由处理（比如在高音前稍作停留），可以忽略。`, `Equal notes come out longer and shorter (varying ${cv.toFixed(0)}%; ≤ 11% counts as even). If it’s deliberate rubato (say, lingering before a high note), ignore it.`),
    action: status === 'good' ? KEEP() : L('先拍手或用节拍器把这首歌的节奏打出来，再跟着节拍唱；每个音唱满它该有的长度，不赶也不拖。', 'Clap the rhythm or play it with a metronome first, then sing along with the beat; give every note its full length — don’t rush or drag.'),
  };
}

// 越唱越快 / 慢 (see rhythm.js): beat length in the first vs the last third.
function tempo(R) {
  const out = { rank: 4, lesson: null, title: L('速度稳定', 'Steady tempo'), how: L('后段比前段快 / 慢多少：≤ 3% 满分，8% 75 分，15% 60 分', 'how much faster / slower the end is than the start: ≤ 3% = 100, 8% = 75, 15% = 60') };
  // prefer the tempo change measured on the meter
  if (R.metered && Number.isFinite(R.meter.change)) R = { ...R, tempo: { change: R.meter.change, bpm: R.meter.bpm } };
  if (!R.tempo) {
    const n = R.onsets.length, secs = R.meter?.secs ?? 0;
    if (secs < 15) return na(out, L('唱一段有节拍的歌（15 秒以上）才能判断', 'Sing a song with a beat for 15 s or more'), secs / 15, L(`再唱约 ${Math.ceil(15 - secs)} 秒`, `about ${Math.ceil(15 - secs)} s more`));
    return n < 16 ? na(out, L('唱一段有稳定节拍的歌（20 个音以上）才能判断', 'Sing a song with a steady beat (20+ notes)'), n / 16, L(`再唱 ${16 - n} 个音`, `sing ${16 - n} more notes`))
      : na(out, R.beat ? L('节拍不够规整，判断不了速度变化', 'The beat isn’t regular enough to judge tempo changes') : L('没有找到稳定的拍子，判断不了速度变化', 'No steady beat found, so tempo changes can’t be judged'), 1, '', true);
  }
  // measurement noise on soft, legato singing reaches a few %: lenient bands
  const c = R.tempo.change * 100, a = Math.abs(c);
  const score = Math.round(band(a, [[3, 100], [8, 75], [15, 60], [25, 20]])), status = statusOf(score);
  const dir = c > 0 ? '快' : '慢', dirEn = c > 0 ? 'faster' : 'slower';
  return {
    ...out, status, score, change: c, bpm: R.tempo.bpm,
    value: a < 3 ? L(`速度稳定（约 ${Math.round(R.tempo.bpm)} 拍/分）`, `steady (≈ ${Math.round(R.tempo.bpm)} bpm)`) : L(`后段${dir}了 ${a.toFixed(0)}%`, `${a.toFixed(0)}% ${dirEn} at the end`),
    detail: status === 'good' ? L(`从头到尾速度基本一致（约每分钟 ${Math.round(R.tempo.bpm)} 拍）。`, `The tempo held from start to end (≈ ${Math.round(R.tempo.bpm)} bpm).`)
      : L(`越唱越${dir}：后段比前段${dir}了 ${a.toFixed(0)}%。${c > 0 ? '清唱时最常见的就是越唱越快。' : ''}`, `You got ${dirEn}: the end is ${a.toFixed(0)}% ${dirEn} than the start.${c > 0 ? ' Speeding up is the most common slip a cappella.' : ''}`),
    action: status === 'good' ? KEEP() : c > 0 ? L(`跟着节拍器唱（设成你开头的速度，约每分钟 ${Math.round(R.tempo.bpm)} 拍）；长音和句尾的停顿要唱满、停够，再进下一句。`, `Sing with a metronome set to your opening tempo (≈ ${Math.round(R.tempo.bpm)} bpm); hold long notes and rests at phrase ends for their full length before going on.`)
      : L(`跟着节拍器唱（约每分钟 ${Math.round(R.tempo.bpm)} 拍）；长音别拖，换气要快。`, `Sing with a metronome (≈ ${Math.round(R.tempo.bpm)} bpm); don’t drag long notes, and breathe quickly.`),
  };
}

// 句尾掉音: at the end of a phrase the last long note sinks (the breath runs
// out and the support drops). Held notes ≥ 0.8 s followed by a pause ≥ 0.25 s:
// mean pitch just before the end (0.22 → 0.05 s before the sound stops — the
// release itself is shorter) vs the body (until 0.45 s before the end). A drop
// of ≥ 30 cents counts (a sag that ends ≈ 50 cents low); both windows span
// about a vibrato cycle. A slide down of more than a semitone at the very end
// is a deliberate fall-off — style, not a sag.
function tail(notes, F) {
  const out = { rank: 5, lesson: 'sustain', title: L('句尾掉音', 'Sagging phrase ends'), how: L('句尾长音结束前往下掉 ≥ 30 音分的比例：0% 满分，20% 75 分，35% 60 分', 'share of phrase-final long notes that sink ≥ 30 cents before the end: 0% = 100, 20% = 75, 35% = 60') };
  const ends = [];
  for (const n of notes) {
    if (!n.held || n.dur < 0.8) continue;
    // the sound may run on a little past the note (a short fragment that
    // sank too far to count as the same note): follow it to the silence
    let i = lowerBound(F.t, n.t1), end = n.t1;
    while (i < F.t.length && F.t[i] - end <= 0.08 && F.t[i] - n.t1 <= 0.4) { if (Number.isFinite(F.midi[i])) end = F.t[i]; i++; }
    let k = i;
    while (k < F.t.length && !Number.isFinite(F.midi[k])) k++;
    if (k < F.t.length && F.t[k] - end < 0.25) continue; // not the end of a phrase
    const body = meanPitch(F, n.t0 + 0.15, Math.min(n.t1, end - 0.45)), fin = meanPitch(F, end - 0.22, end - 0.05);
    if (!Number.isFinite(body) || !Number.isFinite(fin)) continue;
    const drop = (body - fin) * 100;
    if (drop > 150 || body - minPitch(F, end - 0.15, end) > 1) continue; // fall-off
    ends.push({ t: end, drop, name: n.name });
  }
  if (ends.length < 3) return na(out, L('需要几个句尾的长音（≥ 0.8 秒、后面有停顿）才能判断', 'Needs a few phrase-final long notes (≥ 0.8 s, then a pause)'), ends.length / 3, L(`再唱 ${3 - ends.length} 句（句尾拖一个长音，再停一下）`, `sing ${3 - ends.length} more phrase${3 - ends.length > 1 ? 's' : ''} (end on a long note, then pause)`));
  const sag = ends.filter((e) => e.drop >= 30), share = sag.length / ends.length;
  const status = share <= 0.2 || sag.length <= 1 ? 'good' : share <= 0.35 ? 'ok' : 'poor';
  const avg = sag.length ? sag.reduce((a, e) => a + e.drop, 0) / sag.length : 0;
  return {
    ...out, status, share, score: inBand(band(share * 100, [[0, 100], [20, 75], [35, 60], [70, 20]]), status),
    value: sag.length ? L(`${sag.length} / ${ends.length} 个句尾往下掉`, `${sag.length} / ${ends.length} phrase ends sank`) : L('句尾稳', 'endings hold'),
    detail: status === 'good' ? L(`句尾的长音能保持住音高${sag.length ? `（只有 ${sag.length} 个往下掉）` : ''}。`, `Long notes at phrase ends hold their pitch${sag.length ? ` (only ${sag.length} sank)` : ''}.`)
      : L(`${sag.length} 个句尾长音在结束前往下掉（平均 ${Math.round(avg)} 音分）——气不够，或者最后没“托住”：${sag.slice(0, 3).map((e) => e.name).join('、')}。`, `${sag.length} phrase-final long notes sank before the end (${Math.round(avg)} cents on average) — running out of breath, or not supporting to the end: ${sag.slice(0, 3).map((e) => e.name).join(', ')}.`),
    action: status === 'good' ? KEEP() : L('唱长音时把气留一点到最后：句尾别泄气，想象声音一直往前送到收尾。去练「长音」。', 'Save some breath for the end of long notes: don’t let go at phrase ends, imagine the sound travelling forward right to the release. Practise “Long notes”.'),
    points: sag.map((e) => ({ t: e.t })),
  };
}

// 挑音: a note that starts clearly below its pitch and slides up into it. At
// every onset after silence (≥ 60 ms) that leads into a settled note (0.25–0.45 s
// later, mostly voiced, spread ≤ 1.2 semitones — vibrato is fine): the first
// 60 ms start ≥ 80 cents (and ≤ 3 semitones) low and take ≥ 0.1 s to come
// within 30 cents. Now and then it's style; on most notes it sounds out of tune.
function scoop(F) {
  const out = { rank: 7, lesson: 'pitch', title: L('挑音', 'Scooping'), how: L('开口时从下面滑上来的音占多少：≤ 5% 满分，25% 75 分，40% 60 分', 'share of notes that start low and slide up: ≤ 5% = 100, 25% = 75, 40% = 60') };
  const t = F.t, m = F.midi, n = t.length, on = [];
  let last = -1;
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(m[i])) continue;
    const gap = last < 0 ? Infinity : t[i] - t[last];
    last = i;
    if (gap < 0.06) continue;
    const settled = [];
    let tot = 0, first = [], reach = null;
    for (let j = i; j < n && t[j] - t[i] <= 0.45; j++) {
      const dt = t[j] - t[i], ok = Number.isFinite(m[j]);
      if (dt <= 0.06 && ok) first.push(m[j]);
      if (dt >= 0.25) { tot++; if (ok) settled.push(m[j]); }
    }
    if (settled.length < 5 || settled.length < 0.8 * tot || !first.length) continue;
    settled.sort((a, b) => a - b);
    if (settled[Math.floor(settled.length * 0.9)] - settled[Math.floor(settled.length * 0.1)] > 1.2) continue;
    const target = median(settled), rise = target - median(first);
    for (let j = i; j < n && t[j] - t[i] <= 0.45; j++) if (Number.isFinite(m[j]) && m[j] >= target - 0.3) { reach = t[j] - t[i]; break; }
    on.push({ t: t[i], scoop: rise >= 0.8 && rise <= 3 && reach != null && reach >= 0.1 });
  }
  if (on.length < 5) return na(out, L('需要至少 5 个停顿之后开口的音', 'Needs at least 5 notes started after a pause'), on.length / 5, L(`再唱 ${5 - on.length} 个停顿后开口的音`, `sing ${5 - on.length} more notes after a pause`));
  const sc = on.filter((o) => o.scoop), share = sc.length / on.length;
  const score = Math.round(band(share * 100, [[5, 100], [25, 75], [40, 60], [70, 20]])), status = statusOf(score);
  return {
    ...out, status, score, share,
    value: sc.length ? L(`${Math.round(share * 100)}% 的音从下面滑上来`, `${Math.round(share * 100)}% scooped from below`) : L('起音干净', 'clean onsets'),
    detail: status === 'good' ? L(`开口基本直接落在音上${sc.length ? `（${sc.length} / ${on.length} 个从下面滑上来，偶尔用是一种风格）` : ''}。`, `Notes mostly start right on pitch${sc.length ? ` (${sc.length} / ${on.length} slid up from below — fine as an occasional effect)` : ''}.`)
      : L(`${sc.length} / ${on.length} 个音是从下面“挑”上去的（开口比目标低 80 音分以上，滑了 0.1 秒以上）。偶尔用是风格，大部分音都这样，听起来就像音不准。`, `${sc.length} / ${on.length} notes were scooped from below (starting 80+ cents low and sliding for 0.1 s or more). Now and then it’s style; on most notes it sounds out of tune.`),
    action: status === 'good' ? KEEP() : L('开口前先在心里想好这个音的高度，直接“落”在音上，不要从下面找。去练「音准」的“跟唱一个音”。', 'Hear the pitch in your head before you start and land right on it instead of searching up from below. Practise “Match one note” in “Pitch”.'),
    points: sc.map((o) => ({ t: o.t })),
  };
}

// 强弱对比: loudness contrast between phrases, beyond the natural rise of
// ≈ 0.6 dB per semitone with pitch (so a louder, higher chorus still counts).
// Phrases = notes separated by pauses ≥ 0.25 s; P85 − P15 of the phrase levels.
// What the contrast should express is up to the singer — only whether there is any.
function dynamics(notes, voicedTime) {
  const out = { rank: 10, lesson: 'dynamics', title: L('强弱对比', 'Dynamic contrast'), how: L('乐句之间的音量差：≥ 10 dB 满分，6 dB 75 分，3 dB 60 分', 'loudness difference between phrases: ≥ 10 dB = 100, 6 dB = 75, 3 dB = 60') };
  const ns = notes.filter((n) => n.dur >= 0.25);
  const phrases = [];
  let cur = [];
  for (const n of ns) { if (cur.length && n.t0 - cur[cur.length - 1].t1 > 0.25) { phrases.push(cur); cur = []; } cur.push(n); }
  if (cur.length) phrases.push(cur);
  const ok = phrases.filter((p) => p.reduce((a, n) => a + n.dur, 0) >= 1);
  if (ok.length < 4 || voicedTime < 20) {
    return na(out, L('唱 20 秒以上、至少 4 句才能判断', 'Needs 20 s or more and at least 4 phrases'), Math.min(ok.length / 4, voicedTime / 20), voicedTime < 20 ? L(`再唱约 ${Math.ceil(20 - voicedTime)} 秒`, `about ${Math.ceil(20 - voicedTime)} s more`) : L(`再唱 ${4 - ok.length} 句`, `sing ${4 - ok.length} more phrase${4 - ok.length > 1 ? 's' : ''}`));
  }
  const mid = ns.reduce((a, n) => a + n.midi, 0) / ns.length;
  const lv = ok.map((p) => { const w = p.reduce((a, n) => a + n.dur, 0); return p.reduce((a, n) => a + n.dur * (n.db - 0.6 * (n.midi - mid)), 0) / w; }).sort((a, b) => a - b);
  const pct = (q) => { const x = q * (lv.length - 1), i = Math.floor(x); return lv[i] + (lv[Math.min(i + 1, lv.length - 1)] - lv[i]) * (x - i); };
  const c = pct(0.85) - pct(0.15);
  const score = Math.round(band(c, [[1.5, 20], [3, 60], [6, 75], [10, 100]])), status = statusOf(score);
  return {
    ...out, status, score, contrast: c,
    value: L(`乐句音量差 ${c.toFixed(0)} dB`, `${c.toFixed(0)} dB between phrases`),
    detail: status === 'good' ? L(`乐句之间有明显的强弱变化（约 ${c.toFixed(0)} dB）。`, `Clear loud–soft contrast between phrases (≈ ${c.toFixed(0)} dB).`)
      : L(`各句音量差不多（只差 ${c.toFixed(1)} dB），听起来会比较平。如果唱的是练声曲，可以忽略。`, `The phrases are all about equally loud (only ${c.toFixed(1)} dB apart), which can sound flat. Ignore this for vocal exercises.`),
    action: status === 'good' ? KEEP() : L('试着让主歌轻、副歌强；每句中间稍强、句尾收一点。先去练「音量控制」的渐强渐弱。', 'Try verses softer and choruses stronger; a little louder mid-phrase and easing off at the end. Practise the crescendo–decrescendo in “Volume control” first.'),
  };
}

function range(notes) {
  const ok = notes.filter((n) => n.dur >= 0.3);
  if (!ok.length) return null;
  const lo = Math.min(...ok.map((n) => n.target)), hi = Math.max(...ok.map((n) => n.target));
  return { lo, hi, loName: midiName(lo), hiName: midiName(hi), span: hi - lo };
}

export const STATUS = {
  good: { text: L('✓ 好', '✓ Good'), color: '#0ca30c' },
  ok: { text: L('! 注意', '! Watch'), color: '#fab219' },
  poor: { text: L('✕ 需要练', '✕ Practise'), color: '#d03b3b' },
  na: { text: L('— 数据不足', '— Not enough'), color: '#6e7689' },
};
