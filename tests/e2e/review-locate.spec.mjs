// review-locate.spec.mjs — the part of the #561 review (a worker-built run's `locate` runs in the worker) that only a real
// browser shows: a page that navigates while it answers locate's layout questions. The page's main world answers the
// worker's geometry (injected.ts, PAGE_TOOL_RUN with `geometry`), so a hostile page sees each question arrive and can
// move under it: a pushState, a fragment change, or a full navigation, issued synchronously before its own answer.
// The worker must refuse the call whole (GEOMETRY_MOVED) and ask its reader nothing about the page's marks.
//
// tests/review-locate.test.mjs has the node:vm half (the same events fired by the fake chrome); here the events and their
// order relative to the page's answer are Chrome's own.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOVED = "The page changed while it was being looked at";

/** A page with two buttons whose script moves (`how`) when the worker first asks it for `op`. */
const PAGE = (how, op) => `<!doctype html><html><head><title>Mover</title><style>
html,body{margin:0;background:#fff} button{position:absolute;border:0;padding:0;margin:0;width:200px;height:100px;font-size:0}
#a{left:50px;top:40px;background:rgb(255,0,0)} #b{left:400px;top:300px;background:rgb(0,0,255)}
</style></head><body><button id="a">Red</button><button id="b">Blue</button><script>
let moved = false;
window.addEventListener("message", (e) => {
    const d = e.data;
    if (moved || !d || d.type !== "PAGE_TOOL_RUN" || !d.geometry || d.geometry.op !== ${JSON.stringify(op)}) return;
    moved = true;
    ${how === "push" ? 'history.pushState({}, "", "/moved")' : how === "hash" ? 'location.hash = "#moved"' : 'location.href = "/navigated"'};
}, true);
</script></body></html>`;

/** Serve PAGE(how, op) on 127.0.0.1 for every path, an origin nobody approves. */
async function servePage(how, op) {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); res.end(PAGE(how, op)); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

const promptOf = (body) => { const m = body.messages.at(-1); return typeof m.content === "string" ? m.content : m.content.filter((p) => p.type === "text").map((p) => p.text).join("\n"); };

/** A worker-built run on a fresh tab of the moving page whose driver calls `locate(args)` once. */
async function moverRun(how, op, args, side, cfg = {}) {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await servePage(how, op);
    const ext = await launchExtension();
    const subs = [];
    fake.setSide((body) => { subs.push(body); return { content: side(promptOf(body)) }; });
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", defaultModelVision: "yes", debugMode: "off", ...cfg });
    fake.setScript([{ tool: "locate", args }, { content: "done" }]);
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 800, height: 600 });
    await page.goto(site.url);
    await waitForMl(page, { approve: false });
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
    await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "find the red button", hud: "quiet", surface: "hud" }), tabId);
    const driver = () => fake.calls().filter((c) => c.tools?.length);
    for (let i = 0; i < 300 && driver().length < 2; i++) await sleep(100);
    expect(driver().length, "the driver was asked again after its locate").toBeGreaterThanOrEqual(2);
    return { subs, page, turn2: driver()[1], close: async () => { await ext.close(); fake.stop?.(); await site.close(); } };
}

/** The tool result the driver was given for its locate. */
const resultOf = (turn) => turn.messages.filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");

// --- a page that moves while it answers locate's layout questions ---

for (const how of ["push", "hash"]) {
    test(`a same-document navigation (${how === "push" ? "pushState" : "a fragment change"}) as the page is asked for its marks refuses the locate whole: no reader call about them`, async () => {
        const r = await moverRun(how, "marks", { description: "a red rectangle", strategy: "marks" }, () => "1");
        try {
            expect(resultOf(r.turn2)).toContain(MOVED);
            expect(r.subs.filter((s) => promptOf(s).startsWith("The screenshot has numbered badges")), "the reader was asked about the moved page's marks").toEqual([]);
        } finally { await r.close(); }
    });
}

test("a pushState as the page snaps a grounding box refuses the locate: the grounding call is made, nothing is minted or returned from the snap", async () => {
    const r = await moverRun("push", "snap", { description: "a red rectangle", strategy: "grounding" }, (p) => (p.startsWith("Locate") ? "70,60,300,165" : "NONE"),
        { groundingEnabled: true, groundingModel: "fake-model" });
    try {
        const out = resultOf(r.turn2);
        expect(out).toContain(MOVED);
        expect(out).not.toContain("#a");
        expect(r.subs.length, "the grounding call before the move only").toBe(1);
    } finally { await r.close(); }
});

test("a full navigation started as the page is asked for its marks refuses the locate: nothing of the call reaches the driver", async () => {
    // Unlike a pushState, `location.href = …` commits later than the page's answer: the reader may already have been
    // asked about the old document's capture and marks (the call's own document at that moment). What must hold is that
    // the call is refused whole once the commit lands, so the driver gets the fixed sentence and no pick.
    const r = await moverRun("navigate", "marks", { description: "a red rectangle", strategy: "marks" }, () => "1");
    try {
        const out = resultOf(r.turn2);
        expect(out).toMatch(new RegExp(`${MOVED}|could not be asked about its layout`));
        expect(out).not.toContain("Matched");
        expect(out).not.toContain("#a");
    } finally { await r.close(); }
});
