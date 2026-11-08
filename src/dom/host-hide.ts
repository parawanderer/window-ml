// host-hide.ts — hiding one of the extension's shadow hosts so a screenshot, a hit-test or a trusted click reaches the page beneath it.

/**
 * Hide or show one of the extension's shadow hosts. A plain `style.visibility` is not `!important` and loses to the
 * host's own inline `all: initial !important` (shell-shot.ts `HOST_STYLE`), so the hide is `!important` too, and
 * showing removes it to fall back to `all: initial`.
 * @param host the shadow host, if mounted
 * @param hidden whether to hide it
 */
export function setHostHidden(host: HTMLElement | null, hidden: boolean): void {
    if (!host) return;
    if (hidden) host.style.setProperty("visibility", "hidden", "important");
    else host.style.removeProperty("visibility");
}
