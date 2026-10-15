// settings-label.tsx — the Settings page's field label, shared by the sections split into their own files.

/**
 * A Settings field label with an optional hover tooltip. Left-anchored (.left) so it opens rightward into the panel:
 * far-left labels would clip a centered pop.
 * @param children the label text
 * @param tip the tooltip, if any
 */
export const Lbl = ({ children, tip }: { children: string; tip?: string }) =>
    tip
        ? <span class="tt">{children}<span class="tt-pop left" role="tooltip">{tip}</span></span>
        : <span>{children}</span>;
