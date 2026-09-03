"use strict";
// The POINTER layer behind `dereference`: what a @tool:<id> points at, what type it is, how stale it is, and
// the two type-level casts (latex / img) the line dialect can't express. The pipe language itself is
// text-pipe.ts and is tested there — these tests cover what a pointer knows that a bare string doesn't.
import { test } from "node:test";
import assert from "node:assert";
const P = await import("../token-pipe.ts");

const tok = (over = {}) => ({ id: "a1b2c3f", tool: "exec", kind: "text", out: "hello", t: 1000, step: 1, ...over });
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
    assert.equal(P.TokenStore.slotOf("@tool:a1b2c3f:in"), "in");
    assert.equal(P.TokenStore.slotOf("@tool:a1b2c3f"), "out", "out is the default");
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
    s.note(tok({ id: "aaa1115", tool: "exec", out: "first", step: 1 }));
    s.note(tok({ id: "bbb222", tool: "python_exec", out: "older py", step: 2 }));
    s.note(tok({ id: "ccc333", tool: "python_exec", out: "newer py", step: 3 }));

    assert.equal(s.get("aaa1115").out, "first");
    assert.equal(s.get("@tool:aaa1115").out, "first", "the model writes the @tool: form it was shown");
    assert.equal(s.get("@tool:aaa1115:out").out, "first", "a slot suffix doesn't break resolution");
    assert.equal(s.get("  aaa1115 ").out, "first", "whitespace is forgiven");
    assert.equal(s.get("python_exec").out, "newer py", "a tool-name alias means the LATEST call of that tool");
    assert.equal(s.get("nope"), null, "an unresolvable reference is null, not a wrong guess");
    assert.deepEqual(s.all().map((v) => v.id), ["aaa1115", "bbb222", "ccc333"], "oldest first");
});

// Models hallucinate token-SHAPED ids — six plausible hex characters that were never minted — so a bare
// "no such pointer" just invites another guess.
test("nearest() names the closest real pointers for a hallucinated id", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "a1b2c3f", tool: "exec", step: 1 }));
    s.note(tok({ id: "d4e5f6b", tool: "python_exec", step: 2 }));
    s.note(tok({ id: "9a8b7c7", tool: "fetch_url", step: 3 }));

    // One character off — the intended pointer must rank first.
    assert.equal(s.nearest("a1b2c9f")[0].id, "a1b2c3f");
    assert.equal(s.nearest("@tool:a1b2c9f:out")[0].id, "a1b2c3f", "the @tool: form and slot are normalised away");
    // Half-remembered by TOOL rather than id.
    assert.equal(s.nearest("python")[0].id, "d4e5f6b", "a near-miss on the tool name steers to that tool's output");
    assert.equal(s.nearest("fetchurl")[0].id, "9a8b7c7");
    assert.equal(s.nearest("zzzzzz").length, 3, "always offers candidates rather than a dead end");
    assert.equal(s.nearest("zzzzzz", 1).length, 1, "…capped by the limit");
    assert.deepEqual(new P.TokenStore().nearest("a1b2c3f"), [], "nothing captured → nothing to suggest");
});

test("editDistance underpins the ranking", () => {
    assert.equal(P.editDistance("abc", "abc"), 0);
    assert.equal(P.editDistance("a1b2c3f", "a1b2c9f"), 1);
    assert.equal(P.editDistance("", "abc"), 3);
});

// A pointer that doesn't resolve is usually a HALLUCINATED token-shaped id. The message is modelled on a memory
// fault because that is exactly what happened, and it is a concept the model already understands precisely.
test("memoryFault: names the fault, ranks the candidates, and says it is recoverable", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "af21d0d", tool: "python_exec", step: 2 }));
    s.note(tok({ id: "bf21d0e", tool: "exec", step: 1 }));
    const msg = P.memoryFault("@tool:af21e0d", s.nearest("af21e0d"), 4);

    assert.match(msg, /^MemoryFault: pointer '@tool:af21e0d' does not exist\./, "the fault names the bad address");
    assert.match(msg, /Nearest valid pointers:/);
    // Distance from the CURRENT step, which is the actionable half ("2 steps back" beats "step 2").
    assert.match(msg, /- @tool:af21d0d \(2 steps back: python_exec\)\s+\[edit_dist=1\]/);
    assert.match(msg, /- @tool:bf21d0e \(3 steps back: exec\)\s+\[edit_dist=3\]/);
    // The candidate columns line up, so the list is scannable rather than ragged.
    const cols = msg.split("\n").filter((l) => l.includes("edit_dist")).map((l) => l.indexOf("[edit_dist"));
    assert.equal(new Set(cols).size, 1, "the edit_dist column is aligned across candidates");
    // Without this a model pattern-matching "fault" to a segfault may report a crash or abandon the task.
    assert.match(msg, /recoverable/i, "the fault says it can be retried");
    assert.match(msg, /re-run the tool if you need the data fresh/, "…and names the other valid recovery");
});

test("memoryFault: distinguishes a typo from an invented id", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "af21d0d", tool: "python_exec", step: 2 }));
    // One character out — a typo. Don't tell the model it invented it.
    assert.doesNotMatch(P.memoryFault("af21e06", s.nearest("af21e06"), 3), /inventing the id/);
    // Nothing remotely like it — say so, because a fabricated pointer needs a different fix than a typo.
    assert.match(P.memoryFault("zzzzzz", s.nearest("zzzzzz"), 3), /None of these is close/);
    assert.match(P.memoryFault("zzzzzz", s.nearest("zzzzzz"), 3), /earlier turn or inventing the id/);
});

test("memoryFault: an empty run says there is nothing to point at yet", () => {
    const msg = P.memoryFault("@tool:abc1231", new P.TokenStore().nearest("abc1231"), 1);
    assert.match(msg, /^MemoryFault: pointer '@tool:abc1231' does not exist\./);
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
        sawInside = fn ? await fn("@tool:abc1231", "head 2") : null;
        return "done";
    });
    await executeTool(tool, {}, ctx);
    assert.equal(sawInside, "read @tool:abc1231 | head 2", "bound to THIS run's resolver while the tool ran");
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
    s.note(tok({ id: "a1b2c3f", tool: "python_exec", step: 1, label: "the pricing table" }));
    s.note(tok({ id: "d4e5f6", tool: "exec", step: 2, label: "nav links" }));

    // Recalling the name but inventing the id is the common failure — the label must rescue it.
    assert.equal(s.nearest("pricing")[0].id, "a1b2c3f", "a substring of the label is an exact hit");
    assert.equal(s.nearest("the pricing table")[0].id, "a1b2c3f");
    assert.equal(s.nearest("nav")[0].id, "d4e5f6");
    // And the fault message names pointers the way the model named them.
    const msg = P.memoryFault("@tool:zzzzzz", s.nearest("zzzzzz"), 4);
    assert.match(msg, /python_exec: "the pricing table"/);
    assert.match(msg, /exec: "nav links"/);
});

// A store now lives for a whole SESSION, and an entry can carry a full capture or a screenshot data URL, so
// it must be bounded or a long conversation grows without limit.
test("TokenStore: bounded, evicting the OLDEST, and re-noting an id keeps it 'latest' for the name alias", () => {
    const store = new P.TokenStore();
    const put = (id, out, tool = "exec") => store.note({ id, tool, kind: "text", out, t: 1000, step: 1 });
    const hex = (i) => i.toString(16).padStart(7, "0");   // ids dispatch on SHAPE, so fixtures must be id-shaped
    for (let i = 0; i < P.TokenStore.CAP + 10; i++) put(hex(i), `v${i}`);
    assert.equal(store.size, P.TokenStore.CAP, "capped");
    assert.equal(store.get(hex(0)), null, "the oldest were evicted");
    assert.ok(store.get(hex(P.TokenStore.CAP + 9)), "the newest survive");
    // The tool-name alias resolves to the most recently NOTED entry of that tool.
    const s2 = new P.TokenStore();
    s2.note({ id: "aaaaaaa", tool: "python_exec", kind: "text", out: "FIRST", t: 1, step: 1 });
    s2.note({ id: "bbbbbbb", tool: "python_exec", kind: "text", out: "SECOND", t: 2, step: 2 });
    assert.equal(s2.get("python_exec").out, "SECOND");
    s2.note({ id: "aaaaaaa", tool: "python_exec", kind: "text", out: "AGAIN", t: 3, step: 3 });
    assert.equal(s2.get("python_exec").out, "AGAIN", "re-noting moves it to the end");
    assert.equal(s2.size, 2, "…without duplicating it");
});

// Eviction is LRU, not FIFO: "bind it before it goes out of scope" only works if consulting a pointer keeps it
// alive. The recency used for eviction is tracked apart from insertion order, because insertion order is what
// makes the tool-name alias mean "the latest CALL".
test("TokenStore: a READ keeps a pointer alive, without making it look like the newest call", () => {
    const store = new P.TokenStore();
    const put = (id, out) => store.note({ id, tool: "exec", kind: "text", out, t: 1, step: 1 });
    const hex = (i) => i.toString(16).padStart(7, "0");
    for (let i = 0; i < P.TokenStore.CAP; i++) put(hex(i), `v${i}`);
    store.get(hex(0));                      // consult the OLDEST — it must now outlive the next one
    put("fffffff", "new");                  // pushes one entry out
    assert.ok(store.get(hex(0)), "the pointer the model just read survived");
    assert.equal(store.get(hex(1)), null, "the least recently USED went instead");
    // Reading must NOT reorder the alias: id0 is an old call, not the latest exec.
    assert.notEqual(store.get("exec").id, hex(0), "a read never promotes an old call to 'latest'");
    assert.equal(store.get("exec").id, "fffffff");
});

// A label is the handle a model actually remembers: it CHOSE it at the moment it knew what the output was
// for, so it is recalled rather than transcribed. Before this the store knew the label — `nearest()` would
// even name it in a fault — and still refused to resolve it.
test("labels resolve: QUOTED is the canonical form, and quoting is what disambiguates", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "a1b2c3f", tool: "python_exec", out: "TABLE", label: "the sales table", step: 1 }));

    assert.equal(s.get('@tool:"the sales table"').out, "TABLE");
    assert.equal(s.get(`@tool:'the sales table'`).out, "TABLE", "models mix quote styles; accept both");
    assert.equal(s.get('@tool:"the sales table":out').out, "TABLE", "a slot suffix still parses");
    assert.equal(s.get('"the sales table"').out, "TABLE", "the @tool: prefix is optional, as for an id");
    // Recall, not transcription: case and inner spacing are not what the model was trying to say.
    assert.equal(s.get('@tool:"The Sales Table"').out, "TABLE");
    assert.equal(s.get('@tool:"the  sales   table"').out, "TABLE");
    assert.equal(s.get('@tool:"  the sales table  "').out, "TABLE");
    // Quoting is REQUIRED: a bare ref is a tool alias, so it misses (see the fault test below).
    assert.equal(s.get("the sales table"), null);
    assert.equal(s.resolveRef('@tool:"the sales table"').via, "label");
    assert.equal(s.get('@tool:"no such label"'), null);
    assert.equal(s.get('@tool:""'), null, "an empty label matches nothing, rather than the first thing");
});

// ADVERSARIAL. A label is free text the model wrote, so it can look like anything else in the namespace.
// Quoting must settle every one of these, and an UNQUOTED label must never shadow a real id or tool alias.
test("labels resolve: a label that impersonates an id or a tool cannot shadow one", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "a1b2c3f", tool: "python_exec", out: "REAL-PY", step: 1 }));
    s.note(tok({ id: "d4e5f6b", tool: "exec", out: "LABELLED-PY", label: "python_exec", step: 2 }));
    s.note(tok({ id: "9a8b7c7", tool: "look", out: "LABELLED-ID", label: "a1b2c3f", step: 3 }));

    // Unquoted: id wins, then tool name — the label NEVER pre-empts either.
    assert.equal(s.get("a1b2c3f").out, "REAL-PY", "id-shaped -> the id, never a label spelling it");
    assert.equal(s.get("python_exec").out, "REAL-PY", "bare -> the tool alias, never a label spelling it");
    // Quoted: unambiguously the label, which is the whole reason the syntax exists.
    assert.equal(s.get('@tool:"python_exec"').out, "LABELLED-PY");
    assert.equal(s.get('@tool:"a1b2c3f"').out, "LABELLED-ID");
    // Latest-wins on a duplicate label, mirroring the tool-name alias rather than inventing a second rule.
    s.note(tok({ id: "eeee11e", tool: "exec", out: "NEWER", label: "python_exec", step: 4 }));
    assert.equal(s.get('@tool:"python_exec"').out, "NEWER");
    // An unlabelled value is never reachable by label, however the ref is spelled.
    assert.equal(s.get('@tool:"REAL-PY"'), null);
    // A corrupted ID stays in the id branch and MISSES — it is never retried as a tool or a label.
    assert.equal(s.get("a1b2c3e"), null, "one character out is a miss, not a fallback to something else");
});

test("labels resolve: a quote or a backslash inside the label survives", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "a1b2c3f", tool: "exec", out: "QUOTED", label: 'the "sales" table', step: 1 }));
    s.note(tok({ id: "d4e5f6b", tool: "exec", out: "PATH", label: "C:\\reports\\q3", step: 2 }));

    assert.equal(s.get('@tool:"the \\"sales\\" table"').out, "QUOTED", "the escaped form — canonical");
    assert.equal(s.get('@tool:"the "sales" table"').out, "QUOTED", "unescaped still lands (greedy to the last quote)");
    // A backslash that isn't an escape is left alone, so a path in a label reads back intact.
    assert.equal(s.get('@tool:"C:\\reports\\q3"').out, "PATH");
});

// The three reference forms are told apart by SHAPE, so they must actually be distinguishable. The charset
// alone does not give that: `deadbee` is a fine identifier AND a valid token shape. `ml.defineTool` therefore
// rejects both malformed names and id-shaped ones, at definition time.
test("tool names: the namespace guarantee is ENFORCED, not assumed", async () => {
    const { toolNameError, isTokenShape } = await import("../token-id.ts");

    for (const ok of ["python_exec", "exec", "fetch_url", "look", "_private", "Tool2", "a"]) {
        assert.equal(toolNameError(ok), null, `${ok} should be a legal tool name`);
    }
    // Spaces and punctuation would not survive being written bare in a @tool: reference.
    for (const bad of ["my tool", "fetch-url", "tool!", "café", "", "  ", "2fast"]) {
        assert.match(String(toolNameError(bad)), /letters, digits and underscores|needs a name/, `${JSON.stringify(bad)} should be rejected`);
    }
    assert.equal(toolNameError(null), "a tool needs a name");
    // The collision that the shape dispatch depends on not existing — a legal identifier that is ALSO an id.
    assert.ok(isTokenShape("deadbee"), "precondition: this is id-shaped");
    assert.match(String(toolNameError("deadbee")), /looks like a generated output id/);
    assert.equal(toolNameError("deadbeef"), null, "one character longer is not an id, so it is fine");
});

// A bare reference is a TOOL alias, so an unquoted label misses — and the fault says so in the canonical
// form. Resolving it silently would work once and teach nothing.
test("labels: an UNQUOTED label misses, and the fault teaches the quoted form", () => {
    const s = new P.TokenStore();
    s.note(tok({ id: "a1b2c3f", tool: "python_exec", out: "TABLE", label: "the sales table", step: 1 }));

    assert.equal(s.get("the sales table"), null, "bare means a TOOL alias; there is no such tool");
    const msg = P.memoryFault("@tool:the sales table", s.nearest("the sales table"), 3);
    assert.match(msg, /That is a LABEL, and a label must be quoted/);
    assert.match(msg, /@tool:"the sales table"/, "shows the exact form to use");
    assert.match(msg, /an unquoted @tool:<name> means a TOOL's latest call/, "…and why");
    // The quoted form is the one that works.
    assert.equal(s.get('@tool:"the sales table"').out, "TABLE");
});
