// attention-page.tsx — the ATTENTION LIST: what needs someone's hand before a runtime works fully, as a sheet like
// Search and Settings, opened from an inbox above the gear. Nothing is stored: every item is derived from the codes the
// runtimes report (attention.ts), so fixing a thing is what removes it.
//
// The button shows only when there is something in the list, and its count only for problems, never suggestions, so
// a page that is set up stays as quiet as it was. A fix is offered only where THIS device can apply it (one click,
// `ChatExtras.fix`, or the extension's Settings it holds); elsewhere the item says on which runtime it is fixed.
import { useState } from "preact/hooks";
import type { RuntimeInfo } from "../session-host";
import { IconInbox } from "../sidebar/icons";
import { attentionCount, attentionItems, type AttentionFix, type AttentionItem } from "./attention";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { mainView, useEscapeCloses } from "./nav";
import { SheetHead, settingsTab } from "./settings-page";
import { dismiss, dismissed } from "./view-mode";

/** No codes of this device's own: every runtime reports its own now (`capabilities.attention`). */
const NONE: ReadonlyMap<string, readonly string[]> = new Map();

/**
 * The list, from what the runtimes report. It changes when a runtime's description does, which a fix causes: the
 * worker follows permissions and settings, so a grant clears its item without the page asking again.
 */
export function useAttention(store: ChatStore, extras?: ChatExtras): { items: AttentionItem[] } {
    const canFix = (rt: RuntimeInfo, fix: AttentionFix, code: string) =>
        fix.kind === "act" ? !!extras?.fix?.(rt.id, code) : !!rt.capabilities.localSettings && extras?.settings?.(rt.id) != null;
    return { items: attentionItems(store.runtimes.value, NONE, canFix, dismissed.value) };
}

/** The inbox above the gear: absent with nothing to do, a count only for problems. `labelled` in the list's foot. */
export function AttentionButton({ items, labelled }: { items: AttentionItem[]; labelled?: boolean }) {
    if (!items.length) return null;
    const n = attentionCount(items);
    const label = n ? `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention` : "Suggestions";
    const on = mainView.value === "attention";
    const open = () => { mainView.value = on ? null : "attention"; };
    return labelled ? (
        <button class={`chat-gear-wide chat-att-btn${on ? " on" : ""}`} aria-label={label} onClick={open}>
            <IconInbox /><span>{n ? "Needs attention" : "Suggestions"}</span>{n ? <span class="chat-att-n">{n}</span> : null}
        </button>
    ) : (
        <button class={`tt hbtn chat-att-btn${on ? " on" : ""}`} aria-label={label} onClick={open}>
            <IconInbox />{n ? <span class="chat-att-dot">{n}</span> : null}<span class="tt-pop" role="tooltip">{label}</span>
        </button>
    );
}

/** The sheet: problems first, then suggestions, each with its fix where this device has one. */
export function AttentionPage({ items, extras }: { items: AttentionItem[]; extras?: ChatExtras }) {
    useEscapeCloses();
    const [busy, setBusy] = useState("");
    const many = new Set(items.map((i) => i.runtime.id)).size > 1;
    const apply = (it: AttentionItem) => {
        const fix = it.fix;
        if (!fix) return;
        if (fix.kind === "settings") { settingsTab.value = "extension"; mainView.value = "settings"; return; }
        // Called synchronously in the click: a browser shows a permission prompt or a folder picker only inside one.
        const ask = extras?.fix?.(it.runtime.id, it.code);
        if (!ask) return;
        setBusy(it.key);
        void ask().then(() => setBusy(""));
    };
    return (
        <main class="chat-main chat-settings" aria-label="Needs attention">
            <div class="view chat-sheet-scroll">
                <div class="chat-sheet-col">
                    <SheetHead title="Needs attention" back="Close" />
                    {!items.length ? <p class="chat-set-lede">Nothing needs attention.</p> : (
                        <ul class="chat-att-list">
                            {items.map((it) => (
                                <li key={it.key} class={`chat-att-item ${it.level}`}>
                                    <div class="chat-att-text">
                                        <div class="chat-att-title">{it.title}{many ? <span class="chat-att-rt">{it.runtime.name}</span> : null}</div>
                                        <div class="chat-att-detail">
                                            {it.detail}
                                            {it.fix?.kind === "settings" ? <> In Settings → {it.fix.where}.</> : null}
                                            {!it.fix && !it.runtime.capabilities.localSettings ? <> It is fixed on {it.runtime.name}.</> : null}
                                        </div>
                                    </div>
                                    <div class="chat-att-acts">
                                        {it.fix ? (
                                            <button class="chat-att-fix" disabled={busy === it.key} onClick={() => apply(it)}>
                                                {busy === it.key ? "Asking…" : it.fix.label}
                                            </button>
                                        ) : null}
                                        {it.level === "suggests" ? <button class="chat-att-dismiss" onClick={() => dismiss(it.key)}>Dismiss</button> : null}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>
        </main>
    );
}
