// propose-policy-tool.ts — the `propose_policy` tool: the model asks the person for a run policy over fetch_url.

// It never adds one itself. The call is always gated; the worker checks it, measures its breadth and leads the card with
// that (policy-proposal.ts), and adds the policy only when the person approves (sw-run-host.ts, the gate's resolve). By
// the time this tool's own `run` is reached, the decision is made: it only reports it. Offered to a run the WORKER
// built alone (sw-run-start.ts); a page's start never carries it (`pageStartPayload`).

import type { MlTool } from "../contract/contract-agent";
import type { defineTool } from "../ml/ml-tool-factories";
import { PROPOSAL_ROWS_MAX } from "../sw/policy-valid";

/** What the tool needs of the worker. Absent: the descriptor alone, whose run refuses (only the worker runs it). */
export interface ProposePolicyDeps {
    /** The checked rows, in the order sent, or the error the model reads. */
    check(args: Record<string, unknown>): { proposals: { effect: string; source: string; label: string }[] } | { error: string };
    /** Whether the run now holds this exact policy: the person approved it. */
    added(p: { effect: string; source: string }): boolean;
}

/**
 * Build `propose_policy`.
 * @param define the tool factory
 * @param deps the worker's check and store; absent for the descriptor a run's assembly lists
 * @returns the tool, always gated
 */
export function proposePolicyTool(define: typeof defineTool, deps?: ProposePolicyDeps): MlTool {
    return define({
        name: "propose_policy",
        summary: "Asks the person for a rule that answers matching fetch_url calls of this run without a card, or always shows one.",
        description: "Ask the person to let matching fetch_url calls of this run go without asking (allow), be refused without asking (deny), or always be put to them (ask). " +
            "They see your code, with which of this run's calls it matches and whether it matches other sites, and approve or refuse it. " +
            "Propose an allow only after several approvals of similar fetches; keep it narrow, e.g. one host. " +
            "Several rules go in `rules`; a deny beats an allow.",
        parameters: {
            type: "object",
            properties: {
                effect: { type: "string", enum: ["allow", "deny", "ask"] },
                when: {
                    type: "string",
                    description: "A read-only JS function over the call returning a boolean, e.g. (c) => c.host === \"docs.python.org\" && !c.credentials. " +
                        "Fields: url, host, method, credentials, rendered, interactive (true for navigate). Use === only.",
                },
                label: { type: "string", description: "One short sentence the person reads, e.g. \"Read docs.python.org\"." },
                rules: {
                    type: "array",
                    maxItems: PROPOSAL_ROWS_MAX,
                    description: "Instead of effect, when and label.",
                    items: {
                        type: "object",
                        properties: { effect: { type: "string", enum: ["allow", "deny", "ask"] }, when: { type: "string" }, label: { type: "string" } },
                        required: ["effect", "when", "label"],
                    },
                },
            },
            required: [],
        },
        requiresApproval: true,
        run: async (args: Record<string, unknown>) => {
            if (!deps) return "Error: propose_policy runs only in a run the extension started for you.";
            const r = deps.check(args);
            if ("error" in r) return r.error;
            const rows = r.proposals;
            if (!rows.every((q) => deps.added(q))) return "Not added: the person did not approve it. Matching calls still ask.";
            if (rows.length > 1) return `Added for this run: ${rows.map((q) => `${q.effect} "${q.label}"`).join("; ")}. A deny beats an allow.`;
            const q = rows[0];
            return `Added for this run: "${q.label}". ${q.effect === "ask" ? "Matching fetch_url calls now always ask the person." : `Matching fetch_url calls are now ${q.effect === "allow" ? "fetched" : "refused"} without asking.`}`;
        },
    });
}
