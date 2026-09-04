// A DEBUG PROBE, not a test: drives `ml.execServerTool` against the REAL OpenWebUI on the box, through the
// built extension. Everything in tests/e2e/server-tools.spec.mjs drives frames this repo also writes, which
// is a closed loop; this is the only thing that exercises the actual service-worker fetch, the
// chrome-extension:// origin, the real auth header, and frames a server we did not write produced.
//
//   npm run build && node --import tsx tests/e2e/server-tool-live.mjs
//
// Reads OPENWEBUI_URL / OPENWEBUI_KEY from .env. Spends real GPU time on the box (fetch_page summarises with
// a local model), so it runs one small page by default. Not in CI — the backend is live.
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { readFileSync } from "node:fs";

const env = Object.fromEntries(readFileSync(new URL("../../.env", import.meta.url), "utf8")
    .split("\n").filter((l) => /^\w+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));

const URL_ = process.env.OPENWEBUI_URL || env.OPENWEBUI_URL;
const KEY = process.env.OPENWEBUI_KEY || env.OPENWEBUI_KEY;
if (!URL_ || !KEY) { console.error("need OPENWEBUI_URL + OPENWEBUI_KEY (.env)"); process.exit(1); }

const TOOL = process.env.TOOL || "web_page_fetch_summarize";
const FN = process.env.FN || "fetch_page";
const ARGS = JSON.parse(process.env.ARGS || '{"url":"https://example.com/","query":"what is this domain for"}');

const ext = await launchExtension();
const site = await startPageServer({});
try {
    await configureExtension(ext.sw, {
        chatUrl: `${URL_.replace(/\/$/, "")}/api/chat/completions`, apiKey: KEY, apiFormat: "openai",
        model: env.OPENWEBUI_MODEL || "", debugMode: "off",
        // The probe calls the primitive DIRECTLY, with no agent run to approve it — so the test origin is
        // trusted for this run only. A page NOT on this list is refused, which server-tools.spec.mjs covers.
        pageApprovalDomains: ["127.0.0.1", "localhost"],
    });

    const page = await ext.context.newPage();
    await page.goto(site.url + "/");
    await waitForMl(page);

    console.log(`\n  ${TOOL}.${FN}(${JSON.stringify(ARGS)})\n`);
    const t0 = Date.now();
    const r = await page.evaluate(async ({ tool, fn, args }) => {
        const seen = [];
        const res = await window.ml.execServerTool(tool, fn, args, {
            onOutput: (text, ts) => seen.push({ at: Date.now(), ts, text }),
        });
        return { res, seen };
    }, { tool: TOOL, fn: FN, args: ARGS });

    // The point of the probe: did output arrive PROGRESSIVELY, and does the producer's stamp differ from
    // when we saw it? A stamp equal to arrival everywhere means the anchoring is doing nothing — either the
    // server is not stamping, or something between us buffered the whole stream and delivered it at once.
    for (const c of r.seen.slice(0, 40)) {
        console.log(`  +${String(c.at - t0).padStart(6)}ms  produced ${c.ts ? `+${c.ts - t0}ms` : "(unstamped)"}  ${JSON.stringify(c.text).slice(0, 60)}`);
    }
    if (r.seen.length > 40) console.log(`  … ${r.seen.length - 40} more`);

    const arrivals = new Set(r.seen.map((c) => c.at));
    const produced = new Set(r.seen.map((c) => c.ts));
    console.log(`\n  chunks: ${r.seen.length}   distinct arrival moments: ${arrivals.size}   distinct produced moments: ${produced.size}`);
    console.log(`  ok=${r.res.ok} durationMs=${r.res.result?.durationMs} queuedMs=${r.res.result?.queuedMs} events=${r.res.events?.length} truncated=${r.res.result?.truncated ?? "-"}`);
    console.log(`  wall=${Date.now() - t0}ms   output=${r.res.output?.length ?? 0} chars`);
    if (r.res.events?.length) {
        const bytes = r.res.events.map((e) => JSON.stringify(e.event).length);
        console.log(`  event payload bytes: ${bytes.join(", ")}   (total ${bytes.reduce((a, b) => a + b, 0)} vs ${r.res.output?.length ?? 0} of output)`);
    }
    if (!r.res.ok) console.log(`  transportError: ${r.res.transportError}`);
    console.log(`\n  result: ${JSON.stringify(r.res.result?.result ?? r.res.result?.error).slice(0, 400)}\n`);
} finally {
    await site.stop();
    await ext.context.close();
}
