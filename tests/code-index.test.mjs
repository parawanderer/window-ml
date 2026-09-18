// The code index (scripts/index.mjs): what it finds, what it deliberately does not, and that its cache cannot serve
// a stale answer. Run against FIXTURE sources in a temp directory rather than the repo, so a test never asserts a
// fact about a file someone is editing — the failure that makes an index test worthless is that it passes because
// the repo happens to look right today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "index.mjs");

/** A throwaway repo with a `src/` of its own, and the index script run inside it. */
function fixture(files) {
    const root = mkdtempSync(join(tmpdir(), "idx-"));
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(join(root, dirname(rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    // The script resolves ROOT from its own location, so it is copied in beside a `scripts/` of the fixture's own.
    mkdirSync(join(root, "scripts"), { recursive: true });
    const script = join(root, "scripts", "index.mjs");
    writeFileSync(script, execFileSync("cat", [SCRIPT], { encoding: "utf8" }));
    return {
        root,
        /** Run the index and return its stdout lines as split fields. Throws with stderr attached on a non-zero exit. */
        run: (...args) => execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" })
            .trim().split("\n").filter(Boolean).map((l) => l.split("\t")),
        stop: () => rmSync(root, { recursive: true, force: true }),
    };
}

const MOD = `// widget-store.ts — where a widget's bytes live once it is too big to keep in the message. Second sentence.
import { thing } from "./thing";

/** Put a widget away and answer with its key. */
export async function storeWidget(w: Widget, opts: { budget: number }): Promise<string> {
    const helper = 1;
    function nestedHelper() { return helper; }
    return "k";
}

/** Every backend we can talk to. */
export const WIDGET_FORMATS = {
    openai: { build: () => 1 },
    ollama: { build: () => 2 },
};

/** A widget's metadata row. */
export interface WidgetRow { key: string; bytes: number }

// a block above WINS over a trailing comment when a declaration has both
export const widgetCap = 64;   // ignored, because the block above says more

export const widgetFloor = 1;   // the smallest widget worth storing

export function undocumentedOne(a: number) { return a; }

/** Not exported: a private helper. */
function localOnly() { return 1; }

/** The store itself. */
export class WidgetStore {
    constructor() { /* */ }
    /** Read one. */
    async get(key: string) { return key; }
    private evict() { return 1; }
}
`;

test("index: module-scope declarations, with their signature and the first sentence of their docstring", async () => {
    const fx = fixture({ "src/widget-store.ts": MOD });
    try {
        const rows = fx.run("", "--sig");
        const by = (name) => rows.find((r) => r[1] === name);

        // THE FILE is a row of its own — the one that answers "is there already a module for this".
        assert.deepEqual(by("widget-store.ts").slice(0, 3), ["file", "widget-store.ts", "src/widget-store.ts:1"]);
        assert.equal(by("widget-store.ts")[4], "widget-store.ts — where a widget's bytes live once it is too big to keep in the message",
            "the header's FIRST sentence, not the whole block");

        const fn = by("storeWidget");
        assert.equal(fn[0], "function");
        assert.match(fn[3], /storeWidget\(w: Widget, opts: \{ budget: number \}\): Promise<string>/, "the whole head, body stripped");
        assert.equal(fn[4], "Put a widget away and answer with its key");

        // An object literal lists its OWN keys, one level deep — the API-surface case.
        assert.match(by("WIDGET_FORMATS")[3], /keys: openai, ollama$/);
        // A class lists its methods, and never its private ones' bodies.
        assert.match(by("WidgetStore")[3], /members: get, evict$/);
        assert.equal(by("WidgetStore")[0], "class");
        assert.equal(by("WidgetRow")[0], "type");

        // A TRAILING comment is the docstring for a one-line export — the house style here.
        assert.equal(by("widgetFloor")[4], "the smallest widget worth storing");
        // …and a block ABOVE still wins when a declaration carries both, since it is the fuller description.
        assert.equal(by("widgetCap")[4], "a block above WINS over a trailing comment when a declaration has both");
    } finally { fx.stop(); }
});

test("index: nested declarations are NOT indexed, because a binding's innards are not the unit of search", async () => {
    const fx = fixture({ "src/widget-store.ts": MOD });
    try {
        const names = fx.run("").map((r) => r[1]);
        assert.ok(!names.includes("nestedHelper"), "a function inside a function body is out of scope by design");
        assert.ok(!names.includes("build"), "a key of a key: one level deep, never recursive");
        assert.ok(names.includes("localOnly"), "…but a module-scope private IS indexed (find it with --local)");
    } finally { fx.stop(); }
});

test("index: --exported / --local split the module surface from its private helpers", async () => {
    const fx = fixture({ "src/widget-store.ts": MOD });
    try {
        assert.deepEqual(fx.run("", "--local", "--kind", "function").map((r) => r[1]), ["localOnly"]);
        assert.ok(fx.run("", "--exported").map((r) => r[1]).includes("storeWidget"));
        assert.ok(!fx.run("", "--exported").map((r) => r[1]).includes("localOnly"));
    } finally { fx.stop(); }
});

test("index: the query is a REGEX over the name, the summary and the path", async () => {
    const fx = fixture({ "src/widget-store.ts": MOD, "src/other.ts": "// other.ts — nothing to do with it.\nexport const q = 1;   // a thing\n" });
    try {
        // Matched on the SUMMARY, which is the point: nothing here is named "bytes".
        assert.ok(fx.run("bytes").some((r) => r[1] === "widget-store.ts"));
        // Alternation, which is why it is a regex rather than a substring.
        const names = fx.run("storeWidget|WidgetRow").map((r) => r[1]);
        assert.deepEqual(names.sort(), ["WidgetRow", "storeWidget"]);
        // Case-insensitive.
        assert.ok(fx.run("STOREWIDGET").length > 0);
        assert.equal(fx.run("zzz-no-such-thing").length, 0);
    } finally { fx.stop(); }
});

test("index: one row per CSS class, from the declaration that explains it", async () => {
    const fx = fixture({
        "src/sidebar/sidebar.css": "/* a compact chip that points at the live element */\n.am-chip { color: red }\n.am-chip:hover { color: blue }\n.am-chip.on { color: green }\n",
        "src/chat/chat.css": "/* the composer */\n.c-box { top: 0 }\n",
    });
    try {
        const chips = fx.run("am-chip", "--kind", "css");
        assert.equal(chips.length, 1, "not one row per :hover / modifier — that buries the documented one");
        assert.equal(chips[0][2], "src/sidebar/sidebar.css:2");
        assert.equal(chips[0][3], "a compact chip that points at the live element");
    } finally { fx.stop(); }
});

test("index: the cache serves a warm read and NEVER a stale one", async () => {
    const fx = fixture({ "src/widget-store.ts": MOD });
    try {
        const stats = () => Object.fromEntries(fx.run("--stats"));
        assert.equal(stats().rescanned, "1", "cold: the file is read");
        assert.equal(stats().rescanned, "0", "warm: served from .index-cache.tsv");

        // EDIT it: the answer must change, not the cache's idea of it.
        writeFileSync(join(fx.root, "src/widget-store.ts"), MOD.replace("storeWidget", "stashWidget"));
        assert.equal(stats().rescanned, "1", "the bytes changed, so it is rescanned");
        assert.ok(fx.run("stashWidget").length > 0, "and the new name is findable");
        assert.equal(fx.run("storeWidget").length, 0, "…while the old one is gone");

        // A BRANCH SWITCH rewrites mtimes without changing bytes. The hash is what decides, so this is not a rescan.
        const t = new Date(Date.now() + 60_000);
        utimesSync(join(fx.root, "src/widget-store.ts"), t, t);
        assert.equal(stats().rescanned, "0", "same bytes, new mtime: the content hash keeps the cached records");
    } finally { fx.stop(); }
});

test("index: --headerless and --undocumented name what nothing can find, and exit 1", async () => {
    const fx = fixture({ "src/nohead.ts": "export const x = 1;\n", "src/widget-store.ts": MOD });
    try {
        assert.throws(() => fx.run("--headerless"), /Command failed/, "a file with no header fails the check");
        let out = "";
        try { fx.run("--headerless"); } catch (e) { out = String(e.stdout); }
        assert.match(out, /src\/nohead\.ts:1\tNO HEADER COMMENT|src\/nohead\.ts:1\t— NO HEADER COMMENT/);

        try { fx.run("--undocumented"); } catch (e) { out = String(e.stdout); }
        assert.match(out, /undocumentedOne/, "an export with no docstring is invisible to a concept search");
        assert.ok(!/storeWidget/.test(out), "…and a documented one is not listed");
    } finally { fx.stop(); }
});

test("index: --check-speed reports a cold build and passes well inside its budget", async () => {
    const fx = fixture({ "src/widget-store.ts": MOD });
    try {
        const [line] = fx.run("--check-speed");
        // A ::notice, so the number lands on the diff as a trend rather than in a log.
        assert.match(line.join("\t"), /^::notice::The code index built in \d+ ms for 1 files, \d+ records .* inside its \d+ ms budget\.$/);
    } finally { fx.stop(); }
});
