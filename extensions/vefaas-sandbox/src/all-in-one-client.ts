import { randomUUID } from "node:crypto";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "openclaw/plugin-sdk/sandbox";

export type AllInOneClientConfig = {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  instanceName?: string;
  timeoutMs: number;
};

type JsonObject = Record<string, unknown>;

export class AllInOneHttpClient {
  private readonly baseUrl: string;

  constructor(private readonly config: AllInOneClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
  }

  async runShellCommand(
    params: SandboxBackendCommandParams & {
      workdir?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<SandboxBackendCommandResult> {
    const stdinPath =
      params.stdin === undefined ? undefined : `/tmp/openclaw-vefaas-stdin-${randomUUID()}.bin`;
    if (stdinPath) {
      await this.writeFile(stdinPath, params.stdin, params.signal);
    }
    const command = buildCommand({
      script: params.script,
      args: params.args ?? [],
      stdinPath,
    });
    const response = await this.requestJson("v1/bash/exec", {
      method: "POST",
      body: {
        command,
        exec_dir: params.workdir,
        env: params.env,
        async_mode: false,
        timeout: Math.ceil((params.timeoutMs ?? this.config.timeoutMs) / 1000),
        hard_timeout: Math.ceil((params.timeoutMs ?? this.config.timeoutMs) / 1000),
        max_output_length: 0,
      },
      signal: params.signal,
    });
    const result = parseCommandResult(response);
    if (!params.allowFailure && result.code !== 0) {
      return {
        stdout: result.stdout,
        stderr:
          result.stderr.length > 0
            ? result.stderr
            : Buffer.from(`VEFaaS command failed with exit code ${result.code}`),
        code: result.code,
      };
    }
    return result;
  }

  async readFile(path: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await this.requestJson("v1/file/read", {
      method: "POST",
      body: { file: path },
      signal,
    });
    const data = getResponseData(response);
    const content = typeof data.content === "string" ? data.content : "";
    return Buffer.from(content, "utf8");
  }

  async writeFile(path: string, data: Buffer | string, signal?: AbortSignal): Promise<void> {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await this.requestJson("v1/file/write", {
      method: "POST",
      body: {
        file: path,
        content: buffer.toString("base64"),
        encoding: "base64",
        trailing_newline: false,
      },
      signal,
    });
  }

  private async requestJson(
    path: string,
    params: {
      method: "GET" | "POST";
      body?: JsonObject;
      signal?: AbortSignal;
    },
  ): Promise<JsonObject> {
    const url = new URL(`${this.baseUrl}/${path.replace(/^\/+/, "")}`);
    if (this.config.instanceName) {
      url.searchParams.set("faasInstanceName", this.config.instanceName);
    }
    const headers: Record<string, string> = {
      ...(params.body ? { "content-type": "application/json" } : {}),
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(this.config.instanceName ? { "x-faas-instance-name": this.config.instanceName } : {}),
      ...(this.config.headers ?? {}),
    };
    const response = await fetch(url, {
      method: params.method,
      headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: params.signal,
    });
    const text = await response.text();
    const parsed = parseJsonObject(text);
    if (!response.ok) {
      const detail =
        typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.detail === "string"
            ? parsed.detail
            : text;
      throw new Error(`VEFaaS All-in-One HTTP ${response.status}: ${detail}`);
    }
    return parsed;
  }
}

function buildCommand(params: { script: string; args: string[]; stdinPath?: string }): string {
  const encoded = Buffer.from(
    JSON.stringify({
      script: params.script,
      args: params.args,
      stdinPath: params.stdinPath,
    }),
  ).toString("base64");
  return [
    "python3 - <<'PY'",
    "import base64, json, os, subprocess, sys",
    `payload = json.loads(base64.b64decode(${JSON.stringify(encoded)}))`,
    "stdin_path = payload.get('stdinPath')",
    "stdin_file = open(stdin_path, 'rb') if stdin_path else None",
    "try:",
    "    code = subprocess.call(['/bin/sh', '-c', payload['script'], 'openclaw-vefaas', *payload['args']], stdin=stdin_file)",
    "finally:",
    "    if stdin_file:",
    "        stdin_file.close()",
    "    if stdin_path:",
    "        try:",
    "            os.unlink(stdin_path)",
    "        except FileNotFoundError:",
    "            pass",
    "sys.exit(code)",
    "PY",
  ].join("\n");
}

function parseJsonObject(text: string): JsonObject {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function getResponseData(response: JsonObject): JsonObject {
  const data = response.data;
  return data && typeof data === "object" && !Array.isArray(data) ? (data as JsonObject) : response;
}

function parseCommandResult(response: JsonObject): SandboxBackendCommandResult {
  const data = getResponseData(response);
  const stdout = typeof data.stdout === "string" ? data.stdout : "";
  const stderr = typeof data.stderr === "string" ? data.stderr : "";
  const code = typeof data.exit_code === "number" ? data.exit_code : 0;
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    code,
  };
}
