// run-state-demo.mjs — a NARRATED VISUAL demo (not a test) of the RUN STATE panel: what a run holds right now, member by
// member, read from the state registry of the worker and of the page the run is on (docs/spec/STATE_INSPECTOR.md).
//
//   npm run build:all && node tests/e2e/run-state-demo.mjs   # headful; HOLD=0 to exit instead of waiting
//
//   1. NOTHING OPEN: the panel follows the session you are reading.
//   2. A LIVE TURN, held at its approval gate: every declared member is listed, empty ones included, grouped by what
//      they belong to. The model's members and the ones only you see are told apart.
//   3. WHAT IT WAS ASKED, and the gate it is waiting on.
//   4. WHAT IT MAY DO WITHOUT ASKING this turn: only you see it.
//   5. THE PAGE'S WORD: the run's answer set and the @pt/@box tokens live in the page, and are marked as such.
//   6. THE TURN ENDS: what lived only in it goes with it.
//   7. A BIG TABLE: the pointer holds a preview, the whole body is a stored value, and the two are joined by key.
//   8. A PAGE-HOSTED run: its context comes from the page that runs its loop.
//
// Screenshots land in tests/e2e/artifacts/run-state-demo/.
import fs from "node:fs";
import path from "node:path";
import { createServer } from "node:http";
import { launchExtension, configureExtension, waitForMl, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const HOLD = process.env.HOLD !== "0";
const BEAT = Number(process.env.BEAT || 2200);
const ART = path.join(import.meta.dirname, "artifacts", "run-state-demo");
fs.mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One local site: a page to run on, and a table big enough that its body goes to the value store.
const big = ["order_id,region,revenue"];
for (let i = 0; i < 300_000; i++) big.push(`${i},${["north", "south", "east"][i % 3]},${i % 97}`);
const srv = createServer((q, r) => {
    if (q.url === "/orders.csv") { r.writeHead(200, { "content-type": "text/csv" }); r.end(big.join("\n")); return; }
    r.writeHead(200, { "content-type": "text/html" });
    r.end("<title>Orders</title><h1>Orders</h1><p>Quarterly orders by region.</p><button id=go>Export</button>");
});
await new Promise((res) => srv.listen(0, "127.0.0.1", res));
const origin = `http://127.0.0.1:${srv.address().port}`;

const fake = await startFakeLlm({ model: "fake-model" });
const ext = await launchExtension({ headful: true });
const errors = [];
let n = 0, watch = null;
const shot = async (name) => { if (watch) await watch.screenshot({ path: path.join(ART, `${String(++n).padStart(2, "0")}-${name}.png`) }).catch(() => {}); };

try {
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "off", autoApproveReadonly: false });
    const site = await ext.context.newPage();
    await site.goto(origin + "/");
    await waitForMl(site);
    const chat = await ext.context.newPage();
    chat.on("pageerror", (e) => errors.push(e.message));
    await chat.goto(`chrome-extension://${ext.extensionId}/chat.html`);
    await chat.locator(".chat").waitFor();
    await chat.setViewportSize({ width: 1500, height: 920 });
    watch = chat;
    const panel = chat.locator(".chat-dock-right .rstate");
    const member = (id) => panel.locator(`[data-member="${id}"]`);
    const open = async (id, inner = 0) => {
        const m = member(id);
        await m.scrollIntoViewIfNeeded();
        await m.locator(".jt-clickable").first().click();
        for (let i = 1; i <= inner; i++) await m.locator(".jt-clickable").nth(i).click().catch(() => {});
        return m;
    };
    const openSession = async (text) => { await chat.locator(".chat-row", { hasText: text }).first().click(); await sleep(400); };

    await narrate(chat, "1 · The Run state panel, with nothing open", { sub: "it describes the session you are reading, so with none it says so" });
    await chat.locator(".chat-gear-btn").click();
    await chat.getByRole("menuitem", { name: "Panels" }).click();
    await chat.getByRole("menuitemcheckbox", { name: /Run state/ }).click();
    await sleep(BEAT); await shot("nothing-open");

    // A background-hosted run whose first step is an exec that is not read-only, so it waits at the approval gate.
    fake.setScript([
        { tool: "exec", args: { js: "document.querySelector('#go').click(); 'exported'" } },
        { content: "Exported the quarterly orders." },
    ]);
    void site.evaluate(() => window.ml.agent("Export this quarter's orders", { env: false, approvalRouting: "both" })).catch(() => {});
    await chat.waitForFunction(() => document.querySelector(".chat-row"), null, { timeout: 15000 });
    await chat.bringToFront();
    await openSession("Export this quarter");
    await narrate(chat, "2 · A live turn, held at its approval gate", { sub: "one line per member, like a debug console: named by the expression that reaches it (inspector.… until the model is given it), empty ones too, grouped by what each belongs to" });
    await member("run.init").waitFor();
    await sleep(BEAT + 600); await shot("live-turn-overview");

    await narrate(chat, "3 · What it was asked, and what it is waiting on", { sub: "`input` is this turn's prompt and origin; `approvals` is the gate itself: the tool, its arguments, since when" });
    await open("run.input");
    await open("run.approvals", 1);
    await sleep(BEAT + 800); await shot("input-and-gate");

    await narrate(chat, "4 · What it may do without asking, this turn", { sub: "the origins it may navigate and fetch from freely. Marked \"you only\": the model's own view (ml.current) never includes it. Hover a name for what it holds and what loses it" });
    const turn = await open("grants.turn");
    await turn.getByRole("button", { name: /origins:/ }).click().catch(() => {});
    await turn.scrollIntoViewIfNeeded();
    {
        const key = turn.locator(".rstate-key");
        const box = await key.boundingBox();
        await chat.mouse.move(box.x + 4, box.y + box.height / 2);
        await chat.mouse.move(box.x + 6, box.y + box.height / 2);
    }
    await sleep(BEAT + 1000); await shot("grants-you-only");

    await narrate(chat, "5 · The page's word", { sub: "the answer set and the @pt/@box tokens live in the PAGE, so the worker asks the tab. A hostile page could answer anything there, so those rows say where they came from" });
    await chat.mouse.move(5, 5);
    await member("run.answer").scrollIntoViewIfNeeded();
    await sleep(BEAT + 600); await shot("from-the-page");

    await narrate(chat, "6 · Approved: the turn ends, and what lived only in it goes with it", { sub: "the prompt, the gate and the per-turn grants empty out; the session's context and pointers stay" });
    const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
    await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
    await panel.locator('[data-member="run.input"].empty').waitFor({ timeout: 10000 }).catch(() => {});
    await member("run.init").scrollIntoViewIfNeeded();
    await sleep(BEAT + 600); await shot("turn-ended");

    // A run that fetches a table too big to keep whole in a pointer.
    await narrate(chat, "7 · A big table: a pointer and the stored value behind it", { sub: "300,000 rows: the @tool: pointer keeps a preview, the whole body goes to the value store, and the panel joins them by key. `linked` says whether the context still mentions it" });
    fake.setScript([{ tool: "fetch_url", args: { url: `${origin}/orders.csv`, token: "the orders" } }, { content: "Fetched the orders." }]);
    await site.evaluate(() => window.ml.agent("Fetch the orders table", { env: false, toolTokens: true }));
    await openSession("Fetch the orders table");
    await open("run.pointers", 1);
    await open("run.values", 1);
    await member("run.pointers").scrollIntoViewIfNeeded();
    await sleep(BEAT + 1400); await shot("pointer-join");

    // A run on a site trusted to gate its own approvals runs its loop in the page.
    await narrate(chat, "8 · A run whose loop is in the page", { sub: "a site on the page-approval list hosts its own run. The worker holds no context for it, so the page answers for it, and every such row is marked as the page's" });
    await configureExtension(ext.sw, { listPageSessions: true, pageApprovalDomains: ["127.0.0.1"] });
    await site.reload();
    await waitForMl(site);
    fake.setScript([{ tool: "exec", args: { js: "document.title = 'checked'; 'ok'" } }, { content: "Checked." }]);
    await site.evaluate(() => {
        window.__held = new Promise((go) => { window.__go = go; });
        window.__run = window.ml.agent("Check the page title", { env: false, approve: () => window.__held }).catch(() => {});
    });
    await chat.bringToFront();
    await chat.locator(".chat-row", { hasText: "Check the page title" }).waitFor({ timeout: 15000 });
    await openSession("Check the page title");
    await open("run.messages", 2);
    await member("run.messages").scrollIntoViewIfNeeded();
    await sleep(BEAT + 1400); await shot("page-hosted");
    await site.evaluate(() => window.__go(true));

    console.log(`\nscreenshots in ${ART}`);
    await narrateDone(chat);
    if (errors.length) console.error("page errors:\n" + errors.join("\n"));
    if (HOLD) await new Promise(() => {});
} finally {
    if (!HOLD) { await ext.context.close(); await fake.stop(); await new Promise((r) => srv.close(r)); }
}
