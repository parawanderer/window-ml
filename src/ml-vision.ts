// ml-vision.ts — the VISION surface of `window.ml`: producing pixels, and deciding what can read them.
//
// Split out of injected.ts. Three jobs that only look separate: getting an image (`screenshot` of a region or a
// whole page via `_stitchFullPage`, `_imageToDataUrl` for an <img>/blob/http URL), asking a model to read one
// (`read`, `_nativeLookTool`), and working out WHICH model is allowed to (`_resolveVisionModel`, `_modelSees`).
//
// The capability question is the subtle part and the reason these belong together: a model's vision support is
// PROBED, never assumed, and an undeterminable answer means "unknown" rather than "no" — a cloud model or an old
// Ollama returns nothing, and treating that as a refusal silently disables sight on exactly the models most
// likely to have it. See `docs/LOCATE-VISION.md`.
//
// Images reach the model as data URLs built in the BACKGROUND, not on a canvas: a cross-origin `<img>` without
// CORS taints the canvas, so pixel readback fails even for something already rendered on screen.

import { makeBackgroundTaskPromise, hideSidebarForShot } from "./bridge";
import { VIEWS_PARAM, targetRender, lookViews, BOX_OVER_TEXT_TIP, legendFor } from "./builtin-tools";
import type { MlApi, ShotBox, MlPublicConfig, VisionMemory, MlTool, ToolResult } from "./contract";
import { queryAll, isElement, viewportRect, classifyOverlay, errText } from "./dom";
import { pickAccentColorForTarget, annotate } from "./locate";
import { POINT_RE, resolvePoint, PT_LOOK_RADIUS, cropDataUrl, BOX_RE, resolveBox, MIN_SHOT_PX, markSeen } from "./util";

/**
 * OCR: transcribe baked-in text from an image to a plain string, using
 * the dedicated OCR (vision) model — so the reasoning model never sees
 * image tokens. Composes with chat:
 *   await ml.chat("Summarize: " + await ml.read($0))
 *   await Promise.all(imgs.map(i => ml.read(i)))
 *
 * @param {string|HTMLImageElement} image An <img> element or URL string.
 * @param {Object} [options] Options object.
 * @param {string} [options.model=null] Per-call override of the configured OCR model.
 * @param {string} [options.prompt=null] Override the default transcription prompt.
 * @returns {Promise<string>} The transcribed text.
 */
export const read = async function(this: MlApi, image: string | HTMLImageElement, { model = null, prompt = null, numCtx = null }: { model?: string | null; prompt?: string | null; numCtx?: number | null } = {}): Promise<string> {
    const dataUrl = await this._imageToDataUrl(image);
    const instruction = prompt ||
        "Transcribe all text in this image exactly as it appears, " +
        "preserving reading order. Output only the transcribed text — " +
        "no commentary, no descriptions, no markdown.";
    const reply = await makeBackgroundTaskPromise<string>(
        "LLM_REQUEST",
        "LLM_RESPONSE",
        {
            "messages": [{ role: "user", content: instruction, images: [dataUrl] }],
            "think": null,
            "model": model,
            // Per-call override; when omitted, prepareRequest applies the small config.ocrNumCtx
            // default (residency-guarded, so a bigger already-loaded model is reused, not reloaded).
            "numCtx": typeof numCtx === "number" ? numCtx : undefined,
            "ocr": true
        }
    );
    return reply.trim();
};

/**
 * Screenshot to a PNG data URL. With no target, captures the whole visible
 * viewport (use it to ORIENT — see the page like you would in devtools).
 * With a target, scrolls it into view and crops to its rect. Feed either
 * to a vision model:
 *
 * ```js
 *   await ml.chat("What does this show?", { images: [await ml.screenshot("#card")] })
 *   await ml.chat("What page is this?", { images: [await ml.screenshot()] })
 *```
 *
 * @param {string|Element|null} [target=null] A CSS selector, an Element, or null for the whole viewport.
 * @param {Object} [options] Options object.
 * @param {boolean} [options.scroll=true] Set false to skip scroll-into-view.
 * @param {boolean} [options.fullPage=false] Set true to capture the full page (stitched).
 * @param {number} [options.index=0] Which match of a selector to shoot (0-based).
 * @param {boolean} [options.raw=false] For an `@pt`/`@box` token: return the plain crop
 *   (no verify overlay/padding — the actual pixels). Default draws the marker/outline.
 * @param {number} [options.margin=0] For an `@pt` token: the crop radius (px) around the
 *   point. 0 = the default look-radius. Ignored otherwise.
 * @returns {Promise<string>} The screenshot as a PNG data URL.
 */
export const screenshot = async function(this: MlApi, target: string | Element | null = null, { scroll = true, fullPage = false, index = 0, raw = false, margin = 0, noOverlay = false, capture = null }: { scroll?: boolean; fullPage?: boolean; index?: number; raw?: boolean; margin?: number; noOverlay?: boolean; capture?: string | null } = {}): Promise<string> {
    // Hide the debug sidebar overlay (if mounted) for the shot, so it isn't
    // captured into the agent's `look`; restore after. No wait when the
    // sidebar is off (no #ml-sb-root) — it's a no-op then.
    // `capture` (a pre-taken viewport data-URL) SHORT-CIRCUITS this: `look`'s two-view mode
    // (overlay + no-overlay) crops both from ONE capture instead of re-screenshotting the tab.
    const viewport = async (): Promise<string> => {
        if (capture) return capture;
        await hideSidebarForShot();
        try { return await makeBackgroundTaskPromise<string>("CAPTURE_TAB_REQUEST", "CAPTURE_TAB_RESPONSE", {}); }
        finally { window.postMessage({ __mlSidebarShot: "show" }, "*"); }
    };
    if (target == null) return fullPage ? this._stitchFullPage(viewport) : viewport();

    // An `@pt:` point token (a canvas coordinate from locate) → a cropped view around
    // the point with a MARK on the exact click spot, so look() can VERIFY what a click
    // will hit (a canvas has no DOM node to screenshot). Works for both look paths.
    if (typeof target === "string" && POINT_RE.test(target.trim())) {
        const pt = resolvePoint(target);
        if (!pt) throw new Error(`Unknown point token "${target}" — re-run locate for a fresh one.`);
        const dpr = window.devicePixelRatio || 1, R = margin > 0 ? margin : PT_LOOK_RADIUS;
        const left = Math.max(0, pt.x - R), top = Math.max(0, pt.y - R);
        const rect = { left, top, width: Math.min(window.innerWidth, pt.x + R) - left, height: Math.min(window.innerHeight, pt.y + R) - top };
        const cropped = await cropDataUrl(await viewport(), rect, dpr);
        if (raw || noOverlay) return cropped;   // raw: pythonExec pixels · noOverlay: look's clean copy (same crop, no marker)
        const marker = { left: pt.x - left - 12, top: pt.y - top - 12, width: 24, height: 24 };
        // Contrast the marker with the background AND the target under it (in image px).
        const color = await pickAccentColorForTarget(cropped, { left: marker.left * dpr, top: marker.top * dpr, width: marker.width * dpr, height: marker.height * dpr });
        return annotate(cropped, [{ rect: marker, color, label: "click point", float: true }], dpr);
    }

    // An `@box:` container token (a canvas region from locate({ container: true })) →
    // a padded crop with the region OUTLINED, so look() can VERIFY what you scoped to
    // before operating inside it. The canvas analogue of screenshotting a container.
    if (typeof target === "string" && BOX_RE.test(target.trim())) {
        const bx = resolveBox(target);
        if (!bx) throw new Error(`Unknown container token "${target}" — re-run locate({ container: true }) for a fresh one.`);
        // raw (pythonExec): the EXACT box content — no padding, no outline — so the
        // pixels the sandbox sees are the container's, not the marker's. Non-raw
        // (look verify): pad + outline so the driver can see what it scoped to.
        const dpr = window.devicePixelRatio || 1, pad = raw ? 0 : 16;
        const left = Math.max(0, bx.left - pad), top = Math.max(0, bx.top - pad);
        const rect = { left, top, width: Math.min(window.innerWidth, bx.right + pad) - left, height: Math.min(window.innerHeight, bx.bottom + pad) - top };
        const cropped = await cropDataUrl(await viewport(), rect, dpr);
        if (raw) return cropped;
        if (noOverlay) return cropped;   // look's clean copy: same PADDED framing as the marked one, just no outline
        const outline = { left: bx.left - left, top: bx.top - top, width: bx.right - bx.left, height: bx.bottom - bx.top };
        const color = await pickAccentColorForTarget(cropped, { left: outline.left * dpr, top: outline.top * dpr, width: outline.width * dpr, height: outline.height * dpr });
        return annotate(cropped, [{ rect: outline, color, label: "container" }], dpr);
    }

    let el = target;
    if (typeof target === "string") {
        el = queryAll(target)[index];   // Nth match (queryAll adds :contains + `>>>` shadow/iframe crossing)
        if (!el) throw new Error(`No element matches "${target}"${index ? ` at index ${index}` : ""}.`);
    }
    // isElement = cross-realm nodeType check (dom.ts) — a `>>>` iframe-inner element is in the frame's
    // realm, so `instanceof Element` fails. Type guard → `el` narrows to Element below (no casts).
    if (!isElement(el)) throw new Error("ml.screenshot needs a CSS selector, an Element, or nothing.");
    if (scroll) {
        el.scrollIntoView({ block: "center", inline: "center" });
        // Let the scroll paint before we capture.
        await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    }
    // viewportRect (not getBoundingClientRect) — an element inside a same-origin iframe reports a
    // FRAME-LOCAL rect, but the captured tab image is the TOP viewport, so the crop must be composed
    // across the frame offset (else it crops the wrong region — the page's top-left).
    const rect = viewportRect(el);
    // A zero- or sliver-sized element (e.g. a 1px-tall spacer/rule, or a
    // collapsed container) crops to a degenerate 1px-by-N image the vision
    // model just hallucinates over. Reject it with an actionable message
    // rather than sending the sliver off (roadmap #10).
    if (rect.width < MIN_SHOT_PX || rect.height < MIN_SHOT_PX) {
        throw new Error(
            `element is ${Math.round(rect.width)}×${Math.round(rect.height)}px — too small to ` +
            `screenshot (hidden, collapsed, or a 1px spacer?). Target a parent container with real size.`
        );
    }
    return cropDataUrl(await viewport(), rect, window.devicePixelRatio || 1);
};

/**
 * The crop transform of a raw ml.screenshot({ raw:true }) of `target`: the crop's viewport
 * top-left (CSS px) + the dpr it was captured at. So a python_exec coordinate — computed in
 * the returned image's PIXELS — can be projected back to the viewport for a clickable @pt/@box
 * (projectShotPoint/Box). Mirrors screenshot's raw crop rects: @pt → a PT_LOOK_RADIUS/`margin`
 * box; @box → the box (pad 0); a selector/Element → its bounding rect. Call AFTER the shot so a
 * scrolled-into-view element's rect is settled.
 *
 * @returns {ShotBox|null} null if the target doesn't resolve.
 */
export const _shotBox = function(target: string | Element, margin = 0): ShotBox | null {
    const dpr = window.devicePixelRatio || 1;
    if (typeof target === "string" && POINT_RE.test(target.trim())) {
        const pt = resolvePoint(target); if (!pt) return null;
        const R = margin > 0 ? margin : PT_LOOK_RADIUS;
        return { left: Math.max(0, pt.x - R), top: Math.max(0, pt.y - R), dpr };
    }
    if (typeof target === "string" && BOX_RE.test(target.trim())) {
        const bx = resolveBox(target); if (!bx) return null;
        return { left: Math.max(0, bx.left), top: Math.max(0, bx.top), dpr };   // raw: pad 0
    }
    const el = typeof target === "string" ? queryAll(target)[0] : target;
    if (!isElement(el)) return null;   // cross-realm nodeType check (iframe-inner elements)
    const r = viewportRect(el);   // top-viewport (composes iframe offsets)
    return { left: r.left, top: r.top, dpr };
};

/**
 * Scroll the page in viewport-height steps, capture each, and stitch them
 * vertically into one tall PNG data URL. Browser-only (canvas). Paces
 * captures to respect captureVisibleTab's 2/sec limit, with backoff retries.
 *
 * @param {Function} capture The capture function that returns a viewport screenshot.
 * @returns {Promise<string>} The stitched full-page screenshot as a PNG data URL.
 */
export const _stitchFullPage = async function(capture: () => Promise<string>): Promise<string> {
    const dpr = window.devicePixelRatio || 1;
    const vh = window.innerHeight;
    // Cap at ~8 screens so the image stays sane
    const total = Math.min(document.documentElement.scrollHeight, vh * 8);
    const startY = window.scrollY;
    const shots: { y: number; url: string }[] = [];
    const paint = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Detect PINNED overlays (position:fixed, or a currently-STUCK sticky) so we can stop
    // them being stamped into every tile: a fixed nav bar / footer is on screen in every
    // viewport, so a naive scroll+stitch repeats it down the whole image. We probe each
    // candidate's viewport rect at two scroll positions — an invariant top ⇒ pinned
    // (classifyOverlay) — and later show it on exactly ONE tile (a top header on the first,
    // a bottom footer on the last), hiding it on the rest so the content behind shows
    // through. Skipped for a single-viewport page (nothing can repeat). getComputedStyle
    // over the DOM is a one-time cost, negligible beside the paced 600ms/tile captures.
    const overlays: { el: HTMLElement; anchor: "top" | "bottom"; vis: string }[] = [];
    if (total > vh) {
        const cands = ([...document.querySelectorAll("*")] as HTMLElement[])
            .filter(el => { const p = getComputedStyle(el).position; return p === "fixed" || p === "sticky"; });
        window.scrollTo(0, 0); await paint();
        const r0 = cands.map(el => el.getBoundingClientRect());
        window.scrollTo(0, Math.min(vh, Math.max(1, total - vh))); await paint();
        cands.forEach((el, i) => {
            const c = classifyOverlay(r0[i], el.getBoundingClientRect(), vh);
            if (c.pinned) overlays.push({ el, anchor: c.anchor, vis: el.style.visibility });
        });
    }

    try {
        for (let y = 0; y < total; y += vh) {
            window.scrollTo(0, y);
            // Wait for the browser to actually paint the new scroll position
            await paint();
            // Record where we ACTUALLY landed, not where we asked to go: scrollTo clamps at the
            // page's max scroll, so the last step captures the bottom viewport (which overlaps the
            // previous tile) but at a SMALLER offset than `y`. Drawing at the requested `y` painted
            // that overlap band twice — the duplicated "Ridiculous mode"/torn-row seam. Drawing at
            // the real scrollY makes the clamped tile overwrite the overlap with identical pixels.
            const actualY = window.scrollY;
            const isLast = actualY + vh >= total;
            // Show each pinned overlay on ONLY its home tile (header→first, footer→last), hidden
            // elsewhere. Drawn at actualY, the header lands at y≈0 and the footer at ≈page-bottom —
            // each appearing exactly once instead of on every tile.
            for (const o of overlays) o.el.style.visibility = (o.anchor === "top" ? y === 0 : isLast) ? o.vis : "hidden";

            let url: string | null = null;
            let retries = 3;

            while (retries > 0 && !url) {
                try {
                    // 600ms ensures we strictly stay under the 2 calls/sec limit
                    await new Promise(r => setTimeout(r, 600));
                    url = await capture();
                } catch (e) {
                    // If we still hit the quota, back off for a full second and retry
                    if ((e as Error).message && (e as Error).message.includes("MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND")) {
                        console.warn(`Hit Chrome capture limit at scroll ${y}, backing off...`);
                        await new Promise(r => setTimeout(r, 1000));
                        retries--;
                    } else {
                        throw e; // Unrelated error, fail fast
                    }
                }
            }

            if (!url) throw new Error("Failed to capture after retries due to quota limits.");
            shots.push({ y: actualY, url });
            // A clamped step reached the bottom — further steps would re-capture the same tile.
            if (isLast) break;
        }
    } finally {
        // Restore every overlay's visibility (even on a capture throw) and the scroll position.
        for (const o of overlays) o.el.style.visibility = o.vis;
        window.scrollTo(0, startY);
    }

    return new Promise((resolve, reject) => {
        if (!shots.length) return reject(new Error("nothing captured"));
        const imgs: HTMLImageElement[] = [];
        let loaded = 0;
        const done = () => {
            const canvas = document.createElement("canvas");
            canvas.width = imgs[0].naturalWidth;
            canvas.height = Math.round(total * dpr);
            const ctx = canvas.getContext("2d")!;
            shots.forEach((s, i) => ctx.drawImage(imgs[i], 0, Math.round(s.y * dpr)));
            resolve(canvas.toDataURL("image/png"));
        };
        shots.forEach((s, i) => {
            const img = new Image();
            img.onload = () => { imgs[i] = img; if (++loaded === shots.length) done(); };
            img.onerror = () => reject(new Error("failed to load a capture"));
            img.src = s.url;
        });
    });
};

/**
 * Pick a vision model for the auto-registered `look` tool (see ml.agent's `vision` option).
 * Returns a model id the agent can see with, or null. `agentModel` is the agent's own model
 * (opts.model, or null = the saved default). A string `vision` forces that model; otherwise
 * probe the agent's model, then the configured OCR model, accepting only a POSITIVE Ollama
 * vision capability — unknown/null (cloud/non-Ollama) must NOT qualify, or we'd send image
 * tokens to a text-only model. The caps probe is cached per service-worker lifetime in the
 * background worker.
 *
 * @param {string|null} agentModel The agent's model (or null for default).
 * @param {string|boolean|null} [vision] Vision option from ml.agent options.
 * @returns {Promise<string|null>} A vision-capable model id, or null.
 */
export const _resolveVisionModel = async function(this: MlApi, agentModel: string | null, vision: boolean | string | null): Promise<string | null> {
    if (typeof vision === "string" && vision) return vision;   // forced delegated model
    let cfg: MlPublicConfig | null;
    try { cfg = await this.config(); } catch (e) { cfg = null; }
    const primary = agentModel || (cfg && cfg.model);
    if (vision === true) return primary || null;   // forced NATIVE → the agent's own model (no probe)
    if (await this._modelSees(primary)) return primary;
    const ocr = cfg && cfg.ocrModel;
    if (ocr && ocr !== primary && await this._modelSees(ocr)) return ocr;
    return null;
};

/**
 * True only when `model` POSITIVELY reports vision capability.
 * Unknown/null (cloud, non-Ollama, unreachable) is false — never send image
 * tokens to a model we can't confirm sees. Caps are cached in the worker.
 *
 * @param {string|null} model The model id to check.
 * @returns {Promise<boolean>} True if the model has vision capability.
 */
export const _modelSees = async function(this: MlApi, model: string | null): Promise<boolean> {
    if (!model) return false;
    let caps: string[] | null;
    try { caps = await this.capabilities(model); } catch (e) { caps = null; }
    if (Array.isArray(caps)) return caps.includes("vision");   // we KNOW (Ollama /api/show) — authoritative
    // Undeterminable (cloud / non-Ollama / old Ollama): fall back to the user's declared capability for
    // the DEFAULT model — the only way such a model can be marked vision-capable (e.g. HUD native vision
    // on gpt-4o/minimax). Detection above always wins for Ollama, so this never overrides a known answer.
    try {
        const cfg = await this.config();
        if (cfg && cfg.model && model === cfg.model && cfg.defaultModelVision) return cfg.defaultModelVision === "yes";
    } catch (e) { /* no config → treat as unknown = no */ }
    return false;
};

/**
 * Build a capture-only `look` tool for a vision-capable AGENT model.
 * It screenshots and hands the raw image back to ml.agent, which injects it
 * into the model's OWN history so it reasons over the real pixels (vs the
 * delegated lookTool, which returns a second model's text description).
 *
 * @returns {MlTool} A tool with `name: "look"`, `capabilities: ["vision"]`, returning
 *   `{ content, image, imageLabel, elements }` for inline vision.
 */
export const _nativeLookTool = function(this: MlApi, memory?: VisionMemory): MlTool {
    const ml = this;
    return ml.defineTool({
        name: "look",
        summary: "Screenshots the page so the agent can see it.",
        capabilities: ["vision"],
        description: "See the page with your OWN eyes — this screenshots the page (or an element) " +
            "and shows YOU the image directly. Call with NO selector to see the viewport and ORIENT " +
            "when a task is vague; pass a selector to inspect one element (icons, badges, whether " +
            "something looks sponsored / greyed-out / out of stock); pass scope:'page' (no selector) " +
            "to see the whole page stitched into one tall image (DOWNSCALED — use it for layout, not " +
            "small text). To CLASSIFY items in a grid/list (which show a cat?), pass the item selector " +
            "and iterate `index` (0,1,2,…) for a tight crop of each. After looking, DESCRIBE what you " +
            "see, then take the next action. BONUS: alongside the image the result appends a \"DOM in " +
            "view\" legend — the exact visible TEXT, controls and boundaries under the crop with their " +
            "selectors — so you read the ground-truth characters instead of guessing them from pixels " +
            "(no OCR risk) and get a ready anchor for click/type. It's a heuristic: it can't reach a " +
            "CANVAS or a CROSS-ORIGIN iframe (no DOM there), and a BUSY or LARGE selection skips the " +
            "text listing (too much to be useful) — so a tight crop gets the richest legend.",
        parameters: {
            type: "object",
            properties: {
                selector: { type: "string", description: "CSS selector of an element; omit to see the page." },
                scope: { type: "string", enum: ["viewport", "page"], description: "'viewport' (default), or 'page' to scroll+stitch the full page (only when no selector)." },
                index: { type: "integer", description: "Which match of the selector to look at (0-based); iterate a grid with 0,1,2,…" },
                margin: { type: "number", description: "For an @pt: token only — the crop RADIUS in px around the point (bigger = more context). Ignored for CSS selectors." },
                views: VIEWS_PARAM
            }
        },
        // In: the target as a hoverable ref (hover → outline it on the page). No selector → raw args.
        render: (_input, args) => targetRender(args),
        run: async ({ selector, scope, index, margin, views }: { selector?: string; scope?: "viewport" | "page"; index?: number; margin?: number; views?: string[] } = {}): Promise<string | ToolResult> => {
            const fullPage = scope === "page" && !selector;
            const isPoint = !!selector && POINT_RE.test(selector.trim());
            const isMarked = !!selector && (isPoint || BOX_RE.test(selector.trim()));
            // Looking at an @pt marks it SEEN → locate's snap-feedback won't re-inject its crop.
            if (isPoint) { const p = resolvePoint(selector!); if (p) markSeen(memory, p.x, p.y); }
            // A marked target honours `views` (overlay / no-overlay / both, ONE capture); the driver sees
            // each crop as its own inline image. Everything else is the usual single shot.
            let shots: { image: string; label: string }[], crossesText = false;
            try {
                if (isMarked) { const v = await lookViews(ml, selector!, margin as number, views); shots = v.images; crossesText = v.crossesText; }
                else { const shot = await ml.screenshot(selector || null, { fullPage, index: index || 0, margin: typeof margin === "number" ? margin : 0 }); shots = [{ image: shot, label: selector ? `element "${selector}"${index ? ` #${index}` : ""}` : (fullPage ? "full page" : "viewport") }]; }
            }
            catch (e) { return `Error: ${errText(e)}`; }
            const label = shots[0].label;
            // The SUBJECT for the content line — for a marked target, `shots[0].label` is a VIEW label
            // ("with click-point box"), NOT a subject, which read as "Screenshot of the with click-point
            // box". Name the target itself; the crop labels still appear in `multi`.
            const subject = isMarked ? (isPoint ? `marked point ${selector!.trim()}` : `marked region ${selector!.trim()}`) : label;
            // @pt verify shot → disclose the snap-around-point recovery, @pt-only: the
            // driver can see here whether the mark grazes a target it can otherwise see.
            const pointTip = isPoint
                ? `\n\n(Verify before clicking. If the target IS visible in this crop but the mark isn't on it, re-locate just this area to snap onto it: locate({ selector: "${selector}", strategy: "grounding", description: "…" }) — searches only this box (add margin: 40–120 if the target is partly cut off at the edge). If the target ISN'T in this crop at all, it's the wrong spot: change region/description, don't re-verify here.)`
                : "";
            // Targeted no-overlay nudge — only when the box was DETECTED over text AND a clean copy wasn't already sent.
            const overTextTip = crossesText && shots.length === 1 ? BOX_OVER_TEXT_TIP : "";
            const multi = shots.length > 1 ? ` (${shots.length} crops: ${shots.map(s => s.label).join(" · ")})` : "";
            // DOM legend of what's IN this crop — actionable selectors beside the pixels. Skip for a
            // downscaled full-page overview (the model shouldn't act on tiny elements from it).
            const legend = fullPage ? "" : legendFor(selector || null, typeof margin === "number" ? margin : 0);
            // Hand the screenshotted element back on the elements side-channel
            // so it's hoverable in `logDebug`/`onStep` (never sent to the model).
            // Guarded: a bad/stub-DOM selector just yields no node.
            let elements;
            if (selector) { try { const el = queryAll(selector)[index || 0]; if (el) elements = [el]; } catch {} }
            return {
                content: `Screenshot of the ${subject}${multi} captured — shown to you in the next message.${pointTip}${overTextTip}${legend}`,
                // One view → the single `image` shortcut; two → `images` (each injected as its own turn).
                ...(shots.length > 1 ? { images: shots } : { image: shots[0].image, imageLabel: label }),
                elements
            };
        }
    });
};

/**
 * Convert an image to a data URL.
 * Accepts a URL string or <img> element, returns "data:image/...;base64,...".
 * Handles data URIs (passed through), blob URIs (read via FileReader),
 * and external URLs (delegated to background for CORS).
 *
 * @param {string|HTMLImageElement} image A URL string or <img> element.
 * @returns {Promise<string>} The image as a data URL.
 */
export const _imageToDataUrl = async function(this: MlApi, image: string | HTMLImageElement): Promise<string> {
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
                    reader.onloadend = () => resolve(reader.result as string);
                    reader.readAsDataURL(blob);
                })
                .catch(e => reject("Failed to read Blob: " + (e as Error).message));
        });
    }

    // Case C: Standard HTTP/HTTPS (External Images)
    // The Page Context will likely fail (CORS).
    // The Background Script will SUCCEED (Extension Permissions).
    // We delegate the fetch to the background.
    return this._fetchImageBase64(url);
};

/**
 * Fetch an external image as base64 via the background worker (for CORS).
 *
 * @param {string} url The image URL to fetch.
 * @returns {Promise<string>} The image as a base64 data URL.
 */
export const _fetchImageBase64 = async function(url: string): Promise<string> {
    return makeBackgroundTaskPromise(
        "B64_REQUEST",
        "B64_RESPONSE",
        { "url": url }
    );
};
