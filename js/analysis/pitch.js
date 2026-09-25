// Per-frame pitch state from analyzer features: voicing, smoothed pitch,
// nearest note and deviation in cents, level.

import { hzToMidi, midiName } from '../config.js';

export class PitchTracker {
  constructor(settings) {
    this.settings = settings;
    this.reset();
  }

  reset() {
    this.buf = [];
    this.recent = [];
    this.jumpSince = null;
    this.lastVoicedT = -1;
  }

  // feat: FrameAnalyzer output; returns { t, voiced, f0, midi, note, noteName, cents, db, raw }
  // (midi: lightly smoothed; raw: this frame's estimate, for vibrato)
  update(feat, t) {
    const S = this.settings;
    const st = { t, voiced: false, f0: 0, midi: NaN, note: NaN, noteName: '', cents: 0, db: feat.db };
    // above F6 (1400 Hz) is outside every voice type here: an artefact (breath, "s")
    const voiced = feat.voiced && !feat.irregular && feat.clarity >= S.voicingClarity && feat.f0 <= 1400;

    // Octave glitches: when the previous note (or its reverb) overlaps the next
    // one, the estimator can briefly report their common sub-period; breath or
    // sibilants can flash a high partial. A real jump persists; glitches last
    // < 150 ms — skip them.
    while (this.recent.length && t - this.recent[0].t > 0.25) this.recent.shift();
    if (voiced && this.recent.length) {
      const ref = this.recent.map((r) => r.f0).sort((a, b) => a - b)[Math.floor(this.recent.length / 2)];
      if (feat.f0 < 0.62 * ref || feat.f0 > 1.9 * ref) {
        if (this.jumpSince == null) this.jumpSince = t;
        if (t - this.jumpSince < 0.15) return st;
      } else this.jumpSince = null;
    }

    if (!voiced) {
      if (this.lastVoicedT >= 0 && t - this.lastVoicedT > 0.12) { this.buf.length = 0; this.jumpSince = null; }
      return st;
    }
    this.lastVoicedT = t;
    this.recent.push({ t, f0: feat.f0 });
    // median of 3 (≈70 ms) removes single-frame glitches but keeps vibrato
    this.buf.push(feat.f0);
    if (this.buf.length > 3) this.buf.shift();
    const f0 = [...this.buf].sort((a, b) => a - b)[Math.floor(this.buf.length / 2)];
    const midi = hzToMidi(f0, S.a4);
    const note = Math.round(midi);
    Object.assign(st, { voiced: true, f0, midi, note, noteName: midiName(note), cents: (midi - note) * 100, raw: hzToMidi(feat.f0, S.a4) });
    return st;
  }
}
