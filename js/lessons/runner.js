// Runs one lesson step: mic (or a file) → pitch → take → step.check.

import { AudioEngine } from '../audio/engine.js';
import { FrameAnalyzer } from '../dsp/analyzer.js';
import { PitchTracker } from '../analysis/pitch.js';
import { SingingMetrics } from '../analysis/metrics.js';
import { refSounding } from '../audio/tone.js';
import { L } from '../i18n.js';
import { pool, SpecAvg } from '../viz/scope.js';

const MAX_SECONDS = 40;

export class Take {
  constructor(settings) {
    this.pt = new PitchTracker(settings);
    this.m = new SingingMetrics();
    this.frames = [];
  }
  // muted: the reference tone is playing — the microphone hears the speaker,
  // not the singer, so the frame counts as silence.
  push(feat, t, muted = false) {
    const st = this.pt.update(muted ? { ...feat, voiced: false } : feat, t);
    st.muted = muted;
    this.m.push(st);
    this.frames.push(st);
    return st;
  }
}

export class StepRunner {
  // ctx: what earlier steps saved (e.g. the plain-voice reference for twang)
  constructor(app, step, P, { onEnd, ctx } = {}) {
    this.app = app;
    this.step = step;
    this.P = P;
    this.check = step.check(P, ctx);
    this.onEnd = onEnd;
    this.take = new Take(app.settings);
    this.spec = new SpecAvg(0.4);
    this.ev = { progress: 0, pass: false, level: 'idle', hint: '' };
    this.last = null;
    this.endAt = null; // passed, or the step said the attempt is over (ev.final)
    this.lastEval = -1;
  }

  async start(source) {
    const S = this.app.settings;
    this.eng = new AudioEngine();
    let an = null;
    this.eng.onFrame = (frame, t) => {
      if (!an || t < 0) return;
      const muted = refSounding();
      // steps that judge the vocal folds' closure need the full analysis (H1*−H2*, CPP)
      const feat = an.analyze(frame, { gateDb: S.gateDb, pitchOnly: !this.step.glottal, formants: 'compare' in this.step });
      const st = this.take.push(feat, t, muted);
      // the voice's recent spectrum (for the spectrum views and the saved references)
      if (!muted && st.voiced) this.spec.push(pool(feat.spec, feat.binHz), this.last ? Math.min(0.1, t - this.last.t) : 0.02);
      // and the latest voiced frame's, for the compact spectrum (viz/voiceSpec.js)
      if (!muted && st.voiced && feat.f0 > 0) this.frameSpec = { db: Float32Array.from(feat.spec), binHz: feat.binHz, f0: feat.f0 };
      this.last = st;
      if (muted) this.ev = { ...this.ev, pass: false, level: 'idle', hint: L('正在播放参考音——听完再唱（这段时间不计入）', 'Playing the reference — listen, then sing (this time doesn’t count)') };
      else if (t - this.lastEval >= 0.15) { this.lastEval = t; this.ev = this.check(this.take); }
      if (this.ev.pass && !this.passEv) this.passEv = this.ev;
      if ((this.ev.pass || this.ev.final) && this.endAt == null) this.endAt = t;
      if ((this.endAt != null && t - this.endAt > 1.0) || t > (this.step.maxSeconds || MAX_SECONDS)) this.stop();
    };
    if (source) await this.eng.startFile(source, { onEnded: () => this.stop() });
    else await this.eng.startMic({ deviceId: S.deviceId, record: false });
    an = new FrameAnalyzer(this.eng.sampleRate);
    this.running = true;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.take.ended = true;
    this.take.m.finish();
    // a pass is kept: the second after it (stopping, a breath) can't undo it
    this.ev = this.passEv || this.check(this.take);
    await this.eng.stop();
    this.onEnd?.(this);
  }
}
