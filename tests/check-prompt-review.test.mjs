// check-prompt-review.test.mjs — the prompt-review reminder: when it speaks, and which date counts as the last review.

import { test } from "node:test";
import assert from "node:assert/strict";
import { lastReview, reminder } from "../scripts/check-prompt-review.mjs";

// --- the last review: the newer of AGENTS.md and the trailers ---

test("the last review is the newer of AGENTS.md's date and the newest Prompt-Review trailer", () => {
    assert.equal(lastReview("Last review: **2026-10-10** (#544).", ["2026-09-01"]), "2026-10-10");
    assert.equal(lastReview("Last review: **2026-10-10**.", ["2026-11-02", "2026-09-01"]), "2026-11-02");
    assert.equal(lastReview("no record", []), null);
    assert.equal(lastReview("no record", ["junk"]), null);
});

// --- when it speaks ---

test("it speaks past 30 days or 25 commits of model-facing changes, and says nothing before either", () => {
    const today = new Date("2026-11-05T12:00:00Z");
    assert.equal(reminder("2026-10-10", 3, today), null, "26 days, few commits: quiet");
    assert.match(reminder("2026-10-01", 3, today), /2026-10-01 \(35 days ago; 3 commits/);
    assert.match(reminder("2026-10-20", 25, today), /25 commits have changed what the model reads/);
    assert.match(reminder(null, 0, today), /No prompt review is recorded/);
});
