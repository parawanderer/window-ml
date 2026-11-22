// redteam-table-plan.test.mjs — a stored table's read plan is a closed shape at every reader, its bounds cannot be named away, and the
// decode cache never confuses two options or answers for a value the store no longer holds (#2062, ML_TABLE.md, "Views of a stored
// table in JS"). Source: src/table/table-plan.ts (checkReadPlan, STORED_READ_FIELDS), src/sw/iso-channel.ts (isoServer, the isolated
// channel), src/table/table-data.ts (storedReadRows), src/table/table-decode-cache.ts (cachedStoredColumns).
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkReadPlan, STORED_READ_FIELDS } from "../src/table/table-plan.ts";
import { isoServer, ISO_REFUSED } from "../src/sw/iso-channel.ts";
import { storedReadRows, MAX_STORED_READ_CELLS } from "../src/table/table-data.ts";
import { cachedStoredColumns, clearDecodeCache, decodeCacheStats } from "../src/table/table-decode-cache.ts";

const enc = new TextEncoder();
const csv = (s) => enc.encode(s).buffer;

// --- the plan is closed: one field outside the shape is refused, at every reader ---

test("RED TEAM (plan): any field outside the closed shape is refused, and a valid plan passes", () => {
    // The content script (src/content.ts:320), the worker's router (src/background.ts:993) and the isolated
    // channel (src/sw/iso-channel.ts:95) all call this one function; the channel is exercised end to end below.
    const base = { type: "PAGE_VALUE_COLUMNS", id: "i1", runId: "run-1", op: "cols", key: "k1", names: ["a"] };
    assert.deepEqual(checkReadPlan(base), {});
    assert.deepEqual(checkReadPlan({ ...base, limit: 5 }), { limit: 5 });
    for (const field of ["where", "sql", "path", "limitBy", "names2", "__proto__", "constructor", "then"]) {
        const r = checkReadPlan({ ...base, [field]: 1 });
        assert.ok("refused" in r, `${field} was accepted`);
    }
    // The shape is exactly the listed fields, so a new field in the table must be a deliberate addition.
    assert.deepEqual([...STORED_READ_FIELDS].sort(), ["delimiter", "headerless", "id", "key", "limit", "names", "op", "runId", "type"]);
});

test("RED TEAM (plan): a limit that is not a whole number from 0 is refused, so no bound is named away", () => {
    const base = { type: "PAGE_VALUE_COLUMNS", id: "i1", key: "k1", names: ["a"] };
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, "5", {}, []]) {
        const r = checkReadPlan({ ...base, limit });
        assert.ok("refused" in r, `limit ${String(limit)} was accepted`);
    }
    assert.deepEqual(checkReadPlan({ ...base, limit: 0 }), { limit: 0 });
    assert.deepEqual(checkReadPlan({ ...base, limit: null }), {});
});

test("RED TEAM (plan): the isolated channel refuses a plan with a foreign field before any read, and a holder's refusal names nothing", async () => {
    const reads = [];
    const answerFor = (holders) => isoServer("run-1", [{ meta: { value: "k1", table: { columns: ["a"], rows: [[1]], shape: [1, 1] } } }], {
        deref: async () => null, holders: async () => holders, columns: async (...a) => { reads.push(a); return { rowCount: 1, columns: { a: [1] } }; },
        sh: async () => null,
    });
    const foreign = await answerFor(["run-1"])({ op: "cols", key: "k1", names: ["a"], where: "x > 1" });
    assert.deepEqual(foreign, { error: ISO_REFUSED.malformed }, JSON.stringify(foreign));
    assert.deepEqual(reads, [], "a refused plan reached the reader");
    // positive control: the same call without the foreign field reads.
    const ok = await answerFor(["run-1"])({ op: "cols", key: "k1", names: ["a"], limit: 1 });
    assert.equal(ok.ok?.rowCount, 1);
    assert.equal(reads.length, 1);
    // another run's holder is refused, and the answer names neither the holder nor the key's content.
    const held = await answerFor(["run-2"])({ op: "cols", key: "k1", names: ["a"] });
    assert.deepEqual(held, { error: ISO_REFUSED.held }, JSON.stringify(held));
});

test("RED TEAM (plan): the per-read cell bound cannot be raised by a plan — the rows times columns is what is checked", () => {
    assert.equal(storedReadRows(10, ["a", "b"], { limit: 5 }), 5);
    assert.throws(() => storedReadRows(Math.ceil(MAX_STORED_READ_CELLS / 2) + 1, ["a", "b"], {}), /more than one read hands back/);
    // A limit below the bound is fine; one above the file is the file, so only the file can exceed it.
    // A plan can only LOWER the rows returned, so a limit cannot push a read over a bound the file itself is under.
    assert.equal(storedReadRows(MAX_STORED_READ_CELLS + 1, ["a"], { limit: 1 }), 1);
});

// --- the decode cache: keyed by the options, and asked only after the store ---

test("RED TEAM (plan): two decode options of one blob are two cache keys, and neither answers the other", async () => {
    clearDecodeCache();
    const bytes = csv("a;b\n1;2\n");
    const first = await cachedStoredColumns("blob-1", async () => bytes, "csv", ["a"], { delimiter: ";" });
    assert.deepEqual(first.columns.a, [1]);
    assert.equal(decodeCacheStats().decodes, 1);
    // The other option parses one column named "a;b", so it refuses "a" rather than answering the first decode's rows.
    await assert.rejects(cachedStoredColumns("blob-1", async () => bytes, "csv", ["a"], { delimiter: "," }), /No column "a"/);
    assert.equal(decodeCacheStats().decodes, 2, "the second option reused the first decode");
    // positive control: a repeat of the first option is served from the cache, with its own parse.
    const again = await cachedStoredColumns("blob-1", async () => bytes, "csv", ["a"], { delimiter: ";" });
    assert.deepEqual(again.columns.a, [1]);
    assert.equal(decodeCacheStats().decodes, 2, "a repeat decode ran again");
});
