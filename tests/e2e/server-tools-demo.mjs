// server-tools-demo.mjs — a NARRATED VISUAL demo (not a test) of the remote-tool features.
//
//   npm run build && node --import tsx tests/e2e/server-tools-demo.mjs
//
// Opens a headful browser and walks the four things that landed together, in the order they happen to a run:
//   1. `serverTools`      — a bundle exposed as ONE TOOL PER FUNCTION, with the server's own schema
//   2. the approval card  — the first gate whose risk is "this sends your data somewhere", not "this
//                           changes your page", so the card says the arguments leave this machine
//   3. LIVE frames        — the executor's output streaming in, stamped with when IT produced each line
//   4. the `@tool:` macro — the run reading its own remote output back with SYNCHRONOUS pointer syntax
//
// …and finally the resource panel's event lane, where that remote step draws as net / queue / tool rather
// than one opaque bar — the split that only exists because the executor reports its own timing.
//
// Deterministic: the fake backend serves the tool list AND the NDJSON frames, so there is no real server,
// no key and no GPU. Approvals resolve from the SW's __mlApprovals channel so it runs hands-free.
// Screenshots land in tests/e2e/artifacts/server-tools-demo/. Env: HOLD=0 to exit at the end.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "server-tools-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";
const log = (s) => console.log(`  ${s}`);

// One bundle, one function, with a real schema — the shape `/api/v1/tools/` returns.
const BUNDLE = {
    id: "web_page_fetch_summarize", name: "Web Page Fetch & Summarize", description: "Fetch a page and read it against a question.",
    specs: [{
        name: "fetch_page",
        description: "Fetch one web page and read it against a specific question.",
        parameters: {
            type: "object",
            properties: { url: { type: "string", description: "The full http(s) URL to read." },
                          query: { type: "string", description: "What you want to know from it." } },
            required: ["url", "query"],
        },
    }],
};

// Paced so the output arrives progressively rather than all at once — which is the whole point of frames,
// and what a single JSON response cannot show. `atMs` is what the EXECUTOR says, so the gutter shows when
// each line was produced rather than when we happened to receive it.
const FRAMES = [
    { type: "output", text: "Fetching example.com\n", atMs: 8 },
    { type: "event", event: { type: "citation", data: { document: ["Example Domain — for use in documentation."], metadata: [{ source: "https://example.com/" }] } }, atMs: 40 },
    { type: "output", text: "Reading it with a local model\n", atMs: 60 },
    ...["This ", "domain ", "is ", "for ", "use ", "in ", "documentation ", "examples ", "without ", "needing ", "permission."]
        .map((w, i) => ({ type: "output", text: w, atMs: 900 + i * 120 })),
    { type: "output", text: "\n", atMs: 2300 },
    { type: "result", result: "This domain is for use in documentation examples without needing permission.", name: "fetch_page", durationMs: 2280, queuedMs: 140 },
];

// The pointer macro, reading the remote tool's own output back. No `await`: every reference written
// literally is resolved before the script starts, so this is an ordinary synchronous read — and the macro
// expands to exactly the call written out longhand above it, so the two spellings are the SAME object.
const EXEC_JS = `
const summary = ml.dereference("@tool:web_page_fetch_summarize__fetch_page");
console.log("are equal: " + (summary === @tool:web_page_fetch_summarize__fetch_page));
console.log("read " + summary.length + " characters back through a pointer");
console.log("first sentence:", summary.split(".")[0] + ".");
return summary.split(" ").length + " words";
`.trim();

// The event lane draws events against the MEMORY TRACE, so a box reporting nothing gives it no axis and the
// panel reads "0 B in use / nothing loaded". One card with one resident model is enough for the lane to have
// somewhere to place the run's steps.
const GiB = 1024 ** 3;
const DEVICE = { gpu_id: "0", name: "CUDA0", runner: "CUDA", compute: "12.0", driver: "13.2",
                 total_memory: 25757220864, physical_memory: 25769803776 };
const CAPACITY = {
    models: { count: 4, running: 1, vram_used: 9 * GiB },
    compute: {
        system_compute: { cpu_cores: 16, total_memory: 68719476736, free_memory: 40 * GiB, free_swap: 0 },
        supported_gpus: [{ ...DEVICE, free_memory: 25757220864 - 9 * GiB }],
    },
};
const RESIDENT = [{
    name: "fake-model", model: "fake-model", size: 9 * GiB, size_vram: 9 * GiB,
    gpus: [{ gpu_id: "0", runner: "CUDA", size_vram: 9 * GiB }],
}];

const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 120 });
fake.setCapacity(CAPACITY);
fake.setResident(RESIDENT);
const site = await startPageServer({});
const ext = await launchExtension({ headful: true });
try {
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "demo", apiFormat: "openai", model: "fake-model",
        debugMode: "overlay",   // overlay → the BACKGROUND-hosted path, which is the real one
    });
    fake.setServerTools([BUNDLE]);
    fake.setServerToolScript({ frames: FRAMES });
    fake.setScript([
        // 1-2-3: the model calls the generated per-function tool. It is gated, it streams, it returns.
        { tool: "web_page_fetch_summarize__fetch_page", args: { url: "https://example.com/", query: "what is this domain for" } },
        // 4: and reads its own output back with pointer syntax rather than retyping it.
        { tool: "exec", args: { js: EXEC_JS } },
        { content: "Fetched the page on the server, then read the result back through a pointer." },
    ]);

    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1500, height: 950 });
    await page.goto(site.url + "/");
    await waitForMl(page);

    // A console-first look at the namespace BEFORE the run: the schema is on the callable, and it is the
    // same object the call is validated against.
    log("ml.dynamicTools — the namespace, from the console:");
    const ns = await page.evaluate(async () => {
        const ids = await window.ml.dynamicTools.load();
        const fn = window.ml.dynamicTools.web_page_fetch_summarize.fetch_page;
        let rejected = null;
        try { await fn({ url: "https://example.com/" }); } catch (e) { rejected = String(e.message); }
        return { ids, required: fn.schema?.required, rejected };
    });
    log(`  bundles: ${ns.ids.join(", ")}`);
    log(`  .schema.required: ${JSON.stringify(ns.required)}`);
    log(`  a call missing one is refused locally: ${ns.rejected}`);

    log("starting the run (serverTools, streaming) …");
    await page.evaluate(() => {
        window.ml.agent("read example.com and tell me what it is for", {
            serverTools: ["web_page_fetch_summarize"], stream: true, approvalRouting: "both", maxSteps: 6,
        });
    });

    // Slide the overlay open and click into the live session.
    await page.waitForFunction(() => !!document.getElementById("ml-sb-root")?.shadowRoot?.getElementById("ml-sb-host"), null, { timeout: 15000 });
    await page.evaluate(() => {
        const root = document.getElementById("ml-sb-root").shadowRoot;
        const panel = root.getElementById("ml-sb-host");
        panel.style.width = `${Math.round(window.innerWidth / 2)}px`;
        panel.classList.add("open");
        root.getElementById("ml-sb-frame")?.contentWindow?.postMessage({ __mlSidebarOpen: true }, "*");
    });
    const frame = await (async () => {
        for (let i = 0; i < 60; i++) {
            const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
            if (f) return f;
            await sleep(100);
        }
        throw new Error("sidebar iframe never appeared");
    })();
    for (let i = 0; i < 40; i++) {
        const row = frame.locator("button.row").first();
        if (await row.count()) { await row.click({ timeout: 2000 }).catch(() => {}); break; }
        await sleep(200);
    }

    // The approval card. Screenshot it BEFORE resolving — this is the one gate whose risk is that data
    // leaves the machine, and the card is supposed to say so rather than showing a JSON blob.
    log("waiting at the approval gate (the card should say the arguments leave this machine) …");
    for (let i = 0; i < 100; i++) {
        const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).length);
        if (pending) break;
        await sleep(100);
    }
    await sleep(600);
    await page.screenshot({ path: path.join(ART, "1-approval.png") }).catch(() => {});
    const gate = await ext.sw.evaluate(() => globalThis.__mlApprovals.list()[0]);
    log(`  gate: ${gate?.tool} ${JSON.stringify(gate?.arguments)}`);
    await ext.sw.evaluate((k) => globalThis.__mlApprovals.resolve(k, true), gate.key);

    // The frames arriving. Several shots, because the point is that it fills in rather than appearing.
    log("streaming the executor's frames …");
    for (let i = 1; i <= 8; i++) {
        await sleep(400);
        await page.screenshot({ path: path.join(ART, `2-streaming-${String(i).padStart(2, "0")}.png`) }).catch(() => {});
    }

    // The exec step: approve it too, then show the pointer read.
    for (let i = 0; i < 100; i++) {
        const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).length);
        if (pending) {
            const g = await ext.sw.evaluate(() => globalThis.__mlApprovals.list()[0]);
            log(`  approving ${g.tool} — its In render shows the EXPANDED macro, with a note`);
            await sleep(500);
            await page.screenshot({ path: path.join(ART, "3-macro-expanded.png") }).catch(() => {});
            await ext.sw.evaluate((k) => globalThis.__mlApprovals.resolve(k, true), g.key);
            break;
        }
        await sleep(100);
    }

    await sleep(2500);
    await page.screenshot({ path: path.join(ART, "4-run-done.png") }).catch(() => {});

    // The event lane: the remote step drawn as net / queue / tool. Open the resource panel and let it poll.
    log("opening the resource panel — the remote step splits into net / queue / tool …");
    // The panel polls only while it is OPEN, so it needs several seconds of samples before the lane has an
    // axis wide enough to place anything on.
    await frame.locator("button[aria-label='VRAM monitor']").first().click({ timeout: 4000 }).catch(() => {});
    await sleep(9000);
    await page.screenshot({ path: path.join(ART, "5-event-lane.png") }).catch(() => {});

    console.log(`\n  screenshots in ${ART}`);
    if (HOLD) {
        console.log("  holding the browser open (HOLD=0 to skip). Close the window or Ctrl+C to exit.\n");
        await new Promise(() => {});
    }
} finally {
    if (!HOLD) { await ext.context.close(); await site.stop(); await fake.stop(); }
}
