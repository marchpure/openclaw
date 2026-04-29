import type { BundleMcpConfig, BundleMcpServerConfig } from "../../plugins/bundle-mcp.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import {
  decodeHeaderEnvPlaceholder,
  isRecord,
  normalizeStringArray,
  normalizeStringRecord,
} from "./bundle-mcp-adapter-shared.js";

function normalizeOpencodeMcpType(server: BundleMcpServerConfig): "local" | "remote" {
  const rawType = normalizeOptionalLowercaseString(server.type);
  if (rawType === "remote" || rawType === "http" || rawType === "sse") {
    return "remote";
  }
  if (typeof server.url === "string") {
    return "remote";
  }
  return "local";
}

function normalizeOpencodeHeaderValue(value: string): string {
  const decoded = decodeHeaderEnvPlaceholder(value);
  if (!decoded) {
    return value;
  }
  return decoded.bearer ? `Bearer {env:${decoded.envVar}}` : `{env:${decoded.envVar}}`;
}

function normalizeOpencodeMcpServer(server: BundleMcpServerConfig): Record<string, unknown> {
  const next: Record<string, unknown> = {
    enabled: true,
    type: normalizeOpencodeMcpType(server),
  };
  if (typeof server.command === "string") {
    next.command = server.command;
  }
  const args = normalizeStringArray(server.args);
  if (args) {
    next.args = args;
  }
  const env = normalizeStringRecord(server.env);
  if (env) {
    next.environment = env;
  }
  if (typeof server.url === "string") {
    next.url = server.url;
  }
  const headers = normalizeStringRecord(server.headers);
  if (headers) {
    next.headers = Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, normalizeOpencodeHeaderValue(value)]),
    );
  }
  return next;
}

function readExistingOpencodeConfig(env?: Record<string, string>): Record<string, unknown> {
  const raw = env?.OPENCODE_CONFIG_CONTENT;
  if (!raw?.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

export function injectOpencodeMcpConfigEnv(params: {
  config: BundleMcpConfig;
  env?: Record<string, string>;
}): Record<string, string> {
  const opencodeConfig = readExistingOpencodeConfig(params.env);
  const existingMcp = isRecord(opencodeConfig.mcp) ? opencodeConfig.mcp : {};
  opencodeConfig.mcp = {
    ...existingMcp,
    ...Object.fromEntries(
      Object.entries(params.config.mcpServers).map(([name, server]) => [
        name,
        normalizeOpencodeMcpServer(server),
      ]),
    ),
  };
  return {
    ...(params.env ?? {}),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(opencodeConfig),
  };
}
