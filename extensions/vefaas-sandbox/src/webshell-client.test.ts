import { afterEach, describe, expect, it } from "vitest";
import { VefaasWebShellClient } from "./webshell-client.js";

class FakeWebSocket {
  static sent: string[] = [];
  static instances: FakeWebSocket[] = [];

  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor(_url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.emit("open", {}));
  }

  send(data: string): void {
    FakeWebSocket.sent.push(data);
    const frame = JSON.parse(data) as { Op?: string; Data?: string };
    if (frame.Op === "stdin" && frame.Data?.includes("python3 - <<'PY'")) {
      const marker = /marker = "([^"]+)"/.exec(frame.Data)?.[1];
      if (!marker) {
        return;
      }
      const result = Buffer.from(
        JSON.stringify({
          code: 0,
          stdout: Buffer.from("ok\n").toString("base64"),
          stderr: "",
        }),
      ).toString("base64");
      queueMicrotask(() =>
        this.emit("message", {
          data: JSON.stringify({
            Op: "stdout",
            Data: `${marker}:begin${result}${marker}:end`,
          }),
        }),
      );
    }
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

describe("VefaasWebShellClient", () => {
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    globalThis.WebSocket = originalWebSocket;
    FakeWebSocket.sent = [];
    FakeWebSocket.instances = [];
  });

  it("runs commands through WebShell stdin frames and parses marked output", async () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const client = new VefaasWebShellClient({
      endpoint: "wss://example.invalid/ws",
      timeoutMs: 5_000,
    });

    const result = await client.runShellCommand({
      script: "printf '%s' \"$1\"",
      args: ["ok"],
    });

    expect(result).toEqual({
      code: 0,
      stdout: Buffer.from("ok\n"),
      stderr: Buffer.from(""),
    });
    expect(FakeWebSocket.sent.some((value) => value.includes('"Op":"stdin"'))).toBe(true);
  });
});
