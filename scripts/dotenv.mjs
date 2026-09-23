// dotenv.mjs — READ THE REPO'S `.env`, for the scripts that talk to something real: the live probes, the bench, the
// account's root device. Zero dependency, and a missing file is an empty object rather than an error, so nothing here
// has to guard its own absence.
//
// A real environment variable WINS over the file, which is the precedence `.env.example` promises and the only one
// that lets `WINDOWML_HUB=… node scripts/…` override a checked-out default for one command.
//
// `tests/helpers.js` has a CommonJS twin (`loadDotEnv`) that does a different job: it writes the pairs INTO
// `process.env` for the opt-in live tests, which run under `node:test` and read them from there. This one returns
// them, because a script wants one value and not a mutated global.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The repo's `.env` as an object, or `{}` when there is none.
 *
 * Splits on the FIRST `=` only — a key or a token may contain one — and strips a single layer of surrounding quotes,
 * leaving anything else (a `#` inside a value included) intact.
 */
export function readDotenv(file = path.join(ROOT, ".env")) {
    let text;
    try { text = readFileSync(file, "utf8"); } catch { return {}; }
    return Object.fromEntries(text.split("\n").flatMap((raw) => {
        const line = raw.trim();
        if (!line || line.startsWith("#")) return [];
        const eq = line.indexOf("=");
        if (eq === -1) return [];
        const key = line.slice(0, eq).replace(/^export\s+/, "").trim();
        if (!key) return [];
        return [[key, line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2")]];
    }));
}

/** One setting: the real environment first, then `.env`, then whatever the caller will settle for. */
export function fromEnv(key, fallback = "") {
    return process.env[key] || readDotenv()[key] || fallback;
}
