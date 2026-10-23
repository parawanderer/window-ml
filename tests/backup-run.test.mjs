// The backup sequence (src/backup/backup-run.ts) end to end against a fake archive worker built from the real
// functions: live sessions + archive + settings in, a file out; a file in, a preview, and exactly that applied.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import init from "@sqlite.org/sqlite-wasm";
import { importBytes, markAllDirty, migrate, prepareSession, readArchived, wasmDb, writeSession } from "../src/archive/db.ts";
import { abandonBackup, addSession, beginBackup, finishBackup, inspectBackup, openBackupBytes, sealBackup } from "../src/backup/backup-file.ts";
import { BackupError, createKeyring } from "../src/backup/backup-format.ts";
import { createBackup, offerRestore, restoreBackup } from "../src/backup/backup-run.ts";
import { DEFAULT_CONFIG } from "../src/contract/contract-config.ts";
import { SITE_SCHEMA } from "../src/site-access.ts";

const sqlite3 = await init();
const CHEAP = { argon: { m: 64, t: 1, p: 1 } };
const summary = (hash, lastTs) => ({ id: { runtime: "local", hash }, kind: "agent", status: "done", task: `task ${hash}`, createdTs: lastTs - 10, lastTs, pendingApprovals: 0, saved: true });
const events = (hash) => [{ kind: "agent", id: hash, ts: 1, session: { hash, turn: 0 }, task: `find ${hash}` }];

/** A fake archive worker: the same ops as archive-worker.ts, over the real functions, with the two slots in a Map. */
function fakeWorker(keyring) {
    const raw = new sqlite3.oo1.DB(":memory:");
    const db = wasmDb(raw);
    migrate(db);
    const slots = new Map();
    let build = null;
    const log = [];
    const call = async (op, args) => {
        log.push(op);
        switch (op) {
            case "backupBegin": build = beginBackup(sqlite3, sqlite3.capi.sqlite3_js_db_export(raw.pointer)); return { fromArchive: build.fromArchive };
            case "backupPut": await addSession(build, args.input); return true;
            case "backupAbort": if (build) abandonBackup(build); build = null; return true;
            case "backupFinish": {
                if (args.form === "encrypted" && !keyring) throw new BackupError("needs-key", "set a passphrase");
                const made = finishBackup(sqlite3, build, args.settings); build = null;
                const sealed = await sealBackup(made.bytes, args.form, keyring);
                slots.set("out", sealed);
                return { size: sealed.byteLength, sessions: made.sessions, form: args.form };
            }
            case "restoreInspect": return inspectBackup(sqlite3, raw, await openBackupBytes(slots.get("in"), keyring, args.secret));
            case "restoreSessions": { const n = importBytes(sqlite3, raw, await openBackupBytes(slots.get("in"), keyring, args.secret)); if (n) markAllDirty(db); return { imported: n }; }
            case "backupFileRemove": slots.delete(args.slot); return true;
            default: throw new Error(`fake worker: ${op}`);
        }
    };
    const put = async (hash, ts) => writeSession(db, await prepareSession({ summary: summary(hash, ts), events: events(hash), history: null, bytes: 10 }), 1);
    return { call, slots, raw, db, put, log };
}

/** Storage as plain objects, with a writer. */
function fakeStorage(sync = {}, local = {}) {
    const state = { sync: { ...sync }, local: { ...local } };
    return { state, storage: async () => structuredClone({ ...state, session: {} }), writer: { async set(area, items) { Object.assign(state[area], structuredClone(items)); } } };
}

const row = (hash, ts) => ({ hash, summary: summary(hash, ts), lastTs: ts, createdTs: ts - 10, bytes: 10, count: 1 });
const deps = (w, st, rows = []) => ({ call: w.call, liveRows: async () => rows, readEvents: async (h) => events(h), storage: st.storage, writer: st.writer });

// --- making a backup ---

test("a backup is built from the settings, the archive and every live session, and waits in the out slot", async () => {
    const w = fakeWorker((await createKeyring("pw", CHEAP)).keyring);
    await w.put("arch0001", Date.UTC(2026, 0, 5));
    const st = fakeStorage({ ...DEFAULT_CONFIG, model: "m1", apiKey: "sk-secret" }, { ml_site_always: ["https://a.test"], ml_site_agents: { "https://a.test": "ask" }, ml_site_schema: SITE_SCHEMA, ml_hub_log: [1] });
    const r = await createBackup(deps(w, st, [row("live0001", Date.UTC(2026, 9, 1))]), { form: "encrypted" });
    assert.deepEqual([r.sessions, r.form, r.apiKeyOmitted, r.unclassified], [2, "encrypted", false, []]);
    assert.equal(r.size, w.slots.get("out").byteLength);
    assert.deepEqual(w.log, ["backupBegin", "backupPut", "backupFinish"]);
});

test("a plain backup leaves the API key out unless asked, and reports that it did", async () => {
    const w = fakeWorker(null);
    const st = fakeStorage({ ...DEFAULT_CONFIG, apiKey: "sk-secret" });
    const r = await createBackup(deps(w, st), { form: "plain" });
    assert.equal(r.apiKeyOmitted, true);
    const text = Buffer.from(w.slots.get("out")).toString("latin1");
    assert.ok(!text.includes("sk-secret"));
    const r2 = await createBackup(deps(w, st), { form: "plain", includeApiKey: true });
    assert.equal(r2.apiKeyOmitted, false);
    assert.ok(Buffer.from(w.slots.get("out")).toString("latin1").includes("sk-secret"));
});

test("an encrypted file never holds the API key or a transcript in the clear", async () => {
    const w = fakeWorker((await createKeyring("pw", CHEAP)).keyring);
    const st = fakeStorage({ ...DEFAULT_CONFIG, apiKey: "sk-secret-xyz" });
    await createBackup(deps(w, st, [row("live0001", 1000)]), { form: "encrypted" });
    const text = Buffer.from(w.slots.get("out")).toString("latin1");
    for (const needle of ["sk-secret-xyz", "find live0001", "SQLite format 3"]) assert.ok(!text.includes(needle), needle);
});

test("a failure while reading a live session aborts the build and the error reaches the caller", async () => {
    const w = fakeWorker(null);
    const st = fakeStorage();
    const bad = { ...deps(w, st, [row("a", 1)]), readEvents: async () => { throw new Error("disk read failed"); } };
    await assert.rejects(createBackup(bad, { form: "plain" }), /disk read failed/);
    assert.deepEqual(w.log, ["backupBegin", "backupAbort"]);
    assert.equal(w.slots.has("out"), false);
});

test("without a passphrase set up an encrypted backup is refused", async () => {
    const w = fakeWorker(null);
    await assert.rejects(createBackup(deps(w, fakeStorage()), { form: "encrypted" }), (e) => e.reason === "needs-key");
});

// --- restoring ---

test("restore: the file is inspected without changing anything, then the sessions land in the archive and exactly the preview is written", async () => {
    const { keyring } = await createKeyring("pw", CHEAP);
    const old = fakeWorker(keyring);
    await old.put("arch0001", Date.UTC(2026, 0, 5));
    const oldStorage = fakeStorage({ ...DEFAULT_CONFIG, model: "from-old", theme: "dark" }, { ml_site_always: ["https://a.test"], ml_site_agents: { "https://a.test": "ask" }, ml_site_schema: SITE_SCHEMA, ml_debug_fontscale: 2 });
    await createBackup(deps(old, oldStorage, [row("live0001", Date.UTC(2026, 9, 1))]), { form: "encrypted" });

    // a new machine: another install (no shared key), its own settings
    const fresh = fakeWorker((await createKeyring("other", CHEAP)).keyring);
    fresh.slots.set("in", old.slots.get("out"));
    const freshStorage = fakeStorage({ ...DEFAULT_CONFIG, model: "mine" }, { ml_debug_fontscale: 1 });
    const d = deps(fresh, freshStorage);
    await assert.rejects(offerRestore(d), (e) => e.reason === "needs-key");
    await assert.rejects(offerRestore(d, { passphrase: "wrong" }), (e) => e.reason === "wrong-secret");
    const offer = await offerRestore(d, { passphrase: "pw" });
    assert.deepEqual([offer.contents.sessions, offer.contents.newSessions], [2, 2]);
    assert.equal(offer.plan.sites[0].origin, "https://a.test");
    assert.equal(offer.plan.sites[0].becomesApproved, true);
    assert.equal(fresh.db.selectValue("SELECT count(*) FROM sessions"), 0, "asking changed nothing");
    assert.equal(freshStorage.state.sync.model, "mine");

    const done = await restoreBackup(d, { plan: offer.plan, sessions: true, settings: true, secret: { passphrase: "pw" } });
    assert.equal(done.sessionsAdded, 2);
    assert.deepEqual(readArchived(fresh.db, "live0001").events, events("live0001"));
    assert.equal(freshStorage.state.sync.model, "from-old");
    assert.deepEqual(freshStorage.state.local.ml_site_always, ["https://a.test"]);
    assert.deepEqual(done.written.local.sort(), offer.plan.changes.filter((c) => c.area === "local").map((c) => c.key).sort());
    assert.equal(fresh.slots.has("in"), false, "the picked file is removed afterwards");
    assert.equal(fresh.db.selectValue("SELECT count(*) FROM dirty_months") > 0, true, "so the archive folder learns of them");

    // restoring again adds nothing and writes nothing
    fresh.slots.set("in", old.slots.get("out"));
    const again = await offerRestore(d, { passphrase: "pw" });
    assert.equal(again.contents.newSessions, 0);
    assert.deepEqual(again.plan.changes, []);
});

test("restoring only the sessions, or only the settings, does only that", async () => {
    const w1 = fakeWorker(null);
    const st1 = fakeStorage({ ...DEFAULT_CONFIG, model: "m" }, {});
    await createBackup(deps(w1, st1, [row("live0001", 1000)]), { form: "plain" });
    const w2 = fakeWorker(null);
    w2.slots.set("in", w1.slots.get("out"));
    const st2 = fakeStorage({ ...DEFAULT_CONFIG }, {});
    const offer = await offerRestore(deps(w2, st2));
    await restoreBackup(deps(w2, st2), { plan: offer.plan, sessions: true, settings: false });
    assert.equal(w2.db.selectValue("SELECT count(*) FROM sessions"), 1);
    assert.equal(st2.state.sync.model, "");
    w2.slots.set("in", w1.slots.get("out"));
    const w3 = fakeWorker(null);
    w3.slots.set("in", w1.slots.get("out"));
    const done = await restoreBackup(deps(w3, st2), { plan: offer.plan, sessions: false, settings: true });
    assert.equal(done.sessionsAdded, 0);
    assert.equal(w3.db.selectValue("SELECT count(*) FROM sessions"), 0);
    assert.equal(st2.state.sync.model, "m");
});

test("a month file (no settings) offers its sessions and no settings preview; a payload from a newer version is reported, not thrown", async () => {
    const src = fakeWorker(null);
    await src.put("mon00001", 1000);
    const w = fakeWorker(null);
    w.slots.set("in", sqlite3.capi.sqlite3_js_db_export(src.raw.pointer));
    const offer = await offerRestore(deps(w, fakeStorage()));
    assert.deepEqual([offer.contents.newSessions, offer.plan], [1, null]);
    // a backup whose payload says layout 9
    const build = beginBackup(sqlite3, null);
    const made = finishBackup(sqlite3, build, JSON.stringify({ format: "wml-settings", v: 9, sync: {}, local: {} }));
    w.slots.set("in", made.bytes);
    const newer = await offerRestore(deps(w, fakeStorage()));
    assert.equal(newer.plan, null);
    assert.match(newer.settingsError, /newer version/);
});

// --- the ops the sequence calls exist in the worker ---

test("every op the sequence calls is one archive-worker.ts answers", () => {
    const worker = readFileSync(new URL("../src/archive/archive-worker.ts", import.meta.url), "utf8");
    const run = readFileSync(new URL("../src/backup/backup-run.ts", import.meta.url), "utf8");
    const used = [...run.matchAll(/call(?:<[^>]*>)?\("(\w+)"/g)].map((m) => m[1]);
    assert.ok(used.length >= 6);
    for (const op of used) {
        assert.ok(worker.includes(`op: "${op}"`), `${op} is declared in ArchiveOp`);
        assert.ok(worker.includes(`case "${op}"`), `${op} has a case in run()`);
    }
});
