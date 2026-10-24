import { expect, it } from "@effect/vitest";
import {
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  EnvironmentAuthorizationError,
  OrchestratorMcpFailure,
  type DecisionItem,
  type PermissionProfile,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Inbox from "./DecisionInbox.ts";
import * as Profiles from "./PermissionProfiles.ts";
import * as Settings from "../serverSettings.ts";
import * as Hosts from "../mcp/HostThreadsMcpService.ts";
import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as Access from "../mcp/McpToolAccess.ts";
import { liveThreadsLayer } from "../mcp/McpToolAccess.testkit.ts";
import * as Handlers from "../mcp/toolkits/decision/handlers.ts";
import { DecisionToolkit } from "../mcp/toolkits/decision/tools.ts";

const item = (env: string, id = "decision:collision"): DecisionItem => ({
  id,
  source: "decision",
  from: { environmentId: EnvironmentId.make(env) },
  title: "Choose placement",
  context: "Which host?",
  options: [{ id: "wait", label: "Wait", consequence: "Paused" }],
  recommended: null,
  requiredProfile: "worker",
  expiresAt: null,
  status: "open",
  answer: null,
  answeredBy: null,
  createdAt: "1970-01-01T00:00:00.000Z",
  updatedAt: "1970-01-01T00:00:00.000Z",
  humanRequired: false,
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("origin"),
  requestNamespace: "manager",
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
  thread: undefined,
  grantedScopes: ["orchestration:read", "orchestration:operate", "orchestration:approve"],
  reauthorize: () => Effect.void,
  client: { sessionId: "manager", label: "Manager", access: "full-access" },
};
const denied = () =>
  new OrchestratorMcpFailure({ code: "capability_denied", message: "Grant revoked" });
const run = <A, E>(
  options: {
    readonly caller?: Invocation.McpInvocationScope;
    readonly aliases?: ReadonlyArray<string>;
    readonly profile?: PermissionProfile;
    readonly currentProfile?: () => PermissionProfile;
    readonly beforeAuthorize?: (tool: string) => void;
    readonly answer?: (
      host: string,
      tool: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<unknown, OrchestratorMcpFailure>;
  },
  body: (toolkit: typeof DecisionToolkit.Service) => Effect.Effect<A, E>,
) => {
  const calls: Array<{ host: string; tool: string; arguments: Readonly<Record<string, unknown>> }> =
    [];
  const local = item("origin");
  const remoteCall = <T extends object, F>(
    input: Parameters<Hosts.HostThreadsMcpService["Service"]["readOnHost"]>[1],
    decode: (value: unknown) => Effect.Effect<T, F>,
  ) =>
    Effect.gen(function* () {
      options.beforeAuthorize?.(input.tool);
      if ("authorize" in input && Effect.isEffect(input.authorize)) yield* input.authorize;
      calls.push(input);
      const value = yield* (
        options.answer?.(input.host, input.tool, input.arguments) ??
          Effect.succeed(
            input.tool === "goat_decision_list"
              ? { items: [item(input.host)], unavailableHosts: [], truncated: false }
              : input.tool === "goat_decision_get"
                ? item(input.host)
                : { ...item(input.host), status: "answered", answer: "wait" },
          )
      );
      return { ...(yield* decode(value).pipe(Effect.mapError(() => denied()))), host: input.host };
    });
  const currentProfile =
    options.currentProfile ?? (() => options.profile ?? BUILTIN_PERMISSION_PROFILES.manager);
  const profileLayer = Layer.mock(Profiles.PermissionProfiles)({
    resolve: () =>
      Effect.sync(() => {
        const profile = currentProfile();
        return { enabled: true, profile, runtimeMode: profile.runtimeModeCeiling };
      }),
    check: (_scope, capability, context) =>
      Effect.sync(() => {
        const profile = currentProfile();
        return profile.capabilities.includes(capability) &&
          (profile.hosts === undefined || profile.hosts.includes(context?.host ?? ""))
          ? {
              ok: true as const,
              effective: { enabled: true, profile, runtimeMode: profile.runtimeModeCeiling },
            }
          : { ok: false as const, reason: "Remote capability denied" };
      }),
  });
  const dependencies = Layer.mergeAll(
    Layer.mock(Inbox.DecisionInbox)({
      list: () => Effect.succeed({ items: [local] }),
      get: () => Effect.succeed(local),
      answer: () => Effect.succeed({ ...local, status: "answered", answer: "wait" }),
    }),
    Layer.mock(Hosts.HostThreadsMcpService)({
      readOnHost: (_scope, input, decode) => remoteCall(input, decode),
      writeOnHost: (_scope, input, decode) => remoteCall(input, decode),
    }),
    Layer.mock(Dispatch.SshRemoteDispatch)({
      connectedHosts: Effect.succeed(options.aliases ?? ["alpha", "beta"]),
    }),
    profileLayer,
    Settings.layerTest({ goatclaw: { enabled: true } }),
    liveThreadsLayer,
    Layer.succeed(Invocation.McpInvocationContext, options.caller ?? scope),
  );
  const layer = Access.HandlersLayer.layer(Handlers.layer).pipe(Layer.provideMerge(dependencies));
  return Effect.gen(function* () {
    const toolkit = yield* DecisionToolkit;
    const result = yield* body(toolkit);
    return { result, calls };
  }).pipe(Effect.provide(layer));
};

it.effect(
  "baseline-failing #1405: lists local and remote decisions from every origin launcher without id collisions",
  () =>
    Effect.gen(function* () {
      const { result, calls } = yield* run({}, (toolkit) =>
        toolkit.handle("goat_decision_list", {}).pipe(Stream.unwrap, Stream.runCollect),
      );
      expect(result.at(-1)?.result).toMatchObject({
        items: [
          expect.objectContaining({ from: { environmentId: "alpha", host: "alpha" } }),
          expect.objectContaining({ from: { environmentId: "beta", host: "beta" } }),
          expect.objectContaining({ from: { environmentId: "origin" } }),
        ],
        unavailableHosts: [],
        truncated: false,
      });
      expect(calls.map((call) => call.arguments)).toEqual(
        ["alpha", "beta"].map(() =>
          expect.objectContaining({
            launcherEnvironmentId: "origin",
            permissionProfileCeiling: BUILTIN_PERMISSION_PROFILES.manager,
          }),
        ),
      );
    }),
);
it.effect("baseline-failing #1405: explicit get and answer stay on the asking host", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run({}, (toolkit) =>
      Effect.gen(function* () {
        const read = yield* toolkit
          .handle("goat_decision_get", { id: "decision:collision", host: "beta" })
          .pipe(Stream.unwrap, Stream.runCollect);
        expect(read.at(-1)?.result).toMatchObject({
          from: { environmentId: "beta", host: "beta" },
        });
        return yield* toolkit
          .handle("goat_decision_answer", {
            id: "decision:collision",
            host: "beta",
            optionId: "wait",
            reason: "Wait here",
          })
          .pipe(Stream.unwrap, Stream.runCollect);
      }),
    );
    expect(result.at(-1)?.result).toMatchObject({
      status: "answered",
      from: { environmentId: "beta", host: "beta" },
    });
    expect(calls.filter((call) => call.tool === "goat_decision_answer")).toEqual([
      expect.objectContaining({
        host: "beta",
        arguments: expect.not.objectContaining({ host: expect.anything() }),
      }),
    ]);
  }),
);
it.effect(
  "baseline-failing #1405: read-only discovery keeps local items and reports every denied host",
  () =>
    Effect.gen(function* () {
      const { result, calls } = yield* run(
        { caller: { ...scope, client: { ...scope.client!, access: "read-only" } } },
        (toolkit) =>
          toolkit.handle("goat_decision_list", {}).pipe(Stream.unwrap, Stream.runCollect),
      );
      expect(result.at(-1)?.result).toMatchObject({
        items: [expect.objectContaining({ from: { environmentId: "origin" } })],
        unavailableHosts: [
          { host: "alpha", code: "capability_denied", message: expect.any(String) },
          { host: "beta", code: "capability_denied", message: expect.any(String) },
        ],
      });
      expect(calls).toEqual([]);
    }),
);
it.effect(
  "baseline-failing #1405: an allowed host without threads.remote never receives a call",
  () =>
    Effect.gen(function* () {
      const profile = {
        ...BUILTIN_PERMISSION_PROFILES.manager,
        hosts: ["alpha"],
        capabilities: BUILTIN_PERMISSION_PROFILES.manager.capabilities.filter(
          (c) => c !== "threads.remote",
        ),
      };
      const { result, calls } = yield* run({ profile, aliases: ["alpha"] }, (toolkit) =>
        toolkit.handle("goat_decision_list", {}).pipe(Stream.unwrap, Stream.runCollect),
      );
      expect(result.at(-1)?.result).toMatchObject({
        unavailableHosts: [{ host: "alpha", code: "capability_denied" }],
      });
      expect(calls).toEqual([]);
    }),
);
it.effect(
  "baseline-failing #1405: old and foreign pages are unavailable with no unfiltered retry",
  () =>
    Effect.gen(function* () {
      const { result, calls } = yield* run(
        {
          answer: (host) =>
            Effect.succeed(
              host === "alpha"
                ? { items: [item("alpha")] }
                : {
                    items: [{ ...item("beta"), from: { environmentId: "beta", host: "third" } }],
                    truncated: false,
                    unavailableHosts: [],
                  },
            ),
        },
        (toolkit) =>
          toolkit.handle("goat_decision_list", {}).pipe(Stream.unwrap, Stream.runCollect),
      );
      expect(result.at(-1)?.result).toMatchObject({
        items: [expect.objectContaining({ from: { environmentId: "origin" } })],
        unavailableHosts: [
          expect.objectContaining({ host: "alpha", message: expect.stringMatching(/update/i) }),
          expect.objectContaining({ host: "beta" }),
        ],
      });
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => call.arguments.launcherEnvironmentId === "origin")).toBe(true);
    }),
);
it.effect("preservation #1405: explicit remote writes refuse read-only clients", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* run(
      { caller: { ...scope, client: { ...scope.client!, access: "read-only" } } },
      (toolkit) =>
        toolkit
          .handle("goat_decision_answer", {
            id: "decision:collision",
            optionId: "wait",
            reason: "Wait",
          })
          .pipe(Stream.unwrap, Stream.runCollect),
    );
    expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

it.effect(
  "baseline-failing #1405: narrowing hosts or threads.remote during preparation stops remote reads",
  () =>
    Effect.gen(function* () {
      for (const narrowed of [
        { ...BUILTIN_PERMISSION_PROFILES.manager, hosts: [] },
        {
          ...BUILTIN_PERMISSION_PROFILES.manager,
          capabilities: BUILTIN_PERMISSION_PROFILES.manager.capabilities.filter(
            (c) => c !== "threads.remote",
          ),
        },
      ]) {
        let live = BUILTIN_PERMISSION_PROFILES.manager;
        const { result, calls } = yield* run(
          {
            aliases: ["alpha"],
            currentProfile: () => live,
            beforeAuthorize: () => {
              live = narrowed;
            },
          },
          (toolkit) =>
            toolkit.handle("goat_decision_list", {}).pipe(Stream.unwrap, Stream.runCollect),
        );
        expect(result.at(-1)?.result).toMatchObject({
          unavailableHosts: [{ host: "alpha", code: "capability_denied" }],
        });
        expect(calls).toEqual([]);
      }
    }),
);
it.effect(
  "baseline-failing #1405: remote reads reauthorize operate as well as read after preparation",
  () =>
    Effect.gen(function* () {
      let revoked = false;
      const caller = {
        ...scope,
        reauthorize: (required: ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>) =>
          revoked && required.includes("orchestration:operate")
            ? Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "operate revoked",
                  requiredScope: "orchestration:operate",
                }),
              )
            : Effect.void,
      };
      const { result, calls } = yield* run(
        {
          caller,
          aliases: ["alpha"],
          beforeAuthorize: () => {
            revoked = true;
          },
        },
        (toolkit) =>
          toolkit.handle("goat_decision_list", {}).pipe(Stream.unwrap, Stream.runCollect),
      );
      expect(result.at(-1)?.result).toMatchObject({
        unavailableHosts: [{ host: "alpha", code: "capability_denied" }],
      });
      expect(calls).toEqual([]);
    }),
);

it.effect(
  "baseline-failing #1405: approve revoked before answer dispatch leaves the remote approval untouched",
  () =>
    Effect.gen(function* () {
      let revoked = false;
      const caller = {
        ...scope,
        client: { ...scope.client!, approvals: true },
        reauthorize: (required: ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>) =>
          revoked && required.includes("orchestration:approve")
            ? Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "approve revoked",
                  requiredScope: "orchestration:approve",
                }),
              )
            : Effect.void,
      };
      const approval = {
        ...item("alpha", "pending:thread:request"),
        source: "pending_request" as const,
        humanRequired: true,
        requiredProfile: "owner",
        pending: {
          threadId: "thread",
          requestId: "request",
          questions: [],
          approval: { kind: "command" },
        },
      };
      const { result, calls } = yield* run(
        {
          caller,
          beforeAuthorize: (tool) => {
            if (tool === "goat_decision_answer") revoked = true;
          },
          answer: () => Effect.succeed(approval),
        },
        (toolkit) =>
          toolkit
            .handle("goat_decision_answer", {
              id: approval.id,
              host: "alpha",
              decision: "accept",
              reason: "Approve",
            })
            .pipe(Stream.unwrap, Stream.runCollect),
      );
      expect(result.at(-1)?.result).toMatchObject({ code: "capability_denied" });
      expect(calls.filter((call) => call.tool === "goat_decision_answer")).toEqual([]);
    }),
);
