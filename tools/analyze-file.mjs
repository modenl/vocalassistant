// Offline run of the app pipeline on a WAV file: the five dimensions + notes.
// Usage: node tools/analyze-file.mjs <file.wav> [--notes]
import { readFileSync } from 'node:fs';
import { FrameAnalyzer } from '../js/dsp/analyzer.js';
import { PitchTracker } from '../js/analysis/pitch.js';
import { SingingMetrics, DIMS } from '../js/analysis/metrics.js';
import { DEFAULT_SETTINGS } from '../js/config.js';

export function readWav(path) {
  const b = readFileSync(path);
  if (b.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not RIFF');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4), size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  const { ch, sr, bits } = fmt;
  const fmtCode = fmt.format === 0xfffe ? (bits === 32 ? 3 : 1) : fmt.format;
  const bps = bits / 8, n = Math.floor(data.length / (bps * ch));
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) {
      const o = (i * ch + c) * bps;
      let v;
      if (fmtCode === 3) v = bits === 32 ? data.readFloatLE(o) : data.readDoubleLE(o);
      else if (bits === 16) v = data.readInt16LE(o) / 32768;
      else if (bits === 24) v = data.readIntLE(o, 3) / 8388608;
      else if (bits === 32) v = data.readInt32LE(o) / 2147483648;
      else v = (data[o] - 128) / 128;
      s += v;
    }
    x[i] = s / ch;
  }
  return { x, sr, ch, bits };
}

// Same hop (1024 samples) as the browser capture worklet.
export function runPipeline(x, sr, settings = DEFAULT_SETTINGS) {
  const an = new FrameAnalyzer(sr), pt = new PitchTracker(settings), m = new SingingMetrics();
  for (let end = an.N; end <= x.length; end += 1024) {
    const frame = x.subarray(end - an.N, end), t = (end - an.N / 2) / sr;
    m.push(pt.update(an.analyze(frame, { gateDb: settings.gateDb, pitchOnly: true }), t));
  }
  return { metrics: m, summary: m.finish() };
}

if (process.argv[1] && process.argv[1].endsWith('analyze-file.mjs')) {
  const file = process.argv[2];
  const { x, sr } = readWav(file);
  const { metrics, summary: S } = runPipeline(x, sr);
  console.log(`${file}: ${(x.length / sr).toFixed(1)} s, voiced ${S.voicedTime.toFixed(1)} s, ${S.noteCount} steady notes, range ${S.range ? `${S.range.loName}–${S.range.hiName}` : '—'}`);
  console.log(`  总分 ${S.total ?? '—'}`);
  for (const d of DIMS) {
    const D = S.dims[d.key];
    console.log(`  【${d.title}】 ${D.score ?? '—'} ${D.status}`);
    for (const [k] of d.checks) {
      const r = S[k];
      console.log(`     ${r.title.padEnd(6)} ${String(r.score ?? '—').padStart(3)} ${r.status.padEnd(4)} ${r.value}  | ${r.detail}`);
    }
  }
  console.log('  top issues:', S.issues.map((i) => i.title).join(', ') || 'none');
  if (process.argv.includes('--notes')) for (const n of metrics.notes) console.log(`   ${n.t0.toFixed(2)} ${n.name} ${n.cents.toFixed(0)}c ${n.dur.toFixed(2)}s db ${n.db.toFixed(1)} ${n.steady ? '' : '(glide)'} drift ${Number.isFinite(n.drift) ? n.drift.toFixed(0) : '-'} ${n.vib ? n.vib.type + ' ' + n.vib.rate.toFixed(1) + 'Hz ' + n.vib.extent.toFixed(0) + 'c' : ''}`);
}
