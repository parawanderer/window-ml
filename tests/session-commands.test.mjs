// The local runtime's commands (src/session-commands.ts) against a real SessionIndex and recorded dependencies: which
// existing path each command takes, and which contract error it answers with when it cannot (docs/spec/SESSION_CONTRACT.md
// §Commands).
import test from "node:test";
import assert from "node:assert/strict";
import { SessionIndex } from "../src/session-index.ts";
import { createCommandHandler, imageSize, dataUrlBytes, MAX_PINNED, SIDE_CALL_MAX_TOKENS } from "../src/session-commands.ts";
import { SESSION_CONTRACT_VERSION } from "../src/session-host.ts";

const TAB = 7;
const ev = (hash, kind, over = {}) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, ...over });
const start = (hash) => ev(hash, "agent", { task: "t", model: "m", maxSteps: 3, config: null });
const sid = (hash, runtime = "local") => ({ runtime, hash });

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
/** A PNG header with a given size (enough bytes for the size to be read). */
const png = (w, h, pad = 0) => "data:image/png;base64," + b64([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 6, 0, 0, 0, ...new Array(pad).fill(0)]);
/** A JPEG with an APP0 segment before its frame header. */
const jpeg = (w, h) => "data:image/jpeg;base64," + b64([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

/** A saved session's whole history, as the store holds it: oldest first. */
const STORED = Array.from({ length: 95 }, (_, i) => ev("aaaa0001", "agent-step", { step: i + 1, seq: i + 1, tool: "exec", result: String(i) }));

/** What a saved run would be continued from: its messages and the payload it was started with. */
const AGENT_HISTORY = {
    kind: "agent",
    messages: [{ role: "user", content: "read the headline" }, { role: "assistant", content: "done" }],
    payload: { runId: "aaaa0001", task: "read the headline", systemPrompt: "S", tools: [], model: "m", think: null, maxSteps: 5, rebuild: { toolNames: ["click"], model: "m", driverSees: false, visionModel: null, groundingModel: null, groundingRange: 0, pierceClosed: false, cdp: false, crossOrigin: false } },
};

/** A handler over a fresh index, with every dependency recorded and scriptable. */
function world(over = {}) {
    const index = new SessionIndex({ runtime: "local", spawn: "w1" });
    const calls = [];
    const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return typeof ret === "function" ? ret(...args) : ret; };
    const deps = {
        runtime: "local", index,
        describe: rec("describe", () => ({ kind: "browser", contractVersion: SESSION_CONTRACT_VERSION, capabilities: { chat: true, agent: true, tabs: true } })),
        removeFromIndex: rec("remove", (id) => index.remove(id.hash)),
        listTabs: rec("listTabs", async () => [{ tabId: TAB, url: "https://a.example/", title: "A", active: true, windowId: 1 }]),
        getTab: rec("getTab", async (id) => (id === TAB ? { tabId: TAB, url: "https://a.example/", title: "A", active: true, windowId: 1 } : null)),
        focusTab: rec("focusTab", async () => true),
        toPage: rec("toPage", async () => "turn"),
        highlight: rec("highlight"),
        steer: rec("steer", false),
        cancelRun: rec("cancelRun", false),
        resolveApproval: rec("resolveApproval", true),
        forgetStored: rec("forgetStored", async () => {}),
        startChat: rec("startChat", async () => "beef0001"),
        sendChat: rec("sendChat", async () => "turn"),
        cancelChat: rec("cancelChat", true),
        hostsChat: rec("hostsChat", false),
        keepSession: rec("keepSession"),
        listModels: rec("listModels", async () => [{ id: "m", default: true }]),
        pinSession: rec("pinSession", (hash, pinned) => { index.setPinned(hash, pinned); }),
        renameSession: rec("renameSession", (hash, title) => { index.setTitle(hash, title, !!title); }),
        startAgent: rec("startAgent", async () => ({ outcome: "started", hash: "ab120001" })),
        history: rec("history", async () => AGENT_HISTORY),
        storedEvents: rec("storedEvents", async () => STORED),
        adoptSession: rec("adoptSession", async () => "adopted"),
        noteResumed: rec("noteResumed"),
        openTab: rec("openTab", async () => 99),
        startPage: () => "https://start.example/",
        utilityConfigured: () => true,
        sideCall: rec("sideCall", async () => ({ content: "a title", usage: { totalTokens: 5 } })),
        captureVisible: rec("captureVisible", async () => png(1280, 720)),
        now: () => 42,
        ...over,
    };
    const run = createCommandHandler(deps);
    const named = (n) => calls.filter((c) => c[0] === n);
    return { index, run, calls, named, deps };
}
const code = (r) => (r.ok ? "ok" : r.error.code);

test("every session command refuses a session this runtime does not hold, or another runtime's", async () => {
    const { run, index } = world();
    index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    for (const c of [
        { type: "session.send", session: sid("ffff0000"), text: "hi" },
        { type: "session.cancel", session: sid("aaaa0001", "laptop") },
        { type: "session.continue", session: sid("ffff0000") },
        { type: "session.delete", session: sid("ffff0000") },
        { type: "session.pin", session: sid("ffff0000"), pinned: true },
        { type: "session.rename", session: sid("ffff0000"), title: "x" },
        { type: "approval.answer", session: sid("ffff0000"), seq: 1, decision: "approve" },
        { type: "page.highlight", session: sid("ffff0000"), ref: null },
        { type: "tabs.list", runtime: "laptop" },
        { type: "tab.screenshot", runtime: "local", target: { session: sid("ffff0000") } },
    ]) assert.equal(code(await run(c)), "not-found", c.type);
    assert.equal(code(await run({ type: "session.send", session: "aaaa0001", text: "hi" })), "invalid");
    // A target kind this runtime does not offer answers `unsupported`, so a newer client degrades to a message
    // rather than to a guess.
    assert.equal(code(await run({ type: "agent.start", runtime: "local", task: "hi", target: { kind: "headless" } })), "unsupported");
    assert.equal(code(await run({ type: "nonsense" })), "unsupported");
});

test("session.send: a running background loop is steered directly; anything else goes to the page, which says what it did", async () => {
    const w = world({ steer: (hash, text) => { w.calls.push(["steer", hash, text]); return hash === "aaaa0001"; } });
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    assert.deepEqual(await w.run({ type: "session.send", session: sid("aaaa0001"), text: "also the tax" }), { ok: true, data: { mode: "steer" } });
    assert.equal(w.named("toPage").length, 0);

    // Images cannot ride a mid-run steer: the page starts a turn with them (or steers text-only, as its handle decides).
    await w.run({ type: "session.send", session: sid("aaaa0001"), text: "see", images: ["data:image/png;base64,AA", "javascript:alert(1)"] });
    assert.deepEqual(w.named("toPage").at(-1), ["toPage", TAB, "send", { hash: "aaaa0001", text: "see", images: ["data:image/png;base64,AA"] }]);

    // A page-hosted run: no loop in the worker, so the page's handle steers.
    w.index.ingest(start("bbbb0002"), { tabId: TAB, trusted: false });
    w.deps.toPage = async () => "steer";
    const w2 = createCommandHandler(w.deps);
    assert.deepEqual(await w2({ type: "session.send", session: sid("bbbb0002"), text: "go on" }), { ok: true, data: { mode: "steer" } });

    for (const [outcome, expected] of [["none", "not-found"], ["no-answer", "unavailable"], ["turn", "ok"]]) {
        w.deps.toPage = async () => outcome;
        assert.equal(code(await createCommandHandler(w.deps)({ type: "session.send", session: sid("bbbb0002"), text: "x" })), expected, outcome);
    }
    w.deps.toPage = async () => { throw new Error("Could not establish connection. Receiving end does not exist."); };
    assert.equal(code(await createCommandHandler(w.deps)({ type: "session.send", session: sid("bbbb0002"), text: "x" })), "unavailable");
    assert.equal(code(await w.run({ type: "session.send", session: sid("bbbb0002"), text: "  " })), "invalid");

    // The tab closed: nowhere to deliver it.
    w.index.pageGone(TAB, { closed: true });
    assert.equal(code(await w.run({ type: "session.send", session: sid("bbbb0002"), text: "x" })), "unavailable");
});

test("session.cancel stops a background run itself, a page-hosted one through its page, and says when nothing runs", async () => {
    const w = world({ cancelRun: (h) => h === "aaaa0001" });
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    w.index.ingest(start("bbbb0002"), { tabId: TAB, trusted: false });
    w.index.ingest(start("cccc0003"), { tabId: TAB, trusted: false });
    w.index.ingest(ev("cccc0003", "agent-result", { summary: "done", steps: 1, hitCap: false }), { tabId: TAB, trusted: false });
    assert.equal(code(await w.run({ type: "session.cancel", session: sid("aaaa0001") })), "ok");
    w.deps.toPage = async (_t, action) => (action === "cancel" ? "cancelled" : "none");
    const run = createCommandHandler(w.deps);
    assert.equal(code(await run({ type: "session.cancel", session: sid("bbbb0002") })), "ok");
    assert.equal(code(await run({ type: "session.cancel", session: sid("cccc0003") })), "conflict");
});

test("session.continue only for a run stopped at its cap, through the page that holds it", async () => {
    const w = world();
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    assert.equal(code(await w.run({ type: "session.continue", session: sid("aaaa0001") })), "conflict");
    w.index.ingest(ev("aaaa0001", "agent-result", { summary: "", steps: 3, hitCap: true }), { tabId: TAB, trusted: true });
    for (const [outcome, expected] of [["continued", "ok"], ["busy", "conflict"], ["none", "not-found"]]) {
        w.deps.toPage = async (_t, action, body) => { assert.deepEqual([action, body], ["continue", { hash: "aaaa0001" }]); return outcome; };
        assert.equal(code(await createCommandHandler(w.deps)({ type: "session.continue", session: sid("aaaa0001") })), expected, outcome);
    }
});

test("models.list: this runtime's list, another runtime's refused, and an unreachable backend is an empty list", async () => {
    const { run } = world();
    assert.deepEqual(await run({ type: "models.list", runtime: "local" }), { ok: true, data: { models: [{ id: "m", default: true }] } });
    assert.equal(code(await run({ type: "models.list", runtime: "laptop" })), "not-found");
    const down = world({ listModels: async () => { throw new Error("ECONNREFUSED"); } });
    assert.deepEqual(await down.run({ type: "models.list", runtime: "local" }), { ok: true, data: { models: [] } });
});

test("session.pin: bounded, idempotent, and handed to the one pin path", async () => {
    const { run, index, named } = world();
    index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    assert.equal(code(await run({ type: "session.pin", session: sid("aaaa0001"), pinned: "yes" })), "invalid");
    assert.equal(code(await run({ type: "session.pin", session: sid("aaaa0001"), pinned: true })), "ok");
    assert.equal(index.get("aaaa0001").pinned, true);
    // Two devices pinning the same session both asked for the state it is in: success, and no second write.
    assert.equal(code(await run({ type: "session.pin", session: sid("aaaa0001"), pinned: true })), "ok");
    assert.equal(named("pinSession").length, 1);
    assert.equal(code(await run({ type: "session.pin", session: sid("aaaa0001"), pinned: false })), "ok");
    assert.equal(index.get("aaaa0001").pinned, undefined);

    // Past the bound, a new pin is refused; unpinning and re-pinning what is already pinned are not.
    for (let i = 0; i < MAX_PINNED; i++) {
        const h = (0xb0000000 + i).toString(16);
        index.ingest(start(h), { tabId: TAB, trusted: true });
        index.setPinned(h, true);
    }
    const refused = await run({ type: "session.pin", session: sid("aaaa0001"), pinned: true });
    assert.equal(code(refused), "conflict");
    assert.match(refused.error.message, /unpin one/);
    assert.equal(code(await run({ type: "session.pin", session: sid("b0000000"), pinned: true })), "ok");
    assert.equal(code(await run({ type: "session.pin", session: sid("b0000000"), pinned: false })), "ok");
    assert.equal(code(await run({ type: "session.pin", session: sid("aaaa0001"), pinned: true })), "ok");
});

test("tabs.list carries groups only when the runtime can name some", async () => {
    const none = world();
    assert.deepEqual(Object.keys((await none.run({ type: "tabs.list", runtime: "local" })).data), ["tabs"]);
    const named = world({ listTabGroups: async () => [{ id: 5, title: "Work", color: "blue" }] });
    assert.deepEqual((await named.run({ type: "tabs.list", runtime: "local" })).data.groups, [{ id: 5, title: "Work", color: "blue" }]);
    const broken = world({ listTabGroups: async () => { throw new Error("no permission"); } });
    assert.equal((await broken.run({ type: "tabs.list", runtime: "local" })).ok, true, "a group failure never costs the tabs");
});

test("session.rename: capped, marked as a person's, and empty goes back to generated", async () => {
    const { run, index, named } = world();
    index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    assert.equal(code(await run({ type: "session.rename", session: sid("aaaa0001"), title: 7 })), "invalid");
    const r = await run({ type: "session.rename", session: sid("aaaa0001"), title: "  Lamp   hunt  " });
    assert.deepEqual(r, { ok: true, data: { title: "Lamp hunt" } });
    assert.equal(index.get("aaaa0001").title, "Lamp hunt");
    assert.equal(index.get("aaaa0001").renamed, true);
    const back = await run({ type: "session.rename", session: sid("aaaa0001"), title: "   " });
    assert.deepEqual(back, { ok: true, data: { title: "" } });
    assert.deepEqual(named("renameSession").at(-1), ["renameSession", "aaaa0001", null]);
    assert.equal(index.get("aaaa0001").renamed, undefined);
});

test("session.delete refuses a running session, and forgets a finished one everywhere", async () => {
    const w = world();
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    assert.equal(code(await w.run({ type: "session.delete", session: sid("aaaa0001") })), "conflict");
    assert.equal(w.named("forgetStored").length, 0);
    w.index.ingest(ev("aaaa0001", "agent-result", { summary: "ok", steps: 1, hitCap: false }), { tabId: TAB, trusted: true });
    assert.equal(code(await w.run({ type: "session.delete", session: sid("aaaa0001") })), "ok");
    assert.deepEqual(w.named("forgetStored"), [["forgetStored", "aaaa0001"]]);
    assert.equal(w.index.get("aaaa0001"), null);
});

test("approval.answer goes to the one resolver, keyed hash:seq, and reports a gate already closed as resolved: false", async () => {
    const w = world({ resolveApproval: (key, d) => { w.calls.push(["resolve", key, d]); return key.endsWith(":2"); } });
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    assert.deepEqual(await w.run({ type: "approval.answer", session: sid("aaaa0001"), seq: 2, decision: "approve", persist: true }), { ok: true, data: { resolved: true } });
    assert.deepEqual(await w.run({ type: "approval.answer", session: sid("aaaa0001"), seq: 3, decision: "deny", feedback: "not that one" }), { ok: true, data: { resolved: false } });
    assert.deepEqual(w.named("resolve"), [["resolve", "aaaa0001:2", { approved: true, persist: true }], ["resolve", "aaaa0001:3", { approved: false, feedback: "not that one" }]]);
    assert.equal(code(await w.run({ type: "approval.answer", session: sid("aaaa0001"), seq: "2", decision: "approve" })), "invalid");
    assert.equal(code(await w.run({ type: "approval.answer", session: sid("aaaa0001"), seq: 2, decision: "yes" })), "invalid");
});

test("page.highlight draws on the session's own tab, and takes only a selector, a token or null", async () => {
    const w = world();
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    assert.equal(code(await w.run({ type: "page.highlight", session: sid("aaaa0001"), ref: { selector: "#buy" } })), "ok");
    assert.equal(code(await w.run({ type: "page.highlight", session: sid("aaaa0001"), ref: null })), "ok");
    assert.equal(code(await w.run({ type: "page.highlight", session: sid("aaaa0001"), ref: { script: "x" } })), "invalid");
    assert.deepEqual(w.named("highlight"), [["highlight", TAB, { selector: "#buy" }], ["highlight", TAB, null]]);
});

test("side.call: the utility profile only, a capped token budget, the session on the hint, and the JSON parsed when a schema was sent", async () => {
    const w = world({ sideCall: async (req) => { w.calls.push(["sideCall", req]); return { content: '{"title":"Prices"}', usage: null }; } });
    const base = { type: "side.call", runtime: "local", purpose: "title", session: sid("aaaa0001"), messages: [{ role: "user", content: "name this" }] };
    const r = await w.run({ ...base, maxTokens: 50_000, schema: { type: "object" } });
    assert.deepEqual(r, { ok: true, data: { content: '{"title":"Prices"}', structured: { title: "Prices" }, usage: null } });
    assert.deepEqual(w.named("sideCall")[0][1], { messages: base.messages, schema: { type: "object" }, maxTokens: SIDE_CALL_MAX_TOKENS, session: "aaaa0001" });

    assert.equal(code(await w.run({ ...base, maxTokens: 10, messages: [{ role: "tool", content: "x" }] })), "invalid");
    assert.equal(code(await w.run({ ...base, maxTokens: 10, purpose: "anything" })), "invalid");
    assert.equal(code(await w.run({ ...base, maxTokens: 0 })), "invalid");
    assert.equal(code(await createCommandHandler({ ...w.deps, utilityConfigured: () => false })({ ...base, maxTokens: 10 })), "unsupported");
    assert.deepEqual(await createCommandHandler({ ...w.deps, sideCall: async () => { throw new Error("backend down"); } })({ ...base, maxTokens: 10 }), { ok: false, error: { code: "failed", message: "backend down" } });
});

test("tab.screenshot: only a tab in front, stepped down to JPEG under the size ceiling, with its real pixel size", async () => {
    const shots = [png(1280, 720, 3000), jpeg(1280, 720)];
    const w = world({ captureVisible: async (win, opts) => { w.calls.push(["capture", win, opts]); return opts.format === "png" ? shots[0] : shots[1]; } });
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    const r = await w.run({ type: "tab.screenshot", runtime: "local", target: { session: sid("aaaa0001") }, maxBytes: 1000 });
    assert.deepEqual(r, { ok: true, data: { image: shots[1], width: 1280, height: 720, ts: 42 } });
    assert.deepEqual(w.named("capture").map((c) => c[2].format), ["png", "jpeg"]);

    assert.equal(code(await w.run({ type: "tab.screenshot", runtime: "local", target: { tabId: 999 } })), "not-found");
    const hidden = createCommandHandler({ ...w.deps, getTab: async () => ({ tabId: TAB, url: "", title: "", active: false, windowId: 1 }) });
    assert.equal(code(await hidden({ type: "tab.screenshot", runtime: "local", target: { tabId: TAB } })), "conflict");
    const huge = createCommandHandler({ ...w.deps, captureVisible: async () => png(1, 1, 5000) });
    assert.equal(code(await huge({ type: "tab.screenshot", runtime: "local", target: { tabId: TAB }, maxBytes: 100 })), "failed");
    assert.equal(code(await w.run({ type: "tab.screenshot", runtime: "local", target: {} })), "invalid");
});

test("image headers: PNG and JPEG sizes read from bytes; anything else is not an image", () => {
    assert.deepEqual(imageSize(png(3000, 2)), { width: 3000, height: 2 });
    assert.deepEqual(imageSize(jpeg(640, 480)), { width: 640, height: 480 });
    assert.equal(imageSize("data:image/gif;base64,R0lGOD"), null);
    assert.equal(imageSize("data:image/png;base64,AAAA"), null);
    assert.equal(dataUrlBytes("data:image/png;base64,QUJD"), 3);
    assert.equal(dataUrlBytes("data:image/png;base64,QUI="), 2);
});

/** The index row a worker-hosted chat makes: a `chat` turn with no tab behind it. */
const chatStart = (hash) => ({ kind: "chat", id: `${hash}-1`, ts: 1, save: true, session: { hash, turn: 1 }, streaming: false,
    config: { system: null, model: null, think: null, schema: false, toolIds: null, maxTokens: null, save: true },
    request: { model: null, extend: null, messages: [{ role: "user", content: "hi" }], images: null, toolIds: null, schema: false, think: null, maxTokens: null } });

test("chat.start hands back the new session and passes the options through", async () => {
    const w = world();
    const r = await w.run({ type: "chat.start", runtime: "local", text: "hello", system: "be terse", model: "m1", think: true });
    assert.deepEqual(r, { ok: true, data: { session: sid("beef0001") } });
    assert.deepEqual(w.named("startChat")[0][1], { text: "hello", model: "m1", system: "be terse", think: true });
});

test("chat.start refuses an empty message and another runtime", async () => {
    const w = world();
    assert.equal((await w.run({ type: "chat.start", runtime: "local", text: "   " })).error.code, "invalid");
    assert.equal((await w.run({ type: "chat.start", runtime: "local", text: "x".repeat(100_001) })).error.code, "invalid");
    assert.equal((await w.run({ type: "chat.start", runtime: "phone", text: "hi" })).error.code, "not-found");
    assert.equal(w.named("startChat").length, 0);
});

test("a message to a worker-hosted chat is its next turn, never a relay to a tab", async () => {
    const w = world({ hostsChat: () => true });
    w.index.ingest(chatStart("c0ffee01"), { trusted: true });

    const r = await w.run({ type: "session.send", session: sid("c0ffee01"), text: "and then?" });
    assert.deepEqual(r, { ok: true, data: { mode: "turn" } });
    assert.equal(w.named("sendChat")[0][1], "c0ffee01");
    assert.equal(w.named("toPage").length, 0, "a worker-hosted chat has no page to relay to");
    assert.equal(w.named("steer").length, 0);
});

test("a message to a chat that is still answering is a conflict, and a forgotten one is not-found", async () => {
    const busy = world({ hostsChat: () => true, sendChat: async () => "busy" });
    busy.index.ingest(chatStart("c0ffee02"), { trusted: true });
    assert.equal((await busy.run({ type: "session.send", session: sid("c0ffee02"), text: "hurry up" })).error.code, "conflict");

    const gone = world({ hostsChat: () => true, sendChat: async () => "not-found" });
    gone.index.ingest(chatStart("c0ffee03"), { trusted: true });
    assert.equal((await gone.run({ type: "session.send", session: sid("c0ffee03"), text: "hello?" })).error.code, "not-found");
});

test("cancelling a worker-hosted chat aborts its turn rather than a run or a page", async () => {
    const w = world({ hostsChat: () => true });
    w.index.ingest(chatStart("c0ffee04"), { trusted: true });

    assert.deepEqual(await w.run({ type: "session.cancel", session: sid("c0ffee04") }), { ok: true, data: {} });
    assert.equal(w.named("cancelChat")[0][1], "c0ffee04");
    assert.equal(w.named("cancelRun").length, 0);
    assert.equal(w.named("toPage").length, 0);

    const idle = world({ hostsChat: () => true, cancelChat: () => false });
    idle.index.ingest(chatStart("c0ffee05"), { trusted: true });
    assert.equal((await idle.run({ type: "session.cancel", session: sid("c0ffee05") })).error.code, "conflict");
});

/** A saved run that has finished: the state `session.resume` is for. */
function endedRun(w, hash, over = {}) {
    w.index.ingest(start(hash), { tabId: TAB, trusted: true, page: { url: "https://old.example/" }, ...over });
    w.index.ingest(ev(hash, "agent-result", { summary: "ok", steps: 1, hitCap: false }), { tabId: TAB, trusted: true });
    w.index.markSaved(hash);
}

test("session.resume hands a saved run to a page and says so in the transcript, without taking a turn", async () => {
    const w = world();
    endedRun(w, "aaaa0010");

    const r = await w.run({ type: "session.resume", session: sid("aaaa0010"), target: { kind: "tab", tabId: TAB } });
    assert.deepEqual(r, { ok: true, data: { session: sid("aaaa0010") } });

    const [, tabId, hash, history] = w.named("adoptSession")[0];
    assert.equal(tabId, TAB);
    assert.equal(hash, "aaaa0010");
    assert.equal(history.payload.systemPrompt, "S", "the page rebuilds its toolset from what was stored");
    assert.equal(w.named("startAgent").length, 0, "resuming is not starting");
    assert.equal(w.named("toPage").length, 0, "and it is not a message");

    // The note is a fact about the session: where it is now, where it was, how long it sat, and what it lost.
    const [, noteHash, noteTab, note] = w.named("noteResumed")[0];
    assert.equal(noteHash, "aaaa0010");
    assert.equal(noteTab, TAB);
    assert.equal(note.url, "https://a.example/");
    assert.equal(note.fromUrl, "https://old.example/");
    assert.equal(typeof note.afterMs, "number");
    assert.ok(note.dropped.length > 0, "never empty — something is always dropped");
    assert.ok(note.dropped.some((d) => /approval grants/.test(d)));
});

test("resuming the same session twice is two notes, because it is two resumes", async () => {
    // The index de-duplicates a resume note by its id. A note identified by the SESSION would mean a session that
    // moved page twice showed one divider for both moves, with the second silently dropped.
    let t = 1000;
    const w = world({ now: () => (t += 5000) });
    endedRun(w, "aaaa0018");

    assert.equal(code(await w.run({ type: "session.resume", session: sid("aaaa0018"), target: { kind: "tab", tabId: TAB } })), "ok");
    assert.equal(code(await w.run({ type: "session.resume", session: sid("aaaa0018"), target: { kind: "tab", tabId: TAB } })), "ok");

    const ids = w.named("noteResumed").map((c) => c[3].id);
    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
});

test("a resume that the page does not take leaves no note claiming it happened", async () => {
    const w = world({ adoptSession: async () => "no-answer" });
    endedRun(w, "aaaa0011");

    assert.equal((await w.run({ type: "session.resume", session: sid("aaaa0011"), target: { kind: "tab", tabId: TAB } })).error.code, "unavailable");
    assert.equal(w.named("noteResumed").length, 0);
});

test("session.resume refuses what cannot be resumed, each for its own reason", async () => {
    // Still going: it does not need resuming, and adopting it elsewhere would be two pages holding one run.
    const live = world();
    live.index.ingest(start("aaaa0012"), { tabId: TAB, trusted: true });
    live.index.markSaved("aaaa0012");
    assert.equal((await live.run({ type: "session.resume", session: sid("aaaa0012"), target: { kind: "tab", tabId: TAB } })).error.code, "conflict");

    // Never saved: there is no history to continue from, and the events are a transcript, not one.
    const unsaved = world();
    unsaved.index.ingest(start("aaaa0013"), { tabId: TAB, trusted: true });
    unsaved.index.ingest(ev("aaaa0013", "agent-result", { summary: "ok", steps: 1, hitCap: false }), { tabId: TAB, trusted: true });
    assert.equal((await unsaved.run({ type: "session.resume", session: sid("aaaa0013"), target: { kind: "tab", tabId: TAB } })).error.code, "not-found");

    // Saved before this browser kept enough to continue a run.
    const old = world({ history: async () => ({ kind: "agent", messages: [{ role: "user", content: "x" }] }) });
    endedRun(old, "aaaa0014");
    assert.equal((await old.run({ type: "session.resume", session: sid("aaaa0014"), target: { kind: "tab", tabId: TAB } })).error.code, "not-found");

    // A chat with no page is already this worker's: its next message rehydrates it, and a tab would do nothing.
    const chat = world({ hostsChat: () => true });
    chat.index.ingest(chatStart("c0ffee09"), { trusted: true });
    assert.equal((await chat.run({ type: "session.resume", session: sid("c0ffee09"), target: { kind: "tab", tabId: TAB } })).error.code, "unsupported");
    assert.equal(chat.named("adoptSession").length, 0);
});

test("session.resume picks a target the way agent.start does, including a blank tab", async () => {
    const w = world();
    endedRun(w, "aaaa0015");
    const r = await w.run({ type: "session.resume", session: sid("aaaa0015"), target: { kind: "blank", url: "https://new.example/" } });
    assert.equal(code(r), "ok");
    assert.equal(w.named("openTab")[0][1], "https://new.example/");

    // And refuses the same targets: a page the extension cannot run on is not a place to resume.
    const bad = world({ getTab: async () => ({ tabId: TAB, url: "chrome://settings", title: "s", active: true, windowId: 1 }) });
    endedRun(bad, "aaaa0016");
    assert.equal((await bad.run({ type: "session.resume", session: sid("aaaa0016"), target: { kind: "tab", tabId: TAB } })).error.code, "forbidden");

    const headless = world();
    endedRun(headless, "aaaa0017");
    assert.equal((await headless.run({ type: "session.resume", session: sid("aaaa0017"), target: { kind: "headless" } })).error.code, "unsupported");
});

test("a saved chat the worker has FORGOTTEN is still the worker's, and its next message rehydrates it", async () => {
    // `hostsChat` reads worker memory, which an MV3 eviction empties. Routing on it sent this message down the run
    // paths, which end at a tab a pageless chat never had: "the tab this session ran on is closed", about a session
    // with no tab. The index knows what it is.
    const w = world({ hostsChat: () => false });
    w.index.ingest(chatStart("c0ffee06"), { trusted: true });

    const r = await w.run({ type: "session.send", session: sid("c0ffee06"), text: "still there?" });
    assert.deepEqual(r, { ok: true, data: { mode: "turn" } });
    assert.equal(w.named("sendChat")[0][1], "c0ffee06", "rehydrated from storage rather than relayed");
    assert.equal(w.named("toPage").length, 0);

    // And the same routing for cancel: a chat the worker has forgotten has no turn in flight.
    const c = world({ hostsChat: () => false, cancelChat: () => false });
    c.index.ingest(chatStart("c0ffee07"), { trusted: true });
    assert.equal((await c.run({ type: "session.cancel", session: sid("c0ffee07") })).error.code, "conflict");
    assert.equal(c.named("toPage").length, 0, "not a relay to a tab it never had");
});

test("a chat that DOES have a page is still the page's, forgotten or not", async () => {
    // The distinction is the page, not the kind: `ml.createChat` in a tab is a chat whose turns that page runs.
    const w = world({ hostsChat: () => false });
    w.index.ingest(chatStart("c0ffee08"), { tabId: TAB, trusted: false, page: { url: "https://a.example/" } });

    await w.run({ type: "session.send", session: sid("c0ffee08"), text: "carry on" });
    assert.equal(w.named("sendChat").length, 0, "not the worker's chat");
    assert.equal(w.named("toPage")[0][1], TAB);
});

test("agent.start on a tab goes through that page's own start path and answers with the session it made", async () => {
    const w = world();
    const r = await w.run({ type: "agent.start", runtime: "local", task: "read the headline", target: { kind: "tab", tabId: TAB }, maxSteps: 4, stream: true });
    assert.deepEqual(r, { ok: true, data: { session: sid("ab120001") } });
    assert.deepEqual(w.named("startAgent")[0].slice(1), [TAB, { task: "read the headline", maxSteps: 4, stream: true }]);
    assert.equal(w.named("openTab").length, 0);
});

test("agent.start on a blank tab opens one, at the command's url or the browser's start page", async () => {
    const w = world();
    await w.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "blank" } });
    assert.equal(w.named("openTab")[0][1], "https://start.example/", "the configured start page");
    await w.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "blank", url: "https://other.example/x" } });
    assert.equal(w.named("openTab")[1][1], "https://other.example/x", "the command's own url wins");
    assert.equal(w.named("startAgent")[1][1], 99, "the run starts on the tab that was opened");

    // With no start page set and no url, there is nowhere to go: the browser's own new-tab page cannot host a run.
    const bare = world({ startPage: () => "" });
    assert.equal((await bare.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "blank" } })).error.code, "invalid");
    assert.equal(bare.named("openTab").length, 0);
    // And a non-http(s) one is refused before a tab is opened at it.
    const bad = world({ startPage: () => "" });
    assert.equal((await bad.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "blank", url: "file:///etc/passwd" } })).error.code, "invalid");
    assert.equal(bad.named("openTab").length, 0);
});

test("agent.start refuses a page the extension cannot run on, and a run it cannot confirm", async () => {
    const chromePage = world({ getTab: async () => ({ tabId: 5, url: "chrome://extensions/", title: "Extensions", active: true, windowId: 1 }) });
    assert.equal((await chromePage.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: 5 } })).error.code, "forbidden");
    assert.equal(chromePage.named("startAgent").length, 0);

    const silent = world({ startAgent: async () => ({ outcome: "no-answer" }) });
    assert.equal((await silent.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB } })).error.code, "unavailable");

    const refused = world({ startAgent: async () => ({ outcome: "none" }) });
    assert.equal((await refused.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB } })).error.code, "failed");

    // A started run with no hash is not a session id to hand back.
    const hashless = world({ startAgent: async () => ({ outcome: "started" }) });
    assert.equal((await hashless.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB } })).error.code, "unavailable");
});

test("agent.start refuses an empty task, a bad step budget, a missing target and a subagent", async () => {
    const w = world();
    const bad = [
        { type: "agent.start", runtime: "local", task: "  ", target: { kind: "tab", tabId: TAB } },
        { type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB }, maxSteps: 0 },
        { type: "agent.start", runtime: "local", task: "go", target: { kind: "tab" } },
        { type: "agent.start", runtime: "local", task: "go" },
    ];
    for (const c of bad) assert.equal(code(await w.run(c)), "invalid", JSON.stringify(c.target));
    assert.equal(code(await w.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB }, lineage: { parent: sid("aaaa0001") } })), "unsupported");
    assert.equal(w.named("startAgent").length, 0);
});

test("a session started from a command is kept, unless it asked to be ephemeral", async () => {
    const w = world();
    await w.run({ type: "chat.start", runtime: "local", text: "hello" });
    assert.deepEqual(w.named("keepSession")[0], ["keepSession", "beef0001"], "a chat is kept");

    await w.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB } });
    assert.deepEqual(w.named("keepSession")[1], ["keepSession", "ab120001"], "and so is a run");

    await w.run({ type: "chat.start", runtime: "local", text: "hello", ephemeral: true });
    await w.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB }, ephemeral: true });
    assert.equal(w.named("keepSession").length, 2, "nothing was kept for the ephemeral ones");

    // A start that failed has no session to keep.
    const refused = world({ startAgent: async () => ({ outcome: "none" }) });
    await refused.run({ type: "agent.start", runtime: "local", task: "go", target: { kind: "tab", tabId: TAB } });
    assert.equal(refused.named("keepSession").length, 0);
});


// --- what a runtime says about itself, and what it answers to (slice 6 groundwork) ---

test("runtime.info answers what a transport cannot know, and its own clock with it", async () => {
    const w = world();
    const r = await w.run({ type: "runtime.info", runtime: "local" });
    assert.equal(r.ok, true);
    assert.equal(r.data.kind, "browser");
    assert.equal(r.data.contractVersion, SESSION_CONTRACT_VERSION);
    assert.deepEqual(r.data.capabilities, { chat: true, agent: true, tabs: true });
    // The RUNTIME's clock at the moment it answered: the round trip is what bounds the offset estimated from it.
    assert.equal(r.data.nowMs, 42);

    // It needs only `view`, so a client that may watch but not drive can still tell what it is looking at.
    assert.equal((await world().run({ type: "runtime.info", runtime: "phone" })).error.code, "not-found");
});

test("a runtime keeps answering to the id it had before it was paired", async () => {
    // Over a hub this browser is its principal, not "local". A page open across that change, and a session key kept
    // on disk, name the old id — and a runtime that answered only to its newest name would turn both into a session
    // on a runtime that never existed.
    const w = world({ runtime: "beef".repeat(16), ownsRuntime: (id) => id === "beef".repeat(16) || id === "local" });
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });

    assert.equal(code(await w.run({ type: "runtime.info", runtime: "local" })), "ok", "the old name still reaches it");
    assert.equal(code(await w.run({ type: "runtime.info", runtime: "beef".repeat(16) })), "ok");
    assert.equal(code(await w.run({ type: "session.send", session: { runtime: "local", hash: "aaaa0001" }, text: "hi" })), "ok");

    // And not to anything else.
    assert.equal((await w.run({ type: "runtime.info", runtime: "phone" })).error.code, "not-found");
    assert.equal((await w.run({ type: "session.send", session: { runtime: "phone", hash: "aaaa0001" }, text: "hi" })).error.code, "not-found");
});


// --- paging a session's history, for a client whose subscription came back truncated ---

test("session.backfill pages a saved session's history upwards, newest page first", async () => {
    const w = world();
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    w.index.markSaved("aaaa0001");

    // No `before` is "from the end": the newest page.
    const last = await w.run({ type: "session.backfill", session: sid("aaaa0001") });
    assert.equal(last.ok, true);
    assert.equal(last.data.events.length, 40);
    assert.equal(last.data.from, 55, "a page ENDING at the last event");
    assert.equal(last.data.events[0].step, 56, "oldest-first within the page, so a client applies them in order");
    assert.equal(last.data.events.at(-1).step, 95);
    assert.equal(last.data.more, true);
    assert.equal(last.data.truncated, false);

    // A client pages by handing back the `from` it was given.
    const mid = await w.run({ type: "session.backfill", session: sid("aaaa0001"), before: last.data.from });
    assert.equal(mid.data.from, 15);
    assert.equal(mid.data.events[0].step, 16);
    assert.equal(mid.data.more, true);

    // The last page is short, and says there is nothing below it.
    const first = await w.run({ type: "session.backfill", session: sid("aaaa0001"), before: mid.data.from });
    assert.equal(first.data.events.length, 15);
    assert.equal(first.data.from, 0);
    assert.equal(first.data.events[0].step, 1);
    assert.equal(first.data.more, false);
    assert.equal(first.data.truncated, false, "the runtime has the whole history; nothing is missing");
});

test("a session this runtime does not KEEP says its history is gone, rather than answering with nothing", async () => {
    // The only copy was the ring, which the subscription already served. A client given an empty page with no
    // `truncated` would wait for a page that is never coming.
    const w = world();
    w.index.ingest(start("aaaa0002"), { tabId: TAB, trusted: true });

    const r = await w.run({ type: "session.backfill", session: sid("aaaa0002") });
    assert.deepEqual(r.data.events, []);
    assert.equal(r.data.truncated, true);
    assert.equal(r.data.more, false);
    assert.equal(w.named("storedEvents").length, 0, "and it did not go to disk for a session it does not keep");
});

test("session.backfill caps the page whatever is asked, and refuses a position that is not one", async () => {
    const w = world();
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    w.index.markSaved("aaaa0001");

    // A page holds screenshots, so the cap is a size decision wearing a count.
    assert.equal((await w.run({ type: "session.backfill", session: sid("aaaa0001"), limit: 5000 })).data.events.length, 40);
    assert.equal((await w.run({ type: "session.backfill", session: sid("aaaa0001"), limit: 3 })).data.events.length, 3);
    assert.equal((await w.run({ type: "session.backfill", session: sid("aaaa0001"), limit: 0 })).data.events.length, 1);

    // Past the end is not an error: a client that asked before the runtime wrote its newest events was early, not wrong.
    const past = await w.run({ type: "session.backfill", session: sid("aaaa0001"), before: 10_000 });
    assert.equal(past.data.events.at(-1).step, 95);

    assert.equal((await w.run({ type: "session.backfill", session: sid("aaaa0001"), before: -1 })).error.code, "invalid");
    assert.equal((await w.run({ type: "session.backfill", session: sid("aaaa0001"), before: 1.5 })).error.code, "invalid");
    assert.equal((await w.run({ type: "session.backfill", session: sid("ffff0000") })).error.code, "not-found");
});

test("a runtime that keeps no history at all says unsupported, not empty", async () => {
    const w = world({ storedEvents: undefined });
    w.index.ingest(start("aaaa0001"), { tabId: TAB, trusted: true });
    w.index.markSaved("aaaa0001");
    assert.equal((await w.run({ type: "session.backfill", session: sid("aaaa0001") })).error.code, "unsupported");
});


test("tab.focus brings a tab and its WINDOW forward, and only a tab tabs.list would have shown", async () => {
    const w = world();
    assert.deepEqual(await w.run({ type: "tab.focus", runtime: "local", tabId: TAB }), { ok: true, data: {} });
    const [, tabId, windowId] = w.named("focusTab")[0];
    assert.equal(tabId, TAB);
    assert.equal(windowId, 1, "the window too: an active tab in a window nobody is looking at is not what was asked");

    // A browser page is not in `tabs.list`, so a client could only have GUESSED its id — and `forbidden` would
    // confirm it exists. `not-found` says the truth from where the client stands.
    const chrome = world({ getTab: async () => ({ tabId: 9, url: "chrome://settings", title: "s", active: false, windowId: 1 }) });
    assert.equal((await chrome.run({ type: "tab.focus", runtime: "local", tabId: 9 })).error.code, "not-found");
    assert.equal(chrome.named("focusTab").length, 0);

    assert.equal((await w.run({ type: "tab.focus", runtime: "local", tabId: 404 })).error.code, "not-found");
    assert.equal((await w.run({ type: "tab.focus", runtime: "local", tabId: 1.5 })).error.code, "invalid");
    assert.equal((await w.run({ type: "tab.focus", runtime: "phone", tabId: TAB })).error.code, "not-found");

    // Closed between the check and the focus.
    const gone = world({ focusTab: async () => false });
    assert.equal((await gone.run({ type: "tab.focus", runtime: "local", tabId: TAB })).error.code, "not-found");
});
