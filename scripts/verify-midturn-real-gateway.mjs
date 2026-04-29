#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const nodeBin = process.execPath;
const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-real-midturn-"));
const stateDir = path.join(tmpRoot, "state");
const workspaceDir = path.join(tmpRoot, "workspace");
const providerLogPath = path.join(tmpRoot, "provider-requests.jsonl");
const rawStreamPath = path.join(tmpRoot, "raw-stream.jsonl");
const gatewayLogPath = path.join(tmpRoot, "gateway.log");
const cliLogPath = path.join(tmpRoot, "agent-cli.log");
const configPath = path.join(stateDir, "openclaw.json");
await fs.promises.mkdir(stateDir, { recursive: true });
await fs.promises.mkdir(workspaceDir, { recursive: true });

const scenario = process.env.OPENCLAW_VERIFY_SCENARIO ?? "huge-single";
const hugeBytes = Number.parseInt(process.env.OPENCLAW_VERIFY_BYTES ?? "900000", 10);
const contextTokens = Number.parseInt(process.env.OPENCLAW_VERIFY_CONTEXT_TOKENS ?? "20000", 10);
const reserveTokens = Number.parseInt(process.env.OPENCLAW_VERIFY_RESERVE_TOKENS ?? "12000", 10);
const toolResultMaxChars = Number.parseInt(process.env.OPENCLAW_VERIFY_TOOL_MAX ?? "16000", 10);
const cliTimeoutMs = Number.parseInt(process.env.OPENCLAW_VERIFY_CLI_TIMEOUT_MS ?? "300000", 10);
const fakePort = await getFreePort();
const gatewayPort = await getFreePort();
const scenarioPlan = buildScenarioPlan(scenario, { hugeBytes });

const fixtureName = scenarioPlan.fixtureName;
await fs.promises.writeFile(
  path.join(workspaceDir, fixtureName),
  [
    `OPENCLAW_REAL_MIDTURN_START scenario=${scenario}`,
    buildRepeatedLines("READ_A", hugeBytes),
    "OPENCLAW_REAL_MIDTURN_END",
  ].join("\n"),
);
if (scenarioPlan.needsSecondFile) {
  await fs.promises.writeFile(
    path.join(workspaceDir, "large-b.txt"),
    [
      "OPENCLAW_REAL_MIDTURN_B_START",
      buildRepeatedLines("READ_B", Math.floor(hugeBytes / 2)),
      "OPENCLAW_REAL_MIDTURN_B_END",
    ].join("\n"),
  );
}

await fs.promises.writeFile(
  path.join(workspaceDir, "AGENTS.md"),
  "## Session Startup\nKeep replies brief.\n",
);
await fs.promises.writeFile(
  configPath,
  JSON.stringify(
    {
      gateway: {
        mode: "local",
        port: gatewayPort,
        bind: "loopback",
        auth: { mode: "none" },
      },
      models: {
        mode: "merge",
        pricing: { enabled: false },
        providers: {
          "local-fake": {
            baseUrl: `http://127.0.0.1:${fakePort}/v1`,
            apiKey: "fake-key",
            api: "openai-completions",
            models: [
              {
                id: "fake-tool-model",
                name: "Fake Tool Model",
                input: ["text"],
                contextWindow: contextTokens,
                contextTokens,
                maxTokens: 1024,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                compat: {
                  supportsTools: true,
                  supportsDeveloperRole: false,
                  supportsUsageInStreaming: true,
                },
              },
            ],
          },
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          skipBootstrap: true,
          contextTokens,
          model: { primary: "local-fake/fake-tool-model" },
          timeoutSeconds: 90,
          heartbeat: { every: "0m" },
          contextLimits: { toolResultMaxChars },
          compaction: {
            mode: "safeguard",
            reserveTokens,
            reserveTokensFloor: 0,
            midTurnPrecheck: { enabled: true },
            timeoutSeconds: 60,
          },
        },
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
      tools: {
        exec: { host: "gateway", security: "full", ask: "off", timeoutSec: 30 },
      },
    },
    null,
    2,
  ),
);

let requests = [];
const fakeServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/v1/models") {
    sendJson(res, { object: "list", data: [{ id: "fake-tool-model", object: "model" }] });
    return;
  }
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
    res.writeHead(404).end("not found");
    return;
  }
  const body = await readBody(req);
  const payload = JSON.parse(body);
  const requestIndex = requests.length + 1;
  const toolMessages = (payload.messages ?? []).filter((m) => m?.role === "tool");
  const summary = {
    requestIndex,
    model: payload.model,
    stream: payload.stream,
    messageCount: Array.isArray(payload.messages) ? payload.messages.length : 0,
    toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
    toolNames: Array.isArray(payload.tools)
      ? payload.tools.map((t) => t?.function?.name ?? t?.name).filter(Boolean)
      : [],
    toolMessageCount: toolMessages.length,
    toolMessageChars: toolMessages.reduce(
      (sum, m) => sum + JSON.stringify(m.content ?? "").length,
      0,
    ),
    containsStartMarker: body.includes("OPENCLAW_REAL_MIDTURN_START"),
    containsEndMarker: body.includes("OPENCLAW_REAL_MIDTURN_END"),
    containsExecStartMarker: body.includes("OPENCLAW_REAL_EXEC_START"),
    containsExecEndMarker: body.includes("OPENCLAW_REAL_EXEC_END"),
    containsTruncationNotice: body.includes("truncated") || body.includes("omitted"),
    bodyChars: body.length,
  };
  requests.push(summary);
  await fs.promises.appendFile(providerLogPath, `${JSON.stringify(summary)}\n`);

  const isValidationTurn = body.includes("OPENCLAW_VERIFY_REAL_MIDTURN");
  const hasToolResult = summary.toolMessageCount > 0;
  if (isValidationTurn && !hasToolResult) {
    sendToolCalls(res, payload.model, scenarioPlan.calls);
    return;
  }
  sendText(res, payload.model, `validated real gateway scenario ${scenario}`);
});
await new Promise((resolve) => fakeServer.listen(fakePort, "127.0.0.1", resolve));

const env = {
  ...process.env,
  OPENCLAW_HOME: tmpRoot,
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_GATEWAY_PORT: String(gatewayPort),
  OPENCLAW_RAW_STREAM: "1",
  OPENCLAW_RAW_STREAM_PATH: rawStreamPath,
  OPENAI_API_KEY: "unused-openclaw-real-midturn",
  NO_COLOR: "1",
};

const gateway = spawn(
  nodeBin,
  [
    "openclaw.mjs",
    "gateway",
    "run",
    "--port",
    String(gatewayPort),
    "--auth",
    "none",
    "--allow-unconfigured",
    "--raw-stream",
    "--raw-stream-path",
    rawStreamPath,
    "--verbose",
  ],
  { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
);
const gatewayLog = fs.createWriteStream(gatewayLogPath);
gateway.stdout.pipe(gatewayLog);
gateway.stderr.pipe(gatewayLog);
await waitForGateway(gatewayPort, 45_000);
await waitForLog(gatewayLogPath, "[gateway] ready", 45_000);

let cliResult;
try {
  cliResult = await runAgentCli(env);
} finally {
  gateway.kill("SIGTERM");
  await Promise.race([once(gateway, "exit"), sleep(5_000).then(() => gateway.kill("SIGKILL"))]);
  await new Promise((resolve) => fakeServer.close(resolve));
}

const rawStream = await readJsonlIfExists(rawStreamPath);
const providerRequests = await readJsonlIfExists(providerLogPath);
const gatewayLogText = await fs.promises.readFile(gatewayLogPath, "utf8").catch(() => "");
const transcriptFiles = await listFiles(stateDir, (file) => file.endsWith(".jsonl"));
const transcriptSnippets = [];
for (const file of transcriptFiles.slice(0, 8)) {
  const text = await fs.promises.readFile(file, "utf8").catch(() => "");
  if (text.includes("OPENCLAW_REAL_MIDTURN") || text.includes("truncated")) {
    transcriptSnippets.push({
      file,
      chars: text.length,
      containsStartMarker: text.includes("OPENCLAW_REAL_MIDTURN_START"),
      containsEndMarker: text.includes("OPENCLAW_REAL_MIDTURN_END"),
      containsTruncationNotice: text.includes("truncated") || text.includes("omitted"),
    });
  }
}

const result = {
  tmpRoot,
  scenario,
  config: { contextTokens, reserveTokens, toolResultMaxChars, hugeBytes },
  cli: {
    code: cliResult.code,
    stdoutChars: cliResult.stdout.length,
    stderrChars: cliResult.stderr.length,
    usedEmbeddedFallback: cliResult.stderr.includes("EMBEDDED FALLBACK"),
    stdoutPreview: cliResult.stdout.slice(0, 500),
    stderrPreview: cliResult.stderr.slice(0, 1200),
  },
  providerRequests,
  rawStreamEvents: rawStream.length,
  rawStreamTypeSample: rawStream
    .slice(0, 8)
    .map((evt) => evt.type ?? evt.event ?? Object.keys(evt)[0]),
  gatewayLogContainsMidturn:
    gatewayLogText.includes("mid-turn precheck") || gatewayLogText.includes("MidTurnPrecheck"),
  gatewayLogContainsMidturnRoute: gatewayLogText.includes("[context-overflow-midturn-precheck]"),
  gatewayLogContainsAgentRequest: gatewayLogText.includes("agent"),
  gatewayLogExcerpt: extractInterestingGatewayLog(gatewayLogText),
  transcriptSnippets,
  paths: { providerLogPath, rawStreamPath, gatewayLogPath, cliLogPath, configPath, workspaceDir },
};

const second = providerRequests[1];
const assertions = [
  ["agent CLI exited successfully", cliResult.code === 0],
  ["no embedded fallback", !result.cli.usedEmbeddedFallback],
  ["provider saw initial model call", providerRequests.length >= 1],
  ["provider saw tool schemas", providerRequests.some((req) => (req.toolCount ?? 0) > 0)],
  [
    `initial call selected ${scenarioPlan.expectedToolName} tool`,
    providerRequests.some((req) => req.toolNames?.includes(scenarioPlan.expectedToolName)),
  ],
  ["raw stream captured real model/tool loop", rawStream.length > 0],
];
if (scenarioPlan.expectContinuation) {
  assertions.push(
    ["provider saw continuation after real tool result", providerRequests.length >= 2],
    ["continuation includes tool message", (second?.toolMessageCount ?? 0) > 0],
    ["continuation does not include full huge end marker", second?.containsEndMarker === false],
    [
      "continuation tool payload is bounded",
      (second?.toolMessageChars ?? Number.POSITIVE_INFINITY) < Math.max(80_000, hugeBytes / 3),
    ],
  );
  if (scenarioPlan.expectedToolName === "exec") {
    assertions.push([
      "continuation includes real exec output",
      second?.containsExecStartMarker === true,
    ]);
  } else {
    assertions.push([
      "continuation does not include exec marker",
      second?.containsExecEndMarker !== true,
    ]);
  }
} else {
  assertions.push(
    ["mid-turn precheck stopped before continuation", providerRequests.length === 1],
    ["gateway logged mid-turn precheck route", result.gatewayLogContainsMidturnRoute],
  );
}
result.assertions = assertions.map(([name, pass]) => ({ name, pass }));
result.pass = result.assertions.every((item) => item.pass);
console.log(JSON.stringify(result, null, 2));
process.exit(result.pass ? 0 : 1);

async function runAgentCli(env) {
  const child = spawn(
    nodeBin,
    [
      "openclaw.mjs",
      "agent",
      "--agent",
      "main",
      "--session-id",
      `real-midturn-${scenario}-${Date.now()}`,
      "--message",
      `OPENCLAW_VERIFY_REAL_MIDTURN ${scenario}: use the provided tool call and then answer briefly.`,
      "--model",
      "local-fake/fake-tool-model",
      "--json",
      "--timeout",
      "90",
    ],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
  }, cliTimeoutMs);
  const [code] = await once(child, "exit");
  clearTimeout(timeout);
  await fs.promises.writeFile(cliLogPath, `STDOUT\n${stdout}\nSTDERR\n${stderr}`);
  return { code, stdout, stderr };
}

function buildScenarioPlan(name, { hugeBytes }) {
  const execLargeCommand = [
    "node",
    "-e",
    JSON.stringify(
      "const n=Number(process.env.OPENCLAW_VERIFY_EXEC_BYTES||'120000');" +
        "console.log('OPENCLAW_REAL_EXEC_START');" +
        "let s='';" +
        "for(let i=0;i<n;i+=80){s+='EXEC_LINE_'+String(i).padStart(8,'0')+' '+'.'.repeat(55)+'\\n';}" +
        "process.stdout.write(s);" +
        "console.log('OPENCLAW_REAL_EXEC_END');",
    ),
  ].join(" ");
  switch (name) {
    case "multi-tool":
      return {
        fixtureName: "large-a.txt",
        needsSecondFile: true,
        expectedToolName: "read",
        expectContinuation: true,
        calls: [
          { id: "call_read_a", name: "read", arguments: { path: "large-a.txt" } },
          { id: "call_read_b", name: "read", arguments: { path: "large-b.txt" } },
        ],
      };
    case "exec-large":
      return {
        fixtureName: "large.txt",
        needsSecondFile: false,
        expectedToolName: "exec",
        expectContinuation: true,
        calls: [
          {
            id: "call_exec_large",
            name: "exec",
            arguments: {
              command: execLargeCommand,
              env: { OPENCLAW_VERIFY_EXEC_BYTES: String(hugeBytes) },
              timeout: 30,
            },
          },
        ],
      };
    case "precheck-exec":
      return {
        fixtureName: "large.txt",
        needsSecondFile: false,
        expectedToolName: "exec",
        expectContinuation: false,
        calls: [
          {
            id: "call_exec_precheck",
            name: "exec",
            arguments: {
              command: execLargeCommand,
              env: { OPENCLAW_VERIFY_EXEC_BYTES: String(hugeBytes) },
              timeout: 30,
            },
          },
        ],
      };
    case "small-read":
      return {
        fixtureName: "large.txt",
        needsSecondFile: false,
        expectedToolName: "read",
        expectContinuation: true,
        calls: [{ id: "call_read_small", name: "read", arguments: { path: "large.txt" } }],
      };
    default:
      return {
        fixtureName: "large.txt",
        needsSecondFile: false,
        expectedToolName: "read",
        expectContinuation: true,
        calls: [{ id: "call_read_large", name: "read", arguments: { path: "large.txt" } }],
      };
  }
}

function buildRepeatedLines(prefix, targetChars) {
  const line = `${prefix}_${"x".repeat(70)}\n`;
  return line.repeat(Math.max(1, Math.ceil(targetChars / line.length))).slice(0, targetChars);
}

function extractInterestingGatewayLog(text) {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes("context-overflow-midturn-precheck") ||
        line.includes("embedded run tool") ||
        line.includes("tool_execution") ||
        line.includes("embedded run agent end"),
    )
    .slice(-20);
}

function sendJson(res, body) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendToolCalls(res, model, calls) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(res, {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  for (const [index, call] of calls.entries()) {
    writeSse(res, {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.arguments) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
  }
  writeSse(res, {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function sendText(res, model, text) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  writeSse(res, {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  writeSse(res, {
    id: `chatcmpl-${Date.now()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }
  return body;
}

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForGateway(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const ok = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/v1/models`, (res) => {
          res.resume();
          resolve(res.statusCode !== undefined && res.statusCode < 500);
        });
        req.on("error", () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });
      if (ok) {
        return;
      }
    } catch {
      // retry
    }
    await sleep(500);
  }
  throw new Error(`Gateway did not become ready on port ${port}`);
}

async function waitForLog(file, needle, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const text = await fs.promises.readFile(file, "utf8").catch(() => "");
    if (text.includes(needle)) {
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${needle} in ${file}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readJsonlIfExists(file) {
  const text = await fs.promises.readFile(file, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return { parseError: true, line: line.slice(0, 200) };
      }
    });
}

async function listFiles(root, predicate) {
  const out = [];
  async function walk(dir) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (!predicate || predicate(file)) {
        out.push(file);
      }
    }
  }
  await walk(root);
  return out;
}
