// A client that reduces several runtimes' events (the chat page, docs/spec/SESSION_CONTRACT.md) keys each session by
// `runtime:hash`: a hash is 8 hex and unique only within its runtime. The sidebar reduces one browser's sessions and
// keeps the bare hash, so nothing changes for it.
import test from "node:test";
import assert from "node:assert/strict";
import { onDebug } from "../src/sidebar/debug-reducer.ts";
import { sessionMap } from "../src/sidebar/store.ts";
import { bareHash, splitStepKey } from "../src/sidebar/services.ts";

const agentStart = (hash, task) => ({ kind: "agent", session: { hash }, ts: 1000, task, model: "m" });
const agentStep = (hash, step, seq) => ({ kind: "agent-step", session: { hash }, ts: 2000, step, seq, tool: "exec", arguments: {}, result: "ok" });

test("the same hash from two runtimes is two sessions, and a step lands in its own runtime's", () => {
    sessionMap.clear();
    onDebug(agentStart("abcd1234", "on the laptop"), "local");
    onDebug(agentStart("abcd1234", "on the other browser"), "rt-7f3a");
    onDebug(agentStep("abcd1234", 1, 1), "rt-7f3a");
    assert.equal(sessionMap.size, 2);
    const local = sessionMap.get("local:abcd1234"), remote = sessionMap.get("rt-7f3a:abcd1234");
    assert.equal(local?.task, "on the laptop");
    assert.equal(remote?.task, "on the other browser");
    assert.equal(local?.runtime, "local");
    assert.equal(remote?.hash, "rt-7f3a:abcd1234", "the session's key is what every session-keyed map uses");
    assert.equal(local?.steps?.length ?? 0, 0);
    assert.equal(remote?.steps?.length, 1);
});

test("an orphaned step waits for its start in its OWN runtime, not a same-hash session elsewhere", () => {
    sessionMap.clear();
    onDebug(agentStart("feed0001", "local run"), "local");
    onDebug(agentStep("feed0001", 1, 1), "rt-b");        // the remote start has not arrived yet
    assert.equal(sessionMap.get("local:feed0001")?.steps?.length ?? 0, 0, "not applied to the local session");
    onDebug(agentStart("feed0001", "remote run"), "rt-b");
    assert.equal(sessionMap.get("rt-b:feed0001")?.steps?.length, 1, "drained into the remote session once it started");
});

test("without a runtime the key is the bare hash, as the sidebar has always had it", () => {
    sessionMap.clear();
    onDebug(agentStart("0badf00d", "sidebar"));
    assert.ok(sessionMap.has("0badf00d"));
    assert.equal(sessionMap.get("0badf00d")?.runtime, undefined);
});

test("keys split on the LAST colon, since a session key may itself contain one", () => {
    assert.equal(bareHash("rt-7f3a:abcd1234"), "abcd1234");
    assert.equal(bareHash("abcd1234"), "abcd1234");
    assert.deepEqual(splitStepKey("rt-7f3a:abcd1234:12"), { session: "rt-7f3a:abcd1234", seq: 12 });
    assert.deepEqual(splitStepKey("abcd1234:3"), { session: "abcd1234", seq: 3 });
});

test("a resume note is a divider, not a move: it never rewrites where the run started", () => {
    sessionMap.clear();
    onDebug({ ...agentStart("abcd1234", "buy the thing"), pageUrl: "https://shop.example/item", pageTitle: "Item" }, "local");
    const note = { kind: "session-resumed", id: "abcd1234-r1", session: { hash: "abcd1234" }, ts: 5000, url: "https://unrelated.example/blank", fromUrl: "https://shop.example/item", afterMs: 172_800_000, dropped: ["the page's state object", "approval grants"] };
    onDebug(note, "local");

    const s = sessionMap.get("local:abcd1234");
    // `pageUrl` is where the run STARTED, which is what the export's schema promises and what the index's row says.
    // Moving it made run.json report the resume page with the original page's title, so a diff of two runs called a
    // resume a different experiment.
    assert.equal(s.pageUrl, "https://shop.example/item");
    assert.equal(s.resumes.length, 1);
    assert.equal(s.resumes[0].url, "https://unrelated.example/blank", "where it resumed is the field that means that");
    assert.deepEqual(s.resumes[0].dropped, ["the page's state object", "approval grants"]);

    // The same note again is the same resume: both sides can report one, and events repeat around a reconnect.
    onDebug(note, "local");
    assert.equal(s.resumes.length, 1);
    // A different resume is its own divider.
    onDebug({ ...note, id: "abcd1234-r2", ts: 9000, url: "https://third.example/" }, "local");
    assert.equal(sessionMap.get("local:abcd1234").resumes.length, 2);
});
