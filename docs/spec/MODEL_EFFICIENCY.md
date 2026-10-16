# Systems Specification: Constrained Operational Efficiency for Autoregressive Evaluators

**Status: decided; raw telemetry (`runs.passed`, `runs.secs`, `calls`/`snapshots`, `electricity.mjs`, `box.sqlite`) is already recorded in `scores.sqlite` and `box.sqlite`; joint efficiency projections on the scoreboard are to be built.**

### 1. The Core Pathology of Scalar Leaderboards

Current generalist LLM evaluation leaderboards (e.g., Artificial Analysis Intelligence Index) map a high-dimensional Pareto frontier down to a single scalar:

$$\text{Rank}(M) = f\left(\frac{1}{\vert{}\mathcal{T}\vert{}} \sum_{i \in \mathcal{T}} \text{Acc}(M, x_i)\right)$$

By removing temporal ($\tau$), spatial (network topology), and thermodynamic ($E$) constraints, this objective function implicitly assigns:

* Infinite utility to asymptotic test-time search depth ($\tau \to \infty$).
* Zero penalty to computational thrashing / scratchpad token inflation.
* Identical value to a zero-shot, low-latency deterministic emission and an unrolled $O(N)$ Monte Carlo rejection sampling pass taking $15$ minutes.

---

### 2. Formal Definitions: Operational Metrics

Let $\mathcal{T} = \{(x_i, v_i)\}_{i=1}^N$ be a task distribution where:

* $x_i$ is the prompt/specification.
* $v_i: \mathcal{Y} \to \{0, 1\}$ is a deterministic, automated verifier (unit tests pass, formal proof in Lean/Isabelle checks, typed AST matches target schema, numerical value falls within an explicit $\epsilon$-ball; in `tests/e2e/bench/scores.mjs`, the task's pass/fail predicate `runs.passed`).

Let $\tau(M, x_i)$ be the wall-clock **Actionable Latency** required for model $M$ to emit the terminal state $y_i$ such that $v_i(y_i) = 1$. If $v_i(y_i) = 0$ or execution times out, $\tau(M, x_i) = \infty$.

When comparing models across incomplete model$\times$task matrices (where models ran overlapping but non-identical subsets of $\mathcal{T}$), raw indicator sums $\sum v_i(y_i)$ may be weighted by the task's Rasch surprisal $I(i) = -\log_2 \sigma(\bar{\theta} - b_i)$ fitted by `tests/e2e/bench/rasch.mjs`, or evaluated per task against the cross-model median.

#### A. Intelligence Per Second (IPS)

The verified task-density generated per unit of wall-clock time:

$$\text{IPS}(M) = \frac{1}{\vert{}\mathcal{T}\vert{}} \sum_{i \in \mathcal{T}} \frac{v_i(y_i)}{\tau(M, x_i)}$$

* Units: $\text{Tasks} \cdot \text{s}^{-1}$
* **Penalty Dynamic:** A model that generates 40,000 scratchpad tokens over 900 seconds to solve a problem receives $\text{Score} = \frac{1}{900} \approx 0.0011$, whereas a high-density model solving it in 1.5 seconds receives $\text{Score} = \frac{1}{1.5} \approx 0.66$ (a **$600\times$ advantage** for high semantic representation density).

#### B. Capital Efficiency / Intelligence Per Dollar (IPD)

Let $C(M, x_i)$ be the total inference cost (prompt tokens, cache hits/misses, and generated reasoning tokens, recorded per call in `scores.sqlite` and priced via `tests/e2e/bench/spend.mjs` and `tests/e2e/bench/cost.mjs`):

$$\text{IPD}(M) = \frac{\sum_{i \in \mathcal{T}} v_i(y_i)}{\sum_{i \in \mathcal{T}} C(M, x_i)}$$

* Units: $\text{Tasks} \cdot \$^{-1}$
* Eliminates the provider incentive to inflate billable token diarrhea via circular self-reflection loops.

#### C. Thermodynamic Efficiency / Intelligence Per Joule (IPJ)

Let $E(M, x_i)$ be the integrated hardware energy dissipation above resting baseline $P_{\text{idle}}$, measured via hardware telemetry counters (NVML / ROCm energy registers or wall-plug power integration in `tests/e2e/bench/electricity.mjs` `aboveWh`) during the inference run:

$$\text{IPJ}(M) = \frac{\sum_{i \in \mathcal{T}} v_i(y_i)}{\sum_{i \in \mathcal{T}} \int_{0}^{\tau} \bigl(P_{\text{cluster}}(t) - P_{\text{idle}}\bigr) \, dt}$$

* Units: $\text{Tasks} \cdot \text{J}^{-1}$
* Establishes a Green500-equivalent standard for foundation models, directly exposing whether an architecture is computationally optimal or merely an overparameterized room heater.

#### D. Semantic Token Density (Bits per Token)

Let $I(i) = -\log_2 \sigma(\bar{\theta} - b_i)$ be the information content (in bits) of passing task $i$ under the Rasch model (`tests/e2e/bench/rasch.mjs`), and let $N_{\text{tokens}}(M, x_i)$ be the total tokens emitted across all steps of the run:

$$\rho(M, x_i) = \frac{v_i(y_i) \cdot I(i)}{N_{\text{tokens}}(M, x_i)}$$

* Units: $\text{bits} \cdot \text{token}^{-1}$
* Within a fixed task $i$, the cross-model relative density $\rho(M, x_i) / \operatorname{median}_{M'} \rho(M', x_i)$ on passing runs is the reciprocal of the token-bloat ratio (`1 / bloat.ratio` in `tests/e2e/bench/scores.mjs`).

---

### 3. Measurement Topology: Isolating Transport Slop

To prevent fiber routing, proxy queueing, and regional edge variance from corrupting inference evaluation, latency $\tau$ must be measured at two strictly decoupled observation planes:

```text
[ Client Node (Frankfurt / Tokyo / US-East) ]
                  │
                  ▼  <-- τ_client (Edge Latency: Includes routing, queue, TLS; runs.secs)
    [ API Gateway / Regional Proxy ]
                  │
                  ▼  <-- τ_core (Datacenter Latency: Pure Execution Floor; box.sqlite)
     [ Inference Engine Cluster ]
          ├── KV-Cache Allocation
          ├── Forward Pass Compute
          └── Verification Harness (ALU / REPL / AST Check)
```

1. **In-Cluster Core Latency ($\tau_{\text{core}}$):**

$$\tau_{\text{core}} = t_{\text{TTFT}} + \frac{N_{\text{tokens}}}{\text{Throughput}_{\text{decode}}}$$

Isolates execution efficiency, KV-cache paging, and parameter density (recorded from the server's own clock in `box.sqlite` via `tests/e2e/bench/box-stream.mjs`, excluding cold-model load and proxy queue spans).

2. **Edge Latency ($\tau_{\text{client}}$):**
Captures network overhead, connection pooling, and multi-region queuing reliability (recorded as `runs.secs` in `scores.sqlite`).

---

### 4. Classification: Operational Regimes

Models must be evaluated on distinct, non-conflated Pareto axes:

| Regime | Time Horizon ($\tau$) | Target Objective | Applicable Domains |
| --- | --- | --- | --- |
| **Interactive / Generalist** | $\tau \le 3.0\text{s}$ | $\max \text{IPS}$ under strict latency bounds | REPL loops, interactive user interfaces, real-time operating system harnesses, runtime verification |
| **Asymptotic / Batch** | $\tau \to \infty$ | $\max \sum v_i(y)$ with unbounded compute | Formal theorem verification, complex symbolic derivation, asynchronous vulnerability discovery |
