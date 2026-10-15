# Lane 1, root J: whole text captures in the value store (result)

Work slug `repl-lane1`, session `77599c71-822c-4a06-9f4d-6df810a154b7` (the fresh lane 1 session), model `claude-opus-5-5`,
2026-10-15. The red-team pass is by `window-ml-redteam-29`.

## What landed

- **PR #705** (merged, `0f812829`): a `fetch_url` text body past its 4,000-character preview keeps its whole body in the value store
  ([`POINTER_VALUES.md`](../../spec/POINTER_VALUES.md), slice 9; how it works: [`docs/dev/pointers.md`](../../dev/pointers.md),
  "Text capture").
  - Store: `ml._keepText` (`storeText`, `format: "text"`), a member only the worker's `ml` has.
  - Key: `ToolResult.textValue`, which the run host forwards only off an envelope `runLocalTool` returned
    (`workerEnvelopes`). The loop notes it on `TokenValue.value` and claims it like a table's key.
  - Read: `readStoredText(key, run)`, which refuses a key the run does not hold. Its callers are the dereference tool
    (`opts.readText`) and `derefWhole`, used by the dialect's `ml.dereference`, the wire, and an isolated exec's
    pre-reads and re-pipes.
- **Red-team pass**, in the same PR: `tests/redteam-text-captures.test.mjs`, seven properties, each with a positive control
  and a mutation check. It also made a `redteam` test genre.

## What the acceptance tests showed

`tests/text-captures.test.mjs`:

- **The wire:** a 1.5 MB body piped at the store sends twenty lines from past the preview.
- **The `pointer` answer:** an unpiped read past `WIRE_VALUE_CAP` answers `pointer`. This is the first path that reaches it
  from the worker, which root A could not exercise.
- **The model's view:** the `fetch_url` preview is byte-identical with and without a store.
- **The dereference tool:** it pipes over the whole, and its unpiped read is clipped at `UI_OUT_CAP` with a note giving the
  whole's size.
- **Failures:** an evicted body fails the read with the store's reason. A body the fetch clipped at its 8 MB read cap is not
  kept. With no store, nothing changes.
- **Placement:** the same `ml.dereference(ptr, { pipe })` is enumerated across placements. The read-only survey, a
  user-script world and a CDP world read the whole; the main world reads the preview (below).

All but three were seen failing against the code before them. The three whole-reading placement tests were written after the
isolated-channel change.

The red-team pass, mutation-checked:

- The `workerEnvelopes` gate is the first line of defence. Removing it fails the page-supplied-key tests.
- The holders check in `readStoredText` is depth beneath the gate. Removing both fails the cross-run and forged-key tests;
  the holders check alone does not. So the two are a defence checked in combination, not two independently tested layers.
- `withHeldValuesOnly`'s strip is caught by its own test.
- No page-started type answers with a stored body (enumerated).

## Decided on the way

- **Every placement reads the same, but one.** The isolated world first read the preview while a survey of the same script
  read the whole. That inverted privilege, and was fixed: pre-reads and re-pipes go through `derefWhole` (ruled by
  `repl-specs`).
- **The single exception** is `routeExec`'s no-isolation fallback (exec-routing.ts; owner's decision 2026-10-08): a
  pointer-naming exec on an approved page with no isolated world runs in the main world, and is sent the PREVIEW. Its
  note to the model says so and names what reads the whole. **Decided, Shane, 2026-10-15:** the whole does not follow a
  script into the page; an approved page is approved to use window.ml, not to read everything a run fetched elsewhere.
- **The resolver stays synchronous** (`derefByRun` holds only the preview). The whole is read where the reader can wait;
  no worker-side reader calls the resolver directly any more.

## What did not work, or was left out

- **Not kept whole:** a page-hosted run's fetch (the page has no value store), an `exec` or `python_exec` output past
  `UI_OUT_CAP`, and a page's answer. Their pointers read what they did before. The `truncated: true` interim for a value
  answer over such a capture is PR 2's (`ml` in Pyodide).
- **The inventory line** (`dereference` with no token) still sizes a text pointer by its preview. A read's own header
  gives the whole's size.
- **Harness trap** (found by the red-team pass): an assertion thrown inside a `wireRun` cell is swallowed. It becomes the
  Python run's error, not the test's. Assign to an outer object and assert after `wireRun` returns.

## Assumptions where a spec was silent

- The stored whole is the `body` the preview was cut from: converted Markdown, pretty JSON, after the fetch's own pipe.
  So the preview is always a prefix of it.
- A `json`-kind pointer (a JSON body) is stored the same way, `format: "text"`.
- A whole read is clipped at `UI_OUT_CAP` in the dereference tool, the same cap as the panel's copy.

## What I think a spec got wrong

- **AGENTS.md's security invariant** ("An approved exec of a run the worker built runs in an isolated world when it names a
  pointer or `ml.current`…") reads as unconditional, and the coordinator first ruled from that reading. The code and
  `docs/dev/site-access.md` (line 335) are right: with no isolated world available, a pointer-naming exec on an approved
  page falls back to the main world with a note (the 2026-10-08 decision). The invariant line should name that fallback.
