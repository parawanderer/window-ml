// image-gate.ts — where a message's images go: to the model, to a reader model, named and not sent, or refused, and the
// words for each (docs/spec/FILE_ATTACHMENTS.md, "Images go only to a model known to see them").
//
// Pure, with no `chrome`: the worker's chats and an agent run's pasted images decide with this one copy.

/** Whether a model sees images: known yes, known no, or not known. Unknown is never folded into either answer. */
export type VisionAnswer = "yes" | "no" | "unknown";

/**
 * Whether `model` sees images, from what the backend reports and what the person declared.
 * @param caps the model's reported capabilities (Ollama's `/api/show`), or null when the backend cannot say
 * @param declared the person's Settings declaration (`defaultModelVision`: "yes", "no" or "" for auto), which speaks
 *   only for the DEFAULT model, so `isDefault` says whether `model` is it
 * @returns the answer; a report always wins over a declaration
 */
export function visionAnswer(caps: string[] | null, declared: { isDefault: boolean; defaultModelVision: string }): VisionAnswer {
    if (Array.isArray(caps)) return caps.includes("vision") ? "yes" : "no";
    if (declared.isDefault && (declared.defaultModelVision === "yes" || declared.defaultModelVision === "no")) return declared.defaultModelVision;
    return "unknown";
}

/** The path a message's images take. */
export type ImagePlan =
    | { route: "model"; reader?: string }
    | { route: "reader"; reader: string }
    | { route: "named" }
    | { route: "refused"; message: string };

/** What a person is told when a message with images goes to a model whose vision is not known and no reader is set.
 *  The toggle it names is the composer's (start-page.tsx, session-composer). */
export const VISION_UNKNOWN_REFUSAL = "This model may not see images. If it does, turn on 'This model sees images' and send again.";

/**
 * The path for a message's images.
 * @param sees whether the receiving model sees images
 * @param reader a reader model known to see, or null when none is set or it does not see
 * @param forced the person declared this model sees (`vision: true`): the images go to it, unprobed
 * @returns the model when it sees or is declared to (with the reader, for what is past the image cap); else the
 *   reader when one is set; else named when the model is known not to see; else refused, before anything is sent
 */
export function planImages(sees: VisionAnswer, reader: string | null, forced: boolean): ImagePlan {
    if (forced || sees === "yes") return reader ? { route: "model", reader } : { route: "model" };
    if (reader) return { route: "reader", reader };
    if (sees === "no") return { route: "named" };
    return { route: "refused", message: VISION_UNKNOWN_REFUSAL };
}

/** A refusal of a message's images, thrown before anything is sent so the command answers with its sentence. */
export class ImagesRefused extends Error {
    constructor(message: string) { super(message); this.name = "ImagesRefused"; }
}

/** " 2" when a message has several images, "" for one: how the notes number them. */
const which = (i: number, n: number): string => (n > 1 ? ` ${i + 1}` : "");

/** The note that stands in for image `i` of `n` once `reader` has transcribed it; `text` is its reading. */
export function readerNote(i: number, n: number, reader: string, text: string): string {
    return `[Pasted image${which(i, n)}: you can't see images, so ${reader} transcribed its text:]\n${text || "(could not read the image)"}`;
}

/** The note that stands in for image `i` of `n` when the model does not see and no reader is set. */
export function namedNote(i: number, n: number): string {
    return `[Pasted image${which(i, n)} was not sent: you can't see images, and no reader model is set to read it.]`;
}
