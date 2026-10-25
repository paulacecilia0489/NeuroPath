// Part 1 of the SciPy cross-check: run dsp.js on a fixed signal and dump results as JSON.
// Usage: node tests/validate_scipy.js > out.json   (validate_scipy.py calls this for you)
const D = require("../dsp.js");
const fs = 1000, n = 6000;
const rand = D.mulberry32(42);
const x = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const t = i / fs;
  x[i] = D.gaussian(rand) + 0.8 * Math.sin(2 * Math.PI * 60 * t) + 1.5 * Math.sin(2 * Math.PI * 0.7 * t) + (t > 2 && t < 3 ? 2 * D.gaussian(rand) : 0);
}
const bp = D.bandpass(x, fs, 20, 450);
const nt = D.notch(x, fs, 60, 30);
const lp5 = D.lowpass(D.rectify(bp), fs, 5, 4);
const spec = D.powerSpectrum(x, fs, 512);
console.log(JSON.stringify({
  fs, x: Array.from(x), bandpass: Array.from(bp), notch: Array.from(nt), env: Array.from(lp5),
  freqs: Array.from(spec.freqs), psd: Array.from(spec.psd),
}));
