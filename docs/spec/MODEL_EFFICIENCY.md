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

---

### 5. Refinement for Sparse & Heterogeneous Benchmark Matrices (`scores.mjs` / `rasch.mjs`)

The baseline ratios in Section 2 ($\frac{1}{|\mathcal{T}|}\sum \frac{v_i}{\tau_i}$ and $\frac{\sum v_i}{\sum R_i}$ for $R \in \{C, E\}$) assume a **complete, homogeneous design** where every model runs the exact same task set $\mathcal{T}$ and tasks share a common resource scale. On a real, evolving benchmark (`scores.sqlite`, where an item is `task#task_hash#shown`), two pathologies break the raw ratios:

1. **Incomplete-matrix confounding ($M \times \mathcal{T}$ is sparse):**
   If model $A$ only ran 1-step DOM extraction tasks ($\tau \approx 1.5\text{s}$, $C \approx \$0.001$) while model $B$ ran 8-step multi-page synthesis tasks ($\tau \approx 30\text{s}$, $C \approx \$0.05$), raw $\text{IPS}(A)$ and $\text{IPD}(A)$ exceed $B$'s by $20\times$–$50\times$ purely from item selection — the exact confounding `tests/e2e/bench/rasch.mjs` was written to remove from pass rates.
2. **Scale domination across heterogeneous tasks:**
   Even on a complete matrix, the harmonic-like sum $\frac{1}{|\mathcal{T}|}\sum_i \frac{v_i}{\tau_i}$ weights a trivial $0.5\text{s}$ task ($1/\tau = 2.0\text{ s}^{-1}$) **$40\times$** more heavily than a $20\text{s}$ synthesis task ($1/\tau = 0.05\text{ s}^{-1}$): a model that solves the trivial task in $0.4\text{s}$ and fails the hard task ($\text{IPS} = 1.25$) beats a model that takes $1.0\text{s}$ on the trivial task and solves the hard task in $20\text{s}$ ($\text{IPS} = 0.525$). Conversely, in ratios of sums $\frac{\sum v_i}{\sum R_i}$, a single expensive task dominates the denominator while every pass in the numerator contributes $+1$ regardless of difficulty $b_i$.

The bench's two existing estimators eliminate both defects without adding any new schema columns:

#### A. Capability at the Reference Task ($\hat{p}_m$)

`fitRasch` (`tests/e2e/bench/rasch.mjs`) separates model ability $\theta_m$ from item difficulty $b_i$ under $\mathbb{P}(v_{mi} = 1) = \sigma(\theta_m - b_i)$ and reports ability relative to the mean item difficulty $\bar{b} = \frac{1}{|\mathcal{T}|}\sum_{i \in \mathcal{T}} b_i$. Model $m$'s task-adjusted pass probability on the reference task is:

$$\hat{p}_m = \sigma(\theta_m - \bar{b})$$

#### B. Multiplicative Item Decomposition for Resources ($\beta^{(R)}_m$ and $\hat{R}_m$)

Resource expenditure $R_{mi} \in \{N^{\text{tok}}_{mi}, \tau^{\text{core}}_{mi}, \tau^{\text{client}}_{mi}, C_{mi}, E^{\text{active}}_{mi}\}$ scales multiplicatively with task length. Extending the geometric-mean within-item ratio already computed for tokens (`bloat` in `tests/e2e/bench/scores.mjs`) to every resource axis decomposes log-expenditure into a model factor and an item scale:

$$\log R_{mi} = \alpha_m + \gamma_i + \varepsilon_{mi}, \qquad \gamma_i = \operatorname{median}_{m' \in M_i} \log R_{m'i}$$

over items $i$ run by at least two models ($|M_i| \ge 2$). This yields:

1. **Dimensionless Resource Bloat ($\beta^{(R)}_m$):**
   $$\beta^{(R)}_m = \exp\left(\frac{1}{|I_m|} \sum_{i \in I_m} \bigl(\log R_{mi} - \gamma_i\bigr)\right)$$
   giving each model a scale-free multiplier on every axis (`×1.40 tok`, `×0.65 s`, `×2.10 $`, `×0.80 J` relative to the typical run of the same task), where a $0.5\text{s}$ task and a $30\text{s}$ task carry equal leverage.
2. **Reference Task Expenditure ($\hat{R}_m$):**
   Multiplying by the reference task's median scale $\bar{R}_{\text{ref}} = \exp\bigl(\frac{1}{|\mathcal{T}|}\sum_i \gamma_i\bigr)$ restores physical units ($\text{s}$, $\$$, $\text{J}$, $\text{tokens}$) conditioned on the reference task:
   $$\hat{R}_m = \beta^{(R)}_m \cdot \bar{R}_{\text{ref}}$$

#### C. Renewal-Reward Efficiency ($\widehat{\text{IPS}}, \widehat{\text{IPD}}, \widehat{\text{IPJ}}$)

When model $m$ attempts tasks of reference difficulty $\bar{b}$, each attempt $k$ succeeds with probability $\hat{p}_m = \sigma(\theta_m - \bar{b})$ and expends expected resource $\hat{R}_m$ across passing and failing attempts alike (failed runs still consume wall-clock time, API spend, and Joules). By the Elementary Renewal Theorem, the long-run rate of verified completions per unit of resource at the reference task is:

$$\widehat{\text{IPS}}(m) = \frac{\sigma(\theta_m - \bar{b})}{\hat{\tau}_m}, \qquad \widehat{\text{IPD}}(m) = \frac{\sigma(\theta_m - \bar{b})}{\hat{C}_m}, \qquad \widehat{\text{IPJ}}(m) = \frac{\sigma(\theta_m - \bar{b})}{\hat{E}_m}$$

* **Invariance:** Both numerator and denominator are conditioned on the reference task $\bar{b}$, removing subset-selection bias on sparse $M \times \mathcal{T}$ logs.
* **Two-sided penalty:** A model that fails fast ($v_{mi}=0$ in $0.2\text{s}$) is driven to $0$ by $\sigma(\theta_m - \bar{b})$ in the numerator; a model that passes by thrashing through $40{,}000$ tokens over $900\text{s}$ inflates $\beta^{(\tau)}_m, \beta^{(\$)}_m, \beta^{(\text{J})}_m$ in the denominator.

#### D. Budget-Censored Ability Curves ($\theta_m(\tau_{\max}), \theta_m(C_{\max}), \theta_m(E_{\max})$)

Rather than treating Section 4's operational regimes as separate ad-hoc tables, any hard resource budget $B_{\max}$ (latency horizon $\tau_{\max}$, cost cap $C_{\max}$, or energy cap $E_{\max}$) defines a **budget-censored verifier**:

$$v_{mi}(B_{\max}) = v_{mi} \cdot \mathbf{1}\{R_{mi} \le B_{\max}\}$$

Fitting `fitRasch` on $v_{mi}(\tau_{\max})$ yields a continuous **latency-bounded ability curve** $\theta_m(\tau_{\max})$:

* At $\tau_{\max} = 3.0\text{s}$, runs exceeding the interactive horizon are scored as failures ($v_{mi}(3\text{s}) = 0$), yielding the **Interactive Regime** ability $\theta_m(3\text{s})$.
* As $\tau_{\max} \to \infty$, $v_{mi}(\tau_{\max}) \to v_{mi}$, recovering the **Asymptotic / Batch** ability $\theta_m(\infty)$.
* Any crossing point $\theta_A(\tau^*) = \theta_B(\tau^*)$ identifies the exact latency deadline $\tau^*$ at which model routing should switch from model $A$ to model $B$.

