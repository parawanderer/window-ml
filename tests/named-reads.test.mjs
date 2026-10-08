// named-reads.test.mjs — which pointer reads an approved `exec` script names (src/pointers/named-reads.ts), and the
// page-side resolver that answers only those (docs/spec/SITE_ACCESS.md slice 2, attack 14).
import { test } from "node:test";
import assert from "node:assert/strict";
import { namedReads, preResolvedDeref, readKey } from "../src/pointers/named-reads.ts";
import { expandPointers } from "../src/pointers/pointer-macro.ts";

const scan = (js) => namedReads(expandPointers(js).code);

// --- what counts as named ---

test("the macro's forms and a literal call are named, each with its pipe as stages", () => {
    assert.deepEqual(scan("return @tool:abc1234.length"), [{ ref: "@tool:abc1234", pipe: [] }]);
    assert.deepEqual(scan('@tool:"my label"'), [{ ref: '@tool:"my label"', pipe: [] }]);
    assert.deepEqual(scan(`ml.dereference("abc1234", { pipe: "grep x | head 5" })`), [{ ref: "abc1234", pipe: ["grep x", "head 5"] }]);
    assert.deepEqual(scan(`ml.dereference('abc1234', { "pipe": ["grep -E a|b", "head 2"], })`), [{ ref: "abc1234", pipe: ["grep -E a|b", "head 2"] }]);
    assert.deepEqual(scan("window.ml . dereference ( `exec` )"), [{ ref: "exec", pipe: [] }], "a template with no ${, spacing, window.ml");
    assert.deepEqual(scan(`ml.dereference("a\\u0062c\\x64\\n")`), [{ ref: "abcd\n", pipe: [] }], "escapes decode as JS does");
});

test("the same read named twice is one; the same pointer with two pipes is two", () => {
    assert.deepEqual(scan(`ml.dereference("x"); ml.dereference("x"); ml.dereference("x", { pipe: "head 1" })`),
        [{ ref: "x", pipe: [] }, { ref: "x", pipe: ["head 1"] }]);
    assert.equal(readKey("x", ["head 1"]), readKey("x", ["head 1"]));
    assert.notEqual(readKey("x", []), readKey("x", ["head 1"]));
});

// --- what is not: a computed pointer or pipe ---

test("ADVERSARIAL: a computed pointer or pipe is not named, whatever it is dressed as", () => {
    for (const js of [
        "ml.dereference(id)", "ml.dereference('@tool:' + id)", "ml.dereference(`@tool:${id}`)", "ml.dereference(ids[0])",
        `ml.dereference("x" + "")`, `ml.dereference("x", { pipe: p })`, `ml.dereference("x", { pipe: "head " + n })`,
        `ml.dereference("x", { pipe: ["head 1", p] })`, `ml.dereference("x", opts)`, `ml.dereference("x", { pipe: "a", other: 1 })`,
        `ml.dereference("x", { ...o })`, "const d = ml.dereference; d('x')", `ml["dereference"]("x")`,
        `ml.dereference("unterminated)`, `ml.dereference("x"`,
    ]) assert.deepEqual(scan(js), [], js);
});

test("text that looks like a call in a comment or a string counts: the person approved that text", () => {
    assert.deepEqual(scan(`// ml.dereference("noted")\nreturn "ml.dereference('quoted')"`), [{ ref: "noted", pipe: [] }, { ref: "quoted", pipe: [] }]);
});

test("HALTING: a long or pathological script is scanned in linear time", { timeout: 5000 }, () => {
    const big = "ml.dereference(".repeat(20000) + '"x")' + " ml.dereference('".repeat(20000);
    const t0 = Date.now();
    const reads = namedReads(big);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.deepEqual(reads, [{ ref: "x", pipe: [] }]);
});

// --- the resolver the page binds ---

test("the page answers only the reads sent with the call, and says what to write for any other", async () => {
    const deref = preResolvedDeref([
        { ref: "@tool:abc1234", pipe: [], value: "V", meta: { id: "abc1234", tool: "fetch_url", kind: "text", step: 1 } },
        { ref: "@tool:abc1234", pipe: ["head 1"], value: "V1", warning: "soft match" },
        { ref: "@tool:gone", pipe: [], error: "MemoryFault: pointer '@tool:gone' does not exist." },
    ]);
    assert.deepEqual(await deref("@tool:abc1234"), { value: "V", meta: { id: "abc1234", tool: "fetch_url", kind: "text", step: 1 } });
    assert.deepEqual(await deref("@tool:abc1234", "head 1"), { value: "V1", warning: "soft match" });
    assert.deepEqual(await deref("@tool:abc1234", ["head 1"]), { value: "V1", warning: "soft match" }, "a pipe as stages is the same read");
    await assert.rejects(deref("@tool:gone"), /MemoryFault/, "the read's own error, where the script reads it");
    await assert.rejects(deref("@tool:abc1234", "head 2"), /was not named in the script.*literals/s);
    await assert.rejects(deref("@tool:fffffff"), /was not named in the script/);
    await assert.rejects(preResolvedDeref([])("x"), /was not named/);
});
