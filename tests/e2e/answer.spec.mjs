// answer.spec.mjs — the curated ANSWER of a run the person starts (the worker builds it), end to end in a real browser:
// what the `answer` tool and `ml.answer` put in it, what the model is echoed, and what the person is handed when the turn
// ends. Written against the page-side answer set before it moved to the worker (docs/spec/SITE_ACCESS.md, slice 2
// part 2), so the same assertions hold across the move.
import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, watchRunEvents } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";

test.describe.configure({ mode: "default" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run turns of a worker-built run on the demo site's first page, every gate approved through the approvals channel.
 * @param {Array<{ task: string, script: any[] }>} turns each turn's task and the fake model's script for it
 * @returns {Promise<{ results: any[], toolResults: string[][] }>} each turn's agent-result, and the tool results the
 *   model was sent in each turn's last call
 */
async function answerRun(turns, { listen = false } = {}) {
    const fake = await startFakeLlm({ model: "fake-model" });
    const site = await startPageServer({});
    const ext = await launchExtension();
    const events = [];
    let stop = false;
    try {
        await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", debugMode: "overlay", autoApproveReadonly: true });
        const page = await ext.context.newPage();
        // The page's own script, listening to every window message, as any script on it can.
        if (listen) await page.addInitScript(() => { window.__heard = []; window.addEventListener("message", (e) => { try { window.__heard.push(JSON.stringify(e.data)); } catch { /* not cloneable */ } }); });
        await page.goto(site.url + "/");
        await waitForMl(page);
        const watch = await watchRunEvents(ext, page, (ev) => events.push(ev));
        // Rule on every gate as it opens, the way an approver outside the browser does (run-once.mjs).
        const approver = (async () => {
            while (!stop) {
                const gates = await ext.sw.evaluate(() => globalThis.__mlApprovals?.list?.() ?? []).catch(() => []);
                for (const g of gates) await ext.sw.evaluate(({ key }) => globalThis.__mlApprovals.resolve(key, true), { key: g.key }).catch(() => {});
                await sleep(100);
            }
        })();
        const tabId = await ext.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, site.url);
        const results = [], toolResults = [];
        let hash;
        for (const [i, turn] of turns.entries()) {
            const before = fake.calls().length;
            fake.setScript(turn.script);
            if (i === 0) ({ hash } = await ext.sw.evaluate(({ tabId, req }) => globalThis.__mlStartUserRunForTest(tabId, req, { approvalRouting: "both" }), { tabId, req: { task: turn.task, surface: "hud", hud: "quiet" } }));
            else await ext.sw.evaluate(({ h, t }) => globalThis.__mlUserRunActionForTest(h, "send", { text: t, surface: "hud" }), { h: hash, t: turn.task });
            for (let k = 0; k < 300 && events.filter((e) => e.kind === "agent-result").length <= i; k++) await sleep(100);
            results.push(events.filter((e) => e.kind === "agent-result")[i]);
            const last = fake.calls().slice(before).at(-1);
            toolResults.push((last?.messages ?? []).slice(-turn.script.length * 2).filter((m) => m.role === "tool").map((m) => String(m.content)));
        }
        await watch.close();
        const heard = listen ? await page.evaluate(() => window.__heard.join("\n")).catch(() => "") : "";
        return { results, toolResults, heard };
    } finally {
        stop = true;
        await ext.close();
        fake.stop?.();
        site.stop?.();
    }
}

// --- the answer tool ---

test("text and an output pointer the model designates are what the person is handed, and each call echoes the set", async () => {
    const { results, toolResults } = await answerRun([{ task: "answer it", script: [
        { tool: "exec", args: { js: "return 6 * 7" } },
        { tool: "answer", args: { text: "The answer is 42" } },
        { tool: "answer", args: { text: "@tool:exec", note: "the computed value" } },
        { content: "Done." },
    ] }]);
    expect(results[0], "the turn ended").toBeTruthy();
    expect(results[0].answer).toContain("The answer is 42");
    expect(results[0].answer).toMatch(/@tool:/);
    expect(toolResults[0][1]).toMatch(/added text\. Answer set \(1\):\n {2}\[0\] text: The answer is 42/);
    expect(toolResults[0][2]).toMatch(/Answer set \(2\):[\s\S]*\[1\] token: @tool:/);
});

test("an element the model designates by selector is in the set, with its preview, and in the answer", async () => {
    const { results, toolResults } = await answerRun([{ task: "find the title", script: [
        { tool: "answer", args: { selector: "h1", note: "the page title" } },
        { content: "Found it." },
    ] }]);
    expect(toolResults[0][0]).toMatch(/added 1 element\(s\) — the page title\. Answer set \(1\):\n {2}\[0\] element: /);
    expect(results[0].answer ?? "").toMatch(/the page title|h1/i);
});

test("remove and clear curate the set: what is removed is not handed over, and clear with text replaces it", async () => {
    const { results, toolResults } = await answerRun([{ task: "curate", script: [
        { tool: "answer", args: { text: "first" } },
        { tool: "answer", args: { text: "second" } },
        { tool: "answer", args: { remove: 0 } },
        { tool: "answer", args: { clear: true, text: "only this" } },
        { content: "Done." },
    ] }]);
    expect(toolResults[0][2]).toMatch(/removed 1\. Answer set \(1\):\n {2}\[0\] text: second/);
    expect(toolResults[0][3]).toMatch(/cleared; added text\. Answer set \(1\):\n {2}\[0\] text: only this/);
    expect(results[0].answer).toContain("only this");
    expect(results[0].answer).not.toContain("first");
    expect(results[0].answer).not.toContain("second");
});

// --- ml.answer from exec ---

test("an approved exec adds text and an element through ml.answer, reads its length at once, and the tool sees both", async () => {
    const { results, toolResults } = await answerRun([{ task: "designate from a script", script: [
        { tool: "answer", args: { text: "before" } },
        { tool: "exec", args: { js: "document.title = 'x'; ml.answer.add('from exec'); ml.answer.add(document.querySelector('h1')); return ml.answer.length" } },
        { tool: "answer", args: {} },
        { content: "Done." },
    ] }]);
    expect(toolResults[0][1]).toMatch(/\b3\b/);
    expect(toolResults[0][2]).toMatch(/Answer set \(3\):\n {2}\[0\] text: before\n {2}\[1\] text: from exec\n {2}\[2\] element: /);
    expect(results[0].answer).toContain("from exec");
});

test("an approved exec removes by index and clears through ml.answer, and the set it leaves is what the tool sees", async () => {
    const { toolResults } = await answerRun([{ task: "curate from a script", script: [
        { tool: "answer", args: { text: "a" } },
        { tool: "answer", args: { text: "b" } },
        { tool: "exec", args: { js: "document.title = 'x'; const r = ml.answer.remove(0); const n = ml.answer.length; ml.answer.add('c'); return [r, n, ml.answer.length]" } },
        { tool: "answer", args: {} },
        { content: "Done." },
    ] }]);
    expect(toolResults[0][2]).toMatch(/\[1,1,2\]/);
    expect(toolResults[0][3]).toMatch(/Answer set \(2\):\n {2}\[0\] text: b\n {2}\[1\] text: c/);
});

test("a read-only survey that adds to ml.answer counts as the run's", async () => {
    const { results, toolResults } = await answerRun([{ task: "survey", script: [
        { tool: "exec", args: { js: "ml.answer.add('from a survey'); return ml.answer.length" } },
        { content: "Done." },
    ] }]);
    expect(toolResults[0][0]).toMatch(/\b1\b/);
    expect(results[0].answer).toContain("from a survey");
});

// --- across turns ---

test("a follow-up turn starts with an empty set: the first turn's answer is not handed over again", async () => {
    const { results } = await answerRun([
        { task: "first", script: [{ tool: "answer", args: { text: "TURN ONE" } }, { content: "Done." }] },
        { task: "second", script: [{ content: "Nothing to add." }] },
    ]);
    expect(results[0].answer).toContain("TURN ONE");
    expect(results[1].answer ?? "").not.toContain("TURN ONE");
});

// --- what the page may not see (site access, slice 2 part 2) ---

test("answer text the model writes never reaches the page's window, and the person still gets it", async () => {
    const SECRET = "SECRET-FROM-ANOTHER-SITE-5531";
    const { results, heard, toolResults } = await answerRun([{ task: "answer privately", script: [
        { tool: "answer", args: { text: SECRET } },
        { tool: "answer", args: { remove: 0 } },
        { tool: "answer", args: { text: `${SECRET} again`, note: "x" } },
        // An approved exec in the page's world is given the set's shape: it may count the text, never read it.
        { tool: "exec", args: { js: "document.title = 'x'; return [ml.answer.length, JSON.stringify(ml.answer.dump())]" } },
        { content: "Done." },
    ] }], { listen: true });
    expect(results[0].answer, "positive control: the person is handed it").toContain(`${SECRET} again`);
    expect(heard.length, "positive control: the page heard the run's other traffic").toBeGreaterThan(0);
    expect(heard).not.toContain(SECRET);
    expect(toolResults[0][3], "the exec counted the hidden text").toMatch(/\[1,.*kept by the worker/);
});

test("text in the answer outlives a navigation in the middle of the turn", async () => {
    const { results } = await answerRun([{ task: "go on", script: [
        { tool: "answer", args: { text: "KEPT ACROSS PAGES" } },
        { tool: "navigate", args: { url: "/step2" } },
        { tool: "answer", args: { text: "on step 2" } },
        { content: "Done." },
    ] }]);
    expect(results[0].answer).toContain("on step 2");
    expect(results[0].answer).toContain("KEPT ACROSS PAGES");
});
