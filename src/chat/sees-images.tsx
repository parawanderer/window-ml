// sees-images.tsx — the "This model sees images" toggle: the person's word (`vision: true`) for a model whose vision the
// runtime does not report, on the start page and in a chat's composer (docs/spec/FILE_ATTACHMENTS.md).

import { useEffect, useState } from "preact/hooks";
import type { ModelChoice, RuntimeInfo } from "../session/session-host";
import { IconEye, IconEyeOff } from "../sidebar/icons";
import { cursorTipOn } from "../sidebar/ui-kit";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";
import { setVisionChoice, visionChoices } from "./view-mode";
import { visionFor, visionTip } from "../vision-choice";

/** Is a model's vision not reported, so only the person can say it sees? A cloud model, or one listed with no kinds
 *  (absent kinds mean unknown, never "none"). A model the list does not hold is not offered the toggle. */
export const visionUnreported = (m: ModelChoice | undefined): boolean => !!m && (m.where === "cloud" || !m.kinds);

/** Whether a message with images to `model` on runtime `rt` carries `vision: true` (`session.send`, `chat.start`): the model is one
 *  whose vision is not reported, and the person said it sees images or never said otherwise (`vision-choice.ts`). The model
 *  list is the one the composer already asked for; without it nothing is claimed. */
export function claimsVision(rt: string, model: string | null | undefined): boolean {
    const m = modelCache.get(rt)?.find((x) => (model ? x.id === model : x.default));
    return !!m && visionUnreported(m) && visionFor(visionChoices.value, rt, m.id).on;
}

/**
 * The eye toggle itself; its name is the words the runtime's refusal names ('This model sees images'). `chosen` is whether
 * the person said so, or it is the assumption for a model nobody said anything about (drawn dimmer, and worded so).
 * @group primitives
 * @gallery {"on": true, "chosen": false}
 */
export function SeesImagesToggle({ on, chosen = true, onToggle }: { on: boolean; chosen?: boolean; onToggle: () => void }) {
    return (
        <button class={`cmp-vis${on ? " on" : ""}${chosen ? "" : " assumed"}`} type="button" aria-pressed={on} aria-label="This model sees images"
            {...cursorTipOn(visionTip(on, chosen))}
            onClick={onToggle}>{on ? <IconEye /> : <IconEyeOff />}</button>
    );
}

/** Each runtime's model list as last answered, for the page's life: a start page opened again draws it at once. */
export const modelCache = new Map<string, ModelChoice[]>();   // state: cache

/**
 * The toggle in a chat session's composer: drawn when the chat's model is one whose vision is not reported, from the
 * runtime's model list (cached as the start page caches it, asked for once when it is not). An agent run's vision is
 * decided at its start, so a run's composer has none.
 * @gallery none needs a ChatStore and a runtime's model list; drawn as SeesImagesToggle once the list answers
 */
export function ChatSeesImages({ store, rt, model }: { store: ChatStore; rt: RuntimeInfo; model: string | null }) {
    const [list, setList] = useState<ModelChoice[] | null>(() => modelCache.get(rt.id) ?? null);
    useEffect(() => {
        if (list || !rt.online || !mayCommand(rt, "models.list")) return;
        let live = true;
        void store.send({ type: "models.list", runtime: rt.id }, { quiet: true }).then((r) => {
            if (!r.ok) return;
            const got = r.data.models.filter((m) => !m.kinds?.includes("embedding"));
            modelCache.set(rt.id, got);
            if (live) setList(got);
        });
        return () => { live = false; };
    }, [rt.id, list]);
    // A chat on the runtime's default names no model: the list's default is the one it talks to.
    const entry = list?.find((m) => (model ? m.id === model : m.default));
    if (!entry || !visionUnreported(entry)) return null;
    const { on, chosen } = visionFor(visionChoices.value, rt.id, entry.id);
    return <SeesImagesToggle on={on} chosen={chosen} onToggle={() => setVisionChoice(rt.id, entry.id, !on)} />;
}
