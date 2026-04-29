import { describe, expect, it } from "vitest";
import { prepareCliBundleMcpConfig } from "./bundle-mcp.js";
import { cliBundleMcpHarness, setupCliBundleMcpTestHarness } from "./bundle-mcp.test-support.js";

setupCliBundleMcpTestHarness();

describe("prepareCliBundleMcpConfig opencode mode", () => {
  it("injects bundle MCP into OPENCODE_CONFIG_CONTENT", async () => {
    const workspaceDir = await cliBundleMcpHarness.tempHarness.createTempDir(
      "openclaw-cli-bundle-mcp-opencode-",
    );

    const prepared = await prepareCliBundleMcpConfig({
      enabled: true,
      mode: "opencode-config-content",
      backend: {
        command: "opencode",
        args: ["run", "--format", "json"],
      },
      workspaceDir,
      config: { plugins: { enabled: false } },
      additionalConfig: {
        mcpServers: {
          openclaw: {
            type: "http",
            url: "http://127.0.0.1:23119/mcp",
            headers: {
              Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
            },
          },
          localProbe: {
            type: "stdio",
            command: "node",
            args: ["probe.mjs"],
            env: {
              PROBE_TOKEN: "${PROBE_TOKEN}",
            },
          },
        },
      },
      env: {
        OPENCLAW_MCP_TOKEN: "loopback-token-123",
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: "opencode/kimi-k2.6",
          mcp: {
            existing: { type: "remote", url: "https://example.test/mcp", enabled: true },
          },
        }),
      },
    });

    expect(prepared.backend.args).toEqual(["run", "--format", "json"]);
    expect(prepared.env?.OPENCLAW_MCP_TOKEN).toBe("loopback-token-123");
    const raw = JSON.parse(prepared.env?.OPENCODE_CONFIG_CONTENT ?? "{}") as {
      model?: string;
      mcp?: Record<string, Record<string, unknown>>;
    };
    expect(raw.model).toBe("opencode/kimi-k2.6");
    expect(raw.mcp?.existing).toEqual({
      type: "remote",
      url: "https://example.test/mcp",
      enabled: true,
    });
    expect(raw.mcp?.openclaw).toEqual({
      enabled: true,
      type: "remote",
      url: "http://127.0.0.1:23119/mcp",
      headers: {
        Authorization: "Bearer {env:OPENCLAW_MCP_TOKEN}",
      },
    });
    expect(raw.mcp?.localProbe).toEqual({
      enabled: true,
      type: "local",
      command: "node",
      args: ["probe.mjs"],
      environment: {
        PROBE_TOKEN: "${PROBE_TOKEN}",
      },
    });
  });
});
