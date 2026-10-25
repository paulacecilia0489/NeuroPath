# NeuroPath

Clean a noisy muscle (EMG) signal in five steps, find every real contraction, and drive a virtual gripper. Then match with research labs that welcome students. Runs entirely in the browser: no install, no account, no server, no data collected.

## What you need to download

| Need | Why | Required? |
|---|---|---|
| A code editor, e.g. **VS Code** (code.visualstudio.com) | To read and edit the files | Yes |
| **Chrome, Edge, Firefox or Safari** | To run the app | Yes (you have one) |
| A free **GitHub** account | To host it with a public link for judges | Yes, for submission |
| **Node.js** (nodejs.org, LTS) | Only to run `tests/unit.test.js` | Optional |
| **Python 3 + Playwright** | Only to run the browser test | Optional |

No frameworks, no `pip install`, no `npm install`. It is plain HTML, CSS and JavaScript.

## Run it (30 seconds)
1. Unzip the folder.
2. Double-click `index.html`. It opens in your browser.

That is the whole app. (If a browser blocks something on `file://`, run `python3 -m http.server 8000` inside the folder and open http://localhost:8000.)

## Put it online (free, gives judges a link)
**GitHub Pages**
1. Create a new public repository on github.com (e.g. `neuropath`).
2. Click *Add file > Upload files* and drag in everything inside the folder (`index.html`, `app.js`, `dsp.js`, `labs.js`, `labs-data.js`, `style.css`, `README.md`, `CODE_GUIDE.md`, and the `tests` folder). Commit.
3. *Settings > Pages > Build and deployment*: Source = **Deploy from a branch**, Branch = **main**, folder = **/(root)**. Save.
4. After about a minute your app is at `https://YOUR-USERNAME.github.io/neuropath/`. Open it on your phone to check.

The same repository is also your **source code** link for the challenge.

## Testing and validation
Four layers, all runnable on your own computer. Numbers below are from the packaged version.

```
node tests/unit.test.js               # 50 checks of the math, edge cases, CSV safety and outreach rules
python3 tests/validate_scipy.py       # cross-checks dsp.js against SciPy/NumPy (pip install numpy scipy)
python3 tests/browser_test.py         # clicks through the whole app in real Chromium (pip install playwright)
python3 tests/browser_features_test.py  # presets, badges, sound, lab bridge, checklist, downloads, routing, speed
```

**How the signal processing was validated.** Besides unit tests on known signals (a 100 Hz sine must pass, a 60 Hz sine must be removed, an FFT must find a 120 Hz tone), `validate_scipy.py` runs the same 6-second test signal through `dsp.js` and through SciPy/NumPy and compares:

| Stage | Difference from SciPy/NumPy |
|---|---|
| Band-pass 20-450 Hz (4th-order Butterworth, zero-phase) | 0.002 % relative RMS error |
| 60 Hz notch (zero-phase) | 0.11 % |
| Envelope low-pass 5 Hz | 0.09 % |
| Welch power spectrum | 0.03 dB maximum |

**Edge cases covered:** all-zero signal, constant (flat) signal, DC offsets from -4000 to 1,000,000, tiny (1e-6) and huge (1e6) amplitudes, out-of-range cutoffs (negative, zero, above Nyquist), NaN parameters (rejected with an error), empty and one-sample arrays, infinite thresholds, 100 Hz and 20 kHz sample rates, and malformed CSVs.

**Speed (headless Chromium, no GPU):** about 10-20 ms for a full recompute (varies by run) and redraw of the 12-second signal after a slider change (budget for 60 fps is 16.7 ms), and about 60 frames per second during gripper playback. Slider events are coalesced with `requestAnimationFrame`, so dragging never queues up work. Real phones and laptops will differ.

## Files
| File | What it does |
|---|---|
| `index.html` | Page structure |
| `style.css` | Look and layout, light and dark mode, phone layout |
| `dsp.js` | **Signal processing**: filters, FFT, envelope, detection, scoring, simulated muscle, CSV import |
| `labs.js` | Lab matching and the outreach-email rules |
| `labs-data.js` | The lab list (demo entries) and settings. **You edit this.** |
| `app.js` | Connects everything to the page: plots, sliders, challenge, gripper, quiz, lab finder |
| `tests/` | Unit tests, SciPy cross-check, two browser test suites |
| `CODE_GUIDE.md` | **Read this.** Explains the code so you can answer questions about it |

## Features at a glance
- **Signal Lab:** five-step EMG pipeline, scored challenge (Easy / Medium / Hard), three one-click example signals (resting muscle, moderate contraction, max flex with artifact noise), live status badges, optional sound (off by default), virtual gripper, upload your own CSV.
- **Find a lab:** matching on topics and skills, topic tags (EMG, EEG, signal processing...), a bridge from the Signal Lab to related labs, and a guided outreach draft: a question of your own, a specificity check, an optional self-reported practice sentence, a four-point checklist that unlocks copy / download / open-in-email, an optional "one task you could take on" line, a live draft check for spam-style patterns, and a **Schedule send** reminder with the next Tuesday-Thursday 8 AM slot.
- **Sending guide:** best days, hours and months (with a note for today's date), how to avoid the spam folder, and how to follow up on the same thread. These are common rules of thumb, and the page says so.
- **Routing:** `#lab`, `#find`, `#about` (plus aliases such as `#matcher`); any unknown hash falls back to the Signal Lab.

## Things to do before you submit
1. **Read `CODE_GUIDE.md` and make sure you can explain each part.** The contest allows AI-assisted code only if you understand it, and judges may ask.
2. **Read the official 2026 rulebook** for the AI-use policy, required video and written-answer formats, and the exact deadline (reported as Oct 26, 2026, 12:00 p.m. ET). Check your district is participating.
3. **Make it yours.** Rewrite the About text and the five quiz questions in your own words, and tune one thing yourself (e.g. add a lesson about EEG alpha waves).
4. **Test with your own sensor data if you have it.** A short CSV recorded from your own EMG project makes a far stronger demo than simulated data. Say clearly in your video which is which.
5. **Set the lab opt-in.** In `labs-data.js`, set `optInFormUrl` (e.g. a Google Form) or `optInEmail` when you are ready. Leave both empty until then.
6. **Do not add a real lab until it agrees.** The directory is demo-only on purpose, and the app says so. Never present demo entries or simulated signals as real data.
7. **Submit a day early.**

## Your own CSV: what is accepted
- One column of values, or `time,value` (seconds or milliseconds). Extra columns are ignored (column 2 is used).
- Header rows are skipped. Commas, semicolons or tabs can separate columns.
- **Refused with a clear message instead of guessed:** files with decimal commas (`0,5`), two columns where the first is not time, flat files, and files under 200 samples.
- Files over 200,000 samples are trimmed to the first 200,000.

## Known limits (be upfront about these)
- The simulated muscle is a model, not a recording. It includes realistic problems but is simpler than real EMG.
- The lab directory has no real labs yet, so "Find a lab" is a working prototype of the matching and email flow, not a live service.
- Impact is not yet measured. The roadmap (lab caps, anonymous outcomes, teacher cohorts) needs real partners and a school pilot first.
- The gripper uses one on/off threshold. Real prosthetics add graded force and pattern recognition.
