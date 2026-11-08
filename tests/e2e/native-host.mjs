// native-host.mjs — a REAL ml.sh process host (window-ml-host's `wmlhost`) for an e2e run: found on disk, registered in
// the test's own browser profile only, and ml.sh turned on with a workspace folder. A spec without the binary skips.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The native messaging name the worker connects to (src/sw/sw-shell.ts). */
export const NATIVE_HOST_NAME = "com.parawanderer.window_ml_host";

/**
 * Where a built `wmlhost` is, or null when there is none, so a spec can skip as the CPython ones do. `E2E_WMLHOST` names
 * one; otherwise a release build in a sibling `window-ml-host*` checkout is used (`cargo build --release` there).
 * @returns {string | null}
 */
export function wmlhostBinary() {
    const named = process.env.E2E_WMLHOST;
    if (named) return fs.existsSync(named) ? path.resolve(named) : null;
    const parent = path.resolve(import.meta.dirname, "../../..");
    const siblings = fs.readdirSync(parent).filter((d) => /^window-ml-host/.test(d)).sort();
    for (const d of siblings) {
        const p = path.join(parent, d, "target/release/wmlhost");
        if (fs.existsSync(p)) return p;
    }
    return null;
}

/**
 * Register `binary` as the native host for the extension `extensionId`, in the browser PROFILE `userDataDir` and nowhere
 * else: never the person's own Chrome profile, which `wmlhost install` would write. Chromium reads the manifest when the
 * worker first calls `connectNative`, so this may run after the launch (the extension's id is only known then).
 * Measured on macOS (Chromium 151) and on Linux (Chromium in Docker, node:26-bookworm, arm64).
 * @param {string} userDataDir the test profile's directory
 * @param {string} extensionId the loaded extension's id
 * @param {string} binary the `wmlhost` to run
 */
export function registerNativeHost(userDataDir, extensionId, binary) {
    const dir = path.join(userDataDir, "NativeMessagingHosts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${NATIVE_HOST_NAME}.json`), JSON.stringify({
        name: NATIVE_HOST_NAME, description: "window-ml process host (e2e test profile)", path: binary, type: "stdio",
        allowed_origins: [`chrome-extension://${extensionId}/`],
    }, null, 2));
}

/** A fresh, empty workspace folder for ml.sh, removed by the caller. Resolved, since macOS's tmpdir is a symlink. */
export function tempWorkspace() {
    return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wml-ws-")));
}

/** A fresh, empty browser profile directory, which `launchExtension({ userDataDir })` uses and the caller removes. */
export function tempProfile() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "wml-profile-"));
}
