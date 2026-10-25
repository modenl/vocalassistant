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

// 31.5-s song (pitch and level only, no spectrum kept): scored without resonance
const f = new URL('../tmp-test/fx/take2053.txt', import.meta.url);
if (existsSync(f)) {
  ran++;
  const S = load(f);
  ok('real take (20:53): scored without resonance (no spectrum kept)', ['pitch', 'breath', 'technique'].every((k) => S.dims[k].score != null) && S.ring.blocked && S.total != null, `total ${S.total} · 强弱 ${S.dynamics.status}`);
}

// Recordings from the app (tmp-test/pro/*.wav, local only), the whole pipeline.
const { readWav, runPipeline } = await import('../tools/analyze-file.mjs');
const wav = (id) => new URL(`../tmp-test/pro/${id}.wav`, import.meta.url);
// a professional female singer, 37 s sung throughout, in a noisy room: the
// voice must come through (it was 18 s of 37), and nothing false flagged
if (existsSync(wav('s1790373437567'))) {
  ran++;
  const { x, sr } = readWav(wav('s1790373437567'));
  const S = runPipeline(x, sr).summary;
  ok('pro singer, noisy room: most of the singing tracked', S.voicedTime >= 21, `voiced ${S.voicedTime.toFixed(1)} s of 37`);
  ok('pro singer: range is a female one', S.range.lo >= 57 && S.range.hi <= 70, `${S.range.loName}–${S.range.hiName}`);
  ok('pro singer: pitch, breath, technique good; no breaks', ['pitch', 'breath', 'technique'].every((k) => S.dims[k].status === 'good') && S.breaks.status === 'good', `total ${S.total}`);
  ok('pro singer: phrase ends and drift judged', S.tail.score != null && S.keyDrift.score != null, `${S.tail.value} · ${S.keyDrift.value}`);
  ok('pro singer: strong ring (singer\'s formant)', S.ring.status === 'good' && S.ring.spr < 15, `${S.ring.value} · ${S.ringHigh.value}`);
  ok('pro singer: one short passage → dynamics not called flat yet', S.dynamics.status === 'na' && !S.issues.some((x) => x.key === 'dynamics'), S.dynamics.detail.slice(0, 50));
}
// a low male voice: melodic leaps in chest voice (C#3→A2) are not register flips
if (existsSync(wav('s1790373199008'))) {
  ran++;
  const { x, sr } = readWav(wav('s1790373199008'));
  const S = runPipeline(x, sr).summary;
  ok('low male voice: no false breaks below the passaggio', S.breaks.status === 'good' && !S.breaks.count, S.breaks.value);
}

// a song played into the microphone through a speaker (the original singer, with
// the band): the bass line must not count as the singer, nor the band's
// spectrum be graded as the singer's resonance ("dull")
const orig = new URL('../tmp-test/orig/s1792884950261.wav', import.meta.url);
if (existsSync(orig)) {
  ran++;
  const { x, sr } = readWav(orig);
  const S = runPipeline(x, sr).summary;
  ok('song with band: accompaniment detected', S.accomp.detected, `${Math.round(S.accomp.share * 100)}% far below the voice type`);
  ok('song with band: the bass line isn’t the singer’s range', S.range.lo >= 40, `${S.range.loName}–${S.range.hiName}`);
  ok('song with band: resonance and dynamics not judged (not “dull”)', S.ring.status === 'na' && S.ring.blocked && S.dynamics.status === 'na' && !S.issues.some((i) => i.key === 'ring'), S.ring.detail.slice(0, 40));
  ok('song with band: pitch still judged, and good', S.dims.pitch.score >= 90, `pitch ${S.dims.pitch.score}`);
}
// a cappella takes are never taken for accompaniment
for (const id of ['s1790373437567', 's1790373397428', 's1790373199008']) {
  if (!existsSync(wav(id))) continue;
  const { x, sr } = readWav(wav(id));
  const S = runPipeline(x, sr).summary;
  ok(`a cappella ${id}: no accompaniment detected`, !S.accomp.detected, `${(S.accomp.share * 100).toFixed(1)}%`);
}

console.log(ran ?(fails ? `\n${fails} FAILED` : '\nall real-take checks passed') : 'no real takes in tmp-test/fx — skipped');
process.exitCode = fails ? 1 : 0;
