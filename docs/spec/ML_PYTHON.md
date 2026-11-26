# `ml.python`: the kernel's own members, and how a cell learns what `ml` has

**Status: ruled, not built.** RULED 2026-11-24 (Shane, ruling 116, in the coordinator's session): "I think all the
python-only functions should start to get grouped under a 'python namespace'. Especially when they have no planned JS
analogues", the kernel control commands "surely should be grouped with this", and, on the coordinator's proposals for
the name, the members and the discovery design, "Sure your call is fine. I think being able to list the packages while
the kernel is dead is useful". The restart command was ruled earlier with the ladder (ruling 102; the plan's class A,
B and C entry). Everything below the ruling is the coordinator's calls, each for Shane to override. Owner of the
build: the packages lane, after the `tables` removal and `ml.image` (ruling 114). AMENDED 2026-11-24 after the
packages lane read it against main (0f4efcb9): ten sentences were wrong or incomplete about the code, and the
mechanisms below are the corrected ones.

## What exists today

The packages lane's reading of main, 2026-11-24, with its file references; the coordinator checked the facade and
`agent_api_docs` and no more.

- Every `ml` member a Python cell has is shared with JavaScript and sits at the top level (`config`, `dereference`,
  `settings`, the other read-only members the worker's realm serves, `sh.run`, `sh.read`, `sh.put`), but for
  `ml.table`. Everything else that is Python-only is an argument or a behaviour of `python_exec`: `keep`, the outside
  mark, the "namespace reset" line in a cell's output.
- No restart member exists. The outside mark is cleared only by a new Worker (`py-mark.ts`).
- A model is told about ONE Python member, once the `tables` removal lands (main today has no Python `ml.table`, so it
  is told of none). The `python_exec` description and its details name `ml.table` only; the system prompt's Python
  clause names none, and names `ml.sh` as something an `exec` script calls; `agent_api_docs` describes the JavaScript
  surface; in a cell `dir(ml)` lists `table` alone, since every other member is resolved dynamically (`ml-facade.ts`),
  and `help(ml)` prints a docstring naming `ml.dereference` and `ml.table`. The real list of what a cell has appears
  in one place: the error after a call to a member that does not exist (`ml-wire-serve.ts`). The facade's printed form
  tells the model to `await` every member, which is wrong for `ml.table`.

## The namespace

`ml.python` holds what is about the Python kernel of the run and has no JavaScript analogue. A member that has, or may
get, a JavaScript form stays at the top level: `ml.table`, `ml.image`. The name is `ml.python`, not `ml.py`, which
reads as a file's name in prose, in a search and to a model inside a Python cell.

| Member | What it does | In a Python cell | In a JS cell | Asks |
| --- | --- | --- | --- | --- |
| `ml.python.restart()` | replaces the run's kernel with a fresh one | yes; takes effect when the cell returns | yes | never |
| `ml.python.keep()` | keeps the kernel's names through idle gaps for the rest of the turn; replaces `python_exec`'s `keep` argument | yes | no | never |
| `ml.python.packages()` | lists the packages the run's kernel has or would have: name, version, where from | yes | yes, with the kernel dead too | never |
| `ml.python.names()` | lists the names the kernel's namespace holds, with each one's type name; not scheduled | yes | yes | never |

Never members: the outside mark (a read offers nothing, and anything that clears it on its own would let approved code
un-mark itself); Stop and the bench's reset, which are the person's controls; `expect_ms`, which the host needs before
a line runs; `verify`, which stays an argument until a script can queue an image read with a function (Shane,
2026-11-24) and belongs with `ml.image` then.

## `ml.python.restart()`

It destroys the run's own kernel and starts a new one. It needs no approval: the only state lost is the model's own.
It resets INTEGRITY and nothing else, and what the model has read stays in its context, so nothing that tracks reads
(a policy's remembered reads, the scrub's session entries, the run's ledger) is reset by it. Two marks record what a
kernel may hold, and a restart clears both: the outside mark, which is per Worker and goes with the old one, and the
run's BRIDGED mark (`ml_py_bridged` in `chrome.storage.session`, the record that an approved cell was given the bridge
and may have kept something), which is keyed by the run, survives a new Worker, and is forgotten by the restart as its
own step in the service worker. Without that, later cards would still say what the run "may have kept" in a kernel
that no longer exists. The run is then in class A.

- *One mechanism, a message from the service worker, and two entry points.* A Python cell reaches the member over the
  `ml` wire. A JS cell does not use the wire: a read-only survey's `ml` is the service worker's survey host, so the
  member is on that host too, admitted by name. Both end in the same place: the service worker sends the offscreen
  document a new message, `PY_RESTART { principal }`, and the document replaces that principal's Worker. The service
  worker has no channel to a Python worker itself. The document checks that the principal is `run:<the calling run>`
  and refuses any other.
- *Callable from a JS cell*, because a wedged or out-of-memory kernel cannot run the Python cell that would call it.
  The message is sent at once. In the read-only JS dialect the member is admitted by NAME as the one member that is
  not a read; the read category is not widened for it.
- *From a Python cell* it takes effect after that cell returns, never mid-cell: the service worker notes the call and
  sends `PY_RESTART` after the cell's FINAL result. A cell that outran its lease answers twice, first the detach and
  later its result as a task; the restart waits for the second, since the task is the calling cell still running.
  Nothing today kills a worker after a result but the kernel-death path, which is the precedent. A cell that calls it
  and then loops is bounded by the cell's own clock.
- *It reaches the run's own principal only*: never the person's bench kernel, another run's, or another session's. A
  page-started cell has no kernel of its own, and the member is absent there.
- *A detached cell on that kernel* (one that outran its lease and became a task) is ended with a named reason. The
  kill's reason list gains `restart` (an unlisted reason reads as "crashed" today), and the pending cell's message,
  the task's end and the next cell's loss line all say "the sandbox was restarted by this run's ml.python.restart". No
  other run's task is touched.
- *At most one restart a step, counted in the service worker.* A restart is a full boot, seconds and hundreds of
  megabytes. The offscreen document knows no step, so the count is the service worker's, by run and step sequence, and
  it is ONE count across both entry points: for a Python cell the step of its wire client, for a JS cell the step
  running the survey. A second call in the same step is refused with one sentence. A caller with no step open is
  refused.
- *What the model reads.* The call answers one line saying the kernel is new, every name is gone and cells are tried
  inside the dialect again. The next cell carries the existing "namespace reset" line with the reason `restart`.
- *Recorded*: the housekeeping record the kill already writes (`pyodide` / `kill`), with reason `restart`; no second
  record. The next cell's facts read class `A`.

## `ml.python.keep()`

The `keep` argument's meaning, unchanged, said in the cell: the kernel is not shut after 30 idle minutes, until the
turn ends or the kernel is killed. Today `keep` is armed BEFORE the cell, from the call's payload, and re-checked
against the live turn at each send. A call from inside the cell needs a new path: `ml.python.keep()` is a wire member,
the service worker notes it for the run, and the keep is armed at that cell's FIRST answer, the detach of a cell that
outran its lease or else its result, under the same live-turn check: a detached cell is the long-running case a keep
exists for, and the reaper may look before its final result. The worker's own result carries no keep flag, so a cell
cannot arm it but through the wire. A cell that fails before reaching the line is not kept; that is the one difference
from the argument. Worker-hosted runs only, as now. The `keep` argument is removed in the same PR, the loss line that
names "python_exec keep: true" is reworded with it, and a call that still passes the argument is answered with one
sentence naming `ml.python.keep()`, not a schema error; a stored session replays as stored.

## `ml.python.packages()`

Shane: listing the packages while the kernel is dead is useful. So the answer never comes from the kernel, and no
message goes to a Python worker for it. It is a read in the service worker of two things it already holds: the shipped
set (`pkg-shipped.gen.ts`, wheel file names, from which the name and version are parsed) and the run's approved
installs (`ml_pkginstalls` in `chrome.storage.session`, which each cell already reads). Each row is `{ name, version,
from: "shipped" | "installed" }`. The field is `from`, not `source`, which an install's row already uses for its
index. There is no `loaded` field: nothing outside the interpreter knows what is imported, and a report from the
worker would be a new message kind for little. It is inside both dialects, and the same answer from a JS cell and a
Python cell. Past 512 rows the answer is cut and says so. The installs record is lost when the browser restarts, as
the installs themselves are, and the answer then lists the shipped set alone.

## `ml.python.names()` (not scheduled)

The names the kernel's namespace holds that the run defined, without the prelude's (`PY_RESERVED_NAMES`), each with
its type's name and nothing of its value. A read. From a JS cell it lets a survey see what the kernel holds without
running Python. With the kernel dead it answers an empty list and says the kernel is not running. Built when something
needs it.

## How a cell learns what `ml` has

One table is the source, and everything a model can ask reads it.

- *The table.* `ML_MEMBERS`, in a contract module: one row a member, `{ name, langs: ["js", "python"], sync, realms,
  summary }`. `sync` says the member is not awaited in Python (`ml.table` today). `summary` is one line, under 120
  characters, written for the model.
- *What a cell is handed.* The set a cell has depends on its realm and run (`sh` only with a host and an open step,
  `settings` only on a run the worker built), and the wire computes it at each CALL, not when it opens. So the service
  worker computes the names once more just before it sends the cell, with a names-only form of the same function, and
  sends them with the cell (`wire.members`, each with its summary and whether it is awaited), through the offscreen
  document to the worker, which hands them to the facade and drops the global as it drops the wire's own. In Python
  `dir(ml)` returns those names, `help(ml)` prints them with their summaries and `help(ml.x)` prints one; a member
  object has no room for its own docstring today (`__slots__`), so the facade gives it one from the handed summaries.
  `dir(ml)` is therefore a snapshot from the cell's start: a member it lists can still answer "not available here"
  later in the cell (`sh` once its step ends), and the error then prints the set as it is at that call.
- *`agent_api_docs`* answers a query for Python from the rows with `python` in `langs`, and marks a JavaScript member
  with no Python form as such.
- *The description.* `python_exec` gains one line in place of per-member prose: that `ml` in a cell is the run's `ml`,
  that `dir(ml)` lists what this cell has and `help(ml.x)` says what a member does, and that members are awaited but
  for the ones `help` marks. The text comes to the coordinator first, is counted in PROMPT_BUDGET.md, and its bench
  run needs Shane's yes in the bench lane's own session.
- *No padding.* The summaries and `help`'s output are model-facing: no alignment spaces.

### The table is generated, and Python reads the same graph (ruling 129)

RULED 2026-11-26 (Shane, in the coordinator's session; the details the coordinator's calls). NOT BUILT. It amends the
list above: where the two differ, this section rules.

- **`ML_MEMBERS` is generated, not written by hand.** A row comes from the member's own declaration in the contract:
  its JSDoc's first sentence is the summary, and its signature gives the arguments and the return type. The generator
  is the one that writes the JavaScript reference (`scripts/gen-api-docs.mjs`); no second copy of a member's text
  exists. What a person writes is one tag on the member's JSDoc saying Python has it.
- **No member is Python-only.** Every Python member is a member JavaScript has under the same name (`ml.table`
  included: `src/ml/ml-table.ts`, an awaited call that answers a `Table`). The two languages differ in at most three
  things, and the tag carries them: whether the call is awaited, the return type, and an argument one language has
  alone.
- **One graph, a signature per language.** `agent_api_docs` holds one graph: a member names types, and a type names
  types (`src/tools/api-docs-query.ts`, the breadth-first walk). A member has a JavaScript signature and a Python one,
  and a query for Python starts its walk from the types the Python signature names.
  - *The default Python signature* is derived from the JavaScript one by one rule. OPEN, for the builder to read
    before the rule is written: how a member that is passed through takes an options object in Python (keyword
    arguments or one dict).
  - *An override* is for a member with its own Python implementation (`ml.table` and `ml.fetch`, ML_TABLE.md): the
    tag states the Python signature and return type.
- **The Python walk is cut at a Python type.** A type that is plain data crossing the wire serves both languages
  from one section. A JavaScript object with methods, or anything that answers a promise, is not reachable from
  Python: an override names a Python type in its place (`pandas.DataFrame` for `ml.table`), which is a leaf with no
  section, and the walk stops there.
- **The form the model reads is a Python stub, not TypeScript.**
  - A member is a `def`, or an `async def` when it is awaited, with type hints, its docstring and no body. `async
    def` against `def` is what tells the model to await; the sentence about `help` marking the ones not awaited
    (above, "The description") is dropped, and so is the facade's printed advice to await every member.
  - A plain-data type is rendered as what a cell receives. A JSON value arrives in a cell as a dict (ML_WIRE.md), so
    it is a `TypedDict`, and the model reads `r["url"]`, never `r.url`. Not an abstract base class: nothing is
    inherited, and a class would teach attribute access.
  - `help(ml.x)` in a cell prints the same stub for `x`, from what was handed with the cell.
  - No padding, as above. Its size is counted in PROMPT_BUDGET.md with the description.
- **Rows, added to the list below, each by enumeration over every member, never a sample:**
  1. For each member with an override, the tag's signature equals the signature of the function the worker serves,
     read from a running worker (`inspect.signature`), and `async def` in the stub equals whether the call must be
     awaited there.
  2. No type reachable in the Python walk holds a method or a promise. A member whose JavaScript form answers such a
     type and has no override fails this row, by name.
  3. For each plain-data type reachable from Python, a value of it arriving in a cell is of the rendered form (a
     dict for a `TypedDict`), with the rendered keys.
  4. The generated table equals the wire's set for each realm and host (row 1 of the list below, unchanged), and a
     member with no tag is absent from Python's `dir` and marked JavaScript-only in `agent_api_docs`.

## Rows, for whoever builds it

1. The table against the wire, by enumeration: for each realm and host, the names the wire serves equal the table's
   rows for that realm with `python` in `langs`; `dir(ml)` equals what was sent with the cell; every row with `python`
   in `langs` is served by some realm; a JavaScript-only member is absent from Python's `dir`; a member listed at the
   cell's start and gone by the call answers "not available here" with the current set.
2. `help(ml)`, `help(ml.table)` and the printed forms: `ml.table` is not told to be awaited, every other member is.
3. Restart from a JS cell with the kernel wedged in a loop, and with it out of memory: a new kernel, an unmarked
   Worker, the run's bridged mark forgotten, the next cell tried inside and its card naming nothing kept. `PY_RESTART`
   naming another run's principal, the bench's, and a malformed one is refused by the offscreen document.
4. Restart from a Python cell: the cell's result arrives, then the names are gone; from a cell that detached, the task
   runs to its own result first; a second call in the same step is refused with its sentence, whichever entry point
   made the first, and so is a call with no step.
5. Restart ends a detached cell of that kernel with the named reason in the pending cell's message, the task's end and
   the next cell's loss line, writes `pyodide`/`kill` with reason `restart` once, and leaves another run's task, the
   bench's kernel and another session's kernel untouched.
6. Restart resets no record of what the run read: a remembered read, a session registry entry and the ledger are as
   before.
7. A page-started cell: `ml.python` is absent, in both languages.
8. `ml.python.keep()`: the kernel outlives the idle bound; a cell that detaches is kept from its detach; a cell that
   throws before the line is reaped; a call passing the old `keep` argument gets the sentence; a worker result that
   carries a forged keep flag arms nothing; a keep called after the turn ended arms nothing.
9. `ml.python.packages()` with the kernel dead, never started, and running: the same rows; from a JS cell and a Python
   cell the same answer; no message is posted to a Python worker to answer it; after the installs record is gone the
   shipped set alone.
10. Upgrade: a stored session whose cells passed `keep` replays as stored, and a resumed run that passes it gets the
    sentence, not a schema error.
11. Red team: an approved outside cell cannot make `restart` keep its plant (the Worker object is new, by identity);
    no member reads a mark, and none clears one but `restart`, which does it only by replacing the Worker and
    forgetting the run's bridged mark with it; a page cannot reach any member, nor send `PY_RESTART`; a Python worker
    cannot post `PY_RESTART` for itself or another principal.
