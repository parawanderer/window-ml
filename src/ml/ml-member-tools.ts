// ml-member-tools.ts — which `ml` members belong to an agent tool, so a run without that tool never meets them.

/**
 * Each `ml` member that is one face of an agent tool, to that tool's name. A run whose toolset lacks the tool does not
 * have the member either: the read-only `exec` facade leaves it out, `agent_api_docs` does not list it, and the page's
 * `window.ml` throws when an approved `exec` of that run reaches for it. One table, so a member cannot be hidden in
 * one of those places and left half-present in another.
 */
export const ML_MEMBER_TOOL: Readonly<Record<string, string>> = { answer: "answer" };

/**
 * The members a run with this toolset does not have, each to the sentence a model is given when it reaches for one.
 * @param hasTool whether the run's toolset has a tool by that name
 * @returns member name → why it is absent; empty when the run has every tool the table names
 */
export function hiddenMlMembers(hasTool: (name: string) => boolean): Map<string, string> {
    const out = new Map<string, string>();
    for (const [member, tool] of Object.entries(ML_MEMBER_TOOL))
        if (!hasTool(tool)) out.set(member, `ml.${member} is not part of this run: it comes with the \`${tool}\` tool, which this run was not given.`);
    return out;
}
