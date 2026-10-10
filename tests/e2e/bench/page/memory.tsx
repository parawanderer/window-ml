// memory.tsx — the Memory card: what the bench holds in this machine's memory against its budget (memory-budget.mjs),
// the runs held open grouped by model · task · failure with a command to paste for each action (hold-menu.mjs), and the
// runs the budget turned away. The same menu prints in the terminal when a sweep ends or pauses.

import { useState } from "preact/hooks";
import type { MemoryState } from "./state";
import { CopyableCode } from "../../../../src/sidebar/code-block";
import { TimeChart } from "../../../../src/sidebar/settings/time-chart";
import { Card } from "../../../../src/sidebar/fold-card";

const GB = 1024 ** 3;
const fmt = (b?: number | null) => (b == null ? "?" : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const KIND: Record<string, string> = { held: "held runs", running: "running cells (own process)", runner: "this sweep (runner, its in-process browsers, the page)", page: "page servers" };

/** The chart's series, bottom first: the bench's own processes, then the cells running, then the runs held open. */
const SERIES = [
    { key: "runner", label: "the bench (runners)", cls: "mem-runner" },
    { key: "page", label: "page servers", cls: "mem-page" },
    { key: "running", label: "running cells", cls: "mem-running" },
    { key: "held", label: "held runs", cls: "mem-held" },
];
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** What the bench held over the sweep, stacked by kind, with the limit under it. */
function MemoryChart({ m }: { m: MemoryState }) {
    const h = m.history ?? [];
    if (h.length < 2) return null;
    const peak = Math.max(...h.map((p) => Object.values(p.values).reduce((a, b) => a + b, 0)));
    return <TimeChart series={SERIES} format={fmt} formatTime={clock} points={h} height={70}
        label={`What the bench held from ${clock(h[0].t)} to ${clock(h.at(-1)!.t)}, peaking at ${fmt(peak)} of a ${fmt(m.limit)} limit`}
        axis={<><span>{clock(h[0].t)}</span><span>{fmt(peak)} peak of {fmt(m.limit)}</span><span>{clock(h.at(-1)!.t)}</span></>} />;
}

/** Where the limit came from, in words (memory-budget.mjs `limitWhence`). */
export const limitWhence = (m: Pick<MemoryState, "limitSource" | "limitBy" | "limitAt">) =>
    m.limitSource === "flag" ? "this sweep's --memory-limit" : m.limitSource === "machine"
        ? `set machine-wide${m.limitBy ? ` by ${m.limitBy}` : ""}${m.limitAt ? ` at ${m.limitAt.slice(0, 16).replace("T", " ")} UTC` : ""}`
        : "half the RAM, the default";

/**
 * The machine-wide limit, changed from the page (POST /memory-limit): every running sweep takes it up within 5 s. A
 * sweep started with its own --memory-limit keeps that, so the control says so instead.
 */
function LimitControl({ m }: { m: MemoryState }) {
    const [value, setValue] = useState("");
    const [said, setSaid] = useState<string | null>(null);
    const send = async (limit: string) => {
        try {
            const r = await fetch("/memory-limit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit }) });
            setSaid(r.ok ? `Set: ${(await r.json()).text}. Running sweeps take it up within 5 s.` : `Not set: ${await r.text()}`);
        } catch (e) { setSaid(`Not set: ${String(e)}`); }
    };
    if (m.limitSource === "flag") return <div class="mlimit dim">This sweep was started with --memory-limit, which wins over the machine-wide limit.</div>;
    return (
        <form class="mlimit" onSubmit={(e) => { e.preventDefault(); if (value.trim()) send(value.trim()); }}>
            <span class="tt" data-tip="The most the bench may hold on this machine, for every bench process here. Raise it to hold more failed runs (past the free RAM it swaps and runs slower); lower it and nothing running stops, but nothing more starts or is held past it. Also: hold.mjs --limit 12G">Machine-wide limit</span>
            <input type="text" size={6} placeholder={`${Math.round(m.limit / GB)}G`} value={value} onInput={(e) => setValue((e.target as HTMLInputElement).value)} aria-label="memory limit, e.g. 12G" />
            <button class="btn small" type="submit">set</button>
            {m.limitSource === "machine" ? <button class="btn small" type="button" onClick={() => send("auto")}>back to half the RAM</button> : null}
            {said ? <span class="dim">{said}</span> : null}
        </form>
    );
}

/** One command: what it does, then the line to paste, as a code block with a copy button. */
const Cmd = ({ label, cmd }: { label: string; cmd: string }) => <div class="mcmd"><span class="dim">{label}</span><CopyableCode text={cmd} /></div>;

export function MemoryCard({ m, live = false }: { m?: MemoryState | null; live?: boolean }) {
    if (!m || (!m.active && !m.groups.length)) return null;
    const pct = Math.min(100, Math.round((m.used / m.limit) * 100));
    return (
        <Card id="memory" anchor label="the memory budget" class="memory">
            <header><h2 class="tt" data-tip="Everything the bench keeps in this machine's memory, from every bench process here (the shared ledger, ~/.cache/window-ml-bench/ledger.json): each process tree's resident memory, summed. Shared pages count once per process, so this over-states, the safe side.">Memory</h2>
                <span class="sub">{fmt(m.used)} of a {fmt(m.limit)} limit ({limitWhence(m)}) · {fmt(m.available)} available{m.reserve ? `, ${fmt(m.reserve)} kept free` : ", no reserve (a limit set by hand)"} · room for {fmt(m.room)}</span></header>
            {live ? <LimitControl m={m} /> : null}
            {m.paused ? <div class="mpaused">Paused at the memory budget: {m.paused}. Resume with:<CopyableCode text={m.resume} /></div> : null}
            <div class="bar"><i style={{ width: `${pct}%` }} /></div>
            <MemoryChart m={m} />
            <ul class="mkinds">{Object.entries(m.byKind).map(([k, v]) => <li key={k}>{KIND[k] ?? k}: <b>{fmt(v)}</b>{k === "runner" && m.runner?.heap ? <span class="dim"> (node heap {fmt(m.runner.heap)})</span> : null}</li>)}</ul>
            {m.groups.length ? <>
                <h3>Held open, by model · task · failure</h3>
                {m.groups.map((g) => (
                    // Each group folds to its line (remembered in this browser), so the ones dealt with get out of the way.
                    <Card key={g.key} id={`memory-group:${g.key}`} label={`${g.count} × ${g.key}`} class="mgroup">
                        <header><b>{g.count} ×</b> {g.key} <span class="dim">({fmt(g.rss)}{g.sweeps.length ? `, ${g.sweeps.join(", ")}` : ""})</span></header>
                        <Cmd label="attach to one" cmd={g.commands.attach} />
                        {g.commands.keepOne ? <Cmd label="keep one, release the rest" cmd={g.commands.keepOne} /> : null}
                        <Cmd label={g.count === 1 ? "release it" : `release all ${g.count}`} cmd={g.commands.release} />
                    </Card>
                ))}
                <ul class="mhints">{m.hints.map((h) => <li key={h}>{h}</li>)}</ul>
            </> : null}
            {m.wouldHold.length ? <>
                <h3>Not held: the budget had no room</h3>
                <ul>{m.wouldHold.map((w) => <li key={w.dir}>{w.cell} <span class="dim">({w.failure})</span></li>)}</ul>
            </> : null}
        </Card>
    );
}
