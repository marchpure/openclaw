#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

if (process.env.OPENCLAW_LIVE_MIDTURN !== "1") {
  console.error("Set OPENCLAW_LIVE_MIDTURN=1 to run the live mid-turn verification.");
  process.exit(2);
}

const repoRoot = process.cwd();
const nodeBin = process.execPath;
const sourceConfigPath =
  process.env.OPENCLAW_LIVE_SOURCE_CONFIG ?? path.join(os.homedir(), ".openclaw", "openclaw.json");
const sourceConfig = JSON.parse(await fs.promises.readFile(sourceConfigPath, "utf8"));
const modelId =
  process.env.OPENCLAW_LIVE_MODEL ??
  sourceConfig.agents?.defaults?.model?.primary ??
  sourceConfig.agents?.defaults?.model ??
  "codex/doubao-seed-2-0-pro-260215";
const [providerId, modelName] = splitModelId(modelId);
const liveProviderId = process.env.OPENCLAW_LIVE_PROVIDER_ALIAS ?? "live-codex";
const providerConfig = sourceConfig.models?.providers?.[providerId];
if (!providerConfig) {
  throw new Error(`Provider ${providerId} missing from ${sourceConfigPath}`);
}

const toolCount = Number.parseInt(process.env.OPENCLAW_LIVE_TOOL_COUNT ?? "100", 10);
const tokenChars = Number.parseInt(process.env.OPENCLAW_LIVE_TOKEN_CHARS ?? "4096", 10);
const contextTokens = Number.parseInt(process.env.OPENCLAW_LIVE_CONTEXT_TOKENS ?? "64000", 10);
const reserveTokens = Number.parseInt(process.env.OPENCLAW_LIVE_RESERVE_TOKENS ?? "48000", 10);
const toolResultMaxChars = Number.parseInt(process.env.OPENCLAW_LIVE_TOOL_MAX ?? "8000", 10);
const timeoutSeconds = Number.parseInt(process.env.OPENCLAW_LIVE_TIMEOUT_SECONDS ?? "900", 10);
const scenario = process.env.OPENCLAW_LIVE_SCENARIO ?? "hundred-read";
const maxToolCalls = Number.parseInt(
  process.env.OPENCLAW_LIVE_MAX_TOOL_CALLS ?? String(toolCount + 5),
  10,
);
const runBoth = process.env.OPENCLAW_LIVE_AB_ONLY !== "1";
const cases = runBoth
  ? [
      { label: "midturn-on", midTurnPrecheck: true },
      { label: "midturn-off", midTurnPrecheck: false },
    ]
  : [
      {
        label: process.env.OPENCLAW_LIVE_LABEL ?? "live",
        midTurnPrecheck: process.env.OPENCLAW_LIVE_MIDTURN_ENABLED !== "0",
      },
    ];

const results = [];
for (const testCase of cases) {
  results.push(await runCase(testCase));
}

console.log(
  JSON.stringify(
    {
      scenario,
      modelId: `${liveProviderId}/${modelName}`,
      sourceModelId: modelId,
      toolCount,
      contextTokens,
      reserveTokens,
      maxToolCalls,
      results,
    },
    null,
    2,
  ),
);
process.exit(
  results.every((result) => result.cli.code === 0 || result.expectedFailureObserved) ? 0 : 1,
);

async function runCase(testCase) {
  const tmpRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `openclaw-live-midturn-${testCase.label}-`),
  );
  const stateDir = path.join(tmpRoot, "state");
  const workspaceDir = path.join(tmpRoot, "workspace");
  const rawStreamPath = path.join(tmpRoot, "raw-stream.jsonl");
  const gatewayLogPath = path.join(tmpRoot, "gateway.log");
  const cliLogPath = path.join(tmpRoot, "agent-cli.log");
  const configPath = path.join(stateDir, "openclaw.json");
  await fs.promises.mkdir(stateDir, { recursive: true });
  await fs.promises.mkdir(workspaceDir, { recursive: true });
  await writeWorkspace(workspaceDir);
  await writeConfig({
    configPath,
    workspaceDir,
    gatewayPort: await getFreePort(),
    midTurnPrecheck: testCase.midTurnPrecheck,
  });

  const config = JSON.parse(await fs.promises.readFile(configPath, "utf8"));
  const gatewayPort = config.gateway.port;
  const env = {
    ...process.env,
    OPENCLAW_HOME: tmpRoot,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    OPENCLAW_RAW_STREAM: "1",
    OPENCLAW_RAW_STREAM_PATH: rawStreamPath,
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
  const startedAt = Date.now();
  let cliResult;
  try {
    await waitForGateway(gatewayPort, 90_000);
    await waitForLog(gatewayLogPath, "[gateway] ready", 90_000);
    cliResult = await runAgentCli(env, testCase);
  } finally {
    gateway.kill("SIGTERM");
    await Promise.race([once(gateway, "exit"), sleep(5_000).then(() => gateway.kill("SIGKILL"))]);
  }

  const gatewayLogText = await fs.promises.readFile(gatewayLogPath, "utf8").catch(() => "");
  const rawStream = await readJsonlIfExists(rawStreamPath);
  const transcriptFiles = await listFiles(stateDir, (file) => file.endsWith(".jsonl"));
  const transcriptStats = await summarizeTranscripts(transcriptFiles);
  const compactionEvents = extractCompactionEvents(gatewayLogText);
  const midturnEvents = extractMidturnEvents(gatewayLogText);
  const toolRuns = extractToolRuns(gatewayLogText);
  const cliJson = parseCliJson(cliResult.stdout);
  const compactionCount =
    cliJson?.result?.meta?.agentMeta?.compactionCount ??
    transcriptStats.compactionEntries ??
    compactionEvents.filter((event) => event.phase === "end").length;
  const expectedFailureObserved =
    !testCase.midTurnPrecheck &&
    toolRuns.readEndCount >= toolCount &&
    (cliResult.code !== 0 ||
      /context|token|too large|exceed|overflow|prompt/i.test(
        cliResult.stderr + cliResult.stdout + gatewayLogText,
      ));
  const insufficientNegativeControl =
    !testCase.midTurnPrecheck && !expectedFailureObserved && toolRuns.readEndCount < toolCount;
  return {
    label: testCase.label,
    midTurnPrecheck: testCase.midTurnPrecheck,
    tmpRoot,
    durationMs: Date.now() - startedAt,
    cli: {
      code: cliResult.code,
      stdoutChars: cliResult.stdout.length,
      stderrChars: cliResult.stderr.length,
      stdoutPreview: cliResult.stdout.slice(0, 1200),
      stderrPreview: cliResult.stderr.slice(0, 1200),
    },
    compactionCount,
    compactionEvents,
    compactionDurationsMs: pairCompactionDurations(compactionEvents),
    midturnEvents,
    toolRuns,
    rawStreamEvents: rawStream.length,
    rawStreamTypes: rawStream
      .slice(0, 20)
      .map((event) => event.type ?? event.event ?? Object.keys(event)[0]),
    transcriptStats,
    expectedFailureObserved,
    insufficientNegativeControl,
    paths: { configPath, workspaceDir, rawStreamPath, gatewayLogPath, cliLogPath },
  };
}

async function writeWorkspace(workspaceDir) {
  const files = [];
  for (let i = 1; i <= toolCount; i += 1) {
    const name = `payload-${String(i).padStart(3, "0")}.txt`;
    files.push(name);
    await fs.promises.writeFile(
      path.join(workspaceDir, name),
      [
        `OPENCLAW_LIVE_MIDTURN_FILE ${i}`,
        repeatedPayload(`PAYLOAD_${String(i).padStart(3, "0")}`, tokenChars),
        `OPENCLAW_LIVE_MIDTURN_END ${i}`,
      ].join("\n"),
    );
  }
  await fs.promises.writeFile(
    path.join(workspaceDir, "manifest.txt"),
    files.map((file) => `- ${file}`).join("\n"),
  );
  await fs.promises.writeFile(
    path.join(workspaceDir, "AGENTS.md"),
    [
      "## Session Startup",
      "For this verification, use only the read tool.",
      "Do not use exec, write, edit, browser, web_search, or any messaging tool.",
      "When asked to verify live mid-turn compaction, read every payload listed in manifest.txt.",
      "Issue the payload reads in one assistant tool-call batch when the tool API allows parallel calls.",
      `The expected batch is ${toolCount} read tool calls for payload-001.txt through payload-${String(toolCount).padStart(3, "0")}.txt.`,
      "Read them as tool calls in the same turn before giving the final answer.",
      "After reading all files, answer with exactly: LIVE_MIDTURN_DONE count=<number read>.",
    ].join("\n"),
  );
}

async function writeConfig(params) {
  const provider = structuredClone(providerConfig);
  const model =
    provider.models?.find((candidate) => candidate.id === modelName) ?? provider.models?.[0];
  if (!model) {
    throw new Error(`No model entries for provider ${providerId}`);
  }
  provider.models = [
    {
      ...model,
      id: modelName,
      contextWindow: contextTokens,
      contextTokens,
    },
  ];
  const cfg = {
    gateway: {
      mode: "local",
      port: params.gatewayPort,
      bind: "loopback",
      auth: { mode: "none" },
    },
    models: {
      mode: "merge",
      pricing: { enabled: false },
      providers: {
        [liveProviderId]: provider,
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        skipBootstrap: true,
        contextTokens,
        model: { primary: `${liveProviderId}/${modelName}` },
        timeoutSeconds,
        heartbeat: { every: "0m" },
        params: {
          temperature: 0,
          extra_body: {
            tool_choice: "required",
            parallel_tool_calls: true,
            max_tool_calls: maxToolCalls,
          },
          parallel_tool_calls: true,
        },
        contextLimits: { toolResultMaxChars },
        compaction: {
          mode: "safeguard",
          reserveTokens,
          reserveTokensFloor: 0,
          keepRecentTokens: 4000,
          midTurnPrecheck: { enabled: params.midTurnPrecheck },
          timeoutSeconds: 240,
        },
      },
      list: [
        {
          id: "main",
          default: true,
          workspace: params.workspaceDir,
          tools: { allow: ["read"], deny: [] },
        },
      ],
    },
    tools: {
      allow: ["read"],
      deny: [],
    },
  };
  await fs.promises.writeFile(params.configPath, JSON.stringify(cfg, null, 2));
}

async function runAgentCli(env, testCase) {
  const prompt = [
    `OPENCLAW_LIVE_MIDTURN_VERIFY ${scenario} ${testCase.label}.`,
    `Read manifest.txt, then read every payload file listed there. There are exactly ${toolCount} payload files.`,
    `After reading manifest.txt, immediately issue one assistant tool-call batch containing exactly ${toolCount} read calls, one for each payload file, before observing or summarizing their contents.`,
    "Use only the read tool. Do not stop after a subset. Do not summarize until every payload file has been read.",
    "After all reads complete, reply exactly: LIVE_MIDTURN_DONE count=<number read>.",
  ].join(" ");
  const child = spawn(
    nodeBin,
    [
      "openclaw.mjs",
      "agent",
      "--agent",
      "main",
      "--session-id",
      `live-midturn-${testCase.label}-${Date.now()}`,
      "--message",
      prompt,
      "--model",
      `${liveProviderId}/${modelName}`,
      "--thinking",
      "off",
      "--json",
      "--timeout",
      String(timeoutSeconds),
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
  const timeout = setTimeout(
    () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3_000).unref?.();
    },
    (timeoutSeconds + 60) * 1000,
  );
  const [code] = await once(child, "exit");
  clearTimeout(timeout);
  await fs.promises.writeFile(cliLogPathForEnv(env), `STDOUT\n${stdout}\nSTDERR\n${stderr}`);
  return { code, stdout, stderr };
}

function cliLogPathForEnv(env) {
  return path.join(path.dirname(env.OPENCLAW_CONFIG_PATH), "..", "agent-cli.log");
}

function splitModelId(value) {
  const slash = String(value).indexOf("/");
  if (slash <= 0) {
    throw new Error(`Expected provider/model id, got ${value}`);
  }
  return [value.slice(0, slash), value.slice(slash + 1)];
}

function repeatedPayload(prefix, targetChars) {
  const line = `${prefix} ${"tok ".repeat(20)}\n`;
  return line.repeat(Math.max(1, Math.ceil(targetChars / line.length))).slice(0, targetChars);
}

function parseCliJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractMidturnEvents(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line.includes("[context-overflow-midturn-precheck]"))
    .map((line) => ({ timestamp: parseLogTimestamp(line), line }));
}

function extractCompactionEvents(text) {
  return text
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.includes("[compaction-diag] start") ||
        line.includes("[compaction-diag] end") ||
        line.includes("embedded run compaction start") ||
        line.includes("embedded run compaction retry") ||
        line.includes("auto-compaction succeeded"),
    )
    .map((line) => ({
      timestamp: parseLogTimestamp(line),
      phase:
        line.includes("[compaction-diag] start") || line.includes("compaction start")
          ? "start"
          : line.includes("[compaction-diag] end") || line.includes("auto-compaction succeeded")
            ? "end"
            : "retry",
      durationMs: parseDurationMs(line),
      line,
    }));
}

function pairCompactionDurations(events) {
  const durations = [];
  let start = null;
  for (const event of events) {
    if (event.phase === "end" && Number.isFinite(event.durationMs)) {
      durations.push(event.durationMs);
      start = null;
      continue;
    }
    if (event.phase === "start") {
      start = event.timestamp;
    } else if (event.phase === "end" && start && event.timestamp) {
      durations.push(event.timestamp - start);
      start = null;
    }
  }
  return durations;
}

function extractToolRuns(text) {
  const lines = text.split(/\r?\n/);
  const readStartCount = lines.filter(
    (line) => line.includes("embedded run tool start") && line.includes("tool=read"),
  ).length;
  const readEndCount = lines.filter(
    (line) => line.includes("embedded run tool end") && line.includes("tool=read"),
  ).length;
  return { readStartCount, readEndCount };
}

function parseDurationMs(line) {
  const match = /\bdurationMs=(\d+)\b/.exec(line);
  return match ? Number.parseInt(match[1], 10) : undefined;
}

function parseLogTimestamp(line) {
  const match = /^(\d{4}-\d{2}-\d{2}T\S+)/.exec(line);
  if (!match) {
    return null;
  }
  const time = Date.parse(match[1]);
  return Number.isFinite(time) ? time : null;
}

async function summarizeTranscripts(files) {
  let toolResults = 0;
  let compactionEntries = 0;
  let chars = 0;
  let liveMarkers = 0;
  for (const file of files) {
    const text = await fs.promises.readFile(file, "utf8").catch(() => "");
    chars += text.length;
    liveMarkers += (text.match(/OPENCLAW_LIVE_MIDTURN_FILE/g) ?? []).length;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message?.role === "toolResult") {
          toolResults += 1;
        }
        if (entry.type === "compaction") {
          compactionEntries += 1;
        }
      } catch {
        // ignore malformed debug sidecars
      }
    }
  }
  return { files: files.length, chars, toolResults, compactionEntries, liveMarkers };
}

async function waitForGateway(port, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
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

async function getFreePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
