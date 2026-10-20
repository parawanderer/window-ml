# Lane 7 result: `python_exec`'s `mode` removed (#820, merged 2026-10-19)

## Built

- `mode: "readonly" | "full"` is gone from the tool schema, `ml.pythonExec`, the contract, the worker (`sw-python.ts`, `worker-tools.ts`, `sw-run-host.ts`), grants, auto-approval, the bench (picker and per-mode namespaces), the card, the settings text and the model-facing text.
- Every cell runs in a hardened worker. `pythonCellInDialect` (`src/agent/python-dialect.ts`) is the one question that replaced `mode`: inside runs with no card and the read-only slice of `ml`; outside asks and gets the full gated `ml`. The worker derives the wire realm and the grant class from the code, never from a caller field.
- The approval card shows the verdict as a plain hint, not a warning.

## Assumed where the spec was silent

- No membership predicate exists in the Pyodide build, so `pythonCellInDialect` is false for every cell and **no cell auto-approves**. `autoApprovePython` is inert until lane 5 plugs a predicate in at that function. The wider reading (keep auto-approving what ran as `readonly`) was mailed to `repl-specs` and not built.
- Stored grants keep their key prefixes (`full:` outside, `readonly:` inside). A stored `full:` grant still covers its code; a stored `readonly:` one no longer does, so that cell asks again. Fixture: `tests/grant-extract.test.mjs`.
- The extension's own frame (the bench) needs no whitelist to run a cell: the rule that required one guarded `full` mode's network, which no longer exists. `tests/self-approval-origin.test.js` records it.

## Measured

Core, python, panel and ext genres pass locally; the e2e specs that touched Python (bench-dock, python-stream, review-media, site-access) pass; CI on the merged head was 11 pass, 0 fail. Reviews: the generalist (worker side) and lane 4 (card, nested asks), both approved.

## Cost to know about

Specs that relied on `autoApprovePython` for Python now approve through `approveGates(ext)` (`tests/e2e/harness.mjs`), and the bundle-in-vm tests use `dialectInside` (`loadBackground`, `loadPageWorld`), which patches the default verdict in the bundle's text. When the real predicate lands, replace those stand-ins with cells that are really inside.

## Left

- The `hardened: false` branch in `offscreen.ts` and `python-worker.ts` is unreachable from the service worker; delete it with the Pyodide build.
- DONE (lane 3, 2026-10-20): `pythonDialectVerdict` is gone; a Python cell's card says where it left the dialect (`pythonOutsideWhy`, the step's `askWhy`).
- No red-team pass: no new tool, member or message type, and the change only narrows what runs unasked.
