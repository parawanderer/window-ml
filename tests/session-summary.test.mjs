// session-summary.test.mjs — the session summary page (src/chat/session-summary.tsx, docs/spec/SESSION_SUMMARY.md): the
// summary tab's lines, where a field with no source draws no line, and the sidebar's leased session store
// (src/sidebar/session-menu.tsx), which opens its port through services() and closes it with the last holder.
import { test } from "node:test";
import assert from "node:assert/strict";

// The session list FIRST, as a page loads it (the gallery did): the page's status words once came through an import
// cycle from it, and loaded in this order they were still undefined, so the state line went missing.
await import("../src/chat/session-list.tsx");
const { summaryLines } = await import("../src/chat/session-summary.tsx");
const { STATUS_LABEL } = await import("../src/chat/status-words.ts");

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const rt = (over = {}) => ({ id: "local", name: "This browser", kind: "browser", online: true, contractVersion: 1, capabilities: {}, grants: [], ...over });
const row = (over = {}) => ({ id: { runtime: "local", hash: "a1b2c3d4" }, kind: "agent", status: "done", createdTs: NOW - 3_600_000, lastTs: NOW - 120_000, pendingApprovals: 0, saved: true, ...over });
const keys = (lines) => lines.map((l) => l.key);
const val = (lines, key) => lines.find((l) => l.key === key)?.value;

// --- every status has words, and the list's words are the page's ---

test("every SessionStatus draws a state line; the list's own words are reused, and running and done have theirs", () => {
    const ALL = ["running", "waiting", "done", "error", "cancelled", "capped", "interrupted"];
    for (const status of ALL) {
        const v = val(summaryLines(row({ status }), rt(), NOW), "state");
        assert.ok(v, `${status} draws a state`);
        if (STATUS_LABEL[status]) assert.equal(v, STATUS_LABEL[status]);
    }
    assert.equal(val(summaryLines(row({ status: "running" }), rt(), NOW), "state"), "running");
    assert.equal(val(summaryLines(row({ status: "done" }), rt(), NOW), "state"), "finished");
});

// --- a field with no source draws no line ---

test("a row with only the required fields draws state, last activity, kind, runtime and started, and nothing else", () => {
    assert.deepEqual(keys(summaryLines(row(), rt(), NOW)), ["state", "last", "kind", "runtime", "started"]);
});

test("an unknown model (null or absent), no page, no starter and zero asks each draw no line, never a zero, a dash or 'none'", () => {
    for (const model of [null, undefined, ""]) {
        const lines = summaryLines(row({ model }), rt(), NOW);
        assert.ok(!keys(lines).includes("model"), `model ${model} draws nothing`);
        for (const l of lines) assert.doesNotMatch(l.value, /^(—|-|none|unknown|0)$/i, `${l.key} is not a placeholder`);
    }
    assert.ok(!keys(summaryLines(row({ pendingApprovals: 0 }), rt(), NOW)).includes("asks"));
    assert.doesNotMatch(val(summaryLines(row(), rt(), NOW), "started"), /by/);
});

test("each present field draws its line: model, open asks, the start page labelled as the START page, who started it", () => {
    const lines = summaryLines(row({ model: "qwen3:32b", pendingApprovals: 2, page: { url: "https://x.example/", title: "X" }, startedBy: { id: "p", kind: "device", name: "Phone" } }), rt(), NOW);
    assert.equal(val(lines, "model"), "qwen3:32b");
    assert.equal(val(lines, "asks"), "2 pending");
    assert.equal(lines.find((l) => l.key === "page").label, "Started on");
    assert.match(val(lines, "page"), /X — https:\/\/x\.example\//);
    assert.match(val(lines, "started"), /, by Phone$/);
    assert.equal(val(summaryLines(row({ kind: "chat" }), rt(), NOW), "kind"), "Chat");
    assert.equal(val(summaryLines(row(), rt({ online: false, name: "Desk" }), NOW), "runtime"), "Desk (offline)");
});

test("a runtime's timestamps are put on this client's clock before they are aged", () => {
    // The runtime's clock runs 60 s ahead: its lastTs of NOW-60s is NOW-120s here.
    assert.equal(val(summaryLines(row({ lastTs: NOW - 60_000 }), rt({ clockOffsetMs: 60_000 }), NOW), "last"), "2m ago");
    assert.equal(val(summaryLines(row({ lastTs: NOW - 60_000 }), rt(), NOW), "last"), "1m ago");
    // A runtime clock ahead of this one never ages a session into the future.
    assert.equal(val(summaryLines(row({ lastTs: NOW + 5_000 }), rt(), NOW), "last"), "0s ago");
});

// --- the sidebar's leased store: one port through services(), closed with the last holder ---

test("the sidebar's session store opens one port through services() and closes it when the last holder releases", async () => {
    const { installServices, services } = await import("../src/sidebar/services.ts");
    const { acquireSessionStore, releaseSessionStore, sessionLease } = await import("../src/sidebar/session-menu.tsx");
    const before = services();
    let opened = 0, closed = 0;
    const port = () => { opened++; return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() { closed++; } }; };
    try {
        installServices({ ...before, connectSessions: null });
        assert.equal(acquireSessionStore(), null, "a surface with no sessions port gets no store");
        assert.equal(sessionLease(), null);
        installServices({ ...before, connectSessions: port });
        const a = acquireSessionStore(), b = acquireSessionStore();
        assert.ok(a && a === b, "two headers share one store");
        assert.equal(opened, 1);
        releaseSessionStore();
        assert.equal(closed, 0, "a holder remains");
        releaseSessionStore();
        assert.equal(closed, 1, "the last holder closes the port");
        assert.equal(sessionLease(), null);
        acquireSessionStore();
        assert.equal(opened, 2, "a later header opens a fresh one");
        releaseSessionStore();
    } finally { installServices(before); }
});
