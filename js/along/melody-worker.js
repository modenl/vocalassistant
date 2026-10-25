// MELODIA (Salamon & Gómez 2012), the predominant-melody extractor in Essentia
// (Music Technology Group, UPF; Essentia.js is AGPL-3.0), off the main thread.
// in: { x: Float32Array mono at 44.1 kHz, hop, rate (played faster: 2 = double speed) } → out: { f0 } (Hz per hop, 0 = none) | { error }
const ESS = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/';
let ess = null;
async function load() {
  if (ess) return ess;
  const { EssentiaWASM } = await import(`${ESS}essentia-wasm.es.js`);
  const Essentia = (await import(`${ESS}essentia.js-core.es.js`)).default;
  if (!EssentiaWASM.calledRun) await new Promise((res) => { const prev = EssentiaWASM.onRuntimeInitialized; EssentiaWASM.onRuntimeInitialized = () => { prev?.(); res(); }; });
  ess = new Essentia(EssentiaWASM);
  return ess;
}
self.onmessage = async (e) => {
  try {
    const E = await load(), { x, hop, rate = 1 } = e.data;
    const v = E.arrayToVector(x);
    // audio played `rate` times faster (pitch kept, as a web player's speed-up
    // does): told the sample rate is 44100 / rate, MELODIA sees it at its real
    // pace — every time constant right — and one octave lower per doubling,
    // so the frequency range goes down with it and the pitch comes back × rate
    const sr = 44100 / rate, fr = (f) => f / rate;
    // the documented defaults, except: hop; the frequency range of singing
    // voices (70–1500 Hz) so bass lines and cymbals aren't taken for the melody;
    // and voicingTolerance 1.2 (default 0.2; range −1…1.4), which only decides
    // whether a melody is present: at 0.2 quieter or lower phrases were dropped
    // (a synthetic scale lost D3–A3; a 70-s song had melody in 62 % of it, 84 %
    // at 1.2), at the cost of some instrumental lines in intros
    const r = E.PredominantPitchMelodia(v, 10, 3, 2048, false, 0.8, hop, 1, 40, fr(1500), 100, fr(70), 20, 0.9, 0.9, 27.5625, fr(55), sr, 100, false, 1.2);
    const f0 = E.vectorToArray(r.pitch);
    if (rate !== 1) for (let i = 0; i < f0.length; i++) f0[i] *= rate;
    v.delete?.(); r.pitch.delete?.(); r.pitchConfidence.delete?.();
    self.postMessage({ f0 }, [f0.buffer]);
  } catch (err) { self.postMessage({ error: String(err?.message || err) }); }
};
