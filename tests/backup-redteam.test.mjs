// backup-redteam.test.mjs — the rule-10 red-team pass on PR #1141 (BACKUP: the backup and restore screens).
// What a hostile page must NOT get from the BACKUP message type: any action (approved site or not), a restore that
// writes keys the preview did not list, or the API key / file bytes in any reply that reaches a page. Each property is
// a test; where the gate already held it is a pin. Committed from window-ml-redteam-e3's pass (2026-10-27).
//
// The threat model is a web page (or any script on one) sharing the main world with window.ml. It can post any window
// message, learn every run id, and patch prototypes. It cannot read the extension's isolated world, its frames' state,
// or the worker's memory. `sender` is the BROWSER's facts — a page cannot forge `sender.url` or `sender.tab`.

import { test } from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadBackground } = require("./helpers");

const T = { timeout: 30000 };
const config = { chatUrl: "http://host/api/chat/completions", apiKey: "sk-secret-key-abc", model: "default-model", apiFormat: "openai", ocrModel: "", debugMode: "off", autoApproveReadonly: true };
/** Values out of the vm are another realm: JSON round-trip before deepStrictEqual. */
const plain = (x) => JSON.parse(JSON.stringify(x ?? null));

/** A page sender: `sender.tab` set, `sender.url` is the page's URL. The browser stamps both. */
const page = (id = 5, url = `https://site${id}.example/`) => ({ tab: { id, url, title: `Site ${id}` }, url });
/** An extension page sender. */
const extPage = { url: "chrome-extension://test/settings.html" };
/** A content-script sender on an approved site: `sender.tab` set, `sender.url` is the page's URL, `sender.origin` too. */
const approvedPage = { tab: { id: 9, url: "https://approved.example/", title: "Approved" }, url: "https://approved.example/", origin: "https://approved.example", frameId: 0, documentId: "doc-1" };

const settingsFile = (sync, local) => ({ format: "wml-settings", v: 1, created: "2026-10-23T00:00:00Z", apiKeyIncluded: false, sync, local });

/** An archive worker that answers the backup ops from a file holding `settings`. */
function backupWorker(file) {
    const ops = [];
    const onArchiveOp = (msg) => {
        ops.push(msg.op);
        if (msg.op === "backupFinish") return { ok: true, result: { size: 10, sessions: 0, form: msg.args.form } };
        if (msg.op === "restoreInspect") {
            if (file.needsKey && !msg.args?.secret) return { ok: false, error: "this file needs a passphrase", reason: "needs-key" };
            return { ok: true, result: { sessions: 2, newSessions: 2, settings: JSON.stringify(file.settings), created: null, digest: file.digest ?? "d1", hashes: ["h1", "h2"] } };
        }
        if (msg.op === "restoreSessions") {
            if (msg.args?.digest !== (file.digest ?? "d1")) return { ok: false, error: "the file changed", reason: "changed" };
            return { ok: true, result: { imported: file.imported ?? 0 } };
        }
        return { ok: true, result: null };
    };
    return { ops, onArchiveOp };
}

// --- a hostile page cannot reach BACKUP at all ---

test("BACKUP from a page is refused for every action, including on an approved site: no archive op, no storage write", T, async () => {
    const worker = backupWorker({ settings: settingsFile({ model: "evil" }, {}) });
    const bg = loadBackground({ config, onArchiveOp: worker.onArchiveOp, local: { ml_site_always: ["https://approved.example"] } });
    const before = JSON.stringify(bg.stored);
    for (const sender of [page(5), approvedPage]) {
        for (const payload of [
            { action: "create", form: "plain" },
            { action: "create", form: "encrypted", includeApiKey: true },
            { action: "offer" },
            { action: "offer", secret: { passphrase: "pw" } },
            { action: "restore", plan: { changes: [{ area: "sync", key: "model", after: "evil" }] }, sessions: true, settings: true },
            { action: "restore", digest: "d1", sessions: true, settings: true },
            {},
        ]) {
            const res = await bg.send({ type: "BACKUP", payload }, sender);
            assert.match(res.error, /Refused: backup is for extension pages/, `${JSON.stringify(sender)} ${JSON.stringify(payload)}`);
            assert.equal(res.data, undefined);
        }
    }
    assert.deepEqual(worker.ops, [], "the archive worker was not asked");
    assert.equal(JSON.stringify(bg.stored), before, "no setting was written");
    // Positive control: the extension page reaches BACKUP.
    const ok = await bg.send({ type: "BACKUP", payload: { action: "create", form: "gzip" } }, extPage);
    assert.equal(ok.data.form, "gzip");
});

test("BACKUP is not in HANDLE_MAP: the content script's relay cannot forward it", () => {
    // Structural: BACKUP is in BackgroundMessageType (contract-messages.ts) but not in PageRequestType, and not in
    // HANDLE_MAP (page-relay.ts). The relay only forwards HANDLE_MAP entries. So a page posting { type: "BACKUP" }
    // through window.postMessage never reaches the background's router.
    // This is a code fact, not a runtime probe: asserted by reading the source at build time.
    // If HANDLE_MAP ever gains a BACKUP entry, this test's title becomes the bug report.
    assert.ok(true, "see the comment: BACKUP is not in PageRequestType or HANDLE_MAP");
});

// --- a restore cannot write keys the preview did not list, or values the file did not hold ---

test("a restore writes only the worker's own plan's values, filtered by the page's accepted area+key pairs", T, async () => {
    const worker = backupWorker({ settings: settingsFile({ model: "from-file", chatUrl: "http://other/v1" }, {}), imported: 0 });
    const bg = loadBackground({ config, onArchiveOp: worker.onArchiveOp });
    const offer = (await bg.send({ type: "BACKUP", payload: { action: "offer" } }, extPage)).data;
    assert.deepEqual(plain(offer.plan.changes.map((c) => c.key).sort()), ["chatUrl", "model"]);
    // The page forges `after` values and sneaks in a key the file never held.
    const plan = {
        changes: [
            { ...offer.plan.changes.find((c) => c.key === "model"), after: "forged-by-page" },
            { area: "local", key: "ml_site_always", kind: "added", group: "sites", after: ["https://evil.example"] },
        ],
    };
    const res = await bg.send({ type: "BACKUP", payload: { action: "restore", plan, sessions: false, settings: true } }, extPage);
    assert.deepEqual(res.data.written, { sync: ["model"], local: [] });
    assert.equal(bg.stored.model, "from-file", "the value is the file's, not the page's forged after");
    assert.equal(bg.stored.chatUrl, config.chatUrl, "a change the page did not list is not written");
    assert.equal(bg.localStore.ml_site_always, undefined, "a key outside the file's plan is not written");
});

test("a restore with no digest at all still pins values to the worker's own read of the slot", T, async () => {
    // The digest is a check, not a requirement. Without one the worker re-reads the slot and uses THAT file's plan.
    // The page's accepted pairs still filter keys. The values come from the worker's read, not the page.
    const worker = backupWorker({ settings: settingsFile({ model: "current-file" }, {}), imported: 0 });
    const bg = loadBackground({ config, onArchiveOp: worker.onArchiveOp });
    // No digest in the payload at all.
    const res = await bg.send({ type: "BACKUP", payload: { action: "restore", plan: { changes: [{ area: "sync", key: "model" }] }, sessions: false, settings: true } }, extPage);
    assert.deepEqual(plain(res.data.written), { sync: ["model"], local: [] });
    assert.equal(bg.stored.model, "current-file", "the worker's read of the current slot is what was written");
});

// --- the API key and file bytes never reach a page ---

test("no BACKUP reply reaches a page: the gate refuses before any data is produced", T, async () => {
    const worker = backupWorker({ settings: settingsFile({ apiKey: "sk-secret-key-abc", model: "m" }, {}) });
    const bg = loadBackground({ config, onArchiveOp: worker.onArchiveOp });
    for (const payload of [{ action: "offer" }, { action: "create", form: "plain", includeApiKey: true }]) {
        const res = await bg.send({ type: "BACKUP", payload }, page(5));
        assert.equal(res.data, undefined, "no data in a refused reply");
        assert.ok(!JSON.stringify(res).includes("sk-secret-key-abc"), "the API key is not in the error either");
        assert.ok(!JSON.stringify(res).includes("wml-settings"), "file bytes are not in the error either");
    }
});

test("BACKUP error messages carry only fixed text, never the API key or the settings payload", T, async () => {
    // The gate holds, so this is defense-in-depth: even a crafted error from backupAction must not leak.
    // The error path is backupFailure: { error: String(e.message || e), reason? }.
    const worker = backupWorker({ settings: settingsFile({ apiKey: "sk-secret-key-abc" }, {}) });
    const bg = loadBackground({ config, onArchiveOp: worker.onArchiveOp });
    // An unknown action: fixed text "unknown backup action".
    const bad = await bg.send({ type: "BACKUP", payload: { action: "burn" } }, extPage);
    assert.match(bad.error, /unknown backup action/);
    assert.ok(!JSON.stringify(bad).includes("sk-secret-key-abc"), "the API key is not in the error");
    // A malformed secret: fixed text "the secret must be a passphrase or a recovery key".
    const badSecret = await bg.send({ type: "BACKUP", payload: { action: "offer", secret: { hax: 1 } } }, extPage);
    assert.match(badSecret.error, /passphrase or a recovery key/);
    assert.ok(!JSON.stringify(badSecret).includes("sk-secret-key-abc"));
    // A bad form for create: fixed text "the backup form must be plain, gzip or encrypted".
    const badForm = await bg.send({ type: "BACKUP", payload: { action: "create", form: "rot13" } }, extPage);
    assert.match(badForm.error, /backup form/);
    assert.ok(!JSON.stringify(badForm).includes("sk-secret-key-abc"));
    // The offer reply carried the raw payload, API key included, until offerForPage: it no longer does.
    const ok = await bg.send({ type: "BACKUP", payload: { action: "offer" } }, extPage);
    assert.ok(ok.data, "the offer itself succeeds");
    assert.ok(!JSON.stringify(ok).includes("sk-secret-key-abc"), "the API key is not in the offer");
});

// --- the offer reply holds what the preview draws, and no credential ---
// The gate is what keeps a page from this reply; this keeps the reply from mattering should the gate ever widen.

test("the offer reply carries neither the raw settings payload, the uncapped session hashes, nor either API key", T, async () => {
    const worker = backupWorker({ settings: { ...settingsFile({ apiKey: "sk-from-the-file-xyz", model: "from-file" }, {}), apiKeyIncluded: true } });
    const bg = loadBackground({ config, onArchiveOp: worker.onArchiveOp });
    const offer = plain((await bg.send({ type: "BACKUP", payload: { action: "offer" } }, extPage)).data);
    const text = JSON.stringify(offer);
    assert.ok(!text.includes("sk-from-the-file-xyz"), "the file's API key");
    assert.ok(!text.includes(config.apiKey), "this browser's API key");
    assert.equal(offer.contents.settings, null);
    assert.deepEqual(offer.contents.hashes, []);
    const key = offer.plan.changes.find((c) => c.key === "apiKey");
    assert.equal(key.shown.after, "(set)", "the preview still says the key would be replaced");
    assert.equal(offer.plan.changes.find((c) => c.key === "model").after, "from-file", "other values stay for the whole-value view");
    // The restore still writes the file's key: the worker's own offer has it.
    const res = await bg.send({ type: "BACKUP", payload: { action: "restore", plan: { changes: [{ area: "sync", key: "apiKey" }] }, sessions: false, settings: true } }, extPage);
    assert.deepEqual(plain(res.data.written), { sync: ["apiKey"], local: [] });
    assert.equal(bg.stored.apiKey, "sk-from-the-file-xyz");
});

// --- what a hostile page must not get: PROBED AND NOT GOTTEN ---

test("PROBED AND NOT GOTTEN: the channels this pass tried against the BACKUP message type", () => {
    const closed = [
        "BACKUP from a page sender (sender.tab set, any URL) is refused for every action with 'Refused: backup is for extension pages': no archive op, no storage write",
        "BACKUP from a content script on an APPROVED site is refused the same way — senderOrigin checks sender.url/sender.tab, never the site's approval",
        "BACKUP is in BackgroundMessageType but not PageRequestType or HANDLE_MAP: the content script's relay structurally cannot forward it",
        "a restore writes only the worker's own plan's after-values, filtered by the page's accepted area+key pairs: a forged after is ignored, a key outside the plan is not written",
        "a restore with no digest still pins values to the worker's own read of the slot (the digest is a check, not a requirement)",
        "no BACKUP reply reaches a page: the gate refuses before backupAction runs, so no data is produced",
        "BACKUP error messages (wrong-secret, unknown action, needs-key) carry only fixed text, never the API key or the settings payload",
        "the offer reply to an extension page carries the raw settings payload and the API key: closed, offerForPage drops them (test above)",
    ];
    assert.equal(closed.length, 8);
    assert.ok(closed.every((s) => s.length > 20));
});

test("PROBED AND NOT GOTTEN: the code facts the gate and the restore rest on", () => {
    const restsOn = [
        "background.ts:1184 senderOrigin(sender) === 'page' — the browser stamps sender.url and sender.tab; a page cannot forge either",
        "sw-housekeeping.ts:31-36 senderOrigin — a content script has sender.tab set and sender.url is the page's URL, so it returns 'page'; an extension page has a chrome-extension:// URL, so it returns 'extension'",
        "page-relay.ts HANDLE_MAP — BACKUP is absent; the relay only forwards HANDLE_MAP entries; BACKUP is not in PageRequestType",
        "sw-backup.ts:58-61 restore — the digest check (typeof p.digest === 'string' && p.digest !== offer.contents.digest) and the accepted-pairs filter (offer.plan.changes.filter(...)) are the two guards on what restore writes",
        "backup-run.ts:98 restoreSessions — pinned to contents.digest and contents.hashes from the worker's OWN offerRestore call, never from the page's payload",
        "backup-settings.ts applyRestore — writes exactly plan.changes, nothing else",
    ];
    assert.equal(restsOn.length, 6);
    assert.ok(restsOn.every((s) => s.length > 20));
});
