// annotate-diff-demo.mjs — a NARRATED VISUAL demo (not a test) of the two MODEL-ASSISTED reading aids on a
// code block, and of how they compose with each other and with a failure.
//
//   npm run build && node --import tsx tests/e2e/annotate-diff-demo.mjs
//
// The two are deliberately different KINDS of thing, and putting them on the same block is the point:
//
//   1. THE DIFF is COMPUTED. The model names an earlier call with `revises` and we diff the two sources
//      ourselves — both reflowed first, or pure spacing differences drown the real change. Its own account
//      of what it changed (`changed`) rides along as a CLAIM, on its own ground, never instead of the rows:
//      a model answers that question from what it MEANT to change, and the two disagree exactly when the
//      diff is worth reading. In this demo the claim is deliberately INCOMPLETE — it names one of the two
//      things it altered — so you can see the diff contradict it in place.
//   2. THE ANNOTATION is GENERATED. A utility model is shown the code AND what it produced, and answers
//      with a note per interesting line. Opt-in per block (💡 explain), never automatic. The notes are drawn
//      in the MARGIN and never inserted into the source: inserting would shift every line below it, which
//      invalidates the line map and stops a traceback resolving.
//
// THE COMPOSITION worth looking at is step 2, which has all three at once: it FAILED, it revises step 1,
// and it can be annotated. Reading down the block you get — what changed since last time · where it broke,
// marked in the code · what each line is doing. Three separate mechanisms, one column, no overlap.
//
// Deterministic: a scripted fake-LLM drives the run, and the fake's `setSide` answers the annotator's
// utility call (which is NOT part of the run, so it must not consume a scripted turn).
//
// Screenshots land in tests/e2e/artifacts/annotate-diff-demo/. Env: HOLD=0 to exit instead of waiting.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const ART = path.join(path.dirname(fileURLToPath(import.meta.url)), "artifacts", "annotate-diff-demo");
mkdirSync(ART, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOLD = process.env.HOLD !== "0";

// V1 — works, and is the thing the retry will be diffed against.
const V1 = [
    "import pandas as pd",
    "rows = [{'rep':'Gia','q1':210,'q2':220},{'rep':'Kim','q1':190,'q2':205},{'rep':'Ada','q1':150,'q2':160}]",
    "df = pd.DataFrame(rows)",
    "df['total'] = df['q1'] + df['q2']",
    "return df.sort_values('total', ascending=False).head(2)",
].join("\n");

// V2 — a real retry: one column renamed, one quarter added, and it TRIPS on the column that is not there.
// So this step carries a diff, a failure AND an annotation, which is the composition the demo is for.
const V2 = [
    "import pandas as pd",
    "rows = [{'rep':'Gia','q1':210,'q2':220},{'rep':'Kim','q1':190,'q2':205},{'rep':'Ada','q1':150,'q2':160}]",
    "df = pd.DataFrame(rows)",
    "df['half'] = df['q1'] + df['q2']",
    "df['year'] = df['half'] + df['q3'] + df['q4']",
    "return df.sort_values('year', ascending=False).head(2)",
].join("\n");

// What the annotator answers with. Fixed rather than model-authored so the demo is deterministic, but the
// LINE NUMBERS are resolved from the numbered source the model was actually sent — which is the reflowed
// text the reader sees, NOT the original. Hardcoding them against the original is the mistake the contract
// exists to prevent, and a demo that made it would draw every note one statement adrift.
//
// The notes themselves exercise the whole inline renderer: `code`, **bold**, and inline LaTeX, since a note
// about arithmetic is exactly where a formula says it in one glyph instead of a clause.
const NOTES = {
    1: [
        ["df['total']", "adds a `total` column — $q_1 + q_2$ per rep"],
        ["sort_values", "sorts by it and keeps the **top two**"],
    ],
    2: [
        ["df['half']", "renamed from `total` — same arithmetic $q_1 + q_2$, new name"],
        ["df['year']", "reaches for `q3`/`q4`: this frame has no $q_3, q_4$ to add"],
        ["sort_values", "sorts by the column the line above failed to build"],
    ],
};
/** Resolve each note onto the line of the NUMBERED source that actually contains its anchor — the same
 *  numbering a real utility model would be reading, so the demo cannot drift from the contract. */
const notesFor = (numbered, pairs) => {
    const lines = numbered.split("\n");
    const notes = [];
    for (const [anchor, note] of pairs) {
        const i = lines.findIndex((l) => l.includes(anchor));
        if (i >= 0) notes.push({ line: Number(lines[i].split("|")[0]), note });
    }
    return { notes };
};

const main = async () => {
    const log = (m) => console.log(m);
    const fake = await startFakeLlm({ model: "fake-model" });
    // The annotator's call carries no `tools` (it is not the run), so the fake answers it off to the side and
    // the scripted turns stay where they are. Which block asked is told from the numbered source it sent.
    let asked = 0;
    fake.setSide((body) => {
        const text = String(body.messages?.[1]?.content ?? "");
        if (!/Annotate this/.test(text)) return null;
        asked++;
        return { content: JSON.stringify(notesFor(text, /q3/.test(text) ? NOTES[2] : NOTES[1])) };
    });
    const ext = await launchExtension({ headful: true });
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            // The annotator runs on the UTILITY model — without one configured the button is disabled and
            // says so, which is correct but not what this demo is about.
            utilityModel: "fake-model",
            debugMode: "overlay", autoApprovePython: true,
        });
        fake.setScript([
            { tool: "python_exec", args: { code: V1, mode: "readonly", token: "the q1+q2 totals" } },
            // The retry NAMES what it revises and says what it thinks it changed. The claim is incomplete on
            // purpose — it mentions the new column and not the rename.
            { tool: "python_exec", args: { code: V2, mode: "readonly",
                                           revises: "@tool:python_exec", changed: "added a full-year column" } },
            { content: "The frame only has q1 and q2 — there is no q3/q4 to sum." },
        ]);

        const page = await ext.context.newPage();
        await page.setViewportSize({ width: 1500, height: 1000 });
        await page.goto(`${fake.url}/api/version`);
        await waitForMl(page);

        log("starting the run …");
        await page.evaluate(() => {
            window.ml.agent("total the quarters, then try to add the full year", {
                approvalRouting: "both", extraTools: [window.ml.pythonTool()], toolTokens: true,
            });
        });
        const frame = await openRunInSidebar(page, { task: "total the quarters" });
        // Wait on the STEP ROWS, not on `.r-py-in`: a step's body only renders once it is opened, so waiting
        // for two rendered code blocks waits for something that never happens on its own and then reports
        // whatever had arrived by the timeout — which is how this demo once claimed the run had one step.
        for (let i = 0; i < 60; i++) {
            const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
            for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
            if (await frame.locator(".astep.tool").count() >= 2) break;
            await sleep(400);
        }
        await sleep(1200);

        const steps = frame.locator(".astep");
        log(`\n(${await steps.count()} steps)`);

        // 1 — the first call, annotated. Nothing else is going on in this block, so it is the clean look at
        // what an annotation IS: a note per line, in the margin, with the source untouched beside it.
        const one = steps.nth(0);
        if (!(await one.locator(".r-py-in").count())) await one.locator(".astep-head").click().catch(() => {});
        await sleep(600);
        await one.locator(".code-tool", { hasText: "explain" }).first().click();
        await sleep(900);
        const notes1 = await one.locator(".lnote").allTextContents();
        log(`\n--- step 1: ${notes1.length} margin notes (the utility model was asked ${asked}x) ---`);
        for (const n of notes1) log("    " + n.trim());
        // The SOURCE is untouched — that is the invariant the margin exists to keep.
        const lines1 = await one.locator(".r-py-in .cline .lcode").allTextContents();
        log(`\n--- step 1: the code is still ${lines1.length} lines, unshifted ---\n` + lines1.join("\n"));
        await one.locator(".r-py-in").scrollIntoViewIfNeeded().catch(() => {});
        await sleep(400);
        await frame.page().screenshot({ path: path.join(ART, "1-annotated.png") });

        // 2 — THE COMPOSITION. A retry that also failed: diff on top, failure marked in the code, notes in
        // the margin. Three mechanisms in one column.
        const two = steps.nth(1);
        if (!(await two.locator(".r-py-in").count())) await two.locator(".astep-head").click().catch(() => {});
        await sleep(600);
        const diff = two.locator(".r-diff");
        log(`\n--- step 2: revises ${await diff.locator(".r-diff-ref").textContent().catch(() => "(none)")} · ${(await diff.locator(".r-diff-stat").textContent().catch(() => "")).trim()} ---`);
        log("    the model's claim: " + (await diff.locator(".r-diff-claim").textContent().catch(() => "(none)")).trim());
        const rows = await diff.locator(".dline").allTextContents();
        log("--- the computed diff (note it shows the RENAME the claim omitted) ---");
        for (const r of rows) log("    " + r.replace(/\n/g, ""));
        await frame.page().screenshot({ path: path.join(ART, "2-diff.png") });

        await two.locator(".code-tool", { hasText: "explain" }).first().click();
        await sleep(900);
        const notes2 = await two.locator(".lnote").allTextContents();
        log(`\n--- step 2: ${notes2.length} notes, ON TOP of the diff and the failure mark ---`);
        for (const n of notes2) log("    " + n.trim());
        const failed = await two.locator(".cline-fail").textContent().catch(() => "");
        log("--- and the line that broke, still marked in the same block ---\n    " + (failed || "(none)").trim());
        await two.locator(".r-py-in").scrollIntoViewIfNeeded().catch(() => {});
        await sleep(400);
        await frame.page().screenshot({ path: path.join(ART, "3-all-three.png") });

        // 3 — the notes are a TOGGLE, not a one-way door: the button becomes show/hide once they land, and
        // hiding them does not throw the call away.
        await two.locator(".code-tool", { hasText: "notes" }).first().click();
        await sleep(500);
        log(`\n--- notes hidden: ${await two.locator(".lnote").count()} drawn, and the utility model was still asked only ${asked}x ---`);
        await two.locator(".code-tool", { hasText: "notes" }).first().click();
        await sleep(500);
        log(`--- and back: ${await two.locator(".lnote").count()} drawn, from the same call ---`);
        await frame.page().screenshot({ path: path.join(ART, "4-toggled-back.png") });

        log(`\nscreenshots → ${ART}`);
        if (HOLD) { log("\nholding the browser open — close the window or Ctrl+C to exit"); await new Promise(() => {}); }
    } finally {
        if (!HOLD) { await ext.context.close(); await fake.stop(); }
    }
};

main().catch((e) => { console.error(e); process.exit(1); });
