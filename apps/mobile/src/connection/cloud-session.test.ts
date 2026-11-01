import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { makeMobileCloudSession } from "./cloud-session";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

it.effect("preserves enabled session identity and token lookup", () =>
  Effect.gen(function* () {
    const readClerkToken = vi.fn(() => Effect.succeed("token"));
    const session = makeMobileCloudSession(() => ({ accountId: "account", readClerkToken }));
    expect(yield* session.identity).toEqual(Option.some({ accountId: "account", readClerkToken }));
    expect(yield* session.clerkToken).toBe("token");
    expect(readClerkToken).toHaveBeenCalledOnce();
  }),
);

it.effect("preserves authentication errors when enabled but signed out", () =>
  Effect.gen(function* () {
    const session = makeMobileCloudSession(() => null);
    expect(Option.isNone(yield* session.identity)).toBe(true);
    expect(yield* Effect.flip(session.clerkToken)).toMatchObject({
      _tag: "ConnectionBlockedError",
      reason: "authentication",
    });
  }),
);
