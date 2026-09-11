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
