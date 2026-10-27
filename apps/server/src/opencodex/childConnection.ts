import {
  type ChildReadyAddress,
  type ChildReadyConnectionInput,
  type ChildReadyConnectionResult,
  type ChildReadyDeviceResult,
  decodeChildReadyConnectionInput,
  type EnvironmentId,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import type * as Profiles from "../goatclaw/PermissionProfiles.ts";
import type * as UpdateHost from "../hub/OpenCodexUpdateHost.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type * as ProcessRunner from "../processRunner.ts";
import type * as Inventory from "./OpenCodexInventory.ts";

const refused = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/**
 * goat_hub_child_connection: connect, disconnect or restart this Child's OpenCodex under an
 * ordinary live hub.manage session. A Child setup purpose never reaches it. The pairing code
 * goes only to native stdin and is never logged, returned or kept.
 */
export const makeChildConnection = Effect.fn("OpenCodexChildReady.makeChildConnection")(
  function* (deps: {
    readonly destinationEnvironmentId: EnvironmentId;
    readonly profiles: Profiles.PermissionProfiles["Service"];
    readonly runner: ProcessRunner.ProcessRunner["Service"];
    readonly host: UpdateHost.OpenCodexUpdateHost["Service"];
    readonly inventory: Inventory.OpenCodexInventory["Service"];
    readonly readDevice: (
      address: ChildReadyAddress,
    ) => Effect.Effect<ChildReadyDeviceResult, OrchestratorMcpFailure>;
    readonly invalidateProof: (home: EnvironmentId) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    const permit = yield* Semaphore.make(1);
    // Lets this operation restart right after its own successful disconnect; nothing else.
    const disconnected = yield* Ref.make<
      { home: EnvironmentId; operationId: string; membershipId: string } | undefined
    >(undefined);
    const authorize = Effect.fn("OpenCodexChildReady.authorizeConnection")(function* (
      input: ChildReadyConnectionInput,
      scope: McpInvocationScope,
    ) {
      if (
        scope.childSetupPurpose !== undefined ||
        scope.readOnly === true ||
        scope.client?.access === "read-only" ||
        !scope.capabilities.has("orchestration") ||
        scope.environmentId !== deps.destinationEnvironmentId ||
        input.destinationEnvironmentId !== deps.destinationEnvironmentId ||
        input.homeEnvironmentId === deps.destinationEnvironmentId ||
        (scope.client !== undefined &&
          (!scope.grantedScopes?.includes("orchestration:operate") ||
            scope.reauthorize === undefined))
      )
        return yield* refused(
          "capability_denied",
          "A live ordinary hub.manage session is required.",
        );
      if (scope.reauthorize !== undefined)
        yield* scope
          .reauthorize(["orchestration:operate"])
          .pipe(
            Effect.mapError(() =>
              refused("capability_denied", "The connection session was revoked or expired."),
            ),
          );
      yield* deps.profiles.require(scope, "hub.manage");
    });
    return Effect.fn("OpenCodexChildReady.connection")(function* (
      raw: ChildReadyConnectionInput,
      scope: McpInvocationScope,
    ) {
      yield* authorize(raw, scope);
      const input = yield* decodeChildReadyConnectionInput(raw).pipe(
        Effect.mapError(() => refused("invalid_request", "Invalid Child connection input.")),
      );
      return yield* permit.withPermit(
        Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              deps.host
                .holdAdmission(null)
                .pipe(
                  Effect.flatMap((held) =>
                    held
                      ? Effect.void
                      : Effect.fail(refused("conflict", "Cannot hold Child admission.")),
                  ),
                ),
              () => deps.host.releaseAdmission(null),
            );
            if ((yield* deps.host.member(null, scope)).runningTurns !== 0)
              return yield* refused("conflict", "Child activity is busy or unknown.");
            const address = {
              destinationEnvironmentId: input.destinationEnvironmentId,
              homeEnvironmentId: input.homeEnvironmentId,
            };
            const before = yield* deps.readDevice(address);
            const executable = before.device.ocx;
            if (executable.path === null)
              return yield* refused("provider_unavailable", "OpenCodex is not installed here.");
            const op = input.opencodexConnection;
            const inventory = yield* deps.inventory.readParity;
            const membershipId =
              before.device.connection.linkId ??
              (inventory.hubClient?.state === "connected"
                ? inventory.hubClient.apiKeyId
                : undefined);
            const pending = yield* Ref.get(disconnected);
            const sameDisconnect =
              op.kind === "restart" &&
              membershipId === undefined &&
              before.device.connection.role === "standalone" &&
              pending?.home === input.homeEnvironmentId &&
              pending.operationId === input.operationId &&
              pending.membershipId === op.expectedLinkId;
            if (
              op.kind !== "connectHubClient" &&
              membershipId !== op.expectedLinkId &&
              !sameDisconnect
            )
              return yield* refused(
                "conflict",
                "Child membership changed; reconcile before retrying.",
              );
            if (op.kind === "connectHubClient" && before.device.connection.role !== "standalone")
              return yield* refused(
                "conflict",
                "Child is already connected or its role is unknown.",
              );
            const args =
              op.kind === "connectHubClient"
                ? [
                    "connect",
                    op.dataUrl,
                    "--management-url",
                    op.managementUrl,
                    "--pairing-code-stdin",
                  ]
                : op.kind === "disconnect"
                  ? ["disconnect", "--json"]
                  : ["restart"];
            yield* deps.invalidateProof(input.homeEnvironmentId);
            yield* authorize(input, scope);
            // Output is discarded: a process may echo its stdin.
            const output = yield* deps.runner
              .run({
                command: executable.path,
                args,
                env: deps.environment,
                ...(op.kind === "connectHubClient" ? { stdin: `${op.pairingCode}\n` } : {}),
                timeout: "5 minutes",
                maxOutputBytes: 16 * 1024,
                timeoutBehavior: "timedOutResult",
              })
              .pipe(
                Effect.mapError(() =>
                  refused("orchestration_error", "Child connection command failed."),
                ),
              );
            const code = output.timedOut ? 124 : (output.code ?? 1);
            yield* Ref.set(
              disconnected,
              code === 0 && op.kind === "disconnect"
                ? {
                    home: input.homeEnvironmentId,
                    operationId: input.operationId,
                    membershipId: op.expectedLinkId,
                  }
                : undefined,
            );
            const after = yield* deps.readDevice(address);
            return {
              ...address,
              operationId: input.operationId,
              kind: op.kind,
              code,
              healthy: after.healthy,
            } satisfies ChildReadyConnectionResult;
          }),
        ),
      );
    });
  },
);
