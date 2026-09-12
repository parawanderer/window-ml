// CodeMirror for the Python bench, built as its OWN bundle and loaded only when that tab is opened.
//
// Measured at ~395 KB minified against a 694 KB sidebar-app, so bundling it in would grow the app by
// more than half — and sidebar-app loads in an iframe on every page the overlay mounts on, for a tab
// most sessions never open. Hence a separate entry, fetched on demand.
//
// It attaches to `window` rather than exporting, because every entry here is IIFE (content and
// injected scripts have to be classic scripts) so there is no module graph to import into.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { globalCompletion, localCompletionSource, python } from "@codemirror/lang-python";
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting, syntaxTree } from "@codemirror/language";
import { Compartment, EditorState, RangeSet, StateEffect, type StateEffectType, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, GutterMarker, drawSelection, gutterLineClass, highlightActiveLine, keymap, lineNumbers, placeholder, rectangularSelection } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { CodeEditorHandle, CodeEditorOptions } from "./code-editor-api";

// Token colours come from the Atom One stylesheet the sidebar already swaps on theme change
// (prefs.ts), by emitting the same `hljs-*` class names highlight.js does instead of colours of our
// own. So the editor matches every rendered code block exactly, follows a light/dark switch with no
// work, and a future theme swap moves both together — three things a second palette would break.
const HLJS_STYLE = HighlightStyle.define([
    { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "hljs-comment" },
    { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.self], class: "hljs-keyword" },
    { tag: [t.string, t.special(t.string), t.escape, t.regexp], class: "hljs-string" },
    { tag: [t.number, t.integer, t.float], class: "hljs-number" },
    { tag: [t.bool, t.null, t.atom], class: "hljs-literal" },
    { tag: [t.function(t.variableName), t.function(t.definition(t.variableName))], class: "hljs-title" },
    { tag: [t.standard(t.variableName), t.standard(t.name)], class: "hljs-built_in" },
    { tag: [t.className, t.definition(t.className)], class: "hljs-built_in" },
    { tag: [t.propertyName, t.attributeName], class: "hljs-attr" },
    { tag: [t.meta, t.annotation], class: "hljs-meta" },
    { tag: t.typeName, class: "hljs-type" },
    { tag: t.invalid, class: "hljs-deletion" },
]);

// Structure only. Everything with a colour reads a sidebar CSS variable, so the editor re-themes with
// the rest of the panel rather than holding a copy of the palette.
const THEME = EditorView.theme({
    "&": { color: "var(--fg)", backgroundColor: "var(--panel)", fontSize: "0.88em" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", lineHeight: "1.5" },
    ".cm-content": { padding: "8px 0", caretColor: "var(--fg)" },
    ".cm-line": { padding: "0 9px" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)" },
    ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--fg) 5%, transparent)" },
    // Selection is drawn by drawSelection (below) rather than natively, so it needs colouring here.
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: "color-mix(in srgb, var(--accent) 32%, transparent)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket":
        { backgroundColor: "color-mix(in srgb, var(--accent) 26%, transparent)", outline: "none" },
    ".cm-tooltip": {
        background: "var(--panel-2)", border: "1px solid var(--border)", borderRadius: "6px",
        color: "var(--fg)", boxShadow: "0 4px 14px rgba(0,0,0,.28)",
    },
    ".cm-tooltip-autocomplete > ul": { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", maxHeight: "14em" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "2px 7px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { background: "var(--accent)", color: "var(--accent-fg)" },
    ".cm-completionIcon": { opacity: 0.55, paddingRight: "0.6em" },
    // The gutter drawn the way the log's code blocks draw theirs (`.cline .lno`), so a line number reads the
    // same in the editor as in the step the script came from.
    ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--fg-faint)", borderRight: "1px solid var(--border)" },
    ".cm-lineNumbers .cm-gutterElement": { minWidth: "2.2em", padding: "0 8px 0 4px", opacity: 0.75 },
    // WHERE IT BROKE — the log's `.cline-fail`, on the editor's line and its number.
    ".cm-ml-fail": { backgroundColor: "color-mix(in srgb, var(--err) 13%, transparent)" },
    ".cm-lineNumbers .cm-gutterElement.cm-ml-fail-lno": { color: "var(--err)", fontWeight: "600", opacity: 1 },
    ".cm-completionDetail": { color: "var(--fg-faint)", fontStyle: "normal", marginLeft: "0.7em" },
    ".cm-placeholder": { color: "var(--fg-faint)" },
});

// How long the editor waits for a `complete` source before showing the static list instead. Warm Jedi
// answers in ~20ms plus the message hops; the first request also loads 1.6 MB of wheels, which this
// deliberately does NOT wait for — that one shows the static list and the next word gets Jedi.
const REMOTE_BUDGET_MS = 350;

// Jedi's kinds, onto CodeMirror's icon set. Jedi reports methods as `function`, which is what it shows.
const KIND: Record<string, string> = {
    module: "namespace", class: "class", function: "function", instance: "variable", param: "variable",
    statement: "variable", property: "property", keyword: "keyword", path: "text",
};

// Which of those are worth SAYING beside a name. Jedi's own words for the rest (`statement`, `instance`,
// `param`) are its internals, not something a reader acts on; an unknown kind (`""`) says nothing at all.
const LABELLED = new Set(["module", "class", "function", "property", "keyword"]);

// Where completion would only be noise: Jedi completes FILE PATHS inside a string (the sandbox's own
// filesystem), and nothing useful can be completed inside a comment.
const QUIET = new Set(["String", "FormatString", "Comment"]);

/** The static sources `python()` ships — keywords, builtins, snippets, names in the buffer — merged. */
async function staticCompletions(ctx: CompletionContext): Promise<CompletionResult | null> {
    const results = (await Promise.all([localCompletionSource(ctx), globalCompletion(ctx)]))
        .filter((r): r is CompletionResult => !!r);
    if (!results.length) return null;
    const seen = new Set<string>();
    const options: Completion[] = [];
    for (const r of results) for (const o of r.options) if (!seen.has(o.label)) { seen.add(o.label); options.push(o); }
    return { from: Math.min(...results.map(r => r.from)), options, validFor: /^\w*$/ };
}

/**
 * The editor's one completion source when a `complete` backend is given: ask it, within a budget, and fall
 * back to the static list. Asked once per WORD — `validFor` lets CodeMirror narrow the same answer as you
 * keep typing, so a request is made when a name starts or after a `.`, not on every keystroke.
 */
function withRemote(remote: NonNullable<CodeEditorOptions["complete"]>) {
    return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
        if (QUIET.has(syntaxTree(ctx.state).resolveInner(ctx.pos, -1).name)) return null;
        const word = ctx.matchBefore(/[A-Za-z_]\w*$/);
        const from = word ? word.from : ctx.pos;
        // A MEMBER access — `np.` or `np.ar` alike: what matters is whether the NAME being typed follows a dot,
        // not whether the cursor does.
        const member = from > 0 && ctx.state.sliceDoc(from - 1, from) === ".";
        if (!word && !member && !ctx.explicit) return null;
        const line = ctx.state.doc.lineAt(ctx.pos);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const answer = await Promise.race([
            remote(ctx.state.doc.toString(), line.number, ctx.pos - line.from).catch(() => null),
            new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), REMOTE_BUDGET_MS); }),
        ]);
        clearTimeout(timer);
        if (ctx.aborted) return null;
        if (answer?.length) {
            return {
                from,
                options: answer.map(c => ({ label: c.name, type: KIND[c.type] ?? "variable", ...(LABELLED.has(c.type) ? { detail: c.type } : {}) })),
                validFor: /^\w*$/,
            };
        }
        // On a member the static list has nothing true to say (it would offer builtins as attributes of `np`),
        // so a remote with no answer there means no popup rather than a wrong one.
        return member ? null : staticCompletions(ctx);
    };
}

// LINE NUMBERS, in a compartment so the preference can flip without rebuilding the editor (and losing the
// cursor and history with it).
const numbering = new Compartment();
const gutterFor = (on: boolean) => (on ? lineNumbers() : []);

// THE LINE THAT FAILED, and the FLASH a traceback frame sends. Both are line decorations whose classes are
// the log's own (`.cline-pulse` / `.cline-pulse-fail` are global in sidebar.css), so a jump looks identical
// whether it lands in a step's code block or in this editor. The caller works out WHICH line (the traceback
// names the code that ran, and the document may have moved on); these only draw it.
const setMark = StateEffect.define<number | null>();
const setFlash = StateEffect.define<{ line: number; cls: string } | null>();

/** A decoration field driven by one effect: set to a line (1-based) or cleared, and carried through edits. */
function lineField<T extends number | { line: number }>(effect: StateEffectType<T | null>, deco: (v: T) => Decoration) {
    return StateField.define<DecorationSet>({
        create: () => Decoration.none,
        update(set, tr) {
            set = set.map(tr.changes);
            for (const e of tr.effects) {
                if (!e.is(effect)) continue;
                const v = e.value;
                const line = v == null ? null : typeof v === "number" ? v : v.line;
                set = v == null || line == null || line < 1 || line > tr.state.doc.lines
                    ? Decoration.none
                    : Decoration.set([deco(v).range(tr.state.doc.line(line).from)]);
            }
            return set;
        },
        provide: (f) => EditorView.decorations.from(f),
    });
}
const markField = lineField(setMark, () => Decoration.line({ class: "cm-ml-fail" }));
const flashField = lineField(setFlash, (v: { cls: string }) => Decoration.line({ class: v.cls }));

/** The failing line's NUMBER in red too, as the log's `.cline-fail .lno` is. */
class FailNumber extends GutterMarker { override elementClass = "cm-ml-fail-lno"; }
const failNumber = new FailNumber();
const failGutter = gutterLineClass.compute([markField], (state) => {
    const at: number[] = [];
    state.field(markField).between(0, state.doc.length, (from) => { at.push(from); });
    return RangeSet.of(at.map((from) => failNumber.range(from)));
});

/**
 * Build the extension list for one editor.
 *
 * @param options what the sidebar asked for; `onRun` becomes Cmd/Ctrl+Enter.
 * @param onChange the internal listener that reports edits (and only real edits).
 */
function extensions(options: CodeEditorOptions, onChange: (view: EditorView) => void) {
    // THE RUN CHORD IS ALWAYS CLAIMED, whoever acts on it. CodeMirror's own default keymap reads
    // Mod-Enter as "insert a blank line", and in this app the chord means "run" everywhere — so left
    // unbound it would add a line to the script AND bubble up to whatever runs it.
    //   - With `onRun`, the editor runs it and STOPS it there, so a parent handling the same chord
    //     (the bench does, panel-wide) cannot run the script a second time off the same keypress.
    //   - Without it, the chord is swallowed as a newline and allowed to BUBBLE, for a parent that
    //     owns the shortcut across more than just this field.
    // Both modifiers, deliberately: CodeMirror's "Mod" is Cmd on macOS and Ctrl elsewhere, while the
    // textarea this replaced ran on `metaKey || ctrlKey`, so binding Mod alone would silently drop
    // Ctrl+Enter for every Mac user who had been using it.
    const onRun = options.onRun;
    const run = () => { onRun?.(); return true; };
    const runKey = ["Mod-Enter", "Ctrl-Enter"].map(key => ({ key, run, preventDefault: true, stopPropagation: !!onRun }));
    return [
        numbering.of(gutterFor(!!options.lineNumbers)),
        markField,
        flashField,
        failGutter,
        history(),
        drawSelection(),
        rectangularSelection(),
        highlightActiveLine(),
        bracketMatching(),
        closeBrackets(),
        // With a `complete` backend this REPLACES the language's own sources rather than adding to them: the
        // backend already offers what they would (Jedi knows keywords, builtins and the buffer's names), and
        // two lists merged would show every name twice. They remain the fallback inside `withRemote`.
        options.complete ? autocompletion({ override: [withRemote(options.complete)] }) : autocompletion(),
        indentUnit.of("    "),
        python(),
        syntaxHighlighting(HLJS_STYLE),
        THEME,
        options.placeholder ? placeholder(options.placeholder) : [],
        // Order matters: our Mod-Enter has to be reached before defaultKeymap's Enter handling, and
        // completionKeymap before defaultKeymap so Enter accepts a completion when one is open.
        keymap.of([...runKey, ...closeBracketsKeymap, ...completionKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.view); }),
    ];
}

const factory = {
    mount(parent: HTMLElement, options: CodeEditorOptions): CodeEditorHandle {
        // Guards a setValue that would otherwise be reported straight back as an edit, which turns
        // one keystroke into a loop between the editor and the component holding its value.
        let echoing = false;
        let flashTimer: ReturnType<typeof setTimeout> | undefined;
        const view = new EditorView({
            parent,
            state: EditorState.create({
                doc: options.value,
                extensions: extensions(options, v => { if (!echoing) options.onChange(v.state.doc.toString()); }),
            }),
        });
        return {
            getValue: () => view.state.doc.toString(),
            setValue(value: string) {
                if (value === view.state.doc.toString()) return;   // same text, but would move the cursor
                echoing = true;
                try {
                    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
                } finally {
                    echoing = false;
                }
            },
            focus: () => view.focus(),
            setLineNumbers: (on: boolean) => view.dispatch({ effects: numbering.reconfigure(gutterFor(on)) }),
            markLine: (line: number | null) => view.dispatch({ effects: setMark.of(line) }),
            flashLine(line: number, fail: boolean) {
                if (line < 1 || line > view.state.doc.lines) return false;
                // MARK FIRST, then scroll, as the log's jump does: the mark is the answer, the scroll a nicety.
                view.dispatch({ effects: [
                    setFlash.of({ line, cls: fail ? "cline-pulse-fail" : "cline-pulse" }),
                    EditorView.scrollIntoView(view.state.doc.line(line).from, { y: "center" }),
                ] });
                // The animation's own length. Cleared so the NEXT click on the same line animates again — a
                // class that is still present does not restart its animation.
                clearTimeout(flashTimer);
                flashTimer = setTimeout(() => { try { view.dispatch({ effects: setFlash.of(null) }); } catch { /* destroyed */ } }, 1400);
                return true;
            },
            destroy: () => { clearTimeout(flashTimer); view.destroy(); },
        };
    },
};

window.__mlCodeEditor = factory;
