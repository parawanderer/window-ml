# Lane 1, root A: the `ml` wire (result)

Work slug `repl-lane1`, session `454be6a7-23da-48f4-ad11-b1ea65d7a253`, model `claude-opus-5-5`, 2026-10-15.

## What landed

- **PR #678** (merged, `64e9dc0c`): `ML_CALL`, one `ml` call as a message (`docs/spec/ML_WIRE.md`).
  - Types in `src/contract/contract-messages.ts`.
  - The client registry, the request checks and the copy out in `src/sw/ml-wire-serve.ts`, which has no `chrome`.
  - The sender check, the members and the handler in `src/sw/sw-ml-wire.ts`.
  - One client per Python cell, opened in `runPython` (`src/sw/sw-python.ts`) and passed in `PY_RUN` as
    `wire: { client, run }`. No client consumes it yet; that is PR 2.
  - How it is bound and what the tests hold: `docs/dev/site-access.md`, "The `ml` wire".
- **PR #684**: a pipe pattern that can backtrack without end is refused at the one place `text-pipe.ts` compiles one, for
  every caller. A ruling of `repl-specs`; see "Found on the way".
- Lane 4 was sent the request and answer shapes, the error codes and the `ask` push, for its host protocol to mirror.

## What the acceptance test showed

- **The answer kinds:** a fake client in `tests/ml-wire.test.mjs`, driven by a worker-built run's `python_exec` cell in
  `node:vm` (`tests/ml-wire-harness.mjs`), gets a `value` (`config`, `schema`, `range`, `dereference` with and without a
  pipe) and an `error` (`Absent` for `chat`) back from the real worker.
- **The members:** the read-only realm's are exactly `ML_READONLY_METHODS` minus `queryAll` and `a11y`, enumerated, not
  sampled.
- **`ask`, in the worker-free core only:** allow, deny, a client closed while the card waited (the member never runs),
  and the wall-clock cap. No member is gated yet.
- **`pointer`, in the core only:** unreachable from the worker today (below).
- **The red-team pass:** `tests/redteam-ml-wire.test.mjs`, each test with a positive control.
  - A page's `ML_CALL` is never relayed.
  - A tab sender holding a live handle is refused.
  - Unknown, guessed and closed handles read the same as a wrong sender.
  - A forged or null run id reaches nothing.
  - A page-started cell on the run's own tab, mid-run, has no run and no `dereference`.
  - A read-only client reaches no `chat`, `click`, live or cache-only `fetch`, or prototype name.
  - `$secret` anywhere in the args is refused.
  - No answer carries a function or a non-plain object.
- **Mutation check:** each layer removed alone fails a named test there: the sender check, the run check, the close, the
  secret check, the realm cut, and binding a page cell to its tab's run.
- **A separate red-team agent** reviewed the change before merge. Fixed from it:
  - the `isolated` sender kind, which matched any document on the tab when a field was absent (removed until it has an
    opener, every fact then required);
  - an `ask` running after its client closed;
  - no wall-clock cap on a card.

## What did not work, or was left out

- **The `pointer` answer is unreachable from `dereference`.** The run's pointer store holds the text the model was
  shown (`fetch_url` stores `[first 4000 of N chars]`), and a pipe reads that text, so no answer approaches
  `WIRE_VALUE_CAP` (2^20 characters). A whole TEXT body exists nowhere a code client could read it; a table's whole
  does, in the value store under `meta.value`. Ruled: same view this round; whole text captures become their own root
  under the pointer-values work. Required now, in PR 2: a `value` answer for a truncated capture carries
  `truncated: true` and the full size, visible in the Python facade without the cell asking. The clip note `clipOut`
  writes (`… [first K of M chars]`, parsed by `json-repair.ts`) is where both numbers come from. With a pipe the note
  can be cut away, so the check reads the capture, not the piped text.
- **The `isolated` sender kind** is not built (above). An isolated world keeps its own channel (`iso-channel.ts`).
- **`full` has the read-only member set.** The gated members (a live fetch, `chat`, `click`) come with the consent path,
  each with its own gate.

## Found on the way

- **No backtracking guard on a pipe outside the dialect.** Pre-existing: only the read-only dialect's `ml.pipe` passed
  `riskyRegex`, so the run's `dereference`, a survey's and the wire's could block the service worker. Fixed in #684 at
  the one compile point, with a test on each path; against the unguarded pipe the tests hang until killed.
- **A gap in the readonly `python_exec` sandbox**, found while reading the Pyodide worker for PR 2. Reported to
  `repl-specs` and handed to another session (`window-ml-redteam-29`) together with the interim mitigations (branch
  `repl-lane1/pyodide-lockdown`). PR 2 and root C wait for that fix to merge, since both change the same worker.

## Assumptions where a spec was silent (all accepted by `repl-specs`)

- **`client` on the request:** the handle the server issued when it started the code, answered together with the
  verified sender; `ML_WIRE.md` updated in #678.
- **`ask`:** the final answer is an `ML_ANSWER` push `{ client, answer }`. The member runs only if the client is still
  open when the person decides. `ASK_TIMEOUT_MS` is five minutes, then `Denied`.
- **A page-started `PYTHON_EXEC` cell is bound to no run,** so it has no `dereference`, even on the tab of a run in flight.

## What I think a spec got wrong

- **`ML_WIRE.md`, "What crosses":** it assumes a large value crosses as a pointer to something whole. The store does not
  keep the whole of a text capture, so the pointer names a value that is already cut (finding above).
- **`ML_WIRE.md`, transport:** it says bytes cross "as Arrow or a buffer". Between the offscreen document and the service
  worker, `chrome.runtime` messages are JSON, so a buffer cannot cross that hop: bytes are `{ $bytes: base64 }` there,
  and only the Pyodide worker ↔ offscreen hop can transfer a buffer.
- **`LANE_1_WIRE_PYTHON.md`:** it names `DEREF_TOKEN` as the dereference path. That message no longer exists
  (`named-reads.ts` replaced it); the worker's resolver is `derefByRun`, which the wire reads.
