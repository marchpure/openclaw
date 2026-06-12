import { describe, expect, it, vi } from "vitest";

vi.mock("../context-engine-capabilities.js", () => ({
  resolveContextEngineCapabilities: async () => ({ llm: undefined }),
}));

import { isMidTurnPrecheckEnabled } from "./attempt.js";

describe("isMidTurnPrecheckEnabled", () => {
  it("enables mid-turn precheck by default", () => {
    expect(isMidTurnPrecheckEnabled()).toBe(true);
    expect(isMidTurnPrecheckEnabled({})).toBe(true);
    expect(
      isMidTurnPrecheckEnabled({
        agents: {
          defaults: {
            compaction: {},
          },
        },
      }),
    ).toBe(true);
  });

  it("honors explicit mid-turn precheck opt-out", () => {
    expect(
      isMidTurnPrecheckEnabled({
        agents: {
          defaults: {
            compaction: {
              midTurnPrecheck: {
                enabled: false,
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps explicit opt-in enabled", () => {
    expect(
      isMidTurnPrecheckEnabled({
        agents: {
          defaults: {
            compaction: {
              midTurnPrecheck: {
                enabled: true,
              },
            },
          },
        },
      }),
    ).toBe(true);
  });
});
