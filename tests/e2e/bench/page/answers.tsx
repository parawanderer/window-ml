// answers.tsx — an interview's answers side by side (turns as rows, runs as columns), and the dialog a person marks a
// wrong line in. A mark is POSTed to the dashboard, appended to the sweep's marks.jsonl, and checked on every later run of
// that model at that turn (interview.mjs `checkMarks`); the checks come back on the run as `checks`.

import { Tip } from "../../../../src/sidebar/help-tip";
import { useState, useRef } from "preact/hooks";
import type { BenchState, RunState } from "./state";
import { Outcome, HeldTag, runDir, runName } from "./runs";
import { Hash } from "../../../../src/sidebar/copy-hash";
import { FromSpec, specSource } from "./from-spec";
import { markdown } from "../../../../src/sidebar/format";
import { Card } from "../../../../src/sidebar/fold-card";

/** How answers are shown: rendered as the panel renders an answer, or the exact text the model sent. */
type Mode = "md" | "raw";
const MODE_KEY = "benchAnswerMode";
/** Remembered per browser; guarded, since a saved report opened from file:// can throw on localStorage. */
const readMode = (): Mode => { try { return localStorage.getItem(MODE_KEY) === "raw" ? "raw" : "md"; } catch { return "md"; } };

type Target = { taskId: string; who: string; turn: number; hash: string | null };

/** The text selected inside `box`, or "". */
function selectionIn(box: Element | null): string {
    const sel = window.getSelection();
    return sel && !sel.isCollapsed && box && box.contains(sel.anchorNode) ? sel.toString().trim() : "";
}

/** One answer: what the turn called, the answer itself, the marks on it, and (live) the button that adds one. */
function AnswerCell({ r, turn, base, live, mode, onMark }: { r: RunState; turn: number; base: string; live: boolean; mode: Mode; onMark: (t: Target, quote: string) => void }) {
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
                <Tip tip="The tools the model called during this turn, in order.">{t.tools.length} call{t.tools.length === 1 ? "" : "s"}{t.tools.length ? `: ${t.tools.join(", ")}` : ""}</Tip>
                {t.capped ? <span class="badge warn tt" data-tip="The turn ran out of steps before it answered: what is shown is where it stopped.">step cap</span> : null}
                {t.expect != null ? <span class={`badge tt ${t.expect ? "ok" : "bad"}`} data-tip={`${t.expect ? "As the interview expected" : "Not as the interview expected"}${t.why ? `: ${t.why}` : ""}.${t.expectError ? ` The check threw: ${t.expectError}` : ""} (its \`expect\`)`}>{t.expect ? "as expected" : "not as expected"}</span> : null}
                <span class="sp" />
                {dir ? <><a class="view tt" href={`${dir}/run.md.html`} data-title={who} data-tip="The whole run's transcript, every turn.">run</a><a class="view tt" href={`${dir}/outbox/turn-${t.n ?? turn}.md`} data-title={who} data-tip="This turn's report as the bench saved it (outbox/turn-N.md).">turn</a></> : null}
                {live && r.state === "done"
                    ? <button class="btn small danger" onMouseDown={() => { picked.current = selectionIn(txt.current); }}
                        onClick={() => onMark({ taskId: r.taskId, who: r.who, turn, hash: r.hash ?? null }, picked.current)}>mark wrong</button>
                    : null}
            </div>
            {mode === "md" && t.answer
                // The panel's renderer: it escapes the text before formatting it, so markup a model wrote is shown, never run.
                ? <div class="txt md tt from" data-tip={`What ${r.who} answered at turn ${turn}, rendered as markdown (raw: the toggle above).`} ref={txt} dangerouslySetInnerHTML={{ __html: markdown(t.answer) }} />
                : <div class="txt tt from" data-tip={`What ${r.who} answered at turn ${turn}, verbatim.`} ref={txt}>{t.answer || "(no answer)"}</div>}
            {(r.followUps || []).filter((f) => f.after === turn).map((f) => (
                <div key={`f${f.n}`} class="fup">
                    <div class="fup-q tt" data-tip={`Asked because this answer called for it (the interview's \`followUps\`): turn ${f.n} of this run, not one every model was asked.`}><span class="turn">follow-up</span>{f.ask.length > 300 ? `${f.ask.slice(0, 300)} …` : f.ask}</div>
                    {mode === "md" && f.answer
                        ? <div class="txt md" dangerouslySetInnerHTML={{ __html: markdown(f.answer) }} />
                        : <div class="txt">{f.answer || "(no answer)"}</div>}
                    {dir ? <a class="view tt" href={`${dir}/outbox/turn-${f.n}.md`} data-tip="This turn's report (outbox/turn-N.md).">turn</a> : null}
                </div>
            ))}
            {(r.checks || []).filter((c) => c.turn === turn && c.still != null).map((c) => (
                <div key={c.id} class={`flag ${c.here ? "here" : c.still ? "still" : "gone"}`}>
                    <b>{c.here ? "marked wrong" : c.still ? "still says a line marked wrong" : "no longer says a line marked wrong"}</b>
                    {c.quote ? <q>{c.quote.slice(0, 300)}</q> : null}
                    {c.note ? <span class="dim"> — {c.note}</span> : null}
                    <span class="by tt" data-tip={`Marked by ${c.by}${c.at ? ` at ${new Date(c.at).toLocaleString()}` : ""}`}>{c.by}</span>
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
    const [mode, setModeState] = useState<Mode>(readMode);
    const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* not remembered */ } };
    const ivs = s.interviews || {};
    const ids = Object.keys(ivs);
    if (!ids.length) return null;
    const repeats = new Set(s.runs.map((r) => r.repeat)).size > 1;
    return (
        <Card id="answers" label="the answers">
            <header>
                <h2><Tip tip="Each interview turn as a row, each run as a column: what every model answered to the same question. Also in summary.md.">Answers</Tip></h2>
                <span class="sub">{live ? "Select a line in an answer and press mark wrong; every later run of that model is checked for it." : ""}</span>
                <span class="seg" role="group" aria-label="how answers are shown">
                    {(["md", "raw"] as const).map((m) => <button key={m} class={`btn small tt${mode === m ? " on" : ""}`} data-tip={m === "md" ? "Answers rendered as the panel renders them." : "Answers exactly as the model sent them."} aria-pressed={mode === m} onClick={() => setMode(m)}>{m === "md" ? "markdown" : "raw"}</button>)}
                </span>
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
                                <div key={`q${n}`} class="q"><span class="turn">Turn {n + 1}</span>
                                    <FromSpec class="asked" tip={`What the bench sent each model as turn ${n + 1}, verbatim, from ${specSource(s)}.${q.length > 600 ? " Cut at 600 characters here; the whole of it is in the spec." : ""}`}>{q.length > 600 ? `${q.slice(0, 600)} …` : q}</FromSpec></div>,
                                ...runs.map((r) => <AnswerCell key={`a${n}${r.who}${r.repeat}`} r={r} turn={n + 1} base={base} live={live} mode={mode} onMark={(target, quote) => setMarking({ target, quote })} />),
                            ])}
                        </div>
                    </div>
                );
            })}
            {marking ? <MarkDialog target={marking.target} quote={marking.quote} onClose={() => setMarking(null)} /> : null}
        </Card>
    );
}

/**
 * Turns someone added to a run while it was held open after the sweep (bench/hold.mjs), per run: what was asked and what
 * came back. Its own card, apart from the interview's grid: not asked of every model, so never set side by side, and
 * never scored or checked for marks.
 */
export function Continued({ s, base }: { s: BenchState; base: string }) {
    const [mode] = useState<Mode>(readMode);
    const runs = s.runs.filter((r) => r.continued?.length);
    if (!runs.length) return null;
    const dims = s.dims || [];
    return (
        <Card id="continued" label="the continued conversations">
            <header>
                <h2><Tip tip="Turns sent to a run kept open after the sweep (`--hold`, `converse.mjs --attach`): not part of the scripted interview, so not compared across models and not scored. Each is also outbox/turn-N.md in the run's directory, listed in continued.jsonl.">Continued</Tip></h2>
                <span class="sub">after the scripted turns, on runs held open</span>
            </header>
            {runs.map((r) => {
                // AnswerCell reads a turn by its number, so the added turns sit at theirs (after the run's own).
                const at: RunState = { ...r, turns: [], checks: [] };
                for (const c of r.continued!) at.turns![c.turn - 1] = c;
                return (
                    <div key={`${r.taskId}${r.who}${r.repeat}`} class="answers continued">
                        <div class="ah"><code>{runName(r, dims)}</code>{r.hash ? <Hash hash={r.hash} /> : null}<HeldTag r={r} /></div>
                        {r.continued!.map((c) => [
                            <div key={`q${c.turn}`} class="q"><span class="turn">Turn {c.turn}</span>
                                <span class="asked tt" data-tip={`Sent to this run after the sweep${c.at ? `, ${new Date(c.at).toLocaleString()}` : ""}.`}>{c.ask.length > 600 ? `${c.ask.slice(0, 600)} …` : c.ask}</span></div>,
                            <AnswerCell key={`a${c.turn}`} r={at} turn={c.turn} base={base} live={false} mode={mode} onMark={() => {}} />,
                        ])}
                    </div>
                );
            })}
        </Card>
    );
}
