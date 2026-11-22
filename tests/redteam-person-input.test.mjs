// redteam-person-input.test.mjs — ruling 39 PR 1's red-team pass (SECRET_HANDLES.md, "What the person sends is
// scrubbed too"): what a HOSTILE PAGE can still get out of the input scrub.
//
// The lane's rows (tests/turn-scrub.test.mjs, tests/turn-scrub-paths.test.mjs) hold each entry point against a page's
// START_RUN and steer. These hold the ways a page reaches PAST those rows: the per-call option on a steer it does still
// send, the setting named inside a run's own start payload or config, and every page-started type offered the key —
// with a person's turn read AFTER each attempt, so "the setting is unchanged" is measured rather than inferred.
//
// WHAT THIS FILE CANNOT ROW, with the reason: the shape detector (vendor prefixes, PEM, JWT) is not built in this PR, so
// there is no shape to miss yet; the per-value "send as is" digests are PR 2's, and a page cannot carry one already
// (the exemption is accepted only from an extension-page sender, which the lane's rows pin).

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), apiKey: "sk-test" }), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} },
    },
};
const { _setRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { PAGE_STARTED_TYPES } = await import("../src/page-relay.ts");

const T = { timeout: 20000 };
const NAME = "PLUG_PASSWORD";
const VALUE = "REALSECRET-4b1d-77";
const MARK = `[REDACTED:${NAME}]`;
const REG = { ml_secret_registry: [{ name: NAME, value: VALUE }] };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const TAB = { tab: { id: 7, url: SITE.url }, url: SITE.url };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (v) => JSON.parse(JSON.stringify(v));
const usersOf = (call) => call.body.messages.filter((m) => m.role === "user").map((m) => String(m.content));

/** A worker with the registry, a model that answers "done", and the page on tab 7. */
function world({ hold = false, replies = [] } = {}) {
    const gates = [];
    const bg = loadBackground({
        config, openTabs: [SITE], local: REG,
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const n = bg.calls.filter((c) => c.url.includes("/chat/completions")).length - 1;
            if (hold) await new Promise((r) => gates.push(r));
            const tool = replies[n];
            return jsonResponse({ choices: [{ message: tool ? { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: tool, arguments: "{}" } }] } : { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" ? { result: "ok" } : undefined),
    });
    const chats = () => bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const waitChats = async (n) => { for (let i = 0; i < 600 && chats().length < n; i++) await flush(2); assert.ok(chats().length >= n, `model call ${n} was made (${chats().length})`); };
    /** Everything the worker emitted or stored that a person or the page could read back. */
    const everything = () => JSON.stringify([bg.tabMessages, { ...bg.localStore, ml_secret_registry: undefined }]);
    return { bg, gates, chats, waitChats, everything };
}
const pageStart = (extra = {}) => ({ type: "START_RUN", payload: {
    runId: "pagerun1", task: `use ${VALUE} to sign in`, systemPrompt: "sys", tools: [], model: "m", think: null,
    maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "off", ...extra,
} });
/** A person's own run through the extension's path, whose task must be scrubbed: the worker's setting is what turns that. */
async function personTurnScrubbed(bg) {
    const { hash } = await bg.context.__mlStartUserRunForTest(7, { task: `my password is ${VALUE}`, surface: "hud" });
    for (let i = 0; i < 600 && !bg.calls.some((c) => JSON.stringify(c.body).includes("my password is")); i++) await flush(2);
    const call = bg.calls.find((c) => JSON.stringify(c.body).includes("my password is"));
    assert.ok(call, `the person's run ${hash} was never sent`);
    return usersOf(call).join("\n");
}

// --- the per-call option, on a steer the page does still send ---

test("RED TEAM: a page's INJECT_MESSAGE that passes scrubInput: false is still scrubbed, bare", T, async () => {
    const w = world({ hold: true, replies: ["chat_metadata"] });
    const first = w.bg.send(pageStart({ task: "watch" }), TAB);
    await w.waitChats(1);
    // The worker honours `off` only for an extension page's call; the site's inject goes to pageInject, which has no such
    // option. The row pins that the router did not gain one.
    const r = await w.bg.send({ type: "INJECT_MESSAGE", payload: { runId: "pagerun1", text: `now ${VALUE}`, sayId: "sy1", scrubInput: false } }, TAB);
    assert.equal(r.data, true, JSON.stringify(r));
    w.gates[0]();
    await w.waitChats(2);
    w.gates[1]?.();
    await first;
    const steered = usersOf(w.chats()[1]).at(-1);
    assert.ok(steered.endsWith("now [REDACTED]") && !steered.includes(NAME), `the page turned its own steer off: ${steered}`);
    assert.ok(!w.everything().includes(VALUE));
});

// --- the setting named inside the page's own start ---

test("RED TEAM: a page's START_RUN cannot turn the scrub off by naming the setting in its payload or its config", T, async () => {
    const w = world();
    // `scrubInput: false` is the lane's row; these are the two shapes it does not send: the setting's own name at the
    // top, and a run `config` naming it — the per-run config is how the popup's URL/key overrides travel, so it is the
    // one place a setting-like word could be honoured by accident.
    const r = await w.bg.send(pageStart({ scrubInput: false, scrubPersonInput: false, config: { scrubPersonInput: false } }), TAB);
    assert.ok(!r.error, r.error);
    await w.waitChats(1);
    const user = usersOf(w.chats()[0]).at(-1);
    assert.match(user, /use \[REDACTED\] to sign in/, user);
    assert.ok(!user.includes(NAME) && !w.everything().includes(VALUE));
    // And the worker's own setting is unchanged: a person's turn after the page's attempt is still scrubbed, and its
    // note names the entry (the person's form, not the page's bare one).
    const person = await personTurnScrubbed(w.bg);
    assert.ok(person.includes(MARK) && !person.includes(VALUE), person);
});

// --- every page-started type, offered the key ---

test("RED TEAM: no page-started type writes scrubPersonInput, and a person's turn is scrubbed after every one of them", T, async () => {
    const w = world();
    const payload = { scrubPersonInput: false, config: { scrubPersonInput: false }, key: "scrubPersonInput", value: false, edit: "add" };
    let reached = 0;
    for (const type of PAGE_STARTED_TYPES) {
        // A type the router does not answer for a page tab sender is a refusal by silence and needs no assertion of
        // its own; what must never happen is the setting moving, measured below through its only observable.
        try { await w.bg.send({ type, payload: plain(payload) }, TAB); } catch { /* a type that throws refuses */ }
        reached++;
    }
    assert.ok(reached > 10, `only ${reached} page-started types enumerated`);
    const person = await personTurnScrubbed(w.bg);
    assert.ok(person.includes(MARK) && !person.includes(VALUE), `a page-started type turned the setting off: ${person}`);
});
