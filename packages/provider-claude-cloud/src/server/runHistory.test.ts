import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { cloudRunHistory } from "./runHistory.ts";

type Records = Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
const run = (ordinal: number, instance: string, started = true) => ({
  id: RunId.make("run-" + ordinal),
  ordinal,
  providerInstanceId: ProviderInstanceId.make(instance),
  userMessageId: MessageId.make("message-" + ordinal),
  startedAt: started ? DateTime.makeUnsafe(0) : null,
  status: "completed",
});

it("a cloud run is the registering run only when no earlier run reached its instance", () => {
  // Fixture rows carry only the fields the history reads.
  const records = {
    runs: [
      run(1, "codex"),
      run(2, "claudeCloud", false),
      run(3, "claudeCloud"),
      run(4, "claudeCloud"),
    ],
    messages: [{ id: MessageId.make("message-3"), text: "registered" }],
  } as unknown as Records;
  expect(cloudRunHistory(records, RunId.make("run-3"))).toEqual({
    prompt: "registered",
    first: true,
  });
  expect(cloudRunHistory(records, RunId.make("run-4"))?.first).toBe(false);
});
