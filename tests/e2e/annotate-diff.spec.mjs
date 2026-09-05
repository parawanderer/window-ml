// annotate-diff.spec.mjs — the two MODEL-ASSISTED reading aids on a code block, in a real browser.
//
// The narrated version is tests/e2e/annotate-diff-demo.mjs, and it asserts nothing, so this is what
// actually holds the behaviour: the demo can only tell you it did not crash.
//
// Both aids are model-assisted, and they are trustworthy for OPPOSITE reasons — which is what these
// assertions are mostly about. The DIFF is computed by us from two sources that really ran, and the model's
// account of it rides beside as a claim. The ANNOTATION is generated, and is safe only because it can never
// touch the source: the notes go in the margin, so the line map (and every traceback resolving through it)
// is unaffected no matter what the model says.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// TALL ON PURPOSE. The padding is identical on both sides, so the diff is unaffected — but the step becomes
// taller than the viewport, which is what makes "scrolled to the code" distinguishable from "scrolled to the
// top of the step". Without it the pill test passes with the fix REVERTED, which is how it was caught.
const PAD = Array.from({ length: 40 }, (_, i) => `filler_${i} = ${i}  # padding, identical on both sides`);
const V1 = [
    "import pandas as pd",
    ...PAD,
    "rows = [{'rep':'Gia','q1':210,'q2':220},{'rep':'Kim','q1':190,'q2':205}]",
    "df = pd.DataFrame(rows)",
    "df['total'] = df['q1'] + df['q2']",
    "return df.sort_values('total', ascending=False)",
].join("\n");
// A real retry: one column RENAMED and one quarter added — and it trips on the column that is not there.
// So this step carries a diff, a failure and an annotation at once.
const V2 = [
    "import pandas as pd",
    ...PAD,
    "rows = [{'rep':'Gia','q1':210,'q2':220},{'rep':'Kim','q1':190,'q2':205}]",
    "df = pd.DataFrame(rows)",
    "df['half'] = df['q1'] + df['q2']",
    "df['year'] = df['half'] + df['q3']",
    "return df.sort_values('year', ascending=False)",
].join("\n");

/** Resolve a note onto the line of the NUMBERED source that contains its anchor — the same numbering a real
 *  utility model reads, so the fixture cannot quietly disagree with the contract. */
const notesFor = (numbered, pairs) => ({
    notes: pairs.map(([anchor, note]) => {
        const line = numbered.split("\n").find((l) => l.includes(anchor));
        return line ? { line: Number(line.split("|")[0]), note } : null;
    }).filter(Boolean),
});

const setup = async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    let asked = 0;
    fake.setSide((body) => {
        const text = String(body.messages?.[1]?.content ?? "");
        if (!/Annotate this/.test(text)) return null;
        asked++;
        return { content: JSON.stringify(notesFor(text, /q3/.test(text)
            ? [["df['year']", "reaches for `q3`: this frame has no $q_3$ to add"]]
            : [["df['total']", "adds a `total` column — $q_1 + q_2$ per rep"],
               ["sort_values", "sorts by it, **descending**"]])) };
    });
    const ext = await launchExtension();
    // Line numbers ON. They are a sidebar preference (storage.local), and notes turn them on by themselves —
    // so without seeding it the "before" read has no rows at all and comparing the two proves nothing.
    await ext.sw.evaluate(() => chrome.storage.local.set({ ml_debug_codelines: true }));
    await configureExtension(ext.sw, {
        chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
        utilityModel: "fake-model", debugMode: "overlay", autoApprovePython: true,
    });
    // Three calls: the original, a retry that FAILS, and a retry that WORKS. The last one is what says the
    // diff collapses on success — a step whose output you want must not have a diff pinned above it.
    const V3 = V2.replace("df['year'] = df['half'] + df['q3']", "df['year'] = df['half'] * 2")
        .replace("sort_values('year'", "sort_values('year'");
    fake.setScript([
        { tool: "python_exec", args: { code: V1, mode: "readonly" } },
        { tool: "python_exec", args: { code: V2, mode: "readonly",
                                       revises: "@tool:python_exec", changed: "added a full-year column" } },
        { tool: "python_exec", args: { code: V3, mode: "readonly",
                                       revises: "@tool:python_exec", changed: "dropped the missing quarter" } },
        { content: "no q3 to sum" },
    ]);
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1400, height: 950 });
    await page.goto(`${fake.url}/api/version`);
    await waitForMl(page);
    await page.evaluate(() => {
        window.ml.agent("total the quarters, then add the year", {
            approvalRouting: "both", extraTools: [window.ml.pythonTool()], toolTokens: true,
        });
    });
    const frame = await openRunInSidebar(page, { task: "total the quarters" });
    for (let i = 0; i < 60; i++) {
        const pending = await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).map((d) => d.key));
        for (const k of pending) await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), k);
        if (await frame.locator(".r-py-in").count() >= 2) break;
        await sleep(400);
    }
    return { fake, ext, frame, asked: () => asked };
};

test("annotations go in the MARGIN — the source keeps every line, and its numbers", async () => {
    const { fake, ext, frame, asked } = await setup();
    try {
        const step = frame.locator(".astep").first();
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-py-in")).toBeVisible({ timeout: 30000 });

        // Before: no notes, and the button offers to fetch them.
        await expect(step.locator(".lnote")).toHaveCount(0);
        const explain = step.locator(".code-tool", { hasText: "explain" });
        await expect(explain).toBeEnabled();
        const linesBefore = await step.locator(".r-py-in .cline .lcode").allTextContents();

        await explain.click();
        await expect(step.locator(".lnote")).toHaveCount(2, { timeout: 15000 });
        expect(asked(), "one utility call, not one per line").toBe(1);

        // THE INVARIANT. Notes are siblings of their lines, never inserted into them: the source is
        // byte-identical and the gutter still numbers 1..N, which is what keeps the line map (and every
        // traceback resolving through it) valid no matter what the model returned.
        expect(await step.locator(".r-py-in .cline .lcode").allTextContents()).toEqual(linesBefore);
        const nums = await step.locator(".r-py-in .lno").allTextContents();
        expect(nums).toEqual(linesBefore.map((_, i) => String(i + 1)));

        // Each note sits directly after the line it is about, so "keyed to a line number" is visible rather
        // than merely claimed.
        const anchored = await step.locator(".r-py-in .cline:has-text(\"df['total']\") + .lnote").textContent();
        expect(anchored).toContain("adds a");

        // The prose goes through the markdown renderer: inline code, bold, AND math — a note about
        // arithmetic is exactly where a formula says it in one glyph instead of a clause.
        await expect(step.locator(".lnote code").first()).toHaveText("total");
        await expect(step.locator(".lnote strong").first()).toHaveText("descending");
        await expect(step.locator(".lnote .katex").first()).toBeVisible();
    } finally { await ext.context.close(); await fake.stop(); }
});

test("the notes toggle without a second call, and the utility model is asked only on demand", async () => {
    const { fake, ext, frame, asked } = await setup();
    try {
        const step = frame.locator(".astep").first();
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-py-in")).toBeVisible({ timeout: 30000 });
        // NEVER automatic: it spends tokens, and unlike the approval gloss nobody is waiting on it.
        expect(asked()).toBe(0);

        await step.locator(".code-tool", { hasText: "explain" }).click();
        await expect(step.locator(".lnote")).toHaveCount(2, { timeout: 15000 });

        const toggle = step.locator(".code-tool", { hasText: "notes" });
        await toggle.click();
        await expect(step.locator(".lnote")).toHaveCount(0);
        await toggle.click();
        await expect(step.locator(".lnote")).toHaveCount(2);
        expect(asked(), "hiding is not discarding — it comes back from the same call").toBe(1);
    } finally { await ext.context.close(); await fake.stop(); }
});

test("a retry's diff is COMPUTED, and contradicts the model's own account of it", async () => {
    const { fake, ext, frame } = await setup();
    try {
        const step = frame.locator(".astep").nth(1);
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-diff")).toBeVisible({ timeout: 30000 });

        // It says WHAT it is diffing against, resolved to the minted id even though the model named an
        // alias — a pointer you cannot follow is half an answer.
        const ref = step.locator(".r-diff-ref");
        await expect(ref).toContainText("@tool:");

        // The model claimed ONE change. The diff shows TWO, because we computed it from the sources that
        // actually ran rather than asking what it meant to change.
        await expect(step.locator(".r-diff-claim")).toContainText("added a full-year column");
        const added = await step.locator(".dline-add").allTextContents();
        const removed = await step.locator(".dline-del").allTextContents();
        expect(added.join("\n")).toContain("df['year']");
        expect(added.join("\n"), "the RENAME the claim omitted").toContain("df['half']");
        expect(removed.join("\n")).toContain("df['total']");
        // Unchanged lines are not repeated as a change.
        expect(added.join("\n")).not.toContain("import pandas");
    } finally { await ext.context.close(); await fake.stop(); }
});

test("a diff, a failure and an annotation compose on ONE block without colliding", async () => {
    // The composition is the point: three separate mechanisms writing into the same column. Reading down it
    // you get what changed since last time, where it broke, and what each line is doing.
    const { fake, ext, frame } = await setup();
    try {
        const step = frame.locator(".astep").nth(1);
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-diff")).toBeVisible({ timeout: 30000 });
        await expect(step.locator(".cline-fail"), "the failing line is marked in the same block").toHaveCount(1);

        const linesBefore = await step.locator(".r-py-in .cline .lcode").allTextContents();
        await step.locator(".code-tool", { hasText: "explain" }).click();
        await expect(step.locator(".lnote")).toHaveCount(1, { timeout: 15000 });

        // All three at once, and the annotation still did not move a line — which is what stops it breaking
        // the failure mark it is sitting next to.
        await expect(step.locator(".r-diff")).toBeVisible();
        await expect(step.locator(".cline-fail")).toHaveCount(1);
        expect(await step.locator(".r-py-in .cline .lcode").allTextContents()).toEqual(linesBefore);
        // The diff is drawn ABOVE the code, so the reader meets "what changed" before "what it says".
        const diffY = (await step.locator(".r-diff").boundingBox()).y;
        const codeY = (await step.locator(".code-block pre.code").boundingBox()).y;
        expect(diffY).toBeLessThan(codeY);
    } finally { await ext.context.close(); await fake.stop(); }
});

// FOCUS MODE reads the run as a conversation, and "what changed since the last attempt" is a debugger's
// question. So the diff's ROWS fold — but the header does not: it still says the step revises something,
// which one, and by how much. Nothing is hidden; the detail is put away.
test("focus mode folds the diff's rows and keeps its header", async () => {
    const { fake, ext, frame } = await setup();
    try {
        const step = frame.locator(".astep").nth(1);
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-diff")).toBeVisible({ timeout: 30000 });
        // Open by default OUTSIDE focus mode — the debugging surface shows the debugging detail.
        await expect(step.locator(".dline").first()).toBeVisible();

        await frame.locator('[aria-label="Focus mode"]').click();
        await expect(step.locator(".r-diff-body")).toHaveCount(0, { timeout: 5000 });
        // …and everything that says WHAT it is stays: the label, the pointer you can follow, the size of it.
        await expect(step.locator(".r-diff-lbl")).toBeVisible();
        await expect(step.locator(".r-diff-ref")).toBeVisible();
        await expect(step.locator(".r-diff-stat")).toBeVisible();

        // Still openable by hand — a fold, not a hide. This is why it seeds a state instead of using the
        // CSS hide the rest of focus mode uses.
        await step.locator(".r-diff-tri").click();
        await expect(step.locator(".dline").first()).toBeVisible();

        // And leaving focus mode restores the default rather than whatever the fold left behind.
        await frame.locator('[aria-label="Focus mode"]').click();
        await expect(step.locator(".dline").first()).toBeVisible();
    } finally { await ext.context.close(); await fake.stop(); }
});

// WHEN THE DIFF OPENS. "What did I change" is the question you ask about a FAILURE. On a retry that WORKED
// it is not the question — the output is — and a diff pinned open above it pushes that output out of the
// viewport to answer something nobody asked. So: open on a failure, one collapsed line on a success, and
// the line still says what it revises and by how much either way.
test("the diff opens on a failed retry and collapses to one line on a successful one", async () => {
    const { fake, ext, frame } = await setup();
    try {
        // Wait for the third step, which is the one that succeeds.
        for (let i = 0; i < 40; i++) {
            if (await frame.locator(".astep.tool").count() >= 3) break;
            await sleep(400);
        }
        const failedStep = frame.locator(".astep").nth(1);
        const okStep = frame.locator(".astep").nth(2);
        for (const st of [failedStep, okStep]) {
            if (!(await st.locator(".r-py-in").count())) await st.locator(".astep-head").click();
        }
        await expect(failedStep.locator(".r-diff")).toBeVisible({ timeout: 30000 });
        await expect(okStep.locator(".r-diff")).toBeVisible();

        // The FAILURE keeps its rows: that is the step you are trying to understand.
        await expect(failedStep.locator(".dline").first()).toBeVisible();
        // The SUCCESS is one line — no rows, and no claim row either, or "collapsed" would be two lines.
        await expect(okStep.locator(".r-diff-body")).toHaveCount(0);
        await expect(okStep.locator(".r-diff-claim")).toHaveCount(0);
        // …but the line still carries what it is and how big: nothing is hidden, only put away.
        await expect(okStep.locator(".r-diff-lbl")).toBeVisible();
        await expect(okStep.locator(".r-diff-ref")).toBeVisible();
        await expect(okStep.locator(".r-diff-stat")).toContainText("+");

        // And it opens on demand, claim and all.
        await okStep.locator(".r-diff-tri").click();
        await expect(okStep.locator(".dline").first()).toBeVisible();
        await expect(okStep.locator(".r-diff-claim")).toContainText("dropped the missing quarter");
    } finally { await ext.context.close(); await fake.stop(); }
});

// THE PILL IS A POINTER, so it navigates — and it lands on the CODE, not on the top of the step. The step it
// points at is usually COLLAPSED, which is what made this worth a test: the slot anchor is looked up while
// the open is still re-rendering, so before the fix it found nothing visible and fell back to the row. That
// failed only in the case you are actually in, and worked in the one a hand-check would try first.
test("the revises pill scrolls to the OLD call's code, not to the top of its step", async () => {
    const { fake, ext, frame } = await setup();
    try {
        const step = frame.locator(".astep").nth(1);
        if (!(await step.locator(".r-py-in").count())) await step.locator(".astep-head").click();
        await expect(step.locator(".r-diff-ref")).toBeVisible({ timeout: 30000 });

        // The step being pointed AT is collapsed — the ordinary case, and the one that was broken.
        const target = frame.locator(".astep").nth(0);
        if (await target.locator(".r-py-in").count()) await target.locator(".astep-head").click();
        await expect(target.locator(".r-py-in")).toHaveCount(0);

        await step.locator(".r-diff-ref").click();

        // It opened the step…
        await expect(target.locator(".r-py-in")).toBeVisible({ timeout: 10000 });
        // …and scrolled to the CODE. The In block carries the `data-cite="in"` anchor; the assertion is that
        // it is the thing on screen, not merely that it exists.
        const anchor = target.locator("[data-cite='in']").first();
        await expect(anchor).toBeInViewport({ timeout: 10000 });
        await expect(anchor).toContainText("df['total']", { timeout: 10000 });
        // THE DISTINCTION, which is the only thing worth asserting here: the step is taller than the
        // viewport, so landing on its top and landing on its code are different places. The head must be
        // scrolled PAST — if it is still on screen we went to the row, which is the bug.
        await expect.poll(async () => {
            const head = await target.locator(".astep-head").boundingBox();
            const code = await anchor.boundingBox();
            return head && code ? head.y < code.y - 200 : null;
        }, { timeout: 10000 }).toBe(true);
        // (The pulse that marks WHICH step you were sent to lasts about a second, so it is long gone by the
        // time the assertions above have settled. It has its own coverage; this test is about WHERE.)
    } finally { await ext.context.close(); await fake.stop(); }
});
