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
{ "seq": 12, "pointer": { "token": "@tool:9f2e1a0", "label": "…", "size": 20480 } }   // too big to cross: stays home (a table's or a fetched text's whole, POINTER_VALUES.md slices 5 and 9)
{ "seq": 12, "error": { "code": "NotInDialect", "message": "…" } }
{ "seq": 12, "ask": { "card": "…" } }   // the call needs the person; the client WAITS, and a later message answers
```

`client` is the handle the server issued when it started the code making the call (built: one per Python cell); the
server answers by it and the verified sender together, and checks `run` against it. **The step an ask rides is a fact
of the handle, never of the message** (ruling, 2026-10-15, lane 4's `ml.sh` over the wire): the server recorded which
run and which step started the client when it issued the handle, so a nested ask raised for a wire call attaches to
that step with nothing in the request naming it; a request that did name a step would be the sender-never-message rule
broken. The opener that issues a handle records the step with it. An `ask`'s final answer is a later
`ML_ANSWER` push carrying the same `client` and `seq`.

**What crosses.** Plain JSON; bytes as Arrow (the one copy, as `injectStoredTable` makes today), carried as a transferred
`ArrayBuffer` on the Pyodide-worker↔offscreen hop and as `{ "$bytes": "<base64>" }` on every `chrome.runtime` hop, which
is JSON; a `@tool:` pointer; a table value with its `shape`; a secret HANDLE as a tagged reference `{ "$secret": "github" }` that names a grant
and carries no value ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)). **A tag is a single-key object whose key starts with
`$`**, and data that happens to look like one is escaped (ruling, 2026-10-15, from lane 1's facade PR #728): a data
object whose only key starts with `$` crosses wrapped as `{ "$": <object> }`, in both directions, and the receiver
unwraps exactly one level; so a dereferenced JSON value `{"$bytes": "x"}` arrives as that dict, never as bytes, and a
cell cannot spell a handle out of data. **A handle's name is never its authority**: on receiving `{ "$secret": name }`
the server resolves it against the grants the RUN holds and judges the use at its sink, so a renamed or invented handle
is `Denied` like any other name the run was not granted. **A preview is marked at the top level of the answer**:
`{ "seq", "value", "truncated": true, "size" }`, where `value` is the model-sized text and `size` the whole's length;
the whole is reachable by the pointer the producing call already returned (root J), so the answer carries no second
reference. **Never a proxy**, in either direction: a live object
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

**How it is raised: a NESTED ASK on the running step** (ruled 2026-10-15, built by lane 4 of the plan as its own PR; `ml.sh`
is its first user, the wire's gated members and policies' per-call asking the next two). Today every gate is raised by
the agent loop before a tool runs, keyed `${runId}:${seq}`, and is the step's own pending event; a call made from inside
an already-running step has no gate to open. So a step gains `asks[]`, each `{ id, kind, facts, state, raisedAt,
answeredAt }`, keyed `${runId}:${seq}#${askId}` in the same pending-approvals store, answered by `SET_APPROVAL` with an
optional ask id under today's origin check, drawn as a card inside the running step with two answers (allow, or deny
with a note), showing the resolved facts and never the script, recorded in the run log and both exports. The ask's
`facts` IS the policy's `c` object, one shape for the card, `judgeCall` and the log, so a pending ask is re-judged when
a policy changes with no extra plumbing. An unattended run refuses an ask at once; one unanswered past the wall-clock cap
is denied; cancelling the run denies its pending asks with that reason. A nested ask rides the same approval event the
chat page and the phone render, or the phone could not answer it. Rejected: a synthetic sub-step with its own `seq`,
because `seq` is the model's call index and nothing may put a call the model never made into it.

## One budget a cell

Every call a client's code makes draws on ONE step budget, the dialect's `STEP_BUDGET` (built 2026-10-23), held by the
client, so it lasts exactly as long as the cell. Each call is already bounded alone: a pipe's regex search is priced on
its input before it runs ([`readonly-exec.md`](../dev/readonly-exec.md), the Halting table) and refused over one
budget's worth. That bounds a call, not a loop: a cell calling `dereference` with a search priced just under the cap
in a loop held the worker's one thread about a second a call until the cell's watchdog, and every other run and tab
with it. So the pipe charges
the client at the dialect's rates (what each stage reads and makes, at 64 characters a step, and what its searches
can cost), and holds each stage to the dialect's `MAX_STRING`. A search or a stage's input past what is left answers
`OverBudget` before it runs; a stage's output is charged once made, so the call that crosses the line has spent at
most one stage past it, and a stage that would build more than `MAX_STRING` (`sed`, pretty-printed JSON) is refused
before it builds. A call that does no metered work (`config`, a read with no pipe) still answers. The next cell's
client starts whole. In figures: a stage over a 1 MB text costs about 16k steps to read and as much again for what
it makes, so a cell can pipe such a text about ninety times.

Per cell, not per run: the person approves a cell, or the dialect admits it, one at a time, and the model can only
spend one more cell by making one more call. A budget per run would make a late, cheap cell fail for what an early
one spent. The budget measures the worker's work, never the person's time, so a call waiting on a card spends none.

## Related

- [`PYTHON_DIALECT.md`](PYTHON_DIALECT.md): the first new client, and the reason for the handle and copy rules.
- [`SHELL.md`](SHELL.md): the process host is both a client (CPython there) and a server of its own values.
- [`CURRENT_CONTEXT.md`](CURRENT_CONTEXT.md): `ml.current` was shaped as plain data so that it could cross this way
  ("Python parity constrains the shape").
