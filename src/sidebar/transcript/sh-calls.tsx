// sh-calls.tsx — a step's answered `ml.sh` calls: one collapsed footer, and a row per call that opens to everything.

// The transcript used to print every answered call in full under its step: a long `bash -c` heredoc flattened onto
// one line, then its facts, for each call. Most of the time none of it is needed, and when it is, it is needed for
// ONE call. So the footer says how many calls there were and how they went, each row says the one thing about its
// call worth reading without opening it (the program, the start of what it ran, how it went, how long), and opening a
// row shows the command as code, every fact the card had, and the raw argv. A warning shows on the row, never only
// inside it. A call still waiting on the person is not here: it is a gate and stays open (ask-card.tsx).

import { useEffect, useRef, useState } from "preact/hooks";
import type { AgentStep } from "../store";
import { Disclosure } from "../disclosure";
import { CopyableCode } from "../code-block";
import { Dot } from "../ui-kit";
import { IconWarn } from "../icons";
import { FactList } from "./ask-card";
import { fmtDur } from "../timestamps";
import { shEntries, shSummary, type ShEntry } from "../../shell/sh-entries";
import { quoteArg } from "../../shell/sh-call";

/** The command as a person would type it: an argv quoted word by word, so what is shown can be pasted. */
const commandOf = (argv: readonly string[]): string => argv.map(quoteArg).join(" ");

/** The start of what a call ran, for its row: a script's first line that says something, else the arguments. */
function previewOf(e: ShEntry): string {
    if (e.script != null) return e.script.split("\n").find((l) => l.trim() && !l.trim().startsWith("#!"))?.trim() ?? "";
    return commandOf(e.argv.slice(1));
}

/** What the row's warning dot says: what raised it, by name, so it still means something on a call already open or already run. */
const flagged = (e: ShEntry): string => `Worth a look: ${e.flags.join("; ")}`;

/**
 * One call: its row (status, program, the start of what it ran, how it went, how long), opening to the command, the
 * facts and the raw argv.
 * @group approval
 * @gallery {"e":{"key":"a1","verdict":"ran","how":"asked","said":"allowed after 3 s","program":"git","argv":["git","--no-pager","status","--short"],"script":null,"durationMs":84,"facts":[{"label":"Program","value":"/usr/bin/git (version 2.45.1)"},{"label":"In","value":"/Users/me/src/proj"},{"label":"Sandbox applied","value":"write today, exec any"},{"label":"Protected names","value":"none changed during this call"}],"warn":false}}
 * @param e the entry
 * @param defaultOpen start opened
 */
export function ShEntryCard({ e, defaultOpen }: { e: ShEntry; defaultOpen?: boolean }) {
    const [raw, setRaw] = useState(false);
    const status = e.verdict === "ran" ? "ok" : e.verdict === "denied" ? "err" : "pending";
    const label = (
        <span class={`shc-row ${e.verdict}`}>
            <Dot status={status} warn={e.warn ? flagged(e) : undefined} hollow={e.verdict === "denied"} tip={e.verdict === "denied" ? "Denied: the call never ran. In the script, ml.sh.run threw Denied." : undefined} />
            <span class="shc-prog">{e.program}</span>
            <span class="shc-prev">{previewOf(e)}</span>
            <span class="shc-said">{e.said}</span>
            {e.durationMs != null ? <span class="shc-ms">{fmtDur(e.durationMs)}</span> : null}
        </span>
    );
    return (
        <div class={`shc-entry${e.warn ? " warn" : ""}`}>
            <Disclosure label={label} defaultOpen={defaultOpen}>
                <div class="shc-body">
                    {e.note ? <div class="shc-note">“{e.note}”</div> : null}
                    {e.argv.length
                        ? <CopyableCode text={raw ? JSON.stringify(e.argv) : e.script ?? commandOf(e.argv)} block lang={raw ? "json" : "bash"}
                            tip={raw ? "copy the argv" : e.script != null ? "copy the script" : "copy the command"}
                            extra={<button class="code-tool" aria-pressed={raw} onClick={() => setRaw((v) => !v)}>{raw ? "command" : "raw argv"}</button>} />
                        : null}
                    {e.script != null && !raw ? <div class="shc-via">run as <code>{commandOf(e.argv.slice(0, 2))} …</code></div> : null}
                    {e.facts.length ? <FactList lines={e.facts} cls="shc-facts" skipCommand /> : null}
                </div>
            </Disclosure>
        </div>
    );
}

/**
 * A step's answered `ml.sh` calls, collapsed to one footer that says how many and how they went; open it for a row per
 * call, and open a row for the command, the facts and the raw argv.
 * @gallery one call {"st":{"step":2,"seq":2,"tool":"exec","asks":[{"id":"a01","kind":"sh","state":"allowed","raisedAt":0,"answeredAt":3000,"facts":{"argv":["git","--no-pager","status","--short"],"program":{"path":"/usr/bin/git","inRoot":false},"cwd":{"path":"/Users/me/src/proj","inRoot":true},"env":{"set":[],"free":true},"secrets":[],"paths":[],"repo":{"root":"/Users/me/src/proj","reasons":[]},"repoConfigRunsCode":false,"effects":"unknown","described":false,"why":[],"runner":false,"mode":"host","sandboxed":true,"placement":"host-sandbox"},"outcome":{"ran":"host-sandbox","envelope":{"write":"today","exec":"any"},"protectedChanged":[]}}],"shCalls":[{"program":"git","durationMs":84}]}}
 * @gallery mixed, opened {"defaultOpen":true,"openRows":true,"st":{"step":3,"seq":3,"tool":"exec","asks":[{"id":"a01","kind":"sh","state":"allowed","raisedAt":0,"answeredAt":3000,"facts":{"argv":["bash","-c","for f in *.txt; do printf '%-26s %s bytes\\n' \"$f\" \"$(wc -c < \"$f\" | tr -d ' ')\"; done"]},"outcome":{"ran":"host-sandbox","envelope":{"write":"today","exec":"any"},"protectedChanged":[]}},{"id":"a02","kind":"sh","state":"denied","raisedAt":4000,"answeredAt":9000,"note":"not that branch","facts":{"argv":["git","checkout","main"]}}],"shCalls":[{"program":"bash","durationMs":410},{"program":"wc","durationMs":12,"unasked":{"by":"default","argv":["wc","-l","file-for-the-agent.txt"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"asked":{"write":"none","exec":"program-only"},"protectedChanged":[]}}}]}}
 * @gallery a long heredoc script {"defaultOpen":true,"openRows":true,"st":{"step":4,"seq":4,"tool":"exec","asks":[{"id":"a01","kind":"sh","state":"allowed","raisedAt":0,"answeredAt":11000,"facts":{"argv":["bash","-c","cat > demo.sh <<'EOF'\n#!/usr/bin/env bash\nset -euo pipefail\necho \"hello from $(basename \"$0\") in $(pwd)\"\ntotal=0\nfor n in $(seq 1 5); do total=$((total + n)); done\necho \"sum 1..5 = $total\"\ndf -h . | tail -1 | awk '{print \"disk free here: \" $4}'\nEOF\nchmod +x demo.sh && ./demo.sh"]},"outcome":{"ran":"host-sandbox","envelope":{"write":"today","exec":"any"},"protectedChanged":[]}}],"shCalls":[{"program":"bash","durationMs":1900}]}}
 * @gallery ran free by a policy {"st":{"step":5,"seq":5,"tool":"exec","shCalls":[{"program":"find","durationMs":40,"unasked":{"by":"policy","policy":"tidy build dir","argv":["find","build","-name","*.o","-delete"],"outcome":{"ran":"host-sandbox","envelope":{"write":"today","exec":"any"},"asked":{"write":"roots","exec":"program-only"},"protectedChanged":null}}}]}}
 * @gallery sandbox weaker than asked {"defaultOpen":true,"openRows":true,"st":{"step":6,"seq":6,"tool":"exec","shCalls":[{"program":"npm","durationMs":9100,"unasked":{"by":"default","argv":["npm","install"],"outcome":{"ran":"host-sandbox","envelope":{"write":"today","exec":"any"},"asked":{"write":"roots","exec":"program-only"},"protectedChanged":[{"root":"/Users/me/src/proj","name":".git/hooks/pre-commit","change":"created"}]}}}]}}
 * @gallery an older host reported nothing {"defaultOpen":true,"openRows":true,"st":{"step":7,"seq":7,"tool":"exec","asks":[{"id":"a01","kind":"sh","state":"allowed","raisedAt":0,"answeredAt":2000,"facts":{"argv":["ls","-la"]},"outcome":{"ran":"host-sandbox","envelope":null,"protectedChanged":null}}]}}
 * @gallery the turn ended before an answer {"st":{"step":8,"seq":8,"tool":"exec","asks":[{"id":"a01","kind":"sh","state":"ended","raisedAt":0,"facts":{"argv":["rm","-rf","build"]}},{"id":"a02","kind":"sh","state":"timeout","raisedAt":1000,"answeredAt":61000,"facts":{"argv":["make","clean"]}}]}}
 * @gallery eight calls {"st":{"step":9,"seq":9,"tool":"exec","shCalls":[{"program":"rg","durationMs":31,"unasked":{"by":"default","argv":["rg","-n","TODO","src"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}},{"program":"rg","durationMs":28,"unasked":{"by":"default","argv":["rg","-n","FIXME","src"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}},{"program":"ls","durationMs":9,"unasked":{"by":"default","argv":["ls","-la"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}},{"program":"cat","durationMs":8,"unasked":{"by":"default","argv":["cat","package.json"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}},{"program":"git","durationMs":60,"unasked":{"by":"default","argv":["git","--no-pager","log","--oneline","-n","20"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}},{"program":"git","durationMs":55,"unasked":{"by":"default","argv":["git","--no-pager","diff","--stat"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}},{"program":"wc","durationMs":7,"unasked":{"by":"default","argv":["wc","-l","README.md"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}},{"program":"head","durationMs":6,"unasked":{"by":"default","argv":["head","-n","5","README.md"],"outcome":{"ran":"host-sandbox","envelope":{"write":"none","exec":"program-only"},"protectedChanged":[]}}}]}}
 * @group approval
 * @param st the step
 * @param defaultOpen start with the footer opened (the gallery shows the rows)
 * @param openRows start with every row opened too (the gallery shows what a row holds)
 */
export function ShCalls({ st, defaultOpen, openRows }: { st: AgentStep; defaultOpen?: boolean; openRows?: boolean }) {
    const entries = shEntries(st);
    const s = shSummary(entries);
    // A call JOINING the footer is the one moment it has something to say: the count ticks, once, and only for a call
    // that arrives while it is on screen (it is seeded with the count it already shows).
    const prev = useRef(s.calls);
    const [bumped, setBumped] = useState(false);
    useEffect(() => {
        if (prev.current === s.calls) return;
        prev.current = s.calls;
        setBumped(true);
        const t = setTimeout(() => setBumped(false), 320);
        return () => clearTimeout(t);
    }, [s.calls]);
    if (!entries.length) return null;
    const parts = [
        s.asked ? `${s.asked} asked` : "",
        s.free ? `${s.free} ran without asking` : "",
        s.denied ? `${s.denied} denied` : "",
    ].filter(Boolean);
    const note = (
        <>
            {parts.join(" · ")}
            {s.warns ? <span class="shc-warn" aria-label={`${s.warns} worth a look`}><IconWarn />{s.warns} worth a look</span> : null}
        </>
    );
    return (
        <div class="shcalls">
            <Disclosure label={<span class="shc-head">ml.sh <span class={`shc-n${bumped ? " bumped" : ""}`}>{s.calls === 1 ? "1 call" : `${s.calls} calls`}</span></span>} note={note} defaultOpen={defaultOpen}>
                <div class="shc-list">
                    {entries.map((e) => <ShEntryCard key={e.key} e={e} defaultOpen={openRows} />)}
                </div>
            </Disclosure>
        </div>
    );
}
