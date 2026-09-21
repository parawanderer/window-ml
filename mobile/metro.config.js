// metro.config.js — the app's bundler, told about the folders outside mobile/ it reads: the repo's src/native/ (the
// bridge's message types and checks) and src/pairing/api.ts (the scopes and the words pairing is described in), both
// shared with the page. Only what the app imports is bundled; the keys and the hub client never are.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const config = getDefaultConfig(__dirname);
config.watchFolders = [path.resolve(__dirname, "..", "src", "native"), path.resolve(__dirname, "..", "src", "pairing")];
module.exports = config;
