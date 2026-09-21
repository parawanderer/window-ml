// metro.config.js — the app's bundler, told about the folders outside mobile/ it reads: the repo's src/native/ (the
// bridge's message types and checks), src/pairing/api.ts (the scopes and the words pairing is described in) and
// src/chat/tab-tree.ts (a runtime's tabs in browser order), all shared with the page. Only what the app imports is
// bundled; the keys, the hub client and the page's own components never are.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
config.watchFolders = ["native", "pairing", "chat"].map((d) => path.resolve(__dirname, "..", "src", d));
module.exports = config;
