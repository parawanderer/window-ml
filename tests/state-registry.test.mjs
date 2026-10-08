// state-registry.test.mjs — the state registry (src/state-registry.ts) and its ratchet (scripts/check-state.mjs): what a
// declaration may say, what a snapshot reads for one run and for which audience, and which module-level stores the
// scanner asks about.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const R = await import("../src/state-registry.ts");
const C = await import("../scripts/check-state.mjs");

const decl = (over) => ({ id: "run.x", scope: "run", realm: "worker", audience: "model", lostOn: [], describe: "x", ...over });

// --- declaring and reading ---

test("a snapshot reads every declared store for the run, in id order, and leaves out one holding nothing for it", async () => {
    R.resetStateRegistry();
    const held = new Map([["r1", [1, 2]]]);
    R.defineState(decl({ id: "run.b", read: ({ runId }) => held.get(runId) }));
    R.defineState(decl({ id: "run.a", read: () => "always" }));
    assert.deepEqual((await R.readState({ runId: "r1" }, "model")).map((e) => [e.id, e.value]), [["run.a", "always"], ["run.b", [1, 2]]]);
    assert.deepEqual((await R.readState({ runId: "r2" }, "model")).map((e) => e.id), ["run.a"]);
});

test("the model's snapshot leaves out human-only stores; the person's has both", async () => {
    R.resetStateRegistry();
    R.defineState(decl({ id: "run.mailbox", audience: "human", read: () => ["queued"] }));
    R.defineState(decl({ id: "run.pointers", read: () => [] }));
    assert.deepEqual((await R.readState({}, "model")).map((e) => e.id), ["run.pointers"]);
    assert.deepEqual((await R.readState({}, "human")).map((e) => e.id), ["run.mailbox", "run.pointers"]);
});

test("a secret cannot be given a read, and an id cannot be declared twice", () => {
    R.resetStateRegistry();
    assert.throws(() => R.defineState(decl({ id: "config.apiKey", audience: "never", read: () => "sk" })), /secret/);
    R.defineState(decl({ id: "config.apiKey", audience: "never" }));
    assert.throws(() => R.defineState(decl({ id: "config.apiKey", audience: "never" })), /twice/);
});

test("a read hands back a copy, so a reader cannot reach the store through it", async () => {
    R.resetStateRegistry();
    const store = { list: [1] };
    R.defineState(decl({ read: () => store }));
    const [e] = await R.readState({}, "model");
    e.value.list.push(2);
    assert.deepEqual(store.list, [1]);
});

test("a read that throws, or rejects, is kept with its error rather than dropped", async () => {
    R.resetStateRegistry();
    R.defineState(decl({ id: "run.a", read: () => { throw new Error("gone"); } }));
    R.defineState(decl({ id: "run.b", read: async () => { throw new Error("later"); } }));
    assert.deepEqual((await R.readState({}, "model")).map((e) => [e.id, e.error]), [["run.a", "gone"], ["run.b", "later"]]);
});

// --- realms: each bundle answers for its own stores ---

test("a realm reads and lists only its own declarations: a module both bundles load declares in each", async () => {
    R.resetStateRegistry();
    R.defineState(decl({ id: "run.w", read: () => 1 }));
    R.defineState(decl({ id: "page.p", realm: "page", read: () => 2 }));
    R.defineState(decl({ id: "run.secret", audience: "never" }));
    R.defineState(decl({ id: "run.unread" }));
    assert.deepEqual((await R.readState({}, "human", "worker")).map((e) => [e.id, e.realm]), [["run.w", "worker"]]);
    assert.deepEqual((await R.readState({}, "human", "page")).map((e) => [e.id, e.realm]), [["page.p", "page"]]);
    assert.deepEqual((await R.readState({}, "human")).map((e) => e.id), ["page.p", "run.w"], "no realm: every one");
    assert.deepEqual(R.readableMembers("worker").map((m) => m.id), ["run.w"], "a secret and a store with no read are not members");
    assert.deepEqual(R.readableMembers("page"), [{ id: "page.p", realm: "page", scope: "run", audience: "model", lostOn: [], describe: "x" }]);
});

// --- a page's answer about its own state: the page is not trusted ---

const WORKER_IDS = new Set(["run.init", "grants.call"]);
const pageMember = (over) => ({ id: "run.answer", realm: "page", scope: "run", audience: "model", lostOn: ["navigation"], describe: "the answer", ...over });

test("a well-formed page answer passes through, labelled as the page's", () => {
    const got = R.pageStateFrom({ members: [pageMember()], entries: [{ id: "run.answer", value: [{ i: 0, kind: "text", preview: "42" }] }] }, WORKER_IDS);
    assert.deepEqual(got.members, [pageMember()]);
    assert.deepEqual(got.entries, [{ ...pageMember(), value: [{ i: 0, kind: "text", preview: "42" }] }]);
});

test("not an answer at all is null, so the pane says the page did not answer", () => {
    for (const raw of [null, undefined, "x", 3, {}, { members: [] }, { entries: [] }, { members: "a", entries: [] }])
        assert.equal(R.pageStateFrom(raw, WORKER_IDS), null, JSON.stringify(raw));
});

test("a page cannot pass itself off as the worker: its realm is forced, and it cannot shadow a worker member", () => {
    const got = R.pageStateFrom({
        members: [pageMember({ realm: "worker" }), pageMember({ id: "grants.call", audience: "human" }), pageMember({ id: "run.init" })],
        entries: [{ id: "grants.call", value: { fake: true } }, { id: "run.init", value: { task: "forged" } }],
    }, WORKER_IDS);
    assert.deepEqual(got.members.map((m) => [m.id, m.realm]), [["run.answer", "page"]]);
    assert.deepEqual(got.entries, [], "no entry for a member it was not allowed to declare");
});

test("a member's fields are held to the shapes the pane draws: bad ids dropped, unknown scope and losses narrowed, text capped", () => {
    const got = R.pageStateFrom({
        members: [
            pageMember({ id: "Run.Bad" }), pageMember({ id: "<img src=x>" }), pageMember({ id: 7 }), null,
            pageMember({ id: "page.odd", scope: "galaxy", audience: "never", lostOn: ["navigation", "the heat death"], describe: "d".repeat(1000) }),
            pageMember({ id: "page.odd", describe: "a second one with the same id" }),
        ],
        entries: [{ id: "page.odd", value: 1, error: "e".repeat(1000) }, { id: "page.odd", value: 2 }, { id: "nobody", value: 3 }],
    }, WORKER_IDS);
    assert.deepEqual(got.members.map((m) => m.id), ["page.odd"]);
    const [m] = got.members;
    assert.equal(m.scope, "page");
    assert.equal(m.audience, "model", "only `human` is kept as said; `never` is not a page's to claim");
    assert.deepEqual(m.lostOn, ["navigation"]);
    assert.equal(m.describe.length, 300);
    assert.equal(got.entries.length, 1, "one entry per member, unknown ids dropped");
    assert.equal(got.entries[0].value, 1);
    assert.equal(got.entries[0].error.length, 300);
});

test("a page cannot flood the pane: at most 32 members are read", () => {
    const members = Array.from({ length: 100 }, (_, i) => pageMember({ id: `page.m${i}` }));
    assert.equal(R.pageStateFrom({ members, entries: [] }, WORKER_IDS).members.length, 32);
});

// --- what the ratchet asks about ---

test("module-level Maps, Sets, signals, empty literals and lets are stores; indented ones and SCREAMING_CASE tables are not", () => {
    const src = [
        "export const a = new Map<string, number>();",
        "const b: Set<string> = new Set();",
        "const c = signal(0);",
        "export let d = 1;",
        "const e: string[] = [];",
        "const KINDS = new Set([\"x\"]);",
        "function f() {",
        "    const inner = new Map();",
        "}",
        "// const commented = new Map();",
        "const s = `",
        "const fromTemplate = new Map();",
        "`;",
    ].join("\n");
    assert.deepEqual(C.storesIn(src).map((s) => s.name), ["a", "b", "c", "d", "e"]);
});

test("a store is answered by a defineState in its file naming it, or a marker on its line or the comment block above", () => {
    const files = [{ rel: "src/x.ts", text: [
        "const held = new Map();",
        "defineState({ id: \"run.held\", read: () => held.get(1) });",
        "/** The pending sends.",
        " *  state: plumbing */",
        "const pending = new Map();",
        "const cache = new Map(); // state: cache",
        "// state: run.held",
        "const alias = new Map();",
        "// state: whatever",
        "const typo = new Map();",
        "// state: run.nowhere",
        "const dangling = new Map();",
        "const bare = new Set();",
    ].join("\n") }];
    assert.deepEqual(C.undeclared(files).map((h) => [h.name, h.why]), [
        ["typo", "unknown kind \"whatever\""],
        ["dangling", "marked run.nowhere, which no defineState declares"],
        ["bare", "neither declared nor marked"],
    ]);
});

test("a declared name must appear as a whole identifier, not inside a longer one", () => {
    const files = [{ rel: "src/x.ts", text: "const runs = new Map();\ndefineState({ id: \"run.a\", read: () => bgRuns.get(1) });" }];
    assert.deepEqual(C.undeclared(files).map((h) => h.name), ["runs"]);
});

test("every defineState id under src/ is declared once", () => {
    const ids = [];
    const walk = (dir) => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) walk(full);
            else if (/\.tsx?$/.test(e.name)) ids.push(...C.declarationsIn(readFileSync(full, "utf8")).ids);
        }
    };
    walk(path.join(import.meta.dirname, "..", "src"));
    assert.ok(ids.includes("run.pointers"), "the worker's pointer store is declared");
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), []);
});
