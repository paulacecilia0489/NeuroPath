/* app.js - NeuroPath user interface.
 * Sections:  1 helpers  2 content  3 state  4 pipeline  5 plotting  6 Signal Lab UI
 *            7 gripper playback  8 Find-a-lab UI  9 tabs and start-up
 * The math lives in dsp.js and labs.js; this file only connects it to the page.
 */
(function () {
  "use strict";
  const DSP = window.NPDSP, LABS = window.NPLabs, CFG = window.NP_CONFIG || {};
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  // ======================================================== 1. helpers
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("neuropath:" + key); return v === null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) { try { localStorage.setItem("neuropath:" + key, JSON.stringify(value)); } catch (e) { /* private mode: ignore */ } },
  };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const fmt = (v, d) => (v == null || !isFinite(v) ? "n/a" : v.toFixed(d == null ? 1 : d));

  // ======================================================== 2. content
  const STEPS = [
    {
      short: "Raw signal", title: "This is what the sensor records",
      text: "A muscle sensor records the combined electrical activity of thousands of muscle fibers, plus everything else it picks up. The result looks like fuzz, and during a contraction it gets taller, not slower. Can you tell where the contractions are?",
      tryIt: () => "Look at the spectrum under the plot. The tall, narrow spike is power-line hum and the slow wave in the signal is baseline drift. Neither one is muscle.",
      quiz: {
        q: "Why does raw EMG look like noise even while the muscle is working?",
        opts: ["The sensor is broken.", "It is the sum of many fibers firing at random times, so it looks like noise whose size grows with effort.", "Skin blocks most of the signal."],
        answer: 1,
        why: "EMG has no clean waveform to read. Its amplitude is what carries information about effort.",
      },
    },
    {
      short: "Clean it up", title: "Remove what is not muscle",
      text: "Muscle activity sits mostly between about 20 and 450 Hz. A band-pass filter keeps that range and drops slow drift below it and hiss above it. A notch filter cuts one narrow frequency: the hum from wall power (60 Hz in the Americas, 50 Hz in much of the world).",
      tryIt: () => "Raise the high-pass above the drift, toggle the notch on and off, and watch the signal quality number and the spectrum change.",
      quiz: {
        q: "What does the 60 Hz notch filter target?",
        opts: ["Slow baseline drift.", "Hum from mains electricity.", "Muscle fatigue."],
        answer: 1,
        why: "Wall power oscillates at 60 Hz in the US, and the sensor leads act like antennas for it.",
      },
    },
    {
      short: "Envelope", title: "Turn swings into effort",
      text: "EMG swings positive and negative, so its average is close to zero. Rectifying (absolute value) fixes that. Smoothing the result with a low-pass filter draws an envelope: a curve that rises and falls with muscle effort.",
      tryIt: () => "Try the smallest and the largest smoothing cutoff. One blurs short contractions together, the other stays jittery.",
      quiz: {
        q: "Why rectify the signal before smoothing it?",
        opts: ["Positive and negative swings would cancel and average to about zero.", "It makes the signal louder.", "It removes the 60 Hz hum."],
        answer: 0,
        why: "Smoothing the raw signal would erase exactly the activity you want to measure.",
      },
    },
    {
      short: "Detect", title: "Decide when the muscle is on",
      text: "A threshold turns the envelope into a decision: above the line means on. The resting level is estimated from the quiet parts of your own recording, and you choose how far above it to set the line. Too low gives false alarms, too high misses weak contractions.",
      tryIt: (src) => {
        if (!src || !src.truth) return "Adjust the threshold until the shaded regions match the bursts you can see in your own data.";
        const n = src.truth.length;
        if (n === 0) return "Nothing is happening in this recording, so the right answer is zero detections. Lower the threshold and see what the detector starts mistaking for muscle.";
        if (src.preset) return "Find all " + n + " real contraction" + (n > 1 ? "s" : "") + " with zero false alarms. Then try to break it: move the threshold, change the smoothing, turn the filters off.";
        return "Challenge: find all " + n + " real contractions with zero false alarms. One contraction is weak, and some bumps are not muscle at all.";
      },
      quiz: {
        q: "You lower the threshold and now see detections while the muscle was resting. What happened?",
        opts: ["False alarms: the threshold became too sensitive.", "The filter added a delay.", "The sensor lost contact."],
        answer: 0,
        why: "Noise bumps now cross the line. The fix is a higher threshold, or ignoring very short blips.",
      },
    },
    {
      short: "Gripper", title: "Drive the gripper",
      text: "This is the idea behind a simple myoelectric prosthesis: when the detector says the muscle is on, the controller sends close. Press Play and watch the gripper follow your detections.",
      tryIt: () => "Go back, change a setting, and replay. A better pipeline gives a more faithful gripper.",
      quiz: {
        q: "What is a limit of controlling a gripper with one on/off threshold?",
        opts: ["It only gives open or closed, with no graded force or multiple grips.", "It is too slow to run on a computer.", "It cannot work with filtered signals."],
        answer: 0,
        why: "Real prosthetic controllers often add proportional control or pattern recognition on top of ideas like this.",
      },
    },
  ];

  // ======================================================== 3. state
  const DEFAULTS = { hp: 20, lp: 450, notch: true, notchHz: 60, envHz: 5, k: 6, minMs: 100 };
  const state = {
    step: 0,
    source: null,                         // { kind: "sim"|"upload", difficulty, x, fs, truth, label }
    p: Object.assign({}, DEFAULTS),
    out: null,                            // pipeline results (section 4)
    play: { on: false, t: 0, speed: 1, last: 0 },
    grip: 0,
    quiz: store.get("quiz", {}),          // { stepIndex: true } once answered correctly
    best: store.get("best", {}),          // { easy: 1, medium: 0.89, ... }
    visited: {},
  };

  // ======================================================== 4. pipeline
  function compute() {
    const s = state.source, p = state.p, fs = s.fs, x = s.x;
    // Slider values are clamped here too, so a bad value can never reach the filters.
    const clampTo = (v, lo, hi, dflt) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
    p.hp = clampTo(p.hp, 1, 60, DEFAULTS.hp); p.lp = clampTo(p.lp, 100, 450, DEFAULTS.lp);
    p.envHz = clampTo(p.envHz, 1, 40, DEFAULTS.envHz); p.k = clampTo(p.k, 1, 15, DEFAULTS.k);
    p.minMs = clampTo(p.minMs, 0, 300, DEFAULTS.minMs);
    const lpHz = Math.min(p.lp, fs * 0.45);
    const hpHz = Math.min(p.hp, lpHz * 0.8);
    const raw = DSP.removeDC(x); // step 0 of the pipeline: remove the sensor's constant baseline
    const band = DSP.bandpass(raw, fs, hpHz, lpHz);
    const useNotch = p.notch && p.notchHz < fs * 0.45;
    const clean = useNotch ? DSP.notch(band, fs, p.notchHz, 30) : band;
    const rect = DSP.rectify(clean);
    const env = DSP.envelope(clean, fs, p.envHz);
    const rawEnv = DSP.envelope(raw, fs, p.envHz);
    const thr = DSP.thresholdFor(env, p.k);
    const det = DSP.detect(env, thr, fs, p.minMs, 100);
    const score = s.truth ? DSP.scoreDetections(det, s.truth) : null;
    const segs = s.truth || det;
    let nfft = 512;
    while (nfft > x.length && nfft > 64) nfft /= 2;
    state.out = {
      raw, lpHz, hpHz, clean, rect, env, thr, det, score,
      snrRaw: DSP.snrDb(rawEnv, segs), snrClean: DSP.snrDb(env, segs),
      specRaw: DSP.powerSpectrum(raw, fs, nfft), specClean: DSP.powerSpectrum(clean, fs, nfft),
      duration: x.length / fs,
    };
    if (score && state.step >= 3) recordBest(score.f1);
  }

  function recordBest(f1) {
    const d = state.source && state.source.difficulty;
    if (!d) return;
    if (f1 > (state.best[d] || 0)) { state.best[d] = f1; store.set("best", state.best); }
  }

  // ======================================================== 5. plotting
  function fitCanvas(canvas, cssHeight) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(200, canvas.clientWidth || canvas.parentElement.clientWidth || 300);
    canvas.style.height = cssHeight + "px";
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(cssHeight * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, cssHeight);
    return { ctx, w, h: cssHeight };
  }

  function niceTimeStep(duration) {
    for (const s of [0.5, 1, 2, 5, 10, 20, 30, 60, 120]) if (duration / s <= 10) return s;
    return 300;
  }

  /* spec: { height, label, series:[{data,color,width,alpha}], mode:"sym"|"pos",
   *         regions:[[a,b]], hline:{y,label}, truth:[[a,b]], playhead:seconds|null } */
  function plotTime(canvas, spec) {
    const { ctx, w, h } = fitCanvas(canvas, spec.height);
    const fs = state.source.fs, n = state.source.x.length, dur = n / fs;
    const L = 40, R = 8, T = 8, B = 22, pw = w - L - R, ph = h - T - B;
    let ymax = 1e-9;
    for (const s of spec.series) for (let i = 0; i < s.data.length; i++) { const v = Math.abs(s.data[i]); if (v > ymax) ymax = v; }
    if (spec.hline) ymax = Math.max(ymax, spec.hline.y * 1.1);
    ymax *= 1.08;
    const yOf = (v) => (spec.mode === "pos" ? T + ph - (v / ymax) * ph : T + ph / 2 - (v / ymax) * (ph / 2));
    const xOf = (t) => L + (t / dur) * pw;

    // frame and time axis
    ctx.strokeStyle = css("--line"); ctx.fillStyle = css("--muted"); ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "center";
    const ts = niceTimeStep(dur);
    for (let t = 0; t <= dur + 1e-9; t += ts) {
      const px = Math.round(xOf(t)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke();
      ctx.fillText(t % 1 === 0 ? t + " s" : t.toFixed(1) + " s", px, h - 6);
    }
    ctx.beginPath(); ctx.moveTo(L, yOf(0) + 0.5); ctx.lineTo(L + pw, yOf(0) + 0.5); ctx.stroke();
    ctx.textAlign = "left";
    ctx.fillText(spec.label, L + 6, T + 12);

    // detected regions behind the traces
    if (spec.regions) {
      ctx.fillStyle = css("--accent"); ctx.globalAlpha = 0.2;
      for (const [a, b] of spec.regions) ctx.fillRect(xOf(a / fs), T, Math.max(2, xOf((b + 1) / fs) - xOf(a / fs)), ph);
      ctx.globalAlpha = 1;
    }

    // traces (min/max per pixel keeps narrow peaks visible)
    for (const s of spec.series) {
      ctx.strokeStyle = s.color; ctx.globalAlpha = s.alpha == null ? 1 : s.alpha; ctx.lineWidth = s.width || 1;
      const cols = DSP.decimate(s.data, Math.max(1, Math.floor(pw)));
      ctx.beginPath();
      if (s.width && s.width > 1.4) {
        // smooth curves: connect the midpoints
        cols.forEach((c, i) => { const y = yOf((c[0] + c[1]) / 2); if (i) ctx.lineTo(L + i, y); else ctx.moveTo(L, y); });
      } else {
        cols.forEach((c, i) => { ctx.moveTo(L + i + 0.5, yOf(c[0])); ctx.lineTo(L + i + 0.5, yOf(c[1]) - 0.5); });
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    }

    // threshold
    if (spec.hline) {
      ctx.strokeStyle = css("--amber"); ctx.lineWidth = 1.6; ctx.setLineDash([6, 4]);
      const y = yOf(spec.hline.y);
      ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(L + pw, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css("--amber"); ctx.textAlign = "right";
      ctx.fillText(spec.hline.label, L + pw - 4, y - 4); ctx.textAlign = "left";
    }

    // true contractions (simulated data only) as a strip along the bottom
    if (spec.truth && spec.truth.length) {
      ctx.fillStyle = css("--truth");
      for (const [a, b] of spec.truth) ctx.fillRect(xOf(a / fs), T + ph - 5, Math.max(2, xOf((b + 1) / fs) - xOf(a / fs)), 5);
      ctx.fillStyle = css("--muted"); ctx.textAlign = "left";
      ctx.fillText("black bars = real contractions", L + 6, T + 27);
    }

    if (spec.playhead != null) {
      ctx.strokeStyle = css("--text"); ctx.lineWidth = 1.5;
      const px = xOf(spec.playhead);
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke();
    }
  }

  function plotSpectrum(canvas, withClean) {
    const { ctx, w, h } = fitCanvas(canvas, 160);
    const o = state.out, fs = state.source.fs;
    const L = 40, R = 8, T = 8, B = 22, pw = w - L - R, ph = h - T - B;
    const fmax = fs / 2;
    let ref = 0;
    for (let k = 1; k < o.specRaw.psd.length; k++) ref = Math.max(ref, o.specRaw.psd[k]);
    const dB = (v) => Math.max(-70, 10 * Math.log10((v + 1e-20) / ref));
    const xOf = (f) => L + (f / fmax) * pw, yOf = (d) => T + (-d / 70) * ph;

    ctx.strokeStyle = css("--line"); ctx.fillStyle = css("--muted"); ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif"; ctx.textAlign = "center";
    const fstep = fmax > 400 ? 100 : 50;
    for (let f = 0; f <= fmax; f += fstep) {
      const px = Math.round(xOf(f)) + 0.5;
      ctx.beginPath(); ctx.moveTo(px, T); ctx.lineTo(px, T + ph); ctx.stroke();
      ctx.fillText(f + " Hz", px, h - 6);
    }
    ctx.textAlign = "left";
    ctx.fillText("Power spectrum (dB, 0 = strongest raw peak)", L + 6, T + 12);

    if (withClean) { // shade the band that the band-pass keeps
      ctx.fillStyle = css("--accent"); ctx.globalAlpha = 0.1;
      ctx.fillRect(xOf(o.hpHz), T, xOf(o.lpHz) - xOf(o.hpHz), ph); ctx.globalAlpha = 1;
    }
    const hum = state.p.notchHz;
    if (hum < fmax) {
      ctx.strokeStyle = css("--amber"); ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(xOf(hum), T); ctx.lineTo(xOf(hum), T + ph); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = css("--amber"); ctx.fillText(hum + " Hz hum", xOf(hum) + 4, T + ph - 6);
    }
    const draw = (spec, color, width, alpha) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.globalAlpha = alpha; ctx.beginPath();
      for (let k = 0; k < spec.psd.length; k++) {
        const px = xOf(spec.freqs[k]), py = yOf(dB(spec.psd[k]));
        if (k) ctx.lineTo(px, py); else ctx.moveTo(px, py);
      }
      ctx.stroke(); ctx.globalAlpha = 1;
    };
    draw(o.specRaw, css("--sig-raw"), withClean ? 1.2 : 2, withClean ? 0.7 : 1);
    if (withClean) draw(o.specClean, css("--sig-clean"), 2, 1);
  }

  // Rounded rectangle path. ctx.roundRect is missing in older browsers (Safari < 16), so draw it by hand.
  function rrect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawGripper() {
    const canvas = $("#gripper");
    const { ctx, w, h } = fitCanvas(canvas, 130);
    const cy = h / 2, palmX = Math.max(20, w / 2 - 150), g = state.grip;
    const bg = css("--surface"), ink = css("--text"), acc = css("--accent");
    ctx.fillStyle = css("--muted"); ctx.font = "12px system-ui, sans-serif"; ctx.textAlign = "left";
    ctx.fillText("t = " + state.play.t.toFixed(1) + " s", 8, 16);
    ctx.textAlign = "right"; ctx.fillStyle = g > 0.5 ? acc : css("--muted");
    ctx.font = "700 13px system-ui, sans-serif";
    ctx.fillText(g > 0.5 ? "CLOSED" : "OPEN", w - 10, 16);

    ctx.fillStyle = css("--sig-rect"); // object being held
    ctx.beginPath(); ctx.arc(palmX + 150, cy, 17, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = ink; rrect(ctx, palmX - 14, cy - 34, 34, 68, 8); ctx.fill();
    const angle = 0.55 * (1 - g);
    for (const dir of [-1, 1]) {
      ctx.save();
      ctx.translate(palmX + 18, cy + dir * 15);
      ctx.rotate(dir * angle);
      ctx.fillStyle = acc;
      rrect(ctx, 0, -6, 128, 12, 6); ctx.fill();
      ctx.strokeStyle = bg; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.restore();
    }
  }

  // ======================================================== 6. Signal Lab UI
  // Marks which source button is active (a difficulty, a preset, or neither for an upload).
  function markSource(difficulty, preset) {
    $$(".seg-b").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.diff === difficulty)));
    $$("[data-preset]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.preset === preset)));
  }

  function setSimulated(difficulty) {
    const sim = DSP.simulateEMG({ difficulty });
    state.source = { kind: "sim", difficulty, preset: null, x: sim.x, fs: sim.fs, truth: sim.truth, label: "Simulated muscle signal (" + difficulty + ")" };
    markSource(difficulty, null);
    $("#fsRow").hidden = true; $("#srcError").hidden = true;
    stopPlay(true);
    refresh();
  }

  // One-click example signals (definitions live in dsp.js: DSP.PRESETS).
  function setPreset(id) {
    const pr = DSP.PRESETS[id];
    if (!pr) return;
    const sim = DSP.simulateEMG({ difficulty: pr.difficulty, seconds: pr.seconds, seed: pr.seed, plan: pr.plan, bump: pr.bump });
    state.source = { kind: "sim", difficulty: null, preset: id, x: sim.x, fs: sim.fs, truth: sim.truth, label: pr.label, blurb: pr.blurb };
    markSource(null, id);
    $("#fsRow").hidden = true; $("#srcError").hidden = true;
    stopPlay(true);
    refresh();
  }

  async function loadFile(file) {
    const err = $("#srcError");
    err.hidden = true;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error("That file is over 20 MB. Please trim it to a few seconds to a few minutes of data.");
      const parsed = DSP.parseCSV(await file.text());
      let x = parsed.x;
      const MAX = 200000;
      let note = "";
      if (x.length > MAX) { x = x.slice(0, MAX); note = " (trimmed to the first " + MAX.toLocaleString() + " samples)"; }
      if (parsed.columns > 2) note += " (using column 2 of " + parsed.columns + ")";
      if (parsed.skipped > 1) note += " (skipped " + parsed.skipped + " non-numeric rows)";
      const fs = parsed.fs || Number($("#fsInput").value) || 1000;
      if (!(fs >= 100 && fs <= 20000)) throw new Error("Sample rate must be between 100 and 20000 Hz.");
      $("#fsInput").value = fs;
      state.source = { kind: "upload", difficulty: null, preset: null, x, fs, truth: null, label: "Your file: " + file.name + note };
      markSource(null, null);
      $("#fsRow").hidden = false;
      stopPlay(true);
      refresh();
    } catch (e) {
      err.textContent = e.message; err.hidden = false;
    }
  }

  function applySampleRate() {
    const s = state.source;
    const fs = Number($("#fsInput").value);
    if (!s || s.kind !== "upload") return;
    if (!(fs >= 100 && fs <= 20000)) { $("#srcError").textContent = "Sample rate must be between 100 and 20000 Hz."; $("#srcError").hidden = false; return; }
    $("#srcError").hidden = true;
    s.fs = fs;
    refresh();
  }

  function sourceInfo() {
    const s = state.source;
    const dur = s.x.length / s.fs;
    if (s.kind === "sim") {
      if (s.preset) return "Simulated, not a real recording: <strong>" + esc(s.label) + "</strong>. " + esc(s.blurb) + " (" + dur.toFixed(0) + " s at " + s.fs + " Hz.)";
      return "Simulated, not a real recording: " + s.truth.length + " contractions with realistic problems (power-line hum, slow drift" +
        (s.difficulty === "easy" ? "" : ", cable bumps") + "). " + dur.toFixed(0) + " s at " + s.fs + " Hz.";
    }
    return esc(s.label) + " · " + s.x.length.toLocaleString() + " samples · " + s.fs + " Hz · " + dur.toFixed(1) + " s. No ground truth, so judge detections by eye.";
  }

  // Dragging a slider fires many events per frame; do the heavy work at most once per frame.
  let refreshQueued = false;
  function scheduleRefresh() {
    if (refreshQueued) return;
    refreshQueued = true;
    requestAnimationFrame(() => { refreshQueued = false; refresh(); });
  }

  function refresh() {
    compute();
    $("#srcInfo").innerHTML = sourceInfo();
    renderStep();
  }

  function buildStepNav() {
    const ol = $("#steps");
    ol.innerHTML = "";
    STEPS.forEach((st, i) => {
      const li = document.createElement("li");
      li.innerHTML = '<button type="button" class="step-b"><span class="n">Step ' + (i + 1) + '</span><span class="t">' + esc(st.short) + "</span></button>";
      li.firstChild.addEventListener("click", () => goStep(i));
      ol.appendChild(li);
    });
  }

  function goStep(i) {
    state.step = Math.max(0, Math.min(STEPS.length - 1, i));
    if (state.step !== 4) stopPlay(false);
    state.visited[state.step] = true;
    refresh();
  }

  function renderStep() {
    const i = state.step, st = STEPS[i], src = state.source;
    $$(".step-b").forEach((b, j) => {
      b.setAttribute("aria-current", j === i ? "step" : "false");
      b.classList.toggle("done", !!state.quiz[j]);
    });
    $("#stepKicker").textContent = "Step " + (i + 1) + " of " + STEPS.length;
    $("#stepTitle").textContent = st.title;
    $("#stepText").textContent = st.text;
    $("#stepTry").textContent = st.tryIt(src);
    $$(".controls").forEach((c) => (c.hidden = Number(c.dataset.step) !== i));

    // slider read-outs
    const p = state.p, o = state.out;
    $("#hp").value = p.hp; $("#hpOut").textContent = Math.round(o.hpHz) + " Hz";
    $("#lp").value = p.lp; $("#lpOut").textContent = Math.round(o.lpHz) + " Hz";
    $("#notch").checked = p.notch; $("#notchHz").value = String(p.notchHz);
    $("#envHz").value = p.envHz; $("#envHzOut").textContent = p.envHz + " Hz";
    $("#k").value = p.k; $("#kOut").textContent = "rest + " + p.k + "× spread";
    $("#minMs").value = p.minMs; $("#minMsOut").textContent = p.minMs + " ms";

    // which plots are visible
    $("#wrapB").hidden = !(i === 1 || i === 2);
    $("#wrapS").hidden = !(i === 0 || i === 1);
    $("#wrapG").hidden = i !== 4;
    $("#prev").disabled = i === 0;
    $("#next").textContent = i === STEPS.length - 1 ? "Find a lab →" : "Next →";

    renderQuiz();
    renderResults();
    renderBridge();
    renderStatus();
    drawPlots();
    renderProgress();
  }

  function drawPlots() {
    const i = state.step, o = state.out, x = o.raw;
    const col = { raw: css("--sig-raw"), clean: css("--sig-clean"), env: css("--sig-env"), rect: css("--sig-rect") };
    const two = i === 1 || i === 2;
    const H = two ? 170 : i === 4 ? 230 : 240;
    const truth = state.source.truth;
    if (i === 0) plotTime($("#plotA"), { height: H, label: "Raw EMG (constant offset removed)", mode: "sym", series: [{ data: x, color: col.raw }] });
    if (i === 1) {
      plotTime($("#plotA"), { height: H, label: "Raw EMG (constant offset removed)", mode: "sym", series: [{ data: x, color: col.raw }] });
      plotTime($("#plotB"), { height: H, label: "Cleaned (band-pass" + (state.p.notch ? " + notch" : "") + ")", mode: "sym", series: [{ data: o.clean, color: col.clean }] });
    }
    if (i === 2) {
      plotTime($("#plotA"), { height: H, label: "Cleaned EMG", mode: "sym", series: [{ data: o.clean, color: col.clean }] });
      plotTime($("#plotB"), { height: H, label: "Rectified (faint) and envelope", mode: "pos", series: [{ data: o.rect, color: col.rect, alpha: 0.6 }, { data: o.env, color: col.env, width: 2.4 }] });
    }
    if (i >= 3) {
      plotTime($("#plotA"), {
        height: H, label: "Envelope, threshold and detections", mode: "pos",
        series: [{ data: o.env, color: col.env, width: 2.2 }],
        hline: { y: o.thr, label: "threshold" }, regions: o.det,
        truth: i === 3 ? truth : null, playhead: i === 4 ? state.play.t : null,
      });
    }
    if (i <= 1) plotSpectrum($("#plotS"), i === 1);
    if (i === 4) drawGripper();
    const a = $("#plotA");
    a.setAttribute("aria-label", "Signal plot for step " + (i + 1) + ": " + STEPS[i].short + ". " + o.det.length + " contractions currently detected.");
  }

  function stat(label, value, cls) {
    return '<div class="stat ' + (cls || "") + '"><b>' + esc(value) + "</b><span>" + esc(label) + "</span></div>";
  }

  function renderResults() {
    const i = state.step, o = state.out, s = state.source, el = $("#results");
    let html = "";
    if (i === 0) {
      let lo = Infinity, hi = -Infinity;
      for (let k = 0; k < o.raw.length; k++) { if (o.raw[k] < lo) lo = o.raw[k]; if (o.raw[k] > hi) hi = o.raw[k]; }
      html = '<div class="stat-grid">' + stat("seconds", fmt(o.duration, 1)) + stat("samples/sec", s.fs) + stat("peak-to-peak", fmt(hi - lo, 2)) + "</div>";
    } else if (i === 1) {
      const gain = o.snrRaw != null && o.snrClean != null ? o.snrClean - o.snrRaw : null;
      html = '<div class="stat-grid">' + stat("raw quality (dB)", fmt(o.snrRaw)) + stat("cleaned (dB)", fmt(o.snrClean), gain != null && gain > 0 ? "good" : "") + stat("gain (dB)", gain == null ? "n/a" : (gain >= 0 ? "+" : "") + fmt(gain), gain != null && gain > 0 ? "good" : "bad") + "</div>" +
        '<p class="muted">Quality = how much stronger the envelope is during contractions than at rest (' + (s.truth ? "using the real contraction times" : "using your current detections") + "). Higher is better.</p>";
    } else if (i === 2) {
      const ms = Math.round(1000 / state.p.envHz);
      html = '<div class="msg">Smoothing at ' + state.p.envHz + " Hz averages over roughly the last " + ms + " ms. Lower cutoffs give a calmer curve but blur short contractions together.</div>";
    } else {
      html = detectionSummary(i);
    }
    el.innerHTML = html;
  }

  function detectionSummary(i) {
    const o = state.out, s = state.source, sc = o.score;
    if (!sc) {
      const list = o.det.slice(0, 6).map((d) => (d[0] / s.fs).toFixed(1) + "-" + ((d[1] + 1) / s.fs).toFixed(1) + " s").join(", ");
      return '<div class="stat-grid">' + stat("contractions found", o.det.length) + stat("threshold", fmt(o.thr, 3)) + stat("seconds", fmt(o.duration, 1)) + "</div>" +
        (list ? '<p class="muted">At: ' + esc(list) + (o.det.length > 6 ? ", ..." : "") + "</p>" : '<div class="msg">Nothing detected. Try lowering the threshold or smoothing less.</div>');
    }
    const total = s.truth.length, pct = Math.round(sc.f1 * 100);
    let msg, cls = "";
    if (total === 0) {
      if (sc.fp === 0) { msg = "Perfect: the muscle is at rest and nothing was detected."; cls = "win"; }
      else msg = sc.fp + " false alarm" + (sc.fp > 1 ? "s" : "") + " on a resting muscle. The threshold is too sensitive (or the smoothing too light), so noise is being mistaken for muscle. Raise the threshold.";
    } else if (sc.f1 === 1) { msg = "Perfect: all " + total + " contractions found with no false alarms." + (s.difficulty ? " Now try a harder difficulty." : " Now change a setting and see what breaks."); cls = "win"; }
    else if (sc.fn > 0 && sc.fp === 0) msg = "You missed " + sc.fn + ". A weak contraction may sit below your line. Try a lower threshold or less smoothing.";
    else if (sc.fp > 0 && sc.fn === 0) msg = "Everything real was found, but " + sc.fp + " false alarm" + (sc.fp > 1 ? "s" : "") + ". Raise the threshold or ignore longer blips. Check the filters too.";
    else msg = "Both misses and false alarms. Go back to step 2: a cleaner signal makes the threshold much easier to place.";
    const best = s.difficulty && state.best[s.difficulty] != null ? " Best on " + s.difficulty + ": " + Math.round(state.best[s.difficulty] * 100) + "%." : "";
    return '<div class="stat-grid">' + stat("hits", total ? sc.tp + " of " + total : "none expected", sc.tp === total ? "good" : "") + stat("false alarms", sc.fp, sc.fp ? "bad" : "good") + stat("missed", sc.fn, sc.fn ? "bad" : "good") + "</div>" +
      '<div class="msg ' + cls + '"><strong>Score ' + pct + "%.</strong> " + esc(msg) + esc(best) + "</div>";
  }

  function renderQuiz() {
    const q = STEPS[state.step].quiz;
    $("#quizQ").textContent = q.q;
    const box = $("#quizOpts");
    box.innerHTML = "";
    const done = !!state.quiz[state.step];
    q.opts.forEach((text, idx) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "opt"; b.textContent = text;
      if (done && idx === q.answer) b.classList.add("right");
      b.addEventListener("click", () => {
        const ok = idx === q.answer;
        $$(".opt", box).forEach((x) => x.classList.remove("right", "wrong"));
        b.classList.add(ok ? "right" : "wrong");
        $("#quizFb").textContent = ok ? "Correct. " + q.why : "Not quite. Think about what the signal looks like, then try again.";
        if (ok) { state.quiz[state.step] = true; store.set("quiz", state.quiz); $$(".step-b")[state.step].classList.add("done"); renderProgress(); }
      });
      box.appendChild(b);
    });
    $("#quizFb").textContent = done ? "Answered correctly. " + q.why : "";
  }

  function renderProgress() {
    const n = Object.keys(state.quiz).filter((k) => state.quiz[k]).length;
    const names = { easy: "Easy", medium: "Medium", hard: "Hard" };
    const bests = Object.keys(names).map((d) => names[d] + " " + (state.best[d] != null ? Math.round(state.best[d] * 100) + "%" : "—")).join(" · ");
    $("#progressText").textContent = "Checks passed: " + n + " of " + STEPS.length + "  ·  Best challenge scores: " + bests;
  }

  function downloadReport() {
    const s = state.source, o = state.out, p = state.p;
    const lines = [
      "# NeuroPath EMG results", "",
      "Date: " + new Date().toLocaleString(),
      "Source: " + (s.kind === "sim" ? "simulated (" + (s.preset ? s.label : s.difficulty) + ")" : s.label),
      "Sample rate: " + s.fs + " Hz, duration " + o.duration.toFixed(1) + " s", "",
      "## My pipeline",
      "- Band-pass: " + Math.round(o.hpHz) + "-" + Math.round(o.lpHz) + " Hz (4th-order Butterworth, zero-phase)",
      "- Notch: " + (p.notch ? p.notchHz + " Hz" : "off"),
      "- Envelope: rectify + low-pass at " + p.envHz + " Hz",
      "- Threshold: rest level + " + p.k + " x spread (" + o.thr.toFixed(3) + "), ignore blips under " + p.minMs + " ms", "",
      "## Results",
      "- Contractions detected: " + o.det.length,
      "- Signal quality: " + fmt(o.snrRaw) + " dB raw -> " + fmt(o.snrClean) + " dB cleaned",
    ];
    if (o.score) lines.push("- Hits " + o.score.tp + " of " + s.truth.length + ", false alarms " + o.score.fp + ", missed " + o.score.fn + ", score " + Math.round(o.score.f1 * 100) + "%");
    lines.push("- Checks passed: " + Object.keys(state.quiz).length + " of " + STEPS.length, "", "_Generated by NeuroPath. Simulated data is not a real recording._", "");
    const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "neuropath-results.md";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function bindControls() {
    const num = (id, key, isFloat) => $(id).addEventListener("input", (e) => { state.p[key] = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value, 10); scheduleRefresh(); });
    num("#hp", "hp"); num("#lp", "lp"); num("#envHz", "envHz"); num("#k", "k", true); num("#minMs", "minMs");
    $("#notch").addEventListener("change", (e) => { state.p.notch = e.target.checked; refresh(); });
    $("#notchHz").addEventListener("change", (e) => { state.p.notchHz = parseInt(e.target.value, 10); refresh(); });
    $$(".seg-b").forEach((b) => b.addEventListener("click", () => setSimulated(b.dataset.diff)));
    $$("[data-preset]").forEach((b) => b.addEventListener("click", () => setPreset(b.dataset.preset)));
    $("#soundBtn").addEventListener("click", toggleSound);
    $("#file").addEventListener("change", (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ""; });
    $("#fsApply").addEventListener("click", applySampleRate);
    $("#prev").addEventListener("click", () => goStep(state.step - 1));
    $("#next").addEventListener("click", () => { if (state.step === STEPS.length - 1) showTab("find"); else goStep(state.step + 1); });
    $("#download").addEventListener("click", downloadReport);
    $("#play").addEventListener("click", () => (state.play.on ? stopPlay(false) : startPlay()));
    $("#speed").addEventListener("change", (e) => { state.play.speed = parseFloat(e.target.value); });
    let t = null;
    const redraw = () => { clearTimeout(t); t = setTimeout(() => { if (state.out && !$("#view-lab").hidden) drawPlots(); }, 80); };
    window.addEventListener("resize", redraw);
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      (mq.addEventListener ? mq.addEventListener.bind(mq, "change") : mq.addListener.bind(mq))(redraw);
    }
  }

  // ======================================================== 6b. live status, sound, bridge to labs
  // Badges show real computed values (signal quality in dB, detection count, gripper state). Text and
  // symbols carry the meaning, not color alone. The DOM is only touched when a badge actually changes.
  const lastBadge = {};
  function setBadge(sel, text, tone) {
    const key = text + "|" + tone;
    if (lastBadge[sel] === key) return;
    lastBadge[sel] = key;
    const el = $(sel);
    el.textContent = text;
    el.className = "badge-s " + tone;
  }

  function renderStatus() {
    const o = state.out;
    if (!o) return;
    const q = o.snrClean;
    if (q == null) setBadge("#stQuality", "\u25cb Signal quality: n/a (needs contractions to compare)", "");
    else if (q >= 10) setBadge("#stQuality", "\u2713 Signal clean (" + q.toFixed(1) + " dB)", "ok");
    else if (q >= 5) setBadge("#stQuality", "! Signal noisy (" + q.toFixed(1) + " dB)", "warn");
    else setBadge("#stQuality", "\u2715 Signal very noisy (" + q.toFixed(1) + " dB)", "bad");
    setBadge("#stDetect", "\u25b2 " + o.det.length + " contraction" + (o.det.length === 1 ? "" : "s") + " detected", o.det.length ? "ok" : "");
    const idle = !state.play.on && state.play.t === 0;
    if (idle) setBadge("#stGrip", "\u25cb Gripper idle (press Play in step 5)", "");
    else if (state.grip > 0.5) setBadge("#stGrip", "\u25cf Threshold exceeded: gripper closed", "ok");
    else setBadge("#stGrip", "\u25cb Below threshold: gripper open", "");
  }

  const sound = { on: false, ctx: null, lastClosed: false };
  function beep(freq) {
    if (!sound.on) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!sound.ctx) sound.ctx = new AC();
      if (sound.ctx.state === "suspended") sound.ctx.resume();
      const t = sound.ctx.currentTime, osc = sound.ctx.createOscillator(), gain = sound.ctx.createGain();
      osc.type = "sine"; osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
      osc.connect(gain); gain.connect(sound.ctx.destination);
      osc.start(t); osc.stop(t + 0.13);
    } catch (e) { /* audio unavailable: the visual badges still work */ }
  }

  function toggleSound() {
    sound.on = !sound.on;
    $("#soundBtn").setAttribute("aria-pressed", String(sound.on));
    $("#soundBtn").textContent = "Sound: " + (sound.on ? "on" : "off");
    beep(520); // confirmation tone; also satisfies browsers that need a click before audio
  }

  // Top lab matches for "someone who just worked with EMG". Hard grade filters are skipped here (senior = all labs).
  function bridgeLabs() {
    return LABS.rankLabs(window.NP_LABS || [], { grade: "senior", interests: BRIDGE.interests, skills: BRIDGE.skills, mode: "any" })
      .filter((r) => r.score > 0).slice(0, 2);
  }
  const BRIDGE = { interests: "EMG, signal processing, prosthetics, motor control", skills: "signal processing, EMG" };

  function renderBridge() {
    const el = $("#bridge"), i = state.step, o = state.out;
    const achieved = o.score ? o.score.f1 === 1 : o.det.length > 0;
    const show = i === 4 || (i === 3 && achieved);
    el.hidden = !show;
    if (!show) return;
    const top = bridgeLabs();
    el.innerHTML = '<p class="eyebrow">Next step</p><h3>You just processed an EMG signal. Who works with signals like this?</h3>' +
      (top.length ? '<ul class="bridge-list">' + top.map((r) => "<li><strong>" + esc(r.lab.lab) + "</strong>" + (r.lab.demo ? '<span class="badge">Demo</span>' : "") +
        '<br><span class="muted">' + esc(r.lab.institution) + " · topics: " + esc((r.lab.tags || []).slice(0, 4).join(", ")) + "</span></li>").join("") + "</ul>" : "") +
      '<p class="muted">The directory shows demo entries until real labs opt in.</p>' +
      '<button type="button" class="btn small" id="bridgeGo">See labs that fit this \u2192</button>';
    $("#bridgeGo").addEventListener("click", goToLabsFromLab);
  }

  function goToLabsFromLab() {
    if (!$("#fInterests").value.trim()) $("#fInterests").value = BRIDGE.interests;
    if (!$("#fSkills").value.trim()) $("#fSkills").value = BRIDGE.skills;
    showTab("find");
    $("#findForm").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
  }

  // One honest sentence describing what the student actually did. Self-reported, never a certification.
  function practiceSummary() {
    const o = state.out, s = state.source, p = state.p;
    if (!o) return "";
    const pipeline = "a " + Math.round(o.hpHz) + "\u2013" + Math.round(o.lpHz) + " Hz band-pass" + (p.notch ? ", a " + p.notchHz + " Hz notch" : "") +
      ", a " + p.envHz + " Hz envelope and a threshold";
    if (s.kind === "sim" && o.score) {
      const total = s.truth.length;
      const result = total === 0
        ? (o.score.fp === 0 ? "correctly detected nothing in a resting-muscle recording" : "falsely detected " + o.score.fp + " contraction" + (o.score.fp === 1 ? "" : "s") + " in a resting-muscle recording")
        : "detected " + o.score.tp + " of " + total + " true contractions with " + o.score.fp + " false alarm" + (o.score.fp === 1 ? "" : "s");
      return "On a simulated EMG signal I applied " + pipeline + ", and " + result + ".";
    }
    return "On an EMG recording I uploaded (" + o.duration.toFixed(0) + " s) I applied " + pipeline + ", and it detected " + o.det.length + " contraction" + (o.det.length === 1 ? "" : "s") + ".";
  }

  // ======================================================== 7. gripper playback
  function inDetection(sampleIdx) {
    for (const [a, b] of state.out.det) if (sampleIdx >= a && sampleIdx <= b) return true;
    return false;
  }

  function startPlay() {
    if (state.play.t >= state.out.duration - 0.05) state.play.t = 0;
    state.play.on = true; state.play.last = performance.now();
    $("#play").textContent = "Pause";
    requestAnimationFrame(tick);
  }

  function stopPlay(reset) {
    state.play.on = false;
    if (reset) { state.play.t = 0; state.grip = 0; sound.lastClosed = false; }
    const b = $("#play");
    const finished = state.out && state.play.t > 0 && state.play.t >= state.out.duration - 0.05;
    if (b) b.textContent = finished ? "Replay" : state.play.t > 0 ? "Resume" : "Play";
  }

  function tick(now) {
    if (!state.play.on) return;
    const dt = Math.min(0.1, (now - state.play.last) / 1000);
    state.play.last = now;
    state.play.t += dt * state.play.speed;
    const dur = state.out.duration;
    if (state.play.t >= dur) { state.play.t = dur; state.play.on = false; $("#play").textContent = "Replay"; }
    const idx = Math.min(state.source.x.length - 1, Math.floor(state.play.t * state.source.fs));
    const target = inDetection(idx) ? 1 : 0;
    state.grip += (target - state.grip) * Math.min(1, dt * 14);
    const closed = state.grip > 0.5;
    if (closed !== sound.lastClosed) { sound.lastClosed = closed; beep(closed ? 660 : 330); }
    renderStatus();
    if (state.step === 4) { drawPlots(); }
    if (state.play.on) requestAnimationFrame(tick);
  }

  // ======================================================== 8. Find-a-lab UI
  function renderResources() {
    $("#resources").innerHTML = (window.NP_RESOURCES || []).map((r) =>
      '<li><a href="' + esc(r.url) + '" target="_blank" rel="noopener noreferrer">' + esc(r.name) + "</a>: " + esc(r.note) + "</li>").join("");
    const form = CFG.optInFormUrl, mail = CFG.optInEmail;
    const t = $("#optInText");
    if (form) t.innerHTML = 'Want to hear from prepared students on your terms, with a cap you control? <a href="' + esc(form) + '" target="_blank" rel="noopener noreferrer">Opt in here</a>.';
    else if (mail) t.innerHTML = 'Want to hear from prepared students on your terms, with a cap you control? <a href="mailto:' + esc(mail) + '">Email us to opt in</a>.';
    else t.textContent = "Lab opt-in opens soon. Labs will choose whether to be listed and how many student emails they receive each month.";
  }

  function student() {
    return {
      name: $("#fName").value.trim(), grade: $("#fGrade").value, school: $("#fSchool").value.trim(),
      interests: $("#fInterests").value, skills: $("#fSkills").value, mode: $("#fMode").value, project: $("#fProject").value.trim(),
    };
  }

  function findLabs(ev) {
    ev.preventDefault();
    const err = $("#findError"), out = $("#labResults");
    err.hidden = true;
    const st = student();
    if (!st.interests.trim() && !st.skills.trim()) { err.textContent = "Add at least one interest or skill."; err.hidden = false; return; }
    if (st.project && !/^https?:\/\//i.test(st.project)) { err.textContent = "The project link must start with http:// or https://"; err.hidden = false; return; }
    const ranked = LABS.rankLabs(window.NP_LABS || [], st);
    if (!ranked.length) { out.innerHTML = '<div class="card"><p>No labs match those filters. Try a different format, or use the no-lab path below.</p></div>'; return; }
    out.innerHTML = '<p class="muted">' + ranked.length + " lab" + (ranked.length === 1 ? "" : "s") + ", best match first.</p>" + ranked.map((r, i) => labCard(r, i)).join("");
    ranked.forEach((r, i) => bindLabCard(r, i, st));
  }

  function labCard(r, i) {
    const l = r.lab;
    const why = r.shared.length ? "your terms found in their work: <strong>" + r.shared.map(esc).join(", ") + "</strong>" : "no exact overlap with your terms (shown because it passed your filters)";
    const tags = (l.tags || []).length ? "<br><strong>Topics:</strong> " + l.tags.map(esc).join(", ") : "";
    let action;
    if (l.demo) action = '<p class="muted"><strong>Demo entry.</strong> This lab is not real, so no email is generated.</p>';
    else if (!l.contact) action = '<p class="muted">This lab has not provided a contact address yet.</p>';
    else action =
      '<div class="draft"><label for="q' + i + '"><strong>Your question about their paper</strong> (your own words, ' + LABS.MIN_QUESTION_WORDS + '+ words)</label>' +
      '<textarea id="q' + i + '" rows="3"></textarea><p class="muted" id="qc' + i + '">0 / ' + LABS.MIN_QUESTION_WORDS + " words</p>" +
      '<label for="of' + i + '"><strong>Optional: one task you could take on</strong> (e.g. cleaning data, formatting figures, literature searches)</label>' +
      '<input id="of' + i + '" type="text" maxlength="140" placeholder="e.g. cleaning and plotting a small dataset in Python">' +
      '<label class="check small"><input type="checkbox" id="pr' + i + '"> Add one sentence about my NeuroPath practice (self-reported, not a certification)</label>' +
      '<button type="button" class="btn small" id="b' + i + '">Build draft</button>' +
      '<p class="error" id="e' + i + '" role="alert" hidden></p><div id="d' + i + '" hidden></div></div>';
    return '<article class="lab"><h3>' + esc(l.pi) + (l.demo ? '<span class="badge">Demo</span>' : "") + "</h3>" +
      '<p class="meta">' + esc(l.lab) + " · " + esc(l.institution) + " (" + esc(l.state) + ") · " + esc(l.department) + " · " + esc(l.format) + " · grade " + esc(l.minGrade) + "+ " +
      '<span class="match">match ' + Math.round(r.score * 100) + "</span></p>" +
      "<p>" + esc(l.summary) + "</p>" +
      '<p class="muted"><strong>Paper:</strong> ' + esc(l.paper) + " (" + esc(l.paperYear) + ")" + tags + "<br><strong>Why it fits:</strong> " + why + "</p>" + action + "</article>";
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function bindLabCard(r, i) {
    const l = r.lab;
    if (l.demo || !l.contact) return;
    const q = $("#q" + i), count = $("#qc" + i), build = $("#b" + i), err = $("#e" + i), box = $("#d" + i);
    q.addEventListener("input", () => { count.textContent = LABS.wordCount(q.value) + " / " + LABS.MIN_QUESTION_WORDS + " words"; });
    build.addEventListener("click", () => {
      const st = student();
      const problem = LABS.validateEmailInputs(st, q.value);
      if (problem) { err.textContent = problem; err.hidden = false; box.hidden = true; return; }
      err.hidden = true;
      if ($("#pr" + i).checked) st.practice = practiceSummary();
      st.offer = $("#of" + i).value.trim();
      const mail = LABS.buildEmail(st, l, q.value);
      const hint = LABS.specificityHint(q.value, l);
      box.hidden = false;
      box.innerHTML = '<p><strong>To:</strong> ' + esc(l.contact) + "</p>" +
        (hint ? '<p class="hint" role="status"><strong>Make it more specific.</strong> ' + esc(hint) + "</p>" : "") +
        '<label for="s' + i + '">Subject</label><input id="s' + i + '" type="text">' +
        '<label for="m' + i + '">Body (edit it, then attach your CV)</label><textarea id="m' + i + '" rows="13"></textarea>' +
        '<fieldset class="checklist"><legend>Before you send</legend>' +
        LABS.OUTREACH_CHECKLIST.map((c, n) => '<label><input type="checkbox" class="ck' + i + '"> <span>' + esc(c) + "</span></label>").join("") +
        '<p class="muted" id="ck' + i + '">Tick all four to unlock copy, download and send.</p></fieldset>' +
        '<div class="row"><button type="button" class="btn small" id="c' + i + '" disabled>Copy</button>' +
        '<button type="button" class="btn small ghost" id="dl' + i + '" disabled>Download (.txt)</button>' +
        '<button type="button" class="btn small ghost" id="o' + i + '" disabled>Open in email app</button></div>' +
        '<div class="callout" id="sch' + i + '"><strong>Use Schedule send.</strong> Write now, but send at <strong>' + esc(LABS.nextSendWindow(new Date())) + "</strong> in the professor's time zone. " +
        'In Gmail click the arrow next to Send, then Schedule send. Outlook and Apple Mail have the same feature. "Open in email app" only fills in the draft, so schedule it there. One email per lab; if no reply, wait 5–7 business days, then reply once on the same thread.</div>' +
        '<div id="chk' + i + '" class="spamcheck" role="status" aria-live="polite"></div>';
      $("#s" + i).value = mail.subject; $("#m" + i).value = mail.body;
      const runChecks = () => {
        const notes = LABS.draftChecks($("#s" + i).value, $("#m" + i).value);
        $("#chk" + i).innerHTML = notes.length
          ? "<strong>Draft check:</strong><ul>" + notes.map((n) => "<li>" + esc(n) + "</li>").join("") + "</ul>"
          : "<strong>Draft check:</strong> no common spam patterns found. This is a rough check, not a guarantee of delivery.";
      };
      $("#s" + i).addEventListener("input", runChecks); $("#m" + i).addEventListener("input", runChecks); runChecks();

      const boxes = $$(".ck" + i), actions = [$("#c" + i), $("#dl" + i), $("#o" + i)];
      boxes.forEach((cb) => cb.addEventListener("change", () => {
        const all = boxes.every((x) => x.checked);
        actions.forEach((b) => (b.disabled = !all));
        $("#ck" + i).textContent = all ? "Unlocked. Review your draft one last time." : "Tick all four to unlock copy, download and send.";
      }));
      $("#c" + i).addEventListener("click", async () => {
        const text = "Subject: " + $("#s" + i).value + "\n\n" + $("#m" + i).value;
        try { await navigator.clipboard.writeText(text); $("#c" + i).textContent = "Copied"; }
        catch (e) { const m = $("#m" + i); m.focus(); m.select(); $("#c" + i).textContent = "Select and copy"; }
      });
      $("#dl" + i).addEventListener("click", () => {
        const slug = LABS.lastName(l.pi).toLowerCase().replace(/[^a-z0-9]+/g, "") || "lab";
        downloadText("inquiry-" + slug + ".txt", LABS.draftFileText(l, $("#s" + i).value, $("#m" + i).value));
      });
      $("#o" + i).addEventListener("click", () => {
        window.location.href = "mailto:" + encodeURIComponent(l.contact).replace("%40", "@") + "?subject=" + encodeURIComponent($("#s" + i).value) + "&body=" + encodeURIComponent($("#m" + i).value);
      });
    });
  }

  // ======================================================== 9. tabs and start-up
  const TABS = ["lab", "find", "about"];
  const ALIASES = { lab: "lab", signal: "lab", "signal-lab": "lab", find: "find", matcher: "find", labs: "find", directory: "find", about: "about" };
  // Turns any URL hash (even a garbage one) into a valid tab. Unknown hashes fall back to the Signal Lab.
  function tabFromHash(raw) {
    const key = String(raw || "").replace(/^#/, "").split(/[?\/&]/)[0].toLowerCase();
    return Object.prototype.hasOwnProperty.call(ALIASES, key) ? ALIASES[key] : "lab";
  }
  function showTab(name) {
    name = tabFromHash(name);
    TABS.forEach((t) => {
      const sel = t === name;
      const tab = $("#tab-" + t);
      tab.setAttribute("aria-selected", String(sel)); tab.tabIndex = sel ? 0 : -1;
      $("#view-" + t).hidden = !sel;
    });
    try { history.replaceState(null, "", "#" + name); } catch (e) { /* file:// in some browsers */ }
    if (name === "lab" && state.out) requestAnimationFrame(drawPlots);
    window.scrollTo(0, 0);
  }

  function bindTabs() {
    TABS.forEach((t, idx) => {
      const tab = $("#tab-" + t);
      tab.addEventListener("click", () => showTab(t));
      tab.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        const next = TABS[(idx + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
        showTab(next); $("#tab-" + next).focus();
      });
    });
    window.addEventListener("hashchange", () => showTab(location.hash.replace("#", "")));
  }

  function init() {
    buildStepNav();
    bindControls();
    bindTabs();
    renderResources();
    $("#findForm").addEventListener("submit", findLabs);
    const tn = $("#timingNow"); if (tn) { const t = LABS.academicTiming(new Date()); tn.textContent = t.note; tn.className = t.good ? "timing good" : "timing"; }
    // first plot needs the lab view visible so canvases have a width
    setSimulated("medium");
    goStep(0);
    if (location.hash) showTab(location.hash); // valid, aliased or invalid hashes are all handled by tabFromHash
  }

  // expose a tiny hook for automated tests
  window.__neuropath = { state, goStep, setSimulated, setPreset, showTab, tabFromHash, practiceSummary, compute, refresh };
  init();
})();
