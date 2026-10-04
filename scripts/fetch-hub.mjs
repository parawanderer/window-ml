// fetch-hub.mjs — the `wmlhub` and `wmlbox` binaries the hub tests talk to, from the PINNED tag's release.
//
// Thirty tests across six files run against a real hub rather than a mock (tests/fixtures/hub-harness.mjs). Getting
// one used to mean cloning the hub and running cargo, so in practice they ran on one laptop and skipped everywhere
// else, CI included. This downloads the same artifact instead: `npm run fetch-hub`, once, after a clone.
//
// The tag comes from the harness, so there is still exactly ONE pin; the archive lands where the harness already
// looks (`../window-ml-hub-<TAG>/target/release/`), so nothing else has to know this script exists. Set WMLHUB_BIN
// instead to point at a build of your own — that still wins, which is what you want while changing the hub itself.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * The pin, read out of the harness as TEXT rather than imported from it. Importing drags in `src/hub/keys.ts`, which
 * plain `node` cannot load without tsx — and the whole point of this script is that it runs straight after a clone,
 * before anything else has to work. Still ONE pin: this reads the same line the tests do.
 */
async function pinnedTag() {
    const harness = new URL("../tests/fixtures/hub-harness.mjs", import.meta.url);
    const m = /HUB_TAG\s*=\s*"([^"]+)"/.exec(await readFile(harness, "utf8"));
    if (!m) throw new Error("no HUB_TAG in tests/fixtures/hub-harness.mjs: it moved, and this reads it by name");
    return m[1];
}
const REPO = "parawanderer/window-ml-hub";

/** The release archive for THIS machine. A platform with no published build says so rather than downloading a 404. */
function target() {
    const key = `${process.platform}-${process.arch}`;
    const known = { "linux-x64": "x86_64-unknown-linux-gnu", "darwin-arm64": "aarch64-apple-darwin" };
    if (!known[key]) {
        throw new Error(`no published hub build for ${key}. Build it yourself and set WMLHUB_BIN, or add the target to ${REPO}'s release.yml.`);
    }
    return known[key];
}

const get = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
    return new Uint8Array(await res.arrayBuffer());
};

async function main() {
    const tag = await pinnedTag();
    const dir = new URL(`../../window-ml-hub-${tag}/target/release/`, import.meta.url).pathname;
    if (existsSync(join(dir, "wmlhub")) && existsSync(join(dir, "wmlbox")) && !process.argv.includes("--force")) {
        console.log(`wmlhub ${tag} is already in ${dir} (--force to replace it)`);
        return;
    }
    const name = `wmlhub-${tag}-${target()}`;
    const base = `https://github.com/${REPO}/releases/download/${tag}`;
    console.log(`fetching ${name}.tar.gz`);
    const [archive, sums] = await Promise.all([get(`${base}/${name}.tar.gz`), get(`${base}/${name}.tar.gz.sha256`)]);

    // CHECKED BEFORE IT IS UNPACKED, let alone run: this ends in a binary that a test suite executes, and a download
    // nobody verifies is a supply chain with no links in it. The file is `<sha>  <name>`, as shasum writes it.
    const want = new TextDecoder().decode(sums).trim().split(/\s+/)[0];
    const got = createHash("sha256").update(archive).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`the published checksum is not one: ${want.slice(0, 80)}`);
    if (got !== want) throw new Error(`checksum mismatch for ${name}.tar.gz\n  published ${want}\n  downloaded ${got}`);

    const tmp = join(tmpdir(), `${name}-${process.pid}`);
    await mkdir(tmp, { recursive: true });
    await mkdir(dir, { recursive: true });
    try {
        const tar = join(tmp, "hub.tar.gz");
        await writeFile(tar, archive);
        await run("tar", ["-xzf", tar, "-C", tmp]);
        for (const bin of ["wmlhub", "wmlbox"]) {
            await writeFile(join(dir, bin), await readFile(join(tmp, name, bin)));
            await chmod(join(dir, bin), 0o755);
        }
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
    // Proof it runs here, not merely that it arrived: a binary for the wrong libc downloads perfectly.
    const { stdout } = await run(join(dir, "wmlhub"), ["--version"]);
    console.log(`${stdout.trim()} → ${dir}`);
}

main().catch((e) => { console.error(`fetch-hub: ${e?.message ?? e}`); process.exit(1); });
