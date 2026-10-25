"""End-to-end browser test. Run:  python3 tests/browser_test.py
Opens index.html (file://) in headless Chromium, clicks through the app, fails on any console error,
and saves screenshots to tests/shots/.
"""
import asyncio
import os
import sys
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "tests" / "shots"
SHOTS.mkdir(exist_ok=True)
URL = (ROOT / "index.html").as_uri()
errors = []


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ok  " + msg)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome") \
            if os.path.exists("/opt/pw-browsers/chromium-1194/chrome-linux/chrome") else await p.chromium.launch()
        ctx = await browser.new_context(viewport={"width": 1280, "height": 900}, accept_downloads=True)
        page = await ctx.new_page()
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))
        await page.goto(URL)
        await page.wait_for_selector("#plotA")

        # ---- Signal Lab walk-through
        check(await page.locator("#stepTitle").inner_text() == "This is what the sensor records", "step 1 loads")
        check(await page.locator("#wrapS").is_visible(), "spectrum visible on step 1")
        await page.screenshot(path=str(SHOTS / "1-raw.png"))

        await page.click(".step-b >> nth=1")
        check(await page.locator("#wrapB").is_visible(), "step 2 shows two plots")
        txt = await page.locator("#results").inner_text()
        check("raw quality" in txt, "step 2 shows signal quality")
        await page.fill("#hp", "30") if False else None
        await page.locator("#notch").uncheck()
        gain_off = await page.evaluate("window.__neuropath.state.out.snrClean")
        await page.locator("#notch").check()
        gain_on = await page.evaluate("window.__neuropath.state.out.snrClean")
        check(gain_on > gain_off + 1, f"notch improves quality ({gain_off:.1f} -> {gain_on:.1f} dB)")
        await page.screenshot(path=str(SHOTS / "2-clean.png"))

        await page.click(".step-b >> nth=2")
        check(await page.locator("#wrapB").is_visible(), "step 3 shows envelope plot")
        await page.screenshot(path=str(SHOTS / "3-envelope.png"))

        # ---- challenge: default settings are imperfect, tuned settings win
        await page.click(".step-b >> nth=3")
        res = await page.locator("#results").inner_text()
        check("Score" in res and "Perfect" not in res, "default settings do not already win on Medium")
        await page.screenshot(path=str(SHOTS / "4-detect-before.png"))
        await page.evaluate("""() => { const s = document.getElementById('k'); s.value = 3; s.dispatchEvent(new Event('input', {bubbles:true}));
                                      const e = document.getElementById('envHz'); e.value = 10; e.dispatchEvent(new Event('input', {bubbles:true})); }""")
        await page.wait_for_function("document.getElementById('results').innerText.includes('Perfect')", timeout=3000)
        res = await page.locator("#results").inner_text()
        check("Perfect" in res, "tuned settings reach a perfect score")
        await page.screenshot(path=str(SHOTS / "4-detect-win.png"))
        best = await page.evaluate("window.__neuropath.state.best.medium")
        check(best == 1, "best score saved")

        # ---- quiz
        opts = page.locator("#quizOpts .opt")
        await opts.nth(1).click()
        check("Not quite" in await page.locator("#quizFb").inner_text(), "wrong answer gives feedback")
        await opts.nth(0).click()
        check("Correct" in await page.locator("#quizFb").inner_text(), "right answer accepted")

        # ---- gripper
        await page.click("#next")
        check(await page.locator("#wrapG").is_visible(), "step 5 shows gripper")
        await page.click("#speed")
        await page.select_option("#speed", "2")
        await page.click("#play")
        await page.wait_for_timeout(1700)  # ~3.4 s of signal at 2x -> inside 2nd contraction (3.4-4.3 s)
        t = await page.evaluate("window.__neuropath.state.play.t")
        check(t > 2.5, f"playback advances (t={t:.1f}s)")
        await page.screenshot(path=str(SHOTS / "5-gripper.png"))
        await page.click("#play")  # pause
        check(await page.locator("#play").inner_text() in ("Resume", "Replay"), "pause works")
        # gripper must CLOSE inside a true contraction (5.2-6.8 s) and be OPEN at rest (0.2 s)
        await page.evaluate("() => { const s = window.__neuropath.state; s.play.t = 5.6; s.play.speed = 0.5; s.grip = 0; }")
        await page.click("#play")
        await page.wait_for_timeout(500)
        closed = await page.evaluate("window.__neuropath.state.grip")
        await page.click("#play")
        check(closed > 0.8, f"gripper closes during a contraction (grip={closed:.2f})")
        await page.evaluate("() => { const s = window.__neuropath.state; s.play.t = 0.2; s.play.speed = 0.5; }")
        await page.click("#play")
        await page.wait_for_timeout(300)
        opened = await page.evaluate("window.__neuropath.state.grip")
        await page.click("#play")
        check(opened < 0.2, f"gripper stays open at rest (grip={opened:.2f})")

        # ---- download
        async with page.expect_download() as dl:
            await page.click("#download")
        d = await dl.value
        content = Path(await d.path()).read_text()
        check("NeuroPath EMG results" in content and "Perfect" not in content and "score 100%" in content, "download contains results")

        # ---- upload: good CSV, bad CSV
        import math, random
        random.seed(1)
        rows = ["t,emg"]
        for i in range(4000):
            tt = i / 1000
            amp = 1.0 if 1.0 < tt < 2.0 or 3.0 < tt < 3.8 else 0.05
            rows.append(f"{tt:.3f},{amp * random.gauss(0, 1) + 0.3 * math.sin(2 * math.pi * 60 * tt):.4f}")
        good = ROOT / "tests" / "_good.csv"
        good.write_text("\n".join(rows))
        await page.set_input_files("#file", str(good))
        await page.wait_for_function("document.getElementById('srcInfo').textContent.includes('Your file')")
        check(await page.locator("#fsRow").is_visible(), "sample-rate row shown for uploads")
        await page.click(".step-b >> nth=3")
        res = await page.locator("#results").inner_text()
        check("contractions found" in res, "uploaded data gets detections")
        found = await page.evaluate("window.__neuropath.state.out.det.length")
        check(found == 2, f"finds the 2 contractions in my CSV (found {found})")
        await page.screenshot(path=str(SHOTS / "6-upload.png"))
        bad = ROOT / "tests" / "_bad.csv"
        bad.write_text("hello\nworld\n")
        await page.set_input_files("#file", str(bad))
        await page.wait_for_selector("#srcError:not([hidden])")
        check("numeric samples" in await page.locator("#srcError").inner_text(), "bad CSV shows a friendly error")
        check(await page.evaluate("window.__neuropath.state.source.kind") == "upload", "previous data kept after bad upload")
        # regression: files that used to be accepted silently
        eu = ROOT / "tests" / "_eu.csv"; eu.write_text("\n".join(f"{(i % 7) / 10:.2f}".replace(".", ",") for i in range(2000)))
        await page.set_input_files("#file", str(eu))
        await page.wait_for_function("document.getElementById('srcError').textContent.includes('decimal commas')", timeout=3000)
        check(True, "decimal-comma CSV is rejected with a helpful message")
        flat = ROOT / "tests" / "_flat.csv"; flat.write_text("\n".join(["5"] * 2000))
        await page.set_input_files("#file", str(flat))
        await page.wait_for_function("document.getElementById('srcError').textContent.includes('same')", timeout=3000)
        check(True, "flat CSV is rejected with a helpful message")
        eu.unlink(); flat.unlink()
        good.unlink(); bad.unlink()
        await page.click(".seg-b[data-diff=hard]")
        check(await page.locator("#fsRow").is_hidden(), "returning to simulated hides upload row")

        # ---- Find a lab
        await page.click("#tab-find")
        check(await page.locator("#view-find").is_visible(), "Find a lab tab opens")
        await page.click("#findForm button[type=submit]")
        check(await page.locator("#findError").is_visible(), "empty form shows error")
        await page.fill("#fName", "Sam")
        await page.select_option("#fGrade", "senior")
        await page.fill("#fInterests", "brain-computer interface, EEG")
        await page.fill("#fSkills", "python, signal processing")
        await page.click("#findForm button[type=submit]")
        first = await page.locator(".lab h3").first.inner_text()
        check("Jordan Sample" in first and "demo" in first.lower(), "BCI demo lab ranks first and is badged Demo")
        check(await page.locator("button:has-text('Build draft')").count() == 0, "demo labs cannot generate emails")
        await page.screenshot(path=str(SHOTS / "7-find.png"), full_page=True)

        # inject a REAL (non-demo) lab to test the email flow
        await page.evaluate("""() => { window.NP_LABS.push({id:'real-1', demo:false, pi:'Dr. Test Person', lab:'Test Lab', institution:'Test U', state:'FL',
            department:'Biomedical Engineering', keywords:'EMG; prosthetics', summary:'Studies EMG control.', methods:'EMG; python',
            paper:'EMG control study', paperYear:2025, format:'either', minGrade:'freshman', skills:'python', contact:'pi@test.edu'}); }""")
        await page.click("#findForm button[type=submit]")
        await page.click("button:has-text('Build draft')")
        check(await page.locator(".draft .error").first.is_visible(), "short question is rejected")
        await page.fill("textarea[id^=q]", "Why did you choose a linear decoder instead of a neural network for the EMG signals in your study?")
        await page.click("button:has-text('Build draft')")
        body = await page.locator("textarea[id^=m]").input_value()
        check("Dear Professor Person" in body and "linear decoder" in body and "Sam" in body, "email draft built from the student's own question")
        await page.screenshot(path=str(SHOTS / "8-draft.png"), full_page=True)

        # ---- returning to Signal Lab after visiting another tab redraws plots at full width
        await page.click("#tab-lab")
        await page.wait_for_timeout(200)
        wpx = await page.evaluate("document.getElementById('plotA').width / (window.devicePixelRatio || 1)")
        cpx = await page.evaluate("document.getElementById('plotA').clientWidth")
        check(abs(wpx - cpx) <= 2, f"plots are redrawn at full width after tab switch ({wpx:.0f} vs {cpx})")
        await page.click("#tab-find")

        # ---- About + hash routing
        await page.click("#tab-about")
        check("demo entries only" in (await page.locator("#view-about").inner_text()), "About states demo data honestly")
        await page.goto(URL + "#find")
        check(await page.locator("#view-find").is_visible(), "#find deep link works")

        # ---- mobile
        mob = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2)
        m = await mob.new_page()
        m.on("pageerror", lambda e: errors.append("mobile: " + str(e)))
        m.on("console", lambda msg: errors.append("mobile: " + msg.text) if msg.type == "error" else None)
        await m.goto(URL)
        await m.wait_for_selector("#plotA")
        overflow = await m.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow <= 1, f"no horizontal page scroll on phone (overflow {overflow}px)")
        await m.screenshot(path=str(SHOTS / "m1.png"), full_page=True)
        await m.click(".step-b >> nth=3")
        await m.screenshot(path=str(SHOTS / "m2.png"), full_page=True)
        overflow = await m.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check(overflow <= 1, f"no horizontal scroll on step 4 (overflow {overflow}px)")

        # ---- older browser without ctx.roundRect: gripper step must still work
        old = await browser.new_context(viewport={"width": 1100, "height": 800})
        await old.add_init_script("delete CanvasRenderingContext2D.prototype.roundRect;")
        op = await old.new_page()
        op.on("pageerror", lambda e: errors.append("old-browser: " + str(e)))
        await op.goto(URL)
        await op.wait_for_selector("#plotA")
        await op.click(".step-b >> nth=4")
        await op.click("#play")
        await op.wait_for_timeout(400)
        check(not [e for e in errors if e.startswith("old-browser")], "gripper works without ctx.roundRect")

        # ---- dark mode renders
        dark = await browser.new_context(viewport={"width": 1100, "height": 800}, color_scheme="dark")
        dp = await dark.new_page()
        dp.on("pageerror", lambda e: errors.append("dark: " + str(e)))
        await dp.goto(URL)
        await dp.wait_for_selector("#plotA")
        await dp.click(".step-b >> nth=3")
        await dp.screenshot(path=str(SHOTS / "d1.png"))

        await browser.close()

    check(not errors, "no console errors: " + "; ".join(errors))
    print("\nbrowser tests passed")


try:
    asyncio.run(main())
except Exception as e:
    print("FAILED:", e)
    if errors:
        print("console errors:", errors)
    sys.exit(1)
