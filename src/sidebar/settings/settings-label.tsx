// settings-label.tsx — the Settings page's field label, shared by the sections split into their own files.

import type { MlConfig } from "../../contract/contract-config";
import { SETTING_TEXT } from "../../setting-text";

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

/**
 * A Settings row's label, its name and tooltip read from `SETTING_TEXT` so the panel and an approval card show the same words.
 * @param k the setting's key
 */
export const SettingLbl = ({ k }: { k: keyof MlConfig }) => <Lbl tip={SETTING_TEXT[k]?.tip}>{SETTING_TEXT[k]!.name}</Lbl>;
