import { randomUUID } from "node:crypto";
import type {
  SandboxBackendCommandParams,
  SandboxBackendCommandResult,
} from "openclaw/plugin-sdk/sandbox";

type WebSocketLike = {
  send(data: string): void;
  close(): void;
  addEventListener(
    event: "open" | "message" | "error" | "close",
    listener: (event: unknown) => void,
    options?: { once?: boolean },
  ): void;
};

type WebSocketConstructor = new (url: string) => WebSocketLike;

export type VefaasWebShellClientConfig = {
  endpoint: string;
  timeoutMs: number;
};

export class VefaasWebShellClient {
  constructor(private readonly config: VefaasWebShellClientConfig) {}

  async runShellCommand(
    params: SandboxBackendCommandParams & {
      workdir?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
    },
  ): Promise<SandboxBackendCommandResult> {
    const marker = `__OPENCLAW_VEFAAS_RESULT_${randomUUID().replaceAll("-", "")}__`;
    const command = buildWrappedCommand({
      marker,
      script: params.script,
      args: params.args ?? [],
      stdin: params.stdin,
      workdir: params.workdir,
      env: params.env,
    });
    const output = await this.runInteractiveCommand({
      command,
      marker,
      timeoutMs: params.timeoutMs ?? this.config.timeoutMs,
      signal: params.signal,
    });
    const result = parseMarkedResult(output, marker);
    if (!params.allowFailure && result.code !== 0 && result.stderr.length === 0) {
      return {
        ...result,
        stderr: Buffer.from(`VEFaaS WebShell command failed with exit code ${result.code}`),
      };
    }
    return result;
  }

  private async runInteractiveCommand(params: {
    command: string;
    marker: string;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const WebSocketCtor = getWebSocketConstructor();
    const ws = new WebSocketCtor(this.config.endpoint);
    const chunks: string[] = [];
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let sendDelay: NodeJS.Timeout | undefined;

    return await new Promise<string>((resolve, reject) => {
      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        if (sendDelay) {
          clearTimeout(sendDelay);
        }
        params.signal?.removeEventListener("abort", onAbort);
        try {
          ws.close();
        } catch {
          // The socket may already be closing after a provider-side error.
        }
        fn();
      };
      const onAbort = () =>
        finish(() => reject(params.signal?.reason ?? new Error("VEFaaS WebShell command aborted")));
      timeout = setTimeout(
        () => finish(() => reject(new Error("Timed out waiting for VEFaaS WebShell command."))),
        params.timeoutMs,
      );
      params.signal?.addEventListener("abort", onAbort, { once: true });
      ws.addEventListener("open", () => {
        sendDelay = setTimeout(() => {
          ws.send(JSON.stringify({ Op: "stdin", Data: "stty -echo\n" }));
          ws.send(JSON.stringify({ Op: "stdin", Data: `${params.command}\n` }));
        }, 500);
      });
      ws.addEventListener("message", (event) => {
        const data = messageDataToString(event);
        chunks.push(frameToText(data));
        const output = chunks.join("");
        if (output.includes(`${params.marker}:end`)) {
          finish(() => resolve(output));
        }
      });
      ws.addEventListener("error", (event) =>
        finish(() => reject(new Error(`VEFaaS WebShell error: ${String(event)}`))),
      );
      ws.addEventListener("close", () => {
        if (!settled) {
          finish(() => reject(new Error("VEFaaS WebShell closed before command completed.")));
        }
      });
    });
  }
}

function getWebSocketConstructor(): WebSocketConstructor {
  const ctor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (!ctor) {
    throw new Error("VEFaaS WebShell fallback requires a Node.js runtime with WebSocket support.");
  }
  return ctor;
}

function buildWrappedCommand(params: {
  marker: string;
  script: string;
  args: string[];
  stdin?: Buffer | string;
  workdir?: string;
  env?: Record<string, string>;
}): string {
  const stdin =
    params.stdin === undefined
      ? ""
      : Buffer.isBuffer(params.stdin)
        ? params.stdin.toString("base64")
        : Buffer.from(params.stdin).toString("base64");
  const payload = Buffer.from(
    JSON.stringify({
      script: params.script,
      args: params.args,
      stdin,
      workdir: params.workdir,
      env: params.env ?? {},
    }),
  ).toString("base64");
  const payloadChunks = payload.match(/.{1,1000}/g) ?? [];
  return [
    "python3 - <<'PY'",
    "import base64, json, os, subprocess",
    `marker = ${JSON.stringify(params.marker)}`,
    `payload_b64 = ''.join(${JSON.stringify(payloadChunks)})`,
    "payload = json.loads(base64.b64decode(payload_b64))",
    "if payload.get('workdir'):",
    "    os.chdir(payload['workdir'])",
    "env = os.environ.copy()",
    "env.update(payload.get('env') or {})",
    "proc = subprocess.run(['/bin/sh', '-c', payload['script'], 'openclaw-vefaas', *payload.get('args', [])], input=base64.b64decode(payload.get('stdin') or ''), stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)",
    "result = json.dumps({'code': proc.returncode, 'stdout': base64.b64encode(proc.stdout).decode(), 'stderr': base64.b64encode(proc.stderr).decode()}, separators=(',', ':')).encode()",
    "print(f'{marker}:begin' + base64.b64encode(result).decode() + f'{marker}:end')",
    "PY",
  ].join("\n");
}

function parseMarkedResult(output: string, marker: string): SandboxBackendCommandResult {
  const start = output.indexOf(`${marker}:begin`);
  const end = output.indexOf(`${marker}:end`, start);
  if (start < 0 || end < 0) {
    throw new Error("VEFaaS WebShell command did not return an OpenClaw result marker.");
  }
  const encoded = output.slice(start + `${marker}:begin`.length, end).trim();
  const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    code?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  };
  return {
    code: typeof parsed.code === "number" ? parsed.code : 1,
    stdout: Buffer.from(typeof parsed.stdout === "string" ? parsed.stdout : "", "base64"),
    stderr: Buffer.from(typeof parsed.stderr === "string" ? parsed.stderr : "", "base64"),
  };
}

function messageDataToString(event: unknown): string {
  const data = (event as { data?: unknown }).data;
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return "";
}

function frameToText(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const data = (parsed as { Data?: unknown }).Data;
      return typeof data === "string" ? data : "";
    }
  } catch {
    return value;
  }
  return value;
}
