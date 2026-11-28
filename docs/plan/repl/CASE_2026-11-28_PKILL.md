# Case: one `pkill` from an agent's shell ended every session on the machine (2026-11-28)

A record of an incident on the development laptop, kept because it is a measured instance of the problem `ml.sh` is
designed against: a program started from a string, whose effect nobody stated and nothing bounded. The coordinator
wrote it from the system log, the test queue's records and the agent's own transcript; the two wrong diagnoses made on
the way are kept below, because they are part of the result.

## 1. What happened

At 09:44:14 UTC an agent's subagent, working in a clone on an unmerged branch, had waited 26 minutes in the machine's
test queue ([`scripts/test-slot.mjs`](../../../scripts/test-slot.mjs)) behind one slow run. It ran one shell line:

```
node scripts/test-slot.mjs cancel <its ticket>;
pkill -f "test-slot.mjs run -- npm test" -P 0 2>/dev/null;
(node --import tsx --test … > direct.log 2>&1) &
```

It meant: cancel my ticket, stop the queued runners, run my suite outside the queue. What the second command did:

- BSD `pkill` reads its options BEFORE the pattern and accepts several patterns (`pkill [options] pattern ...`). So `-P`
  and `0` were not an option and its value. They were two more patterns.
- With `-f`, a pattern is matched against the whole command line. The pattern `0` matches every process of the user
  whose command line contains a zero.
- Those were the browser's helper processes, the editor's helper processes, and with the editor every agent session's
  child processes, test runs included.

Seven seconds later every browser tab had crashed, every editor window had restarted, three test runs and a benchmark
sweep's browser were gone, and six queued test runs were marked abandoned. The browser named the extension as the
thing that crashed, since the extension's process was one of those terminated.

## 2. The evidence

| Source | What it shows |
| --- | --- |
| The macOS system log (`/usr/bin/log show`) | `pkill`, one process, sent SIGTERM to 46 launchd jobs between 09:44:20.790 and 09:44:21.190 UTC, in ascending pid order. launchd logs only its own jobs; the browser's and the editor's helpers are their apps' children and are not in that count |
| The subagent's transcript | The line above, as a tool call stamped 09:44:14.842 UTC |
| The test queue's record | That ticket `cancelled` at 09:44:20.689, 100 ms before the first signal |
| The browser's crash folder | Empty. A process terminated from outside writes no crash dump |
| The diagnostic report folders | No memory-kill report for that minute |

## 3. Two wrong diagnoses first

1. **"The test queue admitted four suites at once."** The queue's record does show four runs granted within nine
   seconds. They were an effect: each kill freed a slot, and the next admission pass filled it. No single pass ever
   held more than the queue's limit.
2. **"The machine ran out of memory."** Inferred from two unrelated applications losing processes in the same second.
   The queue's own figures refuted the first half of it (one run alive, 3 GB at its peak, 14.7 GB available nine
   seconds before), and the system log refuted the rest.

Both were passed on as findings before anyone had read the system log. The cost was a machine-wide limit on test runs
that addressed nothing, and an hour of a lane's diagnosis aimed at the queue's memory pricing, which was sound.

## 4. Why it is an argument for `ml.sh`, point by point

The agent's shell took a string, split it, and ran it with the user's whole authority. Each property below is one
`ml.sh` already states in [`SHELL.md`](../../spec/SHELL.md) or [`EFFECTS.md`](../../spec/EFFECTS.md), set against what
the incident needed.

| What went wrong | What the design says | Would it have held here |
| --- | --- | --- |
| Nobody stated what the command would do | A call nobody described has the effect `unknown`, which is inside no bound, so it never runs without asking (EFFECTS.md, the effect table). `pkill` has no program manifest | Yes: the call asks. An ask is a chance to see the mistake, not a guarantee that a person does |
| The option was read as a pattern, and nothing said so | "argv-safe is not option-safe": a manifest marks where a program's operands start, and the call is described from the parsed argv (SHELL.md, "One call") | Only with a manifest for `pkill`. Its description would have read "signal every process matching any of three patterns", with `0` as one of them. No such manifest exists, and none is proposed: the row above already asks |
| The signal reached processes that were not the caller's | Every process has an owner and runs in its own process group; a caller that goes away loses only its own calls, "another caller's processes are untouched" (SHELL.md, "Every process has an owner") | Yes for what the host itself stops. A caller has no reason to reach for `pkill` to stop its own call: stopping a call is the host's, by owner |
| Nothing bounded the process once it ran | The OS sandbox is on by default and fails closed. The host's macOS profile is deny-by-default and allows `signal` and `process-info` only for a target in the same sandbox (`sandbox.rs` in window-ml-host, read at 7708d8d) | Yes, and this is the row that does not depend on anyone reading a card: inside the sandbox this `pkill` could neither list nor signal the browser, the editor or another lane's test run |
| The error output was thrown away (`2>/dev/null`) | Redirecting is a typed argument whose effect is seen, and stdout and stderr are kept by the host as values (SHELL.md, "One call") | Yes: the output exists whether or not the script looks at it |

The general statement: under a string shell the effect of a call is whatever the program makes of its arguments, known
only afterwards. Under `ml.sh` the call is a vector judged before it runs, its effect is either described or `unknown`,
and its reach is bounded by a sandbox that does not depend on the description being right. The incident needed the
third of these. A correct description would not have saved a person who approved it without reading; the sandbox would
have.

## 5. What it does not show

- It is one incident on one machine, from an agent harness that is not window.ml. It shows the failure exists and what
  it costs, not how often.
- No row above was tested by replaying this command through the process host. "Would it have held" is read from the
  specs and from the host's profile source. A row that replays it (an undescribed `pkill` asks; inside the sandbox it
  signals nothing outside its own group) is worth writing, and is not written.
- The Linux half is not read: whether bubblewrap's process namespace gives the same bound is not checked here.

## 6. What changed in how we work

- **Never `pkill`, `killall` or `kill` by pattern**, in a session or a subagent's brief. A run of your own is stopped by
  `node scripts/test-slot.mjs cancel <ticket>` or by the pid you started. Nobody touches another session's process.
- **No test run outside the queue**, however long the wait. A long wait is reported, not worked around.
- **A machine-wide failure is diagnosed from the system log first** (`/usr/bin/log show`, by its full path: `log` is a
  shell builtin in zsh and prints nothing useful), before anyone names a cause.
- The queue keeps one small repair of its own: when runs die by signal, the next pass must not refill every freed slot
  at once.
