"use strict";
// text-pipe.ts — the safe grep/head/tail/wc/sort/uniq pipeline interpreter. Pure text→text, so these are
// correctness tests (no red-team suite needed — there's nothing to escape to). Covers each verb + its flags,
// pipe chaining, quote-aware parsing, and the actionable errors for the un-modeled cases.
import { test } from "node:test";
import assert from "node:assert";
import { runPipe, mlPipe } from "../text-pipe.ts";

const DOC = ["Apple 3", "banana 10", "Cherry 2", "apple 7", "date", "banana 10"].join("\n");

// ---- grep ----
test("grep: lines matching a regex", () => {
    assert.equal(runPipe("foo\nbar\nfood", "grep foo"), "foo\nfood");
    assert.equal(runPipe("foo\nbar\nfood", "grep 'o$'"), "foo");
});
test("grep -i: case-insensitive", () => {
    assert.equal(runPipe(DOC, "grep -i apple"), "Apple 3\napple 7");
});
test("grep -v: invert", () => {
    assert.equal(runPipe("foo\nbar\nbaz", "grep -v ba"), "foo");
});
test("grep -c: count of matching lines only", () => {
    assert.equal(runPipe(DOC, "grep -i banana"), "banana 10\nbanana 10");
    assert.equal(runPipe(DOC, "grep -c -i banana"), "2");
    assert.equal(runPipe(DOC, "grep -ci banana"), "2", "clustered flags");
});
test("grep -n: line numbers with `:`", () => {
    assert.equal(runPipe(DOC, "grep -n -i apple"), "1:Apple 3\n4:apple 7");
});
test("grep -F: fixed string (regex metachars literal)", () => {
    assert.equal(runPipe("a.b\naxb\na.b.c", "grep -F 'a.b'"), "a.b\na.b.c");
    assert.equal(runPipe("a.b\naxb", "grep 'a.b'"), "a.b\naxb", "without -F the dot is a wildcard");
});
test("grep -w: whole word", () => {
    assert.equal(runPipe("foo\nfood\na foo b", "grep -w foo"), "foo\na foo b");
});
test("grep -o: only the matching substrings, one per line", () => {
    assert.equal(runPipe("price: 10, cost: 20", "grep -o '[0-9]+'"), "10\n20");
    assert.equal(runPipe("aXbXc\ndXe", "grep -o X"), "X\nX\nX");
});
test("grep -A/-B/-C: context with `:`/`-` markers and `--` separators", () => {
    const t = ["a", "HIT", "b", "c", "d", "HIT", "e"].join("\n");
    assert.equal(runPipe(t, "grep -A1 HIT"), "HIT\nb\n--\nHIT\ne", "non-adjacent groups get grep's `--` separator");
    assert.equal(runPipe(t, "grep -B1 HIT"), "a\nHIT\n--\nd\nHIT");
    assert.equal(runPipe(t, "grep -n -C1 HIT"), "1-a\n2:HIT\n3-b\n--\n5-d\n6:HIT\n7-e");
});
test("grep: an invalid regex is an actionable error steering to -F", () => {
    assert.throws(() => runPipe("x", "grep '('"), /invalid regex.*-F/s);
});

// ---- head / tail ----
test("head / tail: default 10, -n N, and bare -N", () => {
    const t = Array.from({ length: 12 }, (_, i) => `L${i + 1}`).join("\n");
    assert.equal(runPipe(t, "head").split("\n").length, 10, "default 10");
    assert.equal(runPipe(t, "head -n 3"), "L1\nL2\nL3");
    assert.equal(runPipe(t, "head -3"), "L1\nL2\nL3", "old bare-number syntax");
    assert.equal(runPipe(t, "tail -n 2"), "L11\nL12");
});

// ---- wc ----
test("wc: -l lines, -w words, -c chars; bare → all three", () => {
    assert.equal(runPipe("a b\nc\n", "wc -l"), "2");
    assert.equal(runPipe("a b\nc", "wc -w"), "3");
    assert.equal(runPipe("abc", "wc -c"), "3");
    assert.equal(runPipe("a b\nc", "wc"), "2 3 5", "chars counts the newline byte too (2+1+1+1)");
});

// ---- sort / uniq ----
test("sort: lexical, -n numeric, -r reverse, -u unique, -f fold", () => {
    assert.equal(runPipe("b\na\nc", "sort"), "a\nb\nc");
    assert.equal(runPipe("10\n2\n1", "sort"), "1\n10\n2", "lexical by default");
    assert.equal(runPipe("10\n2\n1", "sort -n"), "1\n2\n10");
    assert.equal(runPipe("a\nb\nc", "sort -r"), "c\nb\na");
    assert.equal(runPipe("b\na\nb\na", "sort -u"), "a\nb");
    assert.equal(runPipe("B\na\nA", "sort -f"), "a\nA\nB");
});
test("uniq: collapses ADJACENT dupes; -c counts; -i folds", () => {
    assert.equal(runPipe("a\na\nb\na", "uniq"), "a\nb\na", "only adjacent (not global)");
    assert.equal(runPipe("a\na\nb", "uniq -c"), "2 a\n1 b");
    assert.equal(runPipe("A\na\nb", "uniq -i"), "A\nb");
});
test("sort | uniq -c: the classic frequency count", () => {
    assert.equal(runPipe("b\na\nb\na\nb", "sort | uniq -c"), "2 a\n3 b");
});

// ---- pipes + parsing ----
test("pipes: stages chain left to right", () => {
    const t = Array.from({ length: 100 }, (_, i) => (i % 2 ? `even ${i}` : `odd ${i}`)).join("\n");
    assert.equal(runPipe(t, "grep even | head -n 2"), "even 1\neven 3");
});
test("quote-aware: a `|` and spaces inside quotes stay part of the grep pattern", () => {
    assert.equal(runPipe("a|b\nac\nxyz", "grep 'a|b'"), "a|b\nac", "the quoted | is regex alternation, not a stage split");
});

// REGRESSION. An ARRAY is one entry per stage and must never be re-split: the old code joined it with " | "
// and re-parsed, tearing `["grep -E head|tail"]` into a grep for "head" followed by a real `tail` stage —
// which returned a plausible WRONG answer with no error at all.
test("pipe: an array entry is ONE stage, so it can hold a bare | with no quoting", () => {
    const doc = "head of report\nerror: disk full\nwarn: slow\ntail of report";
    assert.equal(runPipe(doc, ["grep -E error|warn"]), "error: disk full\nwarn: slow");
    assert.equal(runPipe(doc, ["grep -E head|tail"]), "head of report\ntail of report", "both alternatives are real command names");
    assert.equal(runPipe(doc, ["grep -E error|warn", "head 1"]), "error: disk full", "…and it still pipes");
    // The two forms agree whenever no stage contains a `|`.
    assert.equal(runPipe(doc, ["grep -i report", "head 1"]), runPipe(doc, "grep -i report | head 1"));
    // Array housekeeping matches the string form's: blanks dropped, entries trimmed.
    assert.equal(runPipe(doc, ["  grep -i report  ", "", "head 1"]), "head of report");
    assert.equal(runPipe(doc, []), doc, "no stages = unchanged");
    // A malformed stage still raises the dialect's own actionable error.
    assert.throws(() => runPipe(doc, ["grep 'foo"]), /unterminated quote/);
    assert.throws(() => runPipe(doc, ["jq .x"]), /isn't a supported text command/);
    assert.equal(runPipe("foo bar\nfoo\nbar", "grep 'foo bar'"), "foo bar");
});
test("cat is a harmless no-op (models prefix it out of habit)", () => {
    assert.equal(runPipe("a\nb", "cat | grep a"), "a");
});
test("a trailing newline doesn't create a phantom empty last line", () => {
    assert.equal(runPipe("a\nb\n", "wc -l"), "2");
});

// ---- the modeled-dialect boundary ----
test("an un-modeled command is an actionable error (not a real shell)", () => {
    assert.throws(() => runPipe("x", "sed 's/a/b/'"), /sed.*NOT a real shell.*process the text in a script/s);
    assert.throws(() => runPipe("x", "awk '{print $1}'"), /awk.*NOT a real shell/s);
});
test("an unknown flag names the allowed ones", () => {
    assert.throws(() => runPipe("x", "grep -Z foo"), /grep.*doesn't support -Z/s);
});
test("an unterminated quote is a clear error", () => {
    assert.throws(() => runPipe("x", "grep 'foo"), /unterminated quote/);
});
test("a missing grep pattern is an actionable error", () => {
    assert.throws(() => runPipe("x", "grep"), /grep.*needs a PATTERN/s);
});
test("a numeric flag without its number errors", () => {
    assert.throws(() => runPipe("x", "head -n"), /head -n.*needs a number/s);
});

// --- structural stages (added for `dereference`) --------------------------------------------------------
// The line verbs are blind to structure, which is useless for the JSON a tool often returns. These parse the
// stream, transform it, and re-emit JSON, so they compose with the line verbs in either order.
const JSON_OUT = JSON.stringify({ id: 7, name: "widget", tags: ["a", "b"], nested: { deep: [{ k: 1 }] } });

test("keys / values read an object structurally; a path uses jq's leading dot", () => {
    assert.deepEqual(JSON.parse(runPipe(JSON_OUT, "keys")), ["id", "name", "tags", "nested"]);
    assert.equal(runPipe(JSON_OUT, ".name"), "widget");
    assert.equal(runPipe(JSON_OUT, ".nested.deep[0].k"), "1");
    // The composition that replaces a JS-style `.keys()` method form.
    assert.deepEqual(JSON.parse(runPipe(JSON_OUT, ".nested | keys")), ["deep"]);
    assert.deepEqual(JSON.parse(runPipe(JSON.stringify({ a: 1, b: "two" }), "values")), [1, "two"]);
    assert.throws(() => runPipe(JSON.stringify([1, 2]), "values"), /needs an object; this is an array of 2/);
});

test("keys on an array of objects yields the COLUMNS, and on a {columns,rows} table its columns", () => {
    assert.deepEqual(JSON.parse(runPipe(JSON.stringify([{ a: 1, b: 2 }, { a: 3, b: 4 }]), "keys")), ["a", "b"]);
    const table = JSON.stringify({ columns: ["name", "qty"], rows: [["apples", 3]] });
    assert.deepEqual(JSON.parse(runPipe(table, "keys")), ["name", "qty"], "a DataFrame pointer's keys are its columns");
});

test("schema reads the SHAPE, not the data (jsonschema is the same stage)", () => {
    const shape = runPipe(JSON_OUT, "schema");
    assert.match(shape, /name/, "the shape names the fields");
    assert.ok(!shape.includes("widget"), "…without the values, which is the point of asking for a shape");
    assert.equal(runPipe(JSON_OUT, "jsonschema"), shape, "models reach for this name; accept it");
});

test("type answers 'what is this' for JSON and for prose", () => {
    assert.match(runPipe(JSON_OUT, "type"), /object with 4 keys/);
    assert.match(runPipe(JSON.stringify([1, 2]), "type"), /array of 2/);
    assert.match(runPipe("just some prose\nlines", "type"), /text, \d+ chars \/ 2 lines/);
});

test("structural stages compose with the line verbs in either order", () => {
    const rows = JSON.stringify({ rows: [{ n: 1 }, { n: 2 }, { n: 3 }] });
    assert.match(runPipe(rows, ".rows | head 3"), /^\[/, "a path then a line verb");
    assert.equal(runPipe(JSON.stringify({ a: "x\ny\nz" }), ".a | wc -l"), "3", "…and the line verb sees real lines");
});

test("structural stages REFUSE prose rather than inventing a shape", () => {
    assert.throws(() => runPipe("alpha\nbeta", "keys"), /needs JSON, but this is plain text/);
    assert.throws(() => runPipe("alpha\nbeta", "schema"), /needs JSON/);
    // Looks like JSON but isn't — say so, don't silently treat it as text.
    assert.throws(() => runPipe("{not really json", "keys"), /doesn't parse/);
});

test("a wrong path says WHERE it failed and what was available", () => {
    assert.throws(() => runPipe(JSON_OUT, ".missing"), (e) => {
        assert.match(e.message, /no key "missing"/);
        assert.match(e.message, /id, name, tags, nested/, "the real keys, so the model can correct itself");
        return true;
    });
    assert.throws(() => runPipe(JSON_OUT, ".name[0]"), /needs an array, but that part of the value is a string/);
    assert.throws(() => runPipe(JSON_OUT, ".tags.nope"), /needs an object, but that part of the value is an array of 2/);
    // `.keys()` is not the syntax — it must fail, not be treated as a valid path.
    assert.throws(() => runPipe(JSON_OUT, ".keys()"), /segment|no key/i);
});

test("the dialect stays CLOSED — an unknown stage still refuses and names what exists", () => {
    assert.throws(() => runPipe(JSON_OUT, "jq .name"), /isn't a supported text command/);
    assert.throws(() => runPipe(JSON_OUT, "keys | eval x"), /isn't a supported text command/);
    assert.throws(() => runPipe(JSON_OUT, "keys | rm -rf /"), /isn't a supported text command/);
});

test("head/tail accept a bare count as well as the shell flag forms", () => {
    const lines = "a\nb\nc\nd\ne";
    // Models write the bare form constantly; refusing it would burn a turn teaching a flag that changes nothing.
    assert.equal(runPipe(lines, "head 2"), "a\nb");
    assert.equal(runPipe(lines, "head -n 2"), "a\nb");
    assert.equal(runPipe(lines, "head -2"), "a\nb");
    assert.equal(runPipe(lines, "tail 2"), "d\ne");
    assert.equal(runPipe(lines, "head"), lines, "no count at all is still the shell default of 10");
});

test("count is the structure-aware size (wc -l counts LINES, which a path makes useless)", () => {
    const table = JSON.stringify({ columns: ["a", "b"], rows: [[1, 2], [3, 4], [5, 6]] });
    assert.equal(runPipe(table, ".rows | count"), "3", "elements, not the lines of pretty-printed JSON");
    assert.equal(runPipe(table, "count"), "3", "a {columns,rows} table counts its ROWS");
    assert.equal(runPipe(JSON.stringify({ x: 1, y: 2 }), "count"), "2", "an object counts its keys");
    assert.equal(runPipe(JSON.stringify([9, 8]), "count"), "2");
    assert.equal(runPipe("a\nb\nc", "count"), "3", "text counts lines");
    // The trap this exists to remove — kept working, and deliberately still LINE-based.
    assert.equal(runPipe(table, ".rows | wc -l"), "14", "wc -l still means lines, of the JSON it was handed");
});

// A prompt that advertises a verb the dialect doesn't have costs the model a whole turn to discover. That
// already happened: DEREF_CLAUSE promised `len` and `slice A B`, leftovers from a discarded dialect. The list
// is now DERIVED from PIPE_CMDS, so this asserts the two really are one source rather than two that agree today.
test("DRIFT GUARD: every verb the dialect exports exists, and the prompt names exactly those", async () => {
    const { PIPE_CMDS } = await import("../text-pipe.ts");
    const { DEREF_CLAUSE } = await import("../prompts.ts");
    for (const v of PIPE_CMDS) {
        // Every exported verb must PARSE (a usage error is fine; "not supported" is not).
        const src = v === "grep" ? "grep x" : v === "head" || v === "tail" ? `${v} 2` : v;
        try { runPipe('{"a":[1,2,3]}', src); }
        catch (e) { assert.doesNotMatch(e.message, /isn't a supported text command/, `exported but missing: ${v}`); }
        assert.ok(DEREF_CLAUSE.includes(v), `the prompt doesn't mention the \`${v}\` verb`);
    }
    // And nothing the prompt promises is absent from the dialect (the failure that actually happened).
    for (const gone of ["len", "slice"]) {
        assert.ok(!new RegExp(`\\b${gone}\\b`).test(DEREF_CLAUSE), `the prompt still advertises the removed \`${gone}\``);
    }
});

// The prompt was single-sourced from PIPE_CMDS; the ERROR paths and TOOL PARAMETERS were not, and had drifted
// to a six-verb list while the dialect had twelve. A model told the set is smaller than it is never reaches
// for `schema` or a `.path` — the same wasted turn the PIPE_CMDS comment describes, on a different surface.
test("DRIFT GUARD: every model-facing description of the dialect is derived, not hardcoded", async () => {
    const { PIPE_CMDS, PIPE_HINT, PIPE_SYNTAX } = await import("../text-pipe.ts");
    for (const v of PIPE_CMDS) {
        assert.ok(PIPE_HINT.includes(v), `the pipe-error hint doesn't name \`${v}\``);
        assert.ok(PIPE_SYNTAX.includes(v), `the pipe parameter description doesn't name \`${v}\``);
    }
    // Both name the `.path` stage, which isn't a verb in PIPE_CMDS but is part of the dialect.
    assert.ok(PIPE_HINT.includes(".path") && PIPE_SYNTAX.includes(".path"));
    // No source file may spell the verb list out by hand again. Catches the exact stale list that was copied
    // into four places (fetch_url's param + error, navigate's verify error, interactives' error).
    const { readdirSync, readFileSync } = await import("node:fs");
    const stale = [];
    for (const f of readdirSync(new URL("../", import.meta.url)).filter((f) => f.endsWith(".ts"))) {
        if (f === "text-pipe.ts") continue;        // the single source is allowed to name them
        if (f.endsWith(".gen.ts")) continue;      // generated (build-info embeds a diff of the working tree)
        const src = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
        // Two verbs in a row, joined the way every hardcoded copy joined them.
        if (/grep\s*[·|]\s*head|grep \(flags|grep \(-i/.test(src)) stale.push(f);
    }
    assert.deepEqual(stale, [], `these hardcode a verb list instead of importing PIPE_HINT / PIPE_SYNTAX: ${stale.join(", ")}`);
});

// ---- ml.pipe: the dialect over ANY string, callable from exec ----
// The `pipe` PARAMETER only ever reaches one tool's own output; this is the same dialect inline, so text from
// a survey / python stdout / two fetches can be filtered without hand-rolling the JS equivalent.
const LOG = "head of report\nerror: disk full\nwarn: slow\ntail of report";

test("mlPipe: takes a string, and the array form works the same as it does in a tool", () => {
    assert.equal(mlPipe(LOG, "grep -E 'error|warn'"), "error: disk full\nwarn: slow");
    assert.equal(mlPipe(LOG, ["grep -E error|warn", "head 1"]), "error: disk full");
    assert.equal(mlPipe('{"rows":[1,2,3]}', ".rows | count"), "3", "the structural stages too");
});

// A model WILL write `ml.pipe(await ml.fetch(url), …)` rather than reaching into the result, so accept the
// whole object — the same accommodation the Python prelude makes for `pd.read_csv('current')`.
test("mlPipe: a fetch result is accepted whole, and its READABLE form is used", () => {
    assert.equal(mlPipe({ type: "html", text: "<h1>Hi</h1><h2>There</h2>", markdown: "# Hi\n## There" }, "grep '^##'"),
        "## There", "prefers .markdown — .text is the raw tag soup");
    assert.equal(mlPipe({ type: "json", text: '{"rows":[1,2]}' }, ".rows | count"), "2", "falls back to .text when there is no markdown");
});

test("mlPipe: no pipe returns the source unchanged; a bad source or stage throws actionably", () => {
    assert.equal(mlPipe(LOG), LOG);
    assert.equal(mlPipe(LOG, null), LOG);
    assert.equal(mlPipe(LOG, []), LOG);
    assert.equal(mlPipe(LOG, "   "), LOG);
    // An object that isn't a fetch result names the fix rather than stringifying to "[object Object]".
    assert.throws(() => mlPipe({ a: 1 }, "head"), /needs a string \(or a fetch result\), got object.*JSON\.stringify/s);
    assert.throws(() => mlPipe(42, "head"), /got number/);
    assert.throws(() => mlPipe(null, "head"), /got null/);
    // A bad stage raises the dialect's own error, naming the real verb set.
    assert.throws(() => mlPipe(LOG, "jq .x"), /isn't a supported text command/);
});
