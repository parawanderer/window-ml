// scan-turn-paths.test.mjs — "send as is" through each sender that may or may not exempt (ruling 39, PR 2;
// SECRET_HANDLES.md, "Per value"): the router's SCAN_TURN answers an extension sender only; the person's own surfaces
// (a run the worker builds, a later message to it, an extension frame's steer, this browser's chat page) send a value
// whose token they carry as is and mark it by name; a page, and a hub device's command, have the field ignored and the
// turn scrubbed. The token rules themselves are tests/scan-turn.test.mjs.
//
// The run paths run in the real background bundle (tests/helpers.js `loadBackground`), as tests/turn-scrub-paths.test.mjs
// does; the chat page's chat runs the source's sw-chat.ts, and the commands the source's session-commands.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { jsonResponse, loadBackground } = require("./helpers");

globalThis.chrome = {
    runtime: { id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), apiKey: "sk-test" }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} },
    },
};
const VALUE = "REALSECRET-4b1d-77";
const OTHER = "OTHERSECRET-9c2e-11";
const NAME = "PLUG_PASSWORD";
const MARK = `[REDACTED:${NAME}]`;
const OTHER_MARK = "[REDACTED:ROUTER_PIN]";
const ENTRIES = [{ name: NAME, value: VALUE }, { name: "ROUTER_PIN", value: OTHER }];

const { _setRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { forTurn, scanTurn } = await import("../src/sw/sw-scrub.ts");
const { backgroundChats, configureBackgroundChats, forgetBackgroundChat, sendBackgroundChat, startBackgroundChat } = await import("../src/sw/sw-chat.ts");
const { createCommandHandler, commandAsIs } = await import("../src/session/session-commands.ts");
const { SessionIndex } = await import("../src/session/session-index.ts");
_setRegistryForTest(ENTRIES);

const T = { timeout: 15000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-test", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off" };
const SITE = { id: 7, url: "https://site.example/page", title: "Site" };
const TAB = { tab: { id: 7, url: SITE.url }, url: SITE.url };
const EXT = { id: "test", url: "chrome-extension://test/sidebar.html", origin: "chrome-extension://test" };
/** An extension frame inside the site's tab (the HUD's card): an extension sender with the tab set. */
const FRAME = { id: "test", tab: { id: 7, url: SITE.url }, url: "chrome-extension://test/card.html", origin: "chrome-extension://test" };
const flush = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const plain = (v) => JSON.parse(JSON.stringify(v));
const fanned = (bg, kind) => bg.tabMessages.map(([, m]) => m).filter((m) => m.type === "ML_DEBUG_TO_PAGE" && m.event.kind === kind).map((m) => plain(m.event));
const usersOf = (call) => call.body.messages.filter((m) => m.role === "user").map((m) => String(m.content));

/** A worker with both values registered, a model that answers `replies` (a tool name, or "done"), held when `hold`. */
function world({ hold = false, replies = [] } = {}) {
    const gates = [];
    const bg = loadBackground({
        config, openTabs: [SITE], local: { ml_secret_registry: ENTRIES },
        onFetch: async (call) => {
            if (!call.url.includes("/chat/completions")) return jsonResponse({});
            const n = bg.calls.filter((c) => c.url.includes("/chat/completions")).length - 1;
            if (hold) await new Promise((r) => gates.push(r));
            const reply = replies[n];
            return jsonResponse({ choices: [{ message: reply ? { content: null, tool_calls: [{ id: `c${n}`, type: "function", function: { name: reply, arguments: "{}" } }] } : { content: "done" } }] });
        },
        onTabMessage: async (_t, msg) => (msg.type === "ADOPT_RUN_NOW" ? { pageInfo: "" } : msg.type === "RUN_TOOL_IN_PAGE" && msg.payload.finish ? { result: "" } : msg.type === "RUN_TOOL_IN_PAGE" ? { result: "ok" } : undefined),
    });
    const chats = () => bg.calls.filter((c) => c.url.includes("/chat/completions"));
    const waitChats = async (n) => { for (let i = 0; i < 400 && chats().length < n; i++) await flush(2); assert.ok(chats().length >= n, `model call ${n} was made (${chats().length})`); };
    /** The token this worker's scan gives VALUE, asked as the composer asks. */
    const token = async () => {
        const r = await bg.send({ type: "SCAN_TURN", payload: { texts: [`x ${VALUE}`] } }, EXT);
        assert.ok(r.data, JSON.stringify(r));
        return r.data.spans[0][0].token;
    };
    const everything = () => JSON.stringify([bg.tabMessages, { ...bg.localStore, ml_secret_registry: undefined }]);
    return { bg, gates, chats, waitChats, token, everything };
}

// --- the router: SCAN_TURN answers an extension sender only ---

test("SCAN_TURN from a content script or a page is refused the same whether the text holds a value or not", T, async () => {
    const w = world();
    for (const sender of [TAB, { tab: { id: 7, url: SITE.url }, url: SITE.url, origin: "https://site.example" }]) {
        const hit = await w.bg.send({ type: "SCAN_TURN", payload: { texts: [VALUE] } }, sender);
        const miss = await w.bg.send({ type: "SCAN_TURN", payload: { texts: ["nothing"] } }, sender);
        assert.deepEqual(plain(hit), { error: "refused" });
        assert.deepEqual(plain(miss), plain(hit), "the refusal does not differ by the text");
    }
    const r = await w.bg.send({ type: "SCAN_TURN", payload: { texts: [`pw ${VALUE}`] } }, EXT);
    assert.deepEqual(plain(r.data.spans[0].map((s) => [s.start, s.end, s.name])), [[3, 3 + VALUE.length, NAME]]);
    assert.ok(!JSON.stringify(r).includes(VALUE));
});

// --- the person's own surfaces: the token's value is sent as is and marked by name ---

test("a run the person starts with a token: the model reads that value, the other is still redacted, the display names it, and no token is kept", T, async () => {
    const w = world();
    const tok = await w.token();
    await w.bg.context.__mlStartUserRunForTest(7, { task: `use ${VALUE} and ${OTHER}`, surface: "hud", asIs: [tok] });
    await flush(20);
    const user = usersOf(w.chats()[0]).at(-1);
    assert.ok(user.includes(`use ${VALUE} and ${OTHER_MARK}`), user);
    const [start] = fanned(w.bg, "agent");
    assert.deepEqual(start.display.asIs, [NAME], JSON.stringify(start.display));
    // AT REST: the value sent as is is what the model read, so the stored run and its events hold it, marked by name.
    assert.ok(w.everything().includes(VALUE), "the stored turn holds the value the person sent as is");
    assert.ok(!w.everything().includes(OTHER), "and never the other");
    assert.ok(!w.everything().includes(tok), "no token is stored or emitted");
});

test("a later message from the person's composer (USER_RUN_ACTION through the shell) with a token sends that value as is", T, async () => {
    const w = world();
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "first", surface: "hud" });
    await flush(30);
    const tok = await w.token();
    const r = await w.bg.send({ type: "USER_RUN_ACTION", payload: { hash, action: "send", text: `try ${VALUE} or ${OTHER}`, surface: "hud", asIs: [tok] } }, TAB);
    assert.equal(r.data, "turn");
    await w.waitChats(2);
    await flush(20);
    assert.ok(usersOf(w.chats()[1]).at(-1).startsWith(`try ${VALUE} or ${OTHER_MARK}`), usersOf(w.chats()[1]).at(-1));
    const say = fanned(w.bg, "agent-say").at(-1);
    assert.deepEqual(say.display?.asIs, [NAME], JSON.stringify(say));
    assert.ok(!w.everything().includes(tok));
});

test("a steer into a running run with a token (USER_RUN_ACTION) sends that value as is", T, async () => {
    const w = world({ hold: true, replies: ["chat_metadata"] });
    const { hash } = await w.bg.context.__mlStartUserRunForTest(7, { task: "watch", surface: "hud" });
    await w.waitChats(1);
    const tok = await w.token();
    assert.equal(await w.bg.context.__mlUserRunActionForTest(hash, "send", { text: `now ${VALUE}`, asIs: [tok] }, { surface: "hud" }), "steer");
    w.gates[0]();
    await w.waitChats(2);
    w.gates[1]?.();
    assert.ok(usersOf(w.chats()[1]).at(-1).startsWith(`now ${VALUE}`), usersOf(w.chats()[1]).at(-1));
});

// --- a page: the field is accepted as a shape and ignored ---

const pageStart = (extra = {}) => ({ type: "START_RUN", payload: {
    runId: "pagerun1", task: `use ${VALUE} to sign in`, systemPrompt: "sys", tools: [], model: "m", think: null,
    maxSteps: 3, autoApprovePython: false, autoApproveReadonly: false, surface: "off", ...extra,
} });

test("a page's START_RUN carrying a token the person's scan gave gets the bare [REDACTED]", T, async () => {
    const w = world();
    const tok = await w.token();
    const r = await w.bg.send(pageStart({ asIs: [tok] }), TAB);
    assert.ok(!r.error, r.error);
    await flush(20);
    assert.match(usersOf(w.chats()[0]).at(-1), /use \[REDACTED\] to sign in$/);
    assert.ok(!w.chats().some((c) => JSON.stringify(c.body).includes(VALUE)));
});

test("a page's steer carrying a token is scrubbed bare; an extension frame's steer with it sends the value as is", T, async () => {
    const w = world({ hold: true, replies: ["chat_metadata", "chat_metadata"] });
    const tok = await w.token();
    const first = w.bg.send(pageStart({ task: "watch" }), TAB);
    await w.waitChats(1);
    const page = await w.bg.send({ type: "INJECT_MESSAGE", payload: { runId: "pagerun1", text: `page ${VALUE}`, sayId: "sy1", asIs: [tok] } }, TAB);
    assert.equal(page.data, true, JSON.stringify(page));
    const frame = await w.bg.send({ type: "INJECT_MESSAGE", payload: { runId: "pagerun1", text: `mine ${VALUE}`, sayId: "sy2", asIs: [tok] } }, FRAME);
    assert.equal(frame.data, true, JSON.stringify(frame));
    w.gates[0]();
    await w.waitChats(2);
    for (const g of w.gates.slice(1)) g();
    await flush(20);
    for (const g of w.gates.slice(1)) g();
    await first;
    const said = w.chats().flatMap(usersOf).join("\n");
    assert.ok(said.includes("page [REDACTED]"), said);
    assert.ok(said.includes(`mine ${VALUE}`), said);
});

// --- the chat page's commands: this browser's exempt, a hub device's never ---

test("a session command's asIs is passed on from this browser and dropped from a hub device", T, async () => {
    assert.deepEqual(commandAsIs(["a".repeat(32)], { via: "this browser" }), ["a".repeat(32)]);
    assert.equal(commandAsIs(["a".repeat(32)], { via: "hub" }), undefined);
    assert.equal(commandAsIs("not a list", { via: "this browser" }), undefined);
    const index = new SessionIndex({ runtime: "local", spawn: "w1" });
    const calls = [];
    const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
    const run = createCommandHandler({
        runtime: "local", index, startChat: rec("startChat", Promise.resolve("beef0001")), sendChat: rec("sendChat", Promise.resolve("turn")),
        steer: rec("steer", true), toPage: rec("toPage", Promise.resolve("turn")), keepSession: rec("keepSession"),
        startAgent: rec("startAgent", Promise.resolve({ outcome: "started", hash: "ab120001" })), hostsChat: (h) => h === "cccc0003",
        getTab: async () => ({ tabId: 7, url: SITE.url, title: "S", active: true, windowId: 1 }), listTabs: async () => [], now: () => 1,
    });
    const ev = (hash, kind) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, task: "t", model: "m", maxSteps: 3, config: null });
    index.ingest(ev("aaaa0001", "agent"), { tabId: 7, trusted: true });
    index.ingest({ ...ev("cccc0003", "chat"), request: { messages: [] } }, { trusted: true });
    const asIs = ["f".repeat(32)];
    for (const [from, want] of [[{ via: "this browser" }, asIs], [{ via: "hub" }, undefined]]) {
        calls.length = 0;
        await run({ type: "chat.start", runtime: "local", text: "hi", asIs }, from);
        await run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: 7 }, asIs }, from);
        await run({ type: "session.send", session: { runtime: "local", hash: "aaaa0001" }, text: "steer", asIs }, from);
        await run({ type: "session.send", session: { runtime: "local", hash: "cccc0003" }, text: "next", asIs }, from);
        const got = calls.map(([n, ...a]) => [n, n === "startChat" ? a[0].asIs : n === "startAgent" ? a[1].asIs : n === "steer" ? a[3] : n === "sendChat" ? a[5] : n === "toPage" ? a[2].asIs : undefined]);
        for (const [n, v] of got) if (n !== "keepSession") assert.deepEqual(v, want, `${n} from ${from.via}: ${JSON.stringify(got)}`);
        for (const n of ["startChat", "startAgent", "steer", "sendChat"]) assert.ok(got.some(([m]) => m === n), `${n} was reached: ${JSON.stringify(got)}`);
    }
});

/** The worker's chats over the source modules, with the scrub the worker passes them (sw-sessions.ts). */
function chatWorld() {
    const events = [], stored = new Map(), requests = [];
    configureBackgroundChats({
        emit: (e) => events.push(plain(e)),
        call: async (req) => { requests.push(plain(req)); return { content: "ok", model: "m1" }; },
        load: async (hash) => stored.get(hash) ?? null,
        save: async (hash, session) => { stored.set(hash, plain(session)); },
        now: () => 1000,
        images: async () => ({ route: "model" }),
        read: async () => "",
        hold: async () => ({ key: "row" }),
        release: () => {},
        scrub: (asIs) => forTurn(asIs ? { asIs } : {}),
    });
    for (const hash of backgroundChats()) forgetBackgroundChat(hash);
    const done = async (n) => { for (let i = 0; i < 200 && events.filter((e) => e.kind === "chat-result").length < n; i++) await new Promise((r) => setTimeout(r, 5)); };
    return { events, stored, requests, done };
}

test("the chat page's chat with a token: the value is sent as is, marked by name, kept on the next turn, and stored with no token", T, async () => {
    const c = chatWorld();
    const tok = (await scanTurn([VALUE])).spans[0][0].token;
    const hash = await startBackgroundChat({ text: `pw ${VALUE} pin ${OTHER}`, asIs: [tok] });
    await c.done(1);
    assert.ok(c.requests[0].messages.at(-1).content.startsWith(`pw ${VALUE} pin ${OTHER_MARK}`), c.requests[0].messages.at(-1).content);
    const start = c.events.find((e) => e.kind === "chat");
    assert.deepEqual(start.display.asIs, [NAME]);
    const record = c.stored.get(hash);
    assert.equal(record.scrubbedFrom, 0);
    assert.ok(JSON.stringify(record).includes(VALUE), "the stored chat holds what the model read");
    assert.ok(!JSON.stringify([record, c.events]).includes(tok), "no token at rest or in an event");
    assert.equal(await sendBackgroundChat(hash, `again ${VALUE}`), "turn");
    await c.done(2);
    const second = c.requests[1].messages.filter((m) => m.role === "user").map((m) => m.content);
    assert.ok(second[0].startsWith(`pw ${VALUE}`), "the earlier turn sent as is stays as it was read");
    assert.ok(second[1].startsWith(`again ${MARK}`), "a new turn with no token is scrubbed");
});

test("UPGRADE: a chat stored with no scrubbedFrom has its old turns scrubbed, and a turn sent as is after it stays", T, async () => {
    const c = chatWorld();
    c.stored.set("oldchat9", { hash: "oldchat9", messages: [{ role: "user", content: `pw ${VALUE}` }, { role: "assistant", content: "hi" }], model: null, extend: null, numCtx: null, numGpu: null, think: null, schema: null, toolIds: null, maxTokens: null, save: true });
    const tok = (await scanTurn([VALUE])).spans[0][0].token;
    assert.equal(await sendBackgroundChat("oldchat9", `now ${VALUE}`, undefined, undefined, undefined, [tok]), "turn");
    await c.done(1);
    assert.deepEqual(c.requests[0].messages.filter((m) => m.role === "user").map((m) => m.content.split("\n")[0]), [`pw ${MARK}`, `now ${VALUE}`]);
    assert.equal(c.stored.get("oldchat9").scrubbedFrom, 2, "the line is drawn after the turns it held");
    assert.equal(await sendBackgroundChat("oldchat9", "and?"), "turn");
    await c.done(2);
    assert.deepEqual(c.requests[1].messages.filter((m) => m.role === "user").map((m) => m.content.split("\n")[0]), [`pw ${MARK}`, `now ${VALUE}`, "and?"]);
});
