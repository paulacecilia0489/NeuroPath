// Run: node tests/unit.test.js
const assert = require("assert");
const D = require("../dsp.js");
const L = require("../labs.js");
global.window = {};
require("../labs-data.js");
const LABS = global.window.NP_LABS;

let passed = 0;
function t(name, fn) { fn(); passed++; console.log("  ok  " + name); }
const approx = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ""} expected ${b} +/- ${tol}, got ${a}`);

// ----- filters
function sine(f, fs, n, amp) { const x = new Float64Array(n); for (let i = 0; i < n; i++) x[i] = (amp || 1) * Math.sin(2 * Math.PI * f * i / fs); return x; }
function rms(x, a, b) { let s = 0; a = a || 0; b = b || x.length; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); }

t("band-pass keeps 100 Hz, kills 2 Hz drift", () => {
  const fs = 1000, n = 4000;
  const keep = D.bandpass(sine(100, fs, n), fs, 20, 450);
  const drop = D.bandpass(sine(2, fs, n), fs, 20, 450);
  approx(rms(keep, 500, 3500), Math.SQRT1_2, 0.08, "100 Hz passes");
  assert.ok(rms(drop, 500, 3500) < 0.02, "2 Hz is removed");
});
t("notch removes 60 Hz but keeps 100 Hz", () => {
  const fs = 1000, n = 4000;
  assert.ok(rms(D.notch(sine(60, fs, n), fs, 60, 30), 500, 3500) < 0.03);
  approx(rms(D.notch(sine(100, fs, n), fs, 60, 30), 500, 3500), Math.SQRT1_2, 0.05);
});
t("low-pass envelope follows a slow change", () => {
  const fs = 1000, x = new Float64Array(4000).fill(1);
  const e = D.envelope(x, fs, 5);
  approx(e[2000], 1, 0.02);
});
t("filters are zero-phase (no time shift)", () => {
  const fs = 1000, n = 3000, x = new Float64Array(n);
  for (let i = 1400; i < 1600; i++) x[i] = Math.sin(2 * Math.PI * 100 * i / fs);
  const y = D.bandpass(x, fs, 20, 450);
  let pk = 0, at = 0;
  for (let i = 0; i < n; i++) if (Math.abs(y[i]) > pk) { pk = Math.abs(y[i]); at = i; }
  assert.ok(at > 1400 && at < 1600, "peak stays inside the burst, got " + at);
});
t("cutoff above Nyquist is clamped, output stays finite", () => {
  const x = sine(50, 500, 2000);
  const y = D.bandpass(x, 500, 20, 450);
  assert.ok(Array.from(y).every(Number.isFinite));
});

// ----- FFT
t("FFT finds a 120 Hz tone", () => {
  const fs = 1000, x = sine(120, fs, 4096);
  const { freqs, psd } = D.powerSpectrum(x, fs, 512);
  let best = 0;
  for (let k = 1; k < psd.length; k++) if (psd[k] > psd[best]) best = k;
  approx(freqs[best], 120, 3, "peak frequency");
});

// ----- detection and scoring
t("detect finds segments, merges small gaps, drops blips", () => {
  const fs = 1000, env = new Float64Array(3000);
  for (let i = 500; i < 900; i++) env[i] = 1;
  for (let i = 950; i < 1200; i++) env[i] = 1;    // 50 ms gap -> merged with previous
  for (let i = 2000; i < 2030; i++) env[i] = 1;   // 30 ms blip -> dropped
  const d = D.detect(env, 0.5, fs, 100, 100);
  assert.strictEqual(d.length, 1);
  assert.deepStrictEqual(d[0], [500, 1199]);
});
t("scoreDetections counts hits, misses, false alarms", () => {
  const truth = [[100, 200], [400, 500], [700, 800]];
  const det = [[110, 190], [410, 420], [900, 950]];
  const s = D.scoreDetections(det, truth);
  assert.deepStrictEqual([s.tp, s.fp, s.fn], [2, 1, 1]);
  approx(s.f1, 2 / 3, 1e-9);
  const perfect = D.scoreDetections(truth, truth);
  assert.strictEqual(perfect.f1, 1);
});
t("two detections on one true contraction: second is not a false alarm, not double counted", () => {
  const s = D.scoreDetections([[100, 120], [150, 190]], [[100, 200]]);
  assert.deepStrictEqual([s.tp, s.fp, s.fn], [1, 0, 0]);
});

// ----- simulation
t("simulation is deterministic and has 5 true contractions", () => {
  const a = D.simulateEMG({ seed: 3 }), b = D.simulateEMG({ seed: 3 }), c = D.simulateEMG({ seed: 4 });
  assert.strictEqual(a.truth.length, 5);
  assert.strictEqual(a.x[500], b.x[500]);
  assert.notStrictEqual(a.x[500], c.x[500]);
  assert.strictEqual(a.x.length, 12000);
});
t("good pipeline scores perfectly on every difficulty; unfiltered hard data fails", () => {
  const cfg = { easy: 4, medium: 3, hard: 3 };
  for (const diff of ["easy", "medium", "hard"]) {
    const { x, fs, truth } = D.simulateEMG({ difficulty: diff });
    let y = D.notch(D.bandpass(x, fs, 20, 450), fs, 60, 30);
    const env = D.envelope(y, fs, 10);
    const det = D.detect(env, D.thresholdFor(env, cfg[diff]), fs, 100, 100);
    assert.strictEqual(D.scoreDetections(det, truth).f1, 1, diff + " should be solvable");
  }
  const { x, fs, truth } = D.simulateEMG({ difficulty: "hard" });
  const env = D.envelope(D.bandpass(x, fs, 0.5, 450), fs, 5);
  assert.ok(D.scoreDetections(D.detect(env, D.thresholdFor(env, 6), fs, 100, 100), truth).f1 < 0.5);
});
t("filtering improves SNR", () => {
  const { x, fs, truth } = D.simulateEMG({ difficulty: "medium" });
  const raw = D.envelope(x, fs, 5);
  const good = D.envelope(D.notch(D.bandpass(x, fs, 20, 450), fs, 60, 30), fs, 5);
  assert.ok(D.snrDb(good, truth) > D.snrDb(raw, truth) + 5);
});

// ----- CSV
t("parseCSV: one column with header", () => {
  const rows = ["emg"].concat(Array.from({ length: 300 }, (_, i) => String(Math.sin(i))));
  const r = D.parseCSV(rows.join("\n"));
  assert.strictEqual(r.x.length, 300);
  assert.strictEqual(r.fs, null);
});
t("parseCSV: time,value with seconds and with milliseconds", () => {
  const sec = Array.from({ length: 400 }, (_, i) => `${(i / 500).toFixed(4)},${Math.cos(i)}`).join("\n");
  assert.strictEqual(D.parseCSV("t,v\n" + sec).fs, 500);
  const ms = Array.from({ length: 400 }, (_, i) => `${i * 2},${Math.cos(i)}`).join("\n");
  assert.strictEqual(D.parseCSV(ms).fs, 500);
});
t("parseCSV rejects too-short or non-numeric input", () => {
  assert.throws(() => D.parseCSV("hello\nworld"));
  assert.throws(() => D.parseCSV("1\n2\n3"));
});
t("parseCSV refuses decimal-comma files instead of silently reading garbage", () => {
  const eu = Array.from({ length: 300 }, (_, i) => (Math.sin(i)).toFixed(3).replace(".", ",")).join("\n");
  assert.throws(() => D.parseCSV(eu), /first column is not steadily increasing time/);
});
t("parseCSV refuses two columns when the first is not time", () => {
  const rows = Array.from({ length: 300 }, (_, i) => `${Math.sin(i * 7)},${Math.cos(i)}`).join("\n");
  assert.throws(() => D.parseCSV(rows), /not steadily increasing time/);
});
t("parseCSV refuses a flat file", () => {
  assert.throws(() => D.parseCSV(Array(400).fill("5").join("\n")), /same/);
  assert.throws(() => D.parseCSV(Array(400).fill("0").join("\n")), /same/);
});
t("parseCSV refuses mixed 1-column and 2-column rows", () => {
  const rows = Array.from({ length: 300 }, (_, i) => (i % 2 ? `${i / 1000},${Math.sin(i)}` : `${Math.sin(i)}`)).join("\n");
  assert.throws(() => D.parseCSV(rows));
});
t("parseCSV reports skipped rows and extra columns, and accepts CRLF / semicolons / scientific notation", () => {
  const r = D.parseCSV(Array.from({ length: 300 }, (_, i) => (i % 50 === 0 ? "NaN" : (Math.sin(i) * 1e-4).toExponential(3))).join("\r\n"));
  assert.strictEqual(r.skipped, 6); assert.strictEqual(r.x.length, 294);
  const three = D.parseCSV(Array.from({ length: 300 }, (_, i) => `${i / 1000};${Math.sin(i)};${Math.cos(i)}`).join("\n"));
  assert.strictEqual(three.columns, 3); assert.strictEqual(three.fs, 1000);
});
t("pipeline stays finite at extreme sample rates (100 Hz and 20 kHz)", () => {
  for (const fs of [100, 20000]) {
    const x = D.simulateEMG({ fs, seconds: 12 }).x;
    const lp = Math.min(450, fs * 0.45), hp = Math.min(20, lp * 0.8);
    const y = D.bandpass(x, fs, hp, lp);
    assert.ok(Array.from(y).every(Number.isFinite), "fs " + fs);
  }
});
t("decimate keeps peaks", () => {
  const x = new Float64Array(10000); x[5000] = 9;
  const d = D.decimate(x, 100);
  assert.strictEqual(Math.max(...d.map((p) => p[1])), 9);
});

// ----- lab matching
const bci = { grade: "senior", interests: "brain-computer interface, EEG", skills: "python, signal processing", mode: "any" };
t("matching ranks the BCI lab first", () => {
  const r = L.rankLabs(LABS, bci);
  assert.strictEqual(r[0].lab.id, "demo-2");
  assert.ok(r[0].shared.length >= 2);
});
t("grade and format filters apply", () => {
  const fresh = L.rankLabs(LABS, { ...bci, grade: "freshman" }).map((r) => r.lab.id);
  assert.ok(!fresh.includes("demo-2") && fresh.includes("demo-4"));
  const inp = L.rankLabs(LABS, { ...bci, mode: "in-person" }).map((r) => r.lab.id);
  assert.ok(!inp.includes("demo-2"));
});
t("no overlap does not crash", () => {
  const r = L.rankLabs(LABS, { grade: "senior", interests: "zzzz", skills: "", mode: "any" });
  assert.ok(Array.isArray(r));
});

// ----- email
t("email validation and structure", () => {
  const st = { name: "Sam", grade: "senior", school: "Cypress Bay High School", project: "https://github.com/sam/emg" };
  const q = "Why did you choose a linear decoder instead of a neural network for the EMG signals in your study?";
  assert.ok(L.validateEmailInputs(st, "too short"));
  assert.ok(L.validateEmailInputs(st, q.replace("Why", "[Why")));
  assert.ok(L.validateEmailInputs({ ...st, name: " " }, q));
  assert.strictEqual(L.validateEmailInputs(st, q), null);
  const { subject, body } = L.buildEmail(st, LABS[1], q);
  assert.ok(subject.includes("Prof. Sample's 2025 paper on brain-computer interface"));
  assert.ok(body.includes(q) && body.includes("https://github.com/sam/emg") && !/\[|\]/.test(body));
  assert.ok(!L.buildEmail({ ...st, project: "" }, LABS[1], q).body.includes("project I built"));
  assert.strictEqual(L.lastName("Dr. Jordan Sample Jr."), "Sample");
});
t("send window is Tue-Thu at 8 AM", () => {
  assert.ok(L.nextSendWindow(new Date(2026, 9, 21, 19, 0)).startsWith("Thursday")); // Wed evening -> Thu
  assert.ok(L.nextSendWindow(new Date(2026, 9, 23, 12, 0)).startsWith("Tuesday"));  // Fri -> Tue
});


// ================= v3: presets, edge cases, outreach rules =================
const fin = (a) => Array.from(a).every(Number.isFinite);
function runPipe(x, fs, p) {
  const lp = Math.min(p.lp, fs * 0.45), hp = Math.min(p.hp, lp * 0.8);
  let y = D.bandpass(D.removeDC(x), fs, hp, lp); if (p.notch) y = D.notch(y, fs, 60, 30); // same order as app.js
  const env = D.envelope(y, fs, p.envHz), thr = D.thresholdFor(env, p.k);
  return { y, env, thr, det: D.detect(env, thr, fs, p.minMs, 100) };
}
const DEF = { hp: 20, lp: 450, notch: true, envHz: 5, k: 6, minMs: 100 };
const presetSim = (pr) => D.simulateEMG({ difficulty: pr.difficulty, seconds: pr.seconds, seed: pr.seed, plan: pr.plan, bump: pr.bump });

t("every preset is solved by the default pipeline", () => {
  for (const [id, pr] of Object.entries(D.PRESETS)) {
    const sim = presetSim(pr), r = runPipe(sim.x, sim.fs, DEF);
    assert.strictEqual(D.scoreDetections(r.det, sim.truth).f1, 1, id);
  }
});
t("resting preset has zero true contractions and fires on noise only when the threshold is too sensitive", () => {
  const sim = presetSim(D.PRESETS.rest);
  assert.strictEqual(sim.truth.length, 0);
  assert.strictEqual(runPipe(sim.x, sim.fs, DEF).det.length, 0);
  const sens = runPipe(sim.x, sim.fs, { ...DEF, k: 2, envHz: 20 });
  assert.ok(sens.det.length > 0 && D.scoreDetections(sens.det, sim.truth).f1 === 0);
});
t("max-flex preset: filters raise signal quality by more than 5 dB", () => {
  const sim = presetSim(D.PRESETS.maxflex);
  const on = runPipe(sim.x, sim.fs, DEF), off = runPipe(sim.x, sim.fs, { ...DEF, hp: 1, notch: false });
  assert.ok(D.snrDb(on.env, sim.truth) > D.snrDb(off.env, sim.truth) + 5);
});
t("scoring with no true contractions: 1 if silent, 0 if anything fires", () => {
  assert.strictEqual(D.scoreDetections([], []).f1, 1);
  const s = D.scoreDetections([[10, 50], [90, 120]], []);
  assert.deepStrictEqual([s.f1, s.fp, s.fn, s.tp], [0, 2, 0, 0]);
});

// ---- edge cases in the signal processing
t("edge: all-zero array -> finite output, no detections, no crash", () => {
  const z = new Float64Array(5000), r = runPipe(z, 1000, DEF);
  assert.ok(fin(r.y) && fin(r.env));
  assert.strictEqual(r.det.length, 0);
  assert.strictEqual(D.snrDb(r.env, []), null);
  assert.strictEqual(D.snrDb(r.env, r.det), null);
});
t("edge: perfectly flat noise floor (constant value) does not produce a confident detection", () => {
  const c = new Float64Array(5000).fill(3), r = runPipe(c, 1000, DEF);
  assert.ok(fin(r.y) && fin(r.env));
  const strong = r.det.filter((d) => d[1] - d[0] > 200);
  assert.strictEqual(strong.length, 0, "no long detections on a flat line");
});
t("DC offset (e.g. ADC counts around 512 or 2500) does not create a false detection at the start", () => {
  const sim = D.simulateEMG({ difficulty: "easy" });
  for (const off of [0, 512, 2500, -4000, 1e6]) {
    const x = Float64Array.from(sim.x, (v) => v * 50 + off);
    const r = runPipe(x, 1000, DEF), sc = D.scoreDetections(r.det, sim.truth);
    assert.strictEqual(sc.f1, 1, "offset " + off);
    assert.ok(r.det[0][0] > 500, "first detection is a real contraction, not the startup transient (offset " + off + ")");
  }
});
t("removeDC subtracts the mean and handles empty input", () => {
  const y = D.removeDC([10, 12, 14]); assert.deepStrictEqual(Array.from(y), [-2, 0, 2]);
  assert.strictEqual(D.removeDC([]).length, 0);
});
t("edge: tiny and huge amplitudes behave the same (scale invariance of detection)", () => {
  const sim = D.simulateEMG({ difficulty: "easy" });
  const small = Float64Array.from(sim.x, (v) => v * 1e-6), big = Float64Array.from(sim.x, (v) => v * 1e6);
  const a = runPipe(sim.x, 1000, DEF).det, b = runPipe(small, 1000, DEF).det, c = runPipe(big, 1000, DEF).det;
  assert.deepStrictEqual(b, a); assert.deepStrictEqual(c, a);
});
t("edge: out-of-bounds cutoffs are clamped (negative, zero, above Nyquist, huge)", () => {
  const x = D.simulateEMG({}).x;
  for (const [lo, hi] of [[-5, 99999], [0, 0], [1e9, 1e9], [0.0001, 0.0002]]) {
    assert.ok(fin(D.bandpass(x, 1000, lo, hi)), lo + "," + hi);
  }
  assert.ok(fin(D.notch(x, 1000, 0, 30)) && fin(D.notch(x, 1000, 9999, 30)));
  assert.ok(fin(D.lowpass(x, 1000, -1, 4)) && fin(D.lowpass(x, 1000, 1e6, 4)));
});
t("edge: NaN parameters and a zero sample rate are rejected loudly, not silently", () => {
  const x = D.simulateEMG({}).x;
  assert.throws(() => D.bandpass(x, 1000, NaN, 450), /finite/);
  assert.throws(() => D.notch(x, 1000, 60, NaN), /finite|positive/);
  assert.throws(() => D.bandpass(x, 0, 20, 450), /positive/);
  assert.throws(() => D.bandpass(x, 1000, 20, 450) && D.biquad("wobble", 1000, 50, 1), /unknown/);
});
t("edge: empty and one-sample arrays do not crash", () => {
  assert.strictEqual(D.bandpass(new Float64Array(0), 1000, 20, 450).length, 0);
  assert.ok(fin(D.bandpass(new Float64Array([3]), 1000, 20, 450)));
  assert.deepStrictEqual(D.detect(new Float64Array(0), 1, 1000, 100, 100), []);
  assert.strictEqual(D.median([]), 0);
});
t("edge: detect with threshold Infinity / NaN finds nothing", () => {
  const env = new Float64Array(2000).fill(1);
  assert.strictEqual(D.detect(env, Infinity, 1000, 100, 100).length, 0);
  assert.strictEqual(D.detect(env, NaN, 1000, 100, 100).length, 0);
});
t("edge: a lone short spike is dropped by the minimum-duration rule", () => {
  const env = new Float64Array(2000); env[1000] = 50;
  assert.strictEqual(D.detect(env, 1, 1000, 100, 100).length, 0);
  assert.strictEqual(D.detect(env, 1, 1000, 0, 100).length, 1);
});

// ---- lab matching and outreach rules
t("topic tags drive matching even when the words are absent from the summary", () => {
  const lab = { keywords: "", summary: "A lab.", methods: "", department: "", skills: "", tags: ["EMG", "prosthetics"] };
  const other = { keywords: "", summary: "A lab.", methods: "", department: "", skills: "", tags: ["memory"] };
  const r = L.rankLabs([other, lab], { grade: "senior", interests: "EMG, prosthetics", skills: "", mode: "any" });
  assert.strictEqual(r[0].lab, lab);
});
t("bridge query (EMG, signal processing) ranks an EMG demo lab first", () => {
  const r = L.rankLabs(LABS, { grade: "senior", interests: "EMG, signal processing, prosthetics, motor control", skills: "signal processing, EMG", mode: "any" });
  assert.ok(/EMG|Motor|Neural/.test(r[0].lab.lab + r[0].lab.keywords));
  assert.ok(r[0].lab.tags.includes("EMG"));
});
t("specificityHint flags generic questions and accepts specific ones", () => {
  const lab = LABS.find((l) => l.id === "demo-6");
  assert.ok(L.specificityHint("I am very interested in your research and would love to learn more about what your students do there", lab));
  assert.strictEqual(L.specificityHint("Why did you choose proportional control over a simple threshold for the myoelectric prosthetic hand?", lab), null);
});
t("checklist has four items and the download text includes contact, subject, body and checklist", () => {
  assert.strictEqual(L.OUTREACH_CHECKLIST.length, 4);
  const txt = L.draftFileText({ contact: "pi@u.edu" }, "Subject line", "Body text");
  assert.ok(txt.includes("To: pi@u.edu") && txt.includes("Subject: Subject line") && txt.includes("Body text"));
  assert.strictEqual((txt.match(/\[ \]/g) || []).length, 4);
});
t("practice sentence appears only when provided and never claims certification", () => {
  const st = { name: "Sam", grade: "senior", school: "", project: "" };
  const q = "Why did you choose a linear decoder instead of a neural network for the EMG signals in your study?";
  const without = L.buildEmail(st, LABS[1], q).body;
  const withP = L.buildEmail({ ...st, practice: "On a simulated EMG signal I detected 3 of 3 contractions." }, LABS[1], q).body;
  assert.ok(!without.includes("NeuroPath"));
  assert.ok(withP.includes("learning tool called NeuroPath") && withP.includes("3 of 3"));
  assert.ok(!/certif/i.test(withP), "must not claim a certification");
});

t("offer sentence appears only when provided, and brackets in it are rejected", () => {
  const st = { name: "Sam", grade: "senior", school: "", project: "" };
  const q = "Why did you choose a linear decoder instead of a neural network for the EMG signals in your study?";
  assert.ok(!L.buildEmail(st, LABS[1], q).body.includes("could help with"));
  const b = L.buildEmail({ ...st, offer: "cleaning data in Python." }, LABS[1], q).body;
  assert.ok(b.includes("I could help with: cleaning data in Python.") && !b.includes(".."));
  assert.ok(L.validateEmailInputs({ ...st, offer: "[task]" }, q), "bracketed offer rejected");
  assert.strictEqual(L.validateEmailInputs({ ...st, offer: "cleaning data" }, q), null);
});
t("draftChecks flags caps subject, exclamations, sales words, many links, long text, brackets", () => {
  assert.deepStrictEqual(L.draftChecks("Inquiry about your 2025 paper", "Dear Professor Lee, I read your paper. Thank you."), []);
  assert.ok(L.draftChecks("URGENT RESEARCH OPPORTUNITY NOW", "hi").length >= 1);
  assert.ok(L.draftChecks("Hello", "Great!! Wow!").some((n) => /exclamation/i.test(n)));
  assert.ok(L.draftChecks("Hello", "This is a guaranteed chance, act now").some((n) => /Sales-style/.test(n)));
  assert.ok(L.draftChecks("Hello", "a http://a.com b http://b.com c http://c.com").some((n) => /links/.test(n)));
  assert.ok(L.draftChecks("Hello", "word ".repeat(300)).some((n) => /words/.test(n)));
  assert.ok(L.draftChecks("Hello", "Dear [NAME]").some((n) => /bracket/.test(n)));
  assert.deepStrictEqual(L.draftChecks("EMG and EEG question", "I study EMG. The signal-free period was short."), []); // short acronyms and 'free' are fine
  assert.deepStrictEqual(L.draftChecks("", ""), []);
});
t("academicTiming gives the right window for each month", () => {
  assert.strictEqual(L.academicTiming(new Date(2026, 9, 24)).target, "spring");   // Oct 24 (today)
  assert.strictEqual(L.academicTiming(new Date(2026, 10, 3)).target, "spring");   // early Nov
  assert.strictEqual(L.academicTiming(new Date(2026, 10, 20)).good, false);       // late Nov
  assert.strictEqual(L.academicTiming(new Date(2027, 0, 15)).target, "summer");
  assert.strictEqual(L.academicTiming(new Date(2027, 3, 10)).target, "fall");
  assert.strictEqual(L.academicTiming(new Date(2026, 11, 10)).good, false);
  assert.strictEqual(L.academicTiming(new Date(2026, 8, 5)).good, false);
  assert.ok(L.academicTiming().note.length > 10, "works with no argument");
});
t("download text mentions Schedule send", () => {
  assert.ok(/Schedule send/.test(L.draftFileText({ contact: "x@y.edu" }, "s", "b")));
});

console.log(`\n${passed} tests passed`);
