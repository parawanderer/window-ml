// export-tasks.ts — AN EXPORT THAT OUTLASTS ITS DIALOG, and the inbox items that are the only reason it can.
//
// Exporting a long session fetches the rest of it first (`pull-history.ts`), and over a hub that is a real wait:
// 25,600 events is seconds of work even with nothing on the wire. A modal with a progress bar is the honest thing to
// show for two seconds and the wrong thing to hold someone in for thirty, so past a point the dialog offers to carry
// on without it — and then the work needs somewhere to live that is not a component, and somewhere to be ANNOUNCED
// when it finishes, since by then the reader is looking at something else. Both are here.
//
// WHEN, measured rather than guessed. The temptation is to decide from the session's size, which is known up front;
// that gets it wrong in the only direction that matters, because the same 8,000 events are instant on this machine
// and slow over a phone's hub. So the offer appears from what the pull has ALREADY COST (`shouldOfferBackground`),
// which means a short session never shows it at all — nobody should meet this mechanism to export a chat of twelve
// turns.
//
// NOTHING IS WRITTEN WITHOUT A CLICK. A detached task does not save its file when it finishes: it waits in the
// inbox with the verb on a button. Partly because a download landing minutes later with nothing to explain it reads
// as a bug, partly because the PDF "export" is really a print dialog and springing one on someone is worse than
// that — and partly because a save inside a real click is the one a browser never second-guesses.

import { signal } from "@preact/signals";
import type { SessionKey } from "../session-host";
import { truncate } from "../sidebar/format";
import type { AttentionItem } from "./attention";
import type { ChatStore } from "./chat-store";
import { pullAllHistory, type PullProgress } from "./pull-history";

/** How long a pull has to have taken before going to the background is worth OFFERING, and how much has to be left. */
export const BG_AFTER_MS = 4_000;

/**
 * Should the dialog offer to carry on without it?
 *
 * Yes once the pull has cost {@link BG_AFTER_MS} AND, at the rate actually observed, has at least that much left.
 * The second half is what stops the offer appearing on the last page of a session that was nearly done — arriving
 * just in time to be irrelevant is how a control teaches people to ignore it.
 *
 * `done === 0` after the wait means not one page has landed, which is the slowest case there is, so it qualifies.
 */
export function shouldOfferBackground(p: PullProgress & { elapsedMs: number }): boolean {
    if (p.elapsedMs < BG_AFTER_MS) return false;
    const left = p.total - p.done;
    if (left <= 0) return false;
    const perEvent = p.done > 0 ? p.elapsedMs / p.done : Infinity;
    return perEvent * left >= BG_AFTER_MS;
}

/** One export waiting on its history: what it is for, how far it has got, and what is left to do about it. */
export interface ExportTask {
    id: string;
    key: SessionKey;
    /** the session's title, for saying which export this is when several are running */
    title: string;
    /** what the finished export does, as the word on its button: "Save" for a file, "Print" for the PDF */
    verb: string;
    done: number;
    total: number;
    /** `running` while it pulls, then `ready`, or `failed` with a `why` and a partial history worth writing anyway */
    state: "running" | "ready" | "failed";
    why?: string;
    /** has the dialog let go of it? Until it has, finishing EXPORTS straight away — the reader is watching. */
    detached: boolean;
    /** sticky once {@link shouldOfferBackground} has been true, so the offer cannot flicker away near the end */
    offer: boolean;
    startedTs: number;
}

/** Every export currently pulling, waiting, or stuck. Read it in a render to follow one. */
export const exportTasks = signal<readonly ExportTask[]>([]);

/** The one task the dialog is showing, if any. */
export const exportTask = (id: string | null): ExportTask | undefined =>
    id ? exportTasks.value.find((t) => t.id === id) : undefined;

let seq = 0;
const stoppers = new Map<string, AbortController>();
/** What each task does when it is taken: the export itself, which is the dialog's business and not this file's. */
const finishers = new Map<string, () => void>();

/** Replace a task in place. Replaced, never mutated: the list is a signal, and a mutation is invisible to it. */
function patch(id: string, over: Partial<ExportTask>): void {
    exportTasks.value = exportTasks.value.map((t) => (t.id === id ? { ...t, ...over } : t));
}

function drop(id: string): void {
    stoppers.delete(id);
    finishers.delete(id);
    exportTasks.value = exportTasks.value.filter((t) => t.id !== id);
}

/**
 * Start fetching the rest of a session so it can be exported whole, as a task that can outlive the dialog.
 *
 * `finish` is what the export actually IS — it is called once, either the moment the pull completes with the dialog
 * still watching, or from the inbox when someone takes it. Returns the task's id.
 */
export function startExportPull(opts: { store: ChatStore; key: SessionKey; title: string; verb: string; finish: () => void }): string {
    const id = `x${++seq}`;
    const ctl = new AbortController();
    stoppers.set(id, ctl);
    finishers.set(id, opts.finish);
    const task: ExportTask = { id, key: opts.key, title: opts.title, verb: opts.verb, done: 0, total: 0, state: "running", detached: false, offer: false, startedTs: Date.now() };
    exportTasks.value = [...exportTasks.value, task];
    const onProgress = (p: PullProgress) => {
        const now = exportTask(id);
        if (!now) return;
        const offer = now.offer || shouldOfferBackground({ ...p, elapsedMs: Date.now() - now.startedTs });
        patch(id, { done: p.done, total: p.total, offer });
    };
    void pullAllHistory(opts.store, opts.key, { signal: ctl.signal, onProgress }).then((out) => {
        const now = exportTask(id);
        if (!now) return;                                  // cancelled, and already gone
        if (out.kind === "cancelled") { drop(id); return; }
        // A pull that broke off still exports: what is held is more than there was. Refusing would leave the reader
        // with nothing over a session they can see on the screen behind the dialog.
        const state = out.kind === "failed" ? "failed" : "ready";
        const why = out.kind === "failed" ? out.why : undefined;
        patch(id, { state, why });
        // Still being watched and it worked: do it now. The reader asked for a file and has been sitting in front of
        // a progress bar for it — making them press the button again would be a joke. A FAILED one is left for the
        // dialog to show, because "this is short of the whole session" is the one thing it must not write silently.
        if (!now.detached && state === "ready") takeExport(id);
    });
    return id;
}

/** Let the dialog close and the pull carry on. From here the finished export waits in the inbox. */
export function detachExport(id: string): void { patch(id, { detached: true }); }

/** Stop a pull and forget it. What was already fetched stays in the session — it is history, not a side effect. */
export function cancelExport(id: string): void {
    stoppers.get(id)?.abort();
    drop(id);
}

/** Do the export this task was fetching for, and clear it. */
export function takeExport(id: string): void {
    const run = finishers.get(id);
    drop(id);
    run?.();
}

/** Clear a finished or failed task without exporting it. */
export function dismissExport(id: string): void { drop(id); }

/** What the inbox shows for each task. Nothing while a pull is still the dialog's, because the dialog is saying it. */
export function exportTaskItems(tasks: readonly ExportTask[] = exportTasks.value): AttentionItem[] {
    const out: AttentionItem[] = [];
    for (const t of tasks) {
        if (!t.detached) continue;
        const name = truncate(t.title, 60);
        const counted = `${t.done.toLocaleString()} of ${t.total.toLocaleString()} earlier events`;
        if (t.state === "running") {
            out.push({
                key: `export:${t.id}`, code: "export-pulling", level: "working",
                title: `Fetching the rest of "${name}"`,
                detail: `${counted} so far. The export waits here until it is done, so you can carry on.`,
                progress: { done: t.done, total: t.total },
                fix: { kind: "run", label: "Stop", run: () => cancelExport(t.id) },
            });
            continue;
        }
        if (t.state === "ready") {
            out.push({
                key: `export:${t.id}`, code: "export-ready", level: "ready",
                title: `Export of "${name}" is ready`,
                detail: "The whole session is loaded. Nothing has been written yet.",
                fix: { kind: "run", label: t.verb, run: () => takeExport(t.id) },
                dismiss: () => dismissExport(t.id),
            });
            continue;
        }
        out.push({
            key: `export:${t.id}`, code: "export-failed", level: "ready",
            title: `Could not fetch all of "${name}"`,
            detail: `${t.why ?? "The runtime stopped answering"}. ${counted} were fetched, and exporting now writes those.`,
            fix: { kind: "run", label: `${t.verb} what was fetched`, run: () => takeExport(t.id) },
            dismiss: () => dismissExport(t.id),
        });
    }
    return out;
}
