// resident-reader.test.mjs — "is this model loaded on that runtime's box right now" (src/sidebar/resident-reader.ts):
// answered only for a runtime this device reads, only from a fresh and successful reading, and otherwise not known.
import { test } from "node:test";
import assert from "node:assert/strict";
import { residentReader, RESIDENT_FRESH_MS, RESIDENT_ASK_MS } from "../src/sidebar/resident-reader.ts";

/** A reader over a scripted world: a clock, a reading that lands when `land` is called, and what it says. */
function world() {
    const w = { t: 1_000_000, readAt: null, failed: false, loaded: new Set(), reads: 0 };
    const ask = residentReader({
        mine: (rt) => rt === "laptop",
        read: () => { w.reads++; },
        readAt: () => w.readAt,
        failed: () => w.failed,
        resident: (m) => w.loaded.has(m),
        now: () => w.t,
    });
    const land = (...models) => { w.readAt = w.t; w.failed = false; w.loaded = new Set(models); };
    return { w, ask, land };
}

// --- whose box, and how old the reading may be ---

test("not known until a reading lands; then loaded or not, for this device's own runtime only", () => {
    const { w, ask, land } = world();
    assert.equal(ask("laptop", "qwen3:32b"), undefined, "nothing read yet");
    assert.equal(w.reads, 1, "and asking started a read");
    land("gemma3:27b");
    assert.equal(ask("laptop", "qwen3:32b"), false, "read, and not there: Awakening… is true");
    assert.equal(ask("laptop", "gemma3:27b"), true);
    assert.equal(ask("lab", "gemma3:27b"), undefined, "another runtime's box is not this reading's");
    assert.equal(ask("laptop", null), undefined);
});

test("a stale reading and a failed one are NOT KNOWN, never not loaded", () => {
    const { w, ask, land } = world();
    land();
    assert.equal(ask("laptop", "qwen3:32b"), false);
    w.t += RESIDENT_FRESH_MS + 1;
    assert.equal(ask("laptop", "qwen3:32b"), undefined, "older than the window: it may have loaded since");
    land();
    w.failed = true;
    assert.equal(ask("laptop", "qwen3:32b"), undefined, "a failed read is no news, whatever it left behind");
});

test("asking keeps a reading current, at most once per interval", () => {
    const { w, ask } = world();
    ask("laptop", "m"); ask("laptop", "m"); ask("laptop", "m");
    assert.equal(w.reads, 1, "three asks inside one interval, one read");
    w.t += RESIDENT_ASK_MS;
    ask("laptop", "m");
    assert.equal(w.reads, 2);
    ask("lab", "m");
    assert.equal(w.reads, 2, "a runtime this device cannot read never triggers one");
});
