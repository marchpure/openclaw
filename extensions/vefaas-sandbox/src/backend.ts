import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CreateSandboxBackendParams,
  OpenClawConfig,
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
  SandboxBackendFactory,
  SandboxBackendManager,
  SandboxBackendHandle,
} from "openclaw/plugin-sdk/sandbox";
import { createRemoteShellSandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { AllInOneHttpClient } from "./all-in-one-client.js";
import { resolveVefaasPluginConfig, type ResolvedVefaasPluginConfig } from "./config.js";
import { createVefaasControlPlane, type VefaasRuntimeInfo } from "./control-plane.js";
import { VefaasWebShellClient } from "./webshell-client.js";

type CreateVefaasSandboxBackendFactoryParams = {
  pluginConfig: ResolvedVefaasPluginConfig;
};

type RuntimeState = VefaasRuntimeInfo & {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
};

export function createVefaasSandboxBackendFactory(
  params: CreateVefaasSandboxBackendFactoryParams,
): SandboxBackendFactory {
  return async (createParams) =>
    await createVefaasSandboxBackend({
      ...params,
      createParams,
    });
}

export function createVefaasSandboxBackendManager(params: {
  pluginConfig: ResolvedVefaasPluginConfig;
}): SandboxBackendManager {
  return {
    async describeRuntime({ entry, config }) {
      const pluginConfig = resolveVefaasPluginConfigFromConfig(config, params.pluginConfig);
      const controlPlane = createVefaasControlPlane(pluginConfig);
      const runtime = await controlPlane.getRuntime({ sandboxName: entry.containerName });
      return {
        running: runtime !== null,
        actualConfigLabel: pluginConfig.image,
        configLabelMatch: entry.image === pluginConfig.image,
      };
    },
    async removeRuntime({ entry, config }) {
      const pluginConfig = resolveVefaasPluginConfigFromConfig(config, params.pluginConfig);
      const controlPlane = createVefaasControlPlane(pluginConfig);
      await controlPlane.deleteRuntime({ sandboxName: entry.containerName });
    },
  };
}

async function createVefaasSandboxBackend(params: {
  pluginConfig: ResolvedVefaasPluginConfig;
  createParams: CreateSandboxBackendParams;
}): Promise<SandboxBackendHandle> {
  if ((params.createParams.cfg.docker.binds?.length ?? 0) > 0) {
    throw new Error("VEFaaS sandbox backend does not support sandbox.docker.binds.");
  }

  const sandboxName = buildVefaasSandboxName(params.createParams.scopeKey);
  const impl = new VefaasSandboxBackendImpl({
    createParams: params.createParams,
    pluginConfig: params.pluginConfig,
    sandboxName,
  });
  return impl.asHandle();
}

class VefaasSandboxBackendImpl {
  private ensurePromise: Promise<RuntimeState> | null = null;
  private remoteSeedPending = true;

  constructor(
    private readonly params: {
      createParams: CreateSandboxBackendParams;
      pluginConfig: ResolvedVefaasPluginConfig;
      sandboxName: string;
    },
  ) {}

  asHandle(): SandboxBackendHandle & {
    remoteWorkspaceDir: string;
    remoteAgentWorkspaceDir: string;
    runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  } {
    return {
      id: "vefaas",
      runtimeId: this.params.sandboxName,
      runtimeLabel: this.params.sandboxName,
      workdir: this.params.pluginConfig.remoteWorkspaceDir,
      env: this.params.createParams.cfg.docker.env,
      configLabel: this.params.pluginConfig.image,
      configLabelKind: "Image",
      remoteWorkspaceDir: this.params.pluginConfig.remoteWorkspaceDir,
      remoteAgentWorkspaceDir: this.params.pluginConfig.remoteAgentWorkspaceDir,
      buildExecSpec: async ({ command, workdir, env }) => {
        const runtime = await this.ensureRuntime();
        await this.maybeSeedRemoteWorkspace();
        if (!runtime.baseUrl && !runtime.webshellEndpoint) {
          throw new Error(
            "VEFaaS sandbox exec requires All-in-One HTTP baseUrl or WebShell endpoint.",
          );
        }
        const shim = path.join(path.dirname(fileURLToPath(import.meta.url)), "exec-shim.mjs");
        const webshellEndpoint = runtime.baseUrl
          ? runtime.webshellEndpoint
          : await this.refreshWebshellEndpoint(runtime);
        return {
          argv: [
            process.execPath,
            shim,
            JSON.stringify({
              baseUrl: runtime.baseUrl,
              apiKey: runtime.apiKey,
              headers: runtime.headers,
              instanceName: runtime.instanceName,
              webshellEndpoint,
              command,
              workdir: workdir ?? this.params.pluginConfig.remoteWorkspaceDir,
              env,
              timeoutMs: this.params.pluginConfig.timeoutMs,
            }),
          ],
          env: process.env,
          stdinMode: "pipe-closed",
        };
      },
      runShellCommand: async (command) => await this.runRemoteShellScript(command),
      createFsBridge: ({ sandbox }) =>
        createRemoteShellSandboxFsBridge({
          sandbox,
          runtime: this.asHandle(),
        }),
      runRemoteShellScript: async (command) => await this.runRemoteShellScript(command),
    };
  }

  async runRemoteShellScript(
    params: SandboxBackendCommandParams,
  ): Promise<SandboxBackendCommandResult> {
    const runtime = await this.ensureRuntime();
    await this.maybeSeedRemoteWorkspace();
    if (!runtime.baseUrl && !runtime.webshellEndpoint) {
      throw new Error(
        "VEFaaS sandbox file tools require All-in-One HTTP baseUrl or WebShell endpoint.",
      );
    }
    return await (
      await this.createShellClient(runtime)
    ).runShellCommand({
      ...params,
      workdir: this.params.pluginConfig.remoteWorkspaceDir,
      timeoutMs: this.params.pluginConfig.timeoutMs,
    });
  }

  private async ensureRuntime(): Promise<RuntimeState> {
    if (this.ensurePromise) {
      return await this.ensurePromise;
    }
    this.ensurePromise = this.ensureRuntimeInner();
    try {
      return await this.ensurePromise;
    } catch (error) {
      this.ensurePromise = null;
      throw error;
    }
  }

  private async ensureRuntimeInner(): Promise<RuntimeState> {
    const apiKey = resolveApiKey(this.params.pluginConfig.access?.apiKey);
    const controlPlane = createVefaasControlPlane(this.params.pluginConfig);
    const runtime = await controlPlane.ensureRuntime({
      sandboxName: this.params.sandboxName,
      apiKey,
    });
    return {
      ...runtime,
      baseUrl: this.params.pluginConfig.access?.baseUrl,
      apiKey,
      headers: this.params.pluginConfig.access?.headers,
    };
  }

  private async maybeSeedRemoteWorkspace(): Promise<void> {
    if (!this.remoteSeedPending) {
      return;
    }
    this.remoteSeedPending = false;
    try {
      await this.seedRemoteWorkspace();
    } catch (error) {
      this.remoteSeedPending = true;
      throw error;
    }
  }

  private async seedRemoteWorkspace(): Promise<void> {
    const runtime = await this.ensureRuntime();
    await (
      await this.createShellClient(runtime)
    ).runShellCommand({
      script: 'mkdir -p -- "$1" && find "$1" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +',
      args: [this.params.pluginConfig.remoteWorkspaceDir],
      timeoutMs: this.params.pluginConfig.timeoutMs,
    });
    await uploadDirectoryByTar({
      client: await this.createShellClient(runtime),
      localDir: this.params.createParams.workspaceDir,
      remoteDir: this.params.pluginConfig.remoteWorkspaceDir,
      timeoutMs: this.params.pluginConfig.timeoutMs,
    });
  }

  private async createShellClient(runtime: RuntimeState): Promise<{
    runShellCommand(
      params: SandboxBackendCommandParams & {
        workdir?: string;
        env?: Record<string, string>;
        timeoutMs?: number;
      },
    ): Promise<SandboxBackendCommandResult>;
  }> {
    if (!runtime.baseUrl) {
      const endpoint = await this.refreshWebshellEndpoint(runtime);
      if (!endpoint) {
        throw new Error("Missing VEFaaS All-in-One baseUrl and WebShell endpoint.");
      }
      return new VefaasWebShellClient({
        endpoint,
        timeoutMs: this.params.pluginConfig.timeoutMs,
      });
    }
    return new AllInOneHttpClient({
      baseUrl: runtime.baseUrl,
      apiKey: runtime.apiKey,
      headers: runtime.headers,
      instanceName: runtime.instanceName,
      timeoutMs: this.params.pluginConfig.timeoutMs,
    });
  }

  private async refreshWebshellEndpoint(runtime: RuntimeState): Promise<string | undefined> {
    const controlPlane = createVefaasControlPlane(this.params.pluginConfig);
    const fresh = await controlPlane
      .getRuntime({
        sandboxName: this.params.sandboxName,
      })
      .catch(() => null);
    return fresh?.webshellEndpoint ?? runtime.webshellEndpoint;
  }
}

async function uploadDirectoryByTar(params: {
  client: {
    runShellCommand(
      command: SandboxBackendCommandParams & { timeoutMs?: number },
    ): Promise<SandboxBackendCommandResult>;
  };
  localDir: string;
  remoteDir: string;
  timeoutMs: number;
}): Promise<void> {
  const { spawn } = await import("node:child_process");
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn("tar", ["-C", params.localDir, "-czf", "-", "."], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8") || `tar exited ${code}`));
    });
  });
  const archive = Buffer.concat(chunks).toString("base64");
  await params.client.runShellCommand({
    script:
      'set -eu\nmkdir -p -- "$1"\nbase64 -d > /tmp/openclaw-seed.tgz\ntar -xzf /tmp/openclaw-seed.tgz -C "$1"\nrm -f /tmp/openclaw-seed.tgz',
    args: [params.remoteDir],
    stdin: archive,
    timeoutMs: params.timeoutMs,
  });
}

function resolveVefaasPluginConfigFromConfig(
  config: OpenClawConfig,
  fallback: ResolvedVefaasPluginConfig,
): ResolvedVefaasPluginConfig {
  const pluginConfig = config.plugins?.entries?.["vefaas-sandbox"]?.config;
  if (!pluginConfig) {
    return fallback;
  }
  return resolveVefaasPluginConfig(pluginConfig);
}

function buildVefaasSandboxName(scopeKey: string): string {
  const trimmed = scopeKey.trim() || "session";
  const safe = normalizeLowercaseStringOrEmpty(trimmed)
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const hash = Array.from(trimmed).reduce(
    (acc, char) => ((acc * 33) ^ char.charCodeAt(0)) >>> 0,
    5381,
  );
  return `openclaw-vefaas-${safe || "session"}-${hash.toString(16).slice(0, 8)}`;
}

function resolveApiKey(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const ref = value as { source?: unknown; id?: unknown };
  if (ref.source === "env" && typeof ref.id === "string") {
    return process.env[ref.id]?.trim() || undefined;
  }
  return undefined;
}
