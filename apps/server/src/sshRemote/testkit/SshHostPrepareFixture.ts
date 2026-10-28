import { expect, vi } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the expected path mirrors the host's native join.
import * as NodePath from "node:path";
import * as HostKey from "@goat/ssh/hostKey";
import {
  EnvironmentAuthorizationError,
  ThreadId,
  ProviderInstanceId,
  type SshHostResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as Profiles from "../../goatclaw/PermissionProfiles.ts";
import * as Settings from "../../serverSettings.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../mcp/McpToolAccess.testkit.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as Setup from "../SshHostSetup.ts";
import * as Dispatch from "../SshRemoteDispatch.ts";
import { baseDependencies as dependencies } from "./SshHostSetupTestkit.ts";
import { stopped, invocation } from "./SshRuntimeUpdateFixture.ts";

export const preparationRefusals = [
  ["capability", "hub.manage"],
  ["remote-capability", "threads.remote"],
  ["ceiling", "limits this thread to auto"],
  ["host", "does not allow host box"],
  ["approval-required", "full-access"],
  ["auto", "full-access"],
  ["auto-accept-edits", "full-access"],
  ["plan", "default"],
  ["read-only", "read-only"],
  ["read-only-client", "read-only"],
  ["inactive", "active thread run"],
  ["deleted", "not found"],
  ["credential", "revoked"],
  ["disabled", "goatclaw"],
] as const;
type Reason =
  | (typeof preparationRefusals)[number][0]
  | "revoke"
  | "revoke-remote"
  | "revoke-credential";

export const preparePolicy = (reason?: Reason) =>
  Effect.gen(function* () {
    const database = yield* Layer.build(Sqlite.layerMemory);
    const settingsContext = yield* Layer.build(
      Settings.layerTest({
        goatclaw: {
          enabled: reason !== "disabled",
          defaultProfile: "owner",
        },
      }),
    );
    const settings = Context.get(settingsContext, Settings.ServerSettingsService);
    const policy = (yield* settings.getSettings).goatclaw;
    const owner = policy.profiles.owner;
    if (owner === undefined) return yield* Effect.die("Missing builtin owner profile");
    const revoked = reason === "revoke-remote" ? "threads.remote" : "hub.manage";
    const removeCapability = settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: {
          ...policy.profiles,
          owner: { ...owner, capabilities: owner.capabilities.filter((c) => c !== revoked) },
        },
      },
    });
    yield* settings.updateSettings({
      goatclaw: {
        ...policy,
        profiles: {
          ...policy.profiles,
          owner: {
            ...owner,
            hosts: [reason === "host" ? "other" : "box"],
            ...(reason === "ceiling" ? { runtimeModeCeiling: "auto" as const } : {}),
            capabilities:
              reason === "capability"
                ? owner.capabilities.filter((c) => c !== "hub.manage")
                : reason === "remote-capability"
                  ? owner.capabilities.filter((c) => c !== "threads.remote")
                  : owner.capabilities,
          },
        },
      },
    });
    const sql = Context.get(database, SqlClient.SqlClient);
    yield* sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES ('caller', 'project', 'Test', 'codex', 'full-access', 'default', '2026-10-21', '2026-10-21', '{}')`;
    return {
      removeCapability,
      layer: Profiles.layer.pipe(
        Layer.provide(Layer.succeedContext(Context.merge(database, settingsContext))),
      ),
    };
  });

export const prepareFixture = (
  reason?: Reason,
  beforePhase: Effect.Effect<void> = Effect.void,
  afterPhase: Effect.Effect<void> = Effect.void,
  beforeOutcome: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi
          .spyOn(HostKey, "probeHostKey")
          .mockReturnValue(
            Effect.succeed({ algorithm: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:test" }),
          ),
      ),
      (probe) => Effect.sync(() => probe.mockRestore()),
    );
    const { removeCapability, layer: profileLayer } = yield* preparePolicy(reason);
    const preparations: string[] = [];
    let snapshot: SshHostResult = { kind: "ok", status: stopped };
    const upload = yield* Deferred.make<void>();
    let credentialRevoked = false;
    const scope: McpInvocationScope = {
      ...invocation,
      client:
        reason === "read-only-client"
          ? { sessionId: "client", label: "test", access: "read-only" }
          : undefined,
      readOnly: reason === "read-only",
      grantedScopes: ["orchestration:read"],
      thread: {
        threadId: ThreadId.make("caller"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      reauthorize: () =>
        reason === "credential" || credentialRevoked
          ? Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: "orchestration:read",
                message: "Credential revoked.",
              }),
            )
          : Effect.void,
    };
    const setup = Context.get(
      yield* Layer.build(
        Layer.effect(Setup.SshHostSetup, Setup.make({ home: "/fixture-prepare" })).pipe(
          Layer.provide(profileLayer),
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed(
                  reason === "deleted"
                    ? null
                    : liveThreadShell(ThreadId.make("caller"), {
                        runtimeMode:
                          reason === "approval-required" ||
                          reason === "auto" ||
                          reason === "auto-accept-edits"
                            ? reason
                            : "full-access",
                        interactionMode: reason === "plan" ? "plan" : "default",
                        ...(reason === "inactive" ? { activeRunId: null } : {}),
                      }),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(Dispatch.SshRemoteDispatch)({
              runtimeStatus: () => Effect.sync(() => snapshot),
              beginSetupOperation: () =>
                Effect.gen(function* () {
                  if (reason === "revoke" || reason === "revoke-remote")
                    yield* removeCapability.pipe(Effect.orDie);
                  credentialRevoked = reason === "revoke-credential";
                  return { operationId: "prepare", generation: 1, stage: "runtime" as const };
                }),
              publishSetupOutcome: (_host, operation, outcome) =>
                beforeOutcome.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      if (outcome.kind === "error")
                        snapshot = {
                          kind: "ok",
                          status: {
                            ...stopped,
                            state: "failed",
                            setup: { ...operation, stage: "complete" },
                            detail: outcome.message,
                            failure: { reason: outcome.reason, fix: outcome.fix },
                          },
                        };
                      return true;
                    }),
                  ),
                ),
              prepareRuntime: (host, options) =>
                Effect.gen(function* () {
                  yield* beforePhase;
                  preparations.push(host);
                  snapshot = {
                    kind: "ok",
                    status: { ...stopped, state: "preparing", phase: "uploading" },
                  };
                  options.onPhase?.({
                    target: { alias: host, hostname: host, username: null, port: null },
                    phase: "uploading",
                  });
                  yield* Deferred.await(upload);
                  yield* afterPhase;
                  return snapshot;
                }),
            }),
          ),
          Layer.provide(
            FileSystem.layerNoop({
              readFileString: (file) =>
                Effect.succeed(
                  file.endsWith(".conf")
                    ? "Host box\n HostName box\n User deploy\n Port 2222\n"
                    : "box ssh-ed25519 AAAA\n",
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: () =>
                Effect.succeed({
                  stdout: `hostname box\nuser deploy\nport 2222\nhostkeyalias box\nuserknownhostsfile ${NodePath.join("/fixture-prepare", ".ssh", "goat-hosts", "box.known_hosts")}\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\n`,
                  stderr: "",
                  code: ExitCode(0),
                  timedOut: false,
                  stdoutTruncated: false,
                  stderrTruncated: false,
                  stdoutInvalidUtf8: false,
                  stderrInvalidUtf8: false,
                }),
            }),
          ),
          Layer.provide(dependencies),
        ),
      ),
      Setup.SshHostSetup,
    );
    return { setup, caller: { kind: "mcp" as const, scope }, preparations, upload };
  });

export const prepareSettlementRegression = Effect.fn("prepareSettlementRegression")(function* (
  mode: "before" | "after" | "publication" | "interrupted",
) {
  let fail = true;
  const crashed = yield* Deferred.make<void>();
  const completed = yield* Deferred.make<void>();
  const crash = Effect.suspend(() =>
    !fail
      ? Effect.void
      : (mode === "interrupted" ? Effect.interrupt : Effect.die("fixture runtime defect")).pipe(
          Effect.ensuring(Deferred.succeed(crashed, undefined)),
        ),
  );
  const f = yield* prepareFixture(
    undefined,
    mode === "after" ? Effect.void : crash,
    mode === "after" ? crash : Effect.void,
    mode === "publication" ? Effect.die("fixture publication defect") : Effect.void,
  );
  const caller = yield* f.setup.prepare({ host: "box" }, f.caller).pipe(
    Effect.tap(() => Deferred.succeed(completed, undefined)),
    Effect.forkChild,
  );
  try {
    if (mode === "after") {
      expect(yield* Fiber.join(caller)).toMatchObject({ status: { phase: "uploading" } });
      yield* Deferred.succeed(f.upload, undefined);
    }
    yield* Deferred.await(crashed);
    yield* TestClock.adjust("0 millis");
    expect(yield* Deferred.isDone(completed)).toBe(true);
    if (mode !== "after")
      expect(yield* Fiber.join(caller)).toMatchObject({ kind: "error", code: "operation_failed" });
    if (mode === "before" || mode === "after")
      expect(yield* f.setup.status({ host: "box" })).toMatchObject({
        status: { state: "failed", setup: { stage: "complete" } },
      });
    if (mode === "before") {
      fail = false;
      expect(yield* f.setup.prepare({ host: "box" }, f.caller)).toMatchObject({
        kind: "ok",
        status: { state: "preparing", phase: "uploading" },
      });
    }
  } finally {
    yield* Fiber.interrupt(caller);
  }
});
