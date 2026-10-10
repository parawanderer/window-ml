// memory.tsx — the Memory card: what the bench holds in this machine's memory against its budget (memory-budget.mjs),
// the runs held open grouped by model · task · failure with a command to paste for each action (hold-menu.mjs), and the
// runs the budget turned away. The same menu prints in the terminal when a sweep ends or pauses.

import type { MemoryState } from "./state";

const GB = 1024 ** 3;
const fmt = (b?: number | null) => (b == null ? "?" : b >= GB ? `${(b / GB).toFixed(1)} GB` : `${Math.round(b / 1024 ** 2)} MB`);
const KIND: Record<string, string> = { held: "held runs", running: "running cells (own process)", runner: "this sweep (runner, its in-process browsers, the page)", page: "page servers" };

/** One command, selectable as a whole. */
const Cmd = ({ label, cmd }: { label: string; cmd: string }) => <div class="mcmd"><span class="dim">{label}</span><code>{cmd}</code></div>;

export function MemoryCard({ m }: { m?: MemoryState | null }) {
    if (!m || (!m.active && !m.groups.length)) return null;
    const pct = Math.min(100, Math.round((m.used / m.limit) * 100));
    return (
        <section class="card memory" id="memory">
            <header><h2 class="tt" data-tip="Everything the bench keeps in this machine's memory, from every bench process here (the shared ledger, ~/.cache/window-ml-bench/ledger.json): each process tree's resident memory, summed. Shared pages count once per process, so this over-states, the safe side.">Memory</h2>
                <span class="sub">{fmt(m.used)} of a {fmt(m.limit)} limit · {fmt(m.available)} available, {fmt(m.reserve)} kept free · room for {fmt(m.room)}</span></header>
            {m.paused ? <div class="mpaused">Paused at the memory budget: {m.paused}. Resume with <code>{m.resume}</code></div> : null}
            <div class="bar"><i style={{ width: `${pct}%` }} /></div>
            <ul class="mkinds">{Object.entries(m.byKind).map(([k, v]) => <li key={k}>{KIND[k] ?? k}: <b>{fmt(v)}</b>{k === "runner" && m.runner?.heap ? <span class="dim"> (node heap {fmt(m.runner.heap)})</span> : null}</li>)}</ul>
            {m.groups.length ? <>
                <h3>Held open, by model · task · failure</h3>
                {m.groups.map((g) => (
                    <div class="mgroup" key={g.key}>
                        <div><b>{g.count} ×</b> {g.key} <span class="dim">({fmt(g.rss)}{g.sweeps.length ? `, ${g.sweeps.join(", ")}` : ""})</span></div>
                        <Cmd label="attach to one" cmd={g.commands.attach} />
                        {g.commands.keepOne ? <Cmd label="keep one, release the rest" cmd={g.commands.keepOne} /> : null}
                        <Cmd label={g.count === 1 ? "release it" : `release all ${g.count}`} cmd={g.commands.release} />
                    </div>
                ))}
                <ul class="mhints">{m.hints.map((h) => <li key={h}>{h}</li>)}</ul>
            </> : null}
            {m.wouldHold.length ? <>
                <h3>Not held: the budget had no room</h3>
                <ul>{m.wouldHold.map((w) => <li key={w.dir}>{w.cell} <span class="dim">({w.failure})</span></li>)}</ul>
            </> : null}
        </section>
    );
}
