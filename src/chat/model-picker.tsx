// model-picker.tsx — WHICH MODEL a session starts on, from the start page: the Commander's model dropdown (a filter to
// type into, the names A→Z) on the tab picker's popover (pop-picker.ts), so the page's two pickers are one control.
//
// "" is the runtime's own default, which sends no `model` at all, so its choice stands; it is listed first and named
// when the runtime says which it is. The Commander's ★ ("make this the default") is not here: it writes this
// browser's config, and the runtime picked on this page may be another machine, whose settings stay its own.
import { IconCheck } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import type { ModelChoice } from "../session-host";
import { usePickerPop } from "./pop-picker";

/** The pill and its list. `models` is the runtime's list with embedding models already left out. */
export function ModelPicker({ models, value, onChange }: { models: readonly ModelChoice[]; value: string; onChange: (id: string) => void }) {
    const dflt = models.find((m) => m.default);
    const others = models.filter((m) => !m.default).map((m) => m.id).sort((a, b) => a.localeCompare(b));
    const where = new Map(models.map((m) => [m.id, m.where]));
    const shownFor = (q: string) => others.filter((id) => !q || id.toLowerCase().includes(q.toLowerCase()));
    const defaultShown = (q: string) => !q || "default".includes(q.toLowerCase()) || !!dflt?.id.toLowerCase().includes(q.toLowerCase());
    const p = usePickerPop<string>({
        picksFor: (q) => [...(defaultShown(q) ? [""] : []), ...shownFor(q)],
        value, onPick: onChange, width: [280, 420],
    });
    const q = p.q.trim();
    const list = shownFor(q);
    const label = value || (dflt ? `Default · ${dflt.id}` : "Default");
    return (
        <>
            <button {...p.pillProps} class="tp-pill" aria-label={`Model: ${label}`}>
                <span class="tp-pill-text">{truncate(label, 48)}</span>
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {p.open && p.popProps ? (
                <div {...p.popProps} class="chat-menu tp-pop" aria-label="Model">
                    <input {...p.filterProps} placeholder="Filter models" aria-label="Filter models" />
                    {defaultShown(q) ? (
                        <>
                            <button type="button" role="option" aria-selected={value === ""} {...p.row("")}>
                                <span class="tp-title">{dflt ? dflt.id : "The runtime's default"}</span>
                                <span class="tp-host">default</span>
                                {value === "" ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                            </button>
                            {list.length ? <div class="tp-rule" role="separator" /> : null}
                        </>
                    ) : null}
                    <div class="tp-list">
                        {list.map((id) => (
                            <button key={id} type="button" role="option" aria-selected={value === id} {...p.row(id)}>
                                <span class="tp-title">{id}</span>
                                {where.get(id) === "cloud" ? <span class="chat-chip rt-where cloud">cloud</span> : null}
                                {value === id ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                            </button>
                        ))}
                        {!list.length && !defaultShown(q) ? <div class="tp-note">No model matches “{truncate(q, 30)}”.</div> : null}
                    </div>
                </div>
            ) : null}
        </>
    );
}
