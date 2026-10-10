// cli-help.mjs — a bench script's `--help`: the comment block that opens the script, printed as text, so the usage a
// person or a model reads at the terminal and the one a reader of the source sees are the same lines. A test holds every
// flag a script parses to appearing in it (tests/bench-cli-help.test.mjs).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The opening `//` comment block of the file at `url` (an import.meta.url), less the `// ` marks. */
export function headerHelp(url) {
    const lines = readFileSync(fileURLToPath(url), "utf8").split("\n");
    const out = [];
    for (const l of lines) {
        if (!l.startsWith("//")) break;
        out.push(l.replace(/^\/\/ ?/, ""));
    }
    return out.join("\n").trimEnd() + "\n";
}

/** Every `--flag` a script's source compares an argument against (`a === "--x"`, `argv[0] === "--x"`), sorted. */
export const parsedFlags = (source) => [...new Set([...source.matchAll(/(?:\ba|argv\[\d\]) === "(--[a-z][a-z-]*)"/g)].map((m) => m[1]))].sort();
