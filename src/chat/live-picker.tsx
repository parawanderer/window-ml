// live-picker.tsx — STREAM THE RUN'S THINKING, OR LET IT RUN QUIETLY: the start page's choice for a run on a machine
// reached over a wire, as the same pill-and-short-list the kind and the model use (pop-picker.ts).
//
// A PICKER RATHER THAN A SWITCH WITH AN `ⓘ`. The thing being chosen is not obvious from its name, and the reason to
// pick either side is a sentence — so the sentences belong beside the options, read at the moment of choosing,
// rather than behind a second press. It is also the only shape that works on a phone, where the panel's tooltip is
// dismissed by the same `pointerdown` a tap begins with.
//
// It is not drawn at all for THIS browser (`ChatExtras.nearby`): there the stream costs nothing, so it is simply on,
// and a control nobody has a reason to touch is one more thing in a row that is already four pills long.

import { IconCheck } from "../sidebar/icons";
import { usePickerPop } from "./pop-picker";

/** The two answers, and the case for each. The wording is the whole point of the control: "stream" is jargon for
 *  what someone actually wants, which is to be able to see that the run is still going. */
const LIVE: Record<"on" | "off", { label: string; detail: string }> = {
    on: { label: "Live", detail: "Watch it think as it goes. The only way to tell a slow step from a stuck run." },
    off: { label: "Quiet", detail: "Send only the result. Cheaper over the network, for a run you mean to leave alone." },
};

/** The pill and its list. `value`/`onChange` are the device's remembered answer (`liveThinking`, view-mode.ts). */
export function LivePicker({ value, onChange }: { value: boolean; onChange: (on: boolean) => void }) {
    const key = value ? "on" : "off";
    const p = usePickerPop<"on" | "off">({ picksFor: () => ["on", "off"], value: key, onPick: (k) => onChange(k === "on"), width: [240, 320] });
    return (
        <>
            <button {...p.pillProps} class="tp-pill" aria-label={`Thinking: ${LIVE[key].label}`}>
                <span class="tp-pill-text">{LIVE[key].label}</span>
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {p.open && p.popProps ? (
                <div {...p.popProps} class="chat-menu tp-pop" aria-label="Thinking">
                    <div class="tp-list">
                        {(["on", "off"] as const).map((k) => (
                            <button key={k} type="button" role="option" aria-selected={key === k} {...p.row(k, " tp-kind")}>
                                <span class="tp-kind-text"><span class="tp-title">{LIVE[k].label}</span><span class="tp-kind-detail">{LIVE[k].detail}</span></span>
                                {key === k ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}
        </>
    );
}
