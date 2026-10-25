// Beginner lessons. Every step is judged only from pitch and level — signals
// that can be measured reliably — so pass / fail is deterministic.
//
// step.check(take, P) → { progress 0…1, pass, level: 'ok'|'off'|'idle', hint }
// take: { frames: PitchTracker states, m: SingingMetrics }; P: voice type.

import { VibratoAnalyzer } from '../analysis/vibrato.js';
import { midiName } from '../config.js';
import { L as tr } from '../i18n.js';
import { twangVerdict, hasMeasures, buildCurve, curveSpan, okCurve, levelOf, GLIDE_SPAN } from '../analysis/twang.js';
import { vowelOf, formantTrust, fmMedians } from '../analysis/vowels.js';

// ------------------------------------------------------------------ helpers
const runsOf = (frames, gap = 0.1) => {
  const runs = [];
  let cur = null;
  for (const f of frames) {
    if (!f.voiced) continue;
    if (cur && f.t - cur[cur.length - 1].t <= gap) cur.push(f);
    else { cur = [f]; runs.push(cur); }
  }
  return runs;
};
const lastRun = (frames) => { const r = runsOf(frames); return r[r.length - 1] || null; };
// moving average of key over the last `win` seconds at each frame
const movAvg = (run, key, win = 0.3) => run.map((f, i) => {
  let s = 0, n = 0;
  for (let j = i; j >= 0 && f.t - run[j].t <= win; j--) { s += run[j][key]; n++; }
  return s / n;
});
const cents = (x) => `${x > 0 ? '+' : ''}${Math.round(x)} ${tr('音分', 'cents')}`;
// Lessons have a reference note, so pitch is judged against it. Pass at ±50
// cents — the usual research line between the right note and a wrong one
// (Pfordresher et al. 2010; Dalla Bella 2015); professionals deviate ≈ 30 cents
// in performance (Larrouy-Maestri 2014). Hints still grade ≤20 / ≤35 / ≤50.
// Any octave counts: pitch-matching studies score octave errors as correct.
export const TOL = 50;
// the target moved to the octave the singer is actually in
const inOctave = (midi, target) => target + 12 * Math.round((midi - target) / 12);
const octaveNote = (midi, target) => {
  const k = Math.round((inOctave(midi, target) - target) / 12);
  return k === 0 ? '' : tr(`（你唱的是${k < 0 ? '低' : '高'}${Math.abs(k) > 1 ? ` ${Math.abs(k)} 个` : ''}八度，也算对）`, ` (you sang ${Math.abs(k) > 1 ? `${Math.abs(k)} octaves` : 'an octave'} ${k < 0 ? 'lower' : 'higher'} — that counts)`);
};
const offHint = (midi, target, tol = TOL) => {
  const d = (midi - target) * 100;
  if (Math.abs(d) <= tol) return null;
  const dir = d < 0 ? tr('往上', 'up') : tr('往下', 'down');
  return Math.abs(d) <= 50 ? tr(`接近了（${cents(d)}），再${dir}一点`, `close (${cents(d)}), a little ${dir}`) : tr(`${d < 0 ? '偏低' : '偏高'} ${cents(d)}，${dir}一点`, `${d < 0 ? 'flat' : 'sharp'} ${cents(d)}, go ${dir} a little`);
};
const grade = (d) => (Math.abs(d) <= 20 ? tr('很准', 'Spot on') : Math.abs(d) <= 35 ? tr('准', 'In tune') : tr('接近了，可以更准', 'Close — could be closer'));
// the sung note's centre: median pitch over the last 0.3 s (vibrato averages out)
const centre = (run, i) => {
  const t = run[i].t, v = [];
  for (let j = i; j >= 0 && t - run[j].t <= 0.3; j--) v.push(run[j].midi);
  v.sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
};
const idle = (hint) => ({ progress: 0, pass: false, level: 'idle', hint, score: 0 });

// ------------------------------------------------------------------ scoring
// Every attempt gets 0–100. A pass scores 60 + 40 × quality, so passes still
// differ; below the pass bar the score is partial credit for progress (≤ 55).
// Full marks follow what counts as very accurate — pitch within ±10 cents
// (trained listeners tolerate ≈ ±10–25 cents; Larrouy-Maestri 2018).
// Each part: { name, text (measured), full (what full marks need), s 0…1, w, tip }.
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const better = (x, full, zero) => clamp01((zero - x) / (zero - full)); // lower is better
const more = (x, zero, full) => clamp01((x - zero) / (full - zero));   // higher is better
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const medianOf = (a) => { const v = [...a].sort((x, y) => x - y); return v.length ? v[v.length >> 1] : NaN; };
function scored(ev, parts) {
  const w = parts.reduce((a, p) => a + p.w, 0) || 1;
  const q = parts.reduce((a, p) => a + p.w * p.s, 0) / w;
  const score = ev.pass ? Math.round(60 + 40 * q) : Math.round(55 * clamp01(ev.progress || 0));
  return { ...ev, score, parts: ev.pass ? parts : [] };
}
export const gradeOf = (score) => (score >= 90 ? tr('优秀', 'Excellent') : score >= 75 ? tr('良好', 'Good') : score >= 60 ? tr('通过', 'Pass') : tr('未通过', 'Not passed'));

// ------------------------------------------------------------------ step kinds
// Hold one note in tune for `secs` in total: the note's centre within ±TOL of
// the target (in whatever octave the singer chose).
function holdNote(target, secs, tol = TOL / 100) {
  return (take) => {
    const run = lastRun(take.frames);
    if (!run) return idle(tr(`唱“啊”，音高 ${midiName(target)}（先点 ▶ 听一下）`, `Sing “ah” on ${midiName(target)} (press ▶ to hear it first)`));
    let total = 0;
    const devs = []; // deviations (cents) of the counted frames, up to the pass
    const runs = runsOf(take.frames);
    for (const r of runs) {
      for (let i = 1; i < r.length; i++) {
        const c = centre(r, i);
        if (Math.abs(c - inOctave(c, target)) <= tol && total < secs) {
          total += Math.min(0.1, r[i].t - r[i - 1].t);
          devs.push((c - inOctave(c, target)) * 100);
        }
      }
    }
    const c = centre(run, run.length - 1), t = inOctave(c, target), d = (c - t) * 100;
    const off = offHint(c, t);
    const pass = total >= secs;
    const medAbs = medianOf(devs.map(Math.abs)), m = mean(devs), sd = Math.sqrt(mean(devs.map((x) => (x - m) ** 2)));
    return scored({
      progress: Math.min(1, total / secs), pass, level: off ? 'off' : 'ok',
      hint: pass ? tr(`✓ 唱准了 ${secs} 秒`, `✓ In tune for ${secs} s`) + octaveNote(c, target) : off ? off + octaveNote(c, target) : tr(`${grade(d)}（${cents(d)}）！保持住（${total.toFixed(1)} / ${secs} 秒）`, `${grade(d)} (${cents(d)})! Hold it (${total.toFixed(1)} / ${secs} s)`) + octaveNote(c, target),
    }, [
      { name: tr('音准', 'Pitch'), text: tr(`平均偏差 ${Math.round(medAbs)} 音分`, `average deviation ${Math.round(medAbs)} cents`), full: tr('≤ 10 音分', '≤ 10 cents'), s: better(medAbs, 10, 50), w: 0.8,
        tip: tr('唱之前先在心里哼出这个音，唱的时候让线落在目标带的正中间。', 'Hum the note in your head before singing, and keep the line in the middle of the target band.') },
      { name: tr('稳定', 'Steadiness'), text: tr(`音高晃动 ±${Math.round(sd)} 音分`, `pitch wavers ±${Math.round(sd)} cents`), full: tr('≤ ±8 音分', '≤ ±8 cents'), s: better(sd, 8, 30), w: 0.2,
        tip: tr('气息保持均匀，嘴型和下巴别动，音就不会晃。', 'Keep the breath even and the mouth and jaw still, and the note won’t waver.') },
    ]);
  };
}

// Sing the target notes in order. Target-aware: walking through the frames, the
// next target is ticked off once the note's centre (0.2 s median — vibrato
// averages out) has stayed on it for `hold` seconds, so legato singing and
// semitone steps work regardless of where note boundaries fall. The first note
// must be within ±tol of the reference; after that each note is judged against
// the singer's running offset (intervals within ±tol — how melodies are judged
// in the literature), as long as the overall drift stays within ±maxDrift.
// Any octave counts. A pause of ≥ 1.5 s restarts an unfinished pattern.
export function tickOff(frames, targets, { hold = 0.25, tol = 50, maxDrift = 75, restartGap = 1.5 } = {}) {
  let i = 0, acc = 0, lastIn = -1, lastT = -1, offs = [], got = [], cur = [], win = [];
  const median = (a) => { const v = [...a].sort((x, y) => x - y); return v[v.length >> 1]; };
  let last = null;
  for (const f of frames) {
    if (!f.voiced) continue;
    const gap = lastT >= 0 ? f.t - lastT : 0;
    if (gap > 0.1) win = [];
    if (gap > restartGap && i > 0 && i < targets.length) { i = 0; acc = 0; offs = []; got = []; cur = []; }
    const dt = lastT >= 0 ? Math.min(0.1, gap) : 0;
    lastT = f.t;
    win.push(f);
    while (f.t - win[0].t > 0.2) win.shift();
    const c = median(win.map((w) => w.midi));
    if (i >= targets.length) { last = { c }; continue; }
    const tt = inOctave(c, targets[i]), dev = (c - tt) * 100;
    // drift allowance starts once 3 notes are in: one off note must not move the reference
    const off = offs.length >= 3 ? offs.slice(-3).reduce((x, y) => x + y, 0) / 3 : 0;
    const ok = Math.abs(dev - off) <= tol && Math.abs(dev) <= (i === 0 ? tol : maxDrift);
    last = { c, dev, off, near: Math.abs(c - tt) <= 1, ok };
    if (ok) { acc += dt; lastIn = f.t; cur.push({ dev, db: f.db, spr: f.spr, hbr: f.hbr, vdb: f.vdb, hnr: f.hnrLite, h1h2: f.h1h2, cpp: f.cpp, midi: f.midi, f0: f.f0, fm: f.fm }); }
    else if (lastIn < 0 || f.t - lastIn > 0.12) { acc = 0; cur = []; }
    if (acc >= hold) {
      const d = median(cur.map((x) => x.dev));
      // the note's measures (for the twang scale): medians; formants where the pitch allows
      const fin = (k) => medianOf(cur.map((x) => x[k]).filter(Number.isFinite));
      const fms = cur.filter((x) => x.fm && formantTrust(x.f0) !== 'none');
      got.push({ target: targets[i], dev: d, rel: d - off, db: median(cur.map((x) => x.db)), spr: fin('spr'), hbr: fin('hbr'), h1h2: fin('h1h2'), cpp: fin('cpp'), vdb: fin('vdb'), hnr: fin('hnr'), midi: fin('midi'), fm: fms.length >= 4 ? fmMedians(fms.map((x) => x.fm)) : null, t: f.t });
      offs.push(d); i++; acc = 0; cur = []; lastIn = -1;
    }
  }
  return { got, done: i, last, sinceVoiced: frames.length ? frames[frames.length - 1].t - lastT : 0 };
}

function sequence(targets, hold = 0.25, tol = 50) {
  return (take) => {
    const r = tickOff(take.frames, targets, { hold, tol });
    const n = targets.length, next = targets[r.done];
    const seq = { targets, done: r.done };
    if (r.done >= n) return scored({ progress: 1, pass: true, level: 'ok', hint: tr('✓ 每个音都唱准了', '✓ Every note in tune'), got: r.got, seq }, seqParts(r.got));
    if (!r.last) return { ...idle(tr(`从 ${midiName(targets[0])} 开始，一个音一个音唱（先点 ▶ 听一遍）`, `Start on ${midiName(targets[0])} and sing note by note (press ▶ to hear it first)`)), seq };
    const L = r.last;
    let hint = tr(`下一个音：${midiName(next)}（已完成 ${r.done} / ${n}）`, `Next note: ${midiName(next)} (${r.done} / ${n} done)`), level = 'ok';
    if (r.sinceVoiced < 0.3 && L.near && !L.ok) {
      const rel = L.dev - L.off, dir = rel < 0 ? tr('往上', 'up') : tr('往下', 'down');
      level = 'off';
      if (r.done > 0 && Math.abs(L.dev) > 75 && Math.abs(rel) <= 50) hint = tr(`${midiName(next)}：整体${L.dev < 0 ? '越唱越低' : '越唱越高'}了（${cents(L.dev)}）——想着参考音的高度`, `${midiName(next)}: you’ve drifted ${L.dev < 0 ? 'flat' : 'sharp'} overall (${cents(L.dev)}) — remember the reference pitch`);
      else hint = tr(`${midiName(next)}：${rel < 0 ? '偏低' : '偏高'} ${cents(rel)}，${dir}一点`, `${midiName(next)}: ${rel < 0 ? 'flat' : 'sharp'} ${cents(rel)}, go ${dir} a little`);
    } else if (r.sinceVoiced < 0.3 && L.near && L.ok) hint = tr(`${midiName(next)}：准，保持一下…（已完成 ${r.done} / ${n}）`, `${midiName(next)}: in tune, hold it… (${r.done} / ${n} done)`);
    if (r.done > 0 && r.sinceVoiced >= 1.5) hint = tr(`停顿太久了，从 ${midiName(targets[0])} 重新开始`, `Paused too long — start again from ${midiName(targets[0])}`);
    return scored({ progress: r.done / n, pass: false, level, hint, got: r.got, seq }, []);
  };
}

// Score parts for a sung sequence: intervals (each note vs the running offset)
// and the overall drift at the end.
function seqParts(got) {
  const rel = got.map((g) => Math.abs(g.rel));
  const worst = got.reduce((a, g) => (Math.abs(g.rel) > Math.abs(a.rel) ? g : a), got[0]);
  const drift = mean(got.slice(-3).map((g) => g.dev));
  // per-note accuracy; the worst note counts too, so one clearly off note shows
  const ns = rel.map((x) => better(x, 10, 50));
  const acc = 0.4 * mean(ns) + 0.6 * Math.min(...ns);
  return [
    { name: tr('音准', 'Pitch'), text: tr(`平均偏差 ${Math.round(mean(rel))} 音分，最差 ${Math.round(Math.max(...rel))} 音分`, `average ${Math.round(mean(rel))} cents off, worst ${Math.round(Math.max(...rel))}`), full: tr('每个音 ≤ 10 音分', 'every note ≤ 10 cents'), s: acc, w: 0.85,
      tip: tr(`最不准的是 ${midiName(worst.target)}（${cents(worst.rel)}），单独多练这个音，再连起来唱。`, `The least accurate note was ${midiName(worst.target)} (${cents(worst.rel)}); practise it on its own, then in the pattern.`) },
    { name: tr('整体偏移', 'Drift'), text: Math.abs(drift) < 5 ? tr('几乎没有偏移', 'hardly any drift') : tr(`唱到最后整体${drift < 0 ? '偏低' : '偏高'} ${Math.round(Math.abs(drift))} 音分`, `${Math.round(Math.abs(drift))} cents ${drift < 0 ? 'flat' : 'sharp'} by the end`), full: tr('≤ 15 音分', '≤ 15 cents'), s: better(Math.abs(drift), 15, 75), w: 0.15,
      tip: tr(`唱到后面要记住开头参考音的高度，别${drift < 0 ? '越唱越低' : '越唱越高'}。`, `Keep the opening reference pitch in mind so you don’t drift ${drift < 0 ? 'flat' : 'sharp'}.`) },
  ];
}

// One breath on one note: pitch (0.6 s average, vibrato removed) stays within
// pitchTol cents and level within levelTol dB for `secs`.
function sustain(target, secs, pitchTol = 40, levelTol = 6) {
  return (take) => {
    const run = lastRun(take.frames);
    if (!run) return idle(tr(`吸一口气，用“啊”唱 ${midiName(target)}，尽量平稳地拉长`, `Breathe in and sing “ah” on ${midiName(target)}, as steadily and long as you can`));
    const body = run.filter((f) => f.t - run[0].t >= 0.3);
    const now = run[run.length - 1];
    const tgt = inOctave(now.midi, target);
    const off = Math.abs(now.midi - tgt) > 0.5 ? offHint(now.midi, tgt) : null;
    if (!body.length) return { progress: 0, pass: false, level: 'ok', hint: tr('保持…', 'Hold it…') };
    // pitch: 0.6 s average over the whole note (onset included) — judged only
    // where the window is full, so vibrato never leaks into the measure
    const skip = run.length - body.length, mpRun = movAvg(run, 'midi', 0.6);
    const mp = body.map((f, i) => (f.t - run[0].t >= 0.6 ? mpRun[skip + i] : NaN)), ml = movAvg(body, 'db');
    let pLo = Infinity, pHi = -Infinity, lLo = Infinity, lHi = -Infinity, stable = 0, broke = null;
    const ref = mp.find(Number.isFinite);
    for (let i = 0; i < body.length; i++) {
      if (Number.isFinite(mp[i])) { pLo = Math.min(pLo, mp[i]); pHi = Math.max(pHi, mp[i]); }
      lLo = Math.min(lLo, ml[i]); lHi = Math.max(lHi, ml[i]);
      if (pHi - pLo > pitchTol / 100) { broke = mp[i] < ref ? tr('音高往下掉了', 'The pitch dropped') : tr('音高往上跑了', 'The pitch rose'); break; }
      if (lHi - lLo > levelTol) { broke = ml[i] < ml[0] ? tr('音量越来越小', 'The volume faded') : tr('音量越来越大', 'The volume grew'); break; }
      stable = body[i].t - body[0].t;
      if (stable >= secs) break; // scored on the passing `secs` seconds
    }
    const pass = stable >= secs;
    const pR = Number.isFinite(pHi - pLo) ? (pHi - pLo) * 100 : 0, lR = lHi - lLo;
    return scored({
      progress: Math.min(1, stable / secs), pass, level: broke || off ? 'off' : 'ok',
      hint: pass ? tr(`✓ 稳稳地唱了 ${secs} 秒`, `✓ Steady for ${secs} s`) : broke ? tr(`${broke}（稳定了 ${stable.toFixed(1)} 秒）——换口气，再来一次，出气要匀`, `${broke} (steady for ${stable.toFixed(1)} s) — take a breath and try again, with an even airflow`) : off || tr(`很稳，继续（${stable.toFixed(1)} / ${secs} 秒）`, `Nice and steady, keep going (${stable.toFixed(1)} / ${secs} s)`),
    }, [
      { name: tr('音高稳定', 'Pitch'), text: tr(`音高变化 ${Math.round(pR)} 音分`, `pitch moved ${Math.round(pR)} cents`), full: tr('≤ 10 音分', '≤ 10 cents'), s: better(pR, 10, pitchTol), w: 0.65,
        tip: tr('越到后面越要保持气息往前送，别让音往下掉。', 'Towards the end keep the breath moving forward so the note doesn’t sink.') },
      { name: tr('音量稳定', 'Volume'), text: tr(`音量变化 ${lR.toFixed(1)} dB`, `volume moved ${lR.toFixed(1)} dB`), full: '≤ 2 dB', s: better(lR, 2, levelTol), w: 0.35,
        tip: tr('像慢慢吹蜡烛一样匀速出气，最后几秒别泄气。', 'Let the air out steadily, as if slowly blowing on a candle — don’t let go in the last seconds.') },
    ]);
  };
}

// Siren: one continuous glide from lo up to hi and back down, without a break.
function glide(lo, hi) {
  return (take) => {
    const run = lastRun(take.frames);
    if (!run) return idle(tr(`用唇颤音“嘟噜”或“呜”，从 ${midiName(lo)} 慢慢滑到 ${midiName(hi)} 再滑回来，中间不断`, `On a lip trill or “oo”, slide slowly from ${midiName(lo)} up to ${midiName(hi)} and back, without a break`));
    const t0 = run[0].t, t1 = run[run.length - 1].t;
    const brk = take.m.breaks.some((b) => b.t >= t0 && b.t <= t1);
    let topAt = -1;
    for (let i = 0; i < run.length; i++) if (run[i].midi >= hi - 0.5) { topAt = i; break; }
    const back = topAt >= 0 && run.slice(topAt).some((f) => f.midi <= lo + 1);
    const maxM = Math.max(...run.map((f) => f.midi));
    const up = Math.min(1, Math.max(0, (maxM - lo) / (hi - lo)));
    const progress = back ? 1 : topAt >= 0 ? 0.6 + 0.4 * Math.min(1, (hi - run[run.length - 1].midi) / (hi - lo)) : 0.6 * up;
    const pass = back && !brk;
    // smoothness: small pitch jumps (> 0.6 semitone between frames) and how much
    // the level swings along the glide (breaks show as abrupt pitch/level changes)
    let jerks = 0;
    for (let i = 1; i < run.length; i++) if (run[i].t - run[i - 1].t <= 0.05 && Math.abs(run[i].midi - run[i - 1].midi) > 0.6) jerks++;
    const inner = run.filter((f) => f.t - t0 >= 0.3 && t1 - f.t >= 0.3);
    const lv = inner.length > 5 ? movAvg(inner, 'db') : [0];
    const lR = Math.max(...lv) - Math.min(...lv);
    return scored({
      progress: brk ? Math.min(progress, 0.95) : progress, pass, level: brk ? 'off' : 'ok',
      hint: pass ? tr('✓ 一口气滑上去又滑下来，没有断开', '✓ Up and back down in one breath, no break')
        : brk ? tr('声音断开了（音高和音量突然跳）——停一下，更轻、更慢地再滑一次', 'The voice broke (pitch and volume jumped) — pause, then slide again lighter and slower')
        : topAt < 0 ? tr(`继续往上滑，到 ${midiName(hi)}`, `Keep sliding up to ${midiName(hi)}`) : tr(`很好，现在滑回 ${midiName(lo)}`, `Good, now slide back to ${midiName(lo)}`),
    }, [
      { name: tr('连贯', 'Smoothness'), text: jerks ? tr(`小跳动 ${jerks} 次`, `${jerks} small jumps`) : tr('没有跳动', 'no jumps'), full: tr('0 次', '0'), s: better(jerks, 0, 4), w: 0.5,
        tip: tr('滑得再慢一点、轻一点，经过换声的地方不要“跳”过去。', 'Slide slower and lighter; don’t “jump” across the register change.') },
      { name: tr('音量均匀', 'Even volume'), text: tr(`音量起伏 ${Math.round(lR)} dB`, `volume swings ${Math.round(lR)} dB`), full: '≤ 8 dB', s: better(lR, 8, 24), w: 0.5,
        tip: tr('往高处滑时别跟着变响，从头到尾保持同样的音量。', 'Don’t get louder as you slide up; keep the same volume throughout.') },
    ]);
  };
}

// Messa di voce: one note, soft → loud → soft, pitch unchanged.
function messa(target, minRange, minDur) {
  return (take) => {
    const run = lastRun(take.frames);
    if (!run) return idle(tr(`在 ${midiName(target)} 上唱“啊”，从很轻开始`, `Sing “ah” on ${midiName(target)}, starting very softly`));
    const body = run.filter((f) => f.t - run[0].t >= 0.2);
    if (body.length < 5) return { progress: 0, pass: false, level: 'ok', hint: tr('从很轻开始，慢慢变响…', 'Start very soft, slowly get louder…') };
    const ml = movAvg(body, 'db');
    const dur = body[body.length - 1].t - body[0].t;
    let pk = 0;
    for (let i = 1; i < ml.length; i++) if (ml[i] > ml[pk]) pk = i;
    const rise = ml[pk] - ml[0], fall = ml[pk] - ml[ml.length - 1];
    const tgt = inOctave(body[body.length >> 1].midi, target);
    const offPitch = body.filter((f) => Math.abs(f.midi - tgt) > 0.4).length / body.length;
    const peakPos = (body[pk].t - body[0].t) / (dur || 1);
    const pass = dur >= minDur && rise >= minRange && fall >= minRange * 0.8 && offPitch <= 0.15 && peakPos > 0.2 && peakPos < 0.85;
    let hint;
    if (pass) hint = tr(`✓ 音量变化 ${Math.round(Math.max(rise, fall))} dB，音高没跑`, `✓ Volume changed ${Math.round(Math.max(rise, fall))} dB and the pitch stayed put`);
    else if (offPitch > 0.15) hint = tr(`音高跟着音量跑了——对准 ${midiName(target)}，只改变音量`, `The pitch moved with the volume — stay on ${midiName(target)} and change only the volume`);
    else if (rise < minRange) hint = tr(`慢慢变响（已经 +${Math.max(0, Math.round(rise))} dB，要 +${minRange} dB）`, `Slowly get louder (+${Math.max(0, Math.round(rise))} dB so far, need +${minRange} dB)`);
    else if (fall < minRange * 0.8) hint = tr('现在慢慢收小，回到很轻', 'Now slowly back down to very soft');
    else hint = tr(`整个过程至少 ${minDur} 秒，再慢一点`, `Take at least ${minDur} s for the whole thing — slower`);
    const progress = Math.min(1, 0.45 * Math.min(1, Math.max(0, rise) / minRange) + 0.45 * Math.min(1, Math.max(0, fall) / (minRange * 0.8)) + 0.1 * Math.min(1, dur / minDur));
    const pitchDev = mean(body.map((f) => Math.abs(f.midi - tgt) * 100));
    return scored({ progress, pass, level: offPitch > 0.15 ? 'off' : 'ok', hint }, [
      { name: tr('音量变化', 'Range'), text: tr(`变响 ${Math.round(rise)} dB、收回 ${Math.round(fall)} dB`, `up ${Math.round(rise)} dB, back ${Math.round(fall)} dB`), full: '≥ 15 dB', s: more((rise + fall) / 2, minRange, 15), w: 0.4,
        tip: tr('轻的时候再轻一点，响的时候可以再响一点（但别喊）。', 'Go softer at the soft end and a bit louder at the peak (without shouting).') },
      { name: tr('音高稳定', 'Pitch'), text: tr(`平均偏离 ${Math.round(pitchDev)} 音分`, `average ${Math.round(pitchDev)} cents off`), full: tr('≤ 10 音分', '≤ 10 cents'), s: better(pitchDev, 10, 40), w: 0.4,
        tip: tr('变响时音高容易往上跑、变轻时容易往下掉——只改音量，音高不动。', 'Pitch tends to rise as you get louder and sink as you get softer — change only the volume.') },
      { name: tr('平稳对称', 'Symmetry'), text: tr(`最响的地方在 ${Math.round(peakPos * 100)}% 处`, `loudest at ${Math.round(peakPos * 100)}%`), full: tr('在中间（50%）', 'in the middle (50%)'), s: clamp01(1 - Math.abs(peakPos - 0.5) / 0.3), w: 0.2,
        tip: tr('变响和变轻用差不多的时间，慢慢来。', 'Take about as long getting louder as getting softer — slowly.') },
    ]);
  };
}

// Ascending notes without the level climbing more than maxRise dB.
// fullRise: going up naturally adds a few dB at the same effort — full marks up to that
function noShout(targets, maxRise, fullRise) {
  const seq = sequence(targets, 0.25, 50);
  return (take) => {
    const r = seq(take);
    if (!r.got || !r.got.length) return r;
    const first = r.got[0];
    const top = Math.max(...targets);
    const highs = r.got.filter((n) => n.target === top);
    if (!r.pass) {
      const partial = r.got.length > 1 ? Math.max(...r.got.map((n) => n.db)) - first.db : NaN;
      if (partial > maxRise) return { ...r, level: 'off', hint: tr(`音量已经涨了 ${Math.round(partial)} dB——越往上越轻（${r.hint}）`, `Already ${Math.round(partial)} dB louder — lighter as you go up (${r.hint})`) };
      return r;
    }
    const rise = Math.max(...highs.map((n) => n.db)) - first.db;
    const pass = rise <= maxRise;
    return scored({
      ...r, pass, progress: pass ? 1 : 0.9, level: pass ? 'ok' : 'off',
      hint: pass ? tr(`✓ 最高音只比起始音响 ${Math.max(0, Math.round(rise))} dB，没有喊`, `✓ The top note was only ${Math.max(0, Math.round(rise))} dB louder than the first — no shouting`) : tr(`最高音比起始音响了 ${Math.round(rise)} dB（要 ≤ ${maxRise} dB）——越往上越轻、嘴型越窄，再来一次`, `The top note was ${Math.round(rise)} dB louder than the first (needs ≤ ${maxRise} dB) — lighter and narrower as you go up; try again`),
    }, [
      { name: tr('不喊', 'No shouting'), text: tr(`最高音比第一个音响 ${Math.max(0, Math.round(rise))} dB`, `top note ${Math.max(0, Math.round(rise))} dB louder than the first`), full: `≤ ${fullRise} dB`, s: better(Math.max(0, rise), fullRise, maxRise), w: 0.6,
        tip: tr('往上时想着“越高越轻”，嘴型往窄收，最高音前先减一点音量。', 'Think “higher = lighter” going up, narrow the mouth, and ease off a little before the top note.') },
      ...seqParts(r.got).slice(0, 1).map((p) => ({ ...p, w: 0.4 })),
    ]);
  };
}

// Maximum phonation time (最长发声时间 — a standard voice-clinic test): one
// breath, comfortable pitch and loudness, as long as possible. The longest run
// of sound (breaks ≤ 0.25 s) that stays on one note (≥ 80 % of it within ±1.5
// semitones of its median — not a melody or a siren), judged once the sound
// stops. Adult norms (ASHA; Maslan et al. 2011): men ≈ 26 s (25–35), women
// ≈ 21 s (15–25); under 10 s points to air leaking or poor breath use. Full
// marks at the average — longer isn't better.
function maxPhonation(P, min = 10) {
  const norm = P.sex === 'f' ? 21 : 26;
  return (take) => {
    const runs = runsOf(take.frames, 0.25);
    if (!runs.length) return idle(tr('吸足一口气，用舒服的音高和音量唱“啊”，一直唱到没气', 'Take a full breath and sing “ah” at a comfortable pitch and volume until you run out of air'));
    const onNote = (r) => { const m = medianOf(r.map((f) => f.midi)); return r.filter((f) => Math.abs(f.midi - m) <= 1.5).length >= 0.8 * r.length; };
    const len = (r) => r[r.length - 1].t - r[0].t;
    const cur = runs[runs.length - 1], last = take.frames[take.frames.length - 1];
    if (!take.ended && last.t - cur[cur.length - 1].t < 0.6) {
      const d = len(cur);
      return { progress: Math.min(1, d / norm), pass: false, level: 'ok', score: 0,
        hint: d < 3 ? tr('保持住，匀速出气…', 'Hold it, steady airflow…') : tr(`${d.toFixed(1)} 秒…继续，省着出气，一直唱到没气`, `${d.toFixed(1)} s… keep going, spend the air sparingly, until it runs out`) };
    }
    // the sound stopped: judge the attempt (a short false start doesn't count)
    const best = Math.max(0, ...runs.filter(onNote).map(len));
    if (best < 3) return idle(runs.some((r) => len(r) >= 3) ? tr('要一直唱同一个音（不要唱旋律或滑音），再来一次', 'Stay on one note (no melody or sliding) and try again') : tr('吸足一口气，唱一个长音，一直唱到没气', 'Take a full breath and sing one long note until you run out of air'));
    const pass = best >= min;
    return scored({
      progress: Math.min(1, best / min), pass, level: pass ? 'ok' : 'off', final: true,
      hint: pass ? tr(`✓ 一口气唱了 ${best.toFixed(1)} 秒`, `✓ ${best.toFixed(1)} s on one breath`) : tr(`一口气唱了 ${best.toFixed(1)} 秒（要 ≥ ${min} 秒）——吸气再深一点，出气再省一点，再来一次`, `${best.toFixed(1)} s on one breath (needs ≥ ${min} s) — breathe deeper, spend the air more sparingly, and try again`),
    }, [
      { name: tr('时长', 'Duration'), text: tr(`${best.toFixed(1)} 秒`, `${best.toFixed(1)} s`), full: tr(`≥ ${norm} 秒（成年${P.sex === 'f' ? '女' : '男'}性平均）`, `≥ ${norm} s (adult ${P.sex === 'f' ? 'female' : 'male'} average)`), s: more(best, min, norm), w: 1,
        tip: tr('声音别漏气：用更轻、更集中的“啊”，想象从一根细吸管里慢慢出气；吸气时肚子和腰向外扩。', 'Don’t let air leak: use a lighter, more focused “ah”, as if breathing out slowly through a thin straw; when breathing in, let the belly and waist expand.') },
    ]);
  };
}

// Straight tone or natural vibrato on one note.
function vibratoStep(target, secs, want) {
  return (take) => {
    const run = lastRun(take.frames);
    if (!run) return idle(tr(`在 ${midiName(target)} 上唱“啊”，保持 ${secs} 秒以上`, `Sing “ah” on ${midiName(target)} for ${secs} s or more`));
    const dur = run[run.length - 1].t - run[0].t;
    const va = new VibratoAnalyzer();
    for (const f of run) if (f.t - run[0].t >= 0.2) va.push(f.t, f.raw * 100);
    const v = dur >= 1.2 ? va.analyze() : null;
    // the note's centre over the last 0.8 s (vibrato swings the instantaneous pitch)
    const tail = run.filter((f) => run[run.length - 1].t - f.t <= 0.8).map((f) => f.midi).sort((a, b) => a - b);
    const cm = tail[Math.floor(tail.length / 2)];
    const off = offHint(cm, inOctave(cm, target));
    if (!v) return { progress: Math.min(0.4, dur / secs), pass: false, level: off ? 'off' : 'ok', hint: off || tr('保持…', 'Hold it…'), score: Math.round(55 * Math.min(0.4, dur / secs)) };
    const good = want === 'straight' ? v.type === 'straight' : v.type === 'healthy';
    // time-based progress, capped until the vibrato criterion is met
    const progress = Math.min(good ? 1 : 0.8, dur / secs);
    const pass = good && dur >= secs && !off;
    const desc = v.type === 'straight' ? tr('直音', 'straight tone') : v.type === 'healthy' ? tr(`自然颤音 ${v.rate.toFixed(1)} 次/秒`, `natural vibrato ${v.rate.toFixed(1)}/s`) : { tremolo: tr('颤得太快（抖）', 'vibrato too fast (bleat)'), wobble: tr('颤得太慢（晃）', 'vibrato too slow (wobble)'), wide: tr('颤得太宽', 'vibrato too wide'), irregular: tr('波动不规则', 'irregular wavering') }[v.type];
    let hint;
    if (pass) hint = tr(`✓ ${desc}，保持了 ${secs} 秒`, `✓ ${desc}, held for ${secs} s`);
    else if (off) hint = off;
    else if (want === 'straight') hint = good ? tr(`很好，直音，继续（${dur.toFixed(1)} / ${secs} 秒）`, `Good, straight tone, keep going (${dur.toFixed(1)} / ${secs} s)`) : tr(`现在是${desc}——让音高像一条直线，不要抖`, `That’s ${desc} — keep the pitch a straight line, no shaking`);
    else hint = good ? tr(`很好，${desc}，继续（${dur.toFixed(1)} / ${secs} 秒）`, `Good, ${desc}, keep going (${dur.toFixed(1)} / ${secs} s)`) : v.type === 'straight' ? tr('还是直音——放松喉咙，让声音自然地轻轻波动（像“哦~哦~”）', 'Still straight — relax the throat and let the voice waver gently (like “oh~oh~”)') : tr(`现在是${desc}——目标是每秒 5–7 次、幅度适中`, `That’s ${desc} — aim for 5–7 per second at a moderate width`);
    const dev = Math.abs((cm - inOctave(cm, target)) * 100);
    const parts = want === 'straight' ? [
      { name: tr('平直', 'Straightness'), text: tr(`波动 ±${Math.round(Math.max(v.extent, v.bandAmp))} 音分`, `wavers ±${Math.round(Math.max(v.extent, v.bandAmp))} cents`), full: tr('≤ ±8 音分', '≤ ±8 cents'), s: better(Math.max(v.extent, v.bandAmp), 8, 20), w: 0.6,
        tip: tr('想象音是一条拉直的线，下巴和舌头别动，气息匀速。', 'Imagine the note as a taut line; keep the jaw and tongue still and the airflow even.') },
      { name: tr('音准', 'Pitch'), text: tr(`偏差 ${Math.round(dev)} 音分`, `${Math.round(dev)} cents off`), full: tr('≤ 10 音分', '≤ 10 cents'), s: better(dev, 10, 50), w: 0.4,
        tip: tr('先听参考音，让线落在目标带正中间。', 'Listen to the reference first and keep the line in the middle of the target band.') },
    ] : [
      { name: tr('速度', 'Rate'), text: tr(`每秒 ${v.rate.toFixed(1)} 次`, `${v.rate.toFixed(1)} per second`), full: tr('每秒 5–6.8 次', '5–6.8 per second'), s: v.rate < 5 ? more(v.rate, 4.4, 5) : better(v.rate, 6.8, 8), w: 0.35,
        tip: v.rate < 5 ? tr('颤得有点慢：放松一点、别用气息推。', 'A bit slow: relax, don’t push with the breath.') : tr('颤得有点快：喉咙放松，让波动自然一些、别刻意抖。', 'A bit fast: relax the throat and let it move naturally; don’t shake it on purpose.') },
      { name: tr('幅度', 'Width'), text: tr(`±${Math.round(v.extent)} 音分`, `±${Math.round(v.extent)} cents`), full: tr('±30–100 音分', '±30–100 cents'), s: v.extent < 30 ? more(v.extent, 15, 30) : better(v.extent, 100, 150), w: 0.35,
        tip: v.extent < 30 ? tr('波动小了一点，可以再放开一些。', 'A little narrow — let it open up a bit.') : tr('波动太大了，收一点，别晃。', 'Too wide — rein it in, don’t wobble.') },
      { name: tr('规律', 'Regularity'), text: tr(`规律性 ${Math.round(v.regularity * 100)}%`, `${Math.round(v.regularity * 100)}% regular`), full: '≥ 85%', s: more(v.regularity, 0.45, 0.85), w: 0.3,
        tip: tr('让每次起伏都一样大小、一样快慢。', 'Make every cycle the same size and speed.') },
    ];
    return scored({ progress, pass, level: good && !off ? 'ok' : 'off', hint }, parts);
  };
}


// ------------------------------------------------------------------ 咽音 / twang
// Twang narrows the epilarynx (the ring just above the vocal folds); in the one
// singer measured by Sundberg & Thalén (2010) F1 and F2 rose, F3 and F5 fell,
// the 2–4 kHz band grew and the sound level rose, with the voice source changing
// too. The microphone can't see the throat, so these steps look for the acoustic
// cues against the singer's own plain voice on the same vowel at the same pitch:
// step 1 glides through a range plainly, and twang is then compared with that
// glide wherever it is sung (see analysis/twang.js). A pass means "the sound
// shows twang's cues", not a diagnosis.
const TW_KEY = 'vocalassistant.twang.v1';
const okBase = (b) => okCurve(b?.curve) && b.fm?.[0] > 0 && b.fm?.[1] > 0 && Number.isFinite(b.at);
// What earlier steps saved — only records that are complete and belong to the
// current reference (re-recording step 1 makes the later ones stale).
export function loadTwang() {
  let x = null;
  try { x = JSON.parse(localStorage.getItem(TW_KEY) || '{}'); } catch { /* ignore */ }
  if (!x || typeof x !== 'object' || !okBase(x.base)) return {};
  const out = { base: x.base };
  if (hasMeasures(x.twang) && Number.isFinite(x.twang.ring) && x.twang.baseAt === x.base.at) out.twang = x.twang;
  return out;
}
// true when stored; a new reference drops the records made against the old one
export function saveTwang(patch) {
  try {
    let prev = {};
    try { prev = JSON.parse(localStorage.getItem(TW_KEY) || '{}') || {}; } catch { /* ignore */ }
    localStorage.setItem(TW_KEY, JSON.stringify(patch.base ? { ...patch } : { ...prev, ...patch }));
    return true;
  } catch { return false; }
}

// medians of the twang measures over some frames
function statsOf(fr) {
  const med = (k) => medianOf(fr.map((f) => f[k]).filter(Number.isFinite));
  return { midi: med('midi'), hbr: med('hbr'), vdb: med('vdb'), hnr: med('hnrLite'), h1h2: med('h1h2'), cpp: med('cpp') };
}
// How long the voice has kept meeting `good`, up to its last frame: each frame
// is judged on the half second up to it; a failing window or a gap over 0.15 s
// starts the count again. (Not the whole note's median: 1.5 good seconds inside
// a longer note must not count as 2.)
function heldFor(frames, good, win = 0.5) {
  let start = null, prevT = -1, held = 0, j = 0;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    while (frames[j].t < f.t - win) j++;
    const w = frames.slice(j, i + 1);
    const ok = f.t - w[0].t >= 0.25 && good(statsOf(w)) && (prevT < 0 || f.t - prevT <= 0.15);
    prevT = f.t;
    if (!ok) { start = null; held = 0; continue; }
    if (start == null) start = f.t;
    held = f.t - start;
  }
  return held;
}
// noise floor in 2–4 kHz: the band's level in the quietest tenth of the take
// (there is no separate silence recording)
function floorOf(frames) {
  const v = frames.map((f) => f.hiMed).filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length * 0.1)] : -200;
}
// share of frames whose 2–4 kHz harmonic stands ≥ 12 dB above that floor
const cleanOf = (fr, floor) => (fr.length ? fr.filter((f) => f.hiPk - floor >= 12).length / fr.length : 0);
// formants F1–F5 (the vowel) from frames whose pitch lets them be measured
function vowelOfFrames(fr) {
  const withFm = fr.filter((f) => f.fm && formantTrust(f.f0) !== 'none');
  return withFm.length >= 5 ? fmMedians(withFm.map((f) => f.fm)) : null;
}

// The note being held now: the last stretch of sound (gaps ≤ 0.25 s) on one
// pitch, onset (0.3 s) skipped.
function heldNote(frames) {
  const runs = runsOf(frames, 0.25), run = runs[runs.length - 1];
  if (!run) return null;
  const m = medianOf(run.map((f) => f.midi));
  const body = run.filter((f) => f.t - run[0].t >= 0.3 && Math.abs(f.midi - m) <= 1);
  if (body.length < 5) return { dur: 0, midi: m, body: [] };
  return {
    ...statsOf(body), body, fm: vowelOfFrames(body),
    dur: body[body.length - 1].t - body[0].t, clean: cleanOf(body, floorOf(frames)),
  };
}
// the last `secs` of a note
const tail = (body, secs) => body.filter((f) => f.t >= body[body.length - 1].t - secs);
const dB = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(1)} dB`;
// sound without a clear pitch for ≥ 1 s of the last 1.5 s: squeezed, breathy or noise
function noTone(frames) {
  if (!frames.length) return false;
  const end = frames[frames.length - 1].t, rec = frames.filter((f) => end - f.t <= 1.5 && !f.muted);
  const loud = rec.filter((f) => f.db > -48), hop = rec.length > 1 ? (rec[rec.length - 1].t - rec[0].t) / (rec.length - 1) : 0.02;
  return loud.length * hop >= 1 && loud.filter((f) => f.voiced).length < 0.3 * loud.length;
}
const off = (hint, extra = {}) => ({ progress: 0, pass: false, level: 'off', score: 0, hint, ...extra });
const roughMsg = () => off(tr('听到了声音，但听不出清楚的音高：可能是喉咙挤了、在用气声，或者环境太吵。放松喉咙，用更轻的声音重新找咽音的“尖”。', 'There’s sound but no clear pitch: the throat may be squeezing, the voice breathy, or the room noisy. Relax the throat and find the twang’s sharpness again, more softly.'));
const noteOf = (m) => midiName(Math.round(m));
const tooNoisy = off(tr('环境太吵：2–4 kHz 一带听不清你的声音。换个安静的地方，离麦克风近一点。', 'Too noisy: your voice can’t be heard clearly in the 2–4 kHz band. Move somewhere quieter, closer to the microphone.'));
const noData = off(tr('2–4 kHz 一带测不到你声音的谐波（太轻、太吵或离麦克风太远），这次没法判断。唱响一点、离麦克风 20–30 cm 再试。', 'No harmonics of your voice measurable at 2–4 kHz (too soft, too noisy or too far from the microphone) — can’t judge this one. Sing a little louder, 20–30 cm from the microphone.'));
const vName = (fm, sex) => { const v = fm && vowelOf(fm[0], fm[1], sex); return v ? tr(v.zh, v.en.split(' ')[0]) : '?'; };
// The comparisons only mean something on the same vowel: changing it moves the
// formants and so the highs (“诶” is brighter than “啊” by nature).
const vowelMsg = (ref, n, sex) => off(tr(`元音和第 1 步不一样：第 1 步像“${vName(ref, sex)}”，现在像“${vName(n, sex)}”。换元音本身就会改变高频（比如“诶”天生比“啊”亮），这样比出来的不全是咽音。请每一步都用同一个元音：这一步也唱“${vName(ref, sex)}”，或者回第 1 步用“${vName(n, sex)}”重新滑一遍。`,
  `The vowel differs from step 1: step 1 sounded like “${vName(ref, sex)}”, now like “${vName(n, sex)}”. Changing the vowel alone changes the highs (“eh” is brighter than “ah” by nature), so the difference isn’t all twang. Use one vowel throughout: sing “${vName(ref, sex)}” here too, or redo step 1 on “${vName(n, sex)}”.`), { vowelClash: true });
const rangeMsg = (B, m) => off(tr(`这个音（${noteOf(m)}）不在第 1 步滑过的范围里（${noteOf(B.curve.lo)}–${noteOf(B.curve.hi)}），没有普通唱法可比。在这个范围里唱，或者回第 1 步滑得更宽一些。`, `This note (${noteOf(m)}) is outside the range glided in step 1 (${noteOf(B.curve.lo)}–${noteOf(B.curve.hi)}), so there’s no plain voice to compare with. Sing within it, or redo step 1 with a wider glide.`));
const noVowelMsg = () => off(tr('测不出现在的元音，没法核对是不是第 1 步的元音：音唱稳一点、别太轻，太高的音也测不出来。', 'Can’t make out the vowel now, so it can’t be checked against step 1: hold the note steadier and not too softly; on very high notes it can’t be measured.'));
// a reference that can't be compared with (from an older version, or broken)
const redoBase = () => off(tr('第 1 步的记录不完整或是旧版本留下的（现在第 1 步改成了滑音），请重做第 1 步。', 'Step 1’s record is incomplete or from an older version (step 1 is now a glide) — please redo step 1.'));
// the verdict's thresholds at a difficulty level (analysis/twang.js LEVELS)
const vOpts = (L, extra = {}) => ({ ringMin: L.ring, perDb: L.perDb, roughMax: L.rough, cppMax: L.cpp, ...extra });
// what the closure verdict says, in words
const closureText = (c) => (!c || c.state === 'unknown' ? tr('测不到', 'not measured')
  : c.state === 'breathy' ? tr(`漏气（周期性降了 ${c.dCpp.toFixed(0)} dB${Number.isFinite(c.dH) ? `，H1−H2 ${c.dH >= 0 ? '+' : ''}${c.dH.toFixed(0)} dB` : ''}）`, `air leaking (periodicity −${c.dCpp.toFixed(0)} dB${Number.isFinite(c.dH) ? `, H1−H2 ${c.dH >= 0 ? '+' : ''}${c.dH.toFixed(0)} dB` : ''})`)
  : c.state === 'pressed' ? tr(`挤（周期性降了 ${c.dCpp.toFixed(0)} dB，闭得紧但振动不规则）`, `squeezed (periodicity −${c.dCpp.toFixed(0)} dB, closed tight but irregular)`)
  : Number.isFinite(c.dH) && c.dH <= -1 ? tr('闭合好，比普通唱法更紧', 'closing well, firmer than the plain voice') : tr('闭合好', 'closing well'));
const levelName = (L) => ({ easy: tr('入门', 'beginner'), std: tr('标准', 'standard'), strict: tr('严格', 'strict') })[L.id];

// Words for a verdict that blocks judging (null when it can be judged)
function verdictMsg(v, B, n, sex) {
  if (v.status === 'unknown') return noData;
  if (v.status === 'range') return rangeMsg(B, n.midi);
  if (v.status === 'vowel') return vowelMsg(B.fm, n.fm, sex);
  if (v.status === 'novowel') return noVowelMsg();
  return null;
}

// 1. the plain voice gliding slowly up and down on one vowel: the reference curve
function twangGlide(lo, hi, sex = 'm') {
  return (take) => {
    const fr = take.frames.filter((f) => f.voiced && !f.muted);
    if (fr.length < 10) return idle(tr(`选一个元音（推荐“诶”），用平常的方式，从 ${midiName(lo)} 附近慢慢滑到 ${midiName(hi)} 附近再滑下来（像警报声），一口气约 6 秒`, `Pick a vowel (“eh” recommended) and glide plainly from about ${midiName(lo)} up to about ${midiName(hi)} and back down, slowly (like a siren), about 6 s in one breath`));
    const floor = floorOf(take.frames), clean = cleanOf(fr, floor);
    if (fr.length >= 40 && clean < 0.6) return tooNoisy;
    const curve = buildCurve(fr.map((f) => ({ midi: f.midi, hbr: f.hbr, vdb: f.vdb, hnr: f.hnrLite, h1h2: f.h1h2, cpp: f.cpp }))), span = curveSpan(curve), fm = vowelOfFrames(fr);
    const enough = span >= GLIDE_SPAN;
    // judged once the glide is over (0.4 s quiet): passing mid-glide would stop
    // the recording and cut off the rest of it
    const ended = take.ended || take.frames[take.frames.length - 1].t - fr[fr.length - 1].t >= 0.4;
    if (enough && !fm) return off(tr('滑音范围够了，但测不出是哪个元音（音都太高了）：从更低的音开始滑。', 'The range is wide enough, but the vowel can’t be made out (the notes are all too high): start the glide lower.'));
    const pass = enough && !!fm && ended;
    const ev = scored({
      progress: Math.min(pass ? 1 : 0.95, span / GLIDE_SPAN), pass, level: 'ok',
      hint: pass ? tr(`✓ 基准记下了：普通唱法 ${noteOf(curve.lo)}–${noteOf(curve.hi)}，元音像“${vName(fm, sex)}”。下一步在这个范围里任选一个音唱咽音，用同一个元音`, `✓ Reference saved: plain voice ${noteOf(curve.lo)}–${noteOf(curve.hi)}, vowel like “${vName(fm, sex)}”. Next, twang on any note in that range, same vowel`)
        : enough ? tr(`范围够了（${span.toFixed(1)} 个半音），滑完停下就记下`, `Range is enough (${span.toFixed(1)} semitones) — finish the glide and stop to save it`)
        : tr(`继续慢慢滑…已经覆盖 ${span.toFixed(1)} 个半音（要 ≥ ${GLIDE_SPAN}，大约五度）`, `Keep gliding slowly… ${span.toFixed(1)} semitones covered (need ≥ ${GLIDE_SPAN}, about a fifth)`),
    }, [
      { name: tr('范围', 'Range'), text: tr(`覆盖 ${span.toFixed(1)} 个半音`, `${span.toFixed(1)} semitones covered`), full: tr('≥ 12 个半音', '≥ 12 semitones'), s: more(span, GLIDE_SPAN - 2, 12), w: 1,
        tip: tr('滑得越宽，下一步可以唱咽音的音就越多。', 'The wider the glide, the more notes you can twang on next.') },
    ]);
    if (pass) ev.save = { base: { v: 3, curve, fm, midi: (curve.lo + curve.hi) / 2, at: Date.now() } };
    return ev;
  };
}

// 2. twang on any note in the glide's range: much more ring than the plain voice
// there, not just louder, not squeezed, kept without a break — how much and how
// long by the difficulty level L
function twangOn(sex = 'm', L = levelOf('easy')) {
  const secs = L.hold;
  return (take, ctx) => {
    const B = ctx?.base;
    if (!B) return idle(tr('先完成第 1 步：用普通唱法滑一遍音，作为对比基准', 'Do step 1 first: a plain glide as the reference'));
    if (!okBase(B)) return redoBase();
    const n = heldNote(take.frames);
    if ((!n || n.dur <= 0) && noTone(take.frames)) return roughMsg();
    if (!n || n.dur <= 0) return idle(tr(`在 ${noteOf(B.curve.lo)}–${noteOf(B.curve.hi)} 之间任选一个舒服的音，用第 1 步的元音（${vName(B.fm, sex)}）唱咽音：像小鸭子“嘎嘎”、“nyeah”或撒娇的哭腔，声音又亮又尖、集中在前面。音高跑一点没关系`, `Pick any comfortable note between ${noteOf(B.curve.lo)} and ${noteOf(B.curve.hi)} and sing the step-1 vowel (${vName(B.fm, sex)}) with twang: like a duck’s quack, “nyeah”, or a whiny cry — bright, sharp, focused at the front. The pitch may wander a little`));
    if (n.dur >= 1 && n.clean < 0.6) return tooNoisy;
    // now = the last 0.6 s; the vowel from the whole note (formants need frames)
    const now = { ...statsOf(tail(n.body, 0.6)), fm: n.fm };
    const v = twangVerdict(B, now, vOpts(L));
    if (n.dur >= 0.6 || v.status === 'range') { const m = verdictMsg(v, B, now, sex); if (m) return m; }
    if (!Number.isFinite(v.ring)) return idle(tr('保持住…', 'Hold it…'));
    const { ring, loud, rough } = v;
    const held = heldFor(n.body, (w) => twangVerdict(B, { ...w, fm: n.fm }, vOpts(L)).status === 'twang');
    const meter = { label: tr(`咽音计：2–4 kHz 相对低频的比例，比你同一音高的普通唱法提高了多少（${levelName(L)}：要 ≥ ${L.ring} dB；整体变响不算）`, `Twang meter: how much the 2–4 kHz share (relative to the lows) rose over your plain voice at this pitch (${levelName(L)}: need ≥ ${L.ring} dB; getting louder doesn’t count)`), value: ring, unit: 'dB', target: L.ring, max: Math.max(18, L.ring + 6) };
    let problem = null;
    if (n.dur >= 0.8) {
      if (v.status === 'breathy') problem = tr(`声带没闭好，在漏气：声音的周期性比同一音高的普通唱法降了 ${v.closure.dCpp.toFixed(0)} dB，多出来的是气流噪声。气声会让高频看起来变强，这种“亮”不算咽音。先哼“嗯”找声音集中、不漏气的感觉，再打开成元音；音量小一点也没关系。`, `The vocal folds aren’t closing — air is leaking: the voice’s periodicity is ${v.closure.dCpp.toFixed(0)} dB below your plain voice at this pitch, the rest is breath noise. Breathiness makes the highs look stronger; that “brightness” isn’t twang. Hum “mm” to find a focused sound with no air leaking, then open into the vowel; softer is fine.`);
      else if (v.status === 'pressed') problem = tr(`挤了：声带闭得很紧但振动不规则（周期性降了 ${v.closure.dCpp.toFixed(0)} dB），声音发紧、发粗。咽音是会厌上方收窄，不是声带使劲：放松喉咙、别憋气，音量小一点再找“尖”的感觉；嗓子发紧或疼就停下。`, `Squeezed: the folds close hard but vibrate irregularly (periodicity −${v.closure.dCpp.toFixed(0)} dB), so the tone is tight and rough. Twang narrows the space above the folds; it isn’t pushing with the folds. Loosen the throat, don’t hold your breath, go softer and find the “sharp” sound again; stop if it feels tight or hurts.`);
      else if (v.status === 'rough') problem = tr(`杂音变多了：谐波比普通唱法弱了 ${rough.toFixed(0)} dB，多出来的是噪声——可能是漏气（气声），也可能是喉咙挤了。这种“亮”不算：气声和挤卡都会让高频看起来变强。放松、声音集中不漏气，音量小一点再找“尖”的感觉。`, `More noise: the harmonics are ${rough.toFixed(0)} dB weaker against it than in the plain voice — air leaking (breathy) or a squeezed throat. That “brightness” doesn’t count: both make the highs look stronger. Relax, keep the sound focused with no air leaking, go a little softer and find the “sharp” sound again.`);
      else if (v.status === 'shout') problem = tr(`主要是变响了：比同一音高的普通唱法响了 ${dB(loud)}，穿透力只提高了 ${ring.toFixed(0)} dB，远赶不上音量涨的——听起来更像喊。音量保持和第 1 步差不多，只让声音变尖、变集中。`, `Mostly louder: ${dB(loud)} louder than your plain voice at this pitch but only ${ring.toFixed(0)} dB more ring, far less than the loudness gained — closer to shouting. Keep the loudness of step 1 and make the sound sharper and more focused instead.`);
    }
    const good = v.status === 'twang';
    const pass = good && held >= secs;
    const ev = scored({
      progress: Math.min(pass ? 1 : 0.95, good ? held / secs : 0.5 * Math.max(0, ring) / L.ring), pass, level: problem || !good ? 'off' : 'ok', meter,
      twang: { ring, loud, zone: good ? 'twang' : v.zone === 'shout' ? 'shout' : 'plain' }, closure: v.closure,
      hint: pass ? tr(`✓ 有咽音的声学特征（${levelName(L)}）：在 ${noteOf(now.midi)}，2–4 kHz 相对低频比普通唱法提高了 ${ring.toFixed(0)} dB，音量只变了 ${dB(loud)}，保持了 ${held.toFixed(1)} 秒`, `✓ Twang’s acoustic cues (${levelName(L)}): on ${noteOf(now.midi)} the 2–4 kHz share rose ${ring.toFixed(0)} dB over the plain voice, loudness changed only ${dB(loud)}, held ${held.toFixed(1)} s`)
        : problem || (ring < L.ring ? tr(`还不够亮：2–4 kHz 相对低频只比普通唱法提高了 ${Math.max(0, ring).toFixed(1)} dB（${levelName(L)}要 ≥ ${L.ring}）。想着“鸭子叫”“nyeah”，声音往前、往尖里收，嘴角稍往两边`, `Not bright enough yet: the 2–4 kHz share rose only ${Math.max(0, ring).toFixed(1)} dB over the plain voice (${levelName(L)}: need ≥ ${L.ring}). Think “quack” or “nyeah”, bring the sound forward and sharper, lips slightly spread`)
          : tr(`很好，保持住（${held.toFixed(1)} / ${secs} 秒）`, `Good, hold it (${held.toFixed(1)} / ${secs} s)`)),
    }, [
      { name: tr('咽音', 'Twang'), text: tr(`2–4 kHz 多出 ${ring.toFixed(0)} dB`, `${ring.toFixed(0)} dB more 2–4 kHz`), full: `≥ ${L.ring + 6} dB`, s: more(ring, L.ring, L.ring + 6), w: 0.5,
        tip: tr('再尖一点、再集中一点：想象声音从鼻梁前面射出去（但不是鼻音）。', 'Sharper and more focused: imagine the sound shooting out in front of the bridge of your nose (not through it).') },
      { name: tr('不靠喊', 'Not shouted'), text: tr(`音量 ${dB(loud)}`, `loudness ${dB(loud)}`), full: '≤ +6 dB', s: better(Math.max(0, loud), 6, 14), w: 0.25,
        tip: tr('音量别加：这种亮应该来自共鸣，不是用力。', 'Don’t add volume: the brightness should come from resonance, not effort.') },
      { name: tr('声带闭合', 'Fold closure'), text: closureText(v.closure), full: tr('不漏气、不挤', 'no air leaking, not squeezed'), s: Number.isFinite(v.closure?.dCpp) ? better(Math.max(0, v.closure.dCpp), 1, L.cpp) : better(Math.max(0, rough), 1, L.rough), w: 0.25,
        tip: tr('漏气：先哼“嗯”找集中的声音；挤：放松喉咙、别憋气、音量小一点。嗓子发紧、发痒或疼就停下休息。', 'Air leaking: hum “mm” to find a focused sound; squeezed: loosen the throat, don’t hold your breath, go softer. Stop and rest if it feels tight, tickles or hurts.') },
    ]);
    if (pass) ev.save = { twang: { midi: now.midi, hbr: now.hbr, vdb: now.vdb, hnr: now.hnr, ring, loud, fm: n.fm, level: L.id, baseAt: B.at, at: Date.now() } };
    return ev;
  };
}

// 3. nose pinched: an oral twang hardly changes. Both takes are measured against
// the plain glide at their own pitch, so the note may differ; still two separate
// takes, so a change can also come from the vowel, the loudness or the distance
// to the microphone — the words say so.
function twangPinch(L = levelOf('easy')) {
  const secs = L.hold, keep = L.ring - 1; // still clearly twang with the nose pinched
  return (take, ctx) => {
    const W = ctx?.twang, B = ctx?.base;
    if (!W || !B) return idle(tr('先完成第 2 步（咽音）', 'Do step 2 first (the twang)'));
    if (!okBase(B)) return redoBase();
    const n = heldNote(take.frames);
    if ((!n || n.dur <= 0) && noTone(take.frames)) return off(tr('捏鼻子后听不出清楚的音高了——可能声音大部分走了鼻腔，也可能挤了。把软腭抬起来（像打哈欠开头），再唱一次。', 'With the nose pinched there’s no clear pitch left — maybe most of the sound went through the nose, or it’s squeezed. Lift the soft palate, as at the start of a yawn, and sing again.'));
    if (!n || n.dur <= 0) return idle(tr(`用手指捏住鼻子，再唱一次刚才的咽音（在 ${noteOf(W.midi)} 附近）`, `Pinch your nose shut and sing the same twang again (around ${noteOf(W.midi)})`));
    if (n.dur >= 1 && n.clean < 0.6) return tooNoisy;
    // (no vowel check here: nasal coupling itself moves the formants)
    const now = statsOf(tail(n.body, 0.6));
    const v = twangVerdict(B, now, vOpts(L, { allowNoVowel: true, ringMin: keep }));
    if (v.status === 'range') return rangeMsg(B, now.midi);
    if (v.status === 'unknown') return n.dur >= 1 ? noData : idle(tr('保持住…', 'Hold it…'));
    const dRing = v.ring - W.ring, dLoud = v.loud - W.loud;
    const same = (s) => { const x = twangVerdict(B, s, vOpts(L, { allowNoVowel: true, ringMin: keep })); return Number.isFinite(x.ring) && Math.abs(x.ring - W.ring) <= 4 && Math.abs(x.loud - W.loud) <= 4 && x.ring >= keep; };
    const held = heldFor(n.body, same);
    const ok = same(now), pass = ok && held >= secs;
    const meter = { label: tr('捏鼻子前后穿透力的差（越接近 0 越好，±4 dB 以内）', 'Ring change with the nose pinched (closer to 0 is better, within ±4 dB)'), value: Math.abs(dRing), unit: 'dB', target: 4, max: 12, lower: true };
    const changed = n.dur >= 0.8 && (Math.abs(dRing) > 4 || Math.abs(dLoud) > 4);
    return scored({
      progress: Math.min(pass ? 1 : 0.95, ok ? held / secs : 0.3), pass, level: changed || !ok ? 'off' : 'ok', meter,
      hint: pass ? tr('✓ 捏鼻子前后几乎一样：声音没有明显走鼻腔', '✓ Almost the same with the nose pinched: no sign of sound going through the nose')
        : changed ? tr(`捏鼻子后声音变了（穿透力 ${dB(dRing)}，音量 ${dB(dLoud)}，都是和同一音高的普通唱法比）。可能有一部分声音走了鼻腔（鼻音咽音）——把软腭抬起来，像打哈欠的开头那一下，别唱成带“嗯”的鼻音。也可能只是元音、音量或离麦克风的距离变了：先确认这几样和第 2 步一样，再试一次。`, `The sound changed with the nose pinched (ring ${dB(dRing)}, loudness ${dB(dLoud)}, both against the plain voice at the same pitch). Part of it may go through the nose (nasal twang) — lift the soft palate as at the start of a yawn, without the “ng” nasal. Or just the vowel, the loudness or the distance to the microphone changed: make sure those match step 2, then try again.`)
        : v.ring < keep ? tr('咽音变弱了：保持第 2 步那种又尖又亮的声音', 'The twang faded: keep the sharp, bright sound of step 2')
        : tr(`保持…（${held.toFixed(1)} / ${secs} 秒）`, `Hold it… (${held.toFixed(1)} / ${secs} s)`),
    }, [
      { name: tr('不走鼻腔', 'Oral'), text: tr(`穿透力差 ${dB(dRing)}`, `ring change ${dB(dRing)}`), full: '≤ 1.5 dB', s: better(Math.abs(dRing), 1.5, 5), w: 0.7,
        tip: tr('软腭再抬高一点，想着打哈欠开头时口腔后部那种“拱起来”的感觉。', 'Lift the soft palate a bit more: the arched feeling at the back of the mouth when a yawn begins.') },
      { name: tr('咽音保持', 'Twang kept'), text: tr(`比普通唱法多 ${v.ring.toFixed(0)} dB`, `${v.ring.toFixed(0)} dB over the plain voice`), full: `≥ ${keep + 5} dB`, s: more(v.ring, keep, keep + 5), w: 0.3,
        tip: tr('捏鼻子时别松掉咽音。', 'Don’t let go of the twang while pinching.') },
    ]);
  };
}

// The five-note pattern, placed inside the glide: from the twang note − 2 where
// it fits, else as near as the glide allows
const SCALE = [0, 2, 4, 5, 7, 5, 4, 2, 0];
function scaleRoot(P, ctx) {
  const c = ctx?.base?.curve;
  if (!okCurve(c)) return P.mid;
  const want = Math.round((ctx.twang?.midi ?? (c.lo + c.hi) / 2)) - 2;
  return Math.max(Math.ceil(c.lo), Math.min(Math.floor(c.hi) - 7, want));
}
const scaleTargets = (P, ctx) => SCALE.map((d) => scaleRoot(P, ctx) + d);

// 4. the five notes with twang: every note against the plain glide at its pitch,
// with all of step 2's checks (vowel where it can be measured, not shouted, not
// squeezed)
function twangScale(L = levelOf('easy')) {
  return (take, ctx, P) => {
    const B = ctx?.base;
    if (!B) return idle(tr('先完成第 1 步（普通唱法滑音）', 'Do step 1 first (the plain glide)'));
    if (!okBase(B)) return redoBase();
    if (curveSpan(B.curve) < 7) return off(tr('第 1 步滑过的范围不到五度，装不下五音：回第 1 步滑宽一些。', 'Step 1’s glide spans less than a fifth, too narrow for the five notes: redo step 1 wider.'));
    const targets = scaleTargets(P, ctx), seq = sequence(targets, 0.3)(take);
    const got = seq.got || [];
    for (let i = 0; i < got.length; i++) {
      // the vowel can't be measured on high notes: those are judged without it
      const v = twangVerdict(B, { ...got[i], fm: got[i].fm }, vOpts(L, { ringMin: L.scaleRing, allowNoVowel: true }));
      if (v.status === 'twang') continue;
      const what = {
        unknown: tr('测不到 2–4 kHz 的谐波', 'no harmonics measurable at 2–4 kHz'),
        range: tr('不在第 1 步滑过的范围里', 'outside the glide of step 1'),
        vowel: tr('元音变了', 'the vowel changed'),
        rough: tr('声音变粗糙了（挤或漏气）', 'the tone turned rough (squeezed or breathy)'),
        breathy: tr('漏气了（声带没闭好）', 'air leaking (the folds aren’t closing)'),
        pressed: tr('挤了（闭得紧但振动不规则）', 'squeezed (closed tight but irregular)'),
        shout: tr(`主要是变响了（音量 ${dB(v.loud ?? 0)}）`, `mostly louder (${dB(v.loud ?? 0)})`),
        plain: tr(`2–4 kHz 只比普通唱法多 ${Math.max(0, v.ring ?? 0).toFixed(0)} dB（${levelName(L)}要 ≥ ${L.scaleRing}）`, `the 2–4 kHz share only ${Math.max(0, v.ring ?? 0).toFixed(0)} dB over the plain voice (${levelName(L)}: need ≥ ${L.scaleRing})`),
      }[v.status];
      return { ...seq, pass: false, level: 'off', score: Math.min(seq.score ?? 0, 55), hint: tr(`第 ${i + 1} 个音（${midiName(targets[i])}）：${what}。从头再来，每个音都保持又尖又亮`, `Note ${i + 1} (${midiName(targets[i])}): ${what}. Start again and keep every note sharp and bright`) };
    }
    if (!seq.pass) return seq;
    const rings = got.map((g) => twangVerdict(B, g, vOpts(L, { ringMin: L.scaleRing, allowNoVowel: true })).ring);
    return scored({ ...seq, hint: tr(`✓ 每个音都有咽音的声学特征（最少多 ${Math.min(...rings).toFixed(0)} dB）`, `✓ Twang’s cues on every note (at least ${Math.min(...rings).toFixed(0)} dB extra)`) }, [
      ...seqParts(got).slice(0, 1).map((p) => ({ ...p, w: 0.5 })),
      { name: tr('咽音', 'Twang'), text: tr(`最弱的音多 ${Math.min(...rings).toFixed(0)} dB`, `weakest note ${Math.min(...rings).toFixed(0)} dB extra`), full: `≥ ${L.scaleRing + 6} dB`, s: more(Math.min(...rings), L.scaleRing, L.scaleRing + 6), w: 0.5,
        tip: tr('往上走时最容易丢：越高越要保持“尖”，别改成喊。', 'It slips most going up: keep it sharp as you rise, don’t switch to shouting.') },
    ]);
  };
}

// ------------------------------------------------------------------ lessons
// P: voice type { mid, low, high }. ref(P): notes to play as a reference.
export const LESSONS = [
  {
    id: 'pitch', name: tr('音准', 'Pitch'), desc: tr('听一个音，唱准它；再唱准一串音。', 'Hear a note and sing it in tune; then a series of notes.'),
    steps: [
      { id: 'one', title: tr('跟唱一个音', 'Match one note'), goal: tr('听参考音，用“啊”唱同一个音，唱准并保持住（累计 1.5 秒）。', 'Listen to the reference, sing the same note on “ah”, and hold it in tune (1.5 s in total).'),
        how: tr(['点“▶ 参考音”听一遍，在心里跟着哼', '用“啊”唱出来，看右边的线落在绿色目标带里（唱高或低一个八度也可以）', '偏低就往上够一点，偏高就放松往下一点'], ['Press “▶ reference”, listen, and hum along in your head', 'Sing it on “ah” and watch the line land in the green target band (an octave higher or lower is fine)', 'If flat, reach up a little; if sharp, relax down a little']),
        pass: tr('和目标音相差不超过 50 音分（半个半音），累计唱准 1.5 秒；唱高或低八度也算对，颤音没关系', 'Within 50 cents (half a semitone) of the target for 1.5 s in total; any octave counts, vibrato is fine'),
        ref: (P) => [P.mid], targets: (P) => [P.mid], check: (P) => holdNote(P.mid, 1.5) },
      { id: 'three', title: 'do–mi–sol', goal: tr('依次唱准三个音：do、mi、sol，每个保持约 1 秒。', 'Sing do, mi, sol in tune, one after another, about 1 s each.'),
        how: tr(['点“▶ 参考音”听一遍', '每个音唱“啊”约 1 秒，音和音之间可以换气', '唱到下一个音之前，先在心里听到它'], ['Press “▶ reference” and listen', 'Sing each note on “ah” for about 1 s; you may breathe between notes', 'Before each next note, hear it in your head first']),
        pass: tr('三个音依次唱准，每个在音上停留 0.35 秒以上（偏差 ≤ 50 音分；哪个八度都行）', 'All three in order, each held on pitch for 0.35 s or more (within 50 cents; any octave)'),
        ref: (P) => [P.mid, P.mid + 4, P.mid + 7], targets: (P) => [P.mid, P.mid + 4, P.mid + 7], check: (P) => sequence([P.mid, P.mid + 4, P.mid + 7], 0.35) },
      { id: 'scale', title: tr('五音上下行', 'Five-note scale'), goal: tr('唱 1-2-3-4-5-4-3-2-1，每个音都唱准。', 'Sing 1-2-3-4-5-4-3-2-1 with every note in tune.'),
        how: tr(['点“▶ 参考音”听一遍', '用“啊”或“嗒”，连着唱或分开唱都可以，每个音约半秒', '慢一点没关系，准比快重要；中间停太久（1.5 秒以上）就从头再来'], ['Press “▶ reference” and listen', 'On “ah” or “da”, legato or detached, about half a second per note', 'Slow is fine — accuracy beats speed; a pause over 1.5 s starts the pattern over']),
        pass: tr('9 个音依次唱准，每个在音上停留 0.25 秒以上。第一个音和参考音差 ≤ 50 音分；之后只要音与音之间准（≤ 50 音分），整体慢慢偏高或偏低一点没关系；哪个八度都行', 'All 9 notes in order, each held for 0.25 s or more. The first within 50 cents of the reference; after that the intervals must be within 50 cents — a slow overall drift is fine; any octave'),
        ref: (P) => [0, 2, 4, 5, 7, 5, 4, 2, 0].map((d) => P.mid + d), targets: (P) => [0, 2, 4, 5, 7, 5, 4, 2, 0].map((d) => P.mid + d),
        check: (P) => sequence([0, 2, 4, 5, 7, 5, 4, 2, 0].map((d) => P.mid + d), 0.25) },
    ],
  },
  {
    id: 'sustain', name: tr('长音与气息', 'Long notes & breath'), desc: tr('一口气把一个音唱稳、唱长：音高不跑、音量不抖，测一口气能唱多久。', 'Hold one note steady and long on one breath — pitch and volume stay put — and measure how long one breath lasts.'),
    steps: [
      { id: 's5', title: tr('稳定 5 秒', 'Steady 5 s'), goal: tr('吸一口气，用“啊”唱一个音，音高和音量都保持平稳 5 秒。', 'Breathe in and sing one note on “ah”, keeping pitch and volume steady for 5 s.'),
        how: tr(['用鼻子吸气，肚子和腰向外扩张', '像慢慢吹蜡烛一样，匀速地出气', '不要越唱越小声，也不要越唱越挤'], ['Breathe in through the nose, letting the belly and waist expand', 'Let the air out evenly, as if slowly blowing on a candle', 'Don’t fade away, and don’t squeeze']),
        pass: tr('5 秒内音高变化 ≤ 50 音分、音量变化 ≤ 8 dB（颤音没关系）', 'For 5 s: pitch moves ≤ 50 cents, volume ≤ 8 dB (vibrato is fine)'),
        ref: (P) => [P.mid + 2], targets: (P) => [P.mid + 2], check: (P) => sustain(P.mid + 2, 5, 50, 8) },
      { id: 's10', title: tr('稳定 10 秒', 'Steady 10 s'), goal: tr('同样的要求，坚持 10 秒。', 'The same, for 10 s.'),
        how: tr(['吸气更深一点', '前 3 秒出气要省着用', '最后几秒最容易往下掉，保持住'], ['Breathe in a bit deeper', 'Spend the air sparingly in the first 3 s', 'The last seconds are where it sinks — hold on']),
        pass: tr('10 秒内音高变化 ≤ 40 音分、音量变化 ≤ 6 dB（颤音没关系）', 'For 10 s: pitch moves ≤ 40 cents, volume ≤ 6 dB (vibrato is fine)'),
        ref: (P) => [P.mid + 2], targets: (P) => [P.mid + 2], check: (P) => sustain(P.mid + 2, 10, 40, 6) },
      { id: 'mpt', title: tr('一口气唱多长', 'One-breath length'), goal: tr('吸足一口气，用舒服的音高和音量唱“啊”，一直唱到没气为止。这就是嗓音检查里的“最长发声时间”。', 'Take a full breath and sing “ah” at a comfortable pitch and volume until the air runs out. This is the “maximum phonation time” of a voice check-up.'),
        how: tr(['用鼻子吸足气，肚子和腰向外扩', '用平时说话一样舒服的音高和音量——可以用参考音，也可以用自己舒服的音；不要大声', '匀速地、省着出气，一直唱到实在没气（停下来就会自动出成绩）', '可以多试几次，记最好成绩'], ['Breathe in fully through the nose, belly and waist expanding', 'Use a pitch and volume as comfortable as speaking — the reference note or your own; not loud', 'Let the air out evenly and sparingly until it’s really gone (the result appears when you stop)', 'Try a few times; the best result is kept']),
        pass: tr('一口气持续唱同一个音 ≥ 10 秒。成年男性平均约 26 秒、女性约 21 秒，达到平均就是满分（不必更长）', 'One note on one breath for ≥ 10 s. Adult men average about 26 s and women about 21 s; reaching the average is full marks (no need to go longer)'),
        ref: (P) => [P.mid], targets: (P) => [P.mid], maxSeconds: 75, check: (P) => maxPhonation(P) },
    ],
  },
  {
    id: 'glide', name: tr('滑音不断', 'Smooth glides'), desc: tr('警笛一样滑上滑下，声音不断开。', 'Slide up and down like a siren without the voice breaking.'),
    steps: [
      { id: 'fifth', title: tr('五度滑音', 'Glide a fifth'), goal: tr('用唇颤音“嘟噜”或“呜”，从低音滑到高 5 度再滑回来，中间不断开。', 'On a lip trill or “oo”, slide up a fifth and back without a break.'),
        how: tr(['唇颤音：嘴唇放松，气吹过去让嘴唇颤动；做不出来就用“呜”', '像警笛一样慢慢滑，不要一格一格地跳', '音量放小——越轻越容易连贯'], ['Lip trill: loose lips, blow air through so they flutter; if you can’t, use “oo”', 'Slide slowly like a siren, not step by step', 'Keep it quiet — the lighter, the smoother']),
        pass: tr('一口气滑到目标高音再回到起点，没有检测到断档', 'Up to the top note and back in one breath, with no break detected'),
        ref: (P) => [P.mid, P.mid + 7, P.mid], targets: (P) => [P.mid, P.mid + 7], check: (P) => glide(P.mid, P.mid + 7) },
      { id: 'octave', title: tr('八度滑音', 'Glide an octave'), goal: tr('同样的方法，滑一个八度。', 'The same, over an octave.'),
        how: tr(['起点低一点', '往上时越高越轻', '到顶以后不要停，直接滑回来'], ['Start a little lower', 'Lighter as you go higher', 'Don’t stop at the top — slide straight back']),
        pass: tr('一口气滑过一个八度再回来，没有断档', 'An octave up and back in one breath, no break'),
        ref: (P) => [P.mid - 2, P.mid + 10, P.mid - 2], targets: (P) => [P.mid - 2, P.mid + 10], check: (P) => glide(P.mid - 2, P.mid + 10) },
    ],
  },
  {
    id: 'dynamics', name: tr('音量控制', 'Volume control'), desc: tr('同一个音从轻到响再到轻，音高不变。', 'Soft to loud to soft on one note, pitch unchanged.'),
    steps: [
      { id: 'messa', title: tr('渐强渐弱', 'Crescendo–decrescendo'), goal: tr('在一个音上，从很轻慢慢唱响，再慢慢收回到很轻，音高保持不变。', 'On one note, grow slowly from very soft to loud and back to very soft, keeping the pitch.'),
        how: tr(['从很轻（像说悄悄话的音量）开始', '用 3 秒慢慢变响（不用到最响）', '再用 3 秒慢慢收回', '全程音高对准目标线'], ['Start very soft (whisper level)', 'Take 3 s to get louder (not to full volume)', 'Take 3 s to come back', 'Stay on the target line throughout']),
        pass: tr('音量先升高 ≥ 6 dB、再降回 ≥ 5 dB，音高偏离不超过 40 音分，总长 ≥ 5 秒', 'Volume up ≥ 6 dB then down ≥ 5 dB, pitch within 40 cents, ≥ 5 s in total'),
        ref: (P) => [P.mid + 2], targets: (P) => [P.mid + 2], check: (P) => messa(P.mid + 2, 6, 5) },
    ],
  },
  {
    id: 'noshout', name: tr('不喊唱', 'No shouting'), desc: tr('往高处唱时音量不猛涨。', 'Going higher without the volume shooting up.'),
    steps: [
      { id: 'five', title: tr('上行五音不喊', 'Five notes up, no shouting'), goal: tr('唱 1-2-3-4-5，越往上越轻松，最高音不比第一个音响太多。', 'Sing 1-2-3-4-5, easier as you go up; the top note not much louder than the first.'),
        how: tr(['用“呜”或“哦”（窄的元音更容易不喊）', '往上时想着“越高越轻”', '嘴型往窄收，不要越张越大'], ['Use “oo” or “oh” (narrow vowels make shouting harder)', 'Think “higher = lighter” going up', 'Narrow the mouth rather than opening wider']),
        pass: tr('5 个音都唱准，最高音比第一个音响不超过 6 dB（往上唱自然会响一点，喊的时候通常会响 12 dB 以上）', 'All 5 notes in tune, the top note ≤ 6 dB louder than the first (going up adds a little naturally; shouting usually adds 12 dB or more)'),
        ref: (P) => [0, 2, 4, 5, 7].map((d) => P.mid + 2 + d), targets: (P) => [0, 2, 4, 5, 7].map((d) => P.mid + 2 + d),
        check: (P) => noShout([0, 2, 4, 5, 7].map((d) => P.mid + 2 + d), 6, 2) },
      { id: 'arp', title: tr('八度琶音不喊', 'Octave arpeggio, no shouting'), goal: tr('唱 1-3-5-8-5-3-1，最高音也保持轻松。', 'Sing 1-3-5-8-5-3-1, keeping even the top note easy.'),
        how: tr(['同样用“呜”或“哦”', '最高音之前先减一点音量', '下行时不要突然变重'], ['Again on “oo” or “oh”', 'Ease off a little before the top note', 'Don’t suddenly get heavy on the way down']),
        pass: tr('7 个音都唱准，最高音比第一个音响不超过 9 dB（升高一个八度时音量自然会大一点）', 'All 7 notes in tune, the top note ≤ 9 dB louder than the first (an octave up is naturally a bit louder)'),
        ref: (P) => [0, 4, 7, 12, 7, 4, 0].map((d) => P.mid + d), targets: (P) => [0, 4, 7, 12, 7, 4, 0].map((d) => P.mid + d),
        check: (P) => noShout([0, 4, 7, 12, 7, 4, 0].map((d) => P.mid + d), 9, 4) },
    ],
  },
  {
    id: 'vibrato', name: tr('颤音', 'Vibrato'), desc: tr('先会唱直音，再唱出自然的颤音。', 'First a straight tone, then a natural vibrato.'),
    steps: [
      { id: 'straight', title: tr('直音', 'Straight tone'), goal: tr('唱一个完全平直的音（不抖、不颤）3 秒。', 'Sing a completely straight note (no shake, no vibrato) for 3 s.'),
        how: tr(['用“啊”或“呜”', '想象音高是一条拉直的线', '气息平稳，喉咙放松'], ['On “ah” or “oo”', 'Imagine the pitch as a taut line', 'Even breath, relaxed throat']),
        pass: tr('3 秒，没有颤音或抖动，音准偏差 ≤ 50 音分', '3 s with no vibrato or shake, within 50 cents'),
        ref: (P) => [P.mid + 2], targets: (P) => [P.mid + 2], check: (P) => vibratoStep(P.mid + 2, 3, 'straight') },
      { id: 'natural', title: tr('自然颤音', 'Natural vibrato'), goal: tr('在同一个音上，让声音自然地轻轻波动：每秒 5–7 次。', 'On one note, let the voice waver gently and naturally: 5–7 times per second.'),
        how: tr(['先唱直音，然后放松喉咙和下巴', '可以先模仿“哦~哦~哦~”的轻微起伏，再慢慢变连贯', '不要用下巴或喉咙“抖”出来'], ['Start with a straight tone, then relax the throat and jaw', 'Imitate a gentle “oh~oh~oh~” first, then let it flow together', 'Don’t shake it out with the jaw or throat']),
        pass: tr('3 秒以上，颤音每秒 4.5–8 次、幅度适中', '3 s or more, vibrato at 4.5–8 per second and a moderate width'),
        ref: (P) => [P.mid + 2], targets: (P) => [P.mid + 2], check: (P) => vibratoStep(P.mid + 2, 3, 'healthy') },
    ],
  },
  {
    id: 'twang', spectrum: true, name: tr('咽音', 'Twang'),
    refs: ['sundberg1974', 'yanagisawa1989', 'sundbergThalen2010', 'titze2003', 'omori1996', 'sundbergNordenberg2006', 'chen1997'], desc: tr('练习把会厌上方收窄，让声音又亮又集中、传得远。麦克风看不到喉咙：程序跟你自己同一音高的普通唱法比，看声音里有没有咽音的声学特征。', 'Practise narrowing the space just above the vocal folds for a bright, focused sound that carries. The microphone can’t see the throat: the app compares with your own plain singing at the same pitch and looks for twang’s acoustic cues.'),
    steps: [
      { glottal: true, id: 'base', title: tr('普通唱法滑音（基准）', 'Plain glide (reference)'), goal: tr('选一个元音，用平常的方式从低慢慢滑到高、再滑下来。程序记下你的普通唱法在每个音高上是什么样——咽音和普通唱法很难唱在同一个音上，有了这条“曲线”，后面唱咽音时音高不用对齐。后面每一步都用这个元音。', 'Pick a vowel and glide plainly from low to high and back, slowly. The app records your plain voice at every pitch — plain and twang are hard to sing on exactly one note, and with this curve the twang needn’t match a note. Use this vowel in every later step.'),
        how: tr(['选一个元音，推荐“诶”（咽音在“诶”上最好找，像 nyeah 里的“诶”）；“啊”也可以', '从说话音高附近的低音开始，慢慢往上滑五度以上，再滑回来，像警报声', '平常的唱法，音量适中、均匀，别刻意找位置', '一口气约 6 秒，中间不断'], ['Pick a vowel — “eh” is recommended (twang comes easiest on it, as in “nyeah”); “ah” works too', 'Start low, near your speaking pitch, glide up a fifth or more and back down, like a siren', 'Your plain voice at an even, medium volume — nothing special', 'About 6 s in one breath, without a break']),
        pass: tr('一口气滑过 ≥ 7 个半音（约五度）；环境要足够安静（2–4 kHz 的谐波要明显高出底噪）；低的那段要测得出元音。程序记下这条曲线和元音，后面几步自动检查', 'One breath covering ≥ 7 semitones (about a fifth); quiet enough that the 2–4 kHz harmonics stand clear of the room noise; the vowel measurable on the lower part. The curve and vowel are recorded and later steps check against them'),
        compare: null, refs: ['omori1996'], glideRef: true,
        ref: (P) => [P.mid - 3, P.mid + 7], targets: (P) => [P.mid - 3, P.mid + 7], check: (P) => twangGlide(P.mid - 3, P.mid + 7, P.sex) },
      { glottal: true, id: 'twang', title: tr('咽音', 'Twang'), goal: tr('在第 1 步滑过的范围里任选一个舒服的音，同一个元音，换成咽音：声音变尖、变亮、更集中，但不是更用力。音高不用和哪个音对齐。', 'On any comfortable note inside step 1’s glide, same vowel, switch to twang: sharper, brighter, more focused — but not more effort. No need to match a particular note.'),
        how: tr(['找感觉：学小鸭子“嘎嘎”、说“nyeah”，或者撒娇的哭腔“嗯~”', '把这种尖亮的感觉放到第 1 步的元音上，音量和第 1 步差不多', '嘴角可以稍往两边，喉咙保持放松，不憋气；嗓子发紧或疼就停下', '看右边的“咽音 / 喊”图：让点往上走（穿透力变强），不要往右走（那只是变响）'], ['Find it: a duck’s “quack”, “nyeah”, or a whiny cry', 'Put that sharp, bright quality on the step-1 vowel, about as loud as step 1', 'Lips may spread slightly; keep the throat loose, don’t hold your breath; stop if it feels tight or hurts', 'Watch the “twang / shout” map on the right: move the dot up (more ring), not right (that’s just louder)']),
        pass: (L) => tr(`在第 1 步的范围里、同一个元音（程序会检查），连续保持 ${L.hold} 秒，和你同一音高的普通唱法比：① 穿透力（2–4 kHz 谐波相对低频的比例）提高 ≥ ${L.ring} dB；② 提高的量至少是音量增加量的 ${L.perDb} 倍——光变响也会让穿透力高一点，但远赶不上音量涨的；③ 谐波纯净度下降 ≤ ${L.rough} dB（不挤、不漏气）。难度越高，要求的“收紧”越多。这些数是本应用的设定，通过表示声音有咽音的声学特征，不等于看到了喉咙`, `Within step 1’s range, same vowel (checked), held ${L.hold} s without a break, against your plain voice at the same pitch: ① the 2–4 kHz harmonics’ share relative to the lows rises ≥ ${L.ring} dB; ② that rise is at least ${L.perDb} × the loudness gained — getting louder brightens a little too, but not this much; ③ harmonic clarity drops ≤ ${L.rough} dB (not squeezed, not breathy). Higher levels ask for more narrowing. These numbers are this app’s settings; a pass means the sound shows twang’s acoustic cues, not that the throat was seen`),
        compare: 'base', refs: ['sundbergThalen2010', 'yanagisawa1989', 'titze2003', 'sundbergNordenberg2006', 'petersonBarney1952'],
        ref: (P, ctx) => [ctx?.base?.curve ? Math.round(ctx.base.midi) : P.mid + 2], targets: (P, ctx) => [ctx?.base?.curve ? Math.round(ctx.base.midi) : P.mid + 2], check: (P, ctx) => (take) => twangOn(P.sex, levelOf(ctx?.level))(take, ctx) },
      { glottal: true, id: 'pinch', title: tr('捏鼻子测试', 'Nose-pinch test'), goal: tr('捏住鼻子再唱一次咽音：口腔咽音几乎不变；如果声音变闷、变小，可能有声音走了鼻腔。', 'Pinch your nose and twang again: an oral twang barely changes; if it goes dull or quiet, some sound may be going through the nose.'),
        how: tr(['用手指捏住鼻子', '唱第 2 步同样的咽音：同一个元音、同样的音量和离麦克风的距离，音高差不多就行', '声音应该和不捏时一样亮'], ['Pinch your nose shut', 'Sing the same twang as in step 2: same vowel, loudness and distance to the microphone; about the same pitch', 'It should be as bright as without pinching']),
        pass: (L) => tr(`和第 2 步比（两次都和同一音高的普通唱法比）：穿透力差 ≤ 4 dB、音量差 ≤ 4 dB，且仍比普通唱法多 ≥ ${L.ring - 1} dB，连续 ${L.hold} 秒。比的是两次分开唱的声音，元音、音量或距离变了也会不通过`, `Against step 2 (both measured against the plain voice at their own pitch): ring within 4 dB, loudness within 4 dB, still ≥ ${L.ring - 1} dB over the plain voice, held ${L.hold} s. Two separate takes are compared, so a change of vowel, loudness or distance also fails it`),
        compare: 'twang', refs: ['chen1997'],
        ref: (P, ctx) => [ctx?.twang ? Math.round(ctx.twang.midi) : P.mid + 2], targets: (P, ctx) => [ctx?.twang ? Math.round(ctx.twang.midi) : P.mid + 2], check: (P, ctx) => (take) => twangPinch(levelOf(ctx?.level))(take, ctx) },
      { glottal: true, id: 'scale', title: tr('咽音五音', 'Twang scale'), goal: tr('带着咽音唱 1-2-3-4-5-4-3-2-1，每个音都保持亮。五音放在第 1 步滑过的范围里。', 'Sing 1-2-3-4-5-4-3-2-1 with twang, every note bright. The notes sit inside step 1’s glide.'),
        how: tr(['点 ▶ 听一遍起始音和五音', '每个音约半秒，连着唱，用第 1 步的元音', '往上走时别改成喊，保持“尖”'], ['Press ▶ to hear the notes', 'About half a second per note, legato, on the step-1 vowel', 'Don’t turn it into shouting on the way up; keep it sharp']),
        pass: (L) => tr(`9 个音都唱准（± 50 音分），每个音都和同一音高的普通唱法比：2–4 kHz 比例多 ≥ ${L.scaleRing} dB、不是主要靠变响、不变粗糙；测得出元音的音还要同一个元音`, `All 9 notes in tune (± 50 cents), each against the plain voice at its pitch: ≥ ${L.scaleRing} dB more 2–4 kHz share, not mostly louder, not rougher; the same vowel wherever it can be measured`),
        ref: scaleTargets, targets: scaleTargets, compare: 'base', refs: ['sundberg1974'],
        check: (P, ctx) => (take) => twangScale(levelOf(ctx?.level))(take, ctx, P) },
    ],
  },
];

export const lessonById = (id) => LESSONS.find((l) => l.id === id);

// ------------------------------------------------------------------ progress
const KEY = 'vocalassistant.lessons.v2';
export function loadProgress() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}
export function saveProgress(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
