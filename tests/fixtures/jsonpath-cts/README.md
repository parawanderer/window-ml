# JSONPath Compliance Test Suite (vendored)

`cts.json` is the RFC 9535 compliance suite from <https://github.com/jsonpath-standard/jsonpath-compliance-test-suite>,
at commit `9d1a415a53f5dfb291bc874823892e49174e38eb` (2026-09-17), under the BSD-2 license in `LICENSE`.

`tests/json-path.test.mjs` runs every case against `src/json-path.ts`: a valid selector must give the expected values
AND the expected Normalized Paths, and an invalid one must be refused. To update, replace `cts.json` and this commit.
