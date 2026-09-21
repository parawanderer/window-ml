// model-picker.tsx — WHICH MODEL a session starts on, from the start page: the Commander's model dropdown (a filter to
// type into, the names A→Z) on the tab picker's popover (pop-picker.ts), so the page's two pickers are one control.
//
// "" is the runtime's own default, which sends no `model` at all, so its choice stands; it is listed first and named
// when the runtime says which it is. The Commander's ★ ("make this the default") is not here: it writes this
// browser's config, and the runtime picked on this page may be another machine, whose settings stay its own.
import { IconCheck } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import { useState } from "preact/hooks";
import type { ModelChoice, RuntimeInfo } from "../session-host";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";
import { usePickerPop } from "./pop-picker";

/** The pill and its list. `models` is the runtime's list with embedding models already left out. */
export function ModelPicker({ models, value, onChange, arrived }: { models: readonly ModelChoice[]; value: string; onChange: (id: string) => void; arrived?: boolean }) {
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
    // The pill names the model alone: "Default · " cost a third of the row and wrapped it. The list says which is
    // the default, and so does the pill's accessible name.
    const label = value || (dflt ? dflt.id : "Default");
    const name = value || (dflt ? `Default · ${dflt.id}` : "Default");
    return (
        <>
            <button {...p.pillProps} class={`tp-pill tp-pill-model${arrived ? " tp-pill-in" : ""}`} aria-label={`Model: ${name}`}>
                <span class="tp-pill-text">{label}</span>
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

/**
 * A SESSION'S MODEL, at the top of its page: the model it runs on, and the list to swap it (the same pill and list as
 * the start page's). Switching needs the runtime to accept a new model for a session (`canSwitch`, asked for in
 * tmp/chat-page-switch-model-asks-2026-09-19.md); until it does, the list says so and picking changes nothing, rather
 * than a control that quietly does nothing. The list is the runtime's own, asked for when the pill first opens.
 */
export function SessionModelPicker({ store, rt, current, canSwitch, note, onSwitch }: {
    store: ChatStore; rt: RuntimeInfo; current: string; canSwitch: boolean;
    /** why the list cannot switch, shown above it when `canSwitch` is false */
    note?: string;
    onSwitch?: (id: string) => void;
}) {
    const [models, setModels] = useState<string[] | null>(null);
    const may = rt.online && mayCommand(rt, "models.list");
    const p = usePickerPop<string>({
        picksFor: (q) => (models ?? []).filter((id) => !q || id.toLowerCase().includes(q.toLowerCase())),
        value: current,
        onPick: (id) => { if (canSwitch && id !== current) onSwitch?.(id); },
        width: [280, 420],
        onOpen: () => {
            if (models || !may) return;
            void store.send({ type: "models.list", runtime: rt.id }, { quiet: true }).then((r) => {
                setModels(r.ok ? r.data.models.filter((m) => !m.kinds?.includes("embedding")).map((m) => m.id).sort((a, b) => a.localeCompare(b)) : []);
            });
        },
    });
    const q = p.q.trim();
    const list = (models ?? []).filter((id) => !q || id.toLowerCase().includes(q.toLowerCase()));
    return (
        <>
            <button {...p.pillProps} class="tp-pill tp-pill-model chat-head-model" aria-label={`Model: ${current}`}>
                <span class="tp-pill-text">{current}</span>
                <svg class="tp-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
            </button>
            {p.open && p.popProps ? (
                <div {...p.popProps} class="chat-menu tp-pop" aria-label="Model">
                    {canSwitch || !note ? null : <div class="tp-note tp-switch-note" role="note">{note}</div>}
                    <input {...p.filterProps} placeholder="Filter models" aria-label="Filter models" />
                    <div class="tp-list">
                        {models === null ? <div class="tp-note">{may ? "Asking…" : "This device may not list its models."}</div>
                            : list.map((id) => (
                                <button key={id} type="button" role="option" aria-selected={current === id} aria-disabled={!canSwitch || undefined} {...p.row(id, canSwitch ? "" : " off")}>
                                    <span class="tp-title">{id}</span>
                                    {current === id ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                                </button>
                            ))}
                        {models && !list.length ? <div class="tp-note">No model matches “{truncate(q, 30)}”.</div> : null}
                    </div>
                </div>
            ) : null}
        </>
    );
}
