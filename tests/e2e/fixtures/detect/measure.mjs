// measure.mjs — drive one action against a probe page and reduce what the page saw to one row of checks, for
// tests/e2e/detection-surface.spec.mjs (the results table: docs/dev/detection-surface.md).
//
// A scenario opens a fresh probe tab in the clean browser (clean-browser.mjs), lets the probe settle, does one thing
// (nothing, a run with a scripted tool call, a page-started call), waits for it to finish and for the probe's last
// report, then `summarize` folds the probe's change log into the fields the spec snapshots.

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` until it returns something truthy. */
export async function waitFor(fn, ms = 20000, what = "condition") {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

/**
 * Open `host` + `path` in a new tab and wait for its probe to report ready.
 * @returns the url, target id, the probe's page id, the tab id (null without the extension) and a reader of its reports
 */
export async function openProbe(b, site, host, path = "/") {
    const url = site.url(host, path);
    const before = new Set(site.reports().map((e) => e.pid));
    const targetId = await b.open(url);
    const pid = await waitFor(() => site.reports().find((e) => e.kind === "ready" && e.href === url && !before.has(e.pid))?.pid, 15000, `the probe on ${url}`);
    const tabId = b.extensionId ? await waitFor(() => b.sw((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === u)?.id), url), 5000, "the tab id") : null;
    return { url, targetId, pid, tabId, reports: () => site.reports().filter((e) => e.pid === pid) };
}

/**
 * Start a run the user asked for on `tabId` with the fake model's `script`, approving every gate through the worker's
 * external channel, and resolve once the driver has been asked for every turn and no run is live.
 * @returns the gates approved, by tool
 */
export async function runOn(b, fake, tabId, script, req = {}) {
    fake.setScript(script);
    const driver = () => fake.calls().filter((c) => c.tools?.length).length;
    const n0 = driver();
    await b.sw(({ tabId, req }) => globalThis.__mlStartUserRunForTest(tabId, { task: "do the scripted step", surface: "hud", hud: "quiet", ...req }, { approvalRouting: "both" }), { tabId, req });
    const approved = [];
    await waitFor(async () => {
        for (const g of await b.sw(() => globalThis.__mlApprovals.list())) { approved.push(g.tool); await b.sw((k) => globalThis.__mlApprovals.resolve(k, true), g.key); }
        const st = await b.sw(() => globalThis.__mlRunStateForTest());
        return driver() - n0 >= script.length && st.controllers.length === 0;
    }, 40000, "the run to finish");
    return { approved };
}

/** The tool results the driver was handed, in order (what the model read). */
export const toolResults = (fake) => (fake.calls().filter((c) => c.tools?.length).at(-1)?.messages || []).filter((m) => m.role === "tool").map((m) => String(m.content));

const uniq = (xs) => [...new Set(xs)];
const EXT = /chrome-extension:\/\/[a-p]{32}/g;
/** A string with the extension's id replaced, so a snapshot does not depend on the build path. */
export const anonymize = (s) => String(s).replace(EXT, "chrome-extension://<id>");

/**
 * Fold a probe's reports from `since` on into one row of checks.
 * @param {any[]} reports one page's entries
 * @param {number} since only entries at or after this time (the action's start); the env entry is always used
 */
export function summarize(reports, since = 0) {
    const env = reports.find((e) => e.kind === "env") || {};
    const rs = reports.filter((e) => e.t >= since);
    const states = (name) => rs.filter((e) => e.kind === "state" && e.name === name).map((e) => e.value);
    const events = rs.filter((e) => e.kind === "event");
    const ev = (types) => events.filter((e) => types.includes(e.type));
    const shape = (e) => ({ type: e.type, isTrusted: e.isTrusted, target: e.target, activation: e.activation, ...(e.pointerType !== undefined ? { pointerType: e.pointerType, pressure: e.pressure, size: e.size } : {}),
        ...(e.clientXY ? { clientXY: e.clientXY, screenXY: e.screenXY, offsetFromCentre: e.offsetFromCentre } : {}), ...(e.key !== undefined ? { key: e.key, code: e.code, keyCode: e.keyCode } : {}),
        ...(e.inputType !== undefined ? { inputType: e.inputType } : {}), ...(e.stack ? { stack: e.stack.map(anonymize) } : {}) });
    const ids = rs.filter((e) => e.kind === "ext-id");
    const probe = rs.find((e) => e.kind === "ext-probe");
    return {
        webdriver: env.webdriver, headlessUa: /HeadlessChrome/.test(env.ua || ""), plugins: env.plugins, automationGlobals: env.automationGlobals,
        attachShadowNative: env.attachShadowNative, attachShadowName: env.attachShadowName, mlClosedRootsAtLoad: env.mlClosedRoots, closedRootReaderAtLoad: env.closedRootReader,
        cdpConsoleGetter: uniq(states("cdpConsoleGetter").flat()).sort(),
        mlCdpStream: states("mlCdpStream").includes(true), mlIsoStream: states("mlIsoStream").includes(true),
        globalsAdded: uniq(states("globalsAdded").flat()).filter((k) => k !== "pageCall").sort(),
        windowMlMembers: states("windowMl").at(-1) ?? null,
        consoleSwapped: uniq(states("consoleSwapped").flat()).sort(),
        fnToStringPatched: states("fnToStringNative").includes(false),
        hasFocus: uniq(states("hasFocus")), visibility: uniq(states("visibility")), innerSizes: uniq(states("inner").map((v) => v.join("x"))),
        rafHz: uniq(states("rafHz")), webdriverChanges: states("webdriver"),
        resizes: ev(["resize"]).length, focusEvents: ev(["focus", "blur"]).map((e) => `${e.type}:${e.target}`),
        lifecycle: ev(["freeze", "resume", "visibilitychange", "pagehide"]).map((e) => e.type),
        domAdded: uniq(rs.filter((e) => e.kind === "dom-add").map((e) => `${e.parent}>${e.tag}${e.id ? "#" + e.id : ""}${e.src ? `[src=${anonymize(e.src)}]` : ""}`)),
        domRemoved: uniq(rs.filter((e) => e.kind === "dom-remove").map((e) => `${e.parent}>${e.tag}${e.id ? "#" + e.id : ""}`)),
        domAttrs: uniq(rs.filter((e) => e.kind === "dom-attr").map((e) => `${e.target}@${e.name}`)),
        messages: uniq(rs.filter((e) => e.kind === "message").map((e) => e.type)),
        extIdLearnedBy: uniq(ids.map((e) => e.how)),
        warFetch: probe ? { injected: probe.injected.status ?? probe.injected.error, sidebar: probe.sidebar.status ?? probe.sidebar.error, manifest: probe.manifest.status ?? probe.manifest.error, bogus: probe.bogus.status ?? probe.bogus.error } : null,
        extensionCallers: uniq(rs.filter((e) => e.kind === "caller-stack").map((e) => e.fn)).sort(),
        pageCallCaller: rs.filter((e) => e.kind === "pagecall").map((e) => e.caller.map(anonymize))[0] ?? null,
        caughtStack: rs.filter((e) => e.kind === "pagecall-caught").map((e) => e.stack.map(anonymize))[0] ?? null,
        pointer: ev(["pointerdown", "mousedown", "pointerup", "mouseup", "click", "pointermove", "mousemove"]).map(shape),
        keys: ev(["keydown", "keypress", "keyup", "beforeinput", "input", "change"]).map(shape),
        sealed: rs.filter((e) => e.kind === "sealed-event").map((e) => ({ type: e.type, isTrusted: e.isTrusted })),
        did: rs.filter((e) => e.kind === "do").map((e) => ({ name: e.name, ok: e.ok, error: e.error })),
        scrolls: ev(["scroll"]).length, windowScreenXY: env.screenXY ?? null, navType: env.navType ?? null, referrer: env.referrer ?? null,
        // The value each watched state holds NOW (the last change on record, from the page's load on).
        final: Object.fromEntries(["mlCdpStream", "mlIsoStream", "consoleSwapped", "windowMl", "globalsAdded", "hasFocus", "visibility"].map((n) => [n, reports.filter((e) => e.kind === "state" && e.name === n).at(-1)?.value ?? null])),
    };
}
