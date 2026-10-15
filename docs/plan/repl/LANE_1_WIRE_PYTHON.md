# Lane 1: the `ml` wire, `ml` inside Pyodide, the persistent Python namespace

Read `README.md` in this folder first. Work slug `repl-lane1`; clone `~/git/window-ml-repl-lane1`. Labels
`@python,@api,@security`. You own `src/python/`, `src/offscreen.ts`, `src/sw/sw-offscreen.ts` and a new
`sw-ml-wire.ts` under `src/sw/` this round.

## Read before coding

- `docs/spec/ML_WIRE.md` (all of it; it is short), `docs/spec/PYTHON_DIALECT.md` ("The namespace", "Membership
  replaces `mode`" for what NOT to do yet), `docs/spec/CURRENT_CONTEXT.md` ("Python parity constrains the shape").
- `docs/dev/python-sandbox.md` (how the offscreen document, the dedicated worker, `harden()`, the stdout tee and the
  per-run reset work today), `docs/dev/architecture.md` (the message contract; the run-keyed dereference resolver is `derefByRun` in `src/sw/sw-runs.ts`), `docs/dev/state.md`
  (where state lives and the registry), `docs/dev/site-access.md` ("Adding a tool, a member or a message").
- The code: `src/python/python-worker.ts`, `src/python/python-runtime.ts` (`wrapUserCode`, its `persist` parameter,
  `harden`/`unharden`, `_ml_stdout_cb`), `src/offscreen.ts`, `src/sw/sw-offscreen.ts`, `src/readonly-exec/policy.ts`
  (`ML_READONLY_METHODS`, `mlFacade`, `ReadonlyRealm`), `src/page-relay.ts` (`HANDLE_MAP`: your new type must NOT be in
  it), `src/state-registry.ts` (`defineState`).

## Root A: the `ml` wire (first PR)

What: one `ml` call as a message, served by the service worker.

- The request and answer shapes from `ML_WIRE.md` as types in the contract (`src/contract/contract-messages.ts`), with
  `value`, `pointer`, `error` and `ask` answers. `ask` may land as a stub that today answers `error` for a gated call
  and is wired to the consent path in a follow-up; say so in the PR if you split it.
- A new `sw-ml-wire.ts` under `src/sw/` routing `call` names to the handlers that exist (`dereference` via `derefByRun`, `config`, `getModel`, `models`, `capabilities`, `ps`, `serverTools`, `info`, `schema`), per CLIENT REALM: a
  read-only client gets exactly `ML_READONLY_METHODS` minus the page-reading ones, built from the same list (do not copy
  it), and an absent member is an `error` the client reports as a refusal.
- **Sender, never run id.** The handler accepts the message only from senders it can verify (the offscreen document's
  URL, an isolated-world frame, later the native port) and refuses it from a tab's page world. The type is NOT added to
  `HANDLE_MAP`, so no page can start it.
- **Red-team pass, tests first** (the `redteam` skill; `tests/redteam.test.js`): a page posting the type is refused; a
  forged run id from a verified sender reaches only that sender's run; a read-only client cannot reach `chat`, `click`,
  a live `fetch`; a secret-tagged reference `{ "$secret": … }` is never answered with a value (there are no secrets yet,
  so this is a shape test).
- What crosses: JSON, a transferred buffer, a pointer, a table value. Assert in a test that no answer ever carries a
  function or a proxy.

Done when a fake client in a new `ml-wire.test.mjs` under `tests/` exercises every answer kind against the worker loaded in `node:vm`.

## Then: `ml` inside Pyodide (second PR)

- One callback installed into the worker namespace the way `_ml_stdout_cb` is (a leading-underscore global that survives
  the per-run RESET and `harden()`), carrying the wire request out through `offscreen.ts` to the worker and the answer
  back by `seq`. Never a `JsProxy` into the namespace; the answer is decoded from JSON or a buffer on the Python side
  (`injectStoredTable` is the pattern for a buffer).
- A Python `ml` object in the prelude (`python-runtime.ts`, single-sourced beside `PY_RESERVED_NAMES`) whose methods are
  **`await`-able**: `rows = await ml.dereference("@tool:…")`. A synchronous form needs `Atomics.wait` on a
  SharedArrayBuffer, which needs the offscreen document cross-origin isolated (manifest COOP/COEP keys); do not build it
  this round, write the question to `repl-specs` with what you measured about how models write the call.
- The realm: a `readonly`-mode cell gets the read-only list; a `full` cell gets the full gated set, each member still
  gated per call. `mode` still exists this round (decision 7).
- Tests under real CPython (`dist/pyodide/`; they self-skip without it) and under the fake: a hardened cell reaches
  exactly the list and nothing more; `import js` still fails; the callback is absent from `dir()` of user scope or is
  underscore-named; a refused member is a Python exception the cell can catch, not a crash.
- `docs/dev/python-sandbox.md` gets the section; the tool description in `python-tool.ts` says `ml` is there.

## Root C: the persistent namespace (third PR; it is a root, so it may go first if A's design is still being read)

- A dict per run in `python-worker.ts` (`Map<runId, globals>`), `wrapUserCode(…, persist=true)` on it (the bench's
  persist path exists: read how `benchNs` promotes names with `symtable`). The per-run reset goes; `_`-prefixed leakage
  between runs is what the map ends.
- **Declared in the state registry from the first commit** (`defineState`, realm `offscreen`, audience `model`, "what
  loses it": a worker kill, an eviction), with a `read` returning names, types and shapes for one run. The Run state
  panel and `ml.current.env` read the registry; the scope manifest from `PERSISTENT_RUNTIME_SPEC.md` is that `read`.
- Injected names (`df`, `tables`, `img`) become plain assignments at the top of the cell that passes them; nothing
  resets them. Fix the tool text that says both "a live notebook" and "stateless".
- **Loss is told.** The next cell's result opens with "namespace reset at <time>: <reason>" from the housekeeping record
  of the kill or cold start (`docs/dev/housekeeping.md`). A test kills the worker between two cells and asserts the
  message.
- Memory: deleted at run end; an eviction rule by size that also tells. Document the numbers you pick.
- **Test the UPGRADE** (AGENTS.md rule): a session saved by the old code resumed under the new one.

## Questions already answered

No `env: persist|isolated` parameter. No `vars` parameter. No `mode` removal yet. The namespace is per run and per
nothing else. The model is never told where a value lives.

## Report back

`LANE_1_RESULT_<root>.md` in this folder, per root: PRs, what the acceptance tests showed, the `await`-versus-sync
observation, anything the specs got wrong.
