// text-captures.test.mjs — a text capture past its preview keeps its WHOLE body in the value store (POINTER_VALUES.md,
// slice 9): the model's view is unchanged, and a read by pointer (the dereference tool, the `ml` wire) computes over the
// whole.

// A worker-built run in node:vm (tests/ml-wire-harness.mjs) with a fake-indexeddb value store. The body is 30,000 lines,
// about 1.5 MB, so its last lines are far past fetch_url's 4,000-character preview.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wireRun, wireCall } from "./ml-wire-harness.mjs";
import { runOn } from "./isolated-harness.mjs";

const T = { timeout: 60000 };
const BIG = Array.from({ length: 30000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
const NOTES = "https://data.example/notes.txt";
const OTHER = "https://data.example/other.txt";
/** Twenty lines that are only in the whole body: none is in the first 4,000 characters the model was shown. */
const PAST_PREVIEW = "grep -E '^line 2[0-9]{4} ' | head 20";

// --- the wire reads the whole ---

test("a piped dereference over the wire runs at the store: twenty lines from past the preview cross", T, async () => {
    let got;
    await wireRun(async (wire, bg) => { got = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: PAST_PREVIEW }]); }, { body: BIG, url: NOTES, store: true });
    const lines = (got.value?.text ?? "").split("\n");
    assert.equal(lines.length, 20, `twenty lines cross: ${JSON.stringify(got).slice(0, 300)}`);
    assert.match(lines[0], /^line 20000 /, "the first match is far past the preview");
    assert.match(lines[19], /^line 20019 /);
});

test("an unpiped dereference of a whole body past WIRE_VALUE_CAP answers a pointer, not the text", T, async () => {
    let got;
    await wireRun(async (wire, bg) => { got = await wireCall(bg, wire, "dereference", ["fetch_url"]); }, { body: BIG, url: NOTES, store: true });
    assert.ok(got.pointer, `a pointer answer: ${JSON.stringify(got).slice(0, 300)}`);
    assert.match(got.pointer.token, /^@tool:[0-9a-f]{7}$/);
    assert.ok(got.pointer.size > 1 << 20, "its size is the whole body's");
    assert.ok(!("value" in got), "no text crosses");
});

// --- the same read answers the same wherever the script runs ---

for (const path of ["readonly", "userScripts", "cdp", "none"]) {
    // The main world is reached by a pointer-naming script only where no isolated world is available (exec-routing.ts); it
    // is sent the preview, as before: the one deliberate exception (POINTER_VALUES.md, slice 9).
    const main = path === "none";
    test(`an exec's dereference of a stored text: ${main ? "the main world keeps the preview" : `reads the whole on ${path}`}`, { timeout: 120000 }, async () => {
        const script = (id) => `const r = await ml.dereference("@tool:${id}", { pipe: ${JSON.stringify(PAST_PREVIEW)} }); return "<<<" + JSON.stringify(r.text.split("\\n").slice(0, 1).concat([r.text.split("\\n").length])) + ">>>";`;
        const { results } = await runOn(path, [script], { fetches: [{ url: NOTES, token: "notes" }], bodies: { [NOTES]: BIG }, types: { [NOTES]: "text/plain" } });
        const m = /<<<(.*)>>>/.exec(results.at(-1) ?? "");
        assert.ok(m, `the probe reported: ${(results.at(-1) ?? "").slice(0, 300)}`);
        const [first, n] = JSON.parse(m[1]);
        if (main) { assert.deepEqual([first, n], ["", 1], "nothing past the preview reaches the page's world"); return; }
        assert.match(first, /^line 20000 /, "the first match is past the preview");
        assert.equal(n, 20, "twenty lines");
    });
}

// --- the model's view is unchanged ---

test("the model is handed the same fetch_url preview whether or not the whole body is stored", T, async () => {
    const calls = [{ name: "fetch_url", args: { url: NOTES } }];
    const without = await wireRun(async () => {}, { body: BIG, url: NOTES, calls });
    const withStore = await wireRun(async () => {}, { body: BIG, url: NOTES, calls, store: true });
    assert.match(without.toolResults[0] ?? "", /\[first 4000 of 1,?548,?889 chars\]/, "positive control: the preview and its note");
    assert.equal(withStore.toolResults[0], without.toolResults[0], "the same preview, byte for byte");
});

test("the dereference tool pipes over the whole body, and its unpiped read is still sized for the context", T, async () => {
    const calls = [
        { name: "fetch_url", args: { url: NOTES } },
        { name: "dereference", args: { token: "fetch_url", pipe: "grep -E '^line 29999 '" } },
        { name: "dereference", args: { token: "fetch_url" } },
    ];
    const { toolResults } = await wireRun(async () => {}, { body: BIG, url: NOTES, calls, store: true });
    assert.match(toolResults[1] ?? "", /line 29999 x{40}/, `the last line is reachable: ${(toolResults[1] ?? "").slice(0, 300)}`);
    assert.ok(toolResults[2].length < 100000, `an unpiped read does not put 1.5 MB in the context (${toolResults[2].length} chars)`);
    assert.match(toolResults[2], /1,?548,?889/, "it says how large the whole is");
});

// --- failure: never degrade to the preview ---

test("a whole body evicted by the budget fails the read with the store's reason, never the preview", T, async () => {
    const calls = [
        { name: "fetch_url", args: { url: NOTES, token: "the notes" } },
        { name: "fetch_url", args: { url: OTHER } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
    ];
    let evicted, kept;
    // Two 1.5 MB bodies in a 2 MB budget: storing the second evicts the first, which nothing has read since.
    await wireRun(async (wire, bg) => {
        evicted = await wireCall(bg, wire, "dereference", ['@tool:"the notes"', { pipe: PAST_PREVIEW }]);
        kept = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: "grep -E '^item 2[0-9]{4} ' | head 20" }]);
    }, { bodies: { [NOTES]: BIG, [OTHER]: BIG.replaceAll("line", "item") }, calls, store: true, budgetMB: 2 });
    assert.equal((kept.value?.text ?? "").split("\n").length, 20, `positive control: the body still stored reads whole: ${JSON.stringify(kept).slice(0, 300)}`);
    assert.ok(evicted.error, `the evicted body's read fails: ${JSON.stringify(evicted).slice(0, 300)}`);
    assert.match(evicted.error.message, /evicted/, "with the store's reason");
});

test("a body the fetch clipped at its read cap is not kept: its pointer reads the preview, as before", T, async () => {
    // Past FETCH_URL_MAX (8,000,000 characters) the fetch keeps a prefix; stored, it would read as the whole.
    const huge = BIG.repeat(6);
    let got;
    await wireRun(async (wire, bg) => { got = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: PAST_PREVIEW }]); }, { body: huge, url: NOTES, store: true });
    assert.equal(got.value?.text, "", `nothing past the preview: ${JSON.stringify(got).slice(0, 200)}`);
    assert.ok(!got.value?.meta?.value, "the pointer names no stored value");
});

// --- where there is no store, nothing changes ---

test("with no value store the pointer reads what it read before: the preview, with its note", T, async () => {
    let got;
    await wireRun(async (wire, bg) => { got = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: PAST_PREVIEW }]); }, { body: BIG, url: NOTES });
    assert.equal(got.value?.text, "", "nothing past the preview is reachable");
});
