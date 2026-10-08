// event-admission.test.mjs — which session events a page may add to a session the worker speaks for
// (src/event-admission.ts, docs/spec/SITE_ACCESS.md attacks 15 and 16). The shell and the worker each apply it; the
// end-to-end proof that they do is tests/e2e/site-access.spec.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const { pageMayWrite, eventSession } = await import("../src/event-admission.ts");

/** Every event kind the contract defines, read from it, so a kind added later is decided here too rather than missed. */
const KINDS = [...new Set([...readFileSync(new URL("../src/contract/contract-debug.ts", import.meta.url), "utf8").matchAll(/kind: "([a-z-]+)"/g)].map((m) => m[1]))];
const LIFECYCLE = new Set(["agent", "agent-say", "agent-result"]);

// --- what a page may add ---

test("the contract's event kinds were found, so the tables below cover something", () => {
    assert.ok(KINDS.length >= 10, KINDS.join(","));
    for (const k of LIFECYCLE) assert.ok(KINDS.includes(k), k);
});

test("a session the worker has not spoken for is the page's: every kind is admitted", () => {
    for (const k of KINDS) assert.equal(pageMayWrite(k, "none"), true, k);
});

test("a run the worker built, or whose lifecycle it emits, takes nothing from the page", () => {
    for (const k of KINDS) assert.equal(pageMayWrite(k, "owns"), false, k);
    assert.equal(pageMayWrite(undefined, "owns"), false);
});

test("a run the worker hosts for the page that built it takes the page's start, follow-up and result, and nothing else", () => {
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
