// devices-ui.tsx — THE DEVICES ON AN ACCOUNT and this device's connection history, under the account view (pairing-ui).
// The list follows docs/spec/CHAT_PAGE.md § Pairing and grants, whose rules are about what a row must be able to SAY:
// which row is this device, when each was last seen (prominent: a forgotten device never expires on its own, since a
// runtime renews what it lists), when a certificate needs renewing (never offered as a way to be rid of a device), what
// "can pair" and "signs revocations" mean, and that removing the device holding the second costs the account its
// ability to remove anything until the root grants it again.

import { useEffect, useState } from "preact/hooks";
import type { DeviceInfo } from "../session-host";
import { Stamp } from "../sidebar/ui-kit";
import { SCOPES, type HubLogLine, type PairingApi, type RevokeOutcome } from "./api";

/** Re-ask `load` every `ms` while mounted; the latest answer, or null before the first. */
function usePolled<T>(load: (() => Promise<T>) | undefined, ms: number, key: unknown = null): [T | null, () => void] {
    const [v, setV] = useState<T | null>(null);
    const [tick, setTick] = useState(0);
    useEffect(() => {
        if (!load) return;
        let on = true;
        const ask = () => load().then((r) => { if (on) setV(r); }, () => {});
        void ask();
        const t = setInterval(ask, ms);
        return () => { on = false; clearInterval(t); };
    }, [load, tick, key]);
    return [v, () => setTick((n) => n + 1)];
}

/** What a device may do, as pills: its scopes by their names here, unknown ones as they are. */
function ScopePills({ scopes }: { scopes: readonly string[] }) {
    if (!scopes.length) return <div class="pair-hint">No scopes: it drives nothing</div>;
    return (
        <div class="pair-scopes" aria-label="What it may do">
            {scopes.map((id) => <span key={id} class="chat-chip">{SCOPES.find((s) => s.id === id)?.label ?? id}</span>)}
        </div>
    );
}

/** The certificate's window, as when it needs renewing: a date, never a countdown to it leaving. */
function validity(notAfterMs: number, now: number): string {
    if (notAfterMs <= now) return "Its certificate expired: pair it again";
    const days = Math.floor((notAfterMs - now) / 86_400_000);
    return days < 1 ? "Its certificate needs renewing today" : `Its certificate needs renewing within ${days} day${days === 1 ? "" : "s"}`;
}

const ROLE: Record<string, string> = { client: "device", runtime: "browser runtime", "box-connector": "box" };

/** Why a removal did not happen, in words. */
const OUTCOME: Record<Exclude<RevokeOutcome, "revoked">, string> = {
    already: "It had already been removed.",
    self: "A device cannot remove itself here. To take this browser out, leave the account instead.",
    unpaired: "This browser is in no account any more.",
};

/** One device's row, with its removal behind a second click (and, for the revocation signer, a sentence first). */
function DeviceRow({ d, self, api, onChanged }: { d: DeviceInfo; self: boolean; api: PairingApi; onChanged: (note: string) => void }) {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const now = Date.now();
    const remove = async () => {
        setBusy(true);
        try {
            const r = await api.revoke!(d.principal);
            onChanged(r === "revoked" ? `“${d.label}” was removed. Its next command is refused.` : OUTCOME[r]);
        } catch (err) {
            onChanged(err instanceof Error ? err.message : "It could not be removed.");
        } finally {
            setBusy(false);
            setAsking(false);
        }
    };
    return (
        <li class={`pair-dev${self ? " self" : ""}`}>
            <div class="pair-dev-head">
                <b class="pair-dev-name">{d.label || "Unnamed device"}</b>
                <span class="pair-dev-role">{ROLE[d.role] ?? "device"}</span>
                {self ? <span class="pair-dev-self">This device</span> : null}
                <span class="pair-dev-seen">{d.lastSeenMs ? <>Seen <Stamp ts={d.lastSeenMs} /></> : "Not seen yet"}</span>
            </div>
            <ScopePills scopes={d.scopes} />
            {d.mayPair ? <div class="pair-hint">Can pair other devices, by itself.</div> : null}
            {d.mayRevoke ? <div class="pair-hint"><b>Signs revocations for this account.</b></div> : null}
            <div class="pair-hint">{validity(d.notAfterMs, now)}.</div>
            {api.revoke && !self ? (
                asking ? (
                    <div class="pair-leave" role="group" aria-label={`Remove ${d.label}`}>
                        <p class="pair-p">{d.mayRevoke
                            ? "This device signs the account's revocations. Removing it leaves the account unable to remove ANY device until the root device grants that power to another. Remove it only if it is lost."
                            : `“${d.label}” stops reaching everything on this account at once. Adding it back takes a new code, confirmed on the root device.`}</p>
                        <div class="pair-actions">
                            <button class="btn" onClick={() => setAsking(false)}>Keep it</button>
                            <button class="btn primary" disabled={busy} onClick={remove}>{busy ? "Removing…" : d.mayRevoke ? "Remove it anyway" : "Remove it"}</button>
                        </div>
                    </div>
                ) : <div class="pair-actions"><button class="btn" onClick={() => setAsking(true)}>Remove…</button></div>
            ) : null}
        </li>
    );
}

/** The devices on the account, as this device can see them. Re-read every few seconds while shown. */
export function DevicesList({ api, self }: { api: PairingApi; self?: string }) {
    const [note, setNote] = useState("");
    const [devices, reread] = usePolled(api.devices, 5000);
    if (!api.devices) return null;
    const changed = (n: string) => { setNote(n); reread(); };
    return (
        <section class="pair-card" aria-label="Devices on this account">
            <h3 class="pair-h">Devices on this account</h3>
            {devices === null ? <p class="pair-hint" role="status">Reading them…</p>
                : !devices.length ? <p class="pair-p">None yet. A device is listed here once it has connected.</p>
                    : <ul class="pair-devs">{devices.map((d) => <DeviceRow key={d.principal} d={d} self={d.principal === self} api={api} onChanged={changed} />)}</ul>}
            {note ? <p class="pair-hint" role="status">{note}</p> : null}
            <p class="pair-hint">A device stays until it is removed: its certificate is renewed while it is listed here.</p>
        </section>
    );
}

/** What the connection did and when, newest first, folded away until asked for (the idle test reads it). */
export function ConnectionHistory({ api }: { api: PairingApi }) {
    const [open, setOpen] = useState(false);
    const [lines] = usePolled(open ? api.history : undefined, 5000, open);
    if (!api.history) return null;
    const fmt = (t: number) => {
        const d = new Date(t);
        const today = d.toDateString() === new Date().toDateString();
        return today ? d.toLocaleTimeString() : d.toLocaleString();
    };
    return (
        <details class="pair-history" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>Connection history</summary>
            {!open ? null : lines === null ? <p class="pair-hint">Reading it…</p>
                : !lines.length ? <p class="pair-hint">Nothing yet.</p>
                    : <ol class="pair-log">{[...lines].reverse().map((l: HubLogLine, i) => <li key={i}><time>{fmt(l.atMs)}</time><span>{l.event}</span></li>)}</ol>}
        </details>
    );
}
