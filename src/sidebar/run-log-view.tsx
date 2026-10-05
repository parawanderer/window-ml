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
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { OutputCell, TimedOutput } from "./render-panel";
import { housekeepingText, subsystemCounts } from "./housekeeping-log";
import { PanelHead } from "./panel-head";
import { IconFilter, IconGear } from "./icons";
import { downloadBlob } from "./download";
import { exportSessionJson } from "./export";
import { RUN_LOG_KEY, runLogDocument, type RunLogEvent } from "../run-log";
import type { RunLogDump } from "../sw-run-log";

// THIS PANEL'S OWN TWO PREFERENCES. Kept in `chrome.storage.local` beside the panel's neighbours (`outMaxH` and
// the rest of Appearance do the same) rather than in the chat page's device prefs, because the view is drawn from
// `src/sidebar/` and must not reach into `src/chat/`. Module-level signals, so closing and reopening the panel
// does not forget what you set.

/** The text-size ladder, as MULTIPLES of the size this log already reads at, never absolute pixels. The log is a
 *  code block, so that size is the device's "Code size" (`--code-fs`); a second absolute size here would quietly
 *  disagree with it the first time someone changed that one, so the zoom rides on it instead. */
export const LOG_ZOOMS = [0.75, 0.85, 1, 1.15, 1.3, 1.5, 1.75] as const;
/** The rung that means "the same size as the other docked panels". */
export const LOG_ZOOM_BASE = 2;
const ZOOM_KEY = "ml_runlog_zoom", COLOUR_KEY = "ml_runlog_colour";
const zoomStep = signal<number>(LOG_ZOOM_BASE);
const colourGroups = signal<boolean>(false);
let prefsRead = false;

/** Set the log's zoom, clamped to the ladder, and remember it. */
function setZoom(step: number): void {
    const i = Math.max(0, Math.min(LOG_ZOOMS.length - 1, step));
    if (i === zoomStep.value) return;
    zoomStep.value = i;
    try { chrome.storage.local.set({ [ZOOM_KEY]: i }); } catch { /* no storage: the size still changes, it just does not stick */ }
}

/** Colour each line by its subsystem, or stop. Default OFF: the renderer is shared with the housekeeping log,
 *  and a log that started colouring itself everywhere would be a change to a surface nobody asked about. */
function setColour(on: boolean): void {
    colourGroups.value = on;
    try { chrome.storage.local.set({ [COLOUR_KEY]: on }); } catch { /* as above */ }
}

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

    useEffect(() => {
        if (prefsRead) return;
        prefsRead = true;
        try {
            chrome.storage.local.get([ZOOM_KEY, COLOUR_KEY], (d: Record<string, unknown>) => {
                const z = d?.[ZOOM_KEY];
                if (typeof z === "number" && LOG_ZOOMS[z] != null) zoomStep.value = z;
                if (d?.[COLOUR_KEY] === true) colourGroups.value = true;
            });
        } catch { /* no storage here: the defaults are the answer */ }
    }, []);

    // THE STANDARD SHORTCUT, while the log has focus. The output cell is already focusable (it owns Ctrl+F), so
    // this rides the keydown on its way out. It is prevented, which stops the BROWSER zooming the whole page —
    // that is the point: the gesture you reach for over a dense log should size the log.
    const onKey = (e: KeyboardEvent) => {
        if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
        const by = e.key === "+" || e.key === "=" ? 1 : e.key === "-" || e.key === "_" ? -1 : e.key === "0" ? 0 : null;
        if (by === null) return;
        e.preventDefault();
        setZoom(by === 0 ? LOG_ZOOM_BASE : zoomStep.value + by);
    };

    const all: RunLogEvent[] = dump?.events || [];
    const counts = subsystemCounts(all);
    // A run is normally hosted in ONE tab, so its id is the same on every line and spends the width that makes
    // a record wrap into two in a panel this narrow. Dropped from the LINES only while it is uniform — the
    // moment a run is re-filed under a new tab it differs, which is exactly when it is worth reading. The
    // download is unaffected: it carries the records.
    const tabs = new Set(all.map((e) => e.detail?.tab).filter((v) => v != null));
    const { text, marks, groups, headWidth } = housekeepingText(all, hidden, tabs.size > 1 ? new Set() : new Set(["tab"]));
    const elsewhere = (dump?.runs || []).filter((r) => r.run !== run);

    return (
        <div class="runlog" style={{ "--runlog-zoom": LOG_ZOOMS[zoomStep.value] }} onKeyDown={onKey}>
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
                            : <OutputCell text fill>
                                {/* `counts` is over EVERY record, not the shown ones, so the colours are the
                                    same whether or not a subsystem is filtered out. */}
                                <TimedOutput text={text} marks={marks}
                                    {...(colourGroups.value ? { groups, headWidth, groupKeys: counts.map(([s]) => s) } : {})} />
                            </OutputCell>}
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
                <IconGear />
                {/* The COUNT lives here. It is a status rather than a control, so it earned no row of its own —
                    but it is the one number someone wants at a glance, and a tooltip costs no width. */}
                {open ? null : <span class="tt-pop left" role="tooltip">Filters and exports<span class="tt-note">{n} record{n === 1 ? "" : "s"}</span></span>}
            </button>
            {open ? (
                <div class="menu" role="menu">
                    {counts.length > 1 ? (
                        <>
                            <div class="menu-head"><IconFilter />Filters</div>
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
                    <div class="menu-rule" role="separator" />
                    {/* Colouring is a reading aid for THIS log, and off by default — the renderer under it is the
                        housekeeping log's too, and a log that started colouring itself everywhere would be a
                        change to a surface nobody asked about. */}
                    <button class="menu-item menu-check" role="menuitemcheckbox" aria-checked={colourGroups.value}
                        onClick={() => setColour(!colourGroups.value)}>
                        <span class="menu-tick">{colourGroups.value ? "✓" : ""}</span>Colour by group
                    </button>
                    {/* A zoom, not a size: it multiplies "Panel text size", which is the page-wide knob for every
                        docked panel. The keys do the same thing and are the ones a hand already reaches for. */}
                    <div class="menu-zoom">
                        <span class="menu-zoom-lbl">Text size</span>
                        <button class="hbtn" aria-label="Smaller" disabled={zoomStep.value === 0}
                            onClick={() => setZoom(zoomStep.value - 1)}>−</button>
                        <button class="menu-zoom-now" aria-label="Reset the text size"
                            onClick={() => setZoom(LOG_ZOOM_BASE)}>{Math.round(LOG_ZOOMS[zoomStep.value] * 100)}%</button>
                        <button class="hbtn" aria-label="Bigger" disabled={zoomStep.value === LOG_ZOOMS.length - 1}
                            onClick={() => setZoom(zoomStep.value + 1)}>+</button>
                    </div>
                    <div class="menu-foot">{navigator.platform?.startsWith("Mac") ? "⌘" : "Ctrl"} + − 0 over the log</div>
                </div>
            ) : null}
        </span>
    );
}
