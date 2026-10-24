import { describe, expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentAuthorizationError,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AuthEnvironmentScope,
  type OrchestrationV2ThreadShell,
  type RuntimeMode,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";
import * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ThreadReplicaService from "../mcp/ThreadReplicaService.ts";
import { reauthorizationFailure } from "../mcp/threadAccess.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ThreadResultService from "../threadResults/ThreadResultService.ts";
import * as Dispatch from "./SshRemoteDispatch.ts";
import { host, initialize, withRemote } from "./SshRemoteDispatch.hostCall.testkit.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("decision-origin"),
  requestNamespace: "decision-dispatch-test",
  thread: {
    threadId: ThreadId.make("launcher"),
    providerSessionId: "provider-session",
    providerInstanceId,
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const reply = { accepted: true };
const decode = Schema.decodeUnknownEffect(Schema.Struct({ accepted: Schema.Boolean }));
const answer = (request: { readonly method: string }) =>
  initialize(request) ?? { result: { structuredContent: reply } };
const denied = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });

// #1405: keep HostThreads and dispatch real; fake only their unused services and caller store.
const throughHostThreads = <A, E>(
  body: (service: HostThreads.HostThreadsMcpServiceShape) => Effect.Effect<A, E>,
  caller: () => Pick<
    OrchestrationV2ThreadShell,
    "runtimeMode" | "interactionMode" | "activeRunId"
  > = () => ({
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: RunId.make("active-run"),
  }),
) =>
  Effect.gen(function* () {
    const dispatch = yield* Dispatch.SshRemoteDispatch;
    return yield* Effect.flatMap(HostThreads.HostThreadsMcpService, body).pipe(
      Effect.provide(
        HostThreads.layer.pipe(
          Layer.provide(Layer.succeed(Dispatch.SshRemoteDispatch, dispatch)),
          Layer.provide(layerNoFleetSync),
          Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
          Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
          Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
          Layer.provide(Layer.mock(LaunchWatchService.LaunchWatchService)({})),
          Layer.provide(Layer.mock(ThreadReplicaService.ThreadReplicaService)({})),
          Layer.provide(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: () =>
                Effect.sync(
                  () =>
                    ({
                      id: scope.thread!.threadId,
                      providerInstanceId,
                      deletedAt: null,
                      archivedAt: null,
                      ...caller(),
                    }) as OrchestrationV2ThreadShell,
                ),
            }),
          ),
        ),
      ),
    );
  });

const invoke = (
  service: HostThreads.HostThreadsMcpServiceShape,
  writes: boolean,
  authorize: Effect.Effect<RuntimeMode, OrchestratorMcpFailure>,
  invocation = scope,
  approvals = false,
) => {
  // A variable lets this regression execute on the old API, which ignores authorize.
  const input = {
    host,
    tool: writes ? "goat_decision_answer" : "goat_decision_get",
    arguments: { id: "decision-1" },
    authorize,
    approvals,
  };
  return writes
    ? service.writeOnHost(invocation, input, decode)
    : service.readOnHost(invocation, input, decode);
};

describe("#1405 baseline-failing: HostThreads additional authorization", () => {
  it.effect.each([
    { writes: false, stage: "initial", grant: "threads.remote" },
    { writes: true, stage: "initial", grant: "destination host" },
    { writes: false, stage: "prepared", grant: "destination host" },
    { writes: true, stage: "prepared", grant: "threads.remote" },
    { writes: false, stage: "session", grant: "required profile" },
    { writes: true, stage: "initialized", grant: "required profile" },
  ] as const)(
    "refuses writes=$writes when $grant narrows at $stage with runtime unchanged",
    ({ writes, stage, grant }) =>
      Effect.gen(function* () {
        let allowed = stage !== "initial";
        const revoke = Effect.sync(() => {
          allowed = false;
        });
        const authorize = Effect.suspend(() =>
          allowed
            ? Effect.succeed("full-access" as const)
            : Effect.fail(denied(`${grant} revoked`)),
        );
        const { result, record } = yield* withRemote(
          {
            beforeEnvironmentReady: stage === "prepared" ? revoke : Effect.void,
            beforeSessionIssue: () => (stage === "session" ? revoke : Effect.void),
            answer: (request) => {
              if (stage === "initialized" && request.method === "notifications/initialized")
                allowed = false;
              return answer(request);
            },
          },
          throughHostThreads((service) => invoke(service, writes, authorize)),
        );
        expect(record.toolCalls).toEqual([]);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: "capability_denied", message: `${grant} revoked` },
        });
        if (stage === "initial" || stage === "prepared") expect(record.sessionsIssued).toBe(0);
      }),
  );

  it.effect.each([
    { writes: false, removed: "orchestration:operate", approvals: false, stage: "prepared" },
    { writes: false, removed: "orchestration:read", approvals: false, stage: "initialized" },
    { writes: true, removed: "orchestration:approve", approvals: true, stage: "session" },
    { writes: true, removed: "orchestration:approve", approvals: true, stage: "initialized" },
  ] as const)(
    "refuses writes=$writes after live $removed revocation at $stage",
    ({ writes, removed, approvals, stage }) =>
      Effect.gen(function* () {
        const grants = new Set<AuthEnvironmentScope>([
          "orchestration:read",
          "orchestration:operate",
          "orchestration:approve",
        ]);
        const required: ReadonlyArray<AuthEnvironmentScope> = writes
          ? ["orchestration:operate", "orchestration:approve"]
          : ["orchestration:read", "orchestration:operate"];
        const outside: McpInvocationScope = {
          ...scope,
          thread: undefined,
          client: { sessionId: "outside", label: "Outside", access: "full-access", approvals },
          reauthorize: (scopes) =>
            Effect.suspend(() => {
              const missing = scopes.find((item) => !grants.has(item));
              return missing === undefined
                ? Effect.void
                : Effect.fail(
                    new EnvironmentAuthorizationError({
                      message: "Live scope revoked",
                      requiredScope: missing,
                    }),
                  );
            }),
        };
        const authorize = outside.reauthorize!(required).pipe(
          Effect.mapError(reauthorizationFailure),
          Effect.as("full-access" as const),
        );
        const revoke = Effect.sync(() => {
          grants.delete(removed);
        });
        const { result, record } = yield* withRemote(
          {
            beforeEnvironmentReady: stage === "prepared" ? revoke : Effect.void,
            beforeSessionIssue: () => (stage === "session" ? revoke : Effect.void),
            answer: (request) => {
              if (stage === "initialized" && request.method === "notifications/initialized")
                grants.delete(removed);
              return answer(request);
            },
          },
          throughHostThreads((service) => invoke(service, writes, authorize, outside, approvals)),
        );
        expect(record.toolCalls).toEqual([]);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { code: "capability_denied", message: "Live scope revoked" },
        });
      }),
  );

  it.effect.each([false, true])("uses the narrower callback session ceiling writes=%s", (writes) =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        { answer },
        throughHostThreads((service) =>
          invoke(service, writes, Effect.succeed("approval-required")),
        ),
      );
      expect(result).toMatchObject({ _tag: "Success", success: { ...reply, host } });
      expect(record.sessionOptions).toMatchObject([{ runtimeModeCeiling: "approval-required" }]);
      expect(record.toolCalls).toHaveLength(1);
    }),
  );

  it.effect("rechecks the narrowing grant before replacing a rejected session", () =>
    Effect.gen(function* () {
      let allowed = true;
      let attempts = 0;
      const { result, record } = yield* withRemote(
        {
          answer: (request) => {
            const handshake = initialize(request);
            if (handshake !== undefined) return handshake;
            attempts += 1;
            allowed = false;
            return attempts === 1 ? { status: 401 } : { result: { structuredContent: reply } };
          },
        },
        throughHostThreads((service) =>
          invoke(
            service,
            true,
            Effect.suspend(() =>
              allowed
                ? Effect.succeed("full-access" as const)
                : Effect.fail(denied("Retry grant revoked")),
            ),
          ),
        ),
      );
      expect(record.toolCalls).toEqual(["goat_decision_answer"]);
      expect(record.sessionsIssued).toBe(1);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
    }),
  );

  it.effect.each([false, true])("rechecks narrowing for a linked destination writes=%s", (writes) =>
    Effect.gen(function* () {
      let allowed = true;
      const { result, record } = yield* withRemote(
        {
          linkedHost: {
            host: {
              name: host,
              baseUrl: "https://build.example.test",
              environmentId: "linked-env",
              label: "Build",
              serverVersion: "0.1.0-test",
              access: "full-access",
              linkedAt: "2026-10-25T00:00:00.000Z",
              expiresAt: null,
            },
            token: "fixture-link",
          },
          ensureFails: true,
          answer: (request) => {
            if (request.method === "notifications/initialized") allowed = false;
            return answer(request);
          },
        },
        throughHostThreads((service) =>
          invoke(
            service,
            writes,
            Effect.suspend(() =>
              allowed
                ? Effect.succeed("full-access" as const)
                : Effect.fail(denied("Linked grant revoked")),
            ),
          ),
        ),
      );
      expect(record.sessionsIssued).toBe(0);
      expect(record.toolCalls).toEqual([]);
      expect(result).toMatchObject({ _tag: "Failure", failure: { code: "capability_denied" } });
    }),
  );
});

describe("#1405 preservation: existing caller and transport checks", () => {
  it.effect.each([
    {
      writes: false,
      live: false,
      interactionMode: "default",
      stage: "initial",
      code: "parent_not_active",
    },
    {
      writes: true,
      live: true,
      interactionMode: "plan",
      stage: "initial",
      code: "interaction_mode_escalation_denied",
    },
    {
      writes: false,
      live: false,
      interactionMode: "default",
      stage: "prepared",
      code: "parent_not_active",
    },
    {
      writes: true,
      live: true,
      interactionMode: "plan",
      stage: "prepared",
      code: "interaction_mode_escalation_denied",
    },
    {
      writes: false,
      live: false,
      interactionMode: "default",
      stage: "initialized",
      code: "parent_not_active",
    },
    {
      writes: true,
      live: true,
      interactionMode: "plan",
      stage: "initialized",
      code: "interaction_mode_escalation_denied",
    },
  ] as const)(
    "additional grant cannot bypass $code at $stage",
    ({ writes, live, interactionMode, stage, code }) =>
      Effect.gen(function* () {
        let changed = stage === "initial";
        const { result, record } = yield* withRemote(
          {
            beforeEnvironmentReady: Effect.sync(() => {
              if (stage === "prepared") changed = true;
            }),
            answer: (request) => {
              if (stage === "initialized" && request.method === "notifications/initialized")
                changed = true;
              return answer(request);
            },
          },
          throughHostThreads(
            (service) => invoke(service, writes, Effect.succeed("full-access")),
            () => ({
              runtimeMode: "full-access",
              interactionMode: changed ? interactionMode : "default",
              activeRunId: !changed || live ? RunId.make("run") : null,
            }),
          ),
        );
        expect(record.toolCalls).toEqual([]);
        expect(result).toMatchObject({ _tag: "Failure", failure: { code } });
      }),
  );

  it.effect("a broader additional grant cannot raise the existing caller ceiling", () =>
    Effect.gen(function* () {
      const { result, record } = yield* withRemote(
        { answer },
        throughHostThreads(
          (service) => invoke(service, true, Effect.succeed("full-access")),
          () => ({
            runtimeMode: "approval-required",
            interactionMode: "default",
            activeRunId: RunId.make("run"),
          }),
        ),
      );
      expect(result._tag).toBe("Success");
      expect(record.sessionOptions).toMatchObject([{ runtimeModeCeiling: "approval-required" }]);
    }),
  );

  it.effect.each([false, true])("forwards the full profile ceiling unchanged writes=%s", (writes) =>
    Effect.gen(function* () {
      const arguments_ = {
        ...(writes
          ? { id: "decision-1", optionId: "accept", reason: "Reviewed" }
          : {
              launcherEnvironmentId: "decision-origin",
              launcherThreadId: "launcher",
            }),
        permissionProfileCeiling: BUILTIN_PERMISSION_PROFILES.worker!,
      };
      const tool = writes ? "goat_decision_answer" : "goat_decision_list";
      const { result, record } = yield* withRemote(
        { answer },
        Effect.flatMap(Dispatch.SshRemoteDispatch, (dispatch) =>
          dispatch.callHostTool(
            { host, tool, arguments: arguments_, writes, timeoutMs: 5_000, approvals: writes },
            Effect.succeed("approval-required"),
          ),
        ),
      );
      expect(result).toMatchObject({ _tag: "Success", success: reply });
      expect(record.toolCallArguments).toEqual([{ tool, arguments: arguments_ }]);
      expect(record.sessionOptions).toMatchObject([{ runtimeModeCeiling: "approval-required" }]);
      expect(record.sessionOptions.map((options) => options.approvals === true)).toEqual([writes]);
    }),
  );

  it.effect("old remote schema refusal never retries discovery without lineage", () =>
    Effect.gen(function* () {
      const arguments_ = {
        launcherEnvironmentId: "decision-origin",
        permissionProfileCeiling: BUILTIN_PERMISSION_PROFILES.worker!,
      };
      const { result, record } = yield* withRemote(
        {
          answer: (request) =>
            initialize(request) ?? { rpcError: "Unrecognized key: launcherEnvironmentId" },
        },
        Effect.flatMap(Dispatch.SshRemoteDispatch, (dispatch) =>
          dispatch.callHostTool(
            {
              host,
              tool: "goat_decision_list",
              arguments: arguments_,
              writes: false,
              timeoutMs: 5_000,
            },
            Effect.succeed("approval-required"),
          ),
        ),
      );
      expect(result).toMatchObject({ _tag: "Failure", failure: { reason: "remote_refused" } });
      expect(record.toolCallArguments).toEqual([
        { tool: "goat_decision_list", arguments: arguments_ },
      ]);
    }),
  );
});
