// host-install.ts — the one line that installs the process host, as Settings shows it: the pinned release's installer, its
// sha256 checked before it runs, and THIS install's extension id filled in. Pure, so the section and its tests share it.

// docs/spec/SHELL.md, "Installing the host": the line carries nothing a page wrote (the id is `chrome.runtime.id`, the
// version and hash come from tools/host-dist.json, committed and reviewed), and it is built here, never from a message.
import pinJson from "../../tools/host-dist.json";

/** The pin's shape (scripts/fetch-host.mjs writes it). `installer` is absent until the pinned release carries install.sh. */
interface HostPin {
    tag: string;
    installer?: { file: string; sha256: string };
}

const PIN = pinJson as HostPin;

/** What `chrome.runtime.getPlatformInfo()` says about this machine, narrowed to the fields the line needs. */
export interface HostPlatform {
    os: string;
    arch: string;
}

/** The installer line for a platform, or why there is none. */
export type HostInstall = { ok: true; line: string; tag: string; undo: string } | { ok: false; why: string };

/** An extension id: 32 letters a-p (what `wmlhost install` itself checks). */
export const EXTENSION_ID_RE = /^[a-p]{32}$/;

/**
 * The install line for this machine: download the pinned release's `install.sh`, check its sha256 against the pin, run
 * it with the extension id. macOS and Linux differ only in the checksum program. None for a platform the release has
 * no build for, a release without an installer, or an id that is not an extension id.
 * @param platform what the browser says about this machine
 * @param extensionId this install's own id
 * @param pin the host pin; the committed one by default
 */
export function hostInstall(platform: HostPlatform, extensionId: string, pin: HostPin = PIN): HostInstall {
    if (!EXTENSION_ID_RE.test(extensionId)) return { ok: false, why: "This install's extension id is not available here." };
    const arm = platform.arch === "arm64" || platform.arch === "arm";
    const x64 = platform.arch === "x86-64";
    const sum = platform.os === "mac" && (arm || x64) ? "shasum -a 256 -c -" : platform.os === "linux" && (arm || x64) ? "sha256sum -c -" : null;
    if (!sum) return { ok: false, why: `There is no window-ml-host build for ${platform.os} ${platform.arch} yet (macOS on Apple silicon or Intel, Linux x86-64 and arm64).` };
    if (!pin.installer || !/^v\d+\.\d+\.\d+$/.test(pin.tag) || pin.installer.file !== "install.sh" || !/^[0-9a-f]{64}$/.test(pin.installer.sha256)) return { ok: false, why: "The pinned window-ml-host release has no installer; build it from source (docs/dev/shell.md)." };
    const url = `https://github.com/parawanderer/window-ml-host/releases/download/${pin.tag}/${pin.installer.file}`;
    const line = `f=$(mktemp) && curl -fsSL ${url} -o "$f" && echo "${pin.installer.sha256}  $f" | ${sum} && sh "$f" --extension-id ${extensionId}`;
    return { ok: true, line, tag: pin.tag, undo: "wmlhost uninstall (the installer prints the exact command), then delete ~/.local/bin/wmlhost" };
}
