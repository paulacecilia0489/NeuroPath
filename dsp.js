/* dsp.js - signal processing for NeuroPath.
 * Pure functions only (no page/DOM code) so they can be tested in Node.
 *
 * Pipeline taught in the app:
 *   raw EMG -> band-pass (+ notch) -> rectify -> envelope (low-pass) -> threshold -> activations
 */
(function (root) {
  "use strict";

  // ------------------------------------------------------------ random numbers
  // Seeded generator so the "simulated muscle" is the same every time for a given seed.
  /**
   * Seeded pseudo-random generator (mulberry32). Same seed gives the same sequence, so the
   * simulated muscle is identical on every run, which makes tests repeatable.
   * @param {number} seed integer seed
   * @returns {function(): number} function returning uniform numbers in [0, 1)
   */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * One normally distributed number (mean 0, std 1) via the Box-Muller transform:
   * z = sqrt(-2 ln u1) * cos(2 pi u2), where u1 and u2 are uniform in (0, 1].
   * @param {function(): number} rand uniform generator
   */
  function gaussian(rand) {
    // Box-Muller transform: turns two uniform numbers into one bell-curve number.
    let u = 0;
    while (u === 0) u = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
  }

  // ------------------------------------------------------------ biquad filters
  // Coefficients from the well-known RBJ "Audio EQ Cookbook". Each biquad is a 2nd-order filter.
  /**
   * Coefficients of one 2nd-order IIR filter ("biquad"), from the RBJ Audio EQ Cookbook.
   * Transfer function H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2), with
   *   w0 = 2 pi f0 / fs,  alpha = sin(w0) / (2 Q),  a0 = 1 + alpha  (all coefficients divided by a0).
   * Low-pass:  b0 = (1 - cos w0)/2, b1 = 1 - cos w0, b2 = b0.
   * High-pass: b0 = (1 + cos w0)/2, b1 = -(1 + cos w0), b2 = b0.
   * Notch:     b0 = 1, b1 = -2 cos w0, b2 = 1.
   * Denominator (all types): a1 = -2 cos w0 / a0, a2 = (1 - alpha) / a0.
   * @param {"lowpass"|"highpass"|"notch"} type filter shape
   * @param {number} fs sample rate in Hz
   * @param {number} f0 cutoff (or notch centre) in Hz; clamped to [1e-4 fs, 0.49 fs]
   * @param {number} Q sharpness (0.7071 = maximally flat for a single section)
   * @returns {{b0:number,b1:number,b2:number,a1:number,a2:number}}
   */
  function biquad(type, fs, f0, Q) {
    if (!(fs > 0) || !isFinite(fs) || !isFinite(f0) || !(Q > 0) || !isFinite(Q)) {
      throw new Error("biquad: sample rate, frequency and Q must be positive, finite numbers");
    }
    // Out-of-range cutoffs are clamped (not trusted): a cutoff at 0 Hz or above Nyquist would give NaN output.
    f0 = Math.min(Math.max(f0, fs * 1e-4), fs * 0.49);
    const w0 = (2 * Math.PI * f0) / fs;
    const cosw = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Q);
    let b0, b1, b2;
    if (type === "lowpass") {
      b0 = (1 - cosw) / 2; b1 = 1 - cosw; b2 = (1 - cosw) / 2;
    } else if (type === "highpass") {
      b0 = (1 + cosw) / 2; b1 = -(1 + cosw); b2 = (1 + cosw) / 2;
    } else if (type === "notch") {
      b0 = 1; b1 = -2 * cosw; b2 = 1;
    } else {
      throw new Error("unknown filter type: " + type);
    }
    const a0 = 1 + alpha;
    return {
      b0: b0 / a0, b1: b1 / a0, b2: b2 / a0,
      a1: (-2 * cosw) / a0, a2: (1 - alpha) / a0,
    };
  }

  /**
   * Runs one biquad over a signal using the difference equation
   *   y[n] = b0 x[n] + b1 x[n-1] + b2 x[n-2] - a1 y[n-1] - a2 y[n-2].
   * One pass delays the signal slightly (phase shift); see filtfilt.
   * @param {ArrayLike<number>} x input samples
   * @param {{b0:number,b1:number,b2:number,a1:number,a2:number}} c coefficients from biquad()
   * @returns {Float64Array} filtered samples
   */
  function runBiquad(x, c) {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      y[i] = v;
      x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    }
    return y;
  }

  function reverse(x) {
    const r = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) r[i] = x[x.length - 1 - i];
    return r;
  }

  // Zero-phase filtering: filter forward, then backward, so the output isn't shifted in time.
  /**
   * Zero-phase filtering: apply each section forward, then run the result backward through the
   * same section and reverse again. The forward delay and backward advance cancel, so features
   * stay aligned in time with the input. The effective magnitude response is squared (steeper).
   * @param {ArrayLike<number>} x input samples
   * @param {Array} sections list of biquad coefficient objects
   * @returns {Float64Array}
   */
  function filtfilt(x, sections) {
    let y = x;
    for (const c of sections) {
      y = runBiquad(y, c);
      y = reverse(runBiquad(reverse(y), c));
    }
    return y;
  }

  // Q values that chain 2nd-order sections into a Butterworth (maximally flat) filter.
  const BUTTER_Q = { 2: [Math.SQRT1_2], 4: [0.5412, 1.3066] };

  /**
   * Butterworth filter built as a chain of biquads. A Butterworth response is maximally flat in the
   * pass band. Each biquad is one conjugate pole pair, and its Q is 1 / (2 cos(theta)) where theta
   * is the pole angle: order 2 -> Q = 0.7071; order 4 -> Q = 0.5412 and 1.3066.
   * @param {"lowpass"|"highpass"} type
   * @param {number} fs sample rate (Hz)
   * @param {number} fc -3 dB cutoff (Hz), kept below 0.45 fs
   * @param {2|4} [order=4]
   */
  function butter(type, fs, fc, order) {
    const qs = BUTTER_Q[order || 4];
    // Keep the cutoff safely below Nyquist (half the sample rate).
    const f = Math.min(fc, fs * 0.45);
    return qs.map((q) => biquad(type, fs, f, q));
  }

  /**
   * Band-pass = high-pass at `lo` followed by low-pass at `hi`, both 4th-order Butterworth and zero-phase.
   * Surface EMG has most of its power at roughly 20-450 Hz, so this removes slow drift (below `lo`)
   * and high-frequency hiss (above `hi`).
   */
  function bandpass(x, fs, lo, hi) {
    const sections = butter("highpass", fs, lo, 4).concat(butter("lowpass", fs, hi, 4));
    return filtfilt(x, sections);
  }

  /**
   * Notch (band-stop) filter that removes one narrow frequency, e.g. 60 Hz power-line hum.
   * Q = f0 / bandwidth, so Q = 30 at 60 Hz removes a band about 2 Hz wide.
   */
  function notch(x, fs, f0, Q) {
    return filtfilt(x, [biquad("notch", fs, f0, Q === undefined ? 30 : Q)]); // only an omitted Q defaults; NaN is rejected
  }

  /** Zero-phase Butterworth low-pass. Used to smooth the rectified signal into an envelope. */
  function lowpass(x, fs, fc, order) {
    return filtfilt(x, butter("lowpass", fs, fc, order || 4));
  }

  // ------------------------------------------------------------ basic stats
  function mean(x) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i];
    return x.length ? s / x.length : 0;
  }

  function std(x) {
    const m = mean(x);
    let s = 0;
    for (let i = 0; i < x.length; i++) s += (x[i] - m) * (x[i] - m);
    return x.length ? Math.sqrt(s / x.length) : 0;
  }

  function median(x) {
    const s = Array.from(x).sort((a, b) => a - b);
    const n = s.length;
    if (!n) return 0;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /**
   * Removes the constant baseline (DC offset) by subtracting the mean: y[n] = x[n] - mean(x).
   * Sensors and ADCs add a constant level (e.g. ~512 counts on a 10-bit Arduino). Left in, it looks like a
   * huge step to a filter that starts at zero and causes a false detection at the very start of the recording.
   * @param {ArrayLike<number>} x
   * @returns {Float64Array}
   */
  function removeDC(x) {
    const m = mean(x), y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = x[i] - m;
    return y;
  }

  /**
   * Full-wave rectification: y[n] = |x[n]|. EMG swings above and below zero, so its mean is about 0;
   * rectifying makes every swing positive so that smoothing measures effort instead of cancelling out.
   */
  function rectify(x) {
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) y[i] = Math.abs(x[i]);
    return y;
  }

  // Envelope = rectify, then smooth with a low-pass filter. Result follows how hard the muscle works.
  /**
   * Linear envelope = low-pass( |x| ). A lower cutoff gives a smoother curve but blurs short
   * contractions together; roughly, it averages over the last 1/cutoff seconds.
   * (A moving average does a similar job; a Butterworth low-pass has a cleaner frequency response.)
   */
  function envelope(x, fs, cutoffHz) {
    const e = lowpass(rectify(x), fs, cutoffHz, 4);
    for (let i = 0; i < e.length; i++) if (e[i] < 0) e[i] = 0; // filter ringing can dip below 0
    return e;
  }

  // ------------------------------------------------------------ detection
  // Resting level estimated from the quieter half of the envelope: mean + k * spread above it.
  /**
   * Estimates the resting level without labels: take the quieter half of the envelope (values at or
   * below the median) and compute its mean (mu) and standard deviation (sd).
   * Assumes the muscle is at rest for at least half of the recording.
   */
  function restStats(env) {
    const med = median(env);
    const rest = [];
    for (let i = 0; i < env.length; i++) if (env[i] <= med) rest.push(env[i]);
    return { mu: mean(rest), sd: std(rest) };
  }

  /** Detection threshold = mu + k * sd, using restStats(). Larger k means fewer false alarms but more misses. */
  function thresholdFor(env, k) {
    const r = restStats(env);
    return r.mu + k * r.sd;
  }

  // Returns [[startSample, endSample], ...] for stretches above threshold.
  /**
   * Finds stretches where env > thr, then (1) merges stretches separated by gaps of at most
   * `mergeGapMs` (one contraction can flicker around the threshold) and (2) drops stretches shorter
   * than `minDurMs` (cable bumps last only tens of milliseconds).
   * @returns {Array<[number, number]>} [startSample, endSample] pairs
   */
  function detect(env, thr, fs, minDurMs, mergeGapMs) {
    const minLen = Math.round(((minDurMs == null ? 100 : minDurMs) * fs) / 1000);
    const gap = Math.round(((mergeGapMs == null ? 100 : mergeGapMs) * fs) / 1000);
    const raw = [];
    let start = -1;
    for (let i = 0; i < env.length; i++) {
      if (env[i] > thr) {
        if (start < 0) start = i;
      } else if (start >= 0) {
        raw.push([start, i - 1]);
        start = -1;
      }
    }
    if (start >= 0) raw.push([start, env.length - 1]);
    // merge segments separated by tiny gaps, then drop segments that are too short
    const merged = [];
    for (const seg of raw) {
      const last = merged[merged.length - 1];
      if (last && seg[0] - last[1] <= gap) last[1] = seg[1];
      else merged.push([seg[0], seg[1]]);
    }
    return merged.filter((s) => s[1] - s[0] + 1 >= minLen);
  }

  // Compare detections with the known true contractions (only possible for simulated data).
  /**
   * Scores detections against known true contractions (possible only for simulated data).
   * hit (tp): a true contraction overlapped by a detection; false alarm (fp): a detection overlapping
   * no true contraction; miss (fn): a true contraction with no detection.
   * precision P = tp / (tp + fp), recall R = tp / (tp + fn), F1 = 2PR / (P + R).
   * With no true contractions, the score is 1 if nothing was detected and 0 otherwise.
   */
  function scoreDetections(detected, truth) {
    // Nothing should have been found (e.g. a resting muscle): perfect only if nothing was detected.
    if (!truth.length) {
      const fa = detected.length;
      return { tp: 0, fp: fa, fn: 0, precision: fa ? 0 : 1, recall: 1, f1: fa ? 0 : 1 };
    }
    const overlaps = (a, b) => a[0] <= b[1] && b[0] <= a[1];
    let tp = 0;
    const usedDet = new Set();
    for (const t of truth) {
      const hit = detected.findIndex((d, i) => !usedDet.has(i) && overlaps(d, t));
      if (hit >= 0) { tp++; usedDet.add(hit); }
    }
    // Any detection that touches no true contraction is a false alarm.
    let fp = 0;
    for (let i = 0; i < detected.length; i++) {
      if (!truth.some((t) => overlaps(detected[i], t))) fp++;
    }
    const fn = truth.length - tp;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = truth.length ? tp / truth.length : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { tp, fp, fn, precision, recall, f1 };
  }

  // How much stronger is the signal during contractions than at rest? (dB, higher = cleaner)
  /**
   * Signal quality in dB: 20 log10( mean envelope inside contractions / mean envelope outside ).
   * 20 dB means contractions are 10x stronger than rest. Returns null if it cannot be computed.
   */
  function snrDb(env, segments) {
    if (!segments.length) return null;
    const inSeg = new Uint8Array(env.length);
    let sumA = 0, nA = 0;
    for (const [s, e] of segments) {
      for (let i = s; i <= e; i++) { inSeg[i] = 1; sumA += env[i]; nA++; }
    }
    let sumR = 0, nR = 0;
    for (let i = 0; i < env.length; i++) if (!inSeg[i]) { sumR += env[i]; nR++; }
    if (!nA || !nR || sumR === 0) return null;
    return 20 * Math.log10(sumA / nA / (sumR / nR));
  }

  // ------------------------------------------------------------ spectrum (FFT)
  /**
   * In-place radix-2 Cooley-Tukey FFT of length N (a power of two): X[k] = sum_n x[n] e^(-2 pi i k n / N).
   * Re-orders samples by bit reversal, then combines pairs with "butterfly" operations in log2(N) stages.
   */
  function fft(re, im) {
    // In-place iterative radix-2 FFT. Length must be a power of two.
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = i + k + len / 2;
          const tr = re[b] * cr - im[b] * ci;
          const ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  // Welch-style power spectrum: average the FFT of overlapping Hann-windowed chunks.
  /**
   * Welch power spectrum: split the signal into 50 %-overlapping windows of `nfft` samples, multiply
   * each by a Hann window (reduces spectral leakage), take |FFT|^2, and average over windows.
   * Frequency of bin k is k * fs / nfft. Output is un-normalised, so compare shapes, not absolute values.
   */
  function powerSpectrum(x, fs, nfft) {
    const N = nfft || 512;
    const half = N / 2;
    const psd = new Float64Array(half + 1);
    const hann = new Float64Array(N);
    for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    let chunks = 0;
    for (let s = 0; s + N <= x.length; s += half) {
      const re = new Float64Array(N), im = new Float64Array(N);
      for (let i = 0; i < N; i++) re[i] = x[s + i] * hann[i];
      fft(re, im);
      for (let k = 0; k <= half; k++) psd[k] += re[k] * re[k] + im[k] * im[k];
      chunks++;
    }
    const freqs = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      freqs[k] = (k * fs) / N;
      if (chunks) psd[k] /= chunks;
    }
    return { freqs, psd };
  }

  // ------------------------------------------------------------ simulated muscle
  // Presets: how loud the background noise is relative to the muscle signal.
  const DIFFICULTY = {
    easy:   { noise: 0.10, hum: 0.15, drift: 0.3, bump: 0.0 },
    medium: { noise: 0.35, hum: 1.00, drift: 1.2, bump: 1.4 },
    hard:   { noise: 0.60, hum: 2.00, drift: 2.5, bump: 1.8 },
  };

  const DEFAULT_PLAN = [
    [1.0, 2.2, 1.0], [3.4, 4.3, 0.7], [5.2, 6.8, 1.0],
    [7.8, 8.6, 0.4], [9.6, 11.0, 0.9],
  ];

  /** One-click example signals. `plan` lists [start s, end s, strength] for each true contraction. */
  const PRESETS = {
    rest: {
      label: "Resting muscle", seconds: 8, difficulty: "medium", seed: 11, plan: [], bump: 0,
      blurb: "No contraction at all, only hum, drift and sensor noise. The right answer is zero detections. Make the threshold too sensitive and the detector starts firing on noise.",
    },
    moderate: {
      label: "Moderate contraction", seconds: 8, difficulty: "easy", seed: 5, plan: [[1.5, 5.5, 0.6]],
      blurb: "One sustained, moderate contraction in a fairly clean recording.",
    },
    maxflex: {
      label: "Max flex + artifact noise", difficulty: "hard", seed: 9,
      seconds: 10, plan: [[0.8, 2.2, 1.6], [3.2, 4.2, 1.8], [5.2, 6.8, 1.5]],
      blurb: "Three strong contractions buried in heavy hum, drift and cable bumps. In step 2, compare the signal quality number with the filters on and off.",
    },
  };

  /* Simulated surface EMG: noise shaped to 20-450 Hz (like real muscle activity), switched on
   * during known contractions, plus common real-world problems:
   *   - 60 Hz mains hum (US power lines)
   *   - slow baseline drift / motion artifact
   *   - broadband sensor noise
   * Returns {x, fs, truth:[[start,end],...]} where truth marks the true contractions. */
  /**
   * Builds a simulated EMG recording with known ground truth: band-limited (20-450 Hz) noise switched
   * on during each planned contraction, plus mains hum, slow drift, sensor noise and cable bumps.
   * @param {{fs?:number,seconds?:number,difficulty?:string,seed?:number,plan?:Array,mains?:number,bump?:number}} [opts]
   * @returns {{x:Float64Array, fs:number, truth:Array<[number,number]>}}
   */
  function simulateEMG(opts) {
    const o = Object.assign({ fs: 1000, seconds: 12, difficulty: "medium", seed: 7, mains: 60 }, opts || {});
    const d = Object.assign({}, DIFFICULTY[o.difficulty] || DIFFICULTY.medium);
    if (o.bump != null) d.bump = o.bump; // presets can switch cable bumps on or off
    const fs = o.fs, n = Math.round(o.seconds * fs);
    const rand = mulberry32(o.seed);

    // Contractions at fixed times, with different strengths (like a real user).
    // [start s, end s, strength]. In the default plan one contraction is deliberately weak:
    // a threshold set too high misses it. Presets pass their own plan.
    const plan = (o.plan || DEFAULT_PLAN).filter((p) => p[1] < o.seconds);
    const gate = new Float64Array(n);
    const truth = [];
    for (const [a, b, amp] of plan) {
      const s = Math.round(a * fs), e = Math.round(b * fs);
      truth.push([s, e]);
      for (let i = s; i < e; i++) gate[i] = amp;
    }
    // Smooth the on/off switching a little so onsets aren't perfectly square.
    const smooth = lowpass(gate, fs, 8, 2);

    // Muscle noise: white noise limited to the 20-450 Hz band, scaled by the gate.
    const white = new Float64Array(n);
    for (let i = 0; i < n; i++) white[i] = gaussian(rand);
    const band = bandpass(white, fs, 20, 450);
    const x = new Float64Array(n);
    const phase = rand() * 2 * Math.PI;
    // Cable bumps: very brief (50 ms) bursts during rest that look like muscle but are not.
    const bumps = new Float64Array(n);
    if (d.bump > 0) {
      for (const at of [2.8, 4.8, 7.2, 9.1]) {
        const s0 = Math.round(at * fs), len = Math.round(0.05 * fs);
        for (let i = 0; i < len && s0 + i < n; i++) {
          bumps[s0 + i] = d.bump * Math.sin((Math.PI * i) / len) * gaussian(rand);
        }
      }
    }
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const muscle = band[i] * Math.max(0, smooth[i]) * 1.0;
      const sensor = gaussian(rand) * d.noise * 0.6;
      const hum = d.hum * 0.5 * Math.sin(2 * Math.PI * o.mains * t + phase);
      const drift = d.drift * (0.8 * Math.sin(2 * Math.PI * 0.4 * t) + 0.4 * Math.sin(2 * Math.PI * 1.3 * t + 1));
      x[i] = muscle + sensor + hum + drift + bumps[i];
    }
    return { x, fs, truth };
  }

  // ------------------------------------------------------------ CSV import
  // Accepts one column (just values) or two+ columns (time, value, ...). Header lines are skipped.
  // Refuses data it cannot interpret safely, because a wrong guess would look like a real result.
  /**
   * Reads a CSV/TSV of EMG samples. Accepts one column (values) or time,value[,...]. Skips header and
   * non-numeric rows (and counts them). Refuses data it cannot interpret safely: fewer than 200 samples,
   * inconsistent columns, a first column that is not increasing time (also catches decimal commas),
   * and flat data. Sample rate is estimated as 1 / median(dt) when a time column is present.
   */
  function parseCSV(text) {
    const values = [], times = [];
    let skipped = 0, twoCol = false, columns = 1;
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      const parts = t.split(/[,\t;]+/).map((s) => s.trim()).filter((s) => s !== "");
      const nums = parts.map(Number);
      if (!nums.length || nums.some((v) => !isFinite(v))) { skipped++; continue; } // header, NaN or junk row
      columns = Math.max(columns, nums.length);
      if (nums.length >= 2) {
        twoCol = true;
        times.push(nums[0]);
        values.push(nums[1]);
      } else {
        values.push(nums[0]);
      }
    }
    if (values.length < 200) {
      throw new Error("Found only " + values.length + " numeric samples. Need at least 200 (about 0.2 s at 1000 Hz).");
    }
    if (twoCol && times.length !== values.length) {
      throw new Error("Some rows have one number and others have two. Use one consistent format: either a single column of values, or time,value.");
    }
    let fs = null;
    if (twoCol) {
      const dts = [];
      for (let i = 1; i < times.length; i++) dts.push(times[i] - times[i - 1]);
      const increasing = dts.filter((d) => d > 0).length / dts.length;
      if (increasing < 0.95) {
        throw new Error("This file has two or more columns, but the first column is not steadily increasing time. " +
          "If your numbers use decimal commas (0,5), re-export with decimal points. Otherwise use a single column of values, or time,value.");
      }
      const dt = median(dts);
      if (dt > 0) {
        fs = 1 / dt;
        // Times in milliseconds give an absurdly low rate; convert if that looks like what happened.
        if (fs < 5) fs *= 1000;
      }
    }
    const x = Float64Array.from(values);
    if (std(x) <= 1e-12 * Math.max(1, Math.abs(mean(x)))) {
      throw new Error("Every value in this file is the same, so there is no signal to analyze.");
    }
    return { x, fs: fs ? Math.round(fs) : null, skipped, columns };
  }

  // Min/max decimation for drawing: keeps the peaks visible when there are more samples than pixels.
  function decimate(x, width) {
    const n = x.length;
    const out = [];
    const step = n / width;
    for (let px = 0; px < width; px++) {
      const a = Math.floor(px * step), b = Math.max(a + 1, Math.floor((px + 1) * step));
      let lo = Infinity, hi = -Infinity;
      for (let i = a; i < b && i < n; i++) {
        if (x[i] < lo) lo = x[i];
        if (x[i] > hi) hi = x[i];
      }
      out.push([lo, hi]);
    }
    return out;
  }

  const api = {
    mulberry32, gaussian, biquad, runBiquad, filtfilt, butter, bandpass, notch, lowpass,
    mean, std, median, removeDC, rectify, envelope, restStats, thresholdFor, detect, scoreDetections,
    snrDb, fft, powerSpectrum, simulateEMG, DIFFICULTY, PRESETS, parseCSV, decimate,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.NPDSP = api;
})(typeof window !== "undefined" ? window : globalThis);
