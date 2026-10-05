// run-log-view.tsx — the EXECUTION LOG panel: what the machinery did underneath the run being read (run-log.ts),
// one line per record, in the same output cell the housekeeping log renders into.
//
// It renders through `housekeepingText` rather than a second formatter, which is the whole reason the record
// shape was reused: a run-log record IS a housekeeping event plus a `run`, so the cell's timestamp gutter, find,
// resize grip and tail-follow come along and there is one place a record's line is decided.
//
// THE PANEL IS THE LOG, and nothing else. Its filters, its exports and its count were a toolbar and a paragraph
// sitting on top of the records, in a region whose whole width is already the scarce thing — so they are one
// menu button in the dock's own bar (`PanelHead`), and the paragraph is the TAB's tooltip. What is left is the
// records, edge to edge.
//
// It follows whatever session is open. The question it answers — "what happened under THIS" — is always about
// what is being read, so there is no run picker; the count of other runs holding records is there only so an
// empty panel can be told from a broken one.
import { useEffect, useRef, useState } from "preact/hooks";
import { OutputCell, TimedOutput } from "./render-panel";
import { housekeepingText, subsystemCounts } from "./housekeeping-log";
import { PanelHead } from "./panel-head";
import { IconMoreH } from "./icons";
import { downloadBlob } from "./download";
import { exportSessionJson } from "./export";
import { RUN_LOG_KEY, runLogDocument, type RunLogEvent } from "../run-log";
import type { RunLogDump } from "../sw-run-log";

/**
 * The EXECUTION LOG view: the mechanics under one run — a tab discarded and reloaded, a CDP attach refused, a
 * send held while the page navigated. Read on mount through the worker (which flushes what it has buffered),
 * then followed through `storage.session` changes, exactly as the housekeeping view does.
 *
 * @param run the open session's hash, which is also the run's id — null with nothing open
 */
export function RunLogView({ run }: { run: string | null }) {
    const [dump, setDump] = useState<RunLogDump | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hidden, setHidden] = useState<Set<string>>(new Set());

    useEffect(() => {
        let live = true;
        setDump(null);
        setError(null);
        const ask = () => chrome.runtime.sendMessage({ type: "DUMP_RUN_LOG", payload: { ...(run ? { run } : {}) } },
            (r: { data?: RunLogDump; error?: string } | undefined) => {
                if (!live) return;
                if (!r) setError(chrome.runtime.lastError?.message || "no answer from the service worker");
                else if (r.error) setError(r.error);
                else { setError(null); setDump(r.data || { events: [], runs: [] }); }
            });
        ask();
        // The ring arrives whole, so this re-reads rather than appending: the worker owns the trim, and a panel
        // that merged deltas itself would hold records the ring had already dropped.
        const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
            if (area === "session" && changes[RUN_LOG_KEY]) ask();
        };
        chrome.storage.onChanged.addListener(onChanged);
        return () => { live = false; chrome.storage.onChanged.removeListener(onChanged); };
    }, [run]);

    const all: RunLogEvent[] = dump?.events || [];
    const counts = subsystemCounts(all);
    // A run is normally hosted in ONE tab, so its id is the same on every line and spends the width that makes
    // a record wrap into two in a panel this narrow. Dropped from the LINES only while it is uniform — the
    // moment a run is re-filed under a new tab it differs, which is exactly when it is worth reading. The
    // download is unaffected: it carries the records.
    const tabs = new Set(all.map((e) => e.detail?.tab).filter((v) => v != null));
    const { text, marks } = housekeepingText(all, hidden, tabs.size > 1 ? new Set() : new Set(["tab"]));
    const elsewhere = (dump?.runs || []).filter((r) => r.run !== run);

    return (
        <div class="runlog">
            <PanelHead>
                <RunLogMenu run={run} records={all} counts={counts} hidden={hidden} setHidden={setHidden} />
            </PanelHead>
            {error ? <div class="hint err">could not read the log: {error}</div>
                : !run ? <div class="hint">Open a session to read what happened underneath it.</div>
                    : dump == null ? null
                        : !text ? (
                            <div class="hint">
                                {all.length ? "Every subsystem is filtered out."
                                    : "Nothing happened underneath this run — no sleeping tab, no debugger, nothing reloaded."}
                                {!all.length && elsewhere.length
                                    ? ` ${elsewhere.length} other run${elsewhere.length === 1 ? " has" : "s have"} records.`
                                    : ""}
                            </div>
                        )
                            : <OutputCell text fill><TimedOutput text={text} marks={marks} /></OutputCell>}
        </div>
    );
}

/** The panel's one control: which subsystems to show, and the three things you can do with the records. A menu
 *  rather than a row of buttons because the row was competing with the log for a width the log needs. */
function RunLogMenu({ run, records, counts, hidden, setHidden }: {
    run: string | null; records: RunLogEvent[]; counts: [string, number][];
    hidden: Set<string>; setHidden: (f: (h: Set<string>) => Set<string>) => void;
}) {
    const [open, setOpen] = useState(false);
    const wrap = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        const onDown = (e: Event) => { if (!wrap.current?.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
    }, [open]);
    const act = (fn: () => void) => () => { setOpen(false); fn(); };
    const toggle = (s: string) => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; });
    // The RECORDS, not the rendered lines: they are structured for the same reason they are stored that way, and
    // a consumer of the rendered text would be parsing a layout. Published shape, so it carries its version and
    // which run it is of: docs/spec/run-log.schema.json.
    const download = () => downloadBlob(`ml-run-log-${run || "all"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        new Blob([JSON.stringify(runLogDocument(records, run), null, 1)], { type: "application/json" }));
    const clear = () => chrome.runtime.sendMessage({ type: "DUMP_RUN_LOG", payload: { ...(run ? { run } : {}), clear: true } }, () => { void chrome.runtime.lastError; });
    const n = records.length;

    return (
        <span class="menuwrap runlog-menu" ref={wrap}>
            <button class={`tt hbtn${open ? " on" : ""}`} aria-label="Execution log options" aria-haspopup="menu" aria-expanded={open}
                onClick={() => setOpen((o) => !o)}>
                <IconMoreH />
                {/* The COUNT lives here. It is a status rather than a control, so it earned no row of its own —
                    but it is the one number someone wants at a glance, and a tooltip costs no width. */}
                {open ? null : <span class="tt-pop left" role="tooltip">Filters and exports<span class="tt-note">{n} record{n === 1 ? "" : "s"}</span></span>}
            </button>
            {open ? (
                <div class="menu" role="menu">
                    {counts.length > 1 ? (
                        <>
                            {counts.map(([s, c]) => (
                                <button class="menu-item menu-check" role="menuitemcheckbox" key={s} aria-checked={!hidden.has(s)}
                                    onClick={() => toggle(s)}>
                                    <span class="menu-tick">{hidden.has(s) ? "" : "✓"}</span>{s}<span class="menu-hint">{c}</span>
                                </button>
                            ))}
                            <div class="menu-rule" role="separator" />
                        </>
                    ) : null}
                    <button class="menu-item" role="menuitem" disabled={!n} onClick={act(download)}>
                        Download the log<span class="menu-hint">the records, as JSON</span>
                    </button>
                    {/* The run's whole timeline is `run.json`, which already carries `session.events` — the file
                        this panel's own question ("where did the time go") belongs to. A fifth artifact that was
                        almost that file is how the "which artifact to reach for" table stops working. */}
                    <button class="menu-item" role="menuitem" disabled={!run} onClick={act(() => run && exportSessionJson(run))}>
                        Export all events<span class="menu-hint">the whole run, as run.json</span>
                    </button>
                    <button class="menu-item" role="menuitem" disabled={!n} onClick={act(clear)}>
                        Clear<span class="menu-hint">{run ? "this run's records" : "every run's records"}</span>
                    </button>
                </div>
            ) : null}
        </span>
    );
}
