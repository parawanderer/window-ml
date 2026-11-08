// fetch-host.mjs — the `wmlhost` binary the ml.sh e2e gate runs against, from the PINNED release in tools/host-dist.json.
//
// `tests/e2e/ml-sh-host.spec.mjs` runs ml.sh against a REAL process host and self-skips without one, which is a green
// run that said nothing (the same silence `fetch-hub` exists to end for the hub tests). CI's gate job must FAIL
// instead: this downloads the pinned tag's archive, checks it against the SHA256 PINNED HERE — never the release's
// own .sha256, which travels with the bytes it would bless — and lands it where `tests/e2e/native-host.mjs` already
// looks. Modelled on fetch-hub.mjs after #1535: the same retry shape, the same `--version` proof, and `--bump` to
// move the pin on purpose, `--check` to compare without writing.
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const PIN = new URL("../tools/host-dist.json", import.meta.url);
const REPO = "parawanderer/window-ml-host";

/** Every target a release publishes. A new one is a code change here, in the pin's shape and in the release.yml. */
const TARGETS = ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin"];

/**
 * The pin. This file is the ONLY trust root: the commit, and one sha256 per target, written by `--bump` from a
 * release whose hashes were checked two ways there. Reading it as JSON rather than importing keeps this runnable
 * straight after a clone, before anything else has to work.
 * @returns {Promise<{repo: string, tag: string, commit: string, assets: Record<string, {file: string, sha256: string}>}>}
 */
export async function readPin(pinPath = PIN) {
    const pin = JSON.parse(await readFile(pinPath, "utf8"));
    if (pin.repo !== REPO) throw new Error(`the pin names ${pin.repo}, not ${REPO}`);
    if (!pin.tag || !pin.commit || typeof pin.assets !== "object") throw new Error("the pin needs tag, commit and assets");
    return pin;
}

/**
 * The release archive for THIS machine. A platform with no pinned build says so rather than downloading a 404.
 * @param {string} [key] `platform-arch`, default this machine's; a parameter so a row can name another one.
 */
export function target(key = `${process.platform}-${process.arch}`) {
    const known = { "linux-x64": "x86_64-unknown-linux-gnu", "darwin-arm64": "aarch64-apple-darwin" };
    if (!known[key]) {
        throw new Error(`no published host build for ${key}. Build it yourself and set E2E_WMLHOST, or add the target to ${REPO}'s release.yml.`);
    }
    return known[key];
}

/** Between attempts: the CDN's 504 window is measured in tens of seconds, not milliseconds. */
const backoff = (attempt) => new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));

/**
 * The release archive's bytes. `name` is the asset's OWN name, `wmlhost-<tag>-<target>.tar.gz`. The same retry
 * shape fetch-hub's `releaseAsset` settled on in #1535: three attempts at the download route, then three at the
 * release API asset endpoint (`Accept: application/octet-stream`) — same CDN, same 504 window — and every attempt
 * is spent the same way whether it 5xx'd, its request died before a response, or its body died mid-read. No
 * `.sha256` is fetched at all: the pin's hash is the check. `sleep(attempt)` is the wait between two attempts: a
 * parameter so the tests run in milliseconds, `backoff` (the real wait) unless they say otherwise.
 * @returns {Promise<Uint8Array>}
 */
export async function releaseArchive(tag, name, sleep = backoff) {
    const base = `https://github.com/${REPO}/releases/download/${tag}`;
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = await fetch(`${base}/${name}`).catch(() => null);
        if (res?.ok) {
            const body = await res.arrayBuffer().catch(() => null);
            if (body) return new Uint8Array(body);
        }
        if (attempt < 2) await sleep(attempt);
    }
    // Both spent: the release API's asset endpoint is a second route to the same bytes.
    for (let attempt = 0; attempt < 3; attempt++) {
        const meta = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`).catch(() => null);
        const parsed = meta?.ok ? await meta.json().catch(() => null) : null;
        if (parsed) {
            const asset = (parsed.assets ?? []).find((a) => a.name === name);
            if (!asset?.id) throw new Error(`no asset named ${name} on ${tag}`);
            const bytes = await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${asset.id}`, { headers: { Accept: "application/octet-stream" } }).catch(() => null);
            const body = bytes?.ok ? await bytes.arrayBuffer().catch(() => null) : null;
            if (body) return new Uint8Array(body);
        }
        if (attempt < 2) await sleep(attempt);
    }
    throw new Error(`neither the download route nor the release API served ${name} on ${tag}`);
}

/**
 * The commit a tag points at, PEELED, and the ref's own object sha beside it. v0.7.0 is an ANNOTATED tag:
 * `git/ref/tags/<tag>` answers `object.type: "tag"` — the tag object dfecf446… — not the commit, so each tag
 * object is followed to its object until that is a commit (a lightweight tag's ref already is one). The pin
 * stores the PEELED commit; `tagObjectSha` exists so `checkAgainstPin` can name the mistake when the pin holds
 * the tag object's sha instead.
 * @returns {Promise<{commit: string, tagObjectSha: string}>}
 */
export async function resolveCommit(tag) {
    const ref = await fetch(`https://api.github.com/repos/${REPO}/git/ref/tags/${tag}`).catch(() => null);
    const parsed = ref?.ok ? await ref.json().catch(() => null) : null;
    let obj = parsed?.object;
    if (!obj?.sha || !obj.type) throw new Error(`no git ref for tag ${tag} on ${REPO}`);
    const tagObjectSha = obj.sha;
    for (let depth = 0; obj.type === "tag"; depth++) {
        if (depth > 4) throw new Error(`tag ${tag} peels past five objects: ${obj.sha}`);
        const t = await fetch(`https://api.github.com/repos/${REPO}/git/tags/${obj.sha}`).catch(() => null);
        const tp = t?.ok ? await t.json().catch(() => null) : null;
        obj = tp?.object;
        if (!obj?.sha || !obj.type) throw new Error(`no git tag object ${tagObjectSha} on ${REPO}`);
    }
    if (obj.type !== "commit") throw new Error(`tag ${tag} ends at a ${obj.type}, not a commit: ${obj.sha}`);
    return { commit: obj.sha, tagObjectSha };
}

/**
 * The archive's sha256 against the pin's, BEFORE it is unpacked — this ends in a binary a test suite executes, and
 * a download nobody verifies is a supply chain with no links in it.
 */
export function assertPinned(archive, pinnedSha, name) {
    const got = createHash("sha256").update(archive).digest("hex");
    if (!/^[0-9a-f]{64}$/.test(pinnedSha)) throw new Error(`the pin's sha256 for ${name} is not one: ${String(pinnedSha).slice(0, 80)}`);
    if (got !== pinnedSha) throw new Error(`checksum mismatch for ${name}\n  pinned     ${pinnedSha}\n  downloaded ${got}`);
}

/**
 * What `--bump <tag>` writes: every target's archive, hashed here and refused unless SHA256SUMS agrees, and the
 * tag's commit PEELED as `resolveCommit` describes. Nothing is written — `main` writes, `--check` does not.
 * @returns {Promise<{repo: string, tag: string, commit: string, tagObjectSha: string, assets: Record<string, {file: string, sha256: string}>}>}
 */
export async function bumpPin(tag, sleep = backoff) {
    const sumsRes = await fetch(`https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS`).catch(() => null);
    const sumsText = sumsRes?.ok ? await sumsRes.text().catch(() => null) : null;
    if (sumsText == null) throw new Error(`no SHA256SUMS on ${tag}`);
    const sums = new Map(sumsText.trim().split("\n").map((l) => l.trim().split(/\s+/)).map(([sha, name]) => [name, sha]));
    const assets = {};
    for (const t of TARGETS) {
        const file = `wmlhost-${tag}-${t}.tar.gz`;
        const want = sums.get(file);
        if (!want) throw new Error(`no ${file} in ${tag}'s SHA256SUMS`);
        const bytes = await releaseArchive(tag, file, sleep);
        const got = createHash("sha256").update(bytes).digest("hex");
        if (got !== want) throw new Error(`checksum mismatch for ${file}\n  SHA256SUMS ${want}\n  downloaded  ${got}`);
        assets[t] = { file, sha256: got };
    }
    const { commit, tagObjectSha } = await resolveCommit(tag);
    return { repo: REPO, tag, commit, tagObjectSha, assets };
}

/**
 * `--bump --check`'s verdict: `fresh` from `bumpPin` against the pin on disk, writing nothing. The commit is the
 * PEELED one; a pin holding the tag object's sha is refused as the annotated-tag mistake it is, not as drift.
 */
export function checkAgainstPin(pin, fresh) {
    const drift = [];
    if (pin.tag !== fresh.tag) drift.push(`tag: pin ${pin.tag}, release ${fresh.tag}`);
    if (pin.commit !== fresh.commit) {
        if (pin.commit === fresh.tagObjectSha) {
            throw new Error(`the pin stores the tag object's sha ${fresh.tagObjectSha}, not the peeled commit ${fresh.commit}: --bump again`);
        }
        drift.push(`commit: pin ${pin.commit}, peeled ${fresh.commit}`);
    }
    for (const t of TARGETS) {
        const have = pin.assets?.[t];
        const want = fresh.assets[t];
        if (!have) drift.push(`${t}: missing from the pin`);
        else {
            if (have.file !== want.file) drift.push(`${t}: pin ${have.file}, release ${want.file}`);
            if (have.sha256 !== want.sha256) drift.push(`${t}: pin ${have.sha256}, release ${want.sha256}`);
        }
    }
    if (drift.length) throw new Error(`the pin does not match ${fresh.tag}:\n  ${drift.join("\n  ")}`);
}

/**
 * The CLI. `--bump <tag>` rewrites the pin from the release; `--bump --check` compares and writes nothing; with
 * no flag it fetches THIS machine's archive, verifies it against the pin and lands it. `sleep` is injectable so
 * rows run in milliseconds; `pinPath` so a row never touches the real pin.
 */
export async function cli(argv, { pinPath = PIN, sleep = backoff } = {}) {
    const check = argv.includes("--check");
    const bumpIdx = argv.indexOf("--bump");
    if (check && bumpIdx < 0) throw new Error("--check is --bump's: --bump <tag> --check");
    if (bumpIdx >= 0) {
        const arg = argv[bumpIdx + 1];
        const tagArg = arg && !arg.startsWith("--") ? arg : null;
        // `--bump <tag>` moves the pin; `--bump --check` (the reviewer's form) checks the pin's own tag.
        if (!tagArg && !check) throw new Error("--bump needs a tag: --bump v0.7.1");
        const tag = tagArg ?? (await readPin(pinPath)).tag;
        const fresh = await bumpPin(tag, sleep);
        const want = { repo: fresh.repo, tag: fresh.tag, commit: fresh.commit, assets: fresh.assets };
        if (check) {
            checkAgainstPin(await readPin(pinPath), fresh); // writes nothing
            console.log(`the pin matches ${tag}`);
            return;
        }
        await writeFile(pinPath, `${JSON.stringify(want, null, 2)}\n`);
        console.log(`the pin now names ${tag} at ${fresh.commit}`);
        return;
    }
    const pin = await readPin(pinPath);
    const t = target();
    const asset = pin.assets[t];
    if (!asset) throw new Error(`no pinned host asset for ${t}: --bump ${pin.tag}`);
    const dir = new URL(`../../window-ml-host-${pin.tag}/target/release/`, import.meta.url).pathname;
    if (existsSync(join(dir, "wmlhost")) && !argv.includes("--force")) {
        console.log(`wmlhost ${pin.tag} is already in ${dir} (--force to replace it)`);
        return;
    }
    console.log(`fetching ${asset.file}`);
    const archive = await releaseArchive(pin.tag, asset.file, sleep);
    assertPinned(archive, asset.sha256, asset.file); // CHECKED BEFORE IT IS UNPACKED, let alone run
    const unpacked = asset.file.slice(0, -".tar.gz".length); // the tar's top directory
    const tmp = join(tmpdir(), `${unpacked}-${process.pid}`);
    await mkdir(tmp, { recursive: true });
    await mkdir(dir, { recursive: true });
    try {
        const tar = join(tmp, "host.tar.gz");
        await writeFile(tar, archive);
        await run("tar", ["-xzf", tar, "-C", tmp]);
        await writeFile(join(dir, "wmlhost"), await readFile(join(tmp, unpacked, "wmlhost")));
        await chmod(join(dir, "wmlhost"), 0o755);
    } finally {
        await rm(tmp, { recursive: true, force: true });
    }
    // Proof it runs here, not merely that it arrived: a binary for the wrong libc downloads perfectly.
    const { stdout } = await run(join(dir, "wmlhost"), ["--version"]);
    console.log(`${stdout.trim()} → ${dir}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    cli(process.argv.slice(2)).catch((e) => { console.error(`fetch-host: ${e?.message ?? e}`); process.exit(1); });
}
