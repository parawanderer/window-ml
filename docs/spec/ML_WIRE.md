# Spec (WIP): `ml` over the wire, the one protocol every executor speaks

**Status: the server half is built (`ML_CALL`, `src/sw/sw-ml-wire.ts`; how it is bound: [`docs/dev/site-access.md`](../dev/site-access.md), "The `ml` wire"); no client consumes it yet.** Written on 2026-10-15. Four pieces of work
turned out to depend on the same missing thing: `ml` inside Pyodide, JS values reaching Python, Python running at the
process host, and policies answering a call from inside a script. The missing thing is a definition of ONE `ml` call as a
message, so that every place code runs is a client of the same server.

## The idea

Today `ml` is a JavaScript object, built per realm: the page's `window.ml`, the worker survey's allow-list facade
(`mlFacade` in `src/readonly-exec/policy.ts`), the isolated world's copy. Pyodide has none, because the worker it runs in
cannot see any of those objects, and the readonly hardening purges the `js` bridge on purpose
([`docs/dev/python-sandbox.md`](../dev/python-sandbox.md)). The CPython a process host would run has none for the same
reason, one hop further out.

The fix is not a bridge per place. It is a wire form of an `ml` call, served by the service worker, which already answers
most of these requests for the isolated world and the background-hosted run (the run-keyed dereference resolver, `derefByRun` in `src/sw/sw-runs.ts`, `GET_CONFIG`, the
pointer store, the run's `current` snapshot).

## One call, one message

```jsonc
// request, from any client
{ "client": "mlw-<uuid>", "run": "<run id>", "seq": 12, "call": "dereference", "args": ["@tool:a1b2c3", { "pipe": ".rows" }] }

// answers
{ "seq": 12, "value": { … } }                                  // plain data
{ "seq": 12, "pointer": { "token": "@tool:9f2e1a0", "label": "…", "size": 20480 } }   // too big to cross: stays home (today only a TABLE has a whole to point at; a text capture is kept model-sized, root J of the plan)
{ "seq": 12, "error": { "code": "NotInDialect", "message": "…" } }
{ "seq": 12, "ask": { "card": "…" } }   // the call needs the person; the client WAITS, and a later message answers
```

`client` is the handle the server issued when it started the code making the call (built: one per Python cell); the
server answers by it and the verified sender together, and checks `run` against it. An `ask`'s final answer is a later
`ML_ANSWER` push carrying the same `client` and `seq`.

**What crosses.** Plain JSON; bytes as Arrow (the one copy, as `injectStoredTable` makes today), carried as a transferred
`ArrayBuffer` on the Pyodide-worker↔offscreen hop and as `{ "$bytes": "<base64>" }` on every `chrome.runtime` hop, which
is JSON; a `@tool:` pointer; a table value with its `shape`; a secret HANDLE as a tagged reference `{ "$secret": "github" }` that names a grant
and carries no value ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)). **Never a proxy**, in either direction: a live object
would be a capability into the realm that made it, which is exactly what the Pyodide hardening exists to remove.

**Who may call what** is decided by the CLIENT'S REALM, with the same table the worker survey uses today: a read-only
dialect client (a JS survey, a Python dialect cell) sees `ML_READONLY_METHODS`; an approved client (a full `exec`, an
approved Python cell) sees the full gated set, each member still gated per call (a fetch by URL, `ml.sh` by argv). A
member a realm does not have is ABSENT, and reaching it is an error the client's dialect reports as a refusal, so adding a
member later costs a hop, never a hole.

**The run id is not authority.** A hostile page knows every run id. The server answers by the SENDER it can verify (the
offscreen document, the native-messaging port, the isolated world's frame, a sealed hub command), never by the id in the
message, the same rule the origin gate applies to page-started messages ([`SITE_ACCESS.md`](SITE_ACCESS.md)).

## Clients

| Client | Transport | Realm |
| --- | --- | --- |
| the Pyodide worker | worker → offscreen → service worker, the path its stdout tee already rides | the Python dialect, or approved |
| CPython at the process host | native messaging, later the hub | the Python dialect, or approved (in a container) |
| a JS survey at the process host (placement, [`SHELL.md`](SHELL.md) slice 4) | the same | the JS dialect |
| the isolated world | `chrome.runtime` messages, as today | approved |
| the page's main world | as today | approved; never a pointer, `ml.current`, `ml.sh` or a secret |

## Per-call asking

The `ask` answer is the capability the earlier specs assumed without naming. A policy returning no opinion from INSIDE a
script ([`POLICIES.md`](POLICIES.md)) means that one call waits on a card while the script is suspended on its promise,
and continues when the person answers. The JS survey could not do this before because its fallback was a different
executor (the whole script re-run under `eval` after approval); a Python dialect cell and a worker-side survey both run
under an async evaluator that can simply wait.

Three rules while a call waits: the dialect's STEP budget does not run (it measures interpreter work, not the person);
a WALL-CLOCK cap does, and a card unanswered past it fails the call, not the script; and a suspended survey records that
it waited, so a reading taken after the wait is not presented as simultaneous with one taken before.

## Related

- [`PYTHON_DIALECT.md`](PYTHON_DIALECT.md): the first new client, and the reason for the handle and copy rules.
- [`SHELL.md`](SHELL.md): the process host is both a client (CPython there) and a server of its own values.
- [`CURRENT_CONTEXT.md`](CURRENT_CONTEXT.md): `ml.current` was shaped as plain data so that it could cross this way
  ("Python parity constrains the shape").
