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
