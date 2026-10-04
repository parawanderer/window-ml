// archive-bridge.test.mjs — the PAGE's side of keeping a session in the app's archive
// (src/native/archive-bridge.ts): what a save actually sends, and what it does when one does not land.
//
// The app's half needs a device. This half does not, and it is the half carrying the idea: a save sends only the
// events past the highest history position the app has confirmed holding. Get that wrong in the forgiving direction
// and every save ships the whole session again, which is the cost the move to SQLite was for; get it wrong in the
// other and events are silently never stored.

import test from "node:test";
import assert from "node:assert/strict";

const { bridgeArchive } = await import("../src/native/archive-bridge.ts");

/** A bridge whose other end is a function you control: it records what was sent and answers when you say. */
function wired(answer = () => ({ ok: true })) {
    const sent = [];
    let settle;
    const a = bridgeArchive((m) => {
        sent.push(m);
        const r = answer(m);
        if (r) queueMicrotask(() => settle({ type: "archiveResult", id: m.id, ...r }));
    });
    settle = a.settle;
    return { sent, cache: a.cache };
}

const ev = (pos) => ({ pos, event: { kind: "chat", id: "x", ts: pos } });
const session = (events, over = {}) => ({
    v: 1, key: "laptop:abcd", feed: { epoch: "e", cursors: [1] }, events, earlier: null, truncated: false,
    summary: { id: { runtime: "laptop", hash: "abcd" }, kind: "chat", status: "done", createdTs: 1, lastTs: 2, pendingApprovals: 0 },
    ...over,
});

// --- what a save sends ---

test("the first save sends everything, and the next sends only what is past what the app holds", async () => {
    const w = wired((m) => (m.op === "save" ? { ok: true, held: 2 } : { ok: true }));
    await w.cache.save(session([ev(0), ev(1), ev(2)]));
    assert.deepEqual(w.sent[0].session.events.map((e) => e.pos), [0, 1, 2], "nothing was held, so all of it went");

    await w.cache.save(session([ev(0), ev(1), ev(2), ev(3), ev(4)]));
    assert.deepEqual(w.sent[1].session.events.map((e) => e.pos), [3, 4], "only the new ones");
});

test("a save still goes when there are no new events, because the summary and the feed moved", async () => {
    // A renamed session has to be listed under its new title, and a reconnect resumes from the feed position. Both
    // ride the same message, so "nothing new to store" is not "nothing to say".
    const w = wired((m) => (m.op === "save" ? { ok: true, held: 1 } : { ok: true }));
    await w.cache.save(session([ev(0), ev(1)]));
    await w.cache.save(session([ev(0), ev(1)], { truncated: true }));
    assert.equal(w.sent.length, 2);
    assert.deepEqual(w.sent[1].session.events, [], "no events, and it was sent anyway");
    assert.equal(w.sent[1].session.truncated, true);
});

test("an event with no history position is never sent: it could not be placed", async () => {
    // A runtime that cannot say where an event sits leaves a copy unable to say where it begins, which is the one
    // thing the archive's positions exist to prevent.
    const w = wired((m) => (m.op === "save" ? { ok: true, held: 0 } : { ok: true }));
    await w.cache.save(session([ev(0), { event: { kind: "chat", id: "x", ts: 9 } }]));
    assert.deepEqual(w.sent[0].session.events.map((e) => e.pos), [0]);
});

// --- when a save does not land ---

test("a failed save leaves the mark alone, so the next one re-sends what did not arrive", async () => {
    let fail = true;
    const w = wired((m) => {
        if (m.op !== "save") return { ok: true };
        if (fail) { fail = false; return { ok: false, error: "no room" }; }
        return { ok: true, held: 1 };
    });
    await assert.rejects(w.cache.save(session([ev(0), ev(1)])), /no room/);
    await w.cache.save(session([ev(0), ev(1)]));
    assert.deepEqual(w.sent[1].session.events.map((e) => e.pos), [0, 1], "both again, because neither was confirmed");
});

test("a load says where the copy got to, so the save after it sends only what is newer", async () => {
    const kept = session([ev(0), ev(1), ev(2)]);
    const w = wired((m) => (m.op === "load" ? { ok: true, session: kept } : { ok: true, held: 2 }));
    const got = await w.cache.load("laptop:abcd");
    assert.deepEqual(got.events.map((e) => e.pos), [0, 1, 2]);
    await w.cache.save(session([ev(0), ev(1), ev(2), ev(3)]));
    assert.deepEqual(w.sent[1].session.events.map((e) => e.pos), [3], "the load seeded the mark");
});

test("dropping or clearing forgets the mark, so the session is sent whole again", async () => {
    const w = wired((m) => (m.op === "save" ? { ok: true, held: 1 } : { ok: true }));
    await w.cache.save(session([ev(0), ev(1)]));
    await w.cache.drop("laptop:abcd");
    await w.cache.save(session([ev(0), ev(1)]));
    assert.deepEqual(w.sent.at(-1).session.events.map((e) => e.pos), [0, 1]);
});
