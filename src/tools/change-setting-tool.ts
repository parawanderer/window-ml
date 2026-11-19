// change-setting-tool.ts — the `change_setting` tool: the model asks to change one of the person's settings.

// It never writes one on its own word. The worker checks the key and the value, judges the change as the `setting`
// consumer, and shows a card unless a policy decides (sw-change-setting.ts, sw-run-host.ts). By the time this tool's own
// `run` is reached the change is approved: it makes the compare-and-set write and says what it did. Offered to a run the
// WORKER built alone (sw-run-start.ts); a page's start never carries it (`WORKER_ONLY_TOOLS`). docs/spec/MODEL_SETTINGS.md.

import type { MlTool } from "../contract/contract-agent";
import type { defineTool } from "../ml/ml-tool-factories";
import { SETTING_WHY_MAX } from "../sw/sw-change-setting";

/** What the tool needs of the worker. Absent: the descriptor alone, whose run refuses (only the worker runs it). */
export interface ChangeSettingDeps {
    /** Write the approved change and return the text the model reads. */
    write(args: Record<string, unknown>): Promise<string>;
}

/**
 * Build `change_setting`.
 * @param define the tool factory
 * @param deps the worker's write; absent for the descriptor a run's assembly lists
 * @returns the tool, always gated
 */
export function changeSettingTool(define: typeof defineTool, deps?: ChangeSettingDeps): MlTool {
    return define({
        name: "change_setting",
        summary: "Asks to change one of the person's settings; most changes show them a card first.",
        description: "Change one setting of the person's, by its key in ml.settings(). One key per call. " +
            "A setting is the same for every run and every browser on this profile, so change one only when the person asked for it or it is needed for their task. " +
            "The result names the old value.",
        parameters: {
            type: "object",
            properties: {
                key: { type: "string", description: "The key, e.g. \"theme\"." },
                value: { description: "The new value, of the type ml.settings() shows for it." },
                why: { type: "string", maxLength: SETTING_WHY_MAX, description: "One sentence the person reads on the card." },
            },
            required: ["key", "value"],
        },
        requiresApproval: true,
        run: async (args: Record<string, unknown>) => {
            if (!deps) return "Error: change_setting runs only in a run the extension started for you.";
            return deps.write(args);
        },
    });
}
