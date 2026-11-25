// redteam-files-name-mask.test.mjs — RED TEAM: what a hostile CELL must not be able to do against `/files`' masked names
// (FILE_ATTACHMENTS.md, "Names under `/files`", rules 1 to 9; #2166). The cell is the adversary: a prompt-injected
// Python cell runs read-only in a worker and can list, stat, open, walk and (under agent/) write. The builder's rows
// (ranged-reader-names.test.mjs) hold the rules; these hold the ORACLES — what a cell can LEARN about a value by
// asking the reader questions, and what it must not learn.
//
// Each row asserts the defended outcome and carries a positive control, so a refusal cannot be a broken harness. Rows
// whose property does not hold today are `{ todo }` with the reason at the row; they were measured against b45ab29a.
//
// The reader is the real RangedReader over a real AgentFiles (fake-indexeddb), as ranged-reader-names.test.mjs. The
// mount adds no naming of its own: files-mount.ts's readdir caches the reader's entries verbatim and its lookup
// forwards the path, which the reader resolves by the same rule (files-mount-py.test.mjs holds the mount's own names),
// so a reader-level answer is what Python's `os.listdir`, `os.scandir`, `glob`, `os.walk` and `os.path.exists` see.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { RangedReader } from "../src/session/ranged-reader.ts";
import { AgentFiles } from "../src/session/agent-files.ts";

const { IDBFactory } = createRequire(import.meta.url)("fake-indexeddb");
const T = { timeout: 5000 };
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

const V1 = "hunter2-db";
const V2 = "hunter2-db-longer-value";
const K = "[REDACTED:DB_PASS]";
const f = (find, put = K) => ({ find, put });
const row = (handle, name, key, bytes) => ({ handle, name, key, bytes: bytes.length, sha256: `sha-${handle}`, attachedMs: 5000 });

/** A reader over a real store; `forms` is the array `secretForms` returns, pushed to by a row. */
function setup(over = {}) {
    const agent = new AgentFiles({ idb: new IDBFactory(), dbName: "t" });
    const forms = [];
    const data = over.data ?? {};
    const source = {
        forms,
        attached: async () => over.attached ?? [],
        blob: async (key) => new Blob([data[key] ?? new Uint8Array()]),
        secretForms: async () => source.forms,
    };
    const reader = new RangedReader({ source, now: () => 123, onLost: () => {}, agent });
    const ch = reader.openChannel("files");
    ch.setSession("s1");
    return { agent, reader, ch, source, forms };
}

async function put(ch, path, text, flags = "w") {
    const t = await ch.begin();
    const { wfd } = await ch.openWrite(path, flags, t);
    await ch.write(wfd, 0, enc(text));
    await ch.closeWrite(wfd);
    await ch.commitTx(t);
}
async function slurp(ch, path) {
    const { fd, size } = await ch.open(path);
    const dest = new Uint8Array(size + 8);
    const n = size ? await ch.read(fd, 0, size, dest) : 0;
    await ch.close(fd);
    return dec(dest.subarray(0, n));
}
const names = async (ch, dir) => (await ch.opendir(dir, { limit: 100 })).entries.map((e) => e.name);
/** What a call does: its value, or the code and message it refused with. */
async function outcome(p) {
    try { return { ok: await p }; } catch (e) { return { code: e.code, message: e.message }; }
}

// --- the shown name is the marker's, never a function of the value ------------------------------------

// The mask's whole job is that a cell cannot read the value off a name. Two ways it could: the shown name keeps some of
// the value (a prefix, its length, its case) or the entry's POSITION in the folder depends on the value's characters.
// Two readers, the same probes, two values that differ in every character and by a length: the shown name and the slot
// must be identical, which is exactly the char-by-char recovery a sort on stored names would hand a cell.
test("RED TEAM (name mask): the shown name and its slot are the marker's, not the value's — two values, one answer", T, async () => {
    const slotOf = async (value) => {
        const { ch, forms } = setup();
        for (const n of ["a0", "a1", "zz"]) await put(ch, `agent/${n}`, "1");
        await put(ch, `agent/m-${value}`, "2");
        forms.push(f(value));
        const listed = await names(ch, "agent");
        return { listed, at: listed.findIndex((n) => n.includes("[REDACTED")) };
    };
    const a = await slotOf(V1);
    const b = await slotOf(V2);
    // Positive control: the entry is listed, between the probes the marker sorts between, in both readers.
    assert.equal(a.listed.length, 4, JSON.stringify(a.listed));
    assert.equal(a.listed[a.at], `m-${K}`, JSON.stringify(a.listed));
    assert.deepEqual(a, b, "a different value of a different length changed what the cell sees");
    // The value's own characters never appear, in the shown name or anywhere in the page.
    const { ch, forms } = setup();
    await put(ch, `agent/x-${V1}-y`, "3");
    forms.push(f(V1));
    const page = await ch.opendir("agent", { limit: 1 });
    assert.ok(!JSON.stringify(page).includes(V1), JSON.stringify(page));
    assert.equal(page.entries[0].name, `x-${K}-y`);
});

test("RED TEAM (name mask): a value registered mid-session changes the shown name on the NEXT call, and nothing else", T, async () => {
    const { ch, forms } = setup();
    await put(ch, `agent/${V1}.txt`, "x");
    // Positive control: before it is registered the name is its own, as any name is.
    assert.deepEqual(await names(ch, "agent"), [`${V1}.txt`]);
    forms.push(f(V1));
    assert.deepEqual(await names(ch, "agent"), [`${K}.txt`]);
    // The slot does not move with the registration: it was and stays where the marker sorts.
    assert.equal((await names(ch, "agent"))[0], `[REDACTED:DB_PASS].txt`);
});

// --- no answer distinguishes a candidate stored name from a wrong guess: the reader is not an oracle -----

// A stored attachment name is the person's file name; it can hold a value (that is why it is masked). Rule 3 keeps the
// EXACT stored name resolving, which makes every lookup a one-bit equality test: a cell tries `attached/h1/<guess>`
// for each candidate and ENOENT/ok tells it whether the guess is the stored name — a dictionary attack on the value,
// with no write needed, on the auto-approved read-only path. The defended property: a raw segment that masks to a
// different string gets the SAME answer as a wrong guess, and the shown name is the only way in.
test("RED TEAM (name mask): the stored name of an attachment is not an equality test — a raw candidate answers as a wrong guess does", { ...T, todo: "open: lookup (src/session/ranged-reader.ts:341-363) tries the exact stored name first, so stat/open/stat-through-a-file of `attached/<handle>/<candidate>` distinguishes the real stored name (ok, or ENOTDIR through it) from a wrong guess (ENOENT); a cell dictionary-attacks the value in the name one stat at a time, read-only. Fix: an exact match on a stored name that maskName shows differently is not a match for a volume the cell did not write (attached/); the shown name resolves it" }, async () => {
    const bytes = enc("attachment body\n");
    const candidate = `${V1}-notes.pdf`;
    const { ch, forms } = setup({ attached: [row("h1", candidate, "k1", bytes)], data: { k1: bytes } });
    forms.push(f(V1));
    // Positive control: the shown name opens it, and the mask is on the listing.
    assert.deepEqual(await names(ch, "attached/h1"), [`${K}-notes.pdf`]);
    assert.equal(await slurp(ch, `attached/h1/${K}-notes.pdf`), "attachment body\n");
    // The oracle: the raw candidate and a wrong guess must be indistinguishable, for a stat, an open, and the
    // stat-through-a-file that answers ENOTDIR only when the segment is exactly a file's stored name.
    const wrong = `${V1}-notes.pdg`;
    for (const call of [(p) => ch.stat(p), (p) => ch.open(p), (p) => ch.stat(`${p}/x`)]) {
        const real = await outcome(call(`attached/h1/${candidate}`));
        const guess = await outcome(call(`attached/h1/${wrong}`));
        assert.deepEqual(real.code, guess.code, `the raw candidate answered ${JSON.stringify(real)}; a wrong guess ${JSON.stringify(guess)}`);
        assert.equal(real.code, "ENOENT", JSON.stringify(real));
    }
    // The marker case rule 3 names still works: a stored name that masks to ITSELF opens by itself.
    const b2 = enc("plain\n");
    const w2 = setup({ attached: [row("h2", "[REDACTED]-plain.txt", "k2", b2), row("h1", candidate, "k1", bytes)], data: { k1: bytes, k2: b2 } });
    w2.forms.push(f(V1));
    assert.equal(await slurp(w2.ch, "attached/h2/[REDACTED]-plain.txt"), "plain\n");
});

// The same one-bit oracle with a WRITE, worse because it needs nothing hidden beforehand: the cell names a file after
// a candidate; if the candidate is a registered value the next listing shows its marker, and the cell learns the value
// from a folder it made. The defended property: a create, a mkdir or a rename onto a name holding a registered value is
// refused, as a marker a shown name could carry is (rule 8), so no listing can answer the question.
test("RED TEAM (name mask): a create is not a probe for a registered value — a name holding one is refused, as a reserved marker is", { ...T, todo: "open: writable (src/session/ranged-reader.ts:385-396) reserves the markers a shown name CARRIES, not the forms themselves, so `openWrite('agent/x-<value>-y')` succeeds with the value registered and the next opendir shows `x-[REDACTED:<NAME>]-y`, confirming the guess; mkdir and a rename destination are the same. Fix: a create/rename-to whose last segment holds a form's `find` is refused (EACCES), which also keeps the value out of the stored names" }, async () => {
    const { ch, forms } = setup();
    await put(ch, "agent/plain", "1");
    forms.push(f(V1));
    // Positive control: the same shape with a non-value succeeds and is listed verbatim, so the refusal is about the
    // value and not the shape.
    await put(ch, `agent/around-not-a-value-end`, "2");
    assert.ok((await names(ch, "agent")).includes("around-not-a-value-end"));
    // The probe, by each way a name can be made.
    const t = await ch.begin();
    const probe = `agent/around-${V1}-end`;
    const created = await outcome(ch.openWrite(probe, "w", t));
    assert.equal(created.code, "EACCES", `openWrite ${JSON.stringify(created)}`);
    const made = await outcome(ch.mkdir(`agent/${V1}-dir`, t));
    assert.equal(made.code, "EACCES", `mkdir ${JSON.stringify(made)}`);
    const renamed = await outcome(ch.rename("agent/plain", `agent/${V1}-renamed`, t));
    assert.equal(renamed.code, "EACCES", `rename ${JSON.stringify(renamed)}`);
    // And the listing that would have answered: nothing it can make shows a marker it did not ask for.
    await ch.commitTx(t);
    assert.ok(!(await names(ch, "agent")).some((n) => n.startsWith("around-[REDACTED")), (await names(ch, "agent")).join(","));
});

// --- a cell cannot join a masked name's collision group, so the tie order is not an oracle ---------------

// Rule 8's markers are derived from the forms AT THE CALL (a config put the tests do not hardcode), so a cell cannot
// make a second entry under a shown name and read the tied order. Positive control: with the form gone the same name
// is free, which is what makes the refusal the form's doing rather than the string's.
test("RED TEAM (name mask): the reserved markers are the forms' own at that call — a put the code never names is reserved too", T, async () => {
    const { ch, forms } = setup();
    await put(ch, "agent/plain", "1");
    const marker = "[just-this-test]";
    forms.push({ find: "never-in-any-listed-name", put: marker });
    const t = await ch.begin();
    const refused = await outcome(ch.openWrite(`agent/x${marker}y`, "w", t));
    assert.equal(refused.code, "EACCES", JSON.stringify(refused));
    assert.match(refused.message, /reserved/, refused.message);
    // A file it wrote before the form existed lists under the shown name; the create of that exact name is not a
    // shadow (rule 6): it resolves to the one existing file.
    forms.length = 0;
    await put(ch, "agent/note-never-in-any-listed-name-end", "2");
    forms.push({ find: "never-in-any-listed-name", put: marker });
    assert.deepEqual(await names(ch, "agent"), ["note-" + marker + "-end", "plain"]);
    const shadow = await outcome((async () => { const t2 = await ch.begin(); return ch.openWrite(`agent/note-${marker}-end`, "w", t2); })());
    assert.equal(shadow.code, undefined, "the exact-match fast path addresses the existing file, never a shadow");
    // Positive control: with the forms gone the literal name is just a name.
    forms.length = 0;
    const free = await outcome((async () => { const t3 = await ch.begin(); return ch.openWrite(`agent/x${marker}y`, "w", t3); })());
    assert.equal(free.code, undefined, JSON.stringify(free));
});

// Rule 2: entries under ONE shown name are ordered by birth time, then a hash of the stored name under a salt drawn
// per reader — never by the stored name. If the order were the stored names', a cell that could see two ties could
// rank a candidate against them. Three ties, one birth time, six readers: if the order came from the names it would be
// the same six times; a salt per reader makes it differ.
test("RED TEAM (name mask): the tie order under one shown name is not the stored names' order", T, async () => {
    const orders = new Set();
    for (let r = 0; r < 6; r++) {
        const { ch, agent, forms } = setup();
        // One commit, so the three birth times are the same and only the tie-break can order them.
        await agent.commit("s1", [
            { op: "put", path: "zsecret", data: new Blob(["z"]) },
            { op: "put", path: "asecret", data: new Blob(["aa"]) },
            { op: "put", path: "secretm", data: new Blob(["mmm"]) },
        ]);
        forms.push(f("zsecret", "S"), f("asecret", "S"), f("secretm", "S"));
        const page = await ch.opendir("agent", { limit: 10 });
        // Positive control: all three are listed, under one shown name, with the same birth time.
        assert.deepEqual(page.entries.map((e) => e.name), ["S", "S", "S"]);
        assert.equal(new Set(page.entries.map((e) => e.birthtimeMs)).size, 1, "the ties need one birth time to test the hash");
        orders.add(page.entries.map((e) => e.size).join(","));
    }
    assert.ok(orders.size > 1, `six readers sorted the ties the same way (${[...orders].join(" / ")}): the order came from the stored names`);
});
