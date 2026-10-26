import { OrchestratorMcpFailure, ProjectId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as Repositories from "../../../sourceControl/SourceControlRepositoryService.ts";
import * as HostThreadsMcpService from "../../HostThreadsMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { admitLaunch, withPressure } from "../../pressureAdmission.ts";
import { newCommandId, readCaller, unavailable } from "../../threadAccess.ts";
import * as ThreadLaunchMcpService from "../../ThreadLaunchMcpService.ts";
import * as RepositoryReferenceMcpService from "../../RepositoryReferenceMcpService.ts";
import { ProjectToolkit } from "./tools.ts";

function projectFailure(error: Project.ProjectServiceError) {
  if (error._tag === "ProjectOperationError") return unavailable();
  const message =
    error._tag === "ProjectNotFoundError"
      ? "The project was not found."
      : error._tag === "ProjectConflictError"
        ? "The workspace is already registered to a project."
        : "The project is not empty; force=true is required to delete it.";
  return new OrchestratorMcpFailure({ code: "invalid_request", message });
}

const access = Effect.gen(function* () {
  yield* readCaller();
  return yield* Project.ProjectService;
});

/** Whether a project read goes to another machine. */
const reachesHost = <P extends { readonly host?: string | undefined }>(input: P) =>
  input.host !== undefined;

const decodeHostProjectList = Schema.decodeUnknownEffect(
  ProjectToolkit.tools.goat_project_list.successSchema,
);
const decodeHostProject = Schema.decodeUnknownEffect(
  ProjectToolkit.tools.goat_project_read.successSchema,
);

/** The same tool on another machine's GOAT server, which answers for its own projects. */
const readOnHost = <A extends object, E>(
  host: string,
  tool: "goat_project_list" | "goat_project_read",
  args: Readonly<Record<string, unknown>>,
  decode: (value: unknown) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const hosts = yield* HostThreadsMcpService.HostThreadsMcpService;
    return yield* hosts.readOnHost(scope, { host, tool, arguments: args }, decode);
  });

export const layer = McpToolAccess.toLayer(ProjectToolkit, {
  goat_repository_snapshot: McpToolAccess.readsOrReachesHost(
    (input) => input.host != null,
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const references = yield* RepositoryReferenceMcpService.RepositoryReferenceMcpService;
        return yield* references.read(scope, input);
      }),
  ),
  goat_thread_launch: McpToolAccess.destructive(
    McpToolAccess.startsThreads(
      (input) => input,
      (input, modes) =>
        Effect.gen(function* () {
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const launches = yield* ThreadLaunchMcpService.ThreadLaunchMcpService;
          const pressure = yield* admitLaunch(null);
          if (input.references === undefined || input.references.length === 0)
            return withPressure(yield* launches.launch(scope, input, modes), pressure);
          const references = yield* RepositoryReferenceMcpService.RepositoryReferenceMcpService;
          const message = yield* references.prepareBrief(scope, {
            message: input.message,
            references: input.references,
          });
          return withPressure(
            yield* launches.launch(scope, { ...input, message }, modes),
            pressure,
          );
        }),
    ),
  ),
  goat_project_list: McpToolAccess.readsOrReachesHost(reachesHost, ({ host, ...input }) =>
    Effect.gen(function* () {
      if (host !== undefined)
        return yield* readOnHost(host, "goat_project_list", input, decodeHostProjectList);
      const projects = yield* access;
      const snapshot = yield* projects.snapshot.pipe(Effect.mapError(unavailable));
      const rows = snapshot.projects.filter((project) => project.deletedAt === null);
      const start = input.cursor ?? 0,
        end = start + (input.limit ?? 20);
      return { projects: rows.slice(start, end), nextCursor: end < rows.length ? end : null };
    }),
  ),
  goat_project_read: McpToolAccess.readsOrReachesHost(reachesHost, ({ host, ...input }) =>
    Effect.gen(function* () {
      if (host !== undefined)
        return yield* readOnHost(host, "goat_project_read", input, decodeHostProject);
      const projects = yield* access;
      const result = yield* projects.getById(input.projectId).pipe(Effect.mapError(unavailable));
      if (Option.isNone(result))
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "The project was not found.",
        });
      return result.value;
    }),
  ),
  goat_project_create: McpToolAccess.destructive(
    McpToolAccess.setsUpProjects(({ workspaceRoot, ...input }) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        if (workspaceRoot === undefined) {
          // Project creation records no model default (only an update does), so
          // reject what this mode would otherwise drop silently.
          if (
            input.scripts !== undefined ||
            input.createWorkspaceRootIfMissing !== undefined ||
            input.defaultModelSelection !== undefined
          )
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message:
                "A project started from its title takes only a title; set scripts or defaultModelSelection afterwards with goat_project_update.",
            });
          const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
          const created = yield* folders.createNamedProject({ name: input.title }).pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({
                  code: "orchestration_error",
                  message: error.message,
                }),
            ),
          );
          const project = yield* projects
            .getById(created.projectId)
            .pipe(
              Effect.mapError(unavailable),
              Effect.flatMap(
                Option.match({ onNone: () => Effect.fail(unavailable()), onSome: Effect.succeed }),
              ),
            );
          return {
            ...project,
            ...(created.commitError === undefined ? {} : { commitError: created.commitError }),
          };
        }
        const commandId = yield* newCommandId();
        return yield* projects
          .create({ ...input, workspaceRoot, commandId, projectId: ProjectId.make(commandId) })
          .pipe(Effect.mapError(projectFailure));
      }),
    ),
  ),
  goat_project_update: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        return yield* projects
          .update({ ...input, commandId: yield* newCommandId() })
          .pipe(Effect.mapError(projectFailure));
      }),
    ),
  ),
  goat_project_delete: McpToolAccess.destructive(
    McpToolAccess.writesEnvironment((input) =>
      Effect.gen(function* () {
        const projects = yield* Project.ProjectService;
        return yield* projects
          .delete({ ...input, commandId: yield* newCommandId() })
          .pipe(Effect.mapError(projectFailure));
      }),
    ),
  ),
  goat_project_clone: McpToolAccess.destructive(
    McpToolAccess.setsUpProjects((input) =>
      Effect.gen(function* () {
        const repositories = yield* Repositories.SourceControlRepositoryService;
        return yield* repositories.cloneRepository(input).pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message: error.detail,
              }),
          ),
        );
      }),
    ),
  ),
});
