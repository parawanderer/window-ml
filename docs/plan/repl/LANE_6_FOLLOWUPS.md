# Lane 6: lane 1's four follow-ups (MiMo)

Read first: [`ROUND_3.md`](ROUND_3.md); [`LANE_1_RESULT_C.md`](LANE_1_RESULT_C.md), all of it, since the four items are
its "follow-up" notes; `docs/spec/ML_WIRE.md` and `docs/spec/PYTHON_DIALECT.md`, "The namespace".

## The four items

1. **The two loader shapes** for the per-run image redirect: `LANE_1_RESULT_C.md` names them and says which is sound
   ("one shared patch whose lookup is a per-call context the worker sets"). Build that one. The measure is the case
   it records: run B with no image of its own must NOT see run A's `img`, and a cell that does `from PIL import Image`
   must neither leak nor lose the redirect. Failing-first test in the Python genre.
2. **Rename the two "property FAILS TODAY" tests** to say what they assert now that they pass. A rename only.
3. **A bound of `handlesIn`'s own**, should it ever be exported: it is not exported today, so this is a test that
   pins it unexported, or, if a use for exporting it appears while doing item 1, the bound plus its test. State which.
4. **The red team's non-blocking second pass on the codec fix** (`b05d1d7c`): this is the red team's work, not yours.
   Ask `window-ml-redteam-e3` whether it will do the pass this round; record its answer in your result file and move
   on. Do not do the pass yourself.

## Order and size

Items 2 and 3 are one small PR. Item 1 is its own PR with the test. Expect the whole lane to close in a day.

## Not this lane

No new `ml` members, no change to the wire, nothing in the dialect's whitelist. Lane 5 is in `src/python/` too:
message it before touching the worker's loader, and whoever is second rebases.

## Who reviews

The generalist (it owns the Pyodide worker); the red team if item 1's test is security-shaped (it is not expected to be).
