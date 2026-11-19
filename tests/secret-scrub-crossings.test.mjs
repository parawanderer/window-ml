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
        onChanged: { listeners: [], addListener(f) { this.listeners.push(f); } },
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

test("a read range that starts inside a multi-byte character ends where the range ends, not in the margin", T, async () => {
    const pad = "b".repeat(SH_HEAD_BYTES + 100);
    hostPrinting(`${pad}€${"A".repeat(20)}${"B".repeat(50)}`);
    const ctx = ctxFor("run-read-utf8");
    const r = await shRun(ctx, [["ls"], { expectMs: 5000 }]);
    // Byte pad+1 is inside the three-byte "€"; 20 bytes from there are its two continuation bytes and 18 "A"s.
    const x = await shRead(ctx, [r.ok.stdout.token, { offset: pad.length + 1, length: 20 }]);
    assert.ok("ok" in x, JSON.stringify(x));
    assert.equal(x.ok.text, `€${"A".repeat(18)}`, "the straddled character whole, and not one character past the range");
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

// --- what the run stores beside the result: the Out render (sidebar, both exports) and a pointer's fuller capture ---

const { forStored, forPage } = await import("../src/sw/sw-scrub.ts");
const { derefPipe } = await import("../src/pointers/token-pipe.ts");
const { sessionToJson } = await import("../src/sidebar/export/export-json.ts");
await import("./stub-css.mjs");   // export.ts imports the panel's CSS
const { serializeSession } = await import("../src/sidebar/export/export.ts");

/**
 * One worker-hosted step of an exec that printed a registered value: the DONE event and the run's token store.
 * @returns the DONE event and the store
 */
async function execThatPrints() {
    const emits = [];
    const tokenStore = new TokenStore();
    let turn = 0;
    const long = `${"x".repeat(400)} ${VALUE} ${"y".repeat(400)}`;
    await runAgentLoop("go", { tools: [{ name: "exec" }], maxSteps: () => 3, tokenStore, toolTokens: true, runHash: "abc12345" }, {
        callModel: async () => (turn++ === 0 ? { content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }] } : { content: "done", tool_calls: [] }),
        approve: async () => true, autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        runTool: async () => ({ result: `out ${VALUE}`, renderIn: { type: "code", text: "1" }, renderOut: { type: "exec-out", stdout: long, capture: long, value: `v ${VALUE}`, error: `e ${VALUE}` } }),
        pushToolResult: (m, call, content) => m.push({ role: "tool", tool_call_id: call.id, content }),
        emit: (ev) => emits.push(ev),
        forModel: async (_n, r) => (await forModel(r)).text,
        scrubText: (t, live) => (live ? forLive(t) : forPerson(t)),
        scrubStored: forStored,
    });
    return { done: emits.find((e) => e.tool === "exec" && e.result != null), tokenStore };
}

test("an exec that printed a registered value leaves none of it in the Out render the sidebar draws", T, async () => {
    const { done } = await execThatPrints();
    const out = done.renderOut;
    for (const k of ["stdout", "capture", "value", "error"]) assert.ok(!leaks(out[k]) && out[k].includes(MARK), `${k}: ${out[k]}`);
});

test("neither export of that step holds the registered value", T, async () => {
    const { done } = await execThatPrints();
    const session = { hash: "abc12345", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 2, status: "ok", config: {}, turns: [], task: "go", maxSteps: 3,
        steps: [{ step: 1, seq: 1, ts: 1, tool: "exec", arguments: { js: "1" }, result: done.result, renderIn: done.renderIn, renderOut: done.renderOut, ...(done.modelResult ? { modelResult: done.modelResult } : {}) }],
        answers: [], summary: "" };
    const json = JSON.stringify(sessionToJson(session));
    assert.ok(!leaks(json) && json.includes(MARK), "the JSON export");
    const { md } = serializeSession(session);
    assert.ok(!leaks(md), "the Markdown export");
});

test("a @tool: read of that step's output hands back the marker, never the value", T, async () => {
    const { done, tokenStore } = await execThatPrints();
    assert.ok(done.token, "the step minted a pointer");
    const v = tokenStore.get(done.token);
    assert.ok(v.full, "the pointer keeps the fuller capture");
    const read = derefPipe(v, "out");
    assert.ok(!leaks(read) && read.includes(MARK), read.slice(0, 200));
});

test("a render whose secrets cannot be read is withheld whole, and its image data is left alone", async () => {
    const r = { type: "python-out", stdout: `p ${VALUE}`, image: "data:image/png;base64,AAAA" };
    const real = chrome.storage.local.get;
    chrome.storage.local.get = async () => { throw new Error("gone"); };
    _coldRegistryForTest();
    try {
        const got = await forStored(r);
        assert.ok(!leaks(got.stdout) && /could not be read/.test(got.stdout), got.stdout);
        assert.equal(got.image, r.image);
    } finally { chrome.storage.local.get = real; _setRegistryForTest([{ name: NAME, value: VALUE }]); }
});

test("every model-bound read of a stored whole (a pointer read, a pipe's head, grep and tail) crosses the scrub", T, async () => {
    const tokenStore = new TokenStore();
    tokenStore.note({ id: "a1b2c3f", tool: "fetch_url", kind: "text", out: "preview", value: "whole-1", in: "{}", t: 1, step: 1, seq: 1 });
    const whole = `line one\nthe key is ${VALUE} here\n${"filler\n".repeat(40)}last ${VALUE}\n`;
    const pipes = [undefined, "head 3", "grep key", "tail 1"];
    const sent = [];
    let turn = 0;
    await runAgentLoop("go", { tools: [{ name: "dereference" }], maxSteps: () => 6, tokenStore, readText: async (k) => { if (k !== "whole-1") throw new Error("gone"); return whole; } }, {
        callModel: async () => (turn < pipes.length
            ? { content: "", tool_calls: [{ id: `c${turn}`, name: "dereference", arguments: { token: "@tool:a1b2c3f", ...(pipes[turn++] ? { pipe: pipes[turn - 1] } : {}) } }] }
            : { content: "done", tool_calls: [] }),
        approve: async () => true, autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, content) => { m.push({ role: "tool", tool_call_id: call.id, content }); sent.push(content); },
        emit: () => {},
        forModel: async (_n, r) => (await forModel(r)).text,
        scrubText: (t, live) => (live ? forLive(t) : forPerson(t)),
        scrubStored: forStored,
    });
    assert.equal(sent.length, pipes.length, "each read reached the model");
    for (const [i, c] of sent.entries()) {
        assert.ok(!leaks(c), `read ${i} (${pipes[i] ?? "no pipe"}): ${c.slice(0, 300)}`);
        assert.ok(c.includes(MARK), `read ${i} carries the marker: ${c.slice(0, 300)}`);
    }
});

// --- the files the sandbox held unreadable: their names are strings of the answer like any other ---

test("a held file whose name holds a registered value is scrubbed in the answer the model reads, the step's span, and both exports", T, async () => {
    const held = [`/w/s0/${VALUE}/.env`, "/w/s0/.netrc"];
    const host = fakeNativeHost({ hiddenSecrets: held, done: () => ({ out: "", err: "", code: 0 }) });
    native = host.onNative;
    sync.shellRoots = [`/w/s${++rootN}`];
    const r = await shRun(ctxFor("held01"), [["ls"]]);
    assert.deepEqual(r.ok.hiddenSecrets, held, "the worker hands the script the host's names");
    const span = { program: "ls", durationMs: 1, unasked: { by: "default", argv: ["ls"], hiddenSecrets: r.ok.hiddenSecrets, outcome: {} } };
    let turn = 0;
    const emits = [], sent = [];
    await runAgentLoop("go", { tools: [{ name: "exec" }], maxSteps: () => 3, tokenStore: new TokenStore(), toolTokens: true, runHash: "abc12345" }, {
        callModel: async () => (turn++ === 0 ? { content: "", tool_calls: [{ id: "c1", name: "exec", arguments: { js: "1" } }] } : { content: "done", tool_calls: [] }),
        approve: async () => true, autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        runTool: async () => ({ result: JSON.stringify({ hiddenSecrets: r.ok.hiddenSecrets }), shCalls: [span] }),
        pushToolResult: (m, call, content) => { m.push({ role: "tool", tool_call_id: call.id, content }); sent.push(content); },
        emit: (ev) => emits.push(ev),
        forModel: async (_n, t) => (await forModel(t)).text,
        scrubText: (t, live) => (live ? forLive(t) : forPerson(t)),
        scrubStored: forStored,
    });
    assert.ok(sent.length && sent.every((c) => !leaks(c)) && sent[0].includes(MARK), `model: ${sent[0]}`);
    const done = emits.find((e) => e.tool === "exec" && e.result != null);
    assert.ok(!leaks(JSON.stringify(done.shCalls)) && JSON.stringify(done.shCalls).includes(MARK), "the stored span");
    const session = { hash: "abc12345", kind: "agent", model: "m", tag: "session", createdTs: 1, lastTs: 2, status: "ok", config: {}, turns: [], task: "go", maxSteps: 3,
        steps: [{ step: 1, seq: 1, ts: 1, tool: "exec", arguments: { js: "1" }, result: done.result, shCalls: done.shCalls, ...(done.modelResult ? { modelResult: done.modelResult } : {}) }], answers: [], summary: "" };
    assert.ok(!leaks(JSON.stringify(sessionToJson(session))), "the JSON export");
    const { md } = serializeSession(session);
    assert.ok(!leaks(md) && md.includes("Held:"), "the Markdown export");
});

// --- what a page is answered: its error strings, with no name ---

test("an error answered to a page has a registered value as a bare [REDACTED], and no name", async () => {
    const got = await forPage({ error: `refused ${VALUE}`, data: { nested: { transportError: `t ${VALUE}` } }, text: `data ${VALUE}` });
    assert.equal(got.error, "refused [REDACTED]");
    assert.equal(got.data.nested.transportError, "t [REDACTED]");
    assert.ok(!JSON.stringify(got).includes(NAME), "no name reaches a page");
    assert.equal(got.text, `data ${VALUE}`, "a data field is the handler's answer, as before");
});

test("an error to a page fails closed when the registry cannot be read", async () => {
    const real = chrome.storage.local.get;
    chrome.storage.local.get = async () => { throw new Error("gone"); };
    _coldRegistryForTest();
    try {
        const got = await forPage({ error: `refused ${VALUE}` });
        assert.deepEqual(got, { error: "The request failed." });
    } finally { chrome.storage.local.get = real; _setRegistryForTest([{ name: NAME, value: VALUE }]); }
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
        const seen = [];
        const { housekeeping } = await import("../src/sw/sw-housekeeping.ts");
        const record = housekeeping.record;
        housekeeping.record = (r) => seen.push(r);
        try { await assert.rejects(registryReady()); } finally { housekeeping.record = record; }
        assert.deepEqual(seen, [{ level: "warn", subsystem: "secrets", kind: "registry-unreadable" }], "the failed read is logged with no name and no value");
        fail = false;
        const again = await forModel(text);
        assert.equal(again.text, `token ${MARK}`);
    });
});

test("a change that arrives while the first read is in flight is not overwritten by that read's older list", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    await withStore(async () => { await gate; return { ml_secret_registry: [] }; }, async () => {
        const read = registryReady();
        for (const f of chrome.storage.onChanged.listeners) f({ ml_secret_registry: { newValue: [{ name: NAME, value: VALUE }] } }, "local");
        assert.equal(forLive(`k ${VALUE}`), `k ${MARK}`, "after the change");
        release();
        await read;
        assert.equal(forLive(`k ${VALUE}`), `k ${MARK}`, "after the older read lands");
        assert.equal((await forModel(`k ${VALUE}`)).text, `k ${MARK}`);
    });
});
