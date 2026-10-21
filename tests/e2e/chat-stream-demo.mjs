#!/usr/bin/env node
// chat-stream-demo.mjs — a NARRATED VISUAL demo (not a test) of the chat page's CALM view while a run streams: a tool
// call typed out while the model writes it, its output while it runs, a stall told apart from slowness, and the reply
// fading in word by word. No extension and no model: it serves dist-web/ and drives the fake host's events by hand
// (`window.__chatFake.emit`), in the order and at the pace a streamed run sends them.
//
//   npm run build && node tests/e2e/chat-stream-demo.mjs        # or `node scripts/build-web.mjs` for dist-web/ alone
//
// Beats: python_exec is written (calls), runs (streamOutput) and lands; an exec survey goes quiet for nine seconds
// mid-write, then resumes and runs; the reply streams as content and settles into the answer. Screenshots land in
// tests/e2e/artifacts/chat-stream-demo/. Env: HOLD=0 to exit at the end, THEME=light, PHONE=1 for a 390px viewport,
// ANSWER=tool to end through the `answer` call instead of streamed content (shots in chat-stream-demo-answer-tool/).
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "./static-server.mjs";
import { narrate, narrateDone } from "./harness.mjs";

const ROOT = path.resolve(process.env.E2E_DIST_WEB || "dist-web");
if (!fs.existsSync(path.join(ROOT, "chat.js"))) { console.error(`no web build at ${ROOT}: run node scripts/build-web.mjs`); process.exit(1); }
const ART = path.resolve("tests/e2e/artifacts/chat-stream-demo" + (process.env.ANSWER === "tool" ? "-answer-tool" : ""));
fs.mkdirSync(ART, { recursive: true });
const HOLD = process.env.HOLD !== "0";
const ANSWER_TOOL = process.env.ANSWER === "tool";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TASK = "Simulate two dice and summarise the result";
const HASH = "5eed0d1e", KEY = `laptop:${HASH}`;

const PY = `import random
import time
from collections import Counter

ROLLS = 10_000
SIDES = 6
random.seed(7)

# Roll two dice, in batches, saying how far it got
sums = []
for batch in range(5):
    sums += [random.randint(1, SIDES) + random.randint(1, SIDES) for _ in range(ROLLS // 5)]
    print(f"rolled {len(sums)} of {ROLLS}")
    time.sleep(0.4)
counts = Counter(sums)

# A text histogram, one row per sum
peak = max(counts.values())
for total in range(2, 2 * SIDES + 1):
    n = counts[total]
    print(f"{total:>2} {n:>5} {'#' * round(40 * n / peak)}")
    time.sleep(0.25)

mean = sum(sums) / ROLLS
print(f"mean {mean:.3f} over {ROLLS} rolls")`;

const COUNTS = [278, 556, 833, 1111, 1389, 1667, 1389, 1111, 833, 556, 278];
const PY_OUT = [
    ...[2000, 4000, 6000, 8000, 10000].map((n) => `rolled ${n} of 10000`),
    ...COUNTS.map((n, i) => `${String(i + 2).padStart(2)} ${String(n).padStart(5)} ${"#".repeat(Math.round(40 * n / 1667))}`),
    "mean 7.002 over 10000 rolls",
];

const CHECKS = ["the title", "the heading", "the dice table", "the links", "the footer", "the scripts", "the forms", "the images"];
const SURVEY = [
    "// Survey the page one check at a time, so each line shows as it is printed.",
    `const checks = ${JSON.stringify(CHECKS)};`,
    "for (const c of checks) {",
    "    console.log('checked ' + c);",
    "    await ml.ps();",
    "}",
    "return document.title;",
].join("\n");

const ANSWER = `## Two dice, 10 000 rolls

The sums pile up in the **middle**: 7 is the most common, at about 1 in 6, and 2 and 12 are the rarest, at about 1 in 36 each.

| Sum | Expected share |
| --- | --- |
| 2 or 12 | 2.8 % |
| 7 | 16.7 % |

The mean came out at **7.0**, as it should for two fair dice, and nothing in the rolls suggests a loaded die.`;

const server = await serveStatic(ROOT);
const browser = await chromium.launch({ channel: "chromium", headless: !HOLD });
const viewport = process.env.PHONE ? { width: 390, height: 844 } : { width: 1280, height: 860 };
const page = await browser.newPage({ viewport, colorScheme: process.env.THEME === "light" ? "light" : "dark" });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const log = (m) => console.log(m);
let n = 0;
const shot = (name) => page.screenshot({ path: path.join(ART, `${String(++n).padStart(2, "0")}-${name}.png`) }).catch(() => {});
/** Say what is happening, on screen and in the terminal. */
const say = async (title, sub) => { log(`${title}: ${sub}`); await narrate(page, title, { sub }); };

let ts = Date.now();
/** Emit one event on the demo session, stamped like the runtime stamps it. */
const emit = (ev) => page.evaluate(([k, e]) => globalThis.__chatFake.emit(k, e), [KEY, { ts: (ts = Math.max(ts + 1, Date.now())), save: ev.kind !== "agent-stream", session: { hash: HASH, turn: 0 }, ...ev }]);

/** The model WRITING a call: its argument text arrives in `parts` fragments, `gapMs` apart; `stallAt` pauses for
 *  `stallMs` before that fragment, as a server that went quiet mid-call does. */
async function writeCall(step, name, args, { parts = 80, gapMs = 70, stallAt = -1, stallMs = 0, onFragment } = {}) {
    const text = JSON.stringify(args);
    for (let i = 1; i <= parts; i++) {
        if (i === stallAt) await onFragment?.("stall", sleep(stallMs));
        const sofar = text.slice(0, Math.ceil(text.length * i / parts));
        await emit({ kind: "agent-stream", id: HASH, step, localStep: step, calls: [{ index: 0, name, args: sofar, chars: sofar.length }], tokens: Math.round(sofar.length / 4) });
        await onFragment?.(i / parts);
        await sleep(gapMs);
    }
}

/** The tool RUNNING: its output lines arrive one at a time (the worker's `streamOutput`, the whole text so far). */
async function runTool(step, tool, args, lines, { gapMs = 300, result, onLine, renderIn } = {}) {
    const started = Date.now();
    await emit({ kind: "agent-step", id: `${HASH}-${step}`, step, seq: step, pending: true, tool, arguments: args, renderIn });
    // The calm view folds a step to its name; open it, as a reader would, so its output is in view as it fills.
    const head = page.locator(`.astep.tool[data-astep-seq="${step}"] .astep-head`).first();
    await head.waitFor({ timeout: 3000 }).catch(() => {});
    if (!/\bopen\b/.test((await head.locator("..").getAttribute("class").catch(() => "")) || "")) await head.click({ timeout: 2000 }).catch(() => {});
    let out = "";
    for (const [i, line] of lines.entries()) {
        await sleep(gapMs);
        out += line + "\n";
        await emit({ kind: "agent-step", id: `${HASH}-${step}`, step, seq: step, streamOutput: out });
        await onLine?.(i, out);
    }
    await sleep(300);
    await emit({ kind: "agent-step", id: `${HASH}-${step}`, step, seq: step, tool, arguments: args, result: result ?? out, toolMs: Date.now() - started, approval: "readonly", renderIn });
}

try {
    await page.goto(server.url + `#/s/${encodeURIComponent(KEY)}`);
    await page.locator(".chat-list, .chat-transcript").first().waitFor();
    await page.evaluate(([k, h, task]) => {
        globalThis.__chatFake.addSession({ id: { runtime: "laptop", hash: h }, kind: "agent", status: "running", createdTs: Date.now(), lastTs: Date.now(), pendingApprovals: 0, saved: true, task });
        globalThis.__chatFake.emit(k, { id: h, ts: Date.now(), save: true, session: { hash: h, turn: 0 }, kind: "agent", task, model: "fake", maxSteps: 10 });
    }, [KEY, HASH, TASK]);
    await page.goto(server.url + `#/s/${encodeURIComponent(KEY)}`);
    await page.locator(".chat-transcript").waitFor();
    await say("The chat page, while a run streams", "Everything a run sends as it goes: the call being written, its output, a stall, the reply. A fake host, no model.");
    await sleep(2200);

    // --- 1. python_exec: written, run, landed ---
    await emit({ kind: "agent-stream", id: HASH, step: 1, localStep: 1, reasoning: "A short simulation answers this; I'll write it in one cell.", reasoningTokens: 14 });
    await sleep(1200);
    let said = false;
    await writeCall(1, "python_exec", { code: PY, mode: "readonly" }, { parts: 110, onFragment: async (f) => {
        if (!said && f > 0.3) { said = true; await say("A call, typed out as it is written", "python_exec's cell grows where its step will land, at an even pace, with a caret where the text arrives."); await shot("python-writing"); }
    } });
    await sleep(300);
    await say("It runs, and its output streams", "Opened, the step shows each print() as the sandbox prints it.");
    await runTool(1, "python_exec", { code: PY, mode: "readonly" }, PY_OUT, { result: PY_OUT.join("\n"), renderIn: { type: "python-in", mode: "script", code: PY }, onLine: async (i) => { if (i === 9) await shot("python-output"); } });
    await sleep(1200);

    // --- 2. an exec survey whose writing stalls, then resumes and runs ---
    await say("Another call…", "An exec survey, written the same way.");
    await writeCall(2, "exec", { js: SURVEY }, { parts: 40, gapMs: 90, stallAt: 20, stallMs: 9000, onFragment: async (f, wait) => {
        if (f !== "stall") return;
        await say("…goes quiet", "No fragment for nine seconds. After four the row says how long, and the caret stops: stalled, not slow.");
        await sleep(6000);
        await shot("exec-stalled");
        await wait;
        await say("Writing again", "The next fragment clears the notice.");
    } });
    await say("A read-only survey streams too", "Its console.log lines arrive as they print.");
    await runTool(2, "exec", { js: SURVEY }, CHECKS.map((c) => `checked ${c}`), { gapMs: 450, result: "Dice lab", renderIn: { type: "code", text: SURVEY, lang: "javascript" }, onLine: async (i) => { if (i === 4) await shot("exec-output"); } });
    await sleep(1000);

    // --- 3. the reply: as streamed content (the chat page's own word-by-word renderer), or as an `answer` call ---
    if (ANSWER_TOOL) {
        await say("The answer, written as a call", "A run that ends through the answer tool: its text arrives as call arguments, drawn as Markdown while it is written.");
        await writeCall(3, "answer", { text: ANSWER }, { parts: 90, gapMs: 60, onFragment: async (f) => { if (f === 0.5) await shot("answer-call-writing"); } });
    } else {
        await say("The reply fades in, word by word", "The calm view's reading motion: each new word settles in rather than snapping.");
        const words = ANSWER.split(/(?<=\s)/);
        let content = "";
        for (const [i, w] of words.entries()) {
            content += w;
            await emit({ kind: "agent-stream", id: HASH, step: 3, localStep: 3, content, tokens: i + 1 });
            if (i === Math.floor(words.length / 2)) await shot("reply-streaming");
            await sleep(55);
        }
    }
    await sleep(400);
    await emit({ kind: "agent-result", id: `${HASH}-ans`, steps: 3, hitCap: false, summary: ANSWER });
    await page.evaluate((k) => globalThis.__chatFake.updateSummary(k, { status: "done", lastTs: Date.now() }), KEY);
    await sleep(800);
    await say("Settled", "The streamed reply hands over to the answer in place, with nothing grown in again.");
    await shot("done");
    log(`\ndone: screenshots in ${ART}`);
    if (errors.length) log(`page errors:\n${errors.join("\n")}`);
    if (HOLD) {
        await narrateDone(page);
        log("holding the browser open (HOLD=0 to skip). Close the window or Ctrl+C to exit.");
        await page.waitForEvent("close", { timeout: 0 }).catch(() => {});
    }
} finally {
    await browser.close().catch(() => {});
    await server.close();
}
process.exit(errors.length ? 1 : 0);
