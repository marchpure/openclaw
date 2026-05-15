import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVefaasSandboxBackendFactory, createVefaasSandboxBackendManager } from "./backend.js";
import { resolveVefaasPluginConfig } from "./config.js";
import { setVefaasControlPlaneFactoryForTest } from "./control-plane.js";

class FakeWebSocket {
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(_url: string) {
    queueMicrotask(() => this.emit("open", {}));
  }

  send(data: string): void {
    const frame = JSON.parse(data) as { Op?: string; Data?: string };
    if (frame.Op !== "stdin" || !frame.Data?.includes("python3 - <<'PY'")) {
      return;
    }
    const marker = /marker = "([^"]+)"/.exec(frame.Data)?.[1];
    if (!marker) {
      return;
    }
    const result = Buffer.from(
      JSON.stringify({
        code: 0,
        stdout: "",
        stderr: "",
      }),
    ).toString("base64");
    queueMicrotask(() =>
      this.emit("message", {
        data: JSON.stringify({
          Op: "stdout",
          Data: [`${marker}:begin`, `${marker}:chunk:${result}`, `${marker}:end`].join("\n"),
        }),
      }),
    );
  }

  close(): void {}

  addEventListener(event: string, listener: (event: unknown) => void): void {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

describe("vefaas backend manager", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    setVefaasControlPlaneFactoryForTest();
    globalThis.WebSocket = originalWebSocket;
  });

  it("checks runtime status with config override from OpenClaw config", async () => {
    const getRuntime = vi.fn().mockResolvedValue({
      functionId: "fn-123",
      instanceName: "openclaw-vefaas-session",
    });
    setVefaasControlPlaneFactoryForTest(() => ({
      ensureRuntime: vi.fn(),
      getRuntime,
      deleteRuntime: vi.fn(),
    }));

    const manager = createVefaasSandboxBackendManager({
      pluginConfig: resolveVefaasPluginConfig({
        image: "default-image",
      }),
    });

    const result = await manager.describeRuntime({
      entry: {
        containerName: "openclaw-vefaas-session",
        backendId: "vefaas",
        runtimeLabel: "openclaw-vefaas-session",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "custom-image",
        configLabelKind: "Image",
      },
      config: {
        plugins: {
          entries: {
            "vefaas-sandbox": {
              enabled: true,
              config: {
                image: "custom-image",
              },
            },
          },
        },
      },
    });

    expect(result).toEqual({
      running: true,
      actualConfigLabel: "custom-image",
      configLabelMatch: true,
    });
    expect(getRuntime).toHaveBeenCalledWith({ sandboxName: "openclaw-vefaas-session" });
  });

  it("removes runtimes through the VEFaaS control plane", async () => {
    const deleteRuntime = vi.fn();
    setVefaasControlPlaneFactoryForTest(() => ({
      ensureRuntime: vi.fn(),
      getRuntime: vi.fn(),
      deleteRuntime,
    }));

    const manager = createVefaasSandboxBackendManager({
      pluginConfig: resolveVefaasPluginConfig({}),
    });

    await manager.removeRuntime({
      entry: {
        containerName: "openclaw-vefaas-session",
        backendId: "vefaas",
        runtimeLabel: "openclaw-vefaas-session",
        sessionKey: "agent:main",
        createdAtMs: 1,
        lastUsedAtMs: 1,
        image: "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
        configLabelKind: "Image",
      },
      config: {},
    });

    expect(deleteRuntime).toHaveBeenCalledWith({ sandboxName: "openclaw-vefaas-session" });
  });

  it("builds exec specs that can use the WebShell endpoint without access.baseUrl", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-vefaas-test-"));
    await fs.writeFile(path.join(workspaceDir, "README.md"), "test\n");
    setVefaasControlPlaneFactoryForTest(() => ({
      ensureRuntime: vi.fn().mockResolvedValue({
        functionId: "fn-123",
        instanceName: "vefaas-fn-123-session-sandbox",
        webshellEndpoint: "wss://example.invalid/ws",
      }),
      getRuntime: vi.fn().mockResolvedValue({
        functionId: "fn-123",
        instanceName: "vefaas-fn-123-session-sandbox",
        webshellEndpoint: "wss://example.invalid/ws",
      }),
      deleteRuntime: vi.fn(),
    }));

    const factory = createVefaasSandboxBackendFactory({
      pluginConfig: resolveVefaasPluginConfig({
        functionId: "fn-123",
      }),
    });
    const backend = await factory({
      sessionKey: "agent:main",
      scopeKey: "agent-main",
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      cfg: {
        mode: "all",
        backend: "vefaas",
        scope: "session",
        workspaceAccess: "rw",
        workspaceRoot: "/tmp/openclaw-sandboxes",
        docker: {
          image: "sandbox",
          containerPrefix: "openclaw-sbx",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: [],
          network: "none",
          capDrop: ["ALL"],
        },
        ssh: {
          command: "ssh",
          workspaceRoot: "/tmp/openclaw-sandboxes",
          strictHostKeyChecking: true,
          updateHostKeys: true,
        },
        browser: {
          enabled: false,
          image: "browser",
          containerPrefix: "openclaw-sbx-browser",
          network: "none",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: true,
          enableNoVnc: false,
          allowHostControl: false,
          autoStart: false,
          autoStartTimeoutMs: 30_000,
        },
        tools: {},
        prune: {
          idleHours: 0,
          maxAgeDays: 0,
        },
      },
    });

    const execSpec = await backend.buildExecSpec({
      command: "pwd",
      env: {},
      usePty: false,
    });

    expect(execSpec.argv.join(" ")).toContain("wss://example.invalid/ws");
    expect(execSpec.stdinMode).toBe("pipe-closed");
  });
});
