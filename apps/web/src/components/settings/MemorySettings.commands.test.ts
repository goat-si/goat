import { memoryImportTestLocks } from "../../test/memoryImportLocks";
import { expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  MemorySpaceId,
  MemoryOperationId,
  MemoryImportSourceId,
  WS_METHODS,
  type AuthSessionState,
  type AuthEnvironmentScope,
  type MemoryImportProviderInput,
  type MemoryImportProviderResult,
} from "@goat/contracts";
import { EnvironmentRegistry } from "@goat/client-runtime/connection";
import { createEnvironmentRpcCommand } from "@goat/client-runtime/state/runtime";
import { createMemoryImportWorkflow } from "@goat/client-runtime/memory-import-workflow";
import { memoryImportRecoveryStorage } from "../../lib/memoryImportRecoveryStorage";
import { memorySyncFixture } from "../../test/memorySyncFixture";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cause from "effect/Cause";
import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";

vi.mock("@goat/client-runtime/state/session", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grants }),
}));
const grants = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("remote-settings");
const space = MemorySpaceId.make("00000000-0000-4000-8000-000000000001");
function harness() {
  const registry = AtomRegistry.make();
  const destinations: EnvironmentId[] = [];
  // Only the transport is substituted: real commands, session atoms, admission and store remain.
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
      run: (id, effect) => {
        destinations.push(id);
        return effect;
      },
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
  );
  registry.mount(grants(env));
  const allow = (scopes: readonly AuthEnvironmentScope[]) =>
    registry.set(
      grants(env),
      AsyncResult.success({
        authenticated: true,
        scopes,
        permissions: scopes,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: [],
          sessionMethods: [],
          sessionCookieName: "synthetic",
        },
      }),
    );
  return { registry, runtime, allow, destinations };
}
it("executes the actual reset command with current settings grants and preserves server counts", async () => {
  const f = harness();
  const transport = vi.fn(() => Effect.succeed({ resetCount: 1, unchangedCount: 1 }));
  const command = createEnvironmentRpcCommand(f.runtime, {
    label: "reset-reports",
    tag: WS_METHODS.memoryResetReportAttempts,
    execute: transport,
  });
  const input = {
    environmentId: env,
    memorySpaceId: space,
    reportIds: ["a".repeat(64), "b".repeat(64)],
  };
  try {
    f.allow(["settings:write"]);
    expect(f.registry.get(command.permissionAtom(env))).toBe(true);
    expect(await command.run(f.registry, { environmentId: env, input })).toMatchObject({
      _tag: "Success",
      value: { resetCount: 1, unchangedCount: 1 },
    });
    f.allow([]);
    expect(f.registry.get(command.permissionAtom(env))).toBe(false);
    expect((await command.run(f.registry, { environmentId: env, input }))._tag).toBe("Failure");
    expect(transport).toHaveBeenCalledOnce();
    expect(f.destinations.every((id) => id === env)).toBe(true);
  } finally {
    vi.unstubAllGlobals();
    f.registry.dispose();
  }
});
it("runs browser recovery through the actual import command and refuses apply after file-read revoke", async () => {
  const f = harness();
  vi.stubGlobal("navigator", { locks: memoryImportTestLocks() });
  const values = new Map<string, string>();
  const recovery = memoryImportRecoveryStorage({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  });
  const sourceId = MemoryImportSourceId.make("00000000-0000-4000-8000-000000000003");
  const operationId = MemoryOperationId.make("00000000-0000-4000-8000-000000000004");
  const calls: MemoryImportProviderInput[] = [];
  const command = createEnvironmentRpcCommand(f.runtime, {
    label: "import-provider",
    tag: WS_METHODS.memoryImportProvider,
    execute: (input) => {
      calls.push(input);
      const result: MemoryImportProviderResult =
        input.action === "preview"
          ? {
              action: "preview",
              sourceId,
              sessionId: "synthetic",
              items: [
                {
                  sourceItemKey: "one",
                  sourceFingerprint: "a".repeat(64),
                  byteCount: 1,
                  mappingRequired: false,
                },
              ],
            }
          : input.action === "discover"
            ? { action: "discover", sources: [] }
            : {
                action: input.action,
                receipt: {
                  operationId: input.operationId,
                  sourceId,
                  sessionId: "synthetic",
                  sessionNewItems: 0,
                  sessionBodyBytes: 0,
                  state: "completed",
                  remaining: 0,
                  items: [],
                },
                syncStatus: memorySyncFixture,
              };
      return Effect.succeed(result);
    },
  });
  const create = () =>
    createMemoryImportWorkflow({
      fence: { environmentId: env, memorySpaceId: space, session: "new-mount" },
      recovery,
      operationId: () => operationId,
      canImport: () => f.registry.get(command.permissionAtom(env)),
      request: async (environmentId, input) => {
        const result = await command.run(f.registry, { environmentId, input });
        if (result._tag === "Failure") throw Cause.squash(result.cause);
        return result.value;
      },
    });
  try {
    f.allow(["memory:write", "filesystem:read"]);
    await recovery.save({ environmentId: env, memorySpaceId: space }, operationId);
    await create().recover();
    expect(calls.map((call) => call.action)).toEqual(["status"]);
    const workflow = create();
    await workflow.preview(sourceId);
    workflow.select([
      { sourceItemKey: "one", sourceFingerprint: "a".repeat(64), scope: { kind: "user" } },
    ]);
    f.allow(["memory:write"]);
    await workflow.apply();
    expect(calls.map((call) => call.action)).toEqual(["status", "preview"]);
    expect(workflow.getState().phase).toBe("partial");
  } finally {
    vi.unstubAllGlobals();
    f.registry.dispose();
  }
});
it("reconcile uses current settings grants and forwards the diagnostics version", async () => {
  const f = harness();
  const transport = vi.fn(
    (_input: {
      environmentId: EnvironmentId;
      memorySpaceId: MemorySpaceId;
      expectedVersion: number;
    }) => Effect.succeed({ version: 7, rearmedClasses: [] }),
  );
  const command = createEnvironmentRpcCommand(f.runtime, {
    label: "reconcile",
    tag: WS_METHODS.memoryHubReconcile,
    execute: transport,
  });
  const input = { environmentId: env, memorySpaceId: space, expectedVersion: 7 };
  try {
    f.allow(["memory:read"]);
    expect((await command.run(f.registry, { environmentId: env, input }))._tag).toBe("Failure");
    expect(transport).not.toHaveBeenCalled();
    f.allow(["settings:write"]);
    expect((await command.run(f.registry, { environmentId: env, input }))._tag).toBe("Success");
    expect(transport.mock.calls[0]?.[0]).toEqual(input);
    f.allow([]);
    expect((await command.run(f.registry, { environmentId: env, input }))._tag).toBe("Failure");
    expect(transport).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
    f.registry.dispose();
  }
});
