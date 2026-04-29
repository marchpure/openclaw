import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";

export const OPENCODE_CLI_BACKEND_ID = "opencode-cli";
export const OPENCODE_CLI_DEFAULT_MODEL_REF = "opencode-cli/opencode/kimi-k2.6";

export function buildOpencodeCliBackend(): CliBackendPlugin {
  return {
    id: OPENCODE_CLI_BACKEND_ID,
    liveTest: {
      defaultModelRef: OPENCODE_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "opencode-ai",
        binaryName: "opencode",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "opencode-config-content",
    config: {
      command: "opencode",
      args: ["run", "--format", "json", "--port", "0"],
      resumeArgs: ["run", "--format", "json", "--port", "0", "--session", "{sessionId}"],
      output: "jsonl",
      input: "arg",
      modelArg: "--model",
      sessionArg: "--session",
      sessionMode: "existing",
      sessionIdFields: ["sessionID", "sessionId", "session_id"],
      systemPromptFileJsonEnv: "OPENCODE_CONFIG_CONTENT",
      systemPromptFileJsonKey: "instructions",
      systemPromptMode: "append",
      systemPromptWhen: "first",
      imageArg: "--file",
      imageMode: "repeat",
      imagePathScope: "workspace",
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
  };
}
