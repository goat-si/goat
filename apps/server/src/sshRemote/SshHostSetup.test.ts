import * as PermissionSettings from "../serverSettings.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Schema from "effect/Schema";
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
  SshPreflightReport,
  SSH_PREFLIGHT_STEP_ORDER,
  type SshHostResult,
} from "@goat/contracts";
import * as HostKey from "@goat/ssh/hostKey";
import * as FileSystem from "effect/FileSystem";
import { ChildProcessSpawner } from "effect/process";
import * as Stream from "effect/Stream";
import { makeSuccessfulProcess } from "../../../../packages/ssh/src/tunnel.fixture.ts";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as Diagnosis from "../provider/ProviderDiagnosisRouting.ts";
import * as SshConfig from "@goat/ssh/config";
import { SshLaunchError, SshHostKeyProbeError } from "@goat/ssh/errors";
import * as SshTunnel from "@goat/ssh/tunnel";
import * as DateTime from "effect/DateTime";
import { TestClock } from "effect/testing";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import { HttpClient } from "effect/http";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { dependencies, baseDependencies } from "./testkit/SshHostSetupTestkit.ts";
import * as SshHostSetup from "./SshHostSetup.ts";
import * as SshDeviceAdd from "./SshDeviceAdd.ts";
import * as HubNodes from "../hubNodes/HubNodes.ts";
import * as Broker from "../connections/ConnectionCatalogBroker.ts";
import * as SshRemoteDispatch from "./SshRemoteDispatch.ts";

import { target, stopped, invocation, fixture } from "./testkit/SshRuntimeUpdateFixture.ts";
import {
  prepareFixture,
  preparationRefusals,
  preparePolicy,
} from "./testkit/SshHostPrepareFixture.ts";
const encodeSshPreflightReport = Schema.encodeEffect(SshPreflightReport);

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

it.effect("journals an SSH update actor and what came of it", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.setup.update({ host: "box" }, { kind: "mcp", scope: f.scope });
    const fs = yield* FileSystem.FileSystem;
    const [requested, outcome, ...rest] = (yield* fs.readFileString(f.journal))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rest).toEqual([]);
    expect(requested).toMatchObject({
      operation: "ssh-runtime-update",
      operationId: expect.any(String),
      ts: expect.any(String),
      actor: { kind: "mcp", sessionId: "client" },
      destination: "box",
      fromVersion: "0.4.2",
      targetVersion: expect.any(String),
      mode: "idle",
      outcome: "requested",
    });
    // The host is still waiting for idle, so the request is accepted but not completed.
    expect(outcome).toMatchObject({ operationId: requested.operationId, outcome: "accepted" });
  }).pipe(Effect.provide(NodeServices.layer)),
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
            ...(insideThread
              ? {
                  client: undefined,
                  grantedScopes: ["orchestration:read" as const],
                  reauthorize: (required: ReadonlyArray<string>) =>
                    Effect.sync(() => {
                      expect(required).toEqual(["orchestration:read"]);
                      f.events.push("authorize");
                    }),
                }
              : {}),
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

it.effect("a thread with only orchestration:read can update when idle or ask to update now", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const seen: Array<ReadonlyArray<string>> = [];
    const threadScope: McpInvocationScope = {
      ...f.scope,
      client: undefined,
      readOnly: false,
      thread: {
        threadId: ThreadId.make("caller"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      grantedScopes: ["orchestration:read"],
      reauthorize: (required) => Effect.sync(() => void seen.push(required)),
    };
    const caller = { kind: "mcp" as const, scope: threadScope };
    expect(yield* f.setup.update({ host: "box", mode: "now" }, caller)).toMatchObject({
      kind: "needs_human",
      next: { after: "approval", call: "goat_ssh_host_status" },
    });
    expect(seen).toEqual([["orchestration:read"]]);
    expect(f.updates).toEqual([]);

    expect(
      yield* f.setup
        .update(
          { host: "box", mode: "now" },
          { kind: "mcp", scope: { ...threadScope, readOnly: true } },
        )
        .pipe(Effect.flip),
    ).toMatchObject({ requiredScope: "orchestration:read" });
    // An idle update cannot interrupt work, so the thread starts it and is reauthorized live.
    expect(yield* f.setup.update({ host: "box", mode: "when_idle" }, caller)).toMatchObject({
      kind: "ok",
      status: { state: "update_waiting" },
    });
    expect(f.updates).toEqual([{ host: "box", confirmReplacement: false }]);
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((scopes) => scopes.length === 1 && scopes[0] === "orchestration:read")).toBe(
      true,
    );
    expect(
      yield* f.setup
        .update(
          { host: "box", mode: "when_idle" },
          { kind: "mcp", scope: { ...threadScope, readOnly: true } },
        )
        .pipe(Effect.flip),
    ).toMatchObject({ requiredScope: "orchestration:read" });
    expect(f.updates).toHaveLength(1);
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
      status: () => Effect.sync(() => snapshot),
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
      issueClientSession: () => Effect.die("unused"),
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
        expect(
          yield* setup.update({ host: "unknown" }, { kind: "mcp", scope: invocation }),
        ).toMatchObject({ kind: "error", code: "host_unknown" });
        expect(ensures).toBe(1);
      }).pipe(
        Effect.provide(
          SshHostSetup.layer.pipe(
            Layer.provideMerge(
              SshRemoteDispatch.layer.pipe(Layer.provide(PermissionSettings.layerTest())),
            ),
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

it.effect.each(
  (["not_ready", "transport_failure", "schema_failure"] as const).flatMap((diagnosisOutcome) =>
    [false, true].map((drainDeferred) => ({ diagnosisOutcome, drainDeferred })),
  ),
)(
  "prepare returns before upload and exits diagnosis after $diagnosisOutcome; drain=$drainDeferred",
  ({ diagnosisOutcome, drainDeferred }) =>
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
                runtimeVersion: drainDeferred ? "0.4.2" : stopped.requestedVersion,
                state: "ready",
                ...(drainDeferred
                  ? {
                      refreshDeferred: {
                        reason: "archive_unavailable" as const,
                        refreshCause: "drain_unavailable" as const,
                        requestedVersion: stopped.requestedVersion,
                        detail: "Refresh deferred: this runtime could not drain for the refresh",
                      },
                    }
                  : {}),
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
                ...snapshot.status!,
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
        else if (drainDeferred) {
          expect(result.status?.runtimeVersion).toBe("0.4.2");
          expect(result.status?.refreshDeferred?.refreshCause).toBe("drain_unavailable");
          expect(yield* setup.status({ host: "box" })).toEqual(result);
        }
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

it.effect.each(["declined", "expired", "cancelled"] as const)(
  "a %s runtime update approval reaches the agent as a terminal error and never updates",
  (state) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      let updates = 0;
      let acknowledgements = 0;
      const operation = { operationId: "refused-op", generation: 1, stage: "runtime" as const };
      let snapshot: SshHostResult = { kind: "ok", status: { ...stopped, setup: operation } };
      const handoff: Handoff = {
        handoffId: TurnItemId.make("refused-update"),
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
        state,
        createdAt: DateTime.subtract(now, { minutes: 15 }),
        expiresAt: DateTime.add(now, { hours: 23 }),
        resolvedAt: now,
        actor: { type: "client", label: "Reviewer" },
      };
      const layer = SshHostSetup.layer.pipe(
        Layer.provide(
          Layer.mock(SessionStore.SessionStore)({
            cookieName: "test",
            legacyCookieName: undefined,
            listActive: () => Effect.succeed([]),
          }),
        ),
        Layer.provide(
          Layer.mock(Handoffs.Handoffs)({
            resolvedSshOutcomes: Effect.succeed([
              {
                handoff,
                sshProgress: {
                  host: "box",
                  operationId: operation.operationId,
                  aliasGeneration: operation.generation,
                  environmentId: EnvironmentId.make("owner"),
                  threadId: ThreadId.make("caller"),
                },
              },
            ]),
            completedSshContinuations: Effect.succeed([]),
            finishSshContinuation: () => Effect.sync(() => void acknowledgements++),
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
            runtimeUpdate: () => Effect.sync(() => void updates++).pipe(Effect.as(snapshot)),
          }),
        ),
        Layer.provide(dependencies),
      );
      const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
      yield* setup.resumeContinuations;
      expect(updates).toBe(0);
      expect(acknowledgements).toBe(1);
      expect(yield* setup.status({ host: "box" })).toMatchObject({
        status: {
          state: "failed",
          setup: { stage: "complete" },
          failure: {
            reason: state === "expired" ? "approval_expired" : "operation_failed",
            fix: { actor: "human" },
          },
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
    jump: false,
    stderr: "connect to host box port 22: Connection refused",
    reason: "connection_refused",
    message: "box refused the connection.",
  },
  {
    jump: false,
    stderr: "connect to host box port 22: No route to host",
    reason: "unreachable",
    message: "Can't reach box.",
  },
  {
    jump: false,
    stderr: "Could not resolve hostname box: nodename nor servname provided",
    reason: "unreachable",
    message: "Can't reach box.",
  },
  {
    jump: false,
    stderr: "Key exchange did not return a destination key",
    reason: "operation_failed",
    message: "Could not check this SSH host. Try again.",
  },
  {
    jump: true,
    stderr: "connect to host box port 22: Connection refused",
    reason: "connection_refused",
    message: "box refused the connection.",
  },
] as const)(
  "typed probe failure: $reason (nested jump: $jump)",
  ({ stderr, reason, message, jump }) =>
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
              Layer.provide(
                Layer.succeed(
                  ChildProcessSpawner.ChildProcessSpawner,
                  ChildProcessSpawner.make((command) => {
                    if (command._tag !== "StandardCommand")
                      return Effect.die("Unexpected pipeline");
                    expect(command.args).toContain("-G");
                    return Effect.succeed(
                      makeSuccessfulProcess(
                        command.args.at(-1) === "bastion"
                          ? "proxyjump outer\n"
                          : "proxyjump none\n",
                      ),
                    );
                  }),
                ),
              ),
              Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
              Layer.provide(
                Layer.mock(ProcessRunner.ProcessRunner)({
                  run: (input) =>
                    Effect.sync(() => {
                      if (input.args.includes("-G"))
                        return processOutput(
                          `hostname box\nuser root\nport 22\n${jump ? "proxyjump bastion\n" : ""}`,
                        );
                      expect(input.args).toContain("PreferredAuthentications=none");
                      for (const option of [
                        "UpdateHostKeys=no",
                        "PermitLocalCommand=no",
                        "ControlMaster=no",
                        "ControlPath=none",
                        "RemoteCommand=none",
                        "ClearAllForwardings=yes",
                      ])
                        expect(input.args).toContain(option);
                      expect(input.args.slice(-3)).toEqual(["box", "exit", "0"]);
                      if (jump) {
                        expect(input.args).toContain("ProxyJump=none");
                        const proxy = input.args.find((arg) => arg.startsWith("ProxyCommand="));
                        expect(proxy).toContain("bastion");
                        expect(proxy).toContain("outer");
                        expect(proxy).toContain("PermitLocalCommand=no");
                        expect(proxy).toContain("ProxyJump=none");
                      }
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
      const policy = yield* preparePolicy();
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
          Layer.provide(policy.layer),
          Layer.provide(baseDependencies),
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
            grantedScopes: ["orchestration:read", "settings:write", "environment:maintain"],
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

it.effect.each(["pinned", "key_changed", "expired", "authorization_revoked"] as const)(
  "host trust approval retains %s without starting setup",
  (outcome) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-pin-only-" });
      const finished = yield* Deferred.make<void>();
      const lookupStarted = yield* Deferred.make<void>();
      let created: Parameters<Handoffs.Handoffs["Service"]["create"]>[0] | undefined;
      let completed = false;
      let completion: Handoffs.SshProgressBinding["completion"];
      let retained: Handoffs.SshProgressBinding | null = null;
      let revoked = false;
      const reviewer = yield* SessionStore.SessionStore.pipe(Effect.provide(probeClient));
      const reviewerLayer = Layer.succeed(SessionStore.SessionStore, {
        ...reviewer,
        listActive: () =>
          reviewer.listActive().pipe(
            Effect.map((entries) =>
              entries.map((entry) => ({
                ...entry,
                scopes: revoked
                  ? ["orchestration:read" as const]
                  : ["settings:write" as const, "orchestration:read" as const],
              })),
            ),
          ),
      });
      const record: Handoff = {
        handoffId: TurnItemId.make("pin-only"),
        kind: "approval",
        title: "Trust build?",
        reason: "Review key",
        requestedBy: {
          threadId: ThreadId.make("caller"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          path: "ssh.host_add",
        },
        target: { environmentId: EnvironmentId.make("owner"), path: "ssh.host_add" },
        dedupeKey: "pin-only",
        state: "completed",
        expiresAt: null,
        createdAt: yield* DateTime.now,
        actor: { type: "client", label: "Reviewer" },
      };
      const key = vi
        .spyOn(HostKey, "probeHostKey")
        .mockReturnValue(
          Effect.succeed({ algorithm: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:review" }),
        );
      const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(Effect.succeed([]));
      yield* Effect.gen(function* () {
        const layer = Layer.effect(SshHostSetup.SshHostSetup, SshHostSetup.make({ home })).pipe(
          Layer.provide(reviewerLayer),
          Layer.provide(
            Layer.mock(Handoffs.Handoffs)({
              create: (input) =>
                Effect.sync(() => {
                  created = input;
                  return handoffSummary({ ...record, state: "pending" });
                }),
              resolvedSshOutcomes: Effect.succeed([]),
              completedSshContinuations: Effect.sync(() =>
                completed || !created
                  ? []
                  : [
                      {
                        handoff: record,
                        approvedBySessionId: probeSessionId,
                        args: created!.args,
                        sshProgress: created!.sshProgress!,
                      },
                    ],
              ),
              read: () => Effect.succeed(record),
              readSshProgressBinding: () =>
                Effect.gen(function* () {
                  yield* Deferred.succeed(lookupStarted, undefined);
                  return retained ?? created?.sshProgress ?? null;
                }),
              finishSshContinuation: (_input, result) =>
                Effect.gen(function* () {
                  completed = true;
                  completion = result;
                  retained = {
                    ...created!.sshProgress!,
                    ...(result ? { completion: result } : {}),
                  };
                  yield* Deferred.succeed(finished, undefined);
                }),
            }),
          ),
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: () =>
                Effect.succeed(
                  processOutput(
                    `hostname build.example\nuser deploy\nport 22\nhostkeyalias build\nuserknownhostsfile ${home}/.ssh/goat-hosts/build.known_hosts\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\nidentityfile /fixture/key\nidentitiesonly yes\n`,
                  ),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
              publishSetupOutcome: () => Effect.succeed(false),
              runtimeStatus: () => Effect.die("Pin approval attempted SSH authentication"),
              beginSetupOperation: () => Effect.die("Approval started a setup operation"),
              prepareRuntime: () => Effect.die("Approval installed a runtime"),
            }),
          ),
          Layer.provide(dependencies),
        );
        const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
        const caller: SshHostSetup.SshHostCaller = {
          kind: "mcp",
          scope: {
            ...invocation,
            client: undefined,
            grantedScopes: ["orchestration:read"],
            thread: {
              threadId: ThreadId.make("caller"),
              providerInstanceId: ProviderInstanceId.make("codex"),
              providerSessionId: "provider",
            },
          },
        };
        expect(
          yield* setup.add(
            {
              address: "build.example",
              user: "deploy",
              alias: "build",
              identityFile: "/fixture/key",
            },
            caller,
          ),
        ).toMatchObject({ kind: "needs_human" });
        if (outcome === "key_changed")
          key.mockReturnValue(
            Effect.succeed({
              algorithm: "ssh-ed25519",
              key: "BBBB",
              fingerprint: "SHA256:changed",
            }),
          );
        if (outcome === "expired") yield* TestClock.adjust("24 hours");
        if (outcome === "authorization_revoked") revoked = true;
        const address = { threadId: record.requestedBy.threadId, handoffId: record.handoffId };
        const pinStarted = yield* Deferred.make<void>();
        const releasePin = yield* Deferred.make<void>();
        if (outcome === "pinned")
          key.mockReturnValue(
            Effect.gen(function* () {
              yield* Deferred.succeed(pinStarted, undefined);
              yield* Deferred.await(releasePin);
              return { algorithm: "ssh-ed25519", key: "AAAA", fingerprint: "SHA256:review" };
            }),
          );
        const worker = yield* setup.resumeContinuations.pipe(Effect.forkChild);
        if (outcome === "pinned") yield* Deferred.await(pinStarted);
        const progressRead = yield* setup
          .handoffProgress(address, {
            kind: "client",
            sessionId: probeSessionId,
          })
          .pipe(Effect.forkChild);
        if (outcome === "pinned") {
          yield* Deferred.await(lookupStarted);
          expect(completed).toBe(false);
        }
        yield* Deferred.succeed(releasePin, undefined);
        yield* Fiber.join(worker);
        yield* Deferred.await(finished);
        const progress = yield* Fiber.join(progressRead);
        expect(progress).toMatchObject({
          kind: "available",
          result: { kind: outcome === "pinned" ? "ok" : "error" },
        });
        expect(completion?.result.status?.setup).toBeUndefined();
        if (outcome !== "pinned") {
          expect(completion?.result).toMatchObject({
            kind: "error",
            message: expect.stringContaining(
              outcome === "key_changed"
                ? "changed"
                : outcome === "expired"
                  ? "expired"
                  : "permission",
            ),
          });
          expect(yield* fs.exists(`${home}/.ssh/goat-hosts/build.known_hosts`)).toBe(false);
          return;
        }
        expect(completion?.result).toMatchObject({
          kind: "ok",
          status: { host: "build", state: "stopped" },
        });
        expect(yield* fs.readFileString(`${home}/.ssh/goat-hosts/build.known_hosts`)).toBe(
          "build ssh-ed25519 AAAA\n",
        );
        expect(yield* fs.readFileString(`${home}/.ssh/goat-hosts/build.conf`)).toContain(
          "IdentityFile",
        );
        yield* setup.resumeContinuations;
        yield* fs.writeFileString(
          `${home}/.ssh/goat-hosts/build.known_hosts`,
          "build ssh-ed25519 BBBB\n",
        );
        expect(
          yield* setup.handoffProgress(address, { kind: "client", sessionId: probeSessionId }),
        ).toEqual({ kind: "unavailable", reason: "superseded" });
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

it.effect("preflight normalizes typed destinations and rejects configured alias overrides", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preflight-setup-" });
    const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(
      Effect.succeed([
        {
          alias: "configured",
          hostname: "build.example",
          username: "deploy",
          port: 22,
          source: "ssh-config",
        },
      ]),
    );
    yield* Effect.gen(function* () {
      const layer = Layer.effect(SshHostSetup.SshHostSetup, SshHostSetup.make({ home })).pipe(
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(
          Layer.mock(ProcessRunner.ProcessRunner)({
            run: ({ args }) => {
              expect(args).toEqual(["-G", "custom"]);
              return Effect.succeed(
                processOutput("hostname build.example\nuser deploy\nport 2222\n"),
              );
            },
          }),
        ),
        Layer.provide(dependencies),
      );
      const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
      expect(yield* setup.resolveDestination({ address: "deploy@[2001:db8::1]:2222" })).toEqual({
        input: { address: "2001:db8::1", user: "deploy", port: 2222 },
      });
      expect(yield* setup.resolveDestination({ address: "configured" })).toEqual({
        host: "configured",
        managed: false,
        input: { address: "configured" },
      });
      yield* fs.makeDirectory(`${home}/.ssh/goat-hosts`, { recursive: true });
      yield* fs.writeFileString(
        `${home}/.ssh/goat-hosts/custom.conf`,
        "Host custom\n  HostName build.example\n  User deploy\n  Port 2222\n",
      );
      yield* fs.writeFileString(
        `${home}/.ssh/goat-hosts/custom.known_hosts`,
        "custom ssh-ed25519 AAAA\n",
      );
      expect(
        yield* setup.resolveDestination({ address: "deploy@build.example:2222" }),
      ).toMatchObject({
        host: "custom",
        input: { address: "build.example", user: "deploy", port: 2222 },
      });
      for (const overrides of [{ user: "root" }, { port: 2222 }, { identityFile: "/keys/id" }]) {
        expect(
          yield* setup
            .resolveDestination({ address: "configured", ...overrides })
            .pipe(Effect.flip),
        ).toMatchObject({
          reason: "invalid_request",
          message: expect.stringContaining(`${home}/.ssh/config`),
        });
      }
    }).pipe(Effect.ensuring(Effect.sync(() => discover.mockRestore())));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "preflight passes the environment label and source runner through the injected runner with crypto and HTTP",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preflight-runner-" });
      const report: SshPreflightReport = {
        host: "configured",
        destination: { alias: "configured", hostname: "build.example", user: "deploy", port: 22 },
        ready: false,
        steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({
          id,
          state: id === "host_key" ? "needs_review" : "passed",
          summary: "Checked.",
          ...(id === "host_key" ? { fingerprint: "SHA256:human-only" } : {}),
        })),
      };
      const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(
        Effect.succeed([
          {
            alias: "configured",
            hostname: "build.example",
            username: "deploy",
            port: 22,
            source: "ssh-config",
          },
        ]),
      );
      yield* Effect.gen(function* () {
        const layer = Layer.effect(
          SshHostSetup.SshHostSetup,
          SshHostSetup.make({
            home,
            runPreflight: (input, options) => {
              expect(input).toEqual({ host: "configured" });
              expect(options.ownerLabel).toBe("Origin");
              expect(options.runner.nodeScriptPath).toBe("/src/server.ts");
              expect(options.runner.nodeEngineRange).toBeTruthy();
              return Effect.gen(function* () {
                const crypto = yield* Crypto.Crypto;
                yield* HttpClient.HttpClient;
                expect(
                  (yield* crypto.digest("SHA-256", new Uint8Array()).pipe(Effect.orDie)).byteLength,
                ).toBe(32);
                return report;
              });
            },
          }),
        ).pipe(
          Layer.provide(probeClient),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(dependencies),
        );
        const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
        expect(
          yield* setup.preflight(
            { host: "configured" },
            { kind: "client", sessionId: probeSessionId },
          ),
        ).toEqual(report);
        expect(
          yield* setup.preflight(
            { host: "configured" },
            {
              kind: "mcp",
              scope: {
                ...invocation,
                grantedScopes: ["orchestration:read", "orchestration:operate"],
              },
            },
          ),
        ).toEqual(report);
        expect(
          yield* setup
            .preflight(
              { host: "configured" },
              {
                kind: "mcp",
                scope: { ...invocation, capabilities: new Set() },
              },
            )
            .pipe(Effect.flip),
        ).toMatchObject({ requiredScope: "orchestration:read" });
      }).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnvRecord({ GOAT_DEV_REMOTE_SERVER_ENTRY_PATH: "/src/server.ts" }),
        ),
        Effect.ensuring(Effect.sync(() => discover.mockRestore())),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preparation rejects a configured alias without managed files before dispatch", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-configured-prepare-" });
    const sshConfig =
      "Host configured\n  HostName build.example\n  User deploy\n  StrictHostKeyChecking no\n";
    yield* fs.makeDirectory(`${home}/.ssh`);
    yield* fs.writeFileString(`${home}/.ssh/config`, sshConfig);
    const layer = Layer.effect(
      SshHostSetup.SshHostSetup,
      SshHostSetup.make({
        home,
        runPreflight: () => Effect.die("Unmanaged preparation must not rely on preflight"),
      }),
    ).pipe(
      Layer.provide(
        Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
          beginSetupOperation: () => Effect.die("Unmanaged preparation started a job"),
          prepareRuntime: () => Effect.die("Unmanaged preparation installed a runtime"),
        }),
      ),
      Layer.provide(dependencies),
    );
    const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
    expect(
      yield* setup.prepare({ host: "configured" }, { kind: "mcp", scope: invocation }),
    ).toMatchObject({ kind: "error", code: "operation_failed" });
    expect(yield* fs.exists(`${home}/.ssh/goat-hosts`)).toBe(false);
    expect(yield* fs.readFileString(`${home}/.ssh/config`)).toBe(sshConfig);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([true, false])(
  "pin-only trust handles a policy-refused user (key confirmation succeeds: %s)",
  (confirmKey) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-policy-pin-" });
      const stderr = "goat-cursor-2-e25449c9: Connection closed by 100.84.150.71 port 22";
      let approving = false;
      const calls: ReadonlyArray<string>[] = [];
      const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(Effect.succeed([]));
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
          calls.push(command.args);
          if (command.args.includes("-G"))
            return makeSuccessfulProcess("hostname cursor-2\nuser ubuntu\nport 22\n");
          if (command.args.includes("-lf"))
            return makeSuccessfulProcess(`256 SHA256:${"a".repeat(43)} cursor-2 (ED25519)\n`);
          expect(command.args).toContain("PreferredAuthentications=none");
          const knownHosts = command.args
            .find((arg) => arg.startsWith("UserKnownHostsFile="))!
            .slice("UserKnownHostsFile=".length)
            .replace(/^"|"$/gu, "");
          if (!approving || confirmKey)
            yield* fs.writeFileString(knownHosts, "cursor-2 ssh-ed25519 AAAA\n");
          return {
            ...makeSuccessfulProcess(""),
            exitCode: Effect.succeed(ExitCode(255)),
            stderr: Stream.make(new TextEncoder().encode(stderr)),
          };
        }),
      );
      yield* Effect.gen(function* () {
        const layer = Layer.effect(SshHostSetup.SshHostSetup, SshHostSetup.make({ home })).pipe(
          Layer.provide(probeClient),
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: ({ args }) =>
                Effect.succeed(
                  args?.includes("-G")
                    ? processOutput(
                        `hostname cursor-2\nuser ubuntu\nport 22\nhostkeyalias goat-cursor-2-e25449c9\nuserknownhostsfile ${home}/.ssh/goat-hosts/goat-cursor-2-e25449c9.known_hosts\nglobalknownhostsfile /dev/null\nstricthostkeychecking yes\nupdatehostkeys no\nhostkeyalgorithms ssh-ed25519\nidentityfile /fixture/key\nidentitiesonly yes\n`,
                      )
                    : processOutput("", stderr, 255),
                ),
            }),
          ),
          Layer.provide(
            Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
              runtimeStatus: () => Effect.die("Pin approval attempted SSH authentication"),
              beginSetupOperation: () => Effect.die("Pin approval started setup"),
            }),
          ),
          Layer.provide(dependencies),
        );
        const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
        const probe = yield* setup.probe(
          {
            address: "cursor-2",
            user: "ubuntu",
            alias: "goat-cursor-2-e25449c9",
            identityFile: "/fixture/key",
          },
          probeSessionId,
        );
        expect(probe.human.location).toMatch(
          /^cursor-2 presented this key\. GOAT will connect as ubuntu and save it as goat-cursor-2-e25449c9\./u,
        );
        approving = true;
        const result = yield* setup.trust(
          { probeId: probe.probeId, accepted: true },
          probeSessionId,
        );
        expect(calls.filter((args) => args.includes("PreferredAuthentications=none"))).toHaveLength(
          2,
        );
        if (confirmKey) {
          expect(result).toMatchObject({
            kind: "ok",
            status: { state: "stopped", runtimeVersion: null },
          });
          expect(
            yield* fs.readFileString(`${home}/.ssh/goat-hosts/goat-cursor-2-e25449c9.known_hosts`),
          ).toBe("goat-cursor-2-e25449c9 ssh-ed25519 AAAA\n");
        } else {
          expect(result).toMatchObject({
            kind: "error",
            message: "Could not reach cursor-2 to confirm its key; Check again.",
          });
          expect(JSON.stringify(result)).not.toContain(stderr);
          expect(
            yield* fs.exists(`${home}/.ssh/goat-hosts/goat-cursor-2-e25449c9.known_hosts`),
          ).toBe(false);
        }
      }).pipe(Effect.ensuring(Effect.sync(() => discover.mockRestore())));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "managed aliases reject destination and identity conflicts before preflight or dispatch",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-alias-conflict-" });
      yield* fs.makeDirectory(`${home}/.ssh/goat-hosts`, { recursive: true });
      yield* fs.writeFileString(
        `${home}/.ssh/goat-hosts/prod.conf`,
        'Host prod\n  HostName production.example\n  User deploy\n  Port 2222\n  IdentityFile "/keys/production"\n',
      );
      yield* fs.writeFileString(
        `${home}/.ssh/goat-hosts/prod.known_hosts`,
        "prod ssh-ed25519 AAAA\n",
      );
      const effectiveSettings =
        "hostname production.example\nuser deploy\nport 2222\nidentityfile /keys/production\n";
      let effective = effectiveSettings;
      const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(Effect.succeed([]));
      yield* Effect.gen(function* () {
        const setupLayer = Layer.effect(
          SshHostSetup.SshHostSetup,
          SshHostSetup.make({
            home,
            runPreflight: () => Effect.die("Alias conflict reached preflight"),
          }),
        ).pipe(
          Layer.provide(
            Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
              beginSetupOperation: () => Effect.die("Alias conflict started preparation"),
              prepareRuntime: () => Effect.die("Alias conflict prepared a runtime"),
            }),
          ),
          Layer.provide(
            Layer.mock(ProcessRunner.ProcessRunner)({
              run: ({ args }) => {
                expect(args).toEqual(["-G", "prod"]);
                return Effect.succeed(processOutput(effective));
              },
            }),
          ),
          Layer.provide(dependencies),
        );
        const setup = Context.get(yield* Layer.build(setupLayer), SshHostSetup.SshHostSetup);
        const add = Context.get(
          yield* Layer.build(
            SshDeviceAdd.layer.pipe(
              Layer.provide(Layer.succeed(SshHostSetup.SshHostSetup, setup)),
              Layer.provide(
                Layer.mock(Broker.ConnectionCatalogBroker)({
                  invoke: () => Effect.die("Alias conflict dispatched to the catalog"),
                }),
              ),
              Layer.provide(
                Layer.mock(HubNodes.HubNodes)({
                  add: () => Effect.die("Alias conflict registered on the hub"),
                }),
              ),
              Layer.provide(dependencies),
            ),
          ),
          SshDeviceAdd.SshDeviceAdd,
        );
        const destination = {
          address: "production.example",
          user: "deploy",
          port: 2222,
          alias: "prod",
        };
        for (const override of [
          { address: "staging.example" },
          { user: "root" },
          { port: 22 },
          { port: undefined },
          { identityFile: "/keys/staging" },
        ]) {
          expect(
            yield* add
              .addDevice({ ...destination, ...override }, { kind: "mcp", scope: invocation })
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "alias_conflict" });
        }
        for (const identityFile of [undefined, "/keys/production"]) {
          expect(yield* setup.resolveDestination({ ...destination, identityFile })).toMatchObject({
            host: "prod",
            managed: true,
          });
        }
        for (const [setting, replacement] of [
          ["hostname production.example", "hostname staging.example"],
          ["user deploy", "user root"],
          ["port 2222", "port 22"],
          ["identityfile /keys/production", "identityfile /keys/staging"],
        ]) {
          effective = effectiveSettings.replace(setting!, replacement!);
          expect(
            yield* add
              .addDevice(
                { ...destination, identityFile: "/keys/production" },
                { kind: "mcp", scope: invocation },
              )
              .pipe(Effect.flip),
          ).toMatchObject({ reason: "alias_conflict" });
        }
        effective = effectiveSettings;
        yield* fs.remove(`${home}/.ssh/goat-hosts/prod.conf`);
        expect(
          yield* add.addDevice(destination, { kind: "mcp", scope: invocation }).pipe(Effect.flip),
        ).toMatchObject({ reason: "alias_conflict" });
      }).pipe(Effect.ensuring(Effect.sync(() => discover.mockRestore())));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("preflight marks GOAT's managed aliases and keeps long personal aliases encodable", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "goat-preflight-managed-" });
    const longAlias = "personal-" + "a".repeat(57);
    yield* fs.makeDirectory(home + "/.ssh/goat-hosts", { recursive: true });
    yield* fs.writeFileString(home + "/.ssh/goat-hosts/goat-box.conf", "Host goat-box\n");
    yield* fs.writeFileString(home + "/.ssh/goat-hosts/goat-box.known_hosts", "goat-box key\n");
    const reportFor = (alias: string): SshPreflightReport => ({
      host: alias,
      destination: { alias, hostname: "box.example", user: "jun", port: 22 },
      ready: true,
      steps: SSH_PREFLIGHT_STEP_ORDER.map((id) => ({ id, state: "passed", summary: "Checked." })),
    });
    const discover = vi.spyOn(SshConfig, "discoverSshHosts").mockReturnValue(
      Effect.succeed(
        ["goat-box", longAlias].map((alias) => ({
          alias,
          hostname: "box.example",
          username: "jun",
          port: 22,
          source: "ssh-config" as const,
        })),
      ),
    );
    yield* Effect.gen(function* () {
      const layer = Layer.effect(
        SshHostSetup.SshHostSetup,
        SshHostSetup.make({
          home,
          runPreflight: (input) => Effect.succeed(reportFor(input.host)),
        }),
      ).pipe(
        Layer.provide(probeClient),
        Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
        Layer.provide(dependencies),
      );
      const setup = Context.get(yield* Layer.build(layer), SshHostSetup.SshHostSetup);
      const caller = { kind: "client", sessionId: probeSessionId } as const;
      const managed = yield* setup.preflight({ host: "goat-box" }, caller);
      expect(managed.destination).toMatchObject({ alias: "goat-box", managed: true });
      const personal = yield* setup.preflight({ host: longAlias }, caller);
      expect(personal.destination.managed).toBeUndefined();
      expect((yield* encodeSshPreflightReport(personal)).destination.alias).toBe(longAlias);
    }).pipe(Effect.ensuring(Effect.sync(() => discover.mockRestore())));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "an owner-profile thread with only orchestration:read prepares an allowed pinned host",
  () =>
    Effect.gen(function* () {
      const f = yield* prepareFixture();
      expect(yield* f.setup.prepare({ host: "box" }, f.caller)).toMatchObject({
        status: { state: "preparing", phase: "uploading" },
      });
      expect(f.preparations).toEqual(["box"]);
    }),
);

it.effect.each(preparationRefusals.map(([reason, requirement]) => ({ reason, requirement })))(
  "refuses preparation when $reason",
  ({ reason, requirement }) =>
    Effect.gen(function* () {
      const f = yield* prepareFixture(reason);
      const denied = yield* f.setup.prepare({ host: "box" }, f.caller).pipe(Effect.flip);
      expect(denied.message).toContain(requirement);
      expect(denied.message).toContain(
        "Ask a person to open Settings → Connections and press Retry on box (or Update runtime when it offers one)",
      );
      expect(f.preparations).toEqual([]);
    }),
);

it.effect.each(["revoke", "revoke-credential"] as const)(
  "%s between admission and job execution stops preparation",
  (reason) =>
    Effect.gen(function* () {
      const f = yield* prepareFixture(reason);
      const result = yield* f.setup.prepare({ host: "box" }, f.caller);
      expect(result).toMatchObject({
        status: { state: "failed", failure: { reason: "authorization_revoked" } },
      });
      expect(result.status?.detail).toContain(
        reason === "revoke" ? "hub.manage" : "Credential revoked",
      );
      expect(result.status?.failure?.fix.instruction).toContain("Retry on box");
      expect(f.preparations).toEqual([]);
    }),
);

it.effect.each(["client", "mcp"] as const)(
  "a non-thread %s without environment:maintain cannot prepare a pinned host",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* prepareFixture();
      expect(
        yield* f.setup
          .prepare(
            { host: "box" },
            kind === "client"
              ? { kind, sessionId: AuthSessionId.make("unprivileged") }
              : { kind, scope: { ...f.caller.scope, thread: undefined } },
          )
          .pipe(Effect.flip),
      ).toMatchObject({ requiredScope: "environment:maintain" });
      expect(f.preparations).toEqual([]);
    }),
);
