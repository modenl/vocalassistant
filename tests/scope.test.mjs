// Run: node tests/scope.test.mjs — the voice-scope estimates (analysis/voiceState.js)
// on synthetic voices with known answers: the tongue from the vowel, the pharynx
// narrowing with twang, no problems on a clean voice, breathiness named.
import { FrameAnalyzer } from '../js/dsp/analyzer.js';
import { VoiceState } from '../js/analysis/voiceState.js';
import { synth, hz, VOWELS } from '../tools/synth.mjs';
import { vowelOf, sameVowel, recentFm } from '../js/analysis/vowels.js';

const sr = 44100;
let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(56)} ${info}`); };
function run(seg, sex = 'm', base = null) {
  const x = Float32Array.from(synth([{ dur: 3, f0: () => hz(sex === 'm' ? 48 : 60), jitter: 0.003, shimmer: 0.03, oq: 0.55, sq: 2.4, ...seg }], sr, { gain: 0.3 }));
  const an = new FrameAnalyzer(sr), vs = new VoiceState({ sex });
  if (base) vs.setBase(base);
  let st = null; const probs = new Set();
  for (let end = an.N; end <= x.length; end += 1024) { st = vs.push(an.analyze(x.subarray(end - an.N, end), { gateDb: -52, f5: true }), (end - an.N / 2) / sr); for (const p of st.problems) probs.add(p.key); }
  return { st, probs: [...probs], vs };
}
const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const I = run({ vowel: VOWELS.i }), A = run({ vowel: VOWELS.a }), U = run({ vowel: VOWELS.u });
ok('"ee": tongue high and front', I.st.tongueHigh > 0.7 && I.st.tongueFront > 0.7, `high ${f2(I.st.tongueHigh)} front ${f2(I.st.tongueFront)}`);
ok('"ah": tongue low', A.st.tongueHigh < 0.35, `high ${f2(A.st.tongueHigh)} front ${f2(A.st.tongueFront)}`);
ok('"oo": tongue high and back', U.st.tongueHigh > 0.7 && U.st.tongueFront < 0.3, `high ${f2(U.st.tongueHigh)} front ${f2(U.st.tongueFront)}`);
const R = run({ vowel: VOWELS.aRing });
ok('clean, ringing "ah": no problems named', !R.probs.length, R.probs.join(','));
ok('"ah" with little 2–4 kHz: called dull', A.probs.includes('dull'), `${A.probs.join(',')} · ${Math.round(A.st.spr)} dB`);
ok('"oo" is dull by nature: not called dull', !U.probs.includes('dull'), U.probs.join(','));
const TWF = [{ f: 850, b: 70 }, { f: 1350, b: 80 }, { f: 2400, b: 90 }, { f: 2850, b: 90 }, { f: 3250, b: 110 }];
const plainBase = A.vs.baseFromNow();
const T = run({ vowel: TWF, oq: 0.42, sq: 3.0 }, 'm', plainBase);
ok('twang against the plain reference: pharynx narrow', T.st.pharynx > 0.6 && A.st.pharynx < 0.4, `twang ${f2(T.st.pharynx)} vs plain ${f2(A.st.pharynx)}`);
const B = run({ vowel: VOWELS.aRing, oq: 0.92, sq: 1.2, noise: 0.3 });
ok('breathy voice → "breathy" named', B.probs.includes('breathy'), `${B.probs.join(',')} oq ${f2(B.st.oq)}`);
ok('larynx: unknown without a reference', !Number.isFinite(A.st.larynx));
ok('high female note: formants not trusted → tongue unknown', !Number.isFinite(run({ vowel: VOWELS.a, f0: () => hz(74) }, 'f').st.tongueHigh));

// formants F1–F5 (the formant views): the vowel named, twang's F3–F5 drawn together
const fmTxt = (fm) => (fm ? fm.map((v) => (Number.isFinite(v) ? Math.round(v) : '—')).join(' / ') : '—');
const named = [[I, 'i'], [A, 'ɑ'], [U, 'u']].map(([r, ipa]) => [r, ipa, vowelOf(r.st.fm?.[0], r.st.fm?.[1], 'm')?.ipa]);
ok('F1–F5: "ee", "ah", "oo" recognised as those vowels', named.every(([, ipa, got]) => got === ipa), named.map(([, ipa, got]) => `${ipa}→${got}`).join(' '));
ok('F1–F5: all five measured at a low pitch', A.st.fm?.every(Number.isFinite), fmTxt(A.st.fm));
const span = (fm) => fm[4] - fm[2];
ok('F1–F5: twang draws F3–F5 together', T.st.fm && span(T.st.fm) < span(A.st.fm) - 300, `twang ${Math.round(span(T.st.fm))} Hz vs plain ${Math.round(span(A.st.fm))} Hz`);
ok('F1–F5: twang on "ah" is still "ah"; "ee" is not', sameVowel(A.st.fm, T.st.fm) === true && sameVowel(A.st.fm, I.st.fm) === false);
ok('F1–F5: high female note → not shown', run({ vowel: VOWELS.aF, f0: () => hz(74) }, 'f').st.fm === null);
const near = (got, want, tol = 0.05) => Number.isFinite(got) && Math.abs(got / want - 1) <= tol;
ok('F1–F5: twang’s close F4 and F5 kept apart', near(T.st.fm?.[3], 2850) && near(T.st.fm?.[4], 3250), fmTxt(T.st.fm));
// at 48 kHz (browsers) the analysis frame is shorter than the resampling filter
// needs: that once made a false peak near 5 kHz
const at48 = (() => {
  const sr48 = 48000, x = Float32Array.from(synth([{ dur: 2, f0: () => hz(48), jitter: 0.003, shimmer: 0.03, oq: 0.55, sq: 2.4, vowel: VOWELS.a }], sr48, { gain: 0.3 }));
  const an = new FrameAnalyzer(sr48), vs = new VoiceState({ sex: 'm' });
  let st = null;
  for (let end = an.N; end <= x.length; end += 1024) st = vs.push(an.analyze(x.subarray(end - an.N, end), { gateDb: -52, f5: true }), (end - an.N / 2) / sr48);
  return st.fm;
})();
ok('F1–F5 at 48 kHz: "ah" right, no false 5 kHz peak', [730, 1150, 2500, 3300, 3900].every((w, k) => near(at48?.[k], w, 0.06)), fmTxt(at48));
ok('F1–F5: a wandering F5 (weak highs, "oo") is not shown', !Number.isFinite(U.st.fm?.[4]), fmTxt(U.st.fm));
// a low voice: F5 lies above the 40th harmonic, it must still be checked in the spectrum
const lowI = run({ vowel: VOWELS.i, f0: () => 82.4 });
ok('F1–F5: low voice (82 Hz) keeps a real F5', near(lowI.st.fm?.[4], 4200, 0.08), fmTxt(lowI.st.fm));
const fr = (f0, n = 20) => Array.from({ length: n }, (_, i) => ({ t: i * 0.02, voiced: true, f0, fm: [850 + (i % 3) * 10, 1250, 2850, 3700, 4400] }));
ok('recent F1–F5: median of the last frames, trust from pitch', recentFm(fr(220))?.F[0] === 860 && recentFm(fr(220)).trust === 'good' && recentFm(fr(380)).trust === 'rough');
ok('recent F1–F5: none above 450 Hz', recentFm(fr(500)) === null);

console.log(fails ? `\n${fails} FAILED` : '\nall voice-scope checks passed');
process.exitCode = fails ? 1 : 0;
