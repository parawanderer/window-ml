// prompt-cuts.mjs — the pages the prompt-budget-cuts bench reads, and the answers its predicates check them against.

/** The one FATAL line's error code in /logs/app.log. */
export const FATAL_CODE = "E-4471";

/** The log's line count: far more than any tool returns whole, so only a `pipe` (or a survey) finds the line. */
const LOG_LINES = 4000;

/**
 * The application log at /logs/app.log: INFO, WARN and ERROR lines (with their own error codes) and one FATAL line,
 * near the end, the same on every call.
 * @returns the log's text
 */
export function appLog() {
    const lines = [];
    const t0 = Date.UTC(2026, 10, 3, 8, 0, 0);
    for (let i = 0; i < LOG_LINES; i++) {
        const ts = new Date(t0 + i * 1370).toISOString();
        if (i === LOG_LINES - 212) { lines.push(`${ts} FATAL worker-3 ${FATAL_CODE}: ledger write lost its lease; shutting down`); continue; }
        const k = (i * 7919) % 97;
        if (k === 0) lines.push(`${ts} ERROR worker-${i % 5} E-${2000 + (i % 400)}: retrying upstream fetch (attempt ${1 + (i % 3)})`);
        else if (k < 9) lines.push(`${ts} WARN  worker-${i % 5} slow response from inventory: ${400 + (i % 900)} ms`);
        else lines.push(`${ts} INFO  worker-${i % 5} handled request ${100000 + i} in ${3 + (i % 40)} ms`);
    }
    return lines.join("\n") + "\n";
}

/** The /controls page's buttons, in page order, and which are disabled. Nothing visible says which. */
export const CONTROLS = [
    ["Save", false], ["Archive", true], ["Export", true], ["Share", false], ["Merge", true], ["Rebase", true],
    ["Rename", false], ["Transfer", true], ["Lock", true], ["Duplicate", false], ["Purge", true],
];

/**
 * The /controls page's body: a toolbar of buttons styled alike, so only each button's state tells a disabled one.
 * @returns the HTML
 */
export function controlsBody() {
    const buttons = CONTROLS.map(([name, off]) => `<button type="button" class="tb"${off ? " disabled" : ""}>${name}</button>`).join("\n            ");
    return `<style>.tb,.tb:disabled{font:inherit;padding:8px 14px;margin:4px;border:1px solid var(--line);border-radius:8px;
            background:var(--bg);color:var(--fg);opacity:1;cursor:pointer}</style>
        <p>Actions for the selected repository.</p>
        <div role="toolbar" aria-label="Repository actions">
            ${buttons}
        </div>`;
}

/** The Markdown version /docs/guide publishes of itself. */
export const GUIDE_MD = "/docs/guide.md";

/** /docs/guide's Markdown twin. */
export const GUIDE_MD_BODY = "# Getting started\n\nInstall the CLI, then run `acme init` in an empty folder.\n";

/** The tiles of /tiles, in order: what each shows. Only the canvases draw them, so the DOM does not say. */
export const TILES = ["blue circle", "red circle", "red square", "blue circle", "red circle", "green triangle", "blue circle", "green triangle", "red circle"];

/**
 * The /tiles page's body: nine numbered tiles, each a canvas with one shape drawn on it.
 * @returns the HTML
 */
export function tilesBody() {
    const cells = TILES.map((_, i) => `<figure class="tile"><canvas width="120" height="120"></canvas><figcaption>Tile ${i + 1}</figcaption></figure>`).join("");
    // Hue and shape as numbers, so a read of the script is no shortcut to the answer a look gives.
    const spec = JSON.stringify(TILES.map((t) => [t.startsWith("red") ? 0 : t.startsWith("blue") ? 220 : 130, t.endsWith("circle") ? 0 : t.endsWith("square") ? 1 : 2]));
    return `<style>.grid{display:grid;grid-template-columns:repeat(3,130px);gap:10px}.tile{margin:0;text-align:center}
            .tile canvas{background:#f4f4f6;border-radius:8px}.tile figcaption{font-size:13px;color:var(--dim)}</style>
        <p>Nine tiles, one shape each.</p>
        <div class="grid">${cells}</div>
        <script>JSON.parse(${JSON.stringify(spec)}).forEach(([h, s], i) => {
            const c = document.querySelectorAll(".tile canvas")[i].getContext("2d");
            c.fillStyle = "hsl(" + h + ",75%,48%)"; c.beginPath();
            if (s === 0) c.arc(60, 60, 38, 0, 7); else if (s === 1) c.rect(24, 24, 72, 72); else { c.moveTo(60, 18); c.lineTo(102, 98); c.lineTo(18, 98); }
            c.fill();
        });</script>`;
}
