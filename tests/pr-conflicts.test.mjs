// pr-conflicts.test.mjs — the guard over a failure that is the ABSENCE of a check (scripts/pr-conflicts.mjs).
//
// A PR that conflicts with its base gets no `pull_request` run at all, because there is no merge commit to build one
// against, so its pushes look untested rather than failing. What is testable here without GitHub is the decision:
// which answers mean "say something", which mean "wait", and what is said.

import test from "node:test";
import assert from "node:assert/strict";
import { MARKER, conflictComment, sortByMergeable } from "../scripts/pr-conflicts.mjs";

// --- what each answer from GitHub means ---

test("an unanswered mergeability is its own bucket, never a conflict", () => {
    // GitHub computes this asynchronously and says `null` for a window after every push — after a push to the BASE,
    // for every open PR at once. Reading that as a conflict would comment on every PR in the repo each time anything
    // lands, which is how a guard gets turned off.
    const out = sortByMergeable([
        { number: 1, mergeable: null },
        { number: 2, mergeable: "UNKNOWN" },
        { number: 3 },
        { number: 4, mergeable: "MERGEABLE" },
        { number: 5, mergeable: "CONFLICTING" },
    ]);
    assert.deepEqual(out.unknown.map((p) => p.number), [1, 2, 3]);
    assert.deepEqual(out.ok.map((p) => p.number), [4]);
    assert.deepEqual(out.conflicting.map((p) => p.number), [5]);
});

test("a draft that conflicts is reported apart, rather than dropped or nagged about", () => {
    // A draft that does not merge is not news. Counting it separately is what keeps a run from silently losing one.
    const out = sortByMergeable([
        { number: 7, mergeable: "CONFLICTING", isDraft: true },
        { number: 8, mergeable: "CONFLICTING" },
    ]);
    assert.deepEqual(out.conflicting.map((p) => p.number), [8]);
    assert.deepEqual(out.drafts.map((p) => p.number), [7]);
});

// --- what it says on the pull request ---

test("the comment names the consequence, not the state, and can find itself later", () => {
    const body = conflictComment("main", "247ece52");
    assert.ok(body.startsWith(MARKER), "a marker, so the next run edits this comment instead of stacking another");
    assert.match(body, /CI is no longer running on it/);
    // The point someone has to understand is that nothing went red: "CONFLICTING" can be read without noticing that
    // the checks have stopped existing.
    assert.match(body, /absence of one/);
    assert.match(body, /247ece52/, "and which commit on the base did it");
    assert.match(body, /Merge `main` in \(or rebase\)/);
});
