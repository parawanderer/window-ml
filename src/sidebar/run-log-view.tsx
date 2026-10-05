// run-log-view.tsx — the EXECUTION LOG panel: what the machinery did underneath the run being read (run-log.ts),
// one line per record, in the same output cell the housekeeping log renders into.
//
// It renders through `housekeepingText` rather than a second formatter, which is the whole reason the record
// shape was reused: a run-log record IS a housekeeping event plus a `run`, so the cell's timestamp gutter, find,
// resize grip and tail-follow come along and there is one place a record's line is decided.
//
// It follows whatever session is open. The question it answers — "what happened under THIS" — is always about
// what is being read, so there is no run picker; the count of other runs holding records is there only so an
// empty panel can be told from a broken one.
import { useEffect, useState } from "preact/hooks";
import { OutputCell, TimedOutput } from "./render-panel";
import { housekeepingText, subsystemCounts } from "./housekeeping-log";
import { downloadBlob } from "./download";
import { exportSessionJson } from "./export";
import { RUN_LOG_KEY, type RunLogEvent } from "../run-log";
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
        const ask = (clear?: true) => chrome.runtime.sendMessage({ type: "DUMP_RUN_LOG", payload: { ...(run ? { run } : {}), ...(clear ? { clear: true } : {}) } },
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
    const toggle = (s: string) => setHidden((h) => { const n = new Set(h); if (n.has(s)) n.delete(s); else n.add(s); return n; });
    const clear = () => chrome.runtime.sendMessage({ type: "DUMP_RUN_LOG", payload: { ...(run ? { run } : {}), clear: true } }, () => { void chrome.runtime.lastError; });
    // The RECORDS, not the rendered lines: they are structured for the same reason they are stored that way, and
    // a consumer of the rendered text would be parsing a layout.
    const download = () => downloadBlob(`ml-run-log-${run || "all"}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        new Blob([JSON.stringify(all, null, 1)], { type: "application/json" }));
    const elsewhere = (dump?.runs || []).filter((r) => r.run !== run);

    return (
        <div class="hk-view">
            <div class="hk-bar">
                {counts.length > 1 ? (
                    <div class="rc-lane-filter">
                        {counts.map(([s, n]) => (
                            <button class={`rc-lane-chip${hidden.has(s) ? " off" : ""}`} key={s} aria-pressed={!hidden.has(s)}
                                aria-label={hidden.has(s) ? `Show ${s}` : `Hide ${s}`} onClick={() => toggle(s)}>{s} {n}</button>
                        ))}
                    </div>
                ) : null}
                <span class="hk-count">{error ? "unavailable" : dump == null ? "loading…" : `${all.length} record${all.length === 1 ? "" : "s"}`}</span>
                <span class="sp" />
                <button class="raw-btn tt" onClick={download} disabled={!all.length}>
                    download<span class="tt-pop left" role="tooltip">The records themselves, as JSON — structured, not these rendered lines</span>
                </button>
                {/* The run's whole timeline is `run.json`, which already carries `session.events` — the file this
                    panel's own question ("where did the time go") belongs to. A fifth artifact that was almost
                    that file is how the "which one to reach for" table stops working. */}
                <button class="raw-btn tt" onClick={() => run && exportSessionJson(run)} disabled={!run}>
                    all events<span class="tt-pop left" role="tooltip">The whole run as <code>run.json</code>: every step, and the timeline the resource panel draws</span>
                </button>
                <button class="raw-btn" onClick={clear} disabled={!all.length}>clear</button>
            </div>
            <div class="hint hk-about">
                What the machinery did under this run, which its steps cannot say: a tab the browser discarded and we
                reloaded, a debugger attach that was refused. Kept until the browser restarts.
            </div>
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
