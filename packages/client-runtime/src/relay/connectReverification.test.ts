import { describe, expect, it, vi } from "vite-plus/test";
import { RelayAuthenticationStrengthError } from "@goat/contracts/connectAssurance";
import { runConnectSensitiveAction } from "./connectReverification.ts";
const denied = () =>
  new RelayAuthenticationStrengthError({
    code: "authentication_strength_required",
    reason: "reauthentication_required",
    requiredLevel: "multi_factor",
    maxAgeSeconds: 600,
    traceId: "test-trace",
  });
describe("explicit Connect reverification", () => {
  it("invalidates credentials after verification and retries the action only once", async () => {
    const action = vi.fn().mockRejectedValueOnce(denied()).mockResolvedValue("linked");
    const reverify = vi.fn().mockResolvedValue(undefined);
    const invalidate = vi.fn().mockResolvedValue(undefined);
    expect(await runConnectSensitiveAction({ action, reverify, invalidate })).toBe("linked");
    expect(action).toHaveBeenCalledTimes(2);
    expect(reverify).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    action.mockRejectedValue(denied());
    await expect(runConnectSensitiveAction({ action, reverify, invalidate })).rejects.toMatchObject(
      { code: "authentication_strength_required" },
    );
    expect(action).toHaveBeenCalledTimes(4);
  });
  it("cancellation cannot resume the mutation", async () => {
    const action = vi.fn().mockRejectedValue(denied());
    const invalidate = vi.fn();
    await expect(
      runConnectSensitiveAction({
        action,
        invalidate,
        reverify: () => Promise.reject(new Error("cancelled")),
      }),
    ).rejects.toThrow("cancelled");
    expect(action).toHaveBeenCalledTimes(1);
    expect(invalidate).not.toHaveBeenCalled();
  });
});
