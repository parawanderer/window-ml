// propose-manifest-tool.ts — the `propose_manifest` tool: the model asks the person to store a program manifest it drafted.

// It never stores one itself. The call is always gated; the worker resolves the draft through the host, pins it, and
// leads the card with how the draft reads this run's own calls (sw-manifest-proposal.ts); it is stored, and its evidence
// run made, only when the person approves (sw-run-host.ts, the gate's resolve). By the time this tool's own `run` is
// reached, the decision is made: it only reports it. Offered to a run the WORKER built, with ml.sh set up
// (sw-run-start.ts); a page's start never carries it.

import type { MlTool } from "../contract/contract-agent";
import type { defineTool } from "../ml/ml-tool-factories";

/** What the tool needs of the worker. Absent: the descriptor alone, whose run refuses (only the worker runs it). */
export interface ProposeManifestDeps {
    /** What became of the person's answer: what was stored and measured, or undefined when they did not approve it. */
    outcome(args: Record<string, unknown>): Promise<string | undefined>;
}

/**
 * Build `propose_manifest`.
 * @param define the tool factory
 * @param deps the worker's outcome; absent for the descriptor a run's assembly lists
 * @returns the tool, always gated
 */
export function proposeManifestTool(define: typeof defineTool, deps?: ProposeManifestDeps): MlTool {
    return define({
        name: "propose_manifest",
        summary: "Asks the person to store a program manifest you drafted, so ml.sh can describe that program's calls.",
        description: "Ask the person to store a manifest for a program ml.sh has none for (a CLI on PATH, or a script of this repository), " +
            "drafted from its --help or its source, so its read-only calls can run without a card. " +
            "The host pins it to the program file as it is now. They see it with how it reads this run's own calls of that program. " +
            "Once approved it applies under the OS sandbox only, until those calls re-run cleanly under it.",
        parameters: {
            type: "object",
            properties: {
                manifest: {
                    type: "object",
                    description: "A program manifest: {program, version: {range, args, pattern} for a binary (range \"*\" when it reports none), " +
                        "or entrypoint: {path} for a script (path relative to the workspace root; its sha256 is filled in), command: {effects, paths, flags}}.",
                },
                scope: { type: "string", enum: ["global", "workspace"], description: "global for a tool on PATH; workspace for one of this repository (forced for a script)." },
            },
            required: ["manifest", "scope"],
        },
        requiresApproval: true,
        run: async (args: Record<string, unknown>) => {
            if (!deps) return "Error: propose_manifest runs only in a run the extension started for you.";
            return (await deps.outcome(args)) ?? "Not stored: the person did not approve it. Its calls still ask.";
        },
    });
}
