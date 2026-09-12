// The contract between the lazily loaded CodeMirror bundle and the sidebar that asks for it.
//
// It is its own file because both sides import it and neither should pull the other in: the editor
// bundle must not drag Preact along, and sidebar-app must not drag CodeMirror. These are types only,
// so the import erases at build time and nothing crosses.

/** What the sidebar hands the editor when it mounts one. */
export interface CodeEditorOptions {
    /** Initial document. Later changes go through {@link CodeEditorHandle.setValue}. */
    value: string;
    /** Called on every edit, with the whole document. */
    onChange(value: string): void;
    /**
     * Cmd/Ctrl+Enter. Given, the editor runs it and stops the event there. Absent, the editor still
     * claims the chord (it never becomes a newline) but lets it bubble to a parent that owns it.
     */
    onRun?(): void;
    /** Shown while the document is empty. */
    placeholder?: string;
    /**
     * A completion source that knows more than the static list — for the bench, Jedi in the sandbox. Given
     * the whole document and a 1-based line / 0-based column, resolve candidates, or null when it cannot say
     * (still loading, busy behind a run, failed). The static list stays the floor: the editor never waits
     * past its budget for this, and a late answer is dropped.
     */
    complete?(code: string, line: number, column: number): Promise<RemoteCompletion[] | null>;
    /** Draw a line-number gutter. Later changes go through {@link CodeEditorHandle.setLineNumbers}. */
    lineNumbers?: boolean;
}

/** One candidate from a `complete` source: the whole `name` and its kind (`module`/`function`/…). */
export interface RemoteCompletion { name: string; type: string; }

/** The live editor, as the sidebar sees it. */
export interface CodeEditorHandle {
    /** Replace the document, unless it already matches (which would fight the user's cursor). */
    setValue(value: string): void;
    getValue(): string;
    focus(): void;
    /** Show or hide the line-number gutter. */
    setLineNumbers(on: boolean): void;
    /** Mark a line (1-based, in the CURRENT document) as the one that failed, or clear it with null. */
    markLine(line: number | null): void;
    /**
     * Scroll a line (1-based, current document) into view and pulse it — red for the line that failed, green
     * for a line on the way there. The same flash the log's code blocks use.
     * @returns false when there is no such line.
     */
    flashLine(line: number, fail: boolean): boolean;
    /** Tear down the view. Safe to call twice. */
    destroy(): void;
}

export interface CodeEditorFactory {
    mount(parent: HTMLElement, options: CodeEditorOptions): CodeEditorHandle;
}

declare global {
    interface Window {
        /** Defined by dist/cm-editor.js once it loads. Absent until then, and forever if it fails. */
        __mlCodeEditor?: CodeEditorFactory;
    }
}
