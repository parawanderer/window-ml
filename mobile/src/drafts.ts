// drafts.ts — WHAT YOU TYPED, kept until a runtime has taken it: the app's copy of the page's rules
// (src/sidebar/drafts.ts). The box is saved per session as it is typed; sending empties it at once but HOLDS the text
// until the send's answer arrives; a failure puts it back in front of anything typed since; a send still held when the
// app died comes back on the next start. Storage is AsyncStorage, read once at startup into memory, so a box can draw its
// draft synchronously.

import AsyncStorage from "@react-native-async-storage/async-storage";

const DRAFT = "wml-draft:";
const SENDING = "wml-sending:";

/** Drafts in memory, mirrored to storage on every change. */
const drafts = new Map<string, string>();
/** Sends in flight: those of this run, and (after `loadDrafts`) none left over from a dead one. */
const held = new Map<string, { id: string; text: string }[]>();
const listeners = new Set<(key: string) => void>();
let seq = 0;

/** Read every draft into memory, putting back any send the last run left unconfirmed. Call once, before the first box. */
export async function loadDrafts(): Promise<void> {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(DRAFT) || k.startsWith(SENDING));
    const pairs = await AsyncStorage.multiGet(keys);
    for (const [k, v] of pairs) if (k.startsWith(DRAFT) && v) drafts.set(k.slice(DRAFT.length), v);
    for (const [k, v] of pairs) {
        if (!k.startsWith(SENDING) || !v) continue;
        const key = k.slice(SENDING.length);
        let unsent: { text: string }[] = [];
        try { unsent = JSON.parse(v); } catch { /* unreadable: nothing to restore */ }
        if (unsent.length) drafts.set(key, joinDraft(unsent.map((u) => u.text).join("\n\n"), drafts.get(key) ?? ""));
        await AsyncStorage.removeItem(k);
        await persist(key);
    }
}

/** Put text that did not get through in front of what the box holds now, a blank line between. */
export function joinDraft(unsent: string, typed: string): string {
    return [unsent, typed].filter((t) => t.trim()).join("\n\n");
}

async function persist(key: string): Promise<void> {
    const t = drafts.get(key);
    if (t) await AsyncStorage.setItem(DRAFT + key, t);
    else await AsyncStorage.removeItem(DRAFT + key);
}

/** The box's text for `key`. */
export const draftOf = (key: string): string => drafts.get(key) ?? "";

/** Save the box's text as typed. */
export function saveDraft(key: string, text: string): void {
    if (text) drafts.set(key, text); else drafts.delete(key);
    void persist(key);
}

/** Hear when a failed send has put text back for a key. Returns the unsubscribe. */
export function onDraftRestored(cb: (key: string) => void): () => void {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
}

/** Send, holding the text until `send` resolves: the box is emptied at once, and a failure puts the text back. */
export async function sendHeld(key: string, text: string, send: () => Promise<{ ok: boolean; error?: string }>): Promise<{ ok: boolean; error?: string }> {
    const id = `${Date.now()}-${++seq}`;
    const list = [...(held.get(key) ?? []), { id, text }];
    held.set(key, list);
    await AsyncStorage.setItem(SENDING + key, JSON.stringify(list));
    saveDraft(key, "");
    let r: { ok: boolean; error?: string };
    try { r = await send(); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    const rest = (held.get(key) ?? []).filter((h) => h.id !== id);
    held.set(key, rest);
    if (rest.length) await AsyncStorage.setItem(SENDING + key, JSON.stringify(rest)); else await AsyncStorage.removeItem(SENDING + key);
    if (!r.ok) {
        saveDraft(key, joinDraft(text, draftOf(key)));
        for (const cb of listeners) cb(key);
    }
    return r;
}
