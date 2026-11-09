// fetch-host-pin.test.mjs — that fetch-host trusts only the PINNED hash, retries the #1535 shapes, and peels an annotated tag before it stores a commit.

import test from "node:test";
import assert from "node:assert";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseArchive, resolveCommit, target, assertPinned, bumpPin, checkAgainstPin, cli } from "../scripts/fetch-host.mjs";

const ARCHIVE = "wmlhost-v0.7.0-aarch64-apple-darwin.tar.gz";

/** A wait that records the attempts it waits after instead of spending the real backoff, so a row runs in
 *  milliseconds while still proving the pacing: the attempts named are exactly the gaps between retries. */
function instantSleep() {
    const sleeps = [];
    return { sleeps, sleep: async (attempt) => { sleeps.push(attempt); } };
}

/** Every URL a stub was asked, so a row can assert what was never fetched (the release's own .sha256). */
function recorder(inner) {
    const urls = [];
    return { urls, fetch: async (url, init) => { urls.push(String(url)); return inner(String(url), init); } };
}

// --- the archive retries like fetch-hub after #1535 ---

test("three 5xxs on the download route fall back to the release API asset endpoint, and no .sha256 is ever fetched", async () => {
    const body = new TextEncoder().encode("hello host\n");
    const rec = recorder(async (url) => {
        if (url.includes("/releases/download/")) return { ok: false, status: 504, arrayBuffer: async () => new Uint8Array() };
        if (url.includes("/releases/tags/")) return { ok: true, json: async () => ({ assets: [{ id: 4242, name: ARCHIVE }] }) };
        if (url.includes("/releases/assets/")) return { ok: true, arrayBuffer: async () => body };
        return { ok: false, status: 404, arrayBuffer: async () => new Uint8Array() };
    });
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = rec.fetch;
    try {
        const archive = await releaseArchive("v0.7.0", ARCHIVE, sleep);
        assert.equal(Buffer.from(archive).toString("utf8"), "hello host\n", "the API's bytes are the archive");
        assert.ok(rec.urls.filter((u) => u.includes("/releases/download/")).every((u) => u.endsWith(ARCHIVE)), "the download route is asked for the archive only");
        assert.ok(rec.urls.every((u) => !u.endsWith(".sha256")), "the pin is the check: the release's own sums are never read");
        assert.deepEqual(sleeps, [0, 1], "the download route's retries wait in their own gaps; the API needed none");
    } finally {
        globalThis.fetch = real;
    }
});

test("the API's bytes die twice and the third lands", async () => {
    const body = new TextEncoder().encode("hello host\n");
    let assetHits = 0;
    const rec = recorder(async (url) => {
        if (url.includes("/releases/download/")) return { ok: false, status: 504, arrayBuffer: async () => new Uint8Array() };
        if (url.includes("/releases/tags/")) return { ok: true, json: async () => ({ assets: [{ id: 4242, name: ARCHIVE }] }) };
        if (url.includes("/releases/assets/")) {
            assetHits++;
            return assetHits < 3
                ? { ok: false, status: 504, arrayBuffer: async () => new Uint8Array() }
                : { ok: true, arrayBuffer: async () => body };
        }
        return { ok: false, status: 404, arrayBuffer: async () => new Uint8Array() };
    });
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = rec.fetch;
    try {
        const archive = await releaseArchive("v0.7.0", ARCHIVE, sleep);
        assert.equal(Buffer.from(archive).toString("utf8"), "hello host\n");
        assert.equal(assetHits, 3, "the API's bytes are asked three times");
        assert.deepEqual(sleeps, [0, 1, 0, 1], "each route's retries wait in their own gaps");
    } finally {
        globalThis.fetch = real;
    }
});

test("both routes spent: one error naming both, with no body", async () => {
    const rec = recorder(async () => ({ ok: false, status: 504, json: async () => ({}), arrayBuffer: async () => new Uint8Array() }));
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = rec.fetch;
    try {
        await assert.rejects(
            releaseArchive("v0.7.0", ARCHIVE, sleep),
            { message: `neither the download route nor the release API served ${ARCHIVE} on v0.7.0` },
            "the one error names both routes",
        );
        assert.deepEqual(sleeps, [0, 1, 0, 1], "every attempt on both routes is spent before the error");
    } finally {
        globalThis.fetch = real;
    }
});

test("a fetch that dies before a response is retried like a 504 (e3's `fetch failed`)", async () => {
    const body = new TextEncoder().encode("hello host\n");
    const rec = recorder(async (url) => {
        if (url.includes("/releases/download/")) throw new TypeError("fetch failed");
        if (url.includes("/releases/tags/")) return { ok: true, json: async () => ({ assets: [{ id: 4242, name: ARCHIVE }] }) };
        if (url.includes("/releases/assets/")) return { ok: true, arrayBuffer: async () => body };
        return { ok: false, status: 404, arrayBuffer: async () => new Uint8Array() };
    });
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = rec.fetch;
    try {
        const archive = await releaseArchive("v0.7.0", ARCHIVE, sleep);
        assert.equal(Buffer.from(archive).toString("utf8"), "hello host\n", "the API serves what the dead route could not");
        assert.deepEqual(sleeps, [0, 1], "the three dead requests spend the download route's attempts");
    } finally {
        globalThis.fetch = real;
    }
});

test("a body that dies mid-read is retried, not fatal", async () => {
    const body = new TextEncoder().encode("hello host\n");
    let hits = 0;
    const rec = recorder(async (url) => {
        if (url.includes("/releases/download/")) {
            hits++;
            return hits < 2
                ? { ok: true, arrayBuffer: async () => { throw new TypeError("terminated"); } }
                : { ok: true, arrayBuffer: async () => body };
        }
        return { ok: false, status: 404, arrayBuffer: async () => new Uint8Array() };
    });
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = rec.fetch;
    try {
        const archive = await releaseArchive("v0.7.0", ARCHIVE, sleep);
        assert.equal(Buffer.from(archive).toString("utf8"), "hello host\n");
        assert.deepEqual(sleeps, [0], "the dying body spends one attempt and waits its gap");
    } finally {
        globalThis.fetch = real;
    }
});

test("the first-try path returns the download's own bytes with no API call", async () => {
    const body = new TextEncoder().encode("hello host\n");
    const rec = recorder(async (url) => {
        if (url.includes("/releases/download/")) return { ok: true, arrayBuffer: async () => body };
        return { ok: true, json: async () => { throw new Error("the API must not be asked"); } };
    });
    const { sleeps, sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = rec.fetch;
    try {
        const archive = await releaseArchive("v0.7.0", ARCHIVE, sleep);
        assert.equal(Buffer.from(archive).toString("utf8"), "hello host\n");
        assert.deepEqual(sleeps, [], "nothing was retried");
    } finally {
        globalThis.fetch = real;
    }
});

// --- the pin is the check ---

test("a body whose hash is not the pin's is refused, naming both", () => {
    const body = new TextEncoder().encode("hello host\n");
    const pinned = "ab".repeat(32);
    assert.throws(
        () => assertPinned(body, pinned, ARCHIVE),
        { message: `checksum mismatch for ${ARCHIVE}\n  pinned     ${pinned}\n  downloaded ${createHash("sha256").update(body).digest("hex")}` },
    );
});

test("the three published targets map from their Node keys, and an unknown platform names itself", () => {
    assert.equal(target("linux-x64"), "x86_64-unknown-linux-gnu");
    assert.equal(target("linux-arm64"), "aarch64-unknown-linux-gnu");
    assert.equal(target("darwin-arm64"), "aarch64-apple-darwin");
    assert.equal(target(), target(`${process.platform}-${process.arch}`), "the default is this machine's key");
    assert.throws(
        () => target("win32-x64"),
        { message: "no published host build for win32-x64. Build it yourself and set E2E_WMLHOST, or add the target to parawanderer/window-ml-host's release.yml." },
    );
});

// --- an annotated tag is peeled before the commit is trusted ---

test("an annotated tag's ref object is the TAG object, and is peeled down to the commit", async () => {
    const asked = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        asked.push(String(url));
        if (String(url).includes("/git/ref/tags/")) return { ok: true, json: async () => ({ object: { type: "tag", sha: "dfecf446" + "0".repeat(56) } }) };
        if (String(url).includes("/git/tags/")) return { ok: true, json: async () => ({ object: { type: "commit", sha: "323b5c2155fdd75782926073b9d9c18201b7214c" } }) };
        return { ok: false, json: async () => ({}) };
    };
    try {
        const { commit, tagObjectSha } = await resolveCommit("v0.7.0");
        assert.equal(commit, "323b5c2155fdd75782926073b9d9c18201b7214c", "the peeled commit is what a pin stores");
        assert.equal(tagObjectSha, "dfecf446" + "0".repeat(56), "the ref's own object is reported so the mistake can be named");
        assert.equal(asked.length, 2, "the ref, then the one tag object");
    } finally {
        globalThis.fetch = real;
    }
});

test("a lightweight tag's ref object is already the commit, and no tag object is asked for", async () => {
    const asked = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        asked.push(String(url));
        if (String(url).includes("/git/ref/tags/")) return { ok: true, json: async () => ({ object: { type: "commit", sha: "323b5c2155fdd75782926073b9d9c18201b7214c" } }) };
        return { ok: true, json: async () => { throw new Error("a tag object must not be asked for"); } };
    };
    try {
        const { commit, tagObjectSha } = await resolveCommit("v0.7.1");
        assert.equal(commit, "323b5c2155fdd75782926073b9d9c18201b7214c");
        assert.equal(tagObjectSha, commit, "there is no separate tag object");
        assert.equal(asked.length, 1, "the ref only");
    } finally {
        globalThis.fetch = real;
    }
});

test("a tag that peels to anything but a commit is refused", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes("/git/ref/tags/")) return { ok: true, json: async () => ({ object: { type: "tag", sha: "dfecf446" + "0".repeat(56) } }) };
        return { ok: true, json: async () => ({ object: { type: "tree", sha: "beeff00d" + "0".repeat(56) } }) };
    };
    try {
        await assert.rejects(
            resolveCommit("v0.7.0"),
            { message: `tag v0.7.0 ends at a tree, not a commit: beeff00d${"0".repeat(56)}` },
        );
    } finally {
        globalThis.fetch = real;
    }
});

// --- --check compares and writes nothing ---

const PEELED = "323b5c2155fdd75782926073b9d9c18201b7214c";
const TAGOBJ = "dfecf446" + "0".repeat(56);

/** A fresh pin as `bumpPin` reports it, one sha per target; `over` patches it (a drift to refuse). */
function freshPin(over = {}) {
    const assets = {};
    for (const t of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin"]) {
        assets[t] = { file: `wmlhost-v0.7.0-${t}.tar.gz`, sha256: "ab".repeat(32) };
    }
    return { repo: "parawanderer/window-ml-host", tag: "v0.7.0", commit: PEELED, tagObjectSha: TAGOBJ, assets, ...over };
}

/** The pin on disk in the ruled shape (no tagObjectSha). */
function diskPin(over = {}) {
    const { tagObjectSha, ...rest } = freshPin(over);
    return rest;
}

test("a pin matching the release passes", () => {
    checkAgainstPin(diskPin(), freshPin());
});

test("a pin holding the tag object's sha is refused as the annotated-tag mistake, not as drift", () => {
    assert.throws(
        () => checkAgainstPin(diskPin({ commit: TAGOBJ }), freshPin()),
        { message: `the pin stores the tag object's sha ${TAGOBJ}, not the peeled commit ${PEELED}: --bump again` },
    );
});

test("every target's drift is refused with both hashes, and a missing target is named", () => {
    for (const t of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin"]) {
        const pin = diskPin();
        pin.assets[t] = { ...pin.assets[t], sha256: "cd".repeat(32) };
        assert.throws(
            () => checkAgainstPin(pin, freshPin()),
            (e) => e.message.includes(`${t}: pin ${"cd".repeat(32)}, release ${"ab".repeat(32)}`),
            `${t}'s drift is named with both hashes`,
        );
    }
    const missing = diskPin();
    delete missing.assets["aarch64-unknown-linux-gnu"];
    assert.throws(() => checkAgainstPin(missing, freshPin()), (e) => e.message.includes("aarch64-unknown-linux-gnu: missing from the pin"));
    const renamed = diskPin();
    renamed.assets["x86_64-unknown-linux-gnu"] = { ...renamed.assets["x86_64-unknown-linux-gnu"], file: "wmlhost-v0.7.0-x86_64-unknown-linux-musl.tar.gz" };
    assert.throws(() => checkAgainstPin(renamed, freshPin()), (e) => e.message.includes("x86_64-unknown-linux-gnu: pin wmlhost-v0.7.0-x86_64-unknown-linux-musl.tar.gz"));
});

/** A stubbed release holding `SHA256SUMS`, the three archives, and a tag ref; `bad` makes one archive's bytes
 *  disagree with SHA256SUMS, `ref` chooses annotated or lightweight. */
function bumpStub({ bad = null, ref = "annotated", commit = PEELED, tagObjectSha = TAGOBJ } = {}) {
    const asked = [];
    const sums = [];
    const archives = {};
    for (const t of ["x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu", "aarch64-apple-darwin"]) {
        const file = `wmlhost-v0.7.0-${t}.tar.gz`;
        let bytes = new TextEncoder().encode(`the ${t} archive\n`);
        sums.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
        if (bad === t) bytes = new TextEncoder().encode(`the ${t} archive, swapped\n`);
        archives[file] = bytes;
    }
    return {
        asked,
        fetch: async (url) => {
            const u = String(url);
            asked.push(u);
            if (u.endsWith("/SHA256SUMS")) return { ok: true, text: async () => sums.join("\n") + "\n" };
            if (u.includes("/releases/download/") && archives[u.split("/").pop()]) return { ok: true, arrayBuffer: async () => archives[u.split("/").pop()] };
            if (u.includes("/git/ref/tags/")) {
                return { ok: true, json: async () => ({ object: ref === "annotated" ? { type: "tag", sha: tagObjectSha } : { type: "commit", sha: commit } }) };
            }
            if (u.includes("/git/tags/")) return { ok: true, json: async () => ({ object: { type: "commit", sha: commit } }) };
            return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new Uint8Array() };
        },
    };
}

test("--bump hashes every archive itself and refuses unless SHA256SUMS agrees", async () => {
    const stub = bumpStub({ bad: "aarch64-unknown-linux-gnu" });
    const { sleep } = instantSleep();
    const real = globalThis.fetch;
    globalThis.fetch = stub.fetch;
    try {
        await assert.rejects(
            bumpPin("v0.7.0", sleep),
            (e) => e.message.includes("checksum mismatch for wmlhost-v0.7.0-aarch64-unknown-linux-gnu.tar.gz")
                && e.message.includes("SHA256SUMS ") && e.message.includes("downloaded  "),
            "the two-way disagreement names both hashes",
        );
    } finally {
        globalThis.fetch = real;
    }
});

test("--bump stores the PEELED commit in the ruled shape, and --check writes nothing", async () => {
    const stub = bumpStub();
    const { sleep } = instantSleep();
    const dir = await mkdtemp(join(tmpdir(), "fetch-host-pin-"));
    const pinPath = join(dir, "host-dist.json");
    await writeFile(pinPath, `${JSON.stringify(diskPin({ commit: TAGOBJ }), null, 2)}\n`);
    const before = await readFile(pinPath, "utf8");
    const real = globalThis.fetch;
    globalThis.fetch = stub.fetch;
    try {
        await assert.rejects(
            cli(["--bump", "--check"], { pinPath, sleep }),
            { message: `the pin stores the tag object's sha ${TAGOBJ}, not the peeled commit ${PEELED}: --bump again` },
            "--check refuses the annotated-tag mistake",
        );
        assert.equal(await readFile(pinPath, "utf8"), before, "--check writes nothing");
        await cli(["--bump", "v0.7.0"], { pinPath, sleep });
        const written = JSON.parse(await readFile(pinPath, "utf8"));
        assert.equal(written.commit, PEELED, "the PEELED commit is stored");
        assert.deepEqual(Object.keys(written).sort(), ["assets", "commit", "repo", "tag"], "the ruled shape, with no tagObjectSha in the file");
        assert.deepEqual(Object.keys(written.assets).sort(), ["aarch64-apple-darwin", "aarch64-unknown-linux-gnu", "x86_64-unknown-linux-gnu"]);
        await cli(["--bump", "--check"], { pinPath, sleep }); // the fresh pin passes with no write
    } finally {
        globalThis.fetch = real;
    }
});

// --- the land path checks the pin before anything is unpacked or lands ---

test("a wrong-hash archive is refused with checksum mismatch, and the land dir is never created", async () => {
    // The body is not a tar either: a `assertPinned` moved after `tar -xzf` would surface tar's error instead of
    // the pin's, and this row would go red on the message. The ordering is the invariant the file exists for.
    const dir = await mkdtemp(join(tmpdir(), "fetch-host-land-"));
    const out = join(dir, "out");
    const pinPath = join(dir, "host-dist.json");
    await writeFile(pinPath, `${JSON.stringify(diskPin(), null, 2)}\n`);
    const garbage = new TextEncoder().encode("not an archive");
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
        if (String(url).includes("/releases/download/")) return { ok: true, arrayBuffer: async () => garbage };
        throw new Error(`nothing but the download route should be asked: ${url}`);
    };
    try {
        await assert.rejects(
            cli([], { pinPath, sleep: instantSleep().sleep, dir: out }),
            (e) => e.message.includes("checksum mismatch for") && e.message.includes("pinned") && e.message.includes("downloaded"),
            "the pin names both hashes",
        );
        assert.equal(existsSync(out), false, "nothing behind: the land dir is never created");
    } finally {
        globalThis.fetch = real;
    }
});

// --- a token in the environment rides the API calls ---

test("GITHUB_TOKEN or GH_TOKEN is a bearer on the API calls, and the download routes never see it", async () => {
    const seen = []; // {url, headers}
    const stub = async (url, init) => {
        const u = String(url);
        seen.push({ url: u, headers: init?.headers ?? {} });
        if (u.includes("/releases/download/")) return { ok: false, status: 504, arrayBuffer: async () => new Uint8Array() };
        if (u.includes("/releases/tags/")) return { ok: true, json: async () => ({ assets: [{ id: 4242, name: ARCHIVE }] }) };
        if (u.includes("/releases/assets/")) return { ok: true, arrayBuffer: async () => new TextEncoder().encode("bytes\n") };
        if (u.includes("/git/ref/tags/")) return { ok: true, json: async () => ({ object: { type: "commit", sha: PEELED } }) };
        return { ok: false, status: 404, json: async () => ({}), arrayBuffer: async () => new Uint8Array() };
    };
    const real = globalThis.fetch;
    const had = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
    globalThis.fetch = stub;
    try {
        process.env.GITHUB_TOKEN = "ghs_row_token";
        delete process.env.GH_TOKEN;
        await releaseArchive("v0.7.0", ARCHIVE, instantSleep().sleep); // download 504s → the API fallback carries it
        await resolveCommit("v0.7.0");
        for (const s of seen.filter((x) => x.url.includes("api.github.com"))) {
            assert.equal(s.headers.Authorization, "Bearer ghs_row_token", `${s.url} carries the token`);
        }
        assert.ok(seen.some((x) => x.url.includes("/releases/download/")), "the download route was asked");
        for (const s of seen.filter((x) => x.url.includes("/releases/download/"))) {
            assert.equal(s.headers.Authorization, undefined, "the download route never sees the token");
        }
        seen.length = 0;
        delete process.env.GITHUB_TOKEN;
        process.env.GH_TOKEN = "ghp_row_token";
        await resolveCommit("v0.7.0");
        assert.ok(seen.length > 0 && seen.every((x) => x.headers.Authorization === "Bearer ghp_row_token"), "GH_TOKEN alone counts too");
        seen.length = 0;
        delete process.env.GH_TOKEN;
        await resolveCommit("v0.7.0");
        assert.ok(seen.length > 0 && seen.every((x) => x.headers.Authorization === undefined), "with neither set, no Authorization header at all");
    } finally {
        globalThis.fetch = real;
        for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) {
            if (had[k] === undefined) delete process.env[k];
            else process.env[k] = had[k];
        }
    }
});
