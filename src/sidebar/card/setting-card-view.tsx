// setting-card-view.tsx — change_setting's card: which setting, in the words DevTools Settings uses, from what to what.

// Everything on it but `why` was built by the worker from the checked change (sw/sw-change-setting.ts). Both values are
// drawn in full, one line per list entry, each a text node with a control, bidi or invisible character replaced by
// U+FFFD and listed beside it (`shownText`), so a path with a newline or a right-to-left mark cannot pose as another.

import type { RenderDescriptor } from "../../contract/contract-render";
import { shownText } from "../../python/pkg-card";
import { settingValueLines } from "../../setting-text";

type SettingCard = Extract<RenderDescriptor, { type: "setting" }>;

/** One line of text with its hidden characters replaced, and those characters listed beside it. */
function Shown({ cls, text }: { cls: string; text: string }) {
    const s = shownText(text);
    return <span class={cls}>{s.text}{s.hidden.length ? <span class="pkg-escaped">{s.hidden.join(" ")}</span> : null}</span>;
}

/** One value, every line of it. */
function Value({ label, v }: { label: string; v: unknown }) {
    return (
        <div class="setcard-val">
            <span class="setcard-val-label">{label}</span>
            <div class="setcard-val-lines">{settingValueLines(v).map((line, i) => <Shown key={i} cls="setcard-line" text={line} />)}</div>
        </div>
    );
}

/**
 * change_setting's card: the setting's name and tooltip, the old and the new value in full, why it is guarded, the
 * model's reason, and that a synced setting changes on every browser signed in.
 * @group card
 * @gallery {"d": {"type": "setting", "key": "shellRoots", "name": "Workspace folders", "tip": "Absolute paths, one per line. A call's working folder must be inside one; with the sandbox on, programs may write only inside them.", "reason": "the folders ml.sh may reach", "class": "guarded", "from": ["/Users/me/src/proj"], "to": ["/Users/me/src/proj", "/Users/me/src/other"], "why": "The tests for the other project live in ~/src/other.", "synced": true}}
 */
export function SettingCardRender({ d }: { d: SettingCard }) {
    return (
        <div class="setcard" data-key={d.key} data-class={d.class}>
            <div class="setcard-head">The agent wants to change <span class="setcard-name">{d.name}</span></div>
            {d.tip ? <div class="setcard-tip">{d.tip}</div> : null}
            {d.reason ? <div class="setcard-reason">Always asks: {d.reason}.</div> : null}
            <Value label="Now" v={d.from} />
            <Value label="New" v={d.to} />
            {d.host ? <div class="setcard-host">Every blank run would start on a page of <Shown cls="setcard-hostname" text={d.host} />.</div> : null}
            {d.why ? <div class="setcard-why">The agent says: “<Shown cls="setcard-why-text" text={d.why} />”</div> : null}
            {d.synced ? <div class="setcard-sync">This applies to every browser signed in to this profile.</div> : null}
            {d.class === "guarded" ? <div class="setcard-once">Your answer is for this change only; it cannot be remembered.</div> : null}
        </div>
    );
}
