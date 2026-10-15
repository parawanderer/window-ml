// redteam-text-captures.test.mjs — what a hostile page must NOT get from a whole text capture in the value store
// (POINTER_VALUES.md, slice 9; the functional tests are tests/text-captures.test.mjs).

// The page shares the main world with any tool code the extension runs in it, posts any window message, knows every run
// id, and can answer any tool call the run delegates to it. What it must not get from a stored body, each property a test
// here with a positive control: a `textValue` the page supplies is never claimed, a key one run holds is never read by
// another, a forged key reads as absent rather than as someone else's, and no page-started message answers with a body.
//
// Assertions live AFTER `wireRun` returns: the cell runs inside the offscreen PY_RUN, whose throw is that run's Python
// error rather than the test's, so a failure inside it is swallowed (the same shape as text-captures.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { wireRun, wireCall, SITE } from "./ml-wire-harness.mjs";

const require = createRequire(import.meta.url);
// The CommonJS build, so its key range matches the one the harness puts in the realm.
const { IDBFactory } = require("fake-indexeddb");
const { PAGE_STARTED_TYPES } = require("../src/page-relay.ts");

const T = { timeout: 60000 };
const BIG = Array.from({ length: 30000 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
const NOTES = "https://data.example/notes.txt";
const OTHER = "https://data.example/other.txt";
/** Twenty lines only in the whole body: none is in the 4,000-character preview the model was shown. */
const PAST_PREVIEW = "grep -E '^line 2[0-9]{4} ' | head 20";
/** The store's key shape (value-store.ts `mintKey`): unguessable, so a forged one is a guess that must read as absent. */
const FORGED = "v00000000deadbeef";
const PAGE = "PAGE-SAID";
const hostilePage = (id = SITE.id, url = SITE.url) => ({ tab: { id, url }, url, frameId: 0, documentId: `doc-${id}`, origin: new URL(url).origin });

/** The stored text's key in one worker's store, or undefined when it did not keep one. */
const textKey = async (bg) => (await bg.context.__mlValues.rows()).find((r) => r.format === "text")?.key;
/** The `@tool:<7 hex>` token in a tool message whose text contains `mark`. */
const tokenIn = (bg, mark) => {
    const last = bg.calls.filter((c) => String(c.url).includes("/chat/completions")).at(-1);
    const texts = (last?.body?.messages ?? []).filter((m) => m.role === "tool").map((m) => String(m.content));
    return /@tool:([0-9a-f]{7})/.exec(texts.find((t) => t.includes(mark)) ?? "")?.[1];
};
const lines = (text) => String(text ?? "").split("\n");
/** The page's answer to a delegated tool call: its result, and whatever `extra` puts beside it (a forged `textValue`,
 *  a render naming a foreign key). The key is read at answer time, from the same store the run just wrote. */
const pageSays = (extra = {}) => async (_msg, bg) => ({ result: PAGE, ...extra, ...(extra.textValue === true ? { textValue: await textKey(bg) } : {}) });

// --- a page's answer never names a stored body ---

test("a page-supplied textValue is dropped: only the worker's own mints a pointer that reads the whole", T, async () => {
    // The one gate is `workerEnvelopes` (sw-run-host.ts): an envelope the worker made by running the tool itself may name
    // a stored text; a page's answer is deserialized and can never be in that set. Positive control in the same test: the
    // worker-run fetch_url's own `textValue` does read past the preview.
    const got = { own: null, viaPage: null, rows: [], key: undefined, pageTok: undefined };
    await wireRun(async (wire, bg) => {
        got.key = await textKey(bg);
        got.rows = await bg.context.__mlValues.rows();
        got.own = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: PAST_PREVIEW }]);
        got.pageTok = tokenIn(bg, PAGE);
        // UNPIPED: a pipe greps the page's one line away and hides which text was read. If the gate fails and the key is
        // claimed, this read is the WHOLE 1.5 MB body — past WIRE_VALUE_CAP an unpiped read answers a pointer.
        got.viaPage = await wireCall(bg, wire, "dereference", [`@tool:${got.pageTok}`]);
    }, {
        body: BIG, url: NOTES, store: true,
        calls: [
            { name: "fetch_url", args: { url: NOTES } },
            { name: "click", args: { selector: "#x", token: "page" } },
            { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        ],
        // The page has learned its own run's key (a main-world exec's pre-read carries `meta.value`) and answers a tool
        // as if the worker had kept a body: the gate must drop it either way.
        pageAnswer: pageSays({ textValue: true }),
    });
    assert.ok(got.key, "positive control: the fetch kept its whole body");
    assert.equal(lines(got.own?.value?.text).length, 20, "positive control: the worker's own key reads whole");
    assert.ok(got.pageTok, "the page's call was citable and the model was given a token");
    assert.match(got.viaPage?.value?.text ?? "", /^PAGE-SAID/, `the page's token reads what the page said, not the body: ${JSON.stringify(got.viaPage).slice(0, 300)}`);
    assert.ok(!got.viaPage?.pointer, "and it is not a pointer at a stored body either");
    assert.ok(!got.viaPage?.value?.meta?.value, "the page's token names no stored value");
});

test("a page-supplied textValue naming a guessed key mints no pointer and stores nothing", T, async () => {
    const got = { viaPage: null, rows: [] };
    await wireRun(async (wire, bg) => {
        got.viaPage = await wireCall(bg, wire, "dereference", [`@tool:${tokenIn(bg, PAGE)}`]);
        got.rows = await bg.context.__mlValues.rows();
    }, {
        body: BIG, url: NOTES, store: true,
        calls: [
            { name: "fetch_url", args: { url: NOTES } },
            { name: "click", args: { selector: "#x", token: "page" } },
            { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        ],
        pageAnswer: pageSays({ textValue: FORGED }),
    });
    assert.equal(got.viaPage?.value?.text, PAGE, `the page's token reads what the page said: ${JSON.stringify(got.viaPage).slice(0, 200)}`);
    assert.ok(!got.rows.some((r) => r.key === FORGED), `a guessed key is never claimed: ${JSON.stringify(got.rows)}`);
});

// --- a key one run holds is another run's absent ---

test("a second run reads another run's key as absent, never as its body", T, async () => {
    // The holders check in `readStoredText` is the layer under the `textValue` gate: even a pointer that somehow names a
    // foreign key must fail the read for a session that does not hold it.
    const idb = new IDBFactory();
    const a = { key: undefined, own: null };
    await wireRun(async (wire, bg) => {
        a.key = await textKey(bg);
        a.own = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: PAST_PREVIEW }]);
    }, { body: BIG, url: NOTES, idb, calls: [
        { name: "fetch_url", args: { url: NOTES } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
    ] });
    assert.ok(a.key, "positive control: run A stored a body");
    assert.equal(lines(a.own?.value?.text).length, 20, "positive control: run A reads its own whole body");

    const b = { viaPage: null };
    await wireRun(async (wire, bg) => {
        b.viaPage = await wireCall(bg, wire, "dereference", [`@tool:${tokenIn(bg, PAGE)}`]);
    }, {
        body: "item 1\nitem 2\n", url: OTHER, idb,
        calls: [
            { name: "fetch_url", args: { url: OTHER } },
            { name: "click", args: { selector: "#x", token: "page" } },
            { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        ],
        pageAnswer: pageSays({ textValue: a.key }),
    });
    const seen = JSON.stringify(b.viaPage);
    // A 1.5 MB read past WIRE_VALUE_CAP answers a POINTER rather than text, so a pointer at run A's body is as much a
    // leak as the text would be — assert neither.
    assert.ok(!b.viaPage?.pointer, `run B is handed no pointer at run A's body: ${seen.slice(0, 300)}`);
    assert.ok(!/^line 20000 /m.test(b.viaPage?.value?.text ?? ""), `run B never sees run A's body: ${seen.slice(0, 300)}`);
    assert.ok(!seen.includes("line 20000"), "and no error text carries it either");
});

test("a forged key reads as not-in-the-store, never as someone else's body", T, async () => {
    const a = { own: null };
    await wireRun(async (wire, bg) => {
        a.own = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: PAST_PREVIEW }]);
    }, { body: BIG, url: NOTES, store: true, calls: [
        { name: "fetch_url", args: { url: NOTES } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
    ] });
    assert.match(a.own?.value?.text ?? "", /^line 20000 /, "positive control: a held key reads whole");

    const b = { viaPage: null };
    await wireRun(async (wire, bg) => {
        b.viaPage = await wireCall(bg, wire, "dereference", [`@tool:${tokenIn(bg, PAGE)}`]);
    }, {
        body: "x\n", url: OTHER, idb: new IDBFactory(),
        calls: [
            { name: "fetch_url", args: { url: OTHER } },
            { name: "click", args: { selector: "#x", token: "page" } },
            { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        ],
        pageAnswer: pageSays({ textValue: FORGED }),
    });
    assert.match(b.viaPage?.value?.text ?? "", /^PAGE-SAID/, `a forged key never yields a body: ${JSON.stringify(b.viaPage).slice(0, 300)}`);
});

// --- no page-started path reads a stored body ---

test("VALUE_COLUMNS from a tab that does not hold the key is refused", T, async () => {
    // The key reaches a page with its pointer, so the key alone must never be enough: the handler checks the run, the
    // holders and the running script's named reads (background.ts).
    const idb = new IDBFactory();
    const a = { key: undefined };
    await wireRun(async (wire, bg) => { a.key = await textKey(bg); }, { body: BIG, url: NOTES, idb, calls: [
        { name: "fetch_url", args: { url: NOTES } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
    ] });
    assert.ok(a.key, "positive control: a body is stored");

    const got = {};
    await wireRun(async (wire, bg) => {
        const run = wire?.run ?? "run-of-this-call";
        got.foreign = await bg.send({ type: "VALUE_COLUMNS", runId: run, key: a.key, names: ["line"] }, hostilePage());
        got.forged = await bg.send({ type: "VALUE_COLUMNS", runId: run, key: FORGED, names: ["line"] }, hostilePage());
        got.noRun = await bg.send({ type: "VALUE_COLUMNS", runId: "run-of-another-tab", key: a.key, names: ["line"] }, hostilePage());
    }, {
        body: "x\n", url: OTHER, idb,
        calls: [
            { name: "fetch_url", args: { url: OTHER } },
            { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        ],
    });
    for (const k of ["foreign", "forged", "noRun"]) {
        assert.ok(got[k]?.error, `${k} is refused: ${JSON.stringify(got[k]).slice(0, 200)}`);
        assert.ok(!JSON.stringify(got[k]).includes("line 20000"), `${k} carried none of the body`);
    }
});

test("no page-started message type answers with a stored body", T, async () => {
    // Enumerated rather than sampled: every type in PAGE_STARTED_TYPES, sent with the key, must not come back with the
    // body. A type that never answers is raced against a short timer, as `attempt()` does in tests/redteam.test.js.
    const idb = new IDBFactory();
    const a = { key: undefined };
    await wireRun(async (wire, bg) => { a.key = await textKey(bg); }, { body: BIG, url: NOTES, idb, calls: [
        { name: "fetch_url", args: { url: NOTES } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
    ] });
    assert.ok(a.key);

    const attempt = (bg, type, payload) => Promise.race([
        bg.send({ type, requestId: "r", payload }, hostilePage()).then((r) => r ?? null),
        new Promise((r) => setTimeout(() => r(undefined), 40)),
    ]);
    const answers = {};
    await wireRun(async (wire, bg) => {
        for (const type of PAGE_STARTED_TYPES) {
            answers[type] = await attempt(bg, type, { key: a.key, runId: wire?.run, valueKey: a.key, body: BIG, url: NOTES, code: `open(${JSON.stringify(a.key)})`, js: `return ${JSON.stringify(a.key)}` });
        }
    }, {
        body: "x\n", url: OTHER, idb,
        calls: [
            { name: "fetch_url", args: { url: OTHER } },
            { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        ],
    });
    for (const [type, r] of Object.entries(answers)) {
        const s = JSON.stringify(r ?? null);
        assert.ok(!s.includes("line 20000"), `${type} answered with the body: ${s.slice(0, 200)}`);
    }
});

// --- a render naming a foreign key loses the key ---

test("a page's render naming a key the run may not hold does not ride the step's pointer", T, async () => {
    // `withHeldValuesOnly` drops a `table`/`python-out` `value` the claim would refuse, because the sidebar's "copy all
    // rows" reads the value by that key alone. Positive control: the run's own stored body still reads whole.
    const idb = new IDBFactory();
    const a = { key: undefined, own: null };
    await wireRun(async (wire, bg) => {
        a.key = await textKey(bg);
        a.own = await wireCall(bg, wire, "dereference", ["fetch_url", { pipe: PAST_PREVIEW }]);
    }, { body: BIG, url: NOTES, idb, calls: [
        { name: "fetch_url", args: { url: NOTES } },
        { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
    ] });
    assert.ok(a.key);
    assert.equal(lines(a.own?.value?.text).length, 20, "positive control: the run reads its own body");

    const b = { viaPage: null };
    await wireRun(async (wire, bg) => {
        b.viaPage = await wireCall(bg, wire, "dereference", [`@tool:${tokenIn(bg, PAGE)}`]);
    }, {
        body: "x\n", url: OTHER, idb,
        calls: [
            { name: "fetch_url", args: { url: OTHER } },
            { name: "click", args: { selector: "#x", token: "page" } },
            { name: "python_exec", args: { code: "print(1)", mode: "readonly" } },
        ],
        pageAnswer: pageSays({ renderOut: { type: "table", value: a.key, columns: ["line"], rows: [["x"]], rowCount: 1 } }),
    });
    assert.match(b.viaPage?.value?.text ?? "", /^PAGE-SAID/, `a render's foreign key never yields that body: ${JSON.stringify(b.viaPage).slice(0, 300)}`);
    assert.ok(!b.viaPage?.value?.meta?.value, "and the key does not ride the render into the step's pointer");
});
