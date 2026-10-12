// lab.test.mjs — the rule for LAB code (src/lab/<topic>/: research modules that live here but are not for window.ml,
// AGENTS.md): each topic stands alone, importing nothing outside its own folder, so lifting it into another project is
// a copy rather than a refactor. One test over every folder, so a new topic is covered the day it lands.
import { test } from "node:test";
import assert from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";

const LAB = new URL("../src/lab/", import.meta.url);

/** Every source file under a folder, recursively, as URLs. */
function files(dir) {
    return readdirSync(dir).flatMap((f) => {
        const u = new URL(f, dir);
        return statSync(u).isDirectory() ? files(new URL(`${f}/`, dir)) : /\.(m?[jt]sx?)$/.test(f) ? [u] : [];
    });
}

/** The module specifiers a source file imports or re-exports, static and dynamic. */
function specifiers(src) {
    return [
        ...src.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
        ...src.matchAll(/^\s*import\s+["']([^"']+)["']/gm),
        ...src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g),
    ].map((m) => m[1]);
}

// --- every lab topic stands alone ------------------------------------------------------------------------------------

test("there is at least one lab topic, and the gradient fills are one", () => {
    const topics = readdirSync(LAB).filter((t) => statSync(new URL(`${t}/`, LAB)).isDirectory());
    assert.ok(topics.includes("gradient"), `lab topics: ${topics.join(", ")}`);
});

test("nothing in a lab topic imports from outside its own folder (no packages, no other topic, no window.ml)", () => {
    for (const topic of readdirSync(LAB).filter((t) => statSync(new URL(`${t}/`, LAB)).isDirectory())) {
        const root = new URL(`${topic}/`, LAB);
        for (const f of files(root)) {
            for (const spec of specifiers(readFileSync(f, "utf8"))) {
                const where = `src/lab/${topic}/${f.pathname.slice(root.pathname.length)} imports ${spec}`;
                assert.ok(spec.startsWith("./") || spec.startsWith("../"), `${where}: a lab module uses relative imports only`);
                assert.ok(new URL(spec, f).pathname.startsWith(root.pathname), `${where}: outside its topic`);
            }
        }
    }
});

test("the import scan sees every import form, so the rule cannot pass by missing one", () => {
    const src = `import { a } from "./x";\nimport "./side";\nexport * from "../other/y";\nconst m = await import("preact");\nimport type { T } from "./t";`;
    assert.deepStrictEqual(specifiers(src).sort(), ["../other/y", "./side", "./t", "./x", "preact"].sort());
});
