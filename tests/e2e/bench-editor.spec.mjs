// bench-editor.spec.mjs — the Python bench's code editor, in a real browser.
//
// None of this is representable in jsdom. The editor arrives as a SEPARATE bundle fetched at runtime
// (dist/cm-editor.js, kept out of sidebar-app because it is ~392 KB against that bundle's ~694 KB),
// it renders inside an iframe nested in a shadow root, and what is being asserted is that real
// keystrokes produce the right document. The narrated version of the same script is
// bench-editor-demo.mjs.
//
// Two regressions live here permanently, both found by running this and neither visible from a unit
// test: Ctrl+Enter on macOS, and characters landing in the order they were typed.
import { expect, test } from "@playwright/test";
import { configureExtension, launchExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CodeMirror's "Mod" is Cmd on macOS and Ctrl elsewhere, and both of these depend on which one you press.
// Select-all: Ctrl-a on a Mac is "start of line", so the wrong one silently edits the wrong range.
// The run chord: only MOD-Enter reaches CodeMirror's default "insert a blank line" binding, so a test that
// presses Ctrl+Enter on a Mac cannot see that bug at all — it would pass on a Mac and fail on Linux CI.
const MAC = process.platform === "darwin";
const SELECT_ALL = MAC ? "Meta+a" : "Control+a";
const MOD_ENTER = MAC ? "Meta+Enter" : "Control+Enter";

/** Boot the extension, open the sidebar, and switch to the bench. */
async function openBench(fake, ext) {
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fake.url}/api/version`);
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const host = root.getElementById("ml-sb-host");
        host.style.width = "560px";
        host.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    let frame = null;
    for (let i = 0; i < 80 && !frame; i++) {
        frame = page.frames().find((f) => /sidebar\.html/.test(f.url()));
        if (!frame) await sleep(100);
    }
    if (!frame) throw new Error("sidebar iframe never appeared");
    // dispatchEvent, not click(): the button's own tooltip span covers its centre.
    await frame.locator('button[aria-label="Python bench"]').dispatchEvent("click");
    await frame.locator(".bench").waitFor({ timeout: 10000 });
    // THE PANEL IS STILL SLIDING IN. Its transition is on the shadow host OUTSIDE the iframe, which Playwright's
    // stability check does not see, so a click in the first ~300ms lands where the button WAS (measured: the
    // Run button at x=1510, then 1172, then 1170) and nothing in the frame receives it — a run that silently
    // never started, 3 times in 4. Wait for the bench to stop moving.
    let last = null;
    for (let i = 0; i < 40; i++) {
        const x = (await frame.locator(".bench").boundingBox())?.x;
        if (x != null && x === last) break;
        last = x;
        await sleep(100);
    }
    return { page, frame };
}

test("python bench: the editor upgrades, highlights, completes, and runs", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const { frame } = await openBench(fake, ext);

        // The textarea renders first and CodeMirror replaces it once its bundle lands. Both halves
        // matter: the fallback is what makes loading it separately safe.
        await frame.locator(".ced-cm .cm-editor").waitFor({ timeout: 15000 });
        expect(await frame.locator(".ced-ta").count()).toBe(0);

        // Highlighting reuses highlight.js's own class names, so the Atom One stylesheet the sidebar
        // already swaps on theme change colours the editor too, with no second palette to drift.
        const keywords = await frame.locator(".cm-content .hljs-keyword").allTextContents();
        expect(keywords).toContain("import");

        const content = frame.locator(".cm-content");
        // Keys go through the LOCATOR: the sidebar is an iframe inside a shadow root, so page-level
        // typing lands on the host page instead of in the editor.
        await content.click();
        await content.press(SELECT_ALL);
        await content.press("Backspace");
        await content.pressSequentially("pri", { delay: 40 });

        // REGRESSION: a stale `value` prop replayed a few keystrokes behind used to be pushed back
        // into the document under a cursor that had moved on, so "pri" arrived as "rip".
        expect(await content.innerText()).toBe("pri");

        await expect.poll(() => frame.locator(".cm-tooltip-autocomplete li").count(), { timeout: 5000 })
            .toBeGreaterThan(0);
        expect(await frame.locator(".cm-tooltip-autocomplete li").allTextContents())
            .toEqual(expect.arrayContaining([expect.stringContaining("print")]));

        await content.press("Escape");
        await content.press(SELECT_ALL);
        await content.pressSequentially("return 6 * 7", { delay: 20 });

        // Count the SCRIPT runs the bench sends. The environment probe rides the same message type with
        // `env: true` and no code, and fires after a run, so it is filtered out rather than counted.
        await frame.evaluate(() => {
            const send = chrome.runtime.sendMessage.bind(chrome.runtime);
            window.__scriptRuns = 0;
            chrome.runtime.sendMessage = (msg, ...rest) => {
                if (msg?.type === "PYTHON_EXEC" && !msg.payload?.env) window.__scriptRuns++;
                return send(msg, ...rest);
            };
        });
        await content.press(MOD_ENTER);

        await frame.locator(".bench-outpane").waitFor({ timeout: 30000 });
        // Pyodide's first load in a cold profile is slow, so poll for a real result.
        await expect.poll(async () => frame.locator(".bench-outpane").innerText(), { timeout: 120000 })
            .toContain("42");

        // REGRESSION: CodeMirror's default keymap reads Mod-Enter as "insert a blank line". The bench owns
        // the chord panel-wide, so an editor that left it unclaimed ran the script AND added a line to it,
        // on every run. Verified to fail with the chord unclaimed, on the platform's own Mod.
        expect(await content.innerText()).toBe("return 6 * 7");
        // One keypress, one run. Held today by TWO things, either of which suffices: the editor stops a
        // chord it acted on, and the bench's `run` guards on a signal that is already set by the time a
        // second call arrives. So this does NOT fail on the naive port — it pins the invariant, not a bug.
        expect(await frame.evaluate(() => window.__scriptRuns)).toBe(1);

        if (MAC) {
            // REGRESSION: the textarea this replaced ran on `metaKey || ctrlKey`, and "Mod" alone is Cmd
            // here, so binding only Mod silently dropped Ctrl+Enter for every Mac user.
            await frame.locator(".bench-outpane").evaluate((el) => { el.dataset.before = el.innerText; });
            await content.press("Control+Enter");
            await expect.poll(() => frame.evaluate(() => window.__scriptRuns), { timeout: 30000 }).toBe(2);
        }
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});

test("python bench: once the sandbox is warm, completion comes from Jedi — imports resolved, never run", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
            model: "fake-model", debugMode: "overlay",
        });
        const { frame } = await openBench(fake, ext);
        await frame.locator(".ced-cm .cm-editor").waitFor({ timeout: 15000 });
        const content = frame.locator(".cm-content");

        // WARM the sandbox with a run: completion is never what starts Pyodide (a keystroke must not pay a cold
        // start, nor push the first Run behind one), so before this the editor has only its static list.
        await content.click();
        await content.press(SELECT_ALL);
        await content.pressSequentially("return 1", { delay: 20 });
        await content.press(MOD_ENTER);
        await expect.poll(async () => frame.locator(".bench-outpane").innerText(), { timeout: 120000 }).toContain("1");

        await content.press(SELECT_ALL);
        await content.pressSequentially("import numpy as np\nnp.ar", { delay: 30 });
        // The first request after warming LOADS Jedi (1.6 MB), which is longer than the editor waits, so it
        // falls back — deliberately. Keep typing the way a person would until Jedi is the one answering.
        await expect.poll(async () => {
            await content.press("Backspace");
            await content.pressSequentially("r", { delay: 30 });
            await new Promise((r) => setTimeout(r, 700));
            return frame.locator(".cm-tooltip-autocomplete li").allTextContents();
        }, { timeout: 30000, intervals: [500] }).toEqual(expect.arrayContaining([expect.stringContaining("arange")]));
        // numpy's `arange` is a MEMBER of the module — no static list offers that; this came from the sandbox.
        // And it carries NO kind label: Jedi calls it a "module" (numpy 2's stubs defeat it), which is wrong, so
        // an unverified kind is shown as nothing rather than as that.
        await expect(frame.locator(".cm-tooltip-autocomplete li", { hasText: "arange" }).first().locator(".cm-completionDetail")).toHaveCount(0);
        // Where Jedi IS sure, it says so: a real, loaded submodule.
        await content.press("Escape");
        await content.pressSequentially("\nnp.linal", { delay: 40 });
        await expect.poll(() => frame.locator(".cm-tooltip-autocomplete li", { hasText: "linalg" }).first().locator(".cm-completionDetail").innerText().catch(() => ""),
            { timeout: 10000 }).toBe("module");

        // A member that does not exist gets NO popup — not builtins offered as attributes of `np`.
        await content.press("Escape");
        await content.pressSequentially("\nnp.zzqx", { delay: 40 });
        await new Promise((r) => setTimeout(r, 900));
        await expect(frame.locator(".cm-tooltip-autocomplete")).toHaveCount(0);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});

/** Run whatever is in the editor and wait for the result to land. */
async function runBench(frame) {
    await frame.locator(".bench-play").click();
    for (let i = 0; i < 30 && !(await frame.locator(".bench-outpane").count()); i++) await sleep(100);
    for (let i = 0; i < 150; i++) {
        if (!(await frame.locator(".bench-outpane .r-ranfor.live").count())
            && await frame.locator(".bench-play:not([disabled])").count()) return;
        await sleep(400);
    }
    throw new Error("the bench never produced a result");
}

// THE LOG'S TRACEBACK GESTURE, IN THE BENCH. In a step, clicking `File "<python_exec>", line N` pulses that
// line in the step's code block. The bench's code is a live editor, so the frame hands the jump to it — and
// since you keep typing after a failure, the number (which is about the code that RAN) is followed through
// lines added above it and refused once the line itself is edited, never pointed at whatever slid into place.
test("python bench: a traceback frame shows its line in the editor, and follows the script as you edit", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        const { frame } = await openBench(fake, ext);
        await frame.locator(".bench-code .cm-editor").waitFor({ timeout: 15000 });
        const content = frame.locator(".bench-code .cm-content");
        // The preference is off by default, so no gutter yet.
        await expect(frame.locator(".bench-code .cm-lineNumbers")).toHaveCount(0);

        await content.fill("def inner():\n    return 1 / 0\nx = 1\ninner()");
        await runBench(frame);
        await expect(frame.locator(".bench-outbody")).toContainText("ZeroDivisionError");

        // WHERE IT BROKE, marked on the editor's line and its number — and the gutter comes on for it,
        // preference or not, because a traceback names a number.
        const fail = frame.locator(".bench-code .cm-line.cm-ml-fail");
        await expect(fail).toHaveCount(1);
        await expect(fail).toHaveText("    return 1 / 0");
        await expect(frame.locator(".bench-code .cm-lineNumbers")).toHaveCount(1);
        await expect(frame.locator(".bench-code .cm-ml-fail-lno")).toHaveText("2");

        // The deepest frame pulses RED on the failing line; a call-path frame pulses GREEN on its own line.
        await frame.locator(".bench-outbody .tb-fail .tb-line").click();
        await expect(frame.locator(".bench-code .cm-line.cline-pulse-fail")).toHaveText("    return 1 / 0");
        const callSite = frame.locator(".bench-outbody .tbline:not(.tb-fail) .tb-line").first();
        await expect(callSite).toContainText("line 4");
        await callSite.click();
        await expect(frame.locator(".bench-code .cm-line.cline-pulse")).toHaveText("inner()");

        // Two lines added ABOVE after the run: the mark and the jump follow the line to its new number.
        await content.fill("# first\n# second\ndef inner():\n    return 1 / 0\nx = 1\ninner()");
        await expect(fail).toHaveText("    return 1 / 0");
        await expect(frame.locator(".bench-code .cm-ml-fail-lno")).toHaveText("4");
        await frame.locator(".bench-outbody .tb-fail .tb-line").click();
        await expect(frame.locator(".bench-code .cm-line.cline-pulse-fail")).toHaveText("    return 1 / 0");

        // The failing line itself EDITED: it is no longer the line that failed, so nothing is marked and the
        // frame says why instead of pulsing whatever now sits at that number.
        await content.fill("# first\n# second\ndef inner():\n    return 1 / 1\nx = 1\ninner()");
        await expect(fail).toHaveCount(0);
        // …but the GUTTER stays until the next run: dropping it with the mark shifted every line sideways under
        // the cursor that was fixing the failure.
        await expect(frame.locator(".bench-code .cm-lineNumbers")).toHaveCount(1);
        await frame.locator(".bench-outbody .tb-fail .tb-line").click();
        await expect(frame.locator(".bench-outbody .tb-changed")).toContainText("changed since this ran");
        await expect(frame.locator(".bench-code .cm-line.cline-pulse-fail")).toHaveCount(0);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});

test("python bench: the line-number preference draws the editor's gutter", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        // Settings → Appearance → line numbers, the same key the log's code blocks read.
        await ext.sw.evaluate(() => chrome.storage.local.set({ ml_debug_codelines: true }));
        const { frame } = await openBench(fake, ext);
        await frame.locator(".bench-code .cm-editor").waitFor({ timeout: 15000 });
        await frame.locator(".bench-code .cm-content").fill("a = 1\nb = 2\nc = 3");
        await expect(frame.locator(".bench-code .cm-lineNumbers")).toHaveCount(1);
        await expect(frame.locator(".bench-code .cm-lineNumbers .cm-gutterElement", { hasText: /^3$/ })).toHaveCount(1);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});

// THE LOG'S RENDERERS, IN THE BENCH. A sympy return is typeset and a PIL image is drawn — the same decision the
// model's python_exec step makes (py-render.ts). The bench used to decide on its own and showed a sympy result
// as its raw LaTeX source.
test("python bench: a sympy return is typeset and a PIL image is drawn, as in the log", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
        const { frame } = await openBench(fake, ext);
        await frame.locator(".bench-code .cm-editor").waitFor({ timeout: 15000 });
        const content = frame.locator(".bench-code .cm-content");

        await content.fill("import sympy as sp\nx = sp.symbols('x')\nsp.integrate(sp.exp(-x**2), (x, -sp.oo, sp.oo))");
        await runBench(frame);
        await expect(frame.locator(".bench-tab.on")).toHaveText("value (LaTeX)");
        await expect(frame.locator(".bench-outbody .katex").first()).toBeVisible();
        await expect(frame.locator(".bench-outbody"), "typeset, not the raw source").not.toContainText("\\sqrt");

        await content.fill("import numpy as np\nfrom PIL import Image\nImage.fromarray(np.zeros((8, 12, 3), dtype='uint8'))");
        await runBench(frame);
        await expect(frame.locator(".bench-tab.on")).toHaveText("image");
        const src = await frame.locator(".bench-outbody img").first().getAttribute("src");
        expect(src).toMatch(/^data:image\/png;base64,/);
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});
