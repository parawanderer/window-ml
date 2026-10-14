// event-admission.test.mjs — which session events a page may add to a session the worker speaks for
// (src/event-admission.ts, docs/spec/SITE_ACCESS.md attacks 15 and 16). The shell and the worker each apply it; the
// end-to-end proof that they do is tests/e2e/site-access.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { pageMayWrite, eventSession, WORKER_ONLY_KINDS } = await import("../src/event-admission.ts");

/** Every event kind the contract defines, read from it, so a kind added later is decided here too rather than missed. */
const KINDS = [...new Set([...readFileSync(new URL("../src/contract/contract-debug.ts", import.meta.url), "utf8").matchAll(/kind: "([a-z-]+)"/g)].map((m) => m[1]))];
// Not `agent-say`: the worker shows every turn of a run it hosts itself, the site's with its name (SITE_ACCESS_SLICE3.md, Q2a).
const LIFECYCLE = new Set(["agent", "agent-result"]);
/** The kinds only the worker writes about a site's agent (the start card, its outcome, the site's turns, its wait). */
const WORKER_ONLY = new Set(["agent-start-ask", "agent-start-decided", "agent-site", "agent-wait", "agent-site-say", "agent-note"]);

// --- what a page may add ---

test("the contract's event kinds were found, so the tables below cover something", () => {
    assert.ok(KINDS.length >= 10, KINDS.join(","));
    for (const k of LIFECYCLE) assert.ok(KINDS.includes(k), k);
});

test("a session the worker has not spoken for is the page's: every kind is admitted but the worker's own notices", () => {
    for (const k of KINDS) assert.equal(pageMayWrite(k, "none"), !WORKER_ONLY.has(k), k);
});

test("a page writes none of the worker's notices about a site's agent, whatever the claim: no start card, outcome, site mark, site turn, wait or note", () => {
    assert.deepEqual([...WORKER_ONLY_KINDS].sort(), [...WORKER_ONLY].sort(), "the module's list is the reviewed one");
    for (const k of WORKER_ONLY) {
        assert.ok(KINDS.includes(k), `${k} is a contract kind`);
        for (const claim of ["none", "hosts", "owns"]) assert.equal(pageMayWrite(k, claim), false, `${k} ${claim}`);
    }
});

test("a run the worker built, or whose lifecycle it emits, takes nothing from the page", () => {
    for (const k of KINDS) assert.equal(pageMayWrite(k, "owns"), false, k);
    assert.equal(pageMayWrite(undefined, "owns"), false);
});

test("a run the worker hosts for the page that built it takes the page's start and result, and nothing else (not a follow-up: the worker shows those)", () => {
    for (const k of KINDS) assert.equal(pageMayWrite(k, "hosts"), LIFECYCLE.has(k), k);
});

test("a kind that is not a string is refused wherever the worker has a claim", () => {
    for (const k of [undefined, null, 3, {}, ["agent"]]) {
        assert.equal(pageMayWrite(k, "hosts"), false, String(k));
        assert.equal(pageMayWrite(k, "owns"), false, String(k));
    }
});

// --- which session an event names ---

test("an event's session is its session.hash, else its id, else none", () => {
    assert.equal(eventSession({ id: "a", session: { hash: "b" } }), "b", "the session wins over the id");
    assert.equal(eventSession({ id: "a" }), "a");
    for (const bad of [null, undefined, "x", {}, { id: 3 }, { session: { hash: 4 } }]) assert.equal(eventSession(bad), undefined, JSON.stringify(bad));
});
