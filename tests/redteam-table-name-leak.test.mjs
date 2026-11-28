// redteam-table-name-leak.test.mjs — RED TEAM: a name a `/files` listing MASKS must not reach the CELL through an
// `ml.table` read (docs/spec/FILE_ATTACHMENTS.md, "Names under `/files`", rules 1, 4, 5 and 9; #2166).
//
// An `@file:` pointer's `FilePointer.name` is the file's STORED name (src/pointers/file-pointer.ts, the one the person
// gave it), and a table read builds the reader's path from it (src/sw/worker-tools.ts:417), so a path a read fails with
// prints the stored name: table-answer.ts's NotATable (:83), and the reader's own EFBIG (src/python/files-host.ts:76)
// through the same path. The cell's `_answer` raises the error's message verbatim as `MlError(code, message)`
// (src/python/ml-facade.ts:105), so the stored name, which the listing shows only as `[REDACTED:<NAME>]`, is in the
// cell's namespace.
//
// Rule 5 is the property these rows pin: an error names the path as the CALLER wrote it, never a stored name. The caller
// wrote `@file:<id>`; the one `/files` path it could have written is the SHOWN one a listing gives. Rule 4's cost — a
// cell reaches a file two shown names collide on "only by [its] stored names, which it is never shown" — is what the
// leak spends: tests/redteam-files-name-mask.test.mjs measures that a stored name then OPENS the file.
//
// Rows 1 and 2 are the leak (`{ todo }` until the repair lands); rows 3 to 5 hold today and are the controls: the shown
// path names itself, a read that succeeds carries no name at all, and the MODEL, whose way out crosses `forModel`
// (src/sw/sw-run-host.ts:1352), reads exactly the name a listing shows.
import { test } from "node:test";
import assert from "node:assert/strict";

const SECRET = "sekret-one";
const K = "[REDACTED:K_FILE]";
/** The forms FILES_SECRET_FORMS carries at the call, with the marker this registry name puts. */
const forms = [{ find: SECRET, put: K }];
const STORED = `${SECRET}.bin`;
const SHOWN = `${K}.bin`;

// The worker's chrome, as much as sw-scrub.ts and sw-secret-registry.ts use: the registry in memory, the config's own
// secret beside it (so the scrub's other half runs too), and no native host.
const sync = { shellEnabled: false, shellRoots: [], shellSandbox: false, shellPath: [], chatUrl: "http://host/api/chat/completions", apiKey: "sk-test-config-key", model: "m", apiFormat: "openai" };
globalThis.chrome = {
    runtime: {
        id: "ext-id", lastError: undefined, onMessage: { addListener() {} }, getURL: (p) => p,
        connectNative: () => ({ name: "n", postMessage() {}, disconnect() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }),
    },
    storage: {
        local: { get: async (d) => ({ ...(d ?? {}) }), set: async () => {}, remove: async () => {} },
        sync: { get: async (d) => ({ ...(d ?? {}), ...sync }), set: async () => {}, remove: async () => {} },
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { listeners: [], addListener(f) { this.listeners.push(f); } },
    },
};

const { workerTableRead } = await import("../src/sw/worker-tools.ts");
const { tableAnswerBytes, ML_TABLE_FILE_MAX } = await import("../src/python/table-answer.ts");
const { setFilesReader, attachFiles, detachFiles, readWholeFile } = await import("../src/python/files-host.ts");
const { FileShelf, fileId } = await import("../src/pointers/file-pointer.ts");
const { maskName } = await import("../src/secret-mask.ts");
const { _setRegistryForTest } = await import("../src/sw/sw-secret-registry.ts");
const { forModel } = await import("../src/sw/sw-scrub.ts");

_setRegistryForTest([{ name: "K_FILE", value: SECRET }]);

/** The file the person attached: one pointer, named after a registered value. */
const id = fileId("redteam-table-name-leak", 1);
const shelf = new FileShelf();
shelf.note({ id, name: STORED, type: "application/octet-stream", bytes: 4, pages: 0, read: 0, turn: 1, doc: "d", data: "b", sha256: "sha-1", chars: 0, figures: [], scans: [] });
const REF = `@file:${id}`;
const deps = { file: (ref) => shelf.resolve(ref), holds: async () => false };
const ctx = () => ({ tabId: 1, tabUrl: () => "http://site.test/p", cache: new Map() });
/** Four NUL bytes: `binaryKind` calls this binary, so the read is NotATable whatever the name says. */
const BINARY = new Uint8Array([0, 0, 0, 0]);
const stored = async () => { throw new Error("a file answer never asks the value store"); };

/** The message the cell's `MlError` raises for `ml.table(REF)`: the answer's error, re-raised verbatim (ml-facade.ts). */
async function cellError(src = REF) {
    const read = await workerTableRead(ctx(), src, {}, deps);
    const { answer } = await tableAnswerBytes({ seq: 7, value: read }, { stored, file: async () => BINARY });
    return { read, error: answer.error, message: String(answer.error?.message) };
}

// --- what the cell gets from a read that fails ---

test("RED TEAM (table names): the marker is the listing's, so a name holding the value is a name the cell is not shown", () => {
    // The premise every row below reads: this is what an opendir of the file's folder answers for it.
    assert.equal(maskName(STORED, forms), SHOWN);
    assert.ok(!SHOWN.includes(SECRET));
});

test("RED TEAM (table names): an @file: read that is not a table raises an error naming the STORED name the listing masks", { todo: "open: workerTableRead builds the reader's path from FilePointer.name, the stored name (src/sw/worker-tools.ts:417), and tableAnswerBytes prints that path in NotATable (src/python/table-answer.ts:83), which ml-facade raises verbatim as MlError" }, async () => {
    const { read, message } = await cellError();
    // Positive control: the read really is about the attached file, by the reference the caller wrote.
    assert.equal(read.source.label, REF);
    assert.equal(read.data.path, `/files/attached/${id}/${STORED}`, "the reader is asked by the stored name (the leak's route)");
    assert.ok(!message.includes(SECRET), `the CELL's MlError carries the stored name the listing shows as ${SHOWN}: ${message}`);
    assert.ok(message.includes(REF), `rule 5: the error names the source the caller wrote (${REF}); it names ${message}`);
});

test("RED TEAM (table names): an @file: read past ML_TABLE_FILE_MAX raises EFBIG naming the STORED name", { todo: "open: readWholeFile's EFBIG message prints the path it was handed (src/python/files-host.ts:76), and the path a table read hands it is the stored name (src/sw/worker-tools.ts:417)" }, async () => {
    // The run's reader, as the offscreen document wires it: a channel whose file is one byte past the cap, so the read
    // is refused before any bytes are read.
    setFilesReader(() => ({ setSession() {}, home: "/files/agent", open: async () => ({ fd: 1, size: ML_TABLE_FILE_MAX + 1 }), read: async () => 0, close: async () => {}, dispose() {} }));
    const principal = "run:redteam";
    attachFiles(principal, { postMessage() {} });
    try {
        const read = await workerTableRead(ctx(), REF, {}, deps);
        const { answer } = await tableAnswerBytes({ seq: 8, value: read }, { stored, file: (p) => readWholeFile(principal, p, ML_TABLE_FILE_MAX) });
        // Positive control: the refusal is the cap's, raised by the real reader over the real wiring.
        assert.equal(answer.error.code, "EFBIG", JSON.stringify(answer.error));
        const message = String(answer.error.message);
        assert.ok(!message.includes(SECRET), `the CELL's EFBIG carries the stored name the listing shows as ${SHOWN}: ${message}`);
    } finally { detachFiles(principal); setFilesReader(null); }
});

// --- the controls: what holds today ---

test("control: a /files path written with the SHOWN name names that path, never the stored one", async () => {
    const src = `/files/attached/${id}/${SHOWN}`;
    const read = await workerTableRead(ctx(), src, {}, deps);
    assert.equal(read.data.path, src, "a /files source is the path the caller wrote");
    const asked = [];
    const { answer } = await tableAnswerBytes({ seq: 9, value: read }, { stored, file: async (p) => { asked.push(p); return BINARY; } });
    assert.deepEqual(asked, [`attached/${id}/${SHOWN}`], "the reader is asked by the shown name");
    assert.ok(answer.error.message.includes(SHOWN), JSON.stringify(answer.error));
    assert.ok(!answer.error.message.includes(SECRET), JSON.stringify(answer.error));
});

test("control: a table read that succeeds answers the pointer's REFERENCE as its label, and the name nowhere", async () => {
    const csv = new TextEncoder().encode("a,b\n1,2\n");
    const read = await workerTableRead(ctx(), REF, {}, deps);
    const { answer } = await tableAnswerBytes({ seq: 10, value: read }, { stored, file: async () => csv.buffer });
    // Positive control: it really is the table, read as a CSV.
    assert.equal(answer.value.data.format, "csv");
    const text = JSON.stringify(answer);
    assert.ok(text.includes(REF), `the answer names the pointer the caller wrote: ${text}`);
    assert.ok(!text.includes(SECRET) && !text.includes(SHOWN), `the answer carries no name at all: ${text}`);
});

// --- what the model gets: exactly the name a listing shows ---

test("control: the model's way out of the cell's error is `forModel`, and it leaves the name a listing shows, never the value", async () => {
    const { message } = await cellError();
    const m = await forModel(message);
    assert.ok(!m.text.includes(SECRET), `the model read the value: ${m.text}`);
    assert.ok(m.text.includes(SHOWN), `the model reads the name a listing shows (${SHOWN}), not another: ${m.text}`);
});
