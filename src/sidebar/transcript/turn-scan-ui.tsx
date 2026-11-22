// turn-scan-ui.tsx — the composer's chips for registered values in a draft: the hook that scans it and the chip row that shows what it found.

// SECRET_HANDLES.md, "What the person sees". The pure part (merging spans, the choices, the tokens a send carries) is turn-scan.ts.
// A detection never blocks a send and never adds a click to it: the chips are information, and "send as is" is opt-in.
import { useEffect, useRef, useState } from "preact/hooks";
import { services } from "../services";
import { cursorTipOn } from "../ui-kit";
import type { PendingFile } from "./composer";
import { asIsFor, chipsOf, fileScanOf, noScan, pruneChosen, readScan, textsToScan, toggleFile, toggleToken, type FileScan, type TurnChip, type TurnScan } from "./turn-scan";

/** How long after the last edit the draft is scanned: a keystroke is not a question to the worker. */
export const SCAN_DEBOUNCE_MS = 300;

/** What a composer reads from {@link useTurnScan}. */
export interface TurnScanState {
    /** the chips of the typed words, each with whether it is chosen */
    chips: (TurnChip & { on: boolean })[];
    /** the secret store could not be read: said quietly, the send gets its own refusal */
    unreadable: boolean;
    /** flip one chip's "send as is" */
    toggle(token: string): void;
    /** file `i`'s count and choice, or null when it holds nothing */
    file(i: number): FileScanView | null;
    /** the tokens a send carries, or undefined to leave the field off */
    asIs(): string[] | undefined;
    /** forget the choices (the draft was sent or cleared) */
    reset(): void;
}

/** What a file's chip shows of a scan: how many registered values, what they are called, whether all are chosen, and the toggle. */
export interface FileScanView { count: number; names: string[]; on: boolean; onToggle(): void }

/**
 * Scan a draft as it is typed, and keep the person's "send as is" choices.
 * The scan is debounced and an answer for an older draft is dropped. Without `services().scanTurn` (the hub host, the web
 * build, the phone) it does nothing and there are no chips.
 * @param typed the typed words
 * @param docs the files in the box
 * @param scope the session's key, or the runtime's id on a start page: which worker's registry is meant
 * @returns the chips, the file counts and the tokens to send
 */
export function useTurnScan(typed: string, docs: readonly PendingFile[], scope: string): TurnScanState {
    const [scan, setScan] = useState<TurnScan>(() => noScan(docs.length));
    // The files a scan was made for, so a count is never drawn on a file that took the place of the one scanned.
    const [scanned, setScanned] = useState<readonly PendingFile[]>(docs);
    const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
    const seq = useRef(0);   // state: plumbing — which scan is the latest, so an older answer is dropped
    useEffect(() => {
        const mine = ++seq.current;
        const ask = services().scanTurn;
        const { texts, fileAt } = textsToScan(typed, docs);
        if (!ask || texts.every((t) => !t.trim())) {
            setScan(noScan(docs.length)); setScanned(docs); setChosen((c) => (c.size ? new Set() : c));
            return;
        }
        const timer = setTimeout(() => {
            ask.call(services(), texts, scope).then((res) => {
                if (seq.current !== mine) return;
                const next = readScan(res, fileAt);
                setScan(next); setScanned(docs); setChosen((c) => pruneChosen(c, next));
            }, () => { /* the host could not be asked: no chips */ });
        }, SCAN_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [typed, docs, scope]);
    const chips = scan.off ? [] : chipsOf(scan).map((c) => ({ ...c, on: chosen.has(c.token) }));
    return {
        chips,
        unreadable: scan.unreadable,
        toggle: (token) => setChosen((c) => toggleToken(c, token)),
        file: (i) => {
            const at = scanned.indexOf(docs[i]);
            const f: FileScan | null = at < 0 || scan.off ? null : fileScanOf(scan, at);
            return f ? { count: f.count, names: f.names, on: f.tokens.every((t) => chosen.has(t)), onToggle: () => setChosen((c) => toggleFile(c, f.tokens)) } : null;
        },
        asIs: () => asIsFor(chosen, scan),
        reset: () => setChosen((c) => (c.size ? new Set() : c)),
    };
}

/** The tip on a chip's control, which says what the model will read either way. */
const chipTip = (name: string, on: boolean): string => on
    ? `The model will read the value registered as ${name} as it is. Click to take it out again.`
    : `The model will read [REDACTED:${name}] in place of the value registered as ${name}. Click to send it as is.`;

/**
 * THE CHIPS OF A DRAFT: one per registered value found in what is typed, naming it (never showing it, its length or a masked
 * preview) with a control to send it as is. Quiet about a store that could not be read. Nothing when there is nothing to say.
 * @param chips the chips and whether each is chosen
 * @param onToggle flips one chip, by token
 * @param unreadable the secret store could not be read
 * @group sidebar/transcript
 * @gallery {"chips": [{"token": "a", "name": "PLUG_PASSWORD", "count": 1, "on": false}, {"token": "b", "name": "window-ml-api-key", "count": 2, "on": true}], "onToggle": null}
 * @gallery unreadable {"chips": [], "unreadable": true, "onToggle": null}
 */
export function TurnChips({ chips, onToggle, unreadable }: { chips: (TurnChip & { on: boolean })[]; onToggle: (token: string) => void; unreadable?: boolean }) {
    if (!chips.length && !unreadable) return null;
    return (
        <div class="tchips" role="group" aria-label="Registered values in this message">
            {chips.map((c) => (
                <span key={c.token} class={`tchip${c.on ? " on" : ""}`}>
                    <span class="tchip-name">{c.name}{c.count > 1 ? ` ×${c.count}` : ""}</span>
                    <button type="button" class="tchip-as" aria-pressed={c.on} onClick={() => onToggle(c.token)} {...cursorTipOn(chipTip(c.name, c.on))}>
                        {c.on ? "sent as is" : "send as is"}
                    </button>
                </span>
            ))}
            {unreadable ? <span class="tchips-note">The secret store could not be read, so this message may be refused.</span> : null}
        </div>
    );
}

/** The control a file's chip carries when the scan found registered values in it: a count, and "send as is" for the whole file. */
export function FileScanButton({ scan }: { scan: FileScanView }) {
    const tip = `${scan.names.join(", ")}: ${scan.on ? "sent as is. Click to take them out again." : "taken out before the model reads the file. Click to send them as is."}`;
    return (
        <button type="button" class={`tchip-as file-scan${scan.on ? " on" : ""}`} aria-pressed={scan.on} onClick={scan.onToggle} {...cursorTipOn(tip)}>
            {scan.count} registered {scan.count === 1 ? "value" : "values"} · {scan.on ? "sent as is" : "send as is"}
        </button>
    );
}
