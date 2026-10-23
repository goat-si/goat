import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import { CLOUD_DELIVERY_REJECTED_CODE } from "@goat/provider-core/server/cloudTask";
import * as DateTime from "effect/DateTime";
import { cloudRunHistory } from "./runHistory.ts";

type Records = Pick<OrchestrationV2ThreadProjection, "runs" | "messages" | "turnItems">;
const CLOUD = ProviderInstanceId.make("claudeCloud");
const run = (ordinal: number, text: string, instance = CLOUD) => ({
  run: {
    id: RunId.make("run-" + ordinal),
    ordinal,
    providerInstanceId: instance,
    userMessageId: MessageId.make("message-" + ordinal),
    startedAt: DateTime.makeUnsafe(0),
    status: "completed",
  },
  message: { id: MessageId.make("message-" + ordinal), text },
});

it("counts earlier deliveries to the same instance and skips refused ones", () => {
  const rows = [
    run(1, "continue"),
    run(2, "continue"),
    run(3, "continue", ProviderInstanceId.make("codex")),
    run(4, "continue"),
  ];
  // Fixture rows carry only the fields the history reads.
  const records = {
    runs: rows.map((row) => row.run),
    messages: rows.map((row) => row.message),
    turnItems: [
      {
        runId: RunId.make("run-2"),
        type: "error",
        failure: { code: CLOUD_DELIVERY_REJECTED_CODE },
      },
    ],
  } as unknown as Records;
  expect(cloudRunHistory(records, RunId.make("run-4"))).toEqual({
    prompt: "continue",
    earlierPrompts: ["continue"],
    first: false,
  });
  expect(cloudRunHistory(records, RunId.make("run-1"))?.first).toBe(true);
});
