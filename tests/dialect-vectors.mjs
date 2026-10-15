// dialect-vectors.mjs — reads and validates the shared dialect vectors (tests/fixtures/dialect-vectors/) for the tests that run them.

import { readFileSync } from "node:fs";

/** The genres, one JSON file each under `tests/fixtures/dialect-vectors/`. */
export const GENRES = ["abuse", "halting", "failure", "ownership", "print"];
/** The worlds a vector may name; a runner that lacks one skips the vector, never runs it elsewhere. */
export const ENVS = ["none", "dom", "answer", "table", "policy"];

const DIR = new URL("./fixtures/dialect-vectors/", import.meta.url);
const cache = new Map();

/**
 * Throws if `v` is not a vector as tests/fixtures/dialect-vectors/README.md defines it. `where` names the file and
 * position in the message.
 */
export function validateVector(v, where) {
    const bad = (why) => { throw new Error(`dialect vector ${where}: ${why}`); };
    if (!v || typeof v !== "object" || Array.isArray(v)) bad("not an object");
    for (const k of ["name", "env", "reason"]) if (typeof v[k] !== "string" || !v[k]) bad(`"${k}" must be a non-empty string`);
    if (v.js === undefined && v.py === undefined) bad("needs at least one of js, py");
    for (const k of ["js", "py"]) if (v[k] !== undefined && typeof v[k] !== "string") bad(`"${k}" must be a string`);
    if (!ENVS.includes(v.env)) bad(`unknown env "${v.env}" (known: ${ENVS.join(", ")})`);
    const e = v.expect;
    const okExpect = e === "refused" || e === "halts"
        || (e && typeof e === "object" && !Array.isArray(e) && Object.keys(e).length === 1 && "value" in e);
    if (!okExpect) bad(`"expect" must be "refused", "halts" or { "value": … }`);
    if (v.budget !== undefined && !(Number.isInteger(v.budget) && v.budget > 0)) bad(`"budget" must be a positive integer`);
    if (v.pre !== undefined) {
        if (!v.pre || typeof v.pre !== "object" || Array.isArray(v.pre)) bad(`"pre" must be an object`);
        for (const [k, p] of Object.entries(v.pre)) if (!["js", "py"].includes(k) || typeof p !== "string") bad(`"pre" takes js and py strings only`);
    }
    if (v.leaves_nothing !== undefined && v.leaves_nothing !== true) bad(`"leaves_nothing" is true when present`);
    if (v.from !== undefined && typeof v.from !== "string") bad(`"from" must be a string`);
    const known = new Set(["name", "js", "py", "env", "expect", "budget", "pre", "leaves_nothing", "reason", "from"]);
    for (const k of Object.keys(v)) if (!known.has(k)) bad(`unknown field "${k}"`);
}

/** Every vector of one genre, validated, with names unique within the file. Throws on a malformed one. */
export function loadVectors(genre) {
    if (!GENRES.includes(genre)) throw new Error(`unknown dialect-vector genre "${genre}"`);
    if (cache.has(genre)) return cache.get(genre);
    const file = `${genre}.json`;
    const all = JSON.parse(readFileSync(new URL(file, DIR), "utf8"));
    if (!Array.isArray(all)) throw new Error(`dialect vector file ${file}: not an array`);
    const seen = new Set();
    all.forEach((v, i) => {
        validateVector(v, `${file}[${i}]${v && v.name ? ` "${v.name}"` : ""}`);
        if (seen.has(v.name)) throw new Error(`dialect vector file ${file}: duplicate name "${v.name}"`);
        seen.add(v.name);
    });
    cache.set(genre, all);
    return all;
}

/**
 * The JS vectors of one genre that were lifted from `from` (the vector's own `from` field, exactly). Throws when none
 * match, so a renamed group fails loudly instead of running nothing.
 */
export function vectors(genre, from) {
    const hit = loadVectors(genre).filter((v) => v.from === from && v.js !== undefined);
    if (!hit.length) throw new Error(`no ${genre} vector with js has from "${from}"`);
    return hit;
}
