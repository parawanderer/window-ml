// The subset validator both schema tests use. Extracted the moment there were two: a second copy of a
// validator is how two tests come to disagree about what the schema says, which is the failure the
// generated schema exists to prevent one level up.
/**
 * A DELIBERATELY SMALL subset validator: `$ref`, `required`, `type`, `enum`, `const`, `items`,
 * `prefixItems`, `anyOf`. Not a JSON Schema implementation, and not trying to be — a consumer should use
 * a real one. Its job here is to catch the generated schema drifting from the documents we emit, and
 * those are the keywords the generator actually produces.
 *
 * @returns {string[]} paths that failed, empty when the document conforms
 */
export function validate(doc, schema, root = schema, path = "$") {
    const errs = [];
    if (schema.$ref) {
        const name = schema.$ref.replace("#/$defs/", "");
        const target = root.$defs?.[name];
        if (!target) return [`${path}: dangling $ref ${schema.$ref}`];
        return validate(doc, target, root, path);
    }
    if (schema.anyOf) {
        return schema.anyOf.some((s) => validate(doc, s, root, path).length === 0)
            ? [] : [`${path}: matched none of anyOf`];
    }
    const types = schema.type ? (Array.isArray(schema.type) ? schema.type : [schema.type]) : null;
    if (types) {
        const actual = doc === null ? "null" : Array.isArray(doc) ? "array" : typeof doc;
        const ok = types.some((t) => t === actual || (t === "number" && actual === "number") || (t === "integer" && Number.isInteger(doc)));
        if (!ok) return [`${path}: expected ${types.join("|")}, got ${actual}`];
    }
    if (schema.enum && !schema.enum.includes(doc)) errs.push(`${path}: ${JSON.stringify(doc)} not in enum`);
    if ("const" in schema && doc !== schema.const) errs.push(`${path}: expected const ${schema.const}`);

    if (types?.includes("object") && doc && typeof doc === "object" && !Array.isArray(doc)) {
        for (const r of schema.required || []) {
            if (!(r in doc)) errs.push(`${path}.${r}: required but missing`);
        }
        for (const [k, v] of Object.entries(doc)) {
            const sub = schema.properties?.[k];
            if (sub) errs.push(...validate(v, sub, root, `${path}.${k}`));
        }
    }
    if (types?.includes("array") && Array.isArray(doc)) {
        if (schema.prefixItems) {
            schema.prefixItems.forEach((s, i) => errs.push(...validate(doc[i], s, root, `${path}[${i}]`)));
        } else if (schema.items) {
            doc.forEach((v, i) => errs.push(...validate(v, schema.items, root, `${path}[${i}]`)));
        }
    }
    return errs;
}
