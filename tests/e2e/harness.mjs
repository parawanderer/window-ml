// harness.mjs — load the UNPACKED extension in a real Chromium and reach its pieces.
//
// This is the heavy, browser-lifecycle layer that jsdom can't represent (full navigations, content-script
// re-injection, the MV3 service worker). Keep E2E rare — only for behaviour that genuinely needs a real
// browser (see CLAUDE.md "End-to-end tests"). Everything else stays in the fast node:test/jsdom suite.
//
// An MV3 extension only loads with a PERSISTENT context + --load-extension (and needs the FULL browser, not
// the headless shell — see launchExtension). `dist/` must be built first (pretest:e2e).

import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist");

/**
 * Launch Chromium with the built extension. Returns { context, sw, extensionId, close }.
 *
 * `dist` loads a DIFFERENT build directory than `dist/` — how the bench runs an experimental variant
 * (an esbuild `--define`d build in its own outdir) without the experiment ever becoming a product flag.
 */
export async function launchExtension(/** @type {{ headful?: boolean, dist?: string }} */ { dist, headful } = {}) {
    const DIST = dist ? path.resolve(dist) : DEFAULT_DIST;
    const context = await chromium.launchPersistentContext("", {
        // HEADLESS by default, via `channel: "chromium"`.
        //
        // This used to be headful, on the finding that an MV3 service worker does not register under
        // headless Chromium. That finding was real but narrower than it read: `headless: true` alone runs
        // the headless SHELL, a separate stripped binary with no extension support at all. `channel:
        // "chromium"` runs the FULL browser in --headless=new, where the worker registers fine — measured
        // at ~0.5s, and the whole e2e suite passes. A headful window steals focus and the mouse on every
        // launch, which for a suite that launches one per spec makes the machine unusable while it runs.
        //
        // Headful on request: `headful: true` from a caller that exists to be WATCHED (observe's WATCH,
        // the narrated demos), or E2E_HEADFUL=1 for a one-off look at a test.
        headless: !(headful || process.env.E2E_HEADFUL === "1"),
        channel: "chromium",
        args: [
            `--disable-extensions-except=${DIST}`,
            `--load-extension=${DIST}`,
            "--no-first-run",
            "--no-default-browser-check",
        ],
    });
    // The background service worker registers on load; wait for it if it hasn't appeared yet.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;
    return { context, sw, extensionId, close: () => context.close() };
}

/** Write the extension's non-secret config (chatUrl / apiFormat / model / debugMode …) via the SW. */
export async function configureExtension(/** @type {any} */ sw, /** @type {Record<string, unknown>} */ config) {
    await sw.evaluate((/** @type {any} */ cfg) => new Promise((r) => chrome.storage.sync.set(cfg, () => r(undefined))), config);
}

/** Resolve when `window.ml` is live in the page's MAIN world (injected.js has fired ml:ready). */
export async function waitForMl(/** @type {any} */ page) {
    // Cast, because this function is SERIALIZED and evaluated in the page: `window.ml` is installed there
    // by injected.js at runtime, and no ambient declaration in this project covers it (the extension's own
    // types describe the API's shape, not its presence on a page's window). A type here would be a claim
    // about another realm either way.
    await page.waitForFunction(() => { const w = /** @type {any} */ (window); return !!(w.ml && w.ml.ready); }, null, { timeout: 15000 });
}

/**
 * OPEN THE SIDEBAR AND THE RUN INSIDE IT, and return the sidebar frame.
 *
 * The panel opens on the SESSIONS LIST, not on the run — so a demo or probe that slides the sidebar open and
 * then queries the transcript finds nothing, reads zero of everything, and reports that the feature does not
 * work. That is a mistake every demo here has made at least once, which is why it lives in the harness rather
 * than being written out again each time.
 *
 * @param {any} page      the page the run was started on
 * @param {object} [opts]
 * @param {number} [opts.width]  sidebar width in px (default: 55% of the viewport)
 * @param {string|RegExp} [opts.task]  pick the session by its task text (default: the first one)
 * @param {number} [opts.timeout]
 * @returns {Promise<any>} the sidebar iframe, showing the run's detail view
 */
export async function openRunInSidebar(page, { width, task, timeout = 20000 } = {}) {
    const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
    await page.waitForFunction(
        () => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"),
        null, { timeout });
    await page.evaluate((/** @type {number|undefined} */ w) => {
        const root = /** @type {any} */ (document.getElementById("ml-sb-root")).shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = `${w || Math.round(window.innerWidth * 0.55)}px`;
        panel.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    }, width);
    const frame = await (async () => {
        for (let i = 0; i < Math.ceil(timeout / 100); i++) {
            const f = page.frames().find((/** @type {any} */ fr) => /sidebar\.html/.test(fr.url()));
            if (f) return f;
            await sleep(100);
        }
        throw new Error("the sidebar iframe never appeared");
    })();
    // THE CLICK that everyone forgets. A row appears as soon as the run starts, so this does not wait for the
    // run to finish — which is the point, since the interesting demos are about what happens while it runs.
    const rows = task ? frame.locator(".row", { hasText: task }) : frame.locator(".row");
    for (let i = 0; i < Math.ceil(timeout / 200); i++) {
        if (await rows.count()) break;
        await sleep(200);
    }
    if (!(await rows.count())) throw new Error(`no session row to open${task ? ` matching ${task}` : ""}`);
    // CLICK UNTIL IT NAVIGATES. The list re-renders as the run emits, so a single click can land on a row
    // that is replaced before the handler runs — leaving the panel on the list and every later assertion
    // reading an empty transcript, which is the failure this helper exists to prevent.
    for (let i = 0; i < Math.ceil(timeout / 400); i++) {
        if (await frame.locator(".astep, .msg, .aturn-prose").count()) return frame;
        await rows.first().click().catch(() => {});
        await sleep(400);
    }
    const seen = await frame.evaluate(() => ({
        classes: [...new Set([...document.querySelectorAll("body *")].map((e) => e.className).filter((c) => typeof c === "string" && c))].slice(0, 40),
        text: document.body.innerText.slice(0, 300),
    })).catch(() => null);
    throw new Error(`clicked the session row but the detail view never rendered — saw: ${JSON.stringify(seen)}`);
}

/** SAY WHAT THE DEMO IS DOING, on screen. A narrated demo is watched, and a watcher who cannot tell which
 *  beat is running is left inferring it from what moved — which is exactly backwards when the point of the
 *  beat is that something DIDN'T move. (Debugging the sideways-find beat, the terminal said 0px and the
 *  screen said nothing at all; the banner is the difference between "which step is this" and reading the
 *  script alongside the window.)
 *
 *  Drawn in the PAGE, top-left, in its own element with a very high z-index — deliberately not in the
 *  extension's shadow hosts, so it can never be mistaken for part of the product being demonstrated, and so
 *  a demo about the sidebar cannot have its narration hidden by the sidebar. Re-created if a navigation
 *  wiped it, since half these demos navigate.
 *
 *  `narrate(page, null)` clears it — for the screenshot that should show the product alone.
 */
export async function narrate(/** @type {any} */ page, /** @type {string|null} */ text,
                              /** @type {{ sub?: string }} */ { sub = "" } = {}) {
    await page.evaluate((/** @type {[string|null, string]} */ [t, s]) => {
        const ID = "ml-demo-narration";
        let el = document.getElementById(ID);
        if (t == null) { el?.remove(); return; }
        if (!el) {
            el = document.createElement("div");
            el.id = ID;
            // `all: initial` first: this lands on arbitrary pages, and a site's own `div { … }` rule would
            // otherwise restyle the narration into something unreadable.
            el.style.cssText = "all: initial; position: fixed; top: 14px; left: 14px; z-index: 2147483647;"
                + " max-width: 46ch; padding: 10px 14px; border-radius: 10px; pointer-events: none;"
                + " font: 600 14px/1.45 ui-sans-serif, system-ui, -apple-system, sans-serif;"
                + " color: #fff; background: rgba(17,17,20,.92); box-shadow: 0 6px 24px rgba(0,0,0,.4);"
                + " border: 1px solid rgba(255,255,255,.14); white-space: pre-wrap;";
            (document.documentElement || document.body).append(el);
        }
        el.textContent = "";
        const main = document.createElement("div");
        main.textContent = t;
        el.append(main);
        if (s) {
            const note = document.createElement("div");
            note.style.cssText = "margin-top: 5px; font-weight: 400; font-size: 12.5px; opacity: .72;";
            note.textContent = s;
            el.append(note);
        }
    }, [text ?? null, sub]);
}
