// mobile-list.test.mjs — how the phone app's session list is ordered (mobile/src/format.ts): the runtimes you can drive
// first, what waits on you pinned above them, and the words a row uses for a status. Pure, so no emulator is involved.
import { test } from "node:test";
import assert from "node:assert/strict";

const { ago, approvalsPending, byPinned, needsYou, sections, seen, when, STATUS_LABEL, STATUS_TONE } = await import("../mobile/src/format.ts");

const EVERY = [{ scope: "control" }];
const rt = (id, extra = {}) => ({ id, name: id, kind: "browser", online: true, contractVersion: 1, grants: EVERY, capabilities: {}, ...extra });
const ses = (runtime, hash, extra = {}) => ({
    id: { runtime, hash }, kind: "chat", status: "done", title: hash, createdTs: 0, lastTs: Date.now(), pendingApprovals: 0, ...extra,
});

test("runtimes you can drive come first, then the ones you watch, then the offline", () => {
    const runtimes = [rt("offline", { online: false }), rt("watch", { grants: [{ scope: "view" }] }), rt("drive")];
    assert.deepEqual(sections(runtimes, []).map((s) => s.runtime.id), ["drive", "watch", "offline"]);
});

test("a section holds its runtime's recent sessions, newest first, and counts the rest as older", () => {
    const now = Date.now();
    const old = now - 60 * 24 * 3600_000;
    const s = sections([rt("a")], [ses("a", "1", { lastTs: now - 1000 }), ses("a", "2", { lastTs: now }), ses("a", "3", { lastTs: old })], now)[0];
    assert.deepEqual(s.data.map((x) => x.id.hash), ["2", "1"]);
    assert.equal(s.older, 1);
    // A run that is still going is never "older", however long it has been at it.
    const busy = sections([rt("a")], [ses("a", "3", { lastTs: old, status: "running" })], now)[0];
    assert.deepEqual(busy.data.map((x) => x.id.hash), ["3"]);
    assert.equal(busy.older, 0);
});

test("what needs you is every session with an approval waiting, newest first, whichever runtime it is on", () => {
    const now = Date.now();
    const list = [
        ses("a", "quiet"),
        ses("b", "older-gate", { status: "waiting", pendingApprovals: 1, lastTs: now - 5000 }),
        ses("a", "newer-gate", { status: "waiting", pendingApprovals: 2, lastTs: now }),
    ];
    assert.deepEqual(needsYou(list).map((x) => x.id.hash), ["newer-gate", "older-gate"]);
    assert.deepEqual(needsYou([ses("a", "quiet")]), [], "nothing waiting: nothing pinned");
});

test("a status says what it is in the page's words, and a tone every row can colour by", () => {
    assert.equal(STATUS_LABEL.waiting, "waiting on you");
    assert.equal(STATUS_LABEL.done, undefined, "a finished session says nothing: the row is the news");
    assert.equal(STATUS_TONE.running, "busy");
    assert.equal(STATUS_TONE.capped, "stopped", "a step cap is not a failure: it can go on");
    assert.equal(STATUS_TONE.error, "err");
});

test("a row waiting on you says so once, in the badge, worded as the web list words it", () => {
    // Not "1 approval pending": the badge's colour and its place in a list of runs already say what is pending,
    // and a phone's row has no width for the word. Kept in step with src/chat/chat-app.tsx by hand, like the
    // labels above, so the two lists read as the same list.
    assert.equal(approvalsPending(1), "1 pending");
    assert.equal(approvalsPending(3), "3 pending", "no plural to get wrong");
});

test("how long ago, as short as a row can hold", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    assert.equal(ago(now - 10_000, now), "now");
    assert.equal(ago(now - 5 * 60_000, now), "5m");
    assert.equal(ago(now - 3 * 3600_000, now), "3h");
    assert.equal(typeof seen(now - 90 * 60_000, now), "string");
});

test("when something happened reads on into the sentence after it", () => {
    const now = Date.UTC(2026, 8, 21, 12, 0, 0);
    assert.equal(when(now - 10_000, now), "just now");
    assert.equal(when(now - 5 * 60_000, now), "5m ago");
    assert.equal(when(now - 3 * 3600_000, now), "3h ago");
    assert.match(when(now - 2 * 86_400_000, now), /^on \w+/, "a day or more reads as a date, never \"Sun ago\"");
    // `seen` says the word itself, for a line that begins with it; `when` never does.
    assert.match(seen(now - 5 * 60_000, now), /^seen /);
    assert.doesNotMatch(when(now - 5 * 60_000, now), /seen/);
});

// The phone's model shortlist (mobile/src/pinned-models.ts). Pure, so the sort is checked without AsyncStorage.
test("pinned models: this device's shortlist first, then the rest, each alphabetical", () => {
    const m = (id) => ({ id });
    const all = [m("qwen3:32b"), m("gemma3:27b"), m("llama3:8b")];
    const ids = (list) => list.map((x) => x.id);
    // Nothing pinned: plain alphabetical, so a device with no opinion sees no reordering.
    assert.deepEqual(ids(byPinned(all, (x) => x.id, new Set())), ["gemma3:27b", "llama3:8b", "qwen3:32b"]);
    // Several pins, sorted among themselves rather than by when each was pinned.
    assert.deepEqual(ids(byPinned(all, (x) => x.id, new Set(["qwen3:32b", "llama3:8b"]))), ["llama3:8b", "qwen3:32b", "gemma3:27b"]);
    // A pin for a model this runtime does not offer simply does not appear — it is not an error, and it is kept.
    assert.deepEqual(ids(byPinned(all, (x) => x.id, new Set(["gone:70b"]))), ["gemma3:27b", "llama3:8b", "qwen3:32b"]);
    // The input is not mutated: the sheet sorts a list it does not own.
    assert.deepEqual(ids(all), ["qwen3:32b", "gemma3:27b", "llama3:8b"]);
});

test("a session's id is copied as the HASH, not as this client's key", () => {
    // `key` is `runtime:hash`, which names the session to this client and to nothing else: pasted into
    // `ml.resumeChat` or a `#/s/` link on the machine itself, the runtime prefix is wrong. Split on the LAST colon,
    // because a runtime id may contain one.
    const bare = (key) => key.slice(key.lastIndexOf(":") + 1);
    assert.equal(bare("laptop:3f9a0c21bbccddee0011223344556677"), "3f9a0c21bbccddee0011223344556677");
    assert.equal(bare("hub:eu-1:7b21d4e8"), "7b21d4e8", "a runtime id may hold a colon of its own");
    assert.equal(bare("7b21d4e8"), "7b21d4e8", "and a bare hash is already one");
});
