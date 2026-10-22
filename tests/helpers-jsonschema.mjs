// helpers-jsonschema.mjs — a draft 2020-12 subset validator wide enough for the manifest schemas (conditionals, patterns, propertyNames, closed objects), which refuses a keyword it does not implement.

// tests/helpers-validate.mjs is the small one for the generated export schemas (no `additionalProperties`, no `if`).
// The manifest schemas are CLOSED and conditional, so a validator that skipped those keywords would call every
// invalid manifest valid. This one THROWS on a keyword it does not know, so a schema that grows a keyword the test
// cannot check fails loudly instead of passing. Not a JSON Schema implementation: a consumer should use a real one.

/** Keywords that annotate and never constrain (`format` is an annotation in 2020-12 unless asserted). */
const ANNOTATIONS = new Set(["$schema", "$id", "$defs", "title", "description", "default", "examples", "format", "x-schemaVersion", "x-unstable"]);

const typeOf = (v) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
const isType = (v, t) => t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" : typeOf(v) === t;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Validate `doc` against `schema`.
 * @returns {string[]} one message per failure, empty when the document conforms
 */
export function validateSchema(doc, schema, root = schema, path = "$") {
    if (schema === true) return [];
    if (schema === false) return [`${path}: not allowed`];
    const errs = [];
    const sub = (d, s, p) => validateSchema(d, s, root, p);
    for (const k of Object.keys(schema)) {
        if (ANNOTATIONS.has(k) || k === "then" || k === "else") continue;
        const v = schema[k];
        switch (k) {
            case "$ref": {
                const m = /^#\/\$defs\/(.+)$/.exec(v);
                const target = m && root.$defs?.[m[1]];
                if (!target) errs.push(`${path}: dangling $ref ${v}`); else errs.push(...sub(doc, target, path));
                break;
            }
            case "type": if (![].concat(v).some((t) => isType(doc, t))) errs.push(`${path}: expected ${[].concat(v).join("|")}, got ${typeOf(doc)}`); break;
            case "enum": if (!v.some((x) => same(x, doc))) errs.push(`${path}: ${JSON.stringify(doc)} not in enum`); break;
            case "const": if (!same(v, doc)) errs.push(`${path}: expected const ${JSON.stringify(v)}`); break;
            case "pattern": if (typeof doc === "string" && !new RegExp(v, "u").test(doc)) errs.push(`${path}: ${JSON.stringify(doc)} does not match ${v}`); break;
            case "minLength": if (typeof doc === "string" && [...doc].length < v) errs.push(`${path}: shorter than ${v}`); break;
            case "maxLength": if (typeof doc === "string" && [...doc].length > v) errs.push(`${path}: longer than ${v}`); break;
            case "minimum": if (typeof doc === "number" && doc < v) errs.push(`${path}: below ${v}`); break;
            case "maximum": if (typeof doc === "number" && doc > v) errs.push(`${path}: above ${v}`); break;
            case "minItems": if (Array.isArray(doc) && doc.length < v) errs.push(`${path}: fewer than ${v} items`); break;
            case "maxItems": if (Array.isArray(doc) && doc.length > v) errs.push(`${path}: more than ${v} items`); break;
            case "items": if (Array.isArray(doc)) doc.forEach((x, i) => errs.push(...sub(x, v, `${path}[${i}]`))); break;
            case "contains": if (Array.isArray(doc) && !doc.some((x) => sub(x, v, path).length === 0)) errs.push(`${path}: no item matches contains`); break;
            case "required": if (typeOf(doc) === "object") for (const r of v) if (!(r in doc)) errs.push(`${path}.${r}: required but missing`); break;
            case "properties": if (typeOf(doc) === "object") for (const [n, s] of Object.entries(v)) if (n in doc) errs.push(...sub(doc[n], s, `${path}.${n}`)); break;
            case "additionalProperties":
                if (typeOf(doc) === "object") for (const n of Object.keys(doc)) {
                    if (schema.properties && n in schema.properties) continue;
                    errs.push(...(v === false ? [`${path}: unknown key ${n}`] : sub(doc[n], v, `${path}.${n}`)));
                }
                break;
            case "propertyNames": if (typeOf(doc) === "object") for (const n of Object.keys(doc)) errs.push(...sub(n, v, `${path}{${n}}`)); break;
            case "anyOf": if (!v.some((s) => sub(doc, s, path).length === 0)) errs.push(`${path}: matched none of anyOf`); break;
            case "oneOf": { const n = v.filter((s) => sub(doc, s, path).length === 0).length; if (n !== 1) errs.push(`${path}: matched ${n} of oneOf`); break; }
            case "allOf": for (const s of v) errs.push(...sub(doc, s, path)); break;
            case "not": if (sub(doc, v, path).length === 0) errs.push(`${path}: matched a "not"`); break;
            case "if": {
                const branch = sub(doc, v, path).length === 0 ? schema.then : schema.else;
                if (branch !== undefined) errs.push(...sub(doc, branch, path));
                break;
            }
            default: throw new Error(`helpers-jsonschema: keyword "${k}" at ${path} is not implemented — add it (with a test) before relying on this schema`);
        }
    }
    return errs;
}
