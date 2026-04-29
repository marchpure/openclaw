import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildOpencodeCliBackend } from "./cli-backend.js";

export default definePluginEntry({
  id: "opencode",
  name: "OpenCode Setup",
  description: "Lightweight OpenCode setup hooks",
  register(api) {
    api.registerCliBackend(buildOpencodeCliBackend());
  },
});
