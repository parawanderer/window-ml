// Neutralize `.css` imports so a source module that pulls in a bundled stylesheet (sidebar/export.ts →
// an hljs theme) can be imported under tsx in a plain Node test. It must cover BOTH loader paths, because
// tsx routes a `.ts` file through ESM or CJS depending on the Node/tsx version (the repo has no
// `"type": "module"`, so there's no single answer — CI saw Node 24 go ESM but 22/26 go CJS):
//   • CJS require: a bare `.css` require has no handler, so Node falls through to the `.js` handler (tsx's
//     transformer), which tries to parse the stylesheet as JS → `SyntaxError: Unexpected identifier`.
//     Register a `.css` extension that returns an empty module BEFORE that fallback can fire.
//   • ESM import: the css-null.mjs `resolve` hook shortcircuits `.css` to an empty module.
// Import this (statically, so it runs before the module under test) instead of registering the hook alone.
import Module from "node:module";
import { register } from "node:module";

Module._extensions[".css"] = (module) => { module.exports = ""; };   // CJS require path
register(new URL("./css-null.mjs", import.meta.url));                 // ESM import path
