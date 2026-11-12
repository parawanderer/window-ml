// no-cdn-fetch.mjs — a test never downloads a Pyodide wheel. Under Node, Pyodide falls back to its CDN for a wheel
// missing from dist/pyodide (and caches it into node_modules); that fetch once hung a suite for 40 minutes. This
// refuses it at once, naming the wheel and the fix. scripts/test.mjs preloads it with --import, so every test file,
// child process and worker thread has it; tests/pyodide-no-cdn.test.mjs holds it.

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
