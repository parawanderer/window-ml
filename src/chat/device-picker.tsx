// device-picker.tsx — WHICH MACHINE a session starts on, from the start page: the same pill and popover as the kind,
// the model and the tab (pop-picker.ts), so the start row is one control repeated rather than four different ones.
//
// It replaced a bare `<select class="chat-pick-rt">`, which was the one raw browser widget in a row of four styled
// pills — and the phone's equivalent screen had drawn a proper device pill with a glyph since it existed, so the web
// was the surface that had drifted (AGENTS.md, one design language).
//
// It is drawn only where there is a choice to make: `startableOn` already filters to the runtimes that can start this
// kind AND that this client holds the grant for, so one runtime means no pill, and every row listed is one that can
// actually be started on. The device is picked BEFORE the model on purpose — the device is what decides which models
// there are to choose from.

import { IconCheck, IconDevice } from "../sidebar/icons";
import type { RuntimeInfo } from "../session-host";
import { usePickerPop } from "./pop-picker";

/** What a runtime's `kind` is called in the row under its name. An unknown kind is a runtime this client does not
 *  know (the wire is open on purpose), and is named as one rather than left blank. */
const KINDS: Record<string, string> = {
    browser: "A browser: a run works on its tabs.",
    desktop: "A desktop machine.",
    headless: "A machine with no screen of its own.",
};

/** The pill and its list. `value` is the chosen runtime's id; `runtimes` is what may be started on. */
export function DevicePicker({ runtimes, value, onChange }: { runtimes: readonly RuntimeInfo[]; value: string; onChange: (id: string) => void }) {
    const chosen = runtimes.find((r) => r.id === value) ?? runtimes[0];
    const p = usePickerPop<string>({ picksFor: () => runtimes.map((r) => r.id), value: chosen?.id ?? "", onPick: onChange, width: [220, 300] });
    if (!chosen) return null;
    return (
        <>
            {/* It ARRIVES like the pills beside it. This is drawn only where there is a choice, so it appears and
                disappears as the kind changes — and appearing instantly next to a tab pill that fades read as the row
                jolting. `tp-pill-in` is a one-shot animation, so it plays on each mount and never on a re-render. */}
            <button {...p.pillProps} class="tp-pill tp-pill-device tp-pill-in" aria-label={`Device: ${chosen.name}`}>
                <span class="tp-pill-icon" aria-hidden="true"><IconDevice /></span>
                <span class="tp-pill-text">{chosen.name}</span>
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {p.open && p.popProps ? (
                <div {...p.popProps} class="chat-menu tp-pop" aria-label="Device">
                    <div class="tp-list">
                        {runtimes.map((r) => (
                            <button key={r.id} type="button" role="option" aria-selected={r.id === chosen.id} {...p.row(r.id, " tp-kind")}>
                                <span class="tp-kind-text"><span class="tp-title">{r.name}</span>
                                    <span class="tp-kind-detail">{KINDS[r.kind] ?? "A runtime this page does not know the kind of."}</span></span>
                                {r.id === chosen.id ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                            </button>
                        ))}
                    </div>
                </div>
            ) : null}
        </>
    );
}
