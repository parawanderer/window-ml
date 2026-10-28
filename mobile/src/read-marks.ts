// read-marks.ts — WHAT THIS PHONE HAS SHOWN YOU: the app's copy of the page's `readState`
// (src/chat/view-mode.tsx), with the rule itself shared (src/chat/read-marks.ts). A session with news since this phone
// first loaded its marks is unread until it has been open here, and is unread again if it moves on.
//
// THE PHONE'S OWN, as on the page: what the laptop showed you, the phone in your pocket did not.
//
// Storage is AsyncStorage, read once at startup into memory (`loadReadMarks`, beside `loadPinnedOrder`), so the list
// does not draw every row unread on its first frame and then drop them.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { hasBaseline, markSeen, readStateFrom, type ReadState } from "../../src/chat/read-marks";

const KEY = "wml-read-marks";

let marks: ReadState = { since: Date.now(), seen: {} };
const listeners = new Set<() => void>();
const snapshot = (): ReadState => marks;

/** Read this phone's marks into memory. Call once, before the first list. */
export async function loadReadMarks(): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        const stored: unknown = raw ? JSON.parse(raw) : undefined;
        marks = readStateFrom(stored, Date.now());
        // The baseline is taken ONCE: stored now, so the next launch finds it.
        if (!hasBaseline(stored)) void AsyncStorage.setItem(KEY, JSON.stringify(marks));
    } catch { marks = readStateFrom(undefined, Date.now()); }   // unreadable or absent: nothing is unread yet
    for (const cb of listeners) cb();
}

/** Record that this phone has shown session `key` up to its event at `lastTs`; no write if it had. */
export function markRead(key: string, lastTs: number): void {
    const next = markSeen(marks, key, lastTs);
    if (next === marks) return;
    marks = next;
    for (const cb of listeners) cb();
    void AsyncStorage.setItem(KEY, JSON.stringify(marks));
}

/** The stored marks, re-rendering the caller when they change. */
export function useReadMarks(): ReadState {
    return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot, snapshot);
}
