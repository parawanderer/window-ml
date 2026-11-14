// hops-page.js — the extension page of the hop probe: stands where the offscreen document stands in route A. It owns a
// dedicated worker, times the page/worker and page/service-worker hops, and relays the worker's blocking calls to the
// service worker (a probe listener `evaluate`d in there by measure-hops.mjs, so nothing in src/ changes).

/** Layout of the chain's SharedArrayBuffer: see hops-worker.js. */
const DATA_OFF = 64;
const SAB_BYTES = 4 << 20;

/** A string of `bytes` raw bytes' worth of base64 (4/3 as many characters). */
const b64String = (bytes) => "A".repeat(Math.ceil(bytes / 3) * 4);

/** Median, p90 and max of a list of numbers. */
const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    return { n: s.length, median: q(0.5), p90: q(0.9), max: s[s.length - 1], min: s[0], mean: s.reduce((a, b) => a + b, 0) / s.length };
};

const worker = new Worker("hops-worker.js");

/** Wait for the next message of type `t` from `w`. */
const next = (w, t) => new Promise((res) => { const f = (e) => { if (e.data.t === t) { w.removeEventListener("message", f); res(e.data); } }; w.addEventListener("message", f); });

/**
 * Round trips of one payload to the dedicated worker and back, as the page sees them.
 * @param {"str"|"ab"} kind a base64 string, or an ArrayBuffer (structured clone)
 * @param {number} bytes raw size
 * @param {number} reps repeats
 */
async function workerRtt(kind, bytes, reps) {
    const payload = kind === "str" ? b64String(bytes) : new ArrayBuffer(bytes);
    const out = [];
    for (let i = 0; i < reps + 2; i++) {
        const p = next(worker, "echo");
        const t0 = performance.now();
        worker.postMessage({ t: "echo", payload });
        await p;
        if (i >= 2) out.push(performance.now() - t0);
    }
    return { kind, bytes, ...stats(out), samples: out };
}

/**
 * Small-message round trips timed in batches, since one sample is quantised to 0.1 ms: the figure is the mean per round
 * trip of `n` back-to-back ones, over `batches` batches.
 * @param {"worker"|"sw"} hop which hop
 * @param {number} n round trips per batch
 * @param {number} batches batches
 */
async function smallBatch(hop, n, batches) {
    const one = hop === "worker"
        ? async () => { const p = next(worker, "echo"); worker.postMessage({ t: "echo", payload: "x" }); await p; }
        : async () => { await chrome.runtime.sendMessage({ type: "__hops_sw", reply: 0 }); };
    const out = [];
    for (let b = 0; b < batches + 1; b++) {
        const t0 = performance.now();
        for (let i = 0; i < n; i++) await one();
        if (b > 0) out.push((performance.now() - t0) / n);
    }
    return { hop, n, ...stats(out), samples: out };
}

/** The wake cost across a worker boundary: ping-pong between two workers, and a parked worker woken by the page. */
async function wake(batches, n) {
    const sab = new SharedArrayBuffer(64);
    const a = new Worker("hops-worker.js"), b = new Worker("hops-worker.js");
    const pa = next(a, "pingA"), pb = next(b, "pingB");
    b.postMessage({ t: "pingB", sab, n, batches });
    a.postMessage({ t: "pingA", sab, n, batches });
    const r = await pa; await pb;
    a.terminate(); b.terminate();
    const pingpong = { roundTripMs: stats(r.batches), batches, n };

    const reps = 60;
    const sab2 = new SharedArrayBuffer(64);
    const i32 = new Int32Array(sab2), f64 = new Float64Array(sab2, 16, 4);
    const w = new Worker("hops-worker.js");
    const done = next(w, "parked");
    w.postMessage({ t: "parked", sab: sab2, reps });
    await new Promise((r) => setTimeout(r, 100));
    const oneWay = [];
    for (let r = 0; r < reps; r++) {
        await new Promise((x) => setTimeout(x, 10));   // let the worker park on the wait again
        f64[0] = performance.timeOrigin + performance.now();
        Atomics.store(i32, 0, r + 1);
        Atomics.notify(i32, 0);
        while (Atomics.load(i32, 1) !== r + 1) await new Promise((x) => setTimeout(x, 1));
        oneWay.push(f64[1] - f64[0]);
    }
    await done; w.terminate();
    return { pingpong, parkedWake: { oneWayMs: stats(oneWay), samples: oneWay, note: "page notify to the parked worker's return from Atomics.wait, on performance.timeOrigin+now (clock grain may be 0.1 ms)" } };
}

/**
 * chrome.runtime.sendMessage to the service worker's probe listener.
 * @param {"up"|"down"|"small"} dir `up`: payload in the request, tiny reply; `down`: tiny request, payload in the reply
 * @param {number} bytes raw size
 * @param {number} reps repeats
 */
async function swRtt(dir, bytes, reps) {
    const payload = b64String(bytes);
    const out = [];
    for (let i = 0; i < reps + 2; i++) {
        const t0 = performance.now();
        const r = dir === "up" ? await chrome.runtime.sendMessage({ type: "__hops_sw", payload, reply: 0 })
            : await chrome.runtime.sendMessage({ type: "__hops_sw", reply: dir === "down" ? Math.ceil(bytes / 3) * 4 : 0 });
        const ms = performance.now() - t0;
        if (!r || !r.ok) throw new Error("no probe answer: " + JSON.stringify(r));
        if (i >= 2) out.push(ms);
    }
    return { dir, bytes, ...stats(out), samples: out };
}

/** Wire the worker's blocking calls to the service worker's host relay, through the SAB. */
async function chainSetup() {
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const i32 = new Int32Array(sab);
    const w = new Worker("hops-worker.js");
    w.onmessage = async (e) => {
        const m = e.data;
        if (m.t !== "req") return;
        let msg;
        try { msg = await chrome.runtime.sendMessage({ type: "__hops_host", call: m.call, args: m.args }); }
        catch (err) { msg = { error: { code: "Relay", message: String(err) } }; }
        const bytes = new TextEncoder().encode(JSON.stringify(msg || { error: { code: "NoAnswer" } }));
        if (bytes.length > SAB_BYTES - DATA_OFF) throw new Error("reply too big for the SAB: " + bytes.length);
        new Uint8Array(sab, DATA_OFF, bytes.length).set(bytes);
        Atomics.store(i32, 1, bytes.length);
        Atomics.store(i32, 0, 2);
        Atomics.notify(i32, 0);
    };
    const ready = next(w, "chainReady");
    w.postMessage({ t: "chain", sab });
    await ready;
    return w;
}

let chainWorker = null;
window.__h = {
    workerRtt, wake, swRtt, smallBatch,
    async chainHello(reps) {
        chainWorker ??= await chainSetup();
        const p = next(chainWorker, "chainHello");
        chainWorker.postMessage({ t: "chainHello", reps });
        const r = await p;
        return { ...stats(r.out.slice(2).map((x) => x.ms)), samples: r.out.map((x) => x.ms), slices: stats(r.out.map((x) => x.slices)) };
    },
    async chainHelloBatch(n, batches) {
        chainWorker ??= await chainSetup();
        const out = [];
        for (let b = 0; b < batches + 1; b++) {
            const p = next(chainWorker, "chainHello");
            const t0 = performance.now();
            chainWorker.postMessage({ t: "chainHello", reps: n });
            await p;
            if (b > 0) out.push((performance.now() - t0) / n);
        }
        return { n, ...stats(out), samples: out };
    },
    async chainFile(ptr, chunk) {
        chainWorker ??= await chainSetup();
        const p = next(chainWorker, "chainFile");
        chainWorker.postMessage({ t: "chainFile", ptr, chunk });
        return await p;
    },
    stats,
};
