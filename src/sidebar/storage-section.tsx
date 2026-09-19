// storage-section.tsx — the Settings "Storage" section: where saved sessions' bytes go now, how that grew day by day,
// which tools produce the most, and the largest sessions. What decides whether images, a tool's output or plain
// history is worth making smaller is real use over months, so this draws the history the worker records daily
// (session-storage-stats.ts) rather than one measurement.
import { useEffect, useState } from "preact/hooks";
import { formatBytes } from "../resource-model";
import type { StorageReport, StorageSnapshot, StoreBytes } from "../session-storage-stats";

/** The four parts of a snapshot, in stacking order, with the class that colours each. */
const PARTS: { key: "images" | "toolOutput" | "other" | "unmeasured"; label: string; cls: string }[] = [
    { key: "images", label: "Images", cls: "stor-img" },
    { key: "toolOutput", label: "Tool output", cls: "stor-tool" },
    { key: "other", label: "Everything else", cls: "stor-other" },
    { key: "unmeasured", label: "Not yet measured", cls: "stor-unm" },
];

/** A snapshot's `other` counts only measured sessions; unmeasured bytes sit beside it. */
const part = (s: StorageSnapshot, key: (typeof PARTS)[number]["key"]): number => s[key] ?? 0;

/** One horizontal bar, split by part, widths by share of the whole. */
function SplitBar({ s }: { s: StorageSnapshot }) {
    const total = Math.max(1, s.total);
    return (
        <div class="stor-bar" role="img" aria-label={PARTS.map((p) => `${p.label} ${formatBytes(part(s, p.key))}`).join(", ")}>
            {PARTS.map((p) => (part(s, p.key) > 0 ? <span key={p.key} class={p.cls} style={{ width: `${(part(s, p.key) / total) * 100}%` }} /> : null))}
        </div>
    );
}

/** The history as stacked areas, oldest at the left. Nothing to draw until there are two days. */
function HistoryChart({ history }: { history: StorageSnapshot[] }) {
    if (history.length < 2) return <div class="set-hint">Recorded once a day. The chart appears after the second day.</div>;
    const W = 320, H = 90;
    const max = Math.max(1, ...history.map((s) => s.total));
    const x = (i: number) => (i / (history.length - 1)) * W;
    const y = (v: number) => H - (v / max) * H;
    let below = history.map(() => 0);
    const areas = PARTS.map((p) => {
        const top = history.map((s, i) => below[i] + part(s, p.key));
        const d = `M${top.map((v, i) => `${x(i)},${y(v)}`).join("L")}L${[...below].reverse().map((v, i) => `${x(history.length - 1 - i)},${y(v)}`).join("L")}Z`;
        below = top;
        return <path key={p.key} class={p.cls} d={d} />;
    });
    const day = (t: number) => new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return (
        <div class="stor-chart">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Storage from ${day(history[0].t)} to ${day(history.at(-1)!.t)}, peaking at ${formatBytes(max)}`}>{areas}</svg>
            <div class="stor-axis"><span>{day(history[0].t)}</span><span>{formatBytes(max)} peak</span><span>{day(history.at(-1)!.t)}</span></div>
        </div>
    );
}

/**
 * The Storage section's body. `load` fetches the report; injectable so a test needs no worker. `measure` reads every
 * saved session from disk, which only this browser can do, so without it (a remote runtime) there is no button.
 * `emptyText` is what a null report says, for a runtime that is not this browser.
 */
export function StorageBody({ load, measure, emptyText = "This browser keeps no saved sessions." }: { load: () => Promise<StorageReport | null>; measure?: () => Promise<StoreBytes | null>; emptyText?: string }) {
    const [report, setReport] = useState<StorageReport | null | undefined>(undefined);
    const [exact, setExact] = useState<StoreBytes | null | "loading">(null);
    const [err, setErr] = useState("");
    useEffect(() => { load().then(setReport, (e) => { setErr(String(e?.message || e)); setReport(null); }); }, []);
    if (report === undefined) return <div class="set-hint">Reading…</div>;
    if (!report) return <div class="set-hint">{err || emptyText}</div>;
    const s = report.now;
    const tools = Object.entries(s.byTool).sort((a, b) => b[1] - a[1]).slice(0, 8);
    const toolMax = Math.max(1, ...tools.map(([, v]) => v));
    return (
        <div class="stor">
            <div class="set-field"><span>Saved sessions</span>
                <div>{formatBytes(s.total)} in {s.sessions} session{s.sessions === 1 ? "" : "s"}{s.pinned ? `, ${s.pinned} pinned` : ""}</div>
            </div>
            <SplitBar s={s} />
            <div class="stor-legend">{PARTS.map((p) => (part(s, p.key) > 0 ? <span key={p.key}><i class={p.cls} />{p.label} {formatBytes(part(s, p.key))}</span> : null))}</div>
            {report.archive ? <div class="set-hint">Archive: {report.archive.sessions} session{report.archive.sessions === 1 ? "" : "s"}, {formatBytes(report.archive.bytes)} as they were stored here, images {formatBytes(report.archive.imageBytes)} ({report.archive.images}, each stored once).</div> : null}
            {s.unmeasured > 0 ? <div class="set-hint">Sessions saved before this was recorded are not yet measured. They shrink out of the picture as retention removes them{measure ? <>, or use "Measure exactly" below</> : null}.</div> : null}

            <div class="stor-sub">Over time</div>
            <HistoryChart history={report.history} />

            {tools.length ? <>
                <div class="stor-sub">Tool output, by tool</div>
                <div class="stor-tools">{tools.map(([name, v]) => (
                    <div key={name} class="stor-toolrow"><code>{name}</code><span class="stor-toolbar"><span style={{ width: `${(v / toolMax) * 100}%` }} /></span><span>{formatBytes(v)}</span></div>
                ))}</div>
            </> : null}

            {report.largest.length ? <>
                <div class="stor-sub">Largest sessions</div>
                <div class="stor-largest">{report.largest.map((r) => (
                    <div key={r.hash} class="stor-toolrow"><span>{r.title || <code>{r.hash}</code>}{r.pinned ? " (pinned)" : ""}</span><span /><span>{formatBytes(r.bytes)}</span></div>
                ))}</div>
            </> : null}

            {measure ? <div class="set-field">
                <button class="test-btn" disabled={exact === "loading"} onClick={() => { setExact("loading"); measure().then(setExact, () => setExact(null)); }}>
                    {exact === "loading" ? "Measuring…" : "Measure exactly"}
                </button>
                <div class="set-hint">Reads every saved session from disk once. Also says how much storing each image once would save.</div>
                {exact && exact !== "loading" ? <div>{formatBytes(exact.total)} measured: images {formatBytes(exact.images)} ({exact.imageCount}), {formatBytes(exact.imagesIfDeduplicated)} if each were stored once; tool output {formatBytes(exact.toolOutput)}; everything else {formatBytes(exact.other)}.</div> : null}
            </div> : null}
        </div>
    );
}
