// Run: node tests/align.test.mjs — finding where a few seconds of a song are
// (singing along with a player the page can't ask): the tab's sound is matched
// against the recording made for the analysis.
import { features, locate, RATE } from '../js/along/align.js';
import { synth, hz, VOWELS } from '../tools/synth.mjs';

let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(58)} ${info}`); };

// a song: a sung melody over bass, chords and a hi-hat
function song(sr) {
  const MEL = [64, 67, 69, 67, 64, 62, 60, 62, 64, 64, 67, 72, 71, 69, 67, 64], D = 0.75;
  const segs = [{ dur: 1 }];
  MEL.forEach((m, i) => { segs.push({ dur: D - 0.08, f0: () => hz(m), vowel: [VOWELS.a, VOWELS.e, VOWELS.i, VOWELS.u][i % 4], oq: 0.55, sq: 2.4 }); segs.push({ dur: 0.08 }); });
  segs.push({ dur: 1 });
  const v = synth(segs, sr), x = new Float32Array(v.length), chords = [[48, 52, 55], [53, 57, 60], [55, 59, 62], [48, 52, 55]];
  let seed = 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr, ch = chords[Math.floor(t / 1.5) % 4];
    let s = 0;
    for (let k = 1; k <= 4; k++) s += (0.4 / k) * Math.sin(2 * Math.PI * k * hz(ch[0] - 12) * t);
    for (const m of ch) for (let k = 1; k <= 6; k++) s += (0.08 / k) * Math.sin(2 * Math.PI * k * hz(m) * t + k);
    const beat = t % 0.375; if (beat < 0.03) s += 0.2 * rnd() * (1 - beat / 0.03);
    x[i] = 0.5 * v[i] + 0.4 * s;
  }
  return x;
}

const sr = 44100, x = song(sr), S = features(x, sr);
ok('features: 100 frames a second', Math.abs(S.n - (x.length / sr) * RATE) < RATE / 4, `${S.n} frames for ${(x.length / sr).toFixed(1)} s`);
{
  // 4 s from 7.32 s, quieter, with noise
  const a = Math.round(7.32 * sr), seg = x.slice(a, a + 4 * sr);
  let s2 = 7; const rnd = () => ((s2 = (s2 * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < seg.length; i++) seg[i] = 0.3 * seg[i] + 0.01 * rnd();
  const r = locate(S, features(seg, sr));
  ok('4 s from 7.32 s (quieter, noisy): found at 7.32 s ±20 ms', r && Math.abs(r.at / RATE - 7.32) <= 0.02, r && `${(r.at / RATE).toFixed(2)} s, score ${r.score.toFixed(2)}, margin ${r.margin.toFixed(2)}`);
}
{
  // the tab's sound at 48 kHz, the recording at 44.1 kHz
  const x48 = song(48000), a = Math.round(3.05 * 48000), r = locate(S, features(x48.slice(a, a + 3 * 48000), 48000));
  ok('3 s at 48 kHz against the recording at 44.1 kHz', r && Math.abs(r.at / RATE - 3.05) <= 0.02, r && `${(r.at / RATE).toFixed(2)} s, score ${r.score.toFixed(2)}`);
}
{
  // a search near the last place (while singing): only ±2 s looked at
  const a = Math.round(10.5 * sr), r = locate(S, features(x.slice(a, a + 3 * sr), sr), { from: 8.5 * RATE, to: 12.5 * RATE });
  ok('near the last place (±2 s): found', r && Math.abs(r.at / RATE - 10.5) <= 0.02, r && `${(r.at / RATE).toFixed(2)} s`);
}
{
  // something else entirely (silence and noise): no confident match
  let s3 = 3; const rnd = () => ((s3 = (s3 * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const z = Float32Array.from({ length: 3 * sr }, () => 0.05 * rnd()), r = locate(S, features(z, sr));
  ok('noise: a weak match only', r && r.score < 0.3, r && `score ${r.score.toFixed(2)}`);
}
console.log(fails ? `\n${fails} FAILED` : '\nall alignment checks passed');
process.exitCode = fails ? 1 : 0;
