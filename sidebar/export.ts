// Export a session as a shareable bundle: run.md + real PNG sidecars, zipped.
// A coding assistant can open a .png but can't "see" a base64 blob, so screenshots
// ship as files (images/*.png) and a text-only run downloads a bare .md. Includes a
// tiny dependency-free store-method ZIP writer (PNGs are already deflated). Extracted
// from app.tsx.
import { sessionMap } from "./store";
import type { Session } from "./store";
import { pretty, fullStamp, beautifyJs } from "./format";
import { annotatedConfig, resolveModel, shownModel } from "./model";

// --- Export a session as a bundle: run.md + image sidecars -----------------
// A run's screenshots must ship as real PNG files, not base64 in the markdown —
// a coding assistant can open a .png but can't "see" a base64 blob. So an export
// with any images downloads a .zip (run.md + images/*.png); a text-only run
// downloads a bare .md. `addImage` collects sidecars and returns the ref path.
type Sidecar = { name: string; bytes: Uint8Array };
type AddImage = (dataUrl: string, base: string) => string | null;

// A fenced block whose fence is longer than any backtick run inside it.
function fence(text: string, lang = ""): string {
    let n = 3;
    for (const run of text.match(/`+/g) || []) n = Math.max(n, run.length + 1);
    const f = "`".repeat(n);
    return `${f}${lang}\n${text}\n${f}`;
}

// data:<mime>;base64,<data> → raw bytes + a file extension.
function dataUrlToBytes(url: string): { bytes: Uint8Array; ext: string } | null {
    const m = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(url);
    if (!m) return null;
    const mime = m[1] || "";
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : mime === "image/gif" ? "gif" : "png";
    try {
        const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return { bytes, ext };
    } catch { return null; }
}

function agentToMarkdown(s: Session, addImage: AddImage): string {
    const o: string[] = [];
    o.push(`# Agent run · ${s.model || "default"} · ${s.hash}`, "");
    o.push(`- **Task:** ${s.task || ""}`);
    o.push(`- **Started:** ${fullStamp(s.createdTs)}`);
    o.push(`- **Finished:** ${fullStamp(s.lastTs)}`);
    o.push(`- **Steps:** ${(s.steps || []).length}${s.maxSteps ? ` / ${s.maxSteps}` : ""}`);
    o.push(`- **Outcome:** ${s.hitCap ? "stopped (step cap)" : s.status === "err" ? "error" : s.summary != null ? "answered" : "running"}`, "");
    const c = s.agentConfig;
    if (c) {
        const lines = [`model: ${s.model || "default"}`, `maxSteps: ${c.maxSteps}`];
        if (c.think != null) lines.push(`think: ${c.think}`);
        if (!c.env) lines.push("env: false");
        if (c.vision != null && c.vision !== true) lines.push(`vision: ${JSON.stringify(c.vision)}`);
        if (c.hints) lines.push(`hints: ${c.hints}`);
        lines.push(`tools (${c.tools.length}): ${c.tools.map(t => t.name + (t.requiresApproval ? " ⚠" : "")).join(", ")}`);
        o.push("## Agent options", "", fence(lines.join("\n")), "");
        o.push(`<details><summary>System prompt${c.customSystem ? " (custom)" : ""}</summary>`, "", fence(c.system), "", "</details>", "");
    }
    for (const st of s.steps || []) {
        if (st.tool == null && st.thought != null) { o.push(`## Step ${st.step} · thought`, "", st.thought, ""); continue; }
        o.push(`## Step ${st.step} · ${st.tool || "?"}`, "");
        if (st.approval) o.push(`> _${st.approval === "readonly" ? "auto-approved (read-only)" : st.approval === "user" ? "approved by user" : "denied by user"}_`, "");
        if (st.thought) o.push(st.thought, "");
        if (st.arguments && Object.keys(st.arguments).length) {
            const js = st.tool === "exec" && typeof st.arguments.js === "string" ? st.arguments.js : null;
            o.push("**In:**", "", js ? fence(beautifyJs(js), "javascript") : fence(pretty(st.arguments), "json"), "");
        }
        if (st.argIssues && st.argIssues.length) o.push(`> ⚠ arg issues: ${st.argIssues.join("; ")}`, "");
        if (st.render && st.render.type === "image") {
            const label = st.render.label ? ` — ${st.render.label}` : "";
            const ref = addImage(st.render.src, `step-${st.step}`);
            o.push(ref ? `![step ${st.step}${label}](${ref})` : `_🖼️ screenshot${label} (image unavailable)_`, "");
        } else if (st.render && st.render.type === "locate") {
            // The full grounding/SoM debug view, mirroring the sidebar's locate render.
            const r = st.render;
            o.push(`> _${r.mode === "grounding" ? "Grounding" : "Set-of-Marks"} · ${r.model}_`, "");
            if (r.mode === "grounding") {
                if (r.prompt) o.push("<details><summary>Prompt to the model</summary>", "", fence(r.prompt), "", "</details>", "");
                const gref = r.groundingImage && addImage(r.groundingImage, `step-${st.step}-model-output`);
                o.push(`**Model output**${r.gaveBox ? ` — box ${r.boxCoords}` : " — no box returned"}:`, "");
                o.push(gref ? `![step ${st.step} model output](${gref})` : "_🖼️ (image unavailable)_", "");
            }
            const eref = r.resultImage && addImage(r.resultImage, `step-${st.step}-element-location`);
            if (eref) {
                o.push(`**Element location**${r.margin ? ` — +${r.margin}px search margin` : ""}:`, "");
                o.push(`![step ${st.step} element location](${eref})`, "");
            }
            o.push(`**${r.mode === "grounding" ? "Snapped to" : "Model picked"}:** ${r.picked || "_(none)_"}`, "");
        }
        if (st.result != null && st.result !== "") o.push("**Out:**", "", fence(st.result), "");
        else if (st.elements != null) o.push(`**Out:** ${st.elements} element(s)`, "");
    }
    o.push(`## ${s.hitCap ? "Stopped (step cap)" : "Answer"}`, "", s.summary || "_(no answer — run did not complete)_", "");
    return o.join("\n");
}

function chatToMarkdown(s: Session, addImage: AddImage): string {
    const o: string[] = [];
    o.push(`# Chat · ${shownModel(s)} · ${s.hash}`, "");
    if (s.title) o.push(`- **Title:** ${s.title}`);
    o.push(`- **Started:** ${fullStamp(s.createdTs)}`);
    o.push(`- **Last activity:** ${fullStamp(s.lastTs)}`);
    o.push(`- **Type:** ${s.tag}`, "");
    o.push("## Options", "", fence(annotatedConfig(s.config), "javascript"), "");
    s.turns.forEach((t, i) => {
        o.push(`## Turn ${i + 1} · ${fullStamp(t.ts)}`, "");
        o.push("**User:**", "", t.user || "", "");
        (t.images || []).forEach((img, j) => {
            const ref = addImage(img, `turn-${i + 1}-img-${j + 1}`);
            if (ref) o.push(`![turn ${i + 1} image ${j + 1}](${ref})`, "");
        });
        if (t.reasoning) o.push("<details><summary>Thinking</summary>", "", t.reasoning, "", "</details>", "");
        if (t.status === "err") o.push(`**Error:** ${t.error || "(unknown)"}`, "");
        else o.push(`**Assistant** (${t.model || resolveModel(t.reqModel, t.extend)}):`, "", t.assistant || "_(no reply)_", "");
        if (t.sources && t.sources.length) o.push(`**Sources (${t.sources.length}):**`, "", fence(pretty(t.sources), "json"), "");
    });
    return o.join("\n");
}

// Serialise a session to `{ md, images }`. addImage decodes each data-URL into a
// sidecar and returns its `images/…` ref (or null → the markdown notes it as
// unavailable, so a decode failure never breaks the export).
function serializeSession(s: Session): { md: string; images: Sidecar[] } {
    const images: Sidecar[] = [];
    const addImage: AddImage = (dataUrl, base) => {
        const dec = dataUrlToBytes(dataUrl);
        if (!dec) return null;
        const name = `images/${base}.${dec.ext}`;
        images.push({ name, bytes: dec.bytes });
        return name;
    };
    const md = (s.kind === "agent" ? agentToMarkdown(s, addImage) : chatToMarkdown(s, addImage)) + "\n";
    return { md, images };
}

// --- minimal ZIP writer (store / no compression — PNGs are already deflated,
// so re-compressing is pointless; store keeps this dependency-free) -----------
const CRC_TABLE = /* @__PURE__ */ (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(bytes: Uint8Array): number {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files: Sidecar[]): Blob {
    const enc = new TextEncoder();
    const u16 = (n: number) => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = (n: number) => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
    const parts: Uint8Array[] = [];
    const central: number[] = [];
    let offset = 0;
    for (const f of files) {
        const name = enc.encode(f.name);
        const crc = crc32(f.bytes), size = f.bytes.length;
        const header = [
            ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...name,
        ];
        parts.push(new Uint8Array(header), f.bytes);
        central.push(
            ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
            ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0),
            ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name,
        );
        offset += header.length + size;
    }
    const end = [
        ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length),
        ...u32(central.length), ...u32(offset), ...u16(0),
    ];
    parts.push(new Uint8Array(central), new Uint8Array(end));
    return new Blob(parts as BlobPart[], { type: "application/zip" });
}

// Trigger a client-side download (the iframe can't touch the filesystem).
function downloadBlob(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function exportSession(hash: string): void {
    const s = sessionMap.get(hash);
    if (!s) return;
    const base = `ml-${s.kind === "agent" ? "agent" : "chat"}-${hash}`;
    const { md, images } = serializeSession(s);
    if (!images.length) { downloadBlob(`${base}.md`, new Blob([md], { type: "text/markdown" })); return; }
    downloadBlob(`${base}.zip`, zipStore([{ name: "run.md", bytes: new TextEncoder().encode(md) }, ...images]));
}
