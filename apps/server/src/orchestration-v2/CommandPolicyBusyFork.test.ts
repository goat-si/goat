import { assert, it } from "@effect/vitest";
import { CommandId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandPolicy from "./CommandPolicy.ts";

it.effect("only opted-in adapters fork a completed boundary while the source runs", () =>
  Effect.gen(function* () {
    const policy = yield* CommandPolicy.CommandPolicyV2;
    // Codex opts in itself, so the unset case starts from its threads without the flag.
    const { canForkWhileSourceRunning: _codexOptIn, ...threads } =
      CodexProviderCapabilitiesV2.threads;
    const decide = (flag: boolean | undefined, status: "completed" | "running") =>
      policy.decideForkExecution({
        commandId: CommandId.make("busy-fork"),
        threadId: ThreadId.make("busy-fork"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        capabilities: {
          ...CodexProviderCapabilitiesV2,
          threads: {
            ...threads,
            ...(flag === undefined ? {} : { canForkWhileSourceRunning: flag }),
          },
        },
        sameProvider: true,
        hasStrongNativeSource: true,
        hasNativeTurnBoundary: true,
        sourceRunStatus: status,
        fromSpecificTurn: true,
        crossWorkspace: false,
        sourceBusy: true,
      });
    assert.equal(yield* decide(undefined, "completed"), "portable_context");
    assert.equal(yield* decide(false, "completed"), "portable_context");
    assert.equal(yield* decide(true, "completed"), "native_fork");
    assert.equal(yield* decide(true, "running"), "portable_context");
  }).pipe(Effect.provide(CommandPolicy.layer)),
);
