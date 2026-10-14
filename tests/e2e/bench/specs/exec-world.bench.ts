// exec-world.bench.ts — which world should `exec` run in by DEFAULT: the page's own (its globals reachable, and its
// tampering too) or an isolated one (the page cannot reach the code, and the code cannot reach the page's state)?
//
//   npm run build
//   EXEC_WORLD_MODELS=a,b,c USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/exec-world.bench.ts --dry
//   EXEC_WORLD_MODELS=a,b,c USE_ENV=1 node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/exec-world.bench.ts --jobs 2 --serve
//
// Asked for by the site-access work, which adds `exec`'s `world: "page" | "isolated"` and the build constant
// `__EXEC_DEFAULT_WORLD__` this spec sets (a stored setting overrides it; the forced-isolation policy always wins).
// WITHOUT THAT CHANGE BUILT IN, both arms are the same build and measure nothing.
//
// Past runs could not answer this: exec ran in 15–30% of the runs of the tasks that use it most, and none needed a page
// global. So three fixtures are built for it: two whose answer is reachable only from the page's world (a plain global,
// and a store's closure behind a page function), and one whose page lies to code in its own world. The controls are
// everyday tasks where the world should not matter. What a default costs is measured as success, exec calls, the
// page-global misses followed by a `world: "page"` retry (metrics.mjs `execWorld`), tokens, seconds and spend.
//
// A CONFOUND to report with any result: under the isolated default a world-less survey that reads the page is no longer
// answered by the read-only dialect (which runs only in the page's world) but goes to the approval gate (approve "auto"
// passes it) and runs as an approved exec in the isolated world. So the isolated arm also changes how surveys are
// approved: the `exec gated` column counts those per run, against the page arm's. And an isolated default with NO
// isolation available (no user scripts, no CDP) silently runs in the page's world, making the arms identical: check the
// pilot's isolated arm shows the `Page globals need world: "page".` hint on app-state before trusting a sweep.

import { defineBench } from "../spec";

/** The models, overridden by EXEC_WORLD_MODELS (comma-separated). Cloud models by default, cheap ones from weaker to stronger (about 1.3 USD for the sweep, 2026-10-14; mimo had no past run, so pilot it first): the box is asked for first. */
const MODELS = (process.env.EXEC_WORLD_MODELS || "deepseek.deepseek-flash,openrouter.openai/gpt-6-luna,openrouter.xiaomi/mimo-v2.6-pro").split(",").map((s) => s.trim()).filter(Boolean);

/** An answer with its digit grouping and currency marks taken out, for matching an exact number. */
const digits = (answer: string): string => answer.replace(/[\s,$€]|EUR/g, "");

/** Whether `n` (as written with two decimals) is in the answer as a whole number, not inside a longer one. */
const hasAmount = (answer: string, n: string): boolean => {
    const a = digits(answer);
    const bare = n.replace(/\.?0+$/, "");
    return new RegExp(`(^|[^\\d.])(${n.replace(".", "\\.")}|${bare.replace(".", "\\.")})(?![\\d]|\\.\\d)`).test(a);
};

/** Whether the run used a tool at all. */
const used = (steps: { tool?: string }[], tool: string): boolean => steps.some((s) => s.tool === tool);

/** The answers, from the fixtures themselves (tests/bench-exec-world.test.mjs runs each page and checks these). */
export const ANSWERS = {
    /** examples/exec-world-app-state.html: `window.__APP__.cart.total`. */
    appState: "520.69",
    /** examples/exec-world-store.html: the 12 active refunds in `window.store.getState()`. */
    store: "435.91",
    /** examples/exec-world-tampered.html: the ledger's true total, as the DOM holds it and a person sees it. */
    tampered: "1319.70",
    /** ...and what code in the page's world reads instead: each of the 8 amounts 13.00 higher. */
    tamperedLie: "1423.70",
};

/** Not in the regression suite: the world arms come from this spec's build constant, which the suite does not set. */
const NOT_SUITE = { included: false, reason: "measures the exec default world through this spec's build constant" };

export default defineBench({
    name: "exec-world",
    description: "Should exec run in the page's world or an isolated one by default? Page state, a page store, a tampering page, and controls.",
    repeats: 5,
    timeoutMs: 300000,
    approve: "auto",

    dimensions: {
        model: MODELS,
        world: ["page", "isolated"],
    },

    // Both arms set the constant, so neither depends on what the shipped default happens to be.
    apply: (combo) => ({
        backend: { model: combo.model },
        defines: { __EXEC_DEFAULT_WORLD__: JSON.stringify(combo.world) },
    }),

    tasks: [
        {
            // Needs the page's world: the prices and total exist only in `window.__APP__`.
            id: "app-state",
            regression: NOT_SUITE,
            start: "/exec-world-app-state",
            task: "This checkout page doesn't show the cart total yet, but the page's app already has it in memory. What is the cart total?",
            succeeded: ({ answer }) => hasAmount(answer, ANSWERS.appState),
        },
        {
            // Needs a page FUNCTION called in the page's world: the refunds are in a store's closure.
            id: "page-store",
            regression: NOT_SUITE,
            start: "/exec-world-store",
            task: "This support page keeps its refunds in a Redux-style store and does not render the list. What is the total amount of the active refunds?",
            succeeded: ({ answer }) => hasAmount(answer, ANSWERS.store),
        },
        {
            // Isolation should win: the page patches its own getters and JSON.stringify, so a page-world read is wrong.
            id: "tampered-ledger",
            regression: NOT_SUITE,
            start: "/exec-world-tampered",
            task: "What is the total of the Amount column in the expense ledger on this page?",
            succeeded: ({ answer }) => hasAmount(answer, ANSWERS.tampered) && !hasAmount(answer, ANSWERS.tamperedLie),
        },
        // --- controls: everyday tasks where the world should not matter (from prompt-budget-cuts2 and tool-use) ---
        {
            id: "shadow-reveal",
            regression: NOT_SUITE,
            start: "/shadow-dom",
            task: "Reveal and read the access code in the first panel on this page.",
            succeeded: ({ answer }) => /SHDW-7788/.test(answer),
        },
        {
            id: "table-north-q3",
            regression: NOT_SUITE,
            start: "/table",
            task: "Using the sales table on this page, what is the total Q3 sales for the North region?",
            python: true,
            succeeded: ({ answer }) => /\b285\b/.test(answer),
        },
        {
            id: "icon-heart",
            regression: NOT_SUITE,
            start: "/inaccessible-icons",
            task: "Click the heart icon in the toolbar, then tell me exactly what the status line under it says.",
            succeeded: ({ answer, steps }) => /Clicked:\s*heart/i.test(answer) && used(steps, "click"),
        },
    ],
});
