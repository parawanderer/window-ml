// clean-browser.mjs — Chromium with the extension loaded and NO debugger client on any web page, for
// tests/e2e/detection-surface.spec.mjs.
//
// Playwright attaches to every page it opens and sends `Runtime.enable` there, so under the normal harness
// (harness.mjs) a page already sees a debugger client before the extension does anything: the console-getter check
// fires on every page, extension or not. This launches the same Chromium binary itself, with a remote-debugging port,
// and speaks CDP over one browser-level WebSocket: it opens tabs with `Target.createTarget` (which attaches nothing)
// and attaches only to the extension's service worker, to start runs and rule on gates through the worker's test
// hooks. Whatever debugger client a probe page then sees is the extension's own `chrome.debugger`. It also leaves
// out `--enable-automation`, which Playwright passes and which sets `navigator.webdriver`.

//
// NO BROWSER OUTLIVES ITS RUNNER. The browser is not Playwright's, so Playwright's cleanup does not cover it. It is
// started as the leader of its own process group, and a WATCHDOG (a tiny detached node process) holds a pipe to the
// runner: when the pipe closes, which the kernel does when the runner dies by ANY means including SIGKILL, the
// watchdog kills the group and removes the user-data dir. In-process, `close`, `exit`, SIGINT/SIGTERM/SIGHUP and an
// uncaught exception do the same synchronously. Chosen over a pid-polling watchdog because EOF on a pipe needs no
// timer and no pid-reuse guess, and it works the same on macOS and Linux. Dirs left by runs that died before this
// (or whose watchdog was itself killed) are swept on the next launch, by owner file, never by age alone.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

const DIR_PREFIX = "wml-detect-";

/** @param {number} pid Whether a process with this pid exists. */
function alive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e).code === "EPERM"; }
}

/**
 * Remove `wml-detect-*` user-data dirs under the temp dir whose runner and browser are both gone. A dir is in use if
 * its owner file names a live pid, or its Chrome `SingletonLock` (`host-pid`) does; one with neither record is spared
 * for a minute so a launch still writing its owner file is never swept.
 * @param {string} [tmp]
 */
export function sweepStaleDetectDirs(tmp = os.tmpdir()) {
    let names = [];
    try { names = fs.readdirSync(tmp).filter((n) => n.startsWith(DIR_PREFIX)); } catch { return; }
    for (const n of names) {
        const dir = path.join(tmp, n);
        try {
            const pids = [];
            try { const o = JSON.parse(fs.readFileSync(path.join(dir, "wml-owner.json"), "utf8")); pids.push(o.runner, o.browser); } catch { /* none */ }
            try { pids.push(Number(fs.readlinkSync(path.join(dir, "SingletonLock")).split("-").pop())); } catch { /* none */ }
            const known = pids.some((p) => Number.isInteger(p));
            if (pids.some((p) => alive(p))) continue;
            if (!known && Date.now() - fs.statSync(dir).mtimeMs < 60000) continue;
            fs.rmSync(dir, { recursive: true, force: true });
        } catch { /* another sweep got there first */ }
    }
}

/** The watchdog's program: wait for stdin to close, then kill the browser's group and remove its dir. */
const WATCHDOG = `
const [pgid, dir] = process.argv.slice(1);
const fs = require("fs");
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => {});
const done = () => {
    try { process.kill(-Number(pgid), "SIGKILL"); } catch {}
    setTimeout(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} process.exit(0); }, 300);
};
process.stdin.on("end", done); process.stdin.on("close", done); process.stdin.on("error", done);
process.stdin.resume();
`;

/** Every live browser of this process, killed synchronously by the handlers below. @type {Set<() => void>} */
const live = new Set();
let hooked = false;
/** Install the process-level cleanup once. */
function hook() {
    if (hooked) return;
    hooked = true;
    const all = () => { for (const k of [...live]) k(); };
    process.on("exit", all);
    process.on("uncaughtExceptionMonitor", all);
    for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
        const h = () => {
            all();
            // Hand the signal back so the process still dies of it unless someone else handles it.
            process.removeListener(sig, h);
            if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
        };
        process.on(sig, h);
    }
}

/** A minimal CDP client over the browser endpoint: `send(method, params, sessionId)`, and events by name. */
class Cdp {
    /** @param {string} wsUrl */
    constructor(wsUrl) {
        this.ws = new WebSocket(wsUrl);
        this.id = 0;
        /** @type {Map<number, { resolve: Function, reject: Function }>} */
        this.pending = new Map();
        /** @type {((m: any) => void)[]} */
        this.listeners = [];
        this.ws.onmessage = (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(`${m.error.message} ${m.error.data || ""}`)); else p.resolve(m.result); return; }
            for (const l of this.listeners) l(m);
        };
        this.ready = new Promise((r, j) => { this.ws.onopen = () => r(undefined); this.ws.onerror = (e) => j(e); });
    }
    /** @param {string} method @param {any} [params] @param {string} [sessionId] */
    send(method, params = {}, sessionId) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }
}

/**
 * Launch Chromium with `dist` loaded and no client on any page.
 * @param {{ dist?: string, args?: string[], extension?: boolean }} opts `extension: false` launches the same browser bare
 */
export async function launchClean({ dist = path.resolve("dist"), args = [], extension = true } = {}) {
    sweepStaleDetectDirs();
    hook();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), DIR_PREFIX));
    const ownerFile = path.join(userDataDir, "wml-owner.json");
    fs.writeFileSync(ownerFile, JSON.stringify({ runner: process.pid }));
    const argv = [
        // DETECT_HEADFUL=1 shows the window: the only way to see the "being debugged" infobar, which headless has no
        // browser UI to draw (and so no resize to measure).
        ...(process.env.DETECT_HEADFUL === "1" ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check",
        "--window-size=1280,900",
        // As Playwright does on Linux (its chromiumSandbox defaults off): Ubuntu 24.04's AppArmor kills the namespace sandbox.
        ...(process.platform === "linux" ? ["--no-sandbox"] : []),
        ...(extension ? [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] : []),
        ...args, "about:blank",
    ];
    // detached: the browser leads its own process group, so one kill(-pid) takes its helpers with it.
    const proc = spawn(chromium.executablePath(), argv, { stdio: ["ignore", "ignore", "pipe"], detached: true });
    const watchdog = spawn(process.execPath, ["-e", WATCHDOG, String(proc.pid), userDataDir], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    watchdog.unref();
    watchdog.stdin.on("error", () => {});
    fs.writeFileSync(ownerFile, JSON.stringify({ runner: process.pid, browser: proc.pid }));
    let closed = false;
    const kill = () => {
        if (closed) return;
        closed = true;
        live.delete(kill);
        try { process.kill(-/** @type {number} */ (proc.pid), "SIGKILL"); } catch { /* gone */ }
        try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* busy */ }
        try { watchdog.stdin.end(); } catch { /* gone */ }
    };
    live.add(kill);
    const wsUrl = await new Promise((resolve, reject) => {
        let buf = "";
        const t = setTimeout(() => reject(new Error("Chromium did not print its DevTools endpoint")), 20000);
        proc.stderr.on("data", (c) => { buf += c; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
        proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}): ${buf.slice(-500)}`)));
    }).catch((e) => { kill(); throw e; });
    const cdp = new Cdp(/** @type {string} */ (wsUrl));
    try { await cdp.ready; } catch (e) { kill(); throw e; }
    let swSession = null, extensionId = null;
    if (extension) {
        const until = Date.now() + 30000;
        while (!swSession && Date.now() < until) {
            const { targetInfos } = await cdp.send("Target.getTargets");
            // Chrome for Testing ships component extensions with a `background.js` of their own (Gemini in Chrome), so
            // the worker is told by its manifest's name.
            for (const t of targetInfos.filter((x) => x.type === "service_worker" && x.url.startsWith("chrome-extension://"))) {
                const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: t.targetId, flatten: true });
                const r = await cdp.send("Runtime.evaluate", { expression: "chrome.runtime.getManifest().name", returnByValue: true }, sessionId).catch(() => null);
                if (r?.result?.value === "window.ml") { swSession = sessionId; extensionId = new URL(t.url).host; break; }
                await cdp.send("Target.detachFromTarget", { sessionId }).catch(() => {});
            }
            if (!swSession) await new Promise((r) => setTimeout(r, 100));
        }
        if (!swSession) { kill(); throw new Error("the extension's service worker never appeared"); }
    }
    /** Evaluate `fn(arg)` in the extension's service worker and return its value. */
    const sw = async (fn, arg) => {
        const expression = `(${fn.toString()})(${arg === undefined ? "undefined" : JSON.stringify(arg)})`;
        const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, swSession);
        if (r.exceptionDetails) throw new Error(`sw: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
        return r.result.value;
    };
    return {
        cdp, sw, extensionId,
        /** Open a tab on `url` without attaching to it; resolves with its target id. */
        open: async (url) => (await cdp.send("Target.createTarget", { url })).targetId,
        /** Close a tab by target id. */
        closeTab: (targetId) => cdp.send("Target.closeTarget", { targetId }).catch(() => {}),
        close: async () => { try { await cdp.send("Browser.close"); } catch { /* gone */ } kill(); },
    };
}
