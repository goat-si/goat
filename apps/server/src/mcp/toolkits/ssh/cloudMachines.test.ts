import { expect, it } from "@effect/vitest";
import {
  CloudMachineError,
  type CloudMachineErrorReason,
  EnvironmentAuthorizationError,
} from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as CloudMachineService from "../../../cloudMachines/CloudMachineService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as PermissionSettings from "../../../serverSettings.ts";
import * as SshDeviceAdd from "../../../sshRemote/SshDeviceAdd.ts";
import * as SshHostSetup from "../../../sshRemote/SshHostSetup.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import * as SshWorkspaceSync from "../../../sshRemote/SshWorkspaceSync.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as RepositoryLaunchMcpService from "../../RepositoryLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import * as SshHandlers from "./handlers.ts";
import { profileLayer, scope, threadId } from "./handlers.testkit.ts";
import { SshToolkit } from "./tools.ts";

const cloudMachineView = {
  alias: "boat-bx_23456789",
  sandboxId: "bx_23456789",
  label: "Build box",
  provider: "boat",
  type: "small",
  ttlSeconds: 3600,
  presence: "present",
  state: "provisioning",
  deletePending: false,
  lastError: null,
} as const;

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "cloud-machine-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "cloud-machine-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

type CloudGrant = {
  readonly profile?: string;
  readonly tool?: "goat_cloud_machine_create" | "goat_cloud_machine_resume";
  readonly readOnly?: boolean;
  readonly grantedScopes?: ReadonlyArray<"settings:write" | "orchestration:read">;
  readonly reauthorize?: "ok" | "fail";
  readonly failure?: CloudMachineErrorReason;
};

/** A thread caller with the given settings grant, and what it asked Boat to create. */
const cloudCaller = (grant: CloudGrant) => {
  const created: Array<unknown> = [];
  const reauthorized: Array<ReadonlyArray<string>> = [];
  const invocation: McpInvocationContext.McpInvocationScope = {
    ...scope,
    ...(grant.profile === undefined
      ? {}
      : {
          thread: undefined,
          client: { sessionId: "profile-client", label: "test", access: "full-access" as const },
        }),
    ...(grant.readOnly === undefined ? {} : { readOnly: grant.readOnly }),
    ...(grant.grantedScopes === undefined ? {} : { grantedScopes: grant.grantedScopes }),
    ...(grant.reauthorize === undefined
      ? {}
      : {
          reauthorize: (required) =>
            Effect.sync(() => void reauthorized.push(required)).pipe(
              Effect.andThen(
                grant.reauthorize === "ok"
                  ? Effect.void
                  : Effect.fail(
                      new EnvironmentAuthorizationError({
                        message: "revoked",
                        requiredScope: "settings:write",
                      }),
                    ),
              ),
            ),
        }),
  };
  const dependencies = Layer.mergeAll(
    profileLayer(grant.profile),
    PermissionSettings.layerTest(),
    NodeCrypto.layer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({}),
    Layer.mock(SshWorkspaceSync.SshWorkspaceSync)({}),
    Layer.mock(RepositoryReferenceMcpService.RepositoryReferenceMcpService)({}),
    Layer.mock(RepositoryLaunchMcpService.RepositoryLaunchMcpService)({}),
    Layer.mock(SshDeviceAdd.SshDeviceAdd)({}),
    Layer.mock(SshHostSetup.SshHostSetup)({}),
    Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({}),
    Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({}),
    Layer.mock(LaunchWatchService.LaunchWatchService)({}),
    Layer.mock(CloudMachineService.CloudMachineService)({
      create: (input) =>
        Effect.sync(() => void created.push(input)).pipe(
          Effect.andThen(
            grant.failure === undefined
              ? Effect.succeed(cloudMachineView)
              : Effect.fail(new CloudMachineError({ reason: grant.failure })),
          ),
        ),
      resume: (alias) =>
        Effect.sync(() => void created.push(alias)).pipe(Effect.as(cloudMachineView)),
    }),
  );
  return { invocation, dependencies, created, reauthorized };
};

/** Calls goat_cloud_machine_create as a thread caller with the given settings grant. */
const createCloudMachine = (grant: CloudGrant) =>
  Effect.gen(function* () {
    const { dependencies, created, reauthorized } = cloudCaller(grant);
    const toolkit = yield* SshToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(SshHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const responses = yield* toolkit
      .handle(
        grant.tool ?? "goat_cloud_machine_create",
        grant.tool === "goat_cloud_machine_resume"
          ? { alias: cloudMachineView.alias }
          : { label: "Build box", type: "small", ttlSeconds: 3600 },
      )
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return { response: responses.at(-1)?.result, created, reauthorized };
  });

it.effect("creates a cloud machine only for a caller whose settings grant is reconfirmed", () =>
  Effect.gen(function* () {
    const granted = yield* createCloudMachine({
      grantedScopes: ["settings:write"],
      reauthorize: "ok",
    });
    expect(granted.response).toMatchObject({ alias: "boat-bx_23456789" });
    expect(granted.created).toHaveLength(1);
    expect(granted.reauthorized).toEqual([["settings:write"]]);

    for (const grant of [
      { grantedScopes: ["orchestration:read"] as const, reauthorize: "ok" as const },
      { grantedScopes: ["settings:write"] as const },
      { grantedScopes: ["settings:write"] as const, reauthorize: "ok" as const, readOnly: true },
      { grantedScopes: ["settings:write"] as const, reauthorize: "fail" as const },
    ]) {
      const denied = yield* createCloudMachine(grant);
      expect(denied.response, JSON.stringify(grant)).toMatchObject({ code: "capability_denied" });
      expect(denied.created).toEqual([]);
    }
  }),
);

it.effect("keeps Boat's reason on a cloud machine failure beside its legacy code", () =>
  Effect.gen(function* () {
    const refused = yield* createCloudMachine({
      grantedScopes: ["settings:write"],
      reauthorize: "ok",
      failure: "billing_required",
    });
    expect(refused.response).toMatchObject({
      code: "orchestration_error",
      message: "Boat needs an active plan or payment for this.",
      reason: "billing_required",
    });
  }),
);

it.effect.each(["goat_cloud_machine_create", "goat_cloud_machine_resume"] as const)(
  "%s only starts Boat for owner",
  (tool) =>
    Effect.gen(function* () {
      const denied = yield* createCloudMachine({
        profile: "manager",
        tool,
        reauthorize: "ok",
        grantedScopes: ["settings:write"],
      });
      expect(denied.response).toMatchObject({ code: "capability_denied" });
      expect(denied.created).toHaveLength(0);
      const allowed = yield* createCloudMachine({
        profile: "owner",
        tool,
        reauthorize: "ok",
        grantedScopes: ["settings:write"],
      });
      expect(allowed.response).toHaveProperty("alias");
      expect(allowed.created).toHaveLength(1);
    }),
);

it.effect("creates one Boat machine when a create is retried with the same clientRequestId", () => {
  const caller = cloudCaller({ grantedScopes: ["settings:write"], reauthorize: "ok" });
  const create = (clientRequestId: string) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) =>
        server.callTool({
          name: "goat_cloud_machine_create",
          arguments: { label: "Build box", type: "small", ttlSeconds: 3600, clientRequestId },
        }),
      ),
      Effect.map(({ content }) => content.map((part) => (part.type === "text" ? part.text : ""))),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provideService(McpInvocationContext.McpInvocationContext, caller.invocation),
    );
  return Effect.gen(function* () {
    const first = yield* create("build-box-1");
    expect(yield* create("build-box-1")).toEqual(first);
    expect(caller.created).toHaveLength(1);
    // The key never reaches Boat's request; only a new key creates another machine.
    expect(caller.created[0]).not.toHaveProperty("clientRequestId");
    yield* create("build-box-2");
    expect(caller.created).toHaveLength(2);
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(SshToolkit, SshHandlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(caller.dependencies),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  );
});
