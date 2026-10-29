// drafts.ts — WHAT YOU TYPED, kept until a runtime has taken it: a composer's text survives leaving the session, a reload,
// the phone killing the app, and above all a send that FAILS. A chat app that empties the box on send and then reports
// the network error has thrown away the one thing the person cannot get back.
//
// Three rules:
//   - The box's text is saved as it is typed, per session key (or `start` for the new-session page), and read back
//     when the box is drawn again.
//   - Sending empties the box AT ONCE (it is free for the next thing), but the sent text is held, in storage, until
//     the send's result arrives. A success drops it. A failure puts it BACK, in front of whatever was typed since, and
//     tells a box that is on screen to show it; a box that is not on screen finds it when it is next drawn.
//   - A send still held when the page died (the app killed, the tab closed) was never confirmed: the next page load
//     puts it back in the box. The transcript says whether it arrived; losing it is the worse mistake.
//
// Attached FILES ride the same mechanism: kept in memory, written through to the same IndexedDB store (a record's
// items are JSON strings of `{ name, type, text }`, or a PDF's `{ name, type, data }`, instead of data URLs), held with
// a send and put back with it when the send fails or its page died. Only files that will be sent are kept; a refused
// file is not a draft.
//
// Images are kept in memory (the synchronous source: `loadDraftImages` never waits) AND written through to IndexedDB
// (`ml-drafts`), since a few pasted screenshots are megabytes, past what localStorage will hold. On load the store is
// read back in the background; each key it restores fills the memory and tells the listeners, so a box already drawn
// shows its images. A save made on this page load before that read finishes wins over the restored copy. The images of
// a send still held when the page died come back exactly when its text does (`loadDraft`, lazily, never at load:
// another tab's send may still be live). The store is capped (see `CAP_BYTES`), least recently saved key first. Every
// storage call is guarded, since a private window or blocked site data throws, and the box must still work: it then
// lasts the page, as before.

import type { SentFile } from "../contract/contract-run";
import { cleanFiles } from "../attached-files";

const DRAFT = "wml-draft:";
const SENDING = "wml-sending:";

/** This page load, so a held send can be told apart from one a dead page left behind. */
const PAGE = Math.random().toString(36).slice(2, 10);
let seq = 0;

/** A send in flight, as kept in storage: its text, and which page load sent it. */
interface Held { id: string; text: string }

/** A send's outcome, as the composer needs it. */
export type SendOutcome = { ok: true } | { ok: false; error?: string };

// state: ui (the box's images by session key; written through to IndexedDB `ml-drafts`, docs/dev/state.md)
const images = new Map<string, string[]>();
// state: ui (the images of each send in flight, by send id; also in IndexedDB until the send's result arrives)
const heldImages = new Map<string, string[]>();
// state: ui (the box's attached text files by session key; written through to IndexedDB `ml-drafts`, like the images)
const files = new Map<string, SentFile[]>();
// state: ui (the files of each send in flight, by send id; also in IndexedDB until the send's result arrives)
const heldFiles = new Map<string, SentFile[]>();
// state: plumbing (who hears of a restore)
const listeners = new Set<(key: string) => void>();

// --- the IndexedDB copy of the images ---

/**
 * The most the store keeps, counted in characters of data URL (about bytes). A screenshot is 0.3 to 5 MB, so this holds
 * a dozen of them across several sessions, and stays far below the origin's quota (hundreds of MB) so a draft never
 * crowds out the session archive or the values store. Past it, the least recently saved key goes first.
 */
export const CAP_BYTES = 50 * 1024 * 1024;

const DB_NAME = "ml-drafts";
const STORE = "images";
const IMG = "img:";
const HELD = "held:";
const FIL = "file:";
const HELDF = "heldfile:";

/** One record: a key's box (`img:<key>`) or a send in flight (`held:<id>`). */
interface Rec { id: string; key: string; imgs: string[]; bytes: number; at: number }

// state: plumbing (the open database; null once opening failed, so every later call is a no-op)
let dbp: Promise<IDBDatabase | null> | null = null;
// state: plumbing (every IndexedDB operation runs after the one before it, the restore first)
let queue: Promise<void> = Promise.resolve();
// state: cache (size and age of each stored record, for the cap; built by the restore)
const index = new Map<string, { bytes: number; at: number }>();
// state: plumbing (keys saved on this page load before the restore finished; those win over the stored copy)
const touched = new Set<string>();
// state: cache (the held sends' images the restore found, by send id, until their text is reclaimed or they age out)
const storedHeld = new Map<string, Rec>();
// state: cache (the same, for the held sends' files)
const storedHeldFiles = new Map<string, Rec>();
// state: plumbing (send ids `loadDraft` declared dead before the restore finished, by key; claimed when it does)
const pendingDead = new Map<string, string[]>();
/** A held record no page has claimed for this long is an orphan (its owner is long gone and its text never asked for). */
const ORPHAN_MS = 24 * 60 * 60 * 1000;
let restoring = true;
let lastAt = 0;

const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const committed = (tx: IDBTransaction): Promise<void> => new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

function openDb(): Promise<IDBDatabase | null> {
    dbp ??= (async () => {
        try {
            if (typeof indexedDB === "undefined") return null;
            const r = indexedDB.open(DB_NAME, 1);
            r.onupgradeneeded = () => { r.result.createObjectStore(STORE, { keyPath: "id" }); };
            return await req(r);
        } catch { return null; }
    })();
    return dbp;
}

/** Run `fn` against the database once everything queued before it has finished. Never throws, never rejects. */
function enqueue(fn: (db: IDBDatabase) => Promise<void>): Promise<void> {
    queue = queue.then(async () => {
        const db = await openDb();
        if (db) await fn(db);
    }).catch(() => { /* storage unavailable or full: the draft lasts this page */ });
    return queue;
}

/** Store (or, with no images, delete) one record, then bring the store back under the cap. */
function persist(id: string, key: string, imgs: string[]): void {
    const at = (lastAt = Math.max(Date.now(), lastAt + 1));
    void enqueue(async (db) => {
        const tx = db.transaction(STORE, "readwrite");
        const os = tx.objectStore(STORE);
        if (!imgs.length) { os.delete(id); index.delete(id); }
        else {
            const bytes = imgs.reduce((n, u) => n + u.length, 0);
            os.put({ id, key, imgs, bytes, at } satisfies Rec);
            index.set(id, { bytes, at });
            let total = 0;
            for (const v of index.values()) total += v.bytes;
            // Oldest first; the record just written goes last, and goes too if it alone is over the cap.
            const order = [...index].sort((x, y) => x[1].at - y[1].at);
            for (const [oid, v] of order) {
                if (total <= CAP_BYTES) break;
                os.delete(oid); index.delete(oid); total -= v.bytes;
            }
        }
        await committed(tx);
    });
}

function dropHeld(id: string): void {
    heldImages.delete(id);
    persist(HELD + id, "", []);
}

const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((u, i) => u === b[i]);

/** Files as the records keep them: one JSON string each, so a record's items stay opaque strings for the size cap. */
const packFiles = (fs: readonly SentFile[]): string[] => fs.map((f) => JSON.stringify(f));
const unpackFiles = (items: readonly string[]): SentFile[] => items.flatMap((s) => { try { return cleanFiles([JSON.parse(s)]) ?? []; } catch { return []; } });
const sameFiles = (a: readonly SentFile[], b: readonly SentFile[]): boolean => same(packFiles(a), packFiles(b));

/** Read the store back into the memory; what was saved on this page load meanwhile wins. */
function restore(): void {
    void enqueue(async (db) => {
        const recs = (await req(db.transaction(STORE).objectStore(STORE).getAll())) as Rec[];
        const changed = new Set<string>();
        const changedFiles = new Set<string>();
        for (const r of recs) {
            if (!r || typeof r.id !== "string" || !Array.isArray(r.imgs) || !r.imgs.length) continue;
            if (r.id.startsWith(IMG) && !touched.has(r.key)) {
                index.set(r.id, { bytes: r.bytes, at: r.at });
                lastAt = Math.max(lastAt, r.at);
                images.set(r.key, r.imgs);
                changed.add(r.key);
            }
            if (r.id.startsWith(FIL) && !touched.has(FIL + r.key)) {
                const fs = unpackFiles(r.imgs);
                if (!fs.length) continue;
                index.set(r.id, { bytes: r.bytes, at: r.at });
                lastAt = Math.max(lastAt, r.at);
                files.set(r.key, fs);
                changed.add(r.key);
                changedFiles.add(r.key);
            }
        }
        const now = Date.now();
        for (const r of recs) {
            if (!r || typeof r.id !== "string" || !Array.isArray(r.imgs) || !r.imgs.length || !(r.id.startsWith(HELD) || r.id.startsWith(HELDF))) continue;
            index.set(r.id, { bytes: r.bytes, at: r.at });
            // A held record is only claimed when its text is (`loadDraft`); one nobody claims for a day is an orphan.
            if (now - r.at > ORPHAN_MS) persist(r.id, "", []);
            else if (r.id.startsWith(HELDF)) storedHeldFiles.set(r.id.slice(HELDF.length), r);
            else storedHeld.set(r.id.slice(HELD.length), r);
        }
        restoring = false;
        touched.clear();
        for (const k of changed) if (images.has(k)) persist(IMG + k, k, images.get(k) ?? []);
        for (const k of changedFiles) persist(FIL + k, k, packFiles(files.get(k) ?? []));
        for (const [key, ids] of pendingDead) claimHeld(key, ids);
        pendingDead.clear();
        for (const k of changed) for (const cb of listeners) { try { cb(k); } catch { /* a listener's fault is its own */ } }
    });
    // If the read itself failed the memory simply stays as it is.
    void queue.then(() => { restoring = false; touched.clear(); });
}

/**
 * Move the stored images of the dead sends `ids` in front of `key`'s box, in the order of their text, drop their held
 * records and tell the listeners. Before the restore has read the store, the ids wait for it.
 */
function claimHeld(key: string, ids: string[]): void {
    if (restoring) { pendingDead.set(key, [...(pendingDead.get(key) ?? []), ...ids]); return; }
    const recs = ids.map((id) => storedHeld.get(id)).filter((r): r is Rec => !!r);
    const frecs = ids.map((id) => storedHeldFiles.get(id)).filter((r): r is Rec => !!r);
    for (const id of ids) { storedHeld.delete(id); storedHeldFiles.delete(id); }
    if (!recs.length && !frecs.length) return;
    if (recs.length) {
        images.set(key, [...recs.flatMap((r) => r.imgs), ...(images.get(key) ?? [])]);
        persist(IMG + key, key, images.get(key)!);
    }
    if (frecs.length) {
        files.set(key, [...frecs.flatMap((r) => unpackFiles(r.imgs)), ...(files.get(key) ?? [])]);
        persist(FIL + key, key, packFiles(files.get(key)!));
    }
    for (const r of [...recs, ...frecs]) persist(r.id, "", []);
    // Not inside the caller: it may be a render.
    queueMicrotask(() => { for (const cb of listeners) { try { cb(key); } catch { /* a listener's fault is its own */ } } });
}

/** Resolves once every IndexedDB operation queued so far (the restore included) has finished. For tests and shutdown. */
export function draftsSettled(): Promise<void> {
    return queue;
}

function read<T>(k: string): T | undefined {
    try {
        const raw = localStorage.getItem(k);
        return raw == null ? undefined : (JSON.parse(raw) as T);
    } catch { return undefined; }
}
function write(k: string, v: unknown): void {
    try {
        if (v == null || v === "" || (Array.isArray(v) && !v.length)) localStorage.removeItem(k);
        else localStorage.setItem(k, JSON.stringify(v));
    } catch { /* storage unavailable: the draft lasts this page */ }
}

/** Put text that did not get through in front of what the box holds now, a blank line between. */
export function joinDraft(unsent: string, typed: string): string {
    return [unsent, typed].filter((t) => t.trim()).join("\n\n");
}

/** The box's text for `key`, with any send a previous page load left unconfirmed put back in front of it. */
export function loadDraft(key: string): string {
    const held = read<Held[]>(SENDING + key) ?? [];
    const dead = held.filter((h) => !h.id.startsWith(`${PAGE}:`));
    let text = read<string>(DRAFT + key) ?? "";
    if (dead.length) {
        text = joinDraft(dead.map((h) => h.text).join("\n\n"), text);
        write(DRAFT + key, text);
        write(SENDING + key, held.filter((h) => !dead.includes(h)));
        claimHeld(key, dead.map((h) => h.id));
    }
    return text;
}

/** Save the box's text as typed. Empty removes it. */
export function saveDraft(key: string, text: string): void {
    write(DRAFT + key, text);
}

/** The box's images for `key`: the memory's, which the IndexedDB copy fills in shortly after load. */
export function loadDraftImages(key: string): string[] {
    return images.get(key) ?? [];
}

/** Keep the box's images for `key`. */
export function saveDraftImages(key: string, imgs: string[]): void {
    // The composer saves its (still empty) list on mount; that changes nothing and must not beat the restore.
    if (same(images.get(key) ?? [], imgs)) return;
    if (restoring) touched.add(key);
    if (imgs.length) images.set(key, imgs);
    else images.delete(key);
    persist(IMG + key, key, imgs);
}

/** The box's attached text files for `key`: the memory's, which the IndexedDB copy fills in shortly after load. */
export function loadDraftFiles(key: string): SentFile[] {
    return files.get(key) ?? [];
}

/** Keep the box's attached text files for `key`. */
export function saveDraftFiles(key: string, fs: readonly SentFile[]): void {
    if (sameFiles(files.get(key) ?? [], fs)) return;
    if (restoring) touched.add(FIL + key);
    if (fs.length) files.set(key, [...fs]);
    else files.delete(key);
    persist(FIL + key, key, packFiles(fs));
}

/** Call `cb(key)` when a failed send has put text back for `key`. Returns the unsubscribe. */
export function onDraftRestored(cb: (key: string) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

/**
 * Send, holding what was sent until the result says it arrived. The caller empties its box first; on a failure the
 * text and images come back into the saved draft for `key` (in front of anything typed meanwhile) and every listener
 * hears of it. Never throws: a `send` that throws counts as a failure.
 */
export async function sendHeld(key: string, text: string, imgs: string[], send: () => Promise<SendOutcome>, attached: readonly SentFile[] = []): Promise<SendOutcome> {
    const id = `${PAGE}:${++seq}`;
    write(SENDING + key, [...(read<Held[]>(SENDING + key) ?? []), { id, text }]);
    if (imgs.length) { heldImages.set(id, imgs); persist(HELD + id, key, imgs); }
    if (attached.length) { heldFiles.set(id, [...attached]); persist(HELDF + id, key, packFiles(attached)); }
    // The box was emptied for this send: what is saved as typed is what comes after it.
    saveDraft(key, "");
    saveDraftImages(key, []);
    saveDraftFiles(key, []);
    let r: SendOutcome;
    try { r = await send(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    write(SENDING + key, (read<Held[]>(SENDING + key) ?? []).filter((h) => h.id !== id));
    const held = heldImages.get(id) ?? [];
    if (!r.ok) {
        saveDraft(key, joinDraft(text, read<string>(DRAFT + key) ?? ""));
        saveDraftImages(key, [...held, ...loadDraftImages(key)]);
        saveDraftFiles(key, [...(heldFiles.get(id) ?? []), ...loadDraftFiles(key)]);
        for (const cb of listeners) cb(key);
    }
    // After the failure path has saved them again, so a death in between loses nothing.
    if (imgs.length) dropHeld(id);
    if (attached.length) { heldFiles.delete(id); persist(HELDF + id, "", []); }
    return r;
}

restore();
