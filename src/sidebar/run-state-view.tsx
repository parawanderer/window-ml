// run-state-view.tsx — the RUN STATE panel (the state inspector's first step, docs/spec/STATE_INSPECTOR.md): what the
// run being read holds right now, member by member, as the worker's state registry declares it.
//
// It is a snapshot of something mutable, not a replay of events, so it says when it was taken and re-reads on a
// short interval while open. Every declared member is listed, including one holding nothing for this run: an absent
// row would read as "this kind of state does not exist", which is the question the panel is for.
import { signal } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { JsonNode, copyableValue } from "./transcript/json-tree";
import { PanelHead } from "./panel-head";
import { TipText, cursorTipOn, useCopy } from "./ui-kit";
import { IconCheck, IconChevron, IconCopy } from "./icons";
import type { RunStateDump, RunStateMember } from "../sw/sw-run-state";
import type { StateEntry, StateLoss } from "../state-registry";

/** How often an open panel re-reads. A read is a message to the worker and a walk over a dozen maps: cheap. */
export const RUN_STATE_POLL_MS = 2000;

/** What empties a member, as a short phrase for the tooltip's "lost when" row. */
const LOSS: Record<StateLoss, string> = {
    "worker-eviction": "the service worker stops (after ~30 s idle)",
    navigation: "the tab navigates",
    "offscreen-close": "the Python sandbox closes",
    "browser-restart": "the browser restarts",
    "turn-end": "the turn ends",
};

/** How long a member lives, by its scope, for the tooltip's "lives for" row. */
const SCOPE: Record<RunStateMember["scope"], string> = {
    run: "this run", session: "this session, every turn", tab: "this tab", page: "this page, until it navigates", browser: "this browser",
};

/** Which bundle holds a member, for the tooltip's "held by" row. */
const REALM: Record<RunStateMember["realm"], string> = { worker: "the service worker", page: "the page", offscreen: "the Python sandbox" };

/** Who reads a member, in a sentence: the model at a path it really has, the model not yet, or only you. */
function readerOf(m: RunStateMember): string {
    if (m.audience === "human") return "Only you see this: the model is not given it.";
    return m.exposedAs ? `The model reads this as ${m.exposedAs}.` : "Meant for the model, and not given to it yet: no ml.current path reaches it.";
}

/** A short tooltip from this pane, marked so it is drawn at the docked panels' size like the rest of the pane's tips. */
const paneTip = (text: string) => <span class="rstate-tip">{text}</span>;

/** The tooltip on a member's name: what it holds, then under a rule, one fact per row (who reads it, how long it
 *  lives, what holds it, what loses it, and its path), laid out like the resource panel's tips. */
function memberTip(m: RunStateMember) {
    const reader = m.audience === "human" ? "only you" : m.exposedAs ? "the model" : "meant for the model, not yet";
    return <span class="rstate-tip">
        {/* A declaration's sentence is written in markdown (backticked names), so it is drawn as markdown. */}
        <span class="rstate-tip-desc"><TipText md={m.describe} /></span>
        <span class="rstate-tip-sect">
            <span class="rc-tip-line"><span class="rstate-tip-k">read by</span><span>{reader}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">lives for</span><span>{SCOPE[m.scope]}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">held by</span><span>{REALM[m.realm]}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">lost when</span><span>{m.lostOn.length ? m.lostOn.map((l) => LOSS[l]).join(", or ") : "kept in storage"}</span></span>
            <span class="rc-tip-line"><span class="rstate-tip-k">path</span><code>{memberPath(m)}</code></span>
        </span>
    </span>;
}

/** The root of every member the model does not read: `inspector.<id>`. A prefix that is plainly not the model's, so the
 *  name alone says who can reach it; the read-only console will expose the same root. */
export const INSPECTOR_ROOT = "inspector";

/** The expression a member's value is reached by: where the model reads it when it does (`ml.current.messages`), and
 *  `inspector.<id>` otherwise. Its rows' "Copy path" extends it, so a copied path pastes into a watch or the console. */
export const memberPath = (m: RunStateMember): string => m.exposedAs ?? `${INSPECTOR_ROOT}.${m.id}`;

/** A member's name as the row shows it: its expression, with a root the model does not have drawn dimmed. */
function MemberName({ m }: { m: RunStateMember }) {
    if (m.exposedAs) return <>{m.exposedAs}:</>;
    return <><span class="rstate-root">{INSPECTOR_ROOT}.</span>{m.id}:</>;
}

/** The member's value, copied whole. Beside the name, because a right-click on the row is not where a hand goes first. */
function CopyValue({ v }: { v: unknown }) {
    const { copied, copy } = useCopy();
    return <button class="rstate-copy" aria-label="Copy the value" onClick={(e) => { e.stopPropagation(); copy(copyableValue(v)); }}
        {...cursorTipOn(paneTip("Copy the value. Right-click any row for its value or its path."))}>{copied ? <IconCheck /> : <IconCopy />}</button>;
}

/** One member, on ONE LINE until it is opened: its name, what it holds folded to a preview, and who sees it. */
function Member({ m, e }: { m: RunStateMember; e: StateEntry | undefined }) {
    const label = <span class="rstate-key" {...cursorTipOn(memberTip(m))}><MemberName m={m} /></span>;
    // An empty member has nothing to open: the chevron's width, kept blank, so its name lines up with the rest.
    const spacer = <span class="tri jt-tri-space" aria-hidden="true"><IconChevron /></span>;
    const chips = <span class="rstate-trail">
        {/* Only the person's own state is marked: that is a decision. A model member not given to the model yet is a
            gap that closes member by member, and its dimmed `inspector.` root and its tooltip already say so. */}
        {m.audience === "human" ? <span class="rstate-aud" {...cursorTipOn(paneTip(readerOf(m)))}>you only</span> : null}
        {/* The PAGE answered for this one, and a hostile page answers whatever it likes: said, not hidden. */}
        {m.realm === "page" || e?.realm === "page" ? <span class="rstate-aud rstate-page" {...cursorTipOn(paneTip("Reported by the page the run is on. A page can put anything here, so read it as the page's word."))}>from the page</span> : null}
        {e && !e.error ? <CopyValue v={e.value} /> : null}
    </span>;
    return (
        <div class={`rstate-member${e ? "" : " rstate-empty"}`} data-member={m.id}>
            {!e ? <div class="jt-row">{spacer}{label}<span class="rstate-none">none</span>{chips}</div>
                : e.error ? <div class="jt-row">{spacer}{label}<span class="hint err">could not read: {e.error}</span>{chips}</div>
                    : <JsonNode v={e.value} defaultOpen={false} path={memberPath(m)} label={label} trail={chips} times />}
        </div>
    );
}

/** Groups folded on this device, by name. A module signal, so closing and reopening the panel keeps them folded. */
const folded = signal<ReadonlySet<string>>(new Set());
const FOLDED_KEY = "ml_runstate_folded";
let foldedRead = false;

/** Fold or unfold a group, and remember it on this device. */
function toggleGroup(g: string): void {
    const next = new Set(folded.value);
    if (next.has(g)) next.delete(g); else next.add(g);
    folded.value = next;
    try { chrome.storage.local.set({ [FOLDED_KEY]: [...next] }); } catch { /* no storage: it still folds, it just does not stick */ }
}

/** One group of members, under a heading that folds it. Folded, it says how many members it has and how many hold
 *  something, so a folded group still answers "is anything here". */
function Group({ g, ms, byId }: { g: string; ms: RunStateMember[]; byId: Map<string, StateEntry> }) {
    const shut = folded.value.has(g);
    const holding = ms.filter((m) => byId.has(m.id)).length;
    return (
        <section class={`rstate-group${shut ? " shut" : ""}`} data-group={g}>
            <button class="rstate-group-head" aria-expanded={!shut} onClick={() => toggleGroup(g)}>
                {g}
                {/* The fold control at the END of the heading's line, where the eye goes after reading what it heads. */}
                <span class="rstate-group-end">
                    {shut ? <span class="rstate-count">{ms.length} member{ms.length === 1 ? "" : "s"} · {holding} holding something</span> : null}
                    <span class={`tri${shut ? "" : " open"}`} aria-hidden="true"><IconChevron /></span>
                </span>
            </button>
            {shut ? null : ms.map((m) => <Member key={m.id} m={m} e={byId.get(m.id)} />)}
        </section>
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

    useEffect(() => {
        if (foldedRead) return;
        foldedRead = true;
        try {
            chrome.storage.local.get([FOLDED_KEY], (d: Record<string, unknown>) => {
                const v = d?.[FOLDED_KEY];
                if (Array.isArray(v)) folded.value = new Set(v.filter((x): x is string => typeof x === "string"));
            });
        } catch { /* no storage here: nothing is folded */ }
    }, []);

    const byId = new Map((dump?.entries ?? []).map((e) => [e.id, e]));
    // NOTHING LIVE: the session is open, but nothing this browser holds IN MEMORY is about its run. Records kept in
    // storage (its execution log) and its name do not count: they outlive the run by design. Said in a sentence, because
    // a column of "none" reads the same as a panel that cannot see the run at all.
    const inMemory = (e: StateEntry) => e.id !== "session.title" && e.lostOn.some((l) => l !== "browser-restart");
    const nothingLive = !!run && !!dump && !dump.pageError && !(dump.entries ?? []).some(inMemory);
    const groups = new Map<string, RunStateMember[]>();
    for (const m of dump?.members ?? []) {
        const g = m.id.slice(0, m.id.indexOf(".")) || m.id;
        groups.set(g, [...(groups.get(g) ?? []), m]);
    }

    return (
        <div class="rstate">
            <PanelHead>
                {dump ? <span class="rstate-asof" {...cursorTipOn(paneTip(`Read from the service worker, and from the page the run is on, every ${RUN_STATE_POLL_MS / 1000} s while this panel is open.`))}>
                    as of {new Date(dump.ts).toLocaleTimeString()}</span> : <span />}
            </PanelHead>
            {error ? <div class="hint err">could not read the run's state: {error}</div>
                : !run ? <div class="hint">Open a session to see what its run holds.</div>
                    : dump == null ? null
                        : [...(dump.pageError ? [<div class="hint" key="page-error">The page's own state (its answer, its <code>@pt</code>/<code>@box</code> tokens) is not shown: {dump.pageError}.</div>] : []),
                            ...(nothingLive ? [<div class="hint rstate-idle" key="idle">This browser holds nothing live for this session. Its run has
                                ended and the service worker has restarted since, or it was a chat rather than an agent run. What the session kept is
                                its transcript and its execution log.</div>] : []),
                            ...[...groups].map(([g, ms]) => <Group key={g} g={g} ms={ms} byId={byId} />)]}
        </div>
    );
}
