// read-marks.ts — WHICH BAD ENDINGS THIS PHONE HAS SHOWN YOU: the app's copy of the page's `readMarks`
// (src/chat/view-mode.tsx), with the rule itself shared (src/chat/read-marks.ts). A capped or failed session's list dot
// goes once it has been open here, and comes back if the session moves on and ends badly again.
//
// THE PHONE'S OWN, as on the page: what the laptop showed you, the phone in your pocket did not.
//
// Storage is AsyncStorage, read once at startup into memory (`loadReadMarks`, beside `loadPinnedOrder`), so the list
// does not draw every old dot on its first frame and then drop them.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { markSeen, readMarksFrom, type ReadMarks } from "../../src/chat/read-marks";

const KEY = "wml-read-marks";

let marks: ReadMarks = {};
const listeners = new Set<() => void>();
const snapshot = (): ReadMarks => marks;

/** Read this phone's marks into memory. Call once, before the first list. */
export async function loadReadMarks(): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        marks = readMarksFrom(raw ? JSON.parse(raw) : {});
    } catch { marks = {}; }   // unreadable or absent: every bad ending shows its dot, which is what it did before
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
export function useReadMarks(): ReadMarks {
    return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot, snapshot);
}
