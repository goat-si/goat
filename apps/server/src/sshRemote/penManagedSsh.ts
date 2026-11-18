import { SshInvalidTargetError, SshLaunchError } from "@goat/ssh/errors";
import { SshEnvironmentManager, type SshEnvironmentManagerShape } from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import {
  ExpectedPenRoute,
  PenManagedRoutes,
  type PenManagedRoutesShape,
} from "../hubNodes/PenManagedRoutes.ts";

const existingRuntimeRequired = () =>
  new SshLaunchError({
    reason: "existing-runtime-required",
    message: "A Pen machine can only use an existing GOAT runtime.",
    stdout: "",
  });

/**
 * For an alias Pen manages, every operation that opens ssh is admitted first, runs existing-only,
 * and signs in as a Pen member; setup is refused. Other aliases pass through untouched. Read at
 * each call, so an alias becomes guarded the moment it is held. A caller that read a Pen binding
 * with its route (ExpectedPenRoute) is refused unless that alias is still held for that key.
 */
export const guardPenManaged = (
  manager: SshEnvironmentManagerShape,
  routes: PenManagedRoutesShape,
): SshEnvironmentManagerShape => {
  const whenManaged = Effect.fn("guardPenManaged.whenManaged")(function* <A, E, R, A2, E2, R2>(
    alias: string,
    managed: Effect.Effect<A, E, R>,
    plain: Effect.Effect<A2, E2, R2>,
  ): Effect.fn.Return<A | A2, E | E2 | SshInvalidTargetError, R | R2> {
    const expected = yield* ExpectedPenRoute;
    if (expected === undefined) return yield* routes.isManaged(alias) ? managed : plain;
    const held = routes.isManaged(alias) ? routes.binding(alias) : undefined;
    if (
      held?.meshId !== expected.meshId ||
      held.nodeId !== expected.nodeId ||
      held.noisePub !== expected.noisePub
    )
      return yield* new SshInvalidTargetError({
        message: `${alias} is no longer the Pen machine it was listed as.`,
      });
    return yield* managed;
  });
  const admitted = <A, E, R>(alias: string, use: Effect.Effect<A, E, R>) =>
    whenManaged(alias, routes.admit(alias).pipe(Effect.andThen(use)), use);
  const {
    existingEnvironment,
    existingEnvironmentOther,
    issueExistingMcpSession,
    revokeExistingMcpSession,
    provisionedRuntimeExecutable,
  } = manager;
  return {
    ...manager,
    // The manager's optional methods stay absent when it has none.
    ...(existingEnvironment === undefined
      ? {}
      : {
          existingEnvironment: (target, environmentId) =>
            admitted(target.alias, existingEnvironment(target, environmentId)),
        }),
    ...(existingEnvironmentOther === undefined
      ? {}
      : {
          existingEnvironmentOther: (target, current) =>
            admitted(target.alias, existingEnvironmentOther(target, current)).pipe(
              Effect.catchTags({
                SshInvalidTargetError: () => Effect.succeed({ kind: "unavailable" as const }),
              }),
            ),
        }),
    ...(issueExistingMcpSession === undefined
      ? {}
      : {
          issueExistingMcpSession: (target, environmentId, options) =>
            admitted(target.alias, issueExistingMcpSession(target, environmentId, options)),
        }),
    ...(revokeExistingMcpSession === undefined
      ? {}
      : {
          revokeExistingMcpSession: (target, environmentId, sessionId) =>
            admitted(target.alias, revokeExistingMcpSession(target, environmentId, sessionId)),
        }),
    ...(provisionedRuntimeExecutable === undefined
      ? {}
      : {
          provisionedRuntimeExecutable: (target) =>
            admitted(target.alias, provisionedRuntimeExecutable(target)),
        }),
    // Forgetting clears what this machine holds even when Pen cannot vouch, but never stops the
    // runtime: GOAT only attaches to a Pen machine's GOAT.
    forgetEnvironment: (target, options) =>
      Effect.flatMap(ExpectedPenRoute, (expected) =>
        manager.forgetEnvironment(
          target,
          expected !== undefined || routes.isManaged(target.alias)
            ? { ...options, stopRuntime: "no" }
            : options,
        ),
      ),
    status: (target) => admitted(target.alias, manager.status(target)),
    readyEnvironment: (target) => admitted(target.alias, manager.readyEnvironment(target)),
    runRemoteScript: (target, input) =>
      admitted(target.alias, manager.runRemoteScript(target, input)),
    ensureEnvironment: (target, options) =>
      whenManaged(
        target.alias,
        routes.admit(target.alias).pipe(
          Effect.flatMap(() => {
            if (options?.refreshRuntime || options?.confirmReplacement || options?.forceReplace)
              return Effect.fail(existingRuntimeRequired());
            return manager.ensureEnvironment(target, { ...options, installation: "existing-only" });
          }),
        ),
        Effect.suspend(() => manager.ensureEnvironment(target, options)),
      ),
    beginSetupOperation: (target, operationId) =>
      whenManaged(
        target.alias,
        Effect.fail(existingRuntimeRequired()),
        Effect.suspend(() => manager.beginSetupOperation(target, operationId)),
      ),
    issueClientSession: (target, options) =>
      whenManaged(
        target.alias,
        routes.admit(target.alias).pipe(
          Effect.flatMap(({ selfNodeId }) => {
            const { subject: _subject, penMember: _penMember, ...rest } = options;
            return manager.issueClientSession(target, {
              ...rest,
              penMember: selfNodeId,
              installation: "existing-only",
            });
          }),
        ),
        Effect.suspend(() => manager.issueClientSession(target, options)),
      ),
    issueMcpClientSession: (target, options) =>
      whenManaged(
        target.alias,
        routes
          .admit(target.alias)
          .pipe(
            Effect.flatMap(() =>
              manager.issueMcpClientSession(target, { ...options, installation: "existing-only" }),
            ),
          ),
        Effect.suspend(() => manager.issueMcpClientSession(target, options)),
      ),
  };
};

/**
 * The SSH manager dispatch uses, guarded for the aliases Pen manages, and those routes. Dispatch
 * registers a cleanup that fails while a Pen alias's tunnel is still open, so it stays blocked.
 */
export const guardedSshManager = Effect.gen(function* () {
  const penRoutes = yield* PenManagedRoutes;
  return { manager: guardPenManaged(yield* SshEnvironmentManager, penRoutes), penRoutes };
});

export const aliasOnlyTarget = (alias: string) => ({
  alias,
  hostname: alias,
  username: null,
  port: null,
});

/** A Pen alias's cleanup: forget it, then close its tunnel, failing while that stays open. */
export const closeStrictly =
  <E>(
    forget: (alias: string, disconnect: false) => Effect.Effect<void>,
    disconnect: (alias: string) => Effect.Effect<void, E>,
  ) =>
  (alias: string) =>
    Effect.andThen(forget(alias, false), disconnect(alias));
