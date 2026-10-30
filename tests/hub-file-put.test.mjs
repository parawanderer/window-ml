// hub-file-put.test.mjs — a PDF sent from a phone to a runtime through a REAL hub (docs/spec/FILE_ATTACHMENTS.md,
// "Over the hub: chunks in an acknowledged window"): the chat page's client (HubConnection) sends it ahead in
// `file.put` chunks, at most four unanswered, and the command names it by hash; the runtime (HubRuntime with a
// FileChunks store) puts it back together, and its handler gets the bytes back by the reference. Done is the runtime's
// word; an older runtime gets the file inline; a runtime that goes away mid-upload is reported at once, not at the
// 30-second timeout. The store and the frame alone: tests/file-chunks.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUB, LIVE, device, hex, poll, startHub } from "./fixtures/hub-harness.mjs";

const { generateIdentity, SCOPE } = await import("../src/hub/keys.ts");
const { HubClient } = await import("../src/hub/client.ts");
const { Role } = await import("../src/hub/wire.ts");
const { HubConnection } = await import("../src/chat/hub-connection.ts");
const { HubRuntime } = await import("../src/hub/runtime/hub-runtime.ts");
const { FileChunks } = await import("../src/hub/runtime/file-chunks.ts");
const { frameChunk, sha256Hex } = await import("../src/hub/file-frame.ts");
const { checkedFiles } = await import("../src/session/session-commands.ts");
const { bytesToB64 } = await import("../src/pdf/pdf-wire.ts");

/** A PDF of `n` bytes: the header, then bytes no compressor would shrink. */
function pdf(n, seed = 7) {
    const b = new Uint8Array(n);
    let x = seed;
    for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
    b.set(new TextEncoder().encode("%PDF-1.7\n"), 0);
    return b;
}

/**
 * A phone and a runtime on a real hub. The runtime's handler resolves a `chat.start`'s files as the real one does
 * (checkedFiles with the store), and records what it got. `files: null` is an older runtime that takes no chunks;
 * `gate` holds every `file.put` until released.
 */
async function world({ files = new FileChunks({ maxFileBytes: 20 * 1048576, maxTotalBytes: 60 * 1048576, ttlMs: 60_000 }), gate = null } = {}) {
    const hub = await startHub();
    const root = await generateIdentity();
    const runtime = await device(root, Role.ROLE_RUNTIME, [], "Work laptop");
    const phone = await device(root, Role.ROLE_CLIENT, [SCOPE.view, SCOPE.drive], "phone");
    const common = { url: hub.url, hubName: HUB, accountRoot: root.publicKey };
    const puts = [];
    const store = files && {
        have: (from, sha) => files.have(from, sha),
        get: (sha) => files.get(sha),
        put: async (from, c, chunk) => { puts.push({ index: c.index, count: c.count, size: chunk.length }); if (gate) await gate.wait; return files.put(from, c, chunk); },
    };
    const got = [];
    const side = {
        localIds: ["local"],
        list: () => [],
        watch: () => () => {},
        async command(c) {
            if (c.type !== "chat.start") return { ok: false, error: { code: "unsupported", message: c.type } };
            const att = checkedFiles(c.files, "chat", files ? (sha) => files.get(sha) : undefined);
            got.push({ wire: c.files, att });
            return att.error ?? { ok: true, data: { session: { runtime: "local", hash: "c0ffee01" } } };
        },
    };
    const membership = { hubUrl: hub.url, hubName: HUB, accountRoot: root.publicKey, chain: runtime.chain, channelKey: crypto.getRandomValues(new Uint8Array(32)), pairedAtMs: Date.now() };
    const statuses = [];
    const rt = new HubRuntime({ membership, side, ...(store ? { files: store } : {}), connect: () => HubClient.connect({ ...common, ...runtime, role: Role.ROLE_RUNTIME }), onStatus: (st) => statuses.push(st) });
    const running = rt.run();
    await poll("the runtime to come online", () => statuses.some((st) => st.state === "online"));
    const conn = await HubConnection.open({ ...common, ...phone, role: Role.ROLE_CLIENT });
    const id = hex(runtime.principal);
    await poll("the runtime's presence", () => conn.peer(id)?.online);
    const sealed = [];
    const command = conn.hubClient.command.bind(conn.hubClient);
    conn.hubClient.command = (to, scope, body) => { sealed.push(new TextDecoder().decode(body.subarray(0, 200)).split("\u0000")[0]); return command(to, scope, body); };
    const close = async () => { conn.close(); rt.stop(); await running; hub.stop(); };
    return { conn, rt, id, puts, got, sealed, phone, files, root, common, runtime, close, stopRuntime: async () => { rt.stop(); await running; } };
}

const start = (w, files) => w.conn.send({ type: "chat.start", runtime: w.id, text: "summarise", files });

// --- what it is for: a PDF past the hub's limit reaches the runtime whole ---

test("a PDF past the hub's limit goes ahead in chunks; the command names it by hash and the handler gets the bytes back", LIVE, async () => {
    const w = await world();
    try {
        const data = pdf(3_500_000);
        const r = await start(w, [{ name: "paper.pdf", type: "application/pdf", data: bytesToB64(data) }]);
        assert.equal(r.ok, true, JSON.stringify(r));
        const limit = w.conn.hubClient.limits.maxPayloadBytes;
        assert.ok(w.puts.length >= Math.ceil(data.length / limit), `${w.puts.length} chunks`);
        assert.ok(w.puts.every((p) => p.size < limit), "every chunk fits the hub");
        assert.deepEqual([...new Set(w.puts.map((p) => p.index))].sort((a, b) => a - b), w.puts.map((_, i) => i), "each index once");
        const [{ wire, att }] = w.got;
        assert.deepEqual(wire, [{ name: "paper.pdf", type: "application/pdf", sha256: await sha256Hex(data), bytes: data.length }], "the command carried the reference, not the bytes");
        assert.equal(att.files[0].data, bytesToB64(data), "and the handler read the PDF back whole");
    } finally { await w.close(); }
});

test("at most four chunks are unanswered: with the runtime holding its answers, the fifth is not sent", LIVE, async () => {
    let release;
    const gate = { wait: new Promise((r) => { release = r; }) };
    const w = await world({ gate });
    try {
        const sending = start(w, [{ name: "big.pdf", type: "application/pdf", data: bytesToB64(pdf(6_000_000)) }]);
        await poll("four chunks sealed", () => w.sealed.filter((s) => s.includes('"file.put"')).length >= 4);
        await new Promise((r) => setTimeout(r, 400));
        assert.equal(w.sealed.filter((s) => s.includes('"file.put"')).length, 4, "the window held");
        release();
        assert.equal((await sending).ok, true);
        assert.ok(w.puts.length > 4);
    } finally { await w.close(); }
});

test("a file the runtime already holds is not sent again; one it holds part of is sent only the rest", LIVE, async () => {
    const w = await world();
    try {
        const data = pdf(2_500_000, 3);
        const file = { name: "a.pdf", type: "application/pdf", data: bytesToB64(data) };
        assert.equal((await start(w, [file])).ok, true);
        const first = w.puts.length;
        assert.ok(first >= 3);
        assert.equal((await start(w, [file])).ok, true);
        assert.equal(w.puts.length, first, "attached again: named by hash, no chunk sent");

        // Another file, whose first two chunks reached the runtime before the phone lost its connection.
        const other = pdf(2_500_000, 11);
        const sha256 = await sha256Hex(other);
        // Cut as the client cuts it: every chunk the full size but the last (the lanes answer in any order).
        const count = w.puts[0].count;
        const size = Math.max(...w.puts.map((p) => p.size));
        for (const i of [0, 1]) await w.files.put(hex(w.phone.principal), { sha256, index: i, count, bytes: other.length }, other.subarray(i * size, (i + 1) * size));
        w.puts.length = 0;
        const rb = await start(w, [{ name: "b.pdf", type: "application/pdf", data: bytesToB64(other) }]);
        assert.equal(rb.ok, true, JSON.stringify(rb));
        assert.deepEqual(w.puts.map((p) => p.index).sort((a, b) => a - b), Array.from({ length: count - 2 }, (_, i) => i + 2), "only the chunks it did not hold");
    } finally { await w.close(); }
});

// --- an older runtime, a runtime that goes away, a file too large ---

test("a runtime that does not take chunks gets a small PDF inline, as before", LIVE, async () => {
    const w = await world({ files: null });
    try {
        const data = pdf(50_000);
        assert.equal((await start(w, [{ name: "small.pdf", type: "application/pdf", data: bytesToB64(data) }])).ok, true);
        assert.equal(w.puts.length, 0);
        assert.equal(w.got[0].wire[0].data, bytesToB64(data), "the bytes rode in the command");
    } finally { await w.close(); }
});

test("a runtime that goes away mid-upload is reported at once, not at the 30-second timeout, and the message is not sent", LIVE, async () => {
    let release;
    const gate = { wait: new Promise((r) => { release = r; }) };
    const w = await world({ gate });
    try {
        const sending = start(w, [{ name: "big.pdf", type: "application/pdf", data: bytesToB64(pdf(6_000_000)) }]);
        await poll("chunks in flight", () => w.puts.length >= 1);
        const t0 = Date.now();
        await w.stopRuntime();
        release();
        const r = await sending;
        assert.equal(r.ok, false);
        assert.equal(r.error.code, "unavailable");
        assert.ok(Date.now() - t0 < 10_000, `reported after ${Date.now() - t0} ms`);
        assert.equal(w.got.length, 0, "the chat was never started");
    } finally { await w.close(); }
});

test("a PDF past what this hub takes is refused before a chunk is sent", LIVE, async () => {
    const w = await world();
    try {
        const r = await start(w, [{ name: "huge.pdf", type: "application/pdf", data: bytesToB64(pdf(21 * 1048576)) }]);
        assert.equal(r.ok, false);
        assert.match(r.error.message, /^huge\.pdf is too large to send through this hub: 21\.0 MB; it takes files up to /);
        assert.equal(w.sealed.length, 0);
    } finally { await w.close(); }
});

// --- ADVERSARIAL: what the runtime takes as bytes after the JSON ---

test("ADVERSARIAL: bytes after the JSON of any other command are refused, and a file.put without them is too", LIVE, async () => {
    const w = await world();
    try {
        const peer = w.conn.peer(w.id);
        const raw = async (json, chunk) => {
            const body = new TextEncoder().encode(JSON.stringify(json));
            const nonce = await w.conn.hubClient.command(peer.recipient, "drive", chunk ? frameChunk(body, chunk) : body);
            return await new Promise((resolve) => { w.conn["waiting"].set(hex(nonce), resolve); });
        };
        const a = await raw({ type: "chat.start", runtime: w.id, text: "x" }, Uint8Array.of(1, 2));
        assert.deepEqual([a.ok, a.error.code], [false, "invalid"]);
        assert.match(a.error.message, /carries no bytes after its JSON/);
        const b = await raw({ type: "file.put", runtime: w.id, sha256: "a".repeat(64), index: 0, count: 1, bytes: 1 }, null);
        assert.deepEqual([b.ok, b.error.code], [false, "invalid"]);
        assert.equal(w.got.length, 0);
    } finally { await w.close(); }
});

test("ADVERSARIAL: a device holding only `view` can neither send a chunk nor ask what the runtime holds, whichever scope it declares", LIVE, async () => {
    const w = await world();
    let raw;
    try {
        // A file the phone sent, so `file.have` would have something to tell.
        const data = pdf(50_000, 5);
        await w.files.put(hex(w.phone.principal), { sha256: await sha256Hex(data), index: 0, count: 1, bytes: data.length }, data);
        const viewer = await device(w.root, Role.ROLE_CLIENT, [SCOPE.view], "viewer");
        // A bare client: HubConnection would not send these, which is why the runtime has to refuse them.
        raw = await HubClient.connect({ ...w.common, ...viewer, role: Role.ROLE_CLIENT });
        const to = { principal: w.runtime.principal, agreementKey: w.runtime.agreement.publicKey };
        const answerTo = async (nonce) => {
            for (;;) {
                const e = await raw.next();
                if (e.kind === "closed") assert.fail(e.reason);
                if (e.kind === "result" && e.opened.answers.every((b, i) => b === nonce[i])) return JSON.parse(new TextDecoder().decode(e.opened.body));
            }
        };
        const json = (c) => new TextEncoder().encode(JSON.stringify(c));
        const sha256 = "d".repeat(64);
        const put = frameChunk(json({ type: "file.put", runtime: w.id, sha256, index: 0, count: 1, bytes: 3 }), Uint8Array.of(1, 2, 3));
        const a = await answerTo(await raw.command(to, SCOPE.view, put));
        assert.deepEqual([a.ok, a.error.code], [false, "forbidden"], JSON.stringify(a));
        const b = await answerTo(await raw.command(to, SCOPE.view, json({ type: "file.have", runtime: w.id, sha256: await sha256Hex(data) })));
        assert.deepEqual([b.ok, b.error.code], [false, "forbidden"], JSON.stringify(b));
        // Declaring `drive` it does not hold fails to open (seal.ts, OpenError "scope"), and a command that does not open
        // is dropped unanswered: nothing reaches the store.
        const declared = await Promise.race([
            raw.command(to, SCOPE.drive, put).then((n) => answerTo(n)).then((r) => ({ answered: r }), (e) => ({ refused: String(e?.message ?? e) })),
            new Promise((r) => setTimeout(() => r({ silent: true }), 3000)),
        ]);
        assert.deepEqual(declared, { silent: true });
        assert.equal(w.puts.length, 0, "the store never saw a chunk");
        assert.equal(w.files.heldBytes(), data.length, "and holds only the phone's file");
    } finally { raw?.close(); await w.close(); }
});
