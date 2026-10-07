// json-path.test.mjs — `ml.jsonPath`, RFC 9535, checked against the official compliance suite (tests/fixtures/jsonpath-cts/):
// every valid selector must give the expected values AND Normalized Paths, every invalid one must be refused.
import { test } from "node:test";
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { mlJsonPath, JsonPathError } from "../src/json-path.ts";

const CTS = JSON.parse(readFileSync(new URL("./fixtures/jsonpath-cts/cts.json", import.meta.url), "utf8")).tests;

// --- the RFC 9535 compliance suite ---------------------------------------------------------------------------------

test("RFC 9535 compliance suite: every case", () => {
    const failures = [];
    for (const c of CTS) {
        try {
            if (c.invalid_selector) {
                let threw = null;
                try { mlJsonPath(c.document ?? {}, c.selector); } catch (e) { threw = e; }
                if (!(threw instanceof JsonPathError)) failures.push(`${c.name}: accepted an invalid selector ${JSON.stringify(c.selector)}`);
                continue;
            }
            const got = mlJsonPath(c.document, c.selector, { paths: true });
            const values = got.map((n) => n.value), paths = got.map((n) => n.path);
            // `results` lists every acceptable answer, for a selector whose order the RFC leaves to the implementation.
            const options = c.results ? c.results.map((r, i) => [r, c.results_paths?.[i]]) : [[c.result, c.result_paths]];
            const ok = options.some(([r, p]) => {
                try { assert.deepStrictEqual(values, r); if (p) assert.deepStrictEqual(paths, p); return true; } catch { return false; }
            });
            if (!ok) failures.push(`${c.name}: ${JSON.stringify(c.selector)} gave ${JSON.stringify(values).slice(0, 120)} at ${JSON.stringify(paths).slice(0, 120)}`);
        } catch (e) {
            failures.push(`${c.name}: ${JSON.stringify(c.selector)} threw ${e.message}`);
        }
    }
    assert.deepStrictEqual(failures, [], `${failures.length} of ${CTS.length} cases failed:\n${failures.slice(0, 40).join("\n")}`);
});
