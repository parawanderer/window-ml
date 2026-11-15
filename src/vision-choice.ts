// vision-choice.ts — what the person said about whether a model sees images, remembered per model, and the default for a model they never said anything about.

// A model whose vision the runtime cannot report (a cloud model, or one listed with no kinds) is asked about once, by the eye toggle.
// Most such models do see images, so a model nobody has said anything about is ASSUMED to, and only a click is stored: the person's
// word, `true` or `false`, per runtime and model, so the next session on that model starts as they left it. Pure, so the
// chat page (device preferences) and the Commander (`chrome.storage.local`) share the rule and keep their own store.

/** The person's word per model: `{ "<scope>\n<model>": true | false }`. A model with no entry was never asked about. */
export type VisionChoices = Record<string, boolean>;

/** What a model nobody has said anything about is taken to do. */
export const VISION_ASSUMED = true;

/** Entries kept; the oldest go first, so a person who tries many models does not grow the store without end. */
const MAX_CHOICES = 200;

/** The store key for a model: `scope` is where the model list came from (a runtime id; the Commander's is `commander`). */
export const visionKey = (scope: string, model: string): string => `${scope}\n${model}`;

/** Whether images go to `model` natively, and whether that is the person's word (`chosen`) or the assumption. */
export function visionFor(choices: VisionChoices, scope: string, model: string): { on: boolean; chosen: boolean } {
    const v = choices[visionKey(scope, model)];
    return typeof v === "boolean" ? { on: v, chosen: true } : { on: VISION_ASSUMED, chosen: false };
}

/** `choices` with the person's word for `model` set, as a copy; the newest entry is last. */
export function withVisionChoice(choices: VisionChoices, scope: string, model: string, on: boolean): VisionChoices {
    const key = visionKey(scope, model);
    const { [key]: _old, ...rest } = choices;
    const entries = Object.entries({ ...rest, [key]: on });
    return Object.fromEntries(entries.slice(-MAX_CHOICES));
}

/** A stored value read back: only `{ string: boolean }` entries survive, so a hand-edited or older shape means "no choices". */
export function readVisionChoices(raw: unknown): VisionChoices {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === "boolean")) as VisionChoices;
}

/** The eye toggle's hover text: the three states say different things, since a default is not something the person said. */
export function visionTip(on: boolean, chosen: boolean): string {
    if (!chosen) return "Assumed to see images (most do), so they go to it. Click if it does not.";
    return on
        ? "You said this model sees images, so they go to it. Click to turn off."
        : "You said this model does not see images, so they go to the reader model if one is set, and are refused if none is. Click to undo.";
}
