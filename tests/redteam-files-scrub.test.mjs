// redteam-files-scrub.test.mjs — the scrub inside /files's read keeps its promises under the shapes a reader can force (#2058): a
// secret split across a chunk boundary, at either edge of the file, longer than the range read, in another encoding, or registered
// mid-session is masked byte for byte with 0x2A and the length never changes; a malformed forms answer is EIO and writes nothing; and
// FILES_SECRET_FORMS answers the offscreen document alone. Source: src/secret-mask.ts, src/session/ranged-reader.ts (the read's
// widened window), src/sw/sw-python.ts (filesSecretForms).
import { test } from "node:test";
import assert from "node:assert/strict";
import { RangedReader } from "../src/session/ranged-reader.ts";
import { maskSecretBytes, maskOverlap, MASK_BYTE } from "../src/secret-mask.ts";

const SECRET = "sk-live-1234567890abc";
const enc = new TextEncoder();
const bytes = (s) => enc.encode(s);

/** A reader over one file's bytes, whose forms a test can change between reads. */
function readerWith(content, forms = [{ find: SECRET }]) {
    let current = forms;
    const source = {
        attached: async () => [{ handle: "h1", name: "f.bin", key: "k1", bytes: content.length, sha256: "s", attachedMs: 1 }],
        blob: async () => new Blob([content]),
        secretForms: async () => current,
    };
    const reader = new RangedReader({ source });
    const ch = reader.openChannel("files");
    ch.setSession("run-1");
    return { ch, setForms: (f) => { current = f; } };
}
async function readAll(ch, size, chunk = 512 * 1024) {
    const { fd } = await ch.open("attached/h1/f.bin");
    const out = [];
    for (let pos = 0; pos < size; pos += chunk) {
        const dest = new Uint8Array(Math.min(chunk, size - pos));
        const n = await ch.read(fd, pos, dest.length, dest);
        out.push(dest.subarray(0, n));
    }
    return Buffer.concat(out);
}
const plaintext = (buf, secret = SECRET) => Buffer.from(buf).includes(Buffer.from(secret));

// --- the match is found wherever the range boundary falls ---

test("RED TEAM (scrub): a value split across a 512 KiB boundary is masked by both reads, and the length never changes", async () => {
    const content = new Uint8Array(1024).fill(0x41);
    content.set(bytes(SECRET), 500);         // spans 500..520: across the 512 boundary
    const { ch } = readerWith(content);
    const whole = await readAll(ch, 1024, 512);
    assert.equal(whole.length, 1024, "the read changed the length");
    assert.equal(plaintext(whole), false, "the value survived across the boundary");
    for (let i = 500; i < 500 + SECRET.length; i++) assert.equal(whole[i], MASK_BYTE, `byte ${i} is not 0x2A`);
    // The halves are each masked: neither half holds the value in plaintext.
    assert.equal(plaintext(whole.subarray(0, 512)), false);
    assert.equal(plaintext(whole.subarray(512)), false);
});

test("RED TEAM (scrub): a value at the first byte and one ending at the last are both masked (the window is clamped)", async () => {
    const head = Buffer.concat([Buffer.from(SECRET), Buffer.from("tail")]);
    const tail = Buffer.concat([Buffer.from("head"), Buffer.from(SECRET)]);
    for (const [content, what] of [[new Uint8Array(head), "start"], [new Uint8Array(tail), "end"]]) {
        const { ch } = readerWith(content);
        const whole = await readAll(ch, content.length);
        assert.equal(plaintext(whole), false, `${what}: the value survived`);
        assert.equal(whole.length, content.length, `${what}: the length changed`);
    }
});

test("RED TEAM (scrub): a value longer than the range read, straddling both of its edges, still masks every byte of it", async () => {
    const form = "Z".repeat(40);
    const content = bytes("abcd" + form + "efgh");
    const { ch } = readerWith(content, [{ find: form }]);
    const { fd } = await ch.open("attached/h1/f.bin");
    const dest = new Uint8Array(4);
    const n = await ch.read(fd, 22, 4, dest);      // four bytes from the middle of the 40
    assert.equal(n, 4);
    assert.deepEqual([...dest], [MASK_BYTE, MASK_BYTE, MASK_BYTE, MASK_BYTE], "a middle range escaped the widened window");
});

test("RED TEAM (scrub): the filler is 0x2A per byte, so st_size and every later offset are unchanged", async () => {
    const content = new Uint8Array(64).fill(0x42);
    content.set(bytes(SECRET), 10);
    const { ch } = readerWith(content);
    const st = await ch.stat("attached/h1/f.bin");
    const whole = await readAll(ch, 64);
    assert.equal(st.size, 64, "st_size changed");
    assert.equal(Buffer.from(whole.subarray(0, 10)).toString(), Buffer.from(content.subarray(0, 10)).toString(), "bytes before the match changed");
    assert.equal(Buffer.from(whole.subarray(10 + SECRET.length)).toString(), Buffer.from(content.subarray(10 + SECRET.length)).toString(), "bytes after the match changed");
});

test("RED TEAM (scrub): a binary file whose member holds the value still parses — its offset table is untouched", async () => {
    // An "archive": two u32 offsets at 0 and 4, then members. Only the member's value bytes may change.
    const header = new Uint8Array(8);
    new DataView(header.buffer).setUint32(0, 8, true);
    new DataView(header.buffer).setUint32(4, 9 + SECRET.length, true);
    const member1 = bytes(SECRET);
    const member2 = bytes("payload!");
    const content = Buffer.concat([Buffer.from(header), Buffer.from(member1), Buffer.from(member2)]);
    const { ch } = readerWith(new Uint8Array(content));
    const whole = await readAll(ch, content.length);
    const view = new DataView(whole.buffer, whole.byteOffset, whole.byteLength);
    assert.equal(view.getUint32(0, true), 8, "the first member's offset moved");
    assert.equal(view.getUint32(4, true), 9 + SECRET.length, "the second member's offset moved or the file shrank");
    assert.equal(plaintext(whole), false, "the member's value survived");
});

test("RED TEAM (scrub): a form with non-ASCII characters is matched as its UTF-8 bytes", async () => {
    const form = "clé-secrète";
    const content = bytes("x" + form + "y");
    const { ch } = readerWith(content, [{ find: form }]);
    const whole = await readAll(ch, content.length);
    assert.equal(plaintext(whole, form), false, "the UTF-8 form survived");
    assert.equal(whole.length, content.length);
    assert.equal(whole[0], 0x78);
    assert.equal(whole[whole.length - 1], 0x79);
});

test("RED TEAM (scrub): a value registered after the first read masks the next one (the forms are asked every read)", async () => {
    const content = bytes("before " + SECRET + " after");
    const { ch, setForms } = readerWith(content, []);
    const first = await readAll(ch, content.length);
    assert.equal(plaintext(first), true, "positive control: with no forms registered the bytes are the file's");
    setForms([{ find: SECRET }]);
    const second = await readAll(ch, content.length);
    assert.equal(plaintext(second), false, "a value registered mid-session was not masked");
});

test("RED TEAM (scrub): a malformed or failed forms answer is EIO, and not one byte of it reaches dest", async () => {
    const content = bytes("payload " + SECRET);
    for (const forms of [null, "x", {}, [{ find: 5 }], [{ nope: "x" }]]) {
        const source = { attached: async () => [{ handle: "h1", name: "f.bin", key: "k1", bytes: content.length, sha256: "s", attachedMs: 1 }], blob: async () => new Blob([content]), secretForms: async () => forms };
        const reader = new RangedReader({ source });
        const ch = reader.openChannel("files");
        ch.setSession("run-1");
        const { fd } = await ch.open("attached/h1/f.bin");
        const dest = new Uint8Array(content.length).fill(0xaa);
        await assert.rejects(ch.read(fd, 0, content.length, dest), (e) => e?.code === "EIO" && !JSON.stringify(e).includes(SECRET), JSON.stringify(forms));
        assert.deepEqual([...dest], [...new Uint8Array(content.length).fill(0xaa)], "an unscrubbed read wrote into dest");
    }
});

test("RED TEAM (scrub): writes are not masked because they are never written — EROFS on every verb", async () => {
    const { ch } = readerWith(bytes("x"));
    const txn = await ch.begin();
    await assert.rejects(ch.openWrite("attached/h1/f.bin", "w", txn), (e) => e?.code === "EROFS");
    await assert.rejects(ch.openWrite("agent/x.txt", "w", txn), (e) => e?.code === "EROFS");
});

test("RED TEAM (scrub): maskSecretBytes masks overlapping matches whole and counts each", () => {
    const buf = bytes("abcabcabc");
    const n = maskSecretBytes(buf, [{ find: "abcabc" }, { find: "bca" }]);
    assert.equal(n, 4, "abcabc once and bca at 1, 4 and 7 — overlapping matches each count");
    assert.deepEqual([...buf], [42, 42, 42, 42, 42, 42, 42, 42, 42]);
    assert.equal(maskOverlap([{ find: "é" }]), 265, "the overlap is the GitHub token's 266 less one when it is longest");
});

// --- the forms themselves: the offscreen document's alone, and never logged or sent to the worker ---

test("RED TEAM (scrub): FILES_SECRET_FORMS answers the offscreen document alone, and a form is never logged or posted to the worker", { timeout: 60000 }, async () => {
    const { wireRun, OFFSCREEN, SITE, plain } = await import("./ml-wire-harness.mjs");
    const logged = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    for (const k of Object.keys(orig)) console[k] = (...a) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
    let out;
    try {
        out = await wireRun(async () => {}, { files: [{ name: "a.txt", type: "text/plain", text: "x" }], calls: [{ name: "python_exec", args: { code: "print(1)" } }], store: true });
    } finally { Object.assign(console, orig); }
    const { bg, pyRuns } = out;
    const ask = (sender = OFFSCREEN) => bg.send({ type: "FILES_SECRET_FORMS" }, { ...sender }).then(plain);
    const good = await ask();
    assert.ok(Array.isArray(good.forms) && good.forms.length > 0, "positive control: the offscreen document gets forms");
    // A form that exists only as a form — the percent-encoded chat URL — is the marker a leak would carry.
    const marker = good.forms.map((f) => String(f.find)).find((f) => f.includes("%3A%2F%2F"));
    assert.ok(marker, JSON.stringify(good.forms).slice(0, 200));
    const PAGE = { tab: { id: SITE.id, url: SITE.url }, url: SITE.url, origin: "https://site.example" };
    for (const [what, sender] of [
        ["a page's tab", PAGE],
        ["a content script", { id: "test", tab: { id: SITE.id, url: SITE.url }, url: SITE.url }],
        ["an extension page that is not offscreen", { id: "test", url: "chrome-extension://test/popup.html" }],
        ["a look-alike offscreen URL", { id: "test", url: "chrome-extension://test/offscreen.html?x" }],
        ["no facts", {}],
    ]) assert.deepEqual(await ask(sender), { forms: null }, what);
    assert.ok(!JSON.stringify(pyRuns).includes(marker), "a form was posted to the Pyodide worker");
    assert.ok(!logged.join("\n").includes(marker), "a form was logged to the console");
});
