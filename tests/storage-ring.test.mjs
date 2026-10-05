// The buffered ring behind both logs (src/storage-ring.ts): records batch into one write, two flushes never drop
// each other's, and a subclass gets to write its own keys in the same batch.
import { test } from "node:test";
import assert from "node:assert";
import { StorageRing, FLUSH_DELAY_MS } from "../src/storage-ring.ts";

function area(seed = {}) {
    const store = { ...seed };
    let writes = 0;
    const self = {
        store,
        writes: () => writes,
        /** Set to a promise to hold every `set` until it resolves — how an interleaved flush is staged. */
        block: null,
        get: async (keys) => Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
        set: async (items) => { if (self.block) await self.block; writes++; Object.assign(store, structuredClone(items)); },
    };
    return self;
}

/** Lets every pending microtask and timer-free continuation run, so a staged flush has reached storage. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A ring with the protected members opened up, which is how a subclass uses them. */
class Ring extends StorageRing {
    constructor(a, cap = 100, now = () => 1) { super(a, "k", (rs) => (rs.length > cap ? rs.slice(rs.length - cap) : rs), now); }
    add(v) { this.push(v); }
    wipe(rs) { return this.replace(rs); }
}

// --- batching: a burst of records costs one write ---

test("a burst of records is written once, not once each", async () => {
    const a = area();
    const r = new Ring(a);
    for (let i = 0; i < 20; i++) r.add({ i });
    await r.flush();
    assert.equal(a.writes(), 1);
    assert.deepEqual((await r.all()).map((x) => x.i), [...Array(20).keys()]);
});

test("all() includes what is still buffered, so a read never misses the newest record", async () => {
    const a = area();
    const r = new Ring(a);
    r.add({ i: 1 });
    assert.deepEqual((await r.all()).map((x) => x.i), [1]);
});

test("nothing buffered and nothing to contribute means no write at all", async () => {
    const a = area();
    await new Ring(a).flush();
    assert.equal(a.writes(), 0);
});

test("the trim rule is applied on the way in, so the stored ring is never over its cap", async () => {
    const a = area();
    const r = new Ring(a, 3);
    for (let i = 0; i < 5; i++) r.add({ i });
    await r.flush();
    assert.deepEqual(a.store.k.map((x) => x.i), [2, 3, 4]);
});

// --- the serialized write: two flushes must not read the same stored ring ---

test("a flush that starts while another is mid-write still appends to it", async () => {
    const a = area();
    const r = new Ring(a);
    let release;
    a.block = new Promise((res) => { release = res; });
    r.add({ i: 1 });
    const first = r.flush();
    await settle();                     // the first flush is now parked inside set()
    r.add({ i: 2 });
    const second = r.flush();           // must wait for the first, then read the ring IT wrote
    a.block = null;
    release();
    await Promise.all([first, second]);
    assert.deepEqual((await r.all()).map((x) => x.i), [1, 2]);
});

test("a storage failure costs the batch and nothing else: the ring keeps taking records", async () => {
    const a = area();
    const r = new Ring(a);
    a.set = async () => { throw new Error("quota"); };
    r.add({ i: 1 });
    await r.flush();                    // does not reject
    a.set = async (items) => { Object.assign(a.store, structuredClone(items)); };
    r.add({ i: 2 });
    await r.flush();
    assert.deepEqual((await r.all()).map((x) => x.i), [2]);
});

// --- what a subclass contributes and how a ring is emptied ---

test("a subclass's own keys ride along in the same batch", async () => {
    const a = area();
    class Beating extends Ring { extras() { return { beat: 7 }; } }
    const r = new Beating(a);
    r.add({ i: 1 });
    await r.flush();
    assert.equal(a.writes(), 1);
    assert.equal(a.store.beat, 7);
});

test("a subclass with only extras to write still writes them", async () => {
    const a = area();
    class Beating extends Ring { extras() { return { beat: 9 }; } }
    await new Beating(a).flush();
    assert.equal(a.store.beat, 9);
    assert.equal(a.store.k, undefined);
});

test("replace drops what was buffered as well as what was stored", async () => {
    const a = area({ k: [{ i: 0 }] });
    const r = new Ring(a);
    r.add({ i: 1 });
    await r.wipe([{ i: 9 }]);
    assert.deepEqual((await r.all()).map((x) => x.i), [9]);
});

// --- the timer: a record left alone is written without anyone asking ---

test("a record nobody flushes is written a moment later", async () => {
    const a = area();
    const r = new Ring(a);
    r.add({ i: 1 });
    assert.equal(a.writes(), 0);
    await new Promise((res) => setTimeout(res, FLUSH_DELAY_MS + 50));
    assert.deepEqual(a.store.k.map((x) => x.i), [1]);
});
