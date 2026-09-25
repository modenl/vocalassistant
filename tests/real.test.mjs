// Run: node tests/real.test.mjs — real a-cappella takes (the user's own, kept
// only on this machine in tmp-test/fx/, never deployed or committed). Skipped
// when the fixtures aren't there. Format: per frame (21.33 ms) 2 digits −dB,
// then 3 digits pitch × 10 (MIDI) or "---" when silent.
import { existsSync, readFileSync } from 'node:fs';
import { SingingMetrics } from '../js/analysis/metrics.js';

let fails = 0, ran = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(56)} ${info}`); };

function load(file, hop = 0.021333) {
  const s = readFileSync(file, 'utf8').trim(), m = new SingingMetrics();
  for (let i = 0; i * 5 < s.length; i++) {
    const db = -Number(s.slice(i * 5, i * 5 + 2)), p = s.slice(i * 5 + 2, i * 5 + 5), voiced = p !== '---';
    m.push({ t: i * hop, voiced, midi: voiced ? Number(p) / 10 : NaN, raw: voiced ? Number(p) / 10 : NaN, db });
  }
  return m.finish();
}

// 31.5-s song, sung legato around 95/min in 4/4: the note-by-note rules found no
// beat here ("数据不足") — the meter must come through
const f = new URL('../tmp-test/fx/take2053.txt', import.meta.url);
if (existsSync(f)) {
  ran++;
  const S = load(f);
  ok('real take (20:53): beat found and scored', S.beat.score != null && S.beat.bpm > 85 && S.beat.bpm < 110, `${S.beat.value} · ${S.beat.detail.slice(0, 40)}`);
  ok('real take (20:53): tempo change scored', S.tempo.score != null, S.tempo.value);
  ok('real take (20:53): all five dimensions scored', Object.values(S.dims).every((d) => d.score != null), `total ${S.total}`);
}

console.log(ran ? (fails ? `\n${fails} FAILED` : '\nall real-take checks passed') : 'no real takes in tmp-test/fx — skipped');
process.exitCode = fails ? 1 : 0;
