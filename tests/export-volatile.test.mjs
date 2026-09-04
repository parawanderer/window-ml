"use strict";
// The DIFFING contract: VOLATILE_FIELDS + VOLATILE_PATTERNS, the published answer to "what changes between
// two runs of the same task without the run behaving differently".
//
// These were shipped with no tests, which is how the original gap got in: the list named
// `steps[].usage.genMs` but not `messages[].usage.genMs`, so a CHAT export — all messages, no steps — had
// nothing stripped but the envelope, and nobody would find out until their differ was full of noise.
//
// So the central test here is not "does the list contain X". It is: take two runs that differ ONLY in
// volatile ways, strip and canonicalize both, and assert nothing is left. That asserts COMPLETENESS, which
// is the property the list actually promises and the one a hand-written checklist cannot maintain.

import { test } from "node:test";
import assert from "node:assert";
const { VOLATILE_FIELDS, VOLATILE_PATTERNS, canonicalizeText } = await import("../src/export-schema.ts");
const { sessionToJson } = await import("../src/sidebar/export-json.ts");

/** Delete a published path (`a.b[].c`) from a document, walking `[]` as "every element". */
function strip(doc, path) {
    const parts = path.split(".");
    const walk = (node, i) => {
        if (node == null || i >= parts.length) return;
        const key = parts[i].replace("[]", "");
        const isArray = parts[i].endsWith("[]");
        const target = node[key];
        if (target === undefined) return;
        if (i === parts.length - 1) { delete node[key]; return; }
        if (isArray && Array.isArray(target)) for (const el of target) walk(el, i + 1);
        else walk(target, i + 1);
    };
    walk(doc, 0);
}

/** Strip every volatile field, then canonicalize every remaining string. */
function canonical(doc, sessionHash) {
    const out = JSON.parse(JSON.stringify(doc));
    for (const p of VOLATILE_FIELDS) strip(out, p);
    const scrub = (node) => {
        if (Array.isArray(node)) return node.map(scrub);
        if (node && typeof node === "object") {
            for (const [k, v] of Object.entries(node)) node[k] = scrub(v);
            return node;
        }
        return typeof node === "string" ? canonicalizeText(node, sessionHash) : node;
    };
    return scrub(out);
}

const usage = (p, c, ms) => ({ promptTokens: p, completionTokens: c, totalTokens: p + c, genMs: ms, evalMs: ms / 2, loadMs: 3, promptEvalMs: ms / 4 });

/**
 * The same agent run, twice. Everything that legitimately moves between two runs of one task moves here:
 * the session hash, every timestamp, the minted pointer id (and its copies in the answer and in the
 * `dereference` argument), the per-call latencies, and how long the tool took.
 */
const run = ({ hash, t0, token, ms }) => ({
    hash, kind: "agent", model: "gemma4:31b", tag: "session",
    createdTs: t0, lastTs: t0 + 9000, status: "ok", config: {}, turns: [],
    task: "total the amount column", maxSteps: 20,
    pageUrl: "https://example.com/sales", pageTitle: "Sales",
    steps: [
        { step: 1, seq: 1, ts: t0 + 1000, thought: "read the table", usage: usage(100, 20, ms) },
        { step: 1, seq: 2, ts: t0 + 2000, toolMs: ms, tool: "python_exec",
          arguments: { code: "df.sum()" }, result: `1840.55\n@tool:${token}`, token,
          streamOutput: "loading\n1840.55\n", streamMarks: [[0, t0 + 1500], [8, t0 + 1900]] },
        { step: 2, seq: 3, ts: t0 + 3000, tool: "dereference",
          arguments: { ref: `@tool:${token}` }, result: "1840.55" },
    ],
    answers: [{ text: `The total is 1840.55 (see @tool:${token}, from session ${hash})`, ts: t0 + 9000, atStep: 3, status: "ok" }],
    summary: "1840.55",
});

const A = { hash: "abc12345", t0: 1_700_000_000_000, token: "a39f599", ms: 41 };
const B = { hash: "ff00dd11", t0: 1_800_000_000_000, token: "b7c1e02", ms: 260 };

test("two runs differing ONLY in volatile ways canonicalize to the same document", () => {
    const a = canonical(sessionToJson(run(A)), A.hash);
    const b = canonical(sessionToJson(run(B)), B.hash);
    assert.deepEqual(a, b,
        "something volatile is not covered — a differ following the published lists would report this as a behaviour change");
});

const chat = ({ hash, t0, ms }) => ({
    hash, kind: "chat", tag: "session", model: "gemma4:31b",
    createdTs: t0, lastTs: t0 + 5000, status: "ok", config: {}, steps: [],
    turns: [{ user: "hi", assistant: "hello", ts: t0 + 1000, status: "ok", usage: usage(5, 3, ms) }],
});

test("the same, for a CHAT export — the kind that has messages and no steps", () => {
    // This is the shape the original gap hid in: the volatile list named the step timings and not the
    // message ones, so a chat export kept every latency and diffed as though the model had behaved
    // differently.
    const a = canonical(sessionToJson(chat(A)), A.hash);
    const b = canonical(sessionToJson(chat(B)), B.hash);
    assert.deepEqual(a, b, "a chat export still carries volatile values after stripping");
});

test("the test can fail — a REAL behaviour difference survives canonicalization", () => {
    // Without this, both tests above would pass just as happily against a canonicalizer that deleted
    // everything. The point of the lists is to remove noise WITHOUT removing signal.
    const differs = { ...B };
    const b = sessionToJson(run(differs));
    b.session.steps[1].arguments.code = "df.mean()";   // the model did something different
    assert.notDeepEqual(canonical(sessionToJson(run(A)), A.hash), canonical(b, differs.hash),
        "a changed tool argument must survive canonicalization — otherwise the lists are stripping signal");
});

test("every published path actually occurs in one of the export shapes", () => {
    // A path that matches nothing is dead weight that reads as coverage, and it fails silently — stripping
    // a path that is not there succeeds. Checked against BOTH shapes together, since an agent export has
    // no per-message usage and a chat export has no steps; and the fixtures above must therefore exercise
    // every field the list names, which is the real discipline this imposes.
    const docs = [
        sessionToJson(run(A), { version: "1.0", build: { commit: "a".repeat(40), buildTime: "2026-09-03T11:46:52.846Z" } }),
        sessionToJson(chat(A)),
        // A LIVE snapshot: the only shape that carries open events, and therefore the only one in which
        // `elapsedMs` occurs at all.
        sessionToJson({ ...run(A), liveTurn: { step: 9, startedTs: A.t0 + 4000 } }, { includeInFlight: true }),
    ];
    const presentIn = (doc, path) => {
        const parts = path.split(".");
        const walk = (node, i) => {
            if (node == null) return false;
            if (i >= parts.length) return true;
            const key = parts[i].replace("[]", "");
            const target = node[key];
            if (target === undefined) return false;
            if (parts[i].endsWith("[]") && Array.isArray(target)) return target.some((el) => walk(el, i + 1));
            return walk(target, i + 1);
        };
        return walk(doc, 0);
    };
    const dead = VOLATILE_FIELDS.filter((p) => !docs.some((d) => presentIn(d, p)));
    assert.deepEqual(dead, [], `VOLATILE_FIELDS names paths that do not occur in a real export: ${dead.join(", ")}`);
});

test("canonicalizeText neutralises a pointer id wherever it appears in prose", () => {
    const text = 'The total is in @tool:a39f599, and I also read @tool:"the budget table".';
    const out = canonicalizeText(text);
    assert.ok(!out.includes("a39f599"), "a minted id must be replaced");
    assert.ok(out.includes('@tool:"the budget table"'), "a model-authored LABEL is stable, and must survive");
});

test("canonicalizeText leaves bare hex alone — it strips the KNOWN hash, not anything hex-shaped", () => {
    // The session hash is deliberately not a pattern: eight bare hex characters also describe a colour, a
    // short commit, or whatever the page happened to contain. Stripping those would mask real differences
    // while claiming to remove noise.
    const text = "background #deadbeef, commit c0ffee12, session abc12345";
    assert.equal(canonicalizeText(text), text, "with no hash given, nothing hex-shaped is touched");
    const scrubbed = canonicalizeText(text, "abc12345");
    assert.ok(scrubbed.includes("#deadbeef") && scrubbed.includes("c0ffee12"), "unrelated hex must survive");
    assert.ok(!scrubbed.includes("abc12345"), "the known session hash must go");
});

test("VOLATILE_PATTERNS is safe to apply repeatedly", () => {
    // A differ may canonicalize a document that was already canonicalized (a cached artifact, a re-run).
    const once = canonicalizeText("see @tool:a39f599", "abc12345");
    assert.equal(canonicalizeText(once, "abc12345"), once, "canonicalization must be idempotent");
    assert.ok(VOLATILE_PATTERNS.every((p) => p.pattern.global), "a non-global pattern would replace only the FIRST occurrence");
});
