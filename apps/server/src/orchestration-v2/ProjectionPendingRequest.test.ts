import { NodeId, RunId, RuntimeRequestId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { secretRequestAsPendingInput } from "./ProjectionPendingRequest.ts";

const at = DateTime.makeUnsafe("2026-11-18T00:00:00.000Z");
const base = {
  id: TurnItemId.make("card"),
  threadId: ThreadId.make("child"),
  runId: RunId.make("run"),
  nodeId: NodeId.make("node"),
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "waiting" as const,
  title: "Card",
  startedAt: at,
  completedAt: null,
  updatedAt: at,
};

describe("secretRequestAsPendingInput", () => {
  it("marks a waiting secret card as one only the user can answer", () => {
    expect(
      secretRequestAsPendingInput({
        ...base,
        type: "secret_request",
        label: "SMS code",
        reason: "The agent needs the code.",
        secretStatus: "pending",
      }),
    ).toEqual({
      id: RuntimeRequestId.make("card"),
      kind: "user_input",
      createdAt: at,
      blocking: true,
      userOnly: true,
    });
  });

  it("marks a waiting human handoff as one only the user can answer", () => {
    const summary = secretRequestAsPendingInput({
      ...base,
      type: "human_handoff",
      handoff: { kind: "login", title: "Sign in" },
    } as never);
    expect(summary).toMatchObject({ kind: "user_input", blocking: true, userOnly: true });
  });
});
