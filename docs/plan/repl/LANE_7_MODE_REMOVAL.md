# Lane 7: remove `python_exec`'s `mode` (Sonnet)

Read first: [`ROUND_3.md`](ROUND_3.md); `docs/spec/PYTHON_DIALECT.md`, "Membership replaces `mode`" and "The
namespace"; `docs/dev/python-sandbox.md`; `docs/dev/policies.md`; `docs/dev/prompt-review.md` (the tool's text is
what the model reads). Its two dependencies are merged: `ml` reachable from Python (lane 1, #757) and root H (#749).

## The goal

`mode: "readonly" | "full"` goes away. The spec says what replaces it: a cell inside the dialect runs with no card; a
cell outside it goes to the person and runs as full Python with the gated `ml` callback in a worker that is still
hardened. Nothing the removal takes away has a use a gated `ml` does not cover.

## Where `mode` lives today

`node scripts/index.mjs 'mode' --kind` and a grep for `"readonly" | "full"` find it; on 2026-10-19 that was the
contract (`src/contract.ts`, `src/contract/contract-messages.ts`), the worker (`src/sw/sw-python.ts`,
`src/sw/sw-run-host.ts`, `src/sw/worker-tools.ts`, `src/sw/grant-extract.ts`), the tool and the Pyodide worker
(`src/python/python-tool.ts`, `src/python/python-worker.ts`), auto-approval (`src/agent/auto-approve.ts`), and the
sidebar (`src/sidebar/card/card-approval.tsx`, `src/sidebar/store.ts`, `src/sidebar/vram-bench.tsx`).

## The rules that bite here

- **Test the UPGRADE** (AGENTS.md): a stored policy, a saved session, a config or a bench result that names `mode`
  meets the new code. A fixture of what the old code wrote, read by the new code, asserting what the person sees.
  `grant-extract.ts` is where a stored grant is read; start there.
- **Narrow beats wide**: the removal must not let a cell that asked yesterday run without asking today. The measure is
  the policy vectors and the Python genre; add a vector for each old `full` case and assert it still asks.
- **The prompt budget**: the tool's description changes; `docs/spec/PROMPT_BUDGET.md` and the prompt-review doc say
  how a change to model-facing text is checked. Never pad it.
- The card: `card-approval.tsx` shows a mode today; what it shows instead is the dialect's verdict (inside, or the
  reason it fell out). Lane 9 is in the card and the run log too; message it before editing either.

## Not this lane

No dialect change, no vector change beyond the upgrade fixtures, nothing in `src/python/` beyond deleting the mode
switch (lane 5 and 6 are there; message them first). If a reading of the spec would let more run unasked, that is
the coordinator's, not yours: mail `repl-specs` with the two readings and continue on the narrower.

## Who reviews

The generalist for the worker side; lane 4 for the card and anything near nested asks.
