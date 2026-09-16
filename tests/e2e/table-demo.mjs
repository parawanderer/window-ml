// table-demo.mjs — a NARRATED VISUAL demo (not a test) of FETCHING TABLE-LIKE PAGES and then working on them.
//
//   npm run build && node --import tsx tests/e2e/table-demo.mjs
//
// THE PROBLEM IT EXISTS FOR, in one sentence: a CSV used to arrive as four thousand characters of raw rows,
// which is both too much to read and too little to reason about — it hides how big the file is, so a model
// cannot tell whether its answer covers the data.
//
// Six beats, all driven by a scripted fake-LLM so it runs hands-free:
//
//   1. A CSV COMES BACK AS A FRAME. Not the body: a `df.head()` — five rows, then `[50,000 rows x 4 columns]`
//      and the dtypes. The shape is the part a clip can never carry, and it is what tells the model that the
//      five rows it is looking at are five of fifty thousand.
//   2. THE SEPARATOR IS DISCOVERED. The second file is semicolon-separated and served as `text/plain`, so
//      nothing but the body's own shape can classify it. It used to land as one column called
//      "city;population;area"; now it is three, with dtypes.
//   3. PARQUET, WHICH HAS NO TEXT FORM AT ALL. Served as `application/octet-stream` and identified by its
//      magic bytes. Its dtypes are READ from the file's schema rather than inferred — including `bool`,
//      which CSV has no way to declare.
//   4. GREP INSTEAD, WHEN THAT IS WHAT YOU WANTED. `pipe` opts out of the preview: a model that wrote a scan
//      gets the lines its scan selected, not our summary of the whole file.
//   5. THE READ-ONLY DIALECT WORKS ON IT, FOR FREE. A survey filters the fetched table and never prompts —
//      it is a pure read of bytes already approved, so it auto-approves. Watch for the absence of a gate.
//   6. THEN THE TWO ESCALATIONS. A full `exec` reaches the same table through a `@tool:` POINTER (resolved
//      before the script runs, so no `await`), and `python_exec` loads it by URL out of the fetch cache as a
//      real pandas DataFrame — no second request, and no `read_csv` in a sandbox that has no network. The
//      shape and dtypes pandas reports are the ones the preview promised in beat 1.
//
// Screenshots land in tests/e2e/artifacts/table-demo/. Env: HOLD=0 to exit instead of waiting.
import path from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { parquetWriteBuffer } from "hyparquet-writer";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "table-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";
const ROWS = 50_000;

/** The files, served over HTTP so this is a real fetch of a real body — content types included, because the
 *  classification is half of what is being shown. */
async function startDataServer() {
    const sales = ["order_id,region,revenue,units"];
    for (let i = 0; i < ROWS; i++) {
        sales.push(`${1000 + i},${["north", "south", "east", "west"][i % 4]},${(9.99 + (i % 97) * 3.5).toFixed(2)},${1 + (i % 12)}`);
    }
    const cities = ["city;population;area", "Lyon;522969;47.87", "Porto;231962;41.42", "Ghent;263927;156.2", "Aarhus;285273;91.0"].join("\n");
    const parquet = Buffer.from(parquetWriteBuffer({
        columnData: [
            { name: "sku", data: ["A-100", "A-101", "B-200", "B-201"] },
            { name: "price", data: [12.5, 9.99, 4.0, 15.25] },
            { name: "stock", data: [3, 0, 41, 7] },
            { name: "discontinued", data: [false, true, false, false] },
        ],
    }));
    const routes = {
        "/sales.csv": [sales.join("\n"), "text/csv"],
        "/cities.csv": [cities, "text/plain; charset=utf-8"],   // semicolons, and a header that says nothing
        "/stock.parquet": [parquet, "application/octet-stream"],
    };
    const srv = createServer((req, res) => {
        const hit = routes[(req.url || "/").split("?")[0]];
        if (!hit) { res.writeHead(404); return res.end("no"); }
        res.writeHead(200, { "content-type": hit[1], "cache-control": "no-store" });
        res.end(hit[0]);
    });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    return { url: `http://127.0.0.1:${srv.address().port}`, stop: () => new Promise((r) => srv.close(r)) };
}

const main = async () => {
    const log = (m) => console.log(m);
    const fake = await startFakeLlm({ model: "fake-model" });
    const data = await startDataServer();
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
            autoApproveReadonly: true,   // beat 5 is ABOUT this: a read-only survey never prompts
        });

        const SALES = `${data.url}/sales.csv`;
        // The read-only survey. `ml.fetch` is CACHE-ONLY in the dialect, so this reads bytes the human already
        // approved — no egress, no prompt. It filters the parsed table rather than re-splitting the text.
        const SURVEY = [
            `const t = ml.fetch(${JSON.stringify(SALES)}).table;`,
            `const r = t.columns.indexOf("region"), u = t.columns.indexOf("units");`,
            `const west = t.rows.filter(row => row[r] === "west");`,
            `return { shape: t.shape, dtypes: t.dtypes, westRows: west.length, westUnits: west.reduce((a, row) => a + row[u], 0) };`,
        ].join("\n");
        // The full exec, reaching the SAME table through the pointer minted by the fetch step. `@tool:` is
        // resolved before the script runs, so it is not a promise and needs no await.
        const VIA_POINTER = [
            `const t = @tool:1.table;`,
            `const rev = t.columns.indexOf("revenue");`,
            `const top = t.rows.slice().sort((a, b) => b[rev] - a[rev]).slice(0, 3);`,
            `console.log("columns:", t.columns.join(", "));`,
            `return { rows: t.shape[0], top3revenue: top.map(r => r[rev]) };`,
        ].join("\n");
        const PY = [
            "print('shape', df.shape)",
            "print('dtypes'); print(df.dtypes)",
            "by = df.groupby('region')['revenue'].sum().sort_values(ascending=False)",
            "print(by)",
            "return by.reset_index()",
        ].join("\n");

        fake.setScript([
            { tool: "fetch_url", args: { url: SALES } },
            { tool: "fetch_url", args: { url: `${data.url}/cities.csv` } },
            { tool: "fetch_url", args: { url: `${data.url}/stock.parquet` } },
            { tool: "fetch_url", args: { url: SALES, pipe: "grep west | head 3" } },
            { tool: "exec", args: { js: SURVEY } },
            { tool: "exec", args: { js: VIA_POINTER } },
            { tool: "python_exec", args: { code: PY, mode: "readonly", tables: { df: SALES } } },
            { content: "Fetched three table formats, scanned one, and totalled revenue by region." },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 980 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);

        await narrate(page, "Fetching tables: CSV, a mislabelled semicolon export, and Parquet", { sub: "the run is starting" });
        log("starting the run …");
        await page.evaluate(() => {
            window.ml.agent("read the sales table and total revenue by region", {
                approvalRouting: "both", extraTools: [window.ml.pythonTool()],
            });
        });

        // The panel opens on the sessions LIST, so open the RUN inside it or every query below reads an
        // empty transcript (see openRunInSidebar).
        const frame = await openRunInSidebar(page, { task: "read the sales table" });

        // Approve from the SW-only channel so nothing waits on a click. The read-only survey (beat 5) never
        // appears here — that is the point of it — so this loop simply never sees a gate for that step.
        let gatesSeen = 0;
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            gatesSeen += pending.length;
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            await sleep(400);
            if (await frame.locator(".astep").count() >= 7) break;
        }
        await sleep(2000);

        const steps = frame.locator(".astep");
        log(`\n(${await steps.count()} steps; ${gatesSeen} approval gate(s) opened in total)`);

        /** Open one step and return the text of its Out block — what the MODEL was handed. */
        const outOf = async (n) => {
            const s = steps.nth(n);
            await s.locator(".astep-head").click().catch(() => {});
            await sleep(600);
            return (await s.locator(".io-body").last().textContent().catch(() => "")) || "";
        };

        // 1 — the CSV as a frame.
        await narrate(page, "1 — a 50,000-row CSV comes back as a df.head()", { sub: "five rows, then the SHAPE and the dtypes — the part a clip can never carry" });
        log("\n--- 1. fetch_url on a 50,000-row CSV — what the model was handed ---\n" + (await outOf(0)).trim().slice(0, 700));
        await frame.page().screenshot({ path: path.join(ART, "1-csv-head.png") });

        // 2 — the separator nobody declared.
        await narrate(page, "2 — semicolons, served as text/plain", { sub: "only the body's shape can classify this: three columns, not one" });
        log("\n--- 2. a semicolon export mislabelled text/plain ---\n" + (await outOf(1)).trim().slice(0, 500));
        await frame.page().screenshot({ path: path.join(ART, "2-discovered-separator.png") });

        // 3 — the binary one.
        await narrate(page, "3 — Parquet: no text form at all", { sub: "identified by magic bytes; its dtypes are READ from the schema, `bool` included" });
        log("\n--- 3. parquet, served as application/octet-stream ---\n" + (await outOf(2)).trim().slice(0, 500));
        await frame.page().screenshot({ path: path.join(ART, "3-parquet.png") });

        // 4 — grep instead.
        await narrate(page, "4 — `pipe` opts OUT of the preview", { sub: "a model that wrote a scan gets the lines its scan selected" });
        log("\n--- 4. the same CSV, but scanned: pipe grep west | head 3 ---\n" + (await outOf(3)).trim().slice(0, 500));
        await frame.page().screenshot({ path: path.join(ART, "4-piped-grep.png") });

        // 5 — the free one.
        await narrate(page, "5 — the read-only dialect filters it, with NO prompt", { sub: "a pure read of bytes already approved — watch for the gate that never appears" });
        log("\n--- 5. a READ-ONLY survey over the fetched table (auto-approved) ---\n" + (await outOf(4)).trim().slice(0, 600));
        await frame.page().screenshot({ path: path.join(ART, "5-readonly-survey.png") });

        // 6 — the escalations.
        await narrate(page, "6 — full exec, through a @tool: POINTER", { sub: "resolved before the script runs, so it is not a promise and needs no await" });
        log("\n--- 6a. full exec reaching the same table by pointer ---\n" + (await outOf(5)).trim().slice(0, 600));
        await frame.page().screenshot({ path: path.join(ART, "6a-exec-pointer.png") });

        await narrate(page, "7 — python_exec loads it from the CACHE as a real DataFrame", { sub: "no second request, no read_csv — and pandas reports the dtypes beat 1 promised" });
        log("\n--- 6b. python_exec with tables: { df: <the url> } ---\n" + (await outOf(6)).trim().slice(0, 800));
        await frame.page().screenshot({ path: path.join(ART, "6b-python-dataframe.png") });

        log(`\nScreenshots → ${ART}`);
        await narrateDone(page);
        if (HOLD) {
            log("\nHolding the browser open (HOLD=0 to exit immediately). Ctrl+C when done.");
            await new Promise(() => {});
        }
    } finally {
        if (!HOLD) { await ext.close(); await fake.stop(); await data.stop(); }
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
