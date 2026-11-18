import { RuntimeRequestId } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ decline: vi.fn(async () => true) }));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("@goat/client-runtime/state/thread-requests", () => ({
  declinePendingApprovals: state.decline,
  sendApprovalFeedback: vi.fn(),
}));

import { redirectDecline } from "./redirectDecline";

const approval = {
  requestId: RuntimeRequestId.make("approval"),
  requestKind: "command",
  createdAt: "2026-11-18T00:00:00.000Z",
  responseCapability: "live",
} as never;

// The redirect's mode save is a server round trip; a person can leave the thread meanwhile.
it("declines nothing and sends nothing when the thread is left during the mode save", async () => {
  state.decline.mockClear();
  const leave = new AbortController();
  const step = redirectDecline(
    { activePendingUserInput: null, respondingApprovalId: null, onRespondToApproval: vi.fn() },
    leave.signal,
    [approval],
    () => true,
    () => [],
  );
  const result = await step!("Do this instead", false, async () => {
    leave.abort();
    return true;
  });
  expect(result).toBe(false);
  expect(state.decline).not.toHaveBeenCalled();
});

it("declines nothing when the draft changed during the mode save", async () => {
  state.decline.mockClear();
  let sendable = true;
  const step = redirectDecline(
    { activePendingUserInput: null, respondingApprovalId: null, onRespondToApproval: vi.fn() },
    new AbortController().signal,
    [approval],
    () => sendable,
    () => [],
  );
  const result = await step!("Do this instead", false, async () => {
    sendable = false;
    return true;
  });
  expect(result).toBe(false);
  expect(state.decline).not.toHaveBeenCalled();
});
