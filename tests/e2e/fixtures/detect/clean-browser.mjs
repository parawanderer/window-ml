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

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "@playwright/test";

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
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wml-detect-"));
    const argv = [
        // DETECT_HEADFUL=1 shows the window: the only way to see the "being debugged" infobar, which headless has no
        // browser UI to draw (and so no resize to measure).
        ...(process.env.DETECT_HEADFUL === "1" ? [] : ["--headless=new"]), "--remote-debugging-port=0", `--user-data-dir=${userDataDir}`, "--no-first-run", "--no-default-browser-check",
        "--window-size=1280,900",
        ...(extension ? [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`] : []),
        ...args, "about:blank",
    ];
    const proc = spawn(chromium.executablePath(), argv, { stdio: ["ignore", "ignore", "pipe"] });
    const wsUrl = await new Promise((resolve, reject) => {
        let buf = "";
        const t = setTimeout(() => reject(new Error("Chromium did not print its DevTools endpoint")), 20000);
        proc.stderr.on("data", (c) => { buf += c; const m = buf.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } });
        proc.on("exit", (code) => reject(new Error(`Chromium exited (${code}): ${buf.slice(-500)}`)));
    });
    const cdp = new Cdp(/** @type {string} */ (wsUrl));
    await cdp.ready;
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
        if (!swSession) throw new Error("the extension's service worker never appeared");
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
        close: async () => { try { await cdp.send("Browser.close"); } catch { /* gone */ } proc.kill("SIGKILL"); try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* busy */ } },
    };
}
