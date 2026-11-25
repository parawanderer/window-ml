// python-outside-mark.spec.mjs — after a cell of a run ran OUTSIDE the read-only Python dialect, no later cell in that
// worker is tried inside it: each asks, so code an approved cell planted never runs in a cell nobody was asked about.
//
// docs/spec/PYTHON_DIALECT.md, "What an inside run may leave behind is data, never code" (the third layer); py-mark.ts.
// A worker-built run with Python auto-approval on, in the built extension on the fork core: an inside cell runs with no
// card; an outside cell plants code into pandas (tests/python-outside-plant.test.mjs shows the plant runs ungated inside
// on one interpreter) and is approved; the next two cells, inside-shaped, both ask. The first card says why and the
// model is told once; the second asks with the same line and tells the model nothing more. Without the mark the third
// cell runs inside, unasked, and its output carries the plant. Self-SKIPS without the fork core in dist/pyodide.
import { test, expect } from "@playwright/test";
import http from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension, configureExtension, waitForMl, watchRunEvents } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { MARKED_CARD_LINE, MARKED_MODEL_LINE } from "../../src/python/py-mark.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const STDLIB = join(HERE, "../../dist/pyodide/python_stdlib.zip");
/** The fork's core ships `restricted.py` in its stdlib zip, whose central directory names it uncompressed. */
const HAS_FORK = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs")) && existsSync(STDLIB) && readFileSync(STDLIB).includes("restricted.py");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SETUP = "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2, 3]})\ndf.head(2).shape[0]";
const PLANTS = {
    "the admitted function's own code": "import pandas as pd\ndef _p(self, n=5):\n    print('PLANTED')\n    return n\npd.DataFrame.head.__code__ = _p.__code__\n1",
    "a callee of an admitted function": "from pandas.core.indexing import _iLocIndexer\n_orig = _iLocIndexer.__getitem__\ndef _g(self, key):\n    print('PLANTED')\n    return _orig(self, key)\n_iLocIndexer.__getitem__ = _g\n1",
};
const AFTER = "df.head(2).shape[0]";
const AGAIN = "len(df)";

/** Serve a blank page on 127.0.0.1. */
async function servePage() {
    const srv = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end("<!doctype html><title>Mark</title><p>hello</p>"); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}/`, close: () => new Promise((r) => srv.close(r)) };
}

/** The tool results the driver was sent in its last call, in order. */
const toolResults = (fake) => (fake.calls().filter((c) => c.tools?.length).at(-1)?.messages ?? []).filter((m) => m.role === "tool").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

// --- an approved plant never runs in an unasked cell ---

for (const [label, plant] of Object.entries(PLANTS)) {
    test(`after an approved cell plants into ${label}, every later cell of the worker asks, and the model is told once`, async () => {
        test.skip(!HAS_FORK, "needs the restricted-mode fork core in dist/pyodide (npm run fetch-pyodide, then build)");
        test.setTimeout(180000);
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
            const cells = [SETUP, plant, AFTER, AGAIN];
            fake.setScript([...cells.map((code) => ({ tool: "python_exec", args: { code } })), { content: "done" }]);
            await ext.sw.evaluate((id) => globalThis.__mlStartUserRunForTest(id, { task: "plant then read", hud: "quiet", surface: "overlay" }, { approvalRouting: "both" }), tabId);
            // Approve every card as the person would; the run ends when the model has had every result.
            for (let i = 0; i < 1500 && fake.calls().length < cells.length + 1; i++) {
                for (const g of await ext.sw.evaluate(() => globalThis.__mlApprovals.list())) await ext.sw.evaluate((k) => globalThis.__mlApprovals.resolve(k, true), g.key);
                await sleep(100);
            }
            await watch.close();
            const asked = events.filter((e) => e.kind === "agent-step" && e.tool === "python_exec" && e.pending && (e.awaitingApproval || e.approvalExternal));
            const askedCodes = [...new Set(asked.map((e) => e.arguments?.code))];
            expect(askedCodes, "the setup ran inside; the plant and both later cells asked").toEqual([plant, AFTER, AGAIN]);
            const why = (code) => asked.find((e) => e.arguments?.code === code)?.askWhy;
            expect(why(AFTER)?.cause).toBe("sandbox-marked");
            expect(why(AFTER)?.line).toBe(MARKED_CARD_LINE);
            expect(why(AGAIN)?.line).toBe(MARKED_CARD_LINE);
            const out = toolResults(fake);
            expect(out.length, JSON.stringify(out)).toBe(4);
            expect(out[2], "the first marked cell's result tells the model why").toContain(MARKED_MODEL_LINE);
            expect(out[3], "and only the first").not.toContain(MARKED_MODEL_LINE);
            const log = await ext.sw.evaluate(async () => (await globalThis.__mlRunLog.all()).filter((x) => x.kind === "outside-mark").length);
            expect(log, "the run log records the mark once").toBe(1);
        } finally { await ext.close(); fake.stop?.(); await site.close(); }
    });
}
