# PR 2 design note: `ml` inside Pyodide

Work slug `repl-lane1`, session `454be6a7-23da-48f4-ad11-b1ea65d7a253`, 2026-10-15. A design note, not the code: PR 2
waits for the Pyodide lockdown (`window-ml-redteam-29`) to merge, because both change the same worker. Written so the
lockdown's author and whoever takes PR 2 agree the shape now.

## What PR 2 adds

A Python cell can call `ml` over the wire root A built: `rows = await ml.dereference("@tool:a1b2c3")`. The cell holds no
JS object; the call is a message out to the worker (`ML_CALL`) and an answer back, matched by `seq`.

## The channel, after the lockdown

The lockdown's rule is that no JS proxy stays in the namespace and the cell holds no reference that reaches the worker's
global scope. The `ml` channel is built to that rule, not around it:

- **Out of the cell:** the worker (`python-worker.ts`) posts the request through its own closure-held `post` (the
  dedicated worker's `self.postMessage`, captured before the global strip), never a function the cell can name. The cell
  reaches it only through a Python object (below), which calls a leading-underscore global the prelude installs and
  `harden` keeps — the same shape as the stdout tee today, except that it carries data, not a JS function the cell holds.
- **The stdout tee becomes Pyodide's JS-side `setStdout`** (batched or raw), set by the worker through its closure, so
  the tee is no longer a namespace function either. This is part of the lockdown; named here because PR 2 depends on it
  and must not re-introduce a namespace JS function.
- **Back into the cell:** the answer is decoded from JSON, or from a buffer the `injectStoredTable` way, on the Python
  side. Never a `JsProxy` into the namespace, in either direction — the wire's "never a proxy" (root A) made literal on
  the Python side.

## The Python object

A Python `ml` in the prelude (`python-runtime.ts`, single-sourced beside `PY_RESERVED_NAMES`), whose methods are
`await`-able:

```python
rows = await ml.dereference("@tool:a1b2c3", pipe=".rows | head 5")
cfg = await ml.config()
```

- Each method packs its name and args, sends one wire request by `seq`, and awaits the answer. An `error` answer becomes
  a Python exception the cell can `try`/`except`; an `ask` suspends the coroutine until the `ML_ANSWER` push with its
  `seq`.
- A `value` carrying `truncated: true` and the full size (root A's required finding) surfaces visibly: the prelude prints
  a one-line note, or the returned object answers `.truncated`/`.size`, so a cell computing over a prefix is not misled.
- `await` only; no synchronous form this round. A synchronous `ml.dereference(...)` needs `Atomics.wait` on a
  SharedArrayBuffer, which needs the offscreen document cross-origin isolated (manifest COOP/COEP). Deferred, with a
  measurement of how models actually write the call sent to `repl-specs`.

## Realms

- A `readonly` cell gets the read-only member list; a `full` cell gets the full gated set, each member still gated per
  call. `mode` stays this round (decision 7).
- The member list is the worker's, cut by realm, exactly as root A serves it. A page-started cell is bound to no run, so
  it has no `dereference` (root A).

## Who stamps the handle

The offscreen document keeps each run's `{ client, run }` and stamps it on the request by the run it is executing; the
Pyodide worker never sees a handle. This is the lockdown's one-sender rule, which PR 2 relies on: the handle alone
separates cells, so only the offscreen document, not the worker, may assert which cell a call is for.

## Tests

- Under real CPython (`dist/pyodide/`, self-skips without it) and under the fake: a hardened cell reaches exactly the
  realm's list; `import js` still fails; the `ml` callback is absent from `dir()` of user scope or is underscore-named;
  a refused member is a catchable Python exception, not a crash; a truncated value's note is visible.
- The red-team pass is the lockdown's acceptance test plus one for the channel: a cell cannot reach the worker's `post`
  or the stdout sink as a callable, and an answer is never a `JsProxy`.

## Docs

`docs/dev/python-sandbox.md` gets the `ml`-in-Python section; `python-tool.ts`'s description says `ml` is there.
