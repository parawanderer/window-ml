/**
 * A narrated demo, not a test: what the Python bench's completion knows, with nothing kept and with kept state.
 *
 *   npm run build && node --import tsx tests/e2e/bench-completion-demo.mjs
 *
 * Opens a headful window on the bench and walks five beats against the real Pyodide sandbox and real Jedi:
 *   1. the sandbox started, NOTHING kept — the prelude's `np`/`pd`/`to_base64` still complete with no import,
 *      because completion reads the prelude in front of the script (never running it);
 *   2. a pandas call typed from pandas' stubs (`pd.read_csv('sales.csv')` — a file that does not exist, so an
 *      answer proves nothing ran);
 *   3. a Run keeps `grid`, and the environment panel lists it;
 *   4. the LIVE array completes (`grid.su` → `sum`), which static analysis cannot type — while the `pd` call
 *      from beat 2 still does, alongside the kept state;
 *   5. Reset: `grid` is gone, and the prelude's names still complete.
 * Deterministic: nothing here calls a model.
 *
 * Knobs: PACE (ms between keystrokes, default 70), LINGER (ms each popup stays up, default 2500), HOLD=0 to
 * exit instead of holding the window open, HEADLESS=1 to capture the screenshots without a window.
 * Screenshots land in tests/e2e/artifacts/bench-completion-demo/. The assertions are `tests/python.test.mjs`
 * (the completion cases) and `bench-dock.spec.mjs` (kept state through the real worker).
 */
import { mkdirSync } from "node:fs";
import { configureExtension, launchExtension, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE = Number(process.env.PACE ?? 70);
const LINGER = Number(process.env.LINGER ?? 2500);
const HOLD = process.env.HOLD !== "0";
const OUT = new URL("./artifacts/bench-completion-demo/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

/** One beat: on screen for whoever is watching (the repo's demo rule), and in the terminal for the log. */
const beat = async (page, text, sub) => { console.log(`\n▶ ${text}${sub ? `\n  ${sub}` : ""}`); await narrate(page, text, sub ? { sub } : undefined); };

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
    // Full page rather than the drawer: the environment panel is tall, and a watcher should see all of it.
    await frame.locator('button[aria-label="Expand the Python bench"]').dispatchEvent("click");
    await frame.locator(".bench .cm-editor").waitFor({ timeout: 15000 });

    const content = frame.locator(".bench-code .cm-content");
    const selectAll = process.platform === "darwin" ? "Meta+a" : "Control+a";
    // Keys go through the LOCATOR: the sidebar is an iframe inside a shadow root, so page-level typing would
    // land on the host page instead of in the editor.
    const clear = async () => { await content.click(); await content.press(selectAll); await content.press("Backspace"); };
    const type = async (text) => {
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
            await content.pressSequentially(lines[i], { delay: PACE });
            if (i < lines.length - 1) await content.press("Enter");
        }
    };
    const envOpen = async () => (await frame.locator(".bench-env.open").count()) > 0;
    /** Open or close the environment panel, and CONFIRM it: a click landing while the full-page view is still
     *  mounting is undone by that mount, so one click is not proof of anything. */
    const toggleEnv = async (open) => {
        for (let i = 0; i < 10 && (await envOpen()) !== open; i++) {
            await frame.locator(".bench-env-btn").click();
            await sleep(400);
        }
        if ((await envOpen()) !== open) throw new Error(`the environment panel would not ${open ? "open" : "close"}`);
    };

    /** Type `text`, then wait for the popup to offer `want`. The first request after the sandbox warms loads Jedi
     *  and falls back to the static list, so re-type the last character the way a person would, which asks again. */
    const offer = async (name, text, want) => {
        await clear();
        await type(text);
        const items = frame.locator(".cm-tooltip-autocomplete li");
        let got = [];
        for (let i = 0; i < 30; i++) {
            await sleep(700);
            got = await items.allTextContents();
            if (got.some((t) => t.includes(want))) break;
            await content.press("Backspace");
            await content.pressSequentially(text.at(-1), { delay: PACE });
        }
        const hit = got.some((t) => t.includes(want));
        console.log(`   offered: ${got.slice(0, 8).join(" | ") || "(nothing)"}${hit ? "" : `   ← expected ${want}`}`);
        await shot(page, name);
        await sleep(LINGER);
        await content.press("Escape");
        return hit;
    };

    // ── 1. NOTHING KEPT ─────────────────────────────────────────────────────────────────────────────────────
    await beat(page, "Starting the sandbox WITHOUT running anything",
        "The environment panel reads the interpreter, which starts Pyodide. Variables: none — nothing is kept yet.");
    await toggleEnv(true);
    await frame.locator(".bench-env-vars").waitFor({ timeout: 60000 });
    await frame.locator(".bench-env-list li").first().waitFor({ timeout: 60000 });   // the package list = warm
    await sleep(LINGER);
    await shot(page, "1-nothing-kept");
    await toggleEnv(false);

    await beat(page, "Nothing kept, no import — `np.` still completes",
        "Every bench run starts with the prelude (np, pd, Image, to_base64). Completion reads it in front of your script and never runs it.");
    await offer("2-np", "np.ara", "arange");

    await beat(page, "The same for pandas…", "pd is bound by the prelude too.");
    await offer("3-pd", "pd.read_", "read_csv");

    await beat(page, "…and the prelude's own helper");
    await offer("4-helper", "to_ba", "to_base64");

    // ── 2. A CALL'S RESULT, FROM STUBS ──────────────────────────────────────────────────────────────────────
    await beat(page, "A pandas call's result is typed from pandas' own stubs",
        "sales.csv does not exist — if this were run it would raise, so an answer means it was inferred.");
    await offer("5-read-csv", "df = pd.read_csv('sales.csv')\ndf.he", "head");

    // ── 3. KEEP SOMETHING ───────────────────────────────────────────────────────────────────────────────────
    await beat(page, "Now run a script — its top-level names are KEPT for the next run");
    await clear();
    await type("grid = np.arange(24).reshape(4, 6)\ngrid.sum()");
    await frame.locator(".bench-play").click();
    for (let i = 0; i < 30 && !(await frame.locator(".bench-outpane").count()); i++) await sleep(100);
    for (let i = 0; i < 100; i++) {
        if (!(await frame.locator(".bench-outpane .r-ranfor.live").count())
            && await frame.locator(".bench-play:not([disabled])").count()) break;
        await sleep(400);
    }
    console.log(`   result: ${(await frame.locator(".bench-outbody").innerText()).replace(/\s+/g, " ").trim()}`);
    await toggleEnv(true);
    await frame.locator(".bench-env-vars li", { hasText: "grid" }).waitFor({ timeout: 10000 });
    await beat(page, "The environment panel lists what is kept: grid, an ndarray");
    await sleep(LINGER);
    await shot(page, "6-kept");
    await toggleEnv(false);

    // ── 4. THE LIVE OBJECT ──────────────────────────────────────────────────────────────────────────────────
    await beat(page, "The kept array completes from the LIVE object",
        "Static analysis cannot type a numpy call's result (Jedi vs numpy 2's stubs) — the kept namespace can.");
    await offer("7-live", "grid.su", "sum");

    await beat(page, "…and kept state costs nothing: the pandas call is still typed",
        "A live pd from the namespace has no stubs for a call's result; the prelude read in front of the script does.");
    await offer("8-stubs-with-state", "df = pd.read_csv('sales.csv')\ndf.he", "head");

    // ── 5. RESET ────────────────────────────────────────────────────────────────────────────────────────────
    await beat(page, "Reset forgets what was kept");
    await toggleEnv(true);
    await frame.locator(".bench-env-reset").click();
    await frame.locator(".bench-env-vars-none").waitFor({ timeout: 10000 });
    await sleep(LINGER);
    await shot(page, "9-reset");
    await toggleEnv(false);

    await beat(page, "After the reset, grid. has nothing to offer…", "It was only ever in the kept namespace.");
    await clear();
    await type("grid.su");
    await sleep(LINGER);
    const after = await frame.locator(".cm-tooltip-autocomplete li").allTextContents();
    console.log(`   offered: ${after.join(" | ") || "(nothing)"}`);
    await shot(page, "10-grid-gone");
    await content.press("Escape");

    await beat(page, "…and the prelude's names still complete, exactly as before anything was kept");
    await offer("11-np-again", "np.lin", "linspace");

    await clear();
    // Flip the banner to "yours" BEFORE holding: a watcher who cannot tell a finished demo from a paused one
    // either waits for nothing or clicks into the middle of a beat.
    await narrateDone(page, "Demo finished — the bench is yours: try np., pd., or run something and complete it");
    if (HOLD) {
        console.log("\nHolding the window open — close it or press Ctrl+C to exit.");
        await new Promise((resolve) => { page.on("close", resolve); ext.context.on("close", resolve); });
    }
} finally {
    await ext.context.close();
    await fake.stop();
}
