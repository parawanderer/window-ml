# Lane 1, root C and PR 2b: the persistent run namespace and the `ml` transport (result)

Work slug `repl-lane1`, session `77599c71-822c-4a06-9f4d-6df810a154b7`, model `claude-opus-5-5`, 2026-10-19. The core
(worker, offscreen document, service worker, state declaration) was written by `window-ml-redteam-e3`; this session
added the tests, the text, two fixes in `ml-wire-serve.ts` found by those tests, and this note. The existing real-CPython
suite passes on the branch, and the run's dict is now tested in real Pyodide too (see "What did not work" for the limit).

## What landed

PR #757, branch `repl-lane1/ml-wiring`.

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
    document forwards `deleteRun` to every worker that holds a dict for the run (`runPrincipals`: its `run:<id>` worker
    and the shared `full` one), and the worker empties the dict before releasing it.
  - Loss: a kill of any worker records `nsLoss` for every run that kept a dict on it; the run's next cell opens its stdout with
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
  stdout, once, whether or not the run ever returned a scope manifest. A cell with no wire is told nothing.
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
- **A run's dict has its own prelude mode** (`wrapUserCode(..., "run")`), found by CI's e2e on the first push: running
  it in the bench's mode left `img`/`img_np` and the tables undecoded and skipped the `str`/`None` coercion of the
  injected inputs. The run mode binds `img`/`df`/`tables` only when a cell passes them and does NOT run the loaders: they
  patch `Image.open`/`pd.read_*` once per namespace and read that namespace, so a second run's dict would chain onto the
  first's and could be handed its `img`. Cost: `Image.open('<selector>')` is not redirected inside a worker-hosted run.
- **A `full`-mode run's dict was readable from another run, and is now deleted** (the LANE 3 Mimo session's review on
  #757, with the test bodies). Every full-mode cell runs on the one `full` worker, `PY_DELETE_RUN` only ever named
  `run:<id>`, so a finished full-mode run's dict stayed alive there and a later full-mode cell read it through
  `gc.get_objects()`. Now the offscreen document keeps `runId → principals` and deletes on each, and a kill of the `full`
  worker tells every run that kept a dict there. Deleting has to EMPTY the dict as well: the functions a cell defined hold
  it through `__globals__`, so releasing the proxy alone left it reachable until a collection
  (`tests/python-run-namespace-py.test.mjs`, the positive control, failed without it).

- **A run's dict is recorded when its cell is POSTED** (redteam-e3's re-review of `1bcdd5a2`). The worker creates the
  dict before the cell runs, and a cell that failed before returning a scope manifest (a wrapper-level failure, a
  kill mid-cell; a user syntax error is caught inside the wrapper and already carried one) left a dict on `full` that
  the offscreen document never learned of, so neither delete nor loss reached it. `runPrincipals` is now filled at the
  post, and the worker's error return carries the manifest as well.
- **`runPrincipals` is the ONE record of "this run has a dict on this worker"** (redteam-e3's re-check of `b2a478cf`,
  the coordinator's root fix). `killWorker` used to gate the loss note on `seenRuns`/`runNsVars`, both filled only from
  a returned manifest, so a run whose cells all failed got no note when its worker died. `seenRuns` is gone; delete and
  loss both iterate `runPrincipals`.

## Noted by the red-team pass, not changed

- **`PY_DELETE_RUN` trusts `msg.principal`** with no sender check, so anything that can `chrome.runtime.sendMessage`
  inside the extension can drop any run's dict on a named worker. It is not page-reachable (not in `HANDLE_MAP`), so
  this is defense in depth only. Closing it: ignore `msg.principal` and derive the set from `runPrincipals` plus
  `run:<id>`.
- **A second handle scanner:** `parseShRun` (`src/shell/sh-call.ts`) re-checks `$secret` after `fromWire`, so legitimate
  env data `{"$secret": "s"}` is refused as `SecretHandle` rather than `BadRequest`. It fails closed.
- **Latent:** after the one-level unwrap, data `{"$": {"$bytes": "aGk="}}` and a real `{"$bytes": "aGk="}` are the same
  object at the member. No live sink today (`bytesOf` decodes only host-read responses); a future member that calls
  `bytesOf` on its args would confuse the two.

## Known residual: two full-mode runs alive at the same time

Not closed by the fix above, which removes a run's dict when the run ENDS. The `full` worker belongs to the offscreen
document, which is one per BROWSER, so every full-mode run in the browser shares its interpreter: across runs, sessions
and sites. While two of them are alive, B's cell reads A's live dict through `gc.get_objects()`. A readonly worker
refuses `import gc`, so readonly runs are not exposed, to each other or to a full-mode run.

Two ways to close it:
- **A full worker per run:** principal `run:<id>` for full mode too, at the price of one Pyodide boot per full-mode run.
  The only one of the two that separates runs, sessions and sites completely.
- **Full-mode runs serialized on the shared worker:** one at a time, its dict deleted before the next starts. This
  closes the read of a LIVE dict, but the runs still share one process, so module state one leaves behind (a patched
  module attribute, `sys.modules`) still reaches the next, across sites.

Pinned by `RESIDUAL (exists today)` in `tests/python-run-namespace-py.test.mjs`, which asserts the read SUCCEEDS, so
closing it flips a test. Until then, full mode always asks, and its approval card says it "shares one Python process
with every other full-mode run in this browser" (`card-approval.tsx`), so approving it is consent to this.

## What did not work, or was left out

- **The real-Pyodide tests cover the dict and its prelude, not the worker module.**
  `tests/python-run-namespace-py.test.mjs` and the `run dict:` tests in `tests/python.test.mjs` rebuild what the worker
  does with the shipped `wrapUserCode`, so a name surviving a cell, cross-run isolation and the injected inputs are
  measured. `python-worker.ts` itself is not loaded there, and `_user` awaiting `ml.*` is covered only by the e2e.
- **No eviction by size** (the spec asked for one that also tells). The dict is bounded by the worker's memory only.
- **The offscreen document closing** loses every dict with no record and no notice on the next cell.

## Assumptions where a spec was silent

- A "run" for the namespace is the worker-hosted run id, and nothing else: no per-tab or per-page key.
- Reasons in the loss line are the housekeeping reasons (`timeout`, `start-timeout`) or `crashed`; the worker's own
  error text stays in the housekeeping record's detail.
- A kill of a worker the run has posted a cell to is a loss, manifest or not: the worker creates the dict before the
  cell runs (changed in `e4da2267`; it was "no manifest, no loss").

## What I think a spec got wrong

- **`LANE_1_WIRE_PYTHON.md` says deleting a run's namespace is `deleteRun` to "the run's worker"**; with two modes a
  run can have a dict on two workers, one of them shared, so deleting has to reach both (now done).
- **`ML_WIRE.md` says "the receiver unwraps one level"** for both directions, but the server side as first written
  wrapped what was already wrapped. The spec is right; the sentence does not say that arguments arrive in wire form and so
  must not be wrapped again.
