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
 * Turn on "Allow in Incognito" for the loaded extension, as its chrome://extensions toggle does, and return the new
 * worker. Chrome disables the extension to apply it and, for one loaded with `--load-extension`, leaves it disabled
 * (a reload does not bring it back), so it is enabled again here; that starts a fresh worker.
 */
async function allowIncognito(/** @type {import("@playwright/test").BrowserContext} */ context, /** @type {string} */ extensionId) {
    const page = await context.newPage();
    try {
        await page.goto("chrome://extensions");
        const err = await page.evaluate(async (/** @type {string} */ id) => {
            // chrome://extensions' own API, which the extension types do not describe.
            const dev = /** @type {any} */ (chrome).developerPrivate;
            /** @returns {Promise<{ error?: string, v?: any }>} */
            const call = (/** @type {Function} */ fn, /** @type {any[]} */ ...args) => new Promise((resolve) => fn(...args, (/** @type {any} */ v) => resolve(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : { v })));
            const set = await call(dev.updateExtensionConfiguration, { extensionId: id, incognitoAccess: true });
            if (set.error) return set.error;
            // The toggle disables the extension to apply itself; enabling it before that lands is undone by it.
            for (let i = 0; i < 100; i++) {
                const info = await call(dev.getExtensionInfo, id);
                if (info.v?.state === "DISABLED" && info.v.incognitoAccess?.isActive) return null;
                await new Promise((r) => setTimeout(r, 50));
            }
            return "it was never disabled to apply the setting";
        }, extensionId);
        if (err) throw new Error(`could not allow the extension in incognito: ${err}`);
        const fresh = context.waitForEvent("serviceworker", { timeout: 15000 });
        const enable = await page.evaluate((/** @type {string} */ id) => new Promise((resolve) => chrome.management.setEnabled(id, true, () => resolve(chrome.runtime.lastError?.message ?? null))), extensionId);
        if (enable) throw new Error(`could not enable the extension again: ${enable}`);
        const sw = await fresh;
        if (!(await sw.evaluate(() => new Promise((r) => chrome.extension.isAllowedIncognitoAccess(r))))) throw new Error("the extension came back without incognito access");
        return sw;
    } finally {
        await page.close().catch(() => {});
    }
}

/**
 * Launch Chromium with the built extension. Returns { context, sw, extensionId, close }.
 *
 * `dist` loads a DIFFERENT build directory than `dist/` — how the bench runs an experimental variant
 * (an esbuild `--define`d build in its own outdir) without the experiment ever becoming a product flag.
 *
 * `incognito` turns on "Allow in Incognito", which a fresh install has off (and so does every launch without it): a
 * private rendered fetch needs it. The returned `sw` is then the worker of the re-enabled extension.
 *
 * `userDataDir` reuses a profile: launch, close, and launch again on the same directory to test what survives a
 * closed browser (IndexedDB, storage). Absent, every launch is a fresh temporary profile.
 */
export async function launchExtension(/** @type {{ headful?: boolean, dist?: string, args?: string[], incognito?: boolean, userDataDir?: string }} */ { dist, headful, args = [], incognito = false, userDataDir = "" } = {}) {
    // `E2E_DIST` runs a whole spec against a bundle built ELSEWHERE (`node build.mjs --outdir <dir>`), so a suite
    // can test a change while `dist/` is still loaded in a window someone is using — rebuilding it underneath a
    // live extension is exactly the hazard the build rule warns about.
    const DIST = dist ? path.resolve(dist) : process.env.E2E_DIST ? path.resolve(process.env.E2E_DIST) : DEFAULT_DIST;
    const context = await chromium.launchPersistentContext(userDataDir, {
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
    if (incognito) sw = await allowIncognito(context, extensionId);
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
    // The self-approval list is kept by origin in local storage since slice 3, and the worker read the old sync setting
    // once, at its start: a spec that names `pageApprovalDomains` means that list, so it is written there as origins.
    if (Array.isArray(config.pageApprovalDomains)) {
        // Wait for the one-time site-list migration to finish first: it reads `pageApprovalDomains` and writes
        // `ml_site_selfapprove`, and a direct write here that races it can be overwritten with the migration's
        // earlier (empty) read.
        await sw.evaluate(() => /** @type {any} */ (globalThis)._siteSchemaReady?.() ?? Promise.resolve());
        const origins = await sw.evaluate(async (/** @type {string[]} */ entries) => {
            const origins = entries.map((e) => { try { return new URL(/:\/\//.test(e) ? e : `https://${e}`).origin; } catch { return null; } }).filter(Boolean);
            await chrome.storage.local.set({ ml_site_selfapprove: [...new Set(origins)].sort() });
            return /** @type {string[]} */ (origins);
        }, config.pageApprovalDomains);
        // A self-approved origin may use window.ml, so the worker registers its page scripts on this change, after the
        // write returns (sw-presence.ts). A spec that reloads next must not race it: a document that loads before the
        // registration gets no page script at document_start, and the worker's one-shot catch-up (`showInOpenTabs`)
        // can run before that document's content script answers, which left `waitForMl` waiting its 15 s
        // (session-index.spec.mjs:59, value-store.spec.mjs:176 on CI, 2026-10-27).
        await awaitPageScriptRegistration(sw, origins);
    }
}

/**
 * Wait until the worker's main-world registration covers each origin (sw-presence.ts `syncPresence`): the state a
 * navigation to the origin depends on, not a delay. Fails at its deadline instead of going on, so a registration that
 * never comes is named here and not as a `window.ml` that never appears downstream.
 * @param {any} sw the extension's service worker
 * @param {string[]} origins the origins, as `new URL(x).origin` writes them
 * @param {number} timeout ms to wait
 */
export async function awaitPageScriptRegistration(sw, origins, timeout = 15000) {
    const missing = await sw.evaluate(async (/** @type {[string[], number]} */ [list, ms]) => {
        // The worker's own pattern rule (site-access.ts `originMatchPattern`): the port is always written.
        const pattern = (/** @type {string} */ o) => { const u = new URL(o); return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}/*`; };
        const want = list.map(pattern);
        const deadline = Date.now() + ms;
        for (;;) {
            const have = (await chrome.scripting.getRegisteredContentScripts()).flatMap((r) => r.matches ?? []);
            const left = want.filter((p) => !have.includes(p));
            if (!left.length || Date.now() > deadline) return left;
            await new Promise((r) => setTimeout(r, 20));
        }
    }, [origins, timeout]);
    if (missing.length) throw new Error(`the worker never registered the page scripts for ${missing.join(", ")} within ${timeout} ms`);
}

/**
 * The URL a web page must use to load one of the extension's web-accessible files (`sidebar.html`, `mermaid.html`):
 * its per-session id (`use_dynamic_url`, manifest.json), which the worker's `getURL` names. The extension's own id no
 * longer loads them into a page, so an attack that frames one stands for a page that LEARNED this URL. The document
 * loaded from it still reports the extension's own id as its URL.
 * @param {any} sw the extension's service worker
 * @param {string} file the web-accessible file
 * @returns {Promise<string>}
 */
export async function warUrl(sw, file) {
    return sw.evaluate((/** @type {string} */ f) => chrome.runtime.getURL(f), file);
}

/**
 * Put an origin on the extension's approved list ("always"), as a person allowing the site from the toolbar would.
 * Every page-started message is refused for an origin that is not on it (docs/spec/SITE_ACCESS.md). It may also start
 * agents without a card (`agents: "always"`), since a spec that calls `ml.agent` is about the run, not the agent level;
 * pass another level, or `null` for none, for a spec about the level itself.
 * @param {any} sw the extension's service worker
 * @param {string} origin e.g. `http://127.0.0.1:43210`
 * @param {{ agents?: "ask" | "always" | "denied" | null }} [opts]
 */
export async function approveOrigin(sw, origin, { agents = "always" } = {}) {
    await sw.evaluate(async (/** @type {[string, string | null]} */ [o, level]) => {
        const got = await chrome.storage.local.get(["ml_site_always", "ml_site_agents"]);
        const list = Array.isArray(got.ml_site_always) ? /** @type {string[]} */ (got.ml_site_always) : [];
        if (!list.includes(o)) await chrome.storage.local.set({ ml_site_always: [...list, o] });
        const levels = /** @type {Record<string, string>} */ (got.ml_site_agents && typeof got.ml_site_agents === "object" ? got.ml_site_agents : {});
        if (level && levels[o] !== level) await chrome.storage.local.set({ ml_site_agents: { ...levels, [o]: level } });
        if (!level && o in levels) { const { [o]: _drop, ...rest } = levels; await chrome.storage.local.set({ ml_site_agents: rest }); }
    }, [origin, agents]);
    // The worker registers the page scripts for the origin on the change (sw-presence.ts); wait for it, so a page
    // opened next is covered from its first navigation. A deadline that passes is an error, never a pass.
    await awaitPageScriptRegistration(sw, [origin]);
}

/**
 * Resolve when `window.ml` is live in the page's MAIN world (injected.js has fired ml:ready). By default it also
 * APPROVES the page's origin first, because a spec that calls `window.ml` from its page is testing what happens once
 * a person has allowed that site. `{ approve: false }` leaves the page unapproved, for a spec about the gate itself or
 * a run the person starts there. An unapproved page is HIDDEN (docs/spec/SITE_PRESENCE.md): it has no `window.ml`,
 * so this waits for the content script's gate to be decided instead, and for `window.ml` only if it opened.
 * @param {any} page the page
 * @param {{ approve?: boolean }} [opts]
 */
export async function waitForMl(page, { approve = true } = {}) {
    if (approve) {
        // The newest: a relaunched extension (launchExtension's `incognito`) leaves its old, dead worker listed first.
        const sw = page.context().serviceWorkers().at(-1);
        const origin = new URL(page.url()).origin;
        if (sw && /^https?:/.test(origin)) await approveOrigin(sw, origin);
    }
    // Cast, because this function is SERIALIZED and evaluated in the page: `window.ml` is installed there
    // by injected.js at runtime, and no ambient declaration in this project covers it (the extension's own
    // types describe the API's shape, not its presence on a page's window). A type here would be a claim
    // about another realm either way.
    if (!approve) {
        const state = await waitInShell(page, () => { const s = /** @type {any} */ (globalThis).__mlPageGate?.state; return s && s !== "pending" ? s : null; });
        if (state !== "open") return;
    }
    await page.waitForFunction(() => { const w = /** @type {any} */ (window); return !!(w.ml && w.ml.ready); }, null, { timeout: 15000 });
}

/** One CDP session per page and the execution contexts it has seen, for {@link inShell}. */
const shellSessions = new WeakMap();

/**
 * The CDP session and context id of the content script's ISOLATED world in `page`'s top frame: the one non-default
 * context whose global has the shell's `__wmlShellRoots` hook. Waits for it, since the content script loads late.
 * @param {any} page the page
 * @param {number} timeout ms to wait for the content script
 * @returns {Promise<{ cdp: any, ctxs: Map<number, any>, id: number | null }>}
 */
async function shellContext(page, timeout) {
    let s = shellSessions.get(page);
    if (!s) {
        const cdp = await page.context().newCDPSession(page);
        /** @type {Map<number, any>} */
        const ctxs = new Map();
        cdp.on("Runtime.executionContextCreated", (/** @type {any} */ e) => ctxs.set(e.context.id, e.context));
        cdp.on("Runtime.executionContextDestroyed", (/** @type {any} */ e) => ctxs.delete(e.executionContextId));
        cdp.on("Runtime.executionContextsCleared", () => ctxs.clear());
        await cdp.send("Runtime.enable");
        s = { cdp, ctxs, id: null };
        shellSessions.set(page, s);
    }
    const deadline = Date.now() + timeout;
    for (;;) {
        if (s.id != null && s.ctxs.has(s.id)) return s;
        s.id = null;
        const { frameTree } = await s.cdp.send("Page.getFrameTree");
        for (const c of s.ctxs.values()) {
            if (c.auxData?.frameId !== frameTree.frame.id || c.auxData?.isDefault) continue;
            const r = await s.cdp.send("Runtime.evaluate", { contextId: c.id, expression: "typeof globalThis.__wmlShellRoots", returnByValue: true }).catch(() => null);
            if (r?.result?.value === "function") { s.id = c.id; return s; }
        }
        if (Date.now() > deadline) throw new Error("inShell: no content-script world with the shell's hook on this page (is the extension loaded on it?)");
        await new Promise((r) => setTimeout(r, 100));
    }
}

/**
 * RUN `fn` WHERE THE SHELL LIVES: the content script's isolated world of `page`'s top frame, which shares the page's DOM
 * but none of its JS objects. `fn(roots, arg)` gets `{ sidebar, card, highlight, highlightTag }`, the shell's shadow roots (null when
 * not mounted), and its result comes back by value (JSON), like `page.evaluate`'s.
 *
 * The roots are CLOSED, so `host.shadowRoot` is null in every world and Playwright's selectors do not enter them: this
 * is how a test reaches our UI. It reaches the shell's `__wmlShellRoots` hook over CDP (`Runtime.evaluate` with the
 * isolated world's context id), which the page's main world has no way to name. `fn` is serialized, so it closes over
 * nothing: pass what it needs as `arg`.
 * @template T
 * @param {any} page the page
 * @param {(roots: { sidebar: ShadowRoot | null, card: ShadowRoot | null, highlight: ShadowRoot | null, highlightTag: string }, arg: any) => T | Promise<T>} fn
 * @param {any} [arg] JSON-serializable
 * @param {{ timeout?: number }} [opts] how long to wait for the content script (default 15 s)
 * @returns {Promise<T>}
 */
export async function inShell(page, fn, arg, { timeout = 15000 } = {}) {
    const expression = `(async () => (${fn.toString()})(globalThis.__wmlShellRoots(), ${arg === undefined ? "undefined" : JSON.stringify(arg)}))()`;
    for (let attempt = 0; ; attempt++) {
        const s = await shellContext(page, timeout);
        const r = await s.cdp.send("Runtime.evaluate", { contextId: s.id, expression, awaitPromise: true, returnByValue: true })
            .catch((/** @type {any} */ e) => ({ lost: e }));
        // The page navigated between finding the world and using it: find the new one, once.
        if ("lost" in r) { if (attempt === 0 && /context/i.test(String(r.lost?.message))) { s.id = null; continue; } throw r.lost; }
        if (r.exceptionDetails) throw new Error(`inShell: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
    }
}

/**
 * RUN `fn` AT THE CONTENT SCRIPT'S END OF THE PAGE CHANNEL (`page-channel.ts`), where a test stands in for either end:
 * `ch.asInjected(data)` delivers `data` to the content scripts as if injected.js had sent it (a `__mlDebug` event, a
 * sidebar shot ack), and `ch.asIsolated(data)` sends `data` down the port to injected.js as the sidebar would (a
 * `__mlSessionSend`). A window `postMessage` from the page reaches neither, which is the point of the channel.
 * `fn(ch, arg)` is serialized like {@link inShell}'s; `asIsolated` throws while injected.js holds no port.
 * @template T
 * @param {any} page the page
 * @param {(ch: { asInjected: (data: any) => void, asIsolated: (data: any) => void }, arg: any) => T | Promise<T>} fn
 * @param {any} [arg] JSON-serializable
 * @param {{ timeout?: number }} [opts] how long to wait for the content script (default 15 s)
 * @returns {Promise<T>}
 */
export async function onChannel(page, fn, arg, opts) {
    return inShell(page, /** @type {any} */ (new Function("_roots", "arg", `
        const side = globalThis.__mlPageChannel;
        if (!side) throw new Error("onChannel: no page channel in the content script's world");
        const ch = {
            asInjected: (data) => { for (const l of side.listeners.slice()) l({ data }); },
            asIsolated: (data) => { if (!side.port) throw new Error("onChannel: injected.js holds no port on this page"); side.port.postMessage(data); },
        };
        return (${fn.toString()})(ch, arg);`)), arg, opts);
}

/**
 * The highlight host's tag for this page session. The host is anonymous (a random custom-element name and no id of ours,
 * docs/spec/SITE_PRESENCE.md step 4), so a test learns the name from the shell's hook; it is the page's locator for the host.
 * @param {any} page the page
 * @returns {Promise<string>}
 */
export const highlightTag = (page) => inShell(page, (roots) => roots.highlightTag);

/**
 * The highlight box the shell drew, in viewport pixels (rounded), or null when none is drawn: the one place a test reads
 * the box inside the highlight's closed root.
 * @param {any} page the page
 * @returns {Promise<{ left: number, top: number, width: number, height: number } | null>}
 */
export const highlightBox = (page) => inShell(page, (roots) => {
    const el = roots.highlight?.querySelector("#ml-highlight");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
});

/**
 * Poll {@link inShell} until `fn` returns something truthy, and return it: `page.waitForFunction` for our closed roots.
 * A throw (the shell not mounted yet) counts as "not yet".
 * @template T
 * @param {any} page the page
 * @param {(roots: { sidebar: ShadowRoot | null, card: ShadowRoot | null, highlight: ShadowRoot | null, highlightTag: string }, arg: any) => T | Promise<T>} fn
 * @param {any} [arg] JSON-serializable
 * @param {{ timeout?: number, interval?: number }} [opts] default 15 s, polling every 100 ms
 * @returns {Promise<T>}
 */
export async function waitInShell(page, fn, arg, { timeout = 15000, interval = 100 } = {}) {
    const deadline = Date.now() + timeout;
    /** @type {any} */
    let last = null;
    for (;;) {
        try {
            const v = await inShell(page, fn, arg, { timeout: Math.max(1, deadline - Date.now()) });
            if (v) return v;
        } catch (e) { last = e; }
        if (Date.now() > deadline) throw new Error(`waitInShell: timed out after ${timeout} ms${last ? ` (last error: ${last.message})` : ""}`);
        await new Promise((r) => setTimeout(r, interval));
    }
}

/**
 * CLICK an element inside one of our closed roots with a REAL mouse click at its centre (Playwright's locators cannot
 * enter a closed root). `which` names the root, `selector` the element in it.
 * @param {any} page the page
 * @param {"sidebar" | "card" | "highlight"} which the root
 * @param {string} selector a CSS selector inside that root
 * @param {{ timeout?: number, button?: "left" | "right" | "middle" }} [opts]
 */
export async function clickInShell(page, which, selector, { timeout = 15000, button = "left" } = {}) {
    const box = await waitInShell(page, (roots, /** @type {{ which: "sidebar" | "card" | "highlight", selector: string }} */ a) => {
        const el = roots[a.which]?.querySelector(a.selector);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width && r.height ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    }, { which, selector }, { timeout });
    if (!box) throw new Error(`clickInShell: ${selector} never showed in the ${which} root`);
    await page.mouse.click(box.x, box.y, { button });
}

/**
 * HEAR EVERY `__mlDebug` EVENT injected.js SENDS the content scripts of `page`'s top frame, on every document it loads:
 * the page's own run and chat events, in any debug mode, before the shell decides what to draw. It replaces the window
 * listener specs used before SITE_PRESENCE step 2b; the page channel (`page-channel.ts`) carries nothing on the window.
 *
 * A listener added to the isolated world's `__mlPageChannel` over CDP calls a `Runtime.addBinding` binding, which
 * reaches Node; it is installed in each new content-script world as the page navigates. An event sent before a new
 * document's content script exists is missed, which a run's events are not (they start once the page has loaded).
 * @param {any} page the page
 * @param {(ev: any) => void} onEvent called once per event, in the order injected.js sent them
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function tapPageChannel(page, onEvent) {
    const cdp = await page.context().newCDPSession(page);
    const binding = "__wmlTapPageChannel";
    const install = `(() => {
        if (window.top !== window || globalThis.__wmlTapped) return;
        globalThis.__wmlTapped = true;
        let tries = 0;
        const go = () => {
            const side = globalThis.__mlPageChannel, call = globalThis.${binding};
            if (!side || typeof call !== "function") { if (++tries < 500) setTimeout(go, 20); return; }   // not ours, after 10 s
            side.listeners.push((e) => { const d = e && e.data; if (d && d.__mlDebug) { try { call(JSON.stringify(d.__mlDebug)); } catch { /* not JSON */ } } });
        };
        go();
    })()`;
    /** @type {Set<number>} the content-script worlds the tap is installed in */
    const ours = new Set();
    /** @type {Set<string>} the world names the binding was added under */
    const named = new Set();
    cdp.on("Runtime.bindingCalled", (/** @type {any} */ e) => { if (e.name === binding && ours.has(e.executionContextId)) onEvent(JSON.parse(e.payload)); });
    const onContext = async (/** @type {any} */ c) => {
        if (c.auxData?.isDefault || c.auxData?.type !== "isolated" || !c.name || String(c.name).startsWith("__playwright")) return;
        ours.add(c.id);
        if (!named.has(c.name)) { named.add(c.name); await cdp.send("Runtime.addBinding", { name: binding, executionContextName: c.name }).catch(() => {}); }
        await cdp.send("Runtime.evaluate", { contextId: c.id, expression: install }).catch(() => {});
    };
    cdp.on("Runtime.executionContextCreated", (/** @type {any} */ e) => { void onContext(e.context); });
    cdp.on("Runtime.executionContextDestroyed", (/** @type {any} */ e) => ours.delete(e.executionContextId));
    await cdp.send("Runtime.enable");   // reports the worlds that exist now, then each new one
    return { close: () => cdp.detach().catch(() => {}) };
}

/**
 * WATCH A TAB'S RUN EVENTS from outside the page, the way the DevTools panel does: an extension page holds the
 * `ml-devtools` port for `page`'s tab and hands every event to `onEvent`, in Node, in the order it was fanned.
 *
 * The worker's events for a run never reach the page's window (docs/spec/SITE_ACCESS.md, attack 15), so a spec that
 * listened there for a background run's steps listens here instead. The worker fans a run's events to this port
 * whatever the debug mode. The page's OWN events (a run or chat the page hosts) come here only in `debugMode:
 * "devtools"`; in any mode {@link tapPageChannel} hears them where injected.js hands them to the content scripts. The
 * watcher is a popup page in a window of its own, so a capture of the run's window never shows it.
 * @param {any} ext the launched extension (`launchExtension`'s result)
 * @param {any} page the page whose tab to watch; resolved to its tab by URL, so call it once the page has loaded
 * @param {(ev: any) => void} onEvent called once per event: the tab's buffered events first, then each new one
 * @returns {Promise<{ close: () => Promise<void> }>}
 */
export async function watchRunEvents(ext, page, onEvent) {
    const url = page.url();
    const tabId = await ext.sw.evaluate(async (/** @type {string} */ u) => (await chrome.tabs.query({})).find((t) => t.url === u)?.id ?? null, url);
    if (tabId == null) throw new Error(`no tab is on ${url}`);
    // The watcher gets a WINDOW of its own, unfocused, never a tab beside the run's: a headless capture of the run's
    // window (captureVisibleTab) can show the most recently opened page there whatever chrome.tabs says is active, so
    // every look, locate, verify and answer crop of a watched run was of the watcher's popup (review of #571).
    const popup = `chrome-extension://${ext.extensionId}/popup.html`;
    const opened = ext.context.waitForEvent("page", { predicate: (/** @type {any} */ p) => p.url().startsWith(popup) });
    await ext.sw.evaluate((/** @type {string} */ u) => chrome.windows.create({ url: u, focused: false }), popup);
    const watcher = await opened;
    await watcher.waitForLoadState();
    await watcher.exposeFunction("__onRunEvent", (/** @type {any} */ ev) => onEvent(ev));
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
    await waitInShell(page, (roots) => !!roots.sidebar?.getElementById("ml-sb-host"), undefined, { timeout });
    await inShell(page, (roots, /** @type {number|undefined} */ w) => {
        const root = /** @type {ShadowRoot} */ (roots.sidebar);
        const panel = /** @type {HTMLElement} */ (root.getElementById("ml-sb-host"));
        panel.style.width = `${w || Math.round(window.innerWidth * 0.55)}px`;
        panel.classList.add("open");
        (panel.classList.remove("open"), /** @type {HTMLElement} */ (root.getElementById("ml-sb-tab")).click());
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
            ? "\u25cf  demo finished: the browser is yours"
            : "\u25cf  demo running: it is driving the pointer and keyboard";
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

/**
 * Answer every pending approval gate for `tool` with yes, until stopped. Python no longer auto-approves while no cell is
 * known to be inside the dialect (agent/python-dialect.ts), so a spec that only needs the run to GO asks for this.
 * @param {any} ext the launched extension
 * @param {string} [tool] the tool whose gates to approve
 * @returns {() => void} stops the loop
 */
export function approveGates(ext, tool = "python_exec") {
    let on = true;
    (async () => {
        while (on) {
            try {
                const keys = await ext.sw.evaluate((/** @type {string} */ t) => ((/** @type {any} */ (globalThis)).__mlApprovals?.list?.() || []).filter((/** @type {any} */ g) => String(g.tool) === t).map((/** @type {any} */ g) => g.key), tool);
                for (const k of keys) await ext.sw.evaluate((/** @type {string} */ key) => (/** @type {any} */ (globalThis)).__mlApprovals.resolve(key, true), k);
            } catch { /* the worker is restarting or the browser closed */ }
            await new Promise((r) => setTimeout(r, 250));
        }
    })();
    return () => { on = false; };
}
