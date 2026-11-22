# Spec: persistent runtime state — the agent as an interactive programmer, not a stateless RPC caller

Status: JS half **shipped** (`ml.state` + `state` in `exec`, commit 4e0173d).
Python half **built, to a later design than the one written here**: a worker-hosted
run's cells share one namespace (root C, #757 b38b2574), kept across the run's turns
(#1777 a079dfa6), with no `env` parameter and no `mode` ("Python design", below).
Auto-approve of pure-compute writes is a later, separate chunk.

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

**Design:** after a call in a persistent namespace, append a compact manifest of the run's namespace
— **names + types/shapes, never values** (values re-bloat the context you just saved):

```
[scope: parse_table(), df_raw(DataFrame 1200×8), cleaned(list[str], 340)]
```

For JS, the same is available on demand (`Object.keys(state)`), so the model pulls it when
it needs orientation rather than paying for it every turn — arguably better than
always-append. Python's persist result should append it automatically (the model can't
`dir()` cheaply mid-turn without another call).

**Decided, and what is built.** Shane, 2026-11-22: the names and types are given on request, never appended to
every result. Built: the names and types are kept as the scope manifest (state `python.run-namespace`,
`src/offscreen.ts`), read by the state inspector; no `ml.current` path reaches it. Appending it to each
`python_exec` result is NOT built, and the decision above means it will not be; the on-request read, a Python
`ml.names()` ([`ML_WIRE.md`](ML_WIRE.md)), is planned.

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

**Reconciled with "one namespace" (2026-10-15).** [`SHELL.md`](SHELL.md) says the model knows ONE namespace
reachable in two languages. Both hold: the run's namespace, as the worker sees it, is a map from name to
HANDLE, each pointing at where its value lives (the page heap for `ml.state`, the Pyodide heap, the process
host), and reading a value from the other language is a dereference, by copy or as a pointer. Where values
live stays asymmetric as above; what the model sees is one namespace. The Python half below is superseded in
two places by [`PYTHON_DIALECT.md`](PYTHON_DIALECT.md): there is no `env` parameter (the namespace always
persists per run, and a reset is TOLD to the run), and there is no `mode` (dialect membership decides, as for
JS `exec`). The scope manifest and the sequencing stand.

## Python design: retired, and what was built instead

RETIRED: the `env: "persist" | "isolated"` parameter this section specified (never built;
superseded 2026-10-15) and `python_exec`'s `mode` (removed 2026-10-19, #820 c715b9f1), both by
[`PYTHON_DIALECT.md`](PYTHON_DIALECT.md), "Membership replaces `mode`" and "The namespace".
As built, a worker-hosted run's cells always share one namespace, by run id; a page's
`ml.pythonExec` and a page-hosted agent's `python_exec` stay stateless. A lost namespace
is told (`namespace reset at <time>: <reason>`), and the names and types are kept as the
scope manifest (`src/offscreen.ts`, state `python.run-namespace`), read by the state inspector only; the
manifest is NOT appended to each result (decided 2026-11-22, section 1), and the on-request read is planned.
The tool's parameters on main are `code`, `image`, `cast`, `verify`, `margin`, `tables`, `tableRaw`, the output-cap
and retry parameters, and in a worker-hosted run `keep` and `expect_ms`
(`src/python/python-tool.ts`). How it works: [`docs/dev/python-sandbox.md`](../dev/python-sandbox.md),
"A run's namespace (root C)".

## Sequencing

1. **JS `state`** — shipped (4e0173d).
2. **Python per-run namespace** + the scope manifest, built without `env` (above). The manifest
   is not optional; it's what makes persist match the model's priors. Built: the namespace, and the manifest
   as state `python.run-namespace`; not built, and decided against: appending it to every result (the
   manifest is given on request, section 1).
3. **Auto-approve pure-`state`/compute mutations** — the friction unlock; extends
   `readonly-exec.ts`'s mediation. Separate, larger.

## Why the "glue squad" backed away

Enterprise framework authors optimize for statelessness/microservices — persistent global
state reads as a code smell, so they default to isolated stateless calls. The ones who *did*
stumble into statefulness hit exactly the two problems above (context-blindness without a
manifest; state-poisoning without reflection) and quietly retreated, because they didn't also
build reflection + a re-approval story. The primitive is a free lunch only if you pay for
those two — which is the actual content of this spec.
