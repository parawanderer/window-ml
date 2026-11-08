**Keep `SH_LEASE_MS` at 15 s.**
- **Correctness:** over 135 runs, no lease moved any model's correct rate beyond the noise of 5 repeats. gemma4:31b
  and qwen3.8-flash-next:vision were 5/5 on build and quick at every lease.
- **5 s costs turns:** it spent 2.0 task turns per detached 40 s build, against 1.5 at 15 s, and 3.2 per hang against
  2.4.
- **60 s catches nothing more:** it left a stall silent four times as long, and models noticed fewer stalls before the
  host's 120 s kill: 8 of 10, 8 of 9 and 5 of 7 hang runs that reached the host, at 5, 15 and 60 s.

**Time.**
- **Measured:** 1.9 h of wall time and 0.6 h of GPU time (the sum of `genMs`), against the 4.5–7.5 h estimate.
- **Why it was faster:** the estimate assumed every hang ran to the 120 s kill. Models answered or cancelled sooner
  (median 55–65 s per hang run). gemma4:e4b ended most cells within seconds without reaching the host (32 of its 45
  runs), and the quick arm takes about 13 s a run.

**Findings beyond the default.**
- **Unprompted estimates undershoot.** Only qwen3.8 often gave `expectMs` before a `Detached`.
  - 13 runs of the 40 s build gave `expectMs` before their first `Detached`. The first estimate ranged from 1 s to
    60 s, with a median of 20 s. In 12 of the 13, a call or an `await` ran past an estimate the model gave. The
    exception (qwen3.8, 5 s lease, repeat 4) did not detach.
  - Because the one deadline is `expectMs ?? SH_LEASE_MS`, a model's short estimate replaces the lease. That is why
    the 40 s build still detached in 44% of runs under the 60 s lease.
  - So the lease protects only calls with no estimate. The `Detached` message, not the default, is what has to carry
    a model through an underestimate. On the evidence here it does: those runs still answered right.
- **The namespace clause did not fix gemma4:e4b.** On #1437 `859cd023`, 12 of its runs still called `ml.sh('…')` as
  a function, and 20 more never reached the host in some other way. It is the only model whose failures are about
  finding `ml.sh` and not about the lease.
- **gemma4:31b rarely estimates.** It gave no `expectMs` before a `Detached` on any build under the 5 s lease, so it
  pays the full lease cost in task turns (2.6 per build at 5 s, 1.0 at 15 s).

**Negative results and limits.**
- **The quick arm does not separate 5 s from 15 s.** A 2 s call is under both, and none detached at any lease. The
  case where 5 s would tax ordinary work, a 5–15 s call such as a test run or `git fetch`, was not measured.
- **The build arm cannot measure progress.** The host has no `peek` yet, so `task tail` reports nothing while a call
  runs, and models tailed and got nothing.
- **The first matrix was invalid.** On image `18a812eb`, the scripts' `sleep` was refused by the sandbox, as shown at
  the end.
- **Four denied gates,** all qwen3.8: `ml.sh` probes outside the free tier, which the bench's approver denied by
  design. They are not a lease effect.
