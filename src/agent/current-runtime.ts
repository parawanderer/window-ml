// current-runtime.ts — the ONE rule that turns a runtime's description into `ml.current.runtime`: no capability is
// listed here, so one added to the session contract reaches the model with no edit. Pure, so every shape is tested.

import { attentionTitle } from "../chat/attention";
import type { CurrentAttention, CurrentRuntime } from "./current-context";
import type { RuntimeInfo } from "../session/session-host";

/** What an attention code may look like to cross: a short slug. Anything else (a URL, an id) is not a code. */
const CODE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * The runtime's description as the model is told it. A boolean capability stays itself, any other present value becomes
 * `true`: the non-boolean ones carry inventories and identifiers (where a blank run opens and the extension's id, the
 * archive folder, the boxes), so the model learns they exist and nothing they hold. `attention` is the one exception,
 * a closed vocabulary already shown to the person, and crosses as each code with the inbox's title.
 * @param info the runtime's own description
 * @returns the projection
 */
export function runtimeOf(info: Pick<RuntimeInfo, "kind" | "capabilities">): CurrentRuntime {
    const capabilities: CurrentRuntime["capabilities"] = {};
    for (const [name, value] of Object.entries(info.capabilities ?? {})) {
        if (name === "attention") {
            const codes = Array.isArray(value) ? value.filter((c): c is string => typeof c === "string" && CODE.test(c)) : [];
            capabilities.attention = [...new Set(codes)].map((code): CurrentAttention => ({ code, title: attentionTitle(code) }));
        } else if (typeof value === "boolean") capabilities[name] = value;
        else if (value != null) capabilities[name] = true;
    }
    return { kind: info.kind, capabilities };
}
