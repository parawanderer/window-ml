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
import { attentionItems, attentionLabel, certItems, deviceItems, sortAttention, type AttentionFix, type AttentionItem, type CertState } from "./attention";
import { exportTaskItems, exportTasks } from "./export-tasks";
import { deviceEnv } from "./app-badge";
import type { ChatStore } from "./chat-store";
import type { ChatExtras } from "./extras";
import { devicesStep, type Membership, type PairingApi } from "../pairing/api";
import { cursorTipOn } from "../sidebar/ui-kit";
import { mainView, useEscapeCloses } from "./nav";
import { SheetHead, settingsTab } from "./settings-page";
import { dismiss, dismissed } from "./view-mode";
import { certChanged } from "./renew";

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
export function useOwnCert(pairing: PairingApi | undefined, store: ChatStore, extras?: ChatExtras): CertState | null {
    const [me, setMe] = useState<Membership | null>(null);
    // A renewal REPLACES the certificate, and the poll below is hourly: without following this the card kept warning
    // about a window that had already moved, which reads as a press that did nothing (renew.ts).
    const changed = certChanged.value;
    useEffect(() => {
        if (!pairing) return;
        let alive = true;
        const read = () => void pairing.load().then((m) => { if (alive) setMe(m); }).catch(() => {});
        read();
        const t = setInterval(read, CERT_POLL_MS);
        return () => { alive = false; clearInterval(t); };
    }, [pairing, changed]);
    if (!me || typeof me.notAfterMs !== "number") return null;
    return {
        notAfterMs: me.notAfterMs,
        ...(me.mayRevoke ? { mayRevoke: true } : {}),
        // Absent means an older build that did not report it; treat that as renewable rather than telling someone to
        // re-pair a device that may be perfectly renewable.
        renewable: me.renewable !== false,
        issuerOnline: store.runtimes.value.some((rt) => rt.online),
        // Whether THIS surface can carry the press out, which is a different question from whether the account would
        // allow it — and the one that decides whether a button appears at all.
        canRenew: !!extras?.renewSelf,
    };
}

/**
 * The list, from what the runtimes report. It changes when a runtime's description does, which a fix causes: the
 * worker follows permissions and settings, so a grant clears its item without the page asking again.
 */
export function useAttention(store: ChatStore, extras?: ChatExtras, cert?: CertState | null): { items: AttentionItem[] } {
    const canFix = (rt: RuntimeInfo, fix: AttentionFix, code: string) =>
        fix.kind === "act" ? !!extras?.fix?.(rt.id, code) : !!rt.capabilities.localSettings && extras?.settings?.(rt.id) != null;
    const repeat = (rt: RuntimeInfo, code: string) => extras?.fixedTimes?.(rt.id, code) ?? 0;
    // Where each of these sits in the list is the SORT's business rather than this line's — which is why the whole
    // concatenation goes through it, and not just the runtimes' half: a certificate about to expire has to be able
    // to rank with the problems, a detached export waiting on a click above a runtime's lapsed grant, and an export
    // still fetching below both.
    //
    // THIS DEVICE'S OWN CERTIFICATE is not a runtime's code and does not come from one: it is read off the keyring
    // this page is holding. It goes through no `canFix`, because whether a renewal can happen is a fact about the
    // certificate rather than about this surface, and `certItems` already decides it.
    return {
        items: sortAttention([
            ...attentionItems(store.runtimes.value, NONE, canFix, dismissed.value, repeat),
            ...certItems(cert ?? null, Date.now()),
            ...deviceItems(deviceEnv(), dismissed.value),
            ...exportTaskItems(exportTasks.value),
        ]),
    };
}

/** The inbox above the gear: absent with nothing to do, a count only for problems. `labelled` in the list's foot. */
export function AttentionButton({ items, labelled }: { items: AttentionItem[]; labelled?: boolean }) {
    if (!items.length) return null;
    const { word, count: n } = attentionLabel(items);
    const label = n ? `${n} thing${n === 1 ? "" : "s"} need${n === 1 ? "s" : ""} attention` : word;
    const on = mainView.value === "attention";
    const open = () => { mainView.value = on ? null : "attention"; };
    return labelled ? (
        <button class={`chat-gear-wide chat-att-btn${on ? " on" : ""}`} aria-label={label} onClick={open}>
            <IconInbox /><span>{word}</span>{n ? <span class="chat-att-n">{n}</span> : null}
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
        if (!fix) return;
        // AN ITEM THIS PAGE RAISED ABOUT ITS OWN WORK brought its own action, so there is nothing to resolve and no
        // runtime to resolve it against (`AttentionFix`). First, because the two guards below are about items that
        // name a thing to be acted on elsewhere, and this one has already been handed what to do.
        if (fix.kind === "run") { fix.run(); return; }
        // AN ITEM ABOUT THIS DEVICE rather than a machine on the account — its certificate running out. It has no
        // runtime to address, so it takes its own path; before this one existed the choke point below silently
        // swallowed it, and the card drew a button that did nothing.
        if (!it.runtime) {
            // Straight to the code, not to a list: the item says what to do and this is it being done.
            if (fix.kind === "devices") { devicesStep.value = "refresh"; settingsTab.value = "devices"; mainView.value = "settings"; return; }
            const act = extras?.renewSelf;
            if (!act) return;
            setBusy(it.key);
            void act().then((problem) => { setBusy(""); if (problem) setWhy(it.key); });
            return;
        }
        // THIS surface's Devices screen, where a pairing both starts and is confirmed. The one item that uses it is
        // the revocation signer's, whose quarter is a re-pairing rather than a press (attention.ts).
        if (fix.kind === "devices") { devicesStep.value = "refresh"; settingsTab.value = "devices"; mainView.value = "settings"; return; }
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
                                        {it.progress ? <progress class="chat-att-bar" value={it.progress.done} max={it.progress.total || 1} /> : null}
                                        {why === it.key && it.runtime ? <div class="chat-att-why-note">{stuckWhy(it.runtime.name)}</div> : null}
                                    </div>
                                    <div class="chat-att-acts">
                                        {it.fix ? (
                                            <button class="chat-att-fix" disabled={busy === it.key} onClick={() => apply(it)}>
                                                {busy === it.key ? "Asking…" : it.fix.label}
                                            </button>
                                        ) : null}
                                        {/* Two ways to clear a card, and the item says which it has. A SUGGESTION's
                                            dismissal is stored, so the same advice is not given twice; a finished
                                            export is simply dropped, because there is nothing left to remember it
                                            about once the task is gone (and a stored key would pile up forever). */}
                                        {it.dismiss ? <button class="chat-att-dismiss" onClick={it.dismiss}>Dismiss</button>
                                            : it.level === "suggests" || it.hideable ? <button class="chat-att-dismiss" onClick={() => dismiss(it.key)}>Dismiss</button> : null}
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
