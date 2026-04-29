import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SpawnInput } from "../../process/supervisor/index.js";
import type { ResolvedCliBackend } from "../cli-backends.js";
import { executePreparedCliRun, setCliRunnerExecuteTestDeps } from "./execute.js";
import type { PreparedCliRunContext } from "./types.js";

function createContext(dir: string): PreparedCliRunContext {
  return {
    params: {
      sessionId: "session-test",
      sessionFile: path.join(dir, "session.jsonl"),
      workspaceDir: dir,
      prompt: "hello",
      provider: "opencode-cli",
      model: "opencode/kimi-k2.6",
      timeoutMs: 1_000,
      runId: "run-opencode-json-env",
    },
    started: Date.now(),
    workspaceDir: dir,
    backendResolved: {
      id: "opencode-cli",
      config: {
        command: "opencode",
        args: ["run", "--format", "json"],
        output: "text",
        input: "arg",
        modelArg: "--model",
        systemPromptFileJsonEnv: "OPENCODE_CONFIG_CONTENT",
        systemPromptFileJsonKey: "instructions",
        systemPromptMode: "append",
        systemPromptWhen: "first",
      },
      bundleMcp: false,
    } as ResolvedCliBackend,
    preparedBackend: {
      backend: {
        command: "opencode",
        args: ["run", "--format", "json"],
        output: "text",
        input: "arg",
        modelArg: "--model",
        systemPromptFileJsonEnv: "OPENCODE_CONFIG_CONTENT",
        systemPromptFileJsonKey: "instructions",
        systemPromptMode: "append",
        systemPromptWhen: "first",
      },
      env: {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          model: "opencode/kimi-k2.6",
          instructions: ["/existing/instructions.md"],
        }),
      },
    },
    reusableCliSession: {},
    modelId: "opencode/kimi-k2.6",
    normalizedModel: "opencode/kimi-k2.6",
    systemPrompt: "system prompt from OpenClaw",
    systemPromptReport: {
      source: "run",
      generatedAt: Date.now(),
      systemPrompt: {
        chars: 0,
        projectContextChars: 0,
        nonProjectContextChars: 0,
      },
      injectedWorkspaceFiles: [],
      skills: {
        promptChars: 0,
        entries: [],
      },
      tools: {
        listChars: 0,
        schemaChars: 0,
        entries: [],
      },
    },
    bootstrapPromptWarningLines: [],
    authEpochVersion: 1,
  };
}

describe("executePreparedCliRun JSON-env system prompt file", () => {
  it("appends the generated system prompt file path to JSON config env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-cli-json-env-"));
    let spawnInput: SpawnInput | undefined;
    let promptFileText: string | undefined;
    try {
      setCliRunnerExecuteTestDeps({
        getProcessSupervisor: () =>
          ({
            spawn: vi.fn(async (input: SpawnInput) => {
              spawnInput = input;
              const env = input.env as Record<string, string>;
              const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
                instructions?: string[];
              };
              promptFileText = fs.readFileSync(config.instructions?.at(-1) ?? "", "utf-8");
              return {
                runId: "managed-run",
                startedAtMs: Date.now(),
                cancel: vi.fn(),
                wait: vi.fn(async () => ({
                  reason: "exit",
                  exitCode: 0,
                  exitSignal: null,
                  durationMs: 1,
                  stdout: "done",
                  stderr: "",
                  timedOut: false,
                  noOutputTimedOut: false,
                })),
              };
            }),
            cancel: vi.fn(),
            cancelScope: vi.fn(),
            reconcileOrphans: vi.fn(),
            getRecord: vi.fn(),
          }) as never,
      });

      const output = await executePreparedCliRun(createContext(dir));

      expect(output.text).toBe("done");
      const env = spawnInput?.env as Record<string, string>;
      const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT) as {
        instructions?: string[];
        model?: string;
      };
      expect(config.model).toBe("opencode/kimi-k2.6");
      expect(config.instructions?.[0]).toBe("/existing/instructions.md");
      expect(config.instructions?.[1]).toMatch(/system-prompt\.md$/);
      expect(promptFileText).toBe("system prompt from OpenClaw");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
