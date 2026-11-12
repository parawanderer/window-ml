// no-cdn-fetch.mjs — a test never downloads a Pyodide wheel. Under Node, Pyodide falls back to its CDN for a wheel
// missing from dist/pyodide (and caches it into node_modules); that fetch once hung a suite for 40 minutes. This
// refuses it at once, naming the wheel and the fix. It is preloaded with --import by scripts/test.mjs and `npm run
// coverage` (so every test file, and the worker threads and children that inherit their execArgv, has it), and passed
// by NO_CDN_URL to each child a test launches with its own argv to load Pyodide. tests/pyodide-no-cdn.test.mjs
// enumerates those paths.

/** This module's URL, for a test that launches a child with its own argv: `["--import", NO_CDN_URL, …]`. */
export const NO_CDN_URL = import.meta.url;

const CDN = /^https?:\/\/cdn\.jsdelivr\.net\/pyodide\//;
const real = globalThis.fetch;
if (real && !real.wmlNoCdn) {
    const guarded = function fetch(input, init) {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
        if (typeof url === "string" && CDN.test(url)) {
            const file = url.slice(url.lastIndexOf("/") + 1);
            return Promise.reject(new Error(`${file} is not in dist/pyodide: run \`npm run fetch-pyodide\`, then \`npm run build\`. A test never fetches a wheel from the Pyodide CDN (tests/no-cdn-fetch.mjs).`));
        }
        return real.call(this, input, init);
    };
    guarded.wmlNoCdn = true;
    globalThis.fetch = guarded;
}
