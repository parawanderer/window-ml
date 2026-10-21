// cancel-states.spec.mjs — the composer's Stop pressed in EACH state a run streams through: thinking, writing the reply,
// writing a tool call, stalled mid-call, a read-only exec's output streaming, python_exec's output streaming, and an
// approval gate. Each state must end the same way: the run says it was cancelled, the model is asked nothing more, a
// half-written call never runs, nothing on screen is still live (no live call, no pending step, no caret, no clock
// still ticking), and output stops growing. Real extension, fake model, the real Stop button in the overlay sidebar.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, openRunInSidebar } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

test.describe.configure({ mode: "default" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fake, site, ext;
test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model", streamDelayMs: 120 });
    site = await startPageServer({});
    ext = await launchExtension();
    await configureExtension(ext.sw, { chatUrl: fake.origin + "/api/chat/completions", apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay" });
});
test.afterAll(async () => { await ext?.close(); fake?.stop?.(); site?.stop?.(); });

/** Start a streamed user run on a fresh page with `script`, and open it in the overlay sidebar. */
async function startRun(script, task, { psDelay = 0 } = {}) {
    fake.setScript(script);
    fake.setPsDelay(psDelay);
    const before = fake.calls().length;
    const page = await ext.context.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto(site.url + "/");
    await waitForMl(page);
    const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({ active: true, lastFocusedWindow: true })).find((t) => t.url?.startsWith(u))?.id
        ?? (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(u)).pop()?.id, site.url);
    await ext.sw.evaluate(([id, t]) => globalThis.__mlStartUserRunForTest(id, { task: t, stream: true, hud: "quiet", surface: "overlay" }), [tabId, task]);
    const frame = await openRunInSidebar(page, { task });
    return { page, frame, before };
}

/** Press the composer's Stop until the run says it was cancelled (the panel can re-render under the click). On a
 *  timeout the message is what the panel showed instead: whether Stop is still offered, and the end of the turn. */
async function pressStop(frame, { timeout = 20000 } = {}) {
    let seen = "";
    await expect.poll(async () => {
        const turn = await turnText(frame).catch(() => "");
        const stop = await frame.locator(".cbtn.cstop").count();
        if (/cancell?ed/i.test(turn) && !stop) return "cancelled";
        await frame.locator(".cbtn.cstop").click({ timeout: 1000 }).catch(() => {});
        seen = JSON.stringify({ stopShown: !!stop, calls: fake.calls().length, live: await liveLeft(frame).catch(() => null), turnEnd: turn.slice(-300) });
        return `not cancelled: ${seen}`;
    }, { timeout, message: "Stop took effect: the run says cancelled and the composer offers Send again" }).toBe("cancelled");
}

/** What is still LIVE in the transcript: each selector that should be gone once a run is over, with its count. */
const LIVE = [".live-call", ".live-answer", ".astep.pending", ".astep.awaiting", ".writing", ".streaming", ".pending-note", ".w-in"];
async function liveLeft(frame) {
    return frame.evaluate((sels) => Object.fromEntries(sels.map((s) => [s, document.querySelectorAll(s).length]).filter(([, n]) => n)), LIVE);
}

/** After Stop: nothing more is asked of the model, nothing is live, and the transcript stops changing. */
async function expectSettled(frame, before, { calls, label }) {
    await sleep(1500);
    const t1 = await frame.locator("body").textContent();
    const n1 = fake.calls().length - before;
    await sleep(2500);
    const t2 = await frame.locator("body").textContent();
    expect(fake.calls().length - before, `${label}: the model was asked nothing after Stop`).toBe(n1);
    expect(n1, `${label}: model calls in all`).toBe(calls);
    expect(await liveLeft(frame), `${label}: nothing on screen is still live`).toEqual({});
    expect(t2, `${label}: the transcript stopped changing (no clock, no output, no text still arriving)`).toBe(t1);
}

/** Open the running tool step, so its whole output is drawn and not only the folded preview line. */
async function openStep(frame) {
    const step = frame.locator(".astep.tool").last();
    await step.waitFor({ timeout: 20000 });
    if (!/\bopen\b/.test((await step.getAttribute("class")) || "")) await step.locator(".astep-head").first().click({ timeout: 2000 }).catch(() => {});
}

const turnText = (frame) => frame.evaluate(() => [...document.querySelectorAll(".astep, .msg, .aturn-prose")].map((e) => e.textContent).join("\n"));

// --- Stop while the model is streaming ---

test("Stop while the model is thinking ends the run cancelled, with no reply drawn and nothing still live", async () => {
    test.setTimeout(90_000);
    const { page, frame, before } = await startRun([
        { content: "TOO-LATE", emit: [{ kind: "think", text: "Weighing the page title against the heading" }, { kind: "pause", ms: 20000 }, { kind: "answer", text: "TOO-LATE" }] },
    ], "think then stop");
    await expect.poll(() => frame.locator("body").textContent(), { timeout: 15000 }).toContain("Thinking…");
    await pressStop(frame);
    await expectSettled(frame, before, { calls: 1, label: "thinking" });
    expect(await turnText(frame)).not.toContain("TOO-LATE");
    await page.close();
});

test("Stop while the reply is being written keeps what arrived, settled, and nothing after it", async () => {
    test.setTimeout(90_000);
    const { page, frame, before } = await startRun([
        { content: "The title says Dice lab TOO-LATE", emit: [{ kind: "answer", text: "The title says " }, { kind: "answer", text: "Dice lab" }, { kind: "pause", ms: 20000 }, { kind: "answer", text: " TOO-LATE" }] },
    ], "reply then stop");
    await expect.poll(() => frame.locator("body").textContent(), { timeout: 15000 }).toContain("Dice lab");
    await pressStop(frame);
    await expectSettled(frame, before, { calls: 1, label: "reply" });
    expect(await turnText(frame)).not.toContain("TOO-LATE");
    await page.close();
});

const SURVEY = [...Array.from({ length: 40 }, (_, i) => `// survey line ${i + 1} of the page title`), "document.title"].join("\n");

test("Stop while a tool call is being written: the half-written call never runs", async () => {
    test.setTimeout(90_000);
    const { page, frame, before } = await startRun([
        { tool: "exec", args: { js: SURVEY }, emit: Array.from({ length: 60 }, () => ({ kind: "call" })) },
        { content: "never reached" },
    ], "write a call then stop");
    await expect.poll(() => frame.locator(".live-call-code").count(), { timeout: 15000 }).toBeGreaterThan(0);
    await pressStop(frame);
    await expectSettled(frame, before, { calls: 1, label: "writing a call" });
    expect(await frame.locator(".astep.tool").count(), "no step: the call never ran").toBe(0);
    await page.close();
});

test("Stop while a tool call has stalled mid-write: the call never runs and the stall notice goes", async () => {
    test.setTimeout(90_000);
    const { page, frame, before } = await startRun([
        { tool: "exec", args: { js: SURVEY }, emit: [...Array.from({ length: 10 }, () => ({ kind: "call" })), { kind: "pause", ms: 30000 }, ...Array.from({ length: 10 }, () => ({ kind: "call" }))] },
        { content: "never reached" },
    ], "stall then stop");
    await expect.poll(() => frame.locator("body").textContent(), { timeout: 20000 }).toMatch(/no output for \d+s/);
    await pressStop(frame);
    await expectSettled(frame, before, { calls: 1, label: "stalled call" });
    expect(await frame.locator(".astep.tool").count(), "no step: the call never ran").toBe(0);
    expect(await frame.locator("body").textContent()).not.toMatch(/no output for \d+s/);
    await page.close();
});

// --- Stop while a tool runs ---

const CHECKS = Array.from({ length: 30 }, (_, i) => `part ${i + 1}`);
const SLOW_SURVEY = [`const checks = ${JSON.stringify(CHECKS)};`, "for (const c of checks) {", "    console.log('checked ' + c);", "    await ml.ps();", "}", "return document.title;"].join("\n");

test("Stop while a read-only exec streams its output: the output stops growing and the step is not left running", async () => {
    test.setTimeout(90_000);
    const { page, frame, before } = await startRun([{ tool: "exec", args: { js: SLOW_SURVEY } }, { content: "never reached" }], "survey then stop", { psDelay: 600 });
    await openStep(frame);
    await expect.poll(() => turnText(frame), { timeout: 20000 }).toContain("checked part 3");
    await pressStop(frame);
    await expectSettled(frame, before, { calls: 1, label: "exec output" });
    expect(await turnText(frame)).not.toContain("checked part 30");
    await page.close();
});

const PY = ["import time", "for i in range(60):", "    print(f'tick {i}')", "    time.sleep(0.3)"].join("\n");

test("Stop while python_exec streams its output: the output stops growing and the step is not left running", async () => {
    test.setTimeout(120_000);
    const { page, frame, before } = await startRun([{ tool: "python_exec", args: { code: PY, mode: "readonly" } }, { content: "never reached" }], "python then stop");
    // Stock Pyodide asks before it runs: approve that gate, as a person would.
    await expect.poll(async () => {
        await frame.locator(".appr-btn.yes").first().click({ timeout: 500 }).catch(() => {});
        return turnText(frame);
    }, { timeout: 60000 }).toContain("tick 3");
    await pressStop(frame);
    await expectSettled(frame, before, { calls: 1, label: "python output" });
    expect(await turnText(frame)).not.toContain("tick 59");
    await page.close();
});

test("Stop at an approval gate: the call never runs, the gate is closed, and the step says cancelled", async () => {
    test.setTimeout(90_000);
    const { page, frame, before } = await startRun([{ tool: "exec", args: { js: "document.title = 'RAN'; 1" } }, { content: "never reached" }], "gate then stop");
    await expect.poll(async () => ((await frame.locator("body").textContent()) || "").toLowerCase(), { timeout: 20000 }).toContain("waiting for your approval");
    await pressStop(frame);
    await expectSettled(frame, before, { calls: 1, label: "approval" });
    expect(await page.title(), "the gated write never ran").not.toBe("RAN");
    expect(await ext.sw.evaluate(() => (globalThis.__mlApprovals?.list?.() || []).length), "no gate left open").toBe(0);
    expect(await frame.locator(".appr-btn.yes").count(), "no Approve button left to press").toBe(0);
    await page.close();
});
