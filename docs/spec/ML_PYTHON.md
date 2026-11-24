# `ml.python`: the kernel's own members, and how a cell learns what `ml` has

**Status: ruled, not built.** RULED 2026-11-24 (Shane, ruling 116, in the coordinator's session): "I think all the
python-only functions should start to get grouped under a 'python namespace'. Especially when they have no planned JS
analogues", the kernel control commands "surely should be grouped with this", and, on the coordinator's proposals for
the name, the members and the discovery design, "Sure your call is fine. I think being able to list the packages while
the kernel is dead is useful". The restart command was ruled earlier with the ladder (ruling 102; the plan's class A,
B and C entry). Everything below the ruling is the coordinator's calls, each for Shane to override. Owner of the
build: the packages lane, after the `tables` removal and `ml.image` (ruling 114).

## What exists today

The packages lane's reading of main, 2026-11-24, with its file references; the coordinator checked the facade and
`agent_api_docs` and no more.

- Every `ml` member a Python cell has is shared with JavaScript and sits at the top level (`config`, `dereference`,
  `settings`, the other read-only members the worker's realm serves, `sh.run`, `sh.read`, `sh.put`), but for
  `ml.table`. Everything else that is Python-only is an argument or a behaviour of `python_exec`: `keep`, the outside
  mark, the "namespace reset" line in a cell's output.
- No restart member exists. The outside mark is cleared only by a new Worker (`py-mark.ts`).
- A model is told about ONE Python member. The `python_exec` description and its details name `ml.table` only; the
  system prompt's Python clause names none, and names `ml.sh` as something an `exec` script calls; `agent_api_docs`
  describes the JavaScript surface; in a cell `dir(ml)` lists `table` alone, since every other member is resolved
  dynamically (`ml-facade.ts`), and `help(ml)` prints a docstring naming `ml.dereference` and `ml.table`. The real
  list of what a cell has appears in one place: the error after a call to a member that does not exist
  (`ml-wire-serve.ts`). The facade's printed form tells the model to `await` every member, which is wrong for
  `ml.table`.

## The namespace

`ml.python` holds what is about the Python kernel of the run and has no JavaScript analogue. A member that has, or may
get, a JavaScript form stays at the top level: `ml.table`, `ml.image`. The name is `ml.python`, not `ml.py`, which
reads as a file's name in prose, in a search and to a model inside a Python cell.

| Member | What it does | In a Python cell | In a JS cell | Asks |
| --- | --- | --- | --- | --- |
| `ml.python.restart()` | replaces the run's kernel with a fresh one | yes; takes effect when the cell returns | yes | never |
| `ml.python.keep()` | keeps the kernel's names through idle gaps for the rest of the turn; replaces `python_exec`'s `keep` argument | yes | no | never |
| `ml.python.packages()` | lists the packages the run's kernel has or would have: name, version, whether loaded | yes | yes, with the kernel dead too | never |
| `ml.python.names()` | lists the names the kernel's namespace holds, with each one's type name; not scheduled | yes | yes | never |

Never members: the outside mark (a read offers nothing, and anything that clears it on its own would let approved code
un-mark itself); Stop and the bench's reset, which are the person's controls; `expect_ms`, which the host needs before
a line runs; `verify`, which stays an argument until a script can queue an image read with a function (Shane,
2026-11-24) and belongs with `ml.image` then.

## `ml.python.restart()`

It destroys the run's own kernel and starts a new one. It needs no approval: the only state lost is the model's own.
It resets INTEGRITY and nothing else: the new Worker is unmarked, so the run is back in class A, and what the model
has read stays in its context, so nothing that tracks reads (a policy's remembered reads, the scrub's session entries,
the run's ledger) is reset by it.

- *Callable from a JS cell*, because a wedged or out-of-memory kernel cannot run the Python cell that would call it.
  In the read-only JS dialect it is admitted by NAME as the one member that is not a read; the read category is not
  widened for it.
- *From a Python cell* it takes effect after that cell returns, never mid-cell: the cell's result is delivered, then
  the kernel is replaced. A cell that calls it and then loops is bounded by the cell's own clock.
- *It reaches the run's own principal only*: never the person's bench kernel, another run's, or another session's. A
  page-started cell has no kernel of its own, and the member is absent there.
- *A detached cell on that kernel* (one that outran its lease and became a task) is ended by the restart with a named
  reason, "the sandbox was restarted by this run's ml.python.restart", never silently, and no other run's task is
  touched.
- *At most one restart a step.* A restart is a full boot, seconds and hundreds of megabytes. A second call in the same
  step is refused with one sentence. Nothing else bounds it; the count is in the run log.
- *What the model reads.* The call answers one line saying the kernel is new, every name is gone and cells are tried
  inside the dialect again. The next cell carries the existing "namespace reset" line with the reason `restart`.
- *Recorded*: one housekeeping record (`pyodide` / `restart`, the principal as key, no content) and the cell facts'
  `class` of the next cell reads `A`.

## `ml.python.keep()`

The `keep` argument's meaning, unchanged, said in the cell: the kernel is not shut after 30 idle minutes, until the
turn ends or the kernel is killed. It is honoured when the cell returns, which is when the reaper next looks. A cell
that fails before reaching the line is not kept; that is the one difference from the argument. Worker-hosted runs
only, as now. The `keep` argument is removed in the same PR, and a call that still passes it is answered with one
sentence naming `ml.python.keep()`, not a schema error; a stored session replays as stored.

## `ml.python.packages()`

Shane: listing the packages while the kernel is dead is useful. So the answer never comes from the kernel. The
extension answers from what it already holds outside it: the shipped set (`pkg-shipped.gen.ts`) and the run's approved
installs. Each row is `{ name, version, source: "shipped" | "installed", loaded }`, where `loaded` is the kernel's
last report and is `false` for a dead or not yet started kernel. It is a read, inside both dialects, and it is the
same answer from a JS cell and a Python cell. Bounded: the shipped set and a run's installs are both small and
enumerable; past 512 rows the answer is cut and says so. The packages lane states where the run's installs are
recorded outside the kernel before building; if they are recorded only inside it, that record moves out first.

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
- *What a cell is handed.* The set a cell has depends on its realm and run (`sh` only with a host, `settings` only on
  a run the worker built). When the wire opens, the worker hands the cell the names THIS client serves. In Python
  `dir(ml)` returns those names, `help(ml)` prints them with their summaries, `help(ml.x)` prints one, and each
  member's printed form says whether it is awaited. The same list is what the error for an unknown member prints.
- *`agent_api_docs`* answers a query for Python from the rows with `python` in `langs`, and marks a JavaScript member
  with no Python form as such.
- *The description.* `python_exec` gains one line in place of per-member prose: that `ml` in a cell is the run's `ml`,
  that `dir(ml)` lists what this cell has and `help(ml.x)` says what a member does, and that members are awaited but
  for the ones `help` marks. The text comes to the coordinator first, is counted in PROMPT_BUDGET.md, and its bench
  run needs Shane's yes in the bench lane's own session.
- *No padding.* The summaries and `help`'s output are model-facing: no alignment spaces.

## Rows, for whoever builds it

1. The table against the wire, by enumeration: for each realm and host, the names the wire serves equal the table's
   rows for that realm with `python` in `langs`; `dir(ml)` equals what the open handed the cell; every row with
   `python` in `langs` is served by some realm; a JavaScript-only member is absent from Python's `dir`.
2. `help(ml)`, `help(ml.table)` and the printed forms: `ml.table` is not told to be awaited, every other member is.
3. Restart from a JS cell with the kernel wedged in a loop, and with it out of memory: a new kernel, an unmarked
   Worker, the next cell tried inside.
4. Restart from a Python cell: the cell's result arrives, then the names are gone; a second call in the same step is
   refused with its sentence.
5. Restart ends a detached cell of that kernel with the named reason and leaves another run's task, the bench's kernel
   and another session's kernel untouched.
6. Restart resets no record of what the run read: a remembered read, a session registry entry and the ledger are as
   before.
7. A page-started cell: `ml.python` is absent, in both languages.
8. `ml.python.keep()`: the kernel outlives the idle bound; a cell that throws before the line is reaped; a call
   passing the old `keep` argument gets the sentence.
9. `ml.python.packages()` with the kernel dead, never started, and running: the same rows but for `loaded`; from a JS
   cell and a Python cell the same answer; no message is posted to a Python worker to answer it.
10. Upgrade: a stored session whose cells passed `keep` replays as stored, and a resumed run that passes it gets the
    sentence, not a schema error.
11. Red team: an approved outside cell cannot make `restart` keep its plant (the Worker object is new, by identity);
    no member of `ml.python` clears or reads the mark; a page cannot reach any member.
