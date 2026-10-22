import {
  type CloudFolderTrust,
  type CloudFolderTrustAcceptInput,
  type CloudFolderTrustListResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";

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

/** Each project folder's Claude Code trust, for every provider instance that asks for it. */
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

/** Answers the folder's trust prompt now, so even the first launch never sees it. */
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
  yield* instance.folderTrust
    .accept(project.workspaceRoot)
    .pipe(Effect.mapError((error) => failure(error.detail)));
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
