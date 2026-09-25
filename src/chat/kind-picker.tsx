// kind-picker.tsx — AGENT OR CHAT, as a pill that opens a short list, for the start page on a phone. The wide layout
// keeps its segmented control; on a 390px row the two segments took the room the tab and the model pills needed, so
// the phone gets the same pill as those two (pop-picker.ts), and the start row fits on one line.

import { IconAgent, IconChat, IconCheck } from "../sidebar/icons";
import type { StartKind } from "./new-session";
import { usePickerPop } from "./pop-picker";

/** Each kind, its glyph, and what it means in the words the list shows under its name. The glyph is the pair's whole
 *  point: two rows of prose differing in one word are told apart by reading, and a robot beside a speech bubble is
 *  told apart at a glance. The same two marks are drawn wherever the kinds appear (the wide segmented control, the
 *  phone app's tabs), so the pair means one thing across the product. */
const KINDS: Record<StartKind, { label: string; detail: string; icon: () => preact.JSX.Element }> = {
    agent: { label: "Agent", detail: "Works on a page: reads it, clicks, fetches, runs code.", icon: IconAgent },
    chat: { label: "Chat", detail: "Just the conversation, with no page and no tools.", icon: IconChat },
};

/** The pill and its list. */
export function KindPicker({ kinds, value, onChange }: { kinds: readonly StartKind[]; value: StartKind; onChange: (k: StartKind) => void }) {
    const p = usePickerPop<StartKind>({ picksFor: () => [...kinds], value, onPick: onChange, width: [220, 300] });
    return (
        <>
            <button {...p.pillProps} class="tp-pill tp-pill-kind" aria-label={`Kind: ${KINDS[value].label}`}>
                <span class="tp-pill-icon" aria-hidden="true">{KINDS[value].icon()}</span>
                <span class="tp-pill-text">{KINDS[value].label}</span>
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {p.open && p.popProps ? (
                <div {...p.popProps} class="chat-menu tp-pop" aria-label="Kind">
                    <div class="tp-list">
                        {kinds.map((k) => (
                            <button key={k} type="button" role="option" aria-selected={value === k} {...p.row(k, " tp-kind")}>
                                <span class="tp-kind-icon" aria-hidden="true">{KINDS[k].icon()}</span>
                                <span class="tp-kind-text"><span class="tp-title">{KINDS[k].label}</span><span class="tp-kind-detail">{KINDS[k].detail}</span></span>
                                {value === k ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}
        </>
    );
}
