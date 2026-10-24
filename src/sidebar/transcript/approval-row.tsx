// approval-row.tsx — the answer row every approval card draws: approve, deny, deny with a note, and keep where a call has grants.

import { useState, useRef } from "preact/hooks";
import { Dialog } from "../dialog";
import { IconInfo, IconChevron } from "../icons";
import { cursorTipOn } from "../ui-kit";

/**
 * What approving THIS call sets in motion beyond the call itself — the mechanics, in the order the buttons sit.
 *
 * It is the part you need once. Every card already says what is being approved, and some carry a warning about an
 * escalation (arguments leaving the machine, a privileged click into a cross-origin frame, a fetch that runs as
 * you); those stay on the card, because the whole reason they are drawn is that they must not be missed. What was
 * repeated on every card and read only the first time is what each BUTTON then does — above all that "Keep" is not
 * "Approve harder" but a standing grant for the rest of the session. That moves behind the info control.
 *
 * Pure and exported so a test can read the sentences without rendering an approval.
 */
export function approvalMechanics({ grants, arrival }: { grants: boolean; arrival?: "ask" | "deny" }): string[] {
    // A run held on the page its tab arrived on (src/sw/nav-arrival.ts): the answers are about the page, not a call.
    if (arrival === "deny") return ["Go back returns the tab to the page before. The run carries on there.", "End run stops the run here."];
    if (arrival === "ask") return ["Approve lets the run act on this page, and as you on its origin, for the rest of the run.", "Deny takes the tab back to the page before. The run carries on there."];
    return [
        "Approve runs this one call. The agent asks again the next time it wants something.",
        "Deny refuses this call. The run carries on and the agent may try another way.",
        ...(grants ? ["Keep approves it AND stops the agent asking for these URLs for the rest of this session; what it fetches is cached."] : []),
    ];
}

/**
 * The approval's buttons, with a quiet info control at the other end of the row.
 *
 * The explanation is offered BOTH ways on purpose: the pointer gets it on hover, which is what makes it free to
 * consult and free to ignore, and the control OPENS A DIALOG for anyone without one — the cursor tip is
 * pointer-only, and this card is drawn on a phone too. One list, two presentations, so they cannot drift.
 *
 * A dialog rather than the rows unfolding underneath, which is what this did first. Appending to the card pushes the
 * conversation down and keeps the space for as long as it is open, and on a phone that is most of the screen given
 * to something you read once. A dialog costs nothing until it is asked for and nothing after it is dismissed. The
 * control is deliberately not a warning colour: nothing is wrong, there is simply more to know.
 */
export function ApprovalRow({ grants, decide, arrival }: { grants: boolean; decide: (ok: boolean, persist?: boolean, feedback?: string) => void; arrival?: "ask" | "deny" }) {
    const [why, setWhy] = useState(false);
    const [saying, setSaying] = useState(false);
    const note = useRef<HTMLTextAreaElement>(null);
    const lines = approvalMechanics({ grants, arrival });
    const list = <ul class="appr-why-list">{lines.map((l) => <li key={l}>{l}</li>)}</ul>;
    return (
        <>
            <div class="appr-row">
                <button class="appr-info" aria-label="What these choices do" aria-haspopup="dialog" aria-expanded={why}
                    {...cursorTipOn(list)} onClick={() => setWhy(true)}><IconInfo /></button>
                <span class="sp" />
                {/* DENY SPLITS, the way Continue does: the plain press is the common answer and stays one click, and
                    the chevron is where the rarer, wordier one lives. A bare refusal tells the model nothing, so it
                    guesses — often by trying the same thing a slightly different way. A sentence is what turns a
                    denial into a redirection, and the contract has carried `feedback` the whole time. */}
                {arrival === "deny" ? <>
                    <button class="appr-btn no" onClick={() => decide(false)}>End run</button>
                    <button class="appr-btn yes" onClick={() => decide(true)}>Go back</button>
                </> : <>
                <span class="appr-deny-wrap">
                    <button class="appr-btn no" onClick={() => decide(false)}>Deny</button>
                    <button class="appr-btn no appr-deny-more" aria-label="Deny with a message" aria-haspopup="dialog"
                        onClick={() => setSaying(true)}><IconChevron /></button>
                </span>
                <button class="appr-btn yes" onClick={() => decide(true)}>Approve</button>
                {grants ? <button class="appr-btn yes remember" onClick={() => decide(true, true)}>Keep</button> : null}
                </>}
            </div>
            {saying ? (
                <Dialog onClose={() => setSaying(false)} labelledBy="appr-say-h" initialFocus={note}
                    onSubmit={() => { const t = note.current?.value.trim(); setSaying(false); decide(false, false, t || undefined); }}>
                    <h2 id="appr-say-h">Deny, and say why</h2>
                    <p>The run carries on, and the model is told this instead of only that it was refused — so it can try
                        something else rather than guess at a bare no.</p>
                    <textarea ref={note} class="chat-dialog-field appr-say" rows={3}
                        placeholder="Not that site — use the fare rules page on the airline's own domain." />
                    <div class="chat-dialog-actions">
                        <button type="button" class="btn" onClick={() => setSaying(false)}>Cancel</button>
                        <button type="submit" class="btn primary">Deny with this</button>
                    </div>
                </Dialog>
            ) : null}
            {why ? (
                <Dialog onClose={() => setWhy(false)} labelledBy="appr-why-h">
                    <h2 id="appr-why-h">What these choices do</h2>
                    <div class="appr-why">{list}</div>
                    <div class="chat-dialog-actions">
                        <button type="button" class="btn" onClick={() => setWhy(false)}>Close</button>
                    </div>
                </Dialog>
            ) : null}
        </>
    );
}
