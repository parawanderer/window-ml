// page-health.spec.mjs — what a window.ml run does when the page it works on is STUCK or DEAD.
//
// A delegated page tool is watched while it waits (src/sw/page-reachable.ts): a discarded tab is reloaded and retried,
// a closed tab fails as `gone`, anything else silent is given up after PAGE_SILENCE_CAP_MS (240 s). Three kinds of
// unhealthy page fall through that net: a page whose main thread SPINS, a page that NEVER FINISHES LOADING, and a
// renderer that CRASHES. Each row below asserts what a person would want (the tool fails in well under the cap, with a
// cause the model can act on, and the run goes on). They landed as `test.fail()` rows (#1703) and pass since the fix
// (crashed, busy and a stalled navigate told apart in delegate-send.ts, page-reachable.ts and sw-run-host.ts); each
// keeps its BEFORE THE FIX note of what it measured then.

import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { launchExtension, configureExtension, waitForMl, approveOrigin } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const PROBE = !!process.env.PAGE_HEALTH_PROBE;   // print what each row measured
/** "Well under the cap": the backstop is 240 s; a stuck page named within this is a real detection, not the backstop. */
const PROMPT_MS = Number(process.env.PAGE_HEALTH_WAIT_MS) || 45_000;

let ext, fake, site;

/** A page server: a healthy page, one that hangs mid-body, and one that never answers at all. */
async function startHealthSite() {
    /** @type {Set<import("node:http").ServerResponse>} */
    const held = new Set();
    /** @type {Set<import("node:net").Socket>} */
    const socks = new Set();
    const srv = createServer((req, res) => {
        const html = (b) => `<!doctype html><html><head><meta charset="utf-8"><title>health</title></head><body>${b}</body></html>`;
        if (req.url?.startsWith("/half")) {
            // headers and the start of the document, then the connection is held open: the parser never finishes.
            res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
            res.write(`<!doctype html><html><head><meta charset="utf-8"><title>half</title></head><body><h1>Half a page</h1><p>`);
            held.add(res);
            return;
        }
        if (req.url?.startsWith("/nothing")) { held.add(res); return; }   // not even headers: a navigation that never commits
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(html(`<h1>Healthy page</h1><p id="p">hello</p>`));
    });
    srv.on("connection", (s) => { socks.add(s); s.on("close", () => socks.delete(s)); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    return { url, stop: async () => { for (const s of socks) s.destroy(); await new Promise((r) => srv.close(r)); } };
}

test.describe.configure({ mode: "default", timeout: 90_000 });

test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    site = await startHealthSite();
    ext = await launchExtension({ sidePanel: true });
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", debugMode: "off" });
    await approveOrigin(ext.sw, site.url);   // BEFORE any page opens: a page stuck loading is never re-checked by waitForMl
});
test.afterAll(async () => { await ext?.close(); await fake?.stop(); await site?.stop(); });

/** The run log's `page` records for a tab (DUMP_RUN_LOG flushes the ring first; storage.session alone is one flush behind). */
async function pageRecords(tabId) {
    const log = await ext.sw.evaluate(async () => (await chrome.storage.session.get("ml_run_log"))["ml_run_log"] || []);
    return (Array.isArray(log) ? log : []).filter((e) => e.subsystem === "page" && e.detail?.tab === tabId)
        .map((e) => ({ kind: e.kind, reason: e.reason, level: e.level, ms: e.ms, tool: e.detail?.tool }));
}
async function allRecords(tabId) {
    const log = await ext.sw.evaluate(async () => (await chrome.storage.session.get("ml_run_log"))["ml_run_log"] || []);
    return log.filter((e) => e.detail?.tab === tabId).map((e) => `${e.subsystem}/${e.kind}${e.reason ? ":" + e.reason : ""}${e.ms ? "@" + e.ms : ""}`);
}

/** The text of the last tool result the model was shown, from the request the loop made after it. */
function lastToolText(call) {
    const msgs = call?.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].role === "tool") return typeof msgs[i].content === "string" ? msgs[i].content : JSON.stringify(msgs[i].content);
    return null;
}

/** Every tool result the model was shown, in order, from the newest request the loop made. */
function toolTexts(call) {
    return (call?.messages || []).filter((m) => m.role === "tool").map((m) => typeof m.content === "string" ? m.content : JSON.stringify(m.content));
}

/**
 * Run one scripted agent run on `page` whose tool call(s) land on a page made unhealthy by `breakIt`, and measure.
 * `breakIt(page, tabId)` runs when the model's first turn is served (so before its tool call is sent), or, with
 * `during`, `after` ms after it (so the call is already outstanding). `then` are further tool calls the model makes
 * once the first has a result; the run's last step is a plain answer, so "the run went on" means the model was asked again.
 * `elapsedMs[i]` is how long the model waited for tool call i's result, null when none came inside PROMPT_MS.
 */
async function measure(page, { tool, args, breakIt, during = false, after = 1500, then = [] }) {
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, new URL(page.url()).origin);
    await configureExtension(ext.sw, { debugMode: "devtools", agentHudInDevtools: false });
    const before = fake.calls().length;
    const calls = [tool ? { tool, args } : null, ...then];
    /** @type {number[]} */
    const stamps = [];
    fake.setScript([
        ...calls.map((c, i) => () => {
            stamps.push(Date.now());
            if (i === 0 && breakIt) { if (during) setTimeout(() => breakIt(page, tabId), after); else breakIt(page, tabId); }
            return { tool: c.tool, args: c.args };
        }),
        () => { stamps.push(Date.now()); return { content: "run went on" }; },
    ]);
    if (PROBE) page.on("console", (m) => console.log("PH-CONSOLE " + m.text().slice(0, 300)));
    page.evaluate(() => { window.ml.agent("Read the page.", { env: false, approvalRouting: "external" }).then((r) => console.log("AGENT-OK " + String(r?.summary).slice(0, 100)), (e) => console.log("AGENT-ERR " + e)); return true; }).catch((e) => console.log("PH-EVAL-ERR " + e));
    const deadline = Date.now() + PROMPT_MS;
    while (stamps.length < calls.length + 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 250));
    await new Promise((r) => setTimeout(r, 2500));   // the ring batches its writes
    const last = fake.calls().at(-1);
    const texts = toolTexts(last);
    const elapsedMs = calls.map((_, i) => stamps[i + 1] != null ? stamps[i + 1] - stamps[i] : null);
    const records = await pageRecords(tabId);
    const all = PROBE ? await allRecords(tabId) : [];
    const out = { all, elapsedMs, texts, records, modelCalls: fake.calls().length - before, ended: stamps.length === calls.length + 1 };
    if (PROBE) console.log("PAGE-HEALTH " + JSON.stringify(out));
    return out;
}

// --- A. a page whose main thread spins ---

test("A1. a spinning page: the tool names it BUSY and fails well under the cap, and the run goes on", async () => {
    // BEFORE THE FIX (measured, real cap): the tab reads awake, so the call waits the whole 240 s cap (241.6 s) and ends as `silent`:
    // "Error: could not reach the page to run "pageInfo" (the page did not answer for 240s — its tab is most likely asleep in
    // the background)." Two page/unreachable:silent records (240000 ms) are logged. The run then goes on.
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const r = await measure(page, { tool: "pageInfo", args: {}, breakIt: (p) => { p.evaluate(() => { setTimeout(() => { for (;;) { /* spin */ } }, 0); }).catch(() => {}); } });
    expect(r.elapsedMs[0], "the model got a result in well under the cap").not.toBeNull();
    const toolText = r.texts[0] ?? "";
    expect(toolText).toMatch(/busy|unresponsive|not responding|stuck/i);
    expect(toolText).not.toMatch(/asleep/i);
    expect(r.records.find((x) => x.kind === "unreachable")?.reason).toMatch(/busy|unresponsive|hung/);
    expect(r.ended, "the model was asked again").toBe(true);
    await page.close({ runBeforeUnload: false }).catch(() => {});
});

test("A2. a page that starts spinning DURING a call: the outstanding tool names it BUSY and fails well under the cap", async () => {
    // BEFORE THE FIX: the same as A1 (a `wait` of 30 s that the spinning page can never finish waits out the cap and ends as `silent`).
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const r = await measure(page, { tool: "wait", args: { ms: 30000 }, during: true, breakIt: (p) => { p.evaluate(() => { setTimeout(() => { for (;;) { /* spin */ } }, 0); }).catch(() => {}); } });
    expect(r.elapsedMs[0], "the model got a result in well under the cap").not.toBeNull();
    expect(r.texts[0] ?? "").toMatch(/busy|unresponsive|not responding|stuck/i);
    expect(r.texts[0] ?? "").not.toMatch(/asleep/i);
    expect(r.ended, "the model was asked again").toBe(true);
    await page.close({ runBeforeUnload: false }).catch(() => {});
});

// --- B. a page that never finishes loading ---

test("B1. a page stuck mid-load (headers and half a body, then silence): the content script is already there, so a page tool answers at once and the run goes on", async () => {
    // ALREADY WELL BEHAVED (measured): the content script runs at document_start, so pageInfo answers in ~20 ms on the half page.
    const page = await ext.context.newPage();
    await page.goto(site.url + "/half", { waitUntil: "commit" });
    await page.waitForFunction(() => !!(window.ml && window.ml.ready), null, { timeout: 15000 });
    const r = await measure(page, { tool: "pageInfo", args: {} });
    expect(r.elapsedMs[0]).toBeLessThan(5000);
    expect(r.texts[0] ?? "").toContain("/half");
    expect(r.ended, "the model was asked again").toBe(true);
    await page.close({ runBeforeUnload: false }).catch(() => {});
});

test("B1b. ...but nothing tells the model the page never finished loading", async () => {
    // BEFORE THE FIX: pageInfo returns URL, title, time, locale and browser, with no readyState; the model reads half a page as the page.
    const page = await ext.context.newPage();
    await page.goto(site.url + "/half", { waitUntil: "commit" });
    await page.waitForFunction(() => !!(window.ml && window.ml.ready), null, { timeout: 15000 });
    const r = await measure(page, { tool: "pageInfo", args: {} });
    expect(r.texts[0] ?? "").toMatch(/loading|did not finish|incomplete/i);
    await page.close({ runBeforeUnload: false }).catch(() => {});
});

test("B2. a navigation that never commits: navigate says the page did not load, and the next call is not held for the barrier", async () => {
    // BEFORE THE FIX: `navigate` holds 15.0 s (READOPT_TIMEOUT_MS, sw-run-host.ts:1354) and returns "Navigating to <url> … wait for the new page
    // to load, then continue." with no word that nothing arrived; the next pageInfo answers in ~15 ms from the OLD page (old URL), so
    // the model is silently on a page it did not ask for. No page/* record is written.
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const r = await measure(page, { tool: "navigate", args: { url: site.url + "/nothing" }, then: [{ tool: "pageInfo", args: {} }] });
    expect(r.elapsedMs[0]).not.toBeNull();
    expect(r.elapsedMs[0], "not the 15 s barrier").toBeLessThan(10_000);
    expect(r.texts[0] ?? "").toMatch(/finish loading|did not load|not load|timed out/i);
    // and the call after it is not held for a second barrier wait
    expect(r.elapsedMs[1]).not.toBeNull();
    expect(r.elapsedMs[1]).toBeLessThan(5000);
    await page.close({ runBeforeUnload: false }).catch(() => {});
});

// --- C. a renderer crash ---

const crash = async (page) => { const cdp = await page.context().newCDPSession(page); await cdp.send("Page.crash").catch(() => {}); };

test("C1. a crash BETWEEN calls: the next tool says the page crashed, `unreachable` is recorded as crashed, the run goes on", async () => {
    // BEFORE THE FIX: sendMessage to the dead renderer rejects at once ("Could not establish connection. Receiving end does not exist."; the tab
    // reads status "unloaded", discarded false). sw-run-host.ts:1277 takes that for a NAVIGATION: it waits the 15 s barrier and tells the
    // model "The page navigated while running "pageInfo" ... The new page is still loading — wait, then look." (15.3 s). Every later
    // call pays the same 15 s. No page/* record is written. The run goes on.
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const r = await measure(page, { tool: "pageInfo", args: {}, breakIt: (p) => crash(p), then: [{ tool: "pageInfo", args: {} }] });
    expect(r.elapsedMs[0]).not.toBeNull();
    expect(r.elapsedMs[0], "a dead renderer is known within a probe or two, not after the 15 s navigation barrier").toBeLessThan(10_000);
    expect(r.texts[0] ?? "").toMatch(/crash/i);
    expect(r.records.find((x) => x.kind === "unreachable")?.reason).toBe("crashed");
    expect(r.ended, "the model was asked again").toBe(true);
    await page.close({ runBeforeUnload: false }).catch(() => {});
});

test("C2. a crash MID-CALL: the outstanding tool says the page crashed, `unreachable` is recorded as crashed, the run goes on", async () => {
    // BEFORE THE FIX: the outstanding `wait` ends when the channel closes and gets the same "The page navigated while running "wait" ..." text
    // (1.5 s to the crash plus the 15 s barrier = 16.7 s); the next call pays another 15 s. No page/* record is written.
    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
    const r = await measure(page, { tool: "wait", args: { ms: 30000 }, during: true, breakIt: (p) => crash(p), then: [{ tool: "pageInfo", args: {} }] });
    expect(r.elapsedMs[0]).not.toBeNull();
    expect(r.elapsedMs[0], "a dead renderer is known within a probe or two, not after the 15 s navigation barrier").toBeLessThan(10_000);
    expect(r.texts[0] ?? "").toMatch(/crash/i);
    expect(r.records.find((x) => x.kind === "unreachable")?.reason).toBe("crashed");
    expect(r.ended, "the model was asked again").toBe(true);
    await page.close({ runBeforeUnload: false }).catch(() => {});
});
