// python-dialect-edits.spec.mjs — which EDITS a worker-hosted python_exec cell may make inside the read-only dialect, by
// who made the value, on the real fork core in the built extension: what the reshaping bench (reshape.bench.ts) counts.
//
// One worker-built run with Python auto-approval on, one namespace across its cells. A value an earlier INSIDE cell made
// stays owned in later cells (docs/dev/python-sandbox.md, the ownership note), so editing it runs unasked. The injected
// table is not the cell's, so writing a column to it asks. That cell is approved and reruns on the full path, which MARKS
// the worker (py-mark.ts): every later cell asks with the mark's line, whatever it does, so the cells after it (one that
// imports, one that edits what an asked cell made) ask for that reason, never for their own. The ownership refusal on a
// full-path-made value is held by tests/fixtures/dialect-vectors/ownership.json. Each asked cell reruns on the full path. Self-SKIPS
// without the fork core in dist/pyodide (python-dialect-inside.spec.mjs has the CI guard that a skip is not a pass).
import { test, expect } from "@playwright/test";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, configureExtension, waitForMl, watchRunEvents } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { salesCsv } from "../../examples/cross-page/sales.mjs";
import { MARKED_CARD_LINE } from "../../src/python/py-mark.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, "../../dist/pyodide/python_stdlib.zip");
const HAS_FORK = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs")) && existsSync(STDLIB) && readFileSync(STDLIB).includes("restricted.py");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The cells in order, each with whether it should ask and, if so, the refusal its card names. */
const CELLS = [
    { name: "inside makes", code: "kept = [1, 2]\nlen(kept)", asks: null },
    { name: "inside edits what inside made", code: "kept.append(3)\nkept[0] = 9\nkept", asks: null },
    { name: "edits the injected table", code: "df['flag'] = 1\nlen(df)", tables: true, asks: "item assignment to a value the cell does not own: on DataFrame" },
    { name: "asked cell makes", code: "import subprocess\nmade = [1]\nlen(made)", asks: MARKED_CARD_LINE },
    { name: "edits what an asked cell made", code: "made.append(2)\nmade", asks: MARKED_CARD_LINE },
];

/** Serve a blank page and /sales.csv on 127.0.0.1. */
async function serveSite() {
    const srv = http.createServer((req, res) => {
        if (req.url === "/sales.csv") { res.writeHead(200, { "content-type": "text/csv" }); return res.end(salesCsv()); }
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<!doctype html><title>Edits</title><p>hello</p>");
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** The tool results the driver was sent in its last call, in order. */
const toolResults = (fake) => (fake.calls().filter((c) => c.tools?.length).at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

// --- an edit's outcome depends on who made the value ---

test("an inside-made value is edited unasked; the injected table and an asked cell's value ask, each with the refusal named", async () => {
    test.skip(!HAS_FORK, "needs the restricted-mode fork core in dist/pyodide (npm run fetch-pyodide, then build)");
    test.setTimeout(180000);
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await serveSite();
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", autoApprovePython: true });
        const page = await ext.context.newPage();
        await page.goto(site.url);
        await waitForMl(page);
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        const events = [];
        const watch = await watchRunEvents(ext, page, (ev) => events.push(ev));
        const csvUrl = site.url + "sales.csv";
        fake.setScript([
            { tool: "fetch_url", args: { url: csvUrl } },
            ...CELLS.map((c) => ({ tool: "python_exec", args: { code: c.code, ...(c.tables ? { tables: { df: csvUrl } } : {}) } })),
            { content: "done" },
        ]);
        await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "edit some values", hud: "quiet", surface: "overlay" }, { approvalRouting: "both" }), tabId);

        // Approve every gate as it opens, until the model has been called once per scripted turn.
        const want = CELLS.length + 2;
        const gates = [];
        for (let i = 0; i < 1500 && fake.calls().length < want; i++) {
            for (const g of await ext.sw.evaluate(() => globalThis.__mlApprovals.list())) {
                gates.push(g.tool);
                await ext.sw.evaluate((k) => globalThis.__mlApprovals.resolve(k, true), g.key);
            }
            await sleep(100);
        }
        for (let i = 0; i < 100 && events.some((e) => e.kind === "agent-step" && e.pending); i++) await sleep(100);
        await watch.close();
        expect(fake.calls().length, "the run reached its last turn").toBe(want);
        expect(gates.filter((t) => t === "python_exec").length, JSON.stringify(gates)).toBe(CELLS.filter((c) => c.asks).length);

        // Per cell: the step that finished, and the gate's askWhy if one opened.
        const steps = (code) => events.filter((e) => e.kind === "agent-step" && e.tool === "python_exec" && e.arguments?.code === code);
        const outcome = CELLS.map((c) => {
            const asked = steps(c.code).find((e) => e.askWhy);
            return { name: c.name, approval: steps(c.code).find((e) => e.result != null)?.approval ?? null, why: asked?.askWhy?.line ?? null };
        });
        for (const [i, c] of CELLS.entries()) {
            const o = outcome[i];
            if (!c.asks) {
                expect(o.approval, `${c.name}: ${JSON.stringify(o)}`).toBe("sandbox");
                expect(o.why, c.name).toBeNull();
            } else {
                expect(o.approval, `${c.name}: ${JSON.stringify(o)}`).not.toBe("sandbox");
                expect(o.why, c.name).toContain(c.asks);
            }
        }

        // What the model read: the inside edit's own value, and each approved rerun's.
        const out = toolResults(fake);
        expect(out.length, JSON.stringify(out)).toBe(CELLS.length + 1);
        expect(out[2]).toContain("[9,2,3]");
        expect(out[3]).toContain("3000");
        expect(out[5]).toContain("[1,2]");
    } finally { await ext.close(); fake.stop?.(); await site.close(); }
});
