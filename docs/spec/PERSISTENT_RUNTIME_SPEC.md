# Spec: persistent runtime state — the agent as an interactive programmer, not a stateless RPC caller

Status: JS half **shipped** (`ml.state` + `state` in `exec`, commit 4e0173d).
Python half **designed here, not built**. Auto-approve of pure-compute writes is a
later, separate chunk.

## The idea

Most agent frameworks (LangChain, CrewAI, tool-calling pipelines) treat tool calls
as **stateless RPC**: inputs in, outputs out, environment reset. To reuse logic the
model re-emits the whole code block or shells a scratch file — clunky, token-heavy.

`window.ml` runs the agent **inside a live runtime** (the page's JS heap; via Pyodide,
a Python kernel). So it can build reusable functions/results once and invoke them on
later turns — the **Jupyter/REPL paradigm**. This collapses a 20-step natural-language
plan into "define a helper on turn 1, call it turns 2–10," which shortens the effective
horizon (less autoregressive drift) and keeps intermediate data (DOM nodes, DataFrames)
in the heap instead of round-tripping 100KB of JSON through the context window every turn.

This isn't deep — it just *falls out* of gluing the agent directly into an execution
environment, which the "REST/microservice" mental model of most framework authors
never does. But two things make it actually *work* rather than merely exist, and both
are load-bearing:

## The two things that make it work (and why naïve persistence fails)

### 1. Reflection / a scope manifest — the price of admission, NOT a nicety

Stateless tool-calling keeps the model's state **in context** (the transcript IS the
state). A persistent REPL moves state **out of context, into the heap** — so the agent
is now programming against a world it can't see (**context-blindness**).

The Jupyter-fluency argument ("models are trained on notebooks") *cuts both ways*:
notebooks in the training corpus are **linear and fully visible** — every prior cell is
on screen. A hidden heap is the opposite of that distribution. So the fluency benefit is
**conditional on visibility**: persistence *without* a manifest gives the token savings
and forfeits the fluency.

**Design:** after a `persist`-mode call, append a compact manifest of the run's namespace
— **names + types/shapes, never values** (values re-bloat the context you just saved):

```
[scope: parse_table(), df_raw(DataFrame 1200×8), cleaned(list[str], 340)]
```

For JS, the same is available on demand (`Object.keys(state)`), so the model pulls it when
it needs orientation rather than paying for it every turn — arguably better than
always-append. Python's persist result should append it automatically (the model can't
`dir()` cheaply mid-turn without another call).

### 2. The approval gate — the tension Voyager/Code-as-Policies never had

Those systems have **no human in the loop**. We do: `exec`/`python_exec` are
`requiresApproval`. So "define a helper on turn 2, call it turns 3–10" means the human
approves that helper's invocation **ten times** — the re-approval tax eats the macro-reuse
win that is the whole point.

**Design (later, separate):** extend the readonly-interpreter idea from "reads" to
"pure-compute writes to the scratchpad." A mutation that touches ONLY `state` / pure
compute (no DOM, no network, no fs) is safe to auto-approve, so building and calling a
pure micro-DSL is friction-free; a helper that reaches into the DOM/network still gates
every call. This is the real unlock and its own body of work — track separately.

## The JS/Python asymmetry (deliberate — don't force them to match)

- **JS `window` is singular.** `resumeAgent(hash)` revives runs at any time, so there's
  no clean per-run teardown point. → a **single page-global** `ml.state` / `state`, shared
  across runs, never auto-cleared. Honest, and already shipped.
- **Pyodide globals are just a dict you pass in** (`runPythonAsync(code, {globals})`). So
  Python can trivially hold a **`Map<runHash, globalsDict>`** — per-run namespaces, no
  cross-run pollution, *and* still never auto-cleared (same honesty: resume reuses the
  run's dict). Python is the EASIER one to isolate, the opposite of the usual intuition.

So the two runtimes diverge on purpose: **JS = one shared page kernel; Python = per-run
kernel.**

## Python design (`python_exec` gains `env`)

```jsonc
"env": { "type": "string", "enum": ["persist", "isolated"],
         "description": "'persist' keeps variables/functions across this run's turns; 'isolated' runs in a clean scope (today's behavior)." }
```

Under the hood, in the worker (`python-worker.ts` / `python-runtime.ts`):

- A `Map<runHash, PyProxy /* globals dict */>` at worker scope, page/worker-lifetime.
- **`persist`**: run in `globals = namespaces.get(runHash) ??= freshNamespace()`. The
  per-run prelude (img/df/tables preload) still applies, but user-defined names survive
  between calls. Append the scope manifest to the result.
- **`isolated`**: today's path — a throwaway namespace, destroyed after the call (the
  current per-run reset). This stays the default for a one-off computation.
- `runHash` must reach the worker: thread it through `PY_RUN` (offscreen relay →
  worker), alongside the existing payload. The background agent already knows the runId.
- **Never auto-clear** a persist namespace (resume revives it). Bound growth only if it
  becomes a problem (LRU by run, evict the least-recently-used dict) — not v1.
- Interaction with the RESET invariant: the current design wipes non-`_` globals each
  call for isolation. `persist` mode **skips that wipe** for its run's namespace; the
  `harden`/`unharden` (readonly network-nulling) still applies per call regardless.

## Sequencing

1. **JS `state`** — shipped (4e0173d).
2. **Python `env: persist|isolated`** — per-run namespace + the scope manifest. The manifest
   is not optional; it's what makes persist match the model's priors.
3. **Auto-approve pure-`state`/compute mutations** — the friction unlock; extends
   `readonly-exec.ts`'s mediation. Separate, larger.

## Why the "glue squad" backed away

Enterprise framework authors optimize for statelessness/microservices — persistent global
state reads as a code smell, so they default to isolated stateless calls. The ones who *did*
stumble into statefulness hit exactly the two problems above (context-blindness without a
manifest; state-poisoning without reflection) and quietly retreated, because they didn't also
build reflection + a re-approval story. The primitive is a free lunch only if you pay for
those two — which is the actual content of this spec.
