// gen-phases.spec.mjs — end-to-end (real Chromium + built extension) proof that a streamed turn is split by
// WHAT the model was emitting, and that a call in flight is visible while it happens.
//
// Both halves need a real browser. The phase marks are stamped in the SERVICE WORKER as the SSE arrives —
// that is the only place the channel of each chunk is observable, and everything downstream sees the
// accumulated strings — so anything short of the real stream through the real background worker is testing a
// mock of the thing under test. The INTERLEAVED case is the one that matters: a model that resumes reasoning
// after emitting tool-call fragments must produce four phases in order, because bucketing by kind would
// collapse the re-entry and draw a block that never happened.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

/** Attach a node-side collector for the extension's own `__mlDebug` stream — the same bridge the observer
 *  uses, so these assert on the events the product actually emits rather than on a test-only hook. */
async function collectDebug(page, events) {
    await page.exposeFunction("__phEvent", (ev) => events.push(ev));
    await page.addInitScript(() => {
        if (window.top !== window) return;   // the overlay's iframe sees the same messages; capturing there doubles every event
        window.addEventListener("message", (e) => { if (e.data && e.data.__mlDebug) window.__phEvent(e.data.__mlDebug); });
    });
}

const kindsOf = (phases) => (phases || []).map((p) => p.kind);

test("a streamed turn is split by channel, and an INTERLEAVED one keeps its order", async () => {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 60 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        // The turn under test: think, start emitting the call, think AGAIN, finish the call. A model doing
        // this is ordinary; a format that cannot represent it is what this pins.
        fake.setScript([
            { tool: "wait", args: { ms: 10 }, emit: [
                { kind: "think", text: "the page looks like a form. " },
                { kind: "call" },
                { kind: "think", text: "wait — better to settle first. " },
                { kind: "call" },
            ] },
            { content: "Done." },
        ]);

        const page = await ext.context.newPage();
        const events = [];
        await collectDebug(page, events);
        await page.goto(site.url + "/");
        await waitForMl(page);

        const res = await page.evaluate(() => window.ml.agent("settle the page", { stream: true, maxSteps: 4 }));
        expect(res.summary).toContain("Done");

        // The marks ride the call's usage, which is where every other client-side measurement of a model call
        // lives (its wall clock, the load it waited through).
        const steps = events.filter((e) => e.kind === "agent-step" && e.usage?.genPhases?.length);
        expect(steps.length, "a streamed turn must report which channel it was on").toBeGreaterThan(0);
        const marks = steps[0].usage.genPhases;

        expect(marks.map((m) => m.kind)).toEqual(["think", "call", "think", "call"]);
        // Offsets from the call's own start, and monotonic: they are a sequence of transitions, not three
        // buckets that happen to be sorted.
        for (let i = 1; i < marks.length; i++) {
            expect(marks[i].atMs, `mark ${i} runs backwards`).toBeGreaterThanOrEqual(marks[i - 1].atMs);
        }
        expect(marks[0].atMs).toBeGreaterThanOrEqual(0);

        // …and the lane draws that as ONE block with the tool run on the end. Fed the events verbatim, because
        // WHICH record carries the usage is the thing being pinned: the loop emits the turn's usage on the
        // model's own record and the tool call as a separate one, so a derivation that reads `usage` off the
        // tool record finds nothing and silently drops the model's half of the block.
        const { eventsFrom } = await import("../../src/sidebar/model-stats.ts");
        const stepEvents = events.filter((e) => e.kind === "agent-step" && !e.pending)
            .map((e) => ({ step: e.step, seq: e.seq, ts: e.ts, tool: e.tool, toolMs: e.toolMs, usage: e.usage }));
        const [span] = eventsFrom([{
            hash: "h", model: "fake-model", createdTs: stepEvents[0].ts - 1, lastTs: stepEvents.at(-1).ts + 1,
            steps: stepEvents,
        }]).filter((e) => e.kind === "tool");
        // A real stream always opens with a stretch before the first chunk — prompt eval, queue, network.
        // That is the model's time but none of its channels, so it is `model`, and it is the honest leading
        // phase rather than an artefact to assert away.
        expect(span.phases[0].kind).toBe("model");
        expect(kindsOf(span.phases).slice(1)).toEqual(["think", "call", "think", "call", "tool"]);
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});

test("a NON-streamed turn reports no phases — the boundary is not observable, so none is invented", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setScript([{ reasoning: "thinking about it. ", content: "Done." }]);

        const page = await ext.context.newPage();
        const events = [];
        await collectDebug(page, events);
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.agent("answer", { maxSteps: 2 }));

        const withUsage = events.filter((e) => e.kind === "agent-step" && e.usage);
        expect(withUsage.length, "the run must still report its token usage").toBeGreaterThan(0);
        // The response is one object with one duration. We know how much text was thinking and how much was
        // the reply, but not WHEN it crossed over, and apportioning by length would be inventing a timestamp.
        for (const e of withUsage) expect(e.usage.genPhases, "a non-streamed call must not claim a split").toBeUndefined();
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});

test("a model call is visible WHILE it generates, not only once it has finished", async () => {
    // Paced hard: the turn takes several seconds, which is the window in which the timeline used to show
    // nothing at all and then back-date a finished block across memory it had already drawn.
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 80 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        const think = Array.from({ length: 40 }, (_, i) => `word-${i} `).join("");
        fake.setScript([{ emit: [{ kind: "think", text: think }, { kind: "answer", text: "Done." }], content: "Done." }]);

        const page = await ext.context.newPage();
        const events = [];
        await collectDebug(page, events);
        await page.goto(site.url + "/");
        await waitForMl(page);
        const started = Date.now();
        await page.evaluate(() => { window.__run = window.ml.agent("think out loud", { stream: true, maxSteps: 2 }); });

        // The turn-start event is the ONLY stamp for "the model started": the pending step START fires when a
        // TOOL is about to run, i.e. after the generation, and a turn that emits nothing but a tool call
        // produces no content deltas either.
        await expect.poll(() => events.filter((e) => e.kind === "agent-turn").length, { timeout: 15000 }).toBeGreaterThan(0);
        const first = events.find((e) => e.kind === "agent-turn");
        expect(Date.now() - started, "it must arrive while the call is still out, not with the result").toBeLessThan(15000);

        // …and it re-fires as the model crosses from thinking to answering, so a live bar gains its divider
        // mid-flight rather than at the end.
        await expect.poll(() => events.some((e) => e.kind === "agent-turn" && (e.phases || []).some((p) => p.kind === "answer")),
            { timeout: 15000 }).toBe(true);
        const phased = events.filter((e) => e.kind === "agent-turn" && e.phases?.length);
        expect(kindsOf(phased.at(-1).phases)).toEqual(["think", "answer"],
            "the MARKS are the channels only; the pre-first-token stretch becomes a phase when they are drawn");
        expect(first.ts).toBeLessThanOrEqual(phased.at(-1).ts);

        await page.evaluate(() => window.__run);
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});

/* --------------------------- the other wire format --------------------------- */
// The extension speaks two: OpenWebUI's OpenAI-shaped SSE and Ollama's native NDJSON. They differ in every
// detail this feature touches — thinking arrives on `message.thinking` rather than `reasoning_content`, tool
// calls come WHOLE in one chunk rather than fragmented by index, and the timings ride a final `done` object
// instead of not existing at all. Only the OpenAI route was ever exercised end to end, so a split that
// worked there could have been silently broken on the other for a long time.

/** Configure the extension against the fake's Ollama-native passthrough. */
const asOllama = (sw, fake) => configureExtension(sw, {
    chatUrl: fake.origin + "/ollama/api/chat", apiKey: "", apiFormat: "ollama",
    model: "fake-model", debugMode: "overlay",
});

test("ollama-native + streaming: the split works on the other wire shape too", async () => {
    const fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 40 });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await asOllama(ext.sw, fake);
        fake.setScript([
            { tool: "wait", args: { ms: 10 }, emit: [
                { kind: "think", text: "reading the page. " },
                { kind: "call" },
                { kind: "call" },   // Ollama resends the WHOLE call — this must not become two phases
            ] },
            { content: "Done." },
        ]);

        const page = await ext.context.newPage();
        const events = [];
        await collectDebug(page, events);
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.agent("settle the page", { stream: true, maxSteps: 4 }));

        const [withPhases] = events.filter((e) => e.kind === "agent-step" && e.usage?.genPhases?.length);
        expect(withPhases, "thinking arrives on message.thinking here, and must still be recognised").toBeTruthy();
        // A mark is appended on a CHANGE, so two identical whole-call chunks are one phase, not two.
        expect(withPhases.usage.genPhases.map((m) => m.kind)).toEqual(["think", "call"]);

        // …and this route reports its own timings, which the OpenAI one does not have at all.
        expect(withPhases.usage.evalMs).toBe(1200);
        expect(withPhases.usage.promptEvalMs).toBe(640);
        expect(withPhases.usage.loadMs).toBe(20);
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});

test("ollama-native without streaming: real timings, and still no invented split", async () => {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await asOllama(ext.sw, fake);
        fake.setScript([{ reasoning: "thinking. ", content: "Done." }]);

        const page = await ext.context.newPage();
        const events = [];
        await collectDebug(page, events);
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.agent("answer", { maxSteps: 2 }));

        const [u] = events.filter((e) => e.kind === "agent-step" && e.usage).map((e) => e.usage);
        // The three durations are the reason this combination matters: it is the ONLY one where the box
        // reports what the model itself spent, so "the model is slow" and "the box is slow" are separable.
        expect(u.evalMs).toBe(1200);
        expect(u.promptEvalMs).toBe(640);
        expect(u.genMs, "our own wall clock is stamped on every route").toBeGreaterThan(0);
        expect(u.genPhases, "one response object — the boundary is not observable here either").toBeUndefined();
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});

test("the OpenAI route reports no model timings at all — and reports that, rather than zeros", async () => {
    // The other half of the matrix, and the reason `genBasis` exists: on this route the only clock is OURS,
    // so a rate here includes the network and must say so.
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    try {
        await configureExtension(ext.sw, {
            chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay",
        });
        fake.setScript([{ content: "Done." }]);

        const page = await ext.context.newPage();
        const events = [];
        await collectDebug(page, events);
        await page.goto(site.url + "/");
        await waitForMl(page);
        await page.evaluate(() => window.ml.agent("answer", { maxSteps: 2 }));

        const [u] = events.filter((e) => e.kind === "agent-step" && e.usage).map((e) => e.usage);
        expect(u.evalMs).toBeUndefined();
        expect(u.promptEvalMs).toBeUndefined();
        expect(u.loadMs).toBeUndefined();
        expect(u.genMs).toBeGreaterThan(0);

        const { eventsFrom } = await import("../../src/sidebar/model-stats.ts");
        const [gen] = eventsFrom([{ hash: "h", model: "fake-model", turns: [{ ts: Date.now(), usage: u }] }]);
        expect(gen.cost.genBasis).toBe("wall", "the only clock is ours, so the rate includes the network");
        expect(gen.cost).not.toHaveProperty("promptEvalMs");
    } finally {
        await ext.context.close(); await site.stop(); await fake.stop();
    }
});
