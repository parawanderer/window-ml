// sw.js — the probe extension's service worker: answers the page's size probes. The measurements themselves are
// `evaluate`d into this worker by measure-chrome.mjs; nothing else runs here.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.probe === "echo-length") reply({ length: typeof msg.body === "string" ? msg.body.length : -1 });
    return false;
});
chrome.runtime.onConnect.addListener((port) => {
    port.onMessage.addListener((msg) => port.postMessage({ length: typeof msg?.body === "string" ? msg.body.length : -1 }));
});
