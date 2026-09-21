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
// Images are kept in memory only: a few pasted screenshots are megabytes, which is past what localStorage will hold.
// They survive leaving and reopening a session and a failed send, not a reload. Every storage call is guarded, since a
// private window or blocked site data throws, and the box must still work.

const DRAFT = "wml-draft:";
const SENDING = "wml-sending:";

/** This page load, so a held send can be told apart from one a dead page left behind. */
const PAGE = Math.random().toString(36).slice(2, 10);
let seq = 0;

/** A send in flight, as kept in storage: its text, and which page load sent it. */
interface Held { id: string; text: string }

/** A send's outcome, as the composer needs it. */
export type SendOutcome = { ok: true } | { ok: false; error?: string };

const images = new Map<string, string[]>();
const heldImages = new Map<string, string[]>();
const listeners = new Set<(key: string) => void>();

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
    }
    return text;
}

/** Save the box's text as typed. Empty removes it. */
export function saveDraft(key: string, text: string): void {
    write(DRAFT + key, text);
}

/** The box's images for `key`, kept in memory. */
export function loadDraftImages(key: string): string[] {
    return images.get(key) ?? [];
}

/** Keep the box's images for `key`. */
export function saveDraftImages(key: string, imgs: string[]): void {
    if (imgs.length) images.set(key, imgs);
    else images.delete(key);
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
export async function sendHeld(key: string, text: string, imgs: string[], send: () => Promise<SendOutcome>): Promise<SendOutcome> {
    const id = `${PAGE}:${++seq}`;
    write(SENDING + key, [...(read<Held[]>(SENDING + key) ?? []), { id, text }]);
    if (imgs.length) heldImages.set(id, imgs);
    // The box was emptied for this send: what is saved as typed is what comes after it.
    saveDraft(key, "");
    saveDraftImages(key, []);
    let r: SendOutcome;
    try { r = await send(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    write(SENDING + key, (read<Held[]>(SENDING + key) ?? []).filter((h) => h.id !== id));
    const held = heldImages.get(id) ?? [];
    heldImages.delete(id);
    if (!r.ok) {
        saveDraft(key, joinDraft(text, read<string>(DRAFT + key) ?? ""));
        saveDraftImages(key, [...held, ...loadDraftImages(key)]);
        for (const cb of listeners) cb(key);
    }
    return r;
}
