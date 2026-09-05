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
    /** Cmd/Ctrl+Enter. Absent means the shortcut is left to fall through. */
    onRun?(): void;
    /** Shown while the document is empty. */
    placeholder?: string;
}

/** The live editor, as the sidebar sees it. */
export interface CodeEditorHandle {
    /** Replace the document, unless it already matches (which would fight the user's cursor). */
    setValue(value: string): void;
    getValue(): string;
    focus(): void;
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
