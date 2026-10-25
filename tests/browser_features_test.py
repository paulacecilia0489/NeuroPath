"""Browser tests for presets, status badges, sound, lab bridge, outreach checklist, downloads, routing, performance.
Run:  python3 tests/browser_features_test.py     (needs: pip install playwright)
"""
import asyncio, os, sys
from pathlib import Path
from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parent.parent
URL = (ROOT / "index.html").as_uri()
errors = []

def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ok  " + msg)

REAL_LAB = """() => { window.NP_LABS.push({id:'real-1', demo:false, tags:['EMG','prosthetics'], pi:'Dr. Test Person', lab:'Test Lab', institution:'Test U', state:'FL',
  department:'Biomedical Engineering', keywords:'EMG; prosthetics; motor control', summary:'Studies EMG control.', methods:'EMG; python',
  paper:'Proportional myoelectric control', paperYear:2025, format:'either', minGrade:'freshman', skills:'python', contact:'pi@test.edu'}); }"""
GOOD_Q = "Why did you choose proportional control over a simple threshold for the myoelectric prosthetic hand in your study?"
GENERIC_Q = "I am very interested in your research and would love to learn more about what your students do in the lab"

async def new_page(browser, **kw):
    ctx = await browser.new_context(accept_downloads=True, viewport=kw.pop("viewport", {"width": 1280, "height": 900}), **kw)
    page = await ctx.new_page()
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: errors.append(str(e)))
    return page

async def main():
    async with async_playwright() as p:
        exe = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"
        browser = await p.chromium.launch(executable_path=exe) if os.path.exists(exe) else await p.chromium.launch()

        # ---------------- presets
        pg = await new_page(browser)
        await pg.goto(URL); await pg.wait_for_selector("#plotA")
        for pid, label in [("rest", "Resting muscle"), ("moderate", "Moderate contraction"), ("maxflex", "Max flex")]:
            await pg.click(f"[data-preset={pid}]")
            check(await pg.get_attribute(f"[data-preset={pid}]", "aria-pressed") == "true", f"preset '{pid}' button shows as active")
            check(await pg.get_attribute(".seg-b[data-diff=medium]", "aria-pressed") == "false", f"difficulty buttons deactivate for '{pid}'")
            check(label in await pg.locator("#srcInfo").inner_text(), f"source text names the '{pid}' preset")
            await pg.click(".step-b >> nth=3")
            res = await pg.locator("#results").inner_text()
            check("Perfect" in res, f"preset '{pid}' is solved at default settings on step 4")
            await pg.click(".step-b >> nth=0")
        await pg.click("[data-preset=rest]"); await pg.click(".step-b >> nth=3")
        res = await pg.locator("#results").inner_text()
        check("none expected" in res and "nothing was detected" in res, "resting preset explains that zero detections is correct")
        await pg.evaluate("""() => { const e=document.getElementById('envHz'); e.value=20; e.dispatchEvent(new Event('input',{bubbles:true}));
                                     const k=document.getElementById('k'); k.value=2; k.dispatchEvent(new Event('input',{bubbles:true})); }""")
        await pg.wait_for_function("document.getElementById('results').innerText.includes('too sensitive')", timeout=3000)
        check("too sensitive" in await pg.locator("#results").inner_text(), "over-sensitive threshold on rest produces false alarms and an explanation")
        await pg.click(".seg-b[data-diff=easy]")
        check(await pg.get_attribute("[data-preset=rest]", "aria-pressed") == "false", "choosing a difficulty deactivates the preset")
        # put the sliders back to the defaults so later checks start from a known state
        await pg.evaluate("""() => { for (const [id, v] of [['envHz', 5], ['k', 6]]) { const e = document.getElementById(id); e.value = v; e.dispatchEvent(new Event('input', {bubbles: true})); } }""")
        await pg.wait_for_function("window.__neuropath.state.p.k === 6 && window.__neuropath.state.p.envHz === 5")

        # ---------------- status badges (values come from the real computation)
        await pg.click("[data-preset=maxflex]")
        q = await pg.locator("#stQuality").inner_text()
        check("dB" in q, f"quality badge shows a measured value ('{q}')")
        await pg.click(".step-b >> nth=1")
        await pg.locator("#notch").uncheck()
        await pg.evaluate("() => { const e=document.getElementById('hp'); e.value=1; e.dispatchEvent(new Event('input',{bubbles:true})); }")
        await pg.wait_for_function("document.getElementById('stQuality').innerText.includes('noisy')", timeout=3000)
        noisy = await pg.locator("#stQuality").inner_text()
        await pg.locator("#notch").check()
        await pg.evaluate("() => { const e=document.getElementById('hp'); e.value=20; e.dispatchEvent(new Event('input',{bubbles:true})); }")
        await pg.wait_for_function("document.getElementById('stQuality').innerText.includes('clean')", timeout=3000)
        check(True, f"badge flips from '{noisy}' to '{await pg.locator('#stQuality').inner_text()}' when filters are restored")
        check("detected" in await pg.locator("#stDetect").inner_text(), "detection badge shows a count")
        check("idle" in await pg.locator("#stGrip").inner_text(), "gripper badge is 'idle' before playback")

        # ---------------- gripper badge + sound toggle
        await pg.click(".step-b >> nth=4")
        check(await pg.get_attribute("#soundBtn", "aria-pressed") == "false", "sound is OFF by default")
        await pg.click("#soundBtn")
        check(await pg.get_attribute("#soundBtn", "aria-pressed") == "true" and "on" in await pg.locator("#soundBtn").inner_text(), "sound toggle turns on")
        await pg.evaluate("() => { const s = window.__neuropath.state; s.play.t = 0.5; s.play.speed = 0.5; s.grip = 0; }")
        await pg.click("#play")
        await pg.wait_for_function("document.getElementById('stGrip').innerText.includes('Threshold exceeded')", timeout=4000)
        check(True, "gripper badge shows 'Threshold exceeded: gripper closed' during a contraction")
        await pg.click("#play")
        await pg.click("#soundBtn")
        check(await pg.get_attribute("#soundBtn", "aria-pressed") == "false", "sound toggle turns off again")

        # ---------------- bridge from the lab into the matcher
        await pg.click("[data-preset=maxflex]"); await pg.click(".step-b >> nth=4")
        check(await pg.locator("#bridge").is_visible(), "bridge card appears at the end of the Signal Lab")
        btxt = await pg.locator("#bridge").inner_text()
        check("Demo" in btxt and "demo entries" in btxt.lower(), "bridge labels directory entries as demos")
        await pg.click("#bridgeGo")
        check(await pg.locator("#view-find").is_visible(), "bridge button opens Find a lab")
        check("EMG" in await pg.input_value("#fInterests"), "interests are prefilled from the Signal Lab")
        n = await pg.locator(".lab").count()
        first = await pg.locator(".lab h3").first.inner_text()
        check(n >= 2 and ("Motor" in await pg.locator(".lab .meta").first.inner_text() or "Neural" in await pg.locator(".lab .meta").first.inner_text()),
              f"matches are shown automatically, best EMG lab first ({first.splitlines()[0]})")
        await pg.click("#tab-lab"); await pg.click("[data-preset=rest]"); await pg.click(".step-b >> nth=3")
        check(await pg.locator("#bridge").is_visible(), "bridge appears on step 4 once the challenge is solved")
        await pg.evaluate("""() => { const e=document.getElementById('envHz'); e.value=20; e.dispatchEvent(new Event('input',{bubbles:true}));
                                     const k=document.getElementById('k'); k.value=2; k.dispatchEvent(new Event('input',{bubbles:true})); }""")
        await pg.wait_for_function("document.getElementById('results').innerText.includes('too sensitive')", timeout=3000)
        check(await pg.locator("#bridge").is_hidden(), "bridge is hidden on step 4 while the challenge is NOT solved")
        await pg.evaluate("""() => { const e=document.getElementById('envHz'); e.value=5; e.dispatchEvent(new Event('input',{bubbles:true}));
                                     const k=document.getElementById('k'); k.value=6; k.dispatchEvent(new Event('input',{bubbles:true})); }""")
        await pg.wait_for_function("document.getElementById('results').innerText.includes('Perfect')", timeout=3000)

        # ---------------- outreach: checklist gating, hint, practice sentence, downloads
        await pg.click("#tab-find")
        await pg.fill("#fName", "Sam"); await pg.select_option("#fGrade", "senior")
        await pg.evaluate(REAL_LAB)
        await pg.click("#findForm button[type=submit]")
        real = pg.locator("article.lab", has_text="Dr. Test Person")
        await real.locator("textarea[id^=q]").fill(GENERIC_Q)
        await real.locator("button:has-text('Build draft')").click()
        check(await real.locator(".hint").is_visible() and "specific" in (await real.locator(".hint").inner_text()).lower(), "generic question gets a 'make it more specific' hint")
        for sel in ["button:has-text('Copy')", "button:has-text('Download')", "button:has-text('Open in email app')"]:
            check(await real.locator(sel).is_disabled(), f"{sel.split(':')[0]} {sel.split(':')[1]} is locked until the checklist is done")
        boxes = real.locator("fieldset.checklist input[type=checkbox]")
        check(await boxes.count() == 4, "checklist has four items")
        for i in range(3):
            await boxes.nth(i).check()
        check(await real.locator("button:has-text('Download')").is_disabled(), "three of four ticks is not enough")
        await boxes.nth(3).check()
        check(await real.locator("button:has-text('Download')").is_enabled() and await real.locator("button:has-text('Copy')").is_enabled(), "all four ticks unlock the tools")
        await boxes.nth(1).uncheck()
        check(await real.locator("button:has-text('Copy')").is_disabled(), "unticking re-locks the tools")
        await boxes.nth(1).check()
        # specific question + practice sentence
        await pg.click("#tab-lab"); await pg.click("[data-preset=moderate]"); await pg.click(".step-b >> nth=3"); await pg.click("#tab-find")
        await real.locator("textarea[id^=q]").fill(GOOD_Q)
        await real.locator("input[id^=pr]").check()
        await real.locator("button:has-text('Build draft')").click()
        check(await real.locator(".hint").count() == 0, "a specific question gets no hint")
        body = await real.locator("textarea[id^=m]").input_value()
        check("learning tool called NeuroPath" in body and "simulated EMG signal" in body and "1 of 1" in body, "practice sentence reflects what was actually done")
        check("certif" not in body.lower(), "draft never claims a certification")
        for i in range(4):
            await real.locator("fieldset.checklist input[type=checkbox]").nth(i).check()
        async with pg.expect_download() as dl:
            await real.locator("button:has-text('Download')").click()
        d = await dl.value
        txt = Path(await d.path()).read_text()
        check(d.suggested_filename == "inquiry-person.txt", f"download is named sensibly ({d.suggested_filename})")
        check("To: pi@test.edu" in txt and "Subject:" in txt and "[ ] My question points" in txt, "downloaded file has contact, subject, body and checklist")
        # offer field, schedule-send callout, live draft check, sending guide
        await real.locator("input[id^=of]").fill("cleaning and plotting a small dataset in Python")
        await real.locator("button:has-text('Build draft')").click()
        body = await real.locator("textarea[id^=m]").input_value()
        check("I could help with: cleaning and plotting a small dataset in Python." in body, "optional offer sentence is added to the draft")
        check("Schedule send" in (await real.locator(".callout").inner_text()), "schedule-send callout is shown with the draft")
        check("no common spam patterns" in (await real.locator(".spamcheck").inner_text()), "clean draft passes the draft check")
        await real.locator("textarea[id^=m]").fill(body + "\nThis is a guaranteed chance, act now!!")
        check("Sales-style" in (await real.locator(".spamcheck").inner_text()), "draft check updates live when the text is edited")
        guide = await pg.locator("#sendGuide").inner_text()
        check("Schedule send" in guide and "5" in guide and "same thread" in guide, "sending guide covers schedule send and follow-up on the same thread")
        check(len((await pg.locator("#timingNow").inner_text()).strip()) > 20, "timing note for today's date is filled in")
        # why-card honesty
        check("not enforced limits" in (await pg.locator("#whyCard").inner_text()), "page states that the checklist is coaching, not enforcement")

        # ---------------- routing fallbacks (each in a fresh page: direct deep-link on load)
        cases = {"#lab": "view-lab", "#find": "view-find", "#about": "view-about", "#matcher": "view-find", "#FIND": "view-find", "#find?x=1": "view-find",
                 "#garbage": "view-lab", "#": "view-lab", "#__proto__": "view-lab", "#constructor": "view-lab", "#%E0%A4%A": "view-lab", "#lab/../../x": "view-lab"}
        for h, expect in cases.items():
            rp = await new_page(browser)
            await rp.goto(URL + h); await rp.wait_for_selector("#steps", state="attached")
            visible = [v for v in ("view-lab", "view-find", "view-about") if await rp.locator("#" + v).is_visible()]
            check(visible == [expect], f"deep link {h!r} -> {expect}")
            await rp.close()
        rp = await new_page(browser)
        await rp.goto(URL + "#garbage"); await rp.wait_for_selector("#steps", state="attached")
        check(rp.url.endswith("#lab"), "invalid hash is rewritten to a clean #lab")
        await rp.evaluate("location.hash = '#nonsense'"); await rp.wait_for_timeout(150)
        check(await rp.locator("#view-lab").is_visible() and rp.url.endswith("#lab"), "changing to an invalid hash while running falls back to the lab")
        await rp.evaluate("location.hash = '#about'"); await rp.wait_for_timeout(150)
        check(await rp.locator("#view-about").is_visible(), "valid hash change while running switches view")
        # layout shift: loading straight into #find then going to lab must draw at full width
        await rp.goto(URL + "#find"); await rp.click("#tab-lab"); await rp.wait_for_timeout(250)
        w = await rp.evaluate("document.getElementById('plotA').width / (window.devicePixelRatio||1)")
        cw = await rp.evaluate("document.getElementById('plotA').clientWidth")
        check(abs(w - cw) <= 2, f"no stale canvas size after deep-linking to #find ({w:.0f} vs {cw})")

        # ---------------- performance: how long does one full recompute + redraw take?
        pf = await new_page(browser)
        await pf.goto(URL); await pf.wait_for_selector("#plotA")
        await pf.click(".step-b >> nth=3")
        ms = await pf.evaluate("""() => { const f = window.__neuropath; const t0 = performance.now();
            for (let i = 0; i < 50; i++) { f.state.p.k = 1 + (i % 14); f.refresh(); } return (performance.now() - t0) / 50; }""")
        print(f"       measured: {ms:.1f} ms per full recompute + redraw (12 s signal, 12,000 samples)")
        check(ms < 30, f"a slider change recomputes and redraws in {ms:.1f} ms (budget: 16.7 ms per frame at 60 fps, 30 ms test limit)")
        # frame pacing while the gripper plays
        await pf.click(".step-b >> nth=4")
        fps = await pf.evaluate("""() => new Promise((resolve) => { const s = window.__neuropath.state; s.play.t = 0; s.play.speed = 2;
            document.getElementById('play').click(); let frames = 0; const t0 = performance.now();
            const loop = () => { frames++; if (performance.now() - t0 < 1000) requestAnimationFrame(loop); else { document.getElementById('play').click(); resolve(frames); } };
            requestAnimationFrame(loop); })""")
        print(f"       measured: {fps} animation frames in 1 s of gripper playback (headless Chromium)")
        check(fps >= 30, f"gripper playback stays above 30 fps ({fps} fps measured in a headless, CPU-rendered browser)")

        await browser.close()
    check(not errors, "no console or page errors in any of the above: " + "; ".join(errors))
    print("\nfeature browser tests passed")

try:
    asyncio.run(main())
except Exception as e:
    print("FAILED:", e)
    if errors: print("console errors:", errors)
    sys.exit(1)
