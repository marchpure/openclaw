import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export type MidTurnPrecheckRequest = {
  route: Exclude<PreemptiveCompactionRoute, "fits">;
  estimatedPromptTokens: number;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

export class MidTurnPrecheckSignal extends Error {
  readonly request: MidTurnPrecheckRequest;

  constructor(request: MidTurnPrecheckRequest) {
    super("Context overflow: prompt too large for the model (mid-turn precheck).");
    this.name = "MidTurnPrecheckSignal";
    this.request = request;
  }
}

export function isMidTurnPrecheckSignal(error: unknown): error is MidTurnPrecheckSignal {
  return error instanceof MidTurnPrecheckSignal;
}
