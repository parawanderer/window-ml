// python-install-tool.ts — the `python_install` tool: the model asks for a PyPI package in python_exec's sandbox, and the person approves the exact files it would install.

// docs/plan/repl/PACKAGES_INSTALL.md. It never installs anything itself. The call is always gated: the worker decides
// the verdict before anything is downloaded and shows every file of the closure with its sha256 on the card
// (sw-pkg-install.ts, sw-run-host.ts); the answer is approved only when the rows it carries are the rows the card
// showed. By the time this tool's own `run` is reached, the decision is made: it only reports it. Offered to no run
// until the install step exists (`OFFER_PYTHON_INSTALL`, sw-run-start.ts).

import type { MlTool } from "../contract/contract-agent";
import type { defineTool } from "../ml/ml-tool-factories";

/** What the tool needs of the worker. Absent: the descriptor alone, whose run refuses (only the worker runs it). */
export interface PythonInstallDeps {
    /** What became of the person's answer for this call, or undefined when they did not approve it. */
    outcome(args: Record<string, unknown>): Promise<string | undefined>;
}

/**
 * Build `python_install`.
 * @param define the tool factory
 * @param deps the worker's outcome; absent for the descriptor a run's assembly lists
 * @returns the tool, always gated
 */
export function pythonInstallTool(define: typeof defineTool, deps?: PythonInstallDeps): MlTool {
    return define({
        name: "python_install",
        summary: "Asks the person to install a PyPI package into python_exec's sandbox.",
        description: "Ask the person to install a package from PyPI, with its dependencies, into the sandbox python_exec cells run in. " +
            "They see every file it would download with its hash before anything is fetched, or why it cannot be installed. " +
            "Ask for one package per call; a package the sandbox already has needs no install.",
        parameters: {
            type: "object",
            properties: {
                name: { type: "string", description: "The project's name on PyPI." },
                version: { type: "string", description: "An exact version; default: the newest the sandbox can install." },
            },
            required: ["name"],
        },
        requiresApproval: true,
        run: async (args: Record<string, unknown>) => {
            if (!deps) return "Error: python_install runs only in a run the extension started for you.";
            return (await deps.outcome(args)) ?? "Not installed: the person did not approve it.";
        },
    });
}
