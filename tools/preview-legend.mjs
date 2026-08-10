// A visual "notebook" for the legend's word-clipping (clipVisibleText) — the logic unit tests assert but
// can't SHOW. It bundles the REAL legend.ts to a browser IIFE, inlines it + the SHARED cases
// (tools/legend-cases.mjs), and renders each case: the words laid out on a line, the 2D crop box over them,
// which words are kept vs dropped, and the actual clipVisibleText output next to the expected one with a
// PASS/FAIL badge. Drag the crop's edges (or its body) — horizontally to clip words, VERTICALLY to slice
// the line (a line cut to a sliver is unreadable → dropped). A red cell is a failing test you can look at.
//
//   node tools/preview-legend.mjs      # regenerate (always fresh against legend.ts)
//   open tools/legend-notebook.html    # (or CI uploads it as a downloadable artifact)
import * as esbuild from "esbuild";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CLIP_CASES } from "./legend-cases.mjs";

export async function generatePreview() {
    const { outputFiles } = await esbuild.build({
        entryPoints: ["legend.ts"], bundle: true, write: false, format: "iife",
        globalName: "legend", target: ["chrome114"], logLevel: "silent",
    });
    const iife = outputFiles[0].text;

    const page = /* html */ `<meta charset="utf-8"><title>legend word-clipping — visual tests</title>
<style>
  :root { --bg:#0d0d0f; --fg:#e5e5e7; --dim:#8a8a92; --line:#2a2a30; --card:#16161a; --stage:#0a0a0c; --kept:#37d67a; --drop:#4a4a52; --box:#c678dd; --ok:#37d67a; --bad:#ff5c6c; }
  @media (prefers-color-scheme: light) { :root { --bg:#fbfbfc; --fg:#1a1a1e; --dim:#6a6a72; --line:#e6e6ea; --card:#fff; --stage:#f4f4f6; --drop:#c2c2ca; --box:#a626a4; } }
  :root[data-theme="dark"] { --bg:#0d0d0f; --fg:#e5e5e7; --dim:#8a8a92; --line:#2a2a30; --card:#16161a; --stage:#0a0a0c; --drop:#4a4a52; --box:#c678dd; }
  :root[data-theme="light"] { --bg:#fbfbfc; --fg:#1a1a1e; --dim:#6a6a72; --line:#e6e6ea; --card:#fff; --stage:#f4f4f6; --drop:#c2c2ca; --box:#a626a4; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 -apple-system, system-ui, sans-serif; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 28px 20px 60px; }
  h1 { font-size: 19px; margin: 0 0 4px; } .lede { color: var(--dim); margin: 0 0 20px; max-width: 70ch; }
  .summary { font-weight: 600; padding: 8px 14px; border-radius: 8px; display: inline-block; margin-bottom: 22px; }
  .summary.pass { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .summary.fail { background: color-mix(in srgb, var(--bad) 16%, transparent); color: var(--bad); }
  .cell { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin: 0 0 16px; }
  .cell.bad { border-color: color-mix(in srgb, var(--bad) 55%, var(--line)); }
  .cell-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
  .cell-title { font-weight: 600; font-size: 15px; }
  .badge { margin-left: auto; font-size: 12px; font-weight: 700; padding: 2px 9px; border-radius: 999px; }
  .badge.ok { background: color-mix(in srgb, var(--ok) 18%, transparent); color: var(--ok); }
  .badge.bad { background: color-mix(in srgb, var(--bad) 18%, transparent); color: var(--bad); }
  .note { color: var(--dim); font-size: 13px; margin: 0 0 12px; max-width: 74ch; }
  .stage { position: relative; height: 96px; margin: 6px 0 14px; background: var(--stage); border: 1px solid var(--line);
           border-radius: 8px; overflow: hidden; user-select: none; touch-action: none; }
  .word { position: absolute; display: flex; align-items: center; justify-content: center; font: 14px ui-monospace, monospace;
          border: 1.5px solid var(--drop); color: var(--dim); border-radius: 4px; background: transparent; overflow: hidden; }
  .word.kept { border-color: var(--kept); color: var(--fg); background: color-mix(in srgb, var(--kept) 13%, transparent); }
  .cbox { position: absolute; border: 2px solid var(--box); border-radius: 5px; background: color-mix(in srgb, var(--box) 9%, transparent); cursor: move; }
  .cbox .lbl { position: absolute; top: -18px; left: -2px; font-size: 11px; color: var(--box); font-weight: 700; pointer-events: none; }
  .handle { position: absolute; background: transparent; }
  .handle.l { left: -5px; top: 0; width: 10px; height: 100%; cursor: ew-resize; }
  .handle.r { right: -5px; top: 0; width: 10px; height: 100%; cursor: ew-resize; }
  .handle.t { top: -5px; left: 0; width: 100%; height: 10px; cursor: ns-resize; }
  .handle.b { bottom: -5px; left: 0; width: 100%; height: 10px; cursor: ns-resize; }
  .io { display: grid; grid-template-columns: 84px 1fr; gap: 4px 12px; font: 13px ui-monospace, monospace; }
  .io .k { color: var(--dim); } .io .v { white-space: pre-wrap; word-break: break-word; }
  .io .v.expect { color: var(--dim); } .io .v.bad { color: var(--bad); }
  .hint { color: var(--dim); font-size: 12px; margin-top: 8px; }
</style>
<div class="wrap">
  <h1>legend · word-clipping <span style="color:var(--dim);font-weight:400">(clipVisibleText)</span></h1>
  <p class="lede">Each cell is a unit test, drawn. The boxes are the words at their on-screen rects; the
  <span style="color:var(--box);font-weight:600">purple box</span> is the screenshot crop. A word is
  <span style="color:var(--kept);font-weight:600">kept whole</span> when the crop touches its glyphs horizontally AND covers
  at least half its height — a line sliced to a sliver top/bottom isn't readable, so it's dropped. A <b>…</b> marks each spill.
  <b>Drag the crop</b> (its body to move, its edges to resize — including up/down) and the anchor recomputes live via the real
  <code>legend.clipVisibleText</code>. A red cell is a failing case.</p>
  <div id="summary" class="summary"></div>
  <div id="cells"></div>
  <p class="hint">Regenerate with <code>node tools/preview-legend.mjs</code> — always fresh against legend.ts.</p>
</div>
<script>${iife}</script>
<script>
const CASES = ${JSON.stringify(CLIP_CASES)};
const SCALE = 1, OX = 14, OY = 34;           // px per unit + stage insets (words on the y 0–20 line)
const px = u => OX + u * SCALE, py = u => OY + u * SCALE;
const unpx = x => (x - OX) / SCALE, unpy = y => (y - OY) / SCALE;
function toWords(text, spans) {
  const out = []; let i = 0; const re = /\\S+/g; let m;
  while ((m = re.exec(text))) { const [l, r] = spans[i++]; out.push({ start: m.index, end: m.index + m[0].length, rect: { left: l, top: 0, right: r, bottom: 20 } }); }
  return out;
}
// Mirror legend.ts's keep test (horizontal overlap + ≥50% vertical coverage) for the highlight.
function kept(r, b) {
  if (!(r.right > b.left && r.left < b.right)) return false;
  const h = r.bottom - r.top;
  return h > 0 && (Math.max(0, Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top)) / h) >= 0.5;
}
const cells = document.getElementById("cells");
let failed = 0;

for (const c of CASES) {
  const words = toWords(c.text, c.spans);
  const cell = document.createElement("div"); cell.className = "cell";
  cell.innerHTML = \`<div class="cell-head"><span class="cell-title"></span><span class="badge"></span></div>
    <p class="note"></p><div class="stage"></div>
    <div class="io"><span class="k">expected</span><span class="v expect"></span><span class="k">actual</span><span class="v actual"></span></div>\`;
  cell.querySelector(".cell-title").textContent = c.title;
  cell.querySelector(".note").textContent = c.note || "";
  cell.querySelector(".v.expect").textContent = JSON.stringify(c.expect);
  const stage = cell.querySelector(".stage");

  const wordEls = words.map(w => {
    const el = document.createElement("div"); el.className = "word";
    el.style.left = px(w.rect.left) + "px"; el.style.top = py(w.rect.top) + "px";
    el.style.width = (w.rect.right - w.rect.left) * SCALE + "px"; el.style.height = (w.rect.bottom - w.rect.top) * SCALE + "px";
    el.textContent = c.text.slice(w.start, w.end); stage.appendChild(el); return el;
  });
  const box = { left: c.box[0], top: c.box[1], right: c.box[2], bottom: c.box[3] };
  const cbox = document.createElement("div"); cbox.className = "cbox";
  cbox.innerHTML = '<span class="lbl">crop</span><div class="handle l" data-e="left"></div><div class="handle r" data-e="right"></div><div class="handle t" data-e="top"></div><div class="handle b" data-e="bottom"></div>';
  stage.appendChild(cbox);
  const actualEl = cell.querySelector(".v.actual"), badge = cell.querySelector(".badge");

  function render() {
    cbox.style.left = px(box.left) + "px"; cbox.style.top = py(box.top) + "px";
    cbox.style.width = (box.right - box.left) * SCALE + "px"; cbox.style.height = (box.bottom - box.top) * SCALE + "px";
    words.forEach((w, i) => wordEls[i].classList.toggle("kept", kept(w.rect, box)));
    const actual = legend.clipVisibleText(c.text, words, box);
    actualEl.textContent = JSON.stringify(actual);
    return actual === c.expect;
  }
  const passOriginal = render();
  badge.textContent = passOriginal ? "PASS" : "FAIL";
  badge.classList.add(passOriginal ? "ok" : "bad");
  if (!passOriginal) { cell.classList.add("bad"); actualEl.classList.add("bad"); failed++; }

  // Drag: an edge handle resizes that edge; the body moves the whole crop. Exploration only — the badge
  // stays fixed on the CASE's box (that's the asserted test).
  let drag = null;
  const start = (mode, e) => { drag = { mode, sx: e.clientX, sy: e.clientY, b: { ...box } }; e.target.setPointerCapture?.(e.pointerId); e.preventDefault(); e.stopPropagation(); };
  cbox.querySelectorAll(".handle").forEach(h => h.addEventListener("pointerdown", e => start(h.dataset.e, e)));
  cbox.addEventListener("pointerdown", e => { if (!e.target.classList.contains("handle")) start("move", e); });
  stage.addEventListener("pointermove", e => {
    if (!drag) return;
    const dx = (e.clientX - drag.sx) / SCALE, dy = (e.clientY - drag.sy) / SCALE, b0 = drag.b;
    if (drag.mode === "move") { box.left = b0.left + dx; box.right = b0.right + dx; box.top = b0.top + dy; box.bottom = b0.bottom + dy; }
    else if (drag.mode === "left") box.left = Math.min(b0.left + dx, box.right - 2);
    else if (drag.mode === "right") box.right = Math.max(b0.right + dx, box.left + 2);
    else if (drag.mode === "top") box.top = Math.min(b0.top + dy, box.bottom - 2);
    else if (drag.mode === "bottom") box.bottom = Math.max(b0.bottom + dy, box.top + 2);
    render();
  });
  window.addEventListener("pointerup", () => { drag = null; });
  cells.appendChild(cell);
}

const s = document.getElementById("summary");
s.textContent = failed ? (failed + " / " + CASES.length + " FAILING — review the red cells") : (CASES.length + " / " + CASES.length + " passing");
s.classList.add(failed ? "fail" : "pass");
</script>`;

    const dest = "tools/legend-notebook.html";
    writeFileSync(dest, page);
    return dest;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const dest = await generatePreview();
    console.log("wrote " + dest + " — open it in a browser (or publish it as an artifact).");
}
