// ==UserScript==
// @name         YouTube AI Summarizer (window.ml)
// @namespace    window-ml
// @description  Summarize the current YouTube video and ask follow-ups, in-page,
//               using the window.ml extension + an OpenWebUI server-side transcript tool.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

// This is a *page-context* userscript (Tampermonkey / "User JavaScript and CSS"
// with @grant none). It runs in the page's main world, so it can call window.ml
// directly — see the "Using from a userscript" section of the README.
//
// It relies on:
//   1. the window.ml extension being active on this page (Site access), and
//   2. an OpenWebUI backend that has the YouTube transcript tool registered.
//
// The whole loop lives here; window.ml stays a primitive.

(function () {
    "use strict";

    // Only run in the top document. YouTube embeds sandboxed about:blank iframes
    // (ads, utility frames); we have no business running there, and the whole UI
    // is top-frame only. (Note: a *sandboxed* frame blocks injection before this
    // line even runs — those console errors come from the injector, not us.)
    if (window.top !== window.self) return;

    // ---- Config -------------------------------------------------------------

    const DEFAULT_MODEL = "qwen3:32b";
    const TRANSCRIPT_TOOL_ID = "youtube_transcript_provider_update_2_12_2025";
    // The transcript tool's *function* name (what the model calls), distinct
    // from the tool id above (what enables the tool server-side).
    const TRANSCRIPT_FN = "get_youtube_transcript";

    // Currently-selected model — starts at DEFAULT_MODEL, changeable via the
    // header dropdown once ml.models() has loaded. availableModels/mlRef back
    // the picker (see the Model picker section).
    let selectedModel = DEFAULT_MODEL;
    let availableModels = [];
    let mlRef = null;

    // Where to drop the panel, most-preferred first. All are stable watch-page
    // anchors; if none appear we fall back to a floating card (see mount()).
    const ANCHORS = ["#secondary-inner", "#secondary", "#below"];

    // ---- window.ml handle ---------------------------------------------------

    // Resolve window.ml, tolerating the race where this script loads before the
    // extension injects. Re-checked each call so a later injection still works.
    function getMl() {
        if (window.ml && window.ml.ready) return window.ml.ready;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                window.removeEventListener("ml:ready", onReady);
                reject(new Error(
                    "window.ml not detected. Click the window.ml extension icon " +
                    "to enable it on this page, then try again."
                ));
            }, 8000);
            function onReady() {
                clearTimeout(timer);
                resolve(window.ml);
            }
            window.addEventListener("ml:ready", onReady, { once: true });
        });
    }

    // ---- Per-video state ----------------------------------------------------

    let chat = null;          // ml.createChat() instance for the current video
    let currentVideoId = null;
    let busy = false;

    function watchId() {
        if (location.pathname !== "/watch") return null;
        return new URLSearchParams(location.search).get("v");
    }

    function videoUrl(id) {
        return "https://www.youtube.com/watch?v=" + id;
    }

    function videoTitle() {
        const el = document.querySelector("#title h1, h1.ytd-watch-metadata");
        const t = el && el.textContent.trim();
        return t || document.title.replace(/\s*-\s*YouTube\s*$/, "");
    }

    // Scrape the metadata YouTube already shows on the page (channel, subs,
    // views/date, description) so the model can answer questions "beyond the
    // transcript" — who the creator is, when it was posted, etc.
    function pageContext() {
        const pick = (sel) => {
            const el = document.querySelector(sel);
            return el ? el.textContent.trim().replace(/\s+/g, " ") : "";
        };
        const channel = pick("ytd-video-owner-renderer #channel-name a, #owner #channel-name a");
        const subs = pick("#owner-sub-count");
        const info = pick("ytd-watch-info-text, #info-container yt-formatted-string, #info.ytd-watch-metadata");
        const desc = pick("#description-inline-expander, ytd-text-inline-expander");
        const lines = [];
        if (channel) lines.push(`Channel: ${channel}${subs ? ` (${subs})` : ""}`);
        if (info) lines.push(`Views/date: ${info}`);
        if (desc) lines.push(`Description: ${desc.slice(0, 1500)}`);
        return lines.join("\n") || "(no extra page details found)";
    }

    // ---- Minimal markdown renderer (builds real DOM nodes) ------------------
    //
    // We build DOM with createElement/textContent rather than assigning
    // innerHTML: YouTube enforces Trusted Types (require-trusted-types-for
    // 'script'), so `el.innerHTML = "<string>"` *throws* in the page's main
    // world. Node construction sidesteps that entirely (and is XSS-safe for
    // free — model text only ever lands in textContent).

    // Inline spans → array of nodes: **bold**, *italic*, `code`, [text](url).
    function inlineNodes(text) {
        const re = /\*\*([^*]+)\*\*|(?:^|(?<=[^*]))\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
        const nodes = [];
        let last = 0, m;
        while ((m = re.exec(text))) {
            if (m.index > last) nodes.push(document.createTextNode(text.slice(last, m.index)));
            if (m[1] != null) { const el = document.createElement("strong"); el.textContent = m[1]; nodes.push(el); }
            else if (m[2] != null) { const el = document.createElement("em"); el.textContent = m[2]; nodes.push(el); }
            else if (m[3] != null) { const el = document.createElement("code"); el.textContent = m[3]; nodes.push(el); }
            else { const a = document.createElement("a"); a.href = m[5]; a.textContent = m[4]; a.target = "_blank"; a.rel = "noopener noreferrer"; nodes.push(a); }
            last = re.lastIndex;
        }
        if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
        return nodes;
    }

    function appendInline(parent, text) {
        for (const n of inlineNodes(text)) parent.appendChild(n);
    }

    function renderMarkdown(md) {
        const frag = document.createDocumentFragment();
        let list = null, listType = null;
        const closeList = () => { if (list) { frag.appendChild(list); list = null; listType = null; } };
        for (const line of md.split(/\r?\n/)) {
            let m;
            if (/^\s*$/.test(line)) { closeList(); continue; }
            if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) {
                closeList();
                const h = document.createElement("div"); h.className = "mlyt-h";
                appendInline(h, m[1]); frag.appendChild(h);
            } else if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
                if (listType !== "ul") { closeList(); list = document.createElement("ul"); listType = "ul"; }
                const li = document.createElement("li"); appendInline(li, m[1]); list.appendChild(li);
            } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
                if (listType !== "ol") { closeList(); list = document.createElement("ol"); listType = "ol"; }
                const li = document.createElement("li"); appendInline(li, m[1]); list.appendChild(li);
            } else {
                closeList();
                const p = document.createElement("p"); appendInline(p, line); frag.appendChild(p);
            }
        }
        closeList();
        return frag;
    }

    // ---- Styles -------------------------------------------------------------

    function injectStyles() {
        if (document.getElementById("mlyt-styles")) return;
        const css = `
        #mlyt-panel {
            font-family: "Roboto", "Arial", sans-serif;
            color: #0f0f0f;
            background: rgba(0,0,0,.05);
            border: 1px solid rgba(0,0,0,.1);
            border-radius: 12px;
            margin: 0 0 16px 0;
            overflow: hidden;
        }
        /* YouTube marks dark mode with <html dark>; its --yt-spec-* vars don't
           reliably cascade into our node, so key off that attribute instead. */
        html[dark] #mlyt-panel {
            color: #f1f1f1;
            background: rgba(255,255,255,.08);
            border-color: rgba(255,255,255,.15);
        }
        #mlyt-panel.mlyt-floating {
            position: fixed; right: 16px; bottom: 16px; width: 360px;
            max-height: 70vh; z-index: 9999; margin: 0;
            box-shadow: 0 6px 24px rgba(0,0,0,.35);
            display: flex; flex-direction: column;
        }
        #mlyt-panel .mlyt-header {
            display: flex; align-items: center; gap: 8px;
            padding: 10px 12px; cursor: pointer; user-select: none;
            font-size: 1.4rem; font-weight: 500;
        }
        #mlyt-panel .mlyt-model-select {
            margin-left: auto; max-width: 45%;
            font-size: 1.1rem; font-weight: 400; font-family: inherit;
            border-radius: 6px; padding: 2px 6px; cursor: pointer;
            border: 1px solid rgba(0,0,0,.15);
            background: #fff; color: #0f0f0f;
        }
        html[dark] #mlyt-panel .mlyt-model-select {
            border-color: rgba(255,255,255,.2);
            background: rgba(255,255,255,.12); color: #f1f1f1;
        }
        #mlyt-panel .mlyt-badge { cursor: help; font-size: 1.3rem; line-height: 1; }
        #mlyt-panel .mlyt-body { padding: 0 12px 12px; }
        #mlyt-panel.mlyt-collapsed .mlyt-body { display: none; }
        #mlyt-panel.mlyt-floating .mlyt-body { overflow-y: auto; }
        #mlyt-panel .mlyt-btn {
            appearance: none; border: none; cursor: pointer;
            background: var(--yt-spec-brand-button-background, #065fd4);
            color: #fff; border-radius: 18px; padding: 8px 16px;
            font-size: 1.3rem; font-weight: 500; font-family: inherit;
        }
        #mlyt-panel .mlyt-btn[disabled] { opacity: .5; cursor: default; }
        #mlyt-panel .mlyt-summarize { width: 100%; }
        #mlyt-panel .mlyt-thread { display: flex; flex-direction: column; gap: 10px; }
        #mlyt-panel .mlyt-msg {
            font-size: 1.3rem; line-height: 1.5; border-radius: 10px; padding: 8px 10px;
        }
        #mlyt-panel .mlyt-msg.user {
            align-self: flex-end; max-width: 90%;
            background: var(--yt-spec-brand-button-background, #065fd4); color: #fff;
        }
        #mlyt-panel .mlyt-msg.assistant { background: rgba(0,0,0,.05); }
        html[dark] #mlyt-panel .mlyt-msg.assistant { background: rgba(255,255,255,.1); }
        #mlyt-panel .mlyt-msg.error { background: rgba(220,0,0,.15); color: #d33; }
        html[dark] #mlyt-panel .mlyt-msg.error { color: #ff8a8a; }
        #mlyt-panel .mlyt-msg .mlyt-h { font-weight: 600; margin: 6px 0 2px; }
        #mlyt-panel .mlyt-msg p { margin: 4px 0; }
        #mlyt-panel .mlyt-msg ul, #mlyt-panel .mlyt-msg ol { margin: 4px 0; padding-left: 20px; }
        #mlyt-panel .mlyt-msg code {
            background: rgba(127,127,127,.2); border-radius: 4px; padding: 0 4px;
        }
        #mlyt-panel .mlyt-msg a { color: #065fd4; }
        html[dark] #mlyt-panel .mlyt-msg a { color: #3ea6ff; }
        #mlyt-panel .mlyt-thinking { opacity: .6; font-style: italic; }
        #mlyt-panel .mlyt-ask { display: flex; gap: 6px; margin-top: 10px; }
        #mlyt-panel .mlyt-ask input {
            flex: 1; min-width: 0; border-radius: 18px; padding: 8px 12px;
            font-size: 1.3rem; font-family: inherit;
            border: 1px solid rgba(0,0,0,.15);
            background: #fff; color: #0f0f0f;
        }
        html[dark] #mlyt-panel .mlyt-ask input {
            border-color: rgba(255,255,255,.2);
            background: rgba(255,255,255,.1); color: #f1f1f1;
        }
        `;
        const style = document.createElement("style");
        style.id = "mlyt-styles";
        style.textContent = css;
        document.head.appendChild(style);
    }

    // ---- Panel construction -------------------------------------------------

    let els = null; // { panel, thread, summarizeBtn, ask, input, sendBtn }

    const el = (tag, className, text) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text != null) node.textContent = text;
        return node;
    };

    function buildPanel() {
        const panel = el("div");
        panel.id = "mlyt-panel";

        const header = el("div", "mlyt-header");
        const title = el("span", null, "🤖 AI Summary");
        const modelSelect = el("select", "mlyt-model-select");
        modelSelect.title = "Model used for summaries";
        // Seed with the pinned model so the header isn't empty before models load.
        const seed = el("option", null, DEFAULT_MODEL);
        seed.value = DEFAULT_MODEL;
        modelSelect.append(seed);
        const badge = el("span", "mlyt-badge");
        badge.style.display = "none";
        const caret = el("span", "mlyt-caret", "▾");
        header.append(title, modelSelect, badge, caret);

        const thread = el("div", "mlyt-thread");
        const summarizeBtn = el("button", "mlyt-btn mlyt-summarize", "✨ Summarize this video");

        const ask = el("div", "mlyt-ask");
        ask.style.display = "none";
        const input = el("input");
        input.type = "text";
        input.placeholder = "Ask a follow-up about this video…";
        const sendBtn = el("button", "mlyt-btn mlyt-send", "Ask");
        ask.append(input, sendBtn);

        const body = el("div", "mlyt-body");
        body.append(thread, summarizeBtn, ask);
        panel.append(header, body);

        header.addEventListener("click", () => {
            panel.classList.toggle("mlyt-collapsed");
            caret.textContent = panel.classList.contains("mlyt-collapsed") ? "▸" : "▾";
        });

        els = { panel, thread, summarizeBtn, ask, input, sendBtn, modelSelect, badge };
        summarizeBtn.addEventListener("click", doSummary);
        sendBtn.addEventListener("click", doFollowUp);
        input.addEventListener("keydown", e => { if (e.key === "Enter") doFollowUp(); });

        // Don't let dropdown/badge clicks collapse the panel.
        modelSelect.addEventListener("click", e => e.stopPropagation());
        badge.addEventListener("click", e => e.stopPropagation());
        modelSelect.addEventListener("change", () => {
            selectedModel = modelSelect.value;
            chat = null;                       // new model → start a fresh chat
            updateBadge();
        });

        initModelPicker();                     // async: fill the dropdown + badge
        return panel;
    }

    // ---- Model picker -------------------------------------------------------

    function showBadge(text, tip) {
        if (!els) return;
        els.badge.textContent = text;
        els.badge.title = tip;
        els.badge.style.display = "";
    }

    function hideBadge() {
        if (els) els.badge.style.display = "none";
    }

    // Populate the dropdown from ml.models(). Keep the pinned model selectable
    // even when the server doesn't list it, so the badge can explain why.
    async function refreshModels(ml) {
        try { availableModels = await ml.models(); }
        catch { availableModels = []; }

        els.modelSelect.replaceChildren();
        if (!availableModels.includes(selectedModel)) {
            const opt = el("option", null, selectedModel + "  (unavailable)");
            opt.value = selectedModel;
            els.modelSelect.append(opt);
        }
        for (const m of availableModels) {
            const opt = el("option", null, m);
            opt.value = m;
            els.modelSelect.append(opt);
        }
        els.modelSelect.value = selectedModel;
        await updateBadge();
    }

    // Warn (with a hover tooltip) if the selected model is missing from the
    // server, or if we can positively determine it lacks tool-calling support.
    async function updateBadge() {
        if (!availableModels.includes(selectedModel)) {
            showBadge("⚠️",
                `"${selectedModel}" isn't available on your OpenWebUI server. ` +
                `Pull it in OpenWebUI, or pick a tool-capable model from this dropdown.`);
            return;
        }
        let caps = null;
        try { caps = mlRef && await mlRef.capabilities(selectedModel); }
        catch { caps = null; }
        // null = "unknown" (cloud model / old Ollama) — don't cry wolf.
        if (caps && !caps.includes("tools")) {
            showBadge("⚠️",
                `"${selectedModel}" doesn't advertise tool-calling support, so the ` +
                `transcript tool can't run. Pick a tool-capable model (e.g. a qwen3 variant).`);
        } else {
            hideBadge();
        }
    }

    async function initModelPicker() {
        try { mlRef = await getMl(); }
        catch (err) { showBadge("⚠️", String(err && err.message || err)); return; }
        await refreshModels(mlRef);
    }

    // ---- Thread rendering ---------------------------------------------------

    function addMessage(role, text, isMarkdown) {
        const div = document.createElement("div");
        div.className = "mlyt-msg " + role;
        if (isMarkdown) div.appendChild(renderMarkdown(text));
        else div.textContent = text;
        els.thread.appendChild(div);
        div.scrollIntoView({ block: "nearest" });
        return div;
    }

    // Stream a chat turn into `bubble`, rendering the accumulated text as
    // markdown live (so bullets/bold format as they arrive, not as raw `-`/`**`).
    // Re-renders are coalesced to one per animation frame to stay smooth.
    async function streamInto(bubble, prompt) {
        let started = false, pending = "", frame = 0;
        const flush = () => {
            frame = 0;
            bubble.replaceChildren(renderMarkdown(pending));
            bubble.scrollIntoView({ block: "nearest" });
        };
        const reply = await chat.chat(prompt, {
            onToken: (_delta, full) => {
                if (!started) { started = true; bubble.classList.remove("mlyt-thinking"); }
                pending = full;
                if (!frame) frame = requestAnimationFrame(flush);
            }
        });
        if (frame) cancelAnimationFrame(frame);
        bubble.classList.remove("mlyt-thinking");
        bubble.replaceChildren(renderMarkdown(reply || ""));   // final, authoritative
        return reply;
    }

    function setBusy(on) {
        busy = on;
        if (!els) return;
        els.summarizeBtn.disabled = on;
        els.sendBtn.disabled = on;
    }

    function resetForNewVideo() {
        chat = null;
        if (!els) return;
        els.thread.replaceChildren();
        els.summarizeBtn.style.display = "";
        els.ask.style.display = "none";
        els.input.value = "";
    }

    // ---- The two actions ----------------------------------------------------

    // A fixed, compact output template so summaries stay consistent and short
    // instead of sprawling into multi-paragraph write-ups.
    function summaryPrompt(id) {
        return (
            `Use the ${TRANSCRIPT_FN} tool to fetch the transcript for this video, then ` +
            `summarize it.\n\n` +
            `Title: ${videoTitle()}\n` +
            `URL: ${videoUrl(id)}\n\n` +
            `Reply in EXACTLY this format, with nothing before or after:\n\n` +
            `**TL;DR:** <one sentence, max 30 words>\n\n` +
            `**Key points:**\n` +
            `- <point, max 15 words>\n` +
            `- <point>\n` +
            `- <point>\n\n` +
            `Rules: 3–5 bullets, one line each; no sub-bullets, no preamble, ` +
            `no closing remarks, no citation markers.`
        );
    }

    async function doSummary() {
        if (busy) return;
        const id = watchId();
        if (!id) return;
        setBusy(true);
        const thinking = addMessage("assistant", "Fetching transcript & summarizing…");
        thinking.classList.add("mlyt-thinking");
        try {
            const ml = await getMl();
            mlRef = ml;
            // One chat for the whole video. toolIds stays on every turn so the
            // model can (re)pull the transcript server-side whenever it needs it.
            chat = ml.createChat({
                model: selectedModel,
                think: false,
                toolIds: [TRANSCRIPT_TOOL_ID],
                system:
                    `You are embedded in a YouTube watch page. You summarize the video from ` +
                    `its transcript and answer follow-ups. Use the ${TRANSCRIPT_FN} tool to ` +
                    `fetch the transcript and ground content questions in what was actually ` +
                    `said — never invent transcript content, never add citation markers like ` +
                    `[1], and never reply that the transcript is merely "available". For ` +
                    `questions about the video itself (creator/channel, views, upload date, ` +
                    `description), use the page details below. Keep answers tight.\n\n` +
                    `Page details:\n${pageContext()}`,
            });
            await streamInto(thinking, summaryPrompt(id));
            els.summarizeBtn.style.display = "none";
            els.ask.style.display = "flex";
            els.input.focus();
        } catch (err) {
            thinking.remove();
            addMessage("error", String(err && err.message || err));
        } finally {
            setBusy(false);
        }
    }

    async function doFollowUp() {
        if (busy || !chat) return;
        const q = els.input.value.trim();
        if (!q) return;
        els.input.value = "";
        addMessage("user", q);
        setBusy(true);
        const thinking = addMessage("assistant", "Thinking…");
        thinking.classList.add("mlyt-thinking");
        try {
            await streamInto(thinking, q);
        } catch (err) {
            thinking.remove();
            addMessage("error", String(err && err.message || err));
        } finally {
            setBusy(false);
            els.input.focus();
        }
    }

    // ---- Mounting + SPA navigation ------------------------------------------

    function findAnchor() {
        for (const sel of ANCHORS) {
            const el = document.querySelector(sel);
            if (el) return el;
        }
        return null;
    }

    // Wait for a watch-page anchor to render (YouTube fills the DOM lazily).
    function waitForAnchor(timeout = 15000) {
        const now = findAnchor();
        if (now) return Promise.resolve(now);
        return new Promise(resolve => {
            const obs = new MutationObserver(() => {
                const el = findAnchor();
                if (el) { obs.disconnect(); resolve(el); }
            });
            obs.observe(document.documentElement, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); resolve(findAnchor()); }, timeout);
        });
    }

    let mountToken = 0;
    async function mount() {
        const id = watchId();
        const panel = document.getElementById("mlyt-panel") || (els && els.panel) || buildPanel();

        if (!id) { panel.remove(); return; }          // left the watch page

        const token = ++mountToken;                    // guard against navigation races
        const anchor = await waitForAnchor();
        if (token !== mountToken || watchId() !== id) return;

        if (anchor) {
            panel.classList.remove("mlyt-floating");
            if (panel.parentElement !== anchor || anchor.firstChild !== panel) {
                anchor.prepend(panel);
            }
        } else {
            panel.classList.add("mlyt-floating");
            if (panel.parentElement !== document.body) document.body.appendChild(panel);
        }

        if (id !== currentVideoId) { currentVideoId = id; resetForNewVideo(); }
    }

    // Debounce: YouTube can fire several navigation events in a burst.
    let mountTimer = null;
    function scheduleMount() {
        clearTimeout(mountTimer);
        mountTimer = setTimeout(mount, 150);
    }

    injectStyles();
    // yt-navigate-finish fires on SPA route changes; the others cover first paint.
    window.addEventListener("yt-navigate-finish", scheduleMount);
    document.addEventListener("yt-navigate-finish", scheduleMount);
    window.addEventListener("yt-page-data-updated", scheduleMount);
    scheduleMount();
})();
