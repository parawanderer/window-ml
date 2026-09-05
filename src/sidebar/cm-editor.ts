// CodeMirror for the Python bench, built as its OWN bundle and loaded only when that tab is opened.
//
// Measured at ~395 KB minified against a 694 KB sidebar-app, so bundling it in would grow the app by
// more than half — and sidebar-app loads in an iframe on every page the overlay mounts on, for a tab
// most sessions never open. Hence a separate entry, fetched on demand.
//
// It attaches to `window` rather than exporting, because every entry here is IIFE (content and
// injected scripts have to be classic scripts) so there is no module graph to import into.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, keymap, placeholder, rectangularSelection } from "@codemirror/view";
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
    ".cm-completionDetail": { color: "var(--fg-faint)", fontStyle: "normal", marginLeft: "0.7em" },
    ".cm-placeholder": { color: "var(--fg-faint)" },
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
        history(),
        drawSelection(),
        rectangularSelection(),
        highlightActiveLine(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
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
            destroy: () => view.destroy(),
        };
    },
};

window.__mlCodeEditor = factory;
