// attention-page.tsx — the ATTENTION LIST: what needs someone's hand before a runtime works fully, as a sheet like
// Search and Settings, opened from an inbox above the gear. Nothing is stored: every item is derived from the codes the
// runtimes report (attention.ts), so fixing a thing is what removes it.
//
// The button shows only when there is something in the list, and its count only for problems, never suggestions, so
// a page that is set up stays as quiet as it was. A fix is offered only where THIS device can apply it (one click,
// `ChatExtras.fix`, or the extension's Settings it holds); elsewhere the item says on which runtime it is fixed.
import { useEffect, useState } from "preact/hooks";
import type { RuntimeInfo } from "../session-host";
import { IconInbox } from "../sidebar/icons";
import { attentionCount, attentionItems, certItems, deviceItems, type AttentionFix, type AttentionItem, type CertState } from "./attention";
import { deviceEnv } from "./app-badge";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import type { Membership, PairingApi } from "../pairing/api";
import { cursorTipOn } from "../sidebar/ui-kit";
import { mainView, useEscapeCloses } from "./nav";
import { SheetHead, settingsTab } from "./settings-page";
import { dismiss, dismissed } from "./view-mode";

/** No codes of this device's own: every runtime reports its own now (`capabilities.attention`). */
const NONE: ReadonlyMap<string, readonly string[]> = new Map();

/** How often the keyring is re-read for the certificate's end. An expiry moves at the speed of a calendar, so this is
 *  about a long-lived page crossing a day boundary, not about catching a change. */
const CERT_POLL_MS = 60 * 60_000;

/**
 * THIS DEVICE'S OWN CERTIFICATE, as `certItems` needs it: read off the keyring, with `issuerOnline` live because that
 * is the half that changes while you watch — a browser going to sleep is what turns the one-press renewal into "open
 * one of your machines".
 */
export function useOwnCert(pairing: PairingApi | undefined, store: ChatStore): CertState | null {
    const [me, setMe] = useState<Membership | null>(null);
    useEffect(() => {
        if (!pairing) return;
        let alive = true;
        const read = () => void pairing.load().then((m) => { if (alive) setMe(m); }).catch(() => {});
        read();
        const t = setInterval(read, CERT_POLL_MS);
        return () => { alive = false; clearInterval(t); };
    }, [pairing]);
    if (!me || typeof me.notAfterMs !== "number") return null;
    return {
        notAfterMs: me.notAfterMs,
        ...(me.mayRevoke ? { mayRevoke: true } : {}),
        // Absent means an older build that did not report it; treat that as renewable rather than telling someone to
        // re-pair a device that may be perfectly renewable.
        renewable: me.renewable !== false,
        issuerOnline: store.runtimes.value.some((rt) => rt.online),
    };
}

/**
 * The list, from what the runtimes report. It changes when a runtime's description does, which a fix causes: the
 * worker follows permissions and settings, so a grant clears its item without the page asking again.
 */
export function useAttention(store: ChatStore, extras?: ChatExtras, cert?: CertState | null): { items: AttentionItem[] } {
    const canFix = (rt: RuntimeInfo, fix: AttentionFix, code: string) =>
        fix.kind === "act" ? !!extras?.fix?.(rt.id, code) : !!rt.capabilities.localSettings && extras?.settings?.(rt.id) != null;
    const repeat = (rt: RuntimeInfo, code: string) => !!extras?.fixedBefore?.(rt.id, code);
    // This device's own suggestions come FIRST in the call and last in the list: `attentionItems` sorts by level and
    // a suggestion outranks nothing, so where they sit is the sort's business rather than this line's.
    // THIS DEVICE'S OWN CERTIFICATE is not a runtime's code and does not come from one: it is read off the keyring
    // this page is holding. It goes through no `canFix`, because whether a renewal can happen is a fact about the
    // certificate rather than about this surface, and `certItems` already decides it.
    return { items: [
        ...attentionItems(store.runtimes.value, NONE, canFix, dismissed.value, repeat),
        ...certItems(cert ?? null, Date.now()),
        ...deviceItems(deviceEnv(), dismissed.value),
    ] };
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

/** Why a card with no buttons stays put: the one thing its corner `ⓘ` has to say, on either surface. */
const stuckWhy = (rt: string): string => `This stays until it is put right on ${rt}. Nothing on this device can clear it, and dismissing it here would only hide it.`;

/** The sheet: problems first, then suggestions, each with its fix where this device has one. */
export function AttentionPage({ items, extras }: { items: AttentionItem[]; extras?: ChatExtras }) {
    useEscapeCloses();
    const [busy, setBusy] = useState("");
    const many = new Set(items.map((i) => i.runtime?.id).filter(Boolean)).size > 1;
    // Which card has been asked WHY IT WILL NOT GO. One at a time: it is an aside, not a mode.
    const [why, setWhy] = useState("");
    const apply = (it: AttentionItem) => {
        const fix = it.fix;
        // A device-level item has no runtime and never has a fix: the two go together, and this is the choke point.
        if (!fix || !it.runtime) return;
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
                                        <div class="chat-att-title">{it.title}{many && it.runtime ? <span class="chat-att-rt">{it.runtime.name}</span> : null}
                                            {/* WHY THIS ONE HAS NO BUTTONS. A card with neither a fix nor a Dismiss reads
                                                as a message that ignored you, and the answer — that it clears when the
                                                machine it is about is put right, and not before — is worth a corner
                                                rather than a line on every card. Hovering says it where there is a
                                                pointer; tapping says it where there is not, because the panel's tooltip
                                                is hidden by the same pointerdown that a tap begins with.

                                                Never on a DEVICE item: "add this to your home screen" has no machine
                                                to be put right on, and it carries a Dismiss of its own. */}
                                            {!it.fix && it.runtime && it.level !== "suggests" ? (
                                                <button class="chat-att-why" data-inline-target aria-expanded={why === it.key}
                                                    aria-label={`Why ${it.title} cannot be dismissed`}
                                                    onClick={() => setWhy((k) => (k === it.key ? "" : it.key))}
                                                    {...cursorTipOn(stuckWhy(it.runtime.name))}>ⓘ</button>
                                            ) : null}
                                        </div>
                                        <div class="chat-att-detail">
                                            {it.detail}
                                            {it.fix?.kind === "settings" ? <> In Settings → {it.fix.where}.</> : null}
                                            {!it.fix && it.runtime && !it.runtime.capabilities.localSettings ? <> It is fixed on {it.runtime.name}.</> : null}
                                        </div>
                                        {why === it.key && it.runtime ? <div class="chat-att-why-note">{stuckWhy(it.runtime.name)}</div> : null}
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
