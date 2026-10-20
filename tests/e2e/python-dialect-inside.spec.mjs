// python-dialect-inside.spec.mjs — a python_exec cell INSIDE the read-only dialect runs with no card, on the real fork
// core in the built extension; one that leaves it asks, and the card says where.
//
// docs/spec/PYTHON_DIALECT.md, "Membership replaces `mode`": membership is decided by running the cell under the fork's
// gate (`restricted.run_cell`) in the offscreen worker. A worker-built run with Python auto-approval on: the first cell
// finishes inside (no gate, approval `sandbox`); the second imports `os`, is refused at run time, and asks with the line
// "Outside the read-only Python dialect: import 'os' (line 2)" in the sidebar, and only the approved full run's result
// reaches the model. Self-SKIPS without dist/pyodide, or when it is the stock core (no `restricted.py` in the stdlib).
import { test, expect } from "@playwright/test";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, configureExtension, waitForMl, watchRunEvents, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, "../../dist/pyodide/python_stdlib.zip");
/** The fork's core ships `restricted.py` in its stdlib zip, whose central directory names it uncompressed. */
const HAS_FORK = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs")) && existsSync(STDLIB) && readFileSync(STDLIB).includes("restricted.py");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const INSIDE = "xs = [i * i for i in range(10)]\nsum(xs)";
const OUTSIDE = "x = 1\nimport os\nsorted(os.listdir('/'))[:1]";
const WHY = "Outside the read-only Python dialect: import 'os' (line 2)";

/** Serve a blank page on 127.0.0.1. */
async function servePage() {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Dialect</title><p>hello</p>"); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** The tool results the driver was sent in its last call, in order. */
const toolResults = (fake) => (fake.calls().filter((c) => c.tools?.length).at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

// --- under CI a fetched fork core must be the one shipped: a skip must not pass for a run ---

test("under CI, a job that fetched the fork core ships it in dist/pyodide", () => {
    test.skip(!process.env.CI || !existsSync(join(HERE, "../../pyodide-core/.pin")), "only under CI, in a job that ran `npm run fetch-pyodide` with an artefact pinned");
    expect(HAS_FORK, "the spec below would be skipped").toBe(true);
});

// --- inside runs unasked; outside asks with where it left ---

test("an inside cell runs with no card; an `import os` cell asks, and the card names the import and its line", async () => {
    test.skip(!HAS_FORK, "needs the restricted-mode fork core in dist/pyodide (npm run fetch-pyodide, then build)");
    test.setTimeout(150000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await servePage();
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", autoApprovePython: true });
        const page = await ext.context.newPage();
        await page.goto(site.url);
        await waitForMl(page);
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        const events = [];
        const watch = await watchRunEvents(ext, page, (ev) => events.push(ev));
        fake.setScript([
            { tool: "python_exec", args: { code: INSIDE } },
            { tool: "python_exec", args: { code: OUTSIDE } },
            { content: "done" },
        ]);
        await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "sum some squares", hud: "quiet", surface: "overlay" }, { approvalRouting: "both" }), tabId);

        // The outside cell's gate opens; by then the inside cell had finished without one.
        const steps = () => events.filter((e) => e.kind === "agent-step" && e.tool === "python_exec");
        await expect.poll(() => steps().some((e) => e.pending && e.awaitingApproval), { timeout: 90000 }).toBe(true);
        const asked = steps().filter((e) => e.pending && (e.awaitingApproval || e.approvalExternal));
        expect(asked.map((e) => e.arguments?.code), "only the outside cell asked").toEqual([OUTSIDE]);
        expect(asked[0].askWhy?.line).toBe(WHY);
        expect(asked[0].askWhy?.cause).toBe("outside-dialect");
        const done = steps().find((e) => e.arguments?.code === INSIDE && e.result != null);
        expect(done?.approval, "the inside cell's result is the sandbox's").toBe("sandbox");

        // The card in the sidebar says where the cell left the dialect.
        const frame = await openRunInSidebar(page, { task: "sum some squares" });
        await expect(frame.locator(".appr-askwhy")).toHaveText(WHY, { timeout: 20000 });

        // Approved, the cell runs on the full path, and that result is what the model reads.
        const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
        expect(gate?.tool).toBe("python_exec");
        await ext.sw.evaluate((k) => globalThis.__mlApprovals.resolve(k, true), gate.key);
        for (let i = 0; i < 600 && fake.calls().length < 3; i++) await sleep(100);
        await watch.close();
        const out = toolResults(fake);
        expect(out.length, JSON.stringify(out)).toBe(2);
        expect(out[0]).toContain("285");
        expect(out[1], "the full run's own result, not the refused try's").not.toMatch(/not in dialect/);
        expect(out[1]).toContain("outside the read-only Python dialect (import 'os' (line 2))");

        const log = await ext.sw.evaluate(async () => (await globalThis.__mlRunLog.all()).filter((x) => /^python-(inside|outside)$/.test(x.kind)).map((x) => x.kind));
        expect(log).toEqual(["python-inside", "python-outside"]);
    } finally { await ext.close(); fake.stop?.(); await site.close(); }
});
