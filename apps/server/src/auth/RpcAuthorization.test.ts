import { describe, expect, it } from "@effect/vitest";
import {
  AuthDiagnosticsReadScope,
  AuthEnvironmentMaintainScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  CLIENT_GUARDED_RPC_SCOPES,
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  SshWorkspaceLaunchInput,
  ThreadId,
  WS_METHODS,
  WsNotesRpcGroup,
  type EnvironmentAuthorizationError,
  type NoteConflictError,
  type NoteError,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import {
  RPC_REQUIRED_SCOPES as BASE_RPC_REQUIRED_SCOPES,
  HUB_NODES_RPC_REQUIRED_SCOPES,
  MEMORY_RPC_REQUIRED_SCOPES,
  AuthorizedWsRpcGroup as WsRpcGroup,
  requiredScopeForDeviceList,
  requiredScopeForRpcMethod,
} from "./RpcAuthorization.ts";

const RPC_REQUIRED_SCOPES = {
  ...BASE_RPC_REQUIRED_SCOPES,
  ...MEMORY_RPC_REQUIRED_SCOPES,
  ...HUB_NODES_RPC_REQUIRED_SCOPES,
};

describe("RPC authorization scopes", () => {
  it.effect("accepts only the owning desktop with settings write scope as a catalog host", () =>
    Effect.gen(function* () {
      for (const method of [
        WS_METHODS.connectionCatalogServe,
        WS_METHODS.connectionCatalogRespond,
      ]) {
        expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
      }
      const otherSubject = yield* Effect.flip(
        RpcAuthorization.requireConnectionCatalogHost({
          subject: "cli-issued-session",
          scopes: [AuthSettingsWriteScope],
        }),
      );
      expect(otherSubject._tag).toBe("EnvironmentAuthorizationError");
      expect(otherSubject.requiredScope).toBe(AuthSettingsWriteScope);
      expect(otherSubject.message).toContain("desktop bootstrap");
      const missingScope = yield* Effect.flip(
        RpcAuthorization.requireConnectionCatalogHost({
          subject: "desktop-bootstrap",
          scopes: [],
        }),
      );
      expect(missingScope.requiredScope).toBe(AuthSettingsWriteScope);
      yield* RpcAuthorization.requireConnectionCatalogHost({
        subject: "desktop-bootstrap",
        scopes: [AuthSettingsWriteScope],
      });
    }),
  );

  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps hub node scopes equal to client guards", () => {
    for (const [method, scope] of Object.entries(HUB_NODES_RPC_REQUIRED_SCOPES)) {
      expect(CLIENT_GUARDED_RPC_SCOPES[method as keyof typeof HUB_NODES_RPC_REQUIRED_SCOPES]).toBe(
        scope,
      );
      expect(requiredScopeForRpcMethod(method)).toBe(scope);
    }
  });

  // Boat machines bill the owner's account, so only a settings writer may change or wake them.
  it("lets readers list cloud machines and only settings writers change them", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.cloudMachinesList)).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      WS_METHODS.cloudMachinesConfigure,
      WS_METHODS.cloudMachinesDisconnect,
      WS_METHODS.cloudMachinesCreate,
      WS_METHODS.cloudMachinesStop,
      WS_METHODS.cloudMachinesResume,
      WS_METHODS.cloudMachinesDelete,
      WS_METHODS.cloudMachinesForget,
      WS_METHODS.cloudMachinesDismissUnconfirmed,
      WS_METHODS.cloudMachinesEnsureReady,
    ])
      expect(requiredScopeForRpcMethod(method), method).toBe(AuthSettingsWriteScope);
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("reads host status with read scope, like host resources", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverGetHostStatus)).toBe(
      AuthOrchestrationReadScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [
      WS_METHODS.terminalObserve,
      WS_METHODS.subscribeTerminalEvents,
      WS_METHODS.subscribeTerminalMetadata,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalRestart,
      WS_METHODS.terminalClose,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

const sshGroup = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<
      keyof typeof RPC_REQUIRED_SCOPES,
      typeof WS_METHODS.sshWorkspaceLaunch | typeof WS_METHODS.sshWorkspaceFetchBack
    > => tag !== WS_METHODS.sshWorkspaceLaunch && tag !== WS_METHODS.sshWorkspaceFetchBack,
  ),
);
const sshLaunchInput = Schema.decodeUnknownSync(SshWorkspaceLaunchInput)({
  sourceProjectId: "source",
  destination: {
    connectionId: "saved",
    expectedEnvironmentId: "remote",
    target: { alias: "box", hostname: "box", username: null, port: null },
  },
  title: "Work",
  modelSelection: { instanceId: "codex", model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  initialMessage: { text: "Implement" },
});
const sshFetchInput = {
  target: sshLaunchInput.destination.target,
  remoteWorkspaceRoot: "/home/test/.goat/repos/repo-12345678",
  branch: "feature/result",
};
it.effect.each(
  (
    [
      [
        "SSH launch rejects missing source-control write before handler",
        WS_METHODS.sshWorkspaceLaunch,
        [AuthOrchestrationOperateScope],
        AuthSourceControlWriteScope,
      ],
      [
        "SSH launch rejects missing orchestration operate before handler",
        WS_METHODS.sshWorkspaceLaunch,
        [AuthSourceControlWriteScope],
        AuthOrchestrationOperateScope,
      ],
      [
        "SSH fetchBack rejects read-only grant before handler",
        WS_METHODS.sshWorkspaceFetchBack,
        [],
        AuthSourceControlWriteScope,
      ],
    ] as const
  ).map(([name, method, scopes, required]) => [name, [name, method, scopes, required]] as const),
)("%s", ([_name, [_caseName, method, scopes, required]]) =>
  Effect.gen(function* () {
    let handled = 0;
    const client = yield* RpcTest.makeClient(sshGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          sshGroup.toLayerHandler(WS_METHODS.sshWorkspaceLaunch, () =>
            Effect.sync(() => {
              handled++;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          sshGroup.toLayerHandler(WS_METHODS.sshWorkspaceFetchBack, () =>
            Effect.sync(() => {
              handled++;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer(scopes),
        ),
      ),
    );
    const error =
      method === WS_METHODS.sshWorkspaceLaunch
        ? yield* client[method](sshLaunchInput).pipe(Effect.flip)
        : yield* client[method](sshFetchInput).pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: required,
    });
    expect(handled).toBe(0);
  }).pipe(Effect.scoped),
);
it.effect("SSH fetchBack permits source-control write without orchestration operate", () =>
  Effect.gen(function* () {
    let handled = 0;
    const output = {
      sourceProjectId: sshLaunchInput.sourceProjectId,
      localWorkspaceRoot: "/repo",
      localRef: "refs/remotes/goat-ssh/box/feature/result",
      commitOid: "a".repeat(40),
      remoteBranch: sshFetchInput.branch,
    };
    const client = yield* RpcTest.makeClient(sshGroup).pipe(
      Effect.provide(
        Layer.mergeAll(
          sshGroup.toLayerHandler(WS_METHODS.sshWorkspaceLaunch, () => Effect.never),
          sshGroup.toLayerHandler(WS_METHODS.sshWorkspaceFetchBack, () =>
            Effect.sync(() => {
              handled++;
              return output;
            }),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.sshWorkspaceFetchBack](sshFetchInput)).toEqual(output);
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "guards all installed memory routes, including compound source and settings-only owner administration",
  () =>
    Effect.gen(function* () {
      const reads = [
        WS_METHODS.memorySearch,
        WS_METHODS.memoryList,
        WS_METHODS.memoryRead,
        WS_METHODS.memoryHistory,
        WS_METHODS.memoryChanges,
        WS_METHODS.memorySyncStatus,
        WS_METHODS.memoryHubDiagnostics,
      ];
      const writes = [
        WS_METHODS.memoryUpsert,
        WS_METHODS.memoryForget,
        WS_METHODS.memoryRevertResolution,
        WS_METHODS.memoryProjectBindingGet,
        WS_METHODS.memoryProjectBindingUpdate,
      ];
      const settings = [
        WS_METHODS.memoryHubSettingsGet,
        WS_METHODS.memoryHubSettingsUpdate,
        WS_METHODS.memoryResetReportAttempts,
        WS_METHODS.memoryHubReconcile,
        WS_METHODS.memoryOwnerSourceReadPolicyGet,
        WS_METHODS.memoryOwnerSourceReadPolicyUpdate,
      ];
      const cases = [
        {
          method: WS_METHODS.memoryImportProvider,
          scopes: ["memory:write", "filesystem:read"] as const,
        },
        ...reads.map((method) => ({ method, scopes: ["memory:read"] as const })),
        ...writes.map((method) => ({ method, scopes: ["memory:write"] as const })),
        ...settings.map((method) => ({ method, scopes: ["settings:write"] as const })),
        {
          method: WS_METHODS.memoryReadSource,
          scopes: ["memory:read", "orchestration:read"] as const,
        },
      ];
      expect(new Set(cases.map((c) => c.method))).toEqual(
        new Set([...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("memory."))),
      );
      expect(WsRpcGroup.requests.has(WS_METHODS.memoryImportProvider)).toBe(true);
      for (const { method, scopes } of cases) {
        let calls = 0;
        const invoke = (grants: ReadonlyArray<import("@goat/contracts").AuthEnvironmentScope>) =>
          RpcAuthorization.authorizeRpcCall(grants, method, {}).pipe(
            Effect.andThen(
              Effect.sync(() => {
                calls++;
              }),
            ),
          );
        expect((yield* Effect.flip(invoke([])))._tag).toBe("EnvironmentAuthorizationError");
        expect(calls).toBe(0);
        yield* invoke(scopes);
        expect(calls).toBe(1);
        for (const missing of scopes) {
          expect(
            (yield* Effect.flip(invoke(scopes.filter((scope) => scope !== missing))))
              .requiredPermission,
          ).toBe(missing);
          expect(calls).toBe(1);
        }
        if (settings.includes(method as (typeof settings)[number])) {
          expect(
            (yield* Effect.flip(
              invoke(["memory:read", "memory:write", "orchestration:read", "providers:manage"]),
            )).requiredPermission,
          ).toBe("settings:write");
        }
      }
    }).pipe(Effect.scoped),
);

it.each([
  [WS_METHODS.sshHostStatus, AuthOrchestrationReadScope],
  [WS_METHODS.sshHostHandoffProgress, AuthOrchestrationReadScope],
  [WS_METHODS.sshHostProbe, AuthSettingsWriteScope],
  [WS_METHODS.sshHostTrust, AuthSettingsWriteScope],
  [WS_METHODS.sshHostPrepare, AuthEnvironmentMaintainScope],
  [WS_METHODS.sshHostForget, AuthSettingsWriteScope],
] as const)("registers %s with its destination authority", (method, scope) => {
  expect(WsRpcGroup.requests.has(method)).toBe(true);
  expect(requiredScopeForRpcMethod(method)).toBe(scope);
});

describe("notes permissions", () => {
  it("separates note observation from mutations", () => {
    for (const method of [
      WS_METHODS.notesList,
      WS_METHODS.notesRead,
      WS_METHODS.notesSubscribe,
      WS_METHODS.notesWorkTargets,
      WS_METHODS.notesWorkTargetProjects,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    for (const method of [
      WS_METHODS.notesWrite,
      WS_METHODS.notesMove,
      WS_METHODS.notesDelete,
      WS_METHODS.notesStartWork,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
  });
  it.effect("rejects every notes mutation before its handler on a read-only connection", () =>
    Effect.gen(function* () {
      let calls = 0;
      const group = WsNotesRpcGroup.omit(
        WS_METHODS.notesList,
        WS_METHODS.notesRead,
        WS_METHODS.notesSubscribe,
        WS_METHODS.notesWorkTargets,
        WS_METHODS.notesWorkTargetProjects,
      );
      const invoked = Effect.sync(() => {
        calls++;
      }).pipe(Effect.andThen(Effect.never));
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayer({
              [WS_METHODS.notesWrite]: () => invoked,
              [WS_METHODS.notesMove]: () => invoked,
              [WS_METHODS.notesDelete]: () => invoked,
              [WS_METHODS.notesStartWork]: () => invoked,
            }),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      const revision = "a".repeat(64);
      const denied: ReadonlyArray<
        Effect.Effect<void, NoteError | NoteConflictError | EnvironmentAuthorizationError>
      > = [
        client[WS_METHODS.notesWrite]({ path: "a.md", body: "changed", baseRevision: null }).pipe(
          Effect.asVoid,
        ),
        client[WS_METHODS.notesMove]({ from: "a.md", to: "b.md", baseRevision: revision }).pipe(
          Effect.asVoid,
        ),
        client[WS_METHODS.notesDelete]({ path: "a.md", baseRevision: revision }).pipe(
          Effect.asVoid,
        ),
        client[WS_METHODS.notesStartWork]({
          path: "a.md",
          requestId: "attempt",
          target: { type: "host", host: "host", projectPath: "/project" },
        }).pipe(Effect.asVoid),
      ];
      for (const request of denied)
        expect(yield* request.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthOrchestrationOperateScope,
        });
      expect(calls).toBe(0);
    }),
  );
});
