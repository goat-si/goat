import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { OrchestrationV2ProviderTurnJson } from "./orchestrationV2.ts";

it("round trips a surviving provider turn's native start through JSON", () => {
  const decode = Schema.decodeUnknownSync(OrchestrationV2ProviderTurnJson);
  const encode = Schema.encodeSync(OrchestrationV2ProviderTurnJson);
  for (const nativeStartedAt of [null, "2026-04-20T00:00:00.000Z"]) {
    const input = {
      id: "turn",
      providerThreadId: "thread",
      nodeId: "node",
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: null,
      completedAt: null,
      survivingRestart: { nativeStartedAt },
    };
    expect(encode(decode(input)).survivingRestart).toEqual({ nativeStartedAt });
  }
});
