# Code guide: understanding every part


## The big picture
```
raw EMG --> band-pass (20-450 Hz) --> notch (60 Hz) --> rectify (|x|) --> low-pass (envelope) --> threshold --> "muscle ON" --> gripper closes
```
Each arrow is one function in `dsp.js`. `app.js` just calls them in this order and draws the results.

## dsp.js: the signal processing (the core)

**Why filter at all?** The sensor records muscle activity *plus* junk. Three junk types matter:
- **Baseline drift**: slow wobble (<~5 Hz) from motion and skin. Removed by the *high-pass* half of the band-pass.
- **High-frequency hiss**: removed by the *low-pass* half. Together they form the **band-pass**, which keeps roughly the 20-450 Hz range where surface EMG has its energy.
- **Mains hum**: 60 Hz from wall power (50 Hz in Europe). One narrow frequency, so a **notch filter** removes just that.

**`biquad(type, fs, f0, Q)`**: builds the numbers (`b0,b1,b2,a1,a2`) for one 2nd-order filter, using the standard RBJ audio-cookbook formulas. `fs` is the sample rate, `f0` the cutoff, `Q` the sharpness.

**`runBiquad(x, c)`**: applies that filter sample by sample: each output is a weighted mix of the current and two previous inputs and two previous outputs. (This is the "difference equation".)

**`filtfilt`**: runs the filter forward, then backward. Why? A single pass delays the signal slightly (phase shift). Doing both directions cancels the delay, so a contraction in the filtered plot lines up in time with the raw one. Tested in `unit.test.js` ("zero-phase").

**`butter`**: chains two biquads with specific Q values (0.5412 and 1.3066) to make a 4th-order **Butterworth** filter, which is flat in the pass band. The "order" sets how steeply it cuts off.

**`removeDC`**: subtracts the mean. Sensors and ADCs add a constant level (an Arduino reads around 512). A filter that starts at zero sees that level as a giant step at the first sample and "detects" a contraction at t = 0. This bug was found by an edge-case test and fixed here.

**`rectify` + `envelope`**: EMG swings above and below zero, so its average is ~0. Taking the absolute value (rectify) makes all swings positive. A low-pass filter then smooths it into a curve that rises with effort: the **envelope**. Lower cutoff = smoother but blurrier.

**`restStats` + `thresholdFor`**: how is the "resting level" found with no labels? It takes the quieter half of the envelope (values below the median), and computes its mean and spread (standard deviation). Threshold = mean + k x spread. The slider changes `k`. This adapts to each recording, which is why it works on your own CSV.

**`detect`**: walks the envelope and records every stretch above the threshold. Two cleanups: stretches separated by tiny gaps merge (one contraction can flicker around the line), and stretches shorter than the minimum duration are dropped (that is how cable bumps are ignored).

**`scoreDetections`**: only possible for simulated data, because we know the true contraction times. A *hit* is a true contraction that overlaps a detection. A *false alarm* is a detection that overlaps no true contraction. A *miss* is a true contraction with no detection. Score = F1 = the balance of precision (how many detections were real) and recall (how many real ones were found).

**`snrDb`**: "signal quality". 20 x log10(average envelope during contractions / average at rest). Higher means cleaner. 20 dB means contractions are 10x stronger than rest.

**`fft` and `powerSpectrum`**: the FFT converts a signal from "value over time" to "how much power at each frequency". `powerSpectrum` averages the FFT of many short overlapping windows (the Welch method) so the plot is smooth. This is how the 60 Hz spike becomes visible.

**`simulateEMG`**: builds fake-but-realistic data. White noise is shaped to 20-450 Hz (like muscle), switched on during 5 known contractions (one deliberately weak), then 60 Hz hum, slow drift, sensor noise and brief cable bumps are added. A *seeded* random generator (`mulberry32`) makes it identical every run. `DIFFICULTY` sets how bad the junk is.

**`parseCSV`**: accepts one column (values) or two+ (time, value, ...), skips header lines, and estimates the sample rate from the time column. It *refuses* what it cannot read safely: too few numbers, inconsistent columns, a first column that is not steadily increasing time (this also catches European decimal commas like `0,5`, which would otherwise be read as two columns of garbage), and flat data. Why refuse instead of guess? A wrong guess would produce a plausible-looking but meaningless result, which is worse than an error.

**`decimate`**: for drawing. 12,000 samples cannot fit in 600 pixels, so for each pixel column it keeps the min and max. That way narrow peaks never disappear.

## Presets and presets' design (dsp.js `PRESETS`)
Each preset is a recipe for `simulateEMG`: which contractions happen when, how noisy, and whether cable bumps occur. They are tuned so the default pipeline solves them, because a judge should see success in one click. Two things they teach: on the **resting muscle** the right answer is *zero* detections (scoring treats "nothing found" as perfect), and making the threshold too sensitive makes the detector fire on noise.

## Honest limits of the detector (be able to say these)
- The resting level is estimated from the quieter half of the recording, so it assumes the muscle is at rest a good part of the time.
- Cable bumps survive heavy smoothing: a 50 ms bump smoothed at 5 Hz becomes a blip of about 120-145 ms, longer than the 100 ms "ignore short blips" setting. Lighter smoothing (10 Hz) shortens the blip so the rule removes it. This is why the Medium and Hard challenges need about 10 Hz.
- A single threshold gives open/closed only. Real devices use proportional control or pattern recognition.

## labs.js: matching and email

**`similarities`** is TF-IDF cosine similarity. Each lab's text and the student's text become word-count vectors. Rare words get more weight (IDF), so "electromyography" matters more than "study". Cosine similarity measures how much the two vectors point the same way (0 = nothing in common, 1 = identical).

**`rankLabs`**: first *hard filters* (a freshman never sees a junior-and-up lab; remote/in-person preference), then a score of 70% text similarity + 30% skill fit (share of the lab's listed skills the student has). It also returns the exact terms shared, which powers the "Why it fits" line.

**`validateEmailInputs` / `buildEmail`**: the student *must* write a question of 12+ words and remove any [brackets]. The template only supplies structure (greeting, paper title, polite close). This is deliberate: the tool cannot be used to mass-send identical emails.

Outreach helpers added in this version:
- **`specificityHint`**: compares the words in the student's question with the lab's paper title, keywords, methods and tags. If nothing overlaps, it shows a warning. It never blocks; it coaches.
- **`OUTREACH_CHECKLIST`**: four self-attested prompts. The UI keeps Copy / Download / Open in email disabled until all four are ticked. This is a coaching step, not enforcement, and the page says so.
- **The practice sentence** (`practiceSummary` in `app.js`) is generated from what the student actually did (settings and score), is optional, and says "self-reported". It never claims a certification, because nobody is certifying anything.
- **The offer line** (`student.offer`): an optional "one task you could take on" sentence. It shows the professor what you can do for the lab instead of only what you want. Brackets are rejected like in the question.
- **`draftChecks`**: scans the finished draft for common spam-style patterns (mostly-caps subject, repeated exclamation marks, sales phrases, many links, over 250 words, leftover brackets). It is a rough lint that re-runs as you edit. It cannot predict delivery and never blocks.
- **`academicTiming`**: maps today's month to the usual windows (Jan-Feb summer, Apr-May fall, Oct-early Nov spring) and warns about finals and term starts. Rules of thumb for US schools, not guarantees.
- **Schedule send**: NeuroPath sends nothing. "Open in email app" fills a draft, and the student schedules it in Gmail, Outlook or Apple Mail. That is why the page tells them to use that feature, and why SPF/DKIM are not a concern here.
- **Tags** in `labs-data.js` let the Signal Lab bridge recommend labs that match the techniques the student just used.

## app.js: connecting it to the page
Numbered sections at the top of the file. The important ideas:
- **`state`**: one object holding everything (current step, data source, slider values, results).
- **`compute()`**: runs the whole pipeline from the current state. **`refresh()`** = compute + redraw. Every slider calls `refresh()`.
- **`plotTime` / `plotSpectrum`**: draw on `<canvas>` using the 2D API. They read colors from CSS variables, so dark mode works.
- **Playback** (`startPlay`, `tick`): `requestAnimationFrame` advances a clock; the gripper's target is "closed" whenever the clock is inside a detected segment, and it eases toward that target.
- **localStorage**: remembers only quiz progress and best scores, in a try/catch because browsers can block it.
- **`scheduleRefresh`**: dragging a slider fires many events per frame, so the heavy recompute is queued to run at most once per frame (keeps big uploads smooth).
- **`rrect`**: a hand-drawn rounded rectangle, because `ctx.roundRect` does not exist in older browsers (it crashed the gripper step there).
- **No network calls**: uploaded files are read with `file.text()` in the browser.

## Testing and validation (say this in your video)
- `tests/unit.test.js`: 50 checks. Known-answer tests (sine waves, FFT peak), edge cases (zeros, flat line, DC offset, NaN, empty input, extreme sample rates), CSV safety, scoring, matching, and outreach rules.
- `tests/validate_scipy.py`: runs the same signal through `dsp.js` and SciPy/NumPy. Differences: band-pass 0.002 %, notch 0.11 %, envelope 0.09 %, spectrum 0.03 dB.
- `tests/browser_test.py` and `tests/browser_features_test.py`: drive the real app in Chromium (clicks, uploads, downloads, deep links, a browser without `roundRect`, a phone-sized screen).
- Several real bugs were found by these tests (DC-offset false detections, silent CSV misreads, a crash in older browsers), which is the best argument that they are worth having.

## Rendering and speed
`dsp.js` contains no drawing code on purpose, so it can be tested without a browser. Drawing lives in `app.js`: canvas plots use min/max decimation, slider events are coalesced with `requestAnimationFrame` (`scheduleRefresh`), and the gripper animation runs on its own `requestAnimationFrame` loop. Measured: about 10 ms per recompute + redraw and about 60 fps during playback in headless Chromium.

## Questions a judge might ask (and where the answer is)
1. *Why filter forward and backward?* Zero phase shift: no delay. See `filtfilt`.
2. *How do you choose the threshold without labels?* Rest level from the quieter half of the envelope plus k times its spread. See `restStats`.
3. *Why is the data simulated?* No access to lab equipment; it lets everyone practice, and the true answers allow scoring. Your own CSV works too.
4. *What is the limit?* A single threshold gives only open/closed. Real devices use proportional control or pattern recognition.
5. *Why did you not use accounts or a database?* Privacy for minors and zero server risk. Roadmap covers a two-sided platform.
6. *How do you stop email spam to professors?* Students must write their own question, and the roadmap adds per-lab monthly caps and opt-in-only listing.
7. *How do you know your filters are right?* Cross-checked against SciPy on the same signal (differences under 0.2 %), plus known-answer tests.
8. *Why does the resting preset exist?* To show that "detect nothing" can be the correct answer, and that an over-sensitive threshold fires on noise.
9. *What would you do with more time?* Real EMG recordings from your own sensor, an EEG alpha-wave lesson, pilot with a class, recruit labs.

## Exercises (do 2 or 3 before submitting; they make the project yours)
1. In `dsp.js`, change `plan` inside `simulateEMG` to add a sixth contraction. Run `node tests/unit.test.js`: which test fails and why? Fix the test.
2. Change the default `k` in `DEFAULTS` (`app.js`) and see how the Medium challenge changes.
3. Add a "Very hard" difficulty in `DIFFICULTY` and a button for it in `index.html`.
4. Add a rolling RMS envelope as an alternative to rectify + low-pass, and compare the two on the plot.
5. Record a few seconds from your own EMG sensor, save it as CSV, upload it, and describe in your write-up what you had to change to get clean detections.
