// fetch-tables.spec.mjs — `fetch_url` against REAL table files, served over HTTP by this spec: a small CSV,
// a 50,000-row one, a semicolon-separated export mislabelled `text/plain`, and a Parquet file served as
// `application/octet-stream` (which is how most static hosts serve one).
//
// These exist because the interesting failures are all end-to-end. A unit test can prove `tableFromDelimited`
// discovers a semicolon; only this can prove the delimiter survives classification, the service worker's
// fetch, the message channel, the page-side parse and the tool's preview — and that the Parquet decoder,
// which is dynamically imported into a CLASSIC (non-module) MV3 service worker bundle, actually loads there.
// The large file is not padding either: it is the case the whole feature is for, where a 4,000-character clip
// would hide from the model that there are 50,000 rows.
import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parquetWriteBuffer } from "hyparquet-writer";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HAS_PYODIDE = existsSync(join(HERE, "../../dist/pyodide/pyodide.mjs"));

// One browser for the whole file (each test drives an agent run through the same extension), so pin the
// worker — the suite is fullyParallel and a shared beforeAll would otherwise run once per worker.
test.describe.configure({ mode: "default" });

const LARGE_ROWS = 50_000;

/** The files under test. A DIFFERENT ORIGIN from the page (a different port is a different origin), so every
 *  fetch opens the approval gate rather than being auto-approved as same-origin. */
async function startDataServer() {
    const small = ["id,name,price,qty", "1,Ada,12.50,3", "2,Bob,9.99,10", "3,Cy,4.00,7", "4,Dot,15.25,1", "5,Eve,0.99,42"].join("\n");
    // Semicolons AND a generic content-type: the header cannot classify it, so the body's delimiter is the
    // only thing that can. European exports really are shaped like this.
    const euro = ["city;population;area", "Lyon;522969;47.87", "Porto;231962;41.42", "Ghent;263927;156.2"].join("\n");
    const large = ["id,label,value,flag"];
    for (let i = 0; i < LARGE_ROWS; i++) large.push(`${i},row-${i},${(i * 1.5).toFixed(2)},${i % 2 === 0}`);
    const largeCsv = large.join("\n");
    // Parquet carries its own schema, so `dtypes` here are READ rather than inferred — including a real
    // BOOLEAN, which CSV has no way to declare.
    const parquet = Buffer.from(parquetWriteBuffer({
        columnData: [
            { name: "id", data: [1, 2, 3, 4] },
            { name: "name", data: ["Ada", "Bob", "Cy", "Dot"] },
            { name: "price", data: [12.5, 9.99, 4.0, 15.25] },
            { name: "in_stock", data: [true, false, true, true] },
        ],
    }));
    const routes = {
        "/small.csv": [small, "text/csv"],
        "/euro.csv": [euro, "text/plain; charset=utf-8"],
        "/large.csv": [largeCsv, "text/csv"],
        "/data.parquet": [parquet, "application/octet-stream"],
    };
    const srv = createServer((req, res) => {
        const p = (req.url || "/").split("?")[0];
        const hit = routes[p];
        if (!hit) { res.writeHead(404); return res.end("no"); }
        res.writeHead(200, { "content-type": hit[1], "cache-control": "no-store" });
        res.end(hit[0]);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) };
}

let ext, fake, site, data, page;

test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    site = await startPageServer({});
    data = await startDataServer();
    ext = await launchExtension();
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        modelFilter: "", debugMode: "off", autoApprovePython: true,
    });
    page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);
});

test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await site?.stop();
    await data?.stop();
});

async function waitForGate(sw) {
    await expect.poll(async () => (await sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 20000 }).toBe(1);
    const [gate] = await sw.evaluate(() => globalThis.__mlApprovals.list());
    return gate;
}

/** Drive ONE fetch_url call through a real agent run, approve its gate, and return the transcript the model
 *  saw on its final turn — i.e. exactly the text the tool put in front of it. */
async function fetchThroughAgent(url, args = {}) {
    const before = fake.calls().length;
    fake.setScript([
        { tool: "fetch_url", args: { url, ...args } },
        (req) => ({ content: req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n") }),
    ]);
    const runPromise = page.evaluate((u) => window.ml.agent(`Fetch ${u} and report it.`, { env: false, approvalRouting: "both" }), url);
    const gate = await waitForGate(ext.sw);
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await runPromise.catch(() => {});
    await expect.poll(() => fake.calls().length - before, { timeout: 30000 }).toBeGreaterThanOrEqual(2);
    return fake.calls().at(-1).messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
}

test("a small CSV comes back as a df.head(): rows, real shape, and inferred dtypes", async () => {
    const seen = await fetchThroughAgent(data.url + "/small.csv");
    expect(seen).toMatch(/type: csv/);
    expect(seen).toContain("id,name,price,qty");          // the header
    expect(seen).toContain("1,Ada,12.5,3");               // a row, CAST — 12.50 is a float, printed as pandas would
    expect(seen).toMatch(/\[5 rows x 4 columns\]/);       // the shape, in pandas' own words
    // The column types are the point of the exercise: whole numbers int64, a decimal column float64,
    // text object — the same answer read_csv would give.
    expect(seen).toMatch(/dtypes: id int64, name object, price float64, qty int64/);
    // A head, not a dump: the 6th row is not there.
    expect(seen).not.toContain("5,Eve");
});

test("a semicolon-separated export mislabelled text/plain is still discovered and parsed", async () => {
    const seen = await fetchThroughAgent(data.url + "/euro.csv");
    // The header said text/plain, so ONLY the body's shape can have classified this.
    expect(seen).toMatch(/type: csv/);
    expect(seen).toContain("city,population,area");       // parsed on ';', re-printed on ','
    expect(seen).toContain("Lyon,522969,47.87");
    expect(seen).toMatch(/dtypes: city object, population int64, area float64/);
    // The failure this guards against is the old behaviour: one column called "city;population;area".
    expect(seen).not.toContain("city;population;area");
});

test("a 50,000-row CSV reports its REAL size while showing five rows", async () => {
    const seen = await fetchThroughAgent(data.url + "/large.csv");
    expect(seen).toMatch(/type: csv/);
    // The whole reason the preview exists: the model is told how big the file is, which a 4,000-character
    // clip of rows could never tell it.
    expect(seen).toMatch(/\[50,000 rows x 4 columns\]/);
    expect(seen).toContain("0,row-0,0.00,true".replace("0.00", "0"));   // cast: "0.00" → 0
    expect(seen).not.toContain("row-500");                              // nowhere near a dump
    // And it stays small. A raw clip was 4,000 characters; this is a head plus two lines of description.
    expect(seen.length).toBeLessThan(4000);
    // The model is told how to get the REST — by URL, from the cache, not by re-fetching or read_csv.
    expect(seen).toMatch(/pass "[^"]*\/large\.csv" to python_exec's `tables`/);
});

test("a Parquet file decodes in the service worker, with dtypes read from its own schema", async () => {
    // Served as application/octet-stream, so the magic bytes are what identify it. This also proves the
    // dynamically-imported decoder loads inside a classic (non-module) MV3 service worker.
    const seen = await fetchThroughAgent(data.url + "/data.parquet");
    expect(seen).toMatch(/type: parquet/);
    expect(seen).toContain("id,name,price,in_stock");
    expect(seen).toContain("1,Ada,12.5,true");
    expect(seen).toMatch(/\[4 rows x 4 columns\]/);
    // `bool` is the dtype CSV can never produce: Parquet DECLARES it, so it is read, not guessed.
    expect(seen).toMatch(/dtypes: id int64, name object, price float64, in_stock bool/);
});

test("`pipe` opts out of the preview — a model that wrote a scan gets the lines its scan selected", async () => {
    const seen = await fetchThroughAgent(data.url + "/large.csv", { pipe: "grep row-4242 | head 2" });
    expect(seen).toContain("row-4242");
    expect(seen).not.toMatch(/dtypes:/);        // no preview
    expect(seen).toMatch(/piped through/);      // the pipe footer instead
});

test("`schema: true` on a CSV answers with the frame, not an 'isn't JSON' error", async () => {
    const seen = await fetchThroughAgent(data.url + "/small.csv", { schema: true });
    expect(seen).toMatch(/shape: \(5, 4\)/);
    expect(seen).toMatch(/dtypes: id int64/);
    expect(seen).not.toMatch(/isn't JSON/);
    expect(seen).not.toContain("1,Ada");        // structure WITHOUT the payload, as for JSON
});

test("python_exec loads the fetched table from the cache — no refetch, no read_csv", async () => {
    test.skip(!HAS_PYODIDE, "needs the bundled Pyodide (npm run fetch-pyodide) — self-skips without it");
    const url = data.url + "/small.csv";
    const before = fake.calls().length;
    // Turn 1 fetches (and parses). Turn 2 hands python_exec the SAME URL as a table source: it resolves out
    // of the fetch cache as a real DataFrame, which is what makes the pandas-shaped preview honest.
    fake.setScript([
        { tool: "fetch_url", args: { url } },
        { tool: "python_exec", args: { code: "print(df.shape, list(df.columns), str(df['price'].dtype), df['price'].sum())", mode: "readonly", tables: { df: url } } },
        (req) => ({ content: req.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n") }),
    ]);
    const runPromise = page.evaluate((u) => window.ml.agent(`Fetch ${u} then total its price column.`, { env: false, approvalRouting: "both", extraTools: [window.ml.pythonTool()] }), url);
    const gate = await waitForGate(ext.sw);
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await runPromise.catch(() => {});
    await expect.poll(() => fake.calls().length - before, { timeout: 60000 }).toBeGreaterThanOrEqual(3);
    const seen = fake.calls().at(-1).messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    // pandas agrees with the preview: same shape, same columns, and the dtype the preview PROMISED.
    expect(seen).toContain("(5, 4)");
    expect(seen).toContain("['id', 'name', 'price', 'qty']");
    expect(seen).toContain("float64");
    expect(seen).toContain("42.73");            // 12.50 + 9.99 + 4.00 + 15.25 + 0.99
});
