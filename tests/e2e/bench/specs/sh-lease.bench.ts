// sh-lease.bench.ts — what should `SH_LEASE_MS` be: how long an `ml.sh` call runs before it DETACHES into a task
// (docs/spec/ASYNC_CALLS.md mode 1, rule 1; #1437). Too short and every ordinary call spends a wake turn; too long and a
// stalled call is the silent hang again. The arms are the lease, built in per cell (`__SH_LEASE_MS__`, build.mjs).
//
//   docker run … wml-sh-lease (tests/e2e/docker/sh-lease.Dockerfile; its header has the flags bwrap needs)
//   SH_LEASE_MODELS=a,b USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/sh-lease.bench.ts --dry
//
// Three task scripts, each in its own fresh workspace with a stored workspace manifest so it runs without asking:
//   build  40 s, a progress line every 5 s, then its result line (detaches under the 5 s and 15 s leases);
//   hang   prints one line and never ends (the host kills it at its 120 s default unless the model cancels first);
//   quick  2 s (never detaches): the control, the common case the lease must not tax.
// The task text names the command and the answer wanted, and never mentions expectMs, leases or tasks, so how often a
// model gives an estimate before its first Detached is unprompted.
//
// SAFETY: every gate of these runs is ruled by `shLeaseDecide` (run-once.mjs `shell`): the run's own exec step is
// approved and everything else, every ml.sh ask included, is DENIED. ml.sh runs as the user and its host reads everything
// but credential stores; in the container that is the container's files. Local models only (the box) unless Shane says
// otherwise.
//
// What the build arm cannot measure: the host reports a call's output only when it is done (no `peek` yet), so the
// model never sees the build's progress lines while it runs. Re-run that arm after the host's peek slice.

import { defineBench } from "../spec";

/** The local models, overridden by SH_LEASE_MODELS (comma-separated): the box's default, one smaller, and qwen3.8-flash-next:vision (one of the larger that does well; Shane, 2026-11-07). */
const MODELS = (process.env.SH_LEASE_MODELS || "gemma4:31b,gemma4:e4b,qwen3.8-flash-next:vision").split(",").map((s) => s.trim()).filter(Boolean);

/** The result lines the scripts end with: a right answer reports its own. */
export const TOKENS = { build: "BUILD OK 7f3a19", quick: "CHECK OK c42e07" };

/** A workspace manifest for one task script: `bash <path>`, pinned by the host, reading nothing outside its root. It
 *  declares `runs-code` because the scripts start `sleep`: without it the worker sends `exec: program-only` and the host
 *  refuses every child program (the 2026-11-07 matrix: `sleep` denied, the 40 s build done in 5 ms, nothing detached).
 *  Under the sandbox `exec(process)` is inside the bound, so the call still runs without asking. */
const scriptManifest = (file: string) => ({ program: "bash", entrypoint: { path: file }, command: { effects: ["read", "runs-code"], paths: "operands", flags: {} } });

const BUILD_SH = [
    'echo "build: compiling 8 units"',
    ...Array.from({ length: 8 }, (_, i) => `sleep 5\necho "build: unit ${i + 1}/8 done"`),
    `echo "${TOKENS.build}"`,
].join("\n") + "\n";
const HANG_SH = 'echo "fetch: connecting to the data service"\nwhile true; do sleep 3600; done\n';
const QUICK_SH = `sleep 2\necho "${TOKENS.quick}"\n`;

/** Not in the regression suite: the lease arms come from this spec's build constant, and a real host is needed. */
const NOT_SUITE = { included: false, reason: "measures the ml.sh lease through this spec's build constant, against a real wmlhost" };

/** Whether an answer says the call stalled or was stopped, rather than reporting a result it never had. */
const saysStalled = (answer: string): boolean =>
    /\b(hang|hangs|hung|hanging|stall|stalled|stuck|never (finish|finished|complete|completed|end|ended|returned)|did ?n[o']t (finish|complete|end|return)|still running|cancel(l?ed)?|killed|timed? ?out)\b/i.test(answer);

export default defineBench({
    name: "sh-lease",
    description: "SH_LEASE_MS: 5, 15 or 60 s before an ml.sh call detaches, over a 40 s build, a hang and a 2 s call.",
    repeats: 5,
    timeoutMs: 300000,
    capture: "failure",

    dimensions: {
        model: MODELS,
        leaseMs: [5000, 15000, 60000],
    },

    // ml.sh exists only in a run the worker built, so every run starts from the HUD, as a person's does.
    apply: (combo) => ({
        backend: { model: combo.model },
        defines: { __SH_LEASE_MS__: String(combo.leaseMs) },
        surface: "hud",
    }),

    tasks: [
        {
            id: "build",
            regression: NOT_SUITE,
            task: "My project's build script is `build.sh` in the workspace. Run it with `bash build.sh` (ml.sh, from an exec) and tell me the last line it prints.",
            shell: { files: { "build.sh": BUILD_SH }, manifests: [scriptManifest("build.sh")] },
            succeeded: ({ answer }) => answer.includes(TOKENS.build),
        },
        {
            id: "hang",
            regression: NOT_SUITE,
            task: "There is a script `fetch.sh` in the workspace that pulls today's data. Run it with `bash fetch.sh` (ml.sh, from an exec) and tell me what it printed.",
            shell: { files: { "fetch.sh": HANG_SH }, manifests: [scriptManifest("fetch.sh")] },
            // Above the 60 s lease plus the host's 120 s kill, with room for the turns around them.
            timeoutMs: 420000,
            succeeded: ({ answer }) => saysStalled(answer),
        },
        {
            id: "quick",
            regression: NOT_SUITE,
            task: "Run the workspace's check script with `bash check.sh` (ml.sh, from an exec) and tell me the line it prints.",
            shell: { files: { "check.sh": QUICK_SH }, manifests: [scriptManifest("check.sh")] },
            timeoutMs: 180000,
            succeeded: ({ answer }) => answer.includes(TOKENS.quick),
        },
    ],
});
