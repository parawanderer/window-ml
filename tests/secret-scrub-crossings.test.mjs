// secret-scrub-crossings.test.mjs — a registered secret never crosses from the worker into a script or a model
// (SECRET_HANDLES.md, "The scrub as built"): each crossing the spec names, one section each, against a registry set in
// memory and the fake native host. The pure matching is tests/secret-registry.test.mjs; the page-started seat is at the end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fakeNativeHost } from "./fake-native-host.mjs";

const require = createRequire(import.meta.url);
const T = { timeout: 20000 };

const VALUE = "REALSECRET-4b1d-77";
const NAME = "PLUG_PASSWORD";
const MARK = `[REDACTED:${NAME}]`;
/** No text a script or model gets may hold the value, or any front of it long enough to mean something. */
const leaks = (s) => typeof s === "string" && (s.includes(VALUE) || s.includes(VALUE.slice(0, 6)));

// The worker's chrome, as much of it as sw-shell.ts, sw-shell-call.ts, sw-scrub.ts and sw-secret-registry.ts use.
const sync = { shellEnabled: true, shellRoots: ["/w/s0"], shellSandbox: true, shellPath: [], chatUrl: "http://host/api/chat/completions", apiKey: "sk-test-config-key" };
let native = null;
globalThis.chrome = {
    runtime: {
        id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p,
        connectNative: (name) => {
            const onMsg = [], onDisc = [];
            let closed = false;
            const end = { send: (m) => { if (!closed) setTimeout(() => { for (const f of onMsg) f(JSON.parse(JSON.stringify(m))); }, 0); }, close: () => { closed = true; } };
            const receive = native ? native(name, end) : null;
            return { name, postMessage: (m) => receive?.(JSON.parse(JSON.stringify(m))), disconnect: () => { closed = true; },
                onMessage: { addListener: (f) => onMsg.push(f) }, onDisconnect: { addListener: (f) => onDisc.push(f) } };
        },
    },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), ...sync }), set: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener() {} },
    },
};
const { _setRegistryForTest, _coldRegistryForTest, registryReady } = await import("../src/sw/sw-secret-registry.ts");
const { forModel, forModelHistory, forLive, forPerson, redactedNote } = await import("../src/sw/sw-scrub.ts");
const { shRun, shRead } = await import("../src/sw/sw-shell-call.ts");
const { SH_HEAD_BYTES } = await import("../src/shell/sh-call.ts");
const { TokenStore } = await import("../src/pointers/token-pipe.ts");
const { runAgentLoop } = await import("../src/agent/agent-loop.ts");

_setRegistryForTest([{ name: NAME, value: VALUE }]);

let rootN = 0;
/**
 * A fresh fake host whose calls print `out`.
 * @param out the program's stdout
 */
function hostPrinting(out) {
    const host = fakeNativeHost({ done: () => ({ out, err: "", code: 0 }) });
    native = host.onNative;
    sync.shellRoots = [`/w/s${++rootN}`];
    return host;
}
const ctxFor = (runId) => ({ runId, seq: 3, local: { step: 1, seq: 3 }, signal: new AbortController().signal, tokens: new TokenStore() });

// --- forModel: a tool result bound for the model ---

test("forModel replaces each registered value with its marker and counts it; the note names and counts, never the value", async () => {
    const r = await forModel(`url=http://u:${VALUE}@10.0.0.1 and again ${encodeURIComponent(VALUE)}`);
    assert.equal(r.text, `url=http://u:${MARK}@10.0.0.1 and again ${MARK}`);
    assert.deepEqual(r.counts, { [NAME]: 2 });
    assert.equal(redactedNote(r.counts), `\n[2 secrets redacted (${NAME})]`);
    assert.equal(redactedNote({}), "");
    // The config's own secret is still taken out beside it.
    assert.ok(!(await forModel("key sk-test-config-key")).text.includes("sk-test-config-key"));
});

// --- the run log's key: the person's view keeps the config's secrets, never a registered value ---

test("forPerson takes out a registered value and leaves the backend's own key as the run log keeps it", () => {
    const t = forPerson(`key sk-test-config-key and ${VALUE}`);
    assert.equal(t, `key sk-test-config-key and ${MARK}`);
});

// --- the ml.sh head, and what the run's token store keeps ---

test("an ml.sh head reaches the script with the marker, and the token store keeps the scrubbed head", T, async () => {
    hostPrinting(`DSN=postgres://app:${VALUE}@db/x\n`);
    const ctx = ctxFor("run-head");
    const r = await shRun(ctx, [["ls"], { expectMs: 5000 }]);
    assert.ok("ok" in r, JSON.stringify(r).slice(0, 300));
    assert.equal(r.ok.stdout.text, `DSN=postgres://app:${MARK}@db/x\n`);
    const kept = ctx.tokens.get(r.ok.stdout.token);
    assert.ok(kept && !leaks(String(kept.out)), String(kept?.out));
});

test("a cut head whose last bytes begin a registered value holds them back, so no front of it shows", T, async () => {
    const pad = "a".repeat(SH_HEAD_BYTES - 6);
    hostPrinting(`${pad}${VALUE} and more after it\n`);
    const r = await shRun(ctxFor("run-cut"), [["ls"], { expectMs: 5000 }]);
    assert.ok("ok" in r);
    assert.equal(r.ok.stdout.complete, false);
    assert.ok(!r.ok.stdout.text.includes(VALUE.slice(0, 6)), r.ok.stdout.text.slice(-80));
    assert.match(r.ok.stdout.text, /… \[first \d+ of \d+ bytes\]$/);
});

// --- ml.sh.read: a range, widened by the margin ---

test("a read range that cuts a registered value shows its marker, never a front or back of it, and says it scrubbed", T, async () => {
    const pad = "b".repeat(SH_HEAD_BYTES + 100);
    const text = `${pad}${VALUE}${"c".repeat(200)}`;
    hostPrinting(text);
    const ctx = ctxFor("run-read");
    const r = await shRun(ctx, [["ls"], { expectMs: 5000 }]);
    assert.ok("ok" in r);
    const at = pad.length;
    // Two ranges that split the value between them, and one that holds it whole.
    const left = await shRead(ctx, [r.ok.stdout.token, { offset: at - 10, length: 14 }]);
    const right = await shRead(ctx, [r.ok.stdout.token, { offset: at + 4, length: 30 }]);
    for (const x of [left, right]) {
        assert.ok("ok" in x, JSON.stringify(x));
        assert.ok(!leaks(x.ok.text) && !x.ok.text.includes(VALUE.slice(4, 12)), x.ok.text);
        assert.ok(x.ok.text.includes(MARK), x.ok.text);
        assert.equal(x.ok.scrubbed, 1);
        assert.equal(x.ok.offset, x === left ? at - 10 : at + 4, "offset stays the raw byte offset");
    }
    const clean = await shRead(ctx, [r.ok.stdout.token, { offset: 0, length: 10 }]);
    assert.equal(clean.ok.text, "bbbbbbbbbb");
    assert.equal(clean.ok.scrubbed, undefined);
});

test("a binary read range comes back as scrubbed bytes with scrubbed: n", T, async () => {
    const pad = "\u0000\u0001\u0002".repeat(SH_HEAD_BYTES / 3 + 50);
    hostPrinting(`${pad}${VALUE}\u0000\u0000`);
    const ctx = ctxFor("run-bin");
    const r = await shRun(ctx, [["ls"], { expectMs: 5000 }]);
    const x = await shRead(ctx, [r.ok.stdout.token, { offset: Buffer.byteLength(pad) - 4, length: 40 }]);
    assert.ok("ok" in x && x.ok.bytes, JSON.stringify(x).slice(0, 200));
    const got = Buffer.from(x.ok.bytes.$bytes, "base64").toString("latin1");
    assert.ok(!got.includes(VALUE.slice(0, 6)) && got.includes(MARK), JSON.stringify(got));
    assert.equal(x.ok.scrubbed, 1);
});

// --- a live output's view (streamOutput), per delta ---

test("forLive scrubs the text so far and holds back a tail that begins a value, at every delta", () => {
    let so_far = "";
    for (const ch of `log: ${VALUE} done`) {
        so_far += ch;
        const shown = forLive(so_far);
        assert.ok(!shown.includes(VALUE.slice(0, 3)) || shown.includes(MARK), `after ${so_far.length} chars: ${shown}`);
    }
    assert.equal(forLive(so_far), `log: ${MARK} done`);
});

test("the agent loop's live emits and its appended lines go through scrubText", T, async () => {
    const emits = [];
    const msgs = [{ role: "user", content: "go" }];
    let turn = 0;
    await runAgentLoop("go", { tools: [{ name: "probe" }], maxSteps: () => 3, stream: true }, {
        callModel: async () => (turn++ === 0 ? { content: "", tool_calls: [{ id: "c1", name: "probe", arguments: {} }] } : { content: "done", tool_calls: [] }),
        approve: async () => true, autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        runTool: async (_n, _a, push) => { for (const part of ["first ", VALUE.slice(0, 7), VALUE.slice(7), " last"]) { push?.(part); await new Promise((r) => setTimeout(r, 300)); } return { result: `out ${VALUE}` }; },
        pushToolResult: (m, call, content) => { m.push({ role: "tool", tool_call_id: call.id, content }); msgs.push({ role: "tool", content }); },
        emit: (ev) => emits.push(ev),
        forModel: async (_n, r) => (await forModel(r)).text,
        scrubText: (t, live) => (live ? forLive(t) : forPerson(t)),
    });
    const live = emits.filter((e) => e.streamOutput != null).map((e) => e.streamOutput);
    assert.ok(live.length > 0, "the tool streamed");
    for (const s of live) assert.ok(!leaks(s), s);
    for (const m of msgs) assert.ok(!leaks(m.content), m.content);
});

// --- the peek tail: it reaches the model through forModel ---

test("a running call's tail carries the marker through forModel, never the value", async () => {
    // peekTail's asked-and-cut branch stores `forModel(whole)`; its other branches reach the model as a task's text,
    // which crosses the agent loop's hook. Both are forModel: the registry rides it.
    const t = (await forModel(`tail line 1\nline with ${VALUE}\n`)).text;
    assert.ok(!leaks(t) && t.includes(MARK));
});

// --- resume: a session stored before the value was registered ---

test("a resumed history written before the value was registered is scrubbed from what the model is sent", async () => {
    // The UPGRADE case: a stored session's messages as the old code kept them, the value raw in a tool result and in
    // the model's own reply, read back by today's code after the person registered it.
    const stored = [
        { role: "system", content: "sys" },
        { role: "user", content: "read the config" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "exec", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c1", content: `PASSWORD=${VALUE}` },
        { role: "assistant", content: `The password is ${VALUE}.` },
    ];
    const messages = structuredClone(stored);
    const n = await forModelHistory(messages);
    assert.equal(n, 2);
    for (const m of messages) assert.ok(!leaks(m.content ?? ""), JSON.stringify(m));
    assert.equal(stored[3].content, `PASSWORD=${VALUE}`, "the stored session itself still holds it (a known limit)");
});

// --- the page-started seat: a page's model request leaves the worker with no registered value ---

/** A background whose storage holds the registry, and the bodies it sent to the backend. */
function backgroundWithRegistry() {
    const { loadBackground, jsonResponse } = require("./helpers");
    const bodies = [];
    const bg = loadBackground({
        config: { chatUrl: "http://backend.example/api/chat/completions", apiKey: "sk-bg-key-123456", model: "m", apiFormat: "openai", debugMode: "off" },
        local: { ml_secret_registry: [{ name: NAME, value: VALUE }] },
        onFetch: async (call) => { if (call.body) bodies.push(JSON.stringify(call.body)); return jsonResponse({ choices: [{ message: { role: "assistant", content: "ok" } }] }); },
    });
    return { bg, bodies };
}
const PAGE = { tab: { id: 7, url: "https://site.example/p" }, url: "https://site.example/p", origin: "https://site.example", frameId: 0 };

test("a page-started request with a registered value in every role sends none of it to the backend, as a bare [REDACTED]", T, async () => {
    const { bg, bodies } = backgroundWithRegistry();
    const payload = { model: "m", raw: true, messages: [
        { role: "system", content: `sys ${VALUE}` },
        { role: "user", content: [{ type: "text", text: `user ${VALUE}` }] },
        { role: "assistant", content: `asst ${VALUE}`, tool_calls: [{ id: "c1", type: "function", function: { name: "t", arguments: JSON.stringify({ q: VALUE }) } }] },
        { role: "tool", tool_call_id: "c1", content: `tool ${VALUE}` },
    ] };
    await bg.send({ type: "FETCH_LLM", payload }, structuredClone(PAGE));
    const sent = bodies.find((b) => b.includes("messages"));
    assert.ok(sent, "the request reached the backend");
    assert.ok(!sent.includes(VALUE) && !sent.includes(NAME), sent);
    assert.ok(sent.includes("[REDACTED]"));
});

test("a page sees the same answer shape with and without a match, and no page-reachable message returns a name or a count", T, async () => {
    const { bg } = backgroundWithRegistry();
    const ask = (content) => bg.send({ type: "FETCH_LLM", payload: { model: "m", messages: [{ role: "user", content }] } }, structuredClone(PAGE));
    const hit = await ask(`x ${VALUE}`), miss = await ask("x nothing");
    assert.deepEqual(Object.keys(hit).sort(), Object.keys(miss).sort());
    assert.equal(JSON.stringify(hit), JSON.stringify(miss));
    const reg = await bg.send({ type: "SECRET_REGISTRY", payload: { op: "list" } }, structuredClone(PAGE));
    assert.ok(!JSON.stringify(reg ?? {}).includes(NAME), JSON.stringify(reg));
    assert.ok(!("data" in (reg ?? {})), "a page is refused the registry");
});

// --- a cold worker: no crossing reads a registry it has not read yet as "no secrets" ---

/**
 * Runs `f` with the worker's local store answering `get` by `answer`, then puts the store and the registry back.
 * @param answer what `chrome.storage.local.get` does
 * @param f the body
 */
async function withStore(answer, f) {
    const real = chrome.storage.local.get;
    chrome.storage.local.get = answer;
    _coldRegistryForTest();
    try { await f(); } finally { chrome.storage.local.get = real; _setRegistryForTest([{ name: NAME, value: VALUE }]); }
}

test("before the first read a live view shows nothing and the person's view is held back; after it both are scrubbed", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await withStore(async () => { await gate; return { ml_secret_registry: [{ name: NAME, value: VALUE }] }; }, async () => {
        const text = `log: ${VALUE} done`;
        assert.equal(forLive(text), "", "a live delta before the read");
        const held = forPerson(text);
        assert.ok(!leaks(held) && /not read yet/.test(held), held);
        release();
        await registryReady();
        assert.equal(forLive(text), `log: ${MARK} done`);
        assert.equal(forPerson(text), `log: ${MARK} done`);
    });
});

test("a store that cannot be read fails every crossing closed, and the next crossing reads it again", async () => {
    let fail = true;
    await withStore(async () => { if (fail) throw new Error("storage is gone"); return { ml_secret_registry: [{ name: NAME, value: VALUE }] }; }, async () => {
        const text = `token ${VALUE}`;
        const r = await forModel(text);
        assert.ok(!leaks(r.text) && r.changed, r.text);
        assert.equal(forLive(text), "");
        assert.ok(!leaks(forPerson(text)));
        await assert.rejects(registryReady());
        fail = false;
        const again = await forModel(text);
        assert.equal(again.text, `token ${MARK}`);
    });
});
