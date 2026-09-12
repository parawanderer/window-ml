// A code field that upgrades itself.
//
// It renders the plain textarea first and swaps in CodeMirror once dist/cm-editor.js has loaded, so
// the bench is usable the instant the tab opens and stays usable if that fetch never lands — under
// jsdom, or with the file missing from a partial build. Falling back to a working textarea is the
// whole reason the editor is loaded this way rather than imported.

import { useEffect, useRef, useState } from "preact/hooks";
import type { CodeEditorFactory, CodeEditorHandle, CodeEditorOptions } from "./code-editor-api";

let pending: Promise<CodeEditorFactory | null> | null = null;

/**
 * Fetch the editor bundle, once per session.
 *
 * @returns the factory, or null when it cannot be loaded — the caller keeps the textarea. A failure
 *   clears the memo so opening the tab again retries; a permanent one just fails again, cheaply.
 */
function loadEditor(): Promise<CodeEditorFactory | null> {
    if (window.__mlCodeEditor) return Promise.resolve(window.__mlCodeEditor);
    if (pending) return pending;
    pending = new Promise<CodeEditorFactory | null>(resolve => {
        let src = "";
        try { src = chrome.runtime.getURL("cm-editor.js"); } catch { /* no extension context */ }
        if (!src) { resolve(null); return; }
        const script = document.createElement("script");
        script.src = src;
        script.onload = () => resolve(window.__mlCodeEditor ?? null);
        script.onerror = () => resolve(null);
        document.head.appendChild(script);
    }).then(factory => {
        if (!factory) pending = null;
        return factory;
    });
    return pending;
}

interface CodeEditorProps {
    value: string;
    onChange(value: string): void;
    /**
     * Cmd/Ctrl+Enter, in the editor and in the textarea alike. Leave it out when a PARENT owns the
     * shortcut: the chord then bubbles to it, rather than running twice.
     */
    onRun?(): void;
    placeholder?: string;
    /** A completion backend beyond the static list (the bench passes Jedi-in-the-sandbox). Only CodeMirror
     *  asks it; the textarea fallback has no completion to offer. */
    complete?: CodeEditorOptions["complete"];
    /** Class for the field itself, so callers keep owning its size and border. */
    class?: string;
    /** A line-number gutter (the log's "show line numbers" preference, for the bench). The textarea has none. */
    lineNumbers?: boolean;
    /** The line (1-based, in the current `value`) to mark as the one that failed; null or absent for none. */
    markLine?: number | null;
    /** Receives the live editor once CodeMirror is up (and null when it goes), for imperative calls such as
     *  `flashLine`. Stays null for the textarea fallback, which has no lines to point at. */
    handleRef?: { current: CodeEditorHandle | null };
}

/**
 * A code editor field — syntax highlighting and autocomplete (CodeMirror 6) for any place the sidebar takes
 * code, falling back to a plain textarea. Renders the textarea at once and upgrades when the separately
 * built bundle lands, so it is never NOT usable. Controlled by `value`/`onChange`; the caller owns its size.
 * Extracted for the Python bench; reach for it instead of a bare `<textarea class="code">`.
 */
export function CodeEditor({ value, onChange, onRun, placeholder, complete, class: className = "", lineNumbers, markLine, handleRef }: CodeEditorProps) {
    const host = useRef<HTMLDivElement>(null);
    const editor = useRef<CodeEditorHandle | null>(null);
    const [upgraded, setUpgraded] = useState(false);

    // The editor is mounted once, but its callbacks are read through a ref so a re-render with a new
    // closure does not mean tearing the view down and losing the cursor with it.
    const latest = useRef({ onChange, onRun, complete });
    latest.current = { onChange, onRun, complete };

    // Every text this editor has produced and not yet seen come back. Typing goes out as onChange and
    // returns as a new `value` prop a render later, and pushing that back in replaces the document
    // under a cursor that has since moved on — typing "pri" landed as "rip", each keystroke
    // reinserted at the start. Comparing against the LATEST emission is not enough, because the props
    // replay in batches and arrive several keystrokes behind. They do arrive in order, though, so an
    // echo is any value still queued: match it, drop everything up to it, and leave the document
    // alone. Anything else genuinely came from elsewhere.
    const echoes = useRef<string[]>([]);

    useEffect(() => {
        let dropped = false;
        void loadEditor().then(factory => {
            if (dropped || !factory || !host.current) return;
            editor.current = factory.mount(host.current, {
                value,
                placeholder,
                onChange: next => {
                    // Bounded: a parent that ignores onChange would otherwise grow this forever, and a
                    // stale echo that far back is not worth matching anyway.
                    if (echoes.current.push(next) > 200) echoes.current.splice(0, 100);
                    latest.current.onChange(next);
                },
                // Bound only when the caller wants it: an unconditional handler would swallow
                // Cmd/Ctrl+Enter for a caller that has nothing to run.
                onRun: onRun ? () => latest.current.onRun?.() : undefined,
                complete: complete ? (code, line, column) => latest.current.complete?.(code, line, column) ?? Promise.resolve(null) : undefined,
                lineNumbers: latestView.current.lineNumbers,
            });
            editor.current.markLine(latestView.current.markLine ?? null);
            if (handleRef) handleRef.current = editor.current;
            setUpgraded(true);
        });
        return () => {
            dropped = true;
            editor.current?.destroy();
            editor.current = null;
            if (handleRef) handleRef.current = null;
        };
    }, []);

    // What the editor should DRAW, read at mount through a ref (the bundle may land several renders after the
    // first), then pushed whenever it changes.
    const latestView = useRef({ lineNumbers: !!lineNumbers, markLine });
    latestView.current = { lineNumbers: !!lineNumbers, markLine };
    useEffect(() => { editor.current?.setLineNumbers(!!lineNumbers); }, [lineNumbers]);
    // On `value` too: a document replaced from outside can drop the decoration, and the caller's number may
    // not have changed with it.
    useEffect(() => { editor.current?.markLine(markLine ?? null); }, [markLine, value]);

    // A value set from OUTSIDE — a reset, a restored script — is the only thing worth pushing in.
    useEffect(() => {
        const queued = echoes.current.indexOf(value);
        if (queued >= 0) { echoes.current.splice(0, queued + 1); return; }
        echoes.current.length = 0;
        editor.current?.setValue(value);
    }, [value]);

    // Textarea Tab inserts four spaces rather than escaping the field, matching the editor's indent.
    const onKeyDown = (e: KeyboardEvent) => {
        const field = e.target as HTMLTextAreaElement;
        if (e.key === "Tab") {
            e.preventDefault();
            const start = field.selectionStart, end = field.selectionEnd;
            onChange(value.slice(0, start) + "    " + value.slice(end));
            requestAnimationFrame(() => { field.selectionStart = field.selectionEnd = start + 4; });
        } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onRun) {
            // Same contract as the editor: handled here means handled ONLY here.
            e.preventDefault();
            e.stopPropagation();
            onRun();
        }
    };

    return (
        <div class={`ced ${className}`}>
            <div ref={host} class="ced-cm" hidden={!upgraded} />
            {upgraded ? null : (
                <textarea class="ced-ta code" spellcheck={false} value={value} placeholder={placeholder}
                    onInput={e => onChange((e.target as HTMLTextAreaElement).value)} onKeyDown={onKeyDown} />
            )}
        </div>
    );
}
