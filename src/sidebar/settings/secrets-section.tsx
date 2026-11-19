// secrets-section.tsx — the Settings "Secrets" page: the names of the values registered as secret, an add and a remove.

// SECRET_HANDLES.md, "The scrub as built": a value registered here is replaced by [REDACTED:NAME] wherever it would reach a
// script or the model. The worker answers names and a count only (`SECRET_REGISTRY`, src/sw/sw-secret-registry.ts), so
// this page never holds a value except in the input while it is typed, and clears that the moment it is sent.
import { useEffect, useState } from "preact/hooks";
import { entryRefusal, REGISTRY_MAX_ENTRIES } from "../../secret-registry";
import { cursorTipOn } from "../ui-kit";

/** What the worker's `SECRET_REGISTRY` answers (`RegistryView`, src/sw/sw-secret-registry.ts): names and a count, never a value. */
export interface SecretsView { names: string[]; count: number }
/** The storage key the entries live under, re-read on change. Defined as SECRET_REGISTRY_KEY in src/sw/sw-secret-registry.ts (worker code, not imported into this bundle). */
const SECRETS_STORAGE_KEY = "ml_secret_registry";

/**
 * Ask the worker for the registered names (`SECRET_REGISTRY`), applying an add or remove first when one is given.
 * @param payload `{}` to read, or `{ op, name, value? }` to change and read
 * @returns the view after, or `{ error }` when the worker refused, or null when it could not be asked
 */
function askSecrets(payload: Record<string, unknown>): Promise<{ view?: SecretsView; error?: string } | null> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "SECRET_REGISTRY", payload }, (res: { data?: SecretsView; error?: string } | undefined) => {
                void chrome.runtime.lastError;
                if (res?.data) resolve({ view: { names: res.data.names ?? [], count: res.data.count ?? 0 } });
                else resolve(res?.error ? { error: res.error } : null);
            });
        } catch { resolve(null); }
    });
}

/**
 * The page's body: the registered names with a remove each, the count against the cap, and the add form.
 * @gallery {"initial": {"names": ["GITHUB_TOKEN", "DB_PASSWORD"], "count": 2}}
 * @group settings
 * @param initial the view to draw without asking the worker (the gallery's); absent asks it
 */
export function SecretsSectionBody({ initial }: { initial?: SecretsView }) {
    const [view, setView] = useState<SecretsView | null>(initial ?? null);
    const [err, setErr] = useState("");
    const [name, setName] = useState("");
    const [value, setValue] = useState("");
    useEffect(() => {
        if (initial) return;
        const read = (): void => { void askSecrets({}).then((r) => { if (r?.view) setView(r.view); }); };
        read();
        const onChange = (changes: Record<string, unknown>, area?: string) => { if (area === "local" && SECRETS_STORAGE_KEY in changes) read(); };
        try { chrome.storage.onChanged.addListener(onChange); } catch { /* not an extension page */ }
        return () => { try { chrome.storage.onChanged.removeListener(onChange); } catch { /* ignore */ } };
    }, []);
    if (!view) return <div class="set-hint">Reading…</div>;
    const send = (payload: Record<string, unknown>): Promise<boolean> => askSecrets(payload).then((r) => {
        if (r?.view) { setView(r.view); setErr(""); return true; }
        setErr(r?.error ?? "The extension could not be reached.");
        return false;
    });
    const add = (): void => {
        const why = entryRefusal(view.names.map((n) => ({ name: n, value: "" })), { name, value });
        if (why) { setErr(why); setValue(""); return; }
        const sentName = name;
        const sentValue = value;
        setValue("");
        void send({ op: "add", name: sentName, value: sentValue }).then((ok) => { if (ok) setName(""); });
    };
    return (
        <>
            <div class="set-note">The secret registry: values registered here are replaced by <code>[REDACTED:NAME]</code> wherever they would reach a script or the model, so a password or token you register is not shown to either. Only the names are shown on this page. The values are stored on this computer only (<code>chrome.storage.local</code>), never synced or backed up.</div>
            {err ? <div class="set-err secrets-err">{err}</div> : null}
            <div class="set-hint secrets-count">{view.count} of {REGISTRY_MAX_ENTRIES} secrets registered.</div>
            {view.names.length ? (
                <div class="pol-rows">
                    {view.names.map((n) => (
                        <div class="pol-row secrets-row" key={n} data-secret-name={n}>
                            <div class="pol-head">
                                <span class="pol-label"><code>{n}</code></span>
                                <button class="perm-x" aria-label={`Remove the secret ${n}`} {...cursorTipOn(`Remove the secret ${n}`)} onClick={() => { void send({ op: "remove", name: n }); }}>✕</button>
                            </div>
                        </div>
                    ))}
                </div>
            ) : <div class="set-hint">No secret registered.</div>}
            <div class="pol-add secrets-add">
                <div class="set-hint">Add one. The name is A-Z, 0-9 and _, up to 40 characters; a name already registered is replaced.</div>
                <input type="text" class="secrets-name" aria-label="Secret name" placeholder="GITHUB_TOKEN" autocomplete="off" spellcheck={false} value={name} onInput={(e: any) => setName(e.target.value)} />
                <input type="password" class="secrets-value" aria-label="Secret value" placeholder="value" autocomplete="off" spellcheck={false} value={value} onInput={(e: any) => setValue(e.target.value)} />
                <button class="test-btn" onClick={add}>Add</button>
            </div>
        </>
    );
}
