// live-call-demo.mjs — a NARRATED VISUAL demo (not a test) of a tool call being drawn while the model WRITES it.
//
//   npm run build && node --import tsx tests/e2e/live-call-demo.mjs
//
// A long argument (a script, a document) used to show nothing until the model stopped writing it, so a model writing
// slowly and a model that had stalled looked the same. Three beats, on a scripted fake model streaming OpenAI fragments:
//   1. `python_exec`: a forty-line cell grows where its step will land, with a caret where the text arrives, and the
//      orb says which call is being written; the step replaces it once the call lands, and the cell runs.
//   2. a stall: the same kind of call goes quiet for nine seconds mid-write; after four the row says "no output for
//      Ns" and the caret stops, and the next fragment clears both.
//   3. `answer`: a Markdown document streams as Markdown, its open formatting closed as it goes.
//
// Deterministic (fake-LLM, no model or key). Screenshots land in tests/e2e/artifacts/live-call-demo/. Env: HOLD=0 to
// exit at the end. The assertions are tests/e2e/live-call.spec.mjs, tests/sidebar-live-call.test.js and
// tests/background-stream-calls.test.js.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar, narrate, narrateDone } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "live-call-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";
const TASK = "Simulate two dice and summarise the result";

const PY = `
import random
from collections import Counter

# ------------------------------------------------------------
# Block 1: configuration
# ------------------------------------------------------------
ROLLS = 10_000
SIDES = 6
random.seed(7)

# ------------------------------------------------------------
# Block 2: roll two dice, many times
# ------------------------------------------------------------
sums = [random.randint(1, SIDES) + random.randint(1, SIDES) for _ in range(ROLLS)]
counts = Counter(sums)

# ------------------------------------------------------------
# Block 3: the mean and the variance
# ------------------------------------------------------------
mean = sum(sums) / ROLLS
var = sum((s - mean) ** 2 for s in sums) / ROLLS

# ------------------------------------------------------------
# Block 4: a text histogram, one row per sum
# ------------------------------------------------------------
peak = max(counts.values())
for total in range(2, 2 * SIDES + 1):
    n = counts[total]
    bar = "#" * round(40 * n / peak)
    print(f"{total:>2} {n:>5} {bar}")

# ------------------------------------------------------------
# Block 5: the summary line
# ------------------------------------------------------------
print(f"mean {mean:.3f}, variance {var:.3f} over {ROLLS} rolls")
`.trim();

// A read-only survey the dialect runs unasked: the call whose writing stalls.
const SURVEY = [...Array.from({ length: 14 }, (_, i) => `// check ${i + 1}: the page still shows the dice table`), "document.title"].join("\n");

const ANSWER = `## Two dice, 10 000 rolls

The sums pile up in the **middle**: 7 is the most common, at about 1 in 6, and 2 and 12 are the rarest, at about 1 in 36 each.

| Sum | Expected share |
| --- | --- |
| 2 or 12 | 2.8 % |
| 7 | 16.7 % |

- The mean came out at **7.0**, as it should for two fair dice.
- The variance is close to **5.83** (35/6).

Nothing in the rolls suggests a loaded die.`;

/** `n` call beats: the arguments split across `n` fragments, one per beat. */
const calls = (n) => Array.from({ length: n }, () => ({ kind: "call" }));

const main = async () => {
    const log = (m) => console.log(m);
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 70 });
    const site = await startPageServer({});
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
            autoApprovePython: true, autoApproveReadonly: true,
        });
        fake.setScript([
            { tool: "python_exec", args: { code: PY, mode: "readonly" },
              emit: [{ kind: "think", text: "A short simulation answers this; I'll write it in one cell." }, ...calls(110)] },
            // Half the survey, nine seconds of nothing, then the rest: a server that went quiet mid-call.
            { tool: "exec", args: { js: SURVEY }, emit: [...calls(20), { kind: "pause", ms: 9000 }, ...calls(20)] },
            { tool: "answer", args: { text: ANSWER }, emit: calls(90) },
            { content: "Done: the summary is in the answer." },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 950 });
        await page.goto(site.url + "/");
        await waitForMl(page);
        await narrate(page, "A tool call, drawn while it is written", { sub: "A long argument used to show nothing until the model stopped writing it." });
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        await ext.sw.evaluate(([id, task]) => globalThis.__mlStartUserRunForTest(id, { task, stream: true, hud: "quiet", surface: "overlay" }, { answer: true }), [tabId, TASK]);
        const frame = await openRunInSidebar(page, { task: TASK.slice(0, 20) });

        /** What the live call shows now, if one is drawn. */
        const live = () => frame.evaluate(() => {
            const lc = document.querySelector(".live-call");
            return lc && { name: lc.querySelector(".tool-name")?.textContent, head: lc.querySelector(".astep-preview")?.textContent ?? "",
                           len: (lc.querySelector(".live-call-code, .live-call-md, .jt-args")?.textContent || "").length,
                           stalled: lc.classList.contains("stalled") };
        }).catch(() => null);
        const shot = (name) => page.screenshot({ path: path.join(ART, `${name}.png`) }).catch(() => {});

        const said = new Set();
        /** Narrate `key` once, and take its screenshot. */
        const beat = async (key, title, sub) => {
            if (said.has(key)) return;
            said.add(key);
            log(`${key}: ${title}`);
            await narrate(page, title, { sub });
            await sleep(250);
            await shot(key);
        };
        let resumedFrom = 0;
        for (let i = 0; i < 1200; i++) {
            const lc = await live();
            if (lc?.name === "python_exec" && lc.len > 200)
                await beat("1-writing", "Written live: python_exec", "The cell grows where its step will land; the caret is where the text arrives, and the orb names the call.");
            if (said.has("1-writing") && !said.has("1b-landed") && !lc && (await frame.locator(".astep.tool").count()) > 0)
                await beat("1b-landed", "The call landed", "The step that runs it replaces the preview in place, and the cell runs.");
            if (lc?.name === "exec" && !lc.stalled && !said.has("2-stalled") && lc.len > 80)
                await beat("2-writing", "Another call starts", "An exec survey, written the same way…");
            if (lc?.stalled) {
                resumedFrom = lc.len;
                await beat("2-stalled", "…and goes quiet", "Nothing for over 4 s: the row says how long, and the caret stops. Slow and stalled no longer look alike.");
                if (said.has("2-stalled") && /no output for [7-9]s/.test(lc.head)) await shot("2-stalled-late");
            }
            if (said.has("2-stalled") && lc?.name === "exec" && !lc.stalled && lc.len > resumedFrom)
                await beat("2-resumed", "Writing again", "The next fragment clears the notice, and the caret blinks again.");
            if (lc?.name === "answer" && lc.len > 250)
                await beat("3-answer", "A document, as Markdown", "answer's text renders as it arrives, its open bold and table closed for it.");
            if (fake.calls().length >= 4 && !lc && (await frame.locator(".astep.tool.pending").count()) === 0) break;
            await sleep(120);
        }
        await sleep(800);
        await shot("4-done");
        log(`\ndone: screenshots in ${ART}`);
        if (HOLD) {
            await narrateDone(page);
            log("holding the browser open (HOLD=0 to skip). Close the window or Ctrl+C to exit.");
            await page.waitForEvent("close", { timeout: 0 }).catch(() => {});
        }
    } finally {
        if (!HOLD) await ext.close().catch(() => {});
        fake.stop?.(); site.stop?.();
    }
    process.exit(0);
};
main().catch((e) => { console.log("ERR", e); process.exit(2); });
