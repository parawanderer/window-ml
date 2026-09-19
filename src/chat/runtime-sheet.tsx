// runtime-sheet.tsx — Settings → Runtimes: what each runtime this client reaches IS, read-only. What it can do, the
// models it offers and where its saved sessions' bytes go, all asked over the contract, so a phone looking at a box
// sees the same page as the browser looking at itself.
//
// READ-ONLY by design: changing a runtime's settings (its backend, its key, which models it may use) happens on that
// machine, in its own Settings, and is never a remote command (`localSettings` is local by design). What is here only
// needs `view`, which is why a watch-only client sees it too.
import { useEffect, useState } from "preact/hooks";
import type { ArchiveCapability, ModelChoice, RuntimeCapabilities, RuntimeInfo } from "../session-host";
import { StorageBody } from "../sidebar/storage-section";
import { Stamp, cursorTipOn } from "../sidebar/ui-kit";
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
            {rt.capabilities.archive ? (
                <div class="chat-set-row"><div class="chat-set-label"><span>Archive folder</span><span class="chat-set-hint">Where old sessions are copied, so they outlive the browser's profile.</span></div>
                    <div class="rt-val">{folderText(rt.capabilities.archive)}</div></div>
            ) : null}
            <div class="chat-set-row"><div class="chat-set-label"><span>Offers</span></div>
                <div class="rt-val rt-caps">{can.length ? can.map((c) => <span key={c} class="chat-chip">{c}</span>) : "Nothing this client knows"}</div></div>
        </section>
    );
}

/** Past this many models the list gets a filter: a cloud gateway lists dozens. */
const MODEL_FILTER_AT = 8;

/** The archive folder's state in words. Open on the wire: a state this page does not know reads as none. */
function folderText(a: ArchiveCapability) {
    const when = a.lastSync ? <>, last written <Stamp ts={a.lastSync} /></> : null;
    switch (a.folder) {
        case "connected": return <>Connected{a.pending ? `, ${a.pending} month${a.pending === 1 ? "" : "s"} to write` : ""}{when}</>;
        case "needs-grant": return <>Needs reconnecting in that browser's Settings{a.pending ? `, ${a.pending} month${a.pending === 1 ? "" : "s"} waiting` : ""}{when}</>;
        case "unsupported": return "This browser cannot keep one";
        default: return "None picked: the archive stays inside the browser";
    }
}

/** The models the runtime offers, from `models.list`: its default marked. Read-only here. */
function RuntimeModels({ store, rt }: { store: ChatStore; rt: RuntimeInfo }) {
    const [models, setModels] = useState<ModelChoice[] | null | "unsupported">(null);
    const [filtered, setFiltered] = useState<{ hidden: number } | null>(null);
    const [q, setQ] = useState("");
    const may = rt.online && mayCommand(rt, "models.list");
    useEffect(() => {
        if (!may) return;
        let live = true;
        void store.send({ type: "models.list", runtime: rt.id }, { quiet: true }).then((r) => {
            if (!live) return;
            setModels(r.ok ? r.data.models : "unsupported");
            setFiltered(r.ok ? r.data.filtered ?? null : null);
        });
        return () => { live = false; };
    }, [rt.id, may]);
    const list = Array.isArray(models) ? models : [];
    const needle = q.trim().toLowerCase();
    // The default first, then A→Z, so a long list is scannable and the one a start uses is where the eye lands.
    const shown = list.filter((m) => !needle || m.id.toLowerCase().includes(needle))
        .sort((a, b) => Number(!!b.default) - Number(!!a.default) || a.id.localeCompare(b.id));
    return (
        <section class="chat-set-group" aria-label="Models">
            <h2 class="rt-h">Models{list.length ? <span class="rt-count">{list.length}</span> : null}
                {filtered ? (
                    <span class="rt-filtered" tabIndex={0} aria-label="The model access filter is on"
                        {...cursorTipOn(`The model access filter is on: ${filtered.hidden ? `${filtered.hidden} of this backend's models are hidden, and cannot be used from anywhere` : "every model on this backend passes it"}. It is set on that machine, in Settings → Models.`)}>ⓘ</span>
                ) : null}</h2>
            {!may ? <p class="chat-set-hint rt-note">{rt.online ? "This device may not list its models." : "Offline: its models are listed when it is back."}</p>
                : models === null ? <p class="chat-set-hint rt-note">Asking…</p>
                    : models === "unsupported" ? <p class="chat-set-hint rt-note">{rt.name} does not list its models.</p>
                        : !list.length ? <p class="chat-set-hint rt-note">No models: its backend did not answer, or offers none.</p>
                            : <>
                                {list.length > MODEL_FILTER_AT ? (
                                    <input class="tp-filter rt-filter" type="search" placeholder="Filter models" aria-label="Filter models"
                                        value={q} onInput={(e: any) => setQ(e.target.value)} />
                                ) : null}
                                <ul class="rt-models">
                                    {shown.map((m) => (
                                        <li key={m.id}><code>{m.id}</code>
                                            {m.default ? <span class="chat-chip">default</span> : null}
                                            {m.where ? <span class={`chat-chip rt-where ${m.where}`}>{m.where}</span> : null}
                                            {m.kinds?.length ? <span class="rt-kinds">{m.kinds.join(" · ")}</span> : null}</li>
                                    ))}
                                    {!shown.length ? <li class="rt-none">No model matches “{q.trim()}”.</li> : null}
                                </ul>
                            </>}
            <p class="chat-set-hint rt-note">Which models it may use is set on that machine, in its own Settings.</p>
        </section>
    );
}

/** Where its saved sessions' bytes go: the same Storage view as the extension's, fed from `storage.stats`. No
 *  "Measure exactly": that reads every stored event, which only that machine can do. */
function RuntimeStorage({ store, rt }: { store: ChatStore; rt: RuntimeInfo }) {
    const may = rt.online && mayCommand(rt, "storage.stats");
    return (
        <section class="chat-set-group" aria-label="Storage">
            <h2 class="rt-h">Storage</h2>
            {!may ? <p class="chat-set-hint rt-note">{rt.online ? "This device may not read its storage." : "Offline."}</p> : (
                <StorageBody
                    emptyText={`${rt.name} keeps no saved sessions.`}
                    load={async () => {
                        const r = await store.send({ type: "storage.stats", runtime: rt.id }, { quiet: true });
                        if (!r.ok) {
                            if (r.error.code === "unsupported") return null;
                            throw new Error(r.error.message || "Could not read it.");
                        }
                        return r.data;
                    }} />
            )}
        </section>
    );
}
