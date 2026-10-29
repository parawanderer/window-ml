// policy-worked-example.spec.mjs — the worked example of docs/spec/POLICIES.md as an acceptance test: one proposal of four rules,
// approved once, then a run that goes anywhere on origin B, clicks only where the rules allow, and is refused or held at the edge.
//
// Two local origins (A: the page the run starts on; B: the demo site, tests/e2e/fixtures/demo-site/server.mjs, whose server-side
// log says what HAPPENED). The model is scripted (fake-llm); the person's answers are given through the SW-side approvals channel.

import { test, expect } from "@playwright/test";
import { launchExtension, configureExtension, waitForMl, watchRunEvents } from "./harness.mjs";
import { startFakeLlm } from "./fake-llm.mjs";
import { startPageServer } from "../../examples/cross-page/serve.mjs";
import { startDemoSite } from "./fixtures/demo-site/server.mjs";

let ext, fake, siteA, siteB;

test.describe.configure({ mode: "default" });
test.beforeAll(async () => {
    fake = await startFakeLlm({ model: "fake-model" });
    siteA = await startPageServer({});
    siteB = await startDemoSite();
    ext = await launchExtension();
    await configureExtension(ext.sw, { chatUrl: fake.url, apiKey: "", apiFormat: "openai", model: "fake-model", modelFilter: "", debugMode: "off", autoApproveReadonly: false });
});
test.afterAll(async () => {
    await ext?.close();
    await fake?.stop();
    await siteA?.stop();
    await siteB?.stop();
});

/** The four rules as the model sends them, over origin B. */
const rules = (B) => [
    { effect: "allow", when: `(c) => c.url.startsWith("${B}/")`, label: "Go anywhere on the demo site" },
    { effect: "allow", consumer: "act", when: `(c) => c.action === "click" && c.url.startsWith("${B}/user/")`, label: "Click on /user/" },
    { effect: "deny", when: `(c) => c.url.startsWith("${B}/admin/")`, label: "Never /admin/" },
    { effect: "deny", consumer: "act", when: `(c) => c.action === "click" && c.url.startsWith("${B}/user/approvals") && c.element.name !== "Approve This Draft"`, label: "Only Approve This Draft on the approvals page" },
];

/**
 * Start a run on `page`'s tab as the person does, and answer its cards: `decide(gate)` is true to approve (false refuses).
 * Returns the cards shown, the run's events and a way to wait for it to end.
 */
async function run(page, task, decide = () => true) {
    const events = [], cards = [];
    const watcher = await watchRunEvents(ext, page, (e) => events.push(e));
    const tabId = await ext.sw.evaluate((u) => chrome.tabs.query({}).then((ts) => ts.find((t) => t.url === u)?.id), page.url());
    await ext.sw.evaluate((t) => { void globalThis.__mlStartUserRunForTest(t, { task: "do the task", surface: "hud" }, { approvalRouting: "both" }); }, tabId);
    let on = true;
    const loop = (async () => {
        while (on) {
            try {
                for (const g of await ext.sw.evaluate(() => globalThis.__mlApprovals.list())) {
                    if (cards.some((c) => c.key === g.key)) continue;
                    cards.push(g);
                    await ext.sw.evaluate(([k, d]) => globalThis.__mlApprovals.resolve(k, d), [g.key, !!decide(g)]);
                }
            } catch { /* worker restarting */ }
            await new Promise((r) => setTimeout(r, 20));
        }
    })();
    // A nested ask (the arrival card) is pending only until the run ends, which can be before a poll sees it; the step
    // events carry every ask raised, so the cards are completed from them once the run is over.
    const fromEvents = () => {
        for (const e of events) for (const a of e.asks ?? []) if (!cards.some((c) => c.askId === a.id)) cards.push({ key: a.id, askId: a.id, tool: a.kind });
    };
    return {
        events, cards,
        done: async (calls) => { await expect.poll(() => fake.calls().length, { timeout: 40000 }).toBeGreaterThanOrEqual(calls); await new Promise((r) => setTimeout(r, 500)); on = false; await loop; await watcher.close(); fromEvents(); },
    };
}

/** The run's steps as the person saw them: the last event of each step. */
const stepsOf = (events) => {
    const by = new Map();
    for (const e of events) if (e.kind === "agent-step" && e.tool) by.set(e.seq, { ...by.get(e.seq), ...e });
    return [...by.values()].map((e) => ({ tool: e.tool, approval: e.approval ?? null, result: String(e.result ?? "") }));
};

/** A run with the four rules approved first, then `calls`; returns what it did. */
async function worked(calls, decide) {
    const B = siteB.url;
    const page = await ext.context.newPage();
    await page.goto(siteA.url + "/");
    await waitForMl(page);
    siteB.reset();
    const script = [{ tool: "propose_policy", args: { rules: rules(B) } }, ...calls(B), { content: "done" }];
    fake.setScript(script);
    const r = await run(page, "work on the demo site", decide);
    await r.done(script.length);
    const out = { cards: r.cards, steps: stepsOf(r.events), events: r.events, log: siteB.log(), requests: siteB.requests() };
    await page.close();
    return out;
}

const cardsOf = (o) => o.cards.map((c) => c.tool);
const only = (o, tool) => o.steps.filter((x) => x.tool === tool);

test("one card of four rules; navigate and a click under /user/ run with no card; an anchor to /admin/ is refused before the click; a button that sets location there is blocked on arrival", async () => {
    const o = await worked((B) => [
        { tool: "navigate", args: { url: B + "/" } },
        { tool: "navigate", args: { url: B + "/user/x" } },
        { tool: "click", args: { selector: "#admin-link" } },
        { tool: "click", args: { selector: "#open-admin" } },
        { tool: "scroll", args: {} },
    ]);
    const card = o.events.find((e) => e.kind === "agent-step" && e.tool === "propose_policy" && e.awaitingApproval);
    expect(card.renderIn.text).toMatch(/Rule 1 of 4: allow[\s\S]*Rule 2 of 4: allow[\s\S]*Rule 3 of 4: deny[\s\S]*Rule 4 of 4: deny/);
    for (const n of [1, 2, 3, 4]) expect(card.renderIn.note).toContain(`Rule ${n} of 4.`);
    expect(card.renderIn.note, "an act rule's breadth says so when the run has made no click").toContain("no click or type to measure");
    const [nav1, nav2] = only(o, "navigate");
    expect(nav1.approval, "navigate to B runs on the first row, with no card").toBe("consented");
    expect(nav2.approval).toBe("consented");
    const [anchor, button] = only(o, "click");
    expect(anchor.approval).toBe("denied");
    expect(anchor.result).toContain('the policy "Never /admin/" denies: the click was not made');
    expect(button.approval, "the click on the button is allowed by the second row").toBe("consented");
    expect(button.result).toContain('which the policy "Never /admin/" denies: no tool runs on this page');
    expect(only(o, "scroll")[0].approval, "nothing runs on the held page").toBeNull();
    expect(cardsOf(o), "the only cards: the proposal, and the arrival").toEqual(["propose_policy", "arrival-denied"]);
    expect(o.log, "the anchor made no request; the button's script landed on /admin/ once").toEqual(["arrival"]);
    expect(o.requests.filter((r) => r.startsWith("/admin/"))).toEqual(["/admin/"]);
});

test("fetch_url of /admin/ is denied by the third row and the server is never asked", async () => {
    const o = await worked((B) => [{ tool: "fetch_url", args: { url: B + "/admin/secret" } }]);
    expect(only(o, "fetch_url")[0].result).toContain('Refused by the policy "Never /admin/"');
    expect(o.requests.some((r) => r.startsWith("/admin/"))).toBe(false);
    expect(cardsOf(o)).toEqual(["propose_policy"]);
});

test("on the approvals page only Approve This Draft is clicked: Delete and Publish are refused before the click with the fourth row named", async () => {
    const o = await worked((B) => [
        { tool: "navigate", args: { url: B + "/user/approvals" } },
        { tool: "click", args: { selector: "#delete" } },
        { tool: "click", args: { selector: "#publish" } },
        { tool: "click", args: { selector: "#approve" } },
    ]);
    const [del, pub, approve] = only(o, "click");
    for (const x of [del, pub]) {
        expect(x.approval).toBe("denied");
        expect(x.result).toContain('Refused by the policy "Only Approve This Draft on the approvals page", without asking');
    }
    expect(approve.approval, "the one button falls through the deny to the allow").toBe("consented");
    expect(o.log, "the server saw one approve, no delete and no publish").toEqual(["approve"]);
    expect(cardsOf(o)).toEqual(["propose_policy"]);
});

test("on the redirecting variant the approve lands in the log and the arrival at /admin/ is blocked: the rules compose", async () => {
    const o = await worked((B) => [
        { tool: "navigate", args: { url: B + "/user/approvals?redirect=1" } },
        { tool: "click", args: { selector: "#approve" } },
        { tool: "scroll", args: {} },
    ]);
    expect(only(o, "click")[0].approval, "act allowed the click").toBe("consented");
    expect(only(o, "click")[0].result).toContain("Never /admin/");
    expect(o.log).toEqual(["approve", "arrival"]);
    expect(only(o, "scroll")[0].approval, "fetch judged where the tab went").toBeNull();
    expect(cardsOf(o)).toEqual(["propose_policy", "arrival-denied"]);
});

test("type on B/other asks, since no row allows it; refused on the card it types nothing", async () => {
    const o = await worked((B) => [
        { tool: "navigate", args: { url: B + "/other" } },
        { tool: "type", args: { selector: "#q", text: "hello" } },
    ], (g) => g.tool !== "type");
    expect(cardsOf(o)).toEqual(["propose_policy", "type"]);
    expect(only(o, "type")[0].approval).toBe("denied");
});
