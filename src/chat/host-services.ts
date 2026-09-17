// The services seam (src/sidebar/services.ts) as the CHAT CORE implements it: every call the shared session views make
// becomes a contract `Command` to the session's runtime, through the store (which turns a failure into a notice), and
// what belongs to the device instead of the runtime (the lightbox, prefs) goes to the `ClientPlatform`.
//
// A session identifier here is always a key, `runtime:hash`, which is how the command finds its runtime.
import type { JsonSchema, NeutralMessage } from "../contract";
import type { Command, SessionKey } from "../session-host";
import { parseSessionKey } from "../session-host";
import type { SidebarServices } from "../sidebar/services";
import { view } from "../sidebar/store";
import type { ChatStore } from "./chat-store";
import { mayCommand } from "./grants";
import type { ClientPlatform } from "./platform";

/** The services for a chat page over `store`'s host. */
export function hostServices(store: ChatStore, platform: ClientPlatform): SidebarServices {
    const idOf = (key: SessionKey) => parseSessionKey(key);
    const summaryOf = (key: SessionKey) => store.index.value.get(key);
    /** The runtime a session is on, when this client may send it a command of `type`. */
    const allowed = (key: SessionKey, type: Parameters<typeof mayCommand>[1]) => {
        const id = idOf(key);
        if (!id) return null;
        const rt = store.runtime(id.runtime);
        return rt && rt.online && mayCommand(rt, type, { key, summary: summaryOf(key) }, store.host.self) ? { id, rt } : null;
    };
    return {
        sideCalls: (key) => {
            const id = idOf(key);
            // Reads the runtimes signal, so a render that asks stays subscribed to the answer changing.
            const rt = id ? store.runtimes.value.find((r) => r.id === id.runtime) : undefined;
            return !!rt?.capabilities.sideCalls && !!allowed(key, "side.call");
        },
        sideCall: async (req) => {
            const id = idOf(req.session);
            if (!id) return { ok: false, error: "not a session key" };
            // Quiet: a gloss that could not be fetched shows as its own "retry" state, not as a notice.
            const cmd: Extract<Command, { type: "side.call" }> = {
                type: "side.call", runtime: id.runtime, purpose: req.purpose, session: id,
                // The views build these from literals; the runtime validates what arrives either way.
                messages: req.messages as NeutralMessage[], ...(req.schema ? { schema: req.schema as JsonSchema } : {}), maxTokens: req.maxTokens,
            };
            const r = await store.send(cmd, { quiet: true });
            return r.ok ? { ok: true, content: r.data.content } : { ok: false, error: r.error.message || r.error.code };
        },
        answerApproval: (key, seq, decision, persist) => {
            const id = idOf(key);
            if (id) void store.send({ type: "approval.answer", session: id, seq, decision: decision ? "approve" : "deny", ...(persist ? { persist } : {}) });
        },
        sendToSession: (key, text, images) => {
            const id = idOf(key);
            if (id) void store.send({ type: "session.send", session: id, text, ...(images?.length ? { images } : {}) });
        },
        cancelSession: (key) => {
            const id = idOf(key);
            if (id) void store.send({ type: "session.cancel", session: id });
        },
        continueSession: (key) => {
            const id = idOf(key);
            if (id) void store.send({ type: "session.continue", session: id });
        },
        highlight: (ref) => {
            // The shared views outline things on "the session's page" without naming it, because in a panel there is
            // only one. Here that is the session being read.
            const v = view.value;
            if (v.name !== "detail") return;
            const ok = allowed(v.hash, "page.highlight");
            if (!ok?.rt.capabilities.highlight) return;
            const target = ref == null ? null : ref.selector ? { selector: ref.selector } : ref.token ? { token: ref.token } : undefined;
            if (target === undefined) return;
            // Quiet: hovering is not an action worth an error message, and it fires on every pointer move.
            void store.send({ type: "page.highlight", session: ok.id, ref: target }, { quiet: true });
        },
        openLightbox: (src) => platform.openImage(src),
        hostAccess: null,
        sheetTitle: async () => null,
        savePref: (key, value) => platform.prefs.set(key, value),
        bench: false,
        // The values live in the runtime's own browser, which this page does not share.
        storedTable: null,
    };
}
