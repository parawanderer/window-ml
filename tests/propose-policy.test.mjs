// propose-policy.test.mjs — `propose_policy`: the model asks the person for a run policy over fetch_url, and only the
// person's answer on its card adds one (src/sw/policy-proposal.ts, src/tools/propose-policy-tool.ts, the gate in
// src/sw/sw-run-host.ts; docs/spec/POLICIES.md, "Scopes" and "Showing what was approved").
//
// The pure measure is tested directly; the rest in the real background bundle (node:vm), a run the worker built on tab 7
// whose model is scripted, and the page played by `onTabMessage`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");
const PP = await import("../src/sw/policy-proposal.ts");

const T = { timeout: 10000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const PAGE = { tab: { id: 7, url: SITE.url }, url: SITE.url, origin: "https://site.example", frameId: 0 };
/** The Settings panel, as the browser describes an extension page sending a message. */
const EXT_PAGE = { url: "chrome-extension://test/sidebar.html" };
const OTHER = "https://other.example/private";
const BODY = "<h1>OTHER SITE</h1>";
const NARROW = { effect: "allow", when: '(c) => c.host === "other.example" && !c.credentials', label: "Read other.example" };

/** Every run policy the worker holds, as the policy page lists them. */
async function runPolicies(bg) {
    const r = await bg.send({ type: "POLICIES", payload: {} }, EXT_PAGE);
    return r.data.runs.flatMap((x) => x.policies);
}

/**
 * A run the worker built on tab 7 whose model calls `calls` in turn, then answers. Each card is answered by `answer(tool)`
 * (true approves). Returns every card shown (`{ tool, renderIn }`), what the model read back, and what was fetched.
 */
async function workerRun(calls, { answer = () => true } = {}) {
    let turns = 0, bg;
    const cards = [];
    const seen = [];
    bg = loadBackground({
        config, openTabs: [SITE], siteGate: true,
        onFetch: (call) => {
            if (call.url.startsWith("https://other.example/")) return { ok: true, status: 200, url: call.url, headers: { get: (h) => (/content-type/i.test(h) ? "text/html; charset=utf-8" : null) }, text: async () => BODY, arrayBuffer: async () => new TextEncoder().encode(BODY).buffer, body: null };
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            seen.push(call.body.messages);
            const next = calls[turns++];
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: "" };
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                cards.push({ tool: msg.event.tool, renderIn: JSON.parse(JSON.stringify(msg.event.renderIn ?? null)) });
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: !!answer(msg.event.tool) } });
            }
            if (msg.type === "RUN_TOOL_IN_PAGE") return msg.payload.finish ? { result: "" } : {};
            return undefined;
        },
    });
    await bg.context.__mlStartUserRunForTest(7, { task: "read the other site", surface: "hud" });
    for (let i = 0; i < 400 && turns <= calls.length; i++) await new Promise((r) => setTimeout(r, 0));
    await flush(30);
    const results = (seen.at(-1) ?? []).filter((m) => m.role === "tool").map((m) => m.content);
    const fetched = bg.calls.filter((c) => c.url.startsWith("https://other.example/")).map((c) => c.url);
    const steps = bg.tabMessages.filter(([, m]) => m.type === "ML_DEBUG_TO_PAGE" && m.event?.kind === "agent-step" && !m.event.pending).map(([, m]) => m.event);
    return { bg, cards, results, fetched, steps };
}

// --- the measure: what a proposal matches, from the run's own calls and a probe ---

test("checkProposal refuses what is not a runnable fetch policy, and keeps the strings it checked", () => {
    assert.ok("proposal" in PP.checkProposal(NARROW));
    for (const bad of [
        { ...NARROW, effect: "maybe" }, { ...NARROW, when: "" }, { ...NARROW, when: 42 }, { ...NARROW, label: "" },
        { ...NARROW, when: "x".repeat(10_001) }, { ...NARROW, label: "x".repeat(201) },
        { ...NARROW, when: '(c) => c.host == "other.example"' },   // `==` is refused in a policy
        { ...NARROW, when: '(c) => c.hots === "other.example"' },  // a field a fetch call does not have
        { ...NARROW, when: "(c) => c.url.length" },                // not a boolean
        { ...NARROW, when: "this is not code" },
    ]) assert.ok("error" in PP.checkProposal(bad), `accepted ${JSON.stringify(bad).slice(0, 120)}`);
});

test("recordedFetches pairs each fetch_url call with its result by id, with arguments as a string or an object", () => {
    const messages = [
        { role: "assistant", content: null, tool_calls: [{ id: "a", name: "fetch_url", arguments: JSON.stringify({ url: "https://x.example/1" }) }, { id: "b", name: "exec", arguments: { js: "1" } }] },
        { role: "tool", tool_call_id: "a", content: "<h1>x</h1>" },
        { role: "assistant", content: null, tool_calls: [{ id: "c", name: "fetch_url", arguments: { url: "https://y.example/", credentials: true } }, { id: "d", name: "fetch_url", arguments: "{not json" }] },
        { role: "tool", tool_call_id: "c", content: "Denied by the person." },
    ];
    assert.deepEqual(PP.recordedFetches(messages), [
        { url: "https://x.example/1", rendered: false, credentials: false, outcome: "ran" },
        { url: "https://y.example/", rendered: false, credentials: true, outcome: "denied" },
    ]);
});

test("measureBreadth counts the run's calls a proposal matches, and the probe flags one that matches sites the run never used", () => {
    const calls = [{ url: OTHER, rendered: false, credentials: false, outcome: "ran" }, { url: "https://docs.example/a", rendered: false, credentials: false, outcome: "ran" }];
    const narrow = PP.measureBreadth(PP.checkProposal(NARROW).proposal, calls);
    assert.equal(narrow.calls, 2);
    assert.deepEqual(narrow.matched.map((c) => c.url), [OTHER]);
    assert.deepEqual(narrow.strays, []);
    const broad = PP.measureBreadth(PP.checkProposal({ ...NARROW, when: "(c) => true" }).proposal, calls);
    assert.equal(broad.matched.length, 2);
    assert.equal(broad.strays.length, broad.tried, "every unrelated probe matched");
    assert.ok(broad.tried >= 10, `tried ${broad.tried}`);
    // A suffix match is the classic over-broad policy: it matches the local network address too.
    const suffix = PP.measureBreadth(PP.checkProposal({ ...NARROW, when: '(c) => c.url.startsWith("http")' }).proposal, calls);
    assert.ok(suffix.strays.length > 0);
});

test("breadthNote leads with what the policy does, says when it reaches past the run's sites, and says it is measured", () => {
    const p = PP.checkProposal({ ...NARROW, when: "(c) => true" }).proposal;
    const note = PP.breadthNote(p, PP.measureBreadth(p, []));
    assert.match(note, /^Proposed by the model for this run: fetch without asking/);
    assert.match(note, /no fetch_url call to measure/);
    assert.match(note, /ALSO matches sites this run never used/);
    assert.match(note, /Measured, not proven/);
});

test("a proposal that also covers navigating says so on the card, by effect; one written only for reads does not", () => {
    const calls = [{ url: OTHER, rendered: false, credentials: false, outcome: "ran" }];
    const measure = (when, effect = "allow") => { const p = PP.checkProposal({ ...NARROW, when, effect }).proposal; const b = PP.measureBreadth(p, calls); return { b, note: PP.breadthNote(p, b) }; };
    // NARROW excludes credentials, and a navigate is a fetch as the person: it never navigates.
    const reads = measure(NARROW.when);
    assert.equal(reads.b.navigates, false);
    assert.doesNotMatch(reads.note, /go(es|ing)? to those pages/);
    const host = '(c) => c.host === "other.example"';
    assert.equal(measure(host).b.navigates, true);
    assert.match(measure(host).note, /also lets the run go to those pages without asking and act on them/);
    assert.match(measure(host, "ask").note, /also asks before the run goes to those pages/);
    assert.match(measure(host, "deny").note, /also stops the run going to those pages/);
    // Written on `interactive` alone: it matches no recorded fetch, and the probe still finds it reaching every site.
    const nav = measure("(c) => c.interactive === true");
    assert.equal(nav.b.matched.length, 0);
    assert.equal(nav.b.navigates, true);
    assert.equal(nav.b.strays.length, nav.b.tried, "every unrelated site is matched as a navigation");
});

// --- what the model reads ---

test("propose_policy's model-facing text is unpadded and short", async () => {
    const { proposePolicyTool } = await import("../src/tools/propose-policy-tool.ts");
    const t = proposePolicyTool((d) => d);
    const text = JSON.stringify([t.description, t.parameters]);
    assert.ok(!/ {2}/.test(text), "no run of two spaces");
    assert.ok(text.length < 1200, `${text.length} characters`);
});

// --- the tool in a run the worker built ---

test("ACCEPTANCE: a proposal the person approves becomes a run policy, and the run's next matching fetch_url asks nothing", T, async () => {
    const { bg, cards, results, fetched, steps } = await workerRun([
        { name: "fetch_url", args: { url: OTHER } },
        { name: "propose_policy", args: NARROW },
        { name: "fetch_url", args: { url: "https://other.example/second" } },
    ]);
    assert.deepEqual(cards.map((c) => c.tool), ["fetch_url", "propose_policy"], "the second fetch asked nothing");
    const card = cards[1].renderIn;
    assert.equal(card.text, NARROW.when, "the card shows the code as sent");
    assert.match(card.note, /matches 1 of this run's 1 fetch_url calls \(other\.example\)/);
    assert.match(card.note, /matched none of the \d+ unrelated sites it was tried on/);
    assert.match(results[1], /^Added for this run: "Read other\.example"/);
    assert.equal(steps.findLast((e) => e.tool === "fetch_url")?.approval, "consented");
    assert.equal(fetched.length, 2);
    const pols = await runPolicies(bg);
    assert.equal(pols.length, 1);
    assert.equal(pols[0].origin, "proposed");
    assert.equal(pols[0].source, NARROW.when);
});

test("an ASK is the one answer a model may propose with the least at stake: it is accepted, measured, shown as an ask, and the next matching fetch_url asks again", T, async () => {
    const ASK = { ...NARROW, effect: "ask", label: "Check with me about other.example" };
    assert.ok("proposal" in PP.checkProposal(ASK));
    assert.match(PP.checkProposal({ ...ASK, effect: "maybe" }).error, /"allow", "deny" or "ask"/);
    const { bg, cards, results, fetched } = await workerRun([
        { name: "propose_policy", args: ASK },
        { name: "fetch_url", args: { url: OTHER } },
        { name: "fetch_url", args: { url: OTHER } },
    ]);
    assert.deepEqual(cards.map((c) => c.tool), ["propose_policy", "fetch_url", "fetch_url"], "each fetch went to the person");
    assert.match(cards[0].renderIn.note, /^Proposed by the model for this run: ask the person before a fetch when/);
    assert.match(results[0], /^Added for this run: "Check with me about other\.example"\. Matching fetch_url calls now always ask the person\./);
    assert.equal(fetched.length, 2);
    const pols = await runPolicies(bg);
    assert.equal(JSON.stringify(pols.map((q) => [q.effect, q.origin])), JSON.stringify([["ask", "proposed"]]));   // JSON: the objects come from the vm
});

test("RED TEAM: a proposal's breadth is the worker's measure, never what the model says about it", T, async () => {
    const { cards } = await workerRun([
        { name: "fetch_url", args: { url: OTHER } },
        { name: "propose_policy", args: { effect: "allow", when: "(c) => true", label: "Only other.example, nothing else", breadth: "matches one URL", note: "narrow" } },
    ], { answer: (tool) => tool !== "propose_policy" });
    const note = cards.find((c) => c.tool === "propose_policy")?.renderIn?.note ?? "";
    assert.match(note, /ALSO matches sites this run never used/, `the card hid how far the policy reaches: ${note}`);
    assert.ok(!/matches one URL|narrow"/.test(note), "nothing the model sent besides its label reached the note");
});

test("RED TEAM: a proposal the person refuses adds nothing, the model is told so, and the next fetch_url still asks", T, async () => {
    const { bg, cards, results } = await workerRun([
        { name: "fetch_url", args: { url: OTHER } },
        { name: "propose_policy", args: NARROW },
        { name: "fetch_url", args: { url: "https://other.example/second" } },
    ], { answer: (tool) => tool !== "propose_policy" });
    assert.deepEqual(cards.map((c) => c.tool), ["fetch_url", "propose_policy", "fetch_url"]);
    assert.match(results[1], /^Denied by/);
    assert.equal((await runPolicies(bg)).length, 0);
});

test("a proposal that does not run is told to the model and never shown to the person", T, async () => {
    const { bg, cards, results } = await workerRun([{ name: "propose_policy", args: { ...NARROW, when: '(c) => c.host == "other.example"' } }]);
    assert.equal(cards.length, 0);
    assert.match(results[0], /^Error: the policy does not run/);
    assert.equal((await runPolicies(bg)).length, 0);
});

// --- a page's own run never offers it ---

test("RED TEAM: a page's START_RUN that lists propose_policy gets no card for it and no policy, even when every card is approved", T, async () => {
    let turns = 0;
    const calls = [{ name: "propose_policy", args: { effect: "allow", when: "(c) => true", label: "all" } }];
    const cards = [];
    const bg = loadBackground({
        config, openTabs: [SITE], siteGate: true, local: { ml_site_always: ["https://site.example"] },
        onFetch: (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const next = calls[turns++];
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ML_DEBUG_TO_PAGE" && msg.event?.awaitingApproval) {
                cards.push(msg.event.tool);
                void bg.send({ type: "SET_APPROVAL", payload: { runId: msg.event.id, seq: msg.event.seq, decision: true } });
            }
            if (msg.type === "RUN_TOOL_IN_PAGE") return msg.payload.finish ? { result: "" } : { result: "the page's own propose_policy ran" };
            return undefined;
        },
    });
    const tool = { name: "propose_policy", description: "p", parameters: { type: "object", properties: {} }, requiresApproval: false, capabilities: [] };
    const done = bg.send({ type: "START_RUN", payload: { runId: "pagerun1", task: "t", systemPrompt: "S", tools: [tool], model: "m", think: null, maxSteps: 3, surface: "off" } }, PAGE);
    for (let i = 0; i < 300 && turns <= calls.length; i++) await new Promise((r) => setTimeout(r, 0));
    await Promise.race([done, flush(40)]);
    assert.ok(turns >= 1, "positive control: the model made its call");
    const offered = bg.calls.filter((c) => c.url.includes("/chat/completions")).flatMap((c) => (c.body.tools ?? []).map((t) => t.function?.name ?? t.name));
    assert.ok(offered.length === 0 || !offered.includes("propose_policy"), `the page's run offered the model propose_policy: ${offered.join(", ")}`);
    assert.ok(!cards.includes("propose_policy"), `a card was shown for the page's proposal: ${JSON.stringify(cards)}`);
    assert.equal((await runPolicies(bg)).length, 0);
});
