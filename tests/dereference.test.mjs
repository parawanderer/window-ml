"use strict";
// `dereference` and pointer-aware `look` AS THE LOOP ANSWERS THEM. The unit tests cover the pipe dialect and
// the pointer layer; these drive the real runAgentLoop, so they cover the parts only the loop does: minting a
// pointer with the right TYPE from a step's render descriptor, the reply header (what it is, how stale), the
// tool-level error shapes, and rewriting a `look` at an @tool: pointer into a look at that image.
import { test } from "node:test";
import assert from "node:assert";
const { runAgentLoop } = await import("../src/agent-loop.ts");
const { TokenStore } = await import("../src/token-pipe.ts");

const TOOLS = [
    { name: "exec", description: "", parameters: { type: "object", properties: {} } },
    { name: "python_exec", description: "", parameters: { type: "object", properties: {} } },
    { name: "look", description: "", parameters: { type: "object", properties: {} } },
    { name: "dereference", description: "", parameters: { type: "object", properties: {} } },
];
const call = (name, args, id = "c1") => ({ content: "", tool_calls: [{ id, name, arguments: args }] });

/** Drive the loop over scripted turns; return every tool result the MODEL was handed, plus the args each tool
 *  actually received (so a rewritten `look` is observable). */
async function drive(turns, runTool, opts = {}) {
    const results = [], got = [];
    let i = 0;
    await runAgentLoop("t", { tools: TOOLS, maxSteps: () => turns.length + 2, toolTokens: true, runHash: "abcdef", ...opts }, {
        callModel: async () => turns[i++] || { content: "done", tool_calls: [] },
        runTool: async (name, args) => { got.push({ name, args }); return runTool(name, args); },
        autoApprove: () => null,
        buildMessages: (task) => [{ role: "user", content: task }],
        pushAssistant: (m, msg) => m.push({ role: "assistant", ...msg }),
        pushToolResult: (m, c, result) => { results.push({ name: c.name, result }); m.push({ role: "tool", content: result }); },
    });
    return { results, got };
}
const derefResult = (r) => r.results.find((x) => x.name === "dereference").result;

test("dereference: the reply says WHAT the value is and HOW STALE, then the piped text", async () => {
    const full = Array.from({ length: 300 }, (_, i) => `row ${i + 1}: v${i + 1}`).join("\n");
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:exec", pipe: "grep 'row 297:'" })],
        (name) => name === "exec"
            ? { result: full.slice(0, 120) + "… [+truncated]", renderOut: { type: "exec-out", stdout: full, seen: 120 } }
            : { result: "" });

    const out = results.find((r) => r.name === "dereference").result;
    assert.match(out, /^@tool:[0-9a-f]{7} \(exec\) — text, \d+ chars \/ 300 lines/, "leads with what is at the pointer");
    assert.match(out, /chars MORE than you were shown \(your copy was truncated\)/, "…and that this read is worth the step");
    assert.match(out, /captured at step 1, 1 step ago — the page may have changed since/, "…and how stale it is");
    assert.match(out, /row 297: v297/, "then the piped value — a line the model never saw");
});

test("dereference: a hallucinated pointer returns a MemoryFault naming the real ones", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:deadbe1" })],
        () => ({ result: "captured" }));
    const out = results.find((r) => r.name === "dereference").result;
    assert.match(out, /^Error: MemoryFault: pointer '@tool:deadbe1' does not exist\./);
    assert.match(out, /Nearest valid pointers:/);
    assert.match(out, /\(1 step back: exec\) [^[]*\[dist \d+\]/, "the real pointer, with its TYPE, distance and how far back");
    assert.match(out, /recoverable/i);
});

test("dereference: a pipe with NO token still answers with the inventory, and says the pipe was dropped", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { pipe: "head 2" })],
        () => ({ result: "captured" }));
    const out = results.find((r) => r.name === "dereference").result;
    // A pipe with no pointer is a slip, not an inventory request — but the inventory is what recovers it.
    assert.match(out, /1 pointer in this session:/);
    assert.match(out, /@tool:[0-9a-f]{7} \(exec\)/, "names the pointer it could have used");
    // …and the dropped argument is stated rather than silently ignored.
    assert.match(out, /`pipe` was not applied: no pointer was named/);
});

test("dereference: a bad pipe stage returns the dialect's own actionable refusal", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:exec", pipe: "jq .name" })],
        () => ({ result: "captured" }));
    assert.match(derefResult({ results }), /^Error: `jq` isn't a supported text command/);
});

// The pointer carries the value's TYPE, taken from the step's render descriptor — that is what makes `keys` on
// a DataFrame mean its COLUMNS rather than whatever re-parsing rendered text would produce.
test("mint: a DataFrame step becomes a TABLE pointer, so keys are its columns", async () => {
    const df = { columns: ["name", "qty", "price"], rows: [["apples", 3, 1.2], ["pears", 5, 0.9]] };
    const { results } = await drive(
        [call("python_exec", { code: "x", token: true }), call("dereference", { token: "@tool:python_exec", pipe: "keys" })],
        (name) => name === "python_exec"
            ? { result: "a DataFrame", renderOut: { type: "python-out", df } }
            : { result: "" });

    const out = derefResult({ results });
    assert.match(out, /a 2x3 table \(name, qty, price\)/, "described as a table, not as N chars of text");
    assert.match(out, /\[\s*"name",\s*"qty",\s*"price"\s*\]/, "keys yields the COLUMNS");
});

test("mint: a JSON-looking result is typed json, a code render is typed code", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("dereference", { token: "@tool:exec", pipe: "keys" })],
        () => ({ result: '{"a":1,"b":2}' }));
    const out = derefResult({ results });
    assert.match(out, /— JSON, \d+ chars/, "a result that parses as JSON is typed json");
    assert.match(out, /\[\s*"a",\s*"b"\s*\]/);
});

// `look` at an @tool: pointer re-examines a screenshot the run already took — a NEW question about the SAME
// pixels, instead of re-shooting a page that may have scrolled since. The LOOP resolves it (it owns the store)
// and hands the image down, so `look` itself never learns about tokens.
test("look: an @tool: image pointer is rewritten into a look at that image", async () => {
    const shot = "data:image/png;base64,AAAA";
    const { got, results } = await drive(
        [call("look", { question: "what is here?", token: true }), call("look", { selector: "@tool:look", question: "any red text?" })],
        () => ({ result: "a page", image: shot, imageLabel: "viewport", renderOut: { type: "image", src: shot } }));

    const second = got.filter((g) => g.name === "look")[1];
    assert.equal(second.args._image, shot, "the loop resolved the pointer to the captured image");
    assert.match(second.args._imageLabel, /@tool:[0-9a-f]{7} \(captured at step 1\)/, "…labelled with where it came from");
    assert.equal(second.args.question, "any red text?", "the model's own question is preserved");
    assert.equal(results.filter((r) => r.name === "look").length, 2);
});

test("look: a pointer to a NON-image says what it actually is and redirects to dereference", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: true }), call("look", { selector: "@tool:exec" })],
        () => ({ result: "some text output" }));
    const out = results.find((r) => r.name === "look").result;
    assert.match(out, /is text, \d+ chars .*, not an image — there is nothing to look at/);
    assert.match(out, /Read it with dereference instead/);
});

test("look: an unresolvable pointer faults like any other bad pointer", async () => {
    const { results, got } = await drive(
        [call("exec", { js: "x", token: true }), call("look", { selector: "@tool:zzzzzz" })],
        () => ({ result: "captured" }));
    const out = results.find((r) => r.name === "look").result;
    assert.match(out, /MemoryFault: pointer '@tool:zzzzzz' does not exist/);
    assert.equal(got.filter((g) => g.name === "look").length, 0, "and look is never invoked with a broken pointer");
});

test("look: an ordinary selector passes through untouched", async () => {
    const { got } = await drive([call("look", { selector: "#hero" })], () => ({ result: "ok" }));
    const l = got.find((g) => g.name === "look");
    assert.equal(l.args.selector, "#hero");
    assert.ok(!("_image" in l.args), "no pointer machinery on a normal look");
});

// `token` as a LABEL: the string is both the opt-in and the model's own name for the pointer.
test("token as a label: names the pointer in the reply, the listing, and the fault", async () => {
    const { results } = await drive(
        [call("python_exec", { code: "x", token: "the pricing table" }),
         call("dereference", { token: "@tool:python_exec" }),
         call("dereference", { token: "@tool:deadbe1" })],
        (name) => name === "python_exec" ? { result: "rows…" } : { result: "" });

    const [read, fault] = results.filter((r) => r.name === "dereference").map((r) => r.result);
    assert.match(read, /\(python_exec: "the pricing table"\) — text, \d+ chars/,
        "the model's own name leads, the DERIVED description still follows it");
    assert.match(fault, /\(2 steps back: python_exec: "the pricing table"\)/, "the fault lists it by name too");
});

test("token as a label: a string still opts IN (it is not just decoration)", async () => {
    const { results } = await drive(
        [call("exec", { js: "x", token: "nav links" }), call("dereference", { token: "@tool:exec" })],
        () => ({ result: "a\nb" }));
    // If the string hadn't counted as opting in, the id would never have been surfaced to the model.
    const execResult = results.find((r) => r.name === "exec").result;
    assert.match(execResult, /@tool:[0-9a-f]{7}/, "the handle was surfaced because the label opted in");
    assert.match(derefResult({ results }), /"nav links"/);
});

// REGRESSION (observed in a real session). A follow-up turn — "How did you compute this?" — dereferenced
// `python_exec` and got "Nothing has been captured in this run yet, so there is no pointer to read." The tool
// HAD run, in the previous turn of the same session. The store was created per runAgentLoop call, so each turn
// started empty, while the model still saw the earlier turn's `@tool:` pointers in its own history. Ids are
// already unique across turns (the loop offsets each turn's seq base), so one store per SESSION cannot collide.
test("dereference: a pointer from an EARLIER TURN of the same session still resolves", async () => {
    const tokenStore = new TokenStore();
    // Turn 1: run python_exec, capture an output. Nothing dereferences it yet.
    const first = await drive([call("python_exec", { code: "df.sum()", token: true })],
        () => ({ result: "grand total 6260" }), { tokenStore });
    assert.ok(first.results.find((r) => r.name === "python_exec"), "turn 1 captured a pointer");

    // Turn 2 (the follow-up): a NEW loop over the SAME session store, referencing the tool by NAME.
    const second = await drive([call("dereference", { token: "python_exec", pipe: "type" })],
        () => ({ result: "" }), { tokenStore, seqBase: 8 });
    const out = derefResult(second);
    assert.doesNotMatch(out, /MemoryFault/, "the previous turn's output is still readable");
    assert.doesNotMatch(out, /Nothing has been captured/);
    assert.match(out, /\(python_exec\)/, "and it resolved to that tool's capture");
});

test("dereference: the tool-name alias means the LATEST call, across turns too", async () => {
    const tokenStore = new TokenStore();
    await drive([call("python_exec", { code: "a", token: true })], () => ({ result: "FIRST" }), { tokenStore });
    await drive([call("python_exec", { code: "b", token: true })], () => ({ result: "SECOND" }), { tokenStore, seqBase: 8 });
    const third = await drive([call("dereference", { token: "python_exec" })], () => ({ result: "" }), { tokenStore, seqBase: 16 });
    assert.match(derefResult(third), /SECOND/, "the most recent call wins");
    assert.doesNotMatch(derefResult(third), /FIRST/);
});

// Without a shared store a one-shot run is unchanged: each loop owns its own pointers.
test("dereference: separate runs with no shared store stay isolated", async () => {
    await drive([call("python_exec", { code: "a", token: true })], () => ({ result: "FIRST" }));
    const next = await drive([call("dereference", { token: "python_exec" })], () => ({ result: "" }));
    assert.match(derefResult(next), /MemoryFault|Nothing has been captured/, "a fresh run has no prior pointers");
});

// A model often only decides an output is worth SHOWING after it has narrowed it. A piped dereference is a
// reduction the model just constructed, so it gets its own pointer — otherwise its only options are citing the
// whole original or retyping the view into the answer (which costs context and loses the render).
test("dereference: a PIPED view mints its own pointer, and that pointer resolves", async () => {
    const rows = ["q1 1455", "q2 1590", "q3 1555", "q4 1660", "TOTAL 6260"].join("\n");
    const { results } = await drive(
        [call("python_exec", { code: "df", token: true }), call("dereference", { token: "python_exec", pipe: "grep TOTAL" })],
        (name) => name === "python_exec" ? { result: rows } : { result: "" });
    const out = derefResult(results ? { results } : { results });
    assert.match(out, /TOTAL 6260/, "the reduction itself");
    const id = /\[this view is @tool:([0-9a-f]{7})/.exec(out)?.[1];
    assert.ok(id, "the view was given a pointer");
    assert.match(out, new RegExp(`!\\[label\\]\\(@tool:${id}:out\\)`), "…and says how to show it");

    // That pointer is real: a later step reads it back.
    const second = await drive(
        [call("python_exec", { code: "df", token: true }), call("dereference", { token: "python_exec", pipe: "grep TOTAL" }), call("dereference", { token: "dereference" })],
        (name) => name === "python_exec" ? { result: rows } : { result: "" });
    const reads = second.results.filter((r) => r.name === "dereference");
    assert.match(reads[1].result, /TOTAL 6260/, "the minted view is readable by name");
    assert.doesNotMatch(reads[1].result, /q1 1455/, "and holds the REDUCTION, not the original");
    assert.match(reads[1].result, /dereference: "python_exec \| grep TOTAL"/, "labelled with what produced it");
});

// The original exclusion still stands where it was right: with no pipe there is no new data, and the header
// already names the source's id, so a second handle for identical bytes would just clutter the store.
test("dereference: a read that transforms NOTHING mints no pointer", async () => {
    const run = async (args) => {
        const { results } = await drive(
            [call("python_exec", { code: "df", token: true }), call("dereference", args)],
            (name) => name === "python_exec" ? { result: "just one line" } : { result: "" });
        return results.filter((r) => r.name === "dereference").pop().result;
    };
    assert.doesNotMatch(await run({ token: "python_exec" }), /this view is @tool:/, "no pipe → no mint");
    assert.doesNotMatch(await run({ token: "python_exec", pipe: "  " }), /this view is @tool:/, "blank pipe → no mint");
    assert.doesNotMatch(await run({ token: "python_exec", pipe: "cat" }), /this view is @tool:/, "a pipe that changes nothing → no mint");
});

// The point of reading by NAME: `python_exec` means "the latest python_exec call" and MOVES when the tool runs
// again. A model that didn't pass `token: true` was never told that call's id, and it often only decides an
// output is worth keeping after seeing it — so the read hands back the stable id and says it is one.
test("dereference: reading by NAME hands back the stable id, and that id does not move", async () => {
    const { results } = await drive(
        [call("python_exec", { code: "first" }), call("dereference", { token: "python_exec" }),
         call("python_exec", { code: "second" }), call("dereference", { token: "python_exec" })],
        (name, args) => name === "python_exec" ? { result: args.code === "first" ? "ONE" : "TWO" } : { result: "" });
    const reads = results.filter((r) => r.name === "dereference");

    const pinned = /\[pinned: this call is @tool:([0-9a-f]{7})\./.exec(reads[0].result)?.[1];
    assert.ok(pinned, "reading by name pins the call it resolved to");
    assert.match(reads[0].result, /always means the LATEST python_exec call and will move/, "…and says the name moves");
    assert.match(reads[0].result, /ONE/);

    // The SAME name now resolves to the second call — the alias moved, exactly as the pin line warned.
    assert.match(reads[1].result, /TWO/, "the alias followed the newer call");
    const pinned2 = /\[pinned: this call is @tool:([0-9a-f]{7})\./.exec(reads[1].result)?.[1];
    assert.notEqual(pinned2, pinned, "…so it pins a different id");

    // …while the FIRST pin still means the first call. That is the whole point of handing it over.
    const after = await drive(
        [call("python_exec", { code: "first" }), call("dereference", { token: "python_exec" }),
         call("python_exec", { code: "second" }), call("dereference", { token: `@tool:${pinned}` })],
        (name, args) => name === "python_exec" ? { result: args.code === "first" ? "ONE" : "TWO" } : { result: "" });
    const byId = after.results.filter((r) => r.name === "dereference")[1].result;
    assert.match(byId, /ONE/, "the pinned id still reads the ORIGINAL call after the alias moved");
    assert.doesNotMatch(byId, /\[pinned:/, "and a read BY id doesn't re-pin — it already holds the handle");
});

// A soft label match must never be silent: an address dereference that quietly picks different data is the
// failure that costs ten steps of the model explaining an anomaly it caused itself.
test("dereference: a label resolved by SIMILARITY says so; an exact one says nothing", async () => {
    const run = async (query) => {
        const { results } = await drive(
            [call("python_exec", { code: "df", token: "the table of sales" }), call("dereference", { token: `@tool:${JSON.stringify(query)}` })],
            (name) => name === "python_exec" ? { result: "ROWS" } : { result: "" });
        return derefResult({ results });
    };

    const soft = await run("sales table");
    assert.match(soft, /ROWS/, "it did resolve");
    assert.match(soft, /resolved by similarity, not an exact name/);
    assert.match(soft, /you asked for "sales table"/, "echoes what the model actually wrote");
    assert.match(soft, /closest label was "the table of sales"/, "…and what it got");
    assert.match(soft, /\(1\.00\)/, "…with the score, so a weak match is visible as one");
    assert.match(soft, /list what you have with dereference and no token/, "…and the way to check");

    // An EXACT match approximated nothing, so it says nothing.
    const exact = await run("the table of sales");
    assert.match(exact, /ROWS/);
    assert.doesNotMatch(exact, /resolved by similarity/);
});

// The exec path cannot carry the advisory in the value. `ml.dereference()` returns a string a script is about
// to JSON.parse / split / pipe, so a note appended to it would corrupt the data — the tool path appends text
// because there the model READS the result, and these are genuinely different channels.
test("dereference: a soft match reaches exec as a console warning, leaving the VALUE clean", async () => {
    let resolver = null;
    await drive(
        [call("python_exec", { code: "df", token: "the table of sales" }), { content: "done", tool_calls: [] }],
        () => ({ result: "ROWS" }),
        { tokenSink: (fn) => { resolver = fn; } });
    assert.equal(typeof resolver, "function");

    // Exact: the value, and nothing to advise about.
    const exact = resolver('@tool:"the table of sales"');
    assert.equal(exact.value, "ROWS");
    assert.equal(exact.warning, undefined);

    // Soft: the SAME clean value, with the advisory beside it for the caller to console.warn.
    const soft = resolver('@tool:"sales table"');
    assert.equal(soft.value, "ROWS", "the value is untouched — this is what the script operates on");
    assert.match(soft.warning, /^ml\.dereference: resolved "sales table" to the label "the table of sales" by similarity/);
    assert.match(soft.warning, /\(1\.00\)/, "with the score, so a weak match is visible");
    assert.doesNotMatch(soft.value, /similarity/, "and nothing about the resolution leaked into the data");
});

// Calling with NO argument is the inventory. It used to be reachable only by provoking the "token is
// required" error, which is backwards for a mechanism whose job is confidence: a model that cannot cheaply
// see what it holds will guess, and a model that expects to guess wrong retypes the data instead.
test("dereference: no argument lists what the session holds, as a real read", async () => {
    const { results } = await drive(
        [call("python_exec", { code: "df", token: "the sales table" }),
         call("exec", { js: "x", token: true }),
         call("dereference", {})],
        (name) => name === "python_exec" ? { result: "ROWS" } : { result: "SURVEY" });
    const out = derefResult({ results });

    assert.doesNotMatch(out, /^Error/, "an inventory is a legitimate read, not a validation failure");
    assert.match(out, /2 pointers in this session:/);
    assert.match(out, /@tool:[0-9a-f]{7} \(python_exec: "the sales table"\) text \d+ chars, step 1/, "each carries its name, TYPE and age");
    assert.match(out, /@tool:[0-9a-f]{7} \(exec\) text \d+ chars, step 2/);
    // It teaches the reference forms by example, which is cheaper than paying for a paragraph every run.
    assert.match(out, /Read one by passing it as `token`/);
    assert.match(out, /or by its label: @tool:"the sales table"/);
    // No column padding — it is read by a model (see the AGENTS.md rule).
    for (const line of out.split("\n").filter((l) => l.includes("@tool:"))) {
        assert.doesNotMatch(line.trimStart(), / {2,}/, `padded: ${JSON.stringify(line)}`);
    }
});

test("dereference: an empty session says how to fill it, not that something went wrong", async () => {
    const { results } = await drive([call("dereference", {})], () => ({ result: "" }));
    const out = derefResult({ results });
    assert.doesNotMatch(out, /^Error/);
    assert.match(out, /No pointers captured yet/);
    assert.match(out, /token: true/, "and names the way to create one");
});
