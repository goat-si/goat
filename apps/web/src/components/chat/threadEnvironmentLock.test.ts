import { ProviderThreadId } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";
import { isThreadEnvironmentLocked } from "./threadEnvironmentLock";

describe("isThreadEnvironmentLocked", () => {
  it.each([
    { name: "an empty unbound thread", providerThread: null, expected: false },
    {
      name: "an imported session bound before its first run",
      providerThread: "imported",
      expected: true,
    },
  ])("locks $name: $expected", ({ providerThread, expected }) => {
    expect(
      isThreadEnvironmentLocked({
        messageCount: 0,
        hasRuntime: false,
        activeProviderThreadId:
          providerThread === null ? null : ProviderThreadId.make(providerThread),
      }),
    ).toBe(expected);
  });
});
