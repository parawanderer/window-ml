// smoke.bench.ts — the bench proving itself against the scripted fake-LLM.
//
//   node --import tsx tests/e2e/bench/run.mjs tests/e2e/bench/specs/smoke.bench.ts --repeats 1
//
// Deterministic and GPU-free: it exercises the whole pipeline — matrix expansion, repeats, the cache, the
// metric extractors, the seed mechanism, both sinks — on a backend whose behaviour is decided in advance.
// So a wrong number here is the BENCH's bug, not a model's, which is the only way to know the instrument
// works before spending hours of GPU time with it. Run it after touching anything under bench/.
//
// The three scripted tasks are the calibration: one deliberately re-emits, one deliberately cites instead,
// and one deliberately puts the re-emission in a SEEDED turn that must not be charged to the measured one.
// Their expected readings are asserted in tests/e2e/bench-selftest.spec.mjs.

import { defineBench } from "../spec.ts";

/** Echo the previous tool result back verbatim — a model retyping data it was already given. */
const echoLastToolResult = (req: { messages?: { role?: string; content?: unknown }[] }) => {
    const tools = (req.messages || []).filter((m) => m.role === "tool");
    const last = tools.length ? String(tools[tools.length - 1].content ?? "") : "";
    return { content: `Here is what I found: ${last}` };
};

export default defineBench({
    name: "smoke",
    description: "The bench driving itself against the fake-LLM, to check the instrument rather than a model.",
    repeats: 1,
    timeoutMs: 60000,

    dimensions: {
        // Two levels that genuinely change the run without needing a real model: pointers on and off.
        toolTokens: [false, true],
    },

    apply: (combo) => ({ toolTokens: combo.toolTokens }),

    tasks: [
        {
            id: "read-code",
            start: "/step3",
            task: "What code is shown on this page? Use findByText to locate it, then answer with just the code.",
            tools: ["findByText", "answer"],
            script: [
                { tool: "findByText", args: { text: "CROSSPAGE" } },
                (req: { messages?: { content?: unknown }[] }) => {
                    const seen = (req.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join(" ");
                    const m = seen.match(/CROSSPAGE-\d+/);
                    return { content: m ? `The code is ${m[0]}.` : "I couldn't find a code on this page." };
                },
            ],
            // A correct run always contains the page's own code. A predicate this strict is the point: it
            // fails loudly if the harness ever stops actually reaching the page.
            succeeded: ({ answer }) => /CROSSPAGE-\d+/.test(answer),
        },
        {
            id: "re-emitter",
            start: "/step3",
            task: "Find the code on this page and report it.",
            tools: ["findByText", "answer"],
            // Retypes the whole tool result into its answer → re-emission must read 1.00.
            script: [{ tool: "findByText", args: { text: "CROSSPAGE" } }, echoLastToolResult],
            succeeded: ({ answer }) => /CROSSPAGE-\d+/.test(answer),
        },
        {
            id: "citer",
            start: "/step3",
            task: "Find the code on this page and cite it.",
            tools: ["findByText", "answer"],
            toolTokens: true,
            // References the output instead of retyping it → re-emission must read 0.00 even though the
            // same data was in hand. The pair with re-emitter is what shows the metric measures behaviour
            // and not merely "did a tool return something long".
            script: [{ tool: "findByText", args: { text: "CROSSPAGE" } }, { content: "The code is in the element I located above." }],
        },
        {
            id: "seeded",
            start: "/step3",
            task: "Now summarise, without repeating the raw output.",
            tools: ["findByText", "answer"],
            // Turn 1 (scripted, never scored) does the re-emitting. If the seed boundary were wrong, that
            // re-emission would be charged to the measured turn and this cell would read 1.00 instead of 0.
            seed: {
                task: "Find the code on this page and report it.",
                script: [{ tool: "findByText", args: { text: "CROSSPAGE" } }, echoLastToolResult],
            },
            script: [{ content: "Done — the code was located above." }],
        },
    ],
});
