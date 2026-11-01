import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Service from "./MemoryService.ts";

export type MemoryPermit = Effect.Effect<void, Service.MemoryAccessError>;
export type MemoryAccessRequirement = "read" | "write" | "source" | "binding-read";

/** All callbacks must read live, committed SQL-free authority; the Effect is repeatable. */
export function memoryAccessPermit(
  input: {
    readonly grantedScopes?: ReadonlyArray<M.AuthEnvironmentScope>;
    readonly reauthorize?: (scopes: ReadonlyArray<M.AuthEnvironmentScope>) => MemoryPermit;
    readonly readOnly: boolean;
    readonly liveCaller?: MemoryPermit;
  },
  requirement: MemoryAccessRequirement,
): MemoryPermit {
  const scopes: ReadonlyArray<M.AuthEnvironmentScope> =
    requirement === "source"
      ? ["memory:read", "orchestration:read"]
      : [
          requirement === "write" || requirement === "binding-read"
            ? "memory:write"
            : "memory:read",
        ];
  return Effect.suspend(() => {
    const reauthorize = input.reauthorize;
    if (
      !reauthorize ||
      !input.grantedScopes ||
      (requirement === "write" && input.readOnly) ||
      scopes.some((scope) => !input.grantedScopes?.includes(scope))
    )
      return Effect.fail(new Service.MemoryAccessError({ code: "unavailable" }));
    return Effect.gen(function* () {
      if (input.liveCaller) yield* input.liveCaller;
      yield* reauthorize(scopes);
    });
  });
}

/** A captured ceiling can only narrow destination policy and authenticated dispatch scopes. */
export function currentMemoryAccess(input: {
  readonly enableAgentMemoryAccess: boolean;
  readonly policyReady: boolean;
  readonly readOnly: boolean;
  // Null is an ordinary user start; undefined is legacy task metadata and denies.
  readonly memoryGrantCeiling: M.MemoryTaskGrantCeiling | null | undefined;
  readonly dispatchScopes?: ReadonlyArray<M.AuthEnvironmentScope>;
}): M.MemoryCurrentAccess {
  if (!input.policyReady) return { access: "none", reason: "policy_unready" };
  if (!input.enableAgentMemoryAccess) return { access: "none", reason: "environment_off" };
  if (input.memoryGrantCeiling === undefined) return { access: "none", reason: "legacy_none" };
  const ceiling =
    input.memoryGrantCeiling === null ? "read_write" : (input.memoryGrantCeiling ?? "none");
  const canRead =
    ceiling !== "none" &&
    (input.dispatchScopes === undefined || input.dispatchScopes.includes("memory:read"));
  if (!canRead)
    return { access: "none", reason: ceiling === "none" ? "ceiling" : "dispatch_scope" };
  const canWrite =
    ceiling === "read_write" &&
    !input.readOnly &&
    (input.dispatchScopes === undefined || input.dispatchScopes.includes("memory:write"));
  return {
    access: canWrite ? "read_write" : "read",
    reason:
      ceiling === "read_write" && !canWrite
        ? input.readOnly
          ? "read_only_destination"
          : "dispatch_scope"
        : "ceiling",
  };
}

export function effectiveMemoryGrant(
  input: Parameters<typeof currentMemoryAccess>[0],
): M.MemoryTaskGrantCeiling {
  return currentMemoryAccess(input).access;
}

/** Capture actual memory grants, never infer them from orchestration or runtime mode. */
export function captureMemoryGrantCeiling(
  scopes: ReadonlyArray<M.AuthEnvironmentScope>,
  readOnly: boolean,
): M.MemoryTaskGrantCeiling {
  return !scopes.includes("memory:read")
    ? "none"
    : scopes.includes("memory:write") && !readOnly
      ? "read_write"
      : "read";
}
