"use strict";
// The pure resume-decision for durable background runs (contract.ts). This is the guard that stops a
// zombie run — one from a PREVIOUS extension version, or one long-dead — from being silently resumed on
// an SW respawn (the "an old session resumes, invisible + unstoppable, after a reload" bug). The chrome
// glue (onInstalled purge, storage delete) lives in background.ts; this is the decision it hangs on.
import { test } from "node:test";
import assert from "node:assert";
import { bgRunResumable, STALE_BGRUN_MS } from "../src/contract.ts";

const V = "1.4.0";
const now = 1_000_000_000_000;

test("bgRunResumable: a same-version, fresh snapshot resumes", () => {
    assert.equal(bgRunResumable({ version: V, ts: now - 5_000 }, V, now), true);
});

test("bgRunResumable: a snapshot from a DIFFERENT version is invalidated (a reload/update happened)", () => {
    assert.equal(bgRunResumable({ version: "1.3.0", ts: now - 5_000 }, V, now), false);
});

test("bgRunResumable: an UN-STAMPED legacy snapshot (no version) is invalidated — self-heal for old zombies", () => {
    assert.equal(bgRunResumable({ ts: now - 5_000 }, V, now), false);
    assert.equal(bgRunResumable({}, V, now), false);
});

test("bgRunResumable: a STALE snapshot (older than a live respawn could ever be) is invalidated", () => {
    assert.equal(bgRunResumable({ version: V, ts: now - STALE_BGRUN_MS - 1 }, V, now), false);
    // A run genuinely evicted seconds ago (its last checkpoint) still resumes.
    assert.equal(bgRunResumable({ version: V, ts: now - 3_000 }, V, now), true);
});

test("bgRunResumable: the freshness boundary is inclusive (exactly STALE_BGRUN_MS still resumes)", () => {
    assert.equal(bgRunResumable({ version: V, ts: now - STALE_BGRUN_MS }, V, now), true);
    assert.equal(bgRunResumable({ version: V, ts: now - STALE_BGRUN_MS - 1 }, V, now), false);
});

test("bgRunResumable: a current-version snapshot with no ts resumes (version match is the strong signal)", () => {
    assert.equal(bgRunResumable({ version: V }, V, now), true);
});
