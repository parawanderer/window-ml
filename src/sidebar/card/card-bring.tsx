// card-bring.tsx — the HUD composer's "bring a session here": this browser's settled sessions, and moving one to this tab.
import { useEffect, useState } from "preact/hooks";
import { services } from "../services";
import { fmtAge } from "../timestamps";
import { cursorTipOn } from "../ui-kit";

type Bringable = { hash: string; title: string; url: string; lastTs: number; held: boolean; running?: true };

/** The host a session's page is on, for its row; the full URL is the row's tooltip. */
function hostOf(url: string): string {
    try { return new URL(url).host; } catch { return url; }
}

/**
 * The sessions this browser can bring to the HUD's tab (MOVE_RUN.md, shape (a)), this tab's site first as the worker
 * orders them. Choosing one moves it here (resumes it here when the runtime no longer holds it in memory); the card
 * then shows it, from its history.
 * @gallery four sessions {"now": 1800000000000, "rows": [
 *   {"hash": "a1", "title": "Summarise the pricing table", "url": "https://shop.example.com/pricing", "lastTs": 1799999400000, "held": true},
 *   {"hash": "b2", "title": "Find the cheapest flight to Lisbon in March and compare the layovers across every airline listed on the results page", "url": "https://flights.example.org/search?q=lis", "lastTs": 1799996400000, "held": false},
 *   {"hash": "c3", "title": "Extract the changelog entries", "url": "https://docs.example.net/changelog", "lastTs": 1799900000000, "held": false},
 *   {"hash": "d4", "title": "Fill in the expense form", "url": "https://shop.example.com/expenses", "lastTs": 1799500000000, "held": false},
 *   {"hash": "e5", "title": "Watch the build log", "url": "https://ci.example.com/builds/42", "lastTs": 1799999900000, "held": true, "running": true}]}
 * @gallery empty {"now": 1800000000000, "rows": []}
 * @group card
 * @param props.rows the list, for the gallery; omitted, it is fetched from the worker
 * @param props.now the clock the ages are read against, for the gallery
 * @param props.onDone called once a session was brought here, or, for a running one, about 2.5 s after the worker queued its move
 * @param props.onBack back to the task input
 */
export function BringHereList({ onDone, onBack, rows: given, now: clock }: { onDone: () => void; onBack: () => void; rows?: Bringable[]; now?: number }) {
    const [rows, setRows] = useState<Bringable[] | null>(given ?? null);
    const [err, setErr] = useState("");
    const [busy, setBusy] = useState("");
    const [info, setInfo] = useState("");
    useEffect(() => { if (given) return; void (services().bringable?.() ?? Promise.resolve([])).then(setRows); }, []);
    const bring = async (hash: string) => {
        setBusy(hash); setErr(""); setInfo("");
        const r = await services().bringHere!(hash);
        if ("error" in r) { setBusy(""); setErr(r.error); }
        else if (r.queued) { setInfo(r.queued); setTimeout(onDone, 2500); }   // the list stays up so the sentence can be read; busy stays so a second click cannot re-queue
        else { setBusy(""); onDone(); }
    };
    const now = clock ?? Date.now();
    return (
        <div class="card-bring">
            {rows === null ? <div class="card-bring-empty">Loading sessions…</div>
                : !rows.length ? <div class="card-bring-empty">No other session to bring here.</div>
                    : <div class="card-bring-list" role="listbox" aria-label="Sessions to bring here">
                        {rows.map((s) => (
                            <button key={s.hash} type="button" role="option" aria-selected={false} class="cmp-model-row card-bring-row"
                                disabled={!!busy} {...cursorTipOn(s.url)} onClick={() => void bring(s.hash)}>
                                <span class="cmp-model-row-name">{s.title}</span>
                                <span class="card-bring-meta">{s.running ? <span class="card-orb-live">running · </span> : null}{hostOf(s.url)} · {fmtAge(Math.max(0, now - s.lastTs))} ago</span>
                            </button>
                        ))}
                    </div>}
            {err ? <div class="card-cmp-err">{err}</div> : null}
            {info ? <div class="card-bring-empty" role="status">{info}</div> : null}
            <button type="button" class="card-bring-back" onClick={onBack}>Back to a new task</button>
        </div>
    );
}
