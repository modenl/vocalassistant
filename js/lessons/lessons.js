// Beginner lessons. Every step is judged only from pitch and level — signals
// that can be measured reliably — so pass / fail is deterministic.
//
// step.check(take, P) → { progress 0…1, pass, level: 'ok'|'off'|'idle', hint }
// take: { frames: PitchTracker states, m: SingingMetrics }; P: voice type.

import { VibratoAnalyzer } from '../analysis/vibrato.js';
import { midiName } from '../config.js';
import { L as tr } from '../i18n.js';

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
    if (ok) { acc += dt; lastIn = f.t; cur.push({ dev, db: f.db }); }
    else if (lastIn < 0 || f.t - lastIn > 0.12) { acc = 0; cur = []; }
    if (acc >= hold) {
      const d = median(cur.map((x) => x.dev));
      got.push({ target: targets[i], dev: d, rel: d - off, db: median(cur.map((x) => x.db)), t: f.t });
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
