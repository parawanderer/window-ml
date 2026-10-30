// person-word-navigate.test.mjs — an approved policy is the person's word for a navigate under `crossOrigin: false`.
// docs/spec/POLICIES.md, "The person's word under `crossOrigin: false`": exactly "`navigateFacts(url)` of THIS navigate is
// allowed by an approved policy of origin `proposed` or `person`, never a builtin, judged per navigate", and no `allow` on
// another consumer's facts counts. The worker says so on the message it sends the page (`crossOriginWord`), which the
// page's navigate tool honours for that one call; nothing the model passes as an argument can say it.

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
const ELSE = "https://c.example/else";
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };

/** A saved global policy over `consumer`, as the policy page or an approved proposal stores one. */
const row = (id, consumer, effect, source, origin = "person") => ({ id, scope: "global", consumer, effect, source, label: id, origin, created: 1760000000000 });
const ALLOW_B = (origin) => row("allow-b", "fetch", "allow", '(c) => c.host === "b.example" && c.interactive', origin);

/**
 * A page-built run on tab 7 with `crossOrigin: false` whose model calls `calls` in turn. Returns the navigate messages the
 * page was sent (`{ url, word }`) and the gates the person was shown.
 */
async function run(calls, { policies = [], crossOrigin = false } = {}) {
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
        config, openTabs: [tab], siteGate: true, local: { ml_policies_global: policies, ml_site_always: ["https://site.example", "https://b.example", "https://c.example"] },
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
            if (p.precheck || p.renderOnly || p.readonlyTry || p.geometry) return { result: "" };
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
    const done = bg.send({ type: "START_RUN", payload: {
        runId: "pagerun-word", task: "do it", systemPrompt: "S",
        tools: [{ name: "navigate", description: "go", parameters: { type: "object", properties: { url: { type: "string" } } }, requiresApproval: true, capabilities: [] }],
        model: "m", think: null, maxSteps: 8, autoApprovePython: false, autoApproveReadonly: false, surface: "off",
        crossOrigin, approvalRouting: "ui", pageOrigin: "https://site.example",
        rebuild: { toolNames: ["navigate"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 1000, pierceClosed: false, cdp: false, crossOrigin },
    } }, fromPage);
    const raced = await Promise.race([done.then(() => true), sleep(15000).then(() => false)]);
    if (!raced) throw new Error("page-built run did not settle within 15s");
    return { navs, gates };
}

// --- the word: an approved policy of the person's allows THIS navigate ---

test("a policy of origin person or proposed that allows this navigate lets a run without crossOrigin go: the page is told, and no card is shown", T, async () => {
    for (const origin of ["person", "proposed"]) {
        const r = await run([{ name: "navigate", args: { url: OTHER } }], { policies: [ALLOW_B(origin)] });
        assert.deepEqual(r.navs, [{ url: OTHER, word: true }], origin);
        assert.deepEqual(r.gates, [], `${origin}: an allow row needs no card`);
    }
});

test("judged per navigate: a destination the allow row does not cover carries no word, though the run's earlier navigate did", T, async () => {
    const r = await run([{ name: "navigate", args: { url: OTHER } }, { name: "navigate", args: { url: ELSE } }], { policies: [ALLOW_B("person")] });
    assert.deepEqual(r.navs, [{ url: OTHER, word: true }, { url: ELSE, word: false }]);
});

// --- what is not the word ---

test("against it: no policy, an allow row of origin card, and an allow on another consumer's facts carry no word", T, async () => {
    const act = row("act-b", "act", "allow", '(c) => c.url.startsWith("https://b.example/")');
    for (const [name, policies] of [["no policy", []], ["a card-origin allow", [ALLOW_B("card")]], ["an allow on act", [act]]]) {
        const r = await run([{ name: "navigate", args: { url: OTHER } }], { policies });
        assert.deepEqual(r.navs.map((n) => n.word), r.navs.map(() => false), name);
    }
});

test("RED TEAM: a deny row beats the word, and a model that passes the word as an argument gains nothing", T, async () => {
    const deny = row("deny-b", "fetch", "deny", '(c) => c.host === "b.example"');
    const denied = await run([{ name: "navigate", args: { url: OTHER } }], { policies: [ALLOW_B("person"), deny] });
    assert.deepEqual(denied.navs, [], "the deny refuses the navigate before it reaches the page");
    const forged = await run([{ name: "navigate", args: { url: OTHER, crossOriginWord: true } }]);
    assert.deepEqual(forged.navs.map((n) => n.word), [false], "an argument is not the word");
});
