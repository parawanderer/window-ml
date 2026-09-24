// code-size.ts — HOW BIG CODE IS IN THE TRANSCRIPT, as this phone's own setting. The page has the same choice on its
// "This page" tab; the app had none, so a code block on a phone was whatever the page shipped with.
//
// The APP owns it and the PAGE applies it: the WebView keeps nothing (mobile/AGENTS.md), so the value lives in
// AsyncStorage here and rides to the page on the theme message (`BridgeTheme.codeSize`), beside the scheme and the
// insets — the other things the app decides and the page draws.
//
// The sizes themselves are `src/native/text-size.ts`, shared with the page, because a size the app offers that the page does
// not honour is a control that does nothing.
//
// PANEL TEXT SIZE, the page's other size setting, is deliberately absent: `--panel-fs` drives the docked panels — the
// resource graphs, the Python bench, the housekeeping log — and this app has none of them. Offering it would be a
// control with nothing to change.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { CODE_DEFAULT, CODE_SIZES } from "../../src/native/text-size";

const KEY = "wml-code-size";

let size = CODE_DEFAULT;
const listeners = new Set<() => void>();
const snapshot = (): number => size;

/** Read this device's code size into memory. Call once at startup, beside the drafts and the pinned models. */
export async function loadCodeSize(): Promise<void> {
    try {
        const raw = await AsyncStorage.getItem(KEY);
        const px = raw == null ? NaN : Number(raw);
        // A size not on the list is one the page would not honour, so it is not one this device keeps.
        size = CODE_SIZES.some((o) => o.px === px) ? px : CODE_DEFAULT;
    } catch { size = CODE_DEFAULT; }
    for (const cb of listeners) cb();
}

/** Set the size code is drawn at here. Ignores anything not on the shared list. */
export function setCodeSize(px: number): void {
    if (!CODE_SIZES.some((o) => o.px === px)) return;
    size = px;
    for (const cb of listeners) cb();
    void AsyncStorage.setItem(KEY, String(px));
}

/** The size code is drawn at, re-rendering the caller when it changes. */
export function useCodeSize(): number {
    return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, snapshot, snapshot);
}
