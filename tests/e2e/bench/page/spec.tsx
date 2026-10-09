// spec.tsx — the Spec card: which version of the spec this sweep ran, who started it, and its diff against the sweep
// before. An agent iterating on the bench edits the bench itself; a reader comparing two sweeps sees here whether the
// question changed, not only the answers. The data is sweeps.mjs `specProvenance`, the same as spec.md.

import { CodeBlock } from "../../../../src/sidebar/code-block";
import { DiffLines } from "../../../../src/sidebar/code-diff";
import { Tip } from "../../../../src/sidebar/help-tip";
import type { BenchState, SpecState } from "./state";
import { Card } from "../../../../src/sidebar/fold-card";

const when = (iso: string) => { const d = new Date(iso); return isNaN(+d) ? iso : d.toLocaleString(); };

export function SpecCard({ s }: { s: BenchState }) {
    const p = s.spec;
    // Links into the repository at the build's commit, when the sweep knows the repo and the build is a commit.
    const commit = p && /^[0-9a-f]{40}/.exec(p.fingerprint)?.[0];
    const commitUrl = p && s.repo && commit ? `${s.repo}/commit/${commit}` : null;
    const fileUrl = p && s.repo && commit ? `${s.repo}/blob/${commit}/${p.spec.split("/").map(encodeURIComponent).join("/")}` : null;
    if (!p) return null;
    const prev = p.previous;
    return (
        <Card id="spec" label="the spec" anchor class="spec">
            <header>
                <h2><Tip tip="Which version of the spec this sweep ran, who started it, and what changed since the sweep before. Also in spec.md; every sweep is in sweeps.jsonl.">Spec</Tip></h2>
            </header>
            <dl class="kv">
                <dt><Tip tip="The spec file this sweep ran, where it was on disk, and a hash of its text: the same hash is the same question.">file</Tip></dt><dd>{fileUrl
                    ? <a class="tt" href={fileUrl} target="_blank" rel="noopener noreferrer" data-tip={`${p.onDisk ? `In the repo: ${p.spec}. ` : ""}Opens the file at the build's commit in ${s.repo}.${p.dirty ? " The build had uncommitted changes, so the text that ran may differ from it: that text is under \"The spec as it ran\"." : ""}`}><code>{p.onDisk ?? p.spec}</code></a>
                    : <span class="tt" data-tip={p.onDisk ? `In the repo: ${p.spec}` : "Recorded before sweeps kept the path on disk: this is the path in the repo."}><code>{p.onDisk ?? p.spec}</code></span>} <span class="badge">spec {p.specHash}</span></dd>
                <dt><Tip tip="Who started the sweep: BENCH_BY when it was set, else &quot;command line&quot;.">started by</Tip></dt><dd>{p.by} <span class="dim">· {when(p.at)}</span></dd>
                <dt><Tip tip="The commit the extension was built from, plus a hash of any uncommitted changes. Runs are cached per build.">build</Tip></dt><dd>{commitUrl
                    ? <a class="tt" href={commitUrl} target="_blank" rel="noopener noreferrer" data-tip={`Opens commit ${commit!.slice(0, 12)} in ${s.repo}.${p.dirty ? " The build also had uncommitted changes (the hash after +), which are not in that commit." : ""}`}><code>{p.fingerprint}</code></a>
                    : <code>{p.fingerprint}</code>}{p.dirty ? <span class="badge warn">uncommitted changes</span> : null}</dd>
                <dt><Tip tip="Whether the spec text differs from the previous sweep's in this directory.">since last</Tip></dt>
                <dd>{!prev ? <span class="dim">the first sweep recorded here</span>
                    : !p.changed ? <><span class="badge ok">unchanged</span> <span class="dim">since {prev.by}'s sweep, {when(prev.at)}</span></>
                    : <><span class="badge warn">changed</span> <span class="dim">since {prev.by}'s sweep, {when(prev.at)} (spec {prev.specHash})
                        {p.stat ? `: ${p.stat.added} line${p.stat.added === 1 ? "" : "s"} added, ${p.stat.removed} removed` : ": too long to diff"}</span></>}</dd>
            </dl>
            {p.diff ? <details open><summary>What changed</summary><DiffLines rows={p.diff} lang={/\.json$/i.test(p.spec) ? "json" : "typescript"} class="sdiff" /></details> : null}
            {p.history.length > 1 ? (
                <details><summary>Every sweep ({p.history.length})</summary>
                    <div class="hscroll"><table class="hist"><thead><tr><th>started</th><th>by</th><th>spec</th><th>build</th></tr></thead>
                        <tbody>{p.history.slice().reverse().map((h, i) => (
                            <tr key={i}><td>{when(h.at)}</td><td>{h.by}</td><td><code>{h.specHash}</code></td><td><code>{h.fingerprint}</code>{h.dirty ? " (dirty)" : ""}</td></tr>
                        ))}</tbody></table></div>
                </details>
            ) : null}
            <details><summary>The spec as it ran</summary><SpecSource source={p.source} file={p.spec} /></details>
        </Card>
    );
}

/** The spec's text as the panel shows code (code-block.tsx `CodeBlock`): highlighted and numbered. */
export function SpecSource({ source, file }: { source: string; file: string }) {
    return <div class="ssrc"><CodeBlock text={source} lang={/\.json$/i.test(file) ? "json" : "typescript"} lineNumbers /></div>;
}
