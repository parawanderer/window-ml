// pinned-order.ts — THE ORDER OF THIS PHONE'S PINNED GROUP: the app's copy of the page's rule (`orderPins`,
// src/chat/view-mode.tsx), with the placing itself shared (`placePins`, src/chat/pin-order.ts).
//
// THE PHONE'S OWN, as on the page: which conversation sits on top is a fact about how someone works on this screen.
// The pins are the runtime's (a session's `pinned`); only their order is kept here, so a pin made on the laptop shows
// up at the end of the group until it is dragged into place.
//
// Storage is AsyncStorage, read once at startup into memory (`loadPinnedOrder`, beside `loadPinnedModels`), so the
// list draws in the right order on its first frame rather than reordering under the thumb a moment later.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { placePins } from "../../src/chat/pin-order";

const KEY = "wml-pinned-order";

let order: readonly string[] = [];
const listeners = new Set<() => void>();
/** A new identity per change, so `useSyncExternalStore` sees one — the array is replaced, never mutated. */
const snapshot = (): readonly string[] => order;

/** Read this phone's pin order into memory. Call once, before the first list. */
export async function loadPinnedOrder(): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        const list: unknown = raw ? JSON.parse(raw) : [];
        order = Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
    } catch { order = []; }   // unreadable or absent: the runtime's pins by recency, which is the default anyway
    for (const cb of listeners) cb();
}

/**
 * Put the pins the group SHOWS in this order (`shown`, after a drag). A key in `gone` is a session this phone can see
 * is no longer pinned, and is forgotten rather than kept holding a slot; one it cannot see (its runtime offline) keeps
 * its slot, so it comes back where it was.
 */
export function setPinnedOrder(shown: readonly string[], gone: ReadonlySet<string> = new Set()): void {
    order = placePins(order.filter((k) => !gone.has(k)), shown);
    for (const cb of listeners) cb();
    void AsyncStorage.setItem(KEY, JSON.stringify(order));
}

/** A pin made on this phone goes on the end of the order (`on`); an unpin forgets its place. */
export function pinPlaced(key: string, on: boolean): void {
    order = [...order.filter((k) => k !== key), ...(on ? [key] : [])];
    for (const cb of listeners) cb();
    void AsyncStorage.setItem(KEY, JSON.stringify(order));
}

/** The stored order, re-rendering the caller when it changes. */
export function usePinnedOrder(): readonly string[] {
    return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot, snapshot);
}
