// host-install-guide.tsx — the Settings "Programs (ml.sh)" installer guide: the one line to paste while no process host
// answers, what it does and how to undo it, and a "Check again" that asks the host to say hello.

// docs/spec/SHELL.md, "Installing the host". Pure drawing: the section decides when to show it and measures the host.
import type { HostInstall } from "../../shell/host-install";
import { CopyableCode } from "../code-block";

/**
 * The installer guide for one platform, or the reason there is no line for it.
 * @gallery {"install":{"ok":true,"tag":"v0.10.0","line":"f=$(mktemp) && curl -fsSL https://github.com/parawanderer/window-ml-host/releases/download/v0.10.0/install.sh -o \"$f\" && echo \"0000000000000000000000000000000000000000000000000000000000000000  $f\" | shasum -a 256 -c - && sh \"$f\" --extension-id abcdefghijklmnopabcdefghijklmnop","undo":"wmlhost uninstall"},"answered":false}
 * @group settings
 * @param install the line for this machine, or why none
 * @param answered the last "Check again" found no host (false), or nothing was asked yet (absent)
 * @param busy a check is running
 * @param onCheck asks the host to say hello
 */
export function HostInstallGuide({ install, answered, busy, onCheck }: { install: HostInstall; answered?: boolean; busy?: boolean; onCheck?: () => void }) {
    if (!install.ok) return <div class="set-hint shell-install">{install.why}</div>;
    return (
        <div class="shell-install">
            <div class="set-note"><b>No process host answers yet.</b> Paste this in a terminal. It downloads window-ml-host {install.tag} from its GitHub release, checks the installer and then every download against a sha256 pinned in this extension, and registers the host for <b>this extension only</b> (id shown in the line). It needs no root and writes only <code>~/.local/bin/wmlhost</code> and Chrome's native-messaging folder. To undo it: {install.undo}.</div>
            <CopyableCode text={install.line} block tip="copy the install command" />
            <div class="set-hint">
                {answered === false ? "No host answered. Run the line, then check again. " : ""}
                <button class="test-btn" disabled={busy} onClick={onCheck}>Check again</button>
            </div>
        </div>
    );
}
