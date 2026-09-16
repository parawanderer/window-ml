// pointer-values.spec.mjs — ACCEPTANCE tests for docs/spec/POINTER_VALUES.md, written BEFORE the slices that
// satisfy them: Arrow IPC over `fetch_url`/`ml.fetch`, and one table reused across JavaScript and Python through
// the pointer mechanism instead of being copied through a preview.
//
// Every test that describes unbuilt behaviour is marked `pending(…)` (a `test.fail()`) with the slice that will make it pass.
// That is the enforcement, not a skip: Playwright runs it, expects it to fail, and reports "expected to fail,
// but passed" the moment a slice lands — so the marker has to come off in that change, and the test then guards
// the behaviour for good. The cost of the marker is that ANY failure satisfies it, including a broken test, so
// each one asserts its setup first, where a wrong fixture would show up as a failure in the setup lines of the
// report rather than hide inside the expected one.
//
// The Arrow fixtures are written with `apache-arrow` (a dev dependency for exactly this, as `hyparquet-writer`
// is for Parquet). Columns are explicit Arrow types, so the dtypes a reader should report are known: Int64 →
// int64, Float64 → float64, Utf8 → str, Bool → bool.
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tableFromArrays, tableToIPC, vectorFromArray, Utf8, Bool, Float64, Int64 } from "apache-arrow";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HAS_PYODIDE = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs"));

/** Mark a test as describing unbuilt behaviour. `SHOW_PENDING=1` runs them unmarked, to read WHY each fails —
 *  do that when writing or reviewing one, since a marked test passes on any failure at all. */
const pending = (why) => test.fail(!process.env.SHOW_PENDING, why);

// One browser for the file: each test drives a run through the same extension.
test.describe.configure({ mode: "default" });

/** Rows past the page's parse cap (MAX_TABLE_ROWS, 200,000), under the 8 MB body cap: the size at which a
 *  pointer's PREVIEW and its VALUE stop being the same thing, which is the case the value store exists for. */
const BIG_ROWS = 300_000;

/** The stock table as Arrow, typed column by column. */
function stockArrow() {
    return tableFromArrays({
        sku: vectorFromArray(["A-100", "A-101", "B-200", "B-201"], new Utf8()),
        price: vectorFromArray([12.5, 9.99, 4.0, 15.25], new Float64()),
        stock: vectorFromArray([3n, 0n, 41n, 7n], new Int64()),
        discontinued: vectorFromArray([false, true, false, false], new Bool()),
    });
}

async function startDataServer() {
    const stock = stockArrow();
    const big = ["order_id,region,revenue"];
    for (let i = 0; i < BIG_ROWS; i++) big.push(`${i},${["north", "south", "east", "west"][i % 4]},${(i % 97) + 0.5}`);
    const routes = {
        // The File format: `ARROW1` magic, a footer with the schema. Its registered media type.
        "/stock.arrow": [Buffer.from(tableToIPC(stock, "file")), "application/vnd.apache.arrow.file"],
        // The Stream format: no magic — identified by media type or extension, never guessed from bytes.
        "/stock.arrows": [Buffer.from(tableToIPC(stock, "stream")), "application/vnd.apache.arrow.stream"],
        // How most static hosts actually serve one: the File format, as octet-stream. Only the magic can tell.
        "/export.bin": [Buffer.from(tableToIPC(stock, "file")), "application/octet-stream"],
        "/big.csv": [big.join("\n"), "text/csv"],
    };
    const srv = createServer((req, res) => {
        const hit = routes[(req.url || "/").split("?")[0]];
        if (!hit) { res.writeHead(404); return res.end("no"); }
        res.writeHead(200, { "content-type": hit[1], "cache-control": "no-store" });
        res.end(hit[0]);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}`, bytes: (p) => routes[p][0].length, stop: () => new Promise((r) => srv.close(r)) };
}

let ext, fake, data, page;

test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    data = await startDataServer();
    ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        modelFilter: "", debugMode: "off", autoApprovePython: true, autoApproveReadonly: true,
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

/**
 * Drive one scripted run and return the TOOL messages the model received, in order. `steps` are fake-LLM tool
 * steps; a final answer is appended. Every gate is approved from the service worker's channel, since the point
 * here is what the tools return, not whether they ask.
 */
async function runSteps(steps, { timeout = 60_000 } = {}) {
    const before = fake.calls().length;
    fake.setScript([...steps, { content: "done" }]);
    const run = page.evaluate(() => window.ml.agent("Work with the tables.", {
        env: false, approvalRouting: "both", toolTokens: true, extraTools: [window.ml.pythonTool()],
    }));
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline && fake.calls().length - before < steps.length + 1) {
        const pending = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
        for (const g of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), g.key);
        await new Promise((r) => setTimeout(r, 200));
    }
    await run.catch(() => {});
    const msgs = fake.calls().at(-1).messages;
    return msgs.filter((m) => m.role === "tool" && typeof m.content === "string").map((m) => m.content).slice(-steps.length);
}

// ---- Arrow over the fetch path -------------------------------------------------------------------------------

test("an Arrow IPC FILE fetches as a table: type arrow, the real shape, dtypes READ from its schema", async () => {
    pending("POINTER_VALUES: Arrow IPC accepted over ml.fetch / fetch_url (not built)");
    const [seen] = await runSteps([{ tool: "fetch_url", args: { url: `${data.url}/stock.arrow` } }]);
    expect(seen, "setup: the fetch reached the tool").toContain("stock.arrow");
    expect(seen).toMatch(/type: arrow/);
    expect(seen).toMatch(/\[4 rows x 4 columns\]/);
    expect(seen).toMatch(/dtypes: sku str, price float64, stock int64, discontinued bool/);
    expect(seen).toContain("A-100");
});

test("an Arrow IPC STREAM (.arrows, its own media type) fetches as the same table", async () => {
    pending("POINTER_VALUES: Arrow IPC stream format over fetch_url (not built)");
    const [seen] = await runSteps([{ tool: "fetch_url", args: { url: `${data.url}/stock.arrows` } }]);
    expect(seen, "setup: the fetch reached the tool").toContain("stock.arrows");
    expect(seen).toMatch(/type: arrow/);
    expect(seen).toMatch(/\[4 rows x 4 columns\]/);
});

test("an Arrow file served as application/octet-stream is recognised by its ARROW1 magic", async () => {
    pending("POINTER_VALUES: Arrow IPC classified by magic bytes (not built)");
    const [seen] = await runSteps([{ tool: "fetch_url", args: { url: `${data.url}/export.bin` } }]);
    expect(seen, "setup: the fetch reached the tool").toContain("export.bin");
    expect(seen).toMatch(/type: arrow/);
    expect(seen).toMatch(/dtypes: sku str, price float64, stock int64, discontinued bool/);
});

test("ml.fetch on an Arrow file hands the page the Table facade", async () => {
    pending("POINTER_VALUES: Arrow IPC accepted over ml.fetch (not built)");
    // A page may `ml.fetch` only a URL the run's fetch_url already had approved, so fetch it that way first.
    await runSteps([{ tool: "fetch_url", args: { url: `${data.url}/stock.arrow` } }]);
    const r = await page.evaluate(async (u) => {
        const res = await window.ml.fetch(u);
        return { ok: res.ok, type: res.type, prices: res.table ? res.table.col("price") : null, shape: res.table?.shape ?? null };
    }, `${data.url}/stock.arrow`);
    expect(r.ok, "setup: the fetch succeeded").toBe(true);
    expect(r.type).toBe("arrow");
    expect(r.shape).toEqual([4, 4]);
    expect(r.prices).toEqual([12.5, 9.99, 4, 15.25]);
});

// ---- One table, both runtimes, through pointers -------------------------------------------------------------

test("python_exec opens a fetched table by POINTER — tables: { df: \"@tool:…\" } — as a DataFrame", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide)");
    test.setTimeout(120_000);
    pending("POINTER_VALUES slice 5: python_exec reads a pointer (Arrow fetch not built either)");
    const [fetched, py] = await runSteps([
        { tool: "fetch_url", args: { url: `${data.url}/stock.arrow`, token: "the stock table" } },
        { tool: "python_exec", args: { mode: "readonly", tables: { df: '@tool:"the stock table"' },
            code: "print(df.shape); print(df.dtypes.to_dict()); return int(df['stock'].sum())" } },
    ]);
    expect(fetched, "setup: the fetch reached the tool").toContain("stock.arrow");
    expect(py).toContain("(4, 4)");
    expect(py).toMatch(/'stock': dtype\('int64'\)|'stock': 'int64'|stock.*int64/);
    expect(py).toMatch(/\b51\b/);
});

test("a DataFrame python_exec returns becomes a table POINTER that a later exec reads IN FULL, not its preview", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide)");
    test.setTimeout(120_000);
    pending("POINTER_VALUES slices 6 + 7: Python writes pointers back; the facade reads a stored table lazily");
    const [py, js] = await runSteps([
        { tool: "python_exec", args: { mode: "readonly", token: "the frame",
            code: "import pandas as pd\nreturn pd.DataFrame({'x': range(1000), 'y': [i * 0.5 for i in range(1000)]})" } },
        // A FULL exec: a stored table's column reads are requests, so they are awaited.
        { tool: "exec", args: { js: 'const t = @tool:"the frame".table; const x = await t.col("x"); return [t.shape[0], x.length, x[999]]' } },
    ]);
    expect(py, "setup: python produced a frame").toMatch(/1000|x/);
    expect(js).toContain("[1000,1000,999]");
});

test("a table past the page's parse cap reads every row by pointer, in JavaScript and in Python alike", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide)");
    test.setTimeout(180_000);
    pending("POINTER_VALUES slices 4, 5 + 7: the value store holds the whole table; both runtimes read it by pointer");
    const [fetched, js, py] = await runSteps([
        { tool: "fetch_url", args: { url: `${data.url}/big.csv`, token: "the big table" } },
        { tool: "exec", args: { js: 'const t = @tool:"the big table".table; return [t.shape[0], (await t.col("revenue")).length]' } },
        { tool: "python_exec", args: { mode: "readonly", tables: { df: '@tool:"the big table"' }, code: "return len(df)" } },
    ], { timeout: 150_000 });
    expect(fetched, "setup: the preview already knows the real size").toMatch(/\[300,000 rows x 3 columns\]/);
    expect(js).toContain(`[${BIG_ROWS},${BIG_ROWS}]`);
    expect(py).toContain(String(BIG_ROWS));
});
