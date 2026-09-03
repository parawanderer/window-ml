// A visual "notebook" for the canvas code that unit tests can't see — locate.ts's
// annotate() label placement (jsdom has no real getImageData, so tests only cover the
// pure geometry). This bundles the REAL locate.ts to a browser IIFE, inlines it into a
// single self-contained HTML page, and draws a gallery of synthetic scenes with a
// "click point" marker so you can eyeball whether the label dodges the icons.
//
//   node tools/preview-annotate.mjs   # regenerate (always fresh against locate.ts)
//   open tools/annotate-preview.html  # look at the renders
import * as esbuild from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function generatePreview() {
// Real locate.ts → IIFE exposing `window.locate` (same code the extension + tests run).
const { outputFiles } = await esbuild.build({
    entryPoints: ["src/locate.ts"],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "locate",
    target: ["chrome114"],
    logLevel: "silent",
});
const locateIife = outputFiles[0].text;

// Each scene draws onto a canvas, then we annotate its dataURL. Scenes are authored in
// the page (below) so tweaking them is a browser refresh, not a rebuild — the notebook
// feel. `SCENES` here is just the manifest the page iterates.
const page = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><title>annotate() label-placement preview</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 24px; background: #0d0d0f; color: #ddd; font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin: 28px 0 6px; }
  .desc { color: #999; max-width: 70ch; }
  .row { display: flex; gap: 18px; flex-wrap: wrap; align-items: flex-start; margin-top: 8px; }
  figure { margin: 0; }
  figcaption { color: #888; font-size: 12px; margin-top: 4px; }
  img, canvas { image-rendering: pixelated; border: 1px solid #333; background: #000; }
  code { background: #1c1c22; padding: 1px 5px; border-radius: 4px; }
  button { background: #22242c; color: #ddd; border: 1px solid #3a3d47; border-radius: 6px;
           padding: 5px 12px; font: 13px system-ui, sans-serif; cursor: pointer; }
  button:hover { background: #2c2f39; }
  kbd { background: #22242c; border: 1px solid #3a3d47; border-radius: 4px; padding: 0 5px; font-size: 12px; }
</style></head><body>
<h1>annotate() — variance-aware label placement</h1>
<p class="desc">Left = the raw scene. Right = after <code>locate.annotate()</code> drops a
marker on the target and floats the "click point" label to the least-busy spot
<em>beside</em> the box (hug-only — it never flies to a corner, since a detached label +
leader line misleads the VLM reading the crop). The marker colour is the real
<code>pickAccentColor()</code> — green-first, but avoids clashing with the scene (note it
is <em>not</em> green over the green sprites).</p>
<div id="out"></div>
<script>${locateIife}</script>
<script>
// --- scene painters (tweak freely, refresh to see) ------------------------
function panel(ctx, w, h) { ctx.fillStyle = "#15161a"; ctx.fillRect(0, 0, w, h); }
// A little multi-colour "icon" — deliberately high-variance, like a real glyph/button.
function icon(ctx, x, y, s = 22) {
  ctx.fillStyle = "#e8c14a"; ctx.fillRect(x, y, s, s);
  ctx.fillStyle = "#2a2a2a"; ctx.fillRect(x + s*0.2, y + s*0.25, s*0.18, s*0.18);
  ctx.fillStyle = "#2a2a2a"; ctx.fillRect(x + s*0.6, y + s*0.25, s*0.18, s*0.18);
  ctx.fillStyle = "#c0392b"; ctx.fillRect(x + s*0.2, y + s*0.62, s*0.6, s*0.16);
}
function sprite(ctx, x, y, hue) {
  ctx.fillStyle = "hsl(" + hue + ",60%,55%)"; ctx.fillRect(x, y, 30, 20);
  ctx.fillStyle = "#f0d0a0"; ctx.fillRect(x + 6, y - 12, 18, 14);
  ctx.fillStyle = "#111"; ctx.fillRect(x + 9, y - 8, 4, 4); ctx.fillRect(x + 17, y - 8, 4, 4);
}

const W = 340, H = 260;
const out = document.getElementById("out");

// The exact 24px marker box annotate draws for an @pt verify, centred on a target box.
function markerFor(box) { return { left: box.left + box.width/2 - 12, top: box.top + box.height/2 - 12, width: 24, height: 24 }; }
function figure(node, caption) {
  const f = document.createElement("figure"); f.appendChild(node);
  const c = document.createElement("figcaption"); if (typeof caption === "string") c.textContent = caption; f.appendChild(c);
  return { fig: f, cap: c };
}
function heading(title, desc) {
  out.insertAdjacentHTML("beforeend", "<h2></h2>");
  out.lastChild.textContent = title;
  const p = document.createElement("p"); p.className = "desc"; p.innerHTML = desc; out.appendChild(p);
}

// --- static scenes 1, 3, 4 ------------------------------------------------
const STATIC = [
  { title: "1. Icon on a flat toolbar",
    desc: "Target sits mid-panel with empty space around it — label should slide onto the flat background, not over the icon.",
    paint(ctx) { panel(ctx, W, H); icon(ctx, 150, 70, 26); return { left: 150, top: 70, width: 26, height: 26 }; } },
  { title: "3. Target hard against a corner",
    desc: "Candidates clamp inside the image; the label still avoids the icon.",
    paint(ctx) { panel(ctx, W, H); icon(ctx, W - 34, H - 34, 26); return { left: W - 34, top: H - 34, width: 26, height: 26 }; } },
  { title: "4. Boxed in on every side → least-busy hug",
    desc: "Content crowds all eight hugging spots, so the label takes the least-busy one beside the box (it may lightly overlap a neighbour) — but never detaches to a corner.",
    paint(ctx) {
      panel(ctx, W, H);
      const cx = W/2 - 13, cy = H/2 - 13;
      icon(ctx, cx, cy, 26);
      for (const [dx, dy] of [[-40,-40],[0,-44],[40,-40],[-44,0],[44,0],[-40,40],[0,44],[40,40]]) icon(ctx, cx+dx, cy+dy, 22);
      return { left: cx, top: cy, width: 26, height: 26 };
    } },
];

function renderStatic(scene) {
  const src = document.createElement("canvas"); src.width = W; src.height = H;
  const box = scene.paint(src.getContext("2d"));
  heading(scene.title, scene.desc);
  const row = document.createElement("div"); row.className = "row"; out.appendChild(row);
  row.appendChild(figure(src, "scene").fig);
  const marker = markerFor(box), dataUrl = src.toDataURL();
  locate.pickAccentColorForTarget(dataUrl, marker)
    .then(color => locate.annotate(dataUrl, [{ rect: marker, color, label: "click point", float: true }], 1))
    .then(url => { const img = new Image(); img.src = url; img.width = W; img.height = H; row.appendChild(figure(img, "annotated").fig); });
}

// --- interactive scene 2: pick the target with the arrow keys -------------
function renderGrid() {
  const cols = 4, rows = 3, n = cols * rows;
  const scene = document.createElement("canvas"); scene.width = W; scene.height = H;
  const sctx = scene.getContext("2d"); panel(sctx, W, H);
  const sprites = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = (i / cols) | 0, x = 28 + c*76, y = 62 + r*66;
    sprite(sctx, x, y, i * 30);                       // full 0-330° hue wheel
    sprites.push({ x, y, hue: i * 30 });
  }
  const dataUrl = scene.toDataURL();

  heading("2. Dense sprite grid — pick the target (← / →)",
    "A full hue-wheel of sprites. Move the target with <kbd>←</kbd> / <kbd>→</kbd> (or the buttons) and watch the marker colour dodge <em>both</em> the background and the selected sprite's own colour — the swatch in the caption is the chosen accent.");
  const row = document.createElement("div"); row.className = "row"; out.appendChild(row);
  row.appendChild(figure(scene, "scene").fig);
  const img = new Image(); img.width = W; img.height = H;
  const built = figure(img, ""); row.appendChild(built.fig);
  const cap = built.cap;

  const controls = document.createElement("div"); controls.style.marginTop = "10px";
  const prev = document.createElement("button"); prev.textContent = "← prev";
  const next = document.createElement("button"); next.textContent = "next →"; next.style.marginLeft = "8px";
  controls.append(prev, next); out.appendChild(controls);

  let idx = 4;   // start on a green-ish sprite so the dodge off green is obvious
  function render() {
    const s = sprites[idx];
    const marker = markerFor({ left: s.x, top: s.y - 12, width: 30, height: 32 });   // head + body
    locate.pickAccentColorForTarget(dataUrl, marker)
      .then(color => locate.annotate(dataUrl, [{ rect: marker, color, label: "click point", float: true }], 1)
        .then(url => {
          img.src = url;
          cap.innerHTML = "";
          const sw = document.createElement("span");
          sw.style.cssText = "display:inline-block;width:11px;height:11px;border:1px solid #555;vertical-align:-1px;margin:0 5px;background:" + color;
          cap.append("target " + (idx+1) + "/" + n + " · sprite hue " + s.hue + "° · marker ", sw, color);
        }));
  }
  const move = d => { idx = (idx + d + n) % n; render(); };
  prev.onclick = () => move(-1);
  next.onclick = () => move(1);
  window.addEventListener("keydown", e => {
    if (e.key === "ArrowLeft") { move(-1); e.preventDefault(); }
    else if (e.key === "ArrowRight") { move(1); e.preventDefault(); }
  });
  render();
}

renderStatic(STATIC[0]);   // 1
renderGrid();              // 2 (interactive)
renderStatic(STATIC[1]);   // 3
renderStatic(STATIC[2]);   // 4
</script></body></html>`;

const dest = "tools/annotate-preview.html";
writeFileSync(dest, page);
return dest;
}

// Run standalone: `node tools/preview-annotate.mjs`. When imported (by build.mjs) this
// guard is false, so importing just exposes generatePreview() without side effects.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const dest = await generatePreview();
    console.log("wrote " + dest + " — open it in a browser to view the renders.");
}
