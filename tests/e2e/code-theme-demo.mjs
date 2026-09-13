/**
 * A narrated demo, not a test: Settings → Code blocks → Colour theme.
 *
 *   npm run build && node --import tsx tests/e2e/code-theme-demo.mjs
 *
 * Opens a headful window with an agent step's JavaScript in the transcript and a Python script in the bench under
 * it, so every theme is seen on both surfaces at once (they share one stylesheet). It walks: the default (Atom One)
 * in a light panel; GitHub, a pair that follows the panel; Nord, dark-only, keeping its own background inside the
 * light panel; the panel switched to dark, and GitHub following it; then a VS Code theme uploaded through
 * Settings and converted — your own, if `THEME=` points at one, else the repo's fixture.
 *
 * Knobs: THEME (path to a VS Code theme .json), LINGER (ms each beat holds, default 3000), HOLD=0 to exit instead
 * of holding the window open, HEADLESS=1 for screenshots only (tests/e2e/artifacts/code-theme-demo/).
 * The assertions are code-theme.spec.mjs and tests/code-themes.test.mjs.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { configureExtension, launchExtension, narrate, narrateDone, openRunInSidebar, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LINGER = Number(process.env.LINGER ?? 3000);
const HOLD = process.env.HOLD !== "0";
const THEME = process.env.THEME || path.resolve(import.meta.dirname, "../fixtures/vscode-theme.jsonc");
const OUT = new URL("./artifacts/code-theme-demo/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const beat = async (page, text, sub) => { console.log(`\n▶ ${text}${sub ? `\n  ${sub}` : ""}`); await narrate(page, text, sub ? { sub } : undefined); };

const JS = [
    "// how many links does each host get on this page?",
    "const links = [...document.querySelectorAll('a[href]')];",
    "function host(url) { return new URL(url, location.href).hostname; }",
    "const byHost = {};",
    "for (const a of links) byHost[host(a.href)] = (byHost[host(a.href)] || 0) + 1;",
    "return { hosts: Object.keys(byHost).length, total: links.length, ok: true };",
].join("\n");
const PY = [
    "import numpy as np",
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    "class Grid:",
    "    \"\"\"A small grid of numbers.\"\"\"",
    "    rows: int = 4",
    "    cols: int = 6",
    "",
    "    def values(self, scale=1.0):",
    "        # every cell, scaled",
    "        return np.arange(self.rows * self.cols).reshape(self.rows, self.cols) * scale",
    "",
    "print(f\"total: {Grid().values(0.5).sum():.1f}\", None, True)",
].join("\n");

const fake = await startFakeLlm({ model: "fake-model" });
const ext = await launchExtension({ headful: process.env.HEADLESS !== "1" });
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}${name}.png` }); console.log(`   ${name}.png`); };

try {
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", theme: "light" });
    await ext.sw.evaluate(() => chrome.storage.local.set({ ml_bench_h: 360, ml_bench_open: false }));
    fake.setSide(() => null);
    fake.setScript([{ tool: "exec", args: { js: JS } }, { content: "Counted the links on the page." }]);
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fake.url}/api/version`);
    await waitForMl(page);

    await beat(page, "An agent step with some JavaScript, and the Python bench under it");
    await page.evaluate((js) => window.ml.agent("count the links", { approvalRouting: "both" }), JS);
    const frame = await openRunInSidebar(page, { task: "count the links" });
    for (let i = 0; i < 40; i++) {
        const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
        for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
        if (await frame.locator(".astep.tool").count()) break;
        await sleep(300);
    }
    await frame.locator('[aria-label="Python bench"]').click();
    await frame.locator(".bench-code .cm-editor").waitFor({ timeout: 15000 });
    await frame.locator(".bench-code .cm-content").fill(PY);
    await frame.locator(".bench-code .cm-content").press("Escape");

    // Settings replaces the view; Back returns to the run, the bench drawer with it.
    const settings = async () => {
        await frame.locator('button[aria-label="Settings"]').dispatchEvent("click");
        await frame.getByRole("tab", { name: "Appearance" }).or(frame.locator("button", { hasText: /^Appearance$/ })).first().click();
    };
    // The step's open state does not survive the trip to Settings, and the JavaScript in it is half the picture.
    const openStep = async () => {
        for (let i = 0; i < 10 && !(await frame.locator(".astep.tool .code").count()); i++) {
            await frame.locator(".astep.tool .astep-head").first().click();
            await sleep(200);
        }
    };
    const back = async () => {
        await frame.locator('button[aria-label="Back"], button[aria-label="Back to sessions"]').first().dispatchEvent("click");
        await frame.locator(".bench-code .cm-editor").waitFor({ timeout: 10000 });
        await openStep();
    };
    const pick = async (id, label) => {
        await settings();
        const sel = frame.locator("select.set-codetheme");
        await sel.scrollIntoViewIfNeeded();
        await sleep(LINGER / 3);
        await sel.selectOption(id);
        await sleep(LINGER / 3);
        await back();
        console.log(`   picked ${label}`);
    };
    await openStep();
    await sleep(LINGER);

    await beat(page, "The default: Atom One, drawn on the panel's own colours", "Both surfaces share one stylesheet.");
    await shot(page, "1-atom-one");
    await sleep(LINGER);

    await beat(page, "Settings → Code blocks → Colour theme → GitHub", "A light/dark pair: in a light panel it is GitHub's light theme.");
    await pick("github", "GitHub");
    await sleep(LINGER);
    await shot(page, "2-github-light");

    await beat(page, "Nord, a dark-only theme, in the same LIGHT panel", "It keeps its own background, so its light tokens stay readable.");
    await pick("nord", "Nord");
    await sleep(LINGER);
    await shot(page, "3-nord-in-light");

    await beat(page, "Now the panel goes dark, and GitHub follows it");
    await settings();
    await frame.locator("label.set-field", { hasText: /^Theme/ }).locator("select").selectOption("dark");
    await frame.locator("select.set-codetheme").selectOption("github");
    await sleep(LINGER / 3);
    await back();
    await sleep(LINGER);
    await shot(page, "4-github-dark");

    await beat(page, "Your own VS Code theme: Settings → Colour theme → VS Code theme (upload a file)",
        `${path.basename(THEME)} — converted into the same kind of stylesheet.`);
    await settings();
    const sel = frame.locator("select.set-codetheme");
    await sel.scrollIntoViewIfNeeded();
    await sel.selectOption("vscode");
    await sleep(LINGER / 2);
    await frame.locator('.set-codetheme-vscode input[type="file"]').setInputFiles(THEME);
    await frame.locator(".set-codetheme-vscode .dim").waitFor({ timeout: 10000 });
    console.log(`   loaded: ${await frame.locator(".set-codetheme-vscode .dim").innerText()}`);
    await frame.locator(".set-codetheme-vscode .set-note").scrollIntoViewIfNeeded();
    await beat(page, "It says what it loaded, and that the conversion is approximate");
    await sleep(LINGER);
    await shot(page, "5-uploaded");
    await back();
    await beat(page, "The transcript's code and the bench editor, in your theme");
    await sleep(LINGER);
    await shot(page, "6-vscode");

    await narrateDone(page, "Demo finished — Settings → Code blocks → Colour theme is yours to try");
    if (HOLD) {
        console.log("\nHolding the window open — close it or press Ctrl+C to exit.");
        await new Promise((resolve) => { page.on("close", resolve); ext.context.on("close", resolve); });
    }
} finally {
    await ext.context.close();
    await fake.stop();
}
