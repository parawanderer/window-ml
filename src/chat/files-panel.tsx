// files-panel.tsx — the session's files as a plain file tree, in a panel beside the chat (docs/spec/FILE_ATTACHMENTS.md,
// "The files panel" and "The file browser shows the mounts").
//
// The BASE is what any file browser shows: a name, a size, a time and a kind per row, folders that open. It reads
// nothing of ours. Everything specific to window.ml is an ANNOTATION laid on a row by `RowNotes` (hidden, read-only,
// "the model sees this as <name>"), kept apart so that removing one never changes the base row.
//
// Listing is lazy: a directory is asked for (`files.list`, one page) when the person opens it, and dropped when they
// close it, so a closed directory holds nothing and reopening it asks again. Whether the panel is open is remembered
// per device and never moved by an attach: the header button's count moves instead.
import { signal } from "@preact/signals";
import { useEffect, useMemo } from "preact/hooks";
import type { FileListEntry } from "../session/session-host";
import type { SessionKey } from "../session/session-host";
import { formatBytes } from "../resource/resource-model";
import { IconChevron, IconClose, IconEye, IconEyeOff, IconFile } from "../sidebar/icons";
import { shortStamp, fullStamp } from "../sidebar/format";
import { cursorTipOn } from "../sidebar/ui-kit";
import type { ChatStore } from "./chat-store";
import type { PlatformPrefs } from "./platform";

/** The preference key the panel's open state is remembered under, on this device. */
export const FILES_OPEN_KEY = "view.files";

/** Is the files panel open? Remembered per device (`loadFilesOpen`); an attach never changes it. */
export const filesOpen = signal<boolean>(false);   // state: ui (remembered per device in the platform prefs)
let prefsRef: PlatformPrefs | null = null;          // state: plumbing (where `setFilesOpen` writes; set once per page)

/** Read the remembered state and keep writing to the same prefs. The page calls it before its first render. */
export function loadFilesOpen(prefs: PlatformPrefs): void {
    if (prefsRef === prefs) return;
    prefsRef = prefs;
    filesOpen.value = prefs.get<boolean>(FILES_OPEN_KEY) === true;
}

/** Open or close the panel, and remember which. */
export function setFilesOpen(on: boolean): void {
    filesOpen.value = on;
    prefsRef?.set(FILES_OPEN_KEY, on);
}

/** What one open directory holds: the entries of the pages read so far, the cursor of the next, and what is under way. */
export interface DirState {
    entries: readonly FileListEntry[];
    /** the cursor of the next page; absent on the last */
    next?: string;
    loading: boolean;
    /** why the last request failed, in the runtime's words */
    error?: string;
}

const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/** The open directories of one session, by shown path (`""` is the root), and the requests that fill them. */
export class FilesTree {
    /** Open directories only: a closed one holds nothing, so it is asked for again when opened. */
    readonly dirs = signal<ReadonlyMap<string, DirState>>(new Map());
    private readonly gens = new Map<string, number>();

    constructor(private readonly store: ChatStore, readonly key: SessionKey) {}

    private set(path: string, state: DirState | null): void {
        const next = new Map(this.dirs.value);
        if (state) next.set(path, state); else next.delete(path);
        this.dirs.value = next;
    }

    /** Open a directory and ask for its first page. Already open: nothing. */
    open(path: string): void {
        if (this.dirs.value.has(path)) return;
        this.set(path, { entries: [], loading: true });
        void this.read(path, 1);
    }

    /** Close a directory and everything open under it. */
    close(path: string): void {
        if (path === "") return;
        const next = new Map(this.dirs.value);
        for (const p of [...next.keys()]) if (p === path || p.startsWith(`${path}/`)) { next.delete(p); this.gens.delete(p); }
        this.dirs.value = next;
    }

    toggle(path: string): void {
        if (this.dirs.value.has(path)) this.close(path); else this.open(path);
    }

    /** Ask for the page after the last one read. */
    more(path: string): void {
        const d = this.dirs.value.get(path);
        if (!d || d.loading || !d.next) return;
        this.set(path, { ...d, loading: true, error: undefined });
        void this.read(path, 0, d);
    }

    /** List again: the named open directories, or every open one when `dirs` is absent. A directory that is closed is
     *  left alone. It reads back as many pages as were held, so the list does not shrink under the person. */
    relist(dirs?: readonly string[]): void {
        for (const path of this.dirs.value.keys()) {
            if (dirs && !dirs.includes(path)) continue;
            const d = this.dirs.value.get(path)!;
            const pages = Math.max(1, Math.ceil(d.entries.length / Math.max(1, this.pageSize.get(path) ?? d.entries.length)));
            this.set(path, { ...d, loading: true });
            void this.read(path, pages);
        }
    }

    private readonly pageSize = new Map<string, number>();

    /** Read `pages` pages from the start (`from` absent), or the one page after `from`'s cursor; a stale answer, from a
     *  request a later one replaced or a directory closed meanwhile, is dropped. */
    private async read(path: string, pages: number, from?: DirState): Promise<void> {
        const gen = (this.gens.get(path) ?? 0) + 1;
        this.gens.set(path, gen);
        let entries: FileListEntry[] = from ? [...from.entries] : [];
        let cursor = from?.next;
        for (let i = 0; i < Math.max(1, pages); i++) {
            const r = await this.store.listFiles(this.key, path, cursor);
            if (this.gens.get(path) !== gen || !this.dirs.value.has(path)) return;
            if (!r.ok) {
                const was = this.dirs.value.get(path)!;
                this.set(path, { ...was, entries: from ? was.entries : entries, loading: false, error: r.error.message || "Could not list this folder" });
                return;
            }
            if (!from && i === 0) this.pageSize.set(path, r.data.entries.length || this.pageSize.get(path) || 1);
            entries = entries.concat(r.data.entries);
            cursor = r.data.next;
            if (!cursor) break;
        }
        this.set(path, { entries, ...(cursor ? { next: cursor } : {}), loading: false });
    }
}

/** How many files the header button says, and the words for it: with only `attached` known it never presents that as the
 *  total, so the name says "attached". */
export function filesLabel(count: { attached: number; agent?: number }): { n: number; text: string } {
    const n = count.agent == null ? count.attached : count.attached + count.agent;
    const noun = (k: number) => (k === 1 ? "file" : "files");
    return { n, text: count.agent == null ? `${n} attached ${noun(n)}` : `${n} ${noun(n)}` };
}

/**
 * The header button: the files icon and the session's file count, opening and closing the panel. Absent where the runtime
 * has not said (it answers `files.list` as unsupported, or has not answered yet).
 *
 * @group chat
 * @gallery none needs a ChatStore that has been told a count
 */
export function FilesButton({ store, sessionKey }: { store: ChatStore; sessionKey: SessionKey }) {
    const count = store.filesCount.value.get(sessionKey);
    if (!count) return null;
    const { n, text } = filesLabel(count);
    const on = filesOpen.value;
    return (
        <button class={`chat-files-btn${on ? " on" : ""}`} aria-label={text} aria-expanded={on} aria-pressed={on}
            {...cursorTipOn(text)} onClick={() => setFilesOpen(!on)}>
            <IconFile /><span class="chat-files-n">{n}</span>
        </button>
    );
}

/** A folder: the outline of a tab-topped folder, in the family of the other 16-box strokes. */
const IconFolder = () => (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
        <path d="M1.8 3.8h4l1.4 1.6h7v7.4H1.8z" />
    </svg>
);

/** A padlock: the entry cannot be written to. */
const IconLock = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
        <rect x="3.5" y="7" width="9" height="6.5" rx="1.2" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </svg>
);

/**
 * What is particular to window.ml about a row, as icons after the name: hidden from the model, read-only, and the name
 * the model sees where it differs from the one shown. Each carries the panel's tip and an accessible name, so no mark
 * rests on colour alone. A row with none of them is a row of any file browser. Read-only is marked where it starts, on
 * the folder, never again on each row inside it, so a read-only folder of a hundred files carries one mark.
 *
 * @group chat
 * @gallery hidden {"entry": {"name": "keys.env", "kind": "file", "size": 96, "mtimeMs": 1795100000000, "hidden": true, "readonly": false}}
 * @gallery model sees {"entry": {"name": "upload-1.txt", "realName": "quarterly report.txt", "kind": "file", "size": 880, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}}
 * @gallery read-only {"entry": {"name": "out.json", "kind": "file", "size": 700, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}}
 */
export function RowNotes({ entry, parentReadonly = false }: { entry: FileListEntry; parentReadonly?: boolean }) {
    const sees = entry.realName != null && entry.realName !== "" ? entry.name : null;
    // `realName` is what the row shows; the masked `name` is what the model sees it as.
    return (
        <span class="fp-notes">
            {entry.hidden ? <span class="fp-note fp-hidden" role="img" aria-label="Hidden" {...cursorTipOn("Hidden from the model")}><IconEyeOff /></span> : null}
            {sees != null ? <span class="fp-note fp-sees" role="img" aria-label={`The model sees this as ${sees}`} {...cursorTipOn(`The model sees this as ${sees}`)}><IconEye /></span> : null}
            {entry.readonly && !parentReadonly ? <span class="fp-note fp-ro" role="img" aria-label="Read-only" {...cursorTipOn("Read-only")}><IconLock /></span> : null}
        </span>
    );
}

/** The name a row shows: the stored name when the entry has one, else the shown name. */
export const rowLabel = (e: FileListEntry): string => (e.realName != null && e.realName !== "" ? e.realName : e.name);

const truncated = (el: Element) => el.scrollWidth > el.clientWidth;

/** One row of any file browser: the kind's icon (and a chevron for a folder), the name, the size, the time. */
function BaseRow({ entry, open, shared, onToggle, notes, parentReadonly }: { entry: FileListEntry; open: boolean; shared: boolean; onToggle: () => void; notes: boolean; parentReadonly: boolean }) {
    const dir = entry.kind === "dir";
    const label = rowLabel(entry);
    const body = <>
        {dir ? <span class={`tri${open ? " open" : ""}`} aria-hidden="true"><IconChevron /></span> : <span class="tri-gap" aria-hidden="true" />}
        <span class="fp-kind" aria-hidden="true">{dir ? <IconFolder /> : <IconFile />}</span>
        <span class="fp-name" {...cursorTipOn(label, { delayMs: 500, onlyIf: truncated })}>{label}</span>
        {notes ? <RowNotes entry={entry} parentReadonly={parentReadonly} /> : null}
        <span class="fp-size">{dir ? "" : formatBytes(entry.size)}</span>
        <span class="fp-time" {...cursorTipOn(entry.mtimeMs ? fullStamp(entry.mtimeMs) : "No time")}>{entry.mtimeMs ? shortStamp(entry.mtimeMs) : "—"}</span>
    </>;
    // A folder whose shown name two entries share cannot be opened: the runtime refuses the path rather than guess.
    if (dir && shared) return <div class="fp-row fp-dir fp-shared" aria-disabled="true" {...cursorTipOn("Two entries share this name")}>{body}</div>;
    return dir
        ? <button class="fp-row fp-dir" aria-expanded={open} onClick={onToggle}>{body}</button>
        : <div class="fp-row fp-file">{body}</div>;
}

/** One open directory's rows, then a "more" row, a loading row or what went wrong. Rows are keyed by position in the
 *  list: two entries may share a shown name. */
function Level({ dirs, path, onToggle, onMore, notes, readonly = false }: { dirs: ReadonlyMap<string, DirState>; path: string; onToggle: (p: string) => void; onMore: (p: string) => void; notes: boolean; readonly?: boolean }) {
    const d = dirs.get(path);
    if (!d) return null;
    const names = new Map<string, number>();
    for (const e of d.entries) names.set(e.name, (names.get(e.name) ?? 0) + 1);
    return (
        <ul class="fp-level" role={path ? "group" : "tree"} aria-label={path ? undefined : "Files"}>
            {d.entries.map((e, i) => {
                const p = join(path, e.name);
                const open = e.kind === "dir" && dirs.has(p);
                return (
                    <li key={i} role="treeitem" aria-expanded={e.kind === "dir" ? open : undefined}>
                        <BaseRow entry={e} open={open} shared={(names.get(e.name) ?? 0) > 1} onToggle={() => onToggle(p)} notes={notes} parentReadonly={readonly} />
                        {open ? <Level dirs={dirs} path={p} onToggle={onToggle} onMore={onMore} notes={notes} readonly={e.readonly} /> : null}
                    </li>
                );
            })}
            {d.loading ? <li class="fp-status" role="presentation">Loading…</li> : null}
            {!d.loading && d.error ? <li class="fp-status fp-error" role="alert">{d.error}</li> : null}
            {!d.loading && !d.error && d.entries.length === 0 ? <li class="fp-status" role="presentation">Nothing here yet</li> : null}
            {!d.loading && d.next ? <li role="presentation"><button class="fp-more" onClick={() => onMore(path)}>More…</button></li> : null}
        </ul>
    );
}

/**
 * The panel as drawn: a header with its tabs (Files, for now) and a close button, then the tree of what is open.
 * `dirs` holds the open directories by shown path (`""` the root).
 *
 * @group chat
 * @gallery tree {"dirs": {"": {"entries": [{"name": "attached", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}, {"name": "agent", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}, {"name": "archive", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}]}, "attached": {"entries": [{"name": "3fa91c2", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}, {"name": "9b20e11", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}, {"name": "c41d7a0", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}], "next": "3"}, "attached/9b20e11": {"entries": [{"name": "upload-1.txt", "realName": "quarterly report.txt", "kind": "file", "size": 880, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}]}, "agent": {"entries": [{"name": "out.json", "kind": "file", "size": 700, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}, {"name": "data.csv", "kind": "file", "size": 2048, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}, {"name": "data.csv", "kind": "file", "size": 4096, "mtimeMs": 1795100060000, "hidden": false, "readonly": false}, {"name": "plots", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}, {"name": "old", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}, {"name": "old", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}]}}}
 * @gallery closed folders {"dirs": {"": {"entries": [{"name": "attached", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": true}, {"name": "agent", "kind": "dir", "size": 0, "mtimeMs": 1795100000000, "hidden": false, "readonly": false}]}}}
 * @gallery loading {"dirs": {"": {"entries": [], "loading": true}}}
 * @gallery failed {"dirs": {"": {"entries": [], "error": "The runtime is unreachable"}}}
 */
export function FilesPanelView({ dirs, onToggle, onMore, onClose, narrow }: {
    dirs: Record<string, Partial<DirState> & { entries: readonly FileListEntry[] }>;
    onToggle?: (path: string) => void; onMore?: (path: string) => void; onClose?: () => void; narrow?: boolean;
}) {
    const map: ReadonlyMap<string, DirState> = new Map(Object.entries(dirs).map(([k, v]) => [k, { loading: false, ...v } as DirState]));
    return (
        <aside class={`fp${narrow ? " narrow" : ""}`} aria-label="Files panel">
            <div class="fp-head">
                <div class="fp-tabs" role="tablist" aria-label="Panel">
                    <button class="fp-tab" role="tab" aria-selected="true" id="fp-tab-files" aria-controls="fp-panel-files">Files</button>
                </div>
                <span class="sp" />
                <button class="hbtn fp-close" aria-label="Close files" {...cursorTipOn("Close")} onClick={onClose}><IconClose /></button>
            </div>
            <div class="fp-body" role="tabpanel" id="fp-panel-files" aria-labelledby="fp-tab-files">
                <Level dirs={map} path="" onToggle={onToggle ?? (() => undefined)} onMore={onMore ?? (() => undefined)} notes />
            </div>
        </aside>
    );
}

/** The panel for one session: its tree, listing the root when it opens and following the runtime's `files-changed`.
 *
 * @group chat
 * @gallery none needs a ChatStore over a host that lists files; drawn as FilesPanelView */
export function FilesPanel({ store, sessionKey, narrow }: { store: ChatStore; sessionKey: SessionKey; narrow: boolean }) {
    const tree = useMemo(() => new FilesTree(store, sessionKey), [store, sessionKey]);
    useEffect(() => {
        tree.open("");
        const off = store.onFilesChanged((k, c) => { if (k === sessionKey) tree.relist(c.dirs); });
        return () => { off(); tree.close(""); tree.dirs.value = new Map(); };
    }, [tree]);
    return <FilesPanelView dirs={Object.fromEntries(tree.dirs.value)} onToggle={(p) => tree.toggle(p)} onMore={(p) => tree.more(p)} onClose={() => setFilesOpen(false)} narrow={narrow} />;
}
