// answers.tsx — an interview's answers side by side (turns as rows, runs as columns), and the dialog a person marks a
// wrong line in. A mark is POSTed to the dashboard, appended to the sweep's marks.jsonl, and checked on every later run of
// that model at that turn (interview.mjs `checkMarks`); the checks come back on the run as `checks`.

import { useState, useRef } from "preact/hooks";
import type { BenchState, RunState } from "./state";
import { Outcome, runDir } from "./runs";
import { Hash } from "../../../../src/sidebar/copy-hash";

type Target = { taskId: string; who: string; turn: number; hash: string | null };

/** The text selected inside `box`, or "". */
function selectionIn(box: Element | null): string {
    const sel = window.getSelection();
    return sel && !sel.isCollapsed && box && box.contains(sel.anchorNode) ? sel.toString().trim() : "";
}

/** One answer: what the turn called, the answer itself, the marks on it, and (live) the button that adds one. */
function AnswerCell({ r, turn, base, live, onMark }: { r: RunState; turn: number; base: string; live: boolean; onMark: (t: Target, quote: string) => void }) {
    const t = r.turns?.[turn - 1];
    const txt = useRef<HTMLDivElement>(null);
    // Taken on mousedown, before the click can move the selection.
    const picked = useRef("");
    if (!t) return <div class="ans none">{r.state === "done" ? "no answer" : r.state === "running" ? "…" : "queued"}</div>;
    const dir = runDir(r, base);
    const who = [r.taskId, r.who, `turn ${turn}`, r.hash].filter(Boolean).join(" · ");
    return (
        <div class="ans">
            <div class="meta">
                <span>{t.tools.length} call{t.tools.length === 1 ? "" : "s"}{t.tools.length ? `: ${t.tools.join(", ")}` : ""}</span>
                {t.capped ? <span class="badge warn">step cap</span> : null}
                <span class="sp" />
                {dir ? <><a class="view" href={`${dir}/run.md.html`} data-title={who}>run</a><a class="view" href={`${dir}/outbox/turn-${turn}.md`} data-title={who}>turn</a></> : null}
                {live && r.state === "done"
                    ? <button class="btn small danger" onMouseDown={() => { picked.current = selectionIn(txt.current); }}
                        onClick={() => onMark({ taskId: r.taskId, who: r.who, turn, hash: r.hash ?? null }, picked.current)}>mark wrong</button>
                    : null}
            </div>
            <div class="txt" ref={txt}>{t.answer || "(no answer)"}</div>
            {(r.checks || []).filter((c) => c.turn === turn && c.still != null).map((c) => (
                <div key={c.id} class={`flag ${c.here ? "here" : c.still ? "still" : "gone"}`}>
                    <b>{c.here ? "marked wrong" : c.still ? "still says a line marked wrong" : "no longer says a line marked wrong"}</b>
                    {c.quote ? <q>{c.quote.slice(0, 300)}</q> : null}
                    {c.note ? <span class="dim"> — {c.note}</span> : null}
                    <span class="by" title={c.at ?? ""}>{c.by}</span>
                </div>
            ))}
        </div>
    );
}

/** The mark dialog: the quote (prefilled with the selection, editable since a check matches it verbatim) and why. */
function MarkDialog({ target, quote, onClose }: { target: Target; quote: string; onClose: () => void }) {
    const [q, setQ] = useState(quote), [note, setNote] = useState(""), [err, setErr] = useState("");
    const save = async (e: Event) => {
        e.preventDefault();
        if (!q.trim() && !note.trim()) { setErr("Quote the line, or say why."); return; }
        try {
            const res = await fetch("/mark", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...target, quote: q.trim(), note: note.trim() }) });
            if (!res.ok) throw new Error(await res.text());
            onClose();
        } catch (x) { setErr(`Not saved: ${(x as Error).message}`); }
    };
    return (
        <div class="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
            <form class="card dialog" onSubmit={save}>
                <header><h3>Mark wrong</h3><span class="sub">{target.who} · turn {target.turn}</span></header>
                <label for="mq">The wrong line <span class="dim">(the next run checks whether the answer still says it)</span></label>
                <textarea id="mq" rows={4} value={q} onInput={(e) => setQ((e.target as HTMLTextAreaElement).value)} autoFocus={!quote} />
                <label for="mn">Why it is wrong</label>
                <input id="mn" autoComplete="off" value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} autoFocus={!!quote} />
                <div class="err">{err}</div>
                <div class="actions"><button type="button" class="btn" onClick={onClose}>Cancel</button><button type="submit" class="btn primary">Mark wrong</button></div>
            </form>
        </div>
    );
}

/** Every interview of the sweep, each as a grid: a header per run, then per turn the question and each run's answer. */
export function Answers({ s, base, live }: { s: BenchState; base: string; live: boolean }) {
    const [marking, setMarking] = useState<{ target: Target; quote: string } | null>(null);
    const ivs = s.interviews || {};
    const ids = Object.keys(ivs);
    if (!ids.length) return null;
    const repeats = new Set(s.runs.map((r) => r.repeat)).size > 1;
    return (
        <section class="card">
            <header>
                <h2>Answers</h2>
                <span class="sub">{live ? "Select a line in an answer and press mark wrong; every later run of that model is checked for it." : "Each turn's answers, side by side."}</span>
            </header>
            {s.skipped?.length ? <div class="note">Skipped (failed the tool-call probe): {s.skipped.map((k) => <span key={k.model}><code>{k.model}</code> {k.why}; </span>)}</div> : null}
            {ids.map((id) => {
                const runs = s.runs.filter((r) => r.taskId === id);
                return (
                    <div key={id} class="answers">
                        {ids.length > 1 ? <h3>{id}</h3> : null}
                        <div class="agrid" style={{ gridTemplateColumns: `repeat(${runs.length}, minmax(320px, 1fr))` }}>
                            {runs.map((r) => <div key={`h${r.who}${r.repeat}`} class="ah"><code>{r.who}{repeats ? ` r${r.repeat}` : ""}</code>{r.hash ? <Hash hash={r.hash} /> : null}<Outcome r={r} /></div>)}
                            {ivs[id].map((q, n) => [
                                <div key={`q${n}`} class="q"><span class="turn">Turn {n + 1}</span>{q.length > 600 ? `${q.slice(0, 600)} …` : q}</div>,
                                ...runs.map((r) => <AnswerCell key={`a${n}${r.who}${r.repeat}`} r={r} turn={n + 1} base={base} live={live} onMark={(target, quote) => setMarking({ target, quote })} />),
                            ])}
                        </div>
                    </div>
                );
            })}
            {marking ? <MarkDialog target={marking.target} quote={marking.quote} onClose={() => setMarking(null)} /> : null}
        </section>
    );
}
