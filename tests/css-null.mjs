// A node module resolver that maps `*.css` imports to an empty JS module — so a source file that imports
// a bundled stylesheet (esbuild's css loader) can be imported directly under tsx in a test. Registered by
// the test via `module.register(...)` before dynamically importing the module under test.
export function resolve(specifier, context, next) {
    if (specifier.endsWith(".css")) return { url: "data:text/javascript,export default ''", shortCircuit: true };
    return next(specifier, context);
}
