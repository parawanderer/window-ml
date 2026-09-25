// sw.js — THE HOSTED CLIENT'S SERVICE WORKER: it holds the app's own files, so the page opens without the network and
// an installed copy keeps working on a train. It is the template; `buildApp` (scripts/build-web.mjs) stamps the two
// placeholders with the built file list and a version derived from their contents, and writes the result beside them.
//
// It caches THIS APP and nothing else. Everything a session is made of arrives over the hub's WebSocket, which a
// service worker never sees, and the keys and the transcripts live in the client's own storage — so there is no
// version of this file that can serve a stale session, only a stale app, which the version below replaces on the
// first load after a deploy.

const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const CACHE = `wml-app-${VERSION}`;

// A new version takes over AT ONCE rather than waiting for every tab to close. The app is one bundle with no
// half-updated state to protect, and the alternative is a phone that has had the old copy for weeks because its tab
// was never closed.
self.addEventListener("install", (e) => {
    e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
    e.waitUntil((async () => {
        for (const key of await caches.keys()) if (key !== CACHE) await caches.delete(key);
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (e) => {
    const req = e.request;
    if (req.method !== "GET") return;
    let url;
    try { url = new URL(req.url); } catch { return; }
    // Another origin is none of this worker's business: the hub, an image a page sent, anything the client fetches.
    if (url.origin !== self.location.origin) return;
    // …EXCEPT the agent start page, which is a REAL page at a real path and the one thing here a run navigates to.
    // The fallback below would hand it the client instead, so a run that asked for an empty tab would land in the
    // chat app — and only for people who had opened this app before, which is the worst way to find a bug. It is
    // precached like the rest, so an installed copy still has it with no network.
    if (url.pathname.endsWith("/agent-start.html")) { e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit ?? fetch(req))); return; }
    // EVERY OTHER navigation is answered with the app's page, whatever path it names. The client is a single page
    // whose addresses are hashes, so a deep link that arrives as a path (a host that rewrote it, a shortcut) has
    // nothing else here to be served, and a 404 from the network would be the wrong answer while the app is cached.
    if (req.mode === "navigate") { e.respondWith(shell()); return; }
    e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit ?? fetch(req)));
});

/** The app's page out of the cache, or from the network the first time, before this worker has one. */
async function shell() {
    const c = await caches.open(CACHE);
    return (await c.match("index.html", { ignoreSearch: true })) ?? fetch("index.html");
}
