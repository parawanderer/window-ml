// detection-surface.spec.mjs — what a web page can OBSERVE about window.ml acting in it: a measurement of the
// page-visible surface, one check per row of docs/dev/detection-surface.md.
//
// The probe site (fixtures/detect/server.mjs) serves pages whose FIRST script (fixtures/detect/probe.js) watches, from
// the page's main world, every signal an anti-bot script reads: globals, the DOM, window messages, console identity,
// caller stacks, event trust and coordinates, focus/visibility/rAF, lifecycle events, extension resources, and the
// headers of every request it answers. Each test does ONE thing to a fresh probe tab (nothing; a run whose fake model
// makes one tool call; a page-started window.ml call) and records what the page saw.
//
// The browser is fixtures/detect/clean-browser.mjs, not harness.mjs: Playwright attaches a debugger client to every
// page it drives, which would put its own CDP traces on the page before the extension does anything. Here the only
// client a page can have is the extension's own `chrome.debugger`. The one Playwright test is the "by hand" baseline,
// and says what Playwright itself gives off.
//
// The assertions RECORD today's behaviour ("observed today"), so a change to any signal shows up as a failing
// expectation to update on purpose, with the doc. A finding that needs a fix is a `test.fixme` naming it, never a
// failing test. Raw rows go to tests/e2e/artifacts/detection-surface/ (gitignored) for the doc.

import fs from "node:fs";
import path from "node:path";
import { test, expect, chromium } from "@playwright/test";
import { launchClean } from "./fixtures/detect/clean-browser.mjs";
import { startProbeSite, DETECT_RESOLVER_ARGS } from "./fixtures/detect/server.mjs";
import { openProbe, runOn, summarize, toolResults, sleep, anonymize } from "./fixtures/detect/measure.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const ARTIFACTS = path.resolve("tests/e2e/artifacts/detection-surface");

/** Write one scenario's raw row next to the others, for the results doc. */
function keep(name, row) {
    fs.mkdirSync(ARTIFACTS, { recursive: true });
    fs.writeFileSync(path.join(ARTIFACTS, `${name}.json`), JSON.stringify(row, null, 1));
}

/** Every host the probe site answers for, as secure contexts, so the browser sends `Sec-Fetch-*` to them as it would to https. */
const secureArgs = (site) => [`--unsafely-treat-insecure-origin-as-secure=${["probe.test", "other.test", "xo.test", "api.test"].map((h) => site.origin(h)).join(",")}`];

/** Record every CDP method the worker sends through `chrome.debugger`, in the worker's realm (test instrumentation, no `src/` change). */
const CDP_RECORDER = () => {
    if (globalThis.__detectCdp) return;
    globalThis.__detectCdp = [];
    const d = chrome.debugger;
    const send = d.sendCommand.bind(d);
    d.sendCommand = (target, method, params, ...rest) => { globalThis.__detectCdp.push(method); return send(target, method, params, ...rest); };
    const attach = d.attach.bind(d), detach = d.detach.bind(d);
    d.attach = (...a) => { globalThis.__detectCdp.push("(attach)"); return attach(...a); };
    d.detach = (...a) => { globalThis.__detectCdp.push("(detach)"); return detach(...a); };
};

/**
 * One scenario in a fresh clean browser: open a probe tab on `host` + `path`, let it settle, do `act`, let it linger,
 * and fold what the page (and the server, and the worker) saw.
 * @param {{ extension?: boolean, host?: string, path?: string, script?: (site: any) => any[], req?: object, config?: object, linger?: number }} o
 */
async function scenario(name, { extension = true, host = "probe.test", path: p = "/", script, req, config = {}, linger = 1500 } = {}) {
    const site = await startProbeSite();
    const fake = await startFakeLlm({ model: "fake-model" });
    fake.setSide(() => ({ content: "1" }));   // a vision reader's sub-call: mark or cell number 1
    const b = await launchClean({ args: [...DETECT_RESOLVER_ARGS, ...secureArgs(site)], extension });
    try {
        if (extension) {
            await b.sw((c) => chrome.storage.sync.set(c), { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", autoApproveReadonly: false, defaultModelVision: "yes", ...config });
            await b.sw((o) => chrome.storage.local.set({ ml_site_always: o }), [site.origin("probe.test")]);
            await b.sw(CDP_RECORDER);
        }
        // A cookie on api.test, as a site the person is logged in to: what the worker's requests carry of it.
        const c = await b.open(site.url("api.test", "/setcookie")); await sleep(400); await b.closeTab(c);
        const reqOpen = site.requests().length;
        const page = await openProbe(b, site, host, p);
        await sleep(1200);
        const t0 = Date.now();
        let approved = null, results = null;
        if (script) {
            const steps = script(site);
            ({ approved } = await runOn(b, fake, page.tabId, [...steps, { content: "done" }], req));
            results = toolResults(fake).slice(-steps.length).map(anonymize);
        } else await sleep(2000);
        const t1 = Date.now();
        await sleep(linger);
        const all = site.reports();
        const others = Object.fromEntries([...new Set(all.filter((e) => e.pid !== page.pid && e.t >= t0).map((e) => e.pid))]
            .map((pid) => [all.find((e) => e.pid === pid).href.replace(/:\d+/, ""), summarize(all.filter((e) => e.pid === pid), 0)]));
        const cdp = extension ? await b.sw(() => globalThis.__detectCdp.splice(0)) : [];
        const requests = site.requests().slice(reqOpen).filter((r) => r.path !== "/probe.js" && r.path !== "/favicon.ico")
            .map((r) => ({ host: r.host, path: r.path + r.query, headers: Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^sec-fetch|^origin$|^referer$|^cookie$|^accept-language$|^user-agent$/.test(k))) }));
        const row = { approved, results, load: summarize(page.reports(), 0), during: summarize(page.reports(), t0), after: summarize(page.reports(), t1 + 800), others, cdp, requests };
        keep(name, row);
        return row;
    } finally {
        await b.close(); await fake.stop(); await site.stop();
    }
}

const EXEC_JS = "const t = document.title; __probeSays('during exec'); pageCall(() => { throw new Error('thrown in exec') }); await new Promise(r => setTimeout(r, 400)); return t";
const ISO_JS = "const n = document.querySelectorAll('button').length; document.getElementById('btn').click(); console.log('iso says'); await new Promise(r => setTimeout(r, 400)); return n";
/** The newest `@pt:` token the model was handed, clicked (a reactive step: the token is minted by the locate before it). */
const clickLastPoint = (body) => { const t = JSON.stringify(body.messages).match(/@pt:[0-9a-f]+/g)?.at(-1); return t ? { tool: "click", args: { selector: t } } : { content: "no token" }; };


/** What every page shows with the extension merely installed (observed today, on approved and unapproved pages alike). */
function expectInstalledTrace(load) {
    expect(load.mlClosedRootsAtLoad, "`__mlClosedRoots` is on window before any page script").toBe(true);
    expect(load.attachShadowNative, "Element.prototype.attachShadow is not native code").toBe(false);
    expect(load.attachShadowName).toBe("patched");
    expect(load.domAdded, "the content script appends a <script> naming the extension's id").toContain("head>script[src=chrome-extension://<id>/injected.js]");
    expect(load.domRemoved).toContain("head>script");
    expect(load.extIdLearnedBy).toEqual(expect.arrayContaining(["dom", "stack:dispatchEvent"]));
    expect(load.extensionCallers, "injected.js dispatches its ready event through the page's own dispatchEvent").toContain("dispatchEvent");
    expect(load.messages).toEqual(expect.arrayContaining(["__mlSidebar", "PAGE_ADOPT_HELLO"]));
    expect(load.warFetch, "web_accessible_resources answer any page that knows the id (no use_dynamic_url)").toEqual({ injected: 200, sidebar: 200, manifest: "Failed to fetch", bogus: "Failed to fetch" });
    expect(load.globalsAdded).toContain("ml");
    expect(typeof load.final.windowMl, "window.ml, with its members").toBe("number");
}

/** What every run adds to the page it acts on, whatever its tool (observed today). */
function expectRunTrace(during) {
    expect(during.domAdded, "the HUD card is a popover <div> on <html>").toContain("html>div#ml-sb-card");
    expect(during.domAttrs).toContain("ml-sb-card@popover");
    expect(during.messages, "the run's protocol rides the page's window").toEqual(expect.arrayContaining(["ADOPT_RUN", "RUN_ADOPTED_NOW", "PAGE_TOOL_RUN", "PAGE_TOOL_RESULT"]));
    expect(during.globalsAdded).toContain("__mlPierceClosed");
    expect(during.extensionCallers, "page-side tool code calls the page's builtins from chrome-extension://<id>/injected.js").toEqual(expect.arrayContaining(["document.querySelector", "document.querySelectorAll"]));
}

/** No debugger-shaped trace: no console swap, no binding, no CDP command. */
const NO_CDP = { cdpConsoleGetter: [], mlCdpStream: false, mlIsoStream: false };

/** A trusted CDP click as the page sees it: Playwright's own sequence — move, then press/release — with a pressed
 *  mouse's pressure (0.5 down, 0 up) and `code` on the keys. The move's `activation` is the page's before the press. */
const cdpClickEvents = (target) => [
    { type: "pointermove", isTrusted: true, target, pointerType: "mouse", pressure: 0, size: [1, 1] },
    { type: "mousemove", isTrusted: true, target },
    { type: "pointerdown", isTrusted: true, target, activation: [true, true], pointerType: "mouse", pressure: 0.5, size: [1, 1] },
    { type: "mousedown", isTrusted: true, target, activation: [true, true] },
    { type: "pointerup", isTrusted: true, target, activation: [true, true], pointerType: "mouse", pressure: 0, size: [1, 1] },
    { type: "mouseup", isTrusted: true, target, activation: [true, true] },
    { type: "click", isTrusted: true, target, activation: [true, true], pointerType: "mouse", pressure: 0, size: [1, 1] },
];

// --- baselines: the probe page with no extension, and Playwright acting "by hand" ---

test.describe("baselines", () => {
    test("no extension: the probe's own noise floor (headless markers, the console getters that fire on their own)", async () => {
        const row = await scenario("no-extension", { extension: false });
        // observed today: webdriver is true and the UA says HeadlessChrome with no extension at all. Both are the HARNESS's:
        // --remote-debugging-port alone sets webdriver (measured headful too), headless sets the UA. A person's own Chrome
        // has neither, and no launch this harness can drive gives a false baseline; the probe watches it for a change instead.
        expect(row.load).toMatchObject({ webdriver: true, headlessUa: true, automationGlobals: [], attachShadowNative: true, mlClosedRootsAtLoad: false });
        // observed today: three of the four console-getter shapes fire with NO debugger client (Chromium reads an
        // Error's message/name and a function's toString to report every console call), so they detect nothing.
        expect(row.load.cdpConsoleGetter).toEqual(expect.arrayContaining(["errMessage", "errName", "fnToString"]));
        expect(row.load.cdpConsoleGetter).not.toContain("errStack");
        expect(row.load.final.windowMl).toBe("absent");
        expect(row.load.domAdded.filter((d) => /ml-|chrome-extension/.test(d))).toEqual([]);
        expect(row.load.messages).toEqual([]);
    });

    test("a debugger client's Runtime.enable is invisible to every console-getter shape in this Chromium", async () => {
        // The request's leak 1 is measured directly here, with no extension: attach a client to the page and enable the
        // Runtime domain, the thing Puppeteer/Playwright do and cdpEval/runInCdpWorld do.
        const site = await startProbeSite();
        const b = await launchClean({ args: DETECT_RESOLVER_ARGS, extension: false });
        try {
            const page = await openProbe(b, site, "probe.test");
            await sleep(800);
            const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
            const t0 = Date.now();
            await b.cdp.send("Runtime.enable", {}, sessionId);
            await sleep(1500);
            await b.cdp.send("Runtime.disable", {}, sessionId);
            await sleep(500);
            // observed today: no shape changes when Runtime is enabled (the classic Error.stack getter included).
            expect(summarize(page.reports(), t0).cdpConsoleGetter).toEqual([]);
            expect(summarize(page.reports(), 0).cdpConsoleGetter).not.toContain("errStack");
        } finally { await b.close(); await site.stop(); }
    });

    test("Playwright 'by hand': its clicks and keys are CDP input too, and it sets webdriver", async () => {
        // The closest stand-in for a person this harness has. Its limits: Playwright's mouse and keyboard are CDP
        // Input.dispatch*Event like the extension's reserved click, so this shows what CDP input looks like when a
        // driver also moves the mouse first, not what a hand looks like. Real OS input is not reachable headless.
        const site = await startProbeSite();
        const context = await chromium.launchPersistentContext("", { headless: true, channel: "chromium", args: [...DETECT_RESOLVER_ARGS, ...secureArgs(site)] });
        try {
            const pg = await context.newPage();
            await pg.goto(site.url("probe.test"));
            await sleep(800);
            const t0 = Date.now();
            await pg.click("#btn");
            await pg.click("#field");
            await pg.keyboard.type("hi");
            const box = await pg.locator("#cv").boundingBox();
            await pg.mouse.click(box.x + 10, box.y + 10);
            await sleep(800);
            const pid = site.reports().find((e) => e.kind === "ready" && e.host === "probe.test")?.pid;
            const row = summarize(site.reports().filter((e) => e.pid === pid), t0);
            keep("playwright-by-hand", { load: summarize(site.reports().filter((e) => e.pid === pid), 0), during: row });
            // observed today: Playwright passes --enable-automation (webdriver) and its own client trips no getter either.
            expect(summarize(site.reports().filter((e) => e.pid === pid), 0).webdriver).toBe(true);
            const btn = row.pointer.filter((e) => e.target === "btn").map((e) => e.type);
            // observed today: a Playwright click MOVES first (pointermove/mousemove), then the press sequence, all trusted.
            expect(btn).toEqual(["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
            const click = row.pointer.find((e) => e.target === "btn" && e.type === "click");
            expect(click).toMatchObject({ isTrusted: true, activation: [true, true], pointerType: "mouse", offsetFromCentre: [0, 0] });
            const down = row.pointer.find((e) => e.target === "btn" && e.type === "pointerdown");
            expect(down.pressure, "observed today: Playwright's press reports 0.5, a real mouse's value").toBe(0.5);
            const key = row.keys.find((e) => e.type === "keydown");
            expect(key, "observed today: Playwright fills `code`").toMatchObject({ isTrusted: true, key: "h", code: "KeyH", keyCode: 72 });
        } finally { await context.close(); await site.stop(); }
    });
});

// --- the extension installed, no run ---

test.describe("installed, no run", () => {
    test("an UNAPPROVED page sees window.ml, its script, its id and its patched attachShadow", async () => {
        const row = await scenario("idle-unapproved", { host: "other.test" });
        expectInstalledTrace(row.load);
        expect(row.cdp).toEqual([]);
        expect(row.during).toMatchObject({ domAdded: [], messages: [], ...NO_CDP });
    });

    test("an approved page sees the same, and nothing more until a run starts", async () => {
        const row = await scenario("idle-approved");
        expectInstalledTrace(row.load);
        expect(row.cdp).toEqual([]);
        expect(row.during).toMatchObject({ domAdded: [], messages: [], ...NO_CDP });
    });

    test.fixme("a page cannot tell that window.ml is installed", async () => {
        // FINDING (security/privacy): any page identifies the extension, and learns its id, with no run and no approval:
        // `'ml' in window` (slice 4 of SITE_ACCESS.md is open), `'__mlClosedRoots' in window`, attachShadow's source,
        // the <script src="chrome-extension://<id>/injected.js"> a MutationObserver sees, the stack of injected.js's
        // dispatchEvent, and `fetch("chrome-extension://<id>/injected.js")` answering 200 (no use_dynamic_url). See
        // docs/dev/detection-surface.md, rows 1-6.
    });
});

// --- exec, in each world ---

test.describe("exec", () => {
    test("main world (approved page): the console is swapped, the stack names injected.js, the page's console reaches the model", async () => {
        const row = await scenario("exec-main", { script: () => [{ tool: "exec", args: { js: EXEC_JS } }] });
        expectRunTrace(row.during);
        expect(row.cdp).toEqual([]);
        expect(row.during).toMatchObject(NO_CDP);
        // observed today: all five console methods are replaced for the length of the exec, visibly to a page timer.
        expect(row.during.consoleSwapped).toEqual(["debug", "error", "info", "log", "warn"]);
        expect(row.after.final.consoleSwapped).toEqual([]);
        // observed today: a page function the exec calls sees eval'd code under chrome-extension://<id>/injected.js.
        expect(row.during.pageCallCaller[0]).toMatch(/^at eval \(eval at run \(chrome-extension:\/\/<id>\/injected\.js:\d+:\d+\), <anonymous>:\d+:\d+\)$/);
        expect(row.during.caughtStack.join("\n")).toContain("chrome-extension://<id>/injected.js");
        // observed today: what the PAGE logs while the exec runs is collected into the model's tool result.
        expect(row.results[0]).toContain("page says during exec");
    });

    test("main world with streaming: the same, plus PAGE_TOOL_STREAM on the window", async () => {
        const row = await scenario("exec-main-stream", { req: { stream: true }, script: () => [{ tool: "exec", args: { js: EXEC_JS } }] });
        expect(row.cdp).toEqual([]);
        expect(row.during.consoleSwapped).toEqual(["debug", "error", "info", "log", "warn"]);
        expect(row.during.messages).toContain("PAGE_TOOL_STREAM");
    });

    test("isolated world (unapproved page, CDP): Runtime.enable and nothing the page can see but the DOM effect", async () => {
        const row = await scenario("exec-isolated", { host: "other.test", script: () => [{ tool: "exec", args: { js: ISO_JS } }] });
        expect(row.cdp).toEqual(["(attach)", "Runtime.enable", "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate", "Runtime.evaluate", "(detach)"]);
        expect(row.during).toMatchObject({ ...NO_CDP, consoleSwapped: [] });
        // observed today: the isolated world's btn.click() arrives untrusted but WITH user activation (userGesture: true).
        expect(row.during.pointer).toEqual([expect.objectContaining({ type: "click", isTrusted: false, activation: [true, true], clientXY: [0, 0], screenXY: [0, 0] })]);
        expect(row.during.pointer[0].stack, "no injected.js frame: the click came from another world").toBeUndefined();
    });

    test("isolated world with streaming: the binding is named for the world, so the page never sees it", async () => {
        const row = await scenario("exec-isolated-stream", { host: "other.test", req: { stream: true }, script: () => [{ tool: "exec", args: { js: ISO_JS } }] });
        expect(row.cdp).toEqual(["(attach)", "Runtime.enable", "Runtime.addBinding", "Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate", "Runtime.evaluate", "Runtime.removeBinding", "(detach)"]);
        expect(row.during).toMatchObject(NO_CDP);
        expect(row.load.final.mlIsoStream).toBe(false);
    });

    test("strict-CSP page (main world through CDP): the console swap without the injected.js stack", async () => {
        const row = await scenario("exec-strict", { path: "/?csp=strict", script: () => [{ tool: "exec", args: { js: EXEC_JS } }] });
        expect(row.cdp).toEqual(["(attach)", "Runtime.evaluate", "Runtime.evaluate", "(detach)"]);
        expect(row.during.consoleSwapped).toEqual(["debug", "error", "info", "log", "warn"]);
        // observed today: Runtime.evaluate code has no URL, so the stack is bare <anonymous> frames (no sourceURL marker).
        expect(row.during.pageCallCaller.every((f) => /^at <anonymous>:\d+:\d+$/.test(f))).toBe(true);
        expect(row.during.mlCdpStream).toBe(false);
    });

    test("strict-CSP page with streaming: __mlCdpStream appears on the page's window, and stays", async () => {
        const row = await scenario("exec-strict-stream", { path: "/?csp=strict", req: { stream: true }, script: () => [{ tool: "exec", args: { js: EXEC_JS } }] });
        expect(row.cdp).toEqual(["(attach)", "Runtime.enable", "Runtime.addBinding", "Runtime.evaluate", "Runtime.evaluate", "Runtime.removeBinding", "(detach)"]);
        expect(row.during.mlCdpStream).toBe(true);
        // observed today: Runtime.removeBinding stops the notifications but leaves the function on the global (CDP's
        // documented behaviour), so the page keeps `__mlCdpStream` after the exec, the run and the detach.
        expect(row.load.final.mlCdpStream).toBe(true);
        expect(row.load.final.globalsAdded).toContain("__mlCdpStream");
    });

    test.fixme("__mlCdpStream is gone from the page's global once the strict-page exec ends", async () => {
        // FINDING (security + detection): the binding has no executionContextName, so it is a main-world global a page
        // can call while the exec runs (the todo in tests/redteam-isolated.test.mjs) and can test for ever after:
        // `'__mlCdpStream' in window` names this tool, not just "automation". Runtime.removeBinding does not delete the
        // global. Removable by naming the binding for a world the wrapper runs in, or by deleting it from the page in
        // the wrapper's finally (the page can keep a reference); cost: streaming of strict-page execs.
    });
});

// --- click, type and the vision tools ---

test.describe("input", () => {
    test("selector click: one untrusted `click`, no press/release, at (0,0), no activation", async () => {
        const row = await scenario("click-selector", { script: () => [{ tool: "click", args: { selector: "#btn" } }] });
        expectRunTrace(row.during);
        expect(row.cdp).toEqual([]);
        // observed today: HTMLElement.click() — the event a page can tell from a hand on four fields at once.
        expect(row.during.pointer).toEqual([expect.objectContaining({ type: "click", isTrusted: false, activation: [false, false], pointerType: "", clientXY: [0, 0], screenXY: [0, 0] })]);
        expect(row.during.pointer[0].stack[0]).toMatch(/chrome-extension:\/\/<id>\/injected\.js/);
    });

    test("canvas click with CDP off: the same untrusted click", async () => {
        const row = await scenario("click-canvas-no-cdp", { config: { cdp: false }, script: () => [{ tool: "click", args: { selector: "#cv" } }] });
        expect(row.cdp).toEqual([]);
        expect(row.during.pointer).toEqual([expect.objectContaining({ type: "click", isTrusted: false, clientXY: [0, 0] })]);
    });

    test("canvas click (CDP): trusted move/press/release with a pressed mouse's pressure, the exact centre", async () => {
        const row = await scenario("click-canvas-cdp", { script: () => [{ tool: "click", args: { selector: "#cv" } }] });
        // observed today: attach, move+press+release, detach (the run's end detaches; no Runtime, no Emulation).
        expect(row.cdp).toEqual(["(attach)", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "(detach)"]);
        expect(row.during).toMatchObject(NO_CDP);
        expect(row.during.pointer).toMatchObject(cdpClickEvents("cv"));
        const click = row.during.pointer.at(-1);
        expect(click.offsetFromCentre.map((d) => Math.abs(d) <= 1), "the element's centre, to the rounding").toEqual([true, true]);
        // observed today: screenXY = clientXY + the window's own offset (headless), so the request's "screenX == clientX" guess is wrong here.
        expect(click.screenXY[0] - click.clientXY[0]).toBe(row.load.windowScreenXY[0]);
        expect(row.during.resizes, "headless has no infobar to resize the page").toBe(0);
        expect(row.during.webdriverChanges, "attaching chrome.debugger does not flip navigator.webdriver").toEqual([]);
    });

    test("sealed shadow click (CDP): DOM.* and a callFunctionOn in a world of its own, then the trusted click", async () => {
        const row = await scenario("click-sealed-cdp", { script: () => [{ tool: "click", args: { selector: "#sealed >>> #inner" } }] });
        expect(row.cdp).toEqual(["(attach)", "DOM.getDocument", "DOM.querySelectorAll", "DOM.describeNode", "DOM.describeNode", "DOM.querySelectorAll", "Page.getFrameTree", "Page.createIsolatedWorld", "DOM.resolveNode", "Runtime.callFunctionOn", "Runtime.releaseObject", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "(detach)"]);
        expect(row.during.pointer).toMatchObject(cdpClickEvents("sealed"));
        expect(row.during.sealed).toEqual([{ type: "pointerdown", isTrusted: true }, { type: "click", isTrusted: true }]);
    });

    test("cross-origin iframe click (CDP): the frame's own probe sees the trusted click", async () => {
        const row = await scenario("click-iframe-cdp", { script: () => [{ tool: "locate", args: { description: "the button inside the frame", selector: "#xo", strategy: "grid", gridSize: 2 } }, clickLastPoint] });
        expect(row.cdp).toEqual(["(attach)", "Page.captureScreenshot", "Page.captureScreenshot", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "(detach)"]);
        const frame = row.others["http://xo.test/frame"];
        expect(frame.pointer.map((e) => e.type)).toEqual(["pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]);
        expect(frame.pointer.filter((e) => !e.type.endsWith("move")).map((e) => [e.type, e.isTrusted, e.activation])).toEqual(
            ["pointerdown", "mousedown", "pointerup", "mouseup", "click"].map((t) => [t, true, [true, true]]));
    });

    test("a CDP click's pointerdown reports a pressed mouse's pressure (0.5)", async () => {
        // Was a fixme (looks automated): without `force` the press reported pressure 0 with a button held, which no
        // hardware mouse reports. The dispatch layer now sends `force: 0.5` down / 0 up, same as Playwright's baseline.
        const row = await scenario("click-canvas-pressure", { script: () => [{ tool: "click", args: { selector: "#cv" } }] });
        const down = row.during.pointer.find((e) => e.type === "pointerdown");
        const up = row.during.pointer.find((e) => e.type === "pointerup");
        expect(down.pressure).toBe(0.5);
        expect(up.pressure).toBe(0);
    });

    test("type by selector: input + change, untrusted, no key events, and the field focused by script", async () => {
        const row = await scenario("type-selector", { script: () => [{ tool: "type", args: { selector: "#field", text: "hello" } }] });
        expect(row.cdp).toEqual([]);
        expect(row.during.keys.map((e) => [e.type, e.isTrusted])).toEqual([["input", false], ["change", false]]);
        expect(row.during.extensionCallers).toEqual(expect.arrayContaining(["dispatchEvent", "focus"]));
    });

    test("type into a sealed field (CDP): trusted keydown/keypress/beforeinput/input/keyup with the key's `code`", async () => {
        const row = await scenario("type-sealed-cdp", { script: () => [{ tool: "type", args: { selector: "#sealed >>> #sinput", text: "hi" } }] });
        expect(row.cdp.filter((m) => m.startsWith("Input."))).toEqual(["Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent", "Input.dispatchKeyEvent"]);
        expect(row.during.keys.map((e) => e.type)).toEqual(["keydown", "keypress", "beforeinput", "input", "keyup", "keydown", "keypress", "beforeinput", "input", "keyup"]);
        expect(row.during.keys.every((e) => e.isTrusted)).toBe(true);
        expect(row.during.keys[0]).toMatchObject({ key: "h", code: "KeyH", keyCode: 72 });
        expect(row.during.keys.filter((e) => e.type === "keydown").map((e) => e.code)).toEqual(["KeyH", "KeyI"]);
    });

    test("look and locate with CDP on: a screenshot through the debugger, nothing on the page but the card", async () => {
        const look = await scenario("look", { script: () => [{ tool: "look", args: {} }] });
        expect(look.cdp).toEqual(["(attach)", "Page.captureScreenshot", "(detach)"]);
        expect(look.during).toMatchObject({ ...NO_CDP, focusEvents: [], resizes: 0, consoleSwapped: [] });
        const locate = await scenario("locate", { script: () => [{ tool: "locate", args: { description: "the Press button", strategy: "marks" } }] });
        expect(locate.cdp).toEqual(["(attach)", "Page.captureScreenshot", "(detach)"]);
        expect(locate.during.extensionCallers).toEqual(expect.arrayContaining(["elementFromPoint", "getBoundingClientRect"]));
    });

    test("look with CDP off: captureVisibleTab, no debugger", async () => {
        const row = await scenario("look-no-cdp", { config: { cdp: false }, script: () => [{ tool: "look", args: {} }] });
        expect(row.cdp).toEqual([]);
        expect(row.during).toMatchObject({ ...NO_CDP, resizes: 0 });
    });

    test("an approval moves focus from the page to the HUD card and back", async () => {
        const row = await scenario("approval-focus", { script: () => [{ tool: "type", args: { selector: "#field", text: "x" } }] });
        // observed today: the page's window blurs and the card (a page-DOM element) takes focus, before or after the tool
        // focuses its target (the order varies run to run). A page sees a blur it did not cause on a gated call.
        expect(row.during.focusEvents).toEqual(expect.arrayContaining(["blur:window", "focus:ml-sb-card", "focus:field"]));
    });
});

// --- navigation and the requests the worker makes ---

test.describe("navigation and requests", () => {
    test("navigate: a same-origin document request with a Referer and no Sec-Fetch-User", async () => {
        const row = await scenario("navigate", { script: () => [{ tool: "navigate", args: { url: "/page2" } }] });
        expect(row.cdp).toEqual([]);
        const nav = row.requests.find((r) => r.path === "/page2");
        // observed today: a script-started navigation (no user activation), unlike a person's click on the link.
        expect(nav.headers).toMatchObject({ "sec-fetch-site": "same-origin", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" });
        expect(nav.headers["sec-fetch-user"]).toBeUndefined();
        expect(nav.headers.referer).toMatch(/^http:\/\/probe\.test:\d+\/$/);
        expect(row.others["http://probe.test/page2"].navType).toBe("navigate");
    });

    test("fetch_url from the worker: Sec-Fetch-Site none, no Referer/Origin, a short Accept-Language and a .md twin request", async () => {
        const row = await scenario("fetch-url", { script: (site) => [{ tool: "fetch_url", args: { url: site.url("api.test", "/echo?via=fetch_url") } }] });
        const api = row.requests.filter((r) => r.host === "api.test" && !/setcookie/.test(r.path));
        expect(api.map((r) => r.path)).toEqual(["/echo?via=fetch_url", "/echo.md"]);
        const pageLanguage = row.requests.find((r) => r.host === "probe.test").headers["accept-language"];
        for (const r of api) {
            expect(r.headers).toMatchObject({ "sec-fetch-site": "none", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" });
            // observed today: only the first language (en-GB where the page's own requests send en-GB,en;q=0.9).
            expect(r.headers["accept-language"]).toBe(pageLanguage.split(",")[0]);
            expect(r.headers["accept-language"]).not.toBe(pageLanguage);
            expect(r.headers.cookie).toBeUndefined();
            expect(r.headers.referer).toBeUndefined();
            expect(r.headers.origin).toBeUndefined();
        }
        expect(row.cdp).toEqual([]);
    });

    test("fetch_url with credentials: the same request with the site's cookie", async () => {
        const row = await scenario("fetch-url-credentials", { script: (site) => [{ tool: "fetch_url", args: { url: site.url("api.test", "/echo?via=fetch_url_cred"), credentials: true } }] });
        const first = row.requests.find((r) => r.path === "/echo?via=fetch_url_cred");
        expect(first.headers).toMatchObject({ "sec-fetch-site": "none", "sec-fetch-mode": "cors", cookie: "session=api.test-secret" });
    });

    test("rendered fetch: a real tab on the site, focus emulated, visibility flipped, window.ml injected there", async () => {
        const row = await scenario("fetch-url-rendered", { script: (site) => [{ tool: "fetch_url", args: { url: site.url("api.test", "/?via=rendered"), rendered: true, credentials: true } }] });
        // observed today: the ONLY Emulation.* command the extension sends, on the render tab only.
        expect(row.cdp).toEqual(["(attach)", "Emulation.setFocusEmulationEnabled", "Page.setWebLifecycleState", "(detach)"]);
        const tab = row.others["http://api.test/?via=rendered"];
        // false then true on macOS; already true at the probe's first look on Linux (the emulation lands first).
        expect(tab.final.hasFocus).toBe(true);
        expect(tab.visibility).toEqual(["hidden", "visible"]);
        expect(tab.lifecycle.filter((t) => t === "visibilitychange").length).toBeGreaterThanOrEqual(2);
        expect(tab.lifecycle).not.toContain("freeze");
        expect(tab.rafHz, "not throttled: the render tab is made visible, so focused-but-hidden never happens").toEqual(["≥40"]);
        expect(tab.final.windowMl, "the rendered site gets window.ml like any page").toEqual(expect.any(Number));
        const nav = row.requests.find((r) => r.path === "/?via=rendered");
        expect(nav.headers).toMatchObject({ "sec-fetch-site": "none", "sec-fetch-mode": "navigate", cookie: "session=api.test-secret" });
        expect(nav.headers["sec-fetch-user"]).toBeUndefined();
    });

    test("page-started ml.fetch is refused without a grant; FETCH_IMAGE_B64 reads another origin's image with NO cookie, and refuses its HTML", async () => {
        const row = await scenario("ml-fetch", { path: "/?do=mlfetch" });
        const did = Object.fromEntries(row.load.did.map((d) => [d.name, d]));
        expect(did["ml.fetch"].error).toMatch(/^Refused: .* hasn't been approved for fetching on this page/);
        const img = row.requests.find((r) => r.path === "/img.png?via=b64");
        // credentials: "omit" (sw-image-fetch.ts): the target site's cookie is not sent, nor a Referer. Its Accept-Language
        // is platform-dependent (a third shape, en-GB,en-US;q=0.9,en;q=0.8, on macOS; the page's own value on the Linux CI
        // runner), so it is not asserted.
        expect(img.headers).toMatchObject({ "sec-fetch-site": "none", "sec-fetch-mode": "cors" });
        expect(img.headers.cookie, "the person's cookie for api.test is not sent").toBeUndefined();
        expect(img.headers.referer).toBeUndefined();
        expect(did["ml._fetchImageBase64"].ok, "the public image still reads").toMatch(/^data:image\/png;base64,/);
        // An HTML page of another origin is not an image: refused with the one failure text, nothing of it read back, and
        // its request carried no cookie either.
        expect(did["ml._fetchImageBase64 html"].ok).toBeUndefined();
        expect(did["ml._fetchImageBase64 html"].error).toBe("Could not read that URL as an image.");
        const html = row.requests.find((r) => r.path === "/echo?via=b64html");
        if (html) expect(html.headers.cookie).toBeUndefined();
    });

    test("the page's own fetch, for comparison: cross-site, no-cors, with a Referer and the full Accept-Language", async () => {
        const row = await scenario("page-fetch", { path: "/?do=pagefetch" });
        const r = row.requests.find((x) => x.path === "/echo?via=page-fetch");
        expect(r.headers).toMatchObject({ "sec-fetch-site": "cross-site", "sec-fetch-mode": "no-cors" });
        expect(r.headers["accept-language"]).toBe(row.requests.find((x) => x.host === "probe.test").headers["accept-language"]);
        expect(r.headers.referer).toMatch(/^http:\/\/probe\.test:\d+\/$/);
    });
});

// --- the CDP surface as a whole ---

test("the extension sends no Emulation.* command outside a rendered fetch", async () => {
    // Static half: the source names exactly two Emulation/Page lifecycle commands, both in sw-fetch.ts's emulateForeground.
    // The runtime half is the recorder in every scenario above (only fetch-url-rendered shows one).
    const src = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => d.isDirectory() ? src(path.join(dir, d.name)) : /\.tsx?$/.test(d.name) ? [path.join(dir, d.name)] : []);
    const hits = src(path.resolve("src")).flatMap((f) => [...fs.readFileSync(f, "utf8").matchAll(/"(Emulation\.[A-Za-z]+|Page\.setWebLifecycleState)"/g)].map((m) => `${path.basename(f)}:${m[1]}`));
    expect(hits.sort()).toEqual(["sw-fetch.ts:Emulation.setFocusEmulationEnabled", "sw-fetch.ts:Page.setWebLifecycleState"]);
});

// --- public detector pages (network; opt-in) ---

/** The public detectors, each with what to read off the page once it has run. Raw output only: the summary is in the doc. */
const PUBLIC = {
    rebrowser: { url: "https://bot-detector.rebrowser.net/", read: "JSON.stringify(window.detections || null)" },
    sannysoft: { url: "https://bot.sannysoft.com/", read: "document.body.innerText" },
    creepjs: { url: "https://abrahamjuliot.github.io/creepjs/", read: "document.body.innerText", wait: 20000 },
    browserscan: { url: "https://www.browserscan.net/bot-detection", read: "document.body.innerText", wait: 15000 },
    // BotD has no hosted demo any more (its GitHub Pages 404s); its documented CDN build is loaded on a blank page instead.
    botd: { url: "about:blank", read: "(async () => { const B = await import('https://openfpcdn.io/botd/v1'); const b = await B.load(); return JSON.stringify(b.detect()); })()" },
};
/** The exec the rebrowser page asks an automation script to run: main-world access, a sourceURL stack, a main-world DOM call. */
const REBROWSER_JS = "const f = typeof dummyFn === 'function' ? dummyFn() : 'no dummyFn here'; document.getElementById('detections-json'); document.getElementsByClassName('div'); return String(f)";

test.describe("public detectors", () => {
    test.skip(process.env.DETECT_PUBLIC !== "1", "network: set DETECT_PUBLIC=1 to run against the public detector pages");
    test.setTimeout(240000);
    for (const variant of ["no-extension", "installed", "exec-main"]) {
        test(`public detectors, ${variant}`, async () => {
            const fake = await startFakeLlm({ model: "fake-model" });
            const b = await launchClean({ extension: variant !== "no-extension" });
            const out = {};
            try {
                if (variant !== "no-extension") await b.sw((c) => chrome.storage.sync.set(c), { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", autoApproveReadonly: false });
                for (const [name, d] of Object.entries(PUBLIC)) {
                    if (variant === "exec-main" && name !== "rebrowser") continue;
                    if (variant === "exec-main") await b.sw((o) => chrome.storage.local.set({ ml_site_always: [o] }), new URL(d.url).origin);
                    const targetId = await b.open(d.url);
                    await sleep(d.wait || 8000);
                    if (variant === "exec-main") {
                        const tabId = await b.sw((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === u)?.id), d.url);
                        await runOn(b, fake, tabId, [{ tool: "exec", args: { js: REBROWSER_JS } }, { content: "done" }]);
                        await sleep(1500);
                    }
                    // Read AFTER the page's checks ran: attaching a client to read is itself one of the things they test.
                    const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId, flatten: true });
                    const r = await b.cdp.send("Runtime.evaluate", { expression: d.read, awaitPromise: true, returnByValue: true }, sessionId).catch((e) => ({ error: String(e) }));
                    const shot = await b.cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }, sessionId).catch(() => null);
                    out[name] = r.result?.value ?? r.exceptionDetails?.exception?.description ?? r.error ?? null;
                    fs.mkdirSync(ARTIFACTS, { recursive: true });
                    fs.writeFileSync(path.join(ARTIFACTS, `public-${name}-${variant}.txt`), anonymize(String(out[name])));
                    if (shot?.data) fs.writeFileSync(path.join(ARTIFACTS, `public-${name}-${variant}.png`), Buffer.from(shot.data, "base64"));
                    await b.closeTab(targetId);
                }
            } finally { await b.close(); await fake.stop(); }
            expect(Object.keys(out).length).toBeGreaterThan(0);
        });
    }
});
