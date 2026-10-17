import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it, vi } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  OrchestratorMcpFailure,
  handoffSummary,
  buildSshKeyAuthInstructions,
  AuthSessionId,
  TurnItemId,
  type Handoff,
  EnvironmentId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type SshHostResult,
  type SshHostStatus,
} from "@goat/contracts";
import * as HostKey from "@goat/ssh/hostKey";
import * as FileSystem from "effect/FileSystem";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as Diagnosis from "../provider/ProviderDiagnosisRouting.ts";
import * as SshConfig from "@goat/ssh/config";
import { SshLaunchError, SshHostKeyProbeError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as DateTime from "effect/DateTime";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { dependencies } from "./testkit/SshHostSetupTestkit.ts";
import * as SshHostSetup from "./SshHostSetup.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

const target = { alias: "box", hostname: "box", username: null, port: null };
const stopped: SshHostStatus = {
  host: "box",
  state: "stopped",
  runtimeVersion: "0.4.2",
  requestedVersion: "0.4.3-owner",
};
const invocation: McpInvocationScope = {
  environmentId: EnvironmentId.make("owner"),
  requestNamespace: "client:ssh",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "client", label: "Agent", access: "full-access" },
  grantedScopes: ["environment:maintain"],
  reauthorize: () => Effect.void,
};

const fixture = Effect.gen(function* () {
  let snapshot: SshHostResult = { kind: "ok", status: stopped };
  const events: string[] = [];
  const updates: { host: string; confirmReplacement: boolean }[] = [];
  const dispatch = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
    publishSetupOutcome: () => Effect.succeed(true),
    runtimeStatus: () => Effect.sync(() => snapshot),
    beginSetupOperation: (_host, { operationId }) =>
      Effect.succeed({ operationId, generation: 1, stage: "runtime" }),
    runtimeUpdate: (host, options) =>
      Effect.sync(() => {
        events.push("update");
        updates.push({ host, confirmReplacement: options.confirmReplacement });
        snapshot = { kind: "ok", status: { ...stopped, state: "update_waiting" } };
        return snapshot;
      }),
  });
  const setup = Context.get(
    yield* Layer.build(
      SshHostSetup.layer.pipe(Layer.provide(dispatch), Layer.provide(dependencies)),
    ),
    SshHostSetup.SshHostSetup,
  );
  const scope: McpInvocationScope = {
    ...invocation,
    reauthorize: (required) =>
      Effect.sync(() => {
        expect(required).toEqual(["environment:maintain"]);
        events.push("authorize");
      }),
  };
  return { setup, scope, events, updates };
});

it.effect("uses the dispatch owner version", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    expect(yield* f.setup.status({ host: "box" })).toEqual({ kind: "ok", status: stopped });
    expect(f.updates).toEqual([]);
  }),
);

it.effect.each([undefined, "when_idle"] as const)(
  "defaults to when_idle after live authorization (mode=%s)",
  (mode) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.setup.update(
        { host: "box", ...(mode === undefined ? {} : { mode }) },
        { kind: "mcp", scope: f.scope },
      );
      expect(result).toMatchObject({ kind: "ok", status: { state: "update_waiting" } });
      expect(yield* f.setup.status({ host: "box" })).toEqual(result);
      expect(f.events).toEqual(["authorize", "authorize", "authorize", "update"]);
      expect(f.updates).toEqual([{ host: "box", confirmReplacement: false }]);
    }),
);

it.effect.each([false, true])(
  "MCP now creates approval only for an actual thread (thread=%s)",
  (insideThread) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const result = yield* f.setup.update(
        { host: "box", mode: "now" },
        {
          kind: "mcp",
          scope: {
            ...f.scope,
            thread: insideThread
              ? {
                  threadId: ThreadId.make("caller"),
                  providerSessionId: "session",
                  providerInstanceId: ProviderInstanceId.make("codex"),
                }
              : undefined,
          },
        },
      );
      expect(result).toMatchObject(
        insideThread
          ? { kind: "needs_human", next: { after: "approval", call: "goat_ssh_host_status" } }
          : {
              kind: "error",
              code: "unsupported",
              fix: {
                actor: "human",
                instruction: "Ask from a GOAT thread so you can approve it there.",
              },
            },
      );
      expect(f.events).toEqual(["authorize"]);
      expect(f.updates).toEqual([]);
      expect(yield* f.setup.status({ host: "box" })).toEqual({ kind: "ok", status: stopped });
    }),
);

it.effect.each(["read-only", "missing-grant", "missing-reauthorize", "revoked"] as const)(
  "rejects %s before runtime mutation",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const { reauthorize, ...scopeWithoutAuthorization } = f.scope;
      const scope: McpInvocationScope = {
        ...scopeWithoutAuthorization,
        ...(reason === "read-only" ? { readOnly: true } : {}),
        ...(reason === "missing-grant" ? { grantedScopes: [] } : {}),
        ...(reason === "revoked"
          ? {
              reauthorize: () =>
                Effect.fail(
                  new EnvironmentAuthorizationError({
                    requiredScope: "environment:maintain",
                    message: "The session was revoked.",
                  }),
                ),
            }
          : reason === "missing-reauthorize" || reauthorize === undefined
            ? {}
            : { reauthorize }),
      };
      const result = yield* f.setup
        .update({ host: "box" }, { kind: "mcp", scope })
        .pipe(Effect.flip);
      expect(result._tag === "EnvironmentAuthorizationError" && result.requiredScope).toBe(
        "environment:maintain",
      );
      expect(f.updates).toEqual([]);
    }),
);

it.effect.each(["host_unknown", "invalid_request", "ssh_failed"] as const)(
  "returns the known dispatch error %s in the common envelope",
  (reason) =>
    Effect.gen(function* () {
      const setup = Context.get(
        yield* Layer.build(
          SshHostSetup.layer.pipe(
            Layer.provide(dependencies),
            Layer.provide(
              Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
                publishSetupOutcome: () => Effect.succeed(true),
                runtimeStatus: () =>
                  Effect.fail(
                    new SshRemoteDispatch.SshRemoteDispatchError({ reason, message: "box failed" }),
                  ),
              }),
            ),
          ),
        ),
        SshHostSetup.SshHostSetup,
      );
      expect(yield* setup.status({ host: "box" })).toMatchObject({
        kind: "error",
        code: reason === "ssh_failed" ? "operation_failed" : reason,
      });
    }),
);

it.effect("shares the dispatch manager", () =>
  Effect.gen(function* () {
    let snapshot: SshHostResult = { kind: "ok", status: stopped };
    let ensures = 0;
    let statusReads = 0;
    const manager = SshTunnel.SshEnvironmentManager.of({
      readyEnvironment: () => Effect.die("Unexpected ready environment"),
      beginSetupOperation: () =>
        Effect.sync(() => {
          const setup = { operationId: "operation", generation: 1, stage: "runtime" as const };
          snapshot = { kind: "ok", status: { ...stopped, setup } };
          return setup;
        }),
      publishSetupOutcome: () => Effect.succeed(true),
      publishProviderDiagnosis: () => Effect.die("Unexpected provider publication"),
      forgetEnvironment: () => Effect.die("Unexpected forget"),
      status: () =>
        Effect.sync(() => {
          statusReads++;
          return snapshot;
        }),
      ensureEnvironment: (received, options) =>
        Effect.gen(function* () {
          ensures++;
          expect(received).toEqual(target);
          expect(options).toEqual({
            keyOnly: true,
            issuePairingToken: false,
            refreshRuntime: true,
            confirmReplacement: false,
            onPhase: expect.any(Function),
          });
          snapshot = {
            kind: "ok",
            status: {
              ...stopped,
              state: "failed",
              failure: {
                reason: "archive_unavailable",
                archive: {
                  requestedVersion: stopped.requestedVersion,
                  platformKey: "linux-x64",
                  sourcesTried: ["https"],
                },
                fix: {
                  actor: "human",
                  instruction: "Install a published GOAT release, or set a release mirror.",
                },
              },
            },
          };
          return yield* new SshLaunchError({
            reason: "archive-unavailable",
            message: "No archive",
            stdout: "",
          });
        }),
      disconnectEnvironment: () => Effect.die("Unexpected disconnect"),
      revalidateTunnels: () => Effect.void,
      issueMcpClientSession: () => Effect.die("Unexpected pairing/session mutation"),
      runRemoteScript: () => Effect.die("Unexpected remote command"),
    });
    const discover = vi
      .spyOn(SshConfig, "discoverSshHosts")
      .mockReturnValue(Effect.succeed([{ ...target, source: "ssh-config" }]));
    const managerLayer = vi
      .spyOn(SshTunnel.SshEnvironmentManager, "layer")
      .mockReturnValue(Layer.succeed(SshTunnel.SshEnvironmentManager, manager));
    try {
      yield* Effect.gen(function* () {
        const setup = yield* SshHostSetup.SshHostSetup;
        const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
        expect(yield* setup.status({ host: "box" })).toEqual({ kind: "ok", status: stopped });
        const result = yield* setup.update({ host: "box" }, { kind: "mcp", scope: invocation });
        expect(result).toMatchObject({
          kind: "ok",
          status: { state: "failed", failure: { reason: "archive_unavailable" } },
        });
        expect(yield* dispatch.runtimeStatus("box")).toEqual(result);
        expect(yield* setup.status({ host: "box" })).toEqual(result);
        expect(ensures).toBe(1);
        expect(statusReads).toBe(6);
        expect(
          yield* setup.update({ host: "unknown" }, { kind: "mcp", scope: invocation }),
        ).toMatchObject({ kind: "error", code: "host_unknown" });
        expect(ensures).toBe(1);
      }).pipe(
        Effect.provide(
          SshHostSetup.layer.pipe(
            Layer.provideMerge(SshRemoteDispatch.layer),
            Layer.provide(dependencies),
            Layer.provide(ServerConfig.layerTest("/fixture", { prefix: "ssh-host-setup-" })),
            Layer.provide(FetchHttpClient.layer),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    } finally {
      managerLayer.mockRestore();
      discover.mockRestore();
    }
  }),
);

it.effect("when_idle returns the first published phase while installation is gated", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>();
    const complete = yield* Deferred.make<void>();
    let snapshot: SshHostResult = { kind: "ok", status: stopped };
    let installs = 0;
    const dispatch = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
      publishSetupOutcome: () => Effect.succeed(true),
      runtimeStatus: () => Effect.sync(() => snapshot),
      beginSetupOperation: (_host, { operationId }) =>
        Effect.succeed({ operationId, generation: 1, stage: "runtime" }),
      runtimeUpdate: (_host, options) =>
        Effect.gen(function* () {
          installs++;
          snapshot = { kind: "ok", status: { ...stopped, state: "preparing", phase: "uploading" } };
          options.onPhase?.({ target, phase: "uploading" });
          yield* Deferred.await(gate);
          snapshot = { kind: "ok", status: { ...stopped, state: "ready" } };
          yield* Deferred.succeed(complete, undefined);
          return snapshot;
        }),
    });
    const setup = Context.get(
      yield* Layer.build(
        SshHostSetup.layer.pipe(Layer.provide(dispatch), Layer.provide(dependencies)),
      ),
      SshHostSetup.SshHostSetup,
    );
    const first = yield* setup.update({ host: "box" }, { kind: "mcp", scope: invocation });
    expect(first).toMatchObject({ kind: "ok", status: { state: "preparing", phase: "uploading" } });
    expect(yield* Deferred.isDone(gate)).toBe(false);
    expect(yield* setup.update({ host: "box" }, { kind: "mcp", scope: invocation })).toEqual(first);
    expect(installs).toBe(1);
    yield* Deferred.succeed(gate, undefined);
    yield* Deferred.await(complete);
    expect(yield* setup.status({ host: "box" })).toMatchObject({ status: { state: "ready" } });
  }),
);

it.effect.each(["not_ready", "transport_failure", "schema_failure"] as const)(
  "prepare returns before upload and exits diagnosis after %s",
  (diagnosisOutcome) =>
    Effect.gen(function* () {
      const upload = yield* Deferred.make<void>();
      const diagnose = yield* Deferred.make<void>();
      const diagnosisStarted = yield* Deferred.make<void>();
      const published = yield* Deferred.make<void>();
      const home = "/fixture-ssh-origin";
      let snapshot: SshHostResult = { kind: "ok", status: stopped };
      const operation = { operationId: "prepare-one", generation: 1, stage: "runtime" as const };
      const pin = "box ssh-ed25519 AAAA\n";
      const config = "Host box\n HostName box\n User deploy\n Port 2222\n";
      const resolved = `hostname box\nuser deploy\nport 2222\nhostkeyalias box\nuserknownhostsfile ${home}/.ssh/goat-hosts/box.known_hosts\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\n`;
      const key = vi
        .spyOn(HostKey, "probeHostKey")
        .mockReturnValue(
          Effect.succeed({ algorithm: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:test" }),
        );
      const dispatch = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        publishSetupOutcome: (_host, _operation, outcome) =>
          Effect.gen(function* () {
            if (outcome.kind === "error") {
              snapshot = {
                kind: "ok",
                status: {
                  ...stopped,
                  state: "failed",
                  failure: { reason: outcome.reason, fix: outcome.fix },
                  setup: { ...operation, stage: "complete" },
                  detail: outcome.message,
                },
              };
              yield* Deferred.succeed(published, undefined);
            }
            return true;
          }),
        runtimeStatus: () => Effect.sync(() => snapshot),
        beginSetupOperation: () =>
          Effect.sync(() => {
            snapshot = { kind: "ok", status: { ...stopped, setup: operation } };
            return operation;
          }),
        prepareRuntime: (_host, options) =>
          Effect.gen(function* () {
            expect(options.operationId).toBe(operation.operationId);
            snapshot = {
              kind: "ok",
              status: { ...stopped, setup: operation, state: "preparing", phase: "uploading" },
            };
            options.onPhase?.({ target, phase: "uploading" });
            yield* Deferred.await(upload);
            snapshot = {
              kind: "ok",
              status: {
                ...stopped,
                runtimeVersion: stopped.requestedVersion,
                state: "ready",
                setup: { ...operation, stage: "diagnosis" },
              },
            };
            return snapshot;
          }),
        publishProviderDiagnosis: (_host, input) =>
          Effect.gen(function* () {
            expect(input.operationId).toBe(operation.operationId);
            expect(input.generation).toBe(operation.generation);
            snapshot = {
              kind: "ok",
              status: {
                ...stopped,
                runtimeVersion: stopped.requestedVersion,
                state: "providers_not_ready",
                setup: { ...operation, stage: "complete" },
                providers: input.providers,
              },
            };
            yield* Deferred.succeed(published, undefined);
            return true;
          }),
      });
      const setup = Context.get(
        yield* Layer.build(
          Layer.effect(SshHostSetup.SshHostSetup, SshHostSetup.make({ home })).pipe(
            Layer.provide(dispatch),
            Layer.provide(
              FileSystem.layerNoop({
                readFileString: (file) => Effect.succeed(file.endsWith(".conf") ? config : pin),
              }),
            ),
            Layer.provide(
              Layer.mock(ProcessRunner.ProcessRunner)({
                run: () =>
                  Effect.succeed({
                    stdout: resolved,
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
            Layer.provide(
              Layer.mock(Diagnosis.ProviderDiagnosisRouting)({
                diagnose: () =>
                  Effect.gen(function* () {
                    yield* Deferred.succeed(diagnosisStarted, undefined);
                    yield* Deferred.await(diagnose);
                    if (diagnosisOutcome !== "not_ready")
                      return yield* new OrchestratorMcpFailure({
                        code: "orchestration_error",
                        message: diagnosisOutcome,
                      });
                    return {
                      checkedBy: "server",
                      host: "box",
                      diagnoses: [
                        {
                          instanceId: ProviderInstanceId.make("codex"),
                          driver: ProviderDriverKind.make("codex"),
                          configured: true,
                          ready: false,
                          checks: [
                            {
                              id: "auth",
                              status: "fail",
                              reason: "not_signed_in",
                              summary: "Sign in on the host",
                              fix: { actor: "human", instruction: "Sign in on box." },
                            },
                          ],
                        },
                      ],
                    };
                  }),
              }),
            ),
            Layer.provide(dependencies),
          ),
        ),
        SshHostSetup.SshHostSetup,
      );
      yield* Effect.gen(function* () {
        const first = yield* setup.prepare({ host: "box" }, { kind: "mcp", scope: invocation });
        expect(first).toMatchObject({ status: { state: "preparing", phase: "uploading" } });
        expect(yield* Deferred.isDone(upload)).toBe(false);
        yield* Deferred.succeed(upload, undefined);
        yield* Deferred.await(diagnosisStarted);
        expect(yield* setup.status({ host: "box" })).toMatchObject({
          status: { state: "ready", setup: { stage: "diagnosis" } },
        });
        expect(yield* Deferred.isDone(published)).toBe(false);
        yield* Deferred.succeed(diagnose, undefined);
        yield* Deferred.await(published);
        const result = yield* setup.status({ host: "box" });
        expect(result).toMatchObject(
          diagnosisOutcome === "not_ready"
            ? {
                status: {
                  state: "providers_not_ready",
                  setup: { stage: "complete" },
                  providers: { ready: false },
                },
              }
            : {
                status: {
                  state: "failed",
                  setup: { stage: "complete" },
                  failure: { reason: "diagnosis_failed" },
                },
              },
        );
        if (diagnosisOutcome !== "not_ready") expect(result.status?.providers).toBeUndefined();
      }).pipe(Effect.ensuring(Effect.sync(() => key.mockRestore())));
    }),
);

it.effect.each([599999, 600000, null, "revoked"] as const)(
  "resumes an approved runtime update only within ten minutes (age=%s)",
  (age) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const completed = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const install = yield* Deferred.make<void>();
      let updates = 0;
      let acknowledgements = 0;
      const operation = { operationId: "approved-op", generation: 1, stage: "runtime" as const };
      let snapshot: SshHostResult = { kind: "ok", status: { ...stopped, setup: operation } };
      const handoff: Handoff = {
        handoffId: TurnItemId.make("approved-update"),
        kind: "approval",
        title: "Update box?",
        reason: "Replace runtime",
        requestedBy: {
          threadId: ThreadId.make("caller"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          path: "ssh.runtime_update",
        },
        target: { environmentId: EnvironmentId.make("owner"), path: "ssh.runtime_update" },
        dedupeKey: "test",
        state: "completed",
        createdAt: DateTime.subtract(now, { minutes: 15 }),
        expiresAt: DateTime.add(now, { hours: 23 }),
        ...(age === null
          ? {}
          : {
              resolvedAt: DateTime.makeUnsafe(
                DateTime.toEpochMillis(now) - (age === "revoked" ? 1000 : age),
              ),
            }),
        actor: { type: "client", label: "Reviewer" },
      };
      const sessionId = AuthSessionId.make("reviewer");
      const layer = SshHostSetup.layer.pipe(
        Layer.provide(
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () =>
              Effect.succeed(
                age === "revoked"
                  ? []
                  : [
                      {
                        sessionId,
                        subject: "reviewer",
                        method: "browser-session-cookie",
                        scopes: ["environment:maintain", "orchestration:read"],
                        client: { label: "Reviewer", deviceType: "unknown" },
                        issuedAt: now,
                        expiresAt: DateTime.add(now, { hours: 1 }),
                        lastConnectedAt: now,
                        connected: true,
                        current: true,
                      },
                    ],
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(Handoffs.Handoffs)({
            resolvedSshOutcomes: Effect.succeed([]),
            completedSshContinuations: Effect.succeed([
              {
                handoff,
                approvedBySessionId: sessionId,
                sshProgress: {
                  host: "box",
                  operationId: operation.operationId,
                  aliasGeneration: operation.generation,
                  environmentId: EnvironmentId.make("owner"),
                  threadId: ThreadId.make("caller"),
                },
                args: {
                  version: 1,
                  step: "runtime_update",
                  host: "box",
                  operationId: operation.operationId,
                  aliasGeneration: operation.generation,
                  requestedVersion: stopped.requestedVersion,
                },
              },
            ]),
            bindSshContinuation: () => Effect.void,
            finishSshContinuation: () =>
              Effect.gen(function* () {
                acknowledgements++;
                yield* Deferred.succeed(completed, undefined);
              }),
          }),
        ),
        Layer.provide(
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
            publishSetupOutcome: (_host, _operation, outcome) =>
              Effect.sync(() => {
                if (outcome.kind === "error")
                  snapshot = {
                    kind: "ok",
                    status: {
                      ...stopped,
                      state: "failed",
                      setup: { ...operation, stage: "complete" },
                      failure: { reason: outcome.reason, fix: outcome.fix },
                      detail: outcome.message,
                    },
                  };
                return true;
              }),
            runtimeStatus: () => Effect.sync(() => snapshot),
            runtimeUpdate: (_host, options) =>
              Effect.gen(function* () {
                updates++;
                expect(options.confirmReplacement).toBe(true);
                snapshot = {
                  kind: "ok",
                  status: { ...stopped, state: "preparing", phase: "uploading", setup: operation },
                };
                options.onPhase?.({ target, phase: "uploading" });
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(install);
                snapshot = {
                  kind: "ok",
                  status: {
                    ...stopped,
                    state: "ready",
                    setup: { ...operation, stage: "complete" },
                  },
                };
                return snapshot;
              }),
          }),
        ),
        Layer.provide(dependencies),
      );
      const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
      yield* setup.resumeContinuations;
      if (age === 599999) {
        yield* Deferred.await(started);
        yield* setup.resumeContinuations;
        expect(updates).toBe(1);
        expect(acknowledgements).toBe(0);
        yield* Deferred.succeed(install, undefined);
      }
      yield* Deferred.await(completed);
      expect(updates).toBe(age === 599999 ? 1 : 0);
      expect(acknowledgements).toBe(1);
      if (age !== 599999)
        expect(yield* setup.status({ host: "box" })).toMatchObject({
          status: {
            state: "failed",
            setup: { stage: "complete" },
            failure: { reason: age === "revoked" ? "authorization_revoked" : "approval_expired" },
          },
        });
    }),
);

it.effect(
  "Forget fences an admitted job while its upload is still gated and removes only owned files",
  () =>
    Effect.gen(function* () {
      const upload = yield* Deferred.make<void>();
      const fenced = yield* Deferred.make<void>();
      const removed: string[] = [];
      let latePhase: SshTunnel.SshRuntimeProgressCallback | undefined;
      let snapshot: SshHostResult = { kind: "ok", status: stopped };
      const operation = { operationId: "forget-op", generation: 1, stage: "runtime" as const };
      const dispatch = Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        beginSetupOperation: () => Effect.succeed(operation),
        publishSetupOutcome: () => Effect.succeed(true),
        runtimeStatus: () => Effect.sync(() => snapshot),
        runtimeUpdate: (_host, options) =>
          Effect.gen(function* () {
            latePhase = options.onPhase;
            snapshot = {
              kind: "ok",
              status: { ...stopped, state: "preparing", phase: "uploading", setup: operation },
            };
            options.onPhase?.({ target, phase: "uploading" });
            yield* Deferred.await(upload);
            return snapshot;
          }),
        forgetRuntime: (_host, options) =>
          Effect.gen(function* () {
            expect(options.stopRuntime).toBe("no");
            snapshot = { kind: "ok", status: { ...stopped, state: "untrusted" } };
            yield* Deferred.succeed(fenced, undefined);
            return snapshot;
          }),
      });
      const layer = Layer.effect(
        SshHostSetup.SshHostSetup,
        SshHostSetup.make({ home: "/fixture-forget" }),
      ).pipe(
        Layer.provide(dispatch),
        Layer.provide(
          FileSystem.layerNoop({
            remove: (file) =>
              Effect.sync(() => {
                removed.push(file);
              }),
          }),
        ),
        Layer.provide(dependencies),
      );
      const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
      const caller = {
        kind: "mcp" as const,
        scope: {
          ...invocation,
          grantedScopes: ["environment:maintain", "settings:write"] as const,
        },
      };
      expect(yield* setup.update({ host: "box" }, caller)).toMatchObject({
        status: { state: "preparing" },
      });
      expect(yield* setup.forget({ host: "box", stopRuntime: "no" }, caller)).toMatchObject({
        status: { state: "untrusted" },
      });
      yield* Deferred.await(fenced);
      expect(yield* Deferred.isDone(upload)).toBe(false);
      expect(removed).toEqual([
        "/fixture-forget/.ssh/goat-hosts/box.conf",
        "/fixture-forget/.ssh/goat-hosts/box.known_hosts",
      ]);
      latePhase?.({ target, phase: "starting" });
      yield* Deferred.succeed(upload, undefined);
      expect(yield* setup.status({ host: "box" })).toMatchObject({
        status: { state: "untrusted" },
      });
    }),
);

const probeSessionId = AuthSessionId.make("probe-reviewer");
const probeClient = Layer.mock(SessionStore.SessionStore)({
  cookieName: "test",
  legacyCookieName: undefined,
  listActive: () =>
    Effect.succeed([
      {
        sessionId: probeSessionId,
        subject: "reviewer",
        method: "browser-session-cookie",
        scopes: ["settings:write"],
        client: { label: "Reviewer", deviceType: "unknown" },
        issuedAt: DateTime.makeUnsafe(0),
        expiresAt: DateTime.makeUnsafe(9999999999999),
        lastConnectedAt: null,
        connected: true,
        current: true,
      },
    ]),
});
const processOutput = (stdout: string, stderr = "", code = 0) => ({
  stdout,
  stderr,
  code: ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
it.effect.each([
  {
    stderr: "connect to host box port 22: Connection refused",
    reason: "connection_refused",
    message: "box refused the connection.",
  },
  {
    stderr: "connect to host box port 22: No route to host",
    reason: "unreachable",
    message: "Can't reach box.",
  },
  {
    stderr: "Could not resolve hostname box: nodename nor servname provided",
    reason: "unreachable",
    message: "Can't reach box.",
  },
  {
    stderr: "Key exchange did not return a destination key",
    reason: "operation_failed",
    message: "Could not check this SSH host. Try again.",
  },
] as const)("typed probe failure: $reason", ({ stderr, reason, message }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-probe-test-" });
    const paths: string[] = [];
    const key = vi
      .spyOn(HostKey, "probeHostKey")
      .mockReturnValue(
        Effect.fail(
          new SshHostKeyProbeError({ message: "Expected one negotiated destination host key." }),
        ),
      );
    const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(Effect.succeed([]));
    yield* Effect.gen(function* () {
      const setup = Context.get(
        yield* Layer.build(
          Layer.effect(SshHostSetup.SshHostSetup, SshHostSetup.make({ home })).pipe(
            Layer.provide(probeClient),
            Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
            Layer.provide(
              Layer.mock(ProcessRunner.ProcessRunner)({
                run: (input) =>
                  Effect.sync(() => {
                    if (input.args.includes("-G"))
                      return processOutput("hostname box\nuser root\nport 22\n");
                    expect(input.args).toContain("PreferredAuthentications=none");
                    expect(input.args).toContain("UpdateHostKeys=no");
                    const destination = input.args.find((arg) =>
                      arg.startsWith("UserKnownHostsFile="),
                    )!;
                    const file = destination.slice('UserKnownHostsFile="'.length, -1);
                    paths.push(file);
                    expect(file).not.toBe(`${home}/.ssh/known_hosts`);
                    return processOutput("", stderr, 255);
                  }),
              }),
            ),
            Layer.provide(dependencies),
          ),
        ),
        SshHostSetup.SshHostSetup,
      );
      const error = yield* setup.probe({ address: "box" }, probeSessionId).pipe(Effect.flip);
      expect(error._tag).toBe("SshHostProbeError");
      if (error._tag === "SshHostProbeError")
        expect({ reason: error.reason, message: error.message }).toEqual({ reason, message });
      expect(paths).toHaveLength(1);
      for (const path of paths) expect(yield* fs.exists(path)).toBe(false);
      expect(yield* fs.exists(`${home}/.ssh/config`)).toBe(false);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          key.mockRestore();
          discover.mockRestore();
        }),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "approval copy names the server, negotiated algorithm, account and each next action",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-copy-test-" });
      const created: Array<Parameters<Handoffs.Handoffs["Service"]["create"]>[0]> = [];
      const key = vi
        .spyOn(HostKey, "probeHostKey")
        .mockReturnValue(
          Effect.succeed({ algorithm: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:review" }),
        );
      const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(Effect.succeed([]));
      const directory = `${home}/.ssh/goat-hosts`;
      const keyAuth = buildSshKeyAuthInstructions({
        originLabel: "Origin",
        host: "box",
        user: "root",
        port: 2222,
        generatedKey: true,
        publicKey: "ssh-ed25519 AAAA",
        publicKeyPath: `${directory}/id_ed25519.pub`,
      });
      let snapshot: SshHostResult = { kind: "ok", status: stopped };
      yield* Effect.gen(function* () {
        const serviceLayer = Layer.effect(
          SshHostSetup.SshHostSetup,
          SshHostSetup.make({ home }),
        ).pipe(
          Layer.provide(probeClient),
          Layer.provide(
            Layer.mock(Handoffs.Handoffs)({
              create: (input) =>
                Effect.gen(function* () {
                  created.push(input);
                  return handoffSummary({
                    handoffId: TurnItemId.make(`copy-${created.length}`),
                    kind: input.kind,
                    title: input.title,
                    reason: input.reason,
                    requestedBy: input.requestedBy,
                    target: input.target,
                    dedupeKey: "copy",
                    state: "pending",
                    expiresAt: input.expiresAt ?? null,
                    createdAt: yield* DateTime.now,
                    actor: { type: "agent", threadId: input.requestedBy.threadId },
                  });
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: () =>
                Effect.succeed(
                  processOutput(
                    `hostname box\nuser root\nport 2222\nhostkeyalias box\nuserknownhostsfile ${directory}/box.known_hosts\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\n`,
                  ),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
              runtimeStatus: () => Effect.sync(() => snapshot),
              beginSetupOperation: (_host, { operationId }) =>
                Effect.sync(() => {
                  const operation = { operationId, generation: 1, stage: "runtime" as const };
                  snapshot = { kind: "ok", status: { ...stopped, setup: operation } };
                  return operation;
                }),
              prepareRuntime: () =>
                Effect.sync(() => {
                  snapshot = {
                    kind: "ok",
                    status: {
                      ...stopped,
                      state: "auth_failed",
                      publicKey: "ssh-ed25519 AAAA",
                      keyAuth,
                    },
                  };
                  return snapshot;
                }),
            }),
          ),
          Layer.provide(dependencies),
        );
        const setup = Context.get(yield* Layer.build(serviceLayer), SshHostSetup.SshHostSetup);
        const input = { address: "box", alias: "box" };
        const probe = yield* setup.probe(input, probeSessionId);
        expect(probe.human.location).toBe(
          "box presented this key. GOAT will connect as root. Approving also adds one Include line to ~/.ssh/config.",
        );
        expect(probe.human.fingerprint).toBe("SHA256:review (ssh-ed25519)");
        expect(yield* fs.exists(`${home}/.ssh/config`)).toBe(false);
        const caller: SshHostSetup.SshHostCaller = {
          kind: "mcp",
          scope: {
            ...invocation,
            client: undefined,
            thread: {
              threadId: ThreadId.make("caller"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "session",
            },
            grantedScopes: ["settings:write", "environment:maintain"],
          },
        };
        yield* setup.add(input, caller);
        expect(created[0]?.reason).toBe(
          "Check that box is the server you meant before GOAT connects to it.",
        );
        const challenge = created[0]?.args.challenge;
        expect(challenge).toMatchObject({ algorithm: "ssh-ed25519" });
        yield* setup.update({ host: "box", mode: "now" }, caller);
        expect(created[1]?.reason).toBe(
          "Running agent work gets up to a minute to finish, then continues on the new version.",
        );
        expect(created[1]?.human.location).toBe("Update GOAT on box now.");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(
          `${directory}/box.conf`,
          "Host box\n HostName box\n User root\n Port 2222\n",
        );
        yield* fs.writeFileString(`${directory}/box.known_hosts`, "box ssh-ed25519 AAAA\n");
        const result = yield* setup.prepare({ host: "box" }, caller);
        expect(result.kind).toBe("needs_human");
        expect(created[2]?.reason).toBe("box needs your public key before GOAT can sign in.");
        expect(created[2]?.human.command).toBe(keyAuth.command);
        expect(result.status?.keyAuth?.command).toBe(keyAuth.command);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            key.mockRestore();
            discover.mockRestore();
          }),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
