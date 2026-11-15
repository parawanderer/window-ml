// shell-section.tsx — the Settings "Programs (ml.sh)" section: turning ml.sh on, the workspace folders it runs in, the
// OS sandbox, the program search path, and what the process host says about itself.

// docs/spec/SHELL.md, "Two modes": who chooses is the person, here, never the model and never a page. The host is a
// separate program (window-ml-host) the person installs; this section tells them how and shows whether it answered.
import { useEffect, useState } from "preact/hooks";
import type { MlConfig } from "../../contract";
import type { ShellStatus } from "../../sw/sw-shell";
import { Lbl as L } from "./settings-label";
import { formatHostVersion, hostInstall, parseHostVersion, type HostInstall, type HostPlatform } from "../../shell/host-install";
import { HostInstallGuide } from "./host-install-guide";

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
    // The version is the parsed form only: text a host sent that is not `major.minor.patch` is shown as unknown.
    const version = parseHostVersion(s.host?.version);
    return `Ready: window-ml-host ${version ? formatHostVersion(version) : "?"} on ${s.host?.platform ?? "?"}; calls run ${where}.`;
}

/**
 * The section's body.
 * @gallery {"c":{"shellEnabled":true,"shellRoots":["/Users/me/src/proj"],"shellSandbox":true,"shellPath":[]},"initial":{"enabled":true,"ready":true,"sandboxed":true,"host":{"version":"0.2.0","platform":"macos","sandbox":{"kind":"seatbelt","available":true}}}}
 * @group settings
 * @param c the config
 * @param setField writes one setting
 * @param initial the status to draw before the first measurement (the gallery's); absent asks the worker
 * @param platform what the browser says about this machine (the gallery's); absent asks `chrome.runtime.getPlatformInfo`
 */
export function ShellSectionBody({ c, setField, initial, platform: givenPlatform }: {
    c: Pick<MlConfig, "shellEnabled" | "shellRoots" | "shellSandbox" | "shellPath">;
    setField: (k: "shellEnabled" | "shellRoots" | "shellSandbox" | "shellPath", v: boolean | string[]) => void;
    initial?: ShellStatus;
    platform?: HostPlatform;
}) {
    const [status, setStatus] = useState<ShellStatus | null>(initial ?? null);
    const [roots, setRoots] = useState((c.shellRoots ?? []).join("\n"));
    const [path, setPath] = useState((c.shellPath ?? []).join("\n"));
    const [platform, setPlatform] = useState<HostPlatform | null>(givenPlatform ?? null);
    const [checking, setChecking] = useState(false);
    // "Check again" in the installer guide: a hello to the host, whether or not ml.sh is on (the person pressed it).
    const probe = () => {
        if (initial || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
        setChecking(true);
        chrome.runtime.sendMessage({ type: "SHELL_STATUS", payload: { probe: true } }, (r?: { data?: ShellStatus }) => {
            setChecking(false);
            if (r?.data) { setStatus(r.data); if (r.data.hostAnswers) measure(true); }
        });
    };
    const measure = (refresh: boolean) => {
        if (initial || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
        chrome.runtime.sendMessage({ type: "SHELL_STATUS", payload: { refresh } }, (r?: { data?: ShellStatus; error?: string }) => {
            if (r?.data) setStatus(r.data);
            else setStatus({ enabled: !!c.shellEnabled, ready: false, sandboxed: false, error: r?.error || "No answer from the extension." });
        });
    };
    useEffect(() => {
        measure(false);
        if (!givenPlatform && typeof chrome !== "undefined" && chrome.runtime?.getPlatformInfo) {
            // Brave keeps its own NativeMessagingHosts folder: the installer is told which browser this is.
            const brave = (navigator as { brave?: { isBrave?: () => Promise<boolean> } }).brave?.isBrave?.().catch(() => false) ?? Promise.resolve(false);
            Promise.all([chrome.runtime.getPlatformInfo(), brave]).then(([p, b]) => setPlatform({ os: p.os, arch: p.arch, ...(b ? { browser: "brave" as const } : {}) })).catch(() => undefined);
        }
    }, []);
    const id = typeof chrome !== "undefined" && chrome.runtime?.id ? chrome.runtime.id : "";
    // Offered until a host has answered (this worker's last hello, else any earlier one in this profile); not before the
    // first measurement, so a person with a working host never sees it flash.
    const missing = !!status && !status.ready && !(status.hostAnswers ?? status.hostSeen);
    // An answering host that is behind the pin gets the same line as an update; both versions are the worker's parsed forms.
    const update = !missing && status?.hostOutdated && status.hostVersion && status.pinnedHostVersion ? { installed: status.hostVersion, pinned: status.pinnedHostVersion } : undefined;
    const install: HostInstall | null = (missing || update) && platform ? hostInstall(platform, id) : null;
    return (
        <>
            <div class="set-note">Let an approved script start <b>programs on this machine</b> with <code>ml.sh.run(["git", "status"])</code>: an argument list, never a shell command. It is there only inside an agent run (the HUD, the sidebar, the chat page), never in a page's own console. <b>Every call asks you</b>, showing exactly what will run, in which folder, under which sandbox. Programs run through the <b>process host</b>, a separate program you install once. <b>Off by default.</b></div>
            {install ? <HostInstallGuide install={install} answered={status?.hostAnswers} update={update} busy={checking} onCheck={probe} /> : null}
            <label data-setting="shellEnabled" class="set-check">
                <input type="checkbox" checked={!!c.shellEnabled} onChange={(e: any) => { setField("shellEnabled", e.target.checked); setTimeout(() => measure(true), 50); }} />
                <L tip="Off by default. On: an approved exec may call ml.sh, and each call still asks you.">Let scripts run programs (ml.sh)</L>
            </label>
            <label data-setting="shellRoots" class="set-field">
                <L tip="Absolute paths, one per line. A call's working folder must be inside one; with the sandbox on, programs may write only inside them.">Workspace folders</L>
                <textarea class="set-input shell-roots" rows={3} spellcheck={false} placeholder="/Users/you/src/project" value={roots}
                    onInput={(e: any) => setRoots(e.target.value)}
                    onBlur={() => { setField("shellRoots", linesOf(roots)); setTimeout(() => measure(true), 50); }} />
            </label>
            <label data-setting="shellSandbox" class="set-check">
                <input type="checkbox" checked={c.shellSandbox !== false} onChange={(e: any) => { setField("shellSandbox", e.target.checked); setTimeout(() => measure(true), 50); }} />
                <L tip="On by default. Each call runs under the OS sandbox: writes only inside the workspace folders, no network, credential folders hidden. Where no sandbox is available, every call's card says so.">Run programs under the OS sandbox</L>
            </label>
            <label data-setting="shellPath" class="set-field">
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
