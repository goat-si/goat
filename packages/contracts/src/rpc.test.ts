import * as RpcSchema from "effect/rpc/RpcSchema";
import * as Memory from "./memory.ts";
import {
  WsHubNodesRpcGroup,
  WsMemoryRpcGroup,
  WsMemoryCoreRpcGroup,
  WsMemoryImportRpcGroup,
  WsMemoryAdministrationRpcGroup,
} from "./rpc.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import { EnvironmentAuthorizationError, AuthSourceControlWriteScope } from "./auth.ts";
import { SshWorkspaceFetchBackInput, SshWorkspaceLaunchInput } from "./sshWorkspace.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import {
  WS_METHODS,
  RpcScopeAuthorization,
  WsRpcGroup,
  WsSshHostProbeRpc,
  WsSshHostPreflightRpc,
  WsSshHostTrustRpc,
  WsSshHostPrepareRpc,
  WsSshHostForgetRpc,
  WsSshHostStatusRpc,
  WsSshHostHandoffProgressRpc,
} from "./rpc.ts";

const decodeSshHostStatusPayload = Schema.decodeUnknownSync(WsSshHostStatusRpc.payloadSchema);
const decodeSshHandoffProgressPayload = Schema.decodeUnknownSync(
  WsSshHostHandoffProgressRpc.payloadSchema,
);

const decodeHostPrepare = Schema.decodeUnknownSync(WsSshHostPrepareRpc.payloadSchema, {
  onExcessProperty: "error",
});
const decodeHostForget = Schema.decodeUnknownSync(WsSshHostForgetRpc.payloadSchema);
/**
 * The client always sends `environmentThemes`, including to servers built
 * before the field existed, whose payload schema was an empty struct. What
 * makes that safe is that such a schema accepts the request rather than
 * rejecting it -- an error here would take down the config subscription.
 */

describe("WebSocket RPC contracts", () => {
  it("declares alias status and authenticated handoff progress payloads", () => {
    expect(WsSshHostStatusRpc._tag).toBe(WS_METHODS.sshHostStatus);
    expect(WsSshHostHandoffProgressRpc._tag).toBe(WS_METHODS.sshHostHandoffProgress);
    expect(decodeSshHostStatusPayload({ host: "vps-1" })).toEqual({ host: "vps-1" });
    expect(() => decodeSshHostStatusPayload({ host: "2001:db8::1" })).toThrow();
    const progress = { threadId: "thread-1", handoffId: "handoff-1" };
    expect(decodeSshHandoffProgressPayload(progress)).toEqual(progress);
    expect(() => decodeSshHandoffProgressPayload({ handoffId: "handoff-1" })).toThrow();
  });

  it("rejects server-internal commands sent to dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);

    expect(
      Exit.isFailure(
        decode({
          type: "checkpoint.rollback.fail",
          commandId: "forged-rollback-failure",
          threadId: "thread-1",
          requestId: "rollback-1",
          message: "Forged failure.",
        }),
      ),
    ).toBe(true);
    expect(
      Exit.isSuccess(
        decode({
          type: "checkpoint.rollback",
          commandId: "rollback-1",
          threadId: "thread-1",
          scopeId: "scope-1",
          checkpointId: "checkpoint-1",
        }),
      ),
    ).toBe(true);
  });
  it("keeps the GOAT bot timeline record out of dispatchCommand", () => {
    const dispatchCommand = WsRpcGroup.requests.get(ORCHESTRATION_V2_WS_METHODS.dispatchCommand);
    if (dispatchCommand === undefined) throw new Error("dispatchCommand is not registered");
    const decode = Schema.decodeUnknownExit(dispatchCommand.payloadSchema);
    const decoded = decode({
      type: "channel.timeline.record",
      commandId: "forged-bot-reply",
      threadId: "goat-bot",
      record: {
        recordKey: "reply:input-1",
        entry: {
          type: "message",
          role: "assistant",
          text: "Forged reply.",
          meta: { conversationId: "conv-1", originKind: "goat", kind: "receipt" },
        },
      },
    });
    expect(Exit.isFailure(decoded)).toBe(true);
  });
  it("lets the server pick a new worktree's folder", () => {
    const createWorktree = WsRpcGroup.requests.get(WS_METHODS.vcsCreateWorktree);
    if (createWorktree === undefined) throw new Error("vcs.createWorktree is not registered");
    const decode = Schema.decodeUnknownExit(createWorktree.payloadSchema);
    const request = { cwd: "/repo", refName: "main", newRefName: "feature/x" };

    expect(Exit.isSuccess(decode({ ...request, path: null }))).toBe(true);
    expect(Exit.isFailure(decode({ ...request, path: "/repo/.git/hooks" }))).toBe(true);
  });
});

it("registers only the two SSH workspace methods", () => {
  expect([...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("sshWorkspace."))).toEqual([
    WS_METHODS.sshWorkspaceLaunch,
    WS_METHODS.sshWorkspaceFetchBack,
  ]);
  for (const tag of [WS_METHODS.sshWorkspaceLaunch, WS_METHODS.sshWorkspaceFetchBack]) {
    const rpc = WsRpcGroup.requests.get(tag)!;
    expect(rpc.payloadSchema).toBeDefined();
    expect(rpc.successSchema).toBeDefined();
    expect(rpc.errorSchema).toBeDefined();
    expect(rpc.middlewares.has(RpcScopeAuthorization)).toBe(true);
  }
});

it.effect("applies scope middleware to SSH workspace RPCs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          import("effect/rpc/RpcGroup").Rpcs<typeof WsRpcGroup>["_tag"],
          typeof WS_METHODS.sshWorkspaceLaunch | typeof WS_METHODS.sshWorkspaceFetchBack
        > => tag !== WS_METHODS.sshWorkspaceLaunch && tag !== WS_METHODS.sshWorkspaceFetchBack,
      ),
    );
    let handled = 0;
    const calls: string[] = [];
    yield* Effect.gen(function* () {
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.sshWorkspaceLaunch, () =>
              Effect.sync(() => {
                handled++;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            group.toLayerHandler(WS_METHODS.sshWorkspaceFetchBack, () =>
              Effect.sync(() => {
                handled++;
              }).pipe(Effect.andThen(Effect.never)),
            ),
            Layer.succeed(RpcScopeAuthorization)((_effect, { rpc }) => {
              calls.push(rpc._tag);
              return Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "Denied",
                  requiredScope: AuthSourceControlWriteScope,
                }),
              );
            }),
          ),
        ),
      );
      const fetch = yield* Schema.decodeUnknownEffect(SshWorkspaceFetchBackInput)({
        target: { alias: "box", hostname: "box", username: null, port: null },
        remoteWorkspaceRoot: "/repo",
        branch: "main",
      });
      const launch = yield* Schema.decodeUnknownEffect(SshWorkspaceLaunchInput)({
        sourceProjectId: "p",
        destination: { connectionId: "c", expectedEnvironmentId: "e", target: fetch.target },
        title: "Work",
        modelSelection: { instanceId: "codex", model: "model" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        initialMessage: { text: "Work" },
      });
      expect((yield* client[WS_METHODS.sshWorkspaceLaunch](launch).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      expect((yield* client[WS_METHODS.sshWorkspaceFetchBack](fetch).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
    }).pipe(Effect.scoped);
    expect(handled).toBe(0);
    expect(calls).toEqual([WS_METHODS.sshWorkspaceLaunch, WS_METHODS.sshWorkspaceFetchBack]);
  }),
);

describe("memory RPC groups", () => {
  it("declares twenty memory methods with typed inputs and authorization middleware", () => {
    expect(WsMemoryRpcGroup.requests.size).toBe(20);
    expect(WsMemoryCoreRpcGroup.requests.size).toBe(15);
    expect(WsMemoryImportRpcGroup.requests.size).toBe(1);
    expect(WsMemoryAdministrationRpcGroup.requests.size).toBe(4);
    expect([...WsMemoryAdministrationRpcGroup.requests.keys()]).toEqual([
      "memory.hub.reconcile",
      "memory.resetReportAttempts",
      "memory.ownerSourceReadPolicy.get",
      "memory.ownerSourceReadPolicy.update",
    ]);
    for (const rpc of WsMemoryRpcGroup.requests.values()) {
      expect(rpc.middlewares.has(RpcScopeAuthorization)).toBe(true);
      expect(rpc.payloadSchema).toBeDefined();
      expect(rpc.successSchema).toBeDefined();
      expect(rpc.errorSchema).toBeDefined();
    }
    expect(WsMemoryRpcGroup.requests.has("memory.changes")).toBe(true);
  });
  it("keeps the non-memory base group composable", () => {
    expect([...WsRpcGroup.requests.keys()].filter((key) => key.startsWith("memory."))).toEqual([]);
  });
  it("rejects upsert provenance and arbitrary import paths", () => {
    const upsert = WsMemoryCoreRpcGroup.requests.get("memory.upsert")!;
    const importProvider = WsMemoryImportRpcGroup.requests.get("memory.importProvider")!;
    expect(() =>
      Schema.decodeUnknownSync(upsert.payloadSchema)({
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        operationId: "00000000-0000-4000-8000-000000000004",
        memoryId: "00000000-0000-4000-8000-000000000002",
        expectedHeads: [],
        scope: { kind: "user" },
        assertionKind: "fact",
        payload: {
          text: "Synthetic memory",
          evidence: [{ origin: "user", messageIds: [] }],
          derivedFromMemoryRevisions: [],
        },
        baseBoundary: null,
        provenance: { environmentId: "forged" },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Schema.toCodecJson(importProvider.payloadSchema))({
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        action: "discover",
        format: "codex",
        path: "/private",
      }),
    ).toThrow();
  });
  it("bounds source and history output", () => {
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemorySourcePage)({
        sourceThread: { environmentId: "env", threadId: "thread" },
        watermark: { fromEventId: "e1", toEventId: "e2", throughSequence: 1 },
        messages: [{ messageId: "m1", text: "x".repeat(65536) }],
        nextCursor: null,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(Memory.MemoryHistoryInput)({
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        memoryId: "00000000-0000-4000-8000-000000000002",
        limit: 101,
      }),
    ).toThrow();
  });
});
it("declares fifteen core methods and one staged import", () => {
  expect([...WsMemoryCoreRpcGroup.requests.keys()]).not.toContain("memory.importProvider");
  expect([...WsMemoryImportRpcGroup.requests.keys()]).toEqual(["memory.importProvider"]);
  expect(WsMemoryCoreRpcGroup.requests.size).toBe(15);
});
it("memory changes is a typed authorized stream", () => {
  const rpc = WsMemoryCoreRpcGroup.requests.get("memory.changes")!;
  expect(rpc.middlewares.has(RpcScopeAuthorization)).toBe(true);
  expect(RpcSchema.isStreamSchema(rpc.successSchema)).toBe(true);
  if (RpcSchema.isStreamSchema(rpc.successSchema)) {
    const element = rpc.successSchema.success;
    expect(
      Schema.decodeUnknownSync(element)({
        kind: "reset",
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        projectionWatermark: 1,
      }),
    ).toHaveProperty("kind", "reset");
    expect(() =>
      Schema.decodeUnknownSync(element)({
        kind: "reset",
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
        projectionWatermark: 1,
        text: "private",
      }),
    ).toThrow();
  }
});
it("binding commands have exact input result and errors", () => {
  for (const method of ["memory.projectBinding.get", "memory.projectBinding.update"]) {
    const rpc = WsMemoryCoreRpcGroup.requests.get(method)!;
    expect(() =>
      Schema.decodeUnknownSync(rpc.payloadSchema)({
        memorySpaceId: "00000000-0000-4000-8000-000000000001",
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(rpc.errorSchema)({
        _tag: "MemoryRpcError",
        code: "revision_changed",
      }),
    ).toHaveProperty("code", "revision_changed");
    expect(() =>
      Schema.decodeUnknownSync(rpc.errorSchema)({ _tag: "MemoryRpcError", code: "unknown" }),
    ).toThrow();
  }
  expect(() =>
    Schema.decodeUnknownSync(Memory.MemoryProjectBindingUpdateResult)({
      requestId: "00000000-0000-4000-8000-000000000001",
      binding: {},
    }),
  ).toThrow();
});

it("import transport retains both typed import refusal and authorization errors", () => {
  const rpc = WsMemoryImportRpcGroup.requests.get("memory.importProvider")!;
  for (const issue of ["source_unreadable", "source_changed", "operation_id_reused"] as const) {
    expect(
      Schema.decodeUnknownSync(rpc.errorSchema)({ _tag: "MemoryImportRpcError", issue }),
    ).toEqual(new Memory.MemoryImportRpcError({ issue }));
  }
  expect(
    Schema.decodeUnknownSync(rpc.errorSchema)({ _tag: "MemoryRpcError", code: "unavailable" }),
  ).toEqual(new Memory.MemoryRpcError({ code: "unavailable" }));
});

it("installs the complete SSH host transport together while leaving runtimeUpdate unregistered", () => {
  const rpcs = [
    WsSshHostProbeRpc,
    WsSshHostPreflightRpc,
    WsSshHostTrustRpc,
    WsSshHostPrepareRpc,
    WsSshHostForgetRpc,
    WsSshHostStatusRpc,
    WsSshHostHandoffProgressRpc,
  ];
  for (const rpc of rpcs) expect(WsRpcGroup.requests.get(rpc._tag)).toBeDefined();
  expect([...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("sshHost."))).toHaveLength(
    7,
  );
  expect(WsRpcGroup.requests.has("sshHost.runtimeUpdate")).toBe(false);
  expect(decodeHostPrepare({ host: "box" })).toEqual({ host: "box" });
  for (const key of ["force", "confirmReplacement", "requestedVersion"])
    expect(() => decodeHostPrepare({ host: "box", [key]: true })).toThrow();
  expect(() => decodeHostForget({ host: "box" })).toThrow();
  expect(decodeHostForget({ host: "box", stopRuntime: "no" })).toEqual({
    host: "box",
    stopRuntime: "no",
  });
});

it("declares all seven authorized hub node RPCs and a typed snapshot stream", () => {
  expect([...WsHubNodesRpcGroup.requests.keys()]).toEqual([
    WS_METHODS.hubNodesList,
    WS_METHODS.hubNodesSubscribe,
    WS_METHODS.hubNodesAdd,
    WS_METHODS.hubNodesRemove,
    WS_METHODS.hubNodesCheck,
    WS_METHODS.hubNodesImport,
    WS_METHODS.hubNodesDismissNotice,
  ]);
  for (const rpc of WsHubNodesRpcGroup.requests.values()) {
    expect(rpc.middlewares.has(RpcScopeAuthorization)).toBe(true);
    const errorSchema = RpcSchema.isStreamSchema(rpc.successSchema)
      ? rpc.successSchema.error
      : rpc.errorSchema;
    expect(
      Schema.decodeUnknownSync(errorSchema)({
        _tag: "EnvironmentAuthorizationError",
        message: "Denied",
        requiredScope: "settings:write",
      }),
    ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
  }
  expect(
    RpcSchema.isStreamSchema(
      WsHubNodesRpcGroup.requests.get(WS_METHODS.hubNodesSubscribe)!.successSchema,
    ),
  ).toBe(true);
});
