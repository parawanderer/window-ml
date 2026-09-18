// The local runtime's commands (src/session-commands.ts) against a real SessionIndex and recorded dependencies: which
// existing path each command takes, and which contract error it answers with when it cannot (docs/spec/SESSION_CONTRACT.md
// §Commands).
import test from "node:test";
import assert from "node:assert/strict";
import { SessionIndex } from "../src/session-index.ts";
import { createCommandHandler, imageSize, dataUrlBytes, SIDE_CALL_MAX_TOKENS } from "../src/session-commands.ts";

const TAB = 7;
const ev = (hash, kind, over = {}) => ({ kind, id: hash, ts: 1, save: false, session: { hash, turn: 0 }, ...over });
const start = (hash) => ev(hash, "agent", { task: "t", model: "m", maxSteps: 3, config: null });
const sid = (hash, runtime = "local") => ({ runtime, hash });

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
/** A PNG header with a given size (enough bytes for the size to be read). */
const png = (w, h, pad = 0) => "data:image/png;base64," + b64([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, w >>> 24, (w >> 16) & 255, (w >> 8) & 255, w & 255, h >>> 24, (h >> 16) & 255, (h >> 8) & 255, h & 255, 8, 6, 0, 0, 0, ...new Array(pad).fill(0)]);
/** A JPEG with an APP0 segment before its frame header. */
const jpeg = (w, h) => "data:image/jpeg;base64," + b64([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);

/** A handler over a fresh index, with every dependency recorded and scriptable. */
function world(over = {}) {
    const index = new SessionIndex({ runtime: "local", spawn: "w1" });
    const calls = [];
    const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return typeof ret === "function" ? ret(...args) : ret; };
    const deps = {
        runtime: "local", index,
        removeFromIndex: rec("remove", (id) => index.remove(id.hash)),
        listTabs: rec("listTabs", async () => [{ tabId: TAB, url: "https://a.example/", title: "A", active: true, windowId: 1 }]),
        getTab: rec("getTab", async (id) => (id === TAB ? { tabId: TAB, url: "https://a.example/", title: "A", active: true, windowId: 1 } : null)),
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
        startAgent: rec("startAgent", async () => ({ outcome: "started", hash: "ab120001" })),
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
