import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type OrchestrationMessageContext } from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { editedQueuedPayload, withServerAttribution } from "./GuestShareDecider.ts";

const remoteSender = {
  environmentId: EnvironmentId.make("mini"),
  environmentLabel: "mini",
  threadId: ThreadId.make("coordinator"),
  title: "Coordinator",
};
const withSender: OrchestrationMessageContext = { version: 1, records: [], remoteSender };
const forged: OrchestrationMessageContext = {
  version: 1,
  records: [],
  remoteSender: { ...remoteSender, title: "Forged" },
};

it("keeps a remote sender only on an agent-created send; a client cannot claim one", () => {
  assert.deepEqual(
    withServerAttribution({ createdBy: "agent", context: withSender }).context?.remoteSender,
    remoteSender,
  );
  assert.notProperty(
    withServerAttribution({ createdBy: "user", context: withSender }).context,
    "remoteSender",
  );
});

it("an edited queued message keeps the sender it was sent with and gains none from the edit", () => {
  const at = DateTime.makeUnsafe("2026-10-28T00:00:00.000Z");
  const stored = { text: "Rebase", createdBy: "agent", context: withSender, updatedAt: at };
  const edited = editedQueuedPayload(stored, { text: "Rebase onto dev", context: forged }, {}, at);
  assert.equal(edited.text, "Rebase onto dev");
  assert.deepEqual(edited.context?.remoteSender, remoteSender);
  // A message sent without a sender cannot get one by being edited, even when agent-created.
  const plain = {
    text: "Hi",
    createdBy: "agent",
    context: { version: 1 as const, records: [] },
    updatedAt: at,
  };
  assert.notProperty(
    editedQueuedPayload(plain, { text: "Hi", context: forged }, {}, at).context,
    "remoteSender",
  );
});
