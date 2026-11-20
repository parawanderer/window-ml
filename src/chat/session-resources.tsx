// session-resources.tsx — the summary page's RESOURCES tab: the session's slice of the machine, and its usage over time.
//
// docs/spec/SESSION_SUMMARY.md, "Resources tab". The panel is the device's own (`ChatExtras.resourcePanel`), scoped to this
// session; below it, a chart with one mark per model call and a totals block, both read from the session's usage samples.
// A figure no call reported draws no line, never a zero. Energy is the bench lane's later work and draws nothing here.

import { useEffect, useState } from "preact/hooks";
import { CursorRule } from "../sidebar/ui-kit";
import { useTimeReadout } from "../sidebar/settings/time-chart";
import type { SessionSummary, RuntimeInfo } from "../session/session-host";
import { sessionKey } from "../session/session-host";
import type { ChatExtras } from "./extras";
import type { TokenUsage } from "../contract/contract-chat";
import type { CallCost } from "../spend/price-book";
import { rev, sessionMap } from "../sidebar/store";
import type { Session } from "../sidebar/store";
import { services } from "../sidebar/services";
import { sessionSubcall, timedUsage } from "../sidebar/transcript/usage";
import { sessionCalls, summarize, fmtMoney } from "../sidebar/transcript/spend";
import type { SpendSummary } from "../sidebar/transcript/spend";

/** One line of the usage totals block: `key` names the field (a test and a stable list key), then a label and its value. */
export interface TotalsLine { key: string; label: string; value: string }

/** What the totals block is made of; each optional member is null when no source answered it. */
export interface UsageTotals {
    calls: number;
    /** Σ promptTokens: every call is billed the whole prompt it re-sends, so this is a sum, unlike occupancy. */
    prompt: number;
    completion: number;
    /** Σ over the calls that REPORTED cachedTokens; null when none did (0 is a measurement, absent is not). */
    cached: number | null;
    reasoning: number | null;
    /** Tokens and calls of the delegated sub-calls (look, locate, verify), where the session has any. */
    sub: { tokens: number; calls: number } | null;
    /** Money, from the priced calls; null where the host cannot price at all. */
    cost: { money: number; priced: number; unpriced: number } | null;
}

/**
 * The totals of a session's usage samples, plus the sub-call tally and the spend where those answered.
 * Pure: an empty list gives zero calls, and a figure no sample carried is null, never 0.
 * @param samples one usage per model call
 * @param sub the delegated sub-call tally, or null
 * @param spend the priced calls summed, or null where the host cannot price (the web and hub chat pages)
 */
export function usageTotals(samples: readonly TokenUsage[], sub: { tokens: number; calls: number } | null, spend: SpendSummary | null): UsageTotals {
    let prompt = 0, completion = 0, cached: number | null = null, reasoning: number | null = null;
    for (const u of samples) {
        prompt += u.promptTokens || 0;
        completion += u.completionTokens || 0;
        if (typeof u.cachedTokens === "number") cached = (cached ?? 0) + u.cachedTokens;
        if (typeof u.reasoningTokens === "number") reasoning = (reasoning ?? 0) + u.reasoningTokens;
    }
    const cost = spend && (spend.reported + spend.computed > 0 || spend.unpriced > 0)
        ? { money: spend.money, priced: spend.reported + spend.computed, unpriced: spend.unpriced } : null;
    return { calls: samples.length, prompt, completion, cached, reasoning, sub, cost };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The totals as lines, each only where its source answers. An unpriced call is counted, not costed: the cost line names
 *  how many calls it covers and how many it leaves out. No calls, no lines. */
export function totalsLines(t: UsageTotals): TotalsLine[] {
    if (!t.calls) return [];
    const out: TotalsLine[] = [
        { key: "calls", label: "Model calls", value: t.calls.toLocaleString() },
        { key: "prompt", label: "Prompt tokens", value: t.prompt.toLocaleString() },
        { key: "completion", label: "Completion tokens", value: t.completion.toLocaleString() },
    ];
    if (t.cached != null) out.push({ key: "cached", label: "Cached prompt tokens", value: t.cached.toLocaleString() });
    if (t.reasoning != null) out.push({ key: "reasoning", label: "Reasoning tokens", value: t.reasoning.toLocaleString() });
    if (t.sub) out.push({ key: "sub", label: "Delegated sub-calls", value: `${t.sub.tokens.toLocaleString()} tokens in ${plural(t.sub.calls, "call")}` });
    if (t.cost) {
        const { money, priced, unpriced } = t.cost;
        if (priced > 0) out.push({ key: "cost", label: "Cost", value: `${fmtMoney(money)} over ${plural(priced, "priced call")}` });
        if (unpriced > 0) out.push({ key: "unpriced", label: "Not priced", value: `${plural(unpriced, "call")} counted above, not costed` });
    }
    return out;
}

/** The chart's viewBox: the SVG scales uniformly from it, and the reading box is laid over the plot in percent of it. */
const VB_W = 320, VB_H = 130;

/** One model call on the chart. */
export interface ChartPoint { ts: number; prompt: number; completion: number; /** reported cache hits; absent when the call did not say */ cached?: number }
/** One drawn call: its x, and the y of its prompt mark and its completion mark. */
export interface ChartMark extends ChartPoint { i: number; x: number; yPrompt: number; yCompletion: number }
/** The chart's geometry in its own pixel box. */
export interface UsageChart {
    /** "time" when every call has a stamp; otherwise the calls are spaced evenly in order, and the chart says so. */
    axis: "time" | "order";
    yMax: number;
    yTicks: { v: number; y: number }[];
    xTicks: { x: number; ts: number | null }[];
    marks: ChartMark[];
    plot: { l: number; r: number; t: number; b: number };
}

/** The smallest of 1, 2, 5 times a power of ten that is at least `v` (at least 1). */
export function niceMax(v: number): number {
    if (!(v > 1)) return 1;
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
}

/**
 * The geometry of the usage chart: one mark per call, a shared linear token axis from 0, and a time axis across the calls'
 * stamps. A call with no stamp (0 or missing) makes the whole axis ORDER, never a point drawn at 1970. One call, or all at one
 * instant, sit in the middle. Pure; the component only draws it.
 * @param points the calls, oldest first
 * @param w the box's width in px
 * @param h the box's height in px
 */
export function usageChart(points: readonly ChartPoint[], w = 320, h = 130): UsageChart {
    const plot = { l: 40, r: w - 8, t: 8, b: h - 22 };
    const timed = points.length > 0 && points.every((p) => Number.isFinite(p.ts) && p.ts > 0);
    const yMax = niceMax(Math.max(0, ...points.map((p) => Math.max(p.prompt, p.completion))));
    const y = (v: number) => plot.b - (v / yMax) * (plot.b - plot.t);
    const t0 = timed ? Math.min(...points.map((p) => p.ts)) : 0, t1 = timed ? Math.max(...points.map((p) => p.ts)) : 0;
    const mid = (plot.l + plot.r) / 2;
    const xOf = (p: ChartPoint, i: number) => {
        if (points.length < 2) return mid;
        if (!timed) return plot.l + 6 + (i / (points.length - 1)) * (plot.r - plot.l - 12);
        return t1 > t0 ? plot.l + 6 + ((p.ts - t0) / (t1 - t0)) * (plot.r - plot.l - 12) : mid;
    };
    const marks = points.map((p, i) => ({ ...p, i, x: xOf(p, i), yPrompt: y(p.prompt), yCompletion: y(p.completion) }));
    const yTicks = [0, yMax / 2, yMax].map((v) => ({ v, y: y(v) }));
    const xTicks = !points.length ? [] : timed && t1 > t0 ? [{ x: plot.l + 6, ts: t0 }, { x: plot.r - 6, ts: t1 }] : timed ? [{ x: mid, ts: t0 }] : [];
    return { axis: timed ? "time" : "order", yMax, yTicks, xTicks, marks, plot };
}

/** A token count for an axis: 1.2k, 45k, 3.4M. */
export function fmtAxisTokens(n: number): string {
    if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${+(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
    return String(n);
}

/**
 * The usage chart: one mark per model call, prompt (circle) and completion (diamond), on a shared token axis against time.
 * Shape as well as colour tells the two apart; a legend names them, and the totals block under it is the table view. Pointing at
 * the plot, or the arrow keys, reads one call (`useTimeReadout`, the reading `TimeChart` uses), with the panel's cursor tip.
 * @gallery {"points":[{"ts":1795100000000,"prompt":1200,"completion":180,"cached":0},{"ts":1795100060000,"prompt":2600,"completion":420,"cached":1100},{"ts":1795100200000,"prompt":4100,"completion":90},{"ts":1795100500000,"prompt":5200,"completion":760},{"ts":1795101400000,"prompt":9800,"completion":310}]}
 * @gallery-flow readout tests/gallery-flows/UsageChartView.mjs {"points":[{"ts":1795100000000,"prompt":1200,"completion":180,"cached":0},{"ts":1795100060000,"prompt":2600,"completion":420,"cached":1100},{"ts":1795100200000,"prompt":4100,"completion":90},{"ts":1795100500000,"prompt":5200,"completion":760},{"ts":1795101400000,"prompt":9800,"completion":310}]}
 * @group chat
 */
export function UsageChartView({ points }: { points: ChartPoint[] }) {
    const c = usageChart(points, VB_W, VB_H);
    const span = c.plot.r - c.plot.l;
    const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const when = (m: ChartMark) => (c.axis === "time" ? new Date(m.ts).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : `Call ${m.i + 1}`);
    /** The readout for call `i`: when, prompt, completion, total, and the cache hits where the call reported them. */
    const tip = (i: number) => {
        const m = c.marks[i];
        const row = (name: string, sw: string, n: number, cls = "") => <div class={`rc-tip-line${cls}`}><span class="rc-tip-name">{sw ? <i class={`tc-sw ${sw}`} /> : null}{name}</span><span>{n.toLocaleString()}</span></div>;
        return (
            <div class="tc-tip">
                <div class="tc-tip-time">{when(m)}</div>
                {row("Prompt", "sum-sw-prompt", m.prompt)}
                {row("Completion", "sum-sw-completion", m.completion)}
                {row("Total", "", m.prompt + m.completion, " tc-tip-total")}
                {m.cached != null ? row("Cached", "", m.cached) : null}
            </div>
        );
    };
    const { at, box, handlers } = useTimeReadout({ count: c.marks.length, fracOf: (i) => (c.marks[i].x - c.plot.l) / span, tip });
    const label = `Tokens per model call over time: ${points.length} call${points.length === 1 ? "" : "s"}, prompt and completion. Point at a call, or use the arrow keys, to read it.`;
    const pct = (v: number, of: number) => `${(v / of) * 100}%`;
    return (
        <figure class="sum-chart">
            <div class="sum-chart-box">
                <svg viewBox={`0 0 ${VB_W} ${VB_H}`} aria-hidden="true">
                    {c.yTicks.map((t) => (
                        <g key={t.v}>
                            <line class="sum-grid" x1={c.plot.l} x2={c.plot.r} y1={t.y} y2={t.y} />
                            <text class="sum-axis" x={c.plot.l - 4} y={t.y + 3} text-anchor="end">{fmtAxisTokens(t.v)}</text>
                        </g>
                    ))}
                    {c.xTicks.map((t, i) => (
                        <text class="sum-axis" key={i} x={t.x} y={c.plot.b + 14} text-anchor={c.xTicks.length < 2 ? "middle" : i ? "end" : "start"}>{t.ts == null ? "" : clock(t.ts)}</text>
                    ))}
                    {c.axis === "order" ? <text class="sum-axis" x={c.plot.r} y={c.plot.b + 14} text-anchor="end">in call order</text> : null}
                    {c.marks.map((m) => (
                        <g key={m.i}>
                            <circle class="sum-m-prompt" cx={m.x} cy={m.yPrompt} r="3.5" />
                            <path class="sum-m-completion" d={`M${m.x} ${m.yCompletion - 4.5} l4.5 4.5 l-4.5 4.5 l-4.5 -4.5 z`} />
                        </g>
                    ))}
                </svg>
                {/* The reading: a box exactly over the plot (percent of the viewBox), so the rule spans the plot and not the axis labels. */}
                <div class="sum-plot" ref={box} tabIndex={0} role="img" aria-label={label} {...handlers}
                    style={{ left: pct(c.plot.l, VB_W), width: pct(span, VB_W), top: pct(c.plot.t, VB_H), height: pct(c.plot.b - c.plot.t, VB_H) }}>
                    {at != null ? <CursorRule frac={(c.marks[at].x - c.plot.l) / span} snapped label={c.axis === "time" ? clock(c.marks[at].ts) : `Call ${at + 1}`} /> : null}
                </div>
            </div>
            <figcaption class="sum-legend">
                <span><i class="sum-key prompt" aria-hidden="true" />Prompt</span>
                <span><i class="sum-key completion" aria-hidden="true" />Completion</span>
            </figcaption>
        </figure>
    );
}

/** The totals block: the lines of `totalsLines`, as the summary tab draws its own.
 *  @gallery {"lines":[{"key":"calls","label":"Model calls","value":"5"},{"key":"prompt","label":"Prompt tokens","value":"22,900"},{"key":"completion","label":"Completion tokens","value":"1,760"},{"key":"cached","label":"Cached prompt tokens","value":"9,000"},{"key":"cost","label":"Cost","value":"$0.04 over 4 priced calls"},{"key":"unpriced","label":"Not priced","value":"1 call counted above, not costed"}]}
 *  @group chat */
export function UsageTotalsView({ lines }: { lines: TotalsLine[] }) {
    return <dl class="sum-lines sum-totals">{lines.map((l) => <div class="sum-line" key={l.key} data-field={l.key}><dt>{l.label}</dt><dd>{l.value}</dd></div>)}</dl>;
}

/** The priced answer for a session's calls: null where the host cannot price, undefined while asking. Reprices when the
 *  call list changes; an older answer never replaces a newer one. */
function usePriced(s: Session | undefined): CallCost[] | null | undefined {
    const [costs, setCosts] = useState<CallCost[] | null | undefined>(undefined);
    const price = services().priceCalls;
    const calls = s && price ? sessionCalls(s) : [];
    const n = calls.length;
    useEffect(() => {
        if (!price || !n) { setCosts(price ? undefined : null); return; }
        let live = true;
        void price(calls).then((c) => { if (live) setCosts(c); }, () => { if (live) setCosts(null); });
        return () => { live = false; };
    }, [s, n, price]);
    return price ? costs : null;
}

/** The session's usage over time and its totals, read from the reducer's state (`sessionMap`), which the page fills only for
 *  a session it has opened; a session it has not opened says so in one line. */
export function SessionUsage({ mapKey }: { mapKey: string }) {
    void rev.value;   // the session is mutated in place; `rev` says when
    const sess = sessionMap.get(mapKey);
    const costs = usePriced(sess);
    if (!sess) return <p class="sum-empty">This session's usage shows once the session is opened.</p>;
    const timed = timedUsage(sess);
    if (!timed.length) return <p class="sum-empty">No model call has reported usage yet.</p>;
    const spend = costs ? summarize(costs) : null;
    const totals = usageTotals(timed.map((x) => x.usage), sessionSubcall(sess), spend);
    return (
        <div class="sum-usage">
            <UsageChartView points={timed.map((x) => ({ ts: x.ts, prompt: x.usage.promptTokens || 0, completion: x.usage.completionTokens || 0, ...(typeof x.usage.cachedTokens === "number" ? { cached: x.usage.cachedTokens } : {}) }))} />
            <UsageTotalsView lines={totalsLines(totals)} />
        </div>
    );
}

/** What the tab says where no panel can be drawn, in one line and with the reason where it is known. */
export function noPanelLine(rt: RuntimeInfo, hasExtras: boolean, sidebar: boolean): string {
    if (sidebar) return "The machine's memory and GPU are in the sidebar's own resource panel.";
    if (!hasExtras || !rt.capabilities.resourcePanel) return "This runtime does not report its machine's memory and GPU.";
    return "This device cannot draw that runtime's memory and GPU.";
}

/**
 * The Resources tab: the device's resource panel scoped to this session, or the one line that says why there is none, then the
 * session's usage over time and its totals.
 * @param extras the device's own views; absent on the web build
 * @param sidebar the sidebar's dialog, where the panel is the sidebar's own and not mounted a second time
 * @param bareKeys the reducer keys sessions by bare hash (the sidebar) rather than `runtime:hash` (the chat page)
 * @gallery {"s":{"id":{"runtime":"local","hash":"a1b2c3d4"},"kind":"agent","status":"done","title":"Plot the fare prices","createdTs":1795100000000,"lastTs":1795103000000,"pendingApprovals":0,"saved":true},"rt":{"id":"local","name":"This browser","kind":"browser","online":true,"contractVersion":1,"capabilities":{},"grants":[]}}
 * @group chat
 */
export function ResourcesTab({ s, rt, extras, sidebar, bareKeys }: { s: SessionSummary; rt: RuntimeInfo; extras?: ChatExtras; sidebar?: boolean; bareKeys?: boolean }) {
    const key = sessionKey(s.id);
    const panel = !sidebar && rt.capabilities.resourcePanel ? extras?.resourcePanel?.(rt.id, key) ?? null : null;
    return (
        <div class="sum-resources">
            {panel ? <div class="sum-box">{panel}</div> : <p class="sum-empty">{noPanelLine(rt, !!extras, !!sidebar)}</p>}
            <SessionUsage mapKey={bareKeys ? s.id.hash : key} />
        </div>
    );
}
