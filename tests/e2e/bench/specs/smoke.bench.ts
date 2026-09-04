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

import { defineBench } from "../spec";

/** Echo the previous tool result back verbatim — a model retyping data it was already given. */
const echoLastToolResult = (req: { messages?: { role?: string; content?: unknown }[] }) => {
    const tools = (req.messages || []).filter((m) => m.role === "tool");
    const last = tools.length ? String(tools[tools.length - 1].content ?? "") : "";
    return { content: `Here is what I found: ${last}` };
};


/** Read the sales table into the console as CSV — a long, citable output for the next step to reuse. */
const DUMP_CSV = `const rows = [...document.querySelectorAll('#sales tr')]
  .map(r => [...r.querySelectorAll('td,th')].map(c => c.innerText.trim()).join(','));
console.log(rows.join('\\n'));
return rows.length;`;

/**
 * Retype the previous tool result in a DIFFERENT SHAPE: the CSV it returned becomes the JS array literal
 * a model writes into `exec`. Every value carries over and not one 40-character window survives, which is
 * exactly how a real model re-emits and exactly what a verbatim scan cannot see.
 */
const retypeReformatted = (req: { messages?: { role?: string; content?: unknown }[] }) => {
    const tools = (req.messages || []).filter((m) => m.role === "tool");
    const last = tools.length ? String(tools[tools.length - 1].content ?? "") : "";
    const rows = last.split("\n").map((l) => l.trim()).filter((l) => l.includes(","))
        .map((l) => l.split(",").map((c) => c.trim()));
    const lit = rows
        .map((r) => "  [" + r.map((c) => (/^-?\d+(\.\d+)?$/.test(c) ? c : JSON.stringify(c))).join(", ") + "],")
        .join("\n");
    return { tool: "exec", args: { js: `const rows = [\n${lit}\n];\nreturn rows.length;` } };
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
            // The re-emitter above retypes VERBATIM, which any substring scan catches — and that is why
            // this gate stayed green while `reEmission` was blind to every real retype. A model asked to
            // compute over a captured table rewrites it into a literal for `exec`: `Ada,North,120,150`
            // becomes `["Ada", "North", 120, 150],`. Same values, no surviving window.
            //
            // Measured on a real gemma4:31b run that retyped twelve rows: 0.00. Both arms of an A/B would
            // have scored nothing and the sweep would have concluded "no difference" from an instrument
            // measuring nothing. So the calibration has to reproduce the SHAPE of the failure, not only
            // its presence.
            id: "reformatter",
            start: "/spreadsheet",
            task: "Read the sales table, then compute over the rows.",
            tools: ["exec", "answer"],
            script: [
                { tool: "exec", args: { js: DUMP_CSV } },
                retypeReformatted,
                { content: "Counted the rows." },
            ],
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
