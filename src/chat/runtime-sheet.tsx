// runtime-sheet.tsx — Settings → Runtimes: what each runtime this client reaches IS, read-only. What it can do, the
// models it offers and where its saved sessions' bytes go, all asked over the contract, so a phone looking at a box
// sees the same page as the browser looking at itself.
//
// READ-ONLY by design: changing a runtime's settings (its backend, its key, which models it may use) happens on that
// machine, in its own Settings, and is never a remote command (`localSettings` is local by design). What is here only
// needs `view`, which is why a watch-only client sees it too.
import { useEffect, useState } from "preact/hooks";
import type { ModelChoice, RuntimeCapabilities, RuntimeInfo } from "../session-host";
import { StorageBody } from "../sidebar/storage-section";
import { Stamp } from "../sidebar/ui-kit";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";

/** What each capability means to a person, in the order worth reading. Unknown ones are left out, not guessed at. */
const CAPS: [keyof RuntimeCapabilities, string][] = [
    ["chat", "Chats"], ["agent", "Agent runs"], ["tabs", "Its tabs"], ["screenshots", "Screenshots"],
    ["highlight", "Highlight on the page"], ["persistence", "Saved sessions"], ["sideCalls", "Titles and summaries"],
    ["resourcePanel", "Resource graphs"], ["pythonBench", "Python bench"], ["headless", "Headless runs"],
];

/** The Runtimes tab: a runtime picker when there is more than one, then that runtime. */
export function RuntimeSheet({ store }: { store: ChatStore }) {
    const runtimes = store.runtimes.value;
    const [id, setId] = useState(runtimes[0]?.id ?? "");
    const rt = runtimes.find((r) => r.id === id) ?? runtimes[0];
    if (!rt) return <p class="chat-set-lede">No runtime is connected.</p>;
    return (
        <div class="rt-sheet">
            {runtimes.length > 1 ? (
                <div class="chat-seg rt-pick" role="radiogroup" aria-label="Runtime">
                    {runtimes.map((r) => (
                        <button key={r.id} role="radio" aria-checked={r.id === rt.id} class={`chat-seg-opt${r.id === rt.id ? " on" : ""}`}
                            onClick={() => setId(r.id)}>{r.name}</button>
                    ))}
                </div>
            ) : null}
            <RuntimeFacts rt={rt} />
            <RuntimeModels key={`m${rt.id}`} store={store} rt={rt} />
            <RuntimeStorage key={`s${rt.id}`} store={store} rt={rt} />
        </div>
    );
}

/** What the runtime is and what it can do. */
function RuntimeFacts({ rt }: { rt: RuntimeInfo }) {
    const can = CAPS.filter(([k]) => rt.capabilities[k]).map(([, label]) => label);
    return (
        <section class="chat-set-group" aria-label="About this runtime">
            <div class="chat-set-row"><div class="chat-set-label"><span>Status</span></div>
                <div class="rt-val">{rt.online ? "Online" : <>Offline{rt.lastSeen ? <>, seen <Stamp ts={rt.lastSeen} /></> : null}</>}</div></div>
            <div class="chat-set-row"><div class="chat-set-label"><span>Kind</span></div><div class="rt-val">{rt.kind}</div></div>
            <div class="chat-set-row"><div class="chat-set-label"><span>Contract</span><span class="chat-set-hint">The session contract version it speaks.</span></div>
                <div class="rt-val">v{rt.contractVersion}</div></div>
            <div class="chat-set-row"><div class="chat-set-label"><span>Offers</span></div>
                <div class="rt-val rt-caps">{can.length ? can.map((c) => <span key={c} class="chat-chip">{c}</span>) : "Nothing this client knows"}</div></div>
        </section>
    );
}

/** The models the runtime offers, from `models.list`: its default marked. Read-only here. */
function RuntimeModels({ store, rt }: { store: ChatStore; rt: RuntimeInfo }) {
    const [models, setModels] = useState<ModelChoice[] | null | "unsupported">(null);
    const may = rt.online && mayCommand(rt, "models.list");
    useEffect(() => {
        if (!may) return;
        let live = true;
        void store.send({ type: "models.list", runtime: rt.id }, { quiet: true }).then((r) => { if (live) setModels(r.ok ? r.data.models : "unsupported"); });
        return () => { live = false; };
    }, [rt.id, may]);
    return (
        <section class="chat-set-group" aria-label="Models">
            <h2 class="rt-h">Models</h2>
            {!may ? <p class="chat-set-hint rt-note">{rt.online ? "This device may not list its models." : "Offline: its models are listed when it is back."}</p>
                : models === null ? <p class="chat-set-hint rt-note">Asking…</p>
                    : models === "unsupported" ? <p class="chat-set-hint rt-note">{rt.name} does not list its models.</p>
                        : !models.length ? <p class="chat-set-hint rt-note">No models: its backend did not answer, or offers none.</p>
                            : <ul class="rt-models">{models.map((m) => (
                                <li key={m.id}><code>{m.id}</code>{m.default ? <span class="chat-chip">default</span> : null}
                                    {m.kinds?.length ? <span class="rt-kinds">{m.kinds.join(" · ")}</span> : null}</li>
                            ))}</ul>}
            <p class="chat-set-hint rt-note">Which models it may use is set on that machine, in its own Settings.</p>
        </section>
    );
}

/** Where its saved sessions' bytes go: the same Storage view as the extension's, fed from `storage.stats`. */
function RuntimeStorage({ store, rt }: { store: ChatStore; rt: RuntimeInfo }) {
    const may = rt.online && mayCommand(rt, "storage.stats");
    return (
        <section class="chat-set-group" aria-label="Storage">
            <h2 class="rt-h">Storage</h2>
            {!may ? <p class="chat-set-hint rt-note">{rt.online ? "This device may not read its storage." : "Offline."}</p> : (
                <StorageBody
                    load={async () => {
                        const r = await store.send({ type: "storage.stats", runtime: rt.id }, { quiet: true });
                        // Said in this runtime's words: the view's own empty text is about "this browser".
                        if (!r.ok) throw new Error(r.error.code === "unsupported" ? `${rt.name} keeps no saved sessions.` : r.error.message || "Could not read it.");
                        return r.data;
                    }}
                    // An exact measurement reads every stored event, which only that machine can do.
                    measure={async () => null} />
            )}
        </section>
    );
}
