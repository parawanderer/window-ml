// sees-images.tsx — the "This model sees images" toggle: the person's word (`vision: true`) for a model whose vision the
// runtime does not report, on the start page and in a chat's composer (docs/spec/FILE_ATTACHMENTS.md).

import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import type { ModelChoice, RuntimeInfo, SessionKey } from "../session/session-host";
import { IconEye, IconEyeOff } from "../sidebar/icons";
import { cursorTipOn } from "../sidebar/ui-kit";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";

/** Is a model's vision not reported, so only the person can say it sees? A cloud model, or one listed with no kinds
 *  (absent kinds mean unknown, never "none"). A model the list does not hold is not offered the toggle. */
export const visionUnreported = (m: ModelChoice | undefined): boolean => !!m && (m.where === "cloud" || !m.kinds);

/** The chat sessions whose model the person said sees images, for this page's life: `session.send` carries
 *  `vision: true` for them (host-services.ts). Not stored, so a reload asks again. */
export const seesImages = signal<ReadonlySet<SessionKey>>(new Set());   // state: ui

/** Turn the person's word for one chat session on or off. */
export function setSeesImages(key: SessionKey, on: boolean): void {
    const next = new Set(seesImages.value);
    if (on) next.add(key); else next.delete(key);
    seesImages.value = next;
}

/**
 * The eye toggle itself; its name is the words the runtime's refusal names ('This model sees images').
 * @group primitives
 * @gallery {"on": true}
 */
export function SeesImagesToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
    return (
        <button class={`cmp-vis${on ? " on" : ""}`} type="button" aria-pressed={on} aria-label="This model sees images"
            {...cursorTipOn(on
                ? "You said this model sees images, so they go to it. Click to turn off."
                : "Images go to the reader model if one is set, and are refused if none is, since it is not known whether this model sees them. Click if it does.")}
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
export function ChatSeesImages({ store, rt, model, sessionKey }: { store: ChatStore; rt: RuntimeInfo; model: string | null; sessionKey: SessionKey }) {
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
    if (!visionUnreported(list?.find((m) => (model ? m.id === model : m.default)))) return null;
    const on = seesImages.value.has(sessionKey);
    return <SeesImagesToggle on={on} onToggle={() => setSeesImages(sessionKey, !on)} />;
}
