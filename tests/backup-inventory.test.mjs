// The backup inventory (src/backup/backup-inventory.ts) against the sources: every storage key the code uses is
// classified, and every classification names a key the code still uses. A new preference fails here until someone
// decides whether it belongs in a backup (docs/dev/backup.md, "Backup and restore").
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { scan, markIndex } from "../scripts/js-scan.mjs";
import { CONFIG_KEYS, INVENTORY, OTHER_STORES, classify, inventoryCounts } from "../src/backup/backup-inventory.ts";
import { DEFAULT_CONFIG } from "../src/contract/contract-config.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(ROOT, "src");
const INVENTORY_FILE = path.join("src", "backup", "backup-inventory.ts");

// --- reading the sources ---

/** Every .ts/.tsx file under `dir` (declaration files and the generated api docs excluded), as `{ file, text }`. */
function sources(dir = SRC, out = []) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) sources(full, out);
        else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith(".d.ts") && !e.name.endsWith(".gen.ts")) out.push({ file: path.relative(ROOT, full), text: readFileSync(full, "utf8") });
    }
    return out;
}

let cache;
/** The sources, scanned once for the whole file: comments blanked, strings lifted out. */
function scanned() {
    // The inventory file itself is not a use: its strings are the answers, and counting them would make every entry look used.
    cache ??= sources().filter((f) => f.file !== INVENTORY_FILE && /ml_|storage/.test(f.text)).map(({ file, text }) => ({ file, text, ...scan(text) }));
    return cache;
}

const fromText = (file, text) => ({ file, text, ...scan(text) });

const KEY_SHAPE = /^ml_[A-Za-z0-9_:.-]*$/;

/**
 * Every string in the sources shaped like one of our storage keys (`ml_...`): a whole literal is an EXACT key, one that
 * ends in `_` or `:` is a PREFIX, and a template literal contributes the constant text before its first `${` as a
 * prefix. Comments are not read. Returns `{ token, prefix, where }` for each use.
 */
export function keyTokens(files = scanned()) {
    const out = [];
    for (const { file, strings } of files) {
        for (const s of strings) {
            const interpolated = s.value == null;
            const v = interpolated ? s.head : s.value;
            if (!v || !KEY_SHAPE.test(v)) continue;
            out.push({ token: v, prefix: interpolated || /[_:]$/.test(v), where: `${file}:${s.line}` });
        }
    }
    return out;
}

/**
 * The keys named at the call sites of `chrome.storage.<area>.get|set|remove`: an object's own keys (`set({ a: 1 })`,
 * `get({ a: 0 })`), a string argument and the strings of an array argument. A computed key (`[KEY]`) is not read here;
 * the constant it names is a `ml_` token, found by `keyTokens`. Returns `{ area, key, where }`.
 */
export function callKeys(files = scanned()) {
    const out = [];
    for (const { file, code, strings } of files) {
        const str = (tok) => { const m = /^\0(\d+)\0$/.exec(tok); return m ? strings[markIndex(tok)].value : null; };
        const re = /storage\??\.(sync|local|session)\??\.(?:get|set|remove)\(/g;
        for (let m; (m = re.exec(code));) {
            const area = m[1];
            const stack = ["("];   // the call's own paren is stack[0]; "F" is a function body
            const line = code.slice(0, m.index).split("\n").length;
            const add = (key) => { if (key != null) out.push({ area, key, where: `${file}:${line}` }); };
            const before = (i) => code.slice(0, i).trimEnd().slice(-2);
            for (let i = re.lastIndex; i < code.length && stack.length; i++) {
                const c = code[i];
                const top = stack[stack.length - 1];
                const asKey = () => /[{,]$/.test(before(i).slice(-1)) && stack.length === 2 && top === "{";
                if (c === "\0") {
                    const end = code.indexOf("\0", i + 1);
                    const tok = code.slice(i, end + 1);
                    const next = code.slice(end + 1).match(/^\s*(:)/)?.[1];
                    // a string argument, a string in a top-level array, or a quoted key of the top-level object
                    if (stack.length === 1 || (stack.length === 2 && top === "[")) add(str(tok));
                    else if (asKey() && next === ":") add(str(tok));
                    i = end;
                    continue;
                }
                if (c === "{") { stack.push(before(i) === "=>" ? "F" : "{"); continue; }
                if (c === "(" || c === "[") { stack.push(c); continue; }
                if (c === ")" || c === "]" || c === "}") { stack.pop(); continue; }
                // an unquoted key of the call's object: `{ model: "" }` or `, utilityModel: ""`
                if (/[A-Za-z_$]/.test(c) && asKey() && !/[\w$]/.test(code[i - 1] ?? "")) {
                    const id = /^[A-Za-z_$][\w$]*/.exec(code.slice(i))[0];
                    if (/^\s*:/.test(code.slice(i + id.length))) add(id);
                    i += id.length - 1;
                }
            }
        }
    }
    return out;
}

// --- the inventory against the sources ---

const where = (xs) => xs.slice(0, 3).join(", ");

test("every ml_ storage key in src/ is classified", () => {
    const missing = new Map();
    for (const t of keyTokens()) {
        const hit = INVENTORY.some((e) => (e.prefix ? t.token.startsWith(e.key) : t.token === e.key));
        if (!hit) (missing.get(t.token) ?? missing.set(t.token, []).get(t.token)).push(t.where);
    }
    assert.deepEqual([...missing].map(([k, w]) => `${k} (${where(w)})`), [],
        "classify these in src/backup/backup-inventory.ts: backed up, or never with the reason");
});

test("every inventory entry names a key some source still uses", () => {
    const tokens = keyTokens();
    const stale = INVENTORY.filter((e) => !tokens.some((t) => (e.prefix ? t.token.startsWith(e.key) : t.token === e.key)));
    assert.deepEqual(stale.map((e) => e.key), [], "remove these entries: no source names them");
});

test("every key at a storage call site is classified in its area (sync: DEFAULT_CONFIG or the inventory)", () => {
    const unknown = [];
    for (const { area, key, where: w } of callKeys()) if (!classify(area, key)) unknown.push(`${area}:${key} (${w})`);
    assert.deepEqual(unknown, []);
});

test("the call-site scan sees the calls it must (a scan that finds nothing would pass the test above)", () => {
    const found = new Set(callKeys().map((c) => `${c.area}:${c.key}`));
    for (const k of ["sync:debugMode", "sync:model", "sync:pageApprovalDomains", "sync:sessionArchive", "sync:theme"])
        assert.ok(found.has(k), `the scan found ${k}`);
    // A key reached only through a constant: the ml_ token scan has it instead.
    assert.ok(keyTokens().some((t) => t.token === "ml_site_always"));
    assert.ok(keyTokens().some((t) => t.token === "ml_session_" && t.prefix), "a template prefix is read: `ml_session_${hash}`");
    assert.ok(callKeys().length > 15);
});

test("each entry is well-formed, and none is listed twice", () => {
    const seen = new Set();
    for (const e of INVENTORY) {
        assert.ok(e.why && e.why.length > 8, `${e.key} has a reason`);
        assert.ok(e.areas.length, `${e.key} names an area`);
        assert.ok(!seen.has(e.key), `${e.key} is listed once`);
        seen.add(e.key);
        if (e.backup === "yes") assert.ok(e.areas.some((a) => a === "local" || a === "sync"), `${e.key}: a backed-up key must live in sync or local`);
        if (e.backup !== "never") assert.ok(e.mode, `${e.key}: a backed-up key says how a restore treats it`);
        assert.ok(!e.prefix || /[_:]$/.test(e.key), `${e.key}: a prefix ends in _ or :`);
    }
});

test("storage.session is never backed up", () => {
    for (const e of INVENTORY) if (e.areas.includes("session") && e.backup !== "never") assert.equal(e.key, "ml_site_agents", "the only key with a backed-up half in session-straddling storage");
    for (const e of INVENTORY) if (e.areas.length === 1 && e.areas[0] === "session") assert.equal(e.backup, "never", e.key);
    assert.equal(classify("session", "ml_site_session").backup, "never");
    // The one key that straddles: its session half is not what a backup reads (a backup reads local and sync only).
    assert.equal(classify("local", "ml_site_agents").backup, "yes");
});

// --- the config and the secrets ---

test("the config is classified from DEFAULT_CONFIG: every key backed up, the API key only when encrypted", () => {
    assert.deepEqual(CONFIG_KEYS, Object.keys(DEFAULT_CONFIG));
    for (const k of CONFIG_KEYS) assert.equal(classify("sync", k).backup, k === "apiKey" ? "if-encrypted" : "yes", k);
    assert.equal(classify("sync", "notAConfigKey"), null);
    assert.equal(classify("local", "apiKey"), null, "a key is classified in its own area only");
});

test("the hub pairing, run state, logs and a chat's own record are never backed up", () => {
    for (const k of ["ml_bgrun_abc", "ml_session_deadbeef", "ml_hub_log", "ml_run_log", "ml_policies_run", "ml_answer:r1"])
        assert.equal(classify(k.startsWith("ml_run_log") || k.startsWith("ml_answer") ? "session" : "local", k)?.backup, "never", k);
});

test("the policies and site lists a backup carries are the ones a person set", () => {
    const yes = INVENTORY.filter((e) => e.backup === "yes" && (e.group === "policies" || e.group === "sites")).map((e) => e.key).sort();
    assert.deepEqual(yes, ["ml_policies_global", "ml_site_agents", "ml_site_always", "ml_site_denied", "ml_site_schema", "ml_site_selfapprove", "ml_site_visible"]);
});

test("the other stores (IndexedDB, OPFS) each name a store a source opens", () => {
    const all = sources().filter((s) => s.file !== INVENTORY_FILE).map((s) => s.text).join("\n");
    for (const s of OTHER_STORES) assert.ok(all.includes(`"${s.name}"`) || all.includes(`'${s.name}'`), `${s.name} is a store the sources open`);
});

test("the counts the docs quote", () => {
    const n = inventoryCounts();
    assert.equal(n["if-encrypted"], 1);
    assert.equal(n.yes + n.never + n["if-encrypted"], CONFIG_KEYS.length + INVENTORY.length);
});

// --- fail first: the test above really does fail on a key nobody classified ---

test("a storage key nobody classified is caught, and so is a stale entry", () => {
    const fake = [fromText("src/fake.ts", 'const K = "ml_brand_new_pref"; chrome.storage.local.set({ [K]: 1 }); chrome.storage.sync.set({ madeUpSetting: 1 }); chrome.storage.local.get("literal_key"); chrome.storage.local.set({ "quoted_key": 1 }); chrome.storage.local.get([\'in_array\'], (got) => { const x = { not_a_key: 1 }; });')];
    const unclassified = keyTokens(fake).filter((t) => !INVENTORY.some((e) => (e.prefix ? t.token.startsWith(e.key) : t.token === e.key)));
    assert.deepEqual(unclassified.map((t) => t.token), ["ml_brand_new_pref"]);
    const calls = callKeys(fake).filter((c) => !classify(c.area, c.key)).map((c) => `${c.area}:${c.key}`);
    assert.deepEqual(calls.sort(), ["local:in_array", "local:literal_key", "local:quoted_key", "sync:madeUpSetting"]);
    // A prefix use is read from a template.
    assert.deepEqual(keyTokens([fromText("x.ts", "const k = `ml_chat_${h}`;")]).map((t) => [t.token, t.prefix]), [["ml_chat_", true]]);
    // A comment is not a use.
    assert.deepEqual(keyTokens([fromText("x.ts", "// see `ml_in_a_comment`\nconst a = 1;")]), []);
});
