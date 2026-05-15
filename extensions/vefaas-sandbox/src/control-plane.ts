import { buildAllInOneEnv } from "./all-in-one-env.js";
import type { ResolvedVefaasPluginConfig } from "./config.js";

type VefaasSdk = {
  VEFAASClient: new (params: Record<string, unknown>) => {
    send(command: unknown): Promise<Record<string, unknown>>;
  };
  CreateFunctionCommand: new (params: Record<string, unknown>) => unknown;
  UpdateFunctionCommand: new (params: Record<string, unknown>) => unknown;
  GetFunctionCommand: new (params: Record<string, unknown>) => unknown;
  ListFunctionsCommand: new (params: Record<string, unknown>) => unknown;
  ListRevisionsCommand: new (params: Record<string, unknown>) => unknown;
  ReleaseCommand: new (params: Record<string, unknown>) => unknown;
  GetReleaseStatusCommand: new (params: Record<string, unknown>) => unknown;
  CreateSandboxCommand: new (params: Record<string, unknown>) => unknown;
  ListSandboxesCommand: new (params: Record<string, unknown>) => unknown;
  ListFunctionInstancesCommand: new (params: Record<string, unknown>) => unknown;
  GenWebshellEndpointCommand: new (params: Record<string, unknown>) => unknown;
  KillSandboxCommand: new (params: Record<string, unknown>) => unknown;
};

export type VefaasRuntimeInfo = {
  functionId: string;
  instanceName: string;
  webshellEndpoint?: string;
};

export type VefaasControlPlane = {
  ensureRuntime(params: { sandboxName: string; apiKey?: string }): Promise<VefaasRuntimeInfo>;
  getRuntime(params: { sandboxName: string }): Promise<VefaasRuntimeInfo | null>;
  deleteRuntime(params: { sandboxName: string }): Promise<void>;
};

let controlPlaneFactory: (config: ResolvedVefaasPluginConfig) => VefaasControlPlane = (config) =>
  new SdkVefaasControlPlane(config);

export function createVefaasControlPlane(config: ResolvedVefaasPluginConfig): VefaasControlPlane {
  return controlPlaneFactory(config);
}

export function setVefaasControlPlaneFactoryForTest(
  factory?: (config: ResolvedVefaasPluginConfig) => VefaasControlPlane,
): void {
  controlPlaneFactory = factory ?? ((config) => new SdkVefaasControlPlane(config));
}

class SdkVefaasControlPlane implements VefaasControlPlane {
  private sdkPromise: Promise<VefaasSdk> | null = null;
  private clientPromise: Promise<InstanceType<VefaasSdk["VEFAASClient"]>> | null = null;

  constructor(private readonly config: ResolvedVefaasPluginConfig) {}

  async ensureRuntime(params: {
    sandboxName: string;
    apiKey?: string;
  }): Promise<VefaasRuntimeInfo> {
    const functionId = await this.ensureFunction();
    const existing = await this.findInstance(functionId, params.sandboxName);
    if (existing) {
      return existing;
    }
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    const env = buildAllInOneEnv({
      workspaceDir: this.config.remoteWorkspaceDir,
      port: this.config.port,
      apiKey: params.apiKey,
      overrides: this.config.env,
    });
    const result = await client.send(
      new sdk.CreateSandboxCommand({
        FunctionId: functionId,
        SessionId: params.sandboxName,
        Timeout: Math.max(1, Math.ceil(this.config.ttlSeconds / 60)),
        TimeoutUnit: "minute",
        CpuMilli: resourceCpuMilli(this.config.resources?.cpuCores),
        MemoryMB: this.config.resources?.memoryMiB,
        MaxConcurrency: 10,
        RequestTimeout: Math.ceil(this.config.timeoutMs / 1000),
        Envs: Object.entries(env).map(([Key, Value]) => ({ Key, Value })),
        Metadata: {
          openclaw: "true",
          sandboxName: params.sandboxName,
        },
        InstanceImageInfo: {
          Image: this.config.image,
          Command: this.config.imageCommand,
          Port: this.config.port,
        },
      }),
    );
    const instanceName = stringField(result, ["Result", "SandboxId"]) ?? params.sandboxName;
    return await this.waitForInstance(functionId, params.sandboxName, instanceName);
  }

  async getRuntime(params: { sandboxName: string }): Promise<VefaasRuntimeInfo | null> {
    const functionId = await this.resolveFunctionId();
    if (!functionId) {
      return null;
    }
    return await this.findInstance(functionId, params.sandboxName);
  }

  async deleteRuntime(params: { sandboxName: string }): Promise<void> {
    const functionId = await this.resolveFunctionId();
    if (!functionId) {
      return;
    }
    const existing = await this.findInstance(functionId, params.sandboxName);
    if (!existing) {
      return;
    }
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    await client
      .send(
        new sdk.KillSandboxCommand({
          FunctionId: functionId,
          SandboxId: existing.instanceName,
        }),
      )
      .catch(() => undefined);
  }

  private async ensureFunction(): Promise<string> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    const existing = await this.resolveFunctionId();
    if (existing) {
      await this.updateFunction(existing);
      await this.releaseLatestRevision(existing);
      return existing;
    }
    const result = await client.send(
      new sdk.CreateFunctionCommand({
        Name: this.config.functionName,
        Description: "OpenClaw VEFaaS All-in-One sandbox",
        Runtime: "native/v1",
        SourceType: "image",
        Source: this.config.image,
        FunctionType: "sandbox",
        Command: this.config.imageCommand,
        Port: this.config.port,
        CpuMilli: resourceCpuMilli(this.config.resources?.cpuCores),
        MemoryMB: this.config.resources?.memoryMiB ?? 4096,
        MaxConcurrency: 10,
        RequestTimeout: Math.ceil(this.config.timeoutMs / 1000),
        CpuStrategy: "always",
        ProjectName: "default",
        VpcConfig: { EnableVpc: false },
        TlsConfig: { EnableLog: false },
        Tags: [{ Key: "openclaw", Value: "vefaas-sandbox" }],
      }),
    );
    const functionId = requireStringField(result, ["Result", "Id"], "CreateFunction Result.Id");
    await this.releaseLatestRevision(functionId);
    return functionId;
  }

  private async updateFunction(functionId: string): Promise<void> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    await client.send(
      new sdk.UpdateFunctionCommand({
        Id: functionId,
        SourceType: "image",
        Source: this.config.image,
        Command: this.config.imageCommand,
        Port: this.config.port,
        CpuMilli: resourceCpuMilli(this.config.resources?.cpuCores),
        MemoryMB: this.config.resources?.memoryMiB ?? 4096,
        MaxConcurrency: 10,
        RequestTimeout: Math.ceil(this.config.timeoutMs / 1000),
        ProjectName: "default",
        VpcConfig: { EnableVpc: false },
        TlsConfig: { EnableLog: false },
      }),
    );
  }

  private async releaseLatestRevision(functionId: string): Promise<void> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    const revisions = await client.send(
      new sdk.ListRevisionsCommand({
        FunctionId: functionId,
        PageNumber: 1,
        PageSize: 20,
      }),
    );
    const items = arrayField(revisions, ["Result", "Items"]);
    const revisionNumber = Math.max(
      ...items
        .map((item) => numberField(item, ["RevisionNumber"]))
        .filter((value): value is number => value !== undefined),
    );
    if (!Number.isFinite(revisionNumber)) {
      throw new Error("VEFaaS function has no revision to release.");
    }
    await client.send(
      new sdk.ReleaseCommand({
        FunctionId: functionId,
        RevisionNumber: revisionNumber,
        TargetTrafficWeight: 100,
        RollingStep: 100,
        MaxInstance: 1,
        Description: "OpenClaw VEFaaS sandbox release",
      }),
    );
    for (let attempt = 0; attempt < 60; attempt++) {
      const status = await client.send(new sdk.GetReleaseStatusCommand({ FunctionId: functionId }));
      const current = stringField(status, ["Result", "Status"]) ?? stringField(status, ["Status"]);
      if (current?.toLowerCase() === "done") {
        return;
      }
      await sleep(2_000);
    }
    throw new Error(`Timed out waiting for VEFaaS function ${functionId} release.`);
  }

  private async resolveFunctionId(): Promise<string | null> {
    if (this.config.functionId) {
      return this.config.functionId;
    }
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    const result = await client.send(
      new sdk.ListFunctionsCommand({
        PageNumber: 1,
        PageSize: 100,
      }),
    );
    const match = arrayField(result, ["Result", "Items"]).find(
      (item) => stringField(item, ["Name"]) === this.config.functionName,
    );
    return match ? (stringField(match, ["Id"]) ?? null) : null;
  }

  private async findInstance(
    functionId: string,
    sandboxName: string,
  ): Promise<VefaasRuntimeInfo | null> {
    const sandbox = await this.findSandbox(functionId, sandboxName);
    if (!sandbox) {
      return null;
    }
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    const result = await client.send(
      new sdk.ListFunctionInstancesCommand({ FunctionId: functionId }),
    );
    const instances = arrayField(result, ["Result", "Items"]);
    const exact = instances.find(
      (item) =>
        stringField(item, ["InstanceName"]) === sandbox.instanceName ||
        stringField(item, ["Id"]) === sandbox.instanceName,
    );
    if (!exact) {
      return null;
    }
    const status = stringField(exact, ["InstanceStatus"]);
    if (status && status !== "Ready") {
      return null;
    }
    const instanceName = stringField(exact, ["InstanceName"]) ?? sandbox.instanceName;
    if (!instanceName) {
      return null;
    }
    return {
      functionId,
      instanceName,
      webshellEndpoint: await this.getWebshellEndpoint(functionId, instanceName),
    };
  }

  private async findSandbox(
    functionId: string,
    sandboxName: string,
  ): Promise<{ instanceName: string } | null> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    const result = await client.send(
      new sdk.ListSandboxesCommand({
        FunctionId: functionId,
        Metadata: {
          openclaw: "true",
          sandboxName,
        },
        PageNumber: 1,
        PageSize: 100,
      }),
    );
    const sandboxes =
      arrayField(result, ["Result", "Sandboxes"]).length > 0
        ? arrayField(result, ["Result", "Sandboxes"])
        : arrayField(result, ["Sandboxes"]);
    const exact = sandboxes.find(
      (item) =>
        stringField(item, ["SessionId"]) === sandboxName ||
        stringField(item, ["Metadata", "sandboxName"]) === sandboxName,
    );
    if (!exact) {
      return null;
    }
    const status = stringField(exact, ["Status"]);
    if (status && !["Ready", "Running"].includes(status)) {
      return null;
    }
    const instanceName = stringField(exact, ["Id"]);
    return instanceName ? { instanceName } : null;
  }

  private async waitForInstance(
    functionId: string,
    sandboxName: string,
    instanceName: string,
  ): Promise<VefaasRuntimeInfo> {
    for (let attempt = 0; attempt < 90; attempt++) {
      const runtime = await this.findInstance(functionId, sandboxName);
      if (runtime?.instanceName === instanceName) {
        return runtime;
      }
      await sleep(5_000);
    }
    throw new Error(`Timed out waiting for VEFaaS sandbox instance ${instanceName}.`);
  }

  private async getWebshellEndpoint(
    functionId: string,
    instanceName: string,
  ): Promise<string | undefined> {
    const sdk = await this.loadSdk();
    const client = await this.getClient();
    const result = await client
      .send(
        new sdk.GenWebshellEndpointCommand({
          FunctionId: functionId,
          InstanceName: instanceName,
        }),
      )
      .catch(() => undefined);
    return result
      ? (stringField(result, ["Result", "Endpoint"]) ?? stringField(result, ["Endpoint"]))
      : undefined;
  }

  private async getClient(): Promise<InstanceType<VefaasSdk["VEFAASClient"]>> {
    if (!this.clientPromise) {
      this.clientPromise = this.loadSdk().then((sdk) => {
        const params: Record<string, unknown> = {};
        const accessKeyId = resolveSecretRef(this.config.accessKeyId, [
          "VOLCSTACK_ACCESS_KEY_ID",
          "VOLCSTACK_ACCESS_KEY",
          "VOLCENGINE_ACCESS_KEY",
          "VOLCENGINE_ACCESS_KEY_ID",
        ]);
        const secretAccessKey = resolveSecretRef(this.config.secretAccessKey, [
          "VOLCSTACK_SECRET_ACCESS_KEY",
          "VOLCSTACK_SECRET_KEY",
          "VOLCENGINE_SECRET_KEY",
          "VOLCENGINE_SECRET_ACCESS_KEY",
        ]);
        const sessionToken = resolveSecretRef(this.config.sessionToken, [
          "VOLCSTACK_SESSION_TOKEN",
          "VOLCENGINE_SESSION_TOKEN",
        ]);
        if (accessKeyId) {
          params.accessKeyId = accessKeyId;
        }
        if (secretAccessKey) {
          params.secretAccessKey = secretAccessKey;
        }
        if (sessionToken) {
          params.sessionToken = sessionToken;
        }
        if (this.config.region) {
          params.region = this.config.region;
        }
        if (this.config.endpoint) {
          params.endpoint = this.config.endpoint;
        }
        return new sdk.VEFAASClient(params);
      });
    }
    return await this.clientPromise;
  }

  private async loadSdk(): Promise<VefaasSdk> {
    if (!this.sdkPromise) {
      this.sdkPromise = import("@volcengine/vefaas") as Promise<VefaasSdk>;
    }
    return await this.sdkPromise;
  }
}

function resourceCpuMilli(cpuCores: number | undefined): number | undefined {
  return cpuCores === undefined ? undefined : Math.floor(cpuCores * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stringField(value: unknown, path: string[]): string | undefined {
  const found = field(value, path);
  return typeof found === "string" && found.trim() ? found : undefined;
}

function requireStringField(value: unknown, path: string[], label: string): string {
  const found = stringField(value, path);
  if (!found) {
    throw new Error(`Missing VEFaaS ${label}.`);
  }
  return found;
}

function numberField(value: unknown, path: string[]): number | undefined {
  const found = field(value, path);
  return typeof found === "number" && Number.isFinite(found) ? found : undefined;
}

function arrayField(value: unknown, path: string[]): unknown[] {
  const found = field(value, path);
  return Array.isArray(found) ? found : [];
}

function resolveSecretRef(value: unknown, envFallbacks: string[]): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const ref = value as { source?: unknown; id?: unknown };
    if (ref.source === "env" && typeof ref.id === "string") {
      return process.env[ref.id]?.trim() || undefined;
    }
  }
  for (const name of envFallbacks) {
    const candidate = process.env[name]?.trim();
    if (candidate) {
      return candidate;
    }
  }
  return undefined;
}

function field(value: unknown, path: string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}
