// code-theme.spec.mjs — Settings → Code blocks → Colour theme, in a real browser.
//
// The converter and the preset list are unit-tested (tests/code-themes.test.mjs). What only a browser can show is
// the whole chain: the choice applied to the page's stylesheet, the SURFACE colours reaching both code blocks and
// the bench's CodeMirror editor (a separately loaded bundle), and an uploaded file going through the real file
// input. The case worth most is a DARK theme in a LIGHT panel: without the surface colours, its light tokens would
// be drawn on the panel's white.
import { test, expect } from "@playwright/test";
import path from "node:path";
import { configureExtension, launchExtension } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE = path.resolve(import.meta.dirname, "../fixtures/vscode-theme.jsonc");
const SHOTS = process.env.SHOTS;   // a directory to screenshot into, for eyeballing; unset in CI

/** Open the sidebar in a LIGHT panel, and wait for it to stop sliding (the transition is outside the iframe). */
async function openSidebar(fake, ext) {
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fake.url}/api/version`);
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const host = root.getElementById("ml-sb-host");
        host.style.width = "600px";
        host.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    let frame = null;
    for (let i = 0; i < 80 && !frame; i++) {
        frame = page.frames().find((f) => /sidebar\.html/.test(f.url()));
        if (!frame) await sleep(100);
    }
    await frame.locator("body").waitFor();
    for (let i = 0, last = null; i < 40; i++) {
        const x = (await frame.locator("body").boundingBox())?.x;
        if (x != null && x === last) break;
        last = x;
        await sleep(100);
    }
    return { page, frame };
}
const openCodeSettings = async (frame) => {
    await frame.locator('button[aria-label="Settings"]').dispatchEvent("click");
    await frame.getByRole("tab", { name: "Appearance" }).or(frame.locator("button", { hasText: /^Appearance$/ })).first().click();
    await frame.locator("select.set-codetheme").scrollIntoViewIfNeeded();
};
const rootVar = (frame, name) => frame.evaluate((n) => document.documentElement.style.getPropertyValue(n).trim(), name);
/** The bench editor's painted background, and a keyword token's colour, as the browser computed them. */
const benchColours = (frame) => frame.evaluate(() => {
    const ed = document.querySelector(".bench-code .cm-editor");
    const kw = document.querySelector(".bench-code .cm-content .hljs-keyword");
    return { bg: ed ? getComputedStyle(ed).backgroundColor : null, keyword: kw ? getComputedStyle(kw).color : null };
});
const openBenchWith = async (frame, code) => {
    await frame.locator('button[aria-label="Back"], button[aria-label="Back to sessions"]').first().dispatchEvent("click");
    await frame.locator('button[aria-label="Python bench"]').dispatchEvent("click");
    await frame.locator(".bench-code .cm-editor").waitFor({ timeout: 15000 });
    await frame.locator(".bench-code .cm-content").fill(code);
    await sleep(200);
};

test("a preset colours the page's code and the bench editor, and a dark one keeps its own background in a light panel", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", theme: "light" });
        const { page, frame } = await openSidebar(fake, ext);
        await openCodeSettings(frame);
        // The default draws on the panel's own colours: no surface override.
        await expect(frame.locator("select.set-codetheme")).toHaveValue("atom-one");
        expect(await rootVar(frame, "--code-bg")).toBe("");

        await frame.locator("select.set-codetheme").selectOption("nord");
        await expect.poll(() => rootVar(frame, "--code-bg")).toBe("#2E3440");
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-preset.png` });
        await openBenchWith(frame, "import numpy as np\n\ndef f(x):\n    return x * 2  # double");
        const nord = await benchColours(frame);
        expect(nord.bg, "the editor paints Nord's own background, not the light panel's").toBe("rgb(46, 52, 64)");
        expect(nord.keyword, "and its keywords in Nord's keyword colour").toBe("rgb(129, 161, 193)");
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/bench-nord.png` });

        // Remembered, and applied on the next load.
        expect(await frame.evaluate(() => new Promise((r) => chrome.storage.local.get("ml_code_theme", (d) => r(d.ml_code_theme))))).toBe("nord");
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});

test("a VS Code theme file is uploaded, converted, and applied — and a bad file is refused with the reason", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", theme: "light" });
        const { page, frame } = await openSidebar(fake, ext);
        await openCodeSettings(frame);
        await frame.locator("select.set-codetheme").selectOption("vscode");
        await expect(frame.locator(".set-codetheme-vscode .set-note"), "the disclaimer is shown").toContainText("may not look exactly");

        // A file that is not JSON: refused, said why, and nothing changes.
        await frame.locator('.set-codetheme-vscode input[type="file"]').setInputFiles({ name: "broken.json", mimeType: "application/json", buffer: Buffer.from("{ not json") });
        await expect(frame.locator(".set-codetheme-vscode .set-warn")).toContainText("not valid JSON");
        expect(await rootVar(frame, "--code-bg")).toBe("");

        await frame.locator('.set-codetheme-vscode input[type="file"]').setInputFiles(FIXTURE);
        await expect(frame.locator(".set-codetheme-vscode")).toContainText("Fixture Sunset");
        await expect(frame.locator(".set-codetheme-vscode .set-warn")).toHaveCount(0);
        await expect.poll(() => rootVar(frame, "--code-bg")).toBe("#1b1426");
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/settings-vscode.png` });

        await openBenchWith(frame, "import numpy as np\n\ndef f(x):\n    return x * 2  # double");
        const sunset = await benchColours(frame);
        expect(sunset.bg).toBe("rgb(27, 20, 38)");
        expect(sunset.keyword, "keyword.control's colour, the more specific rule").toBe("rgb(255, 79, 154)");
        if (SHOTS) await page.screenshot({ path: `${SHOTS}/bench-vscode.png` });
    } finally {
        await ext.context.close();
        await fake.stop();
    }
});
