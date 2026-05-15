import fsSync from "node:fs";
import { describe, expect, it } from "vitest";
import { createVefaasPluginConfigSchema, resolveVefaasPluginConfig } from "./config.js";

describe("vefaas plugin config", () => {
  it("applies defaults", () => {
    expect(resolveVefaasPluginConfig(undefined)).toEqual({
      mode: "remote",
      functionId: undefined,
      functionName: "openclaw-vefaas-sandbox",
      accessKeyId: undefined,
      secretAccessKey: undefined,
      sessionToken: undefined,
      region: undefined,
      endpoint: undefined,
      image: "enterprise-public-cn-beijing.cr.volces.com/vefaas-public/all-in-one-sandbox:1.9.3",
      imageCommand: "/opt/gem/run.sh",
      port: 8080,
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/agent",
      ttlSeconds: 3600,
      timeoutMs: 120_000,
      resources: undefined,
      network: undefined,
      access: undefined,
      env: {},
    });
  });

  it("normalizes explicit production settings", () => {
    const resolved = resolveVefaasPluginConfig({
      functionId: "fn-123",
      functionName: "openclaw-custom",
      accessKeyId: {
        source: "env",
        id: "VOLCENGINE_ACCESS_KEY",
      },
      secretAccessKey: {
        source: "env",
        id: "VOLCENGINE_SECRET_KEY",
      },
      sessionToken: {
        source: "env",
        id: "VOLCENGINE_SESSION_TOKEN",
      },
      region: "cn-beijing",
      endpoint: "https://vefaas.example",
      image: "registry.example/openclaw-opencode:prod",
      imageCommand: "/opt/openclaw/start.sh",
      port: 18080,
      remoteWorkspaceDir: "/workspace/../workspace/project",
      remoteAgentWorkspaceDir: "/agent/./session",
      ttlSeconds: 7200,
      timeoutSeconds: 30,
      resources: {
        cpuCores: 2,
        memoryMiB: 4096,
      },
      network: {
        egress: "restricted",
        vpcId: "vpc-1",
      },
      access: {
        baseUrl: "https://sandbox.example",
        apiKey: {
          source: "env",
          provider: "default",
          id: "VEFAAS_SANDBOX_API_KEY",
        },
        headers: {
          "x-demo": "1",
        },
      },
      env: {
        DISABLE_BROWSER: "true",
      },
    });

    expect(resolved).toEqual({
      mode: "remote",
      functionId: "fn-123",
      functionName: "openclaw-custom",
      accessKeyId: {
        source: "env",
        id: "VOLCENGINE_ACCESS_KEY",
      },
      secretAccessKey: {
        source: "env",
        id: "VOLCENGINE_SECRET_KEY",
      },
      sessionToken: {
        source: "env",
        id: "VOLCENGINE_SESSION_TOKEN",
      },
      region: "cn-beijing",
      endpoint: "https://vefaas.example",
      image: "registry.example/openclaw-opencode:prod",
      imageCommand: "/opt/openclaw/start.sh",
      port: 18080,
      remoteWorkspaceDir: "/workspace/project",
      remoteAgentWorkspaceDir: "/agent/session",
      ttlSeconds: 7200,
      timeoutMs: 30_000,
      resources: {
        cpuCores: 2,
        memoryMiB: 4096,
      },
      network: {
        egress: "restricted",
        vpcId: "vpc-1",
      },
      access: {
        baseUrl: "https://sandbox.example",
        apiKey: {
          source: "env",
          provider: "default",
          id: "VEFAAS_SANDBOX_API_KEY",
        },
        headers: {
          "x-demo": "1",
        },
      },
      env: {
        DISABLE_BROWSER: "true",
      },
    });
  });

  it("rejects mirror mode", () => {
    expect(() =>
      resolveVefaasPluginConfig({
        mode: "mirror",
      }),
    ).toThrow("mode must be remote");
  });

  it("rejects relative remote paths", () => {
    expect(() =>
      resolveVefaasPluginConfig({
        remoteWorkspaceDir: "workspace",
      }),
    ).toThrow("VEFaaS remoteWorkspaceDir must be absolute");
  });

  it("keeps the runtime json schema in sync with the manifest config schema", () => {
    const manifest = JSON.parse(
      fsSync.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema?: unknown };

    expect(createVefaasPluginConfigSchema().jsonSchema).toEqual(manifest.configSchema);
  });
});
