// redteam-hard-act-judge-click-target.spec.mjs — independent browser rows for SITE_PRESENCE gap (8): locate beneath
// our sidebar must mint the page element's point, and the element resolved by the act judge must be the element the
// trusted click actually reaches. The clear-point control exercises the same path without either extension host.
//
// The two covered rows are expected failures on main. SHOW_PENDING=1 runs them unmarked to inspect their assertions;
// the security owner's branch removes both markers when their fixes land, before that branch merges.

import { test, expect } from "@playwright/test";
import { launchClean } from "./fixtures/detect/clean-browser.mjs";
import { startProbeSite, DETECT_RESOLVER_ARGS } from "./fixtures/detect/server.mjs";
import { openProbe, runOn, summarize, toolResults, waitFor } from "./fixtures/detect/measure.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

/** Mark an unbuilt defended outcome without skipping its measurement. */
const pending = (why) => test.fail(!process.env.SHOW_PENDING, why);

/** Every probe origin is a secure context, as in the detection-surface scenarios. */
const secureArgs = (site) => [`--unsafely-treat-insecure-origin-as-secure=${["probe.test", "other.test", "xo.test", "api.test"].map((h) => site.origin(h)).join(",")}`];

/** Evaluate in the probe without Runtime.enable, then detach; the fixture remains the only source of the event oracle. */
async function evalPage(b, targetId, expression) {
    const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    try {
        const r = await b.cdp.send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        return r.result.value;
    } finally {
        await b.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
}

/** Find a canvas-sized rectangle by actual hit-testing, never by the shadow host's own layout box. */
const FIND_RECT = (covered) => `(() => {
    const covered = ${JSON.stringify(covered)}, hosts = new Set(["ml-sb-root", "ml-sb-card"]);
    const hit = (x, y) => document.elementFromPoint(x, y)?.id || "";
    const fits = (x, y) => [[x, y], [x - 90, y - 30], [x + 90, y - 30], [x - 90, y + 30], [x + 90, y + 30]]
        .every(([px, py]) => covered ? hit(px, py) === "ml-sb-root" : !hosts.has(hit(px, py)));
    const found = [];
    for (let y = 80; y <= innerHeight - 80; y += 40) {
        for (let x = 120; x <= innerWidth - 120; x += 40) if (fits(x, y)) found.push({ x, y });
    }
    const goal = covered ? { x: innerWidth - 200, y: innerHeight / 2 } : { x: 260, y: innerHeight / 2 };
    found.sort((a, b) => Math.hypot(a.x - goal.x, a.y - goal.y) - Math.hypot(b.x - goal.x, b.y - goal.y));
    return found[0] || null;
})()`;

/** Click the closed sidebar's visible tab with trusted setup input; this is not the measured tool click. */
async function clickSidebarTab(b, targetId) {
    const pt = await waitFor(async () => {
        const p = await evalPage(b, targetId, `(() => { const x = innerWidth - 20, y = innerHeight / 2; return document.elementFromPoint(x, y)?.id === "ml-sb-root" ? { x, y } : null; })()`);
        return p;
    }, 15000, "the sidebar tab to receive a hit-test");
    const { sessionId } = await b.cdp.send("Target.attachToTarget", { targetId, flatten: true });
    try {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
            await b.cdp.send("Input.dispatchMouseEvent", { type, x: pt.x, y: pt.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 }, sessionId);
        }
    } finally {
        await b.cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
    }
}

const LOCATE = { tool: "locate", args: { description: "the Gap Eight Target canvas", selector: "#cv", strategy: "grid", gridSize: 2 } };
const PROPOSE = { tool: "propose_policy", args: { rules: [{ effect: "allow", consumer: "act", when: '(c) => c.action === "click" && c.element.name === "Gap Eight Target"', label: "Click Gap Eight Target" }] } };

/** Click the newest locate point; without one, try the other grid cell so the final turn reports the missing point. */
const clickLastPoint = (body) => {
    const token = JSON.stringify(body.messages).match(/@pt:[0-9a-f]+/g)?.at(-1);
    if (token) return { tool: "click", args: { selector: token } };
    return { ...LOCATE, args: { ...LOCATE.args, cells: [2] } };
};

/** Measure one fresh-browser case, stopping after locate when `click` is false; never hide an extension host here. */
async function measure(covered, { click = true } = {}) {
    const site = await startProbeSite();
    const fake = await startFakeLlm({ model: "fake-model" });
    fake.setSide(() => ({ content: "1" }));
    const b = await launchClean({ args: [...DETECT_RESOLVER_ARGS, ...secureArgs(site)] });
    try {
        await b.sw((c) => chrome.storage.sync.set(c), { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", autoApproveReadonly: false, defaultModelVision: "yes", debugMode: "overlay" });
        await b.sw((o) => chrome.storage.local.set({ ml_site_always: o }), [site.origin("probe.test")]);
        await b.sw(async () => {
            for (let i = 0; i < 100 && !(await chrome.scripting.getRegisteredContentScripts()).length; i++) await new Promise((r) => setTimeout(r, 20));
        });
        const page = await openProbe(b, site, "probe.test");
        await waitFor(() => page.reports().some((e) => e.kind === "dom-add" && e.id === "ml-sb-root"), 15000, "the overlay host to mount");
        await clickSidebarTab(b, page.targetId);
        await waitFor(() => evalPage(b, page.targetId, FIND_RECT(true)), 15000, "an open-sidebar rectangle to receive hit-tests");
        const point = await evalPage(b, page.targetId, FIND_RECT(covered));
        expect(point, `a ${covered ? "sidebar-covered" : "host-clear"} canvas rectangle`).toBeTruthy();
        const placed = await evalPage(b, page.targetId, `(() => {
            const c = document.getElementById("cv"), p = ${JSON.stringify(point)};
            c.setAttribute("aria-label", "Gap Eight Target");
            c.style.cssText = "position:fixed;left:" + (p.x - 100) + "px;top:" + (p.y - 40) + "px;width:200px;height:80px;margin:0;z-index:1";
            return { centre: document.elementFromPoint(p.x, p.y)?.id || "", rect: c.getBoundingClientRect().toJSON() };
        })()`);
        expect(placed.centre, "the arranged point is covered by the sidebar, or resolves to the canvas in the control").toBe(covered ? "ml-sb-root" : "cv");
        const t0 = Date.now();
        const script = click ? [PROPOSE, LOCATE, clickLastPoint, { content: "done" }] : [LOCATE, { content: "done" }];
        const { approved } = await runOn(b, fake, page.tabId, script, { surface: "overlay", hud: "quiet" });
        const results = toolResults(fake);
        if (click && results.some((r) => /@pt:[0-9a-f]+/.test(r))) await waitFor(() => page.reports().some((e) => e.kind === "event" && e.type === "click" && e.isTrusted && e.t >= t0), 10000, "the tool's trusted click in the fixture log");
        const pointer = summarize(page.reports(), t0).pointer;
        return { approved, results, clicks: pointer.filter((e) => e.type === "click" && e.isTrusted), point, placed };
    } finally {
        await b.close(); await fake.stop(); await site.stop();
    }
}

/** Locate returned a genuine canvas point inside the canvas the scenario placed, not a coordinate invented by the model. */
function expectCanvasPoint(row) {
    const result = row.results.find((r) => r.includes("@pt:")) || row.results.at(-1) || "";
    const match = result.match(/@pt:[0-9a-f]+[\s\S]*?at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)/);
    expect(match, `locate mints a coordinate on the named canvas: ${result}`).toBeTruthy();
    expect(result, "the point's surface is the page canvas").toContain("on a <canvas>");
    const [x, y] = [Number(match[1]), Number(match[2])], r = row.placed.rect;
    expect(x, "the minted point lies within the canvas horizontally").toBeGreaterThanOrEqual(r.left);
    expect(x).toBeLessThanOrEqual(r.right);
    expect(y, "the minted point lies within the canvas vertically").toBeGreaterThanOrEqual(r.top);
    expect(y).toBeLessThanOrEqual(r.bottom);
}

/** The judge-side oracle is identical in both click cases: a named-canvas allow replaces the click card. */
function expectJudged(row) {
    expect(row.approved, "only the run-scoped proposal needs a card; the act allow resolves the named canvas").toEqual(["propose_policy"]);
    expectCanvasPoint(row);
    expect(row.clicks, "exactly one trusted tool click reaches the fixture").toHaveLength(1);
}

// --- SITE_PRESENCE gap (8): hidden-host locate, then the judged element and the trusted click's actual target ---

test("control: a located point clear of our hosts is judged and clicked on the same canvas", async () => {
    test.setTimeout(90_000);
    const row = await measure(false);
    expectJudged(row);
    expect(row.clicks[0], "the clear point's actual target is the judged canvas").toMatchObject({ type: "click", isTrusted: true, target: "cv" });
});

test("covered locate mints a point on the canvas beneath the open sidebar", async () => {
    pending("SITE_PRESENCE gap (8) prerequisite: the locate hide must resolve the page element beneath our host");
    test.setTimeout(90_000);
    const row = await measure(true, { click: false });
    expect(row.approved, "locate itself needs no approval").toEqual([]);
    expect(row.clicks, "this row stops before dispatch").toHaveLength(0);
    expectCanvasPoint(row);
});

// Gated on the covered-locate row: main mints no point, so the click assertion is reachable only after that fix lands.
test("a located point beneath the open sidebar is judged and clicked on the same canvas", async () => {
    pending("SITE_PRESENCE gap (8): trusted dispatch must reach the element the act judge resolved");
    test.setTimeout(90_000);
    const row = await measure(true);
    expectJudged(row);
    expect(row.clicks[0], "the trusted click must reach the canvas the act judge resolved, not the covering host").toMatchObject({ type: "click", isTrusted: true, target: "cv" });
});
