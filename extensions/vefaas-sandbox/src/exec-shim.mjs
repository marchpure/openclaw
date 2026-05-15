import { randomUUID } from "node:crypto";

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error("Missing VEFaaS exec shim config.");
  }
  const config = JSON.parse(raw);
  const result = config.baseUrl
    ? await runAllInOneCommand(config)
    : await runWebShellCommand(config);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.code;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : JSON.stringify(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});

async function runAllInOneCommand(config) {
  const stdinPath =
    typeof config.stdin === "string" ? `/tmp/openclaw-vefaas-stdin-${randomUUID()}.bin` : undefined;
  if (stdinPath) {
    await requestJson(config, "v1/file/write", {
      file: stdinPath,
      content: Buffer.from(config.stdin).toString("base64"),
      encoding: "base64",
      trailing_newline: false,
    });
  }
  const response = await requestJson(config, "v1/bash/exec", {
    command: buildAllInOneWrapper({
      script: config.command,
      args: [],
      stdinPath,
    }),
    exec_dir: config.workdir,
    env: config.env,
    async_mode: false,
    timeout: Math.ceil((config.timeoutMs ?? 120_000) / 1000),
    hard_timeout: Math.ceil((config.timeoutMs ?? 120_000) / 1000),
    max_output_length: 0,
  });
  return parseAllInOneResult(response);
}

async function requestJson(config, path, body) {
  const baseUrl = String(config.baseUrl ?? "").replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/${path.replace(/^\/+/, "")}`);
  if (config.instanceName) {
    url.searchParams.set("faasInstanceName", config.instanceName);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      ...(config.instanceName ? { "x-faas-instance-name": config.instanceName } : {}),
      ...(isRecord(config.headers) ? config.headers : {}),
    },
    body: JSON.stringify(body),
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

function buildAllInOneWrapper(params) {
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

function parseAllInOneResult(response) {
  const data = getResponseData(response);
  return {
    code: typeof data.exit_code === "number" ? data.exit_code : 0,
    stdout: typeof data.stdout === "string" ? data.stdout : "",
    stderr: typeof data.stderr === "string" ? data.stderr : "",
  };
}

async function runWebShellCommand(config) {
  if (!config.webshellEndpoint) {
    throw new Error(
      "Missing VEFaaS exec transport: configure access.baseUrl or use WebShell endpoint.",
    );
  }
  const WebSocketCtor = globalThis.WebSocket;
  if (!WebSocketCtor) {
    throw new Error("VEFaaS WebShell fallback requires a Node.js runtime with WebSocket support.");
  }
  const marker = `__OPENCLAW_VEFAAS_RESULT_${randomUUID().replaceAll("-", "")}__`;
  const ws = new WebSocketCtor(config.webshellEndpoint);
  const chunks = [];
  let settled = false;
  let timeout;
  let sendDelay;
  return await new Promise((resolve, reject) => {
    const finish = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(sendDelay);
      try {
        ws.close();
      } catch {
        // The provider may already have closed the socket.
      }
      fn();
    };
    timeout = setTimeout(
      () => finish(() => reject(new Error("Timed out waiting for VEFaaS WebShell command."))),
      config.timeoutMs ?? 120_000,
    );
    ws.addEventListener("open", () => {
      sendDelay = setTimeout(() => {
        ws.send(JSON.stringify({ Op: "stdin", Data: "stty -echo\n" }));
        ws.send(
          JSON.stringify({
            Op: "stdin",
            Data: `${buildWebShellWrapper({
              marker,
              script: config.command,
              workdir: config.workdir,
              env: isRecord(config.env) ? config.env : {},
            })}\n`,
          }),
        );
      }, 500);
    });
    ws.addEventListener("message", (event) => {
      chunks.push(frameToText(messageDataToString(event)));
      const output = chunks.join("");
      if (output.includes(`${marker}:end`)) {
        finish(() => resolve(parseMarkedResult(output, marker)));
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

function buildWebShellWrapper(params) {
  const payload = Buffer.from(
    JSON.stringify({
      script: params.script,
      args: [],
      workdir: params.workdir,
      env: params.env,
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
    "proc = subprocess.run(['/bin/sh', '-c', payload['script'], 'openclaw-vefaas', *payload.get('args', [])], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)",
    "result = json.dumps({'code': proc.returncode, 'stdout': base64.b64encode(proc.stdout).decode(), 'stderr': base64.b64encode(proc.stderr).decode()}, separators=(',', ':')).encode()",
    "print(f'{marker}:begin' + base64.b64encode(result).decode() + f'{marker}:end')",
    "PY",
  ].join("\n");
}

function parseMarkedResult(output, marker) {
  const start = output.indexOf(`${marker}:begin`);
  const end = output.indexOf(`${marker}:end`, start);
  if (start < 0 || end < 0) {
    throw new Error("VEFaaS WebShell command did not return an OpenClaw result marker.");
  }
  const encoded = output.slice(start + `${marker}:begin`.length, end).trim();
  const parsed = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  return {
    code: typeof parsed.code === "number" ? parsed.code : 1,
    stdout: Buffer.from(
      typeof parsed.stdout === "string" ? parsed.stdout : "",
      "base64",
    ).toString(),
    stderr: Buffer.from(
      typeof parsed.stderr === "string" ? parsed.stderr : "",
      "base64",
    ).toString(),
  };
}

function messageDataToString(event) {
  const data = event?.data;
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

function frameToText(value) {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed)) {
      return typeof parsed.Data === "string" ? parsed.Data : "";
    }
  } catch {
    return value;
  }
  return value;
}

function parseJsonObject(text) {
  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getResponseData(response) {
  return isRecord(response.data) ? response.data : response;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
