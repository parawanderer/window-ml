// blank-start-dialog.tsx — WHAT TO DO when a new-tab run cannot start, drawn from the state blank-start.ts read.
//
// It opens from the start page and never on its own: it is the answer to an action, not an interruption. Each of its
// shapes offers only routes that actually work from HERE — a permission prompt where this device is the runtime, the
// sites another machine already holds where it is not, and words to carry over when it holds none.

import { useState } from "preact/hooks";
import { Dialog } from "./dialog";
import { IconGlobe } from "../sidebar/icons";
import { originPattern, type BlankStartState } from "./blank-start";

/** The dialog. `onUrl` sets the page this start will use; `onTabs` sends the chooser back to the tab picker. */
export function BlankStartDialog({ state, onClose, onUrl, onTabs, grant }: {
    state: Exclude<BlankStartState, { kind: "ok" }>;
    onClose: () => void;
    onUrl: (url: string) => void;
    onTabs: () => void;
    /** raises the permission prompt; present only where this device is the runtime */
    grant?: (origin: string) => Promise<boolean>;
}) {
    const [typed, setTyped] = useState("");
    const [busy, setBusy] = useState(false);
    const [refused, setRefused] = useState(false);

    const ask = async () => {
        if (!grant || busy) return;
        setBusy(true);
        // The browser says nothing when someone dismisses the prompt, so a refusal is read as "still blocked" and
        // said once rather than left as a button that appears to have done nothing.
        try { if (!(await grant(originPattern(state.url)))) setRefused(true); else onClose(); }
        finally { setBusy(false); }
    };

    return (
        <Dialog onClose={onClose} labelledBy="bs-title" describedBy="bs-why">
            <h2 id="bs-title">A new tab needs permission</h2>
            <p id="bs-why">
                A run on a new tab opens <code class="chat-bs-url">{state.url}</code>, and
                {state.kind === "grantable" ? " this browser is not allowed to run there yet." : ` ${state.runtime} is not allowed to run there.`}
            </p>

            {state.kind === "grantable" ? (
                <>
                    <p class="chat-bs-note">It asks for that one site, not for every site.</p>
                    {refused ? <p class="chat-bs-refused" role="status">Still blocked — the prompt was dismissed or refused.</p> : null}
                    <div class="chat-dialog-actions spread">
                        <button class="btn" onClick={onTabs}>Use one of my tabs</button>
                        <button class="btn" onClick={onClose}>Cancel</button>
                        <button class="btn primary" disabled={busy} onClick={() => void ask()}>{busy ? "Asking…" : "Grant access"}</button>
                    </div>
                </>
            ) : null}

            {state.kind === "propose" ? (
                <>
                    {/* The only route that works from here: nothing on this device can grant a permission on another
                        machine, so what that machine ALREADY holds is the useful answer. */}
                    <p class="chat-bs-note">{state.runtime} can already open these, so a run can start on one of them:</p>
                    <ul class="chat-bs-choices">
                        {state.choices.map((c) => (
                            <li key={c.origin}><button class="btn" onClick={() => { onUrl(c.url); onClose(); }}><IconGlobe />{c.url}</button></li>
                        ))}
                    </ul>
                    <div class="chat-dialog-actions spread">
                        <button class="btn" onClick={onTabs}>Use one of its tabs</button>
                        <button class="btn" onClick={onClose}>Cancel</button>
                    </div>
                </>
            ) : null}

            {state.kind === "elsewhere" ? (
                <>
                    {/* Nothing here can fix it and the machine holds no other site, so the honest offer is the words
                        to carry over — in THAT machine's browser, not the one this is being read in. */}
                    <p class="chat-bs-note">This has to be changed on {state.runtime}:</p>
                    <p class="chat-bs-steps">{state.steps}</p>
                    <label class="chat-bs-field"><span>Or start somewhere {state.runtime} can already open</span>
                        <input class="chat-dialog-field" type="url" value={typed} placeholder="https://…" onInput={(e: any) => setTyped(e.target.value)} />
                    </label>
                    <div class="chat-dialog-actions spread">
                        <button class="btn" onClick={onTabs}>Use one of its tabs</button>
                        <button class="btn" onClick={onClose}>Cancel</button>
                        <button class="btn primary" disabled={!/^https?:\/\//i.test(typed.trim())}
                            onClick={() => { onUrl(typed.trim()); onClose(); }}>Use this page</button>
                    </div>
                </>
            ) : null}
        </Dialog>
    );
}
