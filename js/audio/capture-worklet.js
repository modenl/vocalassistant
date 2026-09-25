// Posts fixed-size blocks of the mono input to the main thread so analysis runs
// on every hop of audio (independent of requestAnimationFrame throttling).
const HOP = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(HOP);
    this.n = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === HOP) {
          this.port.postMessage(this.buf, [this.buf.buffer]);
          this.buf = new Float32Array(HOP);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('vocal-capture', CaptureProcessor);
