// Building a backup file (src/backup/backup-file.ts) and restoring from one: every session, live and archived, plus the
// settings table, in all three forms, through the archive's own import. Real sqlite-wasm in memory; Argon2 run cheap.
import test from "node:test";
import assert from "node:assert/strict";
import init from "@sqlite.org/sqlite-wasm";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { importBytes, markAllDirty, migrate, prepareSession, readArchived, removeArchived, wasmDb, writeSession } from "../src/archive/db.ts";
import { abandonBackup, addSession, beginBackup, finishBackup, inspectBackup, inspectRestore, openBackupBytes, restoreNewSessions, sealBackup, unlockChoice } from "../src/backup/backup-file.ts";
import { BackupError, createKeyring, gunzip, sniff } from "../src/backup/backup-format.ts";
import { PAYLOAD_LIMITS } from "../src/backup/backup-settings.ts";

const sqlite3 = await init();
const CHEAP = { argon: { m: 64, t: 1, p: 1 } };
const PNG = "data:image/png;base64," + Buffer.from("fake png bytes").toString("base64");
const summary = (hash, lastTs) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true });
const events = (hash) => [
    { kind: "agent", id: hash, ts: 1, session: { hash, turn: 0 }, task: `find ${hash}`, images: [PNG] },
    { kind: "agent-result", id: hash, ts: 2, session: { hash, turn: 0 }, summary: "done", steps: 1, hitCap: false },
];
const input = (hash, lastTs, history = { kind: "agent", messages: [{ role: "user", content: hash }] }) => ({ summary: summary(hash, lastTs), events: events(hash), history, bytes: 100 });

/** A fresh archive database, as the worker holds one, with its handles. */
const archive = () => { const raw = new sqlite3.oo1.DB(":memory:"); const db = wasmDb(raw); migrate(db); return { raw, db }; };
const put = async (a, hash, lastTs) => writeSession(a.db, await prepareSession(input(hash, lastTs)), 5000);
const exported = (a) => sqlite3.capi.sqlite3_js_db_export(a.raw.pointer);
const hashes = (a) => a.db.selectValues("SELECT hash FROM sessions ORDER BY hash").map(String);

/** An archive with two archived sessions, and a backup of it plus two live ones (one also archived). */
async function scenario(settings = '{"format":"wml-settings"}') {
    const src = archive();
    await put(src, "arch0001", Date.UTC(2026, 0, 5));
    await put(src, "both0001", Date.UTC(2026, 1, 5));
    const build = beginBackup(sqlite3, exported(src));
    await addSession(build, input("live0001", Date.UTC(2026, 9, 1)));
    await addSession(build, input("both0001", Date.UTC(2026, 9, 2), { kind: "agent", messages: [{ role: "user", content: "the live copy" }] }));
    const made = finishBackup(sqlite3, build, settings, new Date("2026-10-23T12:00:00Z"));
    return { src, made };
}

// --- building ---

test("a backup holds every archived and every live session, the live copy winning where both exist", async () => {
    const { made } = await scenario();
    assert.equal(made.sessions, 3);
    const target = archive();
    const c = inspectBackup(sqlite3, target.raw, made.bytes);
    assert.equal(c.sessions, 3);
    assert.equal(c.newSessions, 3);
    importBytes(sqlite3, target.raw, made.bytes);
    assert.deepEqual(hashes(target), ["arch0001", "both0001", "live0001"]);
    assert.equal(readArchived(target.db, "both0001").history.messages[0].content, "the live copy");
    assert.deepEqual(readArchived(target.db, "live0001").events, events("live0001"), "events and images come back as they went in");
    assert.deepEqual(readArchived(target.db, "arch0001").events, events("arch0001"));
});

test("the settings payload sits in backup_settings, readable by any SQLite tool, and the folder bookkeeping is not carried", async () => {
    const { made } = await scenario('{"format":"wml-settings","v":1}');
    const raw = new sqlite3.oo1.DB(":memory:");
    const p = sqlite3.wasm.allocFromTypedArray(made.bytes);
    assert.equal(sqlite3.capi.sqlite3_deserialize(raw.pointer, "main", p, made.bytes.length, made.bytes.length, sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE), 0);
    const rows = Object.fromEntries(raw.selectArrays("SELECT key, value FROM backup_settings"));
    assert.equal(rows.payload, '{"format":"wml-settings","v":1}');
    assert.equal(rows.created, "2026-10-23T12:00:00.000Z");
    assert.equal(raw.selectValue("SELECT count(*) FROM dirty_months"), 0);
    assert.equal(raw.selectValue("SELECT count(*) FROM removed"), 0);
    raw.close();
});

test("a backup of an install with no archive, and of one with no live sessions, both work", async () => {
    const build = beginBackup(sqlite3, null);
    await addSession(build, input("only0001", 1000));
    assert.equal(finishBackup(sqlite3, build, null).sessions, 1);
    const empty = beginBackup(sqlite3, exported(archive()));
    const made = finishBackup(sqlite3, empty, null);
    assert.equal(made.sessions, 0);
    const c = inspectBackup(sqlite3, archive().raw, made.bytes);
    assert.deepEqual([c.sessions, c.settings], [0, null], "no payload: a sessions-only backup");
});

test("an abandoned backup releases its database", async () => {
    const build = beginBackup(sqlite3, null);
    abandonBackup(build);
    abandonBackup(build);
    assert.throws(() => build.raw.selectValue("SELECT 1"));
});

// --- restoring ---

test("a restore adds the sessions the archive lacks, once: a second restore adds nothing", async () => {
    const { made } = await scenario();
    const target = archive();
    await put(target, "arch0001", Date.UTC(2026, 0, 5));
    const c = inspectBackup(sqlite3, target.raw, made.bytes);
    assert.equal(c.newSessions, 2, "the one the archive already has is not new");
    assert.equal(importBytes(sqlite3, target.raw, made.bytes), 2);
    assert.equal(importBytes(sqlite3, target.raw, made.bytes), 0);
    assert.equal(inspectBackup(sqlite3, target.raw, made.bytes).newSessions, 0);
});

test("a session the person deleted on purpose is not brought back by a restore", async () => {
    const { made } = await scenario();
    const target = archive();
    await put(target, "live0001", 1);
    removeArchived(target.db, "live0001");
    assert.equal(inspectBackup(sqlite3, target.raw, made.bytes).newSessions, 2);
    importBytes(sqlite3, target.raw, made.bytes);
    assert.deepEqual(hashes(target), ["arch0001", "both0001"]);
});

test("restored sessions can be marked for the archive folder (an import alone does not: the folder already matches)", async () => {
    const { made } = await scenario();
    const target = archive();
    importBytes(sqlite3, target.raw, made.bytes);
    assert.equal(target.db.selectValue("SELECT count(*) FROM dirty_months"), 0);
    markAllDirty(target.db);
    assert.deepEqual(target.db.selectValues("SELECT month FROM dirty_months ORDER BY month"), ["2026-01", "2026-10"]);
});

test("a month file is inspected too: no settings, the sessions it holds", async () => {
    const a = archive();
    await put(a, "mon00001", Date.UTC(2026, 3, 1));
    const c = inspectBackup(sqlite3, archive().raw, exported(a));
    assert.deepEqual([c.sessions, c.newSessions, c.settings, c.created], [1, 1, null, null]);
});

test("bytes that are not an archive, and an archive from a newer schema, are refused and leave nothing attached", async () => {
    const target = archive();
    assert.throws(() => inspectBackup(sqlite3, target.raw, new Uint8Array(200)), /not an archive/);
    const newer = archive();
    newer.db.exec("UPDATE meta SET value = '99' WHERE key = 'schema'");
    assert.throws(() => inspectBackup(sqlite3, target.raw, exported(newer)), /newer version/);
    assert.equal(target.db.selectValue("SELECT count(*) FROM pragma_database_list"), 1, "main only: the failed attach was detached");
});

// --- the three forms ---

test("every form opens back to the same SQLite bytes; the encrypted one with the install's keyring or either secret", async () => {
    const { made } = await scenario();
    const { keyring, recoveryKey } = await createKeyring("pw", CHEAP);
    const plain = await sealBackup(made.bytes, "plain", null);
    const gz = await sealBackup(made.bytes, "gzip", null);
    const enc = await sealBackup(made.bytes, "encrypted", keyring, new Date("2026-10-23T12:00:00Z"));
    assert.deepEqual([sniff(plain), sniff(gz), sniff(enc)], ["sqlite", "gzip", "wmlbak"]);
    for (const f of [plain, gz]) assert.deepEqual(Buffer.from(await openBackupBytes(f, null)), Buffer.from(made.bytes));
    assert.deepEqual(Buffer.from(await openBackupBytes(enc, keyring)), Buffer.from(made.bytes), "this install's own file needs no secret");
    assert.deepEqual(Buffer.from(await openBackupBytes(enc, null, { passphrase: "pw" })), Buffer.from(made.bytes));
    assert.deepEqual(Buffer.from(await openBackupBytes(enc, null, { recoveryKey })), Buffer.from(made.bytes));
    assert.equal((await gunzip(gz)).length, made.bytes.length);
});

test("an encrypted backup from another install needs a secret, and a wrong one is refused", async () => {
    const { made } = await scenario();
    const mine = await createKeyring("mine", CHEAP);
    const theirs = await createKeyring("theirs", CHEAP);
    const enc = await sealBackup(made.bytes, "encrypted", theirs.keyring);
    await assert.rejects(openBackupBytes(enc, mine.keyring), (e) => e instanceof BackupError && e.reason === "needs-key");
    await assert.rejects(openBackupBytes(enc, mine.keyring, { passphrase: "mine" }), (e) => e.reason === "wrong-secret");
    assert.deepEqual(Buffer.from(await openBackupBytes(enc, mine.keyring, { passphrase: "theirs" })), Buffer.from(made.bytes));
    assert.throws(() => unlockChoice(made.bytes, null), (e) => e.reason === "unknown-form");
});

test("an encrypted backup cannot be written without a keyring", async () => {
    await assert.rejects(sealBackup(new Uint8Array(10), "encrypted", null), (e) => e instanceof BackupError && e.reason === "needs-key");
});

test("the standalone decryptor opens a backup this code wrote", async () => {
    const { made } = await scenario();
    const { keyring } = await createKeyring("standalone pw", { argon: { m: 8, t: 1, p: 1 } });
    const enc = await sealBackup(made.bytes, "encrypted", keyring);
    const dir = mkdtempSync(path.join(tmpdir(), "wmlbak-"));
    try {
        const file = path.join(dir, "b.wmlbak"), out = path.join(dir, "out.sqlite");
        writeFileSync(file, enc);
        const r = spawnSync(process.execPath, [path.join(import.meta.dirname, "..", "tools", "wmlbak-decrypt.mjs"), file, out], { input: "standalone pw\n", encoding: "utf8" });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(Buffer.from(readFileSync(out)), Buffer.from(made.bytes));
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- what a restore takes from the file ---

const orphan = (a, sha = "orphan0000") => a.db.exec({ sql: "INSERT INTO images(sha, mime, data) VALUES (?, ?, ?)", bind: [sha, "image/png", new Uint8Array(2000)] });

test("an import writes only the images its new sessions reference: an orphan image never lands, with or without a new session beside it", async () => {
    // a file whose only session the target holds already: nothing is new, so no image is
    const src = archive();
    await put(src, "keep0001", Date.UTC(2026, 0, 5));
    orphan(src);
    const target = archive();
    await put(target, "keep0001", Date.UTC(2026, 0, 5));
    const before = Number(target.db.selectValue("SELECT count(*) FROM images"));
    assert.equal(importBytes(sqlite3, target.raw, exported(src)), 0);
    assert.equal(Number(target.db.selectValue("SELECT count(*) FROM images")), before);
    // a file with a new session and an orphan beside it: the session's image lands, the orphan does not
    const src2 = archive();
    await put(src2, "new00001", Date.UTC(2026, 0, 5));
    orphan(src2);
    const t2 = archive();
    assert.equal(importBytes(sqlite3, t2.raw, exported(src2)), 1);
    assert.deepEqual(t2.db.selectValues("SELECT sha FROM images").map(String).includes("orphan0000"), false);
    assert.equal(Number(t2.db.selectValue("SELECT count(*) FROM images")), 1);
    assert.deepEqual(readArchived(t2.db, "new00001").events, events("new00001"), "control: the referenced image reads back");
});

test("inspecting refuses a settings payload past the budget: no settings come back, an error says why", async () => {
    const make = (payload) => finishBackup(sqlite3, beginBackup(sqlite3, null), payload, new Date("2026-10-23T12:00:00Z")).bytes;
    const ok = inspectBackup(sqlite3, archive().raw, make('{"format":"wml-settings","v":1}'));
    assert.equal(ok.settings, '{"format":"wml-settings","v":1}', "control: a small payload is returned");
    assert.equal(ok.settingsError, undefined);
    const huge = inspectBackup(sqlite3, archive().raw, make("x".repeat(PAYLOAD_LIMITS.bytes + 1)));
    assert.equal(huge.settings, null);
    assert.match(huge.settingsError, /larger than any real backup/);
    const edge = inspectBackup(sqlite3, archive().raw, make("x".repeat(PAYLOAD_LIMITS.bytes)));
    assert.equal(edge.settings?.length, PAYLOAD_LIMITS.bytes, "a payload exactly at the budget is returned");
});

test("an inspection names each session it would add, capped at 500 with the rest counted, and pins the file it read", async () => {
    const src = archive();
    await put(src, "aaaa0001", Date.UTC(2026, 0, 5));
    await put(src, "bbbb0002", Date.UTC(2026, 0, 6));
    const target = archive();
    await put(target, "bbbb0002", Date.UTC(2026, 0, 6));
    const file = exported(src);
    const c = await inspectRestore(sqlite3, target.raw, file, file);
    assert.deepEqual(c.hashes, ["aaaa0001"], "the one the archive has is not offered");
    assert.deepEqual(c.adding, [{ hash: "aaaa0001", title: "task aaaa0001", createdTs: Date.UTC(2026, 0, 5) - 10, bytes: 100 }]);
    assert.equal(c.more, 0);
    assert.match(c.digest, /^[0-9a-f]{64}$/);
    // 502 new sessions: 500 named, 2 counted, and all 502 pinned
    const big = archive();
    big.db.transaction(() => { for (let i = 0; i < 502; i++) big.db.exec({ sql: "INSERT INTO sessions(hash, runtime, kind, task, created_ts, last_ts, archived_ts, events, bytes, pinned, summary) VALUES (?, 'local', 'agent', 't', 1, ?, 1, 0, 1, 0, '{}')", bind: [`h${String(i).padStart(7, "0")}`, 1000 + i] }); });
    const many = await inspectRestore(sqlite3, archive().raw, exported(big), exported(big));
    assert.deepEqual([many.adding.length, many.more, many.hashes.length, many.newSessions], [500, 2, 502, 502]);
});

test("restoring is pinned to what was inspected: a changed file is refused, and only the pinned sessions are imported", async () => {
    const src = archive();
    await put(src, "aaaa0001", Date.UTC(2026, 0, 5));
    await put(src, "bbbb0002", Date.UTC(2026, 0, 6));
    const file = exported(src);
    const target = archive();
    const seen = await inspectRestore(sqlite3, target.raw, file, file);
    // the file in the slot changed since: another session, and the digest differs
    const other = archive();
    await put(other, "cccc0003", Date.UTC(2026, 0, 7));
    const swapped = exported(other);
    await assert.rejects(restoreNewSessions(sqlite3, target.raw, swapped, swapped, { digest: seen.digest, hashes: seen.hashes }), (e) => e instanceof BackupError && e.reason === "changed");
    assert.deepEqual(hashes(target), [], "nothing was imported");
    // the same file, pinned to one of the two hashes: only that one lands
    assert.equal(await restoreNewSessions(sqlite3, target.raw, file, file, { digest: seen.digest, hashes: ["bbbb0002"] }), 1);
    assert.deepEqual(hashes(target), ["bbbb0002"]);
});
