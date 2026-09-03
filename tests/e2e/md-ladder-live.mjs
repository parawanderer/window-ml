// A DEBUG PROBE, not a test: drives the real Markdown negotiation ladder against LIVE sites through the
// built extension, and prints the resolution tree for each. Everything in tests/md-ladder.test.mjs drives a
// SCRIPTED fetch; this is the only thing that exercises the actual background worker, its host permissions
// and the real consent path.
//
//   npm run build && node --import tsx tests/e2e/md-ladder-live.mjs
//
// Each site is visited FIRST and then fetched from its own page, so the fetch is same-origin and needs no
// approval — there is no human here to grant one.
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";

const SITES = [
    ["https://unsloth.ai/docs/models/glm-5.3-flash", "GitBook: declares a twin AND serves one by negotiation"],
    ["https://bun.sh/docs/installation", "ignores Accept; only the .md URL works"],
    ["https://docs.github.com/en/actions/writing-workflows/quickstart", "twin at an endpoint no derivation would guess"],
    ["https://developers.cloudflare.com/workers/get-started/guide/", "trailing slash -> index.md, not guide.md"],
    ["https://tailwindcss.com/docs/installation", "no twin at all -> must fall through to our conversion"],
];

const { context, sw } = await launchExtension();
await configureExtension(sw, { model: "none", chatUrl: "http://127.0.0.1:1/api/chat/completions" });
const page = await context.newPage();
let failures = 0;

for (const [url, why] of SITES) {
    console.log(`\n${url}\n  (${why})`);
    try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        await waitForMl(page);
        const r = await page.evaluate((u) => window.ml.fetch(u).then((res) => ({
            type: res.type, status: res.status, bytes: (res.text || "").length,
            negotiation: res.negotiation, url: res.url,
        })), url);

        const n = r.negotiation;
        if (!n) { console.log("  NO negotiation trace — the ladder did not run"); failures++; continue; }
        for (const a of n.attempts) {
            const glyph = a.outcome === "hit" ? "✓" : a.outcome === "skipped" ? "·" : "✗";
            const meta = [a.status, a.contentType?.split(";")[0], a.bytes && `${(a.bytes / 1024).toFixed(1)} KB`, a.ms && `${a.ms} ms`].filter(Boolean).join(" · ");
            console.log(`  ${glyph} ${a.strategy.padEnd(9)} ${(a.url || "").slice(0, 72)} ${meta}${a.note ? `  — ${a.note}` : ""}`);
        }
        console.log(`  => resolved by ${n.resolvedBy}, type ${r.type}, ${(r.bytes / 1024).toFixed(1)} KB from ${r.url}`);
    } catch (e) {
        console.log(`  ERROR: ${(e.message || e).toString().split("\n")[0]}`);
        failures++;
    }
}
console.log(`\n${failures ? `${failures} site(s) failed` : "all sites produced a trace"}`);
await context.close();
process.exit(failures ? 1 : 0);
