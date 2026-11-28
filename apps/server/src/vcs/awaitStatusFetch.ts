import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type { GitCommandError } from "@goat/contracts";

export const AwaitStatusFetch = Context.Reference<boolean>("goat/vcs/AwaitStatusFetch", {
  defaultValue: () => false,
});
export const awaitStatusFetch = Effect.fn("GitVcsDriver.awaitStatusFetch")(function* (
  fiber: Fiber.Fiber<void, GitCommandError> | undefined,
) {
  if ((yield* AwaitStatusFetch) && fiber) yield* Fiber.await(fiber);
});
