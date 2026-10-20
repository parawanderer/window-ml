# Lane 6: follow-ups to lane 1 root C (result)

Work slug `repl-lane6`. Started by `bd5bfe29-a71f-4427-9c6b-254de5f986e0` (MiMo, 2026-10-19), finished by its Sonnet successor under the same slug and clone. Brief: `LANE_6_FOLLOWUPS.md`; what it follows up: "What did not work, or was left out" in `LANE_1_RESULT_C.md`.

## What landed

| # | Item | Result |
| --- | --- | --- |
| 1 | The two loader shapes | PR #830, merge `c789e647`. One shared patch per interpreter; the lookup is per cell. |
| 2 | Rename the two "property FAILS TODAY" tests | PR #822, merge `4ca4201d`. Titles renamed to the property they assert; the comments now say "Before #757:". |
| 3 | A bound for `handlesIn`, or a pin that it stays unexported | PR #822. The PIN: a test fails if `handlesIn` is exported from `src/sw/ml-wire-serve.ts`. |
| 4 | The red team's second pass on the codec fix `b05d1d7c` | Closed, nothing to do. Both passes ran before this lane opened and landed as PR #772 (merge `5d66a240`): pass (a) probed `handlesIn` and the one-level unwrap, pass (b) the `_ml_in` coercion on the `"run"` path. Ten failing-first guards in `tests/ml-wire.test.mjs` and `tests/python.test.mjs`. No hole found; no third pass requested. |

## Item 1: what was built

The per-dict patch chained: a second run's prelude saw no `_ml_orig_image_open` in its own dict, saved the first run's wrapper as the "original", and the outer wrapper read the new dict while the inner read run A's. Run B could be handed A's `img`. That is why the run prelude skipped the loaders and run cells lost the redirect.

- `PRELUDE_LOADERS` (`src/python/python-runtime.ts`) installs once, inside a function, guarded by an attribute on `pd`. The originals live in that function's closure, so no namespace holds an `_ml_orig_*` name. A later prelude run in any namespace installs nothing.
- The wrappers read `img`/`tables` from `__main__._ml_load_ns`, which each cell's prelude sets to its own namespace (`globals()`). They never read the dict that defined them.
- The bench prelude sets it to `None` (`PRELUDE_NO_LOADS`), so for the bench the real `Image.open`/`pd.read_*` runs. The worker clears the pointer in its `finally`.
- The `"run"` prelude is now `PRELUDE_BASE` + `PRELUDE_DATA_KEPT` + `PRELUDE_LOADERS`.
- `docs/dev/python-sandbox.md` and the prelude comments describe the new shape.

## Measured

Failing first, then passing (`tests/python.test.mjs`, "run dict loaders" section):

- Run B with no image of its own: `Image.open('canvas#stage')` raises `FileNotFoundError` (the real open ran); run A still gets its own `img`.
- `from PIL import Image` in a cell neither loses the redirect (run A) nor leaks one (run B).
- Tables are served per run: run B's only table is the one it meant, not run A's.
- The bench is never served a run's image or tables.
- No chain: `id(Image.open)`, `id(pd.read_csv)`, `id(pd.read_html)` are unchanged after other runs' preludes. Making the install unconditional fails this test (mutation-checked). The first version of this assertion walked `__wrapped__`, which the wrappers never set, so it could not fail; the generalist caught that.

`node scripts/test.mjs python` 110/0 and `npm test` 6027/0 on the branch.

## Assumed where the spec was silent

- **The bench keeps no redirect.** Its prelude had none and injects no names; giving it one is a behaviour change the brief did not ask for.
- **A single pointer is safe because runs are serialized** on the one interpreter (the generalist's review).
- **The pointer is set by the Python prelude, not the worker**, so the real-CPython tests exercise the same path the worker does. The worker only clears it.
- **Item 3 took the pin, not the bound.** No use for exporting `handlesIn` appeared, and a bound on an unexported function that is only reached behind `toWire`'s own depth and cycle refusal would be dead code.

## Left

- `__main__._ml_load_ns` is reachable from a cell; it names that cell's own namespace. Reaching another run's is the already-pinned full-mode `gc.get_objects()` residual (`tests/python-run-namespace-py.test.mjs`), not a new hole. Redirects are DX, not a security boundary, and a cell that assigns `Image.open = …` writes the shared slot, as it did before.
- `src/python/python-runtime.ts` is 803 lines (reminder only).
