// dev-hub-pair.ts — a development page that offers this browser to a hub as a RUNTIME and shows how the connection has
// fared, until the pairing screens land in Settings. It drives `beginOffer` exactly as a screen will, then tells the
// worker to read the keyring again (`HUB_RUNTIME` `paired`). Nothing here polls the worker: a page messaging it keeps it
// alive, which is the one thing an idle test must not do, so the history is read only when asked.
import { Keyring } from "./hub/keyring";
import { beginOffer, type PendingOffer } from "./hub/pair-flow";
import { Role } from "./hub/wire";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const URL_KEY = "ml_dev_hub_url";
let pending: PendingOffer | null = null;

function ask(payload: Record<string, unknown>): Promise<unknown> {
    return chrome.runtime.sendMessage({ type: "HUB_RUNTIME", payload }).then((r: { data?: unknown; error?: string }) => {
        if (r?.error) throw new Error(r.error);
        return r?.data;
    });
}

const time = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour12: false });

async function refresh(): Promise<void> {
    const [state, log, devices] = await Promise.all([ask({}), ask({ action: "log" }), ask({ action: "devices" })]);
    const lines = (log as { atMs: number; event: string }[]).map((e) => `${time(e.atMs)}  ${e.event}`);
    $("state").textContent =
        `${JSON.stringify(state)}\n\ndevices:\n${JSON.stringify(devices, null, 1)}\n\nhistory (newest last):\n${lines.join("\n") || "(none)"}`;
}

$("offer").onclick = async () => {
    const hubUrl = $<HTMLInputElement>("url").value.trim();
    localStorage.setItem(URL_KEY, hubUrl);
    $("result").textContent = "";
    const ring = await Keyring.open();
    try {
        pending = await beginOffer(ring, { hubUrl, role: Role.ROLE_RUNTIME, label: $<HTMLInputElement>("label").value.trim() || "a browser" });
        $("code").textContent = pending.code;
        $("fp").textContent = pending.fingerprint.replace(/(....)(?=.)/g, "$1 ");
        $("hub").textContent = pending.hubName;
        $("offered").hidden = false;
        $("cancel").hidden = false;
        await pending.done;
        $("result").textContent = "Paired. The worker is connecting.";
        await ask({ action: "paired" });
        await refresh();
    } catch (e) {
        $("result").textContent = `Not paired: ${(e as Error).message}`;
    } finally {
        ring.close();
        pending = null;
        $("offered").hidden = true;
        $("cancel").hidden = true;
    }
};
$("cancel").onclick = () => pending?.cancel();
$("refresh").onclick = () => void refresh().catch((e) => { $("state").textContent = String(e); });
$("leave").onclick = async () => {
    if (!confirm("Forget this browser's membership? It keeps its keys, and can be paired again.")) return;
    const ring = await Keyring.open();
    try { await ring.leave(); } finally { ring.close(); }
    await ask({ action: "left" });
    await refresh();
};

$<HTMLInputElement>("url").value = localStorage.getItem(URL_KEY) ?? "";
void refresh().catch(() => {});
