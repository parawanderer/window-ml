// redteam-mount-judge.test.mjs — what a mounted folder's judge must refuse and today does not: a rename whose target
// facts are another mount's, or a mount mounted read-only. FILE_ATTACHMENTS.md, the row list's "`rename` with a source
// or target outside this mount, or in another mount, is refused, never degraded to a copy and a delete" and the
// table's "any write to a read-only mount | refused (`EROFS`) | `mode`". MEASURED AT 7496a576: the first test is RED
// (both assertions), the second is green and reds against the mutation named in it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeMount } from "../src/shell/mount-judge.ts";
import { HostClient } from "../src/shell/host-protocol.ts";

const basis = { dev: 1, ino: 2, size: 3, mtimeNs: 4, sha256: "ab" };

/** The facts of a tracked, unchanged file in a writable mount; `over` changes some. */
const facts = (over = {}) => ({
    mount: "m1", path: "a.txt", inMount: true, mode: "rw", kind: "file", exists: true, secret: false, protected: false,
    ignored: false, inUploads: false, inAttached: false, gitUndoable: true, hardLinked: false, basis, ...over,
});

/** A name nothing holds yet in mount `m`, with that mount's mode. */
const free = (over = {}) => facts({ path: "b.txt", kind: null, exists: false, basis: null, ...over });

// --- the target's own mount ---

test("RED TEAM: a rename whose target facts name another mount, or a read-only one, is refused, never judged free", () => {
    const other = judgeMount("rename", facts(), free({ mount: "m2" }));
    assert.equal(other.verdict, "refused", `a target in another mount was judged ${other.verdict}: ${JSON.stringify(other.rows)}`);
    const ro = judgeMount("rename", facts(), free({ mode: "ro" }));
    assert.equal(ro.verdict, "refused", `a target in a read-only mount was judged ${ro.verdict}: ${JSON.stringify(ro.rows)}`);
});

test("RED TEAM: a rename hands back the SOURCE's basis, never one the target (or a cell) supplied", () => {
    const targetBasis = { dev: 9, ino: 9, size: 9, mtimeNs: 9, sha256: "ff" };
    const j = judgeMount("rename", facts(), free({ basis: targetBasis, exists: true, kind: "file" }));
    assert.deepEqual(j.basis, basis);
    assert.notDeepEqual(j.basis, targetBasis);
});

test("RED TEAM: the rename call it is judged for carries one mount, and the source's basis, on the wire", async () => {
    const sent = [];
    const port = { send: (m) => sent.push(m), onMessage: () => {}, onClose: () => {} };
    const c = new HostClient(port);
    c.rename({ session: "s1", mount: "m1", from: "a.txt", to: "b.txt", basis });
    assert.deepEqual(sent[0].args, { session: "s1", mount: "m1", from: "a.txt", to: "b.txt", basis });
    assert.equal(sent[0].call, "rename");
});
