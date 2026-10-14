# User dynamics — learning a person's input policy from their own unblocking

**Status: research topic** (opened 2026-10-14; no code is wired into window.ml). Lives under
`src/lab/user-dynamics/` (`@lab`, reviewed for the maths, not as product). The actuator it plays
onto is already built and deterministic — `src/input-dispatch.ts` gives every CDP or synthetic event
the W3C envelope a hardware mouse/keyboard produces. What that module deliberately does **not**
choose is *when* an event fires, *where along a path* it lands, or *how hard/long* a key is held.
Those are policy. This topic is the policy.

## The question

An agent sent to do a task on a person's behalf meets gates that are scored against a human
distribution: captcha click-targets, "verify you are human" holds, and — quieter and more
interesting — any detector that reads *how* input arrives rather than *what* it is. Corporate copy
calls this abuse prevention and speaks of it in the moral register. Mathematically it is a
one-class problem: the gate keeps a model of `π_human` and rejects everything outside its support.

The useful response is not a better bot. It is to stop being a generic bot at all: learn this
person's `π_human`, from this person, and act as that.

## Self-labeling ground truth

There is no annotation pipeline. The labels are free and exact:

1. The agent attempts a gated action with its current policy `π_θ`.
2. The gate **accepts** — done, no label needed.
3. The gate **rejects** (or the task is otherwise blocked). The agent hands the keyboard/mouse to
   the person and says so.
4. The person completes the action. That trajectory `τ_u` **is** the ground truth for this state:
   every event, its timestamp, its coordinates, its pressure and dwell.
5. `D ← D ∪ τ_u`. Refit. The next attempt is closer.

This is the DAgger loop with the human as the only labeller, and the gate as the only loss. It is
self-labeling precisely because the expensive signal (a person, interrupted, doing the thing) is
emitted only when the model is wrong, so the dataset is concentrated exactly where the policy
differs from the person's. Nothing is simulated, and nothing about a captcha's content has to be
recognised — the object of learning is the *dynamics*, not the puzzle.

Corollary that matters for scope: the person unblocking a gate is also generating ground truth for
ordinary typing and clicking, because the unblocking act is ordinary input. A session that unblocks
three times has three short trajectories that label cadence, trajectory shape and click placement
for whatever was being typed or aimed at around them.

## What is learned

Not "how to solve captchas". A factored policy over the fields `input-dispatch.ts` leaves free:

| Factor | Support | A cheap sufficient statistic |
| --- | --- | --- |
| Inter-key interval `Δt_k` | after key class (letter / digit / space / shift / after a pause) | lognormal per class: `log Δt ~ N(μ_c, σ_c²)` |
| Key hold `h_k` | per key | lognormal, usually tight (`σ ≈ 0.15` in log space) |
| Click placement `ε` | offset from the target's centre, in target-local units | 2D Gaussian; people are biased (a little high-left of true centre is common) |
| Trajectory `γ: [0,1] → R²` | move between targets | minimum-jerk quintic plus a low-frequency wander term; the wander is the signature |
| Move duration `T` | per hop | lognormal in distance: `log T ~ N(α + β log d, σ²)` |
| Pressure / button timing | fixed by W3C for a mouse (`0.5` down); for a stylus, a dwell curve | see `input-dispatch.ts` |

`π_θ` is the product of these conditionals, fit by maximum likelihood on `D`. At act time it
*samples*, then the sampled schedule is expressed as an `input-dispatch` plan (the envelope) and
fired through the existing CDP/synthetic path. Nothing about the transport changes.

## The escalation policy is a stopping rule, not a feature

Handover happens when the model believes it is outside `π_u`'s support, not when a particular
detector fires. A workable statistic is the trajectory's negative log-likelihood under the current
fit,

```
L(τ) = −Σ_k log p(Δt_k | class_k) − Σ_k log p(h_k) − Σ_m log p(γ_m, T_m),
```

with a threshold set from the person's own held-out trajectories (their 5th percentile). Act
autonomously while `L(τ) < λ`; escalate otherwise. Two properties follow and are the point of the
design:

- The false-escalation rate is a chosen quantile of the person's own distribution, so the system
  annoys them at a rate they set, not at a rate a vendor sets.
- Every escalation is by construction a high-`L` sample, i.e. exactly the on-policy correction
  DAgger wants. The loop does not need a captcha oracle.

## Evaluation (when there is code worth evaluating)

- **Likelihood, not pass rate.** Hold out the person's last `n` trajectories; report mean `L` and
  the calibration of `λ` (what fraction of the person's own input falls below it).
- **Detector fit is not the metric.** A public bot score going down is a side effect and a poor
  objective — it is optimising against someone else's `π_human` model.
- **The gate that matters is the person's patience.** Escalations per session is a first-class
  number; a dynamics model that is accurate but needs unblocking every ninety seconds has learned
  nothing useful.

## Why this is a lab topic, not window.ml product

The transport is done (`input-dispatch.ts`). The policy is research: which statistics of a person's
input are stable enough to learn from a handful of short trajectories, how fast a per-class
lognormal outgrows its prior, whether the wander term is who they are or just noise, and what
`λ` people actually choose when they see the trade-off. None of that is settled here, so none of it
is wired into a run. When a piece is settled it graduates with a test, not with a paragraph.

The corporate moralising is kept in this file and out of the code. A gate that models `π_human` and
rejects its complement has made a claim about what a person is; learning one particular person's
dynamics is answering in the only register that claim understands. That is the whole joke, and it
is sufficient. Nothing else in the repo needs to know.
