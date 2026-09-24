// export-dialog.tsx — "Export chat", as a picker over the three shapes a session is already written out in.
//
// The formats and every byte they produce are `src/sidebar/export.ts`, unchanged and shared with the extension's own
// export menu: this is the CHOOSING, in the shape the page's other decisions take (a dialog with Cancel and the verb).
// A menu of formats, which is what the panel has, answers "which one" by making you pick before you have read what
// they are for; here the three sit together with a line each.

import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import type { SessionKey } from "../session-host";
import { canPrintSession, exportSession, exportSessionJson, printSession } from "../sidebar/export";
import { truncate } from "../sidebar/format";
import { Dialog } from "./dialog";

/** The session whose export is being chosen, or null. Set by the header's `⋮`. */
export const exportingChat = signal<{ key: SessionKey; title: string; partial: boolean } | null>(null);

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
    if (!it) return null;
    // PDF is really "print this document and choose Save as PDF", so a surface with no print dialog cannot offer it
    // (the phone app's WebView). Left out rather than disabled: there is nothing the reader could do about it.
    const formats = FORMATS.filter((f) => !f.needsPrint || canPrintSession());
    const chosen = formats.find((f) => f.id === pick) ?? formats[0];
    const close = () => (exportingChat.value = null);
    return (
        <Dialog onClose={close} labelledBy="chat-exp-h" onSubmit={() => { chosen.run(it.key); close(); }}>
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
            {it.partial ? <p class="chat-dialog-hint">Only the part of this session loaded here. Show earlier turns first to export them too.</p> : null}
            <div class="chat-dialog-actions">
                <button type="button" class="btn" onClick={close}>Cancel</button>
                <button type="submit" class="btn primary">Export</button>
            </div>
        </Dialog>
    );
}
