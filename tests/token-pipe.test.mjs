"use strict";
// The POINTER layer behind `dereference`: what a @tool:<id> points at, what type it is, how stale it is, and
// the two type-level casts (latex / img) the line dialect can't express. The pipe language itself is
// text-pipe.ts and is tested there — these tests cover what a pointer knows that a bare string doesn't.
import { test } from "node:test";
import assert from "node:assert";
const P = await import("../token-pipe.ts");

const tok = (over = {}) => ({ id: "a1b2c3", tool: "exec", kind: "text", out: "hello", t: 1000, step: 1, ...over });
const TABLE = tok({ id: "bbb222", tool: "python_exec", kind: "table", step: 3,
    out: "name  qty\napples  3\npears  5",
    table: { columns: ["name", "qty", "price"], rows: [["apples", 3, 1.2], ["pears", 5, 0.9]] } });
const PNG = "data:image/png;base64," + "iVBORw0KGgoAAAANSUhEUg".repeat(400);

test("a TABLE pointer enters the pipe structurally — keys are its COLUMNS", () => {
    assert.deepEqual(JSON.parse(P.derefPipe(TABLE, "out", "keys")), ["name", "qty", "price"],
        "never re-parsed out of the rendered grid — the pointer carried the type");
    assert.deepEqual(JSON.parse(P.derefPipe(TABLE, "out", ".rows[0]")), ["apples", 3, 1.2]);
    assert.equal(P.derefPipe(TABLE, "out", ""), TABLE.out, "no pipe → the str-renderable form the model would read");
});

test("the :in slot reads the call, not the result", () => {
    const v = tok({ in: '{"js":"1+1"}' });
    assert.equal(P.derefPipe(v, "in", ""), '{"js":"1+1"}');
    assert.equal(P.derefPipe(v, "out", ""), "hello");
    assert.equal(P.TokenStore.slotOf("@tool:a1b2c3:in"), "in");
    assert.equal(P.TokenStore.slotOf("@tool:a1b2c3"), "out", "out is the default");
});

test("describeToken names what is at the pointer, for every kind", () => {
    assert.match(P.describeToken(tok({ out: "ab\ncd" })), /text, 5 chars \/ 2 lines/);
    assert.match(P.describeToken(tok({ kind: "json", out: '{"a":1}' })), /^JSON, 7 chars/);
    assert.match(P.describeToken(tok({ kind: "image" })), /an image/);
    assert.match(P.describeToken(tok({ kind: "code", out: "a\nb\nc" })), /code, 3 lines/);
    assert.match(P.describeToken(TABLE), /2x3 table \(name, qty, price\)/);
    // Many columns are elided — the description is a label, not the data.
    const wide = tok({ kind: "table", table: { columns: ["a", "b", "c", "d", "e", "f", "g"], rows: [] } });
    assert.match(P.describeToken(wide), /0x7 table \(a, b, c, d, e, f, …\)/);
});

// `img` must never dump the payload: tens of thousands of tokens with nothing in them the model can perceive.
test("img TRUNCATES, and says plainly that it is base64 image data", () => {
    const v = tok({ id: "img001", kind: "image", image: PNG, out: "Returned an image." });
    const out = P.derefPipe(v, "out", "img");
    assert.ok(out.length < 400, `truncated (${out.length} chars), not the ${PNG.length}-char payload`);
    assert.match(out, /base64 image data/i, "the model is told WHAT this string is");
    assert.match(out, /data: URL/, "…and that it is a data URL");
    assert.match(out, new RegExp(`${PNG.length} chars`), "with the real size, so it knows what it is not seeing");
    assert.match(out, /TRUNCATED/);
    assert.ok(out.includes("data:image/png;base64,iVBOR"), "enough prefix to identify the media type");
    assert.match(out, /!\[caption\]\(@tool:img001:out\)|look/, "and what to do instead of reading pixels as text");
    assert.throws(() => P.derefPipe(tok(), "out", "img"), /isn't an image/);
});

test("latex reads the symbolic form when there is one", () => {
    const v = tok({ kind: "text", latex: "x^{2} e^{x}", out: "x**2*exp(x)" });
    assert.equal(P.derefPipe(v, "out", "latex"), "x^{2} e^{x}");
    assert.throws(() => P.derefPipe(tok(), "out", "latex"), /no LaTeX form/);
});

test("a cast composes with the line dialect, but only as the FIRST stage", () => {
    const v = tok({ latex: "line one\nline two\nline three" });
    assert.equal(P.derefPipe(v, "out", "latex | head 1"), "line one", "the rest of the pipe runs over the cast result");
    // Later it would have nothing typed left to act on — refuse explicitly rather than reporting it as unknown.
    assert.throws(() => P.derefPipe(v, "out", "head 2 | latex"), /only works as the FIRST stage/);
    assert.throws(() => P.derefPipe(v, "out", "wc -l | img"), /only works as the FIRST stage/);
});

test("a failing stage throws an actionable message — the dialect's contract, all the way through", () => {
    // The line dialect's own refusals reach the caller unchanged through derefPipe.
    assert.throws(() => P.derefPipe(tok(), "out", "sort | jq .x"), /isn't a supported text command/);
    assert.throws(() => P.derefPipe(tok({ out: "prose" }), "out", "keys"), /needs JSON, but this is plain text/);
    assert.throws(() => P.derefPipe(TABLE, "out", ".nope"), /no key "nope"/);
});

test("TokenStore resolves a hex id, an @tool: reference, and a tool-name alias", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "aaa111", tool: "exec", out: "first", step: 1 }));
    s.note(tok({ id: "bbb222", tool: "python_exec", out: "older py", step: 2 }));
    s.note(tok({ id: "ccc333", tool: "python_exec", out: "newer py", step: 3 }));

    assert.equal(s.get("aaa111").out, "first");
    assert.equal(s.get("@tool:aaa111").out, "first", "the model writes the @tool: form it was shown");
    assert.equal(s.get("@tool:aaa111:out").out, "first", "a slot suffix doesn't break resolution");
    assert.equal(s.get("  aaa111 ").out, "first", "whitespace is forgiven");
    assert.equal(s.get("python_exec").out, "newer py", "a tool-name alias means the LATEST call of that tool");
    assert.equal(s.get("nope"), null, "an unresolvable reference is null, not a wrong guess");
    assert.deepEqual(s.all().map((v) => v.id), ["aaa111", "bbb222", "ccc333"], "oldest first");
});

// Models hallucinate token-SHAPED ids — six plausible hex characters that were never minted — so a bare
// "no such pointer" just invites another guess.
test("nearest() names the closest real pointers for a hallucinated id", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "a1b2c3", tool: "exec", step: 1 }));
    s.note(tok({ id: "d4e5f6", tool: "python_exec", step: 2 }));
    s.note(tok({ id: "9a8b7c", tool: "fetch_url", step: 3 }));

    // One character off — the intended pointer must rank first.
    assert.equal(s.nearest("a1b2c9")[0].id, "a1b2c3");
    assert.equal(s.nearest("@tool:a1b2c9:out")[0].id, "a1b2c3", "the @tool: form and slot are normalised away");
    // Half-remembered by TOOL rather than id.
    assert.equal(s.nearest("python")[0].id, "d4e5f6", "a near-miss on the tool name steers to that tool's output");
    assert.equal(s.nearest("fetchurl")[0].id, "9a8b7c");
    assert.equal(s.nearest("zzzzzz").length, 3, "always offers candidates rather than a dead end");
    assert.equal(s.nearest("zzzzzz", 1).length, 1, "…capped by the limit");
    assert.deepEqual(new P.TokenStore().nearest("a1b2c3"), [], "nothing captured → nothing to suggest");
});

test("editDistance underpins the ranking", () => {
    assert.equal(P.editDistance("abc", "abc"), 0);
    assert.equal(P.editDistance("a1b2c3", "a1b2c9"), 1);
    assert.equal(P.editDistance("", "abc"), 3);
});

// A pointer that doesn't resolve is usually a HALLUCINATED token-shaped id. The message is modelled on a memory
// fault because that is exactly what happened, and it is a concept the model already understands precisely.
test("memoryFault: names the fault, ranks the candidates, and says it is recoverable", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "af21d0", tool: "python_exec", step: 2 }));
    s.note(tok({ id: "bf21d0", tool: "exec", step: 1 }));
    const msg = P.memoryFault("@tool:af21e0", s.nearest("af21e0"), 4);

    assert.match(msg, /^MemoryFault: pointer '@tool:af21e0' does not exist\./, "the fault names the bad address");
    assert.match(msg, /Nearest valid pointers:/);
    // Distance from the CURRENT step, which is the actionable half ("2 steps back" beats "step 2").
    assert.match(msg, /- @tool:af21d0 \(2 steps back: python_exec\)\s+\[edit_dist=1\]/);
    assert.match(msg, /- @tool:bf21d0 \(3 steps back: exec\)\s+\[edit_dist=2\]/);
    // The candidate columns line up, so the list is scannable rather than ragged.
    const cols = msg.split("\n").filter((l) => l.includes("edit_dist")).map((l) => l.indexOf("[edit_dist"));
    assert.equal(new Set(cols).size, 1, "the edit_dist column is aligned across candidates");
    // Without this a model pattern-matching "fault" to a segfault may report a crash or abandon the task.
    assert.match(msg, /recoverable/i, "the fault says it can be retried");
    assert.match(msg, /re-run the tool if you need the data fresh/, "…and names the other valid recovery");
});

test("memoryFault: distinguishes a typo from an invented id", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "af21d0", tool: "python_exec", step: 2 }));
    // One character out — a typo. Don't tell the model it invented it.
    assert.doesNotMatch(P.memoryFault("af21e0", s.nearest("af21e0"), 3), /inventing the id/);
    // Nothing remotely like it — say so, because a fabricated pointer needs a different fix than a typo.
    assert.match(P.memoryFault("zzzzzz", s.nearest("zzzzzz"), 3), /None of these is close/);
    assert.match(P.memoryFault("zzzzzz", s.nearest("zzzzzz"), 3), /earlier turn or inventing the id/);
});

test("memoryFault: an empty run says there is nothing to point at yet", () => {
    const msg = P.memoryFault("@tool:abc123", new P.TokenStore().nearest("abc123"), 1);
    assert.match(msg, /^MemoryFault: pointer '@tool:abc123' does not exist\./);
    assert.match(msg, /Nothing has been captured in this run yet/);
    assert.match(msg, /Run a tool first/);
    assert.doesNotMatch(msg, /Nearest valid pointers/, "no empty candidate list");
});

// The pointer's headline benefit: it reaches the FULL capture, not the copy the model was already shown.
// Storing only the model-facing string would hand back what the model already has — useless, and it was the
// original bug (a real run dereferenced 7 times against a value truncated before the line it needed).
test("a pointer prefers the FULL capture over the model's truncated copy", () => {
    const full = Array.from({ length: 200 }, (_, i) => `row ${i + 1}: value`).join("\n");
    const shown = full.slice(0, 400) + "… [+3000 chars truncated]";
    const v = tok({ out: shown, full });

    assert.match(P.derefPipe(v, "out", "grep 'row 137:'"), /row 137: value/,
        "the line the model never saw is reachable");
    assert.equal(P.derefPipe(v, "out", ""), full, "no pipe → the full capture, not the clipped copy");
    assert.match(P.describeToken(v), new RegExp(`${full.length} chars`), "the description sizes the FULL value");
    // And the read says how much more it holds, so the model can tell the step was worth spending.
    assert.match(P.extraBeyondModel(v), /chars MORE than you were shown/);
    assert.match(P.extraBeyondModel(v), new RegExp(String(full.length - shown.length)));
    // When the model already has the whole thing, there is nothing extra to advertise.
    assert.equal(P.extraBeyondModel(tok({ out: "short" })), "");
    assert.equal(P.extraBeyondModel(tok({ out: "same", full: "same" })), "");
});

// --- ml.dereference: run-bound, on BOTH hosting paths ---------------------------------------------------
// The primitive is scoped by BINDING, not by a permission check: tool-exec binds a resolver for the duration
// of a tool call and restores it after, so it is live inside an approved exec and absent from a page's own
// console. These exercise that contract directly against the real tool-exec + agent-loop wiring.
const { executeTool, toolContext, currentDeref } = await import("../tool-exec.ts");

const fakeTool = (run) => ({ name: "exec", description: "", parameters: { type: "object", properties: {} }, run });

test("ml.dereference is LIVE inside a tool call and gone outside it", async () => {
    assert.equal(currentDeref(), null, "nothing is bound before any tool runs — a page console gets nothing");

    const ctx = toolContext({ exec: fakeTool(async () => "") });
    ctx.deref = async (ref, pipe) => `read ${ref}${pipe ? ` | ${pipe}` : ""}`;

    let sawInside = null;
    const tool = fakeTool(async () => {
        const fn = currentDeref();
        sawInside = fn ? await fn("@tool:abc123", "head 2") : null;
        return "done";
    });
    await executeTool(tool, {}, ctx);
    assert.equal(sawInside, "read @tool:abc123 | head 2", "bound to THIS run's resolver while the tool ran");
    assert.equal(currentDeref(), null, "and unbound again the moment the call returns");
});

test("the binding is restored after a nested call, and after a throwing one", async () => {
    const outer = toolContext({ a: fakeTool(async () => "") });
    outer.deref = async () => "outer";
    const inner = toolContext({ b: fakeTool(async () => "") });
    inner.deref = async () => "inner";

    let duringNested = null, afterNested = null;
    await executeTool(fakeTool(async () => {
        await executeTool(fakeTool(async () => { duringNested = await currentDeref()(""); return ""; }), {}, inner);
        afterNested = await currentDeref()("");
        return "";
    }), {}, outer);
    assert.equal(duringNested, "inner", "a nested run binds its own");
    assert.equal(afterNested, "outer", "…and the outer run's is restored");

    // executeTool catches a throwing tool; the binding must still be cleaned up.
    const boom = toolContext({ c: fakeTool(async () => "") });
    boom.deref = async () => "boom";
    const r = await executeTool(fakeTool(async () => { throw new Error("kaboom"); }), {}, boom);
    assert.match(r.result, /kaboom/);
    assert.equal(currentDeref(), null, "a throwing tool doesn't leak the binding");
});

test("the loop hands out a resolver bound to ITS OWN store (the page-hosted path)", async () => {
    const { runAgentLoop } = await import("../agent-loop.ts");
    let resolver = null;
    const full = Array.from({ length: 300 }, (_, i) => `row ${i + 1}: v${i + 1}`).join("\n");

    // One exec step that captures a big output, then the model answers. tokenSink hands us the resolver the
    // host would bind onto the ToolContext.
    const turns = [
        { content: "", tool_calls: [{ id: "1", name: "exec", arguments: { js: "x", token: true } }] },
        { content: "done", tool_calls: [] },
    ];
    let i = 0;
    await runAgentLoop("t", {
        tools: [{ name: "exec", description: "", parameters: { type: "object", properties: {} } }],
        maxSteps: () => 3, toolTokens: true, runHash: "abcdef", tokenSink: (fn) => { resolver = fn; },
    }, {
        callModel: async () => turns[i++] || { content: "" },
        runTool: async () => ({ result: full.slice(0, 200) + "… [+truncated]",
            renderOut: { type: "exec-out", stdout: full, seen: 200 } }),
        autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, call, result) => m.push({ role: "tool", tool_call_id: call.id, content: result }),
    });

    assert.equal(typeof resolver, "function", "the loop handed a resolver to the host");
    // It reads the FULL capture, not the truncated copy the model saw — the whole point.
    assert.match(resolver("@tool:exec", "grep 'row 297:'"), /row 297: v297/);
    // A bad pointer raises the same MemoryFault the tool returns, so exec and the tool behave identically.
    assert.throws(() => resolver("@tool:zzzzzz"), /MemoryFault: pointer '@tool:zzzzzz' does not exist/);
    assert.throws(() => resolver("@tool:zzzzzz"), /Nearest valid pointers/);
    // A bad pipe stage raises the dialect's own actionable error.
    assert.throws(() => resolver("@tool:exec", "jq .x"), /isn't a supported text command/);
});

test("pipeStages: a pipe resolves to STAGES — an array entry is one stage, never re-split", () => {
    assert.deepEqual(P.pipeStages([".rows", "head 5"]), [".rows", "head 5"]);
    assert.deepEqual(P.pipeStages(".rows | head 5"), [".rows", "head 5"], "a string splits on unquoted |");
    assert.deepEqual(P.pipeStages([" .rows ", "  head 5"]), [".rows", "head 5"], "entries are trimmed");
    // A conditionally-built array shouldn't produce an empty stage the dialect would then refuse.
    assert.deepEqual(P.pipeStages([".rows", "", null, "head 5"]), [".rows", "head 5"]);
    assert.deepEqual(P.pipeStages([]), []);
    assert.deepEqual(P.pipeStages(null), []);
    assert.deepEqual(P.pipeStages(undefined), []);
    // The point of the array form: a stage may hold a bare `|` (regex alternation) with NO quoting, and it
    // stays ONE stage. Splitting it would make "warn" a command — or, worse, silently run a real one.
    assert.deepEqual(P.pipeStages(["grep -E error|warn", "head 5"]), ["grep -E error|warn", "head 5"]);
    // The string form gets the same protection from quotes, which the splitter respects.
    assert.deepEqual(P.pipeStages("grep -E 'error|warn' | head 5"), ["grep -E 'error|warn'", "head 5"]);
});

test("displayPipe: joins for DISPLAY only, and never throws on a malformed pipe", () => {
    assert.equal(P.displayPipe([".rows", "head 5"]), ".rows | head 5");
    assert.equal(P.displayPipe(".rows | head 5"), ".rows | head 5");
    assert.equal(P.displayPipe(null), "");
    // Unterminated quotes are an EXECUTION error; a label still has to render.
    assert.equal(P.displayPipe("grep 'foo"), "grep 'foo");
    assert.doesNotThrow(() => P.displayPipe(["grep 'foo"]));
});

// REGRESSION. derefPipe used to split the pipe with a naive `split("|")` and then re-join the surviving
// stages with " | " for runPipe to split AGAIN. Both halves corrupted a regex alternation, and neither
// raised: `'error|warn'` came back EMPTY (reads as "no matches"), and `'head|tail'` came back with the
// result of grepping "head " and then running `tail` as its own stage — a plausible wrong answer.
test("derefPipe: a regex alternation survives — as a quoted string AND as an array stage", () => {
    const v = tok({ out: "head of report\nerror: disk full\nwarn: slow\ntail of report", full: "head of report\nerror: disk full\nwarn: slow\ntail of report" });
    assert.equal(P.derefPipe(v, "out", "grep -E 'error|warn'"), "error: disk full\nwarn: slow");
    assert.equal(P.derefPipe(v, "out", ["grep -E error|warn"]), "error: disk full\nwarn: slow", "array: no quoting needed at all");
    // The nastiest case: both alternatives are real command names, so the old code ran one of them silently.
    assert.equal(P.derefPipe(v, "out", "grep -E 'head|tail'"), "head of report\ntail of report");
    assert.equal(P.derefPipe(v, "out", ["grep -E head|tail"]), "head of report\ntail of report");
    // …and a genuine multi-stage pipe still behaves.
    assert.equal(P.derefPipe(v, "out", ["grep -E error|warn", "head 1"]), "error: disk full");
});

// A self-authored LABEL turns a hex address into a named variable — purely for the model's own recall.
test("labels: cleaned, capped, and shown BESIDE the derived description (never instead of it)", () => {
    assert.equal(P.cleanLabel("  the pricing  table \n"), "the pricing table", "collapsed and trimmed");
    assert.equal(P.cleanLabel("x".repeat(200)).length, P.LABEL_MAX, "capped — it's a memo, not prose");
    assert.equal(P.cleanLabel(""), undefined);
    assert.equal(P.cleanLabel(true), undefined, "`token: true` is an opt-in, not a label");
    assert.equal(P.cleanLabel(undefined), undefined);

    const named = tok({ label: "the pricing table" });
    assert.equal(P.nameOf(named), 'exec: "the pricing table"', "the model's own words name it");
    assert.equal(P.nameOf(tok()), "exec", "…and an unlabelled pointer is just its tool");
    // The label is a CLAIM the model wrote; the derived description is what the value actually IS. A read
    // shows both, so a pointer mislabelled "the full table" can't quietly misrepresent itself.
    assert.match(P.describeToken(named), /^text, \d+ chars/, "describeToken stays derived, never the label");
});

test("labels: nearest() finds a pointer by the NAME the model gave it", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "a1b2c3", tool: "python_exec", step: 1, label: "the pricing table" }));
    s.note(tok({ id: "d4e5f6", tool: "exec", step: 2, label: "nav links" }));

    // Recalling the name but inventing the id is the common failure — the label must rescue it.
    assert.equal(s.nearest("pricing")[0].id, "a1b2c3", "a substring of the label is an exact hit");
    assert.equal(s.nearest("the pricing table")[0].id, "a1b2c3");
    assert.equal(s.nearest("nav")[0].id, "d4e5f6");
    // And the fault message names pointers the way the model named them.
    const msg = P.memoryFault("@tool:zzzzzz", s.nearest("zzzzzz"), 4);
    assert.match(msg, /python_exec: "the pricing table"/);
    assert.match(msg, /exec: "nav links"/);
});
