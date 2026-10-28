import { describe, it, expect } from "vite-plus/test";
import {
  advanceAccountDeletion,
  AccountIdentityDeletionPendingError,
  type AccountDeletionAdapter,
} from "./accountDeletion.ts";
import type { RelayAccountDeletion } from "@goat/contracts/relay";

const token = `e30.${btoa(JSON.stringify({ sub: "account-a" }))}.fixture`;
const erased: RelayAccountDeletion = {
  status: "progress",
  operationId: "op",
  relayState: "erased",
  step: "relay_erasure_completed",
  relayDenied: true,
  hostCleanup: { pending: 1, acknowledged: 0, unsupported: 0 },
  endpointCleanup: "pending",
  identityAction: "delete_clerk_user",
  traceId: "fixture",
};
function setup() {
  const calls: string[] = [];
  const adapter: AccountDeletionAdapter = {
    accountId: "account-a",
    session: {},
    isCurrent: () => true,
    getToken: async () => token,
    getStatus: async () => {
      calls.push("status");
      return { status: "absent" };
    },
    requestDelete: async () => {
      calls.push("relay-delete");
      return erased;
    },
    deleteIdentity: async () => {
      calls.push("identity-delete");
    },
  };
  return { adapter, calls };
}
describe("account-bound identity-last deletion", () => {
  it("cancellation reads status without deleting and confirmation erases relay before identity", async () => {
    const { adapter, calls } = setup();
    expect((await advanceAccountDeletion(adapter, "key", false)).identityDeleted).toBe(false);
    expect(calls).toEqual(["status"]);
    await advanceAccountDeletion(adapter, "key", true);
    expect(calls).toEqual(["status", "status", "relay-delete", "identity-delete"]);
  });
  it("account switch during the token await cannot delete either account", async () => {
    const { adapter, calls } = setup();
    let current = true;
    await expect(
      advanceAccountDeletion(
        {
          ...adapter,
          isCurrent: () => current,
          getToken: async () => {
            current = false;
            return token;
          },
        },
        "key",
        true,
      ),
    ).rejects.toThrow("Account or session changed");
    expect(calls).toEqual([]);
  });
  it("account switch after relay erasure cannot delete the newly active identity", async () => {
    const { adapter, calls } = setup();
    let current = true;
    await expect(
      advanceAccountDeletion(
        {
          ...adapter,
          isCurrent: () => current,
          requestDelete: async () => {
            current = false;
            return erased;
          },
        },
        "key",
        true,
      ),
    ).rejects.toThrow("Account or session changed");
    expect(calls).toEqual(["status"]);
  });
  it("pending relay progress blocks identity deletion and an identity failure preserves a resumable receipt", async () => {
    const { adapter, calls } = setup();
    const pending = { ...erased, relayState: "erasing" as const };
    expect(
      (
        await advanceAccountDeletion(
          { ...adapter, requestDelete: async () => pending },
          "key",
          true,
        )
      ).identityDeleted,
    ).toBe(false);
    expect(calls).toEqual(["status"]);
    await expect(
      advanceAccountDeletion(
        {
          ...adapter,
          getStatus: async () => erased,
          deleteIdentity: async () => {
            throw new Error("reverification cancelled");
          },
        },
        "key",
        true,
      ),
    ).rejects.toBeInstanceOf(AccountIdentityDeletionPendingError);
    expect(
      (await advanceAccountDeletion({ ...adapter, getStatus: async () => erased }, "new-key", true))
        .identityDeleted,
    ).toBe(true);
  });
});
