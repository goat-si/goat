import { SshLaunchError } from "@goat/ssh/errors";
import type { SshEnvironmentManagerShape } from "@goat/ssh/tunnel";
import * as Effect from "effect/Effect";
import type { PenManagedRoutesShape } from "../hubNodes/PenManagedRoutes.ts";

const existingRuntimeRequired = () =>
  new SshLaunchError({
    reason: "existing-runtime-required",
    message: "A Pen machine can only use an existing GOAT runtime.",
    stdout: "",
  });

/**
 * For an alias Pen manages, every operation that opens ssh is admitted first, runs existing-only,
 * and signs in as a Pen member; setup is refused. Other aliases pass through untouched. Read at
 * each call, so an alias becomes guarded the moment it is held.
 */
export const guardPenManaged = (
  manager: SshEnvironmentManagerShape,
  routes: PenManagedRoutesShape,
): SshEnvironmentManagerShape => {
  const admitted = <A, E, R>(alias: string, use: Effect.Effect<A, E, R>) =>
    Effect.suspend(() =>
      routes.isManaged(alias) ? routes.admit(alias).pipe(Effect.andThen(use)) : use,
    );
  return {
    ...manager,
    status: (target) => admitted(target.alias, manager.status(target)),
    readyEnvironment: (target) => admitted(target.alias, manager.readyEnvironment(target)),
    runRemoteScript: (target, input) =>
      admitted(target.alias, manager.runRemoteScript(target, input)),
    ensureEnvironment: (target, options) =>
      Effect.suspend(() => {
        if (!routes.isManaged(target.alias)) return manager.ensureEnvironment(target, options);
        return routes.admit(target.alias).pipe(
          Effect.flatMap(() => {
            if (options?.refreshRuntime || options?.confirmReplacement || options?.forceReplace)
              return Effect.fail(existingRuntimeRequired());
            return manager.ensureEnvironment(target, { ...options, installation: "existing-only" });
          }),
        );
      }),
    beginSetupOperation: (target, operationId) =>
      Effect.suspend(() =>
        routes.isManaged(target.alias)
          ? Effect.fail(existingRuntimeRequired())
          : manager.beginSetupOperation(target, operationId),
      ),
    issueClientSession: (target, options) =>
      Effect.suspend(() => {
        if (!routes.isManaged(target.alias)) return manager.issueClientSession(target, options);
        return routes.admit(target.alias).pipe(
          Effect.flatMap(({ selfNodeId }) => {
            const { subject: _subject, penMember: _penMember, ...rest } = options;
            return manager.issueClientSession(target, {
              ...rest,
              penMember: selfNodeId,
              installation: "existing-only",
            });
          }),
        );
      }),
    issueMcpClientSession: (target, options) =>
      Effect.suspend(() => {
        if (!routes.isManaged(target.alias)) return manager.issueMcpClientSession(target, options);
        return routes
          .admit(target.alias)
          .pipe(
            Effect.flatMap(() =>
              manager.issueMcpClientSession(target, { ...options, installation: "existing-only" }),
            ),
          );
      }),
  };
};
