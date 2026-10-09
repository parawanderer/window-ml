// help-tip.tsx — an explanation kept out of the way: a label as usual, its meaning in the tooltip on hover. Used on the
// bench pages' headings and columns; the panel can use it the same way.

import type { ComponentChildren } from "preact";

/**
 * A label that explains itself on hover: `tip` goes in the tooltip layer's `data-tip` (installTooltipLayer reads it as
 * plain text, never markup) and a faint dotted underline (`.help`) says there is one. No tip, just the label.
 */
export function Tip({ tip, children }: { tip?: string; children: ComponentChildren }) {
    if (!tip) return <>{children}</>;
    return <span class="tt help" data-tip={tip}>{children}</span>;
}
