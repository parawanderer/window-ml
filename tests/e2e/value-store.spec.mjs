// The value store in a real browser (POINTER_VALUES slice 4): a fetched table past the page's parse cap is stored whole in
// the service worker's IndexedDB, held by the run that fetched it, evicted when a later write needs the room, and a read of
// the evicted value FAILS with the reason rather than handing back the preview. Its own browser, because it shrinks the
// budget. Reads go through the worker's test-only `__mlValues`: no tool reads a stored value until slice 5.
import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

test.describe.configure({ mode: "default" });

const HAS_PYODIDE = existsSync(join(dirname(fileURLToPath(import.meta.url)), "../../dist/pyodide/pyodide.mjs"));

/** Past MAX_TABLE_ROWS (200,000) and under the 8 MB read cap: its preview is not the whole table. */
const ROWS = 250_000;
/** Past the 8 MB TEXT cap (~11 MB): the page gets a prefix of it, and only the value store holds all of it. */
const HUGE_ROWS = 700_000;

async function startDataServer() {
    const lines = ["order_id,region,revenue"];
    for (let i = 0; i < ROWS; i++) lines.push(`${i},${["north", "south", "east", "west"][i % 4]},${(i % 97) + 0.5}`);
    const body = lines.join("\n");
    const huge = ["order_id,region,revenue"];
    for (let i = 0; i < HUGE_ROWS; i++) huge.push(`${i},${["north", "south", "east", "west"][i % 4]},${(i % 97) + 0.5}`);
    const hugeBody = huge.join("\n");
    const srv = createServer((req, res) => {
        const path = (req.url || "").split("?")[0];
        const b = path === "/orders.csv" ? body : path === "/huge.csv" ? hugeBody : null;
        if (b == null) { res.writeHead(404); return res.end("no"); }
        res.writeHead(200, { "content-type": "text/csv", "cache-control": "no-store" });
        res.end(b);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}`, bytes: Buffer.byteLength(body), hugeBytes: Buffer.byteLength(hugeBody), stop: () => new Promise((r) => srv.close(r)) };
}

let ext, fake, data, page;

test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    data = await startDataServer();
    ext = await launchExtension();
    // Room for ONE body (~3.8 MB) and not two.
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        modelFilter: "", debugMode: "off", autoApproveReadonly: true, autoApprovePython: true, valueStoreBudgetMB: 6,
    });
    page = await ext.context.newPage();
    await page.goto(`${fake.url}/api/version`);
    await waitForMl(page);
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await data?.stop();
});

/** One background-hosted run of scripted tool `steps`, every gate approved from the worker. Returns the run's hash and what
 *  each tool told the model, in order. */
async function runSteps(steps) {
    const before = fake.calls().length;
    fake.setScript([...steps, { content: "done" }]);
    const run = page.evaluate(() => window.ml.agent("Read the orders.", { env: false, approvalRouting: "both", toolTokens: true, extraTools: [window.ml.pythonTool()] }));
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline && fake.calls().length - before < steps.length + 1) {
        for (const g of await ext.sw.evaluate(() => globalThis.__mlApprovals.list())) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), g.key);
        await new Promise((r) => setTimeout(r, 200));
    }
    const result = await run;
    const tools = fake.calls().at(-1).messages.filter((m) => m.role === "tool").map((m) => String(m.content ?? ""));
    return { hash: result.hash, seen: tools.slice(-steps.length) };
}
/** A run that only fetches `url` under a pointer label. */
async function fetchInRun(url, label) {
    const { hash, seen } = await runSteps([{ tool: "fetch_url", args: { url, token: label } }]);
    return { hash, seen: seen[0] };
}

const rows = () => ext.sw.evaluate(() => globalThis.__mlValues.rows());

test("a table past the parse cap is stored whole and held by its run; the next one evicts it, and reading it fails with why", async () => {
    test.setTimeout(120_000);
    const first = await fetchInRun(`${data.url}/orders.csv?copy=1`, "the first orders");
    expect(first.seen, "setup: the model got the preview, which already knows the real size").toMatch(/\[250,000 rows x 3 columns\]/);
    await expect.poll(rows, { timeout: 10_000 }).toHaveLength(1);
    const [a] = await rows();
    expect(a).toMatchObject({ format: "csv", source: `${data.url}/orders.csv?copy=1`, bytes: data.bytes });
    expect(a.sessions, "claimed by the run whose pointer names it").toEqual([first.hash]);
    expect(await ext.sw.evaluate((k) => globalThis.__mlValues.read(k), a.key)).toMatchObject({ bytes: data.bytes });

    const second = await fetchInRun(`${data.url}/orders.csv?copy=2`, "the second orders");
    await expect.poll(async () => (await rows()).map((r) => r.source), { timeout: 10_000 }).toEqual([`${data.url}/orders.csv?copy=2`]);
    expect((await rows())[0].sessions).toEqual([second.hash]);

    const gone = await ext.sw.evaluate((k) => globalThis.__mlValues.read(k), a.key);
    expect(gone.name).toBe("ValueMissing");
    expect(gone.error).toMatch(/orders\.csv\?copy=1\) was evicted to keep the value store within its storage budget, so only its preview is left\. Re-run the step that produced it/);

    await expect.poll(async () => (await page.evaluate(() => window.ml.__housekeeping()))
        .filter((e) => e.subsystem === "value-store").map((e) => [e.kind, e.reason, e.bytes]), { timeout: 10_000 })
        .toEqual([["evict", "budget", data.bytes]]);
});

test("python_exec reads a stored table WHOLE by pointer; once a later fetch evicts it, the same pointer fails with why", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide)");
    test.setTimeout(180_000);
    const py = { mode: "readonly", tables: { df: '@tool:"the orders"' }, code: "return [len(df), round(float(df['revenue'].sum()), 1), str(df.dtypes['order_id'])]" };
    const { seen } = await runSteps([
        { tool: "fetch_url", args: { url: `${data.url}/orders.csv?copy=3`, token: "the orders" } },
        { tool: "python_exec", args: py },
        { tool: "fetch_url", args: { url: `${data.url}/orders.csv?copy=4`, token: "more orders" } },
        { tool: "python_exec", args: py },
    ]);
    expect(seen[0], "setup: a preview, not the whole table").toMatch(/\[250,000 rows x 3 columns\]/);
    // Every row, where the preview holds 200,000: the sum over the whole revenue column, computed the same way here.
    let sum = 0;
    for (let i = 0; i < ROWS; i++) sum += (i % 97) + 0.5;
    expect(seen[1]).toContain(`[250000,${sum},"int64"]`);
    expect(seen[1], "and the note says the size that was loaded, not the preview's").toContain("a 250000×3 DataFrame → `df`");
    expect(seen[3], "the evicted value fails loudly, never the preview").toMatch(/could not load `df` from @tool:[0-9a-f]{7} \("the orders"\): the stored value v[0-9a-f]{16} \(http[^)]*copy=3\) was evicted to keep the value store within its storage budget/);
});

test("a DataFrame python_exec returns is stored whole, and a later python_exec reads every row by its pointer", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide)");
    test.setTimeout(180_000);
    const { seen } = await runSteps([
        { tool: "python_exec", args: { mode: "readonly", token: "the frame", code: "import pandas as pd\nreturn pd.DataFrame({'x': range(1000), 'y': [i * 0.5 for i in range(1000)]})" } },
        { tool: "python_exec", args: { mode: "readonly", tables: { df: '@tool:"the frame"' }, code: "return [len(df), int(df['x'].sum()), float(df['y'].max())]" } },
    ]);
    expect(seen[0], "setup: python produced a frame").toMatch(/1000 rows/);
    expect(seen[1]).toContain("a 1000×2 DataFrame → `df`");
    expect(seen[1]).toContain("[1000,499500,499.5]");
    const stored = (await rows()).filter((r) => r.source === "python_exec");
    expect(stored).toHaveLength(1);
    expect(stored[0].format).toBe("arrow-file");
});

test("exec reads a stored table's columns in full, on the approved path as well as the read-only one", async () => {
    test.setTimeout(120_000);
    const { seen } = await runSteps([
        { tool: "fetch_url", args: { url: `${data.url}/orders.csv?copy=5`, token: "all orders" } },
        // Read-only (auto-approved): the read is awaited for the survey.
        { tool: "exec", args: { js: 'const t = @tool:"all orders".table; return [t.rows.length, t.col("revenue").length]' } },
        // Out of the dialect (it writes a global), so approved: a real `eval`, where the read is a promise.
        { tool: "exec", args: { js: 'window.__mlStoredRead = 1; const t = @tool:"all orders".table; const r = await t.col("revenue"); return [r.length, r[ROWS_MINUS_ONE]]'.replace("ROWS_MINUS_ONE", String(ROWS - 1)) } },
    ]);
    expect(seen[0], "setup: a preview").toMatch(/\[250,000 rows x 3 columns\]/);
    expect(seen[1], "rows is the pointer's 200-row preview; the column is every row").toContain("[200,250000]");
    expect(seen[2]).toContain(`[250000,${((ROWS - 1) % 97) + 0.5}]`);
});

test("a CSV past the 8 MB text cap is stored WHOLE: its preview counts every row, and both runtimes read all of them", async () => {
    test.setTimeout(240_000);
    // Room for this one body; the earlier tests shrink the budget to force evictions.
    await configureExtension(ext.sw, { valueStoreBudgetMB: 64 });
    const steps = [
        { tool: "fetch_url", args: { url: `${data.url}/huge.csv`, token: "the huge table" } },
        { tool: "exec", args: { js: 'const t = @tool:"the huge table".table; const r = t.col("revenue"); return [t.shape[0], r.length, r[r.length - 1]]' } },
    ];
    if (HAS_PYODIDE) steps.push({ tool: "python_exec", args: { mode: "readonly", tables: { df: '@tool:"the huge table"' }, code: "return [len(df), int(df['order_id'].max())]" } });
    const { seen } = await runSteps(steps);
    expect(seen[0], "the preview says how big the table is, not how much of it fit in 8 MB").toMatch(/\[700,000 rows x 3 columns\]/);
    const stored = (await rows()).filter((r) => r.source === `${data.url}/huge.csv`);
    expect(stored.map((r) => [r.format, r.bytes]), "every byte of the body, not the 8 MB prefix").toEqual([["csv", data.hugeBytes]]);
    expect(seen[1]).toContain(`[${HUGE_ROWS},${HUGE_ROWS},${((HUGE_ROWS - 1) % 97) + 0.5}]`);
    if (HAS_PYODIDE) expect(seen[2]).toContain(`[${HUGE_ROWS},${HUGE_ROWS - 1}]`);
});
