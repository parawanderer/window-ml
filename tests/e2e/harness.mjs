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
export async function launchExtension(/** @type {{ headful?: boolean, dist?: string, args?: string[] }} */ { dist, headful, args = [] } = {}) {
    // `E2E_DIST` runs a whole spec against a bundle built ELSEWHERE (`node build.mjs --outdir <dir>`), so a suite
    // can test a change while `dist/` is still loaded in a window someone is using — rebuilding it underneath a
    // live extension is exactly the hazard the build rule warns about.
    const DIST = dist ? path.resolve(dist) : process.env.E2E_DIST ? path.resolve(process.env.E2E_DIST) : DEFAULT_DIST;
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
            // Extra switches for one spec, e.g. `--host-resolver-rules` so several hostnames reach one local server
            // as distinct origins (tests/e2e/site-access.spec.mjs).
            ...args,
        ],
    });
    // The background service worker registers on load; wait for it if it hasn't appeared yet.
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
    const extensionId = new URL(sw.url()).host;
    return { context, sw, extensionId, close: () => context.close() };
}

/**
 * Minimise or restore the window `page` is in (CDP `Browser.setWindowBounds`), for a headful browser that should stay out
 * of the way until someone asks to see it (a held bench run, bench/hold.mjs). macOS keeps part of an off-screen window
 * on screen, so out of the way means minimised. A minimised page still reports itself visible: the run is unchanged.
 * @param {"minimized" | "normal"} state
 */
export async function setWindow(/** @type {any} */ context, /** @type {any} */ page, state) {
    const cdp = await context.newCDPSession(page);
    try {
        const { windowId } = await cdp.send("Browser.getWindowForTarget");
        await cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState: state } });
        if (state === "normal") await page.bringToFront();
    } finally { await cdp.detach().catch(() => {}); }
}

/**
 * Stream what a browser shows, as JPEG frames (CDP `Page.startScreencast`), headless or not: for watching a held bench
 * run on the bench page (bench/hold.mjs). It streams the newest page of `context` that is not the extension's own, and
 * moves to a page opened later (the agent can open a tab mid-run) and back when that one closes. Chrome sends a frame
 * when the page repaints and waits for each to be acknowledged, so a page that does not change costs nothing, and
 * `onFrame` is awaited before the ack: a slow consumer slows the stream rather than queueing frames.
 * @param {(jpeg: Buffer, meta: { width: number, height: number, url: string }) => void | Promise<void>} onFrame
 * @returns {Promise<() => Promise<void>>} stops the stream
 */
export async function screencast(/** @type {any} */ context, onFrame, { maxWidth = 1280, maxHeight = 900, quality = 60 } = {}) {
    let /** @type {any} */ cdp = null, stopped = false;
    const ours = (/** @type {any} */ p) => p.url().startsWith("chrome-extension://");
    const pick = () => context.pages().filter((/** @type {any} */ p) => !ours(p) && !p.isClosed()).at(-1);
    const attach = async (/** @type {any} */ page) => {
        const prev = cdp;
        cdp = null;
        if (prev) { await prev.send("Page.stopScreencast").catch(() => {}); await prev.detach().catch(() => {}); }
        if (!page || stopped) return;
        const s = await context.newCDPSession(page);
        cdp = s;
        s.on("Page.screencastFrame", async (/** @type {any} */ f) => {
            try { await onFrame(Buffer.from(f.data, "base64"), { width: f.metadata.deviceWidth, height: f.metadata.deviceHeight, url: page.url() }); }
            catch { /* a consumer's failure must not stop the stream */ }
            await s.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
        });
        await s.send("Page.startScreencast", { format: "jpeg", quality, maxWidth, maxHeight });
    };
    const back = () => { if (!stopped) attach(pick()).catch(() => {}); };
    const onPage = (/** @type {any} */ p) => { p.once("close", back); if (!ours(p)) attach(p).catch(() => {}); };
    for (const p of context.pages()) p.once("close", back);
    context.on("page", onPage);
    await attach(pick());
    return async () => {
        stopped = true;
        context.off("page", onPage);
        await attach(null);
    };
}

/** Write the extension's non-secret config (chatUrl / apiFormat / model / debugMode …) via the SW. */
export async function configureExtension(/** @type {any} */ sw, /** @type {Record<string, unknown>} */ config) {
    await sw.evaluate((/** @type {any} */ cfg) => new Promise((r) => chrome.storage.sync.set(cfg, () => r(undefined))), config);
}

/**
 * Put an origin on the extension's approved list ("always"), as a person allowing the site from the toolbar would.
 * Every page-started message is refused for an origin that is not on it (docs/spec/SITE_ACCESS.md).
 * @param {any} sw the extension's service worker
 * @param {string} origin e.g. `http://127.0.0.1:43210`
 */
export async function approveOrigin(sw, origin) {
    await sw.evaluate(async (/** @type {string} */ o) => {
        const got = await chrome.storage.local.get("ml_site_always");
        const list = Array.isArray(got.ml_site_always) ? /** @type {string[]} */ (got.ml_site_always) : [];
        if (!list.includes(o)) await chrome.storage.local.set({ ml_site_always: [...list, o] });
    }, origin);
}

/**
 * Resolve when `window.ml` is live in the page's MAIN world (injected.js has fired ml:ready). By default it also
 * APPROVES the page's origin first, because a spec that calls `window.ml` from its page is testing what happens once
 * a person has allowed that site. `{ approve: false }` leaves the page unapproved, for a spec about the gate itself.
 * @param {any} page the page
 * @param {{ approve?: boolean }} [opts]
 */
export async function waitForMl(page, { approve = true } = {}) {
    if (approve) {
        const sw = page.context().serviceWorkers()[0];
        const origin = new URL(page.url()).origin;
        if (sw && /^https?:/.test(origin)) await approveOrigin(sw, origin);
    }
    // Cast, because this function is SERIALIZED and evaluated in the page: `window.ml` is installed there
    // by injected.js at runtime, and no ambient declaration in this project covers it (the extension's own
    // types describe the API's shape, not its presence on a page's window). A type here would be a claim
    // about another realm either way.
    await page.waitForFunction(() => { const w = /** @type {any} */ (window); return !!(w.ml && w.ml.ready); }, null, { timeout: 15000 });
}

/**
 * WATCH A TAB'S RUN EVENTS from outside the page, the way the DevTools panel does: an extension page holds the
 * `ml-devtools` port for `page`'s tab and hands every event to `onEvent`, in Node, in the order it was fanned.
 *
 * The worker's events for a run never reach the page's window (docs/spec/SITE_ACCESS.md, attack 15), so a spec that
 * listened there for a background run's steps listens here instead. The worker fans a run's events to this port
 * whatever the debug mode. The page's OWN events (a run or chat the page hosts) still go to its window, and come here
 * too only in `debugMode: "devtools"`.
 * @param {any} ext the launched extension (`launchExtension`'s result)
 * @param {any} page the page whose tab to watch; resolved to its tab by URL, so call it once the page has loaded
 * @param {(ev: any) => void} onEvent called once per event: the tab's buffered events first, then each new one
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function watchRunEvents(ext, page, onEvent) {
    const url = page.url();
    const tabId = await ext.sw.evaluate(async (/** @type {string} */ u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? null, url);
    if (tabId == null) throw new Error(`no tab is on ${url}`);
    const watcher = await ext.context.newPage();
    await watcher.exposeFunction("__onRunEvent", (/** @type {any} */ ev) => onEvent(ev));
    await watcher.goto(`chrome-extension://${ext.extensionId}/popup.html`);
    await watcher.evaluate((/** @type {number} */ id) => new Promise((resolve) => {
        const w = /** @type {any} */ (window);
        const port = chrome.runtime.connect({ name: "ml-devtools" });
        port.onMessage.addListener((/** @type {any} */ m) => {
            if (Array.isArray(m.replay)) { for (const ev of m.replay) w.__onRunEvent(ev); resolve(undefined); }
            else if (m.__mlDebug) w.__onRunEvent(m.__mlDebug);
        });
        port.postMessage({ type: "ml-devtools-init", tabId: id });
    }), tabId);
    await page.bringToFront();   // the run's tab stays the active one, as it was before the watcher opened
    return { close: () => watcher.close() };
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
        (root.getElementById("ml-sb-host").classList.remove("open"), root.getElementById("ml-sb-tab").click());
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
 *
 *  IT ALSO SAYS WHETHER THE DEMO IS STILL DRIVING. A headful demo takes the pointer and the keyboard, and a
 *  watcher who cannot tell a finished demo from a paused one does not know whether the window is theirs to
 *  touch — so they wait, or they interfere mid-beat. Every `narrate` marks it as running; `narrateDone`
 *  flips it when the demo has stopped acting (call it before the hold, not after the last beat), which is
 *  also the only moment the banner is worth a colour.
 */
export async function narrate(/** @type {any} */ page, /** @type {string|null} */ text,
                              /** @type {{ sub?: string, done?: boolean }} */ { sub = "", done = false } = {}) {
    await page.evaluate((/** @type {[string|null, string, boolean]} */ [t, s, fin]) => {
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
        el.style.borderColor = fin ? "rgba(74,222,128,.55)" : "rgba(255,255,255,.14)";
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
        // WHOSE WINDOW IS IT. Last, and set on every beat, so it cannot be left saying "running" by a demo
        // that forgot to update it — the only way it reads "finished" is `narrateDone`.
        const status = document.createElement("div");
        status.style.cssText = "margin-top: 8px; padding-top: 7px; font-weight: 600; font-size: 11.5px;"
            + " letter-spacing: .02em; border-top: 1px solid rgba(255,255,255,.14);"
            + " color: " + (fin ? "#4ade80" : "#fbbf24") + ";";
        status.textContent = fin
            ? "\u25cf  demo finished \u2014 the browser is yours"
            : "\u25cf  demo running \u2014 it is driving the pointer and keyboard";
        el.append(status);
    }, [text ?? null, sub, done]);
}

/** THE DEMO HAS STOPPED ACTING — flip the banner so the watcher knows the window is theirs. Call it just
 *  before holding the browser open (or before exiting), never after the last beat's `narrate`, which sets
 *  the status back to running. */
export async function narrateDone(/** @type {any} */ page, /** @type {string} */ text = "Demo finished",
                                  /** @type {{ sub?: string }} */ { sub = "Nothing else will move. Click around \u2014 close the window or Ctrl+C to exit." } = {}) {
    await narrate(page, text, { sub, done: true });
}
