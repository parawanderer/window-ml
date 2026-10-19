# Lane 1, root C and PR 2b: the persistent run namespace and the `ml` transport (result)

Work slug `repl-lane1`, session `77599c71-822c-4a06-9f4d-6df810a154b7`, model `claude-opus-5-5`, 2026-10-19. The core
(worker, offscreen document, service worker, state declaration) was written by `window-ml-redteam-e3`; this session
added the tests, the text, two fixes in `ml-wire-serve.ts` found by those tests, and this note. The existing real-CPython
suite passes on the branch (85/85), but no new test drives the worker's dict in Pyodide (see "What did not work").

## What landed

Uncommitted at the time of writing, on `repl-lane1/ml-wiring`; the PR number is not known yet.

- **PR 2b, the transport.** `python-worker.ts` answers an `ml` call by `seq` (`pendingWire`) and posts only
  `{ seq, call, args }`. `offscreen.ts` stamps every `ML_CALL` with the `{ client, run }` it holds for the cell, holds an
  `ask` first answer, and relays the later `ML_ANSWER` (matched by client) down as `mlAnswer`. `sw-python.ts` opens the
  client with `openWireClient` and passes `wire: { client, run }` on `PY_RUN`. The cell body is `async def _user()`, so
  `await ml.…` works.
- **Root C, a namespace per run.**
  - Worker: `runs: Map<runId, { ns, id }>`; a cell with a run id executes in that dict with `persist` on, so `RESET` does
    not run. Injected `df`/`tables`/`img` are assigned into it without wiping other names.
  - Which cells share a dict: those of one worker-hosted run, keyed by `wire.run`, which only `worker-tools.ts` sets. A
    page's `ml.pythonExec`, a page-hosted agent's `python_exec` and the bench do not (main namespace and reset, and
    `benchNs`). A `readonly` and a `full` cell of the same run are on different workers (`run:<id>` and `full`) and so
    in different dicts.
  - End of life: `deletePythonRun(runId)` from `settle()` and from `forgetRun` sends `PY_DELETE_RUN`; the offscreen
    document forwards `deleteRun` to the `run:<id>` worker.
  - Loss: a kill of a `run:` principal records `nsLoss`; the run's next cell opens its stdout with
    `namespace reset at <ISO time>: <reason>` (`reason` is `timeout`, `start-timeout` or `crashed`) and the result
    carries `nsReset`. Declared as state `python.run-namespace`.
- **Two fixes in `src/sw/ml-wire-serve.ts`** (mine, found by the new codec tests; see "Decided on the way").
- **Text.** The `python_exec` description says what holds where it is built (`stateClause`, keyed on the worker-only
  `_mintToken`). A worker-hosted run reads "Names you define persist across your python_exec calls in this run
  (`df`/`tables`/`img` are re-bound when a call passes them); after a sandbox restart the output opens with
  "namespace reset at <time>: <reason>" and they are gone."; a page-hosted agent keeps "Each call is STATELESS — a fresh
  namespace, nothing persists.", which is still true there (`tests/worker-media.test.mjs`, mutation-checked). Also
  `docs/dev/python-sandbox.md` (a "A run's namespace" paragraph), `docs/dev/state.md`, the AGENTS.md trap line, one
  comment in `python-runtime.ts`.
- **Tests:** `tests/python-run-namespace.test.mjs` (new, ten tests), three tests in `tests/ml-wire.test.mjs`, and a
  `pyDeletes` list in `tests/helpers.js`.

## What the tests showed

- **The offscreen document runs under node.** `src/offscreen.ts` imports under a mocked `chrome` and a fake `Worker`,
  with no Pyodide, so its routing is the shipped code. This is the first test of that file.
- **Deletion:** `PY_DELETE_RUN` reaches the worker of the run's own principal and not another run's. A run with no
  worker answers `ok` and spawns nothing. A deleted run that runs again gets no loss notice.
- **Loss:** a worker killed between two cells puts `namespace reset at …: crashed` at the head of the second cell's
  stdout, once. A run that never returned a scope manifest, and a cell with no wire, are told nothing.
- **Stamping:** the handle never reaches the worker; a forged `client`/`run` in the worker's message is ignored; an `ask`
  first answer is not relayed and the later `ML_ANSWER` resolves it.
- **Settling:** a worker-hosted run that ends sends `PY_DELETE_RUN` for its own run and principal (built worker in
  `node:vm`).
- **Codec:** `fromWire(toWire(x))` was not `x` for `{"$": 1}` and `{"$": {"$": 1}}`, and a cell's data
  `{"$secret": "s"}` was refused as a handle. Both fixed.
- **Upgrade:** a `PY_RUN` shaped like the old service worker's (no `wire`, no `run`) reaches the worker with neither
  and returns unchanged. This is the old state that can actually meet the new code: a service worker that has not
  reloaded, and the bench and page-started cells, which still send that shape. The namespace itself is never persisted,
  so there is no saved-session fixture to read; a resumed run starts a fresh dict and no notice (it has never held one on
  this document). That last part is not tested.
- **Mutation checks**, each seen failing against a deliberately broken copy and restored: the non-wrapping inbound copy,
  the one-level unwrap, the wrap-aware handle search, the `deleteRun` principal lookup, recording `nsLoss`, stripping
  the worker-facing `wire`/`run`, taking `client`/`run` from the worker, and relaying an `ask` first answer. The
  settle-sends-delete test was broken by editing the built `dist/background.js` (no rebuild was allowed), then restored.

## Decided on the way

- **Inbound arguments are copied without wrapping, and the handle search runs before the unwrap.** `serveWireCall`
  called `toWire` (which wraps tag-shaped data) on arguments the Python facade had already wrapped, then `fromWire`
  peeled every `{"$": …}` layer. Result: data `{"$": 1}` arrived as `1`, and data `{"$secret": "s"}` was indistinguishable
  from a handle after the peel and was refused as `SecretHandle`. Now `toWire` takes `wrap = false` for wire-form input,
  `fromWire` unwraps exactly one level and treats the wrapped object itself as data, and `handlesIn` looks for `$secret`
  on the wire form, skipping the keys of a wrapped object but not the values inside it. A real handle still refuses at any
  depth. This touches the secret check, so it is for the red-team pass to read.
- **The reset line is stdout, not an error.** It prefixes the cell's own output, which is where the spec put it.

## What did not work, or was left out

- **No new test runs in real Pyodide.** The worker's dict (`runNamespace`, the kept-dict path in `run`, injected names
  surviving a cell, `_user` awaiting `ml.*`) is exercised only by the existing real-CPython suite (85/85 on the branch),
  none of which asserts that a name survives from one cell to the next.
- **A `full` run's namespace is not deleted.** `PY_DELETE_RUN` names the `run:<id>` principal, but a `full` cell runs on
  the single `full` worker, so its dict for the run stays until that worker dies. A kill of the `full` worker also tells
  nobody, since `nsLoss` is recorded only for `run:` principals. Not fixed here: the fix is a broadcast of `deleteRun` to
  every worker, and a per-run map on the `full` principal. Not covered by any test.
- **No eviction by size** (the spec asked for one that also tells). The dict is bounded by the worker's memory only.
- **The offscreen document closing** loses every dict with no record and no notice on the next cell.

## Assumptions where a spec was silent

- A "run" for the namespace is the worker-hosted run id, and nothing else: no per-tab or per-page key.
- Reasons in the loss line are the housekeeping reasons (`timeout`, `start-timeout`) or `crashed`; the worker's own
  error text stays in the housekeeping record's detail.
- A kill when the run has never returned a scope manifest is not a loss.

## What I think a spec got wrong

- **`LANE_1_WIRE_PYTHON.md` says deleting a run's namespace is `deleteRun` to "the run's worker"**; with two modes there
  is a worker per mode, so deleting needs to reach the `full` one too.
- **`ML_WIRE.md` says "the receiver unwraps one level"** for both directions, but the server side as first written
  wrapped what was already wrapped. The spec is right; the sentence does not say that arguments arrive in wire form and so
  must not be wrapped again.
