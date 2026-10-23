// probe.js — the main-world watcher of tests/e2e/fixtures/detect/server.mjs: what a page's own script can observe
// about something else acting in it (tests/e2e/detection-surface.spec.mjs, docs/dev/detection-surface.md).
//
// It is the page's FIRST script, so it is installed before any tool runs; it cannot be installed before the extension's
// document_start content script, which runs before every page script. Each check records CHANGES only, with a
// timestamp, and the batch is POSTed to /log, so the spec reads it without attaching anything to the page (attaching a
// debugger client to read it would itself trip the CDP checks). Plain ES2020, no imports.
(() => {
    "use strict";
    const T0 = Date.now();
    const pid = Math.random().toString(36).slice(2, 10);
    const entries = [];
    const rec = (kind, data) => { entries.push({ t: Date.now(), kind, ...data }); };
    // Native references taken before anyone can swap them.
    const nativeLog = console.log, nativeDebug = console.debug, fnToString = Function.prototype.toString;
    const isNative = (f) => { try { return /\{\s*\[native code\]\s*\}\s*$/.test(fnToString.call(f)); } catch { return null; } };
    const OWN = /\/probe\.js/;
    const short = (s, n = 400) => String(s).slice(0, n);
    /** The frames of a stack that are not this probe's, as their URLs. */
    const foreignFrames = (stack) => String(stack || "").split("\n").slice(1).map((l) => l.trim()).filter((l) => l && !OWN.test(l));

    // --- the environment at load: automation and headless markers ---
    const env = () => {
        const n = navigator;
        const keys = Object.getOwnPropertyNames(window);
        let webgl = null;
        try {
            const gl = document.createElement("canvas").getContext("webgl");
            const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
            webgl = ext ? { vendor: gl.getParameter(ext.UNMASKED_VENDOR_WEBGL), renderer: gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) } : null;
        } catch { /* none */ }
        rec("env", {
            webdriver: n.webdriver, ua: n.userAgent, uaBrands: n.userAgentData ? n.userAgentData.brands.map((b) => b.brand) : null,
            platform: n.platform, plugins: n.plugins.length, mimeTypes: n.mimeTypes.length, languages: n.languages,
            hasChrome: typeof window.chrome, chromeKeys: window.chrome ? Object.keys(window.chrome) : [], hasRuntime: !!(window.chrome && window.chrome.runtime),
            notification: typeof Notification !== "undefined" ? Notification.permission : null,
            automationGlobals: keys.filter((k) => /^\$?cdc_|^__(webdriver|selenium|playwright|pw|puppeteer|nightmare)|^_phantom|^callPhantom|^domAutomation/i.test(k)),
            outer: [window.outerWidth, window.outerHeight], inner: [window.innerWidth, window.innerHeight], screen: [screen.width, screen.height, screen.availWidth, screen.availHeight],
            screenXY: [window.screenX, window.screenY], dpr: window.devicePixelRatio, tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
            hardwareConcurrency: n.hardwareConcurrency, webgl,
            mlClosedRoots: "__mlClosedRoots" in window,
            // The ask that replaced that global: shadow-patch.js answers it with a reader (docs/dev/detection-surface.md, row 2).
            closedRootReader: (() => { const d = {}; try { window.dispatchEvent(new CustomEvent("wml-closed-roots", { detail: d })); } catch { /* none */ } return typeof d.read === "function"; })(),
            attachShadowNative: isNative(Element.prototype.attachShadow),
            attachShadowSrc: short(fnToString.call(Element.prototype.attachShadow), 120), attachShadowName: Element.prototype.attachShadow.name,
            mlAtLoad: "ml" in window, globalsAtLoad: keys.length,
            navType: (performance.getEntriesByType("navigation")[0] || {}).type || null, referrer: document.referrer, historyLength: history.length,
        });
        if (n.permissions) n.permissions.query({ name: "notifications" }).then((p) => rec("env-perm", { notificationsQuery: p.state }), () => {});
    };

    // --- watched values: recorded each time they change ---
    const last = new Map();
    const watch = (name, fn) => { let v; try { v = fn(); } catch (e) { v = "throws: " + e.message; } const s = JSON.stringify(v); if (last.get(name) !== s) { last.set(name, s); rec("state", { name, value: v }); } };
    const initialGlobals = new Set(Object.getOwnPropertyNames(window));
    let rafCount = 0, rafWindowStart = performance.now();
    const raf = () => { rafCount++; requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    const savedConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const tick = () => {
        watch("globalsAdded", () => Object.getOwnPropertyNames(window).filter((k) => !initialGlobals.has(k) && !/^__probe|^\d+$/.test(k)).sort());
        watch("mlCdpStream", () => Object.getOwnPropertyNames(window).some((k) => k.startsWith("__mlCdpStream")));
        watch("mlIsoStream", () => "__mlIsoStream" in window);
        watch("windowMl", () => ("ml" in window ? Object.keys(window.ml || {}).length : "absent"));
        watch("consoleSwapped", () => Object.keys(savedConsole).filter((m) => console[m] !== savedConsole[m]));
        watch("consoleNative", () => Object.keys(savedConsole).filter((m) => !isNative(console[m])));
        watch("attachShadowNative", () => isNative(Element.prototype.attachShadow));
        watch("fnToStringNative", () => Function.prototype.toString === fnToString);
        watch("webdriver", () => navigator.webdriver);
        watch("hasFocus", () => document.hasFocus());
        watch("visibility", () => document.visibilityState);
        watch("inner", () => [window.innerWidth, window.innerHeight]);
        watch("outer", () => [window.outerWidth, window.outerHeight]);
        const now = performance.now();
        if (now - rafWindowStart >= 1000) {
            const hz = Math.round(rafCount * 1000 / (now - rafWindowStart));
            watch("rafHz", () => (hz >= 40 ? "≥40" : hz >= 5 ? "5-39" : hz >= 1 ? "1-4" : "0"));
            rafCount = 0; rafWindowStart = now;
        }
    };

    // --- the Runtime.enable tell: a getter read only when a debugger client serialises a console argument ---
    // Four shapes. The classic one (a getter on an Error's `stack`) no longer fires in current Chromium; a getter on
    // its `message` or `name`, and an own `toString` on a logged function, still do (measured, 2026-10, Chromium 151).
    const variants = {
        errStack: (hit) => { const e = new Error("p"); Object.defineProperty(e, "stack", { configurable: true, get() { hit(); return "p"; } }); return e; },
        errMessage: (hit) => { const e = new Error("p"); Object.defineProperty(e, "message", { configurable: true, get() { hit(); return "p"; } }); return e; },
        errName: (hit) => { const e = new Error("p"); Object.defineProperty(e, "name", { configurable: true, get() { hit(); return "Error"; } }); return e; },
        fnToString: (hit) => { const f = function probe() {}; Object.defineProperty(f, "toString", { value() { hit(); return "function probe() {}"; } }); return f; },
    };
    const consoleProbe = () => {
        const fired = [];
        for (const [name, make] of Object.entries(variants)) {
            let n = 0;
            const arg = make(() => { n++; });
            try { nativeDebug.call(console, arg); } catch { /* none */ }
            if (n) fired.push(name);
        }
        watch("cdpConsoleGetter", () => fired);
    };

    // --- events: every input-shaped event, in the capture phase, with what tells a person from a script ---
    const EVENTS = ["pointermove", "pointerdown", "pointerup", "mousemove", "mousedown", "mouseup", "click", "keydown", "keypress", "keyup", "beforeinput", "input", "change", "focus", "blur", "focusin", "focusout", "resize", "visibilitychange", "freeze", "resume", "pageshow", "pagehide", "scroll", "wheel"];
    let moves = 0;
    const onEvent = (ev) => {
        if (ev.type === "pointermove" || ev.type === "mousemove") { moves++; if (moves > 20) return; }
        const ua = navigator.userActivation;
        const d = { type: ev.type, isTrusted: ev.isTrusted, target: ev.target && (ev.target.id || ev.target.nodeName || (ev.target === window ? "window" : "?")),
            activation: ua ? [ua.isActive, ua.hasBeenActive] : null };
        if ("clientX" in ev) Object.assign(d, { clientXY: [ev.clientX, ev.clientY], screenXY: [ev.screenX, ev.screenY], movement: [ev.movementX, ev.movementY], detail: ev.detail, buttons: ev.buttons });
        if ("pointerType" in ev) Object.assign(d, { pointerType: ev.pointerType, pressure: ev.pressure, size: [ev.width, ev.height], pointerId: ev.pointerId, isPrimary: ev.isPrimary });
        if ("key" in ev) Object.assign(d, { key: ev.key, code: ev.code, keyCode: ev.keyCode });
        if ("inputType" in ev) Object.assign(d, { inputType: ev.inputType, data: ev.data });
        if (ev.type === "resize") Object.assign(d, { inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight] });
        if (ev.type === "click" || ev.type === "keydown" || ev.type === "input") { const f = foreignFrames(new Error().stack); if (f.length) d.stack = f.slice(0, 6); }
        if (ev.target && ev.target.getBoundingClientRect && "clientX" in ev && ev.type === "click") {
            const r = ev.target.getBoundingClientRect();
            d.offsetFromCentre = [Math.round(ev.clientX - (r.left + r.width / 2)), Math.round(ev.clientY - (r.top + r.height / 2))];
        }
        rec("event", d);
    };
    for (const t of EVENTS) window.addEventListener(t, onEvent, { capture: true, passive: true });
    document.addEventListener("visibilitychange", onEvent, { capture: true });
    document.addEventListener("freeze", onEvent, { capture: true });
    document.addEventListener("resume", onEvent, { capture: true });

    // --- the DOM: what is added, removed or changed, and by whom ---
    const describe = (n) => n.nodeType === 1 ? { tag: n.tagName.toLowerCase(), id: n.id || undefined, src: n.getAttribute("src") || undefined, attrs: Array.from(n.attributes).map((a) => a.name).filter((a) => a !== "id" && a !== "src").slice(0, 8), shadowOpen: !!n.shadowRoot } : { node: n.nodeName };
    new MutationObserver((list) => {
        for (const m of list) {
            if (m.type === "childList") {
                for (const n of m.addedNodes) if (n.nodeType === 1) { rec("dom-add", { parent: m.target.nodeName.toLowerCase(), ...describe(n) }); learn(n.getAttribute("src") || "", "dom"); }
                for (const n of m.removedNodes) if (n.nodeType === 1) rec("dom-remove", { parent: m.target.nodeName.toLowerCase(), ...describe(n) });
            } else if (m.type === "attributes") {
                rec("dom-attr", { target: m.target.id || m.target.nodeName.toLowerCase(), name: m.attributeName, value: short(m.target.getAttribute(m.attributeName), 120) });
            }
        }
    }).observe(document, { subtree: true, childList: true, attributes: true });

    // --- window messages: what the page's window is told ---
    window.addEventListener("message", (ev) => {
        const t = ev.data && typeof ev.data === "object" ? (ev.data.type || Object.keys(ev.data).slice(0, 5).join(",")) : typeof ev.data;
        rec("message", { type: short(t, 80), fromSelf: ev.source === window, origin: ev.origin, keys: ev.data && typeof ev.data === "object" ? Object.keys(ev.data).slice(0, 12) : [] });
    }, true);
    // The positive control for the list above: the probe posts itself a ping every half second, so an empty list of
    // messages means the window carried nothing, not that this listener never ran. summarize() keeps the pings apart.
    let pings = 0;
    const ping = () => { window.postMessage({ type: "__probePing", n: ++pings }, "*"); };
    // The two events the extension's page script dispatches on window by name: the port hand-off (page-channel.ts) and
    // `ml:ready`. On a page whose script runs at document_start both fire before this probe exists; on a page given
    // the script later (a run on a hidden page) a page listener sees them, which is detection-surface.md row 6's residual.
    for (const t of ["ml-page-port", "ml:ready"]) window.addEventListener(t, (ev) => rec("page-event", { type: t, ports: ev.ports ? ev.ports.length : 0 }), true);

    // --- resources: anything loaded from an extension, and the extension ids a page could learn ---
    const extIds = new Set();
    const learnedHow = new Set();
    const learn = (text, how) => {
        for (const m of String(text).matchAll(/chrome-extension:\/\/([a-p]{32})/g)) {
            if (!learnedHow.has(m[1] + how)) { learnedHow.add(m[1] + how); rec("ext-id", { id: m[1], how }); }
            if (!extIds.has(m[1])) { extIds.add(m[1]); probeExt(m[1]); }
        }
    };
    try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!/^https?:/.test(e.name)) { rec("resource", { name: short(e.name, 160), initiator: e.initiatorType }); learn(e.name, "resource-timing"); } }).observe({ type: "resource", buffered: true });
    } catch { /* none */ }
    /** Fetch a web-accessible file of the extension `id` (and a made-up id, for the timing): what a site does once it knows an id. */
    const probeExt = async (id) => {
        const one = async (eid, file) => { const t = performance.now(); try { const r = await fetch(`chrome-extension://${eid}/${file}`); const body = await r.text(); return { status: r.status, bytes: body.length, ms: Math.round(performance.now() - t) }; } catch (e) { return { error: short(e.message, 80), ms: Math.round(performance.now() - t) }; } };
        rec("ext-probe", { id, injected: await one(id, "injected.js"), sidebar: await one(id, "sidebar.html"), manifest: await one(id, "manifest.json"), bogus: await one("abcdefghijklmnopabcdefghijklmnop", "injected.js") });
    };

    // --- stacks: who calls the builtins a tool in the main world calls ---
    const seenStacks = new Set();
    const wrap = (obj, name, label) => {
        const orig = obj[name];
        if (typeof orig !== "function") return;
        Object.defineProperty(obj, name, { configurable: true, writable: true, value: function (...a) {
            const f = foreignFrames(new Error().stack);
            if (f.length) { const key = label + f.join("|"); if (!seenStacks.has(key) && seenStacks.size < 60) { seenStacks.add(key); rec("caller-stack", { fn: label, frames: f.slice(0, 6) }); learn(f.join("\n"), "stack:" + label); } }
            return orig.apply(this, a);
        } });
    };
    wrap(Document.prototype, "querySelectorAll", "document.querySelectorAll");
    wrap(Document.prototype, "querySelector", "document.querySelector");
    wrap(Element.prototype, "querySelectorAll", "element.querySelectorAll");
    wrap(Element.prototype, "getBoundingClientRect", "getBoundingClientRect");
    wrap(Document.prototype, "elementFromPoint", "elementFromPoint");
    wrap(EventTarget.prototype, "dispatchEvent", "dispatchEvent");
    wrap(HTMLElement.prototype, "focus", "focus");

    // A page function an exec may call: it records who called it, and the stack of an error thrown back through it.
    window.pageCall = (fn) => {
        rec("pagecall", { caller: foreignFrames(new Error().stack).slice(0, 6) });
        try { return fn(); } catch (e) { rec("pagecall-caught", { message: short(e.message, 80), stack: String(e.stack || "").split("\n").slice(0, 8) }); learn(e.stack, "caught-error"); return "caught"; }
    };
    // The page's own console output, so it is visible whether an exec collected it.
    window.__probeSays = (s) => console.log("page says " + s);

    // --- the sealed shadow host and the canvas: their events are retargeted/visible here ---
    const hook = () => {
        const s = document.getElementById("sealed");
        if (s) for (const t of ["click", "pointerdown"]) s.addEventListener(t, (ev) => rec("sealed-event", { type: ev.type, isTrusted: ev.isTrusted, clientXY: [ev.clientX, ev.clientY], screenXY: [ev.screenX, ev.screenY] }));
    };

    // --- reporting: flush new entries to the server ---
    let sent = 0;
    const flush = () => {
        if (sent >= entries.length) return;
        const batch = entries.slice(sent);
        sent = entries.length;
        try { fetch("/log", { method: "POST", body: JSON.stringify({ pid, href: location.href, entries: batch }), keepalive: true }).catch(() => {}); } catch { /* none */ }
    };
    window.__probeReport = () => entries.slice();

    // --- page-started window.ml calls, asked for by the query string (the spec has no handle on the page) ---
    const act = new URLSearchParams(location.search).get("do");
    const api = `${location.protocol}//api.test:${location.port}`;
    if (act === "mlfetch" || act === "pagefetch") {
        (async () => {
            if (act === "mlfetch") {
                for (let i = 0; i < 100 && !(window.ml && window.ml.ready); i++) await new Promise((r) => setTimeout(r, 100));
                const tryIt = async (name, f) => { try { const v = await f(); rec("do", { name, ok: short(typeof v === "string" ? v : JSON.stringify(v), 160) }); } catch (e) { rec("do", { name, error: short((e && (e.message || e)) || String(e), 160) }); } };
                await tryIt("ml.fetch", () => window.ml.fetch(api + "/echo?via=ml.fetch"));
                await tryIt("ml._fetchImageBase64", () => window.ml._fetchImageBase64(api + "/img.png?via=b64"));
                // Not an image: an HTML page of another origin that says whether the request carried that origin's cookie.
                await tryIt("ml._fetchImageBase64 html", async () => { const d = await window.ml._fetchImageBase64(api + "/echo?via=b64html"); return atob(String(d).split(",")[1] || ""); });
            } else {
                const r = await fetch(api + "/echo?via=page-fetch", { credentials: "include", mode: "no-cors" }).then((x) => x.type, (e) => e.message);
                rec("do", { name: "page fetch", ok: r });
            }
            rec("do-done", {});
        })();
    }

    rec("start", { at: T0, top: window === window.top });
    env();
    tick();
    let ticks = 0;
    setInterval(() => { tick(); consoleProbe(); if (ticks++ % 5 === 0) ping(); flush(); }, 100);
    document.addEventListener("DOMContentLoaded", () => { hook(); rec("ready", {}); flush(); });
    window.addEventListener("pagehide", flush);
})();
