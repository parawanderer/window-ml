// hops-worker.js — the dedicated worker of the hop probe: echoes messages, parks on Atomics.wait, and plays the Python
// worker's part of route A (post a request, block in 50 ms slices on a SharedArrayBuffer, read the reply from it).

/** Layout of the chain's SharedArrayBuffer: Int32 words 0 (state: 0 idle, 1 posted, 2 reply ready), 1 (reply byte length), 2 (interrupt flag); data from byte 64. */
const DATA_OFF = 64;

/** The slice the sliced wait uses, as route A proposes. */
const SLICE_MS = 50;

/** Time on a clock the page and the workers share. */
const now = () => performance.timeOrigin + performance.now();

let chainSab = null;
let chainId = 0;

/**
 * Do one blocking call through the page: post it, then wait on the SAB in slices, checking the interrupt word.
 * @param {string} call the host call
 * @param {object} args its arguments
 * @returns {{value: any, error: any, ms: number, slices: number}} the parsed reply and how long the block took
 */
function blockingCall(call, args) {
    const i32 = new Int32Array(chainSab);
    Atomics.store(i32, 0, 0);
    const t0 = performance.now();
    postMessage({ t: "req", id: ++chainId, call, args });
    let slices = 0;
    while (Atomics.load(i32, 0) !== 2) {
        Atomics.wait(i32, 0, 0, SLICE_MS);
        slices++;
        if (Atomics.load(i32, 2) === 2) throw new Error("interrupted");
    }
    const len = Atomics.load(i32, 1);
    const copy = new Uint8Array(len);
    copy.set(new Uint8Array(chainSab, DATA_OFF, len));
    const text = new TextDecoder().decode(copy);
    const msg = JSON.parse(text);
    return { ...msg, ms: performance.now() - t0, slices };
}

/** Decode base64 into bytes, as the worker must before handing a chunk to Python. */
function b64len(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.length;
}

onmessage = (e) => {
    const m = e.data;
    if (m.t === "echo") { postMessage(m); return; }
    if (m.t === "ack") { postMessage({ t: "ack", id: m.id }); return; }
    if (m.t === "pingA") {
        // Client of a worker-to-worker ping-pong: batches of n round trips on words 0 (ping) and 1 (pong).
        const i32 = new Int32Array(m.sab);
        const batches = [];
        for (let b = 0; b < m.batches + 1; b++) {
            const t0 = performance.now();
            for (let i = 0; i < m.n; i++) {
                const v = Atomics.add(i32, 0, 1) + 1;
                Atomics.notify(i32, 0);
                while (Atomics.load(i32, 1) < v) Atomics.wait(i32, 1, v - 1, 1000);
            }
            if (b > 0) batches.push((performance.now() - t0) / m.n);   // batch 0 is warm-up
        }
        postMessage({ t: "pingA", batches });
        return;
    }
    if (m.t === "pingB") {
        const i32 = new Int32Array(m.sab);
        const total = m.n * (m.batches + 1);
        for (let v = 1; v <= total; v++) {
            while (Atomics.load(i32, 0) < v) Atomics.wait(i32, 0, v - 1, 1000);
            Atomics.add(i32, 1, 1);
            Atomics.notify(i32, 1);
        }
        postMessage({ t: "pingB" });
        return;
    }
    if (m.t === "parked") {
        // Park on word 0 and report when the page's notify reached us, on the shared clock.
        const i32 = new Int32Array(m.sab);
        const f64 = new Float64Array(m.sab, 16, 4);
        for (let r = 0; r < m.reps; r++) {
            while (Atomics.load(i32, 0) !== r + 1) Atomics.wait(i32, 0, r, 1000);
            const t1 = now();
            f64[1] = t1;
            Atomics.store(i32, 1, r + 1);
            Atomics.notify(i32, 1);
            postMessage({ t: "parkedRep", r, t0: f64[0], t1 });
        }
        postMessage({ t: "parked" });
        return;
    }
    if (m.t === "chain") {
        chainSab = m.sab;
        postMessage({ t: "chainReady" });
        return;
    }
    if (m.t === "chainHello") {
        const out = [];
        for (let i = 0; i < m.reps; i++) { const r = blockingCall("hello", {}); if (r.error) throw new Error(JSON.stringify(r.error)); out.push({ ms: r.ms, slices: r.slices }); }
        postMessage({ t: "chainHello", out });
        return;
    }
    if (m.t === "chainFile") {
        // A whole held output read chunk by chunk, each a blocking call; the bytes are decoded as a worker would.
        const t0 = performance.now();
        let off = 0, size = Infinity;
        const chunkMs = [];
        while (off < size) {
            const r = blockingCall("read", { ptr: m.ptr, offset: off, length: m.chunk });
            if (r.error) throw new Error(JSON.stringify(r.error));
            const v = r.value;
            size = v.size;
            const d0 = performance.now();
            const n = b64len(v.data.$bytes);
            off += n;
            chunkMs.push({ rpc: r.ms, decode: performance.now() - d0 });
            if (v.eof) break;
        }
        postMessage({ t: "chainFile", ms: performance.now() - t0, bytes: off, chunkMs });
        return;
    }
};
