import {
  EnvironmentAuthorizationError,
  HandoffError,
  HandoffSummary,
  SshHostStatus,
  OrchestratorMcpFailure,
  PortSchema,
  SavedConnection,
  SshHostAlias,
  SshHostProbeError,
  SshHostResult,
  SshPreflightReport,
  TrimmedNonEmptyString,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Broker from "../connections/ConnectionCatalogBroker.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { assertFullAccess, assertLiveCaller, readCaller } from "../mcp/threadAccess.ts";
import {
  authorizeApprovalRequest,
  authorizeSshHost,
  type SshHostCaller,
} from "./SshHostAuthorization.ts";
import * as Setup from "./SshHostSetup.ts";

export const SshDeviceAddInput = Schema.Struct({
  host: Schema.optional(TrimmedNonEmptyString),
  address: Schema.optional(TrimmedNonEmptyString),
  user: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PortSchema),
  alias: Schema.optional(SshHostAlias),
  label: Schema.optional(TrimmedNonEmptyString),
  identityFile: Schema.optional(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter((input) => (input.host === undefined) !== (input.address === undefined)),
);
export type SshDeviceAddInput = typeof SshDeviceAddInput.Type;
const unsaved = {
  preflight: Schema.optional(SshPreflightReport),
  saved: Schema.Literal(false),
  reason: Schema.String,
};
export const SshDeviceAddResult = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal("failed"), preflight: SshPreflightReport }),
  Schema.Struct({
    outcome: Schema.Literal("capability_denied"),
    preflight: SshPreflightReport,
    saved: Schema.Literal(false),
    reason: Schema.String,
  }),
  Schema.Struct({
    outcome: Schema.Literal("needs_human"),
    preflight: SshPreflightReport,
    handoff: HandoffSummary,
    status: SshHostStatus,
    next: Schema.Struct({
      after: Schema.Literal("approval"),
      call: Schema.Literal("goat_ssh_host_add"),
      host: SshHostAlias,
    }),
  }),
  Schema.Struct({
    outcome: Schema.Literal("connected"),
    preflight: SshPreflightReport,
    connection: SavedConnection,
    created: Schema.Boolean,
  }),
  Schema.Struct({ ...SshHostResult.members[0].fields, ...unsaved }),
  Schema.Struct({ ...SshHostResult.members[1].fields, ...unsaved }),
  Schema.Struct({ ...SshHostResult.members[2].fields, ...unsaved }),
]);
export type SshDeviceAddResult = typeof SshDeviceAddResult.Type;
export class SshDeviceAdd extends Context.Service<
  SshDeviceAdd,
  {
    readonly addDevice: (
      input: SshDeviceAddInput,
      caller: SshHostCaller,
    ) => Effect.Effect<
      SshDeviceAddResult,
      EnvironmentAuthorizationError | HandoffError | SshHostProbeError | OrchestratorMcpFailure
    >;
  }
>()("goat/sshRemote/SshDeviceAdd") {}

// Fingerprints belong to the human trust review, including when an agent cannot proceed.
const toAgentReport = (report: SshPreflightReport): SshPreflightReport => ({
  ...report,
  steps: report.steps.map(({ fingerprint: _fingerprint, ...step }) => step),
});

const make = Effect.gen(function* () {
  const setup = yield* Setup.SshHostSetup;
  const broker = yield* Broker.ConnectionCatalogBroker;
  const sessions = yield* Sessions.SessionStore;
  const threads = yield* Threads.ThreadManagementService;
  const addDevice: SshDeviceAdd["Service"]["addDevice"] = (input, caller) =>
    Effect.gen(function* () {
      if (caller.kind !== "mcp")
        return {
          saved: false,
          reason: "A thread is required for SSH handoffs.",
          kind: "error",
          code: "unsupported",
          message: "Add this host in Settings → Connections.",
          fix: { actor: "human", instruction: "Add this host in Settings → Connections." },
        };
      if ((input.host === undefined) === (input.address === undefined))
        return yield* new SshHostProbeError({
          host: input.host ?? input.address ?? "SSH host",
          reason: "invalid_request",
          message: "Pass exactly one of host or address.",
        });
      const resolved = yield* setup.resolveDestination({
        ...input,
        address: input.host ?? input.address!,
      });
      const preflight = toAgentReport(
        yield* setup.preflight(
          resolved.host
            ? { host: resolved.host }
            : { ...resolved.input, host: resolved.input.address },
          caller,
        ),
      );
      if (preflight.steps.some((step) => step.state === "failed"))
        return { outcome: "failed", preflight };
      // Why the connection could not be saved, kept so a later denied step still explains it.
      let saveBlocked: string | undefined;
      const deniedReason = (message: string) =>
        saveBlocked === undefined ? message : `${saveBlocked} ${message}`;
      // The grant name alone does not tell an agent what to do next.
      const nextStep = (scope: string) =>
        scope === "settings:write"
          ? " A person must approve this host's key: ask them to add it in Settings → Connections → Add device → SSH, or call goat_ssh_host_add from a running GOAT thread so they can approve it there."
          : scope === "environment:maintain"
            ? " Ask the person to connect it in Settings → Connections, or use a caller allowed to maintain environments."
            : "";
      return yield* Effect.gen(function* () {
        const requestTrust = (): ReturnType<SshDeviceAdd["Service"]["addDevice"]> =>
          Effect.gen(function* () {
            if (!caller.scope.thread) {
              yield* authorizeSshHost(sessions, caller, "settings:write");
              return {
                saved: false,
                preflight,
                reason: "A thread is required for SSH handoffs.",
                kind: "error",
                code: "unsupported",
                message: "Add this host in Settings → Connections.",
                fix: { actor: "human", instruction: "Add this host in Settings → Connections." },
              };
            }
            yield* authorizeApprovalRequest(caller.scope);
            const result = yield* setup.add(resolved.input, caller);
            if (result.kind !== "needs_human")
              return {
                ...result,
                preflight,
                saved: false,
                reason: "Host trust has not completed.",
              };
            return {
              outcome: "needs_human",
              preflight,
              handoff: result.handoff,
              status: result.status,
              next: { after: "approval", call: "goat_ssh_host_add", host: result.status.host },
            };
          });
        if (!preflight.ready || !resolved.host) return yield* requestTrust();
        const scope = caller.scope;
        const liveCaller = readCaller().pipe(
          Effect.tap(assertLiveCaller),
          Effect.provideService(Invocation.McpInvocationContext, scope),
          Effect.provideService(Threads.ThreadManagementService, threads),
        );
        const current = yield* liveCaller;
        let reason = "Saving a desktop connection needs full access.";
        if (
          current.limits.runtimeMode === "full-access" &&
          current.limits.interactionMode === "default"
        ) {
          const at = DateTime.formatIso(yield* DateTime.now);
          const latest = yield* liveCaller;
          yield* assertFullAccess(
            latest,
            "Saving a desktop connection needs a live full-access/default calling thread or a full-access client.",
          );
          const response = yield* broker
            .invoke(
              {
                type: "add_ssh",
                host: resolved.host,
                ...(input.label ? { label: input.label } : {}),
                addedBy: {
                  kind: "agent",
                  ...(scope.thread ? { threadId: scope.thread.threadId } : {}),
                  ...(scope.client ? { client: scope.client.label } : {}),
                  at,
                },
              },
              10 * 60_000,
            )
            .pipe(
              Effect.catchTags({
                ConnectionCatalogHostUnavailable: () => Effect.succeed(null),
                ConnectionCatalogHostDetached: () =>
                  Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "host_unavailable",
                      message:
                        "The desktop detached while adding this connection. Check Settings → Connections before trying again.",
                    }),
                  ),
                ConnectionCatalogTimeout: () =>
                  Effect.fail(
                    new OrchestratorMcpFailure({
                      code: "host_unavailable",
                      message:
                        "The desktop did not answer while adding this connection. Check Settings → Connections before trying again.",
                    }),
                  ),
              }),
            );
          if (response?.type === "add_ssh")
            return {
              outcome: "connected" as const,
              preflight,
              connection: response.connection,
              created: response.created,
            };
          if (response !== null)
            return yield* new OrchestratorMcpFailure({
              code:
                response.type === "failure" && response.reason === "connection_failed"
                  ? "host_unavailable"
                  : "invalid_request",
              message:
                response.type === "failure"
                  ? response.message.slice(0, 2000)
                  : "The desktop returned a different operation's response.",
            });
          reason =
            "No desktop connection catalog is attached; this environment cannot save a desktop connection.";
        }
        saveBlocked = reason;
        if (!resolved.managed) return yield* requestTrust();
        yield* authorizeSshHost(sessions, caller, "environment:maintain");
        const result = yield* setup.prepare({ host: resolved.host }, caller);
        return { ...result, preflight, saved: false as const, reason };
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthorizationError: (error) =>
            Effect.succeed({
              outcome: "capability_denied" as const,
              preflight,
              saved: false as const,
              reason: deniedReason(error.message + nextStep(error.requiredScope)),
            }),
          OrchestratorMcpFailure: (error) =>
            error.code === "capability_denied"
              ? Effect.succeed({
                  outcome: "capability_denied" as const,
                  preflight,
                  saved: false as const,
                  reason: deniedReason(error.message),
                })
              : Effect.fail(error),
        }),
      );
    });
  return SshDeviceAdd.of({ addDevice });
});
export const layer = Layer.effect(SshDeviceAdd, make);
