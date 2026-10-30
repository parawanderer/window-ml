// redteam-person-word.test.mjs — the person's word under `crossOrigin: false` (#1358): what must NOT be able to say it
// (src/sw/sw-run-host.ts `personAllowsNav`/`sendTool`, src/agent/run-delegation.ts `runDelegatedTool`, src/content.ts;
// docs/spec/POLICIES.md, "The person's word under `crossOrigin: false`").
//
// The ruled sentence is exact: `navigateFacts(url)` of THIS navigate is allowed by an approved policy of origin
// `proposed` or `person`, never a builtin, judged per navigate. The lane's own rows (tests/person-word-navigate.test.mjs)
// cover the positive form, per-navigate judging, and the no-word cases (none, a card-origin row, another consumer's row,
// a deny that beats it, the word passed as an argument). What is pinned here is the other direction of the same three
// words in that sentence:
//   (1) the NAVIGATE's facts, not some other fetch of the same URL: a row that allows an uncredentialed fetch of the
//       destination is not the word for navigating to it;
//   (2) an approved POLICY, not an answer to a card: the person's yes on the navigate's own card stores no policy, and
//       must not be read as one afterwards;
//   (3) an approved POLICY at all: the same-origin navigate a run may make with no policy and no card must not be read as
//       the word. Measured, not assumed: `free()` does not cover `navigateFacts`, so the judge decides NOTHING there
//       (`decision: undefined`, no `by`) and `personAllowsNav`'s `!!j.by` is what refuses it; the `j.by !== "builtin"`
//       clause beside it is defence in depth this row cannot reach.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SITE = "https://site.example/page";
const OTHER = "https://b.example/docs";
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };

/** A saved global policy, as the policy page or an approved proposal stores one. */
const row = (id, consumer, effect, source, origin = "person") => ({ id, scope: "global", consumer, effect, source, label: id, origin, created: 1760000000000 });
/** An allow over the NAVIGATE's facts: what the word is. */
const ALLOW_NAV = row("allow-nav", "fetch", "allow", '(c) => c.host === "b.example" && c.interactive', "person");
/** An allow over a plain FETCH of the same URL — uncredentialed, not rendered: the same URL, not this navigate. */
const ALLOW_PLAIN_FETCH_ONLY = row("plain-only", "fetch", "allow", '(c) => c.host === "b.example" && !c.interactive', "person");
const ASK_NAV = row("ask-nav", "fetch", "ask", '(c) => c.host === "b.example" && c.interactive', "person");
/** The person's own allow for the run's own page: the control for the free tier, since `free()` would allow it too. */
const ALLOW_SITE = row("allow-site", "fetch", "allow", '(c) => c.host === "site.example" && c.interactive', "person");

/**
 * A page-built run on tab 7 with `crossOrigin: false` whose model calls `calls` in turn. Returns the navigate messages
 * the page was sent (`{ url, word }`) and the cards the person was shown.
 */
async function run(calls, { policies = [] } = {}) {
    const fromPage = { tab: { id: 7, url: SITE }, url: SITE, origin: "https://site.example", frameId: 0 };
    const tab = { id: 7, windowId: 3, active: true, url: SITE, title: "Site" };
    let turns = 0, docN = 1, bg;
    const navs = [], gates = [];
    const answered = new Set();
    const sender = () => ({ tab: { id: 7, url: tab.url }, url: tab.url, origin: new URL(tab.url).origin, frameId: 0, documentId: `doc-${docN}` });
    const ready = async (url) => {
        const r = plain(await bg.send({ type: "CONTENT_READY" }, sender()) ?? null);
        for (const a of r?.adopt ?? []) void bg.send({ type: "RUN_READOPTED", payload: { runId: a.runId, pageInfo: `You are on ${url}` } }, sender());
    };
    bg = loadBackground({
        config, openTabs: [tab], siteGate: true, local: { ml_policies_global: policies, ml_site_always: ["https://site.example", "https://b.example"] },
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const next = calls[turns++];
            return next
                ? jsonResponse({ choices: [{ message: { content: null, tool_calls: [{ id: `c${turns}`, type: "function", function: { name: next.name, arguments: JSON.stringify(next.args) } }] } }] })
                : jsonResponse({ choices: [{ message: { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => {
            if (msg.type === "ADOPT_RUN_NOW") return { pageInfo: `You are on ${tab.url}` };
            const ev = msg.type === "ML_DEBUG_TO_PAGE" ? msg.event : null;
            if (ev?.awaitingApproval && !answered.has(`${ev.id}:${ev.seq}`)) {
                answered.add(`${ev.id}:${ev.seq}`);
                gates.push(ev.tool);
                void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, decision: true } });
            }
            for (const a of ev?.asks ?? []) {
                if (a.state !== "pending" || answered.has(a.id)) continue;
                answered.add(a.id);
                void bg.send({ type: "SET_APPROVAL", payload: { runId: ev.id, seq: ev.seq, ask: a.id, decision: true } });
            }
            if (msg.type !== "RUN_TOOL_IN_PAGE") return undefined;
            const p = plain(msg.payload);
            if (p.finish) return { result: "" };
            if (p.precheck) return { result: "", precheckFailed: false };
            if (p.renderOnly || p.readonlyTry || p.geometry) return { result: "" };
            if (p.name === "navigate") {
                const to = p.args.url;
                navs.push({ url: to, word: p.crossOriginWord === true });
                tab.url = to; docN++;
                bg.commit(7, { documentId: `doc-${docN}`, url: to });
                setTimeout(() => void ready(to), 5);
                return { result: `Navigating to ${to}` };
            }
            return { result: `ran ${p.name}` };
        },
    });
    void bg.send({ type: "START_RUN", payload: {
        runId: "pagerun-word-rt", task: "do it", systemPrompt: "S",
        tools: [{ name: "navigate", description: "go", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: true, capabilities: [] }],
        model: "m", think: null, maxSteps: 8, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
        crossOrigin: false, approvalRouting: "ui", pageOrigin: "https://site.example",
        rebuild: { toolNames: ["navigate"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin: false },
    } }, fromPage);
    for (let i = 0; i < 600 && turns <= calls.length; i++) await sleep(1);
    await sleep(60);
    return { calls: navs, gates };
}

// --- (1) the NAVIGATE's facts ---

test("RED TEAM: an allow over a plain fetch of the destination is not the word for navigating to it", T, async () => {
    // Same URL, different facts: `navigateFacts` says credentials, rendered and interactive. A row written on the plain
    // fetch (uncredentialed, not interactive) allows something else, so the navigate carries no word.
    const plainOnly = await run([{ name: "navigate", args: { url: OTHER } }], { policies: [ALLOW_PLAIN_FETCH_ONLY] });
    assert.deepEqual(plainOnly.calls.map((n) => n.word), [false], "a plain-fetch allow was read as the word");
    // The control the same setup needs: the row over the navigate's own facts does carry it.
    const nav = await run([{ name: "navigate", args: { url: OTHER } }], { policies: [ALLOW_NAV] });
    assert.deepEqual(nav.calls.map((n) => n.word), [true], "the navigate's own facts did not carry the word");
    assert.deepEqual(nav.gates, [], "an allow row needs no card");
});

// --- (2) an approved POLICY, not an answer to a card ---

test("RED TEAM: the person's yes on the navigate's own card is not the word (no policy was approved)", T, async () => {
    const r = await run([{ name: "navigate", args: { url: OTHER } }], { policies: [ASK_NAV] });
    assert.deepEqual(r.gates, ["navigate"], "positive control: the person was asked about this navigate");
    assert.deepEqual(r.calls.map((n) => n.word), [false], "an answered card was read as an approved policy");
});

// --- (3) an approved POLICY at all ---

test("RED TEAM: a navigate no policy decided carries no word; the person's own row for it does", T, async () => {
    // A run with NO policy at all still navigates to its own page, card-free (measured: the judge decides nothing there,
    // and the run's own page is not gated). That path must not be read as the word.
    const bare = await run([{ name: "navigate", args: { url: SITE } }], { policies: [] });
    assert.deepEqual(bare.calls.map((n) => n.url), [SITE], "positive control: the navigate reached the page, so the word could have ridden it");
    assert.deepEqual(bare.gates, [], "and nothing was asked: no card's answer is being mistaken for the word here");
    assert.deepEqual(bare.calls.map((n) => n.word), [false], "a navigate no policy decided was read as the person's word");
    // The same call, with the person's own row for that host, carries it — so the row above cannot pass by the word never
    // being set on this path at all.
    const allowed = await run([{ name: "navigate", args: { url: SITE } }], { policies: [ALLOW_SITE] });
    assert.deepEqual(allowed.calls.map((n) => n.word), [true], "the person's own row for the run's page did not carry the word");
    assert.deepEqual(allowed.gates, [], "an allow row needs no card");
});
