// app-update.ts — KEEPING THIS APP UP TO DATE ON ANDROID: asks GitHub whether a newer build is out (the rule is
// src/native/app-update.ts, shared and tested against a fake GitHub), remembers the answer across launches, and
// downloads and hands a new APK to Android's installer. The app is sideloaded research tooling, not a store app, so
// nothing else would ever tell anyone a new build exists.
//
// Android only: iOS has no build to download (a free Apple account cannot distribute one), so on iOS every part of this
// is off and the screens never show it. The check can be turned off in Settings, since each one tells GitHub this
// phone's address.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useSyncExternalStore } from "react";
import { AppState, Platform } from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import { startActivityAsync } from "expo-intent-launcher";
import { checkForUpdate, dueForCheck, updateOff, updateRow, type UpdateCheck, type UpdateOff } from "../../src/native/app-update";
import type { AttentionRow } from "../../src/native/bridge";
import { BUILD } from "./generated/build";

const KEY_ENABLED = "wml-update-check";
const KEY_LAST = "wml-update-last";
const KEY_HIDDEN = "wml-update-hidden";

/** Where a download stands. */
export type Download =
    | { state: "idle" }
    | { state: "downloading"; fraction: number | null }
    /** handed to Android's installer; the person takes it from there */
    | { state: "installing" }
    | { state: "failed"; error: string };

/** Everything the update screens draw. */
export interface UpdateState {
    /** whether this platform can have it at all */
    supported: boolean;
    enabled: boolean;
    /** why there is no check, or null when there is one */
    off: UpdateOff | null;
    last: UpdateCheck | null;
    checking: boolean;
    download: Download;
    /** the inbox items put away, by key */
    hidden: ReadonlySet<string>;
}

let state: UpdateState = {
    supported: Platform.OS === "android", enabled: true, off: null, last: null, checking: false,
    download: { state: "idle" }, hidden: new Set(),
};
state.off = state.supported ? updateOff(BUILD, true) : "no-build";
const listeners = new Set<() => void>();
const set = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    state.off = state.supported ? updateOff(BUILD, state.enabled) : "no-build";
    for (const cb of listeners) cb();
};

/** Read the setting and the last answer into memory, check if one is due, and again whenever the app comes back to
 *  the front. Call once at startup. */
export async function loadAppUpdate(): Promise<void> {
    if (!state.supported) return;
    try {
        const [enabled, last, hidden] = await Promise.all([KEY_ENABLED, KEY_LAST, KEY_HIDDEN].map((k) => AsyncStorage.getItem(k)));
        set({
            enabled: enabled !== "off",
            last: last ? JSON.parse(last) as UpdateCheck : null,
            hidden: new Set(hidden ? JSON.parse(hidden) as string[] : []),
        });
    } catch { /* a first launch, or storage that cannot be read: start empty */ }
    void checkNow();
    AppState.addEventListener("change", (s) => { if (s === "active") void checkNow(); });
}

/** Ask GitHub, if a check is due (or `force`, from the screen's button), and keep the answer. */
export async function checkNow(force = false): Promise<void> {
    if (state.off || state.checking || !dueForCheck(state.last, Date.now(), { force })) return;
    set({ checking: true });
    // A check that hangs (a captive portal) must not leave the button spinning forever.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
        const last = await checkForUpdate(BUILD, fetch, Date.now(), ctl.signal);
        set({ last, checking: false });
        void AsyncStorage.setItem(KEY_LAST, JSON.stringify(last));
    } finally { clearTimeout(timer); if (state.checking) set({ checking: false }); }
}

/** Turn the check on or off. Off forgets the last answer too, so no stale "a newer build is out" lingers. */
export function setUpdateCheck(on: boolean): void {
    set({ enabled: on, ...(on ? {} : { last: null }) });
    void AsyncStorage.setItem(KEY_ENABLED, on ? "on" : "off");
    if (on) void checkNow(true); else void AsyncStorage.removeItem(KEY_LAST);
}

/** Put the inbox item away until the next build. */
export function hideUpdateRow(key: string): void {
    const hidden = new Set(state.hidden).add(key);
    set({ hidden });
    void AsyncStorage.setItem(KEY_HIDDEN, JSON.stringify([...hidden]));
}

/** The update screens' state, re-rendering the caller when it changes. */
export function useAppUpdate(): UpdateState {
    return useSyncExternalStore((cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; }, () => state, () => state);
}

/** The inbox item, when there is a newer build and it was not put away. */
export function useUpdateRow(): AttentionRow | null {
    const u = useAppUpdate();
    return u.off ? null : updateRow(u.last, u.hidden);
}

/** Android's flag letting the installer read the file this app shares with it. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Download the newest APK and open it in Android's package installer. The first time, Android asks whether this app
 * may install apps (Settings → "Install unknown apps"); after that it asks only to confirm the update. An APK signed with
 * a different key than the installed one is refused there, by Android, which is the check that matters: the digest
 * GitHub publishes comes from the same place as the file.
 */
export async function downloadAndInstall(): Promise<void> {
    const last = state.last;
    if (last?.state !== "behind" && last?.state !== "elsewhere" || !last.release.apkUrl || state.download.state === "downloading") return;
    const dir = new Directory(Paths.cache, "updates");
    const target = new File(dir, `window-ml-${last.release.sha.slice(0, 12)}.apk`);
    try {
        // A finished download of THIS build is used again: going to Settings to allow installs cancels the installer,
        // and the press that follows should not fetch 60 MB a second time.
        const kept = target.exists && !!last.release.apkSize && target.size === last.release.apkSize;
        if (!kept) {
            // Only the newest is worth keeping: an older download is 60 MB of nothing.
            if (dir.exists) dir.delete();
            dir.create();
            set({ download: { state: "downloading", fraction: 0 } });
            const task = File.createDownloadTask(last.release.apkUrl, target, {
                onProgress: ({ bytesWritten, totalBytes }) => {
                    // A late progress event must not drag a finished download back to "Downloading… 100%".
                    if (state.download.state !== "downloading") return;
                    set({ download: { state: "downloading", fraction: totalBytes > 0 ? bytesWritten / totalBytes : null } });
                },
            });
            await task.downloadAsync();
        }
        const file = new File(dir, target.name);
        if (!file || !file.exists || file.size === 0) throw new Error("The download came back empty.");
        if (last.release.apkSize && file.size !== last.release.apkSize) throw new Error(`The download is ${file.size} bytes; GitHub said ${last.release.apkSize}.`);
        set({ download: { state: "installing" } });
        await startActivityAsync("android.intent.action.VIEW", {
            data: file.contentUri, type: "application/vnd.android.package-archive", flags: FLAG_GRANT_READ_URI_PERMISSION,
        });
        // Back here: the installer was closed (an update replaces this process instead, so this line is a cancel).
        set({ download: { state: "idle" } });
    } catch (e) {
        set({ download: { state: "failed", error: (e as Error)?.message || "The download failed." } });
    }
}
