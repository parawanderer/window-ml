// readonly-stream.spec.mjs — a read-only `exec` survey streams its console lines LIVE, the same way an approved `exec`
// does. The same script runs both ways: once auto-approved by the read-only dialect (the page's mediated interpreter,
// its lines posted back through the worker to the loop's fan), once through the human gate (the page's real eval).
// Each prints a line, AWAITS a call the test holds open, then prints another, so "streamed before the step finished"
// is a state the test looks at rather than a race it happens to win.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, watchRunEvents } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

// In the dialect (`ml.ps` is a free read), and valid JavaScript for the approved path too.
const SURVEY = `console.log("before the wait"); const ps = await ml.ps(); console.log("after the wait"); return "done"`;

/** Every live-output delta and every finished step of the runs on this page's tab, from the worker's DevTools port: a
 *  run's events no longer reach the page's own window (#392). */
async function collect(ext, page) {
    const ev = { deltas: [], done: [] };
    await watchRunEvents(ext, page, (d) => {
        if (!d || d.kind !== "agent-step") return;
        if (d.streamOutput != null && d.tool == null) ev.deltas.push(d.streamOutput);
        else if (d.tool === "exec" && !d.pending) ev.done.push({ approval: d.approval, result: d.result });
    });
    return ev;
}

/** Run SURVEY with `ml.ps` held open, and return what streamed while it waited and how the step settled. */
async function streamSurvey({ readonly, js = SURVEY, held = "before the wait\n" }) {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "off", autoApproveReadonly: readonly });
        fake.setScript([{ tool: "exec", args: { js } }, { content: "Done." }]);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const ev = await collect(ext, page);
        if (readonly) fake.holdPs();
        await page.evaluate(() => { window.__run = window.ml.agent("survey the page", { stream: true, approvalRouting: "both" }); window.__run.catch(() => {}); });

        if (!readonly) {
            // The human gate: approve the one exec from outside the browser.
            await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 20000 }).toBe(1);
            const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
            fake.holdPs();
            await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
        }

        // WHILE `ml.ps` is held: the first line is out, the second is not, and the step has not finished.
        await expect.poll(() => ev.deltas.at(-1) || "", { timeout: 20000,
            message: "the line printed before the await streams while the survey waits" }).toBe(held);
        const whileHeld = { deltas: ev.deltas.slice(), done: ev.done.length };
        fake.releasePs();

        // Wait for the RUN, not for a body element of a collapsed step.
        await page.evaluate(() => window.__run);
        const after = { deltas: ev.deltas.slice(), done: ev.done.slice() };
        return { whileHeld, after };
    } finally {
        fake.releasePs();
        await ext.context.close();
        await site.stop();
        await fake.stop();
    }
}

test("a read-only exec survey streams its console lines live, exactly as an approved exec does", async () => {
    test.setTimeout(90_000);
    const ro = await streamSurvey({ readonly: true });
    const approved = await streamSurvey({ readonly: false });

    for (const [name, r] of [["read-only", ro], ["approved", approved]]) {
        expect(r.whileHeld.done, `${name}: the step had not finished while its line was on screen`).toBe(0);
        expect(r.whileHeld.deltas.every((d) => !/after the wait/.test(d)), `${name}: nothing from after the await streamed early`).toBe(true);
        // Not asserted on the deltas: the step's DONE supersedes the live view and cancels a trailing emit, so whether
        // the second line streamed before it landed is a race. The settled result is what holds both.
        expect(r.after.done).toHaveLength(1);
        expect(r.after.done[0].result).toMatch(/before the wait[\s\S]*after the wait/);
    }
    expect(ro.after.done[0].approval, "the survey was answered by the read-only dialect").toBe("readonly");
    expect(approved.after.done[0].approval, "and the other went through the gate").toBe("user");
    // EQUIVALENT: while the survey waited, the same text had streamed both ways, in the same shape.
    expect(ro.whileHeld.deltas).toEqual(approved.whileHeld.deltas);
});

test("a survey that streams and THEN falls out of dialect leaves nothing behind: discarded before the gate, not printed twice", async () => {
    test.setTimeout(60_000);
    // `document.body.click()` is refused at RUN time, after the first line has streamed.
    const js = `console.log("before the click"); document.body.click(); console.log("after the click")`;
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model",
            debugMode: "off", autoApproveReadonly: true });
        fake.setScript([{ tool: "exec", args: { js } }, { content: "Done." }]);
        const page = await ext.context.newPage();
        await page.goto(site.url + "/");
        await waitForMl(page);
        const ev = await collect(ext, page);
        await page.evaluate(() => { window.__run = window.ml.agent("click it", { stream: true, approvalRouting: "both" }); window.__run.catch(() => {}); });

        // The refused try reached the gate. By then its line must be gone: the last delta is the discard.
        await expect.poll(async () => (await ext.sw.evaluate(() => globalThis.__mlApprovals.list())).length, { timeout: 20000 }).toBe(1);
        await expect.poll(() => ev.deltas.slice(), { timeout: 5000,
            message: "the refused try streamed its line, then took it back" }).toEqual(["before the click\n", ""]);
        const [gate] = await ext.sw.evaluate(() => globalThis.__mlApprovals.list());
        await ext.sw.evaluate((key) => globalThis.__mlApprovals.resolve(key, true), gate.key);
        await page.evaluate(() => window.__run);

        const { deltas, done } = ev;
        expect(done).toHaveLength(1);
        expect(done[0].approval).toBe("user");
        // The approved run streamed from empty: no delta after the discard carries the line twice.
        expect(deltas.slice(2).every((d) => !/before the click[\s\S]*before the click/.test(d)), JSON.stringify(deltas)).toBe(true);
        expect(done[0].result.match(/before the click/g)).toHaveLength(1);
    } finally {
        await ext.context.close();
        await site.stop();
        await fake.stop();
    }
});

// The model's limit cuts the RESULT, never the stream: past it, both paths stream every line, the panel greys the
// tail (sidebar-output.test.js), and the model is sent the same clipped console either way.
const LONG = `for (const i of ml.range(20)) console.log("line " + String(i).padStart(2, "0") + " " + "x".repeat(40)); const ps = await ml.ps(); console.log("after the wait"); return "done"`;
const LONG_HELD = Array.from({ length: 20 }, (_, i) => `line ${String(i).padStart(2, "0")} ${"x".repeat(40)}\n`).join("");

test("past the model's character limit, a read-only survey streams every line and is cut exactly as an approved exec is", async () => {
    test.setTimeout(90_000);
    const ro = await streamSurvey({ readonly: true, js: LONG, held: LONG_HELD });
    const approved = await streamSurvey({ readonly: false, js: LONG, held: LONG_HELD });
    for (const [name, r] of [["read-only", ro], ["approved", approved]]) {
        expect(r.whileHeld.deltas.at(-1).length, `${name}: the stream is not cut at the model's 500`).toBeGreaterThan(900);
        const consoleSent = r.after.done[0].result.split("\n\nvalue:")[0];
        expect(consoleSent, `${name}: the model got the head`).toContain("line 00");
        expect(consoleSent, `${name}: and not the tail`).not.toContain("line 19");
        expect(consoleSent.length, `${name}: cut near the limit`).toBeLessThan(700);
    }
    expect(ro.after.done[0].approval).toBe("readonly");
    expect(ro.whileHeld.deltas).toEqual(approved.whileHeld.deltas);
    // The model is sent the same console both ways.
    expect(ro.after.done[0].result.split("\n\nvalue:")[0]).toBe(approved.after.done[0].result.split("\n\nvalue:")[0]);
});
