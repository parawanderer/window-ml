/**
 * A narrated demo, not a test: a traceback in the Python bench points into the editor, the way it points into
 * a step's code block in the log.
 *
 *   npm run build && node --import tsx tests/e2e/bench-traceback-demo.mjs
 *
 * Opens a headful window with the bench as a drawer and walks it against the real Pyodide sandbox:
 *   1. a script that fails inside a function — the failing line is marked red, its number too, and the gutter
 *      comes on (the line-number preference is off, but a traceback names a number);
 *   2. clicking the call-site frame pulses its line GREEN, the failing frame pulses RED — the log's own flash;
 *   3. two lines typed at the top: the mark and the jump FOLLOW the failing line to its new number;
 *   4. the failing line edited: nothing is marked any more, the gutter stays put, and the frame says the line
 *      has changed since the run instead of pulsing whatever sits at that number now;
 *   5. fixed and re-run: clean, and with the preference off the gutter goes;
 *   6. Settings → Appearance → Show line numbers: the preference the log's code blocks use draws the gutter.
 * Deterministic: nothing here calls a model.
 *
 * Knobs: PACE (ms between keystrokes, default 60), LINGER (ms each beat holds, default 2200), HOLD=0 to exit
 * instead of holding the window open, HEADLESS=1 to capture the screenshots without a window.
 * Screenshots land in tests/e2e/artifacts/bench-traceback-demo/. The assertions are in bench-editor.spec.mjs.
 */
import { mkdirSync } from "node:fs";
import { configureExtension, launchExtension, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.PACE ?? 60);
const LINGER = Number(process.env.LINGER ?? 2200);
const HOLD = process.env.HOLD !== "0";
const MAC = process.platform === "darwin";
const DOC_START = MAC ? "Meta+ArrowUp" : "Control+Home";
const LINE_END = MAC ? "Meta+ArrowRight" : "End";
const OUT = new URL("./artifacts/bench-traceback-demo/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** One beat: on screen for whoever is watching (the repo's demo rule), and in the terminal for the log. */
const beat = async (page, text, sub) => { console.log(`\n▶ ${text}${sub ? `\n  ${sub}` : ""}`); await narrate(page, text, sub ? { sub } : undefined); };

const fake = await startFakeLlm({ model: "fake-model" });
const ext = await launchExtension({ headful: process.env.HEADLESS !== "1" });
const shot = async (page, name) => { await page.screenshot({ path: `${OUT}${name}.png` }); console.log(`   ${name}.png`); };

const SCRIPT = [
    "import numpy as np",
    "",
    "def corner(grid):",
    "    return grid[4, 6]",
    "",
    "grid = np.arange(24).reshape(4, 6)",
    "print(grid.shape)",
    "corner(grid)",
].join("\n");

try {
    await configureExtension(ext.sw, {
        chatUrl: `${fake.url}/api/chat/completions`, apiKey: "", apiFormat: "openai",
        model: "fake-model", debugMode: "overlay",
    });
    // A tall drawer, so the editor and the traceback are both on screen with Settings above them.
    await ext.sw.evaluate(() => chrome.storage.local.set({ ml_bench_h: 620, ml_debug_codelines: false }));
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${fake.url}/api/version`);
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot, null, { timeout: 20000 });

    await beat(page, "Opening the Python bench");
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const host = root.getElementById("ml-sb-host");
        host.style.width = "640px";
        host.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    let frame = null;
    for (let i = 0; i < 80 && !frame; i++) {
        frame = page.frames().find((f) => /sidebar\.html/.test(f.url()));
        if (!frame) await sleep(100);
    }
    if (!frame) throw new Error("sidebar iframe never appeared");
    // dispatchEvent, not click(): the button's tooltip span covers its centre.
    await frame.locator('button[aria-label="Python bench"]').dispatchEvent("click");
    await frame.locator(".bench .cm-editor").waitFor({ timeout: 15000 });
    // The panel is still sliding in, on a transition outside the iframe: wait for the bench to stop moving, or
    // a click lands where the button was.
    for (let i = 0, last = null; i < 40; i++) {
        const x = (await frame.locator(".bench").boundingBox())?.x;
        if (x != null && x === last) break;
        last = x;
        await sleep(100);
    }

    const content = frame.locator(".bench-code .cm-content");
    const selectAll = MAC ? "Meta+a" : "Control+a";
    const run = async () => {
        await frame.locator(".bench-play").click();
        for (let i = 0; i < 30 && !(await frame.locator(".bench-outpane").count()); i++) await sleep(100);
        for (let i = 0; i < 150; i++) {
            if (!(await frame.locator(".bench-outpane .r-ranfor.live").count())
                && await frame.locator(".bench-play:not([disabled])").count()) return;
            await sleep(400);
        }
        throw new Error("the bench never produced a result");
    };
    /** Type into the editor line by line (top-level lines, so CodeMirror's auto-indent adds nothing). */
    const typeLines = async (text) => {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            await content.pressSequentially(lines[i], { delay: PACE });
            if (i < lines.length - 1) await content.press("Enter");
        }
    };
    const failingFrame = frame.locator(".bench-outbody .tb-fail .tb-line");
    const callFrame = frame.locator(".bench-outbody .tbline:not(.tb-fail) .tb-line").first();

    // ── 1. A FAILURE ───────────────────────────────────────────────────────────────────────────────────────
    await beat(page, "A script that fails inside a function",
        "Line numbers are OFF in Settings, so the editor starts without a gutter.");
    await content.click();
    await content.press(selectAll);
    await content.press("Backspace");
    // Filled rather than typed: CodeMirror's auto-indent would re-indent a typed function body.
    await content.fill(SCRIPT);
    await sleep(LINGER);
    await shot(page, "1-script");

    await beat(page, "Run it: the failing line is marked, and the gutter comes on for it",
        "A traceback names a number, so the numbers appear — the preference is still off.");
    await run();
    await frame.locator(".bench-code .cm-ml-fail").waitFor({ timeout: 30000 });
    await sleep(LINGER);
    await shot(page, "2-marked");

    // ── 2. CLICKING THE FRAMES ─────────────────────────────────────────────────────────────────────────────
    await beat(page, "Click the call site's frame — its line pulses GREEN", "line 8: corner(grid)");
    await callFrame.click();
    await sleep(250);
    await shot(page, "3-green");
    await sleep(LINGER);

    await beat(page, "Click the failing frame — its line pulses RED", "line 4: return grid[4, 6]");
    await failingFrame.click();
    await sleep(250);
    await shot(page, "4-red");
    await sleep(LINGER);

    // ── 3. EDITING ABOVE IT ────────────────────────────────────────────────────────────────────────────────
    await beat(page, "Typing two lines at the top, after the run…",
        "The traceback still says line 4 — it is about the code that RAN.");
    await content.click();
    await content.press(DOC_START);
    await typeLines("# scratch: find the corner\n# (4, 6) is out of range\n");
    await sleep(LINGER / 2);
    await beat(page, "…the mark FOLLOWS the failing line to its new number, 6");
    await sleep(LINGER);
    await shot(page, "5-moved");

    await beat(page, "And the traceback's \"line 4\" still lands on it", "Mapped from the code that ran to the code as it is now.");
    await failingFrame.click();
    await sleep(250);
    await shot(page, "6-red-moved");
    await sleep(LINGER);

    // ── 4. EDITING THE LINE ITSELF ─────────────────────────────────────────────────────────────────────────
    await beat(page, "Now fix the failing line itself…", "grid[4, 6] → grid[3, 5]");
    const failLine = frame.locator(".bench-code .cm-line.cm-ml-fail");
    await failLine.click();
    await content.press(LINE_END);
    for (let i = 0; i < "4, 6]".length; i++) await content.press("Backspace", { delay: PACE });
    await content.pressSequentially("3, 5]", { delay: PACE * 2 });
    await sleep(LINGER / 2);
    await beat(page, "…the mark goes (that line is no longer the one that failed); the gutter stays",
        "Dropping the gutter too would shift every line sideways under your cursor.");
    await sleep(LINGER);
    await shot(page, "7-edited");

    await beat(page, "The old traceback's frame now says so, instead of pointing at the new code");
    await failingFrame.click();
    await sleep(LINGER);
    await shot(page, "8-changed");

    // ── 5. FIXED ───────────────────────────────────────────────────────────────────────────────────────────
    await beat(page, "Run it again: it works, and with the preference off the gutter goes");
    await run();
    await sleep(LINGER);
    await shot(page, "9-fixed");

    // ── 6. THE PREFERENCE ──────────────────────────────────────────────────────────────────────────────────
    await beat(page, "Settings → Appearance → Show line numbers",
        "The same preference the log's code blocks use.");
    await frame.locator('button[aria-label="Settings"]').dispatchEvent("click");
    await frame.getByRole("tab", { name: "Appearance" }).or(frame.locator("button", { hasText: /^Appearance$/ })).first().click();
    const toggle = frame.locator("label.set-check", { hasText: "Show line numbers" });
    await toggle.scrollIntoViewIfNeeded();
    await sleep(LINGER / 2);
    await toggle.locator("input").check();
    await sleep(LINGER / 2);
    await shot(page, "10-setting");
    // Back to where Settings was opened from, and the drawer with it.
    await frame.locator('button[aria-label="Back"], button[aria-label="Back to sessions"]').first().dispatchEvent("click");
    await frame.locator(".bench .cm-editor").waitFor({ timeout: 10000 });
    await beat(page, "Back in the bench: the editor now draws its gutter with no failure at all");
    await sleep(LINGER);
    await shot(page, "11-preference");

    // Flip the banner to "yours" BEFORE holding: a watcher who cannot tell a finished demo from a paused one
    // either waits for nothing or clicks into the middle of a beat.
    await narrateDone(page, "Demo finished — the bench is yours: break something and click the traceback");
    if (HOLD) {
        console.log("\nHolding the window open — close it or press Ctrl+C to exit.");
        await new Promise((resolve) => { page.on("close", resolve); ext.context.on("close", resolve); });
    }
} finally {
    await ext.context.close();
    await fake.stop();
}
