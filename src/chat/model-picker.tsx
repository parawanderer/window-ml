// model-picker.tsx — WHICH MODEL a session starts on, from the start page: the Commander's model dropdown (a filter to
// type into, the names A→Z) on the tab picker's popover (pop-picker.ts), so the page's two pickers are one control.
//
// "" is the runtime's own default, which sends no `model` at all, so its choice stands; it is listed first and named
// when the runtime says which it is. The Commander's ★ ("make this the default") is not here: it writes this
// browser's config, and the runtime picked on this page may be another machine, whose settings stay its own.
import { IconCheck } from "../sidebar/icons";
import { truncate } from "../sidebar/format";
import { cursorTipOn } from "../sidebar/ui-kit";
import { useState } from "preact/hooks";
import type { ModelChoice, RuntimeInfo } from "../session-host";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";
import { usePickerPop } from "./pop-picker";

/** How long the pointer rests on a cut-off model name before its full name shows. */
const NAME_TIP_MS = 550;
/** Is the name inside this pill or row cut off? Only then is its full name worth a tip. */
const nameCut = (el: Element): boolean => {
    const t = el.querySelector(".tp-pill-text, .tp-title");
    return !!t && t.scrollWidth > t.clientWidth + 1;
};
/** The full model name, after a rest, where it is cut off: a JSX node, so a name is never read as markdown. */
const nameTip = (id: string) => cursorTipOn(<code class="tp-name-tip">{id}</code>, { delayMs: NAME_TIP_MS, onlyIf: nameCut });

/** A cloud glyph (a model the runtime reaches over the internet). */
const IconCloud = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" /></svg>
);
/** A chip glyph (a model on the runtime's own machine). */
const IconChip = () => (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></svg>
);

/**
 * WHERE A MODEL RUNS, said quietly: a faint glyph at the row's end, and the sentence under the pointer. A cloud model
 * is the one worth knowing about (what is sent leaves the machine), so it is the one a glance can pick out; nothing is
 * drawn where the runtime did not say.
 */
export function WhereMark({ where }: { where?: ModelChoice["where"] }) {
    if (where !== "cloud" && where !== "local") return null;
    return (
        <span class={`tp-where ${where}`} aria-label={where === "cloud" ? "cloud model" : "local model"}
            {...cursorTipOn(where === "cloud"
                ? "A cloud model: the runtime sends what you write to its provider."
                : "A local model: it runs on the runtime's own machine, and nothing you write leaves it.")}>
            {where === "cloud" ? <IconCloud /> : <IconChip />}
        </span>
    );
}

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
            <button {...p.pillProps} {...nameTip(label)} class={`tp-pill tp-pill-model${arrived ? " tp-pill-in" : ""}`} aria-label={`Model: ${name}`}>
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
                                <WhereMark where={dflt?.where} />
                                {value === "" ? <span class="tp-check" aria-hidden="true"><IconCheck /></span> : null}
                            </button>
                            {list.length ? <div class="tp-rule" role="separator" /> : null}
                        </>
                    ) : null}
                    <div class="tp-list">
                        {list.map((id) => (
                            <button key={id} type="button" role="option" aria-selected={value === id} {...p.row(id)} {...nameTip(id)}>
                                <span class="tp-title">{id}</span>
                                <WhereMark where={where.get(id)} />
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
export function SessionModelPicker({ store, rt, current, canSwitch, note, onSwitch, quiet }: {
    store: ChatStore; rt: RuntimeInfo; current: string; canSwitch: boolean;
    /** why the list cannot switch, shown above it when `canSwitch` is false */
    note?: string;
    onSwitch?: (id: string) => void;
    /** drawn as a quiet text button inside a composer rather than a pill in a header */
    quiet?: boolean;
}) {
    const [choices, setChoices] = useState<ModelChoice[] | null>(null);
    const models = choices && choices.map((m) => m.id);
    const where = new Map((choices ?? []).map((m) => [m.id, m.where]));
    const may = rt.online && mayCommand(rt, "models.list");
    const p = usePickerPop<string>({
        picksFor: (q) => (models ?? []).filter((id) => !q || id.toLowerCase().includes(q.toLowerCase())),
        value: current,
        onPick: (id) => { if (canSwitch && id !== current) onSwitch?.(id); },
        width: [280, 420],
        align: quiet ? "end" : "start",
        onOpen: () => {
            if (models || !may) return;
            void store.send({ type: "models.list", runtime: rt.id }, { quiet: true }).then((r) => {
                setChoices(r.ok ? r.data.models.filter((m) => !m.kinds?.includes("embedding")).sort((a, b) => a.id.localeCompare(b.id)) : []);
            });
        },
    });
    const q = p.q.trim();
    const list = (models ?? []).filter((id) => !q || id.toLowerCase().includes(q.toLowerCase()));
    return (
        <>
            <button {...p.pillProps} {...nameTip(current)} class={`tp-pill tp-pill-model ${quiet ? "tp-pill-quiet" : "chat-head-model"}`} aria-label={`Model: ${current}`}>
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
                                <button key={id} type="button" role="option" aria-selected={current === id} aria-disabled={!canSwitch || undefined} {...p.row(id, canSwitch ? "" : " off")} {...nameTip(id)}>
                                    <span class="tp-title">{id}</span>
                                    <WhereMark where={where.get(id)} />
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
