# Idea: interactive processes through `ml.sh`

**Status: proposed, not built (2026-10-24, from Shane's question that day; nothing here is assigned).** What it would
take for a script to hold a running program, read what it shows and type into it, and in which order the pieces are
worth having. It refines the open question at the end of [`SHELL.md`](SHELL.md) ("Interactive programs") and changes
nothing that is built: today one call is one process or pipe, stdin closed, no terminal, a time limit, output capped,
a cancel handle if it detaches ([`SHELL.md`](SHELL.md), "One call"), and the host protocol knows `start`, `done`,
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

## Open

- Whether a write's policy pattern is per program (`psql`'s lines) or per handle (this session's `psql`).
- What a resumed session finds: a handle that is still running, or `done` with the output it missed.
- Whether slice 1's stdin may carry a secret handle ([`SECRET_HANDLES.md`](SECRET_HANDLES.md)): a token on stdin is
  the usual way to log a CLI in without the token in argv, and would be the first real use.
