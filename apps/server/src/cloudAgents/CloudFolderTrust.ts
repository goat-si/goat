import {
  type ApplicationStoredEvent,
  type CloudFolderTrust,
  type CloudFolderTrustAcceptInput,
  type CloudFolderTrustListResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";

/** The folder an event brings into GOAT: a new or moved project root, or a thread's worktree. */
function addedFolder(stored: ApplicationStoredEvent): string | null {
  if ("aggregateKind" in stored) {
    if (stored.type === "project.created") return stored.payload.workspaceRoot;
    if (stored.type === "project.meta-updated") return stored.payload.workspaceRoot ?? null;
    return null;
  }
  const event = stored.event;
  return event.type === "thread.created" || event.type === "thread.metadata-updated"
    ? event.payload.worktreePath
    : null;
}

/**
 * Trusts GOAT's folders for every provider that asks, so no launch stops on Claude Code's folder
 * trust prompt and nobody has to answer it: project roots when the server starts, and each new
 * project or worktree as it appears. Each provider decides which folders are its to trust.
 */
export const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;

  const trust = Effect.fn("CloudFolderTrust.trust")(function* (folder: string) {
    const instances = yield* registry.listInstances;
    yield* Effect.forEach(
      instances,
      (instance) =>
        instance.enabled && instance.folderTrust !== undefined
          ? instance.folderTrust.ensure(folder)
          : Effect.void,
      { discard: true },
    );
  });

  const start = Effect.fn("CloudFolderTrust.start")(function* () {
    const running = yield* FiberSet.make<void>();
    yield* forkParked(
      Effect.gen(function* () {
        const from = yield* events.latestApplicationSequence;
        // Thread metadata repeats a worktree on every update; one request per worktree is enough.
        const worktrees = new Set<string>();
        yield* events.streamApplicationEvents({ afterSequence: from }).pipe(
          Stream.runForEach((stored) => {
            const folder = addedFolder(stored);
            if (folder === null) return Effect.void;
            if ("event" in stored) {
              if (worktrees.has(folder)) return Effect.void;
              worktrees.add(folder);
            }
            return FiberSet.run(running, trust(folder)).pipe(Effect.asVoid);
          }),
          Effect.catchCause((cause) =>
            Effect.logWarning("Stopped trusting new folders for Claude Code", { cause }),
          ),
          Effect.forkScoped,
        );
        // Claude keeps a worktree's trust at its main checkout, so the roots cover their worktrees.
        const roots = (yield* projects.list())
          .filter((row) => row.deletedAt === null)
          .map((row) => row.workspaceRoot);
        yield* Effect.forEach(roots, trust, { discard: true });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not trust project folders for Claude Code", { cause }),
        ),
      ),
    );
  });
  return { start };
});

export const layer = Layer.effectDiscard(make.pipe(Effect.flatMap((service) => service.start())));

// Deprecated since GOAT 0.1.2, which trusts folders on its own and dropped Fleet's folder trust
// section. Fleet in clients before 0.1.2 still calls the two RPCs below, so they stay until no
// supported client predates 0.1.2: remove them, their contract schemas, authorization and
// instrumentation entries, and ProviderInstance.folderTrust.states in GOAT 0.2.0.

const failure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

const trustingInstances = ProviderInstanceRegistry.ProviderInstanceRegistry.pipe(
  Effect.flatMap((registry) => registry.listInstances),
  Effect.map((instances) =>
    instances.filter(
      (
        instance,
      ): instance is ProviderInstance & {
        folderTrust: NonNullable<ProviderInstance["folderTrust"]>;
      } => instance.enabled && instance.folderTrust !== undefined,
    ),
  ),
);

const liveProjects = ProjectStore.ProjectStoreV2.pipe(
  Effect.flatMap((projects) => projects.list()),
  Effect.map((rows) => rows.filter((row) => row.deletedAt === null)),
  Effect.mapError(() => failure("Could not read this environment's projects.")),
);

/** Deprecated: each project folder's Claude Code trust, for Fleet before GOAT 0.1.2. */
export const listFolderTrust = Effect.fn("CloudFolderTrust.list")(function* () {
  const [instances, projects] = yield* Effect.all([trustingInstances, liveProjects]);
  const folders = yield* Effect.forEach(instances, (instance) =>
    instance.folderTrust.states(projects.map((project) => project.workspaceRoot)).pipe(
      Effect.map((states) =>
        projects.map((project, index): CloudFolderTrust => ({
          instanceId: instance.instanceId,
          projectId: project.projectId,
          title: project.title,
          path: project.workspaceRoot,
          trusted: states[index]?.trusted ?? null,
          acceptedByGoatAt: states[index]?.acceptedByGoatAt ?? null,
        })),
      ),
    ),
  );
  return { folders: folders.flat() } satisfies CloudFolderTrustListResult;
});

/**
 * Deprecated: Fleet's Trust now button before GOAT 0.1.2. Runs the same background trust and
 * reports the folder's state afterwards; a failure shows as a folder that is still untrusted.
 */
export const acceptFolderTrust = Effect.fn("CloudFolderTrust.accept")(function* (
  input: CloudFolderTrustAcceptInput,
) {
  const instance = (yield* trustingInstances).find(
    (candidate) => candidate.instanceId === input.instanceId,
  );
  if (instance === undefined)
    return yield* failure("That provider is not on here or does not ask to trust folders.");
  const project = (yield* liveProjects).find((row) => row.projectId === input.projectId);
  if (project === undefined) return yield* failure("The project was not found.");
  yield* instance.folderTrust.ensure(project.workspaceRoot);
  const [state] = yield* instance.folderTrust.states([project.workspaceRoot]);
  return {
    instanceId: instance.instanceId,
    projectId: project.projectId,
    title: project.title,
    path: project.workspaceRoot,
    trusted: state?.trusted ?? null,
    acceptedByGoatAt: state?.acceptedByGoatAt ?? null,
  } satisfies CloudFolderTrust;
});
