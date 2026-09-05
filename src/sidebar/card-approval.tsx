// The pending-approval BODY for the off-mode card — a goal + plain-English intent (or the code, or a
// utility-model description), an intent-verification prompt rather than a debug trace. The Deny/Approve
// controls live in CardApp's fixed footer. While it's up, the target element is highlighted on the page
// (green spotlight) and the card names where it sits. Extracted from hud-card.tsx.
import { useEffect } from "preact/hooks";
import type { AgentStep } from "./store";
import { rev } from "./store";
import { truncate } from "./format";
import { IconWarn } from "./icons";
import { Code, SheetChip, highlightApprove, highlightPos, clearHighlight, inlineJson, stepKey } from "./ui-kit";
import { RenderPanel } from "./render-panel";
import { intentFor, codeOf, ensureCodeSummary, ensureActionSummary, codeSummaries } from "./summaries";
import { HostAccessNote, OutputRaiseNote, externalSheetGrant } from "./agent-detail";

/** THE CONSENT SURFACE for a gated call — what the agent wants to do, said as an intent sentence with
 *  the part that matters picked out, plus the actual code or arguments (you cannot approve what you
 *  cannot see). The utility model glosses a code snippet in plain English above it, best-effort. */
export function ApprovalBody({ st, hash, goal }: { st: AgentStep; hash: string; goal: string }) {
    const rv = rev.value;   // subscribe: the utility-model gloss lands on a rev bump (this reads a signal →
                            // auto-memoized, so without this it wouldn't re-render for it). Retained via data-rev.
    const code = codeOf(st);
    const intent = intentFor(st);
    const key = st.seq != null ? stepKey(hash, st.seq) : "";
    useEffect(() => {
        const sel = intent?.selector;
        if (sel) highlightApprove(/^@(?:pt|box):[0-9a-f]+/.test(sel) ? { token: sel } : { selector: sel });
        if (code && st.seq != null) ensureCodeSummary(hash, st.seq, code.lang, code.text);
        else if (!code && !intent?.target && st.seq != null) ensureActionSummary(hash, st.seq, st.tool || "", st.arguments || {});
        return () => { clearHighlight(); highlightPos.value = ""; };
    }, [st.seq]);
    const summary = key ? codeSummaries.get(key) : undefined;
    const pos = highlightPos.value;
    const sheets = externalSheetGrant(st.arguments);
    const isType = !!intent && intent.verb.toLowerCase() === "type";
    return (
        <div class="action" data-rev={rv}>
            <div class="action-goal">{goal}</div>
            {code
                ? <div class="action-card action-code">
                    <div class="action-verb">{st.tool === "python_exec" ? "Run Python" : "Run JavaScript"}</div>
                    {summary ? <div class="action-summary ml-reveal">{summary}</div> : null}
                    <div class="action-codeblk"><Code text={code.text} lang={code.lang} format={code.lang === "javascript"} /></div>
                    <OutputRaiseNote tool={st.tool} args={st.arguments} />
                  </div>
                : intent
                    ? <div class="action-card">
                        <div class="action-sentence">
                            {/* navigate: "Agent wants to go to <url>", the URL styled like a significant action
                                (warm + dotted) — leaving for another page is worth calling out. */}
                            {intent.link
                                ? <>Agent wants to <span class="action-verb">{intent.verb.toLowerCase()}</span> <span class="action-link">{intent.target}</span></>
                                : <>Agent wants to <span class="action-verb">{intent.verb.toLowerCase()}</span>
                                    {isType ? <> “<b class="action-target">{truncate(intent.input || "", 100)}</b>” into</> : null}
                                    {" the "}{intent.kind || "element"}
                                    {intent.target ? <> <b class="action-target">“{intent.target}”</b></> : null}
                                    {/* type + submit is a bigger action (presses Enter → sends the form). Call it out with a
                                        dotted underline so the human sees it's not just typing. */}
                                    {isType && intent.submit ? <> and <span class="action-submit">submit</span> it</> : null}</>}
                            {intent.note ? <span class="action-note"> · {intent.note}</span> : null}.
                        </div>
                        {intent.selector ? <div class="action-loc"><span class="loc-dot" aria-hidden="true" />Highlighted on the page{pos ? <> · <b>{pos}</b></> : null}</div> : null}
                        {/* CROSS-ORIGIN iframe = the one privileged case: a real debugger click reaching INTO
                            embedded third-party content that uses your session there. Chrome's debug banner only
                            appears AFTER you approve, so warn here, visually, BEFORE. (Same-origin frames / shadow
                            roots don't warn — not a security boundary.) */}
                        {intent.crossOrigin ? <div class="action-xorigin"><IconWarn /><span><b>Privileged click into an embedded cross-origin frame</b> — <b class="xorigin-host">{intent.crossOrigin}</b>. It uses a real debugger click and your session on that site.</span></div> : null}
                        {/* A REMOTE call. The risk is not "this might change your page" but "this sends your
                            data somewhere", which has no read-only version to auto-approve — so it gets its
                            own warning rather than borrowing the frame-click one, whose words describe a
                            debugger click that is not happening here. */}
                        {intent.offMachine ? <div class="action-xorigin"><IconWarn /><span><b>These arguments leave this machine</b> — they are sent to <b class="xorigin-host">{intent.offMachine}</b> on the configured server, which runs the tool and can act on them.</span></div> : null}
                      </div>
                    : <div class="action-card">
                        {/* Utility-model gloss (if any) ABOVE the render — but it must NOT replace a
                            deterministic render (e.g. navigate's destination URL); a consent card has to keep
                            showing WHAT it's approving. Summary + render stack, like the code case does. */}
                        {summary ? <div class="action-summary ml-reveal">{summary}</div> : null}
                        {st.renderIn ? <RenderPanel d={st.renderIn} />
                            : (summary ? null : <div class="action-body dim">Run <b>{st.tool}</b>{st.arguments && Object.keys(st.arguments).length ? <> with {inlineJson(st.arguments)}</> : null}</div>)}
                      </div>}
            {sheets.length
                ? <div class="action-sheets"><IconWarn /><span>Grants this run access to {sheets.map((id, i) => <SheetChip key={i} id={id} />)} for the session.</span></div>
                : null}
            <HostAccessNote st={st} />
        </div>
    );
}

