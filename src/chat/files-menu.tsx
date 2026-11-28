// files-menu.tsx — what a row of the files panel offers: hide it from the model, or show it again, each a `policy.files`
// command (FILE_ATTACHMENTS.md, "The file browser shows the mounts, and its menu sends commands", item 2).
//
// A hiding rule matches STORED paths, so the menu is offered only on a page the runtime listed with `detail` (this
// browser's own pages), whose entries carry the stored name. A hub client sees shown names only and gets no menu: a
// rule written from a shown name would hold nothing. The runtime decides that gate from the sender; this one only keeps
// the menu from offering what would not work.
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FileListEntry, SessionKey } from "../session/session-host";
import { parseSessionKey } from "../session/session-host";
import { IconEye, IconEyeOff, IconMore } from "../sidebar/icons";
import { Dialog } from "../sidebar/dialog";
import { truncate } from "../sidebar/format";
import { MenuItem } from "./menu";
import type { ChatStore } from "./chat-store";

/** What the menu would send for one row: hide its stored path, show it, or remove the session rule that hides exactly it. */
export type FileAction =
    | { kind: "hide"; source: string }
    | { kind: "show"; source: string }
    | { kind: "remove"; id: string };

/** Characters a pattern reads as a glob: a stored name holding one cannot be written as a literal source. */
const GLOB_CHARS = /[*?[]/;

/**
 * The one item a row's menu offers, or null for none.
 * - Not a `detail` page, or no stored path: none (a hub listing; a rule needs the stored path).
 * - A stored segment with `*`, `?` or `[`: none, since a literal source would be read as a glob and could match other files.
 * - Shown: hide the stored path, in this session.
 * - Hidden, `unhide: "remove"`: remove that rule (a session `hide` on exactly this path).
 * - Hidden, `unhide: "show"`: a file gets a session `show` on its path, which wins over a directory's or a glob's rule
 *   and over every global one; a directory gets none, since a `show` releases the row and nothing under it.
 * - Hidden with no `unhide` (the runtime could not say which rule): none.
 * @param entry the row
 * @param stored the row's stored path under `/files/`, session-relative; null when a parent's was not known
 * @param detail whether the row's page was listed with `detail`
 */
export function fileAction(entry: FileListEntry, stored: string | null, detail: boolean): FileAction | null {
    if (!detail || stored == null || stored === "") return null;
    if (stored.split("/").some((seg) => GLOB_CHARS.test(seg))) return null;
    const source = `/files/${stored}`;
    if (!entry.hidden) return { kind: "hide", source };
    if (entry.unhide === "remove" && entry.hiddenBy) return { kind: "remove", id: entry.hiddenBy };
    if (entry.unhide === "show" && entry.kind === "file") return { kind: "show", source };
    return null;
}

/** The show waiting for the person's confirmation, one at a time; `exposes` once the runtime said a removal widens. */
const showing = signal<{ store: ChatStore; key: SessionKey; entry: FileListEntry; label: string; action: Extract<FileAction, { kind: "show" | "remove" }>; exposes?: string[] } | null>(null);   // state: ui — one confirmation at a time

/**
 * Send a hide at once (it only narrows), or open the confirmation a show goes through.
 * @param store the page's store
 * @param key the session
 * @param entry the row
 * @param label the name the row shows
 * @param action what `fileAction` said
 */
export async function runFileAction(store: ChatStore, key: SessionKey, entry: FileListEntry, label: string, action: FileAction): Promise<void> {
    if (action.kind !== "hide") { showing.value = { store, key, entry, label, action }; return; }
    const session = parseSessionKey(key);
    if (!session) return;
    // A refusal is a notice (ChatStore.send); a hide that lands sends `files-changed`, and the row re-lists hidden.
    await store.send({ type: "policy.files", session, op: "add", effect: "hide", source: action.source, scope: "session" });
}

/**
 * A row's `⋮` and its one item. Drawn only where `fileAction` names one.
 *
 * @group chat
 * @gallery none opens a menu on a click; drawn in the panel's flow
 */
export function FileRowMenu({ store, sessionKey, entry, label, action }: { store: ChatStore; sessionKey: SessionKey; entry: FileListEntry; label: string; action: FileAction }) {
    const [open, setOpen] = useState<{ top: number; left: number } | null>(null);
    const btn = useRef<HTMLButtonElement>(null);
    const menu = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!open) return;
        const close = () => setOpen(null);
        const onDown = (e: Event) => { const t = e.target as Node; if (!menu.current?.contains(t) && !btn.current?.contains(t)) close(); };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { close(); btn.current?.focus(); } };
        document.addEventListener("pointerdown", onDown);
        document.addEventListener("keydown", onKey);
        document.addEventListener("scroll", close, true);
        return () => {
            document.removeEventListener("pointerdown", onDown);
            document.removeEventListener("keydown", onKey);
            document.removeEventListener("scroll", close, true);
        };
    }, [!!open]);
    const hide = action.kind === "hide";
    return (
        <>
            <button ref={btn} class={`fp-more-btn hbtn${open ? " on" : ""}`} aria-label={`Options for ${truncate(label, 60)}`} aria-haspopup="menu" aria-expanded={!!open}
                onClick={(e) => {
                    e.stopPropagation();
                    if (open) { setOpen(null); return; }
                    const r = btn.current?.getBoundingClientRect();
                    if (r) setOpen({ top: r.bottom + 4, left: Math.max(8, r.right - 190) });
                }}>
                <IconMore />
            </button>
            {open ? (
                <div ref={menu} class="chat-menu fp-menu" role="menu" style={`top:${open.top}px;left:${open.left}px`}>
                    <MenuItem icon={hide ? <IconEyeOff /> : <IconEye />} label={hide ? "Hide from the model" : "Show to the model…"}
                        onPick={() => { setOpen(null); void runFileAction(store, sessionKey, entry, label, action); }} />
                </div>
            ) : null}
        </>
    );
}

/** What showing exposes, in words: a file the model can read from its next cell, or a folder and what is in it. */
export function showWords(entry: FileListEntry, label: string): string {
    return entry.kind === "dir"
        ? `The model can read ${label} and everything in it that no other rule hides, from its next cell.`
        : `The model can read ${label} from its next cell.`;
}

/**
 * The confirmation a show goes through, mounted once by the panel. A show exposes as a removal does, so both ask first;
 * a removal the runtime answers with `confirm` (other rules would then decide) says so and asks again.
 *
 * @group chat
 * @gallery none opened by the row menu's Show; drawn in the panel's flow
 */
export function FileShowConfirm() {
    const c = showing.value;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const cancel = useRef<HTMLButtonElement>(null);
    useEffect(() => { setBusy(false); setError(null); }, [c]);
    if (!c) return null;
    const close = () => { showing.value = null; };
    const go = async () => {
        const session = parseSessionKey(c.key);
        if (!session) { close(); return; }
        setBusy(true);
        const r = c.action.kind === "show"
            ? await c.store.send({ type: "policy.files", session, op: "add", effect: "show", source: c.action.source, scope: "session" }, { quiet: true })
            : await c.store.send({ type: "policy.files", session, op: "remove", id: c.action.id, ...(c.exposes ? { confirm: true } : {}) }, { quiet: true });
        setBusy(false);
        if (!r.ok) { setError(r.error.message || "The rule could not be changed"); return; }
        const d = r.data as { removed?: boolean; confirm?: { exposes: string[] } };
        if (d.removed === false && d.confirm) { showing.value = { ...c, exposes: d.confirm.exposes }; return; }
        close();
    };
    return (
        <Dialog onClose={close} labelledBy="fp-show-h" describedBy="fp-show-p" alert initialFocus={cancel}>
            <h2 id="fp-show-h">Show this to the model?</h2>
            <p id="fp-show-p">{showWords(c.entry, truncate(c.label, 80))}</p>
            {c.exposes ? <p class="chat-dialog-hint">{c.exposes.length
                ? `Removing this rule lets ${c.exposes.length === 1 ? "another rule" : `${c.exposes.length} other rules`} decide: ${c.exposes.join(", ")}.`
                : "Removing this rule widens what the model can read, and nothing else hides it."} Show it anyway?</p> : null}
            {error ? <p class="chat-dialog-hint" role="alert">{error}</p> : null}
            <div class="chat-dialog-actions">
                <button ref={cancel} class="btn" onClick={close}>Cancel</button>
                <button class="btn primary" disabled={busy} onClick={go}>{busy ? "Showing…" : "Show"}</button>
            </div>
        </Dialog>
    );
}
