// Per-frame pitch state from analyzer features: voicing, smoothed pitch,
// nearest note and deviation in cents, level.

import { hzToMidi, midiName, VOICE_TYPES } from '../config.js';

// Far below the chosen voice type is not the singer: with music playing, the
// tracker follows the bass line (a song played through a speaker read A#1–A#3
// for a baritone, a quarter of its frames under E2). A cappella takes have
// ≤ 0.3 % there. Only the low side: a voice type set too low (the default is
// baritone) must not cut a woman's high notes.
export const BELOW_RANGE = 5; // semitones under the voice type's lowest note

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
    this.lastF0 = 0;
    this.weakRun = [];
  }

  // feat: FrameAnalyzer output; returns { t, voiced, f0, midi, note, noteName, cents, db, raw }
  // (midi: lightly smoothed; raw: this frame's estimate, for vibrato)
  update(feat, t) {
    const S = this.settings;
    const st = { t, voiced: false, f0: 0, midi: NaN, note: NaN, noteName: '', cents: 0, db: feat.db, hiMed: feat.hiMed, spr: NaN, hiPk: NaN };
    // above F6 (1400 Hz) is outside every voice type here: an artefact (breath, "s")
    let voiced = feat.voiced && !feat.irregular && feat.f0 <= 1400 && (feat.weak || feat.clarity >= S.voicingClarity);
    // weak frames (harmonics clear, waveform periodicity poor: noise, reverb,
    // breathy tone) only as part of a note: right after a voiced frame at the same
    // pitch (±0.7 semitone), or the third in a row of weak frames at one pitch
    if (voiced && feat.weak) {
      const m = hzToMidi(feat.f0, S.a4);
      const near = (f) => Math.abs(hzToMidi(f, S.a4) - m) <= 0.7;
      const cont = this.lastVoicedT >= 0 && t - this.lastVoicedT <= 0.06 && near(this.lastF0);
      this.weakRun = this.weakRun.filter((w) => t - w.t <= 0.07 && near(w.f0));
      this.weakRun.push({ t, f0: feat.f0 });
      voiced = cont || this.weakRun.length >= 3;
    } else this.weakRun = [];
    const P = VOICE_TYPES[S.voiceType];
    if (voiced && P && hzToMidi(feat.f0, S.a4) < P.low - BELOW_RANGE) { st.outside = true; voiced = false; }

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
    this.lastF0 = feat.f0;
    this.recent.push({ t, f0: feat.f0 });
    // median of 3 (≈70 ms) removes single-frame glitches but keeps vibrato
    this.buf.push(feat.f0);
    if (this.buf.length > 3) this.buf.shift();
    const f0 = [...this.buf].sort((a, b) => a - b)[Math.floor(this.buf.length / 2)];
    const midi = hzToMidi(f0, S.a4);
    const note = Math.round(midi);
    Object.assign(st, { voiced: true, f0, midi, note, noteName: midiName(note), cents: (midi - note) * 100, raw: hzToMidi(feat.f0, S.a4), spr: feat.spr, hiPk: feat.hiPk, vdb: feat.vdb, hnrLite: feat.hnrLite, hbr: feat.hbr, h1h2: feat.h1h2c, cpp: feat.cpp, bands: feat.bands, fm: feat.formants?.length ? feat.formants.map((q) => q.f) : null });
    return st;
  }
}
