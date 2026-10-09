// tip.tsx — an explanation kept out of the way: the label as usual, its meaning in the panel's tooltip on hover (the
// layer app.tsx installs reads `data-tip` as plain text). A faint dotted underline says there is one.

import type { ComponentChildren } from "preact";

export function Tip({ tip, children }: { tip?: string; children: ComponentChildren }) {
    if (!tip) return <>{children}</>;
    return <span class="tt help" data-tip={tip}>{children}</span>;
}
