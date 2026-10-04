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
import { Dialog } from "../sidebar/dialog";
import { cancelExport, detachExport, exportTask, startExportPull, takeExport } from "./export-tasks";
import type { ChatStore } from "./chat-store";

/** The session whose export is being chosen, or null. Set by the header's `⋮`. */
export const exportingChat = signal<{ key: SessionKey; title: string; partial?: PartialWhy; store?: ChatStore } | null>(null);

/** WHY an export would be short of the whole session, which decides what there is to say about it. `"more"` can be
 *  acted on — the rest is still on the runtime; `"gone"` cannot, and telling someone to load what no longer exists
 *  is worse than saying nothing. They were one boolean before, wired to `"gone"` and worded for `"more"`, so the
 *  warning appeared exactly when it could not be followed and stayed silent when it could. */
export type PartialWhy = "more" | "gone";

/** One shape a session can leave in: what the file is, who it is for, and the word for DOING it — which the inbox
 *  needs on a button when a long export finishes somewhere the dialog no longer is. */
interface Format { id: string; label: string; hint: string; verb: string; run: (key: string) => void; needsPrint?: boolean }
const FORMATS: Format[] = [
    { id: "md", label: "Markdown", hint: "readable, screenshots as files", verb: "Save", run: exportSession },
    { id: "pdf", label: "PDF", hint: "one file, to hand to someone", verb: "Print", run: printSession, needsPrint: true },
    { id: "json", label: "JSON", hint: "every field, for a program", verb: "Save", run: exportSessionJson },
];

/** The export picker. Rendered once by the app; it draws nothing until {@link exportingChat} is set. */
export function ExportChat() {
    const it = exportingChat.value;
    const [pick, setPick] = useState<string>("md");
    // The PULL is not held here. It is a task (`export-tasks.ts`) this component merely watches, because the whole
    // point is that it can outlive the component — on unmount a `useState`/`useRef` pull would keep running with
    // nobody left able to stop it or report it.
    const [taskId, setTaskId] = useState<string | null>(null);
    const task = exportTask(taskId);
    if (!it) return null;
    // PDF is really "print this document and choose Save as PDF", so a surface with no print dialog cannot offer it
    // (the phone app's WebView). Left out rather than disabled: there is nothing the reader could do about it.
    const formats = FORMATS.filter((f) => !f.needsPrint || canPrintSession());
    const chosen = formats.find((f) => f.id === pick) ?? formats[0];
    const shut = () => { exportingChat.value = null; };
    // Cancel means cancel: a pull this dialog started and still holds is abandoned with it. One that has been let go
    // of is not this dialog's any more, and closing has nothing to do with it.
    const close = () => { if (task && !task.detached) cancelExport(task.id); shut(); };
    const pulling = task?.state === "running";
    // FETCH THE REST FIRST, where there is a rest to fetch and the page can ask for it. A file holding the end of a
    // conversation is read as the conversation, so the honest export is the whole session — and the wait is shown
    // rather than hidden, because on a long history over a hub it is a real one.
    const submit = () => {
        if (pulling) return;
        // A pull that broke off: pressing the verb again writes what it did fetch, which the dialog has just said.
        if (task?.state === "failed") { takeExport(task.id); shut(); return; }
        if (it.partial !== "more" || !it.store) { chosen.run(it.key); shut(); return; }
        setTaskId(startExportPull({
            store: it.store, key: it.key, title: it.title, verb: chosen.verb,
            finish: () => { chosen.run(it.key); exportingChat.value = null; },
        }));
    };
    // THE OFFER IS NOT PREDICTED, it is earned: it appears once the pull has actually been slow for a while
    // (`shouldOfferBackground`), so exporting a short chat never shows this at all.
    const background = () => { if (task) detachExport(task.id); shut(); };
    return (
        <Dialog onClose={close} labelledBy="chat-exp-h" onSubmit={submit}>
            <h2 id="chat-exp-h">Export chat</h2>
            <p>{truncate(it.title, 80)}</p>
            <div class="chat-export-picks" role="radiogroup" aria-labelledby="chat-exp-h">
                {formats.map((f) => (
                    <label key={f.id} class={`chat-export-opt${pick === f.id ? " on" : ""}${task ? " fixed" : ""}`}>
                        <input type="radio" name="chat-export-format" value={f.id} checked={pick === f.id}
                            disabled={!!task} onChange={() => setPick(f.id)} />
                        <b>{f.label}</b><span class="chat-export-hint">{f.hint}</span>
                    </label>
                ))}
            </div>
            {/* A long session is paged: what is in hand is the end of it, and a file that quietly holds only that
                would be read as the whole conversation. Said here rather than after the download. */}
            {it.partial === "more" && !task ? <p class="chat-dialog-hint">Only the end of this session is loaded. Exporting fetches the rest first.</p> : null}
            {task && pulling ? (
                <div class="chat-export-pull">
                    <progress class="chat-export-bar" value={task.done} max={task.total || 1} />
                    <span>{task.done.toLocaleString()} of {task.total.toLocaleString()} earlier events</span>
                </div>
            ) : null}
            {task?.state === "failed" ? <p class="chat-dialog-hint">{task.why}. {task.done.toLocaleString()} of {task.total.toLocaleString()} earlier events were fetched — exporting writes those.</p> : null}
            {it.partial === "gone" ? <p class="chat-dialog-hint">Only part of this session: the rest no longer exists on the runtime, so this is what was kept.</p> : null}
            <div class="chat-dialog-actions">
                <button type="button" class="btn" onClick={close}>Cancel</button>
                {/* The way out of a long wait. It is the LEFT of the two acts and not the primary one: carrying on
                    without the dialog is a reasonable thing to want, not the thing you came here to do. */}
                {task?.offer && pulling ? <button type="button" class="btn" onClick={background}>Continue in the background</button> : null}
                <button type="submit" class="btn primary" disabled={pulling}>
                    {pulling ? "Fetching…" : task?.state === "failed" ? `${chosen.verb} what was fetched` : "Export"}
                </button>
            </div>
        </Dialog>
    );
}
