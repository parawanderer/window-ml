// ml-current-demo.mjs — a NARRATED VISUAL demo (not a test) of `ml.current`: a run reading its OWN context from a
// read-only `exec`, evaluated in the service worker: the page is never asked to run a survey that reads the run.
//
//   npm run build && node tests/e2e/ml-current-demo.mjs        # headful; HOLD=0 to exit instead of waiting
//
// A scripted model (fake-llm) drives a REAL run through the real extension: the background loop, the worker-first
// read-only try, delegation to the page, the approval gate. Only the model's words are scripted.
//
//   1. A survey of the PAGE (`document.title`). The worker has no page, so it hands the survey to the page, which
//      answers it as it always has.
//   2. A survey of the RUN ITSELF: every message's id, role, size (counted or estimated) and age. Answered in the
//      worker, where the context lives. The page never receives it.
//   3. The print boundary: `console.log(ml.current.messages)` would be half a system prompt in the 500 characters a
//      model sees. A large message prints as a summary naming the expression that prints it whole.
//   4. A survey that needs BOTH the page and the run. The worker has no page, the page has no run context, so it is
//      refused on both sides and the human is asked. The demo denies it, on screen.
//   5. The page's own view, read by listening exactly where a hostile page would. The page is never asked to RUN an
//      `ml.current` survey. But what a survey RETURNS is a tool result, and it reaches the page the way every tool
//      result does: in the debug stream relayed through the page's window, and in the run's result to its caller.
//      The demo shows that rather than hiding it. Closing that channel is the site-access work's, and this demo is
//      how it was found (2026-10-06).
//
// THE WIRING IS A DEMO'S: the worker-first call in sw-run-host.ts is the site-access work's slice 2, and this branch
// carries a minimal version of it so the whole path can run. Everything else is what ships.
//
// Screenshots land in tests/e2e/artifacts/ml-current-demo/.
import fs from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, waitForMl, narrate, narrateDone, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const HOLD = process.env.HOLD !== "0";
const BEAT = Number(process.env.BEAT || 2600);
const ART = path.join(import.meta.dirname, "artifacts", "ml-current-demo");
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The model's scripts, as a model would write them.
const PAGE_SURVEY = `return document.title`;
const SELF_SURVEY = `const meta = ml.current.meta;
return ml.current.messages.map((m, i) =>
  meta[i].id + " " + m.role + " " + meta[i].tokens + "t " + meta[i].tokensBasis + " " +
  Math.round(meta[i].ageMs / 100) / 10 + "s ago" +
  (meta[i].gapMs > 1000 ? ", " + Math.round(meta[i].gapMs / 100) / 10 + "s after the one before" : "") +
  (meta[i].surface ? ", typed in " + meta[i].surface : "")
).join("\\n")`;
const PRINT_SURVEY = `console.log(ml.current.messages)`;
const SCHEMA_SURVEY = `return ml.schema(ml.current.messages)`;
const MIXED_SURVEY = `return document.title + " has " + ml.current.messages.length + " messages behind it"`;

/** The text of the tool result for the Nth exec call, from the conversation the model is sent. */
const toolResult = (body, n) => (body.messages || []).filter((m) => m.role === "tool")[n]?.content ?? "";

const fake = await startFakeLlm({ model: "fake-model" });
const site = await startPageServer({});
const ext = await launchExtension({ headful: true });
const errors = [];
let n = 0;
let page = null;
const shot = async (name) => {
    if (!page) return;
    try { await page.screenshot({ path: path.join(ART, `${String(++n).padStart(2, "0")}-${name}.png`) }); } catch { /* a beat's picture is not worth failing for */ }
};

try {
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", autoApproveReadonly: true });
    page = await ext.context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(site.url + "/");
    await waitForMl(page);
    await page.evaluate(() => { document.title = "Acme · Pricing"; });

    // LISTEN WHERE A HOSTILE PAGE WOULD. A delegated call reaches the page's main world as a PAGE_TOOL_RUN message;
    // anything a page could ever learn about a run's surveys, it learns here.
    await page.evaluate(() => {
        window.__pageSaw = [];
        window.__pageAll = [];   // EVERY message, serialized: what a page could search for the run's context
        window.addEventListener("message", (e) => {
            try { window.__pageAll.push({ kind: e.data?.type || (e.data?.__mlDebug ? `__mlDebug:${e.data.__mlDebug.kind}` : Object.keys(e.data || {})[0] || "?"), text: JSON.stringify(e.data) }); } catch { /* unserializable: not data a page could read as text */ }
            if (e.data?.type === "PAGE_TOOL_RUN") window.__pageSaw.push({ tool: e.data.name, js: e.data.args?.js ?? null, readonlyTry: !!e.data.readonlyTry, renderOnly: !!e.data.renderOnly });
        });
    });

    fake.setScript([
        { tool: "exec", args: { js: PAGE_SURVEY } },
        // A real wait on the page, so the ages and the gap the next survey reports are real seconds, not "0s ago".
        { tool: "wait", args: { selector: "#never-appears", timeout: 4000 } },
        { tool: "exec", args: { js: SELF_SURVEY } },
        { tool: "exec", args: { js: PRINT_SURVEY } },
        { tool: "exec", args: { js: SCHEMA_SURVEY } },
        { tool: "exec", args: { js: MIXED_SURVEY } },
        (body) => {
            const rows = toolResult(body, 2).split("\n").filter((l) => /^[0-9a-f]{7} /.test(l));
            const biggest = rows.map((l) => ({ l, t: Number((l.match(/ (\d+)t /) || [])[1] || 0) })).sort((a, b) => b.t - a.t)[0];
            return { content: `I am carrying ${rows.length} messages. The largest is \`${biggest?.l.split(" ").slice(0, 3).join(" ")}\` (${biggest?.t} tokens, estimated: it is the system prompt). ` +
                `I read that from my own context, in the worker; the page was never asked to run it. The survey that needed both the page and my context was refused, and you declined it.` };
        },
    ]);

    await narrate(page, "ml.current: a run reads its own context", { sub: "a scripted model drives a real run. Its surveys are answered in the service worker, and the page only ever gets what it needs" });
    await sleep(BEAT);
    await page.evaluate(() => { void window.ml.agent("How much context am I carrying, and how old is it?", { env: false }); });
    const sb = await openRunInSidebar(page, { task: /How much context/ });
    // The run goes through steps 1 to 3 in well under a second, then stops at step 4's approval gate.
    await sb.locator(".appr-btn.no").first().waitFor({ timeout: 20000 });
    const steps = sb.locator(".astep.tool");
    const open = async (i) => {
        const head = steps.nth(i).locator(".astep-head").first();
        await head.scrollIntoViewIfNeeded().catch(() => {});
        await head.click();
        await sleep(400);
    };

    await narrate(page, "1 · A survey of the PAGE", { sub: "`document.title`. The worker has no page, so it hands the survey to the page, which answers it as it always has — auto-approved, no prompt" });
    await open(0);
    await sleep(BEAT); await shot("1-page-survey");

    await narrate(page, "…then the model waits on the page", { sub: "four real seconds, for an element that never arrives — so the next survey has real ages and a real gap to report" });
    await open(1);
    await sleep(BEAT); await shot("1b-wait");

    await narrate(page, "2 · A survey of the RUN ITSELF", { sub: "every message: its stable id, role, size and whether that size is COUNTED by the engine or ESTIMATED, and how long ago it arrived. Answered in the worker, where the context lives" });
    await open(2);
    await sleep(BEAT + 1200); await shot("2-self-survey");

    await narrate(page, "3 · The print boundary", { sub: "the model sees 500 characters of a result. A large message prints as a summary that names the exact expression for printing it whole; the value itself is untouched" });
    await open(3);
    await sleep(BEAT + 1200); await shot("3-print-boundary");

    await narrate(page, "3b · The SHAPE of it", { sub: "`ml.schema(ml.current.messages)`: the type of every message, joined — the real NeutralMessage shape, since the print view never touches the value. Pure, so the worker answers it too" });
    await open(4);
    await sleep(BEAT + 1200); await shot("3b-schema");

    await narrate(page, "4 · A survey that needs BOTH", { sub: "`document.title` and `ml.current` together. The worker has no page and the page has no run context, so it is refused on both sides — and you are asked" });
    await sb.locator(".appr-btn.no").first().scrollIntoViewIfNeeded().catch(() => {});
    await sleep(BEAT + 800); await shot("4-asked");
    await narrate(page, "4 · …and declined", { sub: "it never ran. Approving it would have run it on the page, where `ml.current` does not exist" });
    await sb.locator(".appr-btn.no", { hasText: /^Deny$/ }).first().click();
    await sleep(BEAT); await shot("4-declined");

    // The answer arrives once the denied step returns to the model.
    await sb.getByText(/I am carrying \d+ messages/).first().waitFor({ timeout: 15000 });
    await narrate(page, "The model's answer", { sub: "built from its own context, which it read in the worker without the page ever running the survey" });
    await sleep(BEAT + 1200); await shot("5-answer");

    const saw = await page.evaluate(() => window.__pageSaw);
    const all = await page.evaluate(() => window.__pageAll);
    // Which scripts the page was asked to RUN (not merely to draw: `renderOnly` sends the source so the page can
    // render the step's In, which is code the model wrote, not the run's context).
    const ranOnPage = saw.filter((s) => s.tool === "exec" && !s.renderOnly).map((s) => s.js);
    const leaked = ranOnPage.filter((js) => js === SELF_SURVEY || js === PRINT_SURVEY);
    // And the question that matters: did the run's CONTEXT, or a survey's RESULT, reach the page by any channel?
    const calls0 = fake.calls().filter((c) => c.tools);
    const selfOut = toolResult(calls0[calls0.length - 1] || {}, 2);
    const firstRowId = (selfOut.match(/^([0-9a-f]{7}) system/m) || [])[1];
    const markers = { "the system prompt's text": "You are an automation agent", "the self-survey's result": firstRowId ? `${firstRowId} system` : null };
    const carried = Object.entries(markers).filter(([, m]) => m).map(([what, m]) => ({ what, channels: [...new Set(all.filter((x) => x.text.includes(m)).map((x) => x.kind))] }));
    await narrate(page, "5 · What the PAGE was asked to run", {
        sub: `${ranOnPage.length} exec script(s) were sent to run in this page: the page survey and the mixed one (which it refused). ` +
            (leaked.length ? `UNEXPECTED: ${leaked.length} ml.current survey(s) were sent to run here` : "Neither ml.current survey was."),
    });
    await sleep(BEAT + 2000); await shot("5-what-the-page-ran");
    const viaResult = carried.find((c) => c.what === "the self-survey's result")?.channels ?? [];
    await narrate(page, "6 · …and what still reached it", {
        sub: viaResult.length
            ? `the survey's RESULT did, via ${viaResult.join(", ")}: a tool result goes where every tool result goes, including the debug stream relayed through this page's window. That channel is the site-access work's to close`
            : "nothing the survey returned reached this page",
    });
    await sleep(BEAT + 2600); await shot("6-what-still-reached-it");

    console.log("\n--- tool calls the page's main world received, as a hostile page would see them ---");
    for (const s of saw) console.log(`  ${s.tool}${s.readonlyTry ? " (read-only try)" : ""}${s.renderOnly ? " (render only: draw the In)" : ""}: ${s.js ? JSON.stringify(s.js).slice(0, 100) : "(no script)"}`);
    console.log(leaked.length ? `\nUNEXPECTED: ${leaked.length} ml.current survey(s) were sent to RUN on the page` : "\nNo ml.current survey was sent to run on the page.");
    console.log("\n--- did the run's CONTEXT reach the page by any channel? (all messages the main world received) ---");
    for (const c of carried) console.log(`  ${c.what}: ${c.channels.length ? "YES, via " + c.channels.join(", ") : "no"}`);
    console.log(`  (${all.length} messages inspected)`);
    const calls = fake.calls().filter((c) => c.tools);
    console.log(`\n--- the model was sent ${calls.length} turn(s); the self-survey's result, as the model read it ---`);
    console.log(toolResult(calls[calls.length - 1] || {}, 2).split("\n").map((l) => "  " + l).join("\n"));
    console.log("\n--- the print survey's result ---");
    console.log("  " + toolResult(calls[calls.length - 1] || {}, 3).slice(0, 900));
    console.log("\n--- the schema survey's result ---");
    console.log("  " + toolResult(calls[calls.length - 1] || {}, 4).slice(0, 900));
    console.log(`\nscreenshots in ${ART}`);

    await narrateDone(page);
    if (errors.length) console.error("page errors:\n" + errors.join("\n"));
    if (HOLD) await new Promise(() => {});
} finally {
    if (!HOLD) { await ext.context.close(); await site.stop(); await fake.stop(); }
}
