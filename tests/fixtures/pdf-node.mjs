// pdf-node.mjs — pdf.js's legacy build as the PDF tests load it in node, with its run-time files from node_modules.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const { pdfLib } = await import("../../src/pdf/pdf-lib.ts");
/** The directories pdf.js reads wasm, cmaps and standard fonts from (file paths with a trailing slash, as node wants). */
export const assets = Object.fromEntries([["wasm", "wasm"], ["cmaps", "cmaps"], ["fonts", "standard_fonts"], ["icc", "iccs"]].map(([k, d]) => [k, `${join(root, "node_modules", "pdfjs-dist", d)}/`]));
/** The bytes of a committed fixture (tests/fixtures/pdf/<name>). */
export const fixture = (name) => new Uint8Array(readFileSync(join(root, "tests", "fixtures", "pdf", name)));
