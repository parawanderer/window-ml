# Idea: interactive processes through `ml.sh`

**Status: proposed, not built (2026-10-24, from Shane's question that day; nothing here is assigned).** What it would
take for a script to hold a running program, read what it shows and type into it, and in which order the pieces are
worth having. It refines the open question at the end of [`SHELL.md`](SHELL.md) ("Interactive programs") and changes
nothing that is built: today one call is one process or pipe, stdin closed, no terminal, a time limit, output capped,
a cancel handle if it detaches ([`SHELL.md`](SHELL.md), "One call"; the detach itself is
[`ASYNC_CALLS.md`](ASYNC_CALLS.md) mode 1), and the host protocol knows `start`, `done`,
`cancel` and `status` only.

## What the shape is

Shane's framing is the right one: a STATEFUL VALUE in the one namespace ([`SHELL.md`](SHELL.md), "The model of it"),
held by the worker, pointing at a process the host owns. The same object in JS and in Python through the `ml` wire
([`ML_WIRE.md`](ML_WIRE.md)), with four verbs and nothing else:

| verb | what it does | cost |
| --- | --- | --- |
| `read()` | what the program has shown since the last read, or (with a terminal) the SCREEN as it stands | a step per bounded chunk, as `ml.sh.read` charges today |
| `write(text)` | bytes to the program's stdin | ONE CALL, with its own card and policy (below) |
| `wait()` | the `done` record, as a call today | free |
| `kill()` | `cancel` on the host: SIGTERM, SIGKILL two seconds later | free |

Ownership, the memory bound, `onOwnerLoss` and the count of running calls apply unchanged ([`SHELL.md`](SHELL.md),
"Every process has an owner"): the handle is a running call that has not finished, nothing new to the host's table.
That part is plumbing, borrowed from `child_process` and `asyncio.subprocess`, and is NOT the question.

## The question: what an approval means once stdin is open

Everything in the shell design rests on argv being the whole program: a manifest describes the effects of an argv
([`PROGRAM_MANIFEST.md`](PROGRAM_MANIFEST.md)), a policy decides on the argv ([`POLICIES.md`](POLICIES.md)), and the
decision happens ONCE, before the start. A program with an open stdin is a program whose behaviour is chosen AFTER
the approval. A REPL (`python`, `node`, `psql`, `sqlite3`) is a shell by another name; `ssh host` followed by typed
input runs anything on another machine; `git` and `gh` prompt for credentials. So the first ruling, and the only one
consistent with the rest of the design:

**RULE: every `write` is a call.** It has its own card, showing the program, the handle's argv and the text as typed;
a policy may allow a program's input lines by pattern, the way it allows an argv today; NO write is ever in the free
tier, whatever the manifest says about the program, because the manifest described the argv, not what is typed into
it. A remembered answer for a write is a policy with a pattern, never "allow everything typed into this handle". The
describe/decide/enforce layers stay three: the manifest may say a program READS stdin (so the card says "this
program takes input"), the policy decides on each line, the host enforces that nothing reaches the pipe without a
decision.

The non-interactive forms are preferred, and the spec should say so where the model reads it: `ssh host cmd`,
`psql -c`, `python -` with a script, `sqlite3 db 'select …'`. They are one argv, one approval, and a manifest can
describe them. The handle is for what has no such form.

## A terminal, and why the host should own it

A program that behaves differently on a terminal (`top`, `less`, a progress bar, a password prompt, anything using
curses) needs a pty, and a pty's output is escape sequences, not lines. "What is on screen" is then a grid of cells
with a cursor, which is a TERMINAL EMULATOR's job, not a byte stream the model reads. That is a solved problem and is
REUSED, not written: the host is Rust ([`SHELL.md`](SHELL.md), "The host's language"), so `alacritty_terminal` (the
engine behind Alacritty and Zed's terminal), `vt100` (smaller) or `wezterm-term` (heavier) keep the grid; on the
extension side `@xterm/headless` would do the same without a DOM. The emulator lives in the HOST, for two reasons:

- **Bytes never cross the port.** One SNAPSHOT frame (`rows`, `cols`, `cursor`, the lines as text, bounded in size)
  answers a `read`, on demand or on change, under the per-caller stream key SHELL.md already has. The worker and the
  model see rendered text, never raw output.
- **Escape sequences are an injection surface of their own.** Cursor moves that hide text, OSC sequences that set a
  title or paste, bracketed-paste tricks: anything a page-controlled file can print through `cat` or a log can carry.
  A model that reads the rendered grid sees what a person sees on a screen. That argument holds for today's
  NON-INTERACTIVE output too: what `ml.sh.read` hands the model should be measured for control characters, and the
  measurement belongs with the red team's next pass on `ml.sh`, interactive handle or not.

What remains real work, in order of size: the pty inside the sandbox envelope (a pty is a device pair; container
mode allocates it inside the container, Landlock mode must allow the slave; `SANDBOX.md` in window-ml-host on the host
side), the three new frames (`start` with `pty`, `input`, `resize`) and the snapshot answer, and the emulator crate's
bound on scrollback so a `yes` cannot grow the host's memory past the call's bound.

## Slices, in the order they are worth having

1. **Stdin as data.** A string or a handle piped in at start, then closed. `python -` with a heredoc, `psql` with a
   script, `sort` over a value. The whole program is known before the approval, the manifest can say the program
   reads stdin, nothing above changes. Small, and most of what agents want from "interactive" tools.
2. **Streaming read of a detached call.** `read()` on a handle with no `write`: output since a cursor, bounded,
   charged as `ml.sh.read` is. Progress on a long run, which today is invisible until `done`.
3. **The handle proper**, `write` included, under "every write is a call", with NO pty: pipes only. Programs that
   need a terminal fail as they do today (they prompt, stdin is a pipe, they exit), and the card says so.
4. **The pty and the screen**, only when a use case needs it that slices 1 to 3 do not serve. The emulator is a crate
   choice; the sandbox plumbing is the cost.

## What a hostile page must not get (for the red team, when a slice is assigned)

- No write reaches a program's stdin without a decision: not from a page, not from a remembered answer wider than a
  line pattern, not from a policy a page proposed ([`POLICIES.md`](POLICIES.md), proposals).
- A handle is bound to its owner: a page, another run or a resumed session cannot read or write a handle it did not
  start; a handle outlives nothing its owner does not (`onOwnerLoss`).
- A `read` is bounded: a program that prints forever costs steps, never memory, in the host and in the worker.
- The screen a model reads carries no bytes the emulator did not render: no escape sequence survives into a `read`.
- The pty, when it exists, is inside the sandbox: a program cannot reach the controlling terminal of the host or of
  the person's shell (`TIOCSTI` and its successors are the classic escape; the pty is allocated by the host for the
  call, never inherited).

## Typed input: who answers a program's prompt (proposal, 2026-11-20, Shane's ruling; nothing scheduled)

A program that stops to ask for something typed is answered by the model (a y/N, a REPL line) or only by the
person (a password, a 2FA code). A sign-in that needs only a link and a code is not either case: it is in
[`ASYNC_CALLS.md`](ASYNC_CALLS.md), "A detached call that asks the person to sign in". The target experience is the
question card VS Code raises for a Jupyter notebook. The cell calls `input("…")` and an input box appears carrying the
prompt text; the person answers and the cell continues. `getpass` gives a masked box. Claims about today are marked
**checked** (file and line, read on main at 6ebd0efd) or **guessed**.

### 1. The model can answer (y/N, a REPL)

That is this file's slices, unchanged. An answer known before the start (`y` to a confirmation, a script to a REPL) is
slice 1, stdin as data, and the non-interactive form is preferred above it (`--yes`, `psql -c`). An answer chosen
after reading the program's output is slice 3, under "every write is a call".

### 2. A program that says it is waiting: Python's `input()` and `getpass()`

**The Python sandbox is the first slice, because there the program SAYS it is waiting.** Jupyter's kernel sends an
explicit `input_request` on its stdin channel, carrying the prompt and a `password` flag. ipykernel does it by
replacing `builtins.input` and `getpass.getpass` (guessed from memory of ipykernel, not read here). We own the worker,
so the same holds, with no heuristic.

- **Today (checked).** Nothing sets Pyodide's stdin: the one `loadPyodide` (`src/python/python-worker.ts:131-132`) gets
  `pyodideLoadOptions`, which carries only `indexURL` and `packageBaseUrl` (`src/python/python-env.ts`, about `:70`).
  Nothing in `src/python/` touches `input`, `getpass`, `sys.stdin` or `termios`. Pyodide's default stdin is
  `globalThis.prompt ? () => globalThis.prompt() : undefined` (`node_modules/pyodide/pyodide.mjs`, 314.0.3). The cell
  runs in a Worker the offscreen document starts (`src/offscreen.ts:336`), which has no `prompt`, so the default never
  calls one.
- **Measured, stock Pyodide 314.0.3 under Node with stdin at EOF** (a scratch probe, not the restricted core, not the
  worker):
  - `input('name? ')` prints the prompt and raises `EOFError: EOF when reading a line`;
  - `getpass.getpass()` raises `EOFError`;
  - `import termios` works, and `tcgetattr(0)` raises `termios.error: (59, 'Not a tty')`;
  - `sys.stdin.isatty()` is `False`.
- **Guessed:** the worker behaves the same (EOF, then `EOFError`). The building PR's first row pins that in the
  restricted core before changing anything.
- **How the card is raised.** `pyodide.setStdin`'s `stdin()` callback is synchronous but is never handed the prompt
  text (checked: `setStdin(options?: { stdin?, read?, error?, isatty?, autoEOF? })`, `pyodide.d.ts:21-27`). So the card
  comes from replacing `builtins.input` and `getpass.getpass` at kernel start, as `files-mount.ts` patches
  `builtins.open`. Each sends `{ prompt, password }` and blocks until the answer. Direct reads of `sys.stdin` stay at
  EOF, with no card.
- **The wait is route A's** (checked): a posted request and a reply in shared memory, waited on in
  `WAIT_SLICE_MS` slices of `Atomics.wait`, checking the interrupt buffer each slice (`src/python/files-wire.ts:58-66`,
  the `/files` mount's channel). It is the same channel shape with a new op. The sandbox therefore needs what `/files`
  already needs (SharedArrayBuffer, the interrupt buffer). A core without them answers `EOFError`, as today.
- **The card is an inbox item.** It goes in the person's attention inbox (`src/chat/attention.ts`; the same inbox
  `SECRET_HANDLES.md` ruling 33 uses), so the chat page and the phone show it, beside the sidebar. A masked card's VALUE
  is entered only in the renderer the extension hosts, as ruling 33 defers remote entry. A remote surface shows the
  card and says entry is on the computer. An unmasked `input()` answer may come from any surface; it is ordinary text.
- **What the card shows.** The call that asked (the run, the cell's task id, `input` or `getpass`) is in the harness's
  words. The prompt text appears beneath it as quoted PROGRAM OUTPUT, labelled as such: a program can write a
  misleading prompt ("Enter your Google password"), and the card's own words never come from it.

**The flow (RULED 2026-11-20, Shane: the model may answer an `input()` itself, or escalate it to the person).**
1. **The call says it is waiting, at once.** A leased cell that calls `input(prompt)` or `getpass(prompt)` resolves
   its tool call AT ONCE, with no lease wait. The status is new, beside `detached`: `{ status: "waiting-input", id,
   prompt, masked: false, tail }`, or for a `getpass` `{ status: "waiting-person", id, prompt, masked: true, tail }`
   (step 4: only the person can answer it). It is a task row like a detached cell's: `task await` and `task cancel` work
   on it, it shows in `ml.current.tasks`, and the kernel stays locked as for any running cell. A cell that had already
   detached when it asks gets the same state as an inbox item, `[task <id> waiting for input: "<prompt>"]`. That item
   crosses the inbox's checks, wakes a waiting `await`, and with no turn running starts one (rule 4b, slice C) under its
   gates.
2. **Two new `task` verbs, no new tool.**
   - `task send <id> text`: the stdin write, which `input()` returns. The verb is not called `answer`, which is
     already a tool's name.
   - `task escalate <id>`: raises the question card. The card is an inbox item for the person.
3. **The result is the cell's next state.**
   - `send` resumes the cell under a fresh lease, so its result is the cell's next state: `finished` (the cell's
     result), `detached`, or `waiting-input` again.
   - A wizard is that loop, one round per question.
   - Each state after the first carries only the output since the previous state, so a wizard's rounds never repeat
     earlier output. The cell's whole output is one stored value at the end, in its finished result, as any cut
     result is.
   - `escalate` CANNOT work as written. Its next state exists only once the person answers, which may be hours later.
     So `escalate` answers at once with `{ status: "waiting-person", id }`. The next state then arrives as any
     detached result does: to a `task await`, or through the inbox, starting a turn if none is running.
4. **Masked.** A `getpass` (`masked: true`) never accepts `send` with plain text; `send` on it is refused by name. The
   model is told a masked answer is awaited and that the person has been asked, by the status itself:
   `waiting-person` with `masked: true`, never `waiting-input`. Recommended: the card is raised AT ONCE,
   without the model's `escalate`, since nothing else can answer it. Open for files-host: whether `send` may name a
   registered secret BY NAME (`send <id> secret:PLUG_PASSWORD`), which only `SECRET_HANDLES.md` can allow.
5. **The gate: free in a readonly cell, judged in a full one** (recommended). The text only becomes the return value
   of `input()` in the model's own code, so in a READONLY cell it can do nothing that code could not already do there
   for free. A free `send` widens nothing. Checked: today `input` is a refused builtin in the readonly dialect
   (`whitelist.json`), so this half needs `input` admitted with the flow (section 3); until then every `input()` is
   in a full-mode cell. In a FULL-mode cell the approved code may treat the text as code
   (`exec(input())`), and an unjudged `send` would then run unapproved code in full mode. There it is a call with its
   own card showing the prompt and the text, consistent with "every write is a call" above for `ml.sh`, where every
   write is judged. A policy may allow a full-mode cell's sends by pattern, as for `ml.sh`. NO full-mode send is in the
   free tier.
6. **The record.** A `send` is a step like any tool call. The transcript, the run log and both exports show it with
   the prompt it answered, quoted as program output. The cell's own output echoes prompt and answer as a notebook
   does. A person's unmasked answer is ordinary text and reaches the model, through the echo, the variables and the
   inbox item that resumes the run. On its way to the model it passes the same scrub as the cell's output (`forModel`:
   the extension's own key and every registered value). The residual is the variable's: the scrub runs where a text
   crosses to the model, never on the kernel's values. So a secret the person types into an UNMASKED box is masked only
   if it is already registered, and the cell's code holds it in plaintext either way. A masked answer is a session
   secret (below) and does not reach the model.
7. **Edges.**
   - **Nobody answers.** It stays `waiting-input` or `waiting-person`, and no new timeout is invented. The existing cap
     (`detachedTaskMaxMin`) still kills the cell, which withdraws any card.
   - **Cancel** (`task cancel`, Stop) sets the interrupt buffer. The sliced wait checks it every slice (as
     `files-wire.ts:63` does), withdraws the card and raises `KeyboardInterrupt` in `input()`. This differs from the
     EOFError first suggested: rule 3 of ASYNC_CALLS.md makes a cancel an interrupt, with the namespace kept, and a
     program that catches `EOFError` and carries on would not be stopped by one.
   - **Declined.** The person DISMISSING the card raises `EOFError("the person declined to answer")`, what closed
     stdin gives today (measured above).
   - **Both answer.** If the person and the model both answer, the first wins. The second is refused by name: `task
     <id>: its input was already answered by the person` (or by `task send`), and a card answered second shows that
     it closed.
   - **The turn ends while waiting.** The row survives the turn (rule 4b). Recommended: an unmasked
     `waiting-input` the model did not escalate is escalated when its turn ends, since no model step can answer it
     until a person's message or a task starts the next turn. The card says the model left it to the person.
   - **Later, named only:** a setting for "the person always answers" (every `input()` escalated at once).
   - **Where `waiting-input` cannot exist.** A cell that cannot lease has no task row: a page's `ml.pythonExec` (e3's
     row B of `tests/redteam-python-lease.test.mjs`: no cell, no task row) and a page-hosted run's cell. There
     `input()` raises `EOFError` as today. The Python bench has a person at the keyboard and could raise the card
     directly; that is a later choice, not part of this flow.

**A masked answer.**
- **`getpass()`: a session secret** (Shane's direction, 2026-11-20, confirmed with the flow ruling: an ORIGIN, not a
  fourth kind). A masked card's answer is a registered value whose registration origin is the harness at run time,
  not the person in Settings. The definition is
  [`SECRET_HANDLES.md`](SECRET_HANDLES.md)'s, which the files-host lane owns and writes with rulings 93 and 94. This
  side needs only these:
  - **Registered before the cell resumes**, so the existing scrub (tool output, `/files` reads, error text) masks it
    from then on, in the registry's forms ("The scrub as built", "The forms matched"). Nothing echoes it.
  - **Lifetime: the session.** It is gone with the session, never written to disk or sync storage.
  - **NOT promised.** The cell holds the plaintext and can use it; that is what `getpass` is for, and the model's next
    cell can read the same variable. A value the script transforms itself (a slice, a hash, an encoding outside the
    registry's forms) is not masked: "a value that was transformed or only partly echoed" (SECRET_HANDLES.md, "Known
    limits"). It is the same residual as any registered value, and the masked card says so in one line. "Use but never
    read" here means the harness never SHOWS the model the value. It does not mean the model's own code cannot reach
    it.
  - **Asked of files-host, and answered** (SECRET_HANDLES.md, "Amendments after the scrub", the answers to #2066's open
    items: a generated name, a "save to the store" box that starts unticked):
    - whether the person is offered "save to the store" afterwards;
    - what NAME the registration carries, since the prompt text is program-written and cannot be the name as it stands;
    - whether `ml.sh`'s person-answered stdin (below) registers under the same origin.

**The mixed case, written out: a setup wizard.** A cell runs a library's interactive setup, which asks three things in
turn:
```
host [localhost]: <- input(); the model: task send <id> "db.internal"
user: <- input(); the model: task escalate <id>; the person types "shane"
password: <- getpass(); masked, card raised at once; registered as a session secret before the cell resumes
```
Each question is its own round, raised only when the program asks, so at most one is open per cell and they come in
order. The model reads `waiting-input` with prompt `host [localhost]: ` and sends `db.internal` (judged: a library's
setup runs in a full-mode cell). The next state is `waiting-input` again, with `user: `, and the model escalates that
one because it does not know the name. The person answers on the card, and the next state, `waiting-person` with
`masked: true` for `password: `, raises its card at once. The person answers, and the cell finishes. A card names the
cell's task and quotes its prompt as program output. The cell's output reads
`host [localhost]: db.internal`, `user: shane` and `password: ` with nothing after the last. If the password card
is dismissed, `getpass` raises `EOFError` and the wizard fails as it would with closed stdin. The first two answers stay
in the output and the variables, where the model may read them.

**Host programs through `ml.sh` have no such signal**, and stay parked behind the secrets work and this file's slice 4.
- A program reading a password usually opens the terminal, not stdin, so it needs the host-side terminal emulator
  (above).
- Checked: the host has no pty today. `runner.rs` runs argv with stdin closed or a pipe stage
  (`window-ml-host/src/runner.rs:1, 138-147`), and nothing in its `src/` names a pty.
- Without a pty, "output stopped and the last line has no newline" is a heuristic and is said to be one.
- Guessed, not checked: whether the host could know a child is blocked reading.
  - Linux exposes it per process (`/proc/<pid>/syscall`, `wchan`), under ptrace-level access to the child.
  - macOS has no `/proc`, and no supported equivalent is known here.
  - With a pty, the master side can read the terminal's mode. Echo turned off is a strong sign of a password prompt,
    which is what some terminals show a lock for.
- The card, its inbox item, `task send`/`escalate` and the session-secret origin would be the Python slice's,
  reused. A person's answer is written to the program's stdin or pty as the one write in this file not judged as a call,
  because the person typed it. A model's `send` there is judged, as every write is.

### 3. Answers scripted ahead of time: "if it prompts X, answer Y" (PROPOSED, not ruled; Shane's question, 2026-11-20)

**What works today with no harness help.**
- **Checked on stock Pyodide 314.0.3 under Node:** a cell can replace `builtins.input`, `sys.stdin` (an `io.StringIO`)
  or `getpass.getpass` itself, and a library calling them then reads the scripted answers.
- **Checked:** none of that runs in a READONLY cell. `input` is a refused builtin (`refused_builtins` in
  `notebooks/python-dialect/data/whitelist.json`, beside `eval`, `exec`, `compile` and `open`). Neither `builtins`,
  `sys` nor `getpass` is among `manifest-stdlib.json`'s modules.
- **Guessed:** such a cell therefore asks, as a gap does ("which modules, calls and attributes are allowed is enforced
  only by the allow tables", above). That makes it a full-mode cell, approved on its code, which the person can read.
  The building PR pins it with a row.
- Today's answer is therefore "write it in the code, in full mode". The same fact constrains rule 5 of the flow:
  `input()` reaches the flow only from a full-mode cell unless the readonly dialect admits `input`. Recommended: admit
  it with the flow, and never `getpass`. The readonly dialect refuses `eval`, `exec` and `compile`, so a sent text
  cannot become code there, which is what keeps a readonly `send` free.

**Proposed: a declarative answers table on the call**, for `python_exec` first and `ml.sh` later (`answers`, beside
`expect_ms`). The rules are prompt match to reply, e.g. `answers: [{ prompt: "host [localhost]: ", reply:
"db.internal" }, { prompt: "Proceed? [y/N] ", reply: "y", times: 1 }]`.
- **Judged once, up front.** The rules are part of the call, so the approval card shows them beside the code or argv.
  The gate judges them with the call: free where a `send` would be free (a readonly cell), judged where it would be
  judged.
- **Fallback.** A prompt that matches no rule falls back to `waiting-input` (the flow), so the model or the person still
  answers it.
- **Bounded.** Each rule fires at most `times` (default 1, ceiling a small constant), so a program that asks again
  cannot loop forever. A rule used up falls back to `waiting-input`.
- **Masked.** A masked prompt (`waiting-person`, `masked: true`) is never matched by a plain-text reply, only by a
  registered secret's NAME, if `SECRET_HANDLES.md` allows it (open for files-host, as for `send`).
- **Recorded.** Each firing is in the cell's output echo and the run log with the rule's index, so the transcript
  shows which answer the program got and why.

**The hazard: the prompt is program-written.** A program can shape its prompt to trigger a rule.
- **What it can gain:** the reply the model wrote, sent once more than intended, or to a question other than the one
  meant. With `{ prompt: "y/N", reply: "y" }`, a program can ask "Delete all? y/N" and receive the `y`.
- **What it cannot gain:** text the model did not write, a masked value without the person, or more firings than
  `times`.
- **Recommended:** EXACT match of the whole prompt line as the default. A regex is opt-in (`prompt_re`), shown on the
  card as a pattern and costed by the regex-cost rules the dialect already applies
  (`notebooks/python-dialect/data/regex-cost/`). A substring default is the one shaped prompts exploit.
- **Recommended:** under `ml.sh`, where every write is judged, the table is the policy's per-line pattern
  ("Open", above) carried on the call, and nothing wider.

**The fully programmatic form**, a cell driving a process handle expect-style (read, match, write in a loop), is
slices 2 and 3 of this file. It is named here, not designed.

### 4. A page's `prompt()`

A page's own `window.prompt()` in JavaScript is left alone. Checked:
nothing in `src/` wraps or touches it. It is the page's dialog, and an `exec` that calls it blocks the page as it
would for anyone.

### What a hostile program or page must not get (e3's rows, when a slice is built)

1. No answer reaches a program except the model's `task send` (judged in a full-mode cell) or the person's gesture on a
   card. No page message, policy proposal, `change_setting` or `ml.settings` can send, fill or submit one, and no model
   tool can submit a CARD (ruling 33's gesture rule). A masked prompt refuses `send` with plain text.
2. A masked answer never reaches the model through the harness: no tail, result, wake, `ml.current.tasks`, run log
   text or export carries it, in any of the registry's forms, from the moment it is registered.
3. A masked answer is never written to disk or `chrome.storage.sync`, and is gone at session release.
4. A card's own words never come from the program. A prompt that imitates the harness ("window.ml asks for your
   Settings passphrase") shows as quoted program output under the real caller's name.
5. An answer goes to the one call that asked, once, and the second of two answers is refused by name. Another cell,
   run or session cannot read it from the channel, and a stale answer to a withdrawn card is dropped.
6. A page cannot raise a card. Only the worker's own cell can, and only through the channel the worker set up; the op
   is in neither `HANDLE_MAP` nor a page-started type.
7. A cancel or the cap always ends a waiting `input()`. A card left open cannot hold a kernel past its cap.
8. `task send` and `task escalate` act only on the run's own task ids, as `await` and `cancel` do (rule 5 of
   ASYNC_CALLS.md). A forged or foreign id reads `UnknownTask` and reaches no channel.
9. A free `send` exists only in a readonly cell. A full-mode cell's `send` never runs without a decision.
10. An answers table fires only as shown on the card. No rule fires past its `times`, a masked prompt never matches a
    plain-text reply, and a program cannot add, widen or re-arm a rule.

## The person's own terminal (IDEA, Shane, 2026-11-21; nothing assigned)

Everything above is the MODEL driving a program. This is the person's: an ordinary terminal, as in VSCode, opened in a
side tab of the same UI, so a person already talking to the model can unblock it (a `sudo` step, a sign-in, an install
the model may not do) without switching to a separate terminal app. A separate terminal works today; this is for
convenience. The frame is [`COMMAND_MODE.md`](COMMAND_MODE.md), "A console that stays out of the model's context".

- **Not from scratch.** The panel side is xterm.js, the terminal component VSCode uses. The host side is the pty this
  file's slices need anyway (the host has none today), so one pty mechanism serves the model's handles and the
  person's tab.
- **`sudo` needs nothing of ours.** The tab runs the person's login shell with the person's own rights; `sudo` asks
  for the password in that terminal as it would anywhere.
- **The model never has it.** The model reads nothing of the tab and types nothing into it: no `ml.*` member, tool or
  pointer reaches it, and it is in neither the model's context, `ml.current` nor an export, unless the person sends a
  selection, which arrives as the person's turn. Only the person opens it, from the panel; a page, the model and a
  command-mode cell cannot.
- **A cached `sudo` password does not carry over.** A password typed in the person's tab must not let a later `sudo`
  in a model's pty or an `ml.sh` call run without asking. `sudo` caches per terminal by default on macOS (a guess, not
  checked; Linux varies by distribution), so this is a red-team row when it is built, not an assumption.

## Open

- Whether a write's policy pattern is per program (`psql`'s lines) or per handle (this session's `psql`).
- What a resumed session finds: a handle that is still running, or `done` with the output it missed.
- Whether slice 1's stdin may carry a secret handle ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)): a token on stdin is
  the usual way to log a CLI in without the token in argv, and would be the first real use.
  ANSWERED IN PART 2026-11-20 ("Typed input", above): a value only the person may type goes in through a question card
  as a session secret. A STORED secret's handle on slice 1's stdin stays open, with the secrets work.
