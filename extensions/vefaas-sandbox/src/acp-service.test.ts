import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const registry = new Map<string, unknown>();
const acpxRuntimeConstructors = vi.hoisted(() => ({
  AcpxRuntime: vi.fn(function AcpxRuntime(this: { options?: unknown }, options: unknown) {
    this.options = options;
  }),
}));

vi.mock("openclaw/plugin-sdk/acp-runtime-backend", () => ({
  registerAcpRuntimeBackend: vi.fn((entry: { id: string; runtime: unknown }) => {
    registry.set(entry.id, entry.runtime);
  }),
  unregisterAcpRuntimeBackend: vi.fn((id: string) => {
    registry.delete(id);
  }),
}));

vi.mock("acpx/runtime", () => ({
  AcpxRuntime: acpxRuntimeConstructors.AcpxRuntime,
  createFileSessionStore: vi.fn((params: unknown) => ({ kind: "file-store", params })),
  createAgentRegistry: vi.fn((params: unknown) => ({ kind: "agent-registry", params })),
}));

describe("VEFaaS OpenCode ACP service", () => {
  afterEach(() => {
    registry.clear();
    vi.clearAllMocks();
  });

  it("does not register an ACP backend unless opencodeAcp is enabled", async () => {
    const { createVefaasOpencodeAcpService } = await import("./acp-service.js");
    const { resolveVefaasPluginConfig } = await import("./config.js");
    const service = createVefaasOpencodeAcpService({
      pluginConfig: resolveVefaasPluginConfig({}),
    });

    await service.start({
      config: {},
      stateDir: await fs.mkdtemp(path.join(os.tmpdir(), "vefaas-acp-test-")),
      workspaceDir: "/workspace/local",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });

    expect(registry.has("vefaas-opencode")).toBe(false);
  });

  it("registers a VEFaaS OpenCode ACP backend with a proxy command", async () => {
    const { createVefaasOpencodeAcpService } = await import("./acp-service.js");
    const { resolveVefaasPluginConfig } = await import("./config.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "vefaas-acp-test-"));
    const infos: string[] = [];
    const service = createVefaasOpencodeAcpService({
      pluginConfig: resolveVefaasPluginConfig({
        functionId: "fn-123",
        opencodeAcp: {
          enabled: true,
        },
      }),
    });

    await service.start({
      config: {},
      stateDir,
      workspaceDir: "/workspace/local",
      logger: {
        debug() {},
        info(message) {
          infos.push(String(message));
        },
        warn() {},
        error() {},
      },
    });

    expect(registry.has("vefaas-opencode")).toBe(true);
    expect(acpxRuntimeConstructors.AcpxRuntime).toHaveBeenCalledTimes(1);
    const options = acpxRuntimeConstructors.AcpxRuntime.mock.calls[0]?.[0] as {
      agentRegistry?: { params?: { overrides?: Record<string, string> } };
      probeAgent?: string;
      permissionMode?: string;
      nonInteractivePermissions?: string;
    };
    const command = options.agentRegistry?.params?.overrides?.opencode ?? "";
    expect(command).toContain("opencode-acp-proxy.mjs");
    expect(command).toContain("--config");
    expect(options.probeAgent).toBe("opencode");
    expect(options.permissionMode).toBe("approve-all");
    expect(options.nonInteractivePermissions).toBe("deny");
    expect(infos).toContain("VEFaaS OpenCode ACP backend registered");
    await expect(
      fs.readFile(path.join(stateDir, "vefaas-opencode-acp", "vefaas-config.json"), "utf8"),
    ).resolves.toContain('"functionId":"fn-123"');
  });
});
