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
// Select-all is Cmd on macOS. Ctrl-a there is "start of line" in CodeMirror's own keymap, so getting
// this wrong silently edits the wrong range instead of failing.
const SELECT_ALL = process.platform === "darwin" ? "Meta+a" : "Control+a";

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
        // REGRESSION: CodeMirror's "Mod" is Cmd on macOS, but the textarea this replaced ran on
        // `metaKey || ctrlKey`. Binding Mod alone silently dropped Ctrl+Enter for every Mac user.
        await content.press("Control+Enter");

        await frame.locator(".bench-out").waitFor({ timeout: 30000 });
        // Pyodide's first load in a cold profile is slow, so poll for a real result.
        await expect.poll(async () => frame.locator(".bench-out").innerText(), { timeout: 120000 })
            .toContain("42");
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});
