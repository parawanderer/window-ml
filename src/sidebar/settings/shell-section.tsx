// shell-section.tsx — the Settings "Programs (ml.sh)" section: turning ml.sh on, the workspace folders it runs in, the
// OS sandbox, the program search path, and what the process host says about itself.

// docs/spec/SHELL.md, "Two modes": who chooses is the person, here, never the model and never a page. The host is a
// separate program (window-ml-host) the person installs; this section tells them how and shows whether it answered.
import { useEffect, useState } from "preact/hooks";
import type { MlConfig } from "../../contract";
import type { ShellStatus } from "../../sw/sw-shell";
import { Lbl as L } from "./settings-label";

/** One path a line, blank lines and surrounding space dropped. */
export function linesOf(text: string): string[] {
    return text.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** What the status line says: ready (and where calls run), or why not. */
export function shellStatusText(s: ShellStatus | null): string {
    if (!s) return "Checking…";
    if (!s.enabled) return "Off.";
    if (!s.ready) return s.error || "Not reachable.";
    const where = s.sandboxed ? "under the OS sandbox (writes only in the folders above, no network)" : "WITHOUT a sandbox: programs run as you, with your files and network";
    return `Ready: window-ml-host ${s.host?.version ?? "?"} on ${s.host?.platform ?? "?"}; calls run ${where}.`;
}

/**
 * The section's body.
 * @gallery {"c":{"shellEnabled":true,"shellRoots":["/Users/me/src/proj"],"shellSandbox":true,"shellPath":[]},"initial":{"enabled":true,"ready":true,"sandboxed":true,"host":{"version":"0.2.0","platform":"macos","sandbox":{"kind":"seatbelt","available":true}}}}
 * @group settings
 * @param c the config
 * @param setField writes one setting
 * @param initial the status to draw before the first measurement (the gallery's); absent asks the worker
 */
export function ShellSectionBody({ c, setField, initial }: {
    c: Pick<MlConfig, "shellEnabled" | "shellRoots" | "shellSandbox" | "shellPath">;
    setField: (k: "shellEnabled" | "shellRoots" | "shellSandbox" | "shellPath", v: boolean | string[]) => void;
    initial?: ShellStatus;
}) {
    const [status, setStatus] = useState<ShellStatus | null>(initial ?? null);
    const [roots, setRoots] = useState((c.shellRoots ?? []).join("\n"));
    const [path, setPath] = useState((c.shellPath ?? []).join("\n"));
    const measure = (refresh: boolean) => {
        if (initial || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({ type: "SHELL_STATUS", payload: { refresh } }, (r?: { data?: ShellStatus; error?: string }) => {
            if (r?.data) setStatus(r.data);
            else setStatus({ enabled: !!c.shellEnabled, ready: false, sandboxed: false, error: r?.error || "No answer from the extension." });
        });
    };
    useEffect(() => { measure(false); }, []);
    const id = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "<extension id>";
    return (
        <>
            <div class="set-note">Let an approved script start <b>programs on this machine</b> with <code>ml.sh.run(["git", "status"])</code>: an argument list, never a shell command. <b>Every call asks you</b>, showing exactly what will run, in which folder, under which sandbox. Programs run through the <b>process host</b>, a separate program you install once: <code>wmlhost install --extension-id {id}</code>. <b>Off by default.</b></div>
            <label class="set-check">
                <input type="checkbox" checked={!!c.shellEnabled} onChange={(e: any) => { setField("shellEnabled", e.target.checked); setTimeout(() => measure(true), 50); }} />
                <L tip="Off by default. On: an approved exec may call ml.sh, and each call still asks you.">Let scripts run programs (ml.sh)</L>
            </label>
            <label class="set-field">
                <L tip="Absolute paths, one per line. A call's working folder must be inside one; with the sandbox on, programs may write only inside them.">Workspace folders</L>
                <textarea class="set-input shell-roots" rows={3} spellcheck={false} placeholder="/Users/you/src/project" value={roots}
                    onInput={(e: any) => setRoots(e.target.value)}
                    onBlur={() => { setField("shellRoots", linesOf(roots)); setTimeout(() => measure(true), 50); }} />
            </label>
            <label class="set-check">
                <input type="checkbox" checked={c.shellSandbox !== false} onChange={(e: any) => { setField("shellSandbox", e.target.checked); setTimeout(() => measure(true), 50); }} />
                <L tip="On by default. Each call runs under the OS sandbox: writes only inside the workspace folders, no network, credential folders hidden. Where no sandbox is available, every call's card says so.">Run programs under the OS sandbox</L>
            </label>
            <label class="set-field">
                <L tip="Directories to look programs up in, in order, one per line. Empty: the host's default (your PATH plus the usual system folders).">Program search path (optional)</L>
                <textarea class="set-input shell-path" rows={2} spellcheck={false} placeholder="/opt/homebrew/bin" value={path}
                    onInput={(e: any) => setPath(e.target.value)}
                    onBlur={() => { setField("shellPath", linesOf(path)); setTimeout(() => measure(true), 50); }} />
            </label>
            <div class={`set-hint shell-status${status?.ready ? (status.sandboxed ? " ok" : " warn") : status?.enabled ? " warn" : ""}`}>
                {shellStatusText(status)}{" "}
                {c.shellEnabled ? <button class="test-btn" onClick={() => measure(true)}>Check again</button> : null}
            </div>
        </>
    );
}
