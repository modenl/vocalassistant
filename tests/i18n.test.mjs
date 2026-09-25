// Run: node tests/i18n.test.mjs — language choice and the English texts.
// the language is fixed when i18n.js loads: choose English before importing anything
globalThis.VOCAL_LANG = 'en';
const { detectLang, getLang } = await import('../js/i18n.js');

let fails = 0;
const ok = (name, cond, info = '') => { if (!cond) fails++; console.log(`${cond ? '✓' : '✗'} ${name.padEnd(52)} ${info}`); };

ok('auto: Chinese system/browser → zh', detectLang('auto', ['zh-CN', 'en-US']) === 'zh');
ok('auto: Traditional Chinese → zh', detectLang('auto', ['zh-TW']) === 'zh');
ok('auto: English first → en', detectLang('auto', ['en-GB', 'zh-CN']) === 'en');
ok('auto: first of zh/en in preference order wins', detectLang('auto', ['ja-JP', 'zh-CN', 'en']) === 'zh');
ok('auto: neither → en', detectLang('auto', ['fr-FR', 'de']) === 'en');
ok('a choice in Settings overrides the system', detectLang('zh', ['en-US']) === 'zh' && detectLang('en', ['zh-CN']) === 'en');

// the whole analysis in English: no Chinese left in any text a user sees
ok('English chosen', getLang() === 'en');
const { synth, hz, VOWELS } = await import('../tools/synth.mjs');
const { runPipeline } = await import('../tools/analyze-file.mjs');
const { LESSONS } = await import('../js/lessons/lessons.js');
const { DIMS, STATUS } = await import('../js/analysis/metrics.js');
const V = { oq: 0.5, sq: 2.5, vowel: VOWELS.a, jitter: 0.002, shimmer: 0.02 };
const segs = [50, 53, 57, 55, 52, 50, 55, 59, 57, 53].flatMap((m) => [{ dur: 1.1, f0: () => hz(m), ...V }, { dur: 0.3 }]);
const S = runPipeline(Float32Array.from(synth(segs, 44100)), 44100).summary;
const han = /[一-鿿]/;
const texts = [
  ...DIMS.flatMap((d) => [d.title, d.sub, ...d.checks.flatMap(([k]) => [S[k].title, S[k].value, S[k].detail, S[k].action, S[k].how, S[k].left].filter(Boolean))]),
  ...Object.values(STATUS).map((s) => s.text),
  ...LESSONS.flatMap((l) => [l.name, l.desc, ...l.steps.flatMap((s) => [s.title, s.goal, s.pass, ...s.how])]),
];
const bad = texts.filter((t) => han.test(t));
ok('English: analysis, statuses and lessons have no Chinese', !bad.length, bad.slice(0, 3).join(' | '));
ok('English: dimension names', DIMS.map((d) => d.title).join(',') === 'Pitch,Rhythm,Breath,Technique,Expression');

console.log(fails ? `\n${fails} FAILED` : '\nall i18n checks passed');
process.exitCode = fails ? 1 : 0;
