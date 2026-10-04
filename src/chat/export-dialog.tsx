// export-dialog.tsx — "Export chat", as a picker over the three shapes a session is already written out in.
//
// The formats and every byte they produce are `src/sidebar/export.ts`, unchanged and shared with the extension's own
// export menu: this is the CHOOSING, in the shape the page's other decisions take (a dialog with Cancel and the verb).
// A menu of formats, which is what the panel has, answers "which one" by making you pick before you have read what
// they are for; here the three sit together with a line each.

import { signal } from "@preact/signals";
import { useRef, useState } from "preact/hooks";
import type { SessionKey } from "../session-host";
import { canPrintSession, exportSession, exportSessionJson, printSession } from "../sidebar/export";
import { truncate } from "../sidebar/format";
import { Dialog } from "../sidebar/dialog";
import { pullAllHistory } from "./pull-history";
import type { ChatStore } from "./chat-store";

/** The session whose export is being chosen, or null. Set by the header's `⋮`. */
export const exportingChat = signal<{ key: SessionKey; title: string; partial?: PartialWhy; store?: ChatStore } | null>(null);

/** WHY an export would be short of the whole session, which decides what there is to say about it. `"more"` can be
 *  acted on — the rest is still on the runtime; `"gone"` cannot, and telling someone to load what no longer exists
 *  is worse than saying nothing. They were one boolean before, wired to `"gone"` and worded for `"more"`, so the
 *  warning appeared exactly when it could not be followed and stayed silent when it could. */
export type PartialWhy = "more" | "gone";

/** One shape a session can leave in: what the file is, and who it is for. */
interface Format { id: string; label: string; hint: string; run: (key: string) => void; needsPrint?: boolean }
const FORMATS: Format[] = [
    { id: "md", label: "Markdown", hint: "readable, screenshots as files", run: exportSession },
    { id: "pdf", label: "PDF", hint: "one file, to hand to someone", run: printSession, needsPrint: true },
    { id: "json", label: "JSON", hint: "every field, for a program", run: exportSessionJson },
];

/** The export picker. Rendered once by the app; it draws nothing until {@link exportingChat} is set. */
export function ExportChat() {
    const it = exportingChat.value;
    const [pick, setPick] = useState<string>("md");
    // The pull's own state: null until one is running, so the dialog is unchanged for a session already whole.
    const [pulling, setPulling] = useState<{ done: number; total: number } | null>(null);
    const [failed, setFailed] = useState<string | null>(null);
    const stop = useRef<AbortController | null>(null);
    if (!it) return null;
    // PDF is really "print this document and choose Save as PDF", so a surface with no print dialog cannot offer it
    // (the phone app's WebView). Left out rather than disabled: there is nothing the reader could do about it.
    const formats = FORMATS.filter((f) => !f.needsPrint || canPrintSession());
    const chosen = formats.find((f) => f.id === pick) ?? formats[0];
    const close = () => { stop.current?.abort(); exportingChat.value = null; };
    // FETCH THE REST FIRST, where there is a rest to fetch and the page can ask for it. A file holding the end of a
    // conversation is read as the conversation, so the honest export is the whole session — and the wait is shown
    // rather than hidden, because on a long history over a hub it is a real one.
    const submit = () => {
        if (it.partial !== "more" || !it.store) { chosen.run(it.key); close(); return; }
        const ctl = new AbortController();
        stop.current = ctl;
        setFailed(null);
        void pullAllHistory(it.store, it.key, { signal: ctl.signal, onProgress: setPulling }).then((out) => {
            if (out.kind === "cancelled") { setPulling(null); return; }
            // A pull that broke off still exports: what is held is more than there was, and the dialog says what it
            // is. Refusing would leave the reader with nothing over a session they can see on the screen behind it.
            if (out.kind === "failed") setFailed(out.why);
            chosen.run(it.key);
            close();
        });
    };
    return (
        <Dialog onClose={close} labelledBy="chat-exp-h" onSubmit={submit}>
            <h2 id="chat-exp-h">Export chat</h2>
            <p>{truncate(it.title, 80)}</p>
            <div class="chat-export-picks" role="radiogroup" aria-labelledby="chat-exp-h">
                {formats.map((f) => (
                    <label key={f.id} class={`chat-export-opt${pick === f.id ? " on" : ""}`}>
                        <input type="radio" name="chat-export-format" value={f.id} checked={pick === f.id}
                            onChange={() => setPick(f.id)} />
                        <b>{f.label}</b><span class="chat-export-hint">{f.hint}</span>
                    </label>
                ))}
            </div>
            {/* A long session is paged: what is in hand is the end of it, and a file that quietly holds only that
                would be read as the whole conversation. Said here rather than after the download. */}
            {it.partial === "more" && !pulling ? <p class="chat-dialog-hint">Only the end of this session is loaded. Exporting fetches the rest first.</p> : null}
            {pulling ? (
                <div class="chat-export-pull">
                    <progress class="chat-export-bar" value={pulling.done} max={pulling.total || 1} />
                    <span>{pulling.done.toLocaleString()} of {pulling.total.toLocaleString()} earlier events</span>
                </div>
            ) : null}
            {failed ? <p class="chat-dialog-hint">{failed} — exporting what was fetched.</p> : null}
            {it.partial === "gone" ? <p class="chat-dialog-hint">Only part of this session: the rest no longer exists on the runtime, so this is what was kept.</p> : null}
            <div class="chat-dialog-actions">
                <button type="button" class="btn" onClick={close}>Cancel</button>
                <button type="submit" class="btn primary">Export</button>
            </div>
        </Dialog>
    );
}
