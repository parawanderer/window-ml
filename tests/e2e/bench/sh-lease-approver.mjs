// sh-lease-approver.mjs — the ONE approval rule of every ml.sh bench run: approve the run's own exec step and nothing
// else. ml.sh runs as the person's user and its host reads everything but credential stores, so an unattended yes to an
// ml.sh ask would hand the model any file the user can read; only a call the built-in default lets run without asking
// (inside the temp workspace) may run. A UI-started run carries the person's kit, so this rule, not the tool set, is
// what keeps python_exec (in any mode) and every other gated tool from running.

/**
 * Whether the bench approves one gate from `__mlApprovals.list()`: only an `exec` step's own gate, never a nested ask
 * raised under a running step (`askId`, which every ml.sh ask carries as `tool: "sh"`), never any other tool.
 * @param {{ tool?: unknown, askId?: unknown }} gate
 * @returns {boolean}
 */
export function shLeaseDecide(gate) {
    return gate?.tool === "exec" && (gate.askId === undefined || gate.askId === null);
}
