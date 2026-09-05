/**
 * A narrated demo, not a test: the Python bench's editor, driven in a real browser.
 *
 *   npm run build && node --import tsx tests/e2e/bench-editor-demo.mjs
 *
 * Opens a headful window, slides the sidebar open on the bench tab, and types Python into it so you
 * can watch the highlighting land, the completion popup open and filter, and Cmd/Ctrl+Enter run the
 * script against the real Pyodide sandbox. Deterministic: the fake backend serves the extension's
 * config, and nothing here calls a model.
 *
 * Knobs: PACE (ms between keystrokes, default 55), HOLD=0 to exit instead of holding the window
 * open, HEADLESS=1 to capture the screenshots without a window appearing.
 * Screenshots land in tests/e2e/artifacts/bench-editor-demo/.
 */
import { mkdirSync } from "node:fs";
import { configureExtension, launchExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.PACE ?? 55);
const HOLD = process.env.HOLD !== "0";
const OUT = new URL("./artifacts/bench-editor-demo/", import.meta.url).pathname;
const say = (s) => console.log(`\n▶ ${s}`);

mkdirSync(OUT, { recursive: true });

const fake = await startFakeLlm({ model: "fake-model" });
const ext = await launchExtension({ headful: process.env.HEADLESS !== "1" });
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}${name}.png` }); console.log(`   ${name}.png`); };

try {
    await configureExtension(ext.sw, {
        chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
        model: "fake-model", debugMode: "overlay",
    });
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fake.url}/api/version`);
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });

    say("Opening the sidebar at half width");
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const host = root.getElementById("ml-sb-host");
        host.style.width = "620px";
        host.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    let frame = null;
    for (let i = 0; i < 80 && !frame; i++) {
        frame = page.frames().find((f) => /sidebar\.html/.test(f.url()));
        if (!frame) await sleep(100);
    }
    if (!frame) throw new Error("sidebar iframe never appeared");

    say("Switching to the Python bench");
    // dispatchEvent, not click(): the button's tooltip span covers its centre.
    await frame.locator('button[aria-label="Python bench"]').dispatchEvent("click");
    await frame.locator(".bench").waitFor({ timeout: 10000 });
    await shot(page, "1-textarea-first");

    say("CodeMirror arrives and takes over — same field, now highlighted");
    await frame.locator(".ced-cm .cm-editor").waitFor({ timeout: 15000 });
    await sleep(500);
    await shot(page, "2-highlighted");

    const content = frame.locator(".cm-content");
    const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
    // Keys go through the LOCATOR: the sidebar is an iframe inside a shadow root, so page-level
    // typing would land on the host page instead of in the editor.
    await content.click();
    await content.press(selectAll);
    await content.press("Backspace");

    say("Typing Python — keywords, strings and builtins colour as they land");
    for (const line of [
        "import numpy as np",
        "",
        "grid = np.arange(24).reshape(4, 6)",
        'print("row sums:", grid.sum(axis=1))',
    ]) {
        await content.pressSequentially(line, { delay: PACE });
        await content.press("Enter");
    }
    await shot(page, "3-typed");

    say("Autocomplete: a prefix opens the popup, and it filters as you type");
    await content.pressSequentially("pri", { delay: PACE * 2 });
    await sleep(700);
    const options = await frame.locator(".cm-tooltip-autocomplete li").allTextContents();
    console.log(`   offered: ${options.join(", ") || "(none)"}`);
    await shot(page, "4-autocomplete");
    await content.press("Escape");
    await content.press("Backspace");
    await content.press("Backspace");
    await content.press("Backspace");

    say("Cmd/Ctrl+Enter runs it in the real sandbox (Pyodide's first load is slow)");
    await content.pressSequentially("return int(grid.sum())", { delay: PACE });
    await content.press("Control+Enter");
    await frame.locator(".bench-outpane").waitFor({ timeout: 30000 });
    for (let i = 0; i < 120; i++) {
        const out = await frame.locator(".bench-outpane").innerText();
        if (!/running/.test(out)) { console.log(`   result: ${out.replace(/\s+/g, " ").trim()}`); break; }
        await sleep(1000);
    }
    await shot(page, "5-result");

    if (HOLD) {
        console.log("\nHolding the window open — close it or press Ctrl+C to exit.");
        await new Promise((resolve) => { page.on("close", resolve); ext.context.on("close", resolve); });
    }
} finally {
    await ext.context.close();
    await fake.stop();
}
