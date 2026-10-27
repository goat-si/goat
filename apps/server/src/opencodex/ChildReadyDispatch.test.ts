import { expect, it } from "@effect/vitest";
import {
  type ChildReadyResult,
  type ChildSetupBinding,
  EnvironmentId,
  OpenCodexChildSetup,
  OrchestratorMcpFailure,
  ProviderInstanceId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import { SshRemoteDispatchError, type SshHostToolCall } from "../sshRemote/SshRemoteDispatch.ts";
import * as ReadyDispatch from "./ChildReadyDispatch.ts";

// Production prepare/complete against a Child protocol double with contract-shaped answers. The
// revision mismatch is a concurrent Child settings edit at its CAS boundary, not an assumption
// about how Home numbers revisions; Deferreds hold a reply in flight.
const decodeSetup = Schema.decodeSync(OpenCodexChildSetup);
const decodeMcpFailure = Schema.decodeSync(OrchestratorMcpFailure);
const encodeMcpFailure = Schema.encodeSync(OrchestratorMcpFailure);

const fixture = Effect.fn("ChildReadyDispatch.test.fixture")(function* (
  options: {
    linkId?: string;
    staleAt?: string;
    pauseAt?: string;
    wrongAddressAt?: string;
    transportFailureAt?: string;
    proofLinkId?: string;
  } = {},
) {
  const home = EnvironmentId.make("r2-home");
  const child = EnvironmentId.make("r2-child");
  const binding: ChildSetupBinding = {
    purpose: "opencodex-child-setup",
    homeEnvironmentId: home,
    destinationEnvironmentId: child,
    operationId: "r2-operation",
    grantId: "r2-consent",
    grantRevision: 4,
  };
  const consent = yield* Ref.make(true);
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const cleanup = yield* Ref.make(0);
  const steps: Array<string> = [];
  const calls: Array<SshHostToolCall> = [];
  let sequence = 8;
  const setup = (ready = false) =>
    decodeSetup({
      version: 1,
      operationId: binding.operationId,
      destinationEnvironmentId: child,
      homeEnvironmentId: home,
      instanceId: ProviderInstanceId.make("r2-instance"),
      revision: { epoch: "r2-epoch", sequence },
      steps: [],
      readiness: ready ? "ready" : "linked",
      attribution: ready ? "home_zero_local_accounts" : "unproven",
      nextAction: "none",
      ...(ready
        ? {
            proof: {
              version: 1,
              operationId: binding.operationId,
              destinationEnvironmentId: child,
              homeEnvironmentId: home,
              instanceId: "r2-instance",
              configFingerprint: "r2-config",
              executablePath: "/fixture/codex",
              executableVersion: "1.0.0",
              linkId: options.proofLinkId ?? "r2-link",
              listenerInstanceId: "r2-listener",
              settingsDigest: "settings",
              catalogDigest: "catalog",
              model: "fixture-model",
              completedAt: 1,
              expiresAt: 86_400_001,
              attribution: "home_zero_local_accounts",
              localAccountsDigest: "zero-local",
            },
          }
        : {}),
    });
  const admission = ReadyDispatch.makeAdmission(
    binding,
    "approval-required",
    Ref.get(consent).pipe(
      Effect.map((enabled) => ({
        enabled,
        grantId: binding.grantId,
        grantRevision: binding.grantRevision,
      })),
    ),
    Ref.update(cleanup, (n) => n + 1),
    (step) => steps.push(step),
  );
  const dispatch = ReadyDispatch.make({
    callHostTool: (call, beforeSend) =>
      Effect.gen(function* () {
        yield* beforeSend;
        calls.push(call);
        expect(call.environmentId).toBe(child);
        expect(call.childSetupPurpose?.destinationEnvironmentId ?? child).toBe(child);
        const action = call.tool === "goat_hub_child_status" ? "status" : call.arguments.action;
        if (action === options.pauseAt) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        if (action === options.transportFailureAt)
          return yield* new SshRemoteDispatchError({
            reason: "host_unavailable",
            message: "The Child disconnected.",
          });
        const destination =
          action === options.wrongAddressAt ? EnvironmentId.make("another-child") : child;
        if (action === "installOpenCodex" || action === "startOpenCodex")
          return {
            kind: "prelink",
            destinationEnvironmentId: destination,
            homeEnvironmentId: home,
            operationId: binding.operationId,
            step: "opencodex_running",
            healthy: true,
            version: "2.92.0",
          } satisfies ChildReadyResult;
        if (action === "status" || action === "opencodexHealth")
          return {
            kind: "device",
            destinationEnvironmentId: destination,
            homeEnvironmentId: home,
            healthy: true,
            revision: { epoch: "r2-epoch", sequence },
            device: {
              platform: "linux",
              arch: "x64",
              ocx: { path: "/fixture/ocx", version: "2.92.0", ownership: "managed" },
              connection: { role: "client", linkId: options.linkId ?? "r2-link" },
            },
          } satisfies ChildReadyResult;
        if (action === options.staleAt) sequence += 10;
        if (
          JSON.stringify(call.arguments.expectedRevision) !==
          JSON.stringify({ epoch: "r2-epoch", sequence })
        )
          return {
            kind: "error",
            failure: {
              code: "stale_configuration",
              step: "instance_routed",
              retryable: true,
              message: "Configuration changed on the Child.",
            },
          } satisfies ChildReadyResult;
        sequence += 2;
        return {
          kind: "ok",
          setup: { ...setup(action === "probe"), destinationEnvironmentId: destination },
        } satisfies ChildReadyResult;
      }),
  });
  return {
    dispatch,
    admission,
    home,
    child,
    calls,
    steps,
    entered,
    release,
    consent,
    cleanup: Ref.get(cleanup),
    prepare: () => dispatch.prepare("r2-alias", home, admission),
    complete: () => dispatch.complete("r2-alias", home, admission, "r2-link"),
    run: (entry: "prepare" | "complete") =>
      entry === "prepare"
        ? dispatch.prepare("r2-alias", home, admission).pipe(Effect.asVoid)
        : dispatch.complete("r2-alias", home, admission, "r2-link").pipe(Effect.asVoid),
  };
});
const failureOf = (error: unknown) => ReadyDispatch.toChildReadyFailure(error, "goat_available");

it.effect("finishes a linked Child using each returned revision and a fresh catalog phase", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const ready = yield* f.complete();
    expect(ready.readiness).toBe("ready");
    expect(ready.proof?.linkId).toBe("r2-link");
    expect(f.calls.map((call) => call.arguments.expectedRevision)).toEqual([
      undefined,
      { epoch: "r2-epoch", sequence: 8 },
      { epoch: "r2-epoch", sequence: 10 },
      { epoch: "r2-epoch", sequence: 12 },
      { epoch: "r2-epoch", sequence: 14 },
    ]);
    const phases = f.calls.map((call) => call.childSetupPurpose);
    expect(phases.map((purpose) => purpose?.phase)).toEqual([
      "installCodex",
      "installCodex",
      "catalogConfigureProbe",
      "catalogConfigureProbe",
      "catalogConfigureProbe",
    ]);
    expect(phases[0]?.phaseId).not.toBe(phases[2]?.phaseId);
    expect(f.calls[0]?.writes).toBe(false);
  }),
);

it.effect("refuses a different post-link device before installing Codex", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ linkId: "another-link" });
    const result = yield* f.complete().pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(failureOf(result.failure)).toMatchObject({
        code: "link_changed",
        step: "link_established",
      });
    expect(f.calls.filter((call) => call.writes)).toHaveLength(0);
  }),
);

it.effect("stops on a Child revision mismatch without configuring or probing again", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ staleAt: "configure" });
    const result = yield* f.complete().pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(failureOf(result.failure)).toMatchObject({
        code: "stale_configuration",
        step: "instance_routed",
      });
    expect(f.calls.some((call) => call.arguments.action === "probe")).toBe(false);
  }),
);

it.effect("Home refuses to issue the next phase after consent is disabled", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* Ref.set(f.consent, false);
    const result = yield* f.complete().pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(failureOf(result.failure)).toMatchObject({
        code: "setup_approval_revoked",
        step: "codex_installed",
      });
    expect(f.calls).toHaveLength(0);
    expect(yield* f.cleanup).toBe(1);
  }),
);

it.effect("Home rejects an in-flight reply that completes after consent revocation", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ pauseAt: "installCodex" });
    const pending = yield* Effect.forkChild(f.complete().pipe(Effect.result));
    yield* Deferred.await(f.entered);
    yield* Ref.set(f.consent, false);
    yield* Deferred.succeed(f.release, undefined);
    const result = yield* Fiber.join(pending);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(failureOf(result.failure)).toMatchObject({
        code: "setup_approval_revoked",
        step: "codex_installed",
      });
    expect(f.calls.some((call) => call.arguments.action === "syncCatalog")).toBe(false);
    expect(yield* f.cleanup).toBe(1);
    // The Home can record where setup stopped when revocation arrives from outside.
    expect(f.steps.at(-1)).toBe("codex_installed");
  }),
);

it("preserves setup failure reasons through the existing MCP error contract", () => {
  for (const code of [
    "destination_changed",
    "link_changed",
    "stale_configuration",
    "purpose_expired",
    "phase_timeout",
    "setup_approval_revoked",
    "setup_approval_stale",
  ] as const) {
    const failure = ReadyDispatch.toMcpFailure({
      code,
      step: "inference_verified",
      message: "Setup refused at the active step.",
      retryable: false,
    });
    const decoded = decodeMcpFailure(encodeMcpFailure(failure));
    expect(decoded.reason).toBe(code);
  }
});

it.effect("reports inference_verified when the completed proof belongs to another link", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ proofLinkId: "another-link" });
    const result = yield* f.complete().pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(failureOf(result.failure)).toMatchObject({
        code: "route_unverified",
        step: "inference_verified",
      });
  }),
);

const activeSteps = [
  ["installOpenCodex", "opencodex_running", "prepare"],
  ["startOpenCodex", "opencodex_running", "prepare"],
  ["opencodexHealth", "opencodex_running", "prepare"],
  ["status", "link_established", "complete"],
  ["installCodex", "codex_installed", "complete"],
  ["syncCatalog", "instance_routed", "complete"],
  ["configure", "instance_routed", "complete"],
  ["probe", "inference_verified", "complete"],
] as const;
const boundaryCases = activeSteps.flatMap(([action, step, entry]) =>
  (["phaseDeadline", "expiresAt"] as const).map(
    (boundary) => [action, step, entry, boundary] as const,
  ),
);

it.effect.each(activeSteps)(
  "reports %s at step %s when it answers for another destination",
  ([action, step, entry]) =>
    Effect.gen(function* () {
      const f = yield* fixture({ wrongAddressAt: action });
      const result = yield* f.run(entry).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(failureOf(result.failure)).toMatchObject({ code: "destination_changed", step });
      expect(f.calls.at(-1)?.arguments.action ?? "status").toBe(action);
    }),
);

it.effect.each(activeSteps)(
  "reports %s at step %s when it loses its transport",
  ([action, step, entry]) =>
    Effect.gen(function* () {
      const f = yield* fixture({ transportFailureAt: action });
      const result = yield* f.run(entry).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(failureOf(result.failure)).toMatchObject({ code: "unreachable", step });
      expect(f.calls.at(-1)?.arguments.action ?? "status").toBe(action);
    }),
);

it.effect.each(boundaryCases)(
  "reports %s at step %s when it replies at its %s",
  ([action, step, entry, boundary]) =>
    Effect.gen(function* () {
      const f = yield* fixture({ pauseAt: action });
      const pending = yield* Effect.forkChild(f.run(entry).pipe(Effect.result));
      yield* Deferred.await(f.entered);
      const purpose = f.calls.at(-1)?.childSetupPurpose;
      if (purpose === undefined) return yield* Effect.die("Expected the request's setup purpose");
      yield* TestClock.setTime(purpose[boundary]);
      yield* Deferred.succeed(f.release, undefined);
      const result = yield* Fiber.join(pending);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(failureOf(result.failure)).toMatchObject({
          code: boundary === "expiresAt" ? "purpose_expired" : "phase_timeout",
          step,
          retryable: true,
        });
      expect(f.calls.at(-1)?.arguments.action ?? "status").toBe(action);
    }),
);

it.effect("reports link_established when a post-link status read loses its transport", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ transportFailureAt: "status" });
    const result = yield* f.dispatch
      .status(
        "r2-alias",
        { destinationEnvironmentId: f.child, homeEnvironmentId: f.home },
        f.admission,
      )
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(failureOf(result.failure)).toMatchObject({
        code: "unreachable",
        step: "link_established",
      });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.childSetupPurpose).toBeUndefined();
  }),
);
