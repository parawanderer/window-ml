// line-map.spec.mjs — the line-mapping system, in a real browser with the real sandbox.
//
// We reformat code so a person can read it, and a stack trace's entire content is a line number — so without
// a map the two silently stop agreeing and the reader is sent to a line that is not the one that failed.
// Everything else covering this is fast and synthetic: `line-map.test.mjs` and `py-format.test.mjs` are pure,
// and the jsdom tests feed the renderer a traceback we wrote ourselves. NOTHING ran the chain end to end —
// real CPython raising, the real offscreen worker returning, the real renderer mapping — which is exactly the
// gap a narrated demo cannot close, because a demo asserts nothing and so cannot fail.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dense on purpose, and it fails on the user's line 4 — inside a function they defined, so the deepest frame
// is the interesting one and there is a call path above it.
const PY = [
    "import pandas as pd",
    "def total(frame):",
    "    return frame['nope'].sum()",
    "rows = pd.DataFrame([{'aaaaaaaaaaaaaaa': 1, 'bbbbbbbbbbbbbbb': 2, 'ccccccccccccccc': 3, 'ddddddddddddddd': 4}])",
    "total(rows)",
].join("\n");

test("a real traceback names the user's line, and the render points at it", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
        });
        fake.setScript([
            { tool: "python_exec", args: { code: PY, mode: "readonly" } },
            { content: "done" },
        ]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => {
            window.ml.agent("fail on purpose", { approvalRouting: "both", extraTools: [window.ml.pythonTool()] });
        });
        const frame = await openRunInSidebar(page, { task: "fail on purpose" });
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            if (await frame.locator(".code.tb").count()) break;
            await sleep(500);
        }
        const step = frame.locator(".astep").first();
        if (!(await step.locator(".code.tb").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".code.tb")).toBeVisible({ timeout: 30000 });

        // 1. REAL CPYTHON reports the user's own line numbers. The sandbox indents the code into `def
        //    _user():` after a three-line prefix, so without the AST correction every one of these is +3 —
        //    and this is the only test that watches the real interpreter produce them.
        const tb = await step.locator(".code.tb").textContent();
        const userLines = [...tb.matchAll(/File "<python_exec>", line (\d+)/g)].map((m) => Number(m[1]));
        expect(userLines, "the call site, then the function — both as the user wrote them").toEqual([5, 3]);

        // 2. The DEEPEST frame is marked in the CODE, mapped through the reflow. Line 4 is long enough that
        //    the formatter breaks it, so the marked line is NOT simply the number the traceback says.
        const marked = step.locator(".cline.cline-fail");
        await expect(marked).toHaveCount(1);
        await expect(marked).toContainText("frame['nope']");
        expect(await marked.textContent(), "the call site is not the failure").not.toContain("total(rows)");

        // 3. The reflow actually HAPPENED — otherwise the mapping is untested by construction, and a test
        //    that passes because nothing moved proves nothing about moving things. The source is five lines;
        //    the long one opens out, so the block draws more rows than that.
        const drawn = await step.locator(".r-py-in .cline").count();
        expect(drawn, "the long line was broken open for reading").toBeGreaterThan(PY.split("\n").length);
        // The map is published for the traceback to use, and it says line 5 moved — which is the whole
        // reason the marked line cannot simply be the number the traceback printed.
        const raw = await step.locator("[data-cite='in']").getAttribute("data-py-map");
        expect(raw, "the map is published").not.toBeNull();
        const map = JSON.parse(raw);
        expect(map[3], "the failing line did not move; the lines after it did").toBe(3);
        expect(map[5], "the call site moved down as the long line opened out").toBeGreaterThan(5);

        // 4. Clicking a frame lands on the line it names, and the FAILING one flashes red rather than green —
        //    green says "here is the thing you asked for", which on the failing line is the one colour it is
        //    not.
        await step.locator(".tb-line").last().click();
        await expect(step.locator(".cline-pulse-fail")).toHaveCount(1);
        expect(await step.locator(".cline-pulse").count(), "the failure does not flash green").toBe(0);
    } finally { await ext.context.close(); await fake.stop(); }
});


// HOW LONG IT RAN, live. The jsdom tests pin where the footer goes and what it says; only a real browser can
// show the number actually MOVING, which is the half that distinguishes "slow" from "stuck" — and a ticker
// that never fires looks identical to one that does in a static assertion.
test("a running script counts up, and settles on what it measured", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    // Declared out here so the `finally` can stop the background approver whatever happens.
    let approving = false;
    let approver = Promise.resolve();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
        });
        // Slow on purpose, and it PRINTS — so the footer has a console to sit inside.
        fake.setScript([
            { tool: "python_exec", args: { code: "import time\nprint('working')\ntime.sleep(4)\n'done'", mode: "readonly" } },
            { content: "done" },
        ]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1300, height: 900 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => {
            window.ml.agent("run something slow", { stream: true, approvalRouting: "both", extraTools: [window.ml.pythonTool()] });
        });
        // The run parks at the gate before any step exists, so the transcript is empty and
        // `openRunInSidebar` (rightly) refuses to call that "open". Resolve gates in the BACKGROUND while
        // opening, rather than up front: the step we want to watch is the one the approval releases, so
        // draining first and opening second races the 4s window we are trying to observe.
        approving = true;
        approver = (async () => {
            while (approving) {
                const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key)).catch(() => []);
                for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k).catch(() => {});
                await sleep(150);
            }
        })();
        const frame = await openRunInSidebar(page, { task: "run something slow", timeout: 30000 });

        // EXPAND the running step. A step is collapsed until you open it, so its Out block — and the footer
        // hanging off it — do not exist yet; collapsed, the row already says "running…" in its preview.
        for (let i = 0; i < 40; i++) {
            if (await frame.locator(".r-ranfor.live").count()) break;
            const head = frame.locator(".astep-head").first();
            if (await head.count()) await head.click().catch(() => {});
            await sleep(200);
        }

        // WHILE IT RUNS: it says so, and the number moves. Two readings a second apart, because a ticker that
        // never fires is indistinguishable from one that does if you only look once.
        const live = frame.locator(".r-ranfor.live").first();
        await expect(live).toBeVisible({ timeout: 20000 });
        await expect(live).toContainText("running…");
        // Parse the UNITS: the footer humanises ("782ms" → "1.9s" → "1m 5s"), so stripping non-digits
        // compares 782 against 1.9 and concludes time went backwards.
        const ms = (t) => {
            // Each unit matched on its own. One regex of all-optional groups matches the empty string at
            // position 0 and reports zero for everything, which reads as a timer that never moved.
            const num = (re) => { const m = re.exec(t); return m ? Number(m[1]) : 0; };
            return num(/(\d+(?:\.\d+)?)ms\b/) + num(/(\d+(?:\.\d+)?)s\b/) * 1000 + num(/(\d+(?:\.\d+)?)m\b(?!s)/) * 60_000;
        };
        const read = async () => ms(await live.textContent());
        const first = await read();
        await sleep(1100);
        expect(await read(), "the elapsed figure is moving").toBeGreaterThan(first);

        // AND THEN IT SETTLES on the measured figure — not a number still quietly growing.
        await expect.poll(() => frame.locator(".r-ranfor:not(.live)").count(), { timeout: 30000 }).toBeGreaterThan(0);
        const done = frame.locator(".r-ranfor:not(.live)").first();
        await expect(done).toContainText(/ran in \d/);
        expect(await frame.locator(".r-ranfor.live").count(), "nothing is still counting").toBe(0);
        // It printed, so the footer belongs INSIDE the console rather than after the last section.
        expect(await done.evaluate((el) => !!el.closest(".r-py-stdout"))).toBe(true);
    } finally { approving = false; await approver.catch(() => {}); await ext.context.close(); await fake.stop(); }
});

// The JS half of the same guarantee, and a defect it was hiding. `exec` reported `e.message` and dropped
// the stack, so a JS failure said WHAT and never WHERE — on a twenty-line script that is most of the answer
// missing, for the human AND for the model retrying it. There is no traceback to render (an evaluated
// script's stack is almost entirely the wrapper), so the line is measured off the wrapper's own offset and
// reported once; from there it travels the identical route a python frame does, through the DERIVED map
// (js-beautify hands back none) into the beautified code.
const JS = [
    "const rows=[{rep:'Gia',q1:210,q2:220},{rep:'Kim',q1:190,q2:205},{rep:'Ada',q1:150,q2:160}];",
    "const total=rows.reduce((a,r)=>a+r.q1+r.q2,0);",
    "console.log('total',total);",
    "return {total,missing:rows.map(r=>r.q3.toFixed(1))};",
].join("\n");

test("a JS failure names the model's own line, and it clicks through the beautified code", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setScript([{ tool: "exec", args: { js: JS } }, { content: "done" }]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => { window.ml.agent("trip over a missing field", { approvalRouting: "both" }); });
        const frame = await openRunInSidebar(page, { task: "trip over" });
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            if (await frame.locator(".r-py-err").count()) break;
            await sleep(500);
        }
        const step = frame.locator(".astep").first();
        if (!(await step.locator(".r-py-err").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-py-err")).toBeVisible({ timeout: 30000 });

        // 1. The line is the MODEL'S, not the engine's. The source runs inside a wrapper (here the async
        //    one, since it uses top-level `return`), so the raw frame is several lines further down; line 4
        //    is where `r.q3` is, as the model wrote it.
        const err = await step.locator(".r-py-err").textContent();
        expect(err).toContain("toFixed");
        // Read off the CONTROL rather than the block's text: the tooltip lives in the DOM beside the number
        // (so it is readable without a pointer) and lands in the middle of `textContent`.
        await expect(step.locator(".r-py-err .tb-line"), "the failure says WHERE, not only what").toHaveText("4");

        // 2. The MODEL was told too — it is retrying this code, and a line number is the difference between
        //    a targeted fix and a rewrite. The raw view is the model-facing result verbatim (the raw-view
        //    rule), so what is there is what it read.
        await step.locator(".rr-toggle button", { hasText: "raw" }).last().click();
        await expect(step.locator(".io-body").last()).toContainText("(line 4)");
        await step.locator(".rr-toggle button", { hasText: "rendered" }).last().click();

        // 3. It is a CONTROL, and it lands on the mapped line. Beautify split the model's one-line array
        //    literal across many rows, so line 4 of the source is not row 4 of what is drawn — which is the
        //    entire point of carrying a map rather than the number alone.
        const map = JSON.parse(await step.locator("[data-cite='in']").getAttribute("data-py-map"));
        expect(map[4], "the failing line moved when the code was beautified").toBeGreaterThan(4);
        await step.locator(".r-py-err .tb-line").click();
        await expect(step.locator(".cline-pulse-fail")).toHaveCount(1);
        // Red, not green: the failing line is the one line green would be wrong on.
        expect(await step.locator(".cline-pulse").count()).toBe(0);
        await expect(step.locator(`.cline[data-line="${map[4]}"]`)).toContainText("return");
    } finally { await ext.context.close(); await fake.stop(); }
});

// A DataFrame cell with no JSON form. pandas serialises an arbitrary object to an empty object, which is a
// PLAUSIBLE value — so the panel would print `{}` exactly where the reader is looking for the real one, the
// same wrong-fact-in-the-right-place as the `[object Object]` this replaced. The type is recorded in the
// sandbox because that is the last place it is still known, and only a real run proves the two halves agree.
const PY_ODD = [
    "import pandas as pd",
    "class Probe:",
    "    def __repr__(self): return '<Probe live>'",
    "return pd.DataFrame({'name': ['a', 'b'], 'meta': [{'q1': 1}, Probe()]})",
].join("\n");

test("a cell we cannot render says what it is, and never shows as an empty object", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
        });
        fake.setScript([{ tool: "python_exec", args: { code: PY_ODD, mode: "readonly" } }, { content: "done" }]);
        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1400, height: 900 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);
        await page.evaluate(() => {
            window.ml.agent("return a frame with an odd cell", { approvalRouting: "both", extraTools: [window.ml.pythonTool()] });
        });
        const frame = await openRunInSidebar(page, { task: "odd cell" });
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            if (await frame.locator(".r-df-table").count()) break;
            await sleep(500);
        }
        const step = frame.locator(".astep").first();
        if (!(await step.locator(".r-df-table").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-df-table")).toBeVisible({ timeout: 30000 });

        // The dict cell has a JSON form and keeps it — the marker is only for what would otherwise be LOST,
        // and a rule that swallowed working values would be worse than the bug.
        await expect(step.locator(".r-df-table tbody tr").first()).toContainText('"q1"');
        // The class instance is named, with its PYTHON type, carried across from the sandbox.
        const bad = step.locator(".r-td-unrend");
        await expect(bad).toHaveCount(1);
        await expect(bad).toHaveText("unrenderable Probe");
        // And it never reads as an empty dict, which is the specific wrong answer this exists to prevent.
        expect(await step.locator(".r-df-table").textContent()).not.toContain("{}");
    } finally { await ext.context.close(); await fake.stop(); }
});
