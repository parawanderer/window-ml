// scan-ask.ts — asks the worker which registered values a composer's draft holds (`SCAN_TURN`), from an extension page.

// Uses `chrome`, so only an extension frame or page imports it; the composers reach it through `services().scanTurn`.

/**
 * Ask the worker to scan a draft (SECRET_HANDLES.md, "What the person sees"). The answer is what `SCAN_TURN` returns, for
 * `readScan` (turn-scan.ts) to read: spans, names and tokens, never a value.
 * @param texts the typed words, then each text file's contents (at most 64)
 * @returns the worker's response, or null when it could not be asked
 */
export function askScan(texts: string[]): Promise<unknown> {
    return new Promise((resolve) => {
        try {
            chrome.runtime.sendMessage({ type: "SCAN_TURN", payload: { texts } }, (res: unknown) => {
                void chrome.runtime.lastError;
                resolve(res ?? null);
            });
        } catch { resolve(null); }
    });
}
