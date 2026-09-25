// 节奏 without a score. Like 相对音准 (which infers the singer's own tuning),
// the singer's own pulse is inferred from the note onsets and timing is judged
// against it:
//   tempo — speeding up / slowing down: the beat length early in the take vs
//           late, each fitted to the onset positions (jitter doesn't accumulate)
//   beat  — how even the most common note length is: its spread (SD ÷ mean).
//           Dalla Bella et al. (2009, JASA) measured the same on quarter-note
//           intervals: ≈ 12 % (8–16 %) for occasional singers, 18 % for poor
//           singers.
// Without the score a note held a whole beat too long or short that still lands
// on a beat can't be seen — just as a wrong note sung in tune can't.

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };

// Onsets from the pitch/level frames { t, midi (NaN = silent), db }:
//   voice — sound starts after ≥ 60 ms of silence (breaths, unvoiced consonants)
//   dip   — the level dips ≥ 5 dB below both sides (a voiced consonant) and recovers
//   step  — the pitch differs ≥ 0.6 semitone between the 0.2 s before and after
//           (vibrato averages out over 0.2 s)
// Each onset must lead into a settled note: ≥ 0.15 s, mostly voiced, not gliding.
//   note  — every held note of the note tracker (notes: [{ t0, t1, midi, held }]) starts
//           one: after a silence at the start of its sound, from the note before
//           it where the pitch crosses halfway. This catches the notes the
//           rules above miss: wide leaps that slide into the note don't settle
//           within 0.2 s.
export function findOnsets(F, notes = []) {
  const t = F.t, m = F.midi, db = F.db, n = t.length;
  if (n < 20) return [];
  const hop = (t[n - 1] - t[0]) / (n - 1);
  const K = (s) => Math.max(1, Math.round(s / hop));
  const v = (i) => i >= 0 && i < n && Number.isFinite(m[i]);
  const voicedIn = (arr, a, b) => { const r = []; for (let j = Math.max(0, a); j <= Math.min(n - 1, b); j++) if (v(j)) r.push(arr[j]); return r; };

  const settles = (i) => {
    const a = i + K(0.03), b = i + K(0.2);
    const fr = []; let tot = 0;
    for (let j = a; j <= Math.min(n - 1, b); j++) { tot++; if (v(j)) fr.push(j); }
    if (fr.length < 4 || fr.length < 0.7 * tot) return false;
    const mt = fr.reduce((s, j) => s + t[j], 0) / fr.length, mm = fr.reduce((s, j) => s + m[j], 0) / fr.length;
    let sxy = 0, sxx = 0;
    for (const j of fr) { sxy += (t[j] - mt) * (m[j] - mm); sxx += (t[j] - mt) ** 2; }
    return Math.abs(sxx ? sxy / sxx : 0) < 4;
  };

  // pitch step: median of the voiced pitch 0.02–0.22 s after minus before
  const w0 = K(0.02), w1 = K(0.22);
  const step = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!v(i)) continue;
    const a = voicedIn(m, i - w1, i - w0), b = voicedIn(m, i + w0, i + w1);
    step[i] = a.length >= 4 && b.length >= 4 ? med(b) - med(a) : 0;
  }

  const out = [];
  const gapMin = K(0.06), d1 = K(0.04), d2 = K(0.16);
  for (let i = 0; i < n; i++) {
    if (!v(i)) continue;
    // voice onset
    let j = i - 1;
    while (j >= 0 && !v(j)) j--;
    if (j < 0 || i - j > gapMin) { if (settles(i)) out.push({ t: t[i], kind: 'voice' }); continue; }
    // level dip (the dip frame itself may have lost voicing)
    if (db[i] <= db[i - 1] && db[i] <= db[i + 1]) {
      const pre = voicedIn(db, i - d2, i - d1), post = voicedIn(db, i + d1, i + d2);
      if (pre.length >= 3 && post.length >= 3 && db[i] < Math.min(med(pre), med(post)) - 5) {
        const back = med(post) - 3;
        let k = i + 1;
        while (k < n - 1 && db[k] < back && t[k] - t[i] < 0.15) k++;
        if (settles(k)) out.push({ t: t[k], kind: 'dip' });
        continue;
      }
    }
    // pitch step at its local maximum
    const s = Math.abs(step[i]);
    if (s >= 0.6 && s >= Math.abs(step[i - 1] || 0) && s > Math.abs(step[i + 1] || 0) && settles(i)) out.push({ t: t[i], kind: 'step' });
  }
  // note starts
  const idx = (x) => { let lo = 0, hi = n; while (lo < hi) { const md = (lo + hi) >> 1; if (t[md] < x) lo = md + 1; else hi = md; } return lo; };
  let prev = null;
  for (const nt of notes) {
    let i = Math.min(n - 1, idx(nt.t0));
    // a glide that never arrives (a siren) doesn't start a note; one that slides
    // into a pitch and holds it for 0.15 s somewhere does
    if (nt.held === false) {
      let settled = false;
      for (let a = idx(nt.t0), b = a; a < n && t[a] <= nt.t1 && !settled; a++) {
        while (b < n && t[b] - t[a] < 0.15) b++;
        if (b >= n || t[b] > nt.t1 + 0.05) break;
        const w = voicedIn(m, a, b);
        settled = w.length >= 6 && Math.max(...w) - Math.min(...w) <= 0.6;
      }
      if (!settled) { prev = null; continue; }
    }
    if (prev && nt.t0 - prev.t1 < 0.1) {
      // legato from the previous note: first halfway crossing of the pitch
      const half = (prev.midi + nt.midi) / 2, up = nt.midi > prev.midi;
      for (let j = idx(prev.t1 - 0.3); j < n && t[j] <= nt.t0 + 0.15; j++) {
        if (v(j) && (up ? m[j] >= half : m[j] <= half)) { i = j; break; }
      }
    } else {
      // after a silence: where this sound started (a slide into the note included)
      while (i > 0 && v(i - 1) && t[i] - t[i - 1] < 0.06 && nt.t0 - t[i - 1] < 0.5) i--;
    }
    out.push({ t: t[i], kind: 'note' });
    prev = nt;
  }
  // one onset per note: candidates within 0.2 s of each other are one onset,
  // timed by the most consistent landmark — the vowel starting (voice, or the
  // end of a consonant dip), else the middle of the pitch transition
  out.sort((a, b) => a.t - b.t);
  const PRI = { voice: 0, note: 1, dip: 2, step: 3 };
  const merged = [];
  let group = [];
  const flush = () => { if (group.length) merged.push(group.reduce((a, b) => (PRI[b.kind] < PRI[a.kind] ? b : a))); group = []; };
  for (const o of out) { if (group.length && o.t - group[0].t > 0.2) flush(); group.push(o); }
  flush();
  return merged;
}

// The pulse unit u: the largest grid (0.2–1.2 s) that explains the intervals
// about as well as the best one — so eighths don't win when quarters fit.
// fit = mean closeness of the intervals to whole multiples of u (1 = exact).
export function pulseOf(iois) {
  const fitOf = (u) => {
    let s = 0;
    for (const d of iois) { const r = d / u, j = Math.round(r); if (j >= 1 && j <= 8) s += Math.exp(-((r - j) ** 2) / 0.0098); }
    return s / iois.length;
  };
  const sc = [];
  let best = 0;
  for (let u = 0.2; u <= 1.2; u += 0.002) { const f = fitOf(u); sc.push([u, f]); best = Math.max(best, f); }
  let pick = null;
  for (let i = 1; i < sc.length - 1; i++) {
    if (sc[i][1] >= sc[i - 1][1] && sc[i][1] >= sc[i + 1][1] && sc[i][1] >= 0.9 * best) pick = sc[i];
  }
  return pick ? { u: pick[0], fit: pick[1] } : null;
}

// Timing noise of the onset finder itself (frame hop, consonant landmarks),
// measured on synthetic songs with exact timing; removed from the spread.
const DETECT_SD = 0.025; // s per interval

// Full analysis → { onsets, beat, tempo } (either may be null = not judged).
//   beat:  { cv, noteLen, n } — spread of the most common note length
//   tempo: { change, bpm }    — only when the intervals sit on a clear grid
export function rhythmOf(F, notes = []) {
  const on = findOnsets(F, notes);
  const res = { onsets: on, beat: null, tempo: null };
  const t = on.map((o) => o.t);
  const iois = [];
  // intervals across long pauses (> 2.5 s) aren't timed
  for (let i = 1; i < t.length; i++) if (t[i] - t[i - 1] <= 2.5) iois.push(t[i] - t[i - 1]);
  if (iois.length < 16) return res;
  const sorted = [...iois].sort((a, b) => a - b);
  res.spread = { lo: sorted[Math.floor(sorted.length * 0.2)], hi: sorted[Math.floor(sorted.length * 0.8)] }; // for the "no steady beat" message

  // the most common note length: the densest ×0.78…×1.28 window of the
  // intervals (log ±0.25). Narrow on purpose: a dotted, triplet or swung
  // neighbour (×1.5, ×0.67) stays outside, so a regular long–short pattern
  // doesn't read as unsteady. (Very uneven timing is partly cut off, so the
  // numbers run lower than untrimmed ones: Dalla Bella's 12 % / 18 % ≈ 9 % / 13 % here.)
  const lg = iois.map(Math.log);
  let best = null;
  for (const c of lg) {
    const inWin = iois.filter((d, i) => Math.abs(lg[i] - c) <= 0.25);
    if (!best || inWin.length > best.length) best = inWin;
  }
  const share = best.length / iois.length;
  const mean = best.reduce((a, x) => a + x, 0) / best.length;
  const sd = Math.sqrt(best.reduce((a, x) => a + (x - mean) ** 2, 0) / best.length);
  const beat = { cv: Math.sqrt(Math.max(0, sd * sd - DETECT_SD * DETECT_SD)) / mean, noteLen: mean, n: best.length, share };
  // judged only when the take clearly has a beat: the intervals sit on a grid
  // (below), or most notes share one ordinary note length (0.2–1.2 s). Free
  // rhythm and long-tone exercises have neither — then rhythm isn't judged.
  const plain = best.length >= 10 && share >= 0.6 && mean >= 0.2 && mean <= 1.2;

  // tempo: walk the onsets on the inferred grid with a locally adapting unit,
  // then compare the beat length early vs late in the take
  const g = pulseOf(iois);
  if (!g) { if (plain) res.beat = beat; return res; }
  let u = g.u, run = 0;
  const rows = [];
  for (let i = 1; i < t.length; i++) {
    const d = t[i] - t[i - 1];
    if (d > 2.5) { run++; continue; }
    const r = d / u, k = Math.max(1, Math.round(r));
    if (k > 8) { run++; continue; }
    rows.push({ t: t[i], k, dev: r - k, run });
    if (Math.abs(r - k) < 0.2) u = 0.8 * u + 0.2 * (d / k);
  }
  const onGrid = rows.filter((r) => Math.abs(r.dev) <= 0.15).length / rows.length;
  const grid = g.fit >= 0.4 && onGrid >= 0.55 && rows.length >= 16;
  if ((grid || plain) && best.length >= 10 && mean >= 0.2 && mean <= 1.2) res.beat = beat;
  if (!grid) return res;
  // beat length in a stretch: pooled within-run regression of onset time on
  // beat count (positions, so onset jitter doesn't accumulate; runs split at pauses)
  const unitIn = (sel) => {
    const byRun = new Map();
    // an onset off the grid (a stray or misplaced note) breaks the run: beats
    // are only counted between onsets that sit on the grid
    let run = -1, lastRun = null;
    for (const r of sel) {
      if (Math.abs(r.dev) > 0.2) { run--; continue; }
      const key = `${r.run}:${run}`;
      if (key !== lastRun) lastRun = key;
      if (!byRun.has(key)) byRun.set(key, []); byRun.get(key).push(r);
    }
    let sxy = 0, sxx = 0, used = 0;
    for (const rs of byRun.values()) {
      if (rs.length < 3) continue;
      let B = 0;
      const pts = rs.map((r) => { B += r.k; return { B, t: r.t }; });
      const mb = pts.reduce((a, p) => a + p.B, 0) / pts.length, mt = pts.reduce((a, p) => a + p.t, 0) / pts.length;
      for (const p of pts) { sxy += (p.B - mb) * (p.t - mt); sxx += (p.B - mb) ** 2; }
      used += pts.length;
    }
    return used >= 6 && sxx ? sxy / sxx : NaN;
  };
  // slowing down on the last notes (final ritardando) is expression: left out
  const body = rows.length >= 22 ? rows.slice(0, -3) : rows;
  const third = Math.max(6, Math.round(body.length * 0.35));
  const uA = unitIn(body.slice(0, third)), uB = unitIn(body.slice(-third));
  if (Number.isFinite(uA) && Number.isFinite(uB)) res.tempo = { change: uA / uB - 1, bpm: 60 / med([uA, uB]) }; // change > 0: faster at the end
  return res;
}

// ---------------------------------------------------------------- meter
// The beat as a listener hears it: sung music repeats at several levels at once
// — the beat, two beats, the bar (4 beats, or 3). The "novelty" of the singing
// (the level rising at stressed syllables, the pitch moving to a new note, a
// sound starting) is autocorrelated up to 4.2 s, and every beat period of
// 0.3–1.0 s is scored by how strongly the novelty repeats at 1, 2 and 4 beats
// (or 1 and 3). Evidence from all levels together is far more robust than any
// single onset or single peak (cf. comb-filter / metrical tempo estimation,
// Scheirer 1998; Klapuri et al. 2006).
//   z:      strength of that repetition in standard deviations of a curve
//           without any (the autocorrelation of noise is ≈ 1/√n)
// Then the local tempo in 8-s windows (every 2 s), on the strongest level:
//   wobble: how much the local tempo moves around (robust SD, %)
//   change: last third vs first third (%; > 0 = faster at the end)
// Both are ratios, so they don't depend on which level is called "the beat".

export function noveltyOf(F) {
  const n = F.t.length, hop = (F.t[n - 1] - F.t[0]) / (n - 1);
  const L = Array.from(F.db, (v) => Math.max(v, -60));
  const sm = L.map((_, i) => (L[Math.max(0, i - 1)] + L[i] + L[Math.min(n - 1, i + 1)]) / 3);
  const k = Math.max(1, Math.round(0.05 / hop));
  const m = F.midi, v = (i) => i >= 0 && Number.isFinite(m[i]);
  const out = new Float64Array(n);
  for (let i = k; i < n; i++) {
    const rise = Math.max(0, sm[i] - sm[i - k]);                               // dB
    const step = v(i) && v(i - k) ? Math.min(3, Math.abs(m[i] - m[i - k])) : 0; // semitones
    const start = v(i) && !v(i - 1) ? 3 : 0;
    out[i] = rise + 2 * step + start;
  }
  return { hop, nov: out };
}

function acfOf(x, hi) {
  const n = x.length, mean = x.reduce((a, v) => a + v, 0) / n;
  const z = Array.from(x, (v) => v - mean);
  let e0 = 0;
  for (const v of z) e0 += v * v;
  const r = new Float64Array(hi + 2);
  if (!e0) return r;
  for (let lag = 1; lag <= hi + 1 && lag < n; lag++) { let s = 0; for (let i = lag; i < n; i++) s += z[i] * z[i - lag]; r[lag] = s / e0; }
  return r;
}
// the best value within ±6 % of a lag, with its (refined) position
function nearPeak(r, lag, hi) {
  let bi = -1;
  for (let i = Math.max(2, Math.floor(lag * 0.94)); i <= Math.min(hi, Math.ceil(lag * 1.06)); i++) if (bi < 0 || r[i] > r[bi]) bi = i;
  if (bi < 0) return { v: 0, lag };
  const a = r[bi - 1], b = r[bi], c = r[bi + 1], d = a - 2 * b + c;
  return { v: b, lag: d < 0 ? bi + (0.5 * (a - c)) / d : bi };
}

// Real a-cappella songs score 6–8; random note timings (free rhythm) ≤ 4.2.
export const METER_MIN_Z = 5;

export function meterOf(F) {
  const n = F.t.length;
  if (n < 50) return null;
  const { hop, nov } = noveltyOf(F);
  const secs = n * hop;
  const hi = Math.min(n - 3, Math.round(4.2 / hop));
  const r = acfOf(nov, hi);
  let best = null;
  for (let i = Math.round(0.3 / hop); i <= Math.round(1.0 / hop); i++) {
    for (const levels of [[1, 2, 4], [1, 3]]) {
      const lags = levels.map((k) => i * k).filter((l) => l <= hi);
      if (lags.length < 2) continue;
      const s = lags.reduce((a, l) => a + nearPeak(r, l, hi).v, 0) / lags.length;
      // a mild preference for beats near 100/min where levels are ambiguous
      const bpm = 60 / (i * hop), w = s * (0.85 + 0.15 * Math.exp(-0.5 * Math.log2(bpm / 100) ** 2));
      if (!best || w > best.w) best = { i, levels, s, w };
    }
  }
  if (!best) return null;
  const z = best.s * Math.sqrt(n);
  const beat = nearPeak(r, best.i, hi).lag * hop;
  // the strongest level carries the tempo tracking
  const strongest = best.levels.map((k) => ({ k, ...nearPeak(r, best.i * k, hi) })).filter((p) => p.lag <= hi).reduce((a, b) => (b.v > a.v ? b : a));
  const res = { secs, z, found: z >= METER_MIN_Z, beatLen: beat, bpm: 60 / beat, bar: best.levels[best.levels.length - 1], wobble: NaN, change: NaN, windows: 0 };
  if (!res.found) return res;
  // local tempo: 8-s windows every 2 s (longer if the level is long)
  const P = strongest.lag, W = Math.max(Math.round(8 / hop), Math.round(2.6 * P)), step = Math.round(2 / hop);
  const loc = [];
  for (let a = 0; a + W <= n; a += step) {
    const rr = acfOf(nov.subarray(a, a + W), Math.min(W - 3, Math.ceil(P * 1.15) + 1));
    let bi = -1;
    for (let i = Math.floor(P * 0.87); i <= Math.ceil(P * 1.13); i++) if (i > 1 && i < rr.length - 1 && rr[i] >= rr[i - 1] && rr[i] >= rr[i + 1] && (bi < 0 || rr[i] > rr[bi])) bi = i;
    if (bi > 0 && rr[bi] > 0.05) {
      const x = rr[bi - 1], y = rr[bi], w2 = rr[bi + 1], d = x - 2 * y + w2;
      loc.push({ t: (a + W / 2) * hop, p: (d < 0 ? bi + (0.5 * (x - w2)) / d : bi) * hop });
    }
  }
  res.windows = loc.length;
  if (loc.length >= 4) {
    const lp = loc.map((q) => Math.log(q.p)), sorted = [...lp].sort((a, b) => a - b), medLp = sorted[sorted.length >> 1];
    const mad = [...lp.map((x) => Math.abs(x - medLp))].sort((a, b) => a - b)[lp.length >> 1];
    res.wobble = 1.4826 * mad;
    const k = Math.max(2, Math.round(loc.length / 3));
    const md = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
    res.change = Math.exp(md(lp.slice(0, k)) - md(lp.slice(-k))) - 1;
  }
  return res;
}
