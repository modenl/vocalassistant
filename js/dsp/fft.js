// Radix-2 in-place complex FFT with cached twiddle / bit-reversal tables.

export class FFT {
  constructor(n) {
    const levels = Math.round(Math.log2(n));
    if (1 << levels !== n) throw new Error('FFT size must be a power of 2');
    this.n = n;
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
      this.rev[i] = r >>> 0;
    }
  }

  // Forward transform uses e^{-2πik/n}; inverse is unscaled (divide by n yourself).
  transform(re, im, inverse = false) {
    const n = this.n, rev = this.rev, cs = this.cos, sn = this.sin;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const c = cs[k], s = sgn * sn[k];
          const tre = re[b] * c - im[b] * s;
          const tim = re[b] * s + im[b] * c;
          re[b] = re[a] - tre; im[b] = im[a] - tim;
          re[a] += tre; im[a] += tim;
        }
      }
    }
  }
}

const fftCache = new Map();
export function getFFT(n) {
  if (!fftCache.has(n)) fftCache.set(n, new FFT(n));
  return fftCache.get(n);
}

const winCache = new Map();
export function hann(n) {
  const key = 'hann' + n;
  if (!winCache.has(key)) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    winCache.set(key, w);
  }
  return winCache.get(key);
}

export function hamming(n) {
  const key = 'hamm' + n;
  if (!winCache.has(key)) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
    winCache.set(key, w);
  }
  return winCache.get(key);
}
