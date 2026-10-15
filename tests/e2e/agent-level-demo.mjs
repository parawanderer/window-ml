// agent-level-demo.mjs — a narrated demo, not a test: a site starting the extension's agent (docs/spec/SITE_ACCESS_SLICE3.md,
// PR 2). Headful by default, against the fake model, so it needs no backend.
//
// RUN IT (build first: the demo loads the built dist/ extension):
//   npm run build && node --import tsx tests/e2e/agent-level-demo.mjs
//   HEADLESS=1 HOLD=0 node --import tsx tests/e2e/agent-level-demo.mjs   # unattended, screenshots only
//   PACE=2500 node --import tsx tests/e2e/agent-level-demo.mjs            # slower narration (ms per beat)
// Screenshots land in tests/e2e/artifacts/agent-level-demo/ (gitignored).
//
// THE BEATS, on one site (forum.test) the person allowed to use window.ml:
//   1. agents "ask": the site starts an agent, and the start card appears in the sidebar. Its lines, walked.
//   2. the person allows it, and the run goes.
//   3. the site sends the agent another turn: the transcript names the site, never "you".
//   4. the site uses up its page turn budget: the next turn asks to keep going; denied, the site is told so. The site
//      then ends its turn waiting for the person, and its question shows over the reply box, labelled as the site's.
//   5. DevTools Settings sets the site's agents to "Always": its next start runs with no card.
//   6. "Denied": the site's start is refused with the text a page sees.
//   7. a page the agent's own navigation reached tries to start an agent: refused, and recorded in the driving run's
//      steps as "not started: this page was opened by a running agent".
// The assertions behind each beat are tests/redteam-agent-level.test.mjs and tests/e2e/site-access.spec.mjs, attack 19.

import fs from "node:fs";
import path from "node:path";
import { launchExtension, configureExtension, waitForMl, approveOrigin, openRunInSidebar, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startHostileSite, HOSTILE_RESOLVER_ARGS } from "./fixtures/hostile/server.mjs";

const PACE = +(process.env.PACE || 1800);
const HOLD = +(process.env.HOLD ?? 600000);
const HEADLESS = process.env.HEADLESS === "1";
const OUT = path.resolve("tests/e2e/artifacts/agent-level-demo");
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let shotN = 0;
/** One beat's screenshot, numbered in order. */
const shot = async (page, name) => { const f = path.join(OUT, `${String(++shotN).padStart(2, "0")}-${name}.png`); await page.screenshot({ path: f }); console.log(`  screenshot: ${path.relative(process.cwd(), f)}`); };
/** Say a beat in the page and the terminal, then give it time to be read. */
const say = async (page, text, sub = "") => { console.log(`- ${text}${sub ? ` (${sub})` : ""}`); await narrate(page, text, { sub }); await sleep(PACE); };
/** Fail loudly: a demo that silently skips a beat shows nothing and claims it worked. */
const must = (cond, what) => { if (!cond) throw new Error(`demo beat failed: ${what}`); };

const fake = await startFakeLlm({ model: "fake-model" });
const site = await startHostileSite();
const ext = await launchExtension({ headful: !HEADLESS, args: HOSTILE_RESOLVER_ARGS });
await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", debugMode: "overlay" });
const ORIGIN = site.origin("forum.test");
const HOST = ORIGIN.replace(/^https?:\/\//, "");
await approveOrigin(ext.sw, ORIGIN, { agents: "ask" });

const page = await ext.context.newPage();
await page.setViewportSize({ width: 1400, height: 900 });
await page.goto(site.url("forum.test", "/"));
await waitForMl(page, { approve: false });

/** The sidebar frame, open on the session whose task matches: as it is when it already shows it, else back to the list
 *  (out of a session or Settings) and into it. */
async function sidebar(task) {
    const f = page.frames().find((fr) => /sidebar\.html/.test(fr.url()));
    if (f) {
        if (await f.locator(".msg.user", { hasText: task }).count()) return f;
        for (let i = 0; i < 3 && await f.locator("button.nav").count(); i++) { await f.locator("button.nav").first().click(); await sleep(250); }
    }
    return openRunInSidebar(page, { task, width: 620 });
}
/** Wait until the frame shows `sel`. */
const shown = async (frame, sel, timeout = 15000) => { await frame.waitForSelector(sel, { timeout }); };

try {
    // --- 1. the start card ---
    await say(page, `${HOST} may use window.ml, and its agents are set to "Ask each time"`, "the person allowed the site; starting an agent is a second permission");
    fake.setScript([{ tool: "findByText", args: { text: "code" } }, { content: "The thread says the code is 4417." }]);
    await page.evaluate(() => { window.__a = window.ml.createAgent({ vision: false, maxSteps: 4 }); window.__r = window.__a.run("Summarise the thread on this page."); });
    let frame = await sidebar("Summarise the thread");
    await shown(frame, ".start-ask");
    must(fake.calls().length === 0, "nothing ran before the card was answered");
    await say(page, "The site asked to start an agent: nothing runs until the person answers", "the card is the worker's; the page only supplied the task");
    await say(page, `Heading: "${(await frame.textContent(".action-goal"))?.trim()}"`, "the origin as the browser reports it, never a title the page set");
    await say(page, "The task is quoted in the site's own words, as plain text", "markup stays text, bidi controls are shown, long text folds at 12 lines");
    const lines = await frame.locator(".start-lines li").allTextContents();
    await say(page, `It can: ${lines.join("; ")}`, "one fixed sentence per tool, from the extension's registry; the site's tool descriptions are never shown");
    await say(page, (await frame.locator(".start-line").allTextContents()).join(" | "), "the model the worker resolved, the steps a turn, and the page turn budget");
    await shot(page, "start-card");

    // --- 2. allowed ---
    await say(page, "The buttons arm after one second, then the person allows this agent");
    await frame.locator(".start-row .appr-btn.yes").first().click();
    await page.waitForFunction(() => window.__r && window.__r.then ? true : false);
    const first = await page.evaluate(() => window.__r.then((r) => r.summary, (e) => `ERR ${e?.message ?? e}`));
    must(first.includes("4417"), `the run answered: ${first}`);
    await say(page, "The run went, and answered", first);
    await shot(page, "allowed");

    // --- 3. a page-sent turn ---
    fake.setScript([{ content: "Two people posted: Ana and Bo." }]);
    await page.evaluate(() => window.__a.run("Now list who posted."));
    frame = await sidebar("Summarise the thread");
    await shown(frame, ".msg.user.from-site");
    const who = await frame.locator(".msg.user .who").allTextContents();
    must(who.every((w) => w === HOST), `every message names the site: ${who}`);
    await say(page, `The site sent another turn: the transcript names it "${HOST}", never "you"`, "and the model reads it as \"Message from the page (origin): ...\"");
    await shot(page, "page-turn");

    // --- 4. past the page turn budget, then waiting for the person ---
    await say(page, "The site keeps sending turns: each one draws on the page turn budget it was allowed");
    for (let i = 0; i < 9; i++) { fake.setScript([{ content: `ok ${i}` }]); await page.evaluate((n) => window.__a.run(`Turn ${n}`), i); }
    fake.setScript([{ content: "should not run" }]);
    await page.evaluate(() => { window.__more = window.__a.run("One more, please.").then((r) => r.summary, (e) => `ERR ${e?.message ?? e}`); });
    frame = await sidebar("Summarise the thread");
    await shown(frame, ".start-ask");
    await say(page, `"${(await frame.textContent(".action-goal"))?.trim()}"`, (await frame.textContent(".start-ask .start-dim"))?.trim());
    await shot(page, "keep-going");
    await sleep(1100);
    await frame.locator(".start-row .appr-btn.no").click();
    const declined = await page.evaluate(() => window.__more);
    await say(page, "The person declined; the site is told:", declined.replace(/^ERR /, ""));
    await page.evaluate(() => window.__a.waitForPerson("Which thread should I summarise next?"));
    frame = await sidebar("Summarise the thread");
    await shown(frame, ".start-wait");
    await say(page, "The site ends its turn waiting for the person", `"${(await frame.textContent(".start-wait .start-quote-label"))?.trim()}": what the person types next is their own turn`);
    await shot(page, "waiting-for-the-person");

    // --- 5. "Always" in DevTools Settings ---
    const setLevel = async (level) => {
        frame = page.frames().find((f) => /sidebar\.html/.test(f.url()));
        const row = frame.locator(`.perm-row[data-origin="${ORIGIN}"]`);
        if (!(await row.count())) {
            for (let i = 0; i < 3 && !(await frame.locator('[aria-label="Settings"]').count()) && await frame.locator("button.nav").count(); i++) { await frame.locator("button.nav").first().click(); await sleep(250); }
            await frame.locator('[aria-label="Settings"]').first().click();
            await frame.locator(".set-tab", { hasText: "Permissions" }).first().click();
        }
        await frame.locator(`.perm-row[data-origin="${ORIGIN}"] select.perm-agents-select`).selectOption(level);
        await sleep(400);
    };
    await setLevel("always");
    await say(page, `DevTools Settings, Permissions: ${HOST}'s agents set to "Always"`);
    await shot(page, "settings-always");
    fake.setScript([{ content: "Done with no card." }]);
    const always = await page.evaluate(() => window.ml.agent("Count the links on this page.", { vision: false }).then((r) => r.summary, (e) => `ERR ${e?.message ?? e}`));
    must(always === "Done with no card.", `the next start ran with no card: ${always}`);
    await say(page, "The site's next start ran with no card", always);

    // --- 6. "Denied" ---
    await setLevel("denied");
    const denied = await page.evaluate(() => window.ml.agent("Try again.", { vision: false }).then((r) => r.summary, (e) => String(e?.message ?? e)));
    must(/not allowed to start agents/.test(denied), `refused: ${denied}`);
    await say(page, `Agents "Denied": the site's start is refused`, denied);
    await shot(page, "denied");

    // --- 7. a page the agent's navigation reached ---
    await setLevel("always");
    await say(page, "Back to Always. The site's agent now navigates to another page of the site, and waits there");
    fake.setScript([
        { tool: "navigate", args: { url: site.url("forum.test", "/reached") } },
        { tool: "wait", args: { selector: "#never", timeout: 6000 } },
        { content: "Finished on the page I opened." },
    ]);
    await page.evaluate(() => { window.__nav = window.ml.agent("Open the next page and wait for it to settle.", { vision: false }); });
    await page.waitForURL(/\/reached/, { timeout: 15000 });
    await waitForMl(page, { approve: false });
    await sleep(800);
    const hijack = await page.evaluate(() => window.ml.agent("Start an agent of my own.", { vision: false }).then((r) => r.summary, (e) => String(e?.message ?? e)));
    must(/opened by a running agent/.test(hijack), `refused: ${hijack}`);
    await say(page, "That page, opened by the running agent, tried to start one of its own", hijack);
    frame = await sidebar("Open the next page");
    await shown(frame, ".arun-note", 20000);
    await say(page, `The driving run's steps record it: "${(await frame.textContent(".arun-note"))?.trim()}"`, "no card, no model call, and the driver's context unchanged");
    await shot(page, "opened-by-agent");

    await narrateDone(page, "Demo finished");
    console.log(`\nAll beats ran. Screenshots: ${path.relative(process.cwd(), OUT)}`);
    if (!HEADLESS && HOLD > 0) await sleep(HOLD);
} finally {
    await ext.context.close();
    await fake.stop();
    await site.stop();
}
