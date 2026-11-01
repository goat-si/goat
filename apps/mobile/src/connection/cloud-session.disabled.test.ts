import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { makeMobileCloudSession } from "./cloud-session";

it.effect("is synchronously signed out and refuses a retained session without reading tokens", () =>
  Effect.gen(function* () {
    const readClerkToken = vi.fn(() => Effect.succeed("old-token"));
    const readSession = vi.fn(() => ({ accountId: "old-account", readClerkToken }));
    const session = makeMobileCloudSession(readSession);
    expect(Option.isNone(yield* session.identity)).toBe(true);
    const result = yield* Effect.exit(session.clerkToken);
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result))
      expect(Cause.squash(result.cause)).toMatchObject({
        _tag: "ConnectionBlockedError",
        reason: "unsupported",
      });
    expect(readSession).not.toHaveBeenCalled();
    expect(readClerkToken).not.toHaveBeenCalled();
  }),
);
