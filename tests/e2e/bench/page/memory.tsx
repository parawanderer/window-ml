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
const KIND: Record<string, string> = { held: "held runs", running: "running cells (own process)", runner: "this sweep (runner, its in-process browsers, the page)", page: "page servers", tool: "other bench tools (converse, observe) and their browsers" };

/** The chart's series, bottom first: the bench's own processes, then the cells running, then the runs held open. */
const SERIES = [
    { key: "runner", label: "the bench (runners)", cls: "mem-runner" },
    { key: "page", label: "page servers", cls: "mem-page" },
    { key: "tool", label: "converse, observe", cls: "mem-tool" },
    { key: "running", label: "running cells", cls: "mem-running" },
    { key: "held", label: "held runs", cls: "mem-held" },
];
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The pressure around the bench's memory: everything in use behind the stack, and two lines over it. */
const MACHINE = { key: "machine", label: "the whole machine in use", cls: "mem-machine" };
const LINES = [
    { key: "swap", label: "swap in use (the whole machine)", cls: "mem-swap" },
    { key: "out", label: "ours out of RAM (compressed or swapped)", cls: "mem-out", dashed: true },
];

/** What the bench held over the sweep, stacked by kind, inside what the whole machine had in use, with swap and our
 *  memory out of RAM as lines: resident memory alone shrinks when we are swapped out, which reads as calm. */
function MemoryChart({ m }: { m: MemoryState }) {
    const h = m.history ?? [];
    if (h.length < 2) return null;
    const ours = (p: (typeof h)[number]) => SERIES.reduce((a, s) => a + (p.values[s.key] ?? 0), 0);
    const peak = Math.max(...h.map(ours));
    const points = h.map((p) => ({ t: p.t, values: { ...p.values, machine: p.pressure?.machine ?? null, swap: p.pressure?.swap ?? null, out: p.pressure?.out ?? null } }));
    const swapPeak = Math.max(0, ...h.map((p) => p.pressure?.swap ?? 0));
    const any = h.some((p) => p.pressure);
    return <>
        <TimeChart series={SERIES} format={fmt} formatTime={clock} points={points} height={80}
            backdrop={any ? MACHINE : null} lines={any ? LINES : []}
            label={`What the bench held from ${clock(h[0].t)} to ${clock(h.at(-1)!.t)}, peaking at ${fmt(peak)} of a ${fmt(m.limit)} limit${swapPeak ? `; swap in use peaked at ${fmt(swapPeak)}` : ""}`}
            axis={<><span>{clock(h[0].t)}</span><span>{fmt(peak)} peak of {fmt(m.limit)}{swapPeak ? <> · swap up to {fmt(swapPeak)}</> : null}</span><span>{clock(h.at(-1)!.t)}</span></>} />
        {any ? <div class="mem-legend">{[MACHINE, ...LINES].map((s) => <span key={s.key}><i class={`tc-sw ${s.cls}${"dashed" in s ? " dashed" : ""}`} />{s.label}</span>)}
            <span class="dim tt" data-tip="The stack is the bench's processes' RESIDENT memory, which shrinks when they are swapped out: the dashed line is how much of theirs is out of RAM then (pages compressed or swapped to disk; macOS does not say which per process), read every 30 s.">why two?</span></div> : null}
    </>;
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

/**
 * The Memory card: what every bench process on this machine holds against the budget, over time and by kind, the
 * machine-wide limit (settable while `live`), and the held runs with their commands. Nothing when there is no budget.
 *
 *  @group bench page
 *  @gallery {"m": {"limit": 8589934592, "used": 5368709120, "byKind": {"runner": 3221225472, "tool": 1610612736, "held": 1181116006}, "available": 9448928051, "total": 17179869184, "reserve": 4294967296, "room": 2040109466, "active": true, "whenFull": "pause", "groups": [], "runner": {"rss": 3221225472, "heap": 142000000}, "limitSource": "auto", "wouldHold": [], "paused": null, "resume": "", "hints": [], "history": [{"t": 1760000000000, "values": {"runner": 2791728742, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000005000, "values": {"runner": 2853085418, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000010000, "values": {"runner": 2914442094, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000015000, "values": {"runner": 2975798769, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000020000, "values": {"runner": 3037155445, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000025000, "values": {"runner": 3098512121, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000030000, "values": {"runner": 3159868796, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000035000, "values": {"runner": 2791728742, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000040000, "values": {"runner": 2853085418, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000045000, "values": {"runner": 2914442094, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000050000, "values": {"runner": 2975798769, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000055000, "values": {"runner": 3037155445, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000060000, "values": {"runner": 3098512121, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000065000, "values": {"runner": 3159868796, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000070000, "values": {"runner": 2791728742, "tool": 0, "held": 0}, "room": 3221225472}, {"t": 1760000075000, "values": {"runner": 2853085418, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000080000, "values": {"runner": 2914442094, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000085000, "values": {"runner": 2975798769, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000090000, "values": {"runner": 3037155445, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000095000, "values": {"runner": 3098512121, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000100000, "values": {"runner": 3159868796, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000105000, "values": {"runner": 2791728742, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000110000, "values": {"runner": 2853085418, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000115000, "values": {"runner": 2914442094, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000120000, "values": {"runner": 2975798769, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000125000, "values": {"runner": 3037155445, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000130000, "values": {"runner": 3098512121, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000135000, "values": {"runner": 3159868796, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000140000, "values": {"runner": 2791728742, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000145000, "values": {"runner": 2853085418, "tool": 1610612736, "held": 0}, "room": 3221225472}, {"t": 1760000150000, "values": {"runner": 2914442094, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000155000, "values": {"runner": 2975798769, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000160000, "values": {"runner": 3037155445, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000165000, "values": {"runner": 3098512121, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000170000, "values": {"runner": 3159868796, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000175000, "values": {"runner": 2791728742, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000180000, "values": {"runner": 2853085418, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000185000, "values": {"runner": 2914442094, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000190000, "values": {"runner": 2975798769, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000195000, "values": {"runner": 3037155445, "tool": 1610612736, "held": 1181116006}, "room": 3221225472}, {"t": 1760000200000, "values": {"runner": 3098512121, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000205000, "values": {"runner": 3159868796, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000210000, "values": {"runner": 2791728742, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000215000, "values": {"runner": 2853085418, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000220000, "values": {"runner": 2914442094, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000225000, "values": {"runner": 2975798769, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000230000, "values": {"runner": 3037155445, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000235000, "values": {"runner": 3098512121, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000240000, "values": {"runner": 3159868796, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000245000, "values": {"runner": 2791728742, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000250000, "values": {"runner": 2853085418, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000255000, "values": {"runner": 2914442094, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000260000, "values": {"runner": 2975798769, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000265000, "values": {"runner": 3037155445, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000270000, "values": {"runner": 3098512121, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000275000, "values": {"runner": 3159868796, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000280000, "values": {"runner": 2791728742, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000285000, "values": {"runner": 2853085418, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000290000, "values": {"runner": 2914442094, "tool": 0, "held": 1181116006}, "room": 3221225472}, {"t": 1760000295000, "values": {"runner": 2975798769, "tool": 0, "held": 1181116006}, "room": 3221225472}]}}
 *  @gallery under pressure {"m":{"limit":8589934592,"used":4187593114,"byKind":{"runner":3113851290,"held":1181116006},"available":2040109466,"total":17179869184,"reserve":4294967296,"room":0,"active":true,"whenFull":"pause","groups":[],"runner":{"rss":3113851290,"heap":140000000},"limitSource":"auto","wouldHold":[],"paused":null,"resume":"","hints":[],"history":[{"t":1760000000000,"values":{"runner":2791728742,"tool":0,"held":0},"room":2147483648,"pressure":{"machine":11811160064,"swap":1610612736,"out":0}},{"t":1760000015000,"values":{"runner":2875614822,"tool":0,"held":0},"room":2147483648,"pressure":{"machine":11972221338,"swap":1610612736,"out":0}},{"t":1760000030000,"values":{"runner":2959500902,"tool":0,"held":0},"room":2147483648,"pressure":{"machine":12133282611,"swap":1610612736,"out":0}},{"t":1760000045000,"values":{"runner":3043386982,"tool":0,"held":0},"room":2147483648,"pressure":{"machine":12294343885,"swap":1610612736,"out":null}},{"t":1760000060000,"values":{"runner":3127273062,"tool":0,"held":0},"room":2147483648,"pressure":{"machine":12455405158,"swap":1610612736,"out":0}},{"t":1760000075000,"values":{"runner":2791728742,"tool":0,"held":0},"room":2147483648,"pressure":{"machine":12616466432,"swap":1610612736,"out":0}},{"t":1760000090000,"values":{"runner":2875614822,"tool":1610612736,"held":0},"room":2147483648,"pressure":{"machine":12777527706,"swap":1610612736,"out":0}},{"t":1760000105000,"values":{"runner":2959500902,"tool":1610612736,"held":0},"room":2147483648,"pressure":{"machine":12938588979,"swap":1610612736,"out":0}},{"t":1760000120000,"values":{"runner":3043386982,"tool":1610612736,"held":0},"room":2147483648,"pressure":{"machine":13099650253,"swap":1610612736,"out":0}},{"t":1760000135000,"values":{"runner":3127273062,"tool":1610612736,"held":0},"room":2147483648,"pressure":{"machine":13260711526,"swap":1825361101,"out":0}},{"t":1760000150000,"values":{"runner":2791728742,"tool":1610612736,"held":0},"room":2147483648,"pressure":{"machine":13421772800,"swap":2040109466,"out":0}},{"t":1760000165000,"values":{"runner":2875614822,"tool":1610612736,"held":0},"room":2147483648,"pressure":{"machine":13582834074,"swap":2254857830,"out":94371840}},{"t":1760000180000,"values":{"runner":2959500902,"tool":1610612736,"held":1181116006},"room":2147483648,"pressure":{"machine":13743895347,"swap":2469606195,"out":188743680}},{"t":1760000195000,"values":{"runner":3043386982,"tool":1610612736,"held":1181116006},"room":2147483648,"pressure":{"machine":13904956621,"swap":2684354560,"out":283115520}},{"t":1760000210000,"values":{"runner":3127273062,"tool":1610612736,"held":1181116006},"room":2147483648,"pressure":{"machine":14066017894,"swap":2899102925,"out":377487360}},{"t":1760000225000,"values":{"runner":2791728742,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":14227079168,"swap":3113851290,"out":471859200}},{"t":1760000240000,"values":{"runner":2875614822,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":14388140442,"swap":3328599654,"out":566231040}},{"t":1760000255000,"values":{"runner":2959500902,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":14549201715,"swap":3543348019,"out":660602880}},{"t":1760000270000,"values":{"runner":3043386982,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":14710262989,"swap":3758096384,"out":754974720}},{"t":1760000285000,"values":{"runner":3127273062,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":14871324262,"swap":3972844749,"out":849346560}},{"t":1760000300000,"values":{"runner":2791728742,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":15032385536,"swap":4187593114,"out":943718400}},{"t":1760000315000,"values":{"runner":2875614822,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":15193446810,"swap":4402341478,"out":1038090240}},{"t":1760000330000,"values":{"runner":2959500902,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":15354508083,"swap":4617089843,"out":1132462080}},{"t":1760000345000,"values":{"runner":3043386982,"tool":0,"held":1181116006},"room":2147483648,"pressure":{"machine":15515569357,"swap":4831838208,"out":1226833920}}]}}
 */
export function MemoryCard({ m, live = false }: { m?: MemoryState | null; live?: boolean }) {
    if (!m || (!m.active && !m.groups.length)) return null;
    const pct = Math.min(100, Math.round((m.used / m.limit) * 100));
    return (
        <Card id="memory" anchor label="the memory budget" class="memory">
            <header><h2 class="tt" data-tip="Everything the bench keeps in this machine's memory, from every bench process here (the shared ledger, ~/.cache/window-ml-bench/ledger.json): each process tree's resident memory, summed. Shared pages count once per process, so this over-states, the safe side.">Memory</h2>
                <span class="sub">{fmt(m.used)} of a {fmt(m.limit)} limit ({limitWhence(m)}) · {fmt(m.available)} available{m.reserve ? `, ${fmt(m.reserve)} kept free` : ", no reserve (a limit set by hand)"} · room for {fmt(m.room)}</span></header>
            {live ? <LimitControl m={m} /> : null}
            {m.paused ? <div class="mpaused">Paused at the memory budget: {m.paused}. Resume with:<CopyableCode text={m.resume} /></div> : null}
            {m.waiting && !m.paused ? <div class="mpaused mwaiting">{m.waiting.cell} waits for memory: {m.waiting.why}.{m.waiting.free.length ? <> The runs held earlier keep theirs until released (the sweep never releases them itself). To free some:
                {m.waiting.free.map((f, i) => <div key={i} class="mcmd"><span>{f.text}</span><CopyableCode text={f.cmd} /></div>)}</> : null}</div> : null}
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
            {m.released?.length ? <>
                <h3 class="tt" data-tip="This sweep runs with --when-full release-duplicates: when a cell could not start for memory, it released its own held duplicates (same model, task and failure), keeping the run each group's attach line names.">Released by the sweep: duplicates, one of each kept</h3>
                <ul class="mreleased">{m.released.map((r) => <li key={r.pid}>{r.cell} <span class="dim">({r.key}, {fmt(r.rss)}) so {r.for} could start</span></li>)}</ul>
            </> : null}
        </Card>
    );
}
