// spec.tsx — the Spec card: which version of the spec this sweep ran, who started it, and its diff against the sweep
// before. An agent iterating on the bench edits the bench itself; a reader comparing two sweeps sees here whether the
// question changed, not only the answers. The data is sweeps.mjs `specProvenance`, the same as spec.md.

import { Tip } from "../../../../src/sidebar/help-tip";
import type { BenchState, SpecState } from "./state";

const when = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? iso : d.toLocaleString(); };

/** A diff's rows: +/- lines, and a gap for a run of unchanged ones. */
function DiffRows({ rows }: { rows: NonNullable<SpecState["diff"]> }) {
    return (
        <pre class="sdiff">
            {rows.map((r, i) => r.kind === "gap"
                ? <span key={i} class="gap">{`⋯ ${r.skipped} unchanged line${r.skipped === 1 ? "" : "s"}`}</span>
                : <span key={i} class={r.kind}>{r.kind === "add" ? "+ " : r.kind === "del" ? "- " : "  "}{r.text}</span>)}
        </pre>
    );
}

export function SpecCard({ s }: { s: BenchState }) {
    const p = s.spec;
    if (!p) return null;
    const prev = p.previous;
    return (
        <section class="card spec" id="spec">
            <header>
                <h2><Tip tip="Which version of the spec this sweep ran, who started it, and what changed since the sweep before. Also in spec.md; every sweep is in sweeps.jsonl.">Spec</Tip></h2>
            </header>
            <dl class="kv">
                <dt><Tip tip="The spec file this sweep ran, and a hash of its text: the same hash is the same question.">file</Tip></dt><dd><code>{p.spec}</code> <span class="badge">spec {p.specHash}</span></dd>
                <dt><Tip tip="Who started the sweep: BENCH_BY when it was set, else &quot;command line&quot;.">started by</Tip></dt><dd>{p.by} <span class="dim">· {when(p.at)}</span></dd>
                <dt><Tip tip="The commit the extension was built from, plus a hash of any uncommitted changes. Runs are cached per build.">build</Tip></dt><dd><code>{p.fingerprint}</code>{p.dirty ? <span class="badge warn">uncommitted changes</span> : null}</dd>
                <dt><Tip tip="Whether the spec text differs from the previous sweep's in this directory.">since last</Tip></dt>
                <dd>{!prev ? <span class="dim">the first sweep recorded here</span>
                    : !p.changed ? <><span class="badge ok">unchanged</span> <span class="dim">since {prev.by}'s sweep, {when(prev.at)}</span></>
                    : <><span class="badge warn">changed</span> <span class="dim">since {prev.by}'s sweep, {when(prev.at)} (spec {prev.specHash})
                        {p.stat ? `: ${p.stat.added} line${p.stat.added === 1 ? "" : "s"} added, ${p.stat.removed} removed` : ": too long to diff"}</span></>}</dd>
            </dl>
            {p.diff ? <details open><summary>What changed</summary><DiffRows rows={p.diff} /></details> : null}
            {p.history.length > 1 ? (
                <details><summary>Every sweep ({p.history.length})</summary>
                    <div class="hscroll"><table class="hist"><thead><tr><th>started</th><th>by</th><th>spec</th><th>build</th></tr></thead>
                        <tbody>{p.history.slice().reverse().map((h, i) => (
                            <tr key={i}><td>{when(h.at)}</td><td>{h.by}</td><td><code>{h.specHash}</code></td><td><code>{h.fingerprint}</code>{h.dirty ? " (dirty)" : ""}</td></tr>
                        ))}</tbody></table></div>
                </details>
            ) : null}
            <details><summary>The spec as it ran</summary><pre class="ssrc">{p.source}</pre></details>
        </section>
    );
}
