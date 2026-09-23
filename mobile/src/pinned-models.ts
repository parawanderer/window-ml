// pinned-models.ts — WHICH MODELS THIS PHONE KEEPS AT THE TOP of every model list: the app's copy of the page's rule
// (`pinnedModels`, src/chat/view-mode.tsx).
//
// THE PHONE'S OWN, and deliberately not shared with the laptop or carried by the hub. Which models someone reaches
// for is a fact about how they work on a screen, and a thumb reaching past forty models on a bus is a different
// problem from a pointer on a desk — so the two devices are allowed different shortlists, exactly as the page and the
// panel already keep their own view preferences.
//
// Storage is AsyncStorage, read once at startup into memory (`loadPinnedModels`, beside `loadDrafts`), so a sheet
// draws in the right order on its first frame rather than reordering under the thumb a moment later.
//
// The SORT itself is `byPinned` in format.ts, which imports nothing from React Native: this module cannot be loaded
// by a test in the root program (its imports do not resolve there), and the ordering is the half worth testing.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";

const KEY = "wml-pinned-models";

let pins = new Set<string>();
const listeners = new Set<() => void>();
/** A new identity per change, so `useSyncExternalStore` sees one — the set is replaced, never mutated. */
const snapshot = (): ReadonlySet<string> => pins;

/** Read this device's pinned models into memory. Call once, before the first sheet. */
export async function loadPinnedModels(): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        const list: unknown = raw ? JSON.parse(raw) : [];
        pins = new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
    } catch { pins = new Set(); }   // unreadable or absent: nothing pinned, which is the default anyway
    for (const cb of listeners) cb();
}

/** Keep a model at the top of this device's lists, or stop. */
export function togglePinnedModel(id: string): void {
    const next = new Set(pins);
    if (!next.delete(id)) next.add(id);
    pins = next;
    for (const cb of listeners) cb();
    void AsyncStorage.setItem(KEY, JSON.stringify([...next]));
}

/** The pinned ids, re-rendering the caller when they change. */
export function usePinnedModels(): ReadonlySet<string> {
    return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot, snapshot);
}
