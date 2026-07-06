// This runs in the "Main World" (same as the page JS)

(function() {

    const makeBackgroundTaskPromise = (requestType, responseType, payload, callbackOnResponseSuccess) => {
        return new Promise((resolve, reject) => {
            const requestId = Math.random().toString(36).substring(7);

            // Define a one-time listener for the response
            function handleResponse(event) {
                if (event.data.type === responseType && event.data.requestId === requestId) {
                    window.removeEventListener("message", handleResponse);
                    if (event.data.error) {
                        reject(event.data.error);
                    } else {
                        let result = event.data.result;
                        if (callbackOnResponseSuccess) result = callbackOnResponseSuccess(result);
                        resolve(result);
                    }
                }
            }

            window.addEventListener("message", handleResponse);

            // Send the request out to the Content Script
            window.postMessage({
                type: requestType,
                requestId: requestId,
                payload: payload
            }, "*");
        });
    };

    window.ml = {
        // Stateful multi-turn chat:
        //
        //   const history = ml.createChat({ system, model, think, cleanup });
        //   await history.chat("first question", { images: [...] });
        //   await history.chat("follow-up");
        //   history.messages.at(-1)   // last message
        //   history.fork()            // independent copy of the conversation
        //
        // history.messages is a plain [{ role, content, images? }] array —
        // edit it freely (pop to retry, splice to prune, tweak .content).
        // A failed request leaves the history untouched.
        //
        // system:  optional system prompt (first message).
        // model:   default model for this chat; null uses the saved default.
        // think:   true/false maps to Ollama's native "think" parameter
        //          (forwarded by OpenWebUI); null omits it so the server default applies.
        // cleanup: strip the <think>...</think> block from responses — also
        //          before storing them, so it isn't resent as context.
        // schema:  a JSON Schema object — constrains the reply to matching JSON
        //          and returns it parsed (an object), not a string. History
        //          still stores the raw JSON text so turns chain normally.
        // toolIds: OpenWebUI server-side tool ids (e.g. ["web_search"]) — OpenWebUI
        //          runs those tools and returns the finished answer. OpenWebUI only.
        // history.chat() accepts { images, model, think, cleanup, schema, toolIds } per turn.
        createChat: function({ system = null, model = null, think = false, cleanup = true, schema = null, toolIds = null } = {}) {
            const ml = this;
            return {
                messages: system ? [{ role: "system", content: system }] : [],
                model,
                think,
                cleanup,
                schema,
                toolIds,
                chat: async function(prompt, { images = [], model = this.model, think = this.think, cleanup = this.cleanup, schema = this.schema, toolIds = this.toolIds } = {}) {
                    const userMessage = { role: "user", content: prompt };
                    if (images.length) {
                        userMessage.images = await Promise.all(
                            images.map(image => ml._imageToDataUrl(image))
                        );
                    }

                    let reply = await makeBackgroundTaskPromise(
                        "LLM_REQUEST",
                        "LLM_RESPONSE",
                        { "messages": [...this.messages, userMessage], "think": think, "model": model, "schema": schema, "toolIds": toolIds }
                    );
                    if (cleanup) reply = reply.replace(/^<think>[\s\S]*?<\/think>\s*/i, '');

                    this.messages.push(userMessage, { role: "assistant", content: reply });
                    return schema ? ml._parseJSON(reply) : reply;
                },
                fork: function() {
                    const copy = ml.createChat({ model: this.model, think: this.think, cleanup: this.cleanup, schema: this.schema, toolIds: this.toolIds });
                    copy.messages = structuredClone(this.messages);
                    return copy;
                }
            };
        },
        // One-shot chat — a throwaway single-turn history.
        // Options: { system, think, cleanup, images, model, schema, toolIds } as in createChat.
        chat: async function(prompt, options = {}) {
            return this.createChat(options).chat(prompt, options);
        },
        // Low-level single model turn WITH client-side tools. Returns the raw
        // assistant message { content, tool_calls: [{ id, name, arguments }] } and
        // hands control back to you: execute the calls, append the results as
        // { role: "tool", tool_call_id, content }, and call ml.step again to
        // continue. You own the loop (whitelist, limits, overseer — all yours).
        // Works on both OpenWebUI and plain Ollama (wire differences normalized).
        step: async function(messages, { tools = [], model = null, think = null } = {}) {
            return makeBackgroundTaskPromise(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                { "messages": messages, "tools": tools, "model": model, "think": think, "raw": true }
            );
        },
        chatShort: async function(prompt, options) {
            return this.chat(`${prompt}. Short and concise:`, options);
        },
        // OCR: transcribe baked-in text from an image to a plain string, using
        // the dedicated OCR (vision) model — so the reasoning model never sees
        // image tokens. Composes with chat:
        //   await ml.chat("Summarize: " + await ml.read($0))
        //   await Promise.all(imgs.map(i => ml.read(i)))
        // image: <img> element or URL string. model: per-call override of the
        // configured OCR model. prompt: override the default transcription prompt.
        read: async function(image, { model = null, prompt = null } = {}) {
            const dataUrl = await this._imageToDataUrl(image);
            const instruction = prompt ||
                "Transcribe all text in this image exactly as it appears, " +
                "preserving reading order. Output only the transcribed text — " +
                "no commentary, no descriptions, no markdown.";
            const reply = await makeBackgroundTaskPromise(
                "LLM_REQUEST",
                "LLM_RESPONSE",
                {
                    "messages": [{ role: "user", content: instruction, images: [dataUrl] }],
                    "think": null,
                    "model": model,
                    "ocr": true
                }
            );
            return reply.replace(/^<think>[\s\S]*?<\/think>\s*/i, '').trim();
        },
        // Parses a structured-output reply, tolerating a stray ```json fence
        // and surfacing the raw text on failure for debugging.
        _parseJSON: function(text) {
            const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
            try {
                return JSON.parse(stripped);
            } catch (err) {
                throw new Error(
                    `schema was set but the reply wasn't valid JSON (${err.message}). ` +
                    `Got: ${text.slice(0, 200)}`
                );
            }
        },
        // Accepts a URL string or <img> element, returns "data:image/...;base64,..."
        _imageToDataUrl: async function(image) {
            let url = "";

            if (typeof image === "string") {
                url = image;
            } else if (image instanceof HTMLImageElement) {
                url = image.currentSrc || image.src;
            } else {
                throw new Error("Image must be a URL string or <img> element!");
            }

            // Case A: Data URI (Already Base64)
            // e.g. "data:image/png;base64,iVBOR..."
            if (url.startsWith("data:")) {
                return url;
            }

            // Case B: Blob URI (Local Memory)
            // e.g. "blob:https://example.com/..."
            // The Background Script CANNOT fetch these (they exist only in the Tab).
            // We must fetch them here in the Main World.
            if (url.startsWith("blob:")) {
                return new Promise((resolve, reject) => {
                    fetch(url)
                        .then(r => r.blob())
                        .then(blob => {
                            const reader = new FileReader();
                            reader.onloadend = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        })
                        .catch(e => reject("Failed to read Blob: " + e.message));
                });
            }

            // Case C: Standard HTTP/HTTPS (External Images)
            // The Page Context will likely fail (CORS).
            // The Background Script will SUCCEED (Extension Permissions).
            // We delegate the fetch to the background.
            return this._fetchImageBase64(url);
        },
        _fetchImageBase64: async function(url) {
            return makeBackgroundTaskPromise(
                "B64_REQUEST",
                "B64_RESPONSE",
                { "url": url }
            );
        },
        // Available model ids on the server.
        models: async function() {
            return makeBackgroundTaskPromise("LIST_MODELS_REQUEST", "LIST_MODELS_RESPONSE", {});
        },
        // Capability list for a model, read from Ollama's /api/show — e.g.
        // ["completion", "tools", "vision", "thinking"]. Handy for feature
        // gating (e.g. only offer server-side tools on a tool-capable model).
        // Returns null when it can't be determined (cloud/non-Ollama model, old
        // Ollama, unreachable) — treat null as "unknown", never as "no".
        // model omitted = the saved default model.
        capabilities: async function(model = null) {
            return makeBackgroundTaskPromise("CAPS_REQUEST", "CAPS_RESPONSE", { "model": model });
        },
        // The saved default model.
        getModel: async function() {
            return makeBackgroundTaskPromise("GET_MODEL_REQUEST", "GET_MODEL_RESPONSE", {});
        },
        // Persistently switch the default model (validated against the server;
        // the settings popup picks it up automatically).
        setModel: async function(model) {
            return makeBackgroundTaskPromise("SET_MODEL_REQUEST", "SET_MODEL_RESPONSE", { "model": model });
        },
        // Models currently loaded in VRAM: [{ model, vramGB, expiresAt }]
        ps: async function() {
            return makeBackgroundTaskPromise("PS_REQUEST", "PS_RESPONSE", {});
        },
        // Evict a model from VRAM (keep_alive: 0); no argument = evict all.
        // Returns the list of models that were told to unload.
        unload: async function(model = null) {
            return makeBackgroundTaskPromise("UNLOAD_REQUEST", "UNLOAD_RESPONSE", { "model": model });
        },
        logChat: async function(prompt, options) {
            const response = await this.chat(prompt, options);
            console.log(response);
        },
        logChatShort: async function(prompt, options) {
            const response = await this.chatShort(prompt, options);
            console.log(response);
        },
    };

    // Readiness signal for scripts (e.g. userscripts) that may run before this
    // one injects. Resolves immediately since window.ml is fully synchronous:
    //   const ml = await (window.ml?.ready
    //       ?? new Promise(r => addEventListener("ml:ready", () => r(window.ml), { once: true })));
    window.ml.ready = Promise.resolve(window.ml);
    window.dispatchEvent(new Event("ml:ready"));

    console.log("🟢 window.ml is ready.");
})();