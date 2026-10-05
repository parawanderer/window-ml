// streak-demo.mjs — a NARRATED VISUAL demo (not a test) of HOW THE READING VIEW CHANGES AS A RUN GOES, walked
// through one appended step at a time so you can watch each rule decide. Mostly tool-streak FOLDING; part three is
// the other thing that changes under a reader, a step-cap stop continued past.
//
//   npm run build && node tests/e2e/streak-demo.mjs        # headful; HOLD=0 to exit instead of waiting
//
// The feature compresses a run of adjacent turns that all called the SAME tool into one row. Reading the
// finished transcript tells you nothing about WHY a given stretch folded and the one under it did not, because
// every rule is about the turns AROUND a step — so this appends them in order, pausing on each decision:
//
//   1. DIFFERENT TOOLS NEVER FOLD. `pageInfo` then `look` is two rows and stays two rows.
//   2. A STREAK UNDER THE MINIMUM NEVER FOLDS. Two `exec` calls are a pair; three is where a reader starts skipping.
//   3. A LIVE TAIL STAYS OPEN. The third and fourth `exec` do not fold while they are the newest thing on screen:
//      rows collapsing out from under you while you are reading them is motion at exactly the wrong moment, and a
//      repeated tool is often the thing you are watching. It folds when something FOLLOWS it.
//   4. ANOTHER TOOL SPLITS A STREAK IN TWO. The `exec`s before a `fetch_url` and the ones after it are two runs,
//      not one of eight — which is the point of the rule being "adjacent", and the thing a count alone would hide.
//   5. A TURN THAT SAID SOMETHING IS NEVER FOLDED. One `python_exec` whose model also wrote prose breaks the run
//      around it: content is not noise, and folding it would hide the only sentence in the stretch.
//   6. THE FOLDED ROW CARRIES WHAT THE ROWS COULD NOT — how many, how many FAILED, how long in total. In the run
//      this was built for two calls in the stretch were errors and that was the only signal in it.
//   7. OPEN IS INDISTINGUISHABLE FROM NEVER FOLDED, plus a rail saying which rows are inside the group.
//   8. THE TAIL FOLDS WHEN THE RUN ENDS, because nothing is going to follow it now.
//
// Driven by the chat page's fake host (`window.__chatFake`) rather than a scripted model: every beat here is
// about WHEN the client folds what it has, so the events are appended directly and the pacing is the demo's.
// Screenshots land in tests/e2e/artifacts/streak-demo/.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serveStatic } from "./static-server.mjs";
import { narrate, narrateDone } from "./harness.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
if (!fs.existsSync(path.join(ROOT, "chat.js"))) { console.error(`no web build at ${ROOT}: run node scripts/build-web.mjs`); process.exit(1); }
const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "streak-demo");
fs.mkdirSync(ART, { recursive: true });
const HOLD = process.env.HOLD !== "0";
const BEAT = Number(process.env.BEAT || 1700);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KEY = "laptop:5747eac0";
const EXEC_JS = "return [...document.querySelectorAll('.fare-card')].map(c => c.dataset.airline)";
const PY = "import pandas as pd\ndf = pd.DataFrame(rows)\nreturn df.sort_values('price').head(3)";

const server = await serveStatic(ROOT);
const browser = await chromium.launch({ channel: "chromium", headless: false });
const page = await browser.newPage({ viewport: { width: 1180, height: 950 }, colorScheme: "dark" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
await page.goto(server.url);
await page.locator(".chat-list").waitFor();

// A session of our own, so nothing here depends on the demo world's fixtures staying as they are.
await page.evaluate(([key, task]) => {
    const [runtime, hash] = key.split(":");
    const now = Date.now();
    window.__chatFake.addSession(
        { id: { runtime, hash }, kind: "agent", status: "running", createdTs: now, lastTs: now, pendingApprovals: 0, saved: true,
          title: "Fares, step by step", task, model: "qwen3:32b", page: { url: "https://flights.example/search", title: "Flights AMS → LIS", tabId: 41 } },
        [{ id: `${hash}-0`, ts: now, save: true, session: { hash, turn: 0 }, kind: "agent", task, model: "qwen3:32b", maxSteps: 30,
           config: undefined, pageUrl: "https://flights.example/search", pageTitle: "Flights AMS → LIS" }],
    );
}, [KEY, "Price every fare on this page, then check the rules of the cheapest"]);
await page.goto(server.url + `#/s/${encodeURIComponent(KEY)}`);
await page.locator(".chat-transcript").waitFor();

let seq = 0;
/** Append ONE finished tool call as its own turn, the way a run does. `reasoning` is the thinking block that rides
 *  above it — present on nearly every real turn, and deliberately not a reason to refuse to fold. */
const step = async (tool, over = {}) => {
    seq += 1;
    await emit(seq, seq, tool, over);
    await page.waitForTimeout(260);
};
/** One model call that decided on SEVERAL tools: they share a `step`, so they are one turn with several rows.
 *  A turn like this can never join a streak (the rule asks for exactly one call), and it is worth seeing at all —
 *  it is the shape the fixtures never had. */
const multiStep = async (tools) => {
    const at = seq + 1;
    for (const [tool, over] of tools) { seq += 1; await emit(at, seq, tool, over); }
    await page.waitForTimeout(260);
};
const emit = (s, sq, t, o) => page.evaluate(([key, step, seqN, tool, over]) => {
    const hash = key.split(":")[1];
    window.__chatFake.emit(key, {
        id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 },
        kind: "agent-step", step, seq: seqN, tool, approval: "readonly", toolMs: 20 + ((seqN * 37) % 400),
        reasoning: "Checking the next card.", reasoningTokens: 9 + ((seqN * 13) % 40), ...over,
    });
}, [KEY, s, sq, t, o]);
// The model's own one-line account of a call rides in the reserved `title` argument. Several of these carry one,
// because beat 8b is about where it is SHOWN — and a run where only some calls have one is the realistic case.
const TITLES = ["Count the fare cards", "Read each airline code", "Check for a sold-out flag", "Re-read after the filter",
    "Pull the prices", "Find the cheapest row", "Confirm the currency"];
const execStep = (over = {}) => step("exec", { arguments: { js: EXEC_JS, title: TITLES[seq % TITLES.length] }, result: '["TP","HV","KL"]',
    renderIn: { type: "code", text: EXEC_JS, lang: "javascript", format: true },
    renderOut: { type: "exec-out", value: '["TP","HV","KL"]' }, ...over });
const pyStep = (over = {}) => step("python_exec", { approval: "sandbox", toolMs: 1840, arguments: { code: PY }, result: "airline  price\nHV  96",
    renderIn: { type: "python-in", code: PY }, renderOut: { type: "python-out", stdout: "airline  price\nHV  96" }, ...over });
const shot = (name) => page.screenshot({ path: path.join(ART, `${name}.png`) });

await narrate(page, "A run, appended one step at a time", { sub: "the calm view folds runs of the same tool — every rule is about the turns AROUND a step" });
await sleep(BEAT);

// 1 — two different tools.
await narrate(page, "1 · Different tools never fold", { sub: "pageInfo then look stays two rows, and always will" });
await step("pageInfo", { result: "Flights AMS → LIS · 3 fare cards" });
await step("look", { result: "A search results page listing three fares." });
await sleep(BEAT); await shot("1-different-tools");

// 2 — a pair is not a streak.
await narrate(page, "2 · Two is a pair, not a streak", { sub: "the minimum is three: two rows are not where a reader starts skipping" });
await execStep(); await execStep();
await sleep(BEAT); await shot("2-pair-stays-open");

// 3 — the live tail.
await narrate(page, "3 · A live tail stays open", { sub: "three exec calls now — and they do NOT fold, because they are the newest thing on screen" });
await execStep(); await execStep();
await sleep(BEAT); await shot("3-live-tail-open");

// 4 — something follows it, so it folds; and the next run is a SEPARATE streak.
await narrate(page, "4 · Something follows it → it folds", { sub: "one fetch_url arrives and the four exec calls behind it become one row" });
await step("fetch_url", { approval: "user", arguments: { url: "https://transavia.example/fare-rules" }, result: "Fare rules: changes €40…",
    renderIn: { type: "action", verb: "fetch", target: "https://transavia.example/fare-rules" } });
await sleep(BEAT + 600); await shot("4-folded-behind-fetch");

// 5 — a second run of the SAME tool is its own streak, not an addition to the first.
await narrate(page, "5 · Adjacent, not cumulative", { sub: "three more exec calls after the fetch are a SECOND streak — a single count would have hidden the fetch" });
await execStep(); await execStep();
await execStep({ token: "d4e5f60" });   // cited by the final answer, so part two can jump INTO a group
await step("look", { result: "The fare-rules panel is open." });
await sleep(BEAT + 600); await shot("5-two-separate-streaks");

// 6 — failures are the one thing worth colouring, and prose breaks a run.
await narrate(page, "6 · The row says what the rows could not", { sub: "four python_exec calls, two of them failed — the count, the failures and the total time" });
await pyStep(); await pyStep({ result: "Error: KeyError: 'price'", renderOut: { type: "python-out", error: "KeyError: 'price'" } });
await pyStep({ result: "Error: KeyError: 'price'", renderOut: { type: "python-out", error: "KeyError: 'price'" } });
await pyStep();
await step("exec", { arguments: { js: EXEC_JS }, result: '["HV"]', renderIn: { type: "code", text: EXEC_JS, lang: "javascript", format: true } });
await sleep(BEAT + 600); await shot("6-failures-counted");

// 7 — a turn that SAID something is never folded.
await narrate(page, "7 · A turn that said something is never folded", { sub: "three python_exec calls, but the middle one's model also wrote prose — so it breaks the run around it" });
await pyStep(); await pyStep({ thought: "The frame is missing a price column; rebuilding it from the fare cards instead." }); await pyStep();
await step("look", { result: "Done." });
await sleep(BEAT + 600); await shot("7-prose-breaks-the-run");

// 7b — one model call, several tools.
await narrate(page, "7b · One turn, several tool calls", { sub: "a model call that decided on three tools at once is ONE turn with three rows — and can never join a streak" });
await multiStep([
    ["exec", { arguments: { js: EXEC_JS }, result: '["TP"]', renderIn: { type: "code", text: EXEC_JS, lang: "javascript", format: true } }],
    ["exec", { arguments: { js: EXEC_JS }, result: '["HV"]', renderIn: { type: "code", text: EXEC_JS, lang: "javascript", format: true } }],
    ["exec", { arguments: { js: EXEC_JS }, result: '["KL"]', renderIn: { type: "code", text: EXEC_JS, lang: "javascript", format: true } }],
]);
await step("look", { result: "All three read." });
await sleep(BEAT + 600); await shot("7b-one-turn-three-calls");

// 8 — open it.
await narrate(page, "8 · Open is indistinguishable from never folded", { sub: "…plus a rail saying which rows are inside the group. It opens and shuts on the step body's own animation" });
const streak = page.locator(".astreak").first();
await streak.locator(".astreak-head").click();
await sleep(BEAT + 600); await shot("8-open-with-rail");

// 8b — the model's own account of each call, which an open group is the one place to show.
await narrate(page, "8b · What the model said each call was for", { sub: "every tool takes an optional `title`. Shown INLINE only here — expanding a group is the gesture that means you are investigating; watching a run, one per row is noise" });
await sleep(BEAT + 400); await shot("8b-model-titles");
{
    const name = streak.locator(".astep .tool-name").first();
    const box = await name.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
}
await sleep(BEAT + 400); await shot("8c-title-in-the-tip");
await streak.locator(".astreak-head").click();
await sleep(900); await shot("8-closed-again");

// 9 — the tail folds when the run ends.
await narrate(page, "9 · The tail folds when the run ends", { sub: "nothing is going to follow it now, so the last run of exec calls collapses too" });
await execStep(); await execStep(); await execStep();
await sleep(BEAT);
await page.evaluate((key) => {
    const hash = key.split(":")[1];
    window.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 },
        kind: "agent-result", steps: 26, hitCap: false,
        summary: "I read [the airlines](@tool:d4e5f60) off the page. The cheapest fare is HV at €96; changes cost €40." });
    window.__chatFake.updateSummary(key, { status: "done", lastTs: Date.now() });
}, KEY);
await sleep(BEAT + 800); await shot("9-tail-folded-on-end");

await narrate(page, "That is the default rule", { sub: "adjacent · same tool · at least three · ended · nothing said · nothing revised — and the busy view keeps the full trace" });
await sleep(BEAT);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PART TWO — "Group all tool calls", the per-device toggle in the ⋮ menu. The rule above is conservative
// because it is GUESSING at what a reader can tell apart. This one was asked for, so almost every clause goes.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

await narrate(page, "10 · “Group all tool calls”", { sub: "the toggle under Calm view in the ⋮ menu — off by default, because the conservative rule is what someone who has not asked should get" });
await page.locator(".chat-gear-btn").first().click();
await sleep(700);
await shot("10-the-toggle");
await page.getByRole("menuitemcheckbox", { name: "Group all tool calls" }).click();
await sleep(BEAT + 800);
await shot("11-everything-grouped");

await narrate(page, "11 · Mixed tools, counted in CALLS", { sub: "the row can no longer name one tool, so it counts the calls and names them all — and one turn that made three calls counts as three" });
await sleep(BEAT); await shot("12-mixed-row");

// A citation must still reach a step that is now inside a closed group.
await narrate(page, "12 · A citation still reaches inside", { sub: "clicking the pointer in the answer opens the group it landed in — a jump that silently did nothing would be a new way to break the thing reveal exists to prevent" });
await page.locator(".tok-link").first().click();
await sleep(BEAT + 800); await shot("13-jump-opened-the-group");

// The ONE thing group-all still refuses to hide.
await narrate(page, "13 · A gate is never grouped", { sub: "a decision waiting on a human is not machinery — it stands outside the group, whatever the toggle says" });
await page.evaluate((key) => {
    const hash = key.split(":")[1];
    window.__chatFake.updateSummary(key, { status: "waiting", pendingApprovals: 1, lastTs: Date.now() });
    window.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 },
        kind: "agent-step", step: 30, seq: 30, tool: "fetch_url", pending: true, awaitingApproval: true,
        reasoning: "The rules live on another site.", reasoningTokens: 14,
        arguments: { url: "https://transavia.example/fare-rules" },
        renderIn: { type: "action", verb: "fetch", target: "https://transavia.example/fare-rules", crossOrigin: "transavia.example" } });
}, KEY);
await sleep(BEAT + 900); await shot("14-gate-stands-outside");

await narrate(page, "14 · …and folds in once it is answered", { sub: "the refusal is about a decision WAITING on a human, not about the tool or about it having needed approval" });
await page.evaluate((key) => {
    const hash = key.split(":")[1];
    window.__chatFake.updateSummary(key, { status: "running", pendingApprovals: 0, lastTs: Date.now() });
    window.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 },
        kind: "agent-step", step: 30, seq: 30, tool: "fetch_url", approval: "user", toolMs: 410,
        arguments: { url: "https://transavia.example/fare-rules" }, result: "Fare rules: changes €40…",
        renderIn: { type: "action", verb: "fetch", target: "https://transavia.example/fare-rules" } });
}, KEY);
await sleep(BEAT + 900); await shot("15-gate-answered-folds-in");

await narrate(page, "That is the toggle", { sub: "everything groups except a gate waiting on a human and what the model SAID — and nothing is dropped: the busy view and both exports keep the whole trace" });
await sleep(BEAT);

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// PART THREE — the other thing the reading view does as a run goes: a STEP-CAP STOP that was continued past.
// Its own session, because this one is deliberately a mess by now and the seam is worth seeing on a clean page.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const CAP = "laptop:9c0ffee1";
await page.evaluate(([key, task]) => {
    const [runtime, hash] = key.split(":");
    const now = Date.now();
    window.__chatFake.addSession(
        { id: { runtime, hash }, kind: "agent", status: "running", createdTs: now, lastTs: now, pendingApprovals: 0, saved: true,
          title: "Stopped, then continued", task, model: "qwen3:32b", page: { url: "https://flights.example/search", title: "Flights", tabId: 41 } },
        [{ id: `${hash}-0`, ts: now, save: true, session: { hash, turn: 0 }, kind: "agent", task, model: "qwen3:32b", maxSteps: 4,
           config: undefined, pageUrl: "https://flights.example/search", pageTitle: "Flights" }],
    );
}, [CAP, "Check every fare's rules, one by one"]);
await page.goto(server.url + `#/s/${encodeURIComponent(CAP)}`);
await page.locator(".chat-transcript").waitFor();

const capStep = (n) => page.evaluate(([key, s]) => {
    const hash = key.split(":")[1];
    window.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 },
        kind: "agent-step", step: s, seq: s, tool: "fetch_url", approval: "user", toolMs: 300 + ((s * 53) % 500),
        reasoning: "Next fare.", reasoningTokens: 11,
        arguments: { url: `https://transavia.example/rules/${s}` }, result: "changes €40…",
        renderIn: { type: "action", verb: "fetch", target: `https://transavia.example/rules/${s}` } });
}, [CAP, n]);

await narrate(page, "15 · A run that stops at its cap", { sub: "four steps, a 4-step budget — and an answer that offers Continue, because right now this really is the end" });
for (const n of [1, 2, 3, 4]) { await capStep(n); await page.waitForTimeout(220); }
await page.evaluate((key) => {
    const hash = key.split(":")[1];
    window.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 },
        kind: "agent-result", steps: 4, hitCap: true, summary: "Stopped at the 4-step cap without finishing." });
    window.__chatFake.updateSummary(key, { status: "capped", lastTs: Date.now() });
}, CAP);
await sleep(BEAT + 700); await shot("16-stopped-at-the-cap");

await narrate(page, "16 · …and is continued past it", { sub: "the answer said it had ended; steps are arriving under it. Read top to bottom that is a contradiction, and the question it provokes is about a BUDGET" });
await page.evaluate((key) => {
    const hash = key.split(":")[1];
    window.__chatFake.updateSummary(key, { status: "running", lastTs: Date.now() });
    window.__chatFake.emit(key, { id: `${hash}-0`, ts: Date.now(), save: true, session: { hash, turn: 0 },
        kind: "agent-cap", maxSteps: 20 });
}, CAP);
await sleep(600);
for (const n of [5, 6, 7]) { await capStep(n); await page.waitForTimeout(260); }
await sleep(BEAT + 700); await shot("17-the-cap-seam");

await narrate(page, "17 · So it answers with the budget", { sub: "the boilerplate answer collapses into a seam: what it stopped at, and what it was then given. The answer itself is in the tip, and both exports keep it whole" });
// The tip FOLLOWS the cursor, so it is raised by a pointer MOVE and not by arriving: `hover()` alone put the
// pointer there and left the layer empty in the capture. Two moves, the second a pixel off the first.
{
    const box = await page.locator(".cap-divider .nav-label").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.move(box.x + box.width / 2 + 1, box.y + box.height / 2);
}
await sleep(BEAT + 700); await shot("18-the-seam-tip");

await narrate(page, "That is the reading view", { sub: "it says what it is doing as the run goes, instead of cutting between states — and never at the cost of what is in the log" });
await sleep(BEAT);
await narrateDone(page);
console.log(`screenshots in ${ART}`);
if (errors.length) console.error("page errors:\n" + errors.join("\n"));
if (HOLD) await new Promise(() => {});
await browser.close();
await server.close();
process.exit(errors.length ? 1 : 0);
