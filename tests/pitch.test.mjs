// Run: node tests/pitch.test.mjs — pitch accuracy of analyzer + tracker across
// the singing range, vowels, breathiness and vibrato (everything else builds on it).
import { FrameAnalyzer } from '../js/dsp/analyzer.js';
import { PitchTracker } from '../js/analysis/pitch.js';
import { DEFAULT_SETTINGS, midiName, median } from '../js/config.js';
import { synth, hz, VOWELS } from '../tools/synth.mjs';

const sr = 44100;
let fails = 0;
const ok = (name, cond, info) => { if (!cond) fails++; if (!cond || process.argv.includes('-v')) console.log(`${cond ? '✓' : '✗'} ${name.padEnd(36)} ${info}`); };

function track(seg) {
  const x = Float32Array.from(synth([seg], sr));
  const an = new FrameAnalyzer(sr), pt = new PitchTracker(DEFAULT_SETTINGS);
  const out = [];
  for (let end = an.N; end <= x.length; end += 1024) {
    const t = (end - an.N / 2) / sr;
    const st = pt.update(an.analyze(x.subarray(end - an.N, end), { gateDb: -52, pitchOnly: true }), t);
    if (t > 0.2 && t < seg.dur - 0.15) out.push(st);
  }
  return out;
}

const Q = { chest: { oq: 0.45, sq: 3 }, mid: { oq: 0.6, sq: 2.2 }, head: { oq: 0.8, sq: 1.5, noise: 0.3, amp: 0.5 } };
let n = 0;
for (const [lo, hi, k] of [[40, 64, 'm'], [55, 86, 'f']]) {
  for (let m = lo; m <= hi; m += 3) {
    for (const v of ['a', 'e', 'i', 'u']) {
      // head voice / falsetto only where it exists (men ≳ G3); breathy voice may
      // drop frames (unvoiced) but must never report a wrong pitch
      for (const q of ['chest', 'mid', 'head'].filter((q) => q !== 'head' || m >= (k === 'm' ? 55 : 60))) {
        const st = track({ dur: 0.8, f0: () => hz(m), vowel: VOWELS[v], ...Q[q] });
        const voiced = st.filter((s) => s.voiced);
        const err = median(voiced.map((s) => (s.midi - m) * 100));
        const wrong = voiced.filter((s) => Math.abs(s.midi - m) > 0.5).length;
        n++;
        ok(`${midiName(m)} /${v}/ ${q}`, voiced.length >= st.length * (q === 'head' ? 0.5 : 0.8) && Math.abs(err) < 10 && wrong <= 1,
          `voiced ${voiced.length}/${st.length} err ${err?.toFixed(1)}¢ wrong ${wrong}`);
      }
    }
  }
}
// vibrato is tracked, not flattened
const vib = track({ dur: 2, f0: (t) => hz(57 + 0.5 * Math.sin(2 * Math.PI * 6 * t)), vowel: VOWELS.a, ...Q.mid });
const ext = (Math.max(...vib.map((s) => s.raw)) - Math.min(...vib.map((s) => s.raw))) * 50;
ok('6 Hz ±50¢ vibrato keeps its width', ext > 35, `seen ±${ext.toFixed(0)}¢`);
// a 2-frame glitch up to C7 inside a sung note (breath / sibilant) is ignored
{
  const pt = new PitchTracker(DEFAULT_SETTINGS);
  let maxMidi = 0;
  for (let i = 0; i < 60; i++) {
    const glitch = i === 30 || i === 31;
    const st = pt.update({ voiced: true, irregular: false, clarity: 0.95, f0: glitch ? 2093 : 130.8, db: -20 }, i * 0.023);
    if (st.voiced) maxMidi = Math.max(maxMidi, st.midi);
  }
  n++;
  ok('2-frame glitch to C7 is filtered', maxMidi < 50, `max ${maxMidi.toFixed(1)}`);
}
console.log(fails ? `\n${fails} FAILED of ${n + 1}` : `\nall ${n + 1} pitch checks passed`);
process.exitCode = fails ? 1 : 0;
