// probe.js — one route out of an artifact's sandbox frame, named by `?p=`, aimed at the spec's counting server.
// It runs as a manifest SANDBOX page (an opaque origin under the sandbox CSP), the frame an artifact would draw in,
// with no mediation: what it reaches is what an escaped evaluator would reach (tests/e2e/artifact-wall.spec.mjs).
const q = new URLSearchParams(location.search);
const P = q.get("p"), H = q.get("h"), T = q.get("t"), U = q.get("u");
/** The counting server's URL for this probe; `tag` tells two requests of one probe apart. */
const hit = (tag = "") => `${H}/hit/${P}${tag ? "-" + tag : ""}`;
/** Append an element built from `html` to the body. */
const put = (html) => { const d = document.createElement("div"); d.innerHTML = html; document.body.append(...d.childNodes); };

const PROBES = {
    // --- navigation of the frame itself (sandbox allows it; the embedder's frame-src is the question) ---
    "nav-location": () => { location.href = hit(); },
    "nav-meta": () => put(`<meta http-equiv="refresh" content="0;url=${hit()}">`),
    "nav-anchor": () => { const a = document.createElement("a"); a.href = hit(); document.body.append(a); a.click(); },
    "nav-data-chain": () => { location.href = `data:text/html,<meta http-equiv="refresh" content="0;url=${hit()}">`; },
    "nav-blob-chain": () => { location.href = URL.createObjectURL(new Blob([`<meta http-equiv="refresh" content="0;url=${hit()}">`], { type: "text/html" })); },
    // --- navigation of anything else: a popup, the top, a form ---
    "nav-anchor-blank": () => { const a = document.createElement("a"); a.href = hit(); a.target = "_blank"; document.body.append(a); a.click(); },
    "nav-open": () => { window.open(hit()); },
    "nav-top": () => { top.location.href = hit(); },
    "nav-form": () => { put(`<form id=f action="${hit()}" method=get><input name=x value=1></form>`); document.getElementById("f").submit(); },
    "nested-srcdoc": () => put(`<iframe srcdoc='<meta http-equiv="refresh" content="0;url=${hit()}">'></iframe>`),
    "nested-iframe": () => put(`<iframe src="${hit()}"></iframe>`),
    "a-ping": () => { const a = document.createElement("a"); a.href = "#here"; a.ping = hit(); document.body.append(a); a.click(); },
    // --- subresources ---
    "img": () => put(`<img src="${hit()}">`),
    "css-bg": () => put(`<div style="width:9px;height:9px;background:url(${hit()})"></div>`),
    "css-link": () => put(`<link rel=stylesheet href="${hit()}">`),
    "css-import": () => put(`<style>@import url(${hit()});</style>`),
    "font": () => put(`<style>@font-face{font-family:X;src:url(${hit()})}</style><span style="font-family:X">x</span>`),
    "video": () => put(`<video src="${hit()}" autoplay muted></video>`),
    "audio": () => put(`<audio src="${hit()}" autoplay></audio>`),
    "object": () => put(`<object data="${hit()}"></object>`),
    "script": () => put(`<script src="${hit()}"><\/script>`),
    "worker": () => { new Worker(hit()); },
    "manifest": () => put(`<link rel=manifest href="${hit()}">`),
    "prefetch": () => put(`<link rel=prefetch href="${hit()}">`),
    "preload-fetch": () => put(`<link rel=preload as=fetch href="${hit()}" crossorigin>`),
    "preload-style": () => put(`<link rel=preload as=style href="${hit()}">`),
    // A connection with no request: counted by the spec's bare TCP listener on port T.
    "preconnect": () => put(`<link rel=preconnect href="http://pre.test:${T}">`),
    // --- the connect-src family ---
    "fetch": () => fetch(hit()).catch(() => {}),
    "xhr": () => { const x = new XMLHttpRequest(); x.open("GET", hit()); x.send(); },
    "beacon": () => navigator.sendBeacon(hit(), "x"),
    "websocket": () => { new WebSocket(hit().replace(/^http/, "ws")); },
    "eventsource": () => { new EventSource(hit()); },
    // --- WebRTC: ICE gathering sends STUN to the spec's UDP listener on port U, outside connect-src ---
    "webrtc-stun": async () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:127.0.0.1:${U}` }] });
        pc.createDataChannel("x");
        await pc.setLocalDescription(await pc.createOffer());
    },
};

// --- the same routes from a dedicated worker the frame starts from a blob: where an evaluator could run with no
// window at all. `w-<route>`; the worker reports what exists in its scope, the server counts what left. ---
/** The worker's body: run route `r` against base URL `h`, then report the window-only names it can see. */
function workerMain(r, h) {
    const hit = () => `${h}/hit/w-${r}`;
    const routes = {
        fetch: () => fetch(hit()).catch(() => {}),
        xhr: () => { const x = new XMLHttpRequest(); x.open("GET", hit()); x.send(); },
        websocket: () => { new WebSocket(hit().replace(/^http/, "ws")); },
        eventsource: () => { new EventSource(hit()); },
        "import-scripts": () => importScripts(hit()),
        "import-dynamic": () => import(hit()).catch(() => {}),
        "nested-worker": () => { new Worker(hit()); },
        "font-face": () => { const f = new FontFace("X", `url(${hit()})`); self.fonts.add(f); return f.load().catch(() => {}); },
        webtransport: () => { try { new WebTransport(hit().replace(/^http/, "https")); } catch { } },
    };
    const has = ["RTCPeerConnection", "document", "top", "parent", "open", "location"].filter((k) => k in self && (k !== "location" || typeof self.location.assign === "function"));
    let error = null;
    try { const p = routes[r](); if (p && p.catch) p.catch((e) => postMessage({ error: String(e) })); } catch (e) { error = String(e); }
    postMessage({ ran: true, has, error });
}
/** Start `workerMain` for `route` in a blob worker and relay what it says to the embedder. */
function inWorker(route) {
    const src = `(${workerMain})(${JSON.stringify(route)}, ${JSON.stringify(H)})`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    w.onmessage = (e) => say(e.data);
    w.onerror = (e) => say({ error: "worker: " + (e.message || "failed to start") });
}

/** Start the evaluator (`self.__EVAL_SRC`, eval-worker.ts bundled by the spec) in a blob worker, and pass each
 *  script the embedder posts to it and each answer back. */
function startEvaluator() {
    const t = performance.now();
    const w = new Worker(URL.createObjectURL(new Blob([self.__EVAL_SRC], { type: "text/javascript" })));
    w.onmessage = (e) => say(e.data.ready ? { ready: true, startMs: performance.now() - t } : { answer: e.data });
    w.onerror = (e) => say({ error: "worker: " + (e.message || "failed to start") });
    addEventListener("message", (e) => { if (e.source === parent && e.data && e.data.code !== undefined) w.postMessage(e.data); });
}

/** Report to the embedder that the probe ran (or why it threw); the route itself is judged by the server's count. */
const say = (m) => parent.postMessage({ probe: P, ...m }, "*");
try {
    if (P === "top-post") top.postMessage({ leak: "artifact-secret" }, "*");
    else if (P === "eval") startEvaluator();
    else if (P.startsWith("w-")) inWorker(P.slice(2));
    else if (!PROBES[P]) throw new Error("no such probe");
    else { say({ ran: true }); Promise.resolve(PROBES[P]()).catch((e) => say({ error: String(e) })); }
} catch (e) { say({ error: String(e) }); }
