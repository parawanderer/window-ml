// pairing-ui.tsx — THE PAIRING SCREENS: joining an account (this device shows a code and its fingerprint), creating one,
// and pairing a new device (typing its code, comparing fingerprints, choosing what it may do). Standalone: they take a
// `PairingApi` as a prop and nothing else, so the chat page, the DevTools panel or a phone app can each draw them.
//
// THE FINGERPRINT IS THE SECURITY. The code only finds the hub's slot; a hub that swapped the keys in it would pair
// itself, and only a person comparing the two fingerprints notices. So there is no way past the comparison, and the
// button that pairs is the answer to "do these match?", never a generic OK.

import { useEffect, useRef, useState } from "preact/hooks";
import { ConnectionHistory, DevicesList } from "./devices-ui";
import { groupFour, pairingProblem, roleName, SCOPES, type FoundOffer, type Grant, type HubConnectionView, type Membership, type OfferHandle, type PairingApi } from "./api";

/** A fingerprint as both screens draw it: four-character groups in the code face, large enough to compare. */
export function Fingerprint({ value }: { value: string }) {
    return <code class="pair-fp" aria-label={`Fingerprint ${value.split("").join(" ")}`}>{groupFour(value)}</code>;
}

/** A pairing code as the new device shows it: grouped, large, selectable to read out or copy. */
function PairingCode({ code }: { code: string }) {
    return <code class="pair-code" aria-label={`Pairing code ${code.split("").join(" ")}`}>{groupFour(code)}</code>;
}

/** Minutes and seconds until `at`, ticking; "0:00" once past. */
function useCountdown(at: number | null): string {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (at == null) return;
        const t = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(t);
    }, [at]);
    if (at == null) return "";
    const s = Math.max(0, Math.round((at - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One labelled text field. */
function Field({ label, hint, value, onInput, placeholder, mono }: { label: string; hint?: string; value: string; onInput: (v: string) => void; placeholder?: string; mono?: boolean }) {
    return (
        <label class="pair-field">
            <span class="pair-field-label">{label}</span>
            <input class={`pair-input${mono ? " mono" : ""}`} type="text" value={value} placeholder={placeholder}
                spellcheck={false} autocomplete="off" onInput={(e) => onInput((e.target as HTMLInputElement).value)} />
            {hint ? <span class="pair-hint">{hint}</span> : null}
        </label>
    );
}

/**
 * JOINING AN ACCOUNT, on the new device: name it, then show the code and this device's fingerprint while the person
 * types the code on a device that may pair. It resolves by itself when that device answers.
 */
export function JoinAccount({ api, onJoined, onCancel }: { api: PairingApi; onJoined: (m: Membership) => void; onCancel?: () => void }) {
    const [label, setLabel] = useState(api.defaultLabel);
    const [hubUrl, setHubUrl] = useState(api.defaultHubUrl);
    const [offer, setOffer] = useState<OfferHandle | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const live = useRef<OfferHandle | null>(null);
    const left = useCountdown(offer?.expiresAt ?? null);
    // Leaving the screen withdraws the offer: a code nobody is looking at should not stay answerable.
    useEffect(() => () => live.current?.cancel(), []);
    const start = async () => {
        setBusy(true);
        setProblem("");
        try {
            const h = await api.beginOffer({ hubUrl: hubUrl.trim(), label: label.trim() || api.defaultLabel });
            live.current = h;
            setOffer(h);
            h.done.then((m) => { live.current = null; onJoined(m); }, (err) => {
                if (live.current !== h) return;   // cancelled here: not a failure to report
                live.current = null;
                setOffer(null);
                setProblem(pairingProblem(err));
            });
        } catch (err) {
            setProblem(pairingProblem(err));
        } finally {
            setBusy(false);
        }
    };
    const cancel = () => { const h = live.current; live.current = null; h?.cancel(); setOffer(null); onCancel?.(); };
    if (offer) {
        return (
            <section class="pair-card" aria-label="Join an account">
                <h3 class="pair-h">Type this code on a device already in your account</h3>
                <p class="pair-p">There: Settings → Devices → Pair a device.</p>
                <PairingCode code={offer.code} />
                <p class="pair-p">It will then show a fingerprint. It must be exactly this one:</p>
                <Fingerprint value={offer.fingerprint} />
                <p class="pair-hint" role="status">Waiting for it to be confirmed there. The code works for {left}.</p>
                <div class="pair-actions"><button class="btn" onClick={cancel}>Cancel</button></div>
            </section>
        );
    }
    return (
        <section class="pair-card" aria-label="Join an account">
            <h3 class="pair-h">Join an account</h3>
            <p class="pair-p">This device gets a code to type on one that is already in the account, and you compare a fingerprint on both.</p>
            <Field label="Call this device" value={label} onInput={setLabel} placeholder={api.defaultLabel} />
            <Field label="Hub" value={hubUrl} onInput={setHubUrl} placeholder="wss://hub.example" mono />
            {problem ? <p class="pair-problem" role="alert">{problem}</p> : null}
            <div class="pair-actions">
                {onCancel ? <button class="btn" onClick={onCancel}>Back</button> : null}
                <button class="btn primary" disabled={busy || !hubUrl.trim()} onClick={start}>{busy ? "Asking the hub…" : "Get a code"}</button>
            </div>
        </section>
    );
}

/** CREATING AN ACCOUNT: this device becomes its root, the one that pairs everything else. */
export function CreateAccount({ api, onCreated, onCancel }: { api: PairingApi; onCreated: (m: Membership) => void; onCancel?: () => void }) {
    const [label, setLabel] = useState(api.defaultLabel);
    const [hubUrl, setHubUrl] = useState(api.defaultHubUrl);
    const [invite, setInvite] = useState("");
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const go = async () => {
        setBusy(true);
        setProblem("");
        try {
            onCreated(await api.createAccount({ hubUrl: hubUrl.trim(), label: label.trim() || api.defaultLabel, ...(invite.trim() ? { invite: invite.trim() } : {}) }));
        } catch (err) {
            setProblem(pairingProblem(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <section class="pair-card" aria-label="Create an account">
            <h3 class="pair-h">Create an account</h3>
            <p class="pair-p">For your first device. It holds the account's root key and pairs every other device, so keep it somewhere you trust.</p>
            <Field label="Call this device" value={label} onInput={setLabel} placeholder={api.defaultLabel} />
            <Field label="Hub" value={hubUrl} onInput={setHubUrl} placeholder="wss://hub.example" mono />
            <Field label="Invite code" hint="Only if the hub asks for one." value={invite} onInput={setInvite} mono />
            {problem ? <p class="pair-problem" role="alert">{problem}</p> : null}
            <div class="pair-actions">
                {onCancel ? <button class="btn" onClick={onCancel}>Back</button> : null}
                <button class="btn primary" disabled={busy || !hubUrl.trim()} onClick={go}>{busy ? "Creating…" : "Create it"}</button>
            </div>
        </section>
    );
}

/** What the new device may do: the scopes this device may grant, and pairing others. */
function GrantEditor({ found, grant, onChange }: { found: FoundOffer; grant: Grant; onChange: (g: Grant) => void }) {
    const known = SCOPES.filter((s) => !found.grantable || found.grantable.includes(s.id));
    // A scope in the default this page has no words for is still shown, by name, rather than dropped unseen.
    const extra = grant.scopes.filter((id) => !SCOPES.some((s) => s.id === id)).map((id) => ({ id, label: id, detail: "" }));
    const toggle = (id: string, on: boolean) => onChange({ ...grant, scopes: on ? [...grant.scopes, id] : grant.scopes.filter((s) => s !== id) });
    const days = Math.round(grant.validityMs / 86_400_000);
    return (
        <fieldset class="pair-grant">
            <legend class="pair-field-label">What it may do</legend>
            {[...known, ...extra].map((s) => (
                <label key={s.id} class="pair-check">
                    <input type="checkbox" checked={grant.scopes.includes(s.id)} onChange={(e) => toggle(s.id, (e.target as HTMLInputElement).checked)} />
                    <span><b>{s.label}</b>{s.detail ? <span class="pair-hint"> {s.detail}</span> : null}</span>
                </label>
            ))}
            {!found.grantable || grant.mayPair ? (
                <label class="pair-check">
                    <input type="checkbox" checked={grant.mayPair} onChange={(e) => onChange({ ...grant, mayPair: (e.target as HTMLInputElement).checked })} />
                    <span><b>Pair other devices</b><span class="pair-hint"> It can add devices to this account by itself, without asking here.</span></span>
                </label>
            ) : null}
            {grant.mayRevoke ? <p class="pair-hint">It also signs revocations for this account: removing a device goes through it.</p> : null}
            {days > 0 ? <p class="pair-hint">Valid for {days} days, and renewed while a runtime lists it. It leaves the account only by being removed.</p> : null}
        </fieldset>
    );
}

/**
 * PAIRING A NEW DEVICE, on one that may: type its code, compare the fingerprint this device computes with the one the
 * new device shows, choose what it may do, and confirm. "They don't match" is a first-class answer, not a cancel.
 */
export function PairDevice({ api, onDone }: { api: PairingApi; onDone?: () => void }) {
    const [typed, setTyped] = useState("");
    const [found, setFound] = useState<FoundOffer | null>(null);
    const [grant, setGrant] = useState<Grant | null>(null);
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState("");
    const [outcome, setOutcome] = useState<"paired" | "refused" | null>(null);
    const look = async () => {
        setBusy(true);
        setProblem("");
        try {
            const f = await api.lookupOffer(typed);
            setFound(f);
            setGrant(f.grant);
        } catch (err) {
            setProblem(pairingProblem(err));
        } finally {
            setBusy(false);
        }
    };
    const confirm = async () => {
        if (!found || !grant) return;
        setBusy(true);
        setProblem("");
        try {
            await api.confirmOffer(found, grant);
            setOutcome("paired");
        } catch (err) {
            setProblem(pairingProblem(err));
        } finally {
            setBusy(false);
        }
    };
    const again = () => { setTyped(""); setFound(null); setGrant(null); setOutcome(null); setProblem(""); };
    if (outcome === "paired" && found) {
        return (
            <section class="pair-card" aria-label="Pair a device">
                <h3 class="pair-h">Paired</h3>
                <p class="pair-p">“{found.label}” is in the account now. It finishes joining by itself.</p>
                <div class="pair-actions"><button class="btn" onClick={again}>Pair another</button>{onDone ? <button class="btn primary" onClick={onDone}>Done</button> : null}</div>
            </section>
        );
    }
    if (outcome === "refused") {
        return (
            <section class="pair-card" aria-label="Pair a device">
                <h3 class="pair-h">Nothing was paired</h3>
                <p class="pair-p">Different fingerprints mean something between the two devices swapped the keys. On the new device, cancel and get a new code; if it happens again, the hub is not one to trust.</p>
                <div class="pair-actions"><button class="btn" onClick={again}>Start again</button></div>
            </section>
        );
    }
    if (found && grant) {
        return (
            <section class="pair-card" aria-label="Pair a device">
                <h3 class="pair-h">“{found.label}” wants to join as {roleName(found.role)}</h3>
                <p class="pair-p">Its screen shows a fingerprint. Does it match this one, every character?</p>
                <Fingerprint value={found.fingerprint} />
                <GrantEditor found={found} grant={grant} onChange={setGrant} />
                {problem ? <p class="pair-problem" role="alert">{problem}</p> : null}
                <div class="pair-actions">
                    <button class="btn" disabled={busy} onClick={() => setOutcome("refused")}>They don't match</button>
                    <button class="btn primary" disabled={busy} onClick={confirm}>{busy ? "Pairing…" : "They match: pair it"}</button>
                </div>
            </section>
        );
    }
    return (
        <section class="pair-card" aria-label="Pair a device">
            <h3 class="pair-h">Pair a device</h3>
            <p class="pair-p">On the new device, choose Join an account. Type the code it shows.</p>
            <Field label="Its code" value={typed} onInput={setTyped} placeholder="ABCD 1234" mono />
            {problem ? <p class="pair-problem" role="alert">{problem}</p> : null}
            <div class="pair-actions">
                {onDone ? <button class="btn" onClick={onDone}>Back</button> : null}
                <button class="btn primary" disabled={busy || typed.replace(/[\s-]/g, "").length < 8} onClick={look}>{busy ? "Looking…" : "Find it"}</button>
            </div>
        </section>
    );
}

/** Where the connection stands, in words, re-asked every few seconds while shown. */
function ConnectionLine({ api }: { api: PairingApi }) {
    const [c, setC] = useState<HubConnectionView | null>(null);
    useEffect(() => {
        if (!api.connection) return;
        let on = true;
        const ask = () => api.connection!().then((v) => { if (on) setC(v); }, () => {});
        void ask();
        const t = setInterval(ask, 3000);
        return () => { on = false; clearInterval(t); };
    }, [api]);
    if (!c) return null;
    const text = c.state === "online" ? `Connected${c.devices ? `, ${c.devices} device${c.devices === 1 ? "" : "s"} here now` : ", no other device here now"}`
        : c.state === "connecting" ? "Connecting…"
            : c.state === "offline" ? `Offline: ${c.reason}. Trying again in ${Math.max(1, Math.round(c.retryInMs / 1000))} s.`
                : c.state === "stopped" ? "Stopped" : "Not connected";
    return (
        <>
            <span class="pair-field-label">Connection</span>
            <span class={`pair-conn ${c.state}`} role="status"><i class="pair-conn-dot" aria-hidden="true" />{text}</span>
        </>
    );
}

/** Leaving the account, behind a second click that says what it costs. */
function LeaveAccount({ api, onLeft }: { api: PairingApi; onLeft: () => void }) {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    if (!api.leave) return null;
    if (!asking) return <button class="btn" onClick={() => setAsking(true)}>Leave this account…</button>;
    const go = async () => { setBusy(true); try { await api.leave!(); onLeft(); } finally { setBusy(false); } };
    return (
        <div class="pair-leave" role="group" aria-label="Leave this account">
            <p class="pair-p">Your devices stop reaching this browser, and it stops reaching them. Joining again needs a new code, confirmed on the account's root device.</p>
            <div class="pair-actions">
                <button class="btn" onClick={() => setAsking(false)}>Stay</button>
                <button class="btn primary" disabled={busy} onClick={go}>{busy ? "Leaving…" : "Leave"}</button>
            </div>
        </div>
    );
}

/**
 * THE ACCOUNT, as one panel: joining (or, where this device may hold a root, creating) one while it has none, and then
 * what it is on the account — its connection, pairing a device where it may, and leaving. What a surface mounts; the
 * screens above are its steps.
 */
export function AccountPanel({ api }: { api: PairingApi }) {
    const [m, setM] = useState<Membership | null | undefined>(undefined);
    const [step, setStep] = useState<"join" | "create" | "pair" | null>(null);
    useEffect(() => {
        let on = true;
        void api.load().then((v) => { if (on) setM(v); }, () => { if (on) setM(null); });
        return () => { on = false; };
    }, [api]);
    const joined = (v: Membership) => { setM(v); setStep(null); };
    if (m === undefined) return <p class="pair-hint" role="status">Reading this device's keys…</p>;
    if (!m) {
        if (step === "join") return <JoinAccount api={api} onJoined={joined} onCancel={() => setStep(null)} />;
        if (step === "create" && api.canCreate !== false) return <CreateAccount api={api} onCreated={joined} onCancel={() => setStep(null)} />;
        return (
            <section class="pair-card" aria-label="Account">
                <h3 class="pair-h">This device is in no account</h3>
                <p class="pair-p">An account is how your devices reach each other through a hub: a phone driving this browser, this browser watching a box.</p>
                {api.canCreate === false ? (
                    <p class="pair-p">This browser joins an account; it never holds one. Create it on the device you will pair others from, then join from here.</p>
                ) : null}
                <div class="pair-actions">
                    {api.canCreate !== false ? <button class="btn" onClick={() => setStep("create")}>Create an account</button> : null}
                    <button class="btn primary" onClick={() => setStep("join")}>Join an account</button>
                </div>
            </section>
        );
    }
    if (step === "pair") return <PairDevice api={api} onDone={() => setStep(null)} />;
    return (
        <div class="pair-stack">
        <section class="pair-card" aria-label="Account">
            <h3 class="pair-h">“{m.label}”, {roleName(m.role)}{m.root ? ", holding the account's root" : ""}</h3>
            <div class="pair-facts">
                <span class="pair-field-label">Hub</span><code class="pair-mono">{m.hubUrl}</code>
                <ConnectionLine api={api} />
                <span class="pair-field-label">Fingerprint</span><Fingerprint value={m.fingerprint} />
            </div>
            {m.mayPair ? null : <p class="pair-hint">Pair new devices on the one that holds the account's root.</p>}
            <ConnectionHistory api={api} />
            <div class="pair-actions">
                <LeaveAccount api={api} onLeft={() => setM(null)} />
                {m.mayPair ? <button class="btn primary" onClick={() => setStep("pair")}>Pair a device</button> : null}
            </div>
        </section>
        <DevicesList api={api} self={m.principal} />
        </div>
    );
}
