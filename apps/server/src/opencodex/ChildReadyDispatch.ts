import {
  type ChildReadyAddress,
  ChildReadyFailure,
  ChildReadyFailureCode,
  type ChildReadyPrepareInput,
  type ChildReadyRevision,
  type ChildReadyStep,
  type ChildSetupBinding,
  type ChildSetupPhase,
  type ChildSetupPurpose,
  childSetupPurposeAllowsAction,
  childSetupPurposeIsLive,
  decodeChildReadyResult,
  type EnvironmentId,
  makeChildSetupPurpose,
  OrchestratorMcpFailure,
  type RuntimeMode,
} from "@goat/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- phase ids are random identifiers, not secrets.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as Dispatch from "../sshRemote/SshRemoteDispatch.ts";

/**
 * The Home's standing consent for one setup operation. `authorize` reads it fresh (SSH opt-in or
 * cloud auto-join generation) before each phase is issued, before each send and after each reply.
 */
export interface ChildSetupAdmission {
  readonly binding: ChildSetupBinding;
  readonly runtimeMode: RuntimeMode;
  readonly authorize: Effect.Effect<void, OrchestratorMcpFailure>;
  /** Told the step each Child call works on, so a revocation records where setup stopped. */
  readonly enterStep: (step: ChildReadyStep) => void;
}

const isFailureCode = Schema.is(ChildReadyFailureCode);
const RETRYABLE: ReadonlySet<string> = new Set(["purpose_expired", "phase_timeout"]);

/** A refused or changed consent closes admission and revokes the operation's Child sessions. */
export const makeAdmission = (
  binding: ChildSetupBinding,
  runtimeMode: RuntimeMode,
  current: Effect.Effect<
    { readonly enabled: boolean; readonly grantId: string; readonly grantRevision: number },
    OrchestratorMcpFailure
  >,
  revoke: Effect.Effect<void, OrchestratorMcpFailure>,
  enterStep: (step: ChildReadyStep) => void = () => undefined,
): ChildSetupAdmission => ({
  binding,
  runtimeMode,
  enterStep,
  authorize: Effect.gen(function* () {
    const state = yield* current.pipe(Effect.result);
    const code =
      state._tag === "Failure" || !state.success.enabled
        ? "setup_approval_revoked"
        : state.success.grantId !== binding.grantId ||
            state.success.grantRevision !== binding.grantRevision
          ? "setup_approval_stale"
          : undefined;
    if (code === undefined) return;
    yield* revoke.pipe(
      Effect.catch(() =>
        Effect.logWarning("Child setup session cleanup failed; Home admission stays closed."),
      ),
    );
    return yield* new OrchestratorMcpFailure({
      code: "orchestration_error",
      reason: code,
      message:
        code === "setup_approval_revoked"
          ? "Child setup approval was revoked."
          : "Child setup approval changed.",
    });
  }),
});

/** A setup failure with the step it stopped at; the Home records both. */
export class ChildReadyDispatchFailure extends Schema.TaggedError<ChildReadyDispatchFailure>()(
  "ChildReadyDispatchFailure",
  { failure: ChildReadyFailure },
) {
  override get message() {
    return this.failure.message;
  }
}
const isDispatchFailure = Schema.is(ChildReadyDispatchFailure);
const isMcpFailure = Schema.is(OrchestratorMcpFailure);

/** The same failure on the existing MCP error contract, for hub.device_setup's callers. */
export const toMcpFailure = (failure: ChildReadyFailure) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    reason: failure.code,
    message: failure.message,
  });

const reasonOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "reason" in error
    ? (error as { readonly reason: unknown }).reason
    : undefined;

/**
 * Any failure as a setup failure at the active step. A Child-supplied failure keeps its own step;
 * a transport refusal from the Child's tool admission is permission_denied, never Ready.
 */
export const toChildReadyFailure = (error: unknown, step: ChildReadyStep): ChildReadyFailure => {
  if (isDispatchFailure(error)) return error.failure;
  const reason = reasonOf(error);
  const code = isFailureCode(reason)
    ? reason
    : reason === "remote_refused"
      ? "permission_denied"
      : "unreachable";
  return {
    code,
    step,
    message:
      isMcpFailure(error) && isFailureCode(reason)
        ? error.message
        : code === "permission_denied"
          ? "The Child refused the setup request."
          : code === "remote_outdated"
            ? "Update GOAT on this Child, then continue setup."
            : "The Child did not answer the setup request.",
    retryable: RETRYABLE.has(code) || code === "stale_configuration" || code === "unreachable",
  };
};

const refuse = (code: ChildReadyFailure["code"], step: ChildReadyStep, message: string) =>
  Effect.fail(
    new ChildReadyDispatchFailure({
      failure: {
        code,
        step,
        message,
        retryable: RETRYABLE.has(code) || code === "stale_configuration",
      },
    }),
  );
const atStep = (step: ChildReadyStep) =>
  Effect.mapError(
    (error: unknown) =>
      new ChildReadyDispatchFailure({ failure: toChildReadyFailure(error, step) }),
  );
const PHASE_CALL_MS: Record<ChildReadyPrepareInput["action"] | "status", number> = {
  installOpenCodex: 15 * 60_000,
  startOpenCodex: 100_000,
  opencodexHealth: 70_000,
  installCodex: 15 * 60_000,
  syncCatalog: 70_000,
  configure: 70_000,
  probe: 70_000,
  status: 70_000,
};

export const make = (dispatch: Pick<Dispatch.SshRemoteDispatch["Service"], "callHostTool">) => {
  const assertHome = (home: EnvironmentId, admission: ChildSetupAdmission, step: ChildReadyStep) =>
    home === admission.binding.homeEnvironmentId
      ? Effect.void
      : refuse("destination_changed", step, "The Home changed before Child setup.");
  /** Each phase gets a fresh purpose and bearer, with its own deadline plus five minutes. */
  const beginPhase = Effect.fn("ChildReadyDispatch.beginPhase")(function* (
    admission: ChildSetupAdmission,
    phase: ChildSetupPhase,
    step: ChildReadyStep,
  ) {
    admission.enterStep(step);
    yield* admission.authorize.pipe(atStep(step));
    return makeChildSetupPurpose(
      admission.binding,
      phase,
      NodeCrypto.randomUUID(),
      yield* Clock.currentTimeMillis,
    );
  });
  const assertPhase = Effect.fn("ChildReadyDispatch.assertPhase")(function* (
    admission: ChildSetupAdmission,
    purpose: ChildSetupPurpose,
    step: ChildReadyStep,
  ) {
    // Revoked consent takes precedence over a late reply's timeout.
    yield* admission.authorize.pipe(atStep(step));
    const now = yield* Clock.currentTimeMillis;
    if (now >= purpose.expiresAt)
      return yield* refuse("purpose_expired", step, "A setup step timed out. Retry setup.");
    if (!childSetupPurposeIsLive(purpose, now))
      return yield* refuse("permission_denied", step, "The setup purpose is invalid.");
    if (now >= purpose.phaseDeadline)
      return yield* refuse("phase_timeout", step, "A setup step timed out. Retry setup.");
  });
  const callChild = Effect.fn("ChildReadyDispatch.callChild")(function* (
    alias: string,
    admission: ChildSetupAdmission,
    purpose: ChildSetupPurpose,
    action: ChildReadyPrepareInput["action"] | "status",
    step: ChildReadyStep,
    expectedRevision?: ChildReadyRevision,
  ) {
    admission.enterStep(step);
    yield* assertPhase(admission, purpose, step);
    if (!childSetupPurposeAllowsAction(purpose, action))
      return yield* refuse(
        "permission_denied",
        step,
        "This purpose does not authorize this setup action.",
      );
    const { destinationEnvironmentId, homeEnvironmentId, operationId } = purpose;
    const remaining = purpose.phaseDeadline - (yield* Clock.currentTimeMillis);
    const answer = yield* dispatch
      .callHostTool(
        {
          host: alias,
          environmentId: destinationEnvironmentId,
          tool: action === "status" ? "goat_hub_child_status" : "goat_hub_child_prepare",
          arguments:
            action === "status"
              ? { destinationEnvironmentId, homeEnvironmentId }
              : {
                  destinationEnvironmentId,
                  homeEnvironmentId,
                  operationId,
                  action,
                  ...(expectedRevision === undefined ? {} : { expectedRevision }),
                },
          writes: action !== "status" && action !== "opencodexHealth",
          childSetupPurpose: purpose,
          timeoutMs: Math.max(1, Math.min(remaining, PHASE_CALL_MS[action])),
        },
        assertPhase(admission, purpose, step).pipe(Effect.as(admission.runtimeMode)),
      )
      .pipe(Effect.result);
    yield* assertPhase(admission, purpose, step);
    if (answer._tag === "Failure")
      return yield* new ChildReadyDispatchFailure({
        failure: toChildReadyFailure(answer.failure, step),
      });
    const decoded = yield* decodeChildReadyResult(answer.success).pipe(
      Effect.mapError(
        () =>
          new ChildReadyDispatchFailure({
            failure: {
              code: "remote_outdated",
              step,
              message: "Update GOAT on this Child, then continue setup.",
              retryable: false,
            },
          }),
      ),
    );
    if (decoded.kind === "error")
      return yield* new ChildReadyDispatchFailure({ failure: decoded.failure });
    const address = decoded.kind === "ok" ? decoded.setup : decoded;
    if (
      address.destinationEnvironmentId !== destinationEnvironmentId ||
      address.homeEnvironmentId !== homeEnvironmentId ||
      (action !== "status" && address.operationId !== operationId)
    )
      return yield* refuse(
        "destination_changed",
        step,
        "Child setup answered for another destination or operation.",
      );
    return decoded;
  });

  /** Before membership: install, start, then the typed device health the link gate needs. */
  const prepare = Effect.fn("ChildReadyDispatch.prepare")(function* (
    alias: string,
    home: EnvironmentId,
    admission: ChildSetupAdmission,
  ) {
    yield* assertHome(home, admission, "opencodex_running");
    const install = yield* beginPhase(admission, "installOpenCodex", "opencodex_running");
    const installed = yield* callChild(
      alias,
      admission,
      install,
      "installOpenCodex",
      "opencodex_running",
    );
    if (installed.kind !== "prelink")
      return yield* refuse(
        "remote_outdated",
        "opencodex_running",
        "This Child does not support typed OpenCodex installation.",
      );
    const start = yield* beginPhase(admission, "startOpenCodex", "opencodex_running");
    const started = yield* callChild(
      alias,
      admission,
      start,
      "startOpenCodex",
      "opencodex_running",
    );
    if (started.kind !== "prelink" || !started.healthy)
      return yield* refuse(
        "startup_failed",
        "opencodex_running",
        "OpenCodex did not start on this Child.",
      );
    const device = yield* callChild(
      alias,
      admission,
      start,
      "opencodexHealth",
      "opencodex_running",
    );
    if (device.kind !== "device")
      return yield* refuse("remote_outdated", "opencodex_running", "Update GOAT on this Child.");
    if (!device.healthy || device.device.ocx.path === null)
      return yield* refuse(
        "startup_failed",
        "opencodex_running",
        "OpenCodex is installed but not healthy on this Child.",
      );
    return device;
  });

  /**
   * After the Home's link add: confirm the Child is a client of exactly that link, then install
   * Codex, sync its catalog, route it and prove one request, passing each returned revision on.
   */
  const complete = Effect.fn("ChildReadyDispatch.complete")(function* (
    alias: string,
    home: EnvironmentId,
    admission: ChildSetupAdmission,
    expectedLinkId: string,
  ) {
    yield* assertHome(home, admission, "link_established");
    const install = yield* beginPhase(admission, "installCodex", "codex_installed");
    const device = yield* callChild(alias, admission, install, "status", "link_established");
    if (device.kind !== "device")
      return yield* refuse("remote_outdated", "link_established", "Update GOAT on this Child.");
    if (
      !device.healthy ||
      device.device.connection.role !== "client" ||
      device.device.connection.linkId !== expectedLinkId
    )
      return yield* refuse(
        "link_changed",
        "link_established",
        "The Child is no longer linked to this Home link.",
      );
    const installed = yield* callChild(
      alias,
      admission,
      install,
      "installCodex",
      "codex_installed",
      device.revision,
    );
    if (installed.kind !== "ok")
      return yield* refuse(
        "remote_outdated",
        "codex_installed",
        "Child installation metadata is unsupported.",
      );
    let setup = installed.setup;
    const finish = yield* beginPhase(admission, "catalogConfigureProbe", "instance_routed");
    for (const action of ["syncCatalog", "configure", "probe"] as const) {
      const step = action === "probe" ? "inference_verified" : "instance_routed";
      const result = yield* callChild(alias, admission, finish, action, step, setup.revision);
      if (result.kind !== "ok")
        return yield* refuse("remote_outdated", step, "Child setup metadata is unsupported.");
      setup = result.setup;
    }
    if (
      setup.readiness !== "ready" ||
      setup.proof === undefined ||
      setup.proof.linkId !== expectedLinkId
    )
      return yield* refuse(
        "route_unverified",
        "inference_verified",
        "The Child did not return a matching inference proof.",
      );
    return setup;
  });

  /** A non-billed read of the Child's device state and setup, under ordinary read authority. */
  const status = Effect.fn("ChildReadyDispatch.status")(function* (
    alias: string,
    address: ChildReadyAddress,
    admission: {
      readonly runtimeMode: RuntimeMode;
      readonly authorize: Effect.Effect<void, OrchestratorMcpFailure>;
    },
  ) {
    const step = "link_established" as const;
    yield* admission.authorize.pipe(atStep(step));
    const result = yield* dispatch
      .callHostTool(
        {
          host: alias,
          environmentId: address.destinationEnvironmentId,
          tool: "goat_hub_child_status",
          arguments: { ...address },
          writes: false,
          requireReady: true,
          timeoutMs: PHASE_CALL_MS.status,
        },
        admission.authorize.pipe(atStep(step), Effect.as(admission.runtimeMode)),
      )
      .pipe(Effect.result);
    yield* admission.authorize.pipe(atStep(step));
    if (result._tag === "Failure")
      return yield* new ChildReadyDispatchFailure({
        failure: toChildReadyFailure(result.failure, step),
      });
    const decoded = yield* decodeChildReadyResult(result.success).pipe(
      Effect.mapError(
        () =>
          new ChildReadyDispatchFailure({
            failure: {
              code: "remote_outdated",
              step,
              message: "Update GOAT on this Child, then continue setup.",
              retryable: false,
            },
          }),
      ),
    );
    if (decoded.kind === "error")
      return yield* new ChildReadyDispatchFailure({ failure: decoded.failure });
    if (decoded.kind !== "device")
      return yield* refuse("remote_outdated", step, "Typed device status is required.");
    if (
      decoded.destinationEnvironmentId !== address.destinationEnvironmentId ||
      decoded.homeEnvironmentId !== address.homeEnvironmentId
    )
      return yield* refuse(
        "destination_changed",
        step,
        "Child status answered for another destination.",
      );
    return decoded;
  });
  return { prepare, complete, status };
};

export class ChildReadyDispatch extends Context.Service<
  ChildReadyDispatch,
  ReturnType<typeof make>
>()("goat/opencodex/ChildReadyDispatch") {}

export const layer = Layer.effect(
  ChildReadyDispatch,
  Effect.gen(function* () {
    return make(yield* Dispatch.SshRemoteDispatch);
  }),
);
