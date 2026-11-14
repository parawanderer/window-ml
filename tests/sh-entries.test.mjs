// sh-entries.test.mjs — a step's answered ml.sh calls as one list of entries: what is a script, what order they came in,
// whose duration is whose, and what is never an entry (a call still waiting on the person).
"use strict";
import { test } from "node:test";
import assert from "node:assert/strict";
import { scriptOf, shEntries, shSummary } from "../src/shell/sh-entries.ts";

const ask = (id, state, over = {}) => ({ id, kind: "sh", state, raisedAt: 1000, facts: { argv: ["git", "status"] }, ...over });
const free = (argv, over = {}) => ({ program: argv[0], durationMs: 10, unasked: { by: "default", argv, outcome: { ran: "host-sandbox", envelope: { write: "none", exec: "program-only" }, asked: { write: "none", exec: "program-only" }, protectedChanged: [] } }, ...over });

// --- which calls are a script ---

test("a shell's -c argument is a script, newlines kept; anything else is not", () => {
    assert.equal(scriptOf(["bash", "-c", "echo a\necho b"]), "echo a\necho b");
    assert.equal(scriptOf(["/bin/sh", "-c", "ls"]), "ls");
    assert.equal(scriptOf(["bash", "-lc", "ls"]), "ls", "a cluster ending in c is the same flag");
    assert.equal(scriptOf(["bash", "-euc", "ls"]), "ls");
    assert.equal(scriptOf(["bash", "script.sh"]), null, "a script FILE is not a -c script");
    assert.equal(scriptOf(["bash", "-c"]), null, "a -c with nothing after it");
    assert.equal(scriptOf(["git", "-c", "x=y"]), null, "-c to another program means something else");
    assert.equal(scriptOf([]), null);
});

// --- what is an entry ---

test("a call still waiting is a gate, not an entry; every answered state is one", () => {
    const out = shEntries({ asks: [ask("a", "pending"), ask("b", "allowed", { answeredAt: 4000 }), ask("c", "denied", { answeredAt: 5000, note: "no" }), ask("d", "ended", { raisedAt: 6000 })] });
    assert.deepEqual(out.map((e) => [e.key, e.verdict]), [["b", "ran"], ["c", "denied"], ["d", "stopped"]]);
    assert.equal(out[1].note, "no");
    assert.match(out[0].said, /^allowed after 3 s/);
});

test("a call that ran without asking says who allowed it", () => {
    const [d, p] = shEntries({ shCalls: [free(["ls"]), { ...free(["find", "."]), unasked: { ...free(["find", "."]).unasked, by: "policy", policy: "tidy" } }] });
    assert.match(d.said, /built-in default/);
    assert.match(p.said, /the policy "tidy"/);
    assert.equal(d.how, "free");
});

// --- order, and whose duration is whose ---

test("with stamps the asked and the free calls are in the order they finished", () => {
    const out = shEntries({
        asks: [ask("a", "allowed", { answeredAt: 2000 })],
        shCalls: [free(["ls"], { endedAt: 1500 }), { program: "git", durationMs: 700, endedAt: 3000 }, free(["wc"], { endedAt: 4000 })],
    });
    assert.deepEqual(out.map((e) => e.program), ["ls", "git", "wc"], "the free ls finished before the asked git, which finished before the free wc");
    assert.equal(out[1].durationMs, 700, "the asked call took its own span's time");
});

test("two asked calls take their own spans, in the order they were answered", () => {
    const out = shEntries({
        asks: [ask("a", "allowed", { raisedAt: 1000, answeredAt: 2000 }), ask("b", "allowed", { raisedAt: 5000, answeredAt: 6000, facts: { argv: ["ls"] } })],
        shCalls: [{ program: "git", durationMs: 100, endedAt: 2500 }, { program: "ls", durationMs: 900, endedAt: 7000 }],
    });
    assert.deepEqual(out.map((e) => e.durationMs), [100, 900]);
});

test("a record with no stamps is in the order the worker listed the calls, and claims a duration only where the counts agree", () => {
    const old = shEntries({ asks: [ask("a", "allowed", { answeredAt: 2000 })], shCalls: [free(["ls"]), { program: "git", durationMs: 700 }] });
    assert.deepEqual(old.map((e) => e.program), ["ls", "git"], "the free call ran first, so it is first: the list of calls is the run's order, asked and free together");
    assert.equal(old[1].durationMs, 700, "one ask, one span without `unasked`: they pair");
    const unpaired = shEntries({ asks: [ask("a", "allowed", { answeredAt: 2000 }), ask("b", "allowed", { answeredAt: 3000 })], shCalls: [{ program: "git", durationMs: 700 }] });
    assert.equal(unpaired[0].durationMs, undefined, "two asks and one span: no time is put on a call it may not belong to");
});

// --- warnings are on the entry, not only inside it ---

test("a fact that warns, or a call killed past its memory, marks the entry", () => {
    const weak = shEntries({ shCalls: [free(["npm", "install"], { unasked: { by: "default", argv: ["npm", "install"], outcome: { ran: "host-sandbox", envelope: { write: "today", exec: "any" }, asked: { write: "roots", exec: "program-only" }, protectedChanged: [{ root: "/r", name: ".git/hooks/pre-commit", change: "created" }] } } })] });
    assert.equal(weak[0].warn, true);
    assert.equal(shEntries({ shCalls: [free(["ls"])] })[0].warn, false);
    assert.equal(shEntries({ shCalls: [free(["ls"], { killed: "oom" })] })[0].warn, true);
});

test("a call the person was asked about is not flagged for what was on the card they approved; a call that ran free is", () => {
    const facts = { argv: ["bash", "demo.sh"], program: { path: "/bin/bash", inRoot: false }, cwd: { path: "/w", inRoot: true }, env: { set: [], free: true }, secrets: [], paths: [], repo: { root: "/w", reasons: [] }, repoConfigRunsCode: false, effects: "unknown", described: false, why: ["bash has no program manifest"], runner: false, mode: "host", sandboxed: true, placement: "host-sandbox" };
    const [asked] = shEntries({ asks: [ask("a", "allowed", { answeredAt: 2000, facts })] });
    assert.ok(asked.facts.some((l) => l.warn), "the card's own `Does: unknown` still draws amber inside the row");
    assert.equal(asked.warn, false, "but it is not a flag on the row: they saw it before they said yes");
    assert.deepEqual(asked.flags, []);
    const [killed] = shEntries({ asks: [ask("a", "allowed", { answeredAt: 2000, facts })], shCalls: [{ program: "bash", durationMs: 5, killed: "oom", endedAt: 3000 }] });
    assert.deepEqual([killed.warn, killed.flags], [true, ["killed for running out of memory"]], "what happened after the answer is");
});

test("the summary counts calls, asked, free, denied and the ones to check", () => {
    const s = shSummary(shEntries({ asks: [ask("a", "allowed", { answeredAt: 2000 }), ask("b", "denied", { answeredAt: 3000 })], shCalls: [free(["ls"])] }));
    assert.deepEqual(s, { calls: 3, asked: 2, free: 1, denied: 1, warns: 0 });
});

test("entries follow the code's order even when a call that ran free came before the one that was asked, with or without stamps", () => {
    const calls = [free(["ls"], { endedAt: 100 }), { program: "git", durationMs: 5, endedAt: 200 }, free(["wc"], { endedAt: 300 })];
    const asks = [ask("a", "allowed", { answeredAt: 150 })];
    assert.deepEqual(shEntries({ asks, shCalls: calls }).map((e) => e.program), ["ls", "git", "wc"], "stamped");
    const bare = calls.map(({ endedAt, ...c }) => c);
    assert.deepEqual(shEntries({ asks, shCalls: bare }).map((e) => e.program), ["ls", "git", "wc"], "unstamped");
});
