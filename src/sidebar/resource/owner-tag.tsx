// owner-tag.tsx — the small "ours / used by us / not ours" tag a memory tooltip puts beside a model's name, when the
// surface drawing the chart knows which sessions are its own (the bench: this sweep's runs).

import { createContext } from "preact";
import { useContext } from "preact/hooks";
import { type Owner } from "../../resource/ownership";

/** What a chart knows about whose its models are: the reader (`ownership`) and who "us" is, in words ("this sweep"). */
export interface OwnerInfo { of: (model: string, t: number) => Owner | null; us: string }

/** The chart's ownership, provided by `ResourceTracks` when its surface passes one; null everywhere else. */
export const OwnerContext = createContext<OwnerInfo | null>(null);

/** The words for each owner, short for the tag, long for the line that explains them. */
const WORDS: Record<Owner, (us: string) => string> = {
    ours: (us) => `loaded for ${us}`,
    used: (us) => `used by ${us}`,
    other: (us) => `not ${us}'s`,
};

/** The tag for one model at one instant, or nothing when the chart knows no owners or the model had no residency then. */
export function OwnerTag({ model, t }: { model: string; t: number }) {
    const info = useContext(OwnerContext);
    const o = info?.of(model, t);
    return o ? <span class={`rc-tip-owner ${o}`}>{WORDS[o](info!.us)}</span> : null;
}

/** One dim line saying how the tags were read, for a tooltip that shows any. */
export function OwnerNote() {
    const info = useContext(OwnerContext);
    return info ? <div class="rc-tip-line rc-tip-dim rc-tip-owner-note">"loaded for" is read off the first generation the load served</div> : null;
}
