// run-state-view.tsx — the RUN STATE panel (the state inspector's first step, docs/spec/STATE_INSPECTOR.md): what the
// run being read holds right now, member by member, as the worker's state registry declares it.
//
// It is a snapshot of something mutable, not a replay of events, so it says when it was taken and re-reads on a
// short interval while open. Every declared member is listed, including one holding nothing for this run: an absent
// row would read as "this kind of state does not exist", which is the question the panel is for.
import { useEffect, useState } from "preact/hooks";
import { JsonNode } from "./transcript/json-tree";
import { PanelHead } from "./panel-head";
import { cursorTipOn } from "./ui-kit";
import type { RunStateDump, RunStateMember } from "../sw/sw-run-state";
import type { StateEntry, StateLoss } from "../state-registry";

/** How often an open panel re-reads. A read is a message to the worker and a walk over a dozen maps: cheap. */
export const RUN_STATE_POLL_MS = 2000;

const LOSS: Record<StateLoss, string> = {
    "worker-eviction": "the service worker being stopped (it is, after ~30 s idle)",
    navigation: "the tab navigating",
    "offscreen-close": "the Python sandbox closing",
    "browser-restart": "the browser restarting",
    "turn-end": "the turn ending",
};

/** The tooltip on a member's name: what it holds, who sees it, and what empties it. */
function memberTip(m: RunStateMember) {
    const who = m.audience === "model" ? "The model can read this (ml.current)." : "Only you see this: the model is not given it.";
    const lost = m.lostOn.length ? `Lost on ${m.lostOn.map((l) => LOSS[l]).join(", or ")}.` : "Kept in storage.";
    return <>{m.describe}<span class="tt-note">{who} Scope: {m.scope}. {lost}</span></>;
}

/** One member: its name, who sees it, and what it holds for this run. */
function Member({ m, e }: { m: RunStateMember; e: StateEntry | undefined }) {
    const name = m.id.slice(m.id.indexOf(".") + 1);
    return (
        <div class={`rstate-member${e ? "" : " empty"}`} data-member={m.id}>
            <div class="rstate-name">
                <span class="rstate-key" {...cursorTipOn(memberTip(m))}>{name}</span>
                {m.audience === "human" ? <span class="rstate-aud" {...cursorTipOn("Only you see this: the model is not given it.")}>you only</span> : null}
            </div>
            {!e ? <div class="rstate-none">nothing for this run</div>
                : e.error ? <div class="hint err">could not read: {e.error}</div>
                    : <div class="rstate-val"><JsonNode v={e.value} defaultOpen={false} /></div>}
        </div>
    );
}

/**
 * The RUN STATE view for one run. Read through the worker (DUMP_RUN_STATE) on mount and every
 * {@link RUN_STATE_POLL_MS} while open.
 *
 * @param run the open session's hash, which is also the run's id; null with nothing open
 */
export function RunStateView({ run }: { run: string | null }) {
    const [dump, setDump] = useState<RunStateDump | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let live = true;
        setDump(null);
        setError(null);
        const ask = () => chrome.runtime.sendMessage({ type: "DUMP_RUN_STATE", payload: { ...(run ? { run } : {}) } },
            (r: { data?: RunStateDump; error?: string } | undefined) => {
                if (!live) return;
                if (!r) setError(chrome.runtime.lastError?.message || "no answer from the service worker");
                else if (r.error) setError(r.error);
                else { setError(null); setDump(r.data ?? null); }
            });
        ask();
        const t = setInterval(() => { if (document.visibilityState === "visible") ask(); }, RUN_STATE_POLL_MS);
        return () => { live = false; clearInterval(t); };
    }, [run]);

    const byId = new Map((dump?.entries ?? []).map((e) => [e.id, e]));
    const groups = new Map<string, RunStateMember[]>();
    for (const m of dump?.members ?? []) {
        const g = m.id.slice(0, m.id.indexOf(".")) || m.id;
        groups.set(g, [...(groups.get(g) ?? []), m]);
    }

    return (
        <div class="rstate">
            <PanelHead>
                {dump ? <span class="rstate-asof" {...cursorTipOn(`Read from the service worker every ${RUN_STATE_POLL_MS / 1000} s while this panel is open.`)}>
                    as of {new Date(dump.ts).toLocaleTimeString()}</span> : <span />}
            </PanelHead>
            {error ? <div class="hint err">could not read the run's state: {error}</div>
                : !run ? <div class="hint">Open a session to see what its run holds.</div>
                    : dump == null ? null
                        : [...groups].map(([g, ms]) => (
                            <section class="rstate-group" key={g}>
                                <h4 class="rstate-group-head">{g}</h4>
                                {ms.map((m) => <Member key={m.id} m={m} e={byId.get(m.id)} />)}
                            </section>
                        ))}
        </div>
    );
}
