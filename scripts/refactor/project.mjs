// The TypeScript PROJECT the refactor tools work on: a language service over the repo's own tsconfig, with every
// edit held IN MEMORY until `flush()`. That is what makes a dry run exact rather than a guess — the plan, the
// cycle check and the typecheck all read the program as it would be after the move, and nothing touches the disk
// unless all of them pass.
//
// It runs on the TypeScript that `@ts-morph/common` bundles (6.x), not the repo's own `typescript`: 7.x is the Go
// port, whose npm package has no JS language-service API and whose language server offers no move refactor yet
// (checked on 7.0.2 and 7.1.0-dev.20260916.1). Swap this for the Go server once it does. NOT an npm alias of
// typescript@6: that package ships its own `tsc` bin, which replaced 7.x's in node_modules/.bin and turned
// `npm run typecheck` into a TypeScript 6 run with 346 errors.
import tsMorphCommon from "@ts-morph/common";
import fs from "node:fs";
import path from "node:path";

/** @type {typeof import("@ts-morph/common").ts} */
const ts = tsMorphCommon.ts;
export { ts };

/** The repo's layout: 4-space indent, double quotes, and whatever specifier ending the importing file already uses
 *  (extensionless inside src/, `.ts` in the tests). */
export const FORMAT = { ...ts.getDefaultFormatCodeSettings("\n"), indentSize: 4, tabSize: 4, convertTabsToSpaces: true };
export const PREFS = { quotePreference: "double", importModuleSpecifierEnding: "auto", allowImportingTsExtensions: true };

/** A language service over one tsconfig whose file contents can be edited in memory. */
export class Project {
    /**
     * @param {string} root the repo root; relative paths everywhere else resolve against it.
     * @param {string} [tsconfig] relative to root.
     */
    constructor(root, tsconfig = "tsconfig.json") {
        this.root = path.resolve(root);
        const configPath = path.join(this.root, tsconfig);
        const cfg = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); },
        });
        if (!cfg) throw new Error(`cannot read ${configPath}`);
        this.options = cfg.options;
        /** @type {Set<string>} */
        this.names = new Set(cfg.fileNames.map((f) => path.resolve(f)));
        /** In-memory contents, keyed by absolute path. A file absent here reads from disk. @type {Map<string, {text: string, version: number}>} */
        this.edits = new Map();
        const host = {
            getCompilationSettings: () => this.options,
            getScriptFileNames: () => [...this.names],
            getScriptVersion: (f) => String(this.edits.get(path.resolve(f))?.version ?? 0),
            getScriptSnapshot: (f) => {
                const text = this.read(f);
                return text == null ? undefined : ts.ScriptSnapshot.fromString(text);
            },
            getCurrentDirectory: () => this.root,
            getDefaultLibFileName: ts.getDefaultLibFilePath,
            fileExists: (f) => this.read(f) != null,
            readFile: (f) => this.read(f) ?? undefined,
            readDirectory: ts.sys.readDirectory,
            // A directory that exists only because an in-memory file lives in it — a move into a new `src/util/`.
            // Without this, module resolution refuses every import of the new file.
            directoryExists: (d) => ts.sys.directoryExists(d) || [...this.edits.keys()].some((f) => f.startsWith(path.resolve(d) + path.sep)),
            getDirectories: ts.sys.getDirectories,
            realpath: ts.sys.realpath,
        };
        this.ls = ts.createLanguageService(host, ts.createDocumentRegistry());
    }

    /** Absolute path for a root-relative one. @param {string} p */
    abs(p) { return path.resolve(this.root, p); }

    /** Root-relative path, forward slashes. @param {string} p */
    rel(p) { return path.relative(this.root, p).split(path.sep).join("/"); }

    /** The file's current text (in-memory edit first, then disk), or null when it exists in neither. @param {string} f */
    read(f) {
        const a = path.resolve(f);
        const e = this.edits.get(a);
        if (e) return e.text;
        try { return fs.readFileSync(a, "utf8"); } catch { return null; }
    }

    /** Replace a file's text in memory, adding it to the program if new. @param {string} f @param {string} text */
    write(f, text) {
        const a = path.resolve(f);
        const prev = this.edits.get(a);
        this.edits.set(a, { text, version: (prev?.version ?? 0) + 1 });
        this.names.add(a);
    }

    /** @returns {ts.Program} */
    program() {
        const p = this.ls.getProgram();
        if (!p) throw new Error("the language service has no program");
        return p;
    }

    /** @param {string} f @returns {ts.SourceFile} */
    sourceFile(f) {
        const sf = this.program().getSourceFile(path.resolve(f));
        if (!sf) throw new Error(`${this.rel(f)} is not part of the program (is it in tsconfig's include?)`);
        return sf;
    }

    /** Apply a language-service edit set in memory. @param {readonly ts.FileTextChanges[]} changes */
    apply(changes) {
        for (const fc of changes) this.write(fc.fileName, applyTextChanges(this.read(fc.fileName) ?? "", fc.textChanges));
    }

    /** Files whose in-memory text differs from the disk, with both texts. `before` is null for a new file. */
    changed() {
        const out = [];
        for (const [f, e] of this.edits) {
            let before = null;
            try { before = fs.readFileSync(f, "utf8"); } catch { /* new file */ }
            if (before !== e.text) out.push({ file: f, before, after: e.text });
        }
        return out;
    }

    /** Write every in-memory change to disk. */
    flush() {
        for (const { file, after } of this.changed()) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, after);
        }
    }

    /** Syntactic + semantic diagnostics for some files, as position-free strings so two states of the program can
     *  be compared by multiset. A file the program does not hold contributes nothing. @param {Iterable<string>} files */
    diagnostics(files) {
        const out = [];
        for (const f of files) {
            const a = path.resolve(f);
            if (!this.program().getSourceFile(a)) continue;
            for (const d of [...this.ls.getSyntacticDiagnostics(a), ...this.ls.getSemanticDiagnostics(a)]) {
                const where = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
                out.push({ file: this.rel(a), line: where, code: d.code, message: ts.flattenDiagnosticMessageText(d.messageText, " ") });
            }
        }
        return out;
    }
}

/** Apply text changes (spans into the ORIGINAL text) back to front. Two insertions at the same position keep their
 *  listed order in the result — the refactor emits "new import" then "`export ` before the first statement" both at
 *  offset 0, and reversing them produces `export import …`. @param {string} text @param {readonly ts.TextChange[]} changes */
export function applyTextChanges(text, changes) {
    let out = text;
    const indexed = changes.map((c, i) => ({ c, i }));
    for (const { c } of indexed.sort((a, b) => b.c.span.start - a.c.span.start || b.i - a.i)) {
        out = out.slice(0, c.span.start) + c.newText + out.slice(c.span.start + c.span.length);
    }
    return out;
}
