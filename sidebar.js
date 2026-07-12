// Debug sidebar — isolated content-script world. An opt-in, slide-out panel that
// logs every window.ml call on the page. It can't read the main-world `ml` state
// directly, so injected.js pushes a one-way event stream over window.postMessage
// ({ __mlDebug: event }); this script subscribes and renders it.
//
// Wrapped in an IIFE because content scripts in one manifest entry share an
// isolated-world scope with content.js — top-level consts would collide.
(function () {
    "use strict";

    const STORE_KEY = "ml_debug_saved";   // chrome.storage.local array of saved entries
    const WIDTH_KEY = "ml_debug_width";   // chrome.storage.local persisted panel width
    const SAVED_CAP = 200;
    const MIN_W = 280, TAB_W = 34;        // min panel width; tab strip width (see .tab)

    let root = null;        // shadow root
    let host = null;        // host element on the page
    let logEl = null;       // scrollable log column
    let panel = null;       // the sliding wrap
    const cards = new Map();  // debug id -> { card, bodyEl }

    // --- theme: light/dark/auto → data-theme on the host, keying the CSS vars ---
    const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    let themePref = "auto";
    const resolveTheme = () =>
        (themePref === "light" || themePref === "dark") ? themePref : (themeMedia.matches ? "dark" : "light");
    const applyTheme = () => { if (host) host.setAttribute("data-theme", resolveTheme()); };
    themeMedia.addEventListener("change", applyTheme);   // re-resolve when OS flips (auto)

    // --- tiny DOM helpers (no deps) ---
    const el = (tag, props = {}, ...kids) => {
        const n = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
            if (k === "class") n.className = v;
            else if (k === "text") n.textContent = v;
            else if (k === "html") n.innerHTML = v;
            else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
            else if (v != null) n.setAttribute(k, v);
        }
        for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
        return n;
    };
    const pretty = (v, max = 4000) => {
        let s;
        try { s = typeof v === "string" ? v : JSON.stringify(v, null, 2); } catch { s = String(v); }
        return s.length > max ? s.slice(0, max) + `\n… (${s.length - max} more chars)` : s;
    };
    const timeStr = (ts) => new Date(ts || Date.now()).toLocaleTimeString();

    // Fetch our own extension resources (allowed from a content script for
    // web_accessible_resources) and inject them INLINE into the shadow root, so
    // the page's CSP for external resources never applies. Static shell lives in
    // sidebar.html, styles in sidebar.css — only dynamic entries are built in JS.
    const loadAsset = (file) => fetch(chrome.runtime.getURL(file)).then(r => r.text());

    async function mount() {
        if (host) return;
        host = document.createElement("div");
        host.id = "ml-debug-sidebar-host";
        host.style.cssText = "all: initial;";   // keep the host out of page layout
        applyTheme();                            // data-theme drives the shadow CSS vars
        root = host.attachShadow({ mode: "open" });

        let css = "", html = "";
        try { [css, html] = await Promise.all([loadAsset("sidebar.css"), loadAsset("sidebar.html")]); }
        catch (e) { console.error("ml debug sidebar: failed to load assets", e); host = root = null; return; }
        if (!host) return;   // unmounted while loading
        root.innerHTML = `<style>${css}</style>${html}`;

        panel = root.getElementById("wrap");
        logEl = root.getElementById("log");
        root.getElementById("tab").addEventListener("click", () => panel.classList.toggle("open"));
        root.getElementById("clear").addEventListener("click", clearLog);
        wireResize(root.getElementById("resize"));
        (document.documentElement || document.body).append(host);

        window.addEventListener("message", onMessage);
        loadSaved();
        // Handshake: tell injected.js (main world) to start emitting.
        window.postMessage({ __mlSidebar: "ready" }, "*");
    }

    // Drag-to-resize (Claude-Code style). The panel is fixed to the right edge, so
    // its width is just (viewport right − cursor), plus the tab strip. Persist it.
    const applyWidth = (w) => { if (panel) panel.style.width = Math.round(w) + "px"; };
    function wireResize(handle) {
        chrome.storage.local.get({ [WIDTH_KEY]: 0 }, (d) => { if (d[WIDTH_KEY]) applyWidth(d[WIDTH_KEY]); });
        handle.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            handle.classList.add("dragging");
            handle.setPointerCapture(e.pointerId);
            const onMove = (ev) => {
                const w = Math.max(MIN_W, Math.min(window.innerWidth * 0.95, window.innerWidth - ev.clientX + TAB_W));
                applyWidth(w);
            };
            const onUp = () => {
                handle.classList.remove("dragging");
                handle.removeEventListener("pointermove", onMove);
                handle.removeEventListener("pointerup", onUp);
                const w = parseInt(panel.style.width, 10);
                if (w) chrome.storage.local.set({ [WIDTH_KEY]: w });
            };
            handle.addEventListener("pointermove", onMove);
            handle.addEventListener("pointerup", onUp);
        });
    }

    function unmount() {
        if (!host) return;
        window.removeEventListener("message", onMessage);
        host.remove();
        host = root = logEl = panel = null;
        cards.clear();
    }

    function ensureEmptyCleared() {
        const empty = logEl.querySelector(".empty");
        if (empty) empty.remove();
    }

    function clearLog() {
        cards.clear();
        logEl.replaceChildren(el("div", { class: "empty", text: "Cleared. New ml calls will appear here." }));
    }

    // --- rendering ---
    function detail(summaryText, contentNode) {
        return el("details", {}, el("summary", { text: summaryText }), contentNode);
    }

    function buildCard(ev) {
        const req = ev.request || {};
        const sys = (req.messages || []).find(m => m.role === "system");
        const convo = (req.messages || []).filter(m => m.role !== "system");

        const dot = el("span", { class: "dot pending", title: "in flight" });
        const card = el("div", { class: "card" },
            el("div", { class: "crow" },
                dot,
                el("span", { class: "kind", text: ev.streaming ? "chat ›stream" : "chat" }),
                el("span", { class: "model", title: req.model || "default", text: req.model || "default" }),
                el("span", { class: "sp" }),
                el("span", { class: `tag ${ev.save ? "saved" : "session"}`, text: ev.save ? "saved" : "session" }),
                el("span", { class: "time", text: timeStr(ev.ts) })
            )
        );
        // Flags line (schema / toolIds / think / maxTokens) when set.
        const flags = [];
        if (req.schema) flags.push("schema");
        if (req.toolIds && req.toolIds.length) flags.push(`toolIds: ${req.toolIds.join(", ")}`);
        if (req.think === true || req.think === false) flags.push(`think: ${req.think}`);
        if (req.maxTokens != null) flags.push(`maxTokens: ${req.maxTokens}`);
        if (flags.length) card.append(detail("options", el("pre", { text: flags.join("\n") })));

        if (sys) card.append(detail("system prompt", el("pre", { text: pretty(sys.content) })));
        card.append(detail(`messages (${convo.length})`, el("pre", {
            text: convo.map(m => `[${m.role}] ${typeof m.content === "string" ? m.content : pretty(m.content)}`).join("\n\n")
        })));
        if (req.images && req.images.length) {
            const thumbs = el("div", { class: "thumbs" });
            for (const src of req.images) thumbs.append(el("img", { src }));
            card.append(detail(`images (${req.images.length})`, thumbs));
        }
        const bodyEl = el("div");   // response/error filled in on settle
        card.append(bodyEl);
        return { card, bodyEl, dot };
    }

    function settleCard(entry, ev) {
        if (!entry) return;
        entry.dot.className = `dot ${ev.kind === "chat-error" ? "err" : "ok"}`;
        entry.dot.title = ev.kind === "chat-error" ? "error" : "done";
        if (ev.kind === "chat-error") {
            entry.card.classList.add("err");
            entry.bodyEl.append(detail("error", el("pre", { text: ev.error || "(unknown error)" })));
        } else {
            const d = detail(ev.structured ? "response (structured)" : "response", el("pre", { text: pretty(ev.content) }));
            d.open = true;
            entry.bodyEl.append(d);
            if (ev.sources && ev.sources.length) entry.bodyEl.append(detail(`sources (${ev.sources.length})`, el("pre", { text: pretty(ev.sources) })));
        }
    }

    function onMessage(e) {
        if (e.source !== window || !e.data || !e.data.__mlDebug) return;
        const ev = e.data.__mlDebug;
        if (ev.kind === "chat") {
            ensureEmptyCleared();
            const entry = buildCard(ev);
            cards.set(ev.id, entry);
            logEl.append(entry.card);
            logEl.scrollTop = logEl.scrollHeight;
        } else if (ev.kind === "chat-result" || ev.kind === "chat-error") {
            const entry = cards.get(ev.id);
            settleCard(entry, ev);
            if (ev.save && ev.kind === "chat-result") persistSaved(ev);
            logEl.scrollTop = logEl.scrollHeight;
        }
    }

    // --- persistence (saved entries survive reloads) ---
    // Phase 1 stores the reply text of save:true calls; the fuller request context
    // (messages/media) rides the live entry and can be added to the store later.
    function persistSaved(resultEv) {
        chrome.storage.local.get({ [STORE_KEY]: [] }, (data) => {
            const arr = data[STORE_KEY] || [];
            arr.push({ id: resultEv.id, ts: resultEv.ts, content: resultEv.content, sources: resultEv.sources || null });
            while (arr.length > SAVED_CAP) arr.shift();
            chrome.storage.local.set({ [STORE_KEY]: arr });
        });
    }

    function loadSaved() {
        chrome.storage.local.get({ [STORE_KEY]: [] }, (data) => {
            const arr = data[STORE_KEY] || [];
            if (!arr.length || !logEl) return;
            ensureEmptyCleared();
            for (const s of arr) {
                const card = el("div", { class: "card" },
                    el("div", { class: "crow" },
                        el("span", { class: "dot ok", title: "saved (previous session)" }),
                        el("span", { class: "kind", text: "chat" }),
                        el("span", { class: "sp" }),
                        el("span", { class: "tag saved", text: "saved" }),
                        el("span", { class: "time", text: timeStr(s.ts) })
                    ),
                    detail("response", el("pre", { text: pretty(s.content) }))
                );
                logEl.prepend(card);
            }
        });
    }

    // --- config gate + live toggle ---
    chrome.storage.sync.get({ sidebar: false, theme: "auto" }, (cfg) => {
        themePref = cfg.theme || "auto";
        if (cfg.sidebar) mount();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        if (changes.theme) { themePref = changes.theme.newValue || "auto"; applyTheme(); }
        if (changes.sidebar) { if (changes.sidebar.newValue) mount(); else unmount(); }
    });
})();
