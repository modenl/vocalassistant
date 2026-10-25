// Microphone / file input, hop-by-hop frame delivery and recording.
//
// Audio is captured by an AudioWorklet in fixed hops (1024 samples) and kept in
// a ring buffer; `onFrame(frame, t)` is called for every hop with the latest
// analysis frame and its centre time. If AudioWorklet is unavailable we fall
// back to polling an AnalyserNode from a timer.

import { frameSizeFor } from '../dsp/analyzer.js';

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.source = null;
    this.mode = null;
    this.onFrame = null;
    this.samples = 0;
    this.offset = 0;
  }

  get sampleRate() { return this.ctx?.sampleRate ?? 48000; }
  get running() { return !!this.mode; }
  // seconds of input processed so far (media time)
  now() { return this.ctx ? this.samples / this.ctx.sampleRate - this.offset : 0; }

  async ensureCtx() {
    if (!this.ctx || this.ctx.state === 'closed') this.ctx = new AudioContext({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const N = frameSizeFor(this.ctx.sampleRate);
    this.N = N;
    this.ring = new Float32Array(N * 2);
    this.frame = new Float32Array(N);
    this.samples = 0;
    if (!this.workletReady && this.ctx.audioWorklet) {
      try {
        await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
        this.workletReady = true;
      } catch { this.workletReady = false; }
    }
  }

  connectCapture(src) {
    if (this.workletReady) {
      this.node = new AudioWorkletNode(this.ctx, 'vocal-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
      this.node.port.onmessage = (e) => this.ingest(e.data);
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      src.connect(this.node);
      this.node.connect(this.sink).connect(this.ctx.destination);
    } else {
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = this.N;
      src.connect(this.analyser);
      const hop = 1024 / this.ctx.sampleRate;
      let last = this.ctx.currentTime;
      this.poll = setInterval(() => {
        const now = this.ctx.currentTime;
        if (now - last < hop) return;
        this.samples += Math.round((now - last) * this.ctx.sampleRate);
        last = now;
        this.analyser.getFloatTimeDomainData(this.frame);
        this.onFrame?.(this.frame, this.frameTime());
      }, 10);
    }
  }

  ingest(block) {
    const N = this.N, ring = this.ring;
    // keep the most recent N samples contiguous at ring[N..2N)
    ring.copyWithin(0, block.length);
    ring.set(block, ring.length - block.length);
    this.samples += block.length;
    this.frame.set(ring.subarray(ring.length - N));
    this.onFrame?.(this.frame, this.frameTime());
  }

  frameTime() { return this.now() - this.N / (2 * this.sampleRate); }

  async startMic({ deviceId, record = true } = {}) {
    // the microphone first, then the audio output: opening a Bluetooth
    // headset's microphone switches it to its call profile, which can cut sound
    // that was already playing; output opened after the switch keeps working
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
      },
    });
    await this.ensureCtx();
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.offset = 0;
    this.mode = 'mic';
    this.connectCapture(this.source);
    if (record) this.startRecorder(this.stream);
  }

  async startFile(blob, { onEnded } = {}) {
    await this.ensureCtx();
    const buf = await this.ctx.decodeAudioData(await blob.arrayBuffer());
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    this.source = src;
    this.mode = 'file';
    this.fileBlob = blob;
    this.duration = buf.duration;
    const delay = 0.1;
    this.offset = delay;
    this.connectCapture(src);
    src.onended = () => { if (this.mode === 'file' && onEnded) onEnded(); };
    src.start(this.ctx.currentTime + delay);
  }

  startRecorder(stream) {
    if (typeof MediaRecorder === 'undefined') return;
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
    const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t));
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    // the microphone may take a moment to deliver sound: the recording starts
    // later than the analysis clock. Where it starts, in analysis time:
    this.recStart = null;
    this.recorder.onstart = () => { this.recStart = this.now(); };
    this.recorder.start(1000);
  }

  async stop() {
    let blob = null;
    if (this.mode === 'file') blob = this.fileBlob;
    if (this.recorder && this.recorder.state !== 'inactive') {
      blob = await new Promise((res) => {
        this.recorder.onstop = () => res(new Blob(this.chunks, { type: this.recorder.mimeType || 'audio/webm' }));
        this.recorder.stop();
      });
    }
    clearInterval(this.poll);
    try { if (this.mode === 'file') this.source.stop(); } catch { /* already ended */ }
    for (const n of [this.source, this.node, this.sink, this.analyser]) { try { n?.disconnect(); } catch { /* ignore */ } }
    if (this.node) this.node.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null; this.recorder = null; this.source = null; this.node = null; this.sink = null; this.analyser = null;
    this.mode = null;
    return blob;
  }

  // the microphone in use is a Bluetooth headset's (AirPods and the like)
  get micIsHeadset() {
    const label = this.stream?.getAudioTracks()[0]?.label || '';
    return /airpods|bluetooth|headset|hands-?free|buds|beats|耳机/i.test(label);
  }

  static async listInputs() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      return devs.filter((d) => d.kind === 'audioinput');
    } catch { return []; }
  }
}
