// requests-section.tsx — the Settings "Waiting for an answer" section: every site asking for access (ml.requestAccess), with the same buttons as the toolbar popup's rows.

// docs/spec/SITE_ACCESS_SLICE3.md, 1.3, 1.4 and 1.6. The popup (popup.ts `requestRow`) shows these for the current tab's
// site; this is the same list for every site, and appears only while something waits. The worker's side is
// `ACCESS_REQUESTS` (background.ts); its store is `ml_site_requests` (`REQUESTS_KEY` in src/sw/sw-access-requests.ts,
// worker code, not imported into this bundle).
import { useEffect, useState } from "preact/hooks";
import { cursorTipOn } from "../ui-kit";
import { REQUEST_TTL_MS, type RequestDecision, type WaitingRequest } from "../../site-requests";

/** The storage key the request store lives under, re-read on change. */
const REQUESTS_STORAGE_KEY = "ml_site_requests";

/**
 * Ask the worker for the sites asking for access (`ACCESS_REQUESTS`), applying a decision first when one is given.
 * @param payload `{}` to read, `{ origin, decision }` to answer one and read what still waits
 * @returns the requests still waiting, or null when the worker could not be asked
 */
function askRequests(payload: { origin?: string; decision?: RequestDecision } = {}): Promise<WaitingRequest[] | null> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "ACCESS_REQUESTS", payload }, (res: { data?: { requests?: WaitingRequest[] } } | undefined) => {
                void chrome.runtime.lastError;
                resolve(res?.data?.requests ?? null);
            });
        } catch { resolve(null); }
    });
}

/**
 * The requests waiting, kept current: one made by a page, or answered from the popup, shows up here without reopening Settings.
 * @param initial the requests to draw without asking the worker (the gallery's); absent asks it
 * @returns the requests (null until read) and their setter, for an answer's reply
 */
export function useWaitingRequests(initial?: WaitingRequest[]): [WaitingRequest[] | null, (r: WaitingRequest[]) => void] {
    const [requests, setRequests] = useState<WaitingRequest[] | null>(initial ?? null);
    useEffect(() => {
        if (initial) return;
        const read = (): void => { void askRequests().then((r) => { if (r) setRequests(r); }); };
        read();
        const onChange = (changes: Record<string, unknown>) => { if (REQUESTS_STORAGE_KEY in changes) read(); };
        try { chrome.storage.onChanged.addListener(onChange); } catch { /* not an extension page */ }
        return () => { try { chrome.storage.onChanged.removeListener(onChange); } catch { /* ignore */ } };
    }, []);
    return [requests, setRequests];
}

/** "Asked 3 minutes ago · expires in 7 days", from an entry's time (the popup's `requestAge`). */
export function requestAge(at: number, now = Date.now()): string {
    const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
    const mins = Math.round((at - now) / 60_000);
    const ago = Math.abs(mins) < 60 ? rtf.format(mins, "minute") : Math.abs(mins) < 1440 ? rtf.format(Math.round(mins / 60), "hour") : rtf.format(Math.round(mins / 1440), "day");
    const days = Math.max(1, Math.ceil((at + REQUEST_TTL_MS - now) / 86_400_000));
    return `Asked ${ago} · expires in ${days} ${days === 1 ? "day" : "days"}`;
}

/** How long the self-approval confirmation holds its Allow after it opens (1.6). */
const ALLOW_HOLD_MS = 1000;

/**
 * The self-approval confirmation (1.6), opened from Review…: never one click from the entry, and Allow is held for a second.
 * @param r the self-approval request
 * @param onDecide answers it
 */
function SelfApprovalConfirm({ r, onDecide }: { r: WaitingRequest; onDecide: (answer: "allow" | "deny") => void }) {
    const [held, setHeld] = useState(true);
    useEffect(() => {
        const t = setTimeout(() => setHeld(false), ALLOW_HOLD_MS);
        return () => clearTimeout(t);
    }, []);
    return (
        <div class="set-note req-confirm" role="alertdialog" aria-label={`${r.origin} wants to approve its own actions.`}>
            <b>{r.origin} wants to approve its own actions.</b>
            <div>If you allow this, the site can run code, click and type on your behalf, run Python with network access, and fetch pages using your logins, without asking you each time. Only allow this for a site you control or fully trust.</div>
            {r.reason ? <div class="req-says">{`The site says: “${r.reason}”`}</div> : null}
            <div class="perm-add">
                <button class="test-btn req-deny" onClick={() => onDecide("deny")}>Deny</button>
                <button class="test-btn req-allow" disabled={held} onClick={() => onDecide("allow")}>Allow</button>
            </div>
        </div>
    );
}

/**
 * One site asking for access: the origin as the browser reported it, never a title the page set; its reason only as a
 * quote of its own words, as text; and the answers the popup offers for the same entry.
 * @group settings
 * @gallery asks for access {"r": {"kind": "access", "origin": "https://asker.example", "domain": "asker.example", "agents": false, "at": 1760000000000, "state": "pending", "asks": 1, "allowed": false, "reason": "Summarise this page for you"}}
 * @gallery asks for agents too {"r": {"kind": "access", "origin": "https://asker.example", "domain": "asker.example", "agents": true, "at": 1760000000000, "state": "pending", "asks": 1, "allowed": false, "reason": "<b>trust me</b>"}}
 * @gallery allowed, asks for agents {"r": {"kind": "access", "origin": "https://asker.example", "domain": "asker.example", "agents": true, "at": 1760000000000, "state": "pending", "asks": 1, "allowed": true}}
 * @gallery approve its own actions {"r": {"kind": "selfApprove", "origin": "https://asker.example", "domain": "asker.example", "agents": false, "at": 1760000000000, "state": "pending", "asks": 1, "allowed": true, "reason": "my own tool"}}
 * @param r the waiting request
 * @param onDecide answers it
 */
export function RequestRow({ r, onDecide }: { r: WaitingRequest; onDecide?: (decision: RequestDecision) => void }) {
    const [agents, setAgents] = useState(false);   // unticked (Q12): the most a site can ask for is never one click away
    const [reviewing, setReviewing] = useState(false);
    const decide = (d: RequestDecision): void => onDecide?.(d);
    const allowed = r.kind === "access" && r.allowed === true;
    const deny = (): void => decide({ kind: r.kind as "access", answer: "deny" });
    const denyTip = cursorTipOn("Refuse it, and stop it asking. Undo in DevTools Settings → Permissions.");
    return (
        <div class="pol-row req-row" data-origin={r.origin}>
            <div class="set-hint"><code>{r.origin}</code>{r.kind === "selfApprove" ? " asks to approve its own actions." : r.agents ? " asks to use window.ml and to start agents." : " asks to use window.ml."}</div>
            {r.reason ? <div class="set-hint req-says">{`The site says: “${r.reason}”`}</div> : null}
            {r.kind === "access" && r.agents && !allowed
                ? <label class="set-hint req-check"><input type="checkbox" checked={agents} onChange={(e: any) => setAgents(e.currentTarget.checked)} /> Let it start agents too. Each start asks you.</label>
                : null}
            <div class="perm-add req-buttons">
                {r.kind === "selfApprove"
                    ? <button class="test-btn" onClick={() => setReviewing(true)}>Review…</button>
                    : allowed
                        ? <>
                            <button class="test-btn" onClick={() => decide({ kind: "access", answer: "agents" })}>Let it start agents</button>
                            <button class="test-btn" {...denyTip} onClick={deny}>Deny</button>
                          </>
                        : <>
                            <button class="test-btn" {...cursorTipOn("Allowed until the browser restarts")} onClick={() => decide({ kind: "access", answer: "session", agents })}>Allow this session</button>
                            <button class="test-btn" onClick={() => decide({ kind: "access", answer: "always", agents })}>Always allow</button>
                            <button class="test-btn" {...denyTip} onClick={deny}>Deny</button>
                          </>}
            </div>
            {reviewing ? <SelfApprovalConfirm r={r} onDecide={(answer) => { setReviewing(false); decide({ kind: "selfApprove", answer }); }} /> : null}
            <div class="set-hint req-age">{requestAge(r.at)}</div>
        </div>
    );
}

/**
 * The section's rows: one per waiting request, for every site. Draws nothing when nothing waits, so the caller's
 * section wrapper can follow `requests.length`.
 * @group settings
 * @gallery {"requests": [{"kind": "access", "origin": "https://asker.example", "domain": "asker.example", "agents": true, "at": 1760000000000, "state": "pending", "asks": 1, "allowed": false, "reason": "Summarise this page for you"}, {"kind": "selfApprove", "origin": "https://tool.example", "domain": "tool.example", "agents": false, "at": 1760000000000, "state": "pending", "asks": 1, "allowed": true}]}
 * @param requests the waiting requests
 * @param onDecide answers one, by its origin
 */
export function RequestRows({ requests, onDecide }: { requests: WaitingRequest[]; onDecide?: (origin: string, decision: RequestDecision) => void }) {
    return <div class="pol-rows">{requests.map((r) => <RequestRow key={`${r.kind}:${r.origin}`} r={r} onDecide={(d) => onDecide?.(r.origin, d)} />)}</div>;
}

/**
 * Answer a request through the worker and return what still waits (`ACCESS_REQUESTS` with a decision).
 * @param origin the asking site
 * @param decision the answer
 * @returns the requests still waiting, or null when the worker could not be asked
 */
export function answerRequest(origin: string, decision: RequestDecision): Promise<WaitingRequest[] | null> {
    return askRequests({ origin, decision });
}
