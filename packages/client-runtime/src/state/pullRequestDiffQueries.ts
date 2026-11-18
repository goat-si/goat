import {
  PullRequestDiffResult,
  PullRequestOperationError,
  type PullRequestDiffInput,
  type EnvironmentId,
} from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { environmentConnectionAtoms } from "./environmentConnections.ts";
import * as PullRequestDiffLoader from "./pullRequestDiffHttp.ts";
import { persistQuery } from "./queryPersistence.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";

/** @public Required to name the error in consumers' inferred pull request results. */
export class EnvironmentHttpConnectionNotReadyError extends Data.TaggedError(
  "EnvironmentHttpConnectionNotReadyError",
)<{ readonly message: string }> {}

export function createPullRequestDiffQueries<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | PullRequestDiffLoader.PullRequestDiffLoader | R,
    E
  >,
) {
  type DiffTarget = { readonly environmentId: EnvironmentId; readonly input: PullRequestDiffInput };
  const connections = environmentConnectionAtoms(runtime);
  const advertisement = Atom.family((_key: string) =>
    Atom.make<{ readonly session: RpcSession; readonly revision: string } | null>(null).pipe(
      Atom.setIdleTTL(5 * 60_000),
    ),
  );
  const advertisementFor = ({ environmentId, input }: DiffTarget) =>
    advertisement(
      JSON.stringify([
        environmentId,
        input.projectId,
        input.host ?? null,
        input.repository,
        input.number,
        input.expectedAccountId ?? null,
        input.allowStale ?? null,
        input.commit ?? null,
      ]),
    );
  const diffRevision = (commit: string | undefined, revision: PullRequestDiffInput["revision"]) =>
    commit ?? (revision && JSON.stringify([revision.baseSha, revision.headSha]));
  const liveWithheldDiff = Atom.family((key: string) => {
    const target = JSON.parse(key) as DiffTarget;
    return Atom.make((get) => {
      const connection = Option.getOrNull(
        AsyncResult.value(get(connections(target.environmentId))),
      );
      const last = get(advertisementFor(target));
      return (
        connection?.[0].phase === "connected" &&
        last !== null &&
        Option.getOrNull(connection[1]) === last.session &&
        last.revision === diffRevision(target.input.commit, target.input.revision)
      );
    });
  });
  const withheldDiffAdvertised = (target: DiffTarget) => liveWithheldDiff(JSON.stringify(target));

  const loadDiff = Effect.fn("PullRequests.loadDiff")(function* (
    input: PullRequestDiffInput,
    _emit: (page: PullRequestDiffResult) => Effect.Effect<void>,
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
  ) {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const loader = yield* PullRequestDiffLoader.PullRequestDiffLoader;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    if (Option.isNone(prepared)) {
      return yield* new EnvironmentHttpConnectionNotReadyError({
        message: "The environment HTTP connection is not ready.",
      });
    }
    const session = Option.getOrNull(yield* SubscriptionRef.get(supervisor.session));
    const marker = advertisementFor({ environmentId, input });
    if (input.path !== undefined) {
      const saved = registry.get(marker);
      const state = yield* SubscriptionRef.get(supervisor.state);
      if (
        state.phase !== "connected" ||
        !saved ||
        saved.session !== session ||
        saved.revision !== diffRevision(input.commit, input.revision)
      ) {
        return yield* new PullRequestOperationError({
          operation: "diff",
          detail: "The current connection has not offered this file diff.",
        });
      }
    }
    const page = yield* loader.load(prepared.value, input);
    if (
      session !== null &&
      input.cursor === undefined &&
      input.path === undefined &&
      Option.getOrNull(yield* SubscriptionRef.get(supervisor.session)) === session
    ) {
      const revision = diffRevision(input.commit, page.revision);
      registry.set(
        marker,
        page.withheldFilesReadable === true && revision !== undefined
          ? { session, revision }
          : null,
      );
    }
    return page;
  });

  const withheldDiff = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:pull-requests:withheld-diff",
    staleTimeMs: 60_000,
    execute: loadDiff,
  });
  const withheldDiffs = Atom.family((key: string) => {
    const { target, paths } = JSON.parse(key) as {
      readonly target: Parameters<typeof withheldDiff>[0];
      readonly paths: readonly string[];
    };
    return Atom.make((get) =>
      paths.map((path) => get(withheldDiff({ ...target, input: { ...target.input, path } }))),
    );
  });

  return {
    diff: createEnvironmentQueryAtomFamily(runtime, {
      label: "environment-data:pull-requests:diff",
      persistence: persistQuery(PullRequestDiffResult),
      staleTimeMs: 60_000,
      execute: loadDiff,
    }),
    withheldDiff,
    withheldDiffs,
    withheldDiffAdvertised,
  };
}
